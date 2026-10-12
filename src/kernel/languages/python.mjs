// agentry/src/kernel/languages/python.mjs
//
// Python runtime primitives. Runs code or files with the session's
// Python interpreter, installs packages with pip.
//
// Uses the system python3 + pip. No special config; if the container
// has python3, this works.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 60000;
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
    exit_code: r.status,
    signal: r.signal,
    error: r.error ? r.error.message : null,
  };
}

/**
 * Run a Python snippet or file. If `code` is provided, we write it to
 * a temp file in the session and run that — deterministic, avoids
 * `-c` escaping issues, and the file is inspectable afterwards.
 */
export function pythonRun(sessions, shell, { session, code, file, args = [], cwd, env = {}, timeout_ms = DEFAULT_TIMEOUT_MS } = {}) {
  const s = sessions.get(session);
  if (!s) { const e = new Error(`unknown session: ${session}`); e.code = "NOT_FOUND"; throw e; }

  if (!code && !file) {
    const e = new Error("python.run requires either 'code' or 'file'");
    e.code = "INVALID_REQUEST";
    throw e;
  }

  let scriptPath;
  if (code) {
    const dir = sessions.resolvePath(session, ".agentry_scripts");
    mkdirSync(dir, { recursive: true });
    const fname = `script_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}.py`;
    scriptPath = join(dir, fname);
    writeFileSync(scriptPath, code);
  } else {
    scriptPath = sessions.resolvePath(session, file);
    if (!existsSync(scriptPath)) {
      const e = new Error(`script not found: ${file}`);
      e.code = "NOT_FOUND";
      throw e;
    }
  }

  const absCwd = cwd ? sessions.resolvePath(session, cwd) : sessions.resolvePath(session, ".");
  const mergedEnv = { ...process.env, ...s.env, ...env };

  const r = spawnSync("python3", [scriptPath, ...args], {
    cwd: absCwd,
    env: mergedEnv,
    timeout: timeout_ms,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES * 4,
  });

  return {
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    exit_code: r.status,
    signal: r.signal,
    script_path: code ? scriptPath.replace(s.root + "/", "") : file,
    error: r.error ? r.error.message : null,
  };
}

/**
 * pip install into the session's environment. Uses `--user` so it
 * doesn't touch the system packages, and so the session is isolated.
 */
export function pythonInstall(sessions, { session, packages = [], upgrade = false, timeout_ms = 120000 } = {}) {
  const s = sessions.get(session);
  if (!s) { const e = new Error(`unknown session: ${session}`); e.code = "NOT_FOUND"; throw e; }
  if (!Array.isArray(packages) || packages.length === 0) {
    const e = new Error("python.install requires non-empty 'packages' array");
    e.code = "INVALID_REQUEST";
    throw e;
  }
  for (const p of packages) {
    if (typeof p !== "string" || !/^[a-zA-Z0-9_.\-\[\]=<>!~]+$/.test(p)) {
      const e = new Error(`invalid package name: ${p}`);
      e.code = "INVALID_REQUEST";
      throw e;
    }
  }

  const args = ["install", "--user", "--disable-pip-version-check", "--no-input", "--quiet"];
  if (upgrade) args.push("--upgrade");
  args.push(...packages);

  const r = spawnSync("python3", ["-m", "pip", ...args], {
    cwd: sessions.resolvePath(session, "."),
    env: { ...process.env, ...s.env },
    timeout: timeout_ms,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES * 4,
  });

  return {
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    exit_code: r.status,
    installed: packages,
    error: r.error ? r.error.message : null,
  };
}

export function pythonVersion(sessions, { session }) {
  const s = sessions.get(session);
  if (!s) { const e = new Error(`unknown session: ${session}`); e.code = "NOT_FOUND"; throw e; }
  const r = runSync("python3", ["--version"]);
  return { version: (r.stdout || r.stderr || "").trim(), exit_code: r.exit_code };
}
