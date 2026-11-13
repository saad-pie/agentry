// agentry/src/model_tiers.mjs
// v0.60.0-phase2.3.1 — tier → model chain mapping.
//
// Five tiers:
//   auto             — classifyAuto() picks one below
//   agentry-weak     — groq 20b / deepseek flash / haiku, 60s
//   agentry-medium   — default. groq 120b / sonnet / glm-flash, 120s
//   agentry-strong   — frontier. opus / gemini-argon / gpt-5.6-sol, 240s
//   agentry-frontier — same as strong today; Phase 3 adds election
//
// Backward compat: fast→agentry-weak, balanced→agentry-medium, strong→agentry-strong
//
// If caller passes "auto" or nothing, classifyAuto() runs on
// {prompt, cap}. Manual prefixes always win — auto only fills the gap.

import { MODEL_CHAIN as MEDIUM_CHAIN } from "./handlers/synthesize/config.mjs";

export const DEFAULT_TIER = "auto";

export const TIERS = {
  "agentry-weak": {
    label: "Auto · Weak",
    models: [
      { provider: "groq", model: "openai/gpt-oss-20b" },
      { provider: "crowllm", model: "deepseek-v4-flash:free" },
      { provider: "crowllm", model: "deepseek-v4.1-flash:free" },
      { provider: "coarena", model: "claude-haiku-5-5" },
      { provider: "groq", model: "qwen/qwen3.8-27b" },
    ],
    timeout: 60000,
    dsh_prefix: "[Quality tier: WEAK. Be concise. Act directly. Return final JSON — no plan preamble.]",
  },
  "agentry-medium": {
    label: "Auto · Medium",
    models: MEDIUM_CHAIN,
    timeout: 120000,
    dsh_prefix: "",
  },
  "agentry-strong": {
    label: "Auto · Strong",
    models: [
      { provider: "coarena", model: "claude-opus-5-5" },
      { provider: "coarena", model: "claude-fable-5-2" },
      { provider: "coarena", model: "gemini-4-argon" },
      { provider: "crowllm", model: "gpt-5.6-sol:free" },
      { provider: "crowllm", model: "gemini-3.1-pro:free" },
      { provider: "crowllm", model: "o3:free" },
      { provider: "coarena", model: "claude-sonnet-5-5" },
      { provider: "crowllm", model: "deepseek-v4-flash-0731-thinking:free" },
      { provider: "groq", model: "openai/gpt-oss-120b" },
    ],
    timeout: 240000,
    dsh_prefix: "[Quality tier: STRONG. Before acting: (1) read all relevant files, (2) write a short plan (3-5 bullets) in your first response, (3) execute step by step verifying each step, (4) if a step fails think about why before retrying, (5) return only the final answer as JSON.]",
  },
  "agentry-frontier": {
    label: "Auto · Frontier (Phase 3)",
    models: [
      { provider: "coarena", model: "claude-opus-5-5" },
      { provider: "coarena", model: "claude-fable-5-2" },
      { provider: "coarena", model: "gemini-4-argon" },
      { provider: "crowllm", model: "gpt-5.6-sol:free" },
      { provider: "crowllm", model: "gemini-3.1-pro:free" },
      { provider: "crowllm", model: "o3:free" },
      { provider: "coarena", model: "claude-sonnet-5-5" },
      { provider: "crowllm", model: "deepseek-v4-flash-0731-thinking:free" },
      { provider: "groq", model: "openai/gpt-oss-120b" },
    ],
    timeout: 360000,
    dsh_prefix: "[Quality tier: FRONTIER. Before acting: (1) read all relevant files, (2) write a detailed plan in your first response, (3) execute step by step verifying each step, (4) if a step fails think carefully about why before retrying, (5) consider alternative approaches when stuck, (6) return only the final answer as JSON.]",
  },
};

const LEGACY_MAP = { fast: "agentry-weak", balanced: "agentry-medium", strong: "agentry-strong" };
const STRONG_KINDS = new Set(["agent", "bua", "cua", "mua"]);
const SIMPLE_VERB = /\b(convert|parse|extract|fetch|format|reformat|transform|read|write|save)\b/i;
const COMPLEX_SIGNAL = /\b(build|implement|analyze|system|architect|design|optimize|debug|repair|migrate|refactor)\b/i;

export function classifyAuto({ prompt, cap } = {}) {
  if (cap) {
    if (cap.tier_hint && TIERS[cap.tier_hint]) return cap.tier_hint;
    if (LEGACY_MAP[cap.tier_hint]) return LEGACY_MAP[cap.tier_hint];
    if (STRONG_KINDS.has(cap.kind)) return "agentry-strong";
    const pkgCount = (cap.requires?.npm || []).length + (cap.requires?.pip || []).length;
    if (pkgCount > 3) return "agentry-strong";
    if (Object.keys(cap.accepts || {}).length > 4) return "agentry-strong";
    if ((cap.promote_attempts || 0) >= 2) return "agentry-strong";
  }
  if (prompt && typeof prompt === "string") {
    const p = prompt.toLowerCase();
    if (p.length > 500) return "agentry-strong";
    if (COMPLEX_SIGNAL.test(p)) return "agentry-strong";
    if (p.length < 100 && SIMPLE_VERB.test(p)) return "agentry-weak";
  }
  return "agentry-medium";
}

export function resolveTier(tierOrAuto, context = {}) {
  let tier = tierOrAuto;
  if (LEGACY_MAP[tier]) tier = LEGACY_MAP[tier];
  if (!tier || tier === "auto") tier = classifyAuto(context);
  return TIERS[tier] || TIERS["agentry-medium"];
}

export function isValidTier(tier) {
  if (!tier) return false;
  if (tier === "auto") return true;
  if (LEGACY_MAP[tier]) return true;
  return tier in TIERS;
}

// Backward compat
export const TIER_CHAINS = Object.fromEntries(
  Object.entries(TIERS).map(([name, cfg]) => [name, cfg.models])
);
