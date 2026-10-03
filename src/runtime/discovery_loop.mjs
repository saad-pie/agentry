// agentry/src/runtime/discovery_loop.mjs
// The discovery loop.
//
// Every N seconds:
//   1. Read the live capability gaps from the graph.
//   2. For each gap without a corresponding watch, create one on a
//      discovery source. Pick the source by gap kind.
//   3. Watch polling is handled by the runtime (watcher.polling + runtime.tick).
//      On new candidates, the watch fires its on_new capability — a notify.
//   4. Loop.
//
// It does NOT adopt capabilities. It reports them. Adoption is a separate,
// human-gated step. This keeps the discovery loop boring and safe while we
// learn what kind of things it finds.

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

// Watch interval for gap-driven watches. 6 hours is a good default —
// often enough to notice new repos, rare enough not to spam you.
const GAP_WATCH_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Dedupe key for GitHub search results.
const GAP_WATCH_DEDUPE_KEY = "full_name";

// Which notify capability to fire on new candidates.
const DEFAULT_NOTIFY = "notify.email.gmail";

// Bound on how many watches we create per tick.
// Prevents a burst of gaps from creating a burst of watches.
const MAX_WATCHES_PER_TICK = 3;

/**
 * One pass of the loop.
 * Returns a summary of what it did. Never throws.
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
  // gaps written by other processes. The MCP server runs as a separate
  // Node process and writes to the same file — without this, the
  // discovery loop's in-memory cache stays stale and reports gaps: 0
  // even after a gap was successfully recorded.
  if (typeof graph.invalidateCache === "function") {
    graph.invalidateCache();
  } else if ("_cache" in graph) {
    graph._cache = null;
  }

  const gaps = liveGaps(graph);
  if (!gaps.length) {
    events.emit("discovery.no_gaps");
    return { gaps: 0, watched: 0 };
  }

  // Which gaps already have a watch? Watch nodes reference their gap via
  // `reason` — we use the format "gap:<id>" as a convention.
  const coveredGapKeys = new Set();
  for (const cap of graph.capabilities().values()) {
    if (cap.kind !== "watch_instance") continue;
    if (typeof cap.reason === "string" && cap.reason.startsWith("gap:")) {
      coveredGapKeys.add(cap.reason.slice(4));
    }
  }

  const uncovered = gaps.filter(g => !coveredGapKeys.has(g.id));
  if (!uncovered.length) {
    events.emit("discovery.all_gaps_covered", { gaps: gaps.length });
    return { gaps: gaps.length, watched: 0 };
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
      // Reason is the link back to the gap. The runtime uses this
      // to know which gaps are already watched.
      reason: `gap:${gap.id}`,
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
    created: created.length,
  });

  return { gaps: gaps.length, uncovered: uncovered.length, created };
}
