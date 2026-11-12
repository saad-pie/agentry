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

export function emitTrace(events, payload) {
  setImmediate(() => {
    try { events.emit(payload.kind || "synthesize.trace", payload); } catch {}
  });
  return { ok: true };
}

export function formatTraceEmail(t) {
  const L = [];
  L.push("**Trace: " + t.capability_id + "**");
  L.push("");
  L.push("- source: " + (t.source || "dsh"));
  L.push("- intent: " + (t.intent || "?"));
  L.push("- kind: " + (t.wanted_kind || "tool"));
  L.push("- trace_id: " + t.trace_id);
  L.push("- total_ms: " + t.total_ms);
  L.push("- outcome: " + ((t.outcome && t.outcome.verified) ? "verified" : "failed"));
  L.push("");
  L.push("**References shown:** " + ((t.references_shown && t.references_shown.length) ? t.references_shown.join(", ") : "(none)"));
  L.push("");
  if (t.spec_summary) {
    L.push("**Spec summary:**");
    L.push("- package_name: " + (t.spec_summary.package_name || "?"));
    L.push("- packages: " + ((t.spec_summary.packages || []).join(", ") || "?"));
    L.push("- accepts: " + ((t.spec_summary.accepts_keys || []).join(", ") || "?"));
    L.push("- produces: " + ((t.spec_summary.produces_keys || []).join(", ") || "?"));
    L.push("");
  }
  if (t.dsh_internals) {
    L.push("**DSH internals:**");
    L.push("- prompt_len: " + t.dsh_internals.prompt_len);
    L.push("- tool_calls: " + ((t.dsh_internals.tool_calls || []).length));
    for (const tc of (t.dsh_internals.tool_calls || []).slice(0, 8)) {
      L.push("  - " + (tc.tool || "?") + " (" + (tc.status || "?") + "): " + String(tc.input_preview || "").slice(0, 100));
    }
    L.push("- thinking_blocks: " + ((t.dsh_internals.thinking || []).length));
    L.push("");
  }
  if (t.mechanical_internals) {
    L.push("**Mechanical internals:**");
    L.push("- candidate: " + (t.mechanical_internals.candidate_id || "?"));
    L.push("- candidate_kind: " + (t.mechanical_internals.candidate_kind || "?"));
    L.push("- model_used: " + (t.mechanical_internals.model_used || "?"));
    L.push("- handler: " + (t.mechanical_internals.handler_path || "?"));
    L.push("- trial_session: " + (t.mechanical_internals.trial_session || "?"));
    if (t.mechanical_internals.original_error) L.push("- repaired_from: " + t.mechanical_internals.original_error);
    L.push("");
  }
  return L.join("\n");
}

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
