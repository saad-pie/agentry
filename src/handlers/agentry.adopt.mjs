// agentry/src/handlers/agentry.adopt.mjs
// Grows the graph. This is the handler that makes the pitch real.
//
// v0.15.5 — before writing a capability node, run synthesize → trial.
// Only write on trial pass. On trial fail, record a synthesis_attempt
// node (retired immediately) so we can inspect what the LLM tried, keep
// the gap open, and let discovery retry on the next tick.
//
// Notify: routes through notify.fallback so a Gmail outage doesn't
// swallow the adoption follow-up. On failure, notify.console writes
// the full body to stdout — visible in the HF Space log.
//
// Save-on-growth: after adoption writes a new capability and retires
// the gap, force an out-of-cycle checkpoint to GitHub so growth
// survives a crash before the next autosave tick.

import { link, RELATIONS } from "../graph/edges.mjs";

const DEFAULT_NOTIFY = "notify.email.gmail";
const REASON_SEP = "::";

// v0.15.5 — this is only used if synthesis is disabled via env.
// Normal path: synthesize + trial, node written only on pass.
const SYNTHESIS_ENABLED = process.env.AGENTRY_SYNTHESIS_ENABLED !== "0";

function buildPlaceholderCapability({ proposal, candidate, reason }) {
  // Only reached when SYNTHESIS_ENABLED=0 or synthesize/trial are not
  // available as capabilities. Keeps the previous behavior so this
  // batch can be rolled back with one env var.
  const capId = proposal.gap_wanted_id || proposal.gap_id;
  const capKind = proposal.gap_wanted_kind || "unknown";
  const now = Date.now();
  const provenance = candidate.kind === "web_result"
    ? `adopted:web:${candidate.domain || candidate.name || candidate.id}`
    : `adopted:github:${candidate.name || candidate.id}`;
  return {
    id: capId,
    kind: capKind,
    invoked_via: null,
    accepts: null,
    produces: null,
    source: provenance,
    notes: candidate.url || null,
    placeholder_reason: reason || "synthesis_disabled",
    adopted_from: {
      proposal_id: proposal.id,
      candidate_id: candidate.id,
      candidate_name: candidate.name || null,
      candidate_url: candidate.url || null,
      candidate_kind: candidate.kind || null,
      adopted_at: now,
    },
  };
}

function renderAdoptionEmail({ proposal, adopted, failed, retiredGap, retiredWatches }) {
  const lines = [];

  if (adopted.length) {
    lines.push(`Capability added: ${adopted.map(a => `\`${a.capability_id}\``).join(", ")}`);
    lines.push("");
    lines.push(`Kind: ${proposal.gap_wanted_kind || "unknown"}`);
    lines.push(`Gap filled: ${proposal.gap_id || "—"}`);
    lines.push("");
    lines.push("─── Auto-synthesized handlers ───");
    lines.push("");
    for (const a of adopted) {
      lines.push(`• \`${a.capability_id}\``);
      if (a.handler_path) lines.push(`  handler: \`${a.handler_path}\``);
      if (a.candidate_url) lines.push(`  source: ${a.candidate_url}`);
      if (a.trial_session) lines.push(`  trial session: \`${a.trial_session}\``);
      if (a.placeholder) lines.push(`  ⚠ placeholder (no handler) — synthesis was disabled`);
    }
    if (failed && failed.length) {
      lines.push("");
      lines.push("─── Failed (gap stays open, will retry next discovery) ───");
      lines.push("");
      for (const f of failed) {
        lines.push(`• \`${f.capability_id}\` — ${f.phase}: ${f.error}`);
        if (f.handler_path) lines.push(`  attempt: \`${f.handler_path}\``);
      }
    }
    lines.push("");
    lines.push(`Retired gap: \`${retiredGap || "none"}\``);
    lines.push(`Retired watches: ${retiredWatches.length ? retiredWatches.map(w => `\`${w}\``).join(", ") : "none"}`);
  } else {
    lines.push(`Proposal processed — nothing adopted.`);
    lines.push("");
    lines.push(`Proposal: \`${proposal.id}\``);
    lines.push(`Gap: \`${proposal.gap_id || "—"}\``);
    lines.push(`Wanted kind: ${proposal.gap_wanted_kind || "unknown"}`);
    lines.push("");
    if (failed && failed.length) {
      lines.push("─── Synthesis failures ───");
      lines.push("");
      for (const f of failed) {
        lines.push(`• \`${f.capability_id}\` — ${f.phase}: ${f.error}`);
        if (f.handler_path) lines.push(`  attempt: \`${f.handler_path}\``);
      }
      lines.push("");
      lines.push("The gap remains open. Discovery will retry on the next tick. Watches for this gap have been retired to prevent repeat emails; new watches will be created when the gap is re-observed.");
    } else {
      lines.push("The gap remains open. Discovery will propose again if a new candidate appears.");
    }
  }
  return lines.join("\n");
}

