// agentry/src/handlers/agentry.os.mjs
const DEFAULT_KERNEL_URL = "http://127.0.0.1:7864";
const DEFAULT_TIMEOUT_MS = 60000;

function kernelUrl(ctx) {
  return (ctx?.config?.kernel?.url || process.env.AGENTRY_KERNEL_URL || DEFAULT_KERNEL_URL).replace(/\/+$/, "");
}

const ROUTES = {
  "session.create": "POST /session/create",
  "session.get":    "POST /session/get",
  "session.list":   "POST /session/list",
  "session.cwd":    "POST /session/cwd",
  "session.env":    "POST /session/env",

  "fs.read":        "POST /fs/read",
  "fs.write":       "POST /fs/write",
  "fs.list":        "POST /fs/list",

  "shell.spawn":    "POST /shell/spawn",
  "shell.write":    "POST /shell/write",
  "shell.read":     "POST /shell/read",
  "shell.kill":     "POST /shell/kill",
  "shell.list":     "POST /shell/list",

  "python.run":     "POST /python/run",
  "python.install": "POST /python/install",
  "python.version": "POST /python/version",

  "node.run":       "POST /node/run",
  "node.install":   "POST /node/install",
  "rust.run":       "POST /rust/run",
  "rust.version":   "POST /rust/version",
  "go.run":         "POST /go/run",
  "go.version":     "POST /go/version",
  "java.run":       "POST /java/run",
  "java.version":   "POST /java/version",
  "dotnet.run":     "POST /dotnet/run",
  "dotnet.version": "POST /dotnet/version",
  "node.npx":       "POST /node/npx",
  "node.version":   "POST /node/version",

  "git.clone":      "POST /git/clone",
  "git.status":     "POST /git/status",
  "git.commit":     "POST /git/commit",
  "git.log":        "POST /git/log",
  "git.version":    "POST /git/version",

  "proc.start":     "POST /proc/start",
  "proc.status":    "POST /proc/status",
  "proc.stop":      "POST /proc/stop",
  "proc.logs":      "POST /proc/logs",
  "proc.list":      "POST /proc/list",

  "health":         "GET  /health",
};

export default async function agentryOs(input, ctx) {
  const { action, ...args } = input || {};
  if (!action || typeof action !== "string") throw new Error("agentry.os requires 'action'");

  const route = ROUTES[action];
  if (!route) throw new Error(`agentry.os: unknown action '${action}'. Known: ${Object.keys(ROUTES).join(", ")}`);

  const [method, path] = route.split(/\s+/);
  const base = kernelUrl(ctx);
  const url = `${base}${path}`;
  const timeoutMs = Number(args.timeout_ms) || DEFAULT_TIMEOUT_MS;
  // v0.52.20 — DO NOT delete args.timeout_ms. Kernel handlers (shell.spawn,
  // node.run, python.run, rust.run, go.run, java.run, dotnet.run, shell.kill,
  // proc.start) ALL use timeout_ms as their process timeout. Prior version
  // deleted it here, so kernel always used its own defaults (30s for
  // shell.spawn). Callers thought they were setting 180s+ but were getting
  // 30s kills. Symptom: exit_code:null, done:true, duration exactly 30s,
  // tool_calls truncated mid-execution. Fix: pass it through to kernel.
  // The fetch abort below is a separate concern (see next patch).

  const fetchOpts = {
    method,
    headers: { "content-type": "application/json" },
    // v0.52.20 — fetch abort must be LONGER than kernel process timeout,
    // so the process timeout fires first, kernel returns { killed: true },
    // and fetch resolves with the result instead of aborting. Prior code
    // used timeoutMs which raced with kernel timeout at the same instant.
    signal: AbortSignal.timeout(timeoutMs + 30000),
  };
  if (method === "POST") fetchOpts.body = JSON.stringify(args);

  let res;
  try {
    res = await fetch(url, fetchOpts);
  } catch (e) {
    throw new Error(`agentry.os: kernel fetch failed (${base}${path}): ${e.message}. Is the kernel running?`);
  }

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const errCode = data?.error?.code || "INTERNAL";
    const errMsg = data?.error?.message || `HTTP ${res.status}`;
    throw new Error(`agentry.os ${action}: ${errCode}: ${errMsg}`);
  }

  // v0.22.1 — some kernel routes return HTTP 200 with { error } in the body.
  // Treat those as failures. Silent HTTP-200-with-error is exactly how
  // python.install false-succeeded before this fix.
  if (data && data.error && (data.error.code || data.error.message)) {
    const errCode = data.error.code || "INTERNAL";
    const errMsg = data.error.message || "kernel reported error";
    throw new Error(`agentry.os ${action}: ${errCode}: ${errMsg}`);
  }

  return { output: { action, result: data }, cost: { time_ms: 0, http_calls: 1, money_usd: 0 } };
}
