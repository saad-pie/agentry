// agentry/src/handlers/agentry.search.mjs
// v0.58.1 — raw adapter fan-out. No ranking. No LLM. DSH picks from results.

import { runAdapters } from "../adapters/_registry.mjs";

const DEFAULT_ADAPTERS = ["npm","pypi","crates","gomod","maven","nuget","agentskills_code","clawhub","hermes_atlas","dsh_plugins","huggingface","github","web"];

export default async function agentrySearch(input, ctx) {
  const { query, adapters, limit } = input || {};
  if (!query || typeof query !== "string") throw new Error("agentry.search requires query");

  const started = Date.now();
  const events = ctx.events;
  const _adapters = Array.isArray(adapters) && adapters.length ? adapters : DEFAULT_ADAPTERS;
  const _limit = Math.max(1, Math.min(Number(limit) || 10, 30));

  events.emit("search.started", { query: String(query).slice(0, 200), adapters: _adapters, limit: _limit });

  const r = await runAdapters({ query, limit: _limit, sources: _adapters, ctx });

  events.emit("search.completed", {
    query: String(query).slice(0, 200),
    counts: r.counts,
    errors: Object.keys(r.errors).length ? r.errors : null,
  });

  return {
    output: {
      query,
      adapters_searched: _adapters,
      results: r.results,
      counts: r.counts,
      errors: Object.keys(r.errors).length ? r.errors : null,
      hint: "Raw results grouped by adapter. Read them, pick ONE candidate, pass it to build() with the gap_id from check().",
    },
    cost: { time_ms: Date.now() - started },
  };
}
