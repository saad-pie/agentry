// agentry/src/adapters/local.mjs
//
// v0.18.0 — search the local agentry capability graph.
//
// Returns every live invokable capability up to `limit`, no scoring.
// The reasoner reads the full list and decides. Matches v0.17.3
// semantics — the LLM is the ranker.

export const meta = {
  name: "local",
  kind: "capability",
  description: "Live capabilities in the local agentry graph",
};

export async function search({ query, limit = 10, ctx }) {
  const graph = ctx && ctx.graph;
  if (!graph) return [];

  const items = [];
  for (const c of graph.capabilities().values()) {
    if (c.retired_at) continue;
    if (!c.invoked_via) continue;
    if (c.kind === "edge") continue;
    items.push({
      id: c.id,
      source: "local",
      kind: c.kind,
      name: c.id,
      url: null,
      description: c.notes || null,
      accepts: c.accepts || null,
      produces: c.produces || null,
      exists_locally: true,
    });
    if (items.length >= limit) break;
  }
  return items;
}
