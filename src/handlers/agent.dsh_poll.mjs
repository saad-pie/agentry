// agentry/src/handlers/agent.dsh_poll.mjs
// Polls a task submitted via agent.dsh until status becomes "done".
// From the API docs: status is either "running" or "done", result is in `output`.

const BASE_URL = process.env.DSH_BASE_URL || "http://127.0.0.1:7861";
const ADMIN_TOKEN = process.env.DSH_ADMIN_TOKEN || "dsh-admin-2024";
const AGENTRY_USER_NAME = process.env.DSH_USER_NAME || "agentry";

function adminHeaders() {
  return { "x-api-key": ADMIN_TOKEN, "content-type": "application/json" };
}
function userHeaders(apiKey) {
  return { "x-api-key": apiKey, "content-type": "application/json" };
}

let _userApiKey = null;

async function ensureUser() {
  if (_userApiKey) return _userApiKey;

  try {
    const res = await fetch(`${BASE_URL}/api/dsh/users`, {
      headers: adminHeaders(),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const list = await res.json();
      if (Array.isArray(list)) {
        const existing = list.find(u => u.name === AGENTRY_USER_NAME);
        if (existing?.apiKey) { _userApiKey = existing.apiKey; return _userApiKey; }
      }
    }
  } catch { /* fall through */ }

  const res = await fetch(`${BASE_URL}/api/dsh/users`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ name: AGENTRY_USER_NAME }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`agent.dsh_poll: user creation failed HTTP ${res.status} — ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  if (!data.apiKey) {
    throw new Error(`agent.dsh_poll: no apiKey in user creation response — ${JSON.stringify(data).slice(0, 300)}`);
  }
  _userApiKey = data.apiKey;
  return _userApiKey;
}

export default async function agentDshPoll(input, ctx) {
  const { task_id, max_wait_ms = 300000, poll_interval_ms = 2000 } = input || {};
  if (!task_id) throw new Error("agent.dsh_poll requires task_id");

  const apiKey = await ensureUser();
  const started = Date.now();
  let lastStatus = null;

  while (Date.now() - started < max_wait_ms) {
    const res = await fetch(`${BASE_URL}/api/dsh/task/${encodeURIComponent(task_id)}`, {
      headers: userHeaders(apiKey),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      if (res.status === 404) {
        return {
          output: { task_id, status: "not_found", final: true },
          cost: { time_ms: Date.now() - started, http_calls: 1 },
        };
      }
      const text = await res.text().catch(() => "");
      throw new Error(`agent.dsh_poll: HTTP ${res.status} — ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    lastStatus = data.status;

    // Docs: status is "running" or "done". Only "done" is terminal.
    if (lastStatus === "done") {
      return {
        output: {
          task_id,
          status: "done",
          final: true,
          output: data.output ?? null,
          messages: data.messages ?? null,
          session_id: data.sessionId ?? null,
          workspace_id: data.workspaceId ?? null,
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
      note: `Did not reach "done" within ${max_wait_ms}ms`,
    },
    cost: { time_ms: Date.now() - started },
  };
}
