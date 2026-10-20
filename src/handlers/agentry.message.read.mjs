// agentry/src/handlers/agentry.message.read.mjs
// v0.46.0 — read messages for an agent, optionally filtered by thread.
//
// agent_id: required. Only messages to_agent === agent_id are returned
//           by default. Pass include_sent=true to also include messages
//           FROM this agent (for reconstructing threads).
// thread_id: filter to a specific thread
// since:     only messages created_at >= since
// limit:     return at most N most recent

export default async function agentryMessageRead(input, ctx) {
  const { agent_id, thread_id, since, limit, include_sent } = input || {};
  if (!agent_id || typeof agent_id !== "string") throw new Error("agentry.message.read requires agent_id");

  const graph = ctx.graph;
  const msgs = [];

  for (const c of graph.capabilities().values()) {
    if (c.kind !== "message") continue;
    if (c.retired_at) continue;
    const toMe = c.to_agent === agent_id;
    const fromMe = include_sent && c.from_agent === agent_id;
    if (!toMe && !fromMe) continue;
    if (thread_id && c.thread_id !== thread_id) continue;
    if (since && c.created_at < Number(since)) continue;
    msgs.push({
      id: c.id,
      from_agent: c.from_agent,
      to_agent: c.to_agent,
      thread_id: c.thread_id,
      body: c.body,
      task_id: c.task_id || null,
      created_at: c.created_at,
      direction: toMe ? "in" : "out",
    });
  }

  msgs.sort((a, b) => a.created_at - b.created_at);
  const limited = limit ? msgs.slice(-Number(limit)) : msgs;

  return {
    output: { ok: true, agent_id, count: limited.length, messages: limited },
    cost: { time_ms: 0 },
  };
}
