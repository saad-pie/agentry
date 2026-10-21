// agentry/src/runtime/discovery_loop.mjs
//
// The discovery loop. Three passes per tick:
//   1. Un-analyzed watch_results → proposals
//   2. Decided proposals → adopted capabilities
//   3. Gaps → watches (one watch per (gap, source) pair)
//
// Adoption is human-gated by default: the loop only adopts a proposal
// whose state is "decided" (every candidate has a recorded decision).
// Proposals can reach that state two ways: a human clicking approve
// in the email, or (v0.15.23+) auto-approval by kind whitelist.
//
// v0.15.15:
//   - Pass 1 skips watch_results whose gap already has an open
//     proposal (pending or in_review). Fix for the "N emails per gap"
//     flood — without it, every fresh candidate batch from every watch
//     generates a new proposal for the same gap.
//   - bua/cua/mua/memory dropped web_search from SOURCES_BY_KIND. Those
//     queries return blog posts, the LLM correctly rejects them, and
//     the source was pure noise.
//
// v0.15.22:
//   - The "already has an open proposal" predicate was widened from
//     (pending || in_review) to (!adopted_at && !retired_at). This
//     covers proposals in state "decided" that haven't been picked up
//     by Pass 2 yet. Required for v0.15.23 auto-adoption, but harmless
//     on its own.

import { liveGaps } from "../handlers/agentry.capability_gap.mjs";

// ─── Per-kind source policy. Each gap kind maps to an ARRAY of sources.
// Every source becomes its own watch, so one gap triggers GitHub search
// AND (for some kinds) web search in parallel.

const SOURCES_BY_KIND = {
  bua: [
    { source: "discovery.github_search", query: () => ({
        q: `"browser automation" OR playwright OR puppeteer OR "browser-use" OR "chrome devtools" stars:>5`,
        sort: "stars", order: "desc",
      }) },
  ],
  cua: [
    { source: "discovery.github_search", query: () => ({
        q: `"computer use" OR "gui agent" OR "screen agent" OR "desktop automation" stars:>5`,
        sort: "stars", order: "desc",
      }) },
  ],
  mua: [
    { source: "discovery.github_search", query: () => ({
        q: `"mobile automation" OR appium OR "android automation" OR "ios automation" stars:>5`,
        sort: "stars", order: "desc",
      }) },
  ],
  memory: [
    { source: "discovery.github_search", query: () => ({
        q: `"agent memory" OR "vector database" OR "semantic memory" OR qdrant OR chroma stars:>5`,
        sort: "stars", order: "desc",
      }) },
  ],
  tool: [
    {
      source: "discovery.github_search",
      query: (gap) => ({ q: gapSearchSubject(gap), sort: "stars", order: "desc" }),
    },
    {
      source: "discovery.web_search",
      query: (gap) => ({ query: gapSearchSubject(gap) }),
    },
  ],
};

// Fallback policy: two generic sources based on the gap's wanted id.
// v0.23.4 — a search-friendly subject for a gap.
// Prefers the reasoner-provided wanted_description (short natural-language
// phrase designed for search). Falls back to the reason field (strip the
// "deep reasoning:" prefix, take first sentence, truncate). Last resort:
// wanted_id with separators replaced by spaces.
//
// Prior versions used gap.wanted_id directly as the query, which searched
// GitHub for strings like "pdf.render_image stars:>5" — a variable name
// that matches nothing, so results were irrelevant (list pages,
// wrong-direction tools). This was the DSH agent's run on 2026-10-17: it
// recorded a clear failure description, but discovery searched for the id
// and got 10 useless candidates.
function gapSearchSubject(gap) {
  const desc = gap.wanted_description;
  if (desc && String(desc).trim().length >= 4) {
    return String(desc).trim().replace(/\s+/g, " ").slice(0, 120);
  }
  let reason = String(gap.reason || "");
  reason = reason.replace(/^(?:(?:deep|harness|fast)\s+)?reasoning:\s*/i, "").trim();
  const becauseIdx = reason.toLowerCase().indexOf(" because ");
  if (becauseIdx > 20) reason = reason.slice(0, becauseIdx);
  if (reason.length >= 12) {
    return reason.slice(0, 150).replace(/\s+/g, " ").trim();
  }
  const id = String(gap.wanted_id || gap.wanted_kind || "agent capability");
  return id.replace(/^[a-z]+:/i, "").replace(/[._:]/g, " ").trim() || "agent capability";
}


function defaultSources(gap) {
  // v0.51.0 — was "agentry.discover" which returns {results:{...}} shape
  // that watcher.polling doesn't read (it expects {candidates:[...]}).
  // Switched to github_search + web_search matching bua/cua/mua pattern.
  return [
    {
      source: "discovery.github_search",
      query: (gap) => ({ q: gapSearchSubject(gap), sort: "stars", order: "desc" }),
    },
    {
      source: "discovery.web_search",
      query: (gap) => ({ query: gapSearchSubject(gap) }),
    },
  ];
}

