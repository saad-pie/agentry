// agentry/src/graph/edges.mjs
//
// v0.16.0 — typed graph edges.
//
// The graph used to be a flat pile of nodes: every relationship between
// two things was a string field buried in one of them ("gap_id",
// "adopted_from.candidate_id", "requires.capability"). You could not
// ask "what capabilities compose into agent X" without scanning every
// node and inferring the shape.
//
// Edges are the fix. An edge is a first-class node of kind "edge" with
// three load-bearing fields:
//
//   from       — the id of the source node
//   to         — the id of the target node (or a pseudo-id when the
//                target is not itself a node, e.g. a GitHub candidate)
//   relation   — a short verb, one of the RELATIONS below
//
// Edges live in the same capabilities.jsonl as everything else. Same
// append-only model, same putCapability, same retired_at. An edge can
// be retired like any other node.
//
// This module is a helper. graph.mjs is untouched.

export const RELATIONS = {
  // A proposal claims to solve a gap.
  PROPOSAL_SATISFIES_GAP: "satisfies",
  // A watch_result carries candidates for a gap.
  WATCH_RESULT_FOR_GAP: "for_gap",
  // An adopted capability fills a gap.
  CAPABILITY_SATISFIES_GAP: "satisfies",
  // An adopted capability came from this candidate. `to` is a candidate
  // id (repo full_name or URL), which may not be a node in the graph.
  CAPABILITY_SOURCED_FROM: "sourced_from",
  // A proposal adopted a capability.
  PROPOSAL_ADOPTED_CAPABILITY: "adopted_capability",
  // A capability composes another capability (mirror of
  // requires.capability, edges make it queryable).
  CAPABILITY_COMPOSED_OF: "composed_of",
};

export function edgeId(from, relation, to) {
  return "edge:" + from + "::" + relation + "::" + to;
}

/**
 * Write an edge. Idempotent per (from, relation, to): re-linking the
 * same triple bumps the version rather than creating a second node.
 *
 * @param {CapabilityGraph} graph
 * @param {object} args — { from, to, relation, meta? }
 * @returns {object} — the edge node
 */
export function link(graph, { from, to, relation, meta = null }) {
  if (!from || typeof from !== "string") throw new Error("edge: 'from' required");
  if (!to || typeof to !== "string") throw new Error("edge: 'to' required");
  if (!relation || typeof relation !== "string") throw new Error("edge: 'relation' required");
  const id = edgeId(from, relation, to);
  return graph.putCapability({
    id,
    kind: "edge",
    from,
    to,
    relation,
    meta,
  });
}

/**
 * Find edges matching a filter. Any field left undefined is a wildcard.
 * Returns only live (non-retired) edges by default.
 *
 * @param {CapabilityGraph} graph
 * @param {object} filter — { from?, to?, relation?, includeRetired? }
 * @returns {object[]}
 */
export function findEdges(graph, filter = {}) {
  const { from, to, relation, includeRetired = false } = filter;
  const out = [];
  for (const c of graph.capabilities().values()) {
    if (c.kind !== "edge") continue;
    if (!includeRetired && c.retired_at) continue;
    if (from !== undefined && c.from !== from) continue;
    if (to !== undefined && c.to !== to) continue;
    if (relation !== undefined && c.relation !== relation) continue;
    out.push(c);
  }
  return out;
}

/**
 * Find nodes linked to a given id. direction:
 *   "out"  — edges where c.from === id  (default)
 *   "in"   — edges where c.to === id
 *   "both" — either side
 * Returns edges, not the target nodes; call graph.getCapability on the
 * other side of each edge if you need the node itself.
 */
export function linked(graph, { id, relation, direction = "out" } = {}) {
  const out = [];
  for (const c of graph.capabilities().values()) {
    if (c.kind !== "edge") continue;
    if (c.retired_at) continue;
    const matchesFrom = c.from === id;
    const matchesTo = c.to === id;
    const dirOk =
      (direction === "out" && matchesFrom) ||
      (direction === "in" && matchesTo) ||
      (direction === "both" && (matchesFrom || matchesTo));
    if (!dirOk) continue;
    if (relation !== undefined && c.relation !== relation) continue;
    out.push(c);
  }
  return out;
}

/**
 * Convenience: given a gap id, return every live capability that
 * satisfies it, in adoption order.
 */
export function capabilitiesSatisfying(graph, gapId) {
  const edges = findEdges(graph, { relation: RELATIONS.CAPABILITY_SATISFIES_GAP, to: gapId });
  return edges
    .map(e => graph.getCapability(e.from))
    .filter(c => c && c.kind !== "edge" && !c.retired_at);
}
