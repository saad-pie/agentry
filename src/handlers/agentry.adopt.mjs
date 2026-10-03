// agentry/src/handlers/agentry.adopt.mjs
//
// Grows the graph. This is the handler that makes the pitch real.
//
// Contract:
//   input:  { proposal_id }
//   output: { adopted, retired_gap, retired_watches, notified, reason }
//
// When a proposal reaches state === "decided" (every candidate has
// a recorded approve/reject decision), the discovery loop invokes
// this handler. It:
//
//   1. Reads the proposal node.
//   2. Finds every candidate whose decision is "approved".
//   3. Writes each approved candidate as a LIVE capability node,
//      using the gap's wanted_id as the capability id and the gap's
//      wanted_kind as the capability kind.
//   4. Retires the gap node (the need has been filled).
//   5. Retires every watch whose `reason` is that gap's id.
//   6. Stamps the proposal with adopted_at.
//   7. Sends a follow-up email.
//
// It is idempotent: a proposal with adopted_at set is a no-op.

const DEFAULT_NOTIFY = "notify.email.gmail";

function buildAdoptedCapability({ proposal, candidate }) {
  const capId = proposal.gap_wanted_id || proposal.gap_id;
  const capKind = proposal.gap_wanted_kind || "unknown";
  const now = Date.now();

  // An adopted capability is a live node, but it has no handler yet.
  // `invoked_via: null` is honest: the graph knows the capability
  // exists, but invoking it fails cleanly with "no handler registered"
  // — which is exactly the truth we want to tell the harness.
  //
  // The `notes` field carries the source URL so a human (or a later
  // handler) can find what was adopted and wire it up.
  return {
    id: capId,
    kind: capKind,
    invoked_via: null,
    accepts: null,
    produces: null,
    source: `adopted:github:${candidate.name || candidate.id}`,
    notes: candidate.url || null,
    adopted_from: {
      proposal_id: proposal.id,
      candidate_id: candidate.id,
      candidate_name: candidate.name || null,
      candidate_url: candidate.url || null,
      adopted_at: now,
    },
  };
}

function renderAdoptionEmail({ proposal, adopted, retiredGap, retiredWatches }) {
  const lines = [];
  if (adopted.length) {
    lines.push(`Capability added: ${adopted.map(a => `\`${a.capability_id}\``).join(", ")}`);
    lines.push("");
    lines.push(`Kind: ${proposal.gap_wanted_kind || "unknown"}`);
    lines.push(`Gap filled: ${proposal.gap_id || "—"}`);
    lines.push("");
    lines.push("─── Sources ───");
    lines.push("");
    for (const a of adopted) {
      lines.push(`• ${a.candidate_id}`);
      if (a.candidate_url) lines.push(`  url: ${a.candidate_url}`);
    }
    lines.push("");
    lines.push(`Retired gap: \`${retiredGap || "none"}\``);
    lines.push(`Retired watches: ${retiredWatches.length ? retiredWatches.map(w => `\`${w}\``).join(", ") : "none"}`);
    lines.push("");
    lines.push("The capability exists in the graph but has no handler yet. Invoking it will fail with `invalid_spec: no handler registered`. Wire it up when you're ready.");
  } else {
    lines.push(`Proposal rejected — nothing adopted.`);
    lines.push("");
    lines.push(`Proposal: \`${proposal.id}\``);
    lines.push(`Gap: \`${proposal.gap_id || "—"}\``);
    lines.push(`Wanted kind: ${proposal.gap_wanted_kind || "unknown"}`);
    lines.push("");
    lines.push("The gap remains open. Discovery will propose again if a new candidate appears. Watches for this gap have been retired to prevent repeat emails.");
  }
  return lines.join("\n");
}

