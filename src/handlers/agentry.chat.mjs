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
