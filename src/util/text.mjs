// agentry/src/util/text.mjs
// v0.60.0-phase2 — consolidated query tokenizer. Was duplicated 5×.
export const SEARCH_FILLER = new Set([
  "convert","change","transform","turn","make","create","generate",
  "to","into","from","with","and","or","the","a","an",
  "file","files","using","please","via","through","for","of",
]);

export function simplifyQuery(q, maxTokens = 3) {
  const tokens = String(q || "").toLowerCase().split(/[^a-z0-9]+/)
    .filter(t => t.length >= 3 && !SEARCH_FILLER.has(t));
  return tokens.slice(0, maxTokens).join(" ");
}
