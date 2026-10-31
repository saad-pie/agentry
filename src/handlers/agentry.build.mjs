// agentry/src/handlers/agentry.build.mjs
// v0.56.51 — fire-and-forget single-gap build.
// Bypasses the discovery loop's 30s poll cycle. chat fires this for each
// missing capability in its plan and returns immediately.

export default async function agentryBuild(input, ctx) {
  const { gap_id, capability_id } = input || {};
  if (!gap_id && !capability_id) throw new Error("agentry.build requires gap_id or capability_id");
  if (typeof ctx.invoke !== "function") throw new Error("agentry.build requires ctx.invoke");

  const started = Date.now();
  const graph = ctx.graph;
  const events = ctx.events;

  const gapId = gap_id || ("gap:" + capability_id);
  const gap = graph.getCapability(gapId);
  if (!gap) return { output: { ok: false, reason: "gap_not_found", gap_id: gapId }, cost: { time_ms: Date.now() - started } };
  if (gap.retired_at) return { output: { ok: false, reason: "gap_retired", gap_id: gapId }, cost: { time_ms: Date.now() - started } };

  const capId = gap.wanted_id || gapId.replace(/^gap:/, "");
  const desc = gap.wanted_description || gap.reason || capId;

  events.emit("build.started", { gap_id: gapId, capability_id: capId, desc });

  let candidates = [];
  try {
    const disc = await ctx.invoke("agentry.discover", {
      query: desc,
      sources: ["npm", "pypi", "crates", "gomod", "agentskills_code", "clawhub", "github", "dsh_plugins"],
      limit: 15,
    }, { tenant: "local", by: "agentry.build" });
    if (disc.ok && disc.output && disc.output.results) {
      for (const items of Object.values(disc.output.results)) {
        if (Array.isArray(items)) candidates.push(...items);
      }
    }
  } catch (e) {
    events.emit("build.discover_failed", { gap_id: gapId, error: e.message });
  }

  if (candidates.length === 0) {
    events.emit("build.no_candidates", { gap_id: gapId });
    return { output: { ok: false, reason: "no_candidates", gap_id: gapId, candidates: 0 }, cost: { time_ms: Date.now() - started } };
  }

  events.emit("build.discover_done", { gap_id: gapId, candidates: candidates.length });

  let proposalId = null;
  try {
    const prop = await ctx.invoke("agentry.proposal", {
      gap, candidates, notify: "notify.console",
    }, { tenant: "local", by: "agentry.build" });
    if (prop.ok && prop.output && prop.output.proposal_id) proposalId = prop.output.proposal_id;
  } catch (e) {
    events.emit("build.proposal_failed", { gap_id: gapId, error: e.message });
  }

  if (!proposalId) {
    return { output: { ok: false, reason: "no_proposal", gap_id: gapId }, cost: { time_ms: Date.now() - started } };
  }

  events.emit("build.proposal_done", { gap_id: gapId, proposal_id: proposalId });

  let adopted = null;
  try {
    const adopt = await ctx.invoke("agentry.adopt", {
      proposal_id: proposalId, id_override: capId,
    }, { tenant: "local", by: "agentry.build" });
    if (adopt.ok && adopt.output && Array.isArray(adopt.output.adopted) && adopt.output.adopted.length > 0) {
      adopted = adopt.output.adopted[0];
    }
  } catch (e) {
    events.emit("build.adopt_failed", { gap_id: gapId, error: e.message });
  }

  if (!adopted) {
    events.emit("build.failed", { gap_id: gapId, capability_id: capId, ms: Date.now() - started });
    return { output: { ok: false, reason: "adopt_failed", gap_id: gapId, capability_id: capId }, cost: { time_ms: Date.now() - started } };
  }

  events.emit("build.succeeded", {
    gap_id: gapId,
    capability_id: adopted.capability_id || capId,
    handler_path: adopted.handler_path,
    ms: Date.now() - started,
  });

  return {
    output: {
      ok: true, gap_id: gapId,
      capability_id: adopted.capability_id || capId,
      handler_path: adopted.handler_path,
    },
    cost: { time_ms: Date.now() - started },
  };
}
