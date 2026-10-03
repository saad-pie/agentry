// agentry/src/runtime/discovery_loop.mjs
// The discovery loop.
//
// Every N seconds:
//   1. Turn un-analyzed watch_results into proposals. (v0.11.0)
//   2. Turn decided proposals into adopted capabilities. (v0.11.0)
//   3. Read the live capability gaps from the graph.
//   4. For each gap without a corresponding watch, create one on a
//      discovery source. Pick the source by gap kind.
//   5. Watch polling is handled by the runtime (watcher.polling + runtime.tick).
//      On new candidates, the watch fires its on_new capability — a notify,
//      AND writes a watch_result node for pass 1 to pick up next tick.
//   6. Loop.
//
// Adoption is human-gated: the loop only adopts a proposal whose state
// is "decided" (every candidate has a recorded approve/reject decision).

import { liveGaps } from "../handlers/agentry.capability_gap.mjs";

// Which discovery source to use for which gap kind.
// This is policy, not mechanism. When we have more sources, add rows.
// A gap without a matching row simply doesn't get a watch — the loop
// records that and moves on.
const SOURCE_BY_KIND = {
  bua:  { source: "discovery.github_search", query: (gap) => ({
    q: `${gap.wanted_kind} browser automation language:typescript`,
    sort: "stars", order: "desc",
  }) },
  cua:  { source: "discovery.github_search", query: (gap) => ({
    q: `${gap.wanted_kind} computer use agent language:python`,
    sort: "stars", order: "desc",
  }) },
  mua:  { source: "discovery.github_search", query: (gap) => ({
    q: `${gap.wanted_kind} mobile automation language:typescript`,
    sort: "stars", order: "desc",
  }) },
  memory: { source: "discovery.github_search", query: (gap) => ({
    q: `${gap.wanted_kind} vector database memory language:python`,
    sort: "stars", order: "desc",
  }) },
  tool: { source: "discovery.github_search", query: (gap) => ({
    q: `${gap.wanted_kind} cli tool language:typescript`,
    sort: "stars", order: "desc",
  }) },
};

// Default: if a gap has a wanted_kind we don't have a policy for,
// fall back to a general GitHub search on the wanted id.
function defaultPolicy(gap) {
  return {
    source: "discovery.github_search",
    query: () => ({
      q: gap.wanted_id || gap.wanted_kind || "agent capability",
      sort: "stars", order: "desc",
    }),
  };
}

// Watch interval for gap-driven watches.
//
// Default is 6 hours: often enough to notice new repos, rare enough not
// to spam you. Override with AGENTRY_GAP_WATCH_INTERVAL_MS for testing.
const GAP_WATCH_INTERVAL_MS = Number(
  process.env.AGENTRY_GAP_WATCH_INTERVAL_MS || 6 * 60 * 60 * 1000
);

// Dedupe key for GitHub search results.
//
// discovery.github_search emits `id` (= repo.full_name) on every candidate.
// Use that — it's stable and present. `full_name` is NOT a field on the
// emitted candidate, so using it silently dropped every result.
const GAP_WATCH_DEDUPE_KEY = "id";

// Which notify capability to fire on new candidates.
const DEFAULT_NOTIFY = "notify.email.gmail";

// Bound on how many watches we create per tick.
// Prevents a burst of gaps from creating a burst of watches.
const MAX_WATCHES_PER_TICK = 3;

/**
 * One pass of the loop.
 * Returns a summary of what it did. Never throws.
 *
 * Return shape is always:
 *   { gaps, uncovered, watched, created, proposals, adopted }
 * where:
 *   gaps      — total live gap nodes
 *   uncovered — gaps with no watch yet
 *   watched   — live watch_instance nodes in the graph (cross-process truth)
 *   created   — watches created on THIS tick (array of {gap_id, watch_id, source})
 *   proposals — proposals created on THIS tick
 *   adopted   — capabilities adopted on THIS tick
 */
