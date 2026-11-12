// agentry/src/handlers/synthesize/decode.mjs
// v0.53.3 — extracted from agentry.synthesize.mjs.

export function decodeIfDoubleEscaped(s) {
  if (typeof s !== "string" || !s.length) return s;
  if (s.includes("\n")) return s;
  if (!s.includes("\\n")) return s;
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\");
}



// ─────────────────────────────────────────────────────────────
// Rendering — plan → single kernel script + seed JSON
// ─────────────────────────────────────────────────────────────

