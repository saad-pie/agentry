// agentry/src/handlers/agent.dsh_poll.mjs
// Polls a task submitted via agent.dsh until status becomes "done".
//
// The gateway puts the model's answer in one of two places:
//   - data.output   : string, populated for plain-text completions
//   - data.messages : array, populated when the harness ran tools or
//                     injected a system-reminder. The final assistant
//                     message is the answer.
//
// We normalize both into `output` (a string) and also expose `raw_output`
// and `messages` so callers that want the full transcript can read it.

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

// Strip <system-reminder>...</system-reminder> blocks that the gateway
// injects into every message. They're not part of the model's answer.
function stripSystemReminder(text) {
  return String(text).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

// Pick the model's answer out of a task response.
// Priority:
//   1. `output` if it's a non-empty string.
//   2. Last message with role "assistant".
//   3. Last non-empty message of any role.
// Returns "" if nothing usable.
function extractText(data) {
  if (typeof data.output === "string" && data.output.trim().length > 0) {
    return data.output;
  }
  const msgs = Array.isArray(data.messages) ? data.messages : [];
  if (!msgs.length) return "";

  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role === "assistant" && typeof m.text === "string" && m.text.trim()) {
      const cleaned = stripSystemReminder(m.text);
      if (cleaned) return cleaned;
    }
  }
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (typeof m?.text === "string" && m.text.trim()) {
      const cleaned = stripSystemReminder(m.text);
      if (cleaned) return cleaned;
    }
  }
  return "";
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
          output: {
            task_id, status: "not_found", final: true,
            output: "", raw_output: null, messages: [],
          },
          cost: { time_ms: Date.now() - started, http_calls: 1 },
        };
      }
      const text = await res.text().catch(() => "");
      throw new Error(`agent.dsh_poll: HTTP ${res.status} — ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    lastStatus = data.status;

    if (lastStatus === "done") {
      const rawMessages = Array.isArray(data.messages) ? data.messages : [];
      const text = extractText(data);

      ctx?.events?.emit("agent.dsh_poll.completed", {
        task_id,
        raw_output_len: typeof data.output === "string" ? data.output.length : 0,
        messages_count: rawMessages.length,
        extracted_len: text.length,
      });

      return {
        output: {
          task_id,
          status: "done",
          final: true,
          output: text,                        // normalized answer (string)
          raw_output: data.output ?? null,     // untouched gateway field
          messages: rawMessages,               // always an array
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
      output: "",
      raw_output: null,
      messages: [],
      note: `Did not reach "done" within ${max_wait_ms}ms`,
    },
    cost: { time_ms: Date.now() - started },
  };
}
