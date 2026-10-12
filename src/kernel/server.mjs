// agentry/src/kernel/server.mjs
import { createServer } from "node:http";
import { SessionStore } from "./sessions.mjs";
import { fsRead, fsWrite, fsList } from "./fs.mjs";
import { ShellStore } from "./shell.mjs";
import { pythonRun, pythonInstall, pythonVersion } from "./languages/python.mjs";
import { nodeRun, nodeInstall, nodeNpx, nodeVersion } from "./languages/node.mjs";
import { gitClone, gitStatus, gitCommit, gitLog, gitVersion } from "./git.mjs";
import { ProcStore } from "./procs.mjs";

const PORT = Number(process.env.AGENTRY_KERNEL_PORT || 7864);
const HOST = process.env.AGENTRY_KERNEL_HOST || "127.0.0.1";
const ROOT = process.env.AGENTRY_KERNEL_ROOT || "/tmp/home/.dsh/agentry-kernel";

const sessions = new SessionStore({ root: ROOT });
const shell = new ShellStore();
const procs = new ProcStore();

sessions.create({ id: "default" });

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(new Error(`invalid JSON body: ${e.message}`)); }
    });
  });
}
function send(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}
function sendError(res, err) {
  const code = err.code || "INTERNAL";
  const status = {
    NOT_FOUND: 404, IS_DIRECTORY: 400, NOT_DIRECTORY: 400,
    TOO_LARGE: 413, TOO_MANY_PROCS: 429, ALREADY_DONE: 409,
    WRITE_FAILED: 500, KILL_FAILED: 500, INVALID_REQUEST: 400,
  }[code] || 500;
  send(res, status, { error: { code, message: err.message } });
}

const ROUTES = {
  "GET /health": async () => ({
    ok: true, kernel: "agentry-kernel", version: "0.13.2",
    root: ROOT, uptime_s: Math.round(process.uptime()),
    sessions: sessions.list().length,
    shell_processes: shell.processes.size,
    long_running_procs: procs.procs.size,
  }),

  "POST /session/create": async (b) => sessions.create(b),
  "POST /session/get":    async (b) => { const s = sessions.get(b.session); if (!s) { const e = new Error(`unknown session: ${b.session}`); e.code = "NOT_FOUND"; throw e; } return { session: s }; },
  "POST /session/list":   async () => ({ sessions: sessions.list() }),
  "POST /session/cwd":    async (b) => { const s = sessions.setCwd(b.session, b.cwd); if (!s) { const e = new Error(`unknown session: ${b.session}`); e.code = "NOT_FOUND"; throw e; } return { cwd: s.cwd }; },
  "POST /session/env":    async (b) => { const s = sessions.setEnv(b.session, b.key, b.value); if (!s) { const e = new Error(`unknown session: ${b.session}`); e.code = "NOT_FOUND"; throw e; } return { env: s.env }; },

  "POST /fs/read":  async (b) => fsRead(sessions, b),
  "POST /fs/write": async (b) => fsWrite(sessions, b),
  "POST /fs/list":  async (b) => fsList(sessions, b),

  "POST /shell/spawn": async (b) => shell.spawn(sessions, b),
  "POST /shell/write": async (b) => shell.write(sessions, b),
  "POST /shell/read":  async (b) => shell.read(sessions, b),
  "POST /shell/kill":  async (b) => shell.kill(sessions, b),
  "POST /shell/list":  async (b) => shell.list(sessions, b),

  "POST /python/run":     async (b) => pythonRun(sessions, shell, b),
  "POST /python/install": async (b) => pythonInstall(sessions, b),
  "POST /python/version": async (b) => pythonVersion(sessions, b),

  "POST /node/run":     async (b) => nodeRun(sessions, b),
  "POST /node/install": async (b) => nodeInstall(sessions, b),
  "POST /node/npx":     async (b) => nodeNpx(sessions, b),
  "POST /node/version": async (b) => nodeVersion(sessions, b),

  "POST /git/clone":   async (b) => gitClone(sessions, b),
  "POST /git/status":  async (b) => gitStatus(sessions, b),
  "POST /git/commit":  async (b) => gitCommit(sessions, b),
  "POST /git/log":     async (b) => gitLog(sessions, b),
  "POST /git/version": async (b) => gitVersion(sessions, b),

  "POST /proc/start":  async (b) => procs.start(sessions, b),
  "POST /proc/status": async (b) => procs.status(sessions, b),
  "POST /proc/stop":   async (b) => procs.stop(sessions, b),
  "POST /proc/logs":   async (b) => procs.logs(sessions, b),
  "POST /proc/list":   async (b) => procs.list(sessions, b),
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const key = `${req.method} ${url.pathname}`;
  const handler = ROUTES[key];
  res.setHeader("x-agentry-kernel", "0.13.2");

  if (!handler) return send(res, 404, { error: { code: "NOT_FOUND", message: `no route: ${key}` } });

  try {
    let body = {};
    if (req.method === "POST") {
      try { body = await readBody(req); }
      catch (e) { return send(res, 400, { error: { code: "INVALID_REQUEST", message: e.message } }); }
    }
    const result = await handler(body);
    return send(res, 200, result);
  } catch (err) {
    return sendError(res, err);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[agentry-kernel] listening on http://${HOST}:${PORT}`);
  console.log(`[agentry-kernel] root: ${ROOT}`);
  console.log(`[agentry-kernel] routes: ${Object.keys(ROUTES).length}`);
});

setInterval(() => shell.reap(), 60_000).unref();

process.on("SIGTERM", () => { server.close(() => process.exit(0)); });
process.on("SIGINT",  () => { server.close(() => process.exit(0)); });
