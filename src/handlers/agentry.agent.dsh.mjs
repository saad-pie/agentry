// agentry/src/handlers/agentry.agent.dsh.mjs
// v0.40.0 — DSH headless execution with full trace.
//
// Replaces the old submit-and-poll pattern (agent.dsh) with a direct
// subprocess call to `dsh headless --json <prompt>`. The old pattern
// required a browser client to drive the agent loop; headless is
// self-contained and emits structured run events on stdout.
//
// Design:
//   - spawn dsh in an isolated kernel session (unique id per call)
//   - --json flag emits NDJSON run events on stdout
//   - events parsed line-by-line, grouped into messages/tool_calls/usage
//   - full events_raw preserved for UI rendering (chat stream, tool cards)
//   - returns { ok, exit_code, final, messages, tool_calls, events_raw, usage, stderr }
//
// The "final" field is the assistant's final text — what callers usually want.
// events_raw is the full trace — what a UI renders.
//
// Model: unorouter/qwen3.8-27b:free by default (free, no TPM wall,
// tool-call capable — see agentry's config.llm.providers.unorouter).

const DEFAULT_TIMEOUT_MS = 180000;
const DSH_BIN = process.env.DSH_BIN || "/tmp/home/.npm/_npx/b86ed90107c62dab/node_modules/.bin/dsh";
const DSH_PROFILE = process.env.DSH_PROFILE || "headless";
const ATRIA_KEY = process.env.ATRIA_API_KEY || "";

function genSessionId() {
  return "dsh_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
}

function parseEvents(stdout) {
  const events = [];
  for (const line of String(stdout || "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t[0] !== "{") continue; // skip non-JSON junk (shouldn't be on stdout with --json)
    try {
      events.push(JSON.parse(t));
    } catch (e) {
      events.push({ type: "parse_error", raw: t.slice(0, 300), error: e.message });
    }
  }
  return events;
}

function structure(events) {
  const messages = [];
  const tool_calls = [];
  const errors = [];
  const session_info = { sessionId: null, cwd: null };
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0 };
  let final_text = null;
  let turn_count = 0;
  let step_count = 0;

  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    switch (ev.type) {
      case "session":
        session_info.sessionId = ev.sessionId || null;
        session_info.cwd = ev.cwd || null;
        break;
      case "thinking":
        messages.push({ role: "thinking", text: String(ev.text || "") });
        break;
      case "text":
        messages.push({ role: "assistant", text: String(ev.text || "") });
        break;
      case "tool_call": {
        tool_calls.push({
          callId: ev.callId || null,
          tool: ev.tool || null,
          input: ev.input || {},
          status: null,
          result: null,
        });
        break;
      }
      case "tool_result": {
        const call = tool_calls.find(t => t.callId && t.callId === ev.callId);
        if (call) {
          call.status = ev.status || null;
          call.result = ev.result || null;
        } else {
          // result without matching call — record anyway for completeness
          tool_calls.push({
            callId: ev.callId || null,
            tool: null, input: null,
            status: ev.status || null,
            result: ev.result || null,
          });
        }
        break;
      }
      case "status": {
        if (ev.phase === "turn_start") turn_count = Math.max(turn_count, Number(ev.turn || 0));
        if (ev.phase === "step_start") step_count = Math.max(step_count, Number(ev.step || 0));
        if (ev.usage) {
          usage.inputTokens += Number(ev.usage.inputTokens || 0);
          usage.outputTokens += Number(ev.usage.outputTokens || 0);
          usage.totalTokens += Number(ev.usage.totalTokens || 0);
          usage.cacheReadTokens += Number(ev.usage.cacheReadTokens || 0);
        }
        break;
      }
      case "final":
        final_text = String(ev.text || "");
        break;
      case "error":
        errors.push({
          message: String(ev.message || ev.error || "unknown"),
          code: ev.code || null,
        });
        break;
      case "parse_error":
        errors.push({ message: "parse_error: " + ev.error, code: "parse_error" });
        break;
    }
  }

  return {
    messages,
    tool_calls,
    errors,
    session_info,
    usage,
    final_text,
    turn_count,
    step_count,
  };
}

