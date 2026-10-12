// agentry/src/kernel/server.mjs
//
// agentry-kernel — the OS for agents.
//
// An HTTP server on 127.0.0.1:7864 that exposes filesystem, shell,
// and session primitives. Agentry talks to it via the agentry.os
// handler. Sessions are isolated; filesystem is shared under /work.

import { createServer } from "node:http";
import { join } from "node:path";
import { SessionStore } from "./sessions.mjs";
import { fsRead, fsWrite, fsList } from "./fs.mjs";
import { ShellStore } from "./shell.mjs";

const PORT = Number(process.env.AGENTRY_KERNEL_PORT || 7864);
const HOST = process.env.AGENTRY_KERNEL_HOST || "127.0.0.1";
const ROOT = process.env.AGENTRY_KERNEL_ROOT
  || "/tmp/home/.dsh/agentry-kernel";

const sessions = new SessionStore({ root: ROOT });
const shell = new ShellStore();

// Auto-create a default session on boot, so an agent can start
// working without an explicit create.
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
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(s),
  });
  res.end(s);
}

function sendError(res, err) {
  const code = err.code || "INTERNAL";
  const status = {
    NOT_FOUND: 404,
    IS_DIRECTORY: 400,
    NOT_DIRECTORY: 400,
    TOO_LARGE: 413,
    TOO_MANY_PROCS: 429,
    ALREADY_DONE: 409,
    WRITE_FAILED: 500,
    KILL_FAILED: 500,
    INVALID_REQUEST: 400,
  }[code] || 500;
  send(res, status, { error: { code, message: err.message } });
}

const ROUTES = {
  "GET  /health": async () => ({
    ok: true,
    kernel: "agentry-kernel",
    version: "0.13.0",
    root: ROOT,
    uptime_s: Math.round(process.uptime()),
    sessions: sessions.list().length,
  }),

  // Sessions
  "POST /session/create": async (body) => sessions.create(body),
  "POST /session/get":    async (body) => {
    const s = sessions.get(body.session);
    if (!s) {
      const e = new Error(`unknown session: ${body.session}`);
      e.code = "NOT_FOUND";
      throw e;
    }
    return { session: s };
  },
  "POST /session/list":   async () => ({ sessions: sessions.list() }),
  "POST /session/cwd":    async (body) => {
    const s = sessions.setCwd(body.session, body.cwd);
    if (!s) {
      const e = new Error(`unknown session: ${body.session}`);
      e.code = "NOT_FOUND";
      throw e;
    }
    return { cwd: s.cwd };
  },
  "POST /session/env":    async (body) => {
    const s = sessions.setEnv(body.session, body.key, body.value);
    if (!s) {
      const e = new Error(`unknown session: ${body.session}`);
      e.code = "NOT_FOUND";
      throw e;
    }
    return { env: s.env };
  },

  // Filesystem
  "POST /fs/read":  async (body) => fsRead(sessions, body),
  "POST /fs/write": async (body) => fsWrite(sessions, body),
  "POST /fs/list":  async (body) => fsList(sessions, body),

  // Shell
  "POST /shell/spawn": async (body) => shell.spawn(sessions, body),
  "POST /shell/write": async (body) => shell.write(sessions, body),
  "POST /shell/read":  async (body) => shell.read(sessions, body),
  "POST /shell/kill":  async (body) => shell.kill(sessions, body),
  "POST /shell/list":  async (body) => shell.list(sessions, body),
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const key = `${req.method} ${url.pathname}`;
  const handler = ROUTES[key];

  res.setHeader("x-agentry-kernel", "0.13.0");

  if (!handler) {
    return send(res, 404, { error: { code: "NOT_FOUND", message: `no route: ${key}` } });
  }

  try {
    let body = {};
    if (req.method === "POST") {
      try { body = await readBody(req); }
      catch (e) {
        return send(res, 400, { error: { code: "INVALID_REQUEST", message: e.message } });
      }
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

// Periodic process reaper.
setInterval(() => shell.reap(), 60_000).unref();

process.on("SIGTERM", () => { server.close(() => process.exit(0)); });
process.on("SIGINT",  () => { server.close(() => process.exit(0)); });
