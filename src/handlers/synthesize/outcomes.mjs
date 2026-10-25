// agentry/src/handlers/synthesize/outcomes.mjs
// v0.55.0 — write-only observation layer.
// Two logs: outcomes.jsonl (structured, quantitative) and references/<id>.json
// (free-form, LLM-authored). Neither is read yet — data accumulates for v0.55.1.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUTCOMES_FILE = process.env.AGENTRY_OUTCOMES_FILE
  || "/tmp/home/.dsh/agentry-synthesized/outcomes.jsonl";
const REFERENCES_DIR = process.env.AGENTRY_REFERENCES_DIR
  || "/tmp/home/.dsh/agentry-synthesized/references";

export function recordOutcome(rec) {
  try {
    const line = JSON.stringify({
      at: Date.now(),
      capability_id: rec.capability_id || null,
      intent: rec.intent || null,
      kind: rec.kind || "tool",
      refs_shown: Array.isArray(rec.refs_shown) ? rec.refs_shown : [],
      packages: Array.isArray(rec.packages) ? rec.packages : [],
      trial_ok: rec.trial_ok === true,
      elapsed_ms: Number(rec.elapsed_ms) || 0,
      error_class: rec.error_class || null,
      used_composition: rec.used_composition === true,
    });
    appendFileSync(OUTCOMES_FILE, line + "\n");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function writeReference(rec) {
  try {
    mkdirSync(REFERENCES_DIR, { recursive: true });
    const doc = {
      capability_id: rec.capability_id,
      authored_by: "dsh_synth",
      authored_at: Date.now(),
      // Maximum flexibility: DSH writes whatever it wants here. No schema.
      // The reader (v0.55.1+) stringifies it into the next prompt as raw context.
      spec_notes: rec.spec_notes ?? null,
      trial: {
        result: rec.trial_ok ? "pass" : "fail",
        error: rec.error ? String(rec.error).slice(0, 1000) : null,
        duration_ms: Number(rec.elapsed_ms) || 0,
        packages_used: Array.isArray(rec.packages) ? rec.packages : [],
        references_shown: Array.isArray(rec.refs_shown) ? rec.refs_shown : [],
        used_composition: rec.used_composition === true,
      },
    };
    const path = join(REFERENCES_DIR, rec.capability_id + ".json");
    writeFileSync(path, JSON.stringify(doc, null, 2));
    return { ok: true, path };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
