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
  try {
    await ctx.invoke("agentry.os", { action: "session.create", id: ksess },
      { tenant: "local", by: "agentry.agent.dsh" });
  } catch (e) {
    throw new Error("agentry.agent.dsh: session.create failed: " + e.message);
  }

  // ── 2. Propagate ATRIA_API_KEY into the session env ──
  // dsh reads apiKeyEnv from its provider config; the model provider
  // (unorouter) uses ATRIA_API_KEY per agentry's config.mjs convention.
  if (ATRIA_KEY) {
    try {
      await ctx.invoke("agentry.os", {
        action: "session.env", session: ksess,
        key: "ATRIA_API_KEY", value: ATRIA_KEY,
      }, { tenant: "local", by: "agentry.agent.dsh" });
    } catch (e) {
      events_out.emit("agent.dsh.env_set_failed", { error: e.message });
    }
  }

  // ── 3. Spawn dsh ──
  const args = ["--profile", DSH_PROFILE, "--json"];
  if (session_id) args.push("--session-id", String(session_id));
  args.push(prompt);

  let spawn;
  try {
    spawn = await ctx.invoke("agentry.os", {
      action: "shell.spawn",
      session: ksess,
      cmd: DSH_BIN,
      args,
      timeout_ms: timeout,
    }, { tenant: "local", by: "agentry.agent.dsh" });
  } catch (e) {
    events_out.emit("agent.dsh.spawn_failed", { error: e.message });
    throw new Error("agentry.agent.dsh: shell.spawn failed: " + e.message);
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

  return {
    output: {
      ok,
      exit_code,
      duration_ms: elapsed,
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
