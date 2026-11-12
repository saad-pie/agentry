// agentry/src/kernel/languages/python.mjs
//
// Python runtime primitives. Session-isolated via per-session venv.
//
// Every session gets its own .venv/ inside its work dir. Packages
// installed by one capability never leak into another. This is what
// the header of this file always claimed; v0.22.2 finally does it.
//
// Why venv and not --break-system-packages: PEP 668 marks system
// python as externally-managed. Bypassing it is a hack. venv is the
// sanctioned fix and gives real isolation as a bonus.
//
// pip lives inside the venv (ships with CPython's venv module). No
// ensurepip, no get-pip.py, no network at bootstrap time.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_OUTPUT_BYTES = 1 * 1024 * 1024;
const VENV_TIMEOUT_MS = 120000;

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

function sessionRoot(sessions, session) {
  return sessions.resolvePath(session, ".");
}

function venvPath(sessions, session) {
  return join(sessionRoot(sessions, session), ".venv");
}

function venvPython(sessions, session) {
  return join(venvPath(sessions, session), "bin", "python");
}

function venvPip(sessions, session) {
  return join(venvPath(sessions, session), "bin", "pip");
}

/**
 * Create the session's venv if missing. Returns the venv root.
 * Throws if python3 -m venv fails — loud, not silent.
 */
function ensureVenv(sessions, session) {
  const vp = venvPath(sessions, session);
  const py = venvPython(sessions, session);
  if (existsSync(py)) return vp;

  const s = sessions.get(session);
  const cwd = sessionRoot(sessions, session);
  const env = { ...process.env, ...s.env };

  mkdirSync(vp, { recursive: true });
  const r = runSync("python3", ["-m", "venv", vp], {
    cwd, env, timeout: VENV_TIMEOUT_MS,
  });
  if (r.exit_code !== 0) {
    const e = new Error("venv create failed: " + (r.stderr || r.error || "unknown").toString().slice(0, 400));
    e.code = "VENV_FAILED";
    throw e;
  }
  if (!existsSync(py)) {
    const e = new Error("venv created but bin/python missing at " + py);
    e.code = "VENV_FAILED";
    throw e;
  }
  return vp;
}

/**
 * Pick the interpreter for a session: venv python if it exists,
 * else system python3. Read-only — never creates a venv.
 */
function choosePython(sessions, session) {
  const py = venvPython(sessions, session);
  return existsSync(py) ? py : "python3";
}

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

  const absCwd = cwd ? sessions.resolvePath(session, cwd) : sessionRoot(sessions, session);
  const mergedEnv = { ...process.env, ...s.env, ...env };
  const python = choosePython(sessions, session);

  const r = spawnSync(python, [scriptPath, ...args], {
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
    python_used: python,
    error: r.error ? r.error.message : null,
  };
}

/**
 * Install packages into the session's venv. Creates the venv on first
 * use. Throws on any failure — callers see ok:false, not a silent pass.
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

  ensureVenv(sessions, session);

  const pip = venvPip(sessions, session);
  if (!existsSync(pip)) {
    const e = new Error("venv pip missing at " + pip);
    e.code = "VENV_FAILED";
    throw e;
  }

  const args = ["install", "--disable-pip-version-check", "--no-input", "--quiet"];
  if (upgrade) args.push("--upgrade");
  args.push(...packages);

  const cwd = sessionRoot(sessions, session);
  const env = { ...process.env, ...s.env };

  const r = runSync(pip, args, { cwd, env, timeout: timeout_ms });
  if (r.exit_code !== 0) {
    const detail = (r.stderr || r.stdout || r.error || "").toString().slice(0, 500);
    const e = new Error(`pip install failed (exit ${r.exit_code}): ${detail}`);
    e.code = "PIP_INSTALL_FAILED";
    e.exit_code = r.exit_code;
    e.packages = packages;
    throw e;
  }

  return {
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    exit_code: 0,
    installed: packages,
    venv: venvPath(sessions, session),
    error: null,
  };
}

export function pythonVersion(sessions, { session }) {
  const s = sessions.get(session);
  if (!s) { const e = new Error(`unknown session: ${session}`); e.code = "NOT_FOUND"; throw e; }
  const python = choosePython(sessions, session);
  const r = runSync(python, ["--version"]);
  return {
    version: (r.stdout || r.stderr || "").trim(),
    exit_code: r.exit_code,
    python_used: python,
  };
}
