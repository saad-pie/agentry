// agentry/src/handlers/agent.dsh.mjs
// Talks to the DeepSeek Harness business API (dsh-api-gateway plugin).
//
// Submits a task to the harness and returns the task id. The task runs
// asynchronously on the harness; use agent.dsh_poll to wait for the result.
//
// Config:
//   DSH_BASE_URL        — default http://127.0.0.1:7861
//   DSH_ADMIN_TOKEN     — default dsh-admin-2024
//   DSH_WORKSPACE_PATH  — filesystem path used for the default workspace
//                         (default: /tmp/home/.dsh/agentry-workspaces/agentry-default)
//   DSH_WORKSPACE       — workspace id to submit into (created on first use)

import { mkdirSync } from "node:fs";

const BASE_URL = process.env.DSH_BASE_URL || "http://127.0.0.1:7861";
const ADMIN_TOKEN = process.env.DSH_ADMIN_TOKEN || "dsh-admin-2024";

function authHeaders() {
  return {
    "authorization": `Bearer ${ADMIN_TOKEN}`,
    "x-api-key": ADMIN_TOKEN,
    "content-type": "application/json",
  };
}

// Ensure a workspace exists. Idempotent: creates on first call, reuses after.
//
// The gateway calls realpath() on the given path, which fails if the
// directory doesn't exist. So we mkdir -p it first, then ask the gateway to
// claim it.
let _workspaceId = null;
async function ensureWorkspace(name = "agentry-default") {
  if (_workspaceId) return _workspaceId;

  const workspacePath = process.env.DSH_WORKSPACE_PATH
    || `/tmp/home/.dsh/agentry-workspaces/${name}`;

  // The gateway does realpath() on the path, which fails if it doesn't
  // exist. Create the directory before we ask the gateway to claim it.
  try {
    mkdirSync(workspacePath, { recursive: true });
  } catch (e) {
    throw new Error(`agent.dsh: cannot create workspace dir ${workspacePath} — ${e.message}`);
  }

  // Try to list workspaces first (some gateway versions expose GET)
  try {
    const res = await fetch(`${BASE_URL}/api/dsh/workspaces`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json();
      const list = Array.isArray(data) ? data
        : (data.workspaces || data.items || []);
      const existing = list.find(w =>
        w.name === name || w.slug === name || w.path === workspacePath
      );
      if (existing) {
        _workspaceId = existing.id || existing.slug || existing.name;
        return _workspaceId;
      }
    }
  } catch (e) {
    // List failed, fall through to create
  }

  // Create. The gateway requires `path` and expects `name` for identification.
  const res = await fetch(`${BASE_URL}/api/dsh/workspaces`, {
    method: "POST",
    headers: authHeaders(),
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

  const ws = workspace || await ensureWorkspace();

  const body = {
    prompt,
    workspace: ws,
  };

  const started = Date.now();
  const res = await fetch(`${BASE_URL}/api/dsh/task`, {
    method: "POST",
    headers: authHeaders(),
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
