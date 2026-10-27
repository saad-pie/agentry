// agentry/src/handlers/agentry.chat.mjs
// v0.48.1 — surface boot failures instead of silent NO_TASK.
//
// v0.43.0 — the user-facing parent loop.
//
// One capability, one job: take a natural-language message and turn it
// into a completed task. Plans via agent.plan, executes via agent.task,
// returns a human-readable summary + the structured trace for clients
// that want it.
//
// Design:
//   - message (required): the user's natural-language request
//   - agent_id (optional): use this agent. If absent, one is booted on
//     the fly (or reused if conversation_id matches a prior agent)
//   - conversation_id (optional): thread continuity. Prior turns are
//     passed to the planner so follow-ups have context.
//   - max_steps (default 8): passed to agent.plan
//   - execute_default (default true): false = plan-only, returns plan
//     without side effects. Useful for "what would you do" preflight.
//
// Return shape:
//   {
//     ok, conversation_id, agent_id,
//     message,              — human-readable summary (the "answer")
//     plan,                 — the steps executed (or planned)
//     task,                 — full task trace if executed (else null)
//     executed,             — bool
//     error                 — null or { phase, message } on failure
//   }
//
// This capability is the primary MCP tool. When a client wants to talk
// to agentry, it calls chat. Everything below (agent.plan, agent.task,
// task.run, ensure, agentry.agent.dsh) is now internal machinery.

// v0.49.1 — boot error captured + fallback to task.run on boot failure.
//
// v0.49.0 — structured failure task. Prior version returned task:null on
// every failure path, so callers (and tests) could not distinguish boot
// failure from empty plan from execution throw. Every failure now carries
// phase + message.
import { statSync } from "node:fs";

function failTask(phase, message) {
  return {
    task_id: null,
    state: "failed",
    owner_agent: null,
    trace: [],
    artifacts: [],
    error: { phase: String(phase), message: String(message || "unknown") },
  };
}

const DEFAULT_MAX_STEPS = 8;
const CONVERSATION_MEMORY_CAP = 10; // last N turns kept per thread

function genConversationId() {
  return "conv_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
}

function genEphemeralAgentName(conversationId) {
  return "chat_" + conversationId.replace(/[^a-z0-9]/gi, "_").slice(-20);
}

// Summarise a task trace into a human-readable message. Distinct
// messages for done/failed/handoff so the caller can act on the state.
function summariseTask(task) {
  if (!task) return "(no task)";
  // v0.43.1 — task.run's older failure returns omit state; use error as
  // a fallback signal so we name the failure instead of "unknown".
  const state = task.state || (task.error ? "failed" : "unknown");
  const steps = task.trace || [];
  const artifacts = task.artifacts || [];
  const ok_steps = steps.filter(s => s.ok).length;
  const fail_step = steps.find(s => !s.ok);

  if (state === "done") {
    const last = steps[steps.length - 1];
    const final = last?.output_keys?.length
      ? "Returned: " + last.output_keys.join(", ")
      : "(no output fields)";
    const art = artifacts.length
      ? " Produced " + artifacts.length + " artifact(s): " + artifacts.map(a => a.path || a.field).join(", ")
      : "";
    return "Completed " + ok_steps + "/" + steps.length + " step(s). " + final + "." + art;
  }
  if (state === "failed") {
    return "Failed at step " + ((fail_step?.step ?? -1) + 1) + " (" + (fail_step?.capability_id || "?") + "): " + (fail_step?.error?.message || task.error?.message || "unknown");
  }
  if (state === "handoff") {
    return "Ran out of budget at step " + (task.step_index + 1) + ". Remaining: " + JSON.stringify(task.remaining || {});
  }
  return "Task ended in state: " + state;
}

// Extract the "best answer" text from a task, if any step produced one.
// For DSH steps, that's trace[i].output_keys containing "final" (but
// trace only stores keys, not values — the values live in task
// artifacts/stepOutputs which aren't persisted). For most steps, the
// artifact paths are the answer. Return null if nothing text-shaped.
function extractAnswerFromTask(task) {
  // Best source: last successful step's trace entry output_keys.
  const steps = task.trace || [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (!s.ok) continue;
    // We don't persist step output values in trace (only keys). Fall
    // back to artifacts, which is what most callers want.
    const arts = (task.artifacts || []).filter(a => a.from_step === s.step);
    if (arts.length > 0) return null; // artifacts exist, summary already covers it
  }
  return null;
}

