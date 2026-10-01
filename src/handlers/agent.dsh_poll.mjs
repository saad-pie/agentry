// agentry/src/handlers/agent.dsh_poll.mjs
// Polls a task submitted via agent.dsh until it completes or times out.
//
// Uses the user apiKey (not the admin token) because business endpoints
// authenticate with per-user keys. The user is the same one agent.dsh creates.

const BASE_URL = process.env.DSH_BASE_URL || "http://127.0.0.1:7861";
const ADMIN_TOKEN = process.env.DSH_ADMIN_TOKEN || "dsh-admin-2024";
const AGENTRY_USER_NAME = process.env.DSH_USER_NAME || "agentry";
const AGENTRY_USER_EMAIL = process.env.DSH_USER_EMAIL || "agentry@local";

function adminHeaders() {
  return {
    "authorization": `Bearer ${ADMIN_TOKEN}`,
    "x-api-key": ADMIN_TOKEN,
    "content-type": "application/json",
  };
}

function userHeaders(apiKey) {
  return {
    "authorization": `Bearer ${apiKey}`,
    "x-api-key": apiKey,
    "content-type": "application/json",
  };
}

// ---- cached user apiKey (shared pattern with agent.dsh.mjs) ----
let _userApiKey = null;

// Ensure the agentry user exists, return its apiKey.
async function ensureUser() {
  if (_userApiKey) return _userApiKey;

  // Try list
  try {
    const res = await fetch(`${BASE_URL}/api/dsh/users`, {
      headers: adminHeaders(),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json();
      const list = Array.isArray(data) ? data : (data.users || data.items || []);
      const existing = list.find(u =>
        u.name === AGENTRY_USER_NAME || u.email === AGENTRY_USER_EMAIL
      );
      if (existing) {
        _userApiKey = existing.apiKey || existing.api_key;
        if (_userApiKey) return _userApiKey;
      }
    }
  } catch (e) {
    // fall through
  }

  // Create
  const res = await fetch(`${BASE_URL}/api/dsh/users`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({
      name: AGENTRY_USER_NAME,
      email: AGENTRY_USER_EMAIL,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`agent.dsh_poll: user creation failed HTTP ${res.status} — ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  _userApiKey = data.apiKey || data.api_key || data.user?.apiKey;
  if (!_userApiKey) {
    throw new Error(`agent.dsh_poll: user creation returned no apiKey — ${JSON.stringify(data).slice(0, 300)}`);
  }
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
