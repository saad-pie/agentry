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

// v0.18.3 — read a primary name, fall back to alternates.
// The Space sets GH_TOKEN (the standard gh CLI variable) but not
// GITHUB_TOKEN. Before this, config.github.token was always null in
// the Space, so every GitHub call was unauthenticated (60 req/hr).
// Now the config sees GH_TOKEN and authenticates (5000 req/hr).
function envOr(name, altName, fallback) {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  const a = process.env[altName];
  if (a !== undefined && a !== "") return a;
  return fallback;
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
      // Reads GITHUB_TOKEN, falls back to GH_TOKEN (set by the Space).
      // Null when neither is present — the adapter still works, just
      // rate-limited at 60 req/hr.
      token: envOr("GITHUB_TOKEN", "GH_TOKEN", null),
      userAgent: env("GITHUB_UA", "agentry/0.1.0"),
    },

    // Web search (Google Custom Search JSON API)
    googleCse: {
      key: env("GOOGLE_CSE_KEY", null),
      cx: env("GOOGLE_CSE_CX", null),
    },

    // LLM providers. Each entry is { baseUrl, apiKey }. Callers pass a
    // `provider` name to llm.openai_compat; the handler resolves baseUrl
    // + apiKey from this map. If provider is omitted, "atria" is used
    // (backwards compat with every call site written before v0.15.6).
    llm: {
      baseUrl: env("ATRIA_BASE_URL", "https://antigravity-seven-delta.vercel.app/v1"),
      apiKey: env("ATRIA_API_KEY", "antigravity-free"),
      metaFile: env("AGENTRY_META_FILE", null),
      providers: {
        atria: {
          baseUrl: env("ATRIA_BASE_URL", "https://antigravity-seven-delta.vercel.app/v1"),
          apiKey: env("ATRIA_API_KEY", "antigravity-free"),
        },
        plugsky: {
          baseUrl: env("PLUGSKY_BASE_URL", "https://api.plugsky.com/v1"),
          apiKey: env("PLUGSKY_API_KEY", null),
        },
        groq: {
          baseUrl: env("GROQ_BASE_URL", "https://api.groq.com/openai/v1"),
          apiKey: env("GROQ_API_KEY", null),
          // v0.23.2 — multi-key rotation. On 429 the llm handler rotates
          // to the next key before giving up. Only helps if the keys come
          // from separate Groq orgs (rate limits are per-org, not per-key);
          // same-org keys share the 8K TPM budget and won't help.
          keys: [
            env("GROQ_API_KEY", null),
            env("GROQ_API_KEY_1", null),
            env("GROQ_API_KEY_2", null),
            env("GROQ_API_KEY_3", null),
          ].filter(Boolean),
        },
        google: {
          baseUrl: env("ATRIA_BASE_URL", "https://antigravity-seven-delta.vercel.app/v1"),
          apiKey: env("ATRIA_API_KEY", "antigravity-free"),
        },
        unorouter: {
          baseUrl: env("ATRIA_BASE_URL", "https://antigravity-seven-delta.vercel.app/v1"),
          apiKey: env("ATRIA_API_KEY", "antigravity-free"),
        },
        requesty: {
          baseUrl: env("REQUESTY_BASE_URL", "https://router.requesty.ai/v1"),
          apiKey: env("REQUESTYAI_API_KEY", null),
        },
        anyrouter: {
          baseUrl: env("ANYROUTER_BASE_URL", "https://anyrouter.dev/api/v1"),
          apiKey: env("ANYROUTER_API_KEY", null),
        },
        orcarouter: {
          baseUrl: env("ORCAROUTER_BASE_URL", "https://api.orcarouter.ai/v1"),
          apiKey: env("ORCAROUTER_API_KEY", null),
          keys: [
            env("ORCAROUTER_API_KEY", null),
            env("ORCAROUTER_API_KEY_1", null),
            env("ORCAROUTER_API_KEY_2", null),
            env("ORCAROUTER_API_KEY_3", null),
            env("ORCAROUTER_API_KEY_4", null),
            env("ORCAROUTER_API_KEY_5", null),
          ].filter(Boolean),
        },
      },
    },

    // Runtime behavior
    runtime: {
      pollTickMs: Number(env("AGENTRY_TICK_MS", "30000")),      // main loop tick
      watchMaxConcurrent: Number(env("AGENTRY_WATCH_MAX", "5")),
      discoveryEnabled: env("AGENTRY_DISCOVERY", "true") === "true",
      // v0.23.4 — added "tool" to the default auto-adopt kinds.
    // A tool gap that auto-proposes still runs the full synthesize→trial
    // pipeline; trial failure rejects the candidate. So auto-approving
    // tool is safe: bad candidates still fail at trial. Without "tool"
    // here, every tool gap lands in "pending" and stalls discovery
    // (hasProposal blocks re-proposal). Override via AGENTRY_AUTOADOPT_KINDS
    // if a deployment prefers manual review of tool adoptions.
    adoptionAutoKinds: (env("AGENTRY_AUTOADOPT_KINDS", "notify,watcher,invoker,discovery,tool") || "")
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
