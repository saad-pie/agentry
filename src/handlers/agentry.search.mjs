// agentry/src/handlers/agentry.search.mjs
// v0.58.7 — raw adapter fan-out + query retry + web fallback.
// DSH reads results. Agentry never ranks or picks.

import { runAdapters } from "../adapters/_registry.mjs";

const DEFAULT_ADAPTERS = ["npm","pypi","crates","gomod","maven","nuget","agentskills_code","clawhub","hermes_atlas","dsh_plugins","github","web","mcp"];

// v0.58.7 — filler words that don't help maven/nuget search. They index
// package/artifact names, not natural-language queries. "convert json to
// yaml" returns 0, but "json yaml" returns hundreds.
const SEARCH_FILLER = new Set([
  "convert","change","transform","turn","make","create","generate",
  "to","into","from","with","and","or","the","a","an",
  "file","files","using","please","via","through","for","of",
]);

function simplifyQuery(q) {
  const tokens = String(q || "").toLowerCase().split(/[^a-z0-9]+/)
    .filter(t => t.length >= 3 && !SEARCH_FILLER.has(t));
  return tokens.slice(0, 3).join(" ");
}

export default async function agentrySearch(input, ctx) {
  const { query, adapters, limit } = input || {};
  if (!query || typeof query !== "string") throw new Error("agentry.search requires query");

  const started = Date.now();
  const events = ctx.events;
  const _adapters = Array.isArray(adapters) && adapters.length ? adapters : DEFAULT_ADAPTERS;
  const _limit = Math.max(1, Math.min(Number(limit) || 10, 30));

  events.emit("search.started", { query: String(query).slice(0, 200), adapters: _adapters, limit: _limit });

  const r = await runAdapters({ query, limit: _limit, sources: _adapters, ctx });

  // v0.58.7 — retry empty adapters with simplified query.
  const _emptyAdapters = _adapters.filter(a => (r.results[a] || []).length === 0);
  if (_emptyAdapters.length > 0) {
    const _simplified = simplifyQuery(query);
    if (_simplified && _simplified !== query.toLowerCase().trim()) {
      events.emit("search.retry_simplified", { original: query, simplified: _simplified, adapters: _emptyAdapters });
      try {
        const retryRun = await runAdapters({ query: _simplified, limit: Math.min(_limit, 5), sources: _emptyAdapters, ctx });
        let _retryHits = 0;
        for (const src of _emptyAdapters) {
          const retryItems = (retryRun.results && retryRun.results[src]) || [];
          if (retryItems.length > 0) {
            r.results[src] = retryItems;
            r.counts = { ...(r.counts || {}), [src]: retryItems.length };
            _retryHits++;
            events.emit("search.retry_success", { adapter: src, count: retryItems.length, simplified: _simplified });
          }
        }
        if (_retryHits > 0) events.emit("search.retry_done", { hits: _retryHits, total_empty: _emptyAdapters.length });
      } catch (e) {
        events.emit("search.retry_threw", { error: String(e.message || "").slice(0, 200) });
      }
    }
  }

  // v0.58.7 — web (SearXNG) fallback if still nothing.
  const _totalAfterRetry = Object.values(r.results).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);
  if (_totalAfterRetry === 0 && !_adapters.includes("web")) {
    events.emit("search.web_fallback_started", { query });
    try {
      const webRun = await runAdapters({ query, limit: Math.min(_limit, 5), sources: ["web"], ctx });
      if (webRun.results && webRun.results.web && webRun.results.web.length > 0) {
        r.results.web = webRun.results.web;
        r.counts = { ...(r.counts || {}), web: webRun.results.web.length };
        events.emit("search.web_fallback_success", { count: webRun.results.web.length });
      }
    } catch (e) {
      events.emit("search.web_fallback_threw", { error: String(e.message || "").slice(0, 200) });
    }
  }

  events.emit("search.completed", {
    query: String(query).slice(0, 200),
    counts: r.counts,
    errors: Object.keys(r.errors || {}).length ? r.errors : null,
  });

  return {
    output: {
      query,
      adapters_searched: _adapters,
      results: r.results,
      counts: r.counts,
      errors: Object.keys(r.errors || {}).length ? r.errors : null,
      hint: "Raw results grouped by adapter. Read them, pick ONE candidate, pass it to build_from_plan (strong models) or build (weak models) with the gap_id from check().",
    },
    cost: { time_ms: Date.now() - started },
  };
}
