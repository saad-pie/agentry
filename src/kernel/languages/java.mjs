// agentry/src/kernel/languages/java.mjs
// Java 17+ — expects a single .java file with `public class <Main>`.
// Compiles with javac then runs with java. Works with maven deps? No —
// for external jars use requires.jar and put them on the classpath.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 180000;
const MAX_OUTPUT_BYTES = 1 * 1024 * 1024;

function runSync(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { timeout: opts.timeout || DEFAULT_TIMEOUT_MS, encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES * 4, ...opts });
  return { stdout: r.stdout || "", stderr: r.stderr || "", exit_code: typeof r.status === "number" ? r.status : -1, signal: r.signal, error: r.error ? r.error.message : null };
}

export function javaRun(sessions, { session, code, file, args = [], cwd, env = {}, timeout_ms = DEFAULT_TIMEOUT_MS, class_name } = {}) {
  const s = sessions.get(session);
  if (!s) { const e = new Error(`unknown session: ${session}`); e.code = "NOT_FOUND"; throw e; }
  if (!code && !file) { const e = new Error("java.run requires 'code' or 'file'"); e.code = "INVALID_REQUEST"; throw e; }

  let scriptPath;
  let mainClass = class_name || "Main";
  if (code) {
    const dir = sessions.resolvePath(session, ".agentry_scripts");
    mkdirSync(dir, { recursive: true });
    const m = code.match(/public\s+class\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (m) mainClass = m[1];
    const fname = mainClass + ".java";
    scriptPath = join(dir, fname);
    writeFileSync(scriptPath, code);
  } else {
    scriptPath = sessions.resolvePath(session, file);
    if (!existsSync(scriptPath)) { const e = new Error(`script not found: ${file}`); e.code = "NOT_FOUND"; throw e; }
    const m = String(file).match(/([A-Za-z_][A-Za-z0-9_]*)\.java$/);
    if (m) mainClass = m[1];
  }

  const absCwd = cwd ? sessions.resolvePath(session, cwd) : sessions.resolvePath(session, ".");
  const mergedEnv = { ...process.env, ...s.env, ...env };

  const cmp = runSync("javac", [scriptPath], { cwd: absCwd, env: mergedEnv, timeout: timeout_ms });
  if (cmp.exit_code !== 0) {
    return { stdout: cmp.stdout, stderr: cmp.stderr, exit_code: cmp.exit_code, script_path: code ? scriptPath.replace(s.root + "/", "") : file, lang: "java", runner: "javac", error: cmp.error };
  }
  const ex = runSync("java", ["-cp", absCwd, mainClass, ...args], { cwd: absCwd, env: mergedEnv, timeout: timeout_ms });
  return { stdout: ex.stdout, stderr: ex.stderr, exit_code: ex.exit_code, signal: ex.signal, script_path: code ? scriptPath.replace(s.root + "/", "") : file, lang: "java", runner: "java", main_class: mainClass, error: ex.error };
}

export function javaVersion() {
  const r = runSync("java", ["-version"], { timeout: 10000 });
  return { version: (r.stderr || r.stdout || "").trim(), exit_code: r.exit_code };
}
