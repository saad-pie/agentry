// agentry/src/kernel/languages/rust.mjs
// Rust runtime — writes .rs file, runs `rust-script` which handles
// inline cargo blocks (//! ```cargo ... ```) for crate deps.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 180000;
const MAX_OUTPUT_BYTES = 1 * 1024 * 1024;

function runSync(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    timeout: opts.timeout || DEFAULT_TIMEOUT_MS,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES * 4,
    ...opts,
  });
  return {
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    exit_code: typeof r.status === "number" ? r.status : -1,
    signal: r.signal,
    error: r.error ? r.error.message : null,
  };
}

export function rustRun(sessions, { session, code, file, args = [], cwd, env = {}, timeout_ms = DEFAULT_TIMEOUT_MS } = {}) {
  const s = sessions.get(session);
  if (!s) { const e = new Error(`unknown session: ${session}`); e.code = "NOT_FOUND"; throw e; }
  if (!code && !file) { const e = new Error("rust.run requires 'code' or 'file'"); e.code = "INVALID_REQUEST"; throw e; }

  let scriptPath;
  if (code) {
    const dir = sessions.resolvePath(session, ".agentry_scripts");
    mkdirSync(dir, { recursive: true });
    const fname = `script_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}.rs`;
    scriptPath = join(dir, fname);
    writeFileSync(scriptPath, code);
  } else {
    scriptPath = sessions.resolvePath(session, file);
    if (!existsSync(scriptPath)) { const e = new Error(`script not found: ${file}`); e.code = "NOT_FOUND"; throw e; }
  }

  const absCwd = cwd ? sessions.resolvePath(session, cwd) : sessions.resolvePath(session, ".");
  const mergedEnv = { ...process.env, ...s.env, ...env };
  mergedEnv.PATH = "/root/.cargo/bin:" + (mergedEnv.PATH || "");

  // Prefer rust-script (handles inline cargo deps). Fallback to plain rustc.
  const rs = runSync("rust-script", [scriptPath, ...args], { cwd: absCwd, env: mergedEnv, timeout: timeout_ms });
  if (rs.exit_code === 0 || !/not found/i.test(rs.stderr || "") && !/ENOENT/.test(rs.error || "")) {
    return { stdout: rs.stdout, stderr: rs.stderr, exit_code: rs.exit_code, signal: rs.signal, script_path: code ? scriptPath.replace(s.root + "/", "") : file, lang: "rust", runner: "rust-script", error: rs.error };
  }

  // Fallback: plain rustc compile then run
  const binPath = scriptPath.replace(/\.rs$/, "");
  const cmp = runSync("rustc", [scriptPath, "-o", binPath], { cwd: absCwd, env: mergedEnv, timeout: timeout_ms });
  if (cmp.exit_code !== 0) return { stdout: cmp.stdout, stderr: cmp.stderr, exit_code: cmp.exit_code, script_path: code ? scriptPath.replace(s.root + "/", "") : file, lang: "rust", runner: "rustc", error: cmp.error };
  const ex = runSync(binPath, args, { cwd: absCwd, env: mergedEnv, timeout: timeout_ms });
  return { stdout: ex.stdout, stderr: ex.stderr, exit_code: ex.exit_code, signal: ex.signal, script_path: code ? scriptPath.replace(s.root + "/", "") : file, lang: "rust", runner: "rustc", error: ex.error };
}

export function rustVersion() {
  const r = runSync("rustc", ["--version"], { timeout: 10000 });
  const rr = runSync("rust-script", ["--version"], { timeout: 10000 });
  return { version: (r.stdout || r.stderr || "").trim(), rust_script: (rr.stdout || rr.stderr || "").trim(), exit_code: r.exit_code };
}
