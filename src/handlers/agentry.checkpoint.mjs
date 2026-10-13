// agentry/src/handlers/agentry.checkpoint.mjs
//
// Force an immediate save-to-GitHub of the state directory.
//
// Normally the entrypoint's autosave loop commits every 5 minutes.
// This handler triggers a commit+push out of cycle, so events that
// matter (a capability was just adopted) survive a crash in the
// window between ticks.
//
// Contract:
//   input:  { reason?, paths? }
//   output: { committed, pushed, sha, reason }
//
// Idempotent: if nothing has changed since the last save, this returns
// { committed: false, pushed: false }.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const STATE_DIR = process.env.AGENTRY_STATE_DIR || "/tmp/home/.dsh";

function git(args, opts = {}) {
  const r = spawnSync("git", args, {
    cwd: STATE_DIR,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout: opts.timeout || 30000,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    exit_code: r.status,
    error: r.error ? r.error.message : null,
  };
}

export default async function agentryCheckpoint(input, ctx) {
  const { reason = "manual", paths = null } = input || {};
  const started = Date.now();

  if (!existsSync(join(STATE_DIR, ".git"))) {
    return {
      output: {
        committed: false,
        pushed: false,
        sha: null,
        reason,
        note: "no .git in state dir",
      },
      cost: { time_ms: Date.now() - started },
    };
  }

  // Stage
  const add = paths && paths.length
    ? git(["add", "--", ...paths])
    : git(["add", "."]);
  if (add.exit_code !== 0) {
    throw new Error(`checkpoint: git add failed — ${add.stderr.slice(0, 200)}`);
  }

  // Is there anything to commit?
  const diff = git(["diff-index", "--quiet", "HEAD", "--"]);
  if (diff.exit_code === 0) {
    // Exit 0 = clean tree. Nothing to do.
    ctx.events.emit("checkpoint.clean", { reason });
    return {
      output: {
        committed: false,
        pushed: false,
        sha: null,
        reason,
        note: "clean tree",
      },
      cost: { time_ms: Date.now() - started },
    };
  }

  // Commit
  const message = `checkpoint: ${reason} @ ${new Date().toISOString()}`;
  const commit = git(["commit", "-m", message]);
  if (commit.exit_code !== 0) {
    throw new Error(`checkpoint: git commit failed — ${commit.stderr.slice(0, 200)}`);
  }

  // Extract sha from stdout like "[main abc1234] ..."
  const shaMatch = commit.stdout.match(/\[[^\]]+\s+([0-9a-f]{7,40})\]/);
  const sha = shaMatch ? shaMatch[1] : null;

  // Push
  const push = git(["push", "-u", "origin", "HEAD", "--force"], { timeout: 60000 });
  if (push.exit_code !== 0) {
    ctx.events.emit("checkpoint.push_failed", {
      reason,
      sha,
      stderr: push.stderr.slice(0, 200),
    });
    throw new Error(`checkpoint: git push failed — ${push.stderr.slice(0, 200)}`);
  }

  ctx.events.emit("checkpoint.pushed", { reason, sha, ms: Date.now() - started });

  return {
    output: {
      committed: true,
      pushed: true,
      sha,
      reason,
      message,
    },
    cost: { time_ms: Date.now() - started },
  };
}
