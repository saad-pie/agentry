// agentry/src/handlers/agent.dsh.mjs
// Talks to the DeepSeek Harness business API (dsh-api-gateway plugin).
//
// Auth model (from docs/api.md):
//   - Control endpoints (_gw/*):  admin token
//   - User management, workspaces: admin token
//   - Task submission, task query: user apiKey
//   - Header: x-api-key: <token>   (Authorization: Bearer also accepted)
//
// First use creates an agentry user + a workspace. Both are cached.

import { mkdirSync } from "node:fs";

const BASE_URL = process.env.DSH_BASE_URL || "http://127.0.0.1:7861";
const ADMIN_TOKEN = process.env.DSH_ADMIN_TOKEN || "dsh-admin-2024";
const AGENTRY_USER_NAME = process.env.DSH_USER_NAME || "agentry";
const DEFAULT_WORKSPACE_NAME = process.env.DSH_WORKSPACE_NAME || "agentry-default";
const DEFAULT_WORKSPACE_PATH =
  process.env.DSH_WORKSPACE_PATH || "/tmp/home/.dsh/agentry-workspaces/default";

function adminHeaders() {
  return {
    "x-api-key": ADMIN_TOKEN,
    "content-type": "application/json",
  };
}

function userHeaders(apiKey) {
  return {
    "x-api-key": apiKey,
    "content-type": "application/json",
  };
}

// ---- process-lifetime cache ----
let _userId = null;
let _userApiKey = null;
let _workspaceId = null;

// Ensure the agentry user exists, return { userId, apiKey }.
async function ensureUser() {
  if (_userId && _userApiKey) return { userId: _userId, apiKey: _userApiKey };

  // List (admin)
  try {
    const res = await fetch(`${BASE_URL}/api/dsh/users`, {
      headers: adminHeaders(),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const list = await res.json();
      if (Array.isArray(list)) {
        const existing = list.find(u => u.name === AGENTRY_USER_NAME);
        if (existing?.id && existing?.apiKey) {
          _userId = existing.id;
          _userApiKey = existing.apiKey;
          return { userId: _userId, apiKey: _userApiKey };
        }
      }
    }
  } catch { /* fall through to create */ }

  // Create (admin)
  const res = await fetch(`${BASE_URL}/api/dsh/users`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ name: AGENTRY_USER_NAME }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`agent.dsh: user creation failed HTTP ${res.status} — ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  if (!data.id || !data.apiKey) {
    throw new Error(`agent.dsh: user creation returned incomplete data — ${JSON.stringify(data).slice(0, 300)}`);
  }
  _userId = data.id;
  _userApiKey = data.apiKey;
  return { userId: _userId, apiKey: _userApiKey };
}

// Ensure a workspace exists, return its id.
async function ensureWorkspace(name = DEFAULT_WORKSPACE_NAME, path = DEFAULT_WORKSPACE_PATH) {
  if (_workspaceId) return _workspaceId;

  try { mkdirSync(path, { recursive: true }); }
  catch (e) { throw new Error(`agent.dsh: cannot create workspace dir ${path} — ${e.message}`); }

  // List (admin)
  try {
    const res = await fetch(`${BASE_URL}/api/dsh/workspaces`, {
      headers: adminHeaders(),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const list = await res.json();
      if (Array.isArray(list)) {
        const existing = list.find(w => w.name === name || w.path === path);
        if (existing?.id) { _workspaceId = existing.id; return _workspaceId; }
      }
    }
  } catch { /* fall through to create */ }

  // Create (admin)
  const res = await fetch(`${BASE_URL}/api/dsh/workspaces`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ path, name }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`agent.dsh: workspace creation failed HTTP ${res.status} — ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  if (!data.id) {
    throw new Error(`agent.dsh: workspace creation returned no id — ${JSON.stringify(data).slice(0, 300)}`);
  }
  _workspaceId = data.id;
  return _workspaceId;
}

export default async function agentDsh(input, ctx) {
  const { prompt, workspaceId, provider, model, max_tokens, timeout_ms = 30000 } = input || {};
  if (!prompt || typeof prompt !== "string") {
    throw new Error("agent.dsh requires prompt (string)");
  }

  const { apiKey } = await ensureUser();
  const wsId = workspaceId || await ensureWorkspace();

  const body = { workspaceId: wsId, prompt };
  if (provider) body.provider = provider;
  if (model) body.model = model;
  if (max_tokens) body.maxTokens = max_tokens;

  const started = Date.now();
  const res = await fetch(`${BASE_URL}/api/dsh/task`, {
    method: "POST",
    headers: userHeaders(apiKey),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout_ms),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`agent.dsh: task submit failed HTTP ${res.status} — ${text.slice(0, 300)}`);
    err.retryable = res.status >= 500;
    throw err;
  }

  const data = await res.json();
  if (!data.taskId) {
    throw new Error(`agent.dsh: submit returned no taskId — ${JSON.stringify(data).slice(0, 300)}`);
  }

  return {
    output: {
      task_id: data.taskId,
      session_id: data.sessionId || null,
      workspace_id: data.workspaceId || wsId,
      user_id: data.userId || null,
      submitted_at: Date.now(),
    },
    cost: { time_ms: Date.now() - started, http_calls: 1 },
  };
}
