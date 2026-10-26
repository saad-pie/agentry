// agentry/src/handlers/agentry.trace.mjs
// v0.56.8 — reconstruct the timeline of events for a capability.
// Scans events.jsonl, filters to events whose capability_id or gap_id
// matches, sorts chronologically, returns a structured timeline.
// Slow-ish (scans full log) but read-only and only used for inspection.

function summarize(e) {
  const k = e.kind || "?";
  if (k === "ensure.gap_recorded") return "gap recorded: " + (e.gap_id || "?");
  if (k === "ensure.mechanical_started") return "Mechanical funnel: intent=" + JSON.stringify(e.intent || "") + " budget=" + e.budget_ms + "ms";
  if (k === "ensure.mechanical_adopting") return "Mechanical proposing: " + (e.recommended_id || "?") + " (" + (e.candidates_count || 0) + " candidates)";
  if (k === "ensure.mechanical_not_adopted") return "Mechanical failed: " + (e.reason || "?") + " (" + (e.ms || 0) + "ms)";
  if (k === "ensure.mechanical_adopted") return "Mechanical success: " + (e.kind || "?") + " (" + (e.waited_ms || 0) + "ms)";
  if (k === "ensure.dsh_synthesized") return "DSH success: " + (e.package_name || "?") + " (" + (e.waited_ms || 0) + "ms)";
  if (k === "ensure.dsh_synth_not_verified") return "DSH not verified: " + (e.reason || "?");
  if (k === "dsh_synth.started") return "DSH started, " + (e.timeout_ms || 0) + "ms budget";
  if (k === "dsh_synth.references_picked") return "References: " + (e.count || 0) + " (" + ((e.ids || []).join(", ") || "none") + ")";
  if (k === "dsh_synth.pretest_passed") return "Pretest passed: " + (e.package_name || "?") + " (" + (e.output_bytes || 0) + " bytes)";
  if (k === "dsh_synth.pretest_failed") return "Pretest failed: " + (e.package_name || "?") + " exit=" + (e.exit_code ?? "?");
  if (k === "dsh_synth.packages_pruned" || k === "dsh_synth.packages_reconciled") return "Packages reconciled: kept=" + JSON.stringify(e.kept || e.imported || []) + " dropped=" + JSON.stringify(e.dropped || e.extra || []);
  if (k === "dsh_synth.gap_retired") return "Gap retired";
  if (k === "dsh_synth.trace") {
    if (e.dsh_internals) return "Trace captured (dsh): " + ((e.dsh_internals.tool_calls || []).length) + " tool_calls, " + ((e.dsh_internals.thinking || []).length) + " thinking blocks";
    return "Trace captured (dsh)";
  }
  if (k === "synthesize.trace") {
    if (e.mechanical_internals) return "Trace captured (mechanical): candidate=" + (e.mechanical_internals.candidate_id || "?") + " model=" + (e.mechanical_internals.model_used || "?") + (e.mechanical_internals.original_error ? " (repaired)" : "");
    return "Trace captured (mechanical)";
  }
  if (k === "dsh_synth.completed") return "Completed: " + (e.package || "?") + " (" + (e.ms || 0) + "ms)";
  if (k === "dsh_synth.failed" || k === "dsh_synth.no_spec") return "DSH failed: " + (e.reason || "?");
  if (k === "proposal.created") return "Proposal created: " + (e.recommended_id || "no rec") + " (" + (e.candidates || 0) + " candidates)";
  if (k === "adoption.synthesize_completed") return "Synthesis done: " + (e.capability_id || "?");
  if (k === "adoption.trial_completed") return "Trial passed: " + (e.capability_id || "?");
  if (k === "adoption.trial_failed") return "Trial failed: " + (e.capability_id || "?") + " phase=" + (e.phase || "?");
  if (k === "adoption.capability_added") return "Capability adopted: " + (e.capability_id || "?");
  if (k === "invoke.succeeded") return "Invoke succeeded: " + (e.capability_id || "?") + " (" + (e.ms || 0) + "ms)";
  if (k === "invoke.failed") return "Invoke failed: " + (e.capability_id || "?") + " (" + (e.code || "?") + ")";
  if (k === "discovery.watch_created") return "watch created: " + (e.watch_id || "?") + " for gap " + (e.gap_id || "?");
  if (k === "discovery.watch_retired" || k === "adoption.watch_retired") return "watch retired: " + (e.watch_id || "?");
  if (k === "synthesize.started") return "synthesize starting: candidate=" + (e.candidate_id || "?") + " kind=" + (e.candidate_kind || "?");
  if (k === "synthesize.completed") return "synthesize done: " + (e.capability_id || "?") + " model=" + (e.model_used || "?");
  if (k === "proposal.auto_decided") return "proposal auto-decided: " + (e.recommended_id || "no rec");
  if (k === "capability_gap.recorded") return "gap node written: " + (e.key || "?");
  if (k === "dsh_synth.handler_verified") return "handler verified: " + (e.ok ? "OK" : "FAIL") + " — " + (e.reason || "?");
  if (k === "tool" && e.capability_id) return "tool event: " + e.capability_id + (e.ms ? " (" + e.ms + "ms)" : "");
  if (!k || k === "null") return "(event missing kind field)";
  return k;
}

function stripLarge(e) {
  const out = {};
  for (const [k, v] of Object.entries(e)) {
    if (k === "kind" || k === "at") continue;
    if (typeof v === "string" && v.length > 400) {
      out[k] = v.slice(0, 400) + "...[" + (v.length - 400) + " more chars]";
    } else if (typeof v === "object" && v !== null) {
      const s = JSON.stringify(v);
      out[k] = s.length > 800 ? JSON.parse(s.slice(0, 799) + "}") : v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export default async function agentryTrace(input, ctx) {
  const { capability_id, gap_id, limit } = input || {};
  const target = capability_id || gap_id;
  if (!target) throw new Error("agentry.trace requires capability_id or gap_id");
  const max = Math.max(1, Math.min(2000, Number(limit) || 1000));

  const all = ctx.events.all();
  const chain = [];
  const gapKey = target.startsWith("gap:") ? target : "gap:" + target;
  for (const e of all) {
    const match = e.capability_id === target
      || e.gap_id === target
      || e.gap_id === gapKey
      || e.key === gapKey;
    if (match) chain.push(e);
  }
  chain.sort((a, b) => (a.at || 0) - (b.at || 0));
  const sliced = chain.slice(-max);

  const t0 = sliced.length > 0 ? sliced[0].at : null;
  const timeline = sliced.map(e => ({
    at: e.at,
    rel_ms: t0 !== null ? e.at - t0 : 0,
    kind: e.kind,
    summary: summarize(e),
    data: stripLarge(e),
  }));

  return {
    output: {
      target,
      event_count: chain.length,
      showing: sliced.length,
      timeline,
    },
    cost: { time_ms: 0 },
  };
}
