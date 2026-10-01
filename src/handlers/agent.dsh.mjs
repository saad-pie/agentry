// agentry/src/handlers/agent.dsh.mjs
// Talks to the DeepSeek Harness business API (dsh-api-gateway plugin).
//
// Two auth layers:
//   - Admin token  → control endpoints (/api/dsh/_gw/*) and user creation
//   - User apiKey  → business endpoints (/api/dsh/task, /api/dsh/workspaces)
//
// On first use we create a user + workspace, then submit the task with the
// user's apiKey.

import { mkdirSync } from "node:fs";

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

// ---- cached ids/keys ----
let _userId = null;
let _userApiKey = null;
let _workspaceId = null;

// Ensure an agentry user exists. Returns { user_id, api_key }.
async function ensureUser() {
  if (_userId && _userApiKey) return { user_id: _userId, api_key: _userApiKey };

  // Try to list users first
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
        _userId = existing.id || existing.user_id;
        _userApiKey = existing.apiKey || existing.api_key;
        if (_userId && _userApiKey) return { user_id: _userId, api_key: _userApiKey };
      }
    }
  } catch (e) {
    // fall through to create
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
    throw new Error(`agent.dsh: user creation failed HTTP ${res.status} — ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  _userId = data.id || data.user_id || data.user?.id;
  _userApiKey = data.apiKey || data.api_key || data.user?.apiKey;
  if (!_userId || !_userApiKey) {
    throw new Error(`agent.dsh: user creation returned incomplete data — ${JSON.stringify(data).slice(0, 300)}`);
  }
  return { user_id: _userId, api_key: _userApiKey };
}

// Ensure a workspace exists. Returns workspace id.
async function ensureWorkspace(apiKey, name = "agentry-default") {
  if (_workspaceId) return _workspaceId;

  const workspacePath = process.env.DSH_WORKSPACE_PATH
    || `/tmp/home/.dsh/agentry-workspaces/${name}`;

  try {
    mkdirSync(workspacePath, { recursive: true });
  } catch (e) {
    throw new Error(`agent.dsh: cannot create workspace dir ${workspacePath} — ${e.message}`);
  }

  // Try list (with user key — workspaces belong to the user)
  try {
    const res = await fetch(`${BASE_URL}/api/dsh/workspaces`, {
      headers: userHeaders(apiKey),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json();
      const list = Array.isArray(data) ? data : (data.workspaces || data.items || []);
      const existing = list.find(w =>
        w.name === name || w.path === workspacePath
      );
      if (existing) {
        _workspaceId = existing.id || existing.slug || existing.name;
        return _workspaceId;
      }
    }
  } catch (e) {
    // fall through
  }

  // Create (with user key)
  const res = await fetch(`${BASE_URL}/api/dsh/workspaces`, {
    method: "POST",
    headers: userHeaders(apiKey),
    body: JSON.stringify({ name, path: workspacePath }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`agent.dsh: workspace creation failed HTTP ${res.status} — ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  _workspaceId = data.id || data.slug || data.name || data.workspace?.id;
  if (!_workspaceId) {
    throw new Error(`agent.dsh: workspace creation returned no id — ${JSON.stringify(data).slice(0, 300)}`);
  }
  return _workspaceId;
}

export default async function agentDsh(input, ctx) {
  const { prompt, workspace, timeout_ms = 20000 } = input || {};
  if (!prompt || typeof prompt !== "string") {
    throw new Error("agent.dsh requires prompt (string)");
  }

  const { api_key } = await ensureUser();
  const ws = workspace || await ensureWorkspace(api_key);

  const started = Date.now();
  const res = await fetch(`${BASE_URL}/api/dsh/task`, {
    method: "POST",
    headers: userHeaders(api_key),
    body: JSON.stringify({ prompt, workspace: ws }),
    signal: AbortSignal.timeout(timeout_ms),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`agent.dsh: task submit failed HTTP ${res.status} — ${text.slice(0, 300)}`);
    err.retryable = res.status >= 500;
    throw err;
  }

  const data = await res.json();
  const taskId = data.id || data.taskId || data.task_id;
  if (!taskId) {
    throw new Error(`agent.dsh: submit returned no task id — ${JSON.stringify(data).slice(0, 300)}`);
  }

  return {
    output: {
      task_id: taskId,
      workspace: ws,
      submitted_at: Date.now(),
      harness_response: data,
    },
    cost: { time_ms: Date.now() - started, http_calls: 1 },
  };
}
