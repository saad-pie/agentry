// agentry/src/handlers/agentry.build_from_candidate.mjs
// v0.58.1 — build from a DSH-chosen candidate. No ranking. DSH already picked.

export default async function agentryBuildFromCandidate(input, ctx) {
  const { gap_id, candidate, wanted_kind } = input || {};
  if (!gap_id || typeof gap_id !== "string") throw new Error("agentry.build_from_candidate requires gap_id");
  if (!candidate || typeof candidate !== "object" || !candidate.id) throw new Error("agentry.build_from_candidate requires candidate object with id");

  const started = Date.now();
  const graph = ctx.graph, events = ctx.events;

  events.emit("build_from_candidate.started", { gap_id, candidate_id: candidate.id });

  // v0.58.4 — pre-check. If the capability already exists with a passed trial
  // and a live handler, do NOT rebuild. A previous race caused working caps to
  // be overwritten by subsequent synth attempts with a different spec, then
  // retired when the new spec failed trial. This check makes build idempotent:
  // once it works, calling build again returns the existing cap.
  {
    const _preTarget = gap.wanted_id || gap_id.replace(/^gap:/, "");
    const _preCap = graph.getCapability(_preTarget);
    if (_preCap && !_preCap.retired_at && _preCap.trial_passed_at && _preCap.handler_file) {
      events.emit("build_from_candidate.already_exists", {
        gap_id, capability_id: _preTarget, handler_path: _preCap.handler_file,
      });
      // retire gap if still open
      try {
        if (!gap.retired_at) graph.retireCapability(gap_id, "build_from_candidate: already adopted");
      } catch (e) { events.emit("build.retire_gap_failed", { gap_id, error: String(e.message || "").slice(0, 200) }); }
      return {
        output: {
          ok: true,
          gap_id,
          capability_id: _preTarget,
          handler_path: _preCap.handler_file,
          already_existed: true,
          hint: "Capability already exists and passed trial. Call invoke() now.",
        },
        cost: { time_ms: Date.now() - started },
      };
    }
  }

  // 1. Verify gap exists; create if missing
  let gap = graph.getCapability(gap_id);
  if (!gap) {
    try {
      const { recordGap } = await import("./agentry.capability_gap.mjs");
      recordGap({ graph, events }, {
        key: gap_id,
        wanted_kind: wanted_kind || "tool",
        wanted_id: gap_id.replace(/^gap:/, ""),
        wanted_description: String(candidate.description || candidate.name || candidate.id).slice(0, 200),
        reason: "build_from_candidate.implicit_gap",
      });
      gap = graph.getCapability(gap_id);
    } catch (e) {
      return { output: { ok: false, reason: "gap_create_failed: " + e.message }, cost: { time_ms: Date.now() - started } };
    }
  }
  if (!gap) return { output: { ok: false, reason: "gap_not_found" }, cost: { time_ms: Date.now() - started } };
  if (gap.retired_at) return { output: { ok: false, reason: "gap_retired" }, cost: { time_ms: Date.now() - started } };

  // 2. Single-candidate proposal, pre-approved
  const proposalId = "proposal_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  const gapKind = gap.wanted_kind || wanted_kind || "tool";
  const gapCapId = gap.wanted_id || gap_id.replace(/^gap:/, "");

  graph.putCapability({
    id: proposalId,
    kind: "proposal",
    state: "decided",
    gap_id: gap_id,
    gap_wanted_kind: gapKind,
    gap_wanted_id: gapCapId,
    analysis: {
      recommended_id: candidate.id,
      summary: "DSH chose candidate " + candidate.id + " for gap " + gap_id,
      candidates: [{ id: candidate.id, fit: 1, confidence: "high", why: "DSH-selected", risks: [] }],
    },
    candidates: [candidate],
    decisions: { [candidate.id]: { decision: "approved", at: Date.now(), auto: true, source: "dsh_build" } },
    auto_approved: true,
    created_at: Date.now(),
    updated_at: Date.now(),
  });

  events.emit("build_from_candidate.proposal_created", { gap_id, proposal_id: proposalId, candidate_id: candidate.id });

  // 3. Adopt (synthesize + trial + adopt)
  let adopted = null;
  try {
    const adopt = await ctx.invoke("agentry.adopt", {
      proposal_id: proposalId,
      id_override: gapCapId,
    }, { tenant: "local", by: "build_from_candidate" });
    if (adopt.ok && adopt.output && Array.isArray(adopt.output.adopted) && adopt.output.adopted.length > 0) {
      adopted = adopt.output.adopted[0];
    }
  } catch (e) {
    events.emit("build_from_candidate.adopt_threw", { gap_id, error: e.message });
  }

  if (!adopted) {
    events.emit("build_from_candidate.failed", { gap_id, candidate_id: candidate.id, ms: Date.now() - started });
    return {
      output: {
        ok: false,
        reason: "adopt_failed",
        gap_id,
        candidate_id: candidate.id,
        hint: "Synthesis or trial failed. Try a different candidate from search().",
      },
      cost: { time_ms: Date.now() - started },
    };
  }

  events.emit("build_from_candidate.succeeded", {
    gap_id,
    candidate_id: candidate.id,
    capability_id: adopted.capability_id || gapCapId,
    handler_path: adopted.handler_path,
    ms: Date.now() - started,
  });

  // v0.58.4 — force-retire the gap after success. adopt.mjs already tries
  // this, but if its graph cache was stale the retire call silently no-ops
  // and the gap stays open. Background discovery loop then re-proposes,
  // re-synthesizes with a different spec, overwrites the working cap, trial
  // fails on the new spec, and the working cap gets retired. This second
  // retire (with cache invalidate) prevents that race.
  try {
    if (typeof graph.invalidateCache === "function") graph.invalidateCache();
    const _postGap = graph.getCapability(gap_id);
    if (_postGap && !_postGap.retired_at) {
      graph.retireCapability(gap_id, "build_from_candidate: successful adopt (force)");
      events.emit("build_from_candidate.gap_force_retired", { gap_id });
    }
  } catch (e) {
    events.emit("build.gap_force_retire_failed", { gap_id, error: String(e.message || "").slice(0, 200) });
  }

  // v0.58.2 — checkpoint async. Prior version blocked build return on git push
  // (+60s) making total latency exceed curl timeouts even when synth succeeded.
  setImmediate(() => {
    ctx.invoke("agentry.checkpoint", { reason: "build_from_candidate:" + (adopted.capability_id || gapCapId) })
      .catch(e => events.emit("build.checkpoint_async_failed", { gap_id, error: String(e.message || "").slice(0, 200) }));
  });

  return {
    output: {
      ok: true,
      gap_id,
      capability_id: adopted.capability_id || gapCapId,
      handler_path: adopted.handler_path,
      hint: "Capability built and trial-verified. Call invoke() now.",
    },
    cost: { time_ms: Date.now() - started },
  };
}
