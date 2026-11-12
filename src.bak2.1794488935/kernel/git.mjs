// agentry/src/kernel/git.mjs
//
// Git primitives. Clone, status, commit, log. Uses the system git
// binary. All operations are confined to the session's root.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

function git(sessions, session, args, { cwd, timeout_ms = DEFAULT_TIMEOUT_MS } = {}) {
  const s = sessions.get(session);
  if (!s) { const e = new Error(`unknown session: ${session}`); e.code = "NOT_FOUND"; throw e; }
  const absCwd = cwd ? sessions.resolvePath(session, cwd) : sessions.resolvePath(session, ".");
  const r = spawnSync("git", args, {
    cwd: absCwd,
    env: {
      ...process.env,
      ...s.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "echo",
    },
    timeout: timeout_ms,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES * 4,
  });
  return {
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    exit_code: r.status,
    error: r.error ? r.error.message : null,
  };
}

export function gitClone(sessions, { session, url, dest, depth, timeout_ms } = {}) {
  if (!url || typeof url !== "string") {
    const e = new Error("git.clone requires 'url'");
    e.code = "INVALID_REQUEST";
    throw e;
  }
  // Only allow https URLs — no ssh, no git://, no file://.
  if (!url.startsWith("https://")) {
    const e = new Error(`git.clone only supports https:// URLs, got: ${url}`);
    e.code = "INVALID_REQUEST";
    throw e;
  }

  const args = ["clone"];
  if (depth) args.push("--depth", String(Number(depth) || 1));
  args.push(url);
  if (dest) args.push(dest);

  const r = git(sessions, session, args, { timeout_ms: timeout_ms || 180000 });
  let path = dest;
  if (!path) {
    // git clone https://github.com/foo/bar.git → bar
    const m = url.match(/\/([^\/]+?)(\.git)?$/);
    path = m ? m[1] : null;
  }
  return {
    path,
    exit_code: r.exit_code,
    stdout_tail: r.stdout.split("\n").slice(-5).join("\n"),
    stderr_tail: r.stderr.split("\n").slice(-5).join("\n"),
    error: r.error,
  };
}

export function gitStatus(sessions, { session, repo } = {}) {
  const r = git(sessions, session, ["status", "--porcelain=v1", "--branch"], { cwd: repo });
  const lines = r.stdout.split("\n").filter(Boolean);
  const branchLine = lines.find(l => l.startsWith("##"));
  const branch = branchLine ? branchLine.replace(/^##\s*/, "").split("...")[0] : null;
  const files = lines.filter(l => !l.startsWith("##")).map(l => ({
    status: l.slice(0, 2).trim(),
    path: l.slice(3),
  }));
  return { branch, dirty: files.length > 0, files, exit_code: r.exit_code };
}

export function gitCommit(sessions, { session, repo, message, files, sign = false } = {}) {
  if (!message || typeof message !== "string") {
    const e = new Error("git.commit requires 'message'");
    e.code = "INVALID_REQUEST";
    throw e;
  }
  const cwd = repo;
  // Add files (or everything).
  const addArgs = ["add", "--"];
  addArgs.push(...(Array.isArray(files) && files.length ? files : ["."]));
  const addR = git(sessions, session, addArgs, { cwd });
  if (addR.exit_code !== 0) {
    return { sha: null, exit_code: addR.exit_code, stderr: addR.stderr, added: false };
  }

  const commitArgs = ["commit", "-m", message];
  if (sign) commitArgs.push("-S");
  const commitR = git(sessions, session, commitArgs, { cwd });

  // Extract sha from stdout if commit succeeded.
  let sha = null;
  const m = commitR.stdout.match(/\[[^\]]+\s+([0-9a-f]{7,40})\]/);
  if (m) sha = m[1];

  return {
    sha,
    exit_code: commitR.exit_code,
    added: true,
    stdout_tail: commitR.stdout.split("\n").slice(0, 3).join("\n"),
    stderr_tail: commitR.stderr.split("\n").slice(-3).join("\n"),
  };
}

export function gitLog(sessions, { session, repo, n = 5 } = {}) {
  const r = git(sessions, session, ["log", `-${Math.min(Number(n) || 5, 50)}`, "--oneline"], { cwd: repo });
  const commits = r.stdout.split("\n").filter(Boolean).map(line => {
    const [sha, ...rest] = line.split(" ");
    return { sha, message: rest.join(" ") };
  });
  return { commits, exit_code: r.exit_code };
}

export function gitVersion(sessions, { session }) {
  const r = git(sessions, session, ["--version"]);
  return { version: r.stdout.trim() || r.stderr.trim(), exit_code: r.exit_code };
}