// Watch interval for gap-driven watches.
// Default 6h — override with AGENTRY_GAP_WATCH_INTERVAL_MS for testing.
// v0.51.0 — default 5 min, was 6h. 6h made the pipeline invisible: gaps
// sat for hours before any watch fired. 5 min is a compromise between
// responsiveness and GitHub search rate limits.
const GAP_WATCH_INTERVAL_MS = Number(
  process.env.AGENTRY_GAP_WATCH_INTERVAL_MS || 5 * 60 * 1000
);

// Dedupe key: candidate.id is stable for both sources.
//   - github_search emits id = repo.full_name
//   - web_search    emits id = result URL
const GAP_WATCH_DEDUPE_KEY = "id";

const DEFAULT_NOTIFY = "notify.email.gmail";

// Bound on watches created per tick.
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

  // v0.51.0 — retire obsolete gap-watches sourced from "agentry.discover".
  // Those return {results:{...}} not {candidates:[...]}, so watcher.polling
  // never saw candidates. Pass 3 recreates them with discovery.github_search
  // and discovery.web_search, matching bua/cua/mua.
  for (const cap of graph.capabilities().values()) {
    if (cap.kind !== "watch_instance") continue;
    if (cap.retired_at) continue;
    if (cap.source === "agentry.discover" && String(cap.reason || "").startsWith("gap:")) {
      try {
        graph.retireCapability(cap.id, "v0.51.0: obsolete source, recreated with github_search+web_search");
        events.emit("discovery.obsolete_watch_retired", { watch_id: cap.id, source: cap.source });
      } catch {}
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Pass 1: un-analyzed watch_results → proposals
  // ─────────────────────────────────────────────────────────────

  // v0.15.22 — which gaps already have an open proposal? Skip their
  // watch_results entirely. "Open" = no adopted_at and no retired_at,
  // i.e. the proposal is still on its way through the pipeline.
  const gapsWithOpenProposal = new Set();
  for (const cap of graph.capabilities().values()) {
    if (cap.kind !== "proposal") continue;
    if (cap.adopted_at) continue;
    if (cap.retired_at) continue;
    if (cap.gap_id) gapsWithOpenProposal.add(cap.gap_id);
  }

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

    // Skip: gap already has an open proposal. Mark as analyzed so we
    // don't re-check on every tick, but don't propose.
    if (gapsWithOpenProposal.has(gap.id)) {
      events.emit("discovery.watch_result_skipped", {
        watch_result_id: node.id,
        gap_id: gap.id,
        reason: "gap_already_has_open_proposal",
      });
      graph.putCapability({
        id: node.id,
        kind: "watch_result",
        analyzed_at: Date.now(),
        analysis_skipped_reason: "gap_already_has_open_proposal",
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
        // If the proposal was deduped (existing one found), don't count
        // it as new and don't add the gap to the set again.
        if (res.output.deduped) {
          events.emit("discovery.proposal_deduped", {
            watch_result_id: node.id,
            gap_id: gap.id,
            existing_proposal_id: res.output.proposal_id,
          });
          graph.putCapability({
            id: node.id,
            kind: "watch_result",
            analyzed_at: Date.now(),
            analysis_skipped_reason: "proposal_deduped",
            proposal_id: res.output.proposal_id,
          });
          continue;
        }

        proposalsCreated++;
        gapsWithOpenProposal.add(gap.id); // new proposal is now the open one
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
    // v0.21.0 — prevent double-adopt when ticks overlap.
    if (node.adoption_in_progress_at && (Date.now() - node.adoption_in_progress_at) < 300000) continue;
    try { graph.putCapability({ id: node.id, adoption_in_progress_at: Date.now() }); } catch (e) {}

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
    // v0.23.4 — auto-reject stale pending proposals with no recommendation.
    // A proposal stuck in "pending" with recommended_id === null blocks
    // every future proposal for this gap (hasProposal check + the watcher's
    // "gap_already_has_open_proposal" skip). After 10 minutes, mark it
    // rejected so the next tick can retry with fresh candidates.
    //
    // This was the DSH agent's run: proposal_mvc9b21g_hjhkh8 sat pending
    // for hours because the reasoner rated all 10 candidates at fit 0.1
    // (all wrong-direction). Nothing was adoptable, but nothing was
    // rejected either — the gap was stuck.
    const STALE_PENDING_MS = 600000; // 10 min
    const _now = Date.now();
    for (const _c of graph.capabilities().values()) {
      if (_c.kind !== "proposal") continue;
      if (_c.gap_id !== gap.id) continue;
      if (_c.adopted_at || _c.retired_at) continue;
      if (_c.state !== "pending") continue;
      if (_c.recommended_id) continue;
      const _age = _now - (_c.created_at || 0);
      if (_age < STALE_PENDING_MS) continue;
      try {
        graph.putCapability({
          id: _c.id,
          kind: "proposal",
          state: "rejected",
          rejected_reason: "stale: no recommended candidate after " + Math.round(_age / 60000) + "m",
          adopted_at: _now,
        });
        events.emit("discovery.stale_proposal_rejected", {
          proposal_id: _c.id,
          gap_id: gap.id,
          age_min: Math.round(_age / 60000),
        });
      } catch (e) {
        events.emit("discovery.stale_proposal_reject_failed", {
          proposal_id: _c.id, gap_id: gap.id, error: e.message,
        });
      }
    }

    // v0.17.4 — reasoner-discovered candidates. If the gap's wanted_id
    // is prefixed with "npm:" or "mcp:", the reasoner picked it from
    // agentry.discover results. Do NOT create watches (there is nothing
    // to search for) — build a decided proposal directly.
    const wantedId = String(gap.wanted_id || "");
    const isNpm = wantedId.startsWith("npm:");
    const isMcp = wantedId.startsWith("mcp:");
    const isClawhub = wantedId.startsWith("clawhub:");
    const isAgentskills = wantedId.startsWith("agentskills:");
    const isHermesAtlas = wantedId.startsWith("hermes_atlas:");
    const isSkillCandidate = isClawhub || isAgentskills || isHermesAtlas;

    if (isNpm || isMcp || isSkillCandidate) {
      const hasProposal = [...graph.capabilities().values()].some(c =>
        c.kind === "proposal" &&
        !c.adopted_at &&
        !c.retired_at &&
        c.gap_id === gap.id
      );
      if (!hasProposal) {
        let candidate;
        if (isNpm || isMcp) {
          const pkgName = wantedId.slice(4);
          candidate = {
            id: wantedId,
            kind: isNpm ? "npm_package" : "mcp_server",
            name: pkgName,
            url: isNpm ? "https://www.npmjs.com/package/" + pkgName : null,
            description: "Reasoner-chosen from agentry.discover results.",
          };
        } else {
          // Skill candidate — extract the raw id and figure out a URL.
          // v0.19.1: source is set to match the adapter name so
          // readAgentSkill() can branch correctly.
          let rawId = wantedId;
          let url = null;
          let kind = "agent_skill";
          let src = null;
          if (isClawhub) {
            rawId = wantedId.slice("clawhub:".length);
            const parts = rawId.split("/").filter(Boolean);
            url = parts.length >= 2
              ? ("https://clawhub.ai/" + parts[0] + "/skills/" + parts[parts.length - 1])
              : null;
            src = "clawhub";
          } else if (isAgentskills) {
            rawId = wantedId.slice("agentskills:".length);
            const idx = rawId.indexOf(":");
            if (idx > 0) {
              const repo = rawId.slice(0, idx);
              const path = rawId.slice(idx + 1);
              // Raw URL — this is what readAgentSkill() actually fetches.
              url = "https://raw.githubusercontent.com/" + repo + "/HEAD/" + path;
            }
            src = "agentskills_code";
          } else if (isHermesAtlas) {
            rawId = wantedId.slice("hermes_atlas:".length);
            url = "https://github.com/" + rawId;
            kind = "hermes_repo";
            src = "hermes_atlas";
          }
          candidate = {
            id: wantedId,
            source: src,
            kind,
            name: rawId,
            url,
            description: "Reasoner-chosen from agentry.discover results.",
            meta: {},
          };
          if (isAgentskills) {
            const idx = rawId.indexOf(":");
            if (idx > 0) {
              candidate.meta.repo = rawId.slice(0, idx);
              candidate.meta.path = rawId.slice(idx + 1);
            }
          }
          if (isClawhub) {
            candidate.meta.install_reference = rawId;
          }
        }
        const proposalId = "proposal_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
        graph.putCapability({
          id: proposalId,
          kind: "proposal",
          state: "decided",
          gap_id: gap.id,
          gap_wanted_kind: gap.wanted_kind || "tool",
          gap_wanted_id: wantedId,
          analysis: {
            candidates: [{
              id: wantedId,
              fit: 1,
              confidence: "high",
              why: "Reasoner picked this from agentry.discover results.",
              risks: [],
            }],
            recommended_id: wantedId,
            summary: "Reasoner discovered " + wantedId + " via agentry.discover.",
          },
          candidates: [candidate],
          decisions: {
            [wantedId]: { decision: "approved", at: Date.now(), auto: true, source: "reasoner_discover" },
          },
          auto_approved: true,
          model_used: "reasoner",
          provider_used: "reasoner",
          created_at: Date.now(),
          updated_at: Date.now(),
        });
        events.emit("discovery.reasoner_candidate_proposed", {
          gap_id: gap.id,
          wanted_id: wantedId,
          proposal_id: proposalId,
          source: isNpm ? "npm"
                : isMcp ? "mcp"
                : isClawhub ? "clawhub"
                : isAgentskills ? "agentskills"
                : isHermesAtlas ? "hermes_atlas"
                : "unknown",
        });
      }
      continue;
    }

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
