// agentry/src/config.mjs
// The single source of truth for paths and secrets.
// Nothing else in agentry reads process.env directly. Ever.
//
// Why: so we never repeat the "hardcoded /tmp" mistake. Every path comes from here.

import { homedir } from "node:os";
import { join } from "node:path";

function env(name, fallback) {
  const v = process.env[name];
  return (v === undefined || v === "") ? fallback : v;
}

function required(name) {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(`[config] required env var missing: ${name}`);
  }
  return v;
}

/**
 * Build the config object. All fields are plain values, no laziness.
 * Call this ONCE at process start. Pass the result around.
 *
 * Defaults are chosen to work in three environments:
 *   - HF Space:  AGENTRY_DIR=/tmp/home/.dsh/agentry is set by entrypoint.sh
 *   - Termux:    ~/.agentry (auto-detected via $HOME)
 *   - Anywhere:  falls back to <home>/.agentry
 */
export function loadConfig(overrides = {}) {
  const baseDir =
    overrides.dir ||
    env("AGENTRY_DIR", join(homedir() || "/tmp", ".agentry"));

  return {
    dir: baseDir,

    // Email (Gmail API, OAuth 2.0)
    gmail: {
      clientId: env("GMAIL_CLIENT_ID", null),
      clientSecret: env("GMAIL_CLIENT_SECRET", null),
      refreshToken: env("GMAIL_REFRESH_TOKEN", null),
      from: env("GMAIL_FROM", null),
      to: env("GMAIL_TO", null),
    },

    // GitHub (discovery source)
    github: {
      token: env("GITHUB_TOKEN", null),         // optional: unauthenticated works but is rate-limited
      userAgent: env("GITHUB_UA", "agentry/0.1.0"),
    },

    // Web search (Google Custom Search JSON API)
    googleCse: {
      key: env("GOOGLE_CSE_KEY", null),
      cx: env("GOOGLE_CSE_CX", null),
    },

    // LLM provider (the one your harness uses)
    llm: {
      baseUrl: env("ATRIA_BASE_URL", "https://antigravity-seven-delta.vercel.app/v1"),
      apiKey: env("ATRIA_API_KEY", "antigravity-free"),
      metaFile: env("AGENTRY_META_FILE", null),   // path to models.meta.json if present
    },

    // Runtime behavior
    runtime: {
      pollTickMs: Number(env("AGENTRY_TICK_MS", "30000")),      // main loop tick
      watchMaxConcurrent: Number(env("AGENTRY_WATCH_MAX", "5")),
      discoveryEnabled: env("AGENTRY_DISCOVERY", "true") === "true",
      adoptionAutoKinds: (env("AGENTRY_AUTOADOPT_KINDS", "notify,watcher,invoker,discovery") || "")
        .split(",").map(s => s.trim()).filter(Boolean),
    },

    ...overrides,
  };
}

/**
 * Throws if a capability that needs a secret is missing it.
 * Called by capabilities themselves, not by the config loader.
 */
export function assertConfigured(cfg, path, capabilityId) {
  const parts = path.split(".");
  let node = cfg;
  for (const p of parts) node = node?.[p];
  if (!node) {
    throw new Error(`[config] capability ${capabilityId} requires config.${path} — env var not set`);
  }
  return node;
}