// Walk prior conversation messages for this thread. Retrieved from the
// events log, filtered by conversation_id. Cheap and correct.
function getPriorTurns(ctx, conversationId) {
  if (!conversationId) return [];
  try {
    const events = ctx.events.all();
    const turns = [];
    for (const e of events) {
      if (e.conversation_id !== conversationId) continue;
      if (e.kind === "chat.user_turn") turns.push({ role: "user", text: e.message || "" });
      if (e.kind === "chat.assistant_turn") turns.push({ role: "assistant", text: e.message || "" });
    }
    return turns.slice(-CONVERSATION_MEMORY_CAP * 2);
  } catch {
    return [];
  }
}

function tryDirectMatch(message, graph) {
  // v0.56.21 — if the message clearly names an existing capability and we
  // can build its required inputs from path-like tokens in the message,
  // invoke directly. Skips the entire planner (LLM call ~2-3s) plus the
  // agent boot + task wrap (~5s). Falls through to planner on any doubt.
  const tokens = message.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
  if (tokens.length === 0) return null;
  const candidates = [];
  for (const c of graph.capabilities().values()) {
    if (c.retired_at) continue;
    if (!c.invoked_via) continue;
    if (c.kind === "agent" || c.kind === "edge" || c.kind === "capability_gap"
     || c.kind === "watch_instance" || c.kind === "proposal"
     || c.kind === "synthesis_attempt" || c.kind === "task" || c.kind === "message") continue;
    const hay = (String(c.id || "") + " " + String(c.notes || "") + " " + String(c.description || "")).toLowerCase();
    let score = 0;
    for (const t of tokens) if (hay.includes(t)) score++;
    if (score > 0) candidates.push({ cap: c, score });
  }
  if (candidates.length === 0) return null;
  // v0.56.23 — sort by score, then by trial_passed_at (newest first)
  // as tiebreaker. Without this, 4 duplicate csv_to_parquet caps all score 3
  // and the tie returns null → planner picks arbitrary (often the oldest,
  // broken one). Newest-trial-passed wins ties cleanly.
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const _aT = Number(a.cap.trial_passed_at || a.cap.adopted_from?.synthesized_at || 0);
    const _bT = Number(b.cap.trial_passed_at || b.cap.adopted_from?.synthesized_at || 0);
    return _bT - _aT;
  });
  const best = candidates[0];
  const second = candidates[1];
  if (best.score < 2) return null;
  // v0.56.27 — dynamic path extraction. Any fixed cap on extension length has
  // the same failure mode (parquet was truncated by \w{1,6}, then markdown by
  // \w{1,12} would break on .webmanifest). Filesystem-based classification:
  //   1. Match /-prefixed strings, keep only those whose last segment has an
  //      extension >= 2 chars (any length, no cap)
  //   2. fs.statSync each: file exists → input, missing → output
  //   3. Assign to accepts keys by hint (input/output/src/dst) + extension
  //   4. Fallback: leftover unused paths fill other path-like keys
  const accepts = Object.keys(best.cap.accepts || {});
  const input = {};
  const pathKeys = accepts.filter(k => /path|_file$|_dir$/.test(k));
  if (pathKeys.length > 0) {
    const _rawPaths = [...message.matchAll(/\/[\w./-]+/g)].map(m => m[0]);
    const _paths = _rawPaths.filter(p => {
      const _last = p.split("/").pop() || "";
      return _last.includes(".") && (_last.split(".").pop() || "").length >= 2;
    });
    if (_paths.length > 0) {
      const _existing = [];
      const _future = [];
      for (const p of _paths) {
        try { const st = statSync(p); if (st.isFile()) _existing.push(p); else _future.push(p); }
        catch { _future.push(p); }
      }
      const _inKeys = pathKeys.filter(k => /input|_in$|^src|source/.test(k));
      const _outKeys = pathKeys.filter(k => /output|_out$|^dst|dest|target/.test(k));
      const _otherKeys = pathKeys.filter(k => !_inKeys.includes(k) && !_outKeys.includes(k));
      const _usedEx = new Set();
      const _usedFu = new Set();
      const _tryExt = (pool, key, usedSet) => {
        const m = key.match(/_(\w+?)(_path|_file|_dir)$/);
        if (!m) return null;
        const hint = m[1].toLowerCase();
        for (const p of pool) {
          if (usedSet.has(p)) continue;
          if (p.toLowerCase().endsWith("." + hint)) return p;
        }
        return null;
      };
      for (const k of _inKeys) {
        const byExt = _tryExt(_existing, k, _usedEx);
        if (byExt) { input[k] = byExt; _usedEx.add(byExt); continue; }
        const p = _existing.find(x => !_usedEx.has(x));
        if (p) { input[k] = p; _usedEx.add(p); }
      }
      for (const k of _outKeys) {
        const byExt = _tryExt(_future, k, _usedFu);
        if (byExt) { input[k] = byExt; _usedFu.add(byExt); continue; }
        const p = _future.find(x => !_usedFu.has(x));
        if (p) { input[k] = p; _usedFu.add(p); }
      }
      for (const k of _otherKeys) {
        const leftover = [..._existing.filter(p => !_usedEx.has(p)), ..._future.filter(p => !_usedFu.has(p))];
        if (leftover.length > 0) input[k] = leftover[0];
      }
    }
  }
  // Require every non-optional accepts key to be filled
  for (const k of accepts) {
    const spec = best.cap.accepts[k];
    const optional = spec && typeof spec === "object" && spec.optional === true;
    if (!optional && input[k] === undefined) return null;
  }
  return { capability_id: best.cap.id, input, score: best.score, gap: best.score - (second ? second.score : 0), kind: best.cap.kind, produces: best.cap.produces || {} };
}

