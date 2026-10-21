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

// v0.51.2 — WHITELIST not blacklist. Only these kinds auto-adopt:
//   tool      — discrete utilities (convert, extract, render)
//   notify    — messaging delivery
//   web       — HTTP fetch/parse
//   unknown   — LLM couldn't classify, worth a try
// Everything else — bua, cua, mua, memory, harness, and any garbage
// kind the LLM emitted (e.g. "capability") — is EXCLUDED. Those are
// either the dedicated arms layer or invalid.
const AUTO_DECIDE_ALLOWED_KINDS = new Set(["tool", "notify", "web", "unknown"]);

// Gaps whose wanted_id contains these markers are test/debug junk from
// ensure-loop probes. Auto-deciding them pollutes the graph with
// capabilities nobody needs.
const GAP_ID_REJECT_MARKERS = [
  "does.not.exist", "doesnotexist", "test.nonexistent", "example.",
  ".test.", ".test$", "test.capability",
];

function gapIdLooksValid(wantedId) {
  if (!wantedId || typeof wantedId !== "string") return false;
  const w = wantedId.trim();
  if (w.length < 3 || w.length > 200) return false;
  // must be a dotted identifier — letters, digits, dot, underscore, dash
  if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(w)) return false;
  for (const marker of GAP_ID_REJECT_MARKERS) {
    if (w.includes(marker)) return false;
  }
  return true;
}

// v0.51.4 — consolidated pipelineability check. Called from Pass 1, 2, 3.
// Prior versions had inconsistent filters: Pass 1/2 only checked kind, so a
// gap with wanted_kind="tool" but invalid wanted_id (test.nonexistent.*)
// slipped through to adoption, where synth failed on the dead gap.
function isPipelineable(gap, graph) {
  if (!gap) return { ok: false, reason: "no_gap" };
  if (gap.retired_at) return { ok: false, reason: "gap_retired" };
  if (!AUTO_DECIDE_ALLOWED_KINDS.has(gap.wanted_kind)) {
    return { ok: false, reason: "kind_not_allowed", kind: gap.wanted_kind };
  }
  const wid = String(gap.wanted_id || (gap.id || "").replace(/^gap:/, ""));
  if (!gapIdLooksValid(wid)) {
    return { ok: false, reason: "invalid_wanted_id", wanted_id: wid };
  }
  return { ok: true };
}

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

    // v0.51.3 — skip watch_results whose gap kind is not auto-decidable.
    // Prior version only filtered in Pass 3, so existing watch_results on
    // orphan gaps (agent.dsh, junk test gaps) still produced proposals.
    {
      const _pipe1 = isPipelineable(gap, graph);
      if (!_pipe1.ok) {
        events.emit("discovery.watch_result_skipped", {
          watch_result_id: node.id, gap_id: gap.id, reason: _pipe1.reason,
          kind: _pipe1.kind || null, wanted_id: _pipe1.wanted_id || null,
        });
        graph.putCapability({
          id: node.id, kind: "watch_result",
          analyzed_at: Date.now(),
          analysis_skipped_reason: "pipeline_not_valid:" + _pipe1.reason,
        });
        continue;
      }
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
    // v0.51.3 — skip decided proposals whose gap kind is not auto-decidable.
    // Prevents adopt from attempting synthesis for agent/bua/cua/mua/memory/
    // harness kinds that slipped into state=decided before v0.51.2 shipped.
    {
      const _gap2 = graph.getCapability(node.gap_id);
      const _pipe2 = isPipelineable(_gap2, graph);
      if (!_pipe2.ok) {
        events.emit("discovery.proposal_skipped", {
          proposal_id: node.id, gap_id: node.gap_id, reason: _pipe2.reason,
          kind: _pipe2.kind || null, wanted_id: _pipe2.wanted_id || null,
        });
        try {
          graph.putCapability({
            id: node.id, kind: "proposal",
            state: "rejected", adopted_at: Date.now(),
            rejected_reason: "pipeline_not_valid:" + _pipe2.reason,
          });
        } catch {}
        continue;
      }
    }
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

  // v0.51.3 — orphan gap cleanup: if gap.wanted_id matches a capability
  // that exists and is retired, this gap is a ghost. Retire it silently.
  // Example: gap:agent.dsh lingers after agent.dsh was retired in v0.47.3.
  const _orphanRetired = [];
  for (const g of liveGaps(graph)) {
    const wantedId = String(g.wanted_id || g.id.replace(/^gap:/, ""));
    const cap = graph.getCapability(wantedId);
    if (cap && cap.retired_at) {
      try {
        graph.retireCapability(g.id, "v0.51.3: orphan gap — capability " + wantedId + " is retired");
        _orphanRetired.push({ gap: g.id, capability: wantedId });
      } catch {}
    }
  }
  if (_orphanRetired.length > 0) {
    events.emit("discovery.orphan_gaps_retired", { count: _orphanRetired.length, samples: _orphanRetired.slice(0, 10) });
  }

  // v0.51.2 — allowlist + format check. Rejected gaps are silently
  // skipped (not retired — they may be from a legitimate retry, but
  // they'll never auto-adopt while invalid).
  const _allLiveGaps = liveGaps(graph);
  const _rejected = [];
  const gaps = _allLiveGaps.filter(g => {
    if (!AUTO_DECIDE_ALLOWED_KINDS.has(g.wanted_kind)) {
      _rejected.push({ gap: g.id, reason: "kind_not_allowed", kind: g.wanted_kind });
      return false;
    }
    if (!gapIdLooksValid(g.wanted_id || g.id.replace(/^gap:/, ""))) {
      _rejected.push({ gap: g.id, reason: "invalid_wanted_id", wanted_id: g.wanted_id });
      return false;
    }
    return true;
  });
  const excluded_gap_count = _allLiveGaps.length - gaps.length;
  if (_rejected.length > 0) {
    events.emit("discovery.gaps_rejected", {
      count: _rejected.length,
      samples: _rejected.slice(0, 10),
    });
  }

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
    excluded_kinds: excluded_gap_count,
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
