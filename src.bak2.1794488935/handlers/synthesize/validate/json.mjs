// agentry/src/handlers/synthesize/validate/json.mjs
// v0.53.3 — extracted from agentry.synthesize.mjs.

export function repairJsonControlChars(s) {
  let out = "", inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { out += c; esc = false; continue; }
    if (inStr && c === "\\") { out += c; esc = true; continue; }
    if (c === '"') { out += c; inStr = !inStr; continue; }
    if (inStr && c === "\n") { out += "\\n"; continue; }
    if (inStr && c === "\r") { out += "\\r"; continue; }
    if (inStr && c === "\t") { out += "\\t"; continue; }
    out += c;
  }
  return out;
}

export function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  if (!s.startsWith("{")) {
    const fence = s.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
    if (fence) s = fence[1].trim();
  }
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  const slice = s.slice(first, last + 1);
  try { return JSON.parse(slice); } catch {}
  try { return JSON.parse(repairJsonControlChars(slice)); } catch {}
  return null;
}

// ─────────────────────────────────────────────────────────────
// Plan validation — the shape's step list is the contract
// ─────────────────────────────────────────────────────────────