export default async function agentryChat(input, ctx) {
  const {
    message,
    agent_id,
    conversation_id,
    max_steps,
    execute_default,
  } = input || {};
  if (!message || typeof message !== "string" || !message.trim()) {
    throw new Error("agentry.chat requires message (non-empty string)");
  }
  if (typeof ctx.invoke !== "function") throw new Error("agentry.chat requires ctx.invoke");

  const graph = ctx.graph;
  const events = ctx.events;
  const started = Date.now();

  const conversationId = conversation_id || genConversationId();
  const execute = execute_default !== false;
  const maxSteps = Math.max(1, Math.min(20, Number(max_steps) || DEFAULT_MAX_STEPS));

  // ── 1. Resolve / boot agent ──
  let agentId = agent_id;
  if (!agentId) {
    // If this conversation already has an agent (from prior turns), reuse it.
    // Otherwise boot a fresh one named after the conversation.
    const priorTurns = getPriorTurns(ctx, conversationId);
    const priorAgent = priorTurns.length > 0
      ? null // we don't track per-turn agent_ids; boot fresh under conv name
      : null;
    const agentName = genEphemeralAgentName(conversationId);
    // Check if an agent with this deterministic name already exists
    const existingCandidates = [...graph.capabilities().values()].filter(c =>
      c.kind === "agent" && c.name === agentName && !c.retired_at
    );
    if (existingCandidates.length > 0) {
      agentId = existingCandidates[0].id;
    } else {
            let bootError = null;
      try {
        const boot = await ctx.invoke("agentry.agent.boot", { name: agentName },
          { tenant: "local", by: "agentry.chat" });
        if (boot.ok && boot.output?.agent_id) {
          agentId = boot.output.agent_id;
        } else {
          bootError = "boot returned ok=" + boot.ok +
            " agent_id=" + JSON.stringify(boot.output?.agent_id || null) +
            " error=" + (boot.error?.message || "none");
        }
      } catch (e) {
        bootError = "boot threw: " + e.message;
      }
      if (bootError) {
        events.emit("chat.agent_boot_failed", { conversation_id: conversationId, error: bootError });
      }
    }
  }

  // ── 2. Log user turn ──
  events.emit("chat.user_turn", {
    conversation_id: conversationId,
    agent_id: agentId || null,
    message: String(message).slice(0, 2000),
  });

  // ── 2.5 v0.56.21 — fast path: direct match ──
  const _direct = tryDirectMatch(String(message), graph);
  if (_direct) {
    events.emit("chat.direct_match", {
      conversation_id: conversationId, agent_id: agentId,
      capability_id: _direct.capability_id, score: _direct.score, gap: _direct.gap, kind: _direct.kind,
    });
    const _directStarted = Date.now();
    try {
      const _r = await ctx.invoke(_direct.capability_id, _direct.input, {
        tenant: "local", by: "agentry.chat.direct", task_id: ctx.task_id,
      });
      const _directMs = Date.now() - _directStarted;
      if (_r.ok) {
        // v0.56.25 — build artifacts from produces path fields, verify each
        // exists. Prior version trusted _r.output.artifacts which handlers
        // never return (handlers return flat fields like {output_path, bytes}).
        // Result: ok:true with artifacts:[] even when handler wrote a file.
        const _artifacts = [];
        const _produces = _direct.produces || {};
        const _outputObj = _r.output || {};
        for (const _k of Object.keys(_produces)) {
          const _v = _outputObj[_k];
          if (typeof _v !== "string" || !_v) continue;
          if (!/\.\w{2,12}$/.test(_v) && !_v.startsWith("/")) continue;
          try {
            const _st = statSync(_v);
            if (_st.isFile() && _st.size > 0) {
              _artifacts.push({ kind: "file", field: _k, path: _v, bytes: _st.size, from_step: 0 });
            }
          } catch {}
        }
        const _artifactMissing = (_artifacts.length === 0 && Object.keys(_produces).some(k => /path|_file|_out/.test(k)));
        events.emit("chat.direct_success", {
          conversation_id: conversationId, capability_id: _direct.capability_id, ms: _directMs,
          artifacts_count: _artifacts.length,
          artifact_missing: _artifactMissing,
        });
        events.emit("chat.assistant_turn", {
          conversation_id: conversationId, agent_id: agentId,
          message: "Executed " + _direct.capability_id + " directly (" + _directMs + "ms, " + _artifacts.length + " artifacts)",
        });
        return {
          output: {
            ok: true, conversation_id: conversationId, agent_id: agentId,
            message: "Executed " + _direct.capability_id + " directly (" + _artifacts.length + " artifacts)" +
              (_artifactMissing ? " — WARNING: no artifact file produced" : ""),
            plan: [{ capability_id: _direct.capability_id, input: _direct.input, why: "direct_match", score: _direct.score }],
            task: {
              task_id: null, state: "done",
              artifacts: _artifacts,
              trace: [{ step: 0, capability_id: _direct.capability_id, ok: true, ms: _directMs, output_keys: Object.keys(_outputObj), artifact_missing: _artifactMissing }],
              error: null,
            },
            executed: true, error: null, via: "direct_match",
          },
          cost: { time_ms: Date.now() - started },
        };
      }
      events.emit("chat.direct_failed", {
        conversation_id: conversationId, capability_id: _direct.capability_id,
        ms: _directMs, error: _r.error && _r.error.message,
      });
      // Fall through — planner might route differently or fix input shape
    } catch (e) {
      events.emit("chat.direct_threw", {
        conversation_id: conversationId, capability_id: _direct.capability_id, error: e.message,
      });
      // Fall through
    }
  }

  // ── 3. Plan ──
  // Prior turns inform the planner via a prefix in the intent.
  const priorTurns = getPriorTurns(ctx, conversationId);
  const priorContext = priorTurns.length > 0
    ? "Prior conversation:\n" + priorTurns.map(t => t.role + ": " + t.text).join("\n") + "\n\nCurrent request: "
    : "";
  const intentWithContext = priorContext + String(message);

  let planRes;
  try {
    planRes = await ctx.invoke("agentry.agent.plan", {
      intent: intentWithContext,
      agent_id: agentId || undefined,
      max_steps: maxSteps,
      execute: false,
    }, { tenant: "local", by: "agentry.chat", });
  } catch (e) {
    events.emit("chat.plan_threw", { conversation_id: conversationId, error: e.message });
    const errMsg = "Planning failed: " + e.message;
    events.emit("chat.assistant_turn", { conversation_id: conversationId, agent_id: agentId, message: errMsg });
    return {
      output: {
        ok: false, conversation_id: conversationId, agent_id: agentId,
        message: errMsg, plan: null, task: failTask("plan", e.message), executed: false,
        error: { phase: "plan", message: e.message },
      },
      cost: { time_ms: Date.now() - started },
    };
  }
  if (!planRes.ok) {
    events.emit("chat.plan_failed", { conversation_id: conversationId, error: planRes.error });
    const errMsg = "Planning failed: " + (planRes.error?.message || "unknown");
    events.emit("chat.assistant_turn", { conversation_id: conversationId, agent_id: agentId, message: errMsg });
    return {
      output: {
        ok: false, conversation_id: conversationId, agent_id: agentId,
        message: errMsg, plan: null, task: failTask("plan", planRes.error?.message || "unknown"), executed: false,
        error: { phase: "plan", message: planRes.error?.message || "unknown" },
      },
      cost: { time_ms: Date.now() - started },
    };
  }

  const plan = planRes.output.plan || [];
  events.emit("chat.plan_ready", {
    conversation_id: conversationId,
    agent_id: agentId,
    steps: plan.length,
    capabilities: plan.map(s => s.capability_id),
  });

  // ── 4. If plan-only, return early ──
  if (!execute) {
    const summary = "Planned " + plan.length + " step(s): " + plan.map(s => s.capability_id).join(" → ");
    events.emit("chat.assistant_turn", { conversation_id: conversationId, agent_id: agentId, message: summary });
    return {
      output: {
        ok: true, conversation_id: conversationId, agent_id: agentId,
        message: summary, plan, task: null, executed: false, error: null,
      },
      cost: { time_ms: Date.now() - started, http_calls: 1 },
    };
  }

  // ── 5. Execute via agent.task ──
  if (!agentId) {
    const bootReason = (function() {
      try {
        const recent = ctx.events.all().filter(e => e.kind === "chat.agent_boot_failed" && e.conversation_id === conversationId).slice(-1)[0];
        return recent ? recent.error : "unknown (no boot attempt logged)";
      } catch { return "unknown"; }
    })();
    const errMsg = "Cannot execute: no agent could be booted. Reason: " + bootReason;
    events.emit("chat.assistant_turn", { conversation_id: conversationId, agent_id: null, message: errMsg });
    return {
      output: {
        ok: false, conversation_id: conversationId, agent_id: null,
        message: errMsg, plan, task: failTask("boot", bootReason || "no agent"), executed: false,
        error: { phase: "boot", message: bootReason || "no agent" },
      },
      cost: { time_ms: Date.now() - started },
    };
  }

  let taskRes;
  try {
    taskRes = await ctx.invoke("agentry.agent.task", {
      agent_id: agentId,
      intent: String(message),
      plan,
    }, { tenant: "local", by: "agentry.chat" });
  } catch (e) {
    events.emit("chat.task_threw", { conversation_id: conversationId, error: e.message });
    const errMsg = "Execution failed: " + e.message;
    events.emit("chat.assistant_turn", { conversation_id: conversationId, agent_id: agentId, message: errMsg });
    return {
      output: {
        ok: false, conversation_id: conversationId, agent_id: agentId,
        message: errMsg, plan, task: failTask("execute", e.message), executed: true,
        error: { phase: "execute", message: e.message },
      },
      cost: { time_ms: Date.now() - started },
    };
  }

  const task = taskRes.output || {};
  const summarised = summariseTask(task);
  const ok = task.state === "done" && task.ok === true;

  events.emit("chat.assistant_turn", {
    conversation_id: conversationId,
    agent_id: agentId,
    message: summarised,
    task_id: task.task_id,
    state: task.state,
  });
  events.emit("chat.completed", {
    conversation_id: conversationId,
    agent_id: agentId,
    task_id: task.task_id,
    ok,
    steps: (task.trace || []).length,
    artifacts: (task.artifacts || []).length,
    ms: Date.now() - started,
  });

  return {
    output: {
      ok,
      conversation_id: conversationId,
      agent_id: agentId,
      message: summarised,
      plan,
      task,
      executed: true,
      error: ok ? null : { phase: "execute", message: summarised },
    },
    cost: {
      time_ms: Date.now() - started,
      http_calls: 1,
    },
  };
}
