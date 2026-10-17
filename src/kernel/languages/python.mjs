// agentry/src/kernel/languages/python.mjs
//
// Python runtime primitives. Runs code or files with the session's
// Python interpreter, installs packages with pip.
//
// Uses the system python3. Pip is bootstrapped on demand: ensurepip
// first, get-pip.py as last resort. Never silently succeeds — if a
// package cannot be installed, pythonInstall throws and the caller
// sees ok:false. Prior versions returned exit_code:1 with no error,
// which made installer report false successes.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_OUTPUT_BYTES = 1 * 1024 * 1024;
const PIP_BOOTSTRAP_TIMEOUT_MS = 180000;

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
    exit_code: typeof r.status === "number" ? r.status : -1,
    signal: r.signal,
    script_path: code ? scriptPath.replace(s.root + "/", "") : file,
    error: r.error ? r.error.message : null,
  };
}

function pipAvailable(sessions, session) {
  const r = runSync("python3", ["-m", "pip", "--version"], {
    cwd: sessions.resolvePath(session, "."),
    env: { ...process.env, ...sessions.get(session).env },
    timeout: 20000,
  });
  return r.exit_code === 0;
}

function bootstrapPip(sessions, session) {
  const s = sessions.get(session);
  const cwd = sessions.resolvePath(session, ".");
  const env = { ...process.env, ...s.env };

  // Try ensurepip first — ships with CPython, no network.
  const ep = runSync("python3", ["-m", "ensurepip", "--upgrade", "--default-pip"], {
    cwd, env, timeout: PIP_BOOTSTRAP_TIMEOUT_MS,
  });
  if (ep.exit_code === 0 && pipAvailable(sessions, session)) return;

  // Last resort: download get-pip.py.
  const gpPath = join(tmpdir(), `get-pip-${Date.now()}.py`);
  const dl = runSync("python3", ["-c", [
    "import urllib.request,sys",
    "url='https://bootstrap.pypa.io/get-pip.py'",
    "urllib.request.urlretrieve(url, sys.argv[1])",
  ].join(";"), gpPath], { cwd, env, timeout: PIP_BOOTSTRAP_TIMEOUT_MS });
  if (dl.exit_code !== 0) {
    const e = new Error("python3 pip unavailable and get-pip.py download failed: " + (dl.stderr || dl.error || "unknown").slice(0, 300));
    e.code = "PIP_BOOTSTRAP_FAILED";
    throw e;
  }

  const gp = runSync("python3", [gpPath, "--user", "--disable-pip-version-check", "--no-input", "--quiet"], {
    cwd, env, timeout: PIP_BOOTSTRAP_TIMEOUT_MS,
  });
  if (gp.exit_code !== 0 || !pipAvailable(sessions, session)) {
    const e = new Error("python3 pip bootstrap failed: " + (gp.stderr || gp.error || "ensurepip+get-pip both failed").slice(0, 300));
    e.code = "PIP_BOOTSTRAP_FAILED";
    throw e;
  }
}

function runPipInstall(sessions, session, packages, upgrade, timeout_ms) {
  const s = sessions.get(session);
  const cwd = sessions.resolvePath(session, ".");
  const env = { ...process.env, ...s.env };

  // Try normal --user install first. If PEP 668 blocks it, retry with
  // --break-system-packages. Both go through --user so the container
  // system packages are never touched.
  const baseArgs = ["install", "--user", "--disable-pip-version-check", "--no-input", "--quiet"];
  if (upgrade) baseArgs.push("--upgrade");
  const fullArgs = [...baseArgs, ...packages];

  let r = runSync("python3", ["-m", "pip", ...fullArgs], {
    cwd, env, timeout: timeout_ms,
  });

  const isPep668 = /externally-managed-environment|PEP 668/i.test((r.stderr || "") + (r.stdout || ""));
  if (r.exit_code !== 0 && isPep668) {
    r = runSync("python3", ["-m", "pip", ...baseArgs, "--break-system-packages", ...packages], {
      cwd, env, timeout: timeout_ms,
    });
  }

  if (r.exit_code !== 0) {
    const detail = (r.stderr || r.stdout || r.error || "").toString().slice(0, 500);
    const e = new Error(`pip install failed (exit ${r.exit_code}): ${detail}`);
    e.code = "PIP_INSTALL_FAILED";
    e.exit_code = r.exit_code;
    e.packages = packages;
    throw e;
  }

  return { stdout: r.stdout || "", stderr: r.stderr || "", exit_code: 0 };
}

/**
 * pip install into the session's environment. Uses `--user` so it
 * doesn't touch the system packages, and so the session is isolated.
 *
 * Throws on failure — this is critical. Prior versions returned
 * exit_code:1 with no throw, which made installer report ok:true on
 * a failed install. Silent success is worse than loud failure.
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

  if (!pipAvailable(sessions, session)) {
    bootstrapPip(sessions, session);
  }

  const r = runPipInstall(sessions, session, packages, upgrade, timeout_ms);

  return {
    stdout: r.stdout,
    stderr: r.stderr,
    exit_code: r.exit_code,
    installed: packages,
    error: null,
  };
}

export function pythonVersion(sessions, { session }) {
  const s = sessions.get(session);
  if (!s) { const e = new Error(`unknown session: ${session}`); e.code = "NOT_FOUND"; throw e; }
  const r = runSync("python3", ["--version"]);
  return { version: (r.stdout || r.stderr || "").trim(), exit_code: r.exit_code };
}
