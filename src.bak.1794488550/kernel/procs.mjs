// agentry/src/kernel/procs.mjs
//
// Long-running process supervisor. Unlike shell.spawn (which is
// fire-and-forget with a timeout), procs.start launches a persistent
// process that lives until explicitly stopped. Logs are retained and
// streamed on demand. Restart policies supported.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const MAX_LOG_LINES = 5000;
const MAX_PROCS_PER_SESSION = 4;

export class ProcStore {
  constructor() {
    this.procs = new Map();   // proc_id → record
  }

  _sessionProcs(session) {
    return Array.from(this.procs.values()).filter(p => p.session === session);
  }

  start(sessions, { session, name, cmd, args = [], cwd, env = {}, restart = "no" } = {}) {
    const s = sessions.get(session);
    if (!s) { const e = new Error(`unknown session: ${session}`); e.code = "NOT_FOUND"; throw e; }
    if (!cmd) { const e = new Error("proc.start requires 'cmd'"); e.code = "INVALID_REQUEST"; throw e; }
    const live = this._sessionProcs(session).filter(p => p.state === "running");
    if (live.length >= MAX_PROCS_PER_SESSION) {
      const e = new Error(`too many live processes in session: ${live.length} (max ${MAX_PROCS_PER_SESSION})`);
      e.code = "TOO_MANY_PROCS";
      throw e;
    }

    const id = `proc_${randomBytes(6).toString("hex")}`;
    const absCwd = cwd ? sessions.resolvePath(session, cwd) : sessions.resolvePath(session, ".");
    const mergedEnv = { ...process.env, ...s.env, ...env };

    const rec = {
      id, session, name: name || cmd,
      cmd, args, cwd: absCwd, env: mergedEnv,
      restart,
      logs: [],
      state: "starting",
      started_at: Date.now(),
      restarts: 0,
      child: null,
      exit_code: null,
      signal: null,
    };

    const launch = () => {
      const child = spawn(rec.cmd, rec.args, {
        cwd: rec.cwd, env: rec.env, stdio: ["pipe", "pipe", "pipe"],
      });
      rec.child = child;
      rec.state = "running";

      const push = (stream, chunk) => {
        const text = chunk.toString("utf8");
        for (const line of text.split("\n")) {
          if (line === "" && !text.endsWith("\n")) continue;
          rec.logs.push({ at: Date.now(), stream, line });
        }
        if (rec.logs.length > MAX_LOG_LINES) {
          rec.logs = rec.logs.slice(-MAX_LOG_LINES);
        }
      };
      child.stdout.on("data", c => push("stdout", c));
      child.stderr.on("data", c => push("stderr", c));

      child.on("exit", (code, signal) => {
        rec.exit_code = code;
        rec.signal = signal;
        rec.state = "exited";
        rec.stopped_at = Date.now();
        if (rec.restart === "always" && rec.state === "exited") {
          rec.restarts++;
          rec.state = "restarting";
          setTimeout(() => { if (rec.state === "restarting") launch(); }, 1000);
        }
      });
      child.on("error", (e) => {
        rec.logs.push({ at: Date.now(), stream: "stderr", line: `[spawn error] ${e.message}` });
        rec.state = "errored";
      });
    };

    launch();
    this.procs.set(id, rec);
    return {
      proc_id: id,
      name: rec.name,
      cmd: rec.cmd,
      state: rec.state,
      started_at: rec.started_at,
    };
  }

  status(sessions, { session, proc_id }) {
    const rec = this.procs.get(proc_id);
    if (!rec || rec.session !== session) {
      const e = new Error(`unknown process: ${proc_id}`);
      e.code = "NOT_FOUND";
      throw e;
    }
    return {
      proc_id: rec.id,
      name: rec.name,
      state: rec.state,
      cmd: rec.cmd,
      args: rec.args,
      restarts: rec.restarts,
      pid: rec.child?.pid || null,
      started_at: rec.started_at,
      stopped_at: rec.stopped_at || null,
      exit_code: rec.exit_code,
      signal: rec.signal,
      log_lines: rec.logs.length,
    };
  }

  stop(sessions, { session, proc_id, signal = "SIGTERM", timeout_ms = 5000 }) {
    const rec = this.procs.get(proc_id);
    if (!rec || rec.session !== session) {
      const e = new Error(`unknown process: ${proc_id}`);
      e.code = "NOT_FOUND";
      throw e;
    }
    if (rec.state === "exited") return { ok: true, already_exited: true };
    rec.restart = "no";   // prevent auto-restart from resurrecting it
    try { rec.child.kill(signal); } catch {}
    setTimeout(() => { try { rec.child.kill("SIGKILL"); } catch {} }, timeout_ms);
    return { ok: true };
  }

  logs(sessions, { session, proc_id, tail = 100 } = {}) {
    const rec = this.procs.get(proc_id);
    if (!rec || rec.session !== session) {
      const e = new Error(`unknown process: ${proc_id}`);
      e.code = "NOT_FOUND";
      throw e;
    }
    const n = Math.min(Number(tail) || 100, MAX_LOG_LINES);
    const slice = rec.logs.slice(-n);
    return {
      proc_id: rec.id,
      state: rec.state,
      lines: slice.map(l => `[${l.stream}] ${l.line}`),
      total_lines: rec.logs.length,
    };
  }

  list(sessions, { session }) {
    return {
      processes: this._sessionProcs(session).map(rec => ({
        proc_id: rec.id,
        name: rec.name,
        state: rec.state,
        cmd: rec.cmd,
        started_at: rec.started_at,
        restarts: rec.restarts,
      })),
    };
  }
}
