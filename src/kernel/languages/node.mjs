// agentry/src/kernel/languages/node.mjs
//
// Node.js runtime primitives. Runs JS files, installs npm packages,
// runs npx. Uses the same Node binary that runs the kernel.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_OUTPUT_BYTES = 1 * 1024 * 1024;

export function nodeRun(sessions, { session, code, file, args = [], cwd, env = {}, timeout_ms = DEFAULT_TIMEOUT_MS } = {}) {
  const s = sessions.get(session);
  if (!s) { const e = new Error(`unknown session: ${session}`); e.code = "NOT_FOUND"; throw e; }
  if (!code && !file) {
    const e = new Error("node.run requires either 'code' or 'file'");
    e.code = "INVALID_REQUEST";
    throw e;
  }

  let scriptPath;
  if (code) {
    const dir = sessions.resolvePath(session, ".agentry_scripts");
    mkdirSync(dir, { recursive: true });
    const fname = `script_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}.mjs`;
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

  const r = spawnSync(process.execPath, [scriptPath, ...args], {
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

export function nodeInstall(sessions, { session, packages = [], dev = false, timeout_ms = 180000 } = {}) {
  const s = sessions.get(session);
  if (!s) { const e = new Error(`unknown session: ${session}`); e.code = "NOT_FOUND"; throw e; }
  if (!Array.isArray(packages) || packages.length === 0) {
    const e = new Error("node.install requires non-empty 'packages' array");
    e.code = "INVALID_REQUEST";
    throw e;
  }
  for (const p of packages) {
    if (typeof p !== "string" || !/^[@a-zA-Z0-9_.\-\/]+$/.test(p)) {
      const e = new Error(`invalid package name: ${p}`);
      e.code = "INVALID_REQUEST";
      throw e;
    }
  }

  // Bootstrap package.json if it doesn't exist.
  const cwd = sessions.resolvePath(session, ".");
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) {
    writeFileSync(pkgPath, JSON.stringify({
      name: `agentry-session-${session}`,
      version: "1.0.0",
      type: "module",
      private: true,
    }, null, 2));
  }

  const args = ["install", "--no-audit", "--no-fund"];
  if (dev) args.push("--save-dev");
  args.push(...packages);

  const r = spawnSync("npm", args, {
    cwd,
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

export function nodeNpx(sessions, { session, pkg, args = [], cwd, timeout_ms = 120000 } = {}) {
  const s = sessions.get(session);
  if (!s) { const e = new Error(`unknown session: ${session}`); e.code = "NOT_FOUND"; throw e; }
  if (!pkg || typeof pkg !== "string") {
    const e = new Error("node.npx requires 'pkg'");
    e.code = "INVALID_REQUEST";
    throw e;
  }
  const absCwd = cwd ? sessions.resolvePath(session, cwd) : sessions.resolvePath(session, ".");
  const r = spawnSync("npx", ["-y", pkg, ...args], {
    cwd: absCwd,
    env: { ...process.env, ...s.env },
    timeout: timeout_ms,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES * 4,
  });
  return {
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    exit_code: r.status,
    pkg,
  };
}

export function nodeVersion(sessions, { session }) {
  const s = sessions.get(session);
  if (!s) { const e = new Error(`unknown session: ${session}`); e.code = "NOT_FOUND"; throw e; }
  return { version: process.version };
}
