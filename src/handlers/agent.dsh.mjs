// agentry/src/handlers/agent.dsh.mjs
// Talks to the DeepSeek Harness business API (dsh-api-gateway plugin).
//
// Submits a task to the harness and returns the task id. The task runs
// asynchronously on the harness; use agent.dsh.poll to wait for the result.
//
// Config:
//   DSH_BASE_URL   — default http://127.0.0.1:7861
//   DSH_ADMIN_TOKEN — default dsh-admin-2024
//   DSH_WORKSPACE  — the workspace id to submit into (created on first use)

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
let _workspaceId = null;
async function ensureWorkspace(name = "agentry-default") {
  if (_workspaceId) return _workspaceId;

  // Try to list workspaces first
  try {
    const res = await fetch(`${BASE_URL}/api/dsh/workspaces`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json();
      const list = data.workspaces || data.items || [];
      const existing = list.find(w => w.name === name || w.slug === name);
      if (existing) {
        _workspaceId = existing.id || existing.slug;
        return _workspaceId;
      }
    }
  } catch (e) {
    // List failed, fall through to create
  }

  // Create
  const res = await fetch(`${BASE_URL}/api/dsh/workspaces`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ name, slug: name }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`agent.dsh: workspace creation failed HTTP ${res.status} — ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  _workspaceId = data.id || data.slug || data.workspace?.id;
  if (!_workspaceId) {
    throw new Error(`agent.dsh: workspace creation returned no id — ${JSON.stringify(data).slice(0, 200)}`);
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
    throw new Error(`agent.dsh: submit returned no task id — ${JSON.stringify(data).slice(0, 200)}`);
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