export default async function agentryAgentDsh(input, ctx) {
  const { prompt, timeout_ms, session_id } = input || {};
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("agentry.agent.dsh requires prompt (non-empty string)");
  }
  if (typeof ctx.invoke !== "function") throw new Error("agentry.agent.dsh requires ctx.invoke");

  const events_out = ctx.events;
  const started = Date.now();
  const ksess = genSessionId();
  const timeout = Math.max(5000, Math.min(600000, Number(timeout_ms) || DEFAULT_TIMEOUT_MS));

  events_out.emit("agent.dsh.started", { ksess, prompt_len: prompt.length, timeout_ms: timeout });

  // ── 1. Create kernel session ──
  // v0.48.0 — check .ok AND verify with session.get. Prior version ignored
  // the result and proceeded to spawn in a session that never existed,
  // producing "INTERNAL: unknown session: <ksess>" on shell.spawn.
  try {
    const createRes = await ctx.invoke("agentry.os", { action: "session.create", id: ksess },
      { tenant: "local", by: "agentry.agent.dsh" });
    if (!createRes.ok) {
      throw new Error("session.create returned ok=false: " + (createRes.error?.message || "unknown"));
    }
    const verifyRes = await ctx.invoke("agentry.os", { action: "session.get", session: ksess },
      { tenant: "local", by: "agentry.agent.dsh" });
    if (!verifyRes.ok) {
      throw new Error("session.create succeeded but session.get failed: " + (verifyRes.error?.message || "unknown"));
    }
    ctx.events.emit("agent.dsh.session_ready", { ksess, verified: true });
  } catch (e) {
    ctx.events.emit("agent.dsh.session_failed", { ksess, error: e.message });
    throw new Error("agentry.agent.dsh: session setup failed: " + e.message);
  }

  // ── 2. Set env vars required by DSH bundles ──
  // v0.48.2 — DSH's llm-deepseek bundle checks for DEEPSEEK_API_KEY at
  // startup BEFORE atria config takes over model routing. Setting it to a
  // dummy value satisfies the gate; atria handles actual model calls. This
  // is the same workaround as the manual `DEEPSEEK_API_KEY=dummy dsh headless`
  // test that worked earlier in the session.
  const atriaKey = ATRIA_KEY || "antigravity-free";
  const shq = (x) => "'" + String(x).replace(/'/g, "'\\''") + "'";
  try {
    await ctx.invoke("agentry.os", { action: "session.env", session: ksess, key: "DEEPSEEK_API_KEY", value: "dummy-not-used" }, { tenant: "local", by: "agentry.agent.dsh" });
    await ctx.invoke("agentry.os", { action: "session.env", session: ksess, key: "ATRIA_API_KEY", value: atriaKey }, { tenant: "local", by: "agentry.agent.dsh" });
    events_out.emit("agent.dsh.env_set", { ksess, atria_key_present: atriaKey.length > 0 });
  } catch (e) {
    events_out.emit("agent.dsh.env_set_failed", { error: e.message });
  }

  // ── 3. Spawn dsh ──
  const args = ["--profile", DSH_PROFILE, "--json"];
  if (session_id) args.push("--session-id", String(session_id));
  args.push(prompt);

  // v0.48.2 — inline env prefix on sh -c to guarantee propagation
  const requestyKey = process.env.REQUESTYAI_API_KEY || "";
  const envPrefix = "DEEPSEEK_API_KEY='dummy-not-used' ATRIA_API_KEY=" + shq(atriaKey) + " REQUESTYAI_API_KEY=" + shq(requestyKey);
  const cmdParts = [shq(DSH_BIN), ...args.map(shq)];
  const cmdStr = envPrefix + " " + cmdParts.join(" ");
  // v0.48.3 — self-healing DSH profile. The headless profile's patch must
  // route agent-default-model to atria (unorouter). If it's been reset to
  // [] or default, DSH falls back to deepseek-official and AUTH fails
  // against the dummy key. Verify + fix on every invocation.
  const HEADLESS_PATCH_PATH = "/tmp/home/.dsh/profiles/headless/cordis.patch.yml";
  const REQUIRED_PATCH = `- id: llm-pi-ai
  config:
    providers:
      unorouter:
        apiKeyEnv: ATRIA_API_KEY
        api: openai-completions
        baseURL: https://antigravity-seven-delta.vercel.app/v1
        supportsDeveloperRole: false
        defaultMaxTokens: 2048
        models:
          - id: qwen3.8-27b:free
            displayName: qwen3.8-27b:free (unorouter)
            maxTokens: 2048
      requesty:
        apiKeyEnv: REQUESTYAI_API_KEY
        api: openai-completions
        baseURL: https://router.requesty.ai/v1
        supportsDeveloperRole: false
        defaultMaxTokens: 2048
        models:
          - id: nemotron-3-ultra-550b-a55b
            displayName: nemotron-3-ultra-550b-a55b (requesty)
            maxTokens: 2048
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: unorouter
    model: qwen3.8-27b:free
- id: agent-preset-registry
  name: "@deepseek-ai/dsh-agent-preset-registry"
  config:
    default: standard
    selectedDefault: cordis
`;

  try {
    const fs = await import("node:fs");
    let needsFix = true;
    try {
      const current = fs.readFileSync(HEADLESS_PATCH_PATH, "utf8");
      // v0.48.6 — require EXACT provider + model strings. Prior version just
      // matched "atria" substring and skipped even when the profile had
      // qwen3.8-27b (no suffix, which 404s on atria's routing).
      if (current.includes("provider: unorouter") && current.includes("model: qwen3.8-27b:free")) {
        needsFix = false;
      }
    } catch {}
    if (needsFix) {
      fs.mkdirSync("/tmp/home/.dsh/profiles/headless", { recursive: true });
      fs.writeFileSync(HEADLESS_PATCH_PATH, REQUIRED_PATCH);
      events_out.emit("agent.dsh.profile_healed", { path: HEADLESS_PATCH_PATH });
    }
  } catch (e) {
    events_out.emit("agent.dsh.profile_heal_failed", { error: e.message });
  }

  events_out.emit("agent.dsh.spawn_started", { ksess, prompt_len: prompt.length, cmd_len: cmdStr.length });
  let spawn;
  try {
    spawn = await ctx.invoke("agentry.os", {
      action: "shell.spawn",
      session: ksess,
      cmd: "sh",
      args: ["-c", cmdStr],
      timeout_ms: timeout,
    }, { tenant: "local", by: "agentry.agent.dsh" });
  } catch (e) {
    events_out.emit("agent.dsh.spawn_threw", { ksess, error: e.message });
    throw new Error("agentry.agent.dsh: shell.spawn threw: " + e.message);
  }
  if (!spawn.ok) {
    throw new Error("agentry.agent.dsh: spawn not ok: " + (spawn.error?.message || "unknown"));
  }
  const pid = spawn.output.result.pid || spawn.output.result.proc_id;
  if (!pid) {
    throw new Error("agentry.agent.dsh: spawn returned no pid/proc_id: " + JSON.stringify(spawn.output.result).slice(0, 300));
  }

  // ── 4. Read result ──
  let read;
  try {
    read = await ctx.invoke("agentry.os", {
      action: "shell.read",
      session: ksess,
      pid,
      wait_ms: timeout,
    }, { tenant: "local", by: "agentry.agent.dsh" });
  } catch (e) {
    events_out.emit("agent.dsh.read_failed", { pid, error: e.message });
    throw new Error("agentry.agent.dsh: shell.read failed: " + e.message);
  }
  if (!read.ok) {
    throw new Error("agentry.agent.dsh: read not ok: " + (read.error?.message || "unknown"));
  }

  const r = read.output.result || {};
  const stdout = String(r.stdout || "");
  const stderr = String(r.stderr || "");
  const exit_code = r.exit_code ?? r.exitCode ?? null;

  // ── 5. Parse + structure ──
  const events = parseEvents(stdout);
  const structured = structure(events);

  const elapsed = Date.now() - started;
  const ok = exit_code === 0 && structured.errors.length === 0 && !structured.errors.some(e => e.code === "parse_error");

  events_out.emit("agent.dsh.completed", {
    ksess, ok, exit_code,
    tool_calls: structured.tool_calls.length,
    messages: structured.messages.length,
    tokens: structured.usage.totalTokens,
    ms: elapsed,
  });

  // v0.48.1 — enumerate files created during this call from THREE sources:
  //   1. explicit paths in tool_calls[].input (write tool file_path, bash
  //      command string parsed for /tmp/... paths)
  //   2. DSH's session cwd (kernel session workdir)
  //   3. /tmp/agentry-scratch/ (the shared scratch dir our prompt hints use)
  // Prior version only walked cwd, missing files at absolute paths.
  const discovered_files = [];
  const seen = new Set();
  const cutoff = started - 1000;

  try {
    const fs = await import("node:fs");
    const path = await import("node:path");

    const addFile = (p) => {
      if (!p || seen.has(p)) return;
      try {
        const st = fs.statSync(p);
        if (!st.isFile() || st.size === 0) return;
        if (st.mtimeMs < cutoff) return;
        const magic = fs.readFileSync(p).slice(0, 8).toString("hex");
        discovered_files.push({ path: p, bytes: st.size, magic });
        seen.add(p);
      } catch {}
    };

    // Source 1: explicit paths in tool_calls
    const explicitPaths = new Set();
    for (const tc of structured.tool_calls || []) {
      if (!tc.input) continue;
      if (tc.input.file_path) explicitPaths.add(String(tc.input.file_path));
      if (tc.input.path) explicitPaths.add(String(tc.input.path));
      if (tc.tool === "bash" && typeof tc.input.command === "string") {
        const cmd = tc.input.command;
        for (const m of cmd.matchAll(/(\/tmp\/[^\s"'`;|&<>)]+\.(?:pdf|png|jpg|jpeg|txt|json|csv|md|py|js|sh|html|mp4|mp3|wav))/g)) {
          explicitPaths.add(m[1]);
        }
      }
    }
    for (const p of explicitPaths) addFile(p);

    // Source 2 & 3: directory walks
    const scanDirs = new Set();
    if (structured.session_info.cwd) scanDirs.add(structured.session_info.cwd);
    scanDirs.add("/tmp/agentry-scratch");

    const walk = (dir, depth) => {
      if (depth > 3) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full, depth + 1); continue; }
        if (e.isFile()) addFile(full);
      }
    };
    for (const dir of scanDirs) walk(dir, 0);

    ctx.events.emit("agent.dsh.files_discovered", {
      ksess,
      count: discovered_files.length,
      paths: discovered_files.map(f => f.path),
    });
  } catch (e) {
    ctx.events.emit("agent.dsh.discover_files_failed", { error: e.message });
  }

  return {
    output: {
      ok,
      exit_code,
      duration_ms: elapsed,
      discovered_files,
      session_id: structured.session_info.sessionId,
      cwd: structured.session_info.cwd,
      final: structured.final_text,
      messages: structured.messages,
      tool_calls: structured.tool_calls,
      events_raw: events,
      usage: structured.usage,
      turn_count: structured.turn_count,
      step_count: structured.step_count,
      stderr: stderr.slice(0, 4000),
      errors: structured.errors,
    },
    cost: { time_ms: elapsed },
  };
}