export async function tick(deps, opts = {}) {
  const { graph, events } = deps;
  const {
    intervalMs = GAP_WATCH_INTERVAL_MS,
    dedupeKey = GAP_WATCH_DEDUPE_KEY,
    notify = DEFAULT_NOTIFY,
    maxPerTick = MAX_WATCHES_PER_TICK,
  } = opts;

  // Force the graph to re-read capabilities.jsonl from disk so we see
  // nodes written by other processes (the MCP server, the approval
  // server). Without this, the discovery loop's in-memory cache stays
  // stale and reports gaps: 0 even after a gap was successfully recorded.
  if (typeof graph.invalidateCache === "function") {
    graph.invalidateCache();
  } else if ("_cache" in graph) {
    graph._cache = null;
  }

  // ─────────────────────────────────────────────────────────────
  // Pass 1: un-analyzed watch_results → proposals
  //
  // pollWatch writes a `watch_result` node when a poll yields fresh
  // candidates. This pass turns each one into a proposal (LLM analysis
  // + email with approve/reject URLs) exactly once. On success the
  // node is stamped with `analyzed_at` so we don't repropose.
  // ─────────────────────────────────────────────────────────────
  let proposalsCreated = 0;
  for (const node of graph.capabilities().values()) {
    if (node.kind !== "watch_result") continue;
    if (node.analyzed_at || node.retired_at) continue;

    const gap = node.gap_id ? graph.getCapability(node.gap_id) : null;
    if (!gap) {
      events.emit("discovery.watch_result_no_gap", {
        watch_result_id: node.id,
        gap_id: node.gap_id,
      });
      // Stamp it so we don't retry forever on an orphan.
      graph.putCapability({
        id: node.id,
        kind: "watch_result",
        analyzed_at: Date.now(),
        analysis_skipped_reason: "gap_not_found",
      });
      continue;
    }

    try {
      const res = await deps.invoke("agentry.proposal", {
        gap,
        candidates: node.candidates || [],
        notify,
      }, { tenant: "local", by: "discovery_loop" });

      if (res.ok) {
        proposalsCreated++;
        events.emit("discovery.proposal_created", {
          watch_result_id: node.id,
          gap_id: gap.id,
          proposal_id: res.output.proposal_id,
        });
        graph.putCapability({
          id: node.id,
          kind: "watch_result",
          analyzed_at: Date.now(),
          proposal_id: res.output.proposal_id,
        });
      } else {
        events.emit("discovery.proposal_failed", {
          watch_result_id: node.id,
          code: res.error.code,
          message: res.error.message,
        });
      }
    } catch (e) {
      events.emit("discovery.proposal_threw", {
        watch_result_id: node.id,
        error: e.message,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Pass 2: decided proposals → adoption
  //
  // A proposal becomes "decided" when every candidate has an
  // approve/reject decision recorded by the approval HTTP handler.
  // This pass reads those decisions and grows the graph: each
  // approved candidate becomes a live capability node; the gap and
  // its watches are retired.
  // ─────────────────────────────────────────────────────────────
  let adopted = 0;
  for (const node of graph.capabilities().values()) {
    if (node.kind !== "proposal") continue;
    if (node.state !== "decided") continue;
    if (node.adopted_at) continue;

    try {
      const res = await deps.invoke("agentry.adopt", {
        proposal_id: node.id,
      }, { tenant: "local", by: "discovery_loop" });

      if (res.ok) {
        adopted += (res.output.adopted || []).length;
        events.emit("discovery.adoption_completed", {
          proposal_id: node.id,
          adopted: res.output.adopted,
        });
      } else {
        events.emit("discovery.adoption_failed", {
          proposal_id: node.id,
          code: res.error.code,
          message: res.error.message,
        });
      }
    } catch (e) {
      events.emit("discovery.adoption_threw", {
        proposal_id: node.id,
        error: e.message,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Pass 3: gaps → watches (the original loop)
  // ─────────────────────────────────────────────────────────────

  // Count live watches from the graph — the only cross-process source
  // of truth. Do this before the early returns so every path can report
  // an honest number. This is what makes the log line truthful.
  let watchedCount = 0;
  for (const cap of graph.capabilities().values()) {
    if (cap.kind === "watch_instance" && !cap.retired_at) watchedCount++;
  }

  const gaps = liveGaps(graph);
  if (!gaps.length) {
    events.emit("discovery.no_gaps");
    return {
      gaps: 0, uncovered: 0, watched: watchedCount, created: [],
      proposals: proposalsCreated, adopted,
    };
  }

  // Which gaps already have a watch?
  //
  // The convention: a watch's `reason` is exactly the gap's id (which
  // itself is the string "gap:<wanted_id>"). We match by equality, not
  // by prefix arithmetic — the previous "slice(4)" approach was fragile
  // and produced "gap:gap:bua.browser" in the wild.
  const coveredGapIds = new Set();
  for (const cap of graph.capabilities().values()) {
    if (cap.kind !== "watch_instance") continue;
    if (typeof cap.reason === "string" && cap.reason.length > 0) {
      coveredGapIds.add(cap.reason);
    }
  }

  const uncovered = gaps.filter(g => !coveredGapIds.has(g.id));
  if (!uncovered.length) {
    events.emit("discovery.all_gaps_covered", { gaps: gaps.length });
    return {
      gaps: gaps.length, uncovered: 0, watched: watchedCount, created: [],
      proposals: proposalsCreated, adopted,
    };
  }

  const batch = uncovered.slice(0, maxPerTick);
  const created = [];

  for (const gap of batch) {
    const policy = SOURCE_BY_KIND[gap.wanted_kind] || defaultPolicy(gap);

    // Sanity: the discovery source and notify target must exist.
    if (!graph.getCapability(policy.source)) {
      events.emit("discovery.source_missing", {
        gap_id: gap.id,
        wanted_source: policy.source,
      });
      continue;
    }
    if (!graph.getCapability(notify)) {
      events.emit("discovery.notify_missing", {
        gap_id: gap.id,
        wanted_notify: notify,
      });
      continue;
    }

    const query = typeof policy.query === "function" ? policy.query(gap) : policy.query;

    const spec = {
      source: policy.source,
      query,
      interval_ms: intervalMs,
      dedupe_key: dedupeKey,
      on_new: notify,
      // `gap.id` already has the "gap:" prefix. Set reason to the gap's
      // full id so coveredGapIds can match by equality. Do NOT add
      // another "gap:" here — that's how "gap:gap:bua.browser" happened.
      reason: gap.id,
    };

    try {
      const res = await deps.invoke("watcher.polling", spec, {
        tenant: "local",
        by: "discovery_loop",
      });
      if (res.ok) {
        created.push({ gap_id: gap.id, watch_id: res.output.watch_id, source: policy.source });
        events.emit("discovery.watch_created", {
          gap_id: gap.id,
          wanted_kind: gap.wanted_kind,
          watch_id: res.output.watch_id,
          source: policy.source,
        });
      } else {
        events.emit("discovery.watch_failed", {
          gap_id: gap.id,
          code: res.error.code,
          message: res.error.message,
        });
      }
    } catch (e) {
      events.emit("discovery.watch_threw", {
        gap_id: gap.id,
        error: e.message,
      });
    }
  }

  events.emit("discovery.tick_summary", {
    gaps: gaps.length,
    uncovered: uncovered.length,
    watched: watchedCount,
    created: created.length,
    proposals: proposalsCreated,
    adopted,
  });

  return {
    gaps: gaps.length,
    uncovered: uncovered.length,
    watched: watchedCount,
    created,
    proposals: proposalsCreated,
    adopted,
  };
}
