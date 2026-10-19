// agentry/src/handlers/agentry.agent.task.mjs
// v0.35.0 — agent-scoped task execution.
//
// A wrapper around agentry.task.run that binds a task to an agent's
// home session and records attribution on the agent node.
//
// Design:
//   1. Verify agent: exists, kind=agent, not retired, state=active
//   2. Call task.run with session_id = agent.home_session
//   3. Stamp owner_agent on the resulting task node (task.run doesn't
//      accept owner_agent as input in v0.33.x — that's a data write,
//      not a behavior change, so we do it here after the fact)
//   4. On state=done: task_count++, last_task_id, last_task_at on agent
//   5. Return task output with owner_agent attached
//
// The reason this is a separate capability and not a task.run parameter:
// attribution is a policy concern (who owns this work), not a mechanical
// concern (execute this plan). Keeping them separate means task.run stays
// a pure executor and attribution lives at the agent layer where it belongs.

export default async function agentryAgentTask(input, ctx) {
  const { agent_id, intent, plan, task_id, budget } = input || {};
  if (!agent_id) throw new Error("agentry.agent.task requires agent_id");
  if (typeof ctx.invoke !== "function") throw new Error("agentry.agent.task requires ctx.invoke");

  const graph = ctx.graph;
  const events = ctx.events;
  const started = Date.now();

  // ── 1. Resolve agent ──
  const agent = graph.getCapability(agent_id);
  if (!agent) throw new Error("agentry.agent.task: agent not found: " + agent_id);
  if (agent.kind !== "agent") throw new Error("agentry.agent.task: " + agent_id + " is kind " + agent.kind + ", not agent");
  if (agent.retired_at) throw new Error("agentry.agent.task: agent is retired: " + agent_id);
  if (agent.state && agent.state !== "active") {
    throw new Error("agentry.agent.task: agent state is " + agent.state + ", not active");
  }
  if (!agent.home_session) {
    throw new Error("agentry.agent.task: agent has no home_session: " + agent_id);
  }

  // ── 2. Delegate to task.run with agent's home session ──
  let taskRes;
  try {
    taskRes = await ctx.invoke("agentry.task.run", {
      intent, plan, task_id, budget,
      session_id: agent.home_session,
    }, { tenant: "local", by: "agentry.agent.task", task_id });
  } catch (e) {
    events.emit("agent.task.threw", { agent_id, error: e.message });
    throw new Error("agentry.agent.task: task.run threw: " + e.message);
  }

  const out = taskRes.output || {};

  // ── 3. Stamp owner_agent on the task node ──
  const resolvedTaskId = out.task_id;
  if (resolvedTaskId) {
    try {
      const taskNode = graph.getCapability(resolvedTaskId);
      if (taskNode && taskNode.kind === "task" && !taskNode.owner_agent) {
        graph.putCapability({ id: resolvedTaskId, owner_agent: agent_id });
      }
    } catch (e) {
      events.emit("agent.task.owner_stamp_failed", { agent_id, task_id: resolvedTaskId, error: e.message });
    }
  }

  // ── 4. Update agent counters on success ──
  const success = out.state === "done" && out.ok === true;
  if (success) {
    try {
      graph.putCapability({
        id: agent_id,
        task_count: (agent.task_count || 0) + 1,
        last_task_id: resolvedTaskId,
        last_task_at: Date.now(),
      });
    } catch (e) {
      events.emit("agent.task.counter_failed", { agent_id, error: e.message });
    }
  }

  events.emit("agent.task.completed", {
    agent_id,
    task_id: resolvedTaskId,
    state: out.state,
    ok: out.ok === true,
    steps: (out.trace || []).length,
    artifacts: (out.artifacts || []).length,
    ms: Date.now() - started,
  });

  return {
    output: {
      ...out,
      owner_agent: agent_id,
      home_session: agent.home_session,
    },
    cost: { time_ms: Date.now() - started },
  };
}
