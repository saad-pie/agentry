// agentry/src/handlers/synthesize/references.mjs
// v0.53.8 — reference-learning. Picks 1-2 verified handlers from the runtime
// synthesis pool and returns their source. Injected into the DSH prompt so the
// model copies the working pattern (await import, env vars, stdout JSON) instead
// of inventing its own from npm READMEs (which are often CJS).

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { HANDLERS_DIR, SEEDS_DIR } from "./config.mjs";

function tokenize(s) {
  return String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2);
}

function score(c, tokens, kind) {
  let n = 0;
  if (c.kind === kind) n += 5;
  const idToks = tokenize(c.id);
  const accToks = tokenize(c.accepts.join(" "));
  for (const t of tokens) {
    if (idToks.includes(t)) n += 3;
    else if (accToks.includes(t)) n += 1;
  }
  return n;
}

export function pickReferenceHandlers(intent, kind, max = 2) {
  if (!existsSync(SEEDS_DIR)) return [];
  let files = [];
  try { files = readdirSync(SEEDS_DIR).filter(f => f.endsWith(".json")); } catch { return []; }
  const candidates = [];
  for (const f of files) {
    let seed;
    try { seed = JSON.parse(readFileSync(join(SEEDS_DIR, f), "utf8")); } catch { continue; }
    if (!seed.id || !seed.handler_file) continue;
    if (seed.source !== "dsh_synth:verified") continue;
    if (!existsSync(seed.handler_file)) continue;
    let _src = "";
    try { _src = readFileSync(seed.handler_file, "utf8"); } catch { continue; }
    if (_src.includes("globalThis.")) continue;
    candidates.push({
      id: seed.id, kind: seed.kind || "tool",
      accepts: Object.keys(seed.accepts || {}),
      produces: Object.keys(seed.produces || {}),
      handler_file: seed.handler_file,
      filename: f.replace(/\.json$/, ".mjs"),
    });
  }
  const tokens = tokenize(intent);
  if (tokens.length === 0) return [];
  const scored = candidates.map(c => ({
    c, s: score(c, tokens, kind),
    real: tokens.some(t => tokenize(c.id).includes(t) || tokenize(c.accepts.join(" ")).includes(t)),
  }))
    .filter(x => x.real && x.s > 0).sort((a, b) => b.s - a.s);
  const picked = [];
  for (const { c } of scored) {
    if (picked.length >= max) break;
    try {
      let src = readFileSync(c.handler_file, "utf8");
      const lines = src.split("\n");
      if (lines.length > 140) src = lines.slice(0, 140).join("\n") + "\n// ... (truncated)";
      let reqNpm = [];
      try {
        const seedPath = join(SEEDS_DIR, c.filename.replace(/\.mjs$/, ".json"));
        if (existsSync(seedPath)) {
          const seedData = JSON.parse(readFileSync(seedPath, "utf8"));
          reqNpm = (seedData.requires && Array.isArray(seedData.requires.npm)) ? seedData.requires.npm : [];
        }
      } catch {}
      picked.push({ id: c.id, filename: c.filename, kind: c.kind,
        accepts: c.accepts, produces: c.produces, requires_npm: reqNpm, source: src });
    } catch {}
  }
  return picked;
}

export function formatReferences(refs) {
  if (!refs || !refs.length) return "";
  const blocks = refs.map(r => {
    const reqLine = (r.requires_npm && r.requires_npm.length)
      ? ("Requires npm: [" + r.requires_npm.join(", ") + "]  <-- USE THESE PACKAGES, DO NOT EXPLORE ALTERNATIVES\n")
      : "";
    return "=== WORKING REFERENCE (verified, real .mjs file) ===\n"
      + "Filename: " + r.filename + "\n"
      + "Kind: " + r.kind + "\n"
      + "Accepts: " + r.accepts.join(", ") + "\n"
      + "Produces: " + r.produces.join(", ") + "\n"
      + reqLine
      + "---\n"
      + r.source + "\n"
      + "=== END REFERENCE ===\n";
  }).join("\n");
  const anyReq = refs.some(r => r.requires_npm && r.requires_npm.length);
  const hint = anyReq
    ? ("\nSTRONG HINT: The reference above already proves which packages work. " +
       "Use those packages with the same import pattern. Do NOT spend time searching npm for alternatives. " +
       "Your goal is to adapt the reference pattern to the new intent in under 15 tool_calls.\n")
    : "";
  return blocks + hint;
}