export default async function agentryAdopt(input, ctx) {
  const { proposal_id } = input || {};
  if (!proposal_id) throw new Error("agentry.adopt requires proposal_id");

  if (typeof ctx.invoke !== "function") {
    throw new Error("agentry.adopt requires ctx.invoke — was it invoked through the runtime?");
  }

  const started = Date.now();
  const graph = ctx.graph;
  const events = ctx.events;
  const notifyCap = input.notify || DEFAULT_NOTIFY;

  // 1. Load the proposal.
  const proposal = graph.getCapability(proposal_id);
  if (!proposal) {
    throw new Error(`agentry.adopt: proposal not found: ${proposal_id}`);
  }
  if (proposal.kind !== "proposal") {
    throw new Error(`agentry.adopt: ${proposal_id} is kind "${proposal.kind}", not "proposal"`);
  }

  // 2. Idempotence — already adopted.
  if (proposal.adopted_at) {
    return {
      output: {
        adopted: [],
        retired_gap: null,
        retired_watches: [],
        notified: false,
        reason: "already_adopted",
      },
      cost: { time_ms: Date.now() - started },
    };
  }

  // 3. Only adopt proposals whose state is "decided".
  if (proposal.state !== "decided") {
    return {
      output: {
        adopted: [],
        retired_gap: null,
        retired_watches: [],
        notified: false,
        reason: `state_is_${proposal.state || "unknown"}`,
      },
      cost: { time_ms: Date.now() - started },
    };
  }

  // 4. Find approved candidates.
  const decisions = proposal.decisions || {};
  const approved = Object.entries(decisions)
    .filter(([, d]) => d?.decision === "approved")
    .map(([candidateId, d]) => ({ candidateId, decidedAt: d.at }));

  // 5. Find the raw candidate objects for each approved id.
  //    `proposal.candidates` was written at proposal time and holds
  //    {id, name, url, stars, language, license}.
  const candidateById = new Map();
  for (const c of proposal.candidates || []) candidateById.set(c.id, c);

  const adopted = [];
  const now = Date.now();

  for (const { candidateId } of approved) {
    const candidate = candidateById.get(candidateId);
    if (!candidate) {
      events.emit("adoption.candidate_missing", {
        proposal_id,
        candidate_id: candidateId,
      });
      continue;
    }

    const node = buildAdoptedCapability({ proposal, candidate });
    try {
      graph.putCapability(node);
      adopted.push({
        candidate_id: candidateId,
        candidate_url: candidate.url || null,
        capability_id: node.id,
        kind: node.kind,
      });
      events.emit("adoption.capability_added", {
        proposal_id,
        candidate_id: candidateId,
        capability_id: node.id,
        kind: node.kind,
        source: node.source,
      });
    } catch (e) {
      events.emit("adoption.capability_add_failed", {
        proposal_id,
        candidate_id: candidateId,
        error: e.message,
      });
    }
  }

  // 6. Retire the gap if we adopted at least one capability for it.
  let retiredGap = null;
  if (adopted.length > 0 && proposal.gap_id) {
    const gap = graph.getCapability(proposal.gap_id);
    if (gap && !gap.retired_at) {
      try {
        graph.retireCapability(proposal.gap_id, `adopted via proposal ${proposal_id}`);
        retiredGap = proposal.gap_id;
        events.emit("adoption.gap_retired", {
          proposal_id,
          gap_id: proposal.gap_id,
        });
      } catch (e) {
        events.emit("adoption.gap_retire_failed", {
          proposal_id,
          gap_id: proposal.gap_id,
          error: e.message,
        });
      }
    }
  }

  // 7. Retire every watch whose reason is the gap id — regardless of
  //    whether we adopted (a fully-rejected proposal should also stop
  //    the watch from re-proposing the same candidates forever).
  const retiredWatches = [];
  if (proposal.gap_id) {
    for (const cap of graph.capabilities().values()) {
      if (cap.kind !== "watch_instance") continue;
      if (cap.retired_at) continue;
      if (cap.reason !== proposal.gap_id) continue;
      try {
        graph.retireCapability(cap.id, `proposal ${proposal_id} decided`);
        retiredWatches.push(cap.id);
        events.emit("adoption.watch_retired", {
          proposal_id,
          watch_id: cap.id,
          gap_id: proposal.gap_id,
        });
      } catch (e) {
        events.emit("adoption.watch_retire_failed", {
          proposal_id,
          watch_id: cap.id,
          error: e.message,
        });
      }
    }
  }

  // 8. Stamp the proposal.
  graph.putCapability({
    id: proposal.id,
    kind: "proposal",
    adopted_at: now,
    state: adopted.length > 0 ? "adopted" : "rejected",
    adopted_capability_ids: adopted.map(a => a.capability_id),
    retired_gap_id: retiredGap,
    retired_watch_ids: retiredWatches,
  });

  events.emit("proposal.adopted", {
    proposal_id,
    adopted,
    retired_gap: retiredGap,
    retired_watches: retiredWatches,
    decision: adopted.length > 0 ? "adopted" : "rejected",
  });

  // 9. Notify.
  const body = renderAdoptionEmail({
    proposal,
    adopted,
    retiredGap,
    retiredWatches,
  });
  const subject = adopted.length > 0
    ? `[agentry] adopted: ${adopted.map(a => a.capability_id).join(", ")}`
    : `[agentry] rejected: ${proposal.gap_wanted_kind || proposal.id}`;

  let notified = false;
  try {
    const notifyRes = await ctx.invoke(notifyCap, {
      subject,
      body_markdown: body,
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
        channel: notifyCap,
        message_id: notifyRes.output?.message_id || null,
      });
    }
  } catch (e) {
    events.emit("adoption.notify_threw", {
      proposal_id,
      error: e.message,
    });
  }

  return {
    output: {
      adopted,
      retired_gap: retiredGap,
      retired_watches: retiredWatches,
      notified,
      reason: adopted.length > 0 ? "adopted" : "rejected",
    },
    cost: { time_ms: Date.now() - started },
  };
}
