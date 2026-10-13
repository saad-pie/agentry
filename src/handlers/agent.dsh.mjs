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
//
// Workspaces can be targeted by id (`workspaceId`) or by name
// (`workspace`). The name variant resolves through ensureWorkspace,
// which lists and creates as needed — used by agentry.reason.harness
// to submit into the `reasoner` workspace (no AGENTS.md, no recursion).
//
// v0.15.4 — always pass an explicit model. The gateway pins the model on
// the first submit to a workspace and 409s on mismatch afterwards.
// Relying on the gateway's default was silently binding every workspace
// to atria/space-bunny-alpha:free, which returns empty output.

import { mkdirSync } from "node:fs";

const BASE_URL = process.env.DSH_BASE_URL || "http://127.0.0.1:7861";
const ADMIN_TOKEN = process.env.DSH_ADMIN_TOKEN || "dsh-admin-2024";
const AGENTRY_USER_NAME = process.env.DSH_USER_NAME || "agentry";
const DEFAULT_WORKSPACE_NAME = process.env.DSH_WORKSPACE_NAME || "agentry-default";
const DEFAULT_WORKSPACE_PATH =
  process.env.DSH_WORKSPACE_PATH || "/tmp/home/.dsh/agentry-workspaces/default";

// v0.15.4 — explicit model defaults. The gateway has a persistent
// session per workspace; the first submit pins the model. Never rely
// on the gateway default (it's currently atria/space-bunny-alpha:free
// and returns empty).
const DEFAULT_PROVIDER = process.env.DSH_DEFAULT_PROVIDER || "unorouter";
const DEFAULT_MODEL = process.env.DSH_DEFAULT_MODEL || "gpt-oss-20b:free";

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
const _workspaceIdByName = new Map();   // name → id

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
// Cached by name so repeated lookups are cheap.
async function ensureWorkspace(name = DEFAULT_WORKSPACE_NAME, path = DEFAULT_WORKSPACE_PATH) {
  if (_workspaceIdByName.has(name)) return _workspaceIdByName.get(name);

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
        if (existing?.id) {
          _workspaceIdByName.set(name, existing.id);
          return existing.id;
        }
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
  _workspaceIdByName.set(name, data.id);
  return data.id;
}

export default async function agentDsh(input, ctx) {
  const { prompt, workspaceId, workspace, provider, model, max_tokens, timeout_ms = 30000 } = input || {};
  if (!prompt || typeof prompt !== "string") {
    throw new Error("agent.dsh requires prompt (string)");
  }

  const { apiKey } = await ensureUser();

  // Resolve the target workspace: explicit id wins, then name, then default.
  let wsId = workspaceId;
  if (!wsId && workspace && typeof workspace === "string") {
    const wsPath = `/tmp/home/.dsh/agentry-workspaces/${workspace}`;
    wsId = await ensureWorkspace(workspace, wsPath);
  }
  if (!wsId) {
    wsId = await ensureWorkspace();
  }

  // v0.15.4 — always pass an explicit model + provider.
  // The gateway pins the model on the first submit to a workspace and
  // 409s on mismatch. Not passing a model means the gateway chooses its
  // own default (currently atria/space-bunny-alpha:free, which returns
  // empty output). Explicit is correct.
  const body = {
    workspaceId: wsId,
    prompt,
    provider: provider || DEFAULT_PROVIDER,
    model: model || DEFAULT_MODEL,
  };
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
      model_used: data.model || { provider: body.provider, model: body.model },
    },
    cost: { time_ms: Date.now() - started, http_calls: 1 },
  };
}
