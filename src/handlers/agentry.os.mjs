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
  delete args.timeout_ms;

  const fetchOpts = {
    method,
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
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
