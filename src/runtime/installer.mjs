// agentry/src/runtime/installer.mjs
//
// Ensures a session has the dependencies a capability needs.
//
// Reads the capability node's `requires` block and calls the OS
// kernel for each entry. Idempotent: if the session already has the
// deps, this is a no-op (marked via a session env var).
//
// Batch 14 (the adoption pipeline) reuses this verbatim.
//
// v0.15.25 — composition.
// A capability may declare `requires.capability: [<id>, ...]`. Before
// installing its own npm/pip/post_install, prepareSession recursively
// prepares each named inner capability in the same session. The inner's
// deps land in the outer's session, so a composed handler can rely on
// them (and, via glue.pre_invoke, invoke the inner capability directly).
//
// Two structured failure modes are named so callers can react:
//   err.phase === "composed_dep_missing"  — an inner capability is not
//                                            in the graph. err carries
//                                            missing_capability_id and
//                                            outer_capability_id.
//   err.phase === "composed_dep_cycle"    — a capability transitively
//                                            requires itself. err carries
//                                            cycle (array of ids).
//
// Callers that want to record a gap against the *inner* capability should
// check err.phase in their catch block. agentry.trial does this.

const PREPARE_KEY = (capId) => `prepared:${capId}`;

export async function prepareSession(deps, { capId, session, stack = [], requires_override = null }) {
  const { graph, events, invoke } = deps;
  const cap = graph.getCapability(capId);
  // v0.52.10 — accept() (inside trial) calls this BEFORE adopt writes the
  // capability node to the graph. requires_override lets the caller pass
  // the requires block inline so prepareSession can run without the node.
  if (!cap && !requires_override) throw new Error(`prepareSession: unknown capability ${capId}`);

  // Cycle detection: a capability may not transitively require itself.
  if (stack.includes(capId)) {
    const cycle = [...stack, capId];
    const err = new Error(`prepareSession: cycle detected: ${cycle.join(" -> ")}`);
    err.phase = "composed_dep_cycle";
    err.cycle = cycle;
    events.emit("installer.composed_dep_cycle", { capId, cycle });
    throw err;
  }
  const nextStack = [...stack, capId];

  const requires = (requires_override && typeof requires_override === "object")
    ? requires_override
    : (cap?.requires || {});

  // Ensure the session exists before we try to install into it.
  // session.create is idempotent — returns { created: false } if it
  // already exists.
  // v0.52.13 — retry with backoff. Under concurrent trial load, the kernel
  // can serialize the fs writes and one caller's request hits the 60s
  // agentry.os timeout. Two retries with 1s/3s backoff clears the transient
  // case without changing kernel semantics.
  let createRes = null;
  const _backoffMs = [0, 1000, 3000];
  for (let _attempt = 0; _attempt < _backoffMs.length; _attempt++) {
    if (_attempt > 0) {
      await new Promise(r => setTimeout(r, _backoffMs[_attempt]));
      events.emit("installer.session_create_retry", { capId, session, attempt: _attempt + 1 });
    }
    try {
      createRes = await invoke(
        "agentry.os",
        { action: "session.create", id: session },
        { tenant: "local", by: "installer" }
      );
    } catch (e) {
      createRes = { ok: false, error: { code: "invoker_failed", message: e.message } };
    }
    if (createRes && createRes.ok) break;
    // Only retry on transient failures (timeout / fetch failed), not on
    // INVALID_REQUEST which will always fail the same way.
    const _code = createRes?.error?.code || "";
    const _msg = String(createRes?.error?.message || "");
    const _transient = /timeout|fetch failed|ECONNRESET|ETIMEDOUT|socket/i.test(_msg);
    if (!_transient) break;
  }
  if (!createRes || !createRes.ok) {
    throw new Error(
      `installer: session.create failed — ${createRes?.error?.code || "unknown"}: ${createRes?.error?.message || "unknown"}`
    );
  }

  // Already prepared for this cap in this session?
  const sessionEnv = await getSessionEnv(invoke, session);
  if (sessionEnv[PREPARE_KEY(capId)]) {
    events.emit("installer.already_prepared", { capId, session });
    return { already_prepared: true };
  }

  const steps = [];

  // ── Composition: prepare inner capabilities first ──
  const composed = Array.isArray(requires.capability) ? requires.capability : [];
  for (const innerId of composed) {
    const inner = graph.getCapability(innerId);
    if (!inner) {
      const err = new Error(
        `installer: composed dependency missing: ${innerId} (required by ${capId})`
      );
      err.phase = "composed_dep_missing";
      err.missing_capability_id = innerId;
      err.outer_capability_id = capId;
      events.emit("installer.composed_dep_missing", {
        capId,
        missing_capability_id: innerId,
      });
      throw err;
    }
    events.emit("installer.composed_prepare", {
      capId,
      inner_capability_id: innerId,
    });
    await prepareSession(deps, { capId: innerId, session, stack: nextStack });
    steps.push({ step: "composed", ok: true, inner_capability_id: innerId });
  }

  // ── npm ──
  if (Array.isArray(requires.npm) && requires.npm.length) {
    events.emit("installer.npm_starting", { capId, session, packages: requires.npm });
    const res = await invoke(
      "agentry.os",
      { action: "node.install", session, packages: requires.npm },
      { tenant: "local", by: "installer" }
    );
    if (!res.ok) {
      throw new Error(
        `installer: node.install failed — ${res.error.code}: ${res.error.message}`
      );
    }
    steps.push({ step: "node.install", ok: true, packages: requires.npm });
    events.emit("installer.npm_complete", { capId, session, packages: requires.npm });
  }

  // ── pip ──
  if (Array.isArray(requires.pip) && requires.pip.length) {
    events.emit("installer.pip_starting", { capId, session, packages: requires.pip });
    const res = await invoke(
      "agentry.os",
      { action: "python.install", session, packages: requires.pip },
      { tenant: "local", by: "installer" }
    );
    if (!res.ok) {
      throw new Error(
        `installer: python.install failed — ${res.error.code}: ${res.error.message}`
      );
    }
    steps.push({ step: "python.install", ok: true, packages: requires.pip });
    events.emit("installer.pip_complete", { capId, session, packages: requires.pip });
  }

  // ── post_install — a shell command run once after packages are installed. ──
  if (typeof requires.post_install === "string" && requires.post_install.length) {
        const _piCmd = String(requires.post_install || "");
        let _piDefault = 300000;
        if (/\bcargo\s+install\b/.test(_piCmd)) _piDefault = 900000;
        else if (/\bpip[3]?\s+install\b/.test(_piCmd) && /torch|transformers|cuda|tensorflow|jax/i.test(_piCmd)) _piDefault = 900000;
        else if (/\bapt(?:-get)?\s+install\b/.test(_piCmd)) _piDefault = 300000;
        else if (/\bgit\s+clone\b/.test(_piCmd) && /\b(make|cmake|cargo\s+build|npm\s+install|pnpm\s+install)\b/.test(_piCmd)) _piDefault = 900000;
        else if (/(curl|wget)\s+-/.test(_piCmd) && /\.(tar\.gz|tgz|zip|bin|deb)\b/.test(_piCmd)) _piDefault = 600000;
        const _postInstallTimeout = Math.max(30000, Math.min(1800000, Number(requires.post_install_timeout_ms) || _piDefault));
    events.emit("installer.post_install_starting", {
      capId,
      session,
      cmd: requires.post_install,
    });

    // v0.31.8 — persistent cargo cache env so repeat installs skip
    // recompilation. CARGO_HOME and RUSTUP_HOME match Dockerfile ENV.
    try {
      await invoke("agentry.os", { action: "shell.spawn", session, cmd: "sh", args: ["-c", "mkdir -p /tmp/home/.cargo-target"], timeout_ms: 5000 }, { tenant: "local", by: "installer" });
      await invoke("agentry.os", { action: "session.env", session, key: "CARGO_TARGET_DIR", value: "/tmp/home/.cargo-target" }, { tenant: "local", by: "installer" });
      await invoke("agentry.os", { action: "session.env", session, key: "CARGO_HOME", value: "/usr/local/cargo" }, { tenant: "local", by: "installer" });
      await invoke("agentry.os", { action: "session.env", session, key: "RUSTUP_HOME", value: "/usr/local/rustup" }, { tenant: "local", by: "installer" });
    } catch (e) {
      events.emit("installer.cargo_env_setup_failed", { capId, session, error: e.message });
    }
    const res = await invoke(
      "agentry.os",
      {
        action: "shell.spawn",
        session,
        cmd: "sh",
        args: ["-c", requires.post_install],
        timeout_ms: _postInstallTimeout,
      },
      { tenant: "local", by: "installer" }
    );
    if (!res.ok) {
      throw new Error(
        `installer: post_install spawn failed — ${res.error.code}: ${res.error.message}`
      );
    }
    const pid = res.output.result.pid;
    const read = await invoke(
      "agentry.os",
      { action: "shell.read", session, pid, wait_ms: _postInstallTimeout },
      { tenant: "local", by: "installer" }
    );
    const out = read.output.result;
    if (out.exit_code !== 0) {
      const _sig = out.signal ? (" signal=" + out.signal) : "";
      const _exitLabel = (out.exit_code === null || out.exit_code === undefined)
        ? "killed (likely timeout after " + _postInstallTimeout + "ms" + _sig + ")"
        : ("exited " + out.exit_code);
      throw new Error(
        `installer: post_install ${_exitLabel} — ${String(out.stderr || "").slice(0, 400)}`
      );
    }
    steps.push({ step: "post_install", ok: true, cmd: requires.post_install });
    events.emit("installer.post_install_complete", { capId, session });
  }

  // ── dsh_plugin — install DSH plugins via the stable binary ──
  // v0.56.3 — uses /tmp/home/.dsh-cli/bin/dsh (fixed prefix). Handles
  // allowBuilds and minimumReleaseAge silent-failure classes explicitly.
  if (requires.dsh_plugin) {
    const _raw = requires.dsh_plugin;
    const _items = Array.isArray(_raw) ? _raw : [_raw];
    const { installDshPlugin } = await import("./dsh_plugin_installer.mjs");
    const _defaultProfile = process.env.AGENTRY_DSH_PROFILE || "headless";
    for (const _item of _items) {
      const _spec = typeof _item === "string" ? _item : (_item && _item.spec);
      if (!_spec) continue;
      const _profile = (typeof _item === "object" && _item.profile) || _defaultProfile;
      events.emit("installer.dsh_plugin_starting", { capId, session, spec: _spec, profile: _profile });
      const _r = await installDshPlugin({ profile: _profile, spec: _spec });
      if (!_r.ok) {
        events.emit("installer.dsh_plugin_failed", {
          capId, spec: _spec, profile: _profile,
          reason: _r.reason, detail: _r.detail, retried: _r.retried,
        });
        throw new Error(`installer: dsh_plugin "${_spec}" failed — ${_r.reason}${_r.detail ? ": " + String(_r.detail).slice(0, 300) : ""}`);
      }
      steps.push({ step: "dsh_plugin", ok: true, spec: _spec, profile: _profile, reason: _r.reason, retried: _r.retried || false });
      events.emit("installer.dsh_plugin_complete", {
        capId, spec: _spec, profile: _profile, reason: _r.reason, retried: _r.retried || false,
      });
    }
  }

  await markPrepared(invoke, session, capId);
  events.emit("installer.prepared", { capId, session, steps });

  return { already_prepared: false, steps };
}

async function getSessionEnv(invoke, session) {
  const res = await invoke(
    "agentry.os",
    { action: "session.get", session },
    { tenant: "local", by: "installer" }
  );
  if (!res.ok) return {};
  return res.output.result.session.env || {};
}

async function markPrepared(invoke, session, capId) {
  await invoke(
    "agentry.os",
    {
      action: "session.env",
      session,
      key: PREPARE_KEY(capId),
      value: String(Date.now()),
    },
    { tenant: "local", by: "installer" }
  );
}
