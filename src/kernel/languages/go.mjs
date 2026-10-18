// agentry/src/kernel/languages/go.mjs
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 180000;
const MAX_OUTPUT_BYTES = 1 * 1024 * 1024;

function runSync(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { timeout: opts.timeout || DEFAULT_TIMEOUT_MS, encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES * 4, ...opts });
  return { stdout: r.stdout || "", stderr: r.stderr || "", exit_code: typeof r.status === "number" ? r.status : -1, signal: r.signal, error: r.error ? r.error.message : null };
}

export function goRun(sessions, { session, code, file, args = [], cwd, env = {}, timeout_ms = DEFAULT_TIMEOUT_MS } = {}) {
  const s = sessions.get(session);
  if (!s) { const e = new Error(`unknown session: ${session}`); e.code = "NOT_FOUND"; throw e; }
  if (!code && !file) { const e = new Error("go.run requires 'code' or 'file'"); e.code = "INVALID_REQUEST"; throw e; }

  let scriptPath;
  if (code) {
    const dir = sessions.resolvePath(session, ".agentry_scripts");
    mkdirSync(dir, { recursive: true });
    const fname = `script_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}.go`;
    scriptPath = join(dir, fname);
    writeFileSync(scriptPath, code);
  } else {
    scriptPath = sessions.resolvePath(session, file);
    if (!existsSync(scriptPath)) { const e = new Error(`script not found: ${file}`); e.code = "NOT_FOUND"; throw e; }
  }

  const absCwd = cwd ? sessions.resolvePath(session, cwd) : sessions.resolvePath(session, ".");
  const mergedEnv = { ...process.env, ...s.env, ...env };
  mergedEnv.PATH = "/usr/local/go/bin:" + (mergedEnv.PATH || "");
  mergedEnv.GO111MODULE = "on";
  if (!mergedEnv.GOCACHE) mergedEnv.GOCACHE = "/tmp/home/.cache/go-build";

  const initR = runSync("go", ["mod", "init", "agentry_synth_" + Date.now().toString(36)], { cwd: absCwd, env: mergedEnv, timeout: 30000 });
  const tidied = runSync("go", ["mod", "tidy"], { cwd: absCwd, env: mergedEnv, timeout: 90000 });
  if (tidied.exit_code !== 0) {
    return { stdout: tidied.stdout, stderr: tidied.stderr, exit_code: tidied.exit_code, script_path: code ? scriptPath.replace(s.root + "/", "") : file, lang: "go", runner: "go-mod-tidy", error: tidied.error, init_ok: initR.exit_code === 0 };
  }
  const r = runSync("go", ["run", scriptPath, ...args], { cwd: absCwd, env: mergedEnv, timeout: timeout_ms });
  return { stdout: r.stdout, stderr: r.stderr, exit_code: r.exit_code, signal: r.signal, script_path: code ? scriptPath.replace(s.root + "/", "") : file, lang: "go", runner: "go-run", error: r.error };
}

export function goVersion() {
  const r = runSync("go", ["version"], { timeout: 10000 });
  return { version: (r.stdout || r.stderr || "").trim(), exit_code: r.exit_code };
}
