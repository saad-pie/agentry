// agentry/src/kernel/shell.mjs
//
// Shell primitives. Spawns a subprocess, streams stdout/stderr into
// a bounded buffer, and exposes read/write/kill. Processes are
// tracked per-session so the session's shell history can be listed
// and (later) killed on session expiry.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const MAX_OUTPUT_BYTES = 1 * 1024 * 1024;  // 1 MB per stream per process
const MAX_CONCURRENT_PROCS = 8;

export class ShellStore {
  constructor() {
    this.processes = new Map();  // pid → { id, session, child, stdout, stderr, exit_code, done, started_at }
  }

  _sessionProcs(session) {
    return Array.from(this.processes.values()).filter(p => p.session === session);
  }

  spawn(sessions, { session, cmd, args = [], cwd, env = {}, timeout_ms = 30000 }) {
    const s = sessions.get(session);
    if (!s) throw new Error(`unknown session: ${session}`);
    const live = this._sessionProcs(session).filter(p => !p.done);
    if (live.length >= MAX_CONCURRENT_PROCS) {
      const e = new Error(`too many concurrent processes in session: ${live.length} (max ${MAX_CONCURRENT_PROCS})`);
      e.code = "TOO_MANY_PROCS";
      throw e;
    }

    const absCwd = cwd ? sessions.resolvePath(session, cwd) : sessions.resolvePath(session, ".");
    const mergedEnv = { ...process.env, ...s.env, ...env };

    const child = spawn(cmd, args, {
      cwd: absCwd,
      env: mergedEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const id = `proc_${randomBytes(6).toString("hex")}`;
    const rec = {
      id,
      session,
      cmd,
      args,
      cwd: absCwd,
      child,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exit_code: null,
      signal: null,
      done: false,
      started_at: Date.now(),
    };

    const append = (stream, chunk) => {
      const current = rec[stream];
      const next = Buffer.concat([current, chunk]);
      rec[stream] = next.length > MAX_OUTPUT_BYTES
        ? next.slice(next.length - MAX_OUTPUT_BYTES)
        : next;
    };

    child.stdout.on("data", c => append("stdout", c));
    child.stderr.on("data", c => append("stderr", c));
    child.on("exit", (code, signal) => {
      rec.exit_code = code;
      rec.signal = signal;
      rec.done = true;
      rec.finished_at = Date.now();
    });
    child.on("error", (e) => {
      append("stderr", Buffer.from(`\n[spawn error] ${e.message}\n`));
      rec.exit_code = -1;
      rec.done = true;
      rec.finished_at = Date.now();
    });

    if (timeout_ms > 0) {
      rec.timeout = setTimeout(() => {
        if (!rec.done) {
          try { rec.child.kill("SIGTERM"); } catch {}
          setTimeout(() => { try { rec.child.kill("SIGKILL"); } catch {} }, 2000);
        }
      }, timeout_ms);
    }

    this.processes.set(id, rec);
    return { pid: id, started_at: rec.started_at };
  }

  write(sessions, { session, pid, data }) {
    const rec = this.processes.get(pid);
    if (!rec || rec.session !== session) {
      const e = new Error(`unknown process: ${pid}`);
      e.code = "NOT_FOUND";
      throw e;
    }
    if (rec.done) {
      const e = new Error(`process already finished`);
      e.code = "ALREADY_DONE";
      throw e;
    }
    try {
      rec.child.stdin.write(String(data));
      return { ok: true, bytes_written: String(data).length };
    } catch (err) {
      const e = new Error(`write failed: ${err.message}`);
      e.code = "WRITE_FAILED";
      throw e;
    }
  }

  read(sessions, { session, pid, wait_ms = 0 }) {
    const rec = this.processes.get(pid);
    if (!rec || rec.session !== session) {
      const e = new Error(`unknown process: ${pid}`);
      e.code = "NOT_FOUND";
      throw e;
    }

    if (wait_ms > 0 && !rec.done) {
      const deadline = Date.now() + Math.min(wait_ms, 30000);
      return new Promise(resolve => {
        const check = () => {
          if (rec.done || Date.now() >= deadline) {
            resolve(this._snapshot(rec));
          } else {
            setTimeout(check, 50);
          }
        };
        check();
      });
    }

    return this._snapshot(rec);
  }

  _snapshot(rec) {
    // Consume the buffers on read so the caller gets new output only.
    const stdout = rec.stdout.toString("utf8");
    const stderr = rec.stderr.toString("utf8");
    rec.stdout = Buffer.alloc(0);
    rec.stderr = Buffer.alloc(0);
    return {
      stdout,
      stderr,
      exit_code: rec.exit_code,
      done: rec.done,
      started_at: rec.started_at,
      finished_at: rec.finished_at || null,
      ms: (rec.finished_at || Date.now()) - rec.started_at,
    };
  }

  kill(sessions, { session, pid, signal = "SIGTERM" }) {
    const rec = this.processes.get(pid);
    if (!rec || rec.session !== session) {
      const e = new Error(`unknown process: ${pid}`);
      e.code = "NOT_FOUND";
      throw e;
    }
    if (rec.done) return { ok: true, already_done: true };
    try {
      rec.child.kill(signal);
      return { ok: true };
    } catch (err) {
      const e = new Error(`kill failed: ${err.message}`);
      e.code = "KILL_FAILED";
      throw e;
    }
  }

  list(sessions, { session }) {
    return {
      processes: this._sessionProcs(session).map(p => ({
        pid: p.id,
        cmd: p.cmd,
        args: p.args,
        cwd: p.cwd,
        done: p.done,
        exit_code: p.exit_code,
        started_at: p.started_at,
        finished_at: p.finished_at || null,
      })),
    };
  }

  reap(now = Date.now()) {
    // Kill any process alive longer than 10 minutes. Called periodically
    // by the server to bound total resource use.
    const LIMIT_MS = 10 * 60 * 1000;
    for (const rec of this.processes.values()) {
      if (!rec.done && (now - rec.started_at) > LIMIT_MS) {
        try { rec.child.kill("SIGTERM"); } catch {}
      }
    }
  }
}
