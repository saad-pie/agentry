// agentry/src/handlers/agentry.message.send.mjs
// v0.46.0 — the message primitive. Agents talking to agents.
//
// A message is a graph node with no handler and no invocation. It's a
// record. Agents read their inbox via agentry.message.read (or via chat
// context). This is what makes multi-agent collaboration a data problem
// instead of an orchestration problem — messages are just nodes.

export default async function agentryMessageSend(input, ctx) {
  const { from_agent, to_agent, body, thread_id, task_id } = input || {};
  if (!from_agent || typeof from_agent !== "string") throw new Error("agentry.message.send requires from_agent");
  if (!to_agent || typeof to_agent !== "string") throw new Error("agentry.message.send requires to_agent");
  if (!body || typeof body !== "string" || !body.trim()) throw new Error("agentry.message.send requires non-empty body");
  if (typeof ctx.invoke !== "function") throw new Error("agentry.message.send requires ctx.invoke");

  const graph = ctx.graph;
  const events = ctx.events;

  // Sender and recipient must exist as agent nodes
  const from = graph.getCapability(from_agent);
  if (!from || from.kind !== "agent" || from.retired_at) {
    throw new Error("agentry.message.send: from_agent not found or not an active agent: " + from_agent);
  }
  const to = graph.getCapability(to_agent);
  if (!to || to.kind !== "agent" || to.retired_at) {
    throw new Error("agentry.message.send: to_agent not found or not an active agent: " + to_agent);
  }

  const msgId = "msg_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
  const threadId = thread_id || ("thread_" + Date.now().toString(36));
  const node = {
    id: msgId,
    kind: "message",
    from_agent,
    to_agent,
    thread_id: threadId,
    body: String(body).slice(0, 10000),
    task_id: task_id || null,
    created_at: Date.now(),
  };
  graph.putCapability(node);
  events.emit("message.sent", {
    message_id: msgId, from_agent, to_agent, thread_id: threadId,
    body_len: node.body.length, task_id: node.task_id,
  });

  return {
    output: { ok: true, message_id: msgId, thread_id: threadId, from_agent, to_agent, sent_at: node.created_at },
    cost: { time_ms: 0 },
  };
}
