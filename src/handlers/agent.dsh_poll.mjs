// agentry/src/handlers/agent.dsh_poll.mjs
// Polls a task submitted via agent.dsh until it completes or times out.

const BASE_URL = process.env.DSH_BASE_URL || "http://127.0.0.1:7861";
const ADMIN_TOKEN = process.env.DSH_ADMIN_TOKEN || "dsh-admin-2024";

function authHeaders() {
  return {
    "authorization": `Bearer ${ADMIN_TOKEN}`,
    "x-api-key": ADMIN_TOKEN,
    "content-type": "application/json",
  };
}

export default async function agentDshPoll(input, ctx) {
  const { task_id, max_wait_ms = 300000, poll_interval_ms = 2000 } = input || {};
  if (!task_id) throw new Error("agent.dsh_poll requires task_id");

  const started = Date.now();
  let lastStatus = null;

  while (Date.now() - started < max_wait_ms) {
    const res = await fetch(`${BASE_URL}/api/dsh/task/${encodeURIComponent(task_id)}`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      if (res.status === 404) {
        return {
          output: { task_id, status: "not_found", final: true },
          cost: { time_ms: Date.now() - started },
        };
      }
      const text = await res.text().catch(() => "");
      throw new Error(`agent.dsh_poll: HTTP ${res.status} — ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    lastStatus = data.status || data.state;

    // Terminal states
    const done = ["completed", "done", "success", "succeeded", "finished", "error", "failed", "cancelled"];
    if (lastStatus && done.includes(String(lastStatus).toLowerCase())) {
      return {
        output: {
          task_id,
          status: lastStatus,
          final: true,
          result: data.result ?? data.output ?? data.message ?? null,
          error: data.error ?? null,
          raw: data,
        },
        cost: { time_ms: Date.now() - started, http_calls: 1 },
      };
    }

    await new Promise(r => setTimeout(r, poll_interval_ms));
  }

  return {
    output: {
      task_id,
      status: lastStatus || "timeout",
      final: false,
      note: `Did not reach a terminal state within ${max_wait_ms}ms`,
    },
    cost: { time_ms: Date.now() - started },
  };
}
