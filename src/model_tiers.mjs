// agentry/src/model_tiers.mjs
// v0.60.0-phase2.3 — tier → model chain mapping.
//
// Three tiers ship in phase 2.3:
//   fast     — small models, 1-shot, cheap
//   balanced — medium models, default
//   strong   — frontier models, deeper budgets
//
// frontier tier is Phase 3 work (needs multi-model election) and is
// NOT resolved here. Callers requesting "frontier" fall through to
// "balanced" today.
//
// BALANCED refs MODEL_CHAIN from synthesize/config.mjs so there is one
// source of truth for the default chain.

import { MODEL_CHAIN as BALANCED_CHAIN } from "./handlers/synthesize/config.mjs";

export const DEFAULT_TIER = "balanced";

export const TIER_CHAINS = {
  fast: [
    { provider: "groq", model: "openai/gpt-oss-20b" },
    { provider: "coarena", model: "claude-haiku-5-5" },
    { provider: "groq", model: "qwen/qwen3.8-27b" },
  ],
  balanced: BALANCED_CHAIN,
  strong: [
    { provider: "coarena", model: "claude-opus-5-5" },
    { provider: "coarena", model: "gemini-4-argon" },
    { provider: "coarena", model: "claude-sonnet-5-5" },
    { provider: "groq", model: "openai/gpt-oss-120b" },
  ],
};

export function resolveTier(tier) {
  return TIER_CHAINS[tier] || TIER_CHAINS[DEFAULT_TIER];
}

export function isValidTier(tier) {
  return typeof tier === "string" && tier in TIER_CHAINS;
}
