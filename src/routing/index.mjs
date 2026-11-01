// agentry/src/routing/index.mjs
// v0.57.0 — routing module. The single place where agentry decides
// "which capability should serve this intent".
//
// Replaces FOUR copies of _targetWord direction regex (chat, ensure,
// proposal, agent.plan) with one LLM-driven pick.
//
// The rule: regex is for PARSING (finding { } in JSON, finding /tmp/x.ext
// in text). Regex is NEVER for SEMANTICS. "Is yaml->json or yaml->toml
// what the user wants?" is a semantic question. LLM answers it. Regex
// guesses wrong.

/**
 * pick — choose the best capability for an intent from a candidate list.
 * Uses groq/gpt-oss-120b (fast, cheap) as tiebreak. Falls back to first
 * candidate on LLM failure.
 *
 * @param {string} intent — the user's natural language request
 * @param {Array<{id:string, description?:string, [key:string]:any}>} candidates
 * @param {object} ctx — runtime context with ctx.invoke
 * @returns {Promise<object|null>} — the picked candidate, or null if empty
 */
export async function pick(intent, candidates, ctx) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const top = candidates.slice(0, 6);
  try {
    const res = await ctx.invoke("llm.openai_compat", {
      provider: "groq",
      model: "openai/gpt-oss-120b",
      messages: [
        { role: "system", content: "You are a capability router. Return ONLY the exact id of the best candidate. If none fit, reply NONE. No prose. No fences." },
        { role: "user", content:
          "INTENT: " + String(intent).slice(0, 500) + "\n\n" +
          "CANDIDATES:\n" +
          top.map(c => "- " + c.id + (c.description ? ": " + String(c.description).slice(0, 120) : "")).join("\n") +
          "\n\nWhich capability_id best serves the intent? Reply with the exact id only."
        },
      ],
      temperature: 0,
      max_tokens: 60,
      timeout_ms: 4000,
    }, { tenant: "local", by: "routing.pick" });
    if (res.ok) {
      const raw = String(res.output.content || "").trim();
      if (raw.toUpperCase().startsWith("NONE")) return null;
      const id = raw.split(/\s+/)[0].replace(/[`"'*]/g, "");
      const match = top.find(c => c.id === id);
      if (match) return match;
    }
  } catch (e) { /* fall through */ }
  return top[0];
}

/**
 * classify — estimate complexity of an intent against the candidate pool.
 * No regex for semantics. Structural token membership only.
 *
 * @returns {{complexity: "easy"|"medium"|"hard"|"extreme", reason: string}}
 */
export function classify(intent, candidates) {
  const words = String(intent || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const EXTREME_KEYWORDS = ["research","browse","email","login","payment","deploy","database","browser","mobile","video","audio","scrape"];
  for (const kw of EXTREME_KEYWORDS) {
    if (words.includes(kw)) return { complexity: "extreme", reason: "domain keyword: " + kw };
  }
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { complexity: "hard", reason: "no candidates" };
  }
  if (candidates.length >= 3) return { complexity: "medium", reason: candidates.length + " candidates" };
  return { complexity: "easy", reason: candidates.length + " candidates" };
}

/**
 * buildModelChain — the one place model chains live. Callers pass a role,
 * get an ordered array. No more per-file chains that drift out of sync.
 *
 * @param {"planner"|"proposal"|"synth"|"repair"} role
 * @returns {Array<{provider:string, model:string}>}
 */
export function buildModelChain(role) {
  const chains = {
    planner: [
      { provider: "groq", model: "openai/gpt-oss-120b" },
      { provider: "orcarouter", model: "tencent/hy4-preview-free" },
      { provider: "orcarouter", model: "z-ai/glm-5.3-flash-free" },
      { provider: "google", model: "gemini-2.5-flash" },
    ],
    proposal: [
      { provider: "groq", model: "openai/gpt-oss-120b" },
      { provider: "orcarouter", model: "z-ai/glm-5.3-flash-free" },
      { provider: "orcarouter", model: "tencent/hy4-preview-free" },
      { provider: "ollama", model: "beam:cloud" },
      { provider: "google", model: "gemini-2.5-flash" },
    ],
    synth: [
      { provider: "groq", model: "openai/gpt-oss-120b" },
      { provider: "orcarouter", model: "tencent/hy4-preview-free" },
      { provider: "ollama", model: "beam:cloud" },
      { provider: "google", model: "gemini-2.5-flash" },
    ],
    repair: [
      { provider: "groq", model: "openai/gpt-oss-120b" },
      { provider: "orcarouter", model: "tencent/hy4-preview-free" },
      { provider: "google", model: "gemini-2.5-flash" },
    ],
  };
  return chains[role] || chains.planner;
}

/**
 * extractMessagePaths — structural path extraction from a message.
 * This IS regex, and it's LOAD-BEARING: finding "/tmp/x.ext" in arbitrary
 * text needs a regex. What was fragile was DIRECTION INFERENCE (which path
 * is input vs output). That's what pick() now handles.
 *
 * @returns {string[]} — deduped absolute-ish paths ending in a file extension
 */
export function extractMessagePaths(message) {
  const raw = [...String(message).matchAll(/\/[\w./-]+/g)].map(m => m[0]);
  const seen = new Set();
  return raw.filter(p => {
    if (seen.has(p)) return false;
    const last = p.split("/").pop() || "";
    if (!last.includes(".")) return false;
    if ((last.split(".").pop() || "").length < 2) return false;
    seen.add(p);
    return true;
  });
}
