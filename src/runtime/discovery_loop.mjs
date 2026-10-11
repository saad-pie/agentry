// agentry/src/runtime/discovery_loop.mjs
//
// The discovery loop. Three passes per tick:
//   1. Un-analyzed watch_results → proposals
//   2. Decided proposals → adopted capabilities
//   3. Gaps → watches (one watch per (gap, source) pair)
//
// Adoption is human-gated: the loop only adopts a proposal whose
// state is "decided" (every candidate has a recorded decision).

import { liveGaps } from "../handlers/agentry.capability_gap.mjs";

// ─── Per-kind source policy. Each gap kind maps to an ARRAY of sources.
// Every source becomes its own watch, so one gap triggers GitHub search
// AND web search in parallel. Both can independently produce candidates
// and proposals.

const SOURCES_BY_KIND = {
  bua: [
    { source: "discovery.github_search", query: () => ({
        q: `"browser automation" OR playwright OR puppeteer OR "browser-use" OR "chrome devtools" stars:>5`,
        sort: "stars", order: "desc",
      }) },
    { source: "discovery.web_search", query: () =>
        `best open source browser automation library 2026 playwright alternatives` },
  ],
  cua: [
    { source: "discovery.github_search", query: () => ({
        q: `"computer use" OR "gui agent" OR "screen agent" OR "desktop automation" stars:>5`,
        sort: "stars", order: "desc",
      }) },
    { source: "discovery.web_search", query: () =>
        `best open source computer use agent 2026 desktop automation` },
  ],
  mua: [
    { source: "discovery.github_search", query: () => ({
        q: `"mobile automation" OR appium OR "android automation" OR "ios automation" stars:>5`,
        sort: "stars", order: "desc",
      }) },
    { source: "discovery.web_search", query: () =>
        `best open source mobile automation framework 2026 android ios` },
  ],
  memory: [
    { source: "discovery.github_search", query: () => ({
        q: `"agent memory" OR "vector database" OR "semantic memory" OR qdrant OR chroma stars:>5`,
        sort: "stars", order: "desc",
      }) },
    { source: "discovery.web_search", query: () =>
        `best open source agent memory layer 2026 vector store` },
  ],
  tool: [
    { source: "discovery.github_search", query: (gap) => ({
        q: `${gap.wanted_id || gap.wanted_kind} stars:>5`,
        sort: "stars", order: "desc",
      }) },
    { source: "discovery.web_search", query: (gap) =>
        `open source ${gap.wanted_id || gap.wanted_kind} tool 2026` },
  ],
};

// Fallback policy: two generic sources based on the gap's wanted id.
function defaultSources(gap) {
  const subject = gap.wanted_id || gap.wanted_kind || "agent capability";
  return [
    { source: "discovery.github_search", query: () => ({
        q: `${subject} stars:>5`,
        sort: "stars", order: "desc",
      }) },
    { source: "discovery.web_search", query: () =>
        `best open source ${subject} 2026` },
  ];
}

// Watch interval for gap-driven watches.
// Default 6h — override with AGENTRY_GAP_WATCH_INTERVAL_MS for testing.
const GAP_WATCH_INTERVAL_MS = Number(
  process.env.AGENTRY_GAP_WATCH_INTERVAL_MS || 6 * 60 * 60 * 1000
);

// Dedupe key: candidate.id is stable for both sources.
//   - github_search emits id = repo.full_name
//   - web_search    emits id = result URL
const GAP_WATCH_DEDUPE_KEY = "id";

const DEFAULT_NOTIFY = "notify.email.gmail";

// Bound on watches created per tick. Since one gap now spawns multiple
// watches, this is the total across all gaps on a single tick.
const MAX_WATCHES_PER_TICK = 6;

// Composite reason separator. `<gap.id>::<source>`.
const REASON_SEP = "::";

function compositeReason(gapId, sourceId) {
  return `${gapId}${REASON_SEP}${sourceId}`;
}

/**
 * One pass of the loop. Never throws.
 *
 * Return shape:
 *   { gaps, uncovered, watched, created, proposals, adopted }
 */
export async function tick(deps, opts = {}) {
  const { graph, events } = deps;
  const {
    intervalMs = GAP_WATCH_INTERVAL_MS,
    dedupeKey = GAP_WATCH_DEDUPE_KEY,
    notify = DEFAULT_NOTIFY,
    maxPerTick = MAX_WATCHES_PER_TICK,
  } = opts;

  // Cross-process: re-read capabilities.jsonl so we see nodes written
  // by the MCP server / approval server / other processes.
  if (typeof graph.invalidateCache === "function") {
    graph.invalidateCache();
  } else if ("_cache" in graph) {
    graph._cache = null;
  }

  // ─────────────────────────────────────────────────────────────
  // Pass 1: un-analyzed watch_results → proposals
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
          source: node.source || null,
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
  // Pass 3: gaps → watches
  // ─────────────────────────────────────────────────────────────

  // Count live watches from the graph (cross-process truth).
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

  // Which (gap, source) pairs already have a watch?
  // reason is `<gap.id>::<source>`. Match by equality on the composite.
  const coveredWatchKeys = new Set();
  for (const cap of graph.capabilities().values()) {
    if (cap.kind !== "watch_instance") continue;
    if (typeof cap.reason === "string" && cap.reason.length > 0) {
      coveredWatchKeys.add(cap.reason);
    }
  }

  // A gap is "uncovered" if at least one of its source pairs has no watch.
  let uncoveredCount = 0;
  const created = [];
  let createdThisTick = 0;

  for (const gap of gaps) {
    const sources = SOURCES_BY_KIND[gap.wanted_kind] || defaultSources(gap);
    let gapHasAnyUncovered = false;

    for (const policy of sources) {
      const key = compositeReason(gap.id, policy.source);
      if (!coveredWatchKeys.has(key)) {
        gapHasAnyUncovered = true;
        break;
      }
    }
    if (gapHasAnyUncovered) uncoveredCount++;

    for (const policy of sources) {
      if (createdThisTick >= maxPerTick) break;

      const watchKey = compositeReason(gap.id, policy.source);
      if (coveredWatchKeys.has(watchKey)) continue;

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
        reason: watchKey,
      };

      try {
        const res = await deps.invoke("watcher.polling", spec, {
          tenant: "local",
          by: "discovery_loop",
        });
        if (res.ok) {
          createdThisTick++;
          coveredWatchKeys.add(watchKey);
          created.push({
            gap_id: gap.id,
            watch_id: res.output.watch_id,
            source: policy.source,
          });
          events.emit("discovery.watch_created", {
            gap_id: gap.id,
            wanted_kind: gap.wanted_kind,
            watch_id: res.output.watch_id,
            source: policy.source,
          });
        } else {
          events.emit("discovery.watch_failed", {
            gap_id: gap.id,
            source: policy.source,
            code: res.error.code,
            message: res.error.message,
          });
        }
      } catch (e) {
        events.emit("discovery.watch_threw", {
          gap_id: gap.id,
          source: policy.source,
          error: e.message,
        });
      }
    }
  }

  events.emit("discovery.tick_summary", {
    gaps: gaps.length,
    uncovered: uncoveredCount,
    watched: watchedCount,
    created: created.length,
    proposals: proposalsCreated,
    adopted,
  });

  return {
    gaps: gaps.length,
    uncovered: uncoveredCount,
    watched: watchedCount,
    created,
    proposals: proposalsCreated,
    adopted,
  };
}
