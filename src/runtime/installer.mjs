// agentry/src/runtime/installer.mjs
//
// Ensures a session has the dependencies a capability needs.
//
// Reads the capability node's `requires` block and calls the OS
// kernel for each entry. Idempotent: if the session already has the
// deps, this is a no-op (marked via a session env var).
//
// Batch 14 (the adoption pipeline) reuses this verbatim.

const PREPARE_KEY = (capId) => `prepared:${capId}`;

export async function prepareSession(deps, { capId, session }) {
  const { graph, events, invoke } = deps;
  const cap = graph.getCapability(capId);
  if (!cap) throw new Error(`prepareSession: unknown capability ${capId}`);

  const requires = cap.requires || {};

  // Already prepared?
  const sessionEnv = await getSessionEnv(invoke, session);
  if (sessionEnv[PREPARE_KEY(capId)]) {
    events.emit("installer.already_prepared", { capId, session });
    return { already_prepared: true };
  }

  const steps = [];

  // npm
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

  // pip
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

  // post_install — a shell command run once after packages are installed.
  if (typeof requires.post_install === "string" && requires.post_install.length) {
    events.emit("installer.post_install_starting", {
      capId,
      session,
      cmd: requires.post_install,
    });
    const res = await invoke(
      "agentry.os",
      {
        action: "shell.spawn",
        session,
        cmd: "sh",
        args: ["-c", requires.post_install],
        timeout_ms: 180000,
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
      { action: "shell.read", session, pid, wait_ms: 180000 },
      { tenant: "local", by: "installer" }
    );
    const out = read.output.result;
    if (out.exit_code !== 0) {
      throw new Error(
        `installer: post_install exited ${out.exit_code} — ${String(out.stderr || "").slice(0, 200)}`
      );
    }
    steps.push({ step: "post_install", ok: true, cmd: requires.post_install });
    events.emit("installer.post_install_complete", { capId, session });
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