// v0.15.5 — record what the LLM tried so a human can inspect it without
// polluting the live capability set. Retired immediately.
function recordSynthesisAttempt(ctx, { proposal, candidate, phase, error, synthesis }) {
  try {
    const id = `synthesis_attempt:${proposal.id}:${candidate.id}:${Date.now()}`;
    ctx.graph.putCapability({
      id,
      kind: "synthesis_attempt",
      proposal_id: proposal.id,
      candidate_id: candidate.id,
      candidate_url: candidate.url || null,
      gap_id: proposal.gap_id || null,
      phase,
      error: String(error || "").slice(0, 800),
      handler_path: synthesis?.handler_path || null,
      seed_path: synthesis?.seed_path || null,
      capability_id_attempted: synthesis?.capability_id || null,
      retired_at: Date.now(),
      retired_reason: "synthesis_attempt_record",
    });
    ctx.events.emit("adoption.synthesis_attempt_recorded", {
      proposal_id: proposal.id,
      candidate_id: candidate.id,
      phase,
      error_preview: String(error || "").slice(0, 120),
      attempt_id: id,
    });
  } catch (e) {
    ctx.events.emit("adoption.synthesis_attempt_record_failed", { error: e.message });
  }
}

export default async function agentryAdopt(input, ctx) {
  const { proposal_id } = input || {};
  if (!proposal_id) throw new Error("agentry.adopt requires proposal_id");
  if (typeof ctx.invoke !== "function") {
    throw new Error("agentry.adopt requires ctx.invoke");
  }

  const started = Date.now();
  const graph = ctx.graph;
  const events = ctx.events;
  const notifyCap = input.notify || DEFAULT_NOTIFY;

  const proposal = graph.getCapability(proposal_id);
  if (!proposal) throw new Error(`agentry.adopt: proposal not found: ${proposal_id}`);
  if (proposal.kind !== "proposal") throw new Error(`agentry.adopt: ${proposal_id} is kind "${proposal.kind}", not "proposal"`);

  if (proposal.adopted_at) {
    return { output: { adopted: [], failed: [], retired_gap: null, retired_watches: [], notified: false, reason: "already_adopted" }, cost: { time_ms: Date.now() - started } };
  }
  if (proposal.state !== "decided") {
    return { output: { adopted: [], failed: [], retired_gap: null, retired_watches: [], notified: false, reason: `state_is_${proposal.state || "unknown"}` }, cost: { time_ms: Date.now() - started } };
  }

  const decisions = proposal.decisions || {};
  const approved = Object.entries(decisions)
    .filter(([, d]) => d?.decision === "approved")
    .map(([candidateId, d]) => ({ candidateId, decidedAt: d.at }));

  const candidateById = new Map();
  for (const c of proposal.candidates || []) candidateById.set(c.id, c);

  const adopted = [];
  const failed = [];
  const now = Date.now();

  // ── Batch 14: synthesize → trial → adopt on pass ──
  const synthCap = graph.getCapability("agentry.synthesize");
  const trialCap = graph.getCapability("agentry.trial");
  const synthesisAvailable = SYNTHESIS_ENABLED && synthCap && trialCap;

  if (!synthesisAvailable) {
    events.emit("adoption.synthesis_unavailable", {
      proposal_id,
      enabled: SYNTHESIS_ENABLED,
      has_synthesize: !!synthCap,
      has_trial: !!trialCap,
    });
  }

  for (const { candidateId } of approved) {
    const candidate = candidateById.get(candidateId);
    if (!candidate) {
      events.emit("adoption.candidate_missing", { proposal_id, candidate_id: candidateId });
      continue;
    }

    // ── Fallback path: no synthesis available ──
    if (!synthesisAvailable) {
      const node = buildPlaceholderCapability({
        proposal, candidate,
        reason: !SYNTHESIS_ENABLED ? "synthesis_disabled" : "synthesis_capabilities_missing",
      });
      try {
        graph.putCapability(node);
        adopted.push({
          candidate_id: candidateId,
          candidate_url: candidate.url || null,
          capability_id: node.id,
          kind: node.kind,
          placeholder: true,
        });
        events.emit("adoption.capability_added_placeholder", {
          proposal_id, candidate_id: candidateId,
          capability_id: node.id, kind: node.kind, source: node.source,
          reason: node.placeholder_reason,
        });
      } catch (e) {
        events.emit("adoption.capability_add_failed", { proposal_id, candidate_id: candidateId, error: e.message });
        failed.push({ candidate_id: candidateId, capability_id: node.id, phase: "node_write", error: e.message });
      }
      continue;
    }

    // ── Synthesis path ──
    let synthesis = null;
    try {
      const synRes = await ctx.invoke("agentry.synthesize", {
        proposal_id,
        candidate_id: candidateId,
      }, { tenant: "local", by: "agentry.adopt" });

      if (!synRes.ok) {
        const errMsg = synRes.error.message;
        events.emit("adoption.synthesize_failed", {
          proposal_id, candidate_id: candidateId,
          code: synRes.error.code, message: errMsg,
        });
        recordSynthesisAttempt(ctx, { proposal, candidate, phase: "synthesize", error: errMsg });
        failed.push({
          candidate_id: candidateId,
          capability_id: proposal.gap_wanted_id || proposal.gap_id,
          phase: "synthesize",
          error: errMsg,
        });
        continue;
      }

      synthesis = synRes.output;
      events.emit("adoption.synthesize_completed", {
        proposal_id, candidate_id: candidateId,
        capability_id: synthesis.capability_id,
        handler_path: synthesis.handler_path,
      });
    } catch (e) {
      events.emit("adoption.synthesize_threw", { proposal_id, candidate_id: candidateId, error: e.message });
      recordSynthesisAttempt(ctx, { proposal, candidate, phase: "synthesize_threw", error: e.message });
      failed.push({
        candidate_id: candidateId,
        capability_id: proposal.gap_wanted_id || proposal.gap_id,
        phase: "synthesize",
        error: e.message,
      });
      continue;
    }

    // ── Trial ──
    let trial = null;
    try {
      const trialRes = await ctx.invoke("agentry.trial", {
        capability_id: synthesis.capability_id,
        handler_path: synthesis.handler_path,
        seed_path: synthesis.seed_path,
      }, { tenant: "local", by: "agentry.adopt" });

      if (!trialRes.ok || !trialRes.output?.ok) {
        const errMsg = trialRes.error?.message || trialRes.output?.error || "trial failed";
        const phase = trialRes.output?.phase || "trial";
        events.emit("adoption.trial_failed", {
          proposal_id, candidate_id: candidateId,
          capability_id: synthesis.capability_id,
          phase,
          error: errMsg,
        });
        recordSynthesisAttempt(ctx, {
          proposal, candidate, phase: `trial_${phase}`,
          error: errMsg, synthesis,
        });
        failed.push({
          candidate_id: candidateId,
          capability_id: synthesis.capability_id,
          phase: `trial_${phase}`,
          error: errMsg,
          handler_path: synthesis.handler_path,
        });
        continue;
      }

      trial = trialRes.output;
      events.emit("adoption.trial_completed", {
        proposal_id, candidate_id: candidateId,
        capability_id: synthesis.capability_id,
        session: trial.session,
      });
    } catch (e) {
      events.emit("adoption.trial_threw", { proposal_id, candidate_id: candidateId, error: e.message });
      recordSynthesisAttempt(ctx, { proposal, candidate, phase: "trial_threw", error: e.message, synthesis });
      failed.push({
        candidate_id: candidateId,
        capability_id: synthesis.capability_id,
        phase: "trial_threw",
        error: e.message,
        handler_path: synthesis.handler_path,
      });
      continue;
    }

    // ── Pass. Write the real capability node. ──
    const node = {
      id: synthesis.capability_id,
      kind: synthesis.kind,
      invoked_via: "invoker.in_process_js",
      handler: synthesis.capability_id,
      handler_file: synthesis.handler_path,
      accepts: synthesis.spec?.capability?.accepts || null,
      produces: synthesis.spec?.capability?.produces || null,
      requires: synthesis.spec?.capability?.requires || {},
      source: "synthesized:" + (
        candidate.kind === "npm_package" ? "npm" :
        candidate.kind === "mcp_server" ? "mcp" :
        candidate.kind === "repo" ? "github" : "web"
      ) + ":" + candidate.id,
      notes: candidate.url || null,
      trial: false,
      trial_passed_at: Date.now(),
      adopted_from: {
        proposal_id: proposal.id,
        candidate_id: candidate.id,
        candidate_name: candidate.name || null,
        candidate_url: candidate.url || null,
        candidate_kind: candidate.kind || null,
        synthesized_at: now,
        handler_path: synthesis.handler_path,
        seed_path: synthesis.seed_path,
        trial_session: trial.session,
      },
    };

    try {
      graph.putCapability(node);
      adopted.push({
        candidate_id: candidateId,
        candidate_url: candidate.url || null,
        capability_id: node.id,
        kind: node.kind,
        handler_path: synthesis.handler_path,
        trial_session: trial.session,
      });
      events.emit("adoption.capability_added", {
        proposal_id, candidate_id: candidateId,
        capability_id: node.id, kind: node.kind,
        handler_path: synthesis.handler_path,
        source: node.source,
      });
      // v0.16.0 — typed edges for this adoption.
      try {
        if (proposal.gap_id) {
          link(graph, {
            from: node.id,
            to: proposal.gap_id,
            relation: RELATIONS.CAPABILITY_SATISFIES_GAP,
            meta: { via_proposal: proposal.id, candidate_id: candidate.id },
          });
        }
        if (candidate.id) {
          link(graph, {
            from: node.id,
            to: candidate.id,
            relation: RELATIONS.CAPABILITY_SOURCED_FROM,
            meta: { candidate_url: candidate.url || null, candidate_kind: candidate.kind || null },
          });
        }
        link(graph, {
          from: proposal.id,
          to: node.id,
          relation: RELATIONS.PROPOSAL_ADOPTED_CAPABILITY,
          meta: { via_candidate_id: candidate.id },
        });
      } catch (e) {
        events.emit("adoption.edge_write_failed", {
          proposal_id, candidate_id: candidateId, capability_id: node.id, error: e.message,
        });
      }
    } catch (e) {
      events.emit("adoption.capability_add_failed", { proposal_id, candidate_id: candidateId, error: e.message });
      failed.push({
        candidate_id: candidateId,
        capability_id: synthesis.capability_id,
        phase: "node_write",
        error: e.message,
        handler_path: synthesis.handler_path,
      });
    }
  }

  // ── Retire gap only if at least one capability landed ──
  let retiredGap = null;
  if (adopted.length > 0 && proposal.gap_id) {
    const gap = graph.getCapability(proposal.gap_id);
    if (gap && !gap.retired_at) {
      try {
        graph.retireCapability(proposal.gap_id, `adopted via proposal ${proposal_id}`);
        retiredGap = proposal.gap_id;
        events.emit("adoption.gap_retired", { proposal_id, gap_id: proposal.gap_id });
      } catch (e) {
        events.emit("adoption.gap_retire_failed", { proposal_id, gap_id: proposal.gap_id, error: e.message });
      }
    }
  }

  // ── Retire watches: exact gap_id OR prefix "<gap_id>::" ──
  const retiredWatches = [];
  if (proposal.gap_id) {
    const exact = proposal.gap_id;
    const prefix = `${proposal.gap_id}${REASON_SEP}`;
    for (const cap of graph.capabilities().values()) {
      if (cap.kind !== "watch_instance") continue;
      if (cap.retired_at) continue;
      const r = cap.reason;
      const isMatch = r === exact || (typeof r === "string" && r.startsWith(prefix));
      if (!isMatch) continue;
      try {
        graph.retireCapability(cap.id, `proposal ${proposal_id} decided`);
        retiredWatches.push(cap.id);
        events.emit("adoption.watch_retired", { proposal_id, watch_id: cap.id, gap_id: proposal.gap_id });
      } catch (e) {
        events.emit("adoption.watch_retire_failed", { proposal_id, watch_id: cap.id, error: e.message });
      }
    }
  }

  graph.putCapability({
    id: proposal.id,
    kind: "proposal",
    adopted_at: now,
    state: adopted.length > 0 ? "adopted" : "rejected",
    adopted_capability_ids: adopted.map(a => a.capability_id),
    failed_syntheses: failed.map(f => ({
      candidate_id: f.candidate_id,
      capability_id: f.capability_id,
      phase: f.phase,
      error: f.error,
    })),
    retired_gap_id: retiredGap,
    retired_watch_ids: retiredWatches,
  });

  events.emit("proposal.adopted", {
    proposal_id, adopted, failed,
    retired_gap: retiredGap, retired_watches: retiredWatches,
    decision: adopted.length > 0 ? "adopted" : "rejected",
  });

  // ─── Checkpoint on growth ───
  if (adopted.length > 0) {
    try {
      await ctx.invoke("agentry.checkpoint", {
        reason: `adopt:${adopted.length}_capabilities`,
      }, { tenant: "local", by: "agentry.adopt" });
    } catch (e) {
      events.emit("adoption.checkpoint_failed", { proposal_id, error: e.message });
    }
  }

  const body = renderAdoptionEmail({ proposal, adopted, failed, retiredGap, retiredWatches });
  const subject = adopted.length > 0
    ? `[agentry] adopted: ${adopted.map(a => a.capability_id).join(", ")}`
    : (failed.length > 0
        ? `[agentry] synthesis failed: ${proposal.gap_wanted_kind || proposal.id}`
        : `[agentry] rejected: ${proposal.gap_wanted_kind || proposal.id}`);

  let notified = false;
  try {
    const notifyRes = await ctx.invoke("notify.fallback", {
      subject,
      body_markdown: body,
      primary: notifyCap,
      fallback: "notify.console",
    }, { tenant: "local", by: "agentry.adopt" });
    notified = notifyRes.ok === true;
    if (!notified) {
      events.emit("adoption.notify_failed", {
        proposal_id,
        code: notifyRes.error?.code,
        message: notifyRes.error?.message,
      });
    } else {
      events.emit("adoption.notified", {
        proposal_id,
        channel: notifyRes.output.channel,
        primary_ok: notifyRes.output.primary_ok,
        fallback_used: notifyRes.output.fallback_used,
        message_id: notifyRes.output.message_id || null,
      });
    }
  } catch (e) {
    events.emit("adoption.notify_threw", { proposal_id, error: e.message });
  }

  return {
    output: {
      adopted,
      failed,
      retired_gap: retiredGap,
      retired_watches: retiredWatches,
      notified,
      delivered_via: notified ? "notify.fallback" : null,
      reason: adopted.length > 0
        ? "adopted"
        : (failed.length > 0 ? "synthesis_failed" : "rejected"),
    },
    cost: { time_ms: Date.now() - started },
  };
}
