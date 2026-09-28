// agentry/src/handlers/agentry.capability_gap.mjs
// Records a capability gap.
//
// A gap is: "the graph tried to do something and could not, because the
// required capability doesn't exist (A) or exists but has no handler (B)."
//
// Not a gap: missing credentials (C). That's a config problem, and the boot
// log already reports it. Reporting it here would spam the discovery loop
// with the same gap on every tick until someone adds a secret.
//
// Gaps are nodes in the graph, kind "capability_gap". They are deduped by
// their `key` — the same missing capability requested twice is still one gap,
// with `hits` incremented.
//
// The discovery loop reads recent gaps and creates watches to find candidates.

import { errors } from "../errors.mjs";

const GAP_KINDS = new Set([
  "invalid_capability",  // A: capability id doesn't exist in the graph
  "invalid_spec",        // B: capability exists but no handler is registered
]);

// Only treat specific invalid_spec reasons as gaps. "missing required input"
// is a caller bug, not a gap. "no handler registered" is a real gap.
function isGapReason(code, message) {
  if (code === "invalid_capability") return true;
  if (code !== "invalid_spec") return false;
  if (!message) return false;
  const m = String(message).toLowerCase();
  if (m.includes("no handler registered")) return true;
  if (m.includes("missing config")) return false;           // C — ignore
  if (m.includes("missing required input")) return false;   // caller bug
  if (m.includes("rejected input")) return false;           // caller bug
  return false;
}

/**
 * Record a gap. Idempotent per key: calling twice with the same key
 * increments `hits` and updates `last_seen_at` rather than creating
 * a duplicate gap node.
 *
 * @param {object} deps       — { graph, events }
 * @param {object} gap        — { key, kind, wanted, reason, example_task_id? }
 * @returns {object}          — the updated gap node
 */
export function recordGap(deps, gap) {
  const { graph, events } = deps;
  if (!gap?.key) throw errors.invalidRequest("recordGap requires gap.key");

  const existing = graph.getCapability(gap.key);
  const now = Date.now();

  const node = {
    id: gap.key,
    kind: "capability_gap",
    // The gap's *subject* is what it wants. This is separate from the gap
    // node's own kind. `wanted_kind` is a signal to discovery: search for
    // capabilities whose kind matches this.
    wanted_kind: gap.wanted_kind || null,
    wanted_id: gap.wanted_id || null,
    reason: gap.reason || null,
    example_task_id: gap.example_task_id || null,
    hits: (existing?.hits || 0) + 1,
    first_seen_at: existing?.first_seen_at || now,
    last_seen_at: now,
    retired_at: null,
    invoked_via: null,       // gaps are not invoked; they're referenced
    accepts: null,
    produces: null,
    source: existing?.source || "runtime:observed",
    updated_at: now,
  };

  graph.putCapability(node);
  events.emit(existing ? "capability_gap.recurred" : "capability_gap.recorded", {
    key: gap.key,
    wanted_kind: node.wanted_kind,
    wanted_id: node.wanted_id,
    reason: node.reason,
    hits: node.hits,
    example_task_id: node.example_task_id,
  });

  return node;
}

/**
 * Scan an invoke result and, if it looks like a gap, record it.
 * Called from the runtime after every failed invoke.
 *
 * @returns {object|null} — the gap node if recorded, else null
 */
export function observeFailure(deps, { capability_id, error, task_id }) {
  if (!error) return null;
  if (!GAP_KINDS.has(error.code)) return null;
  if (!isGapReason(error.code, error.message)) return null;

  // Gap key: derived from what was missing. If the capability_id itself
  // doesn't exist, the gap is "we don't have <capability_id>". If the
  // capability_id exists but has no handler, the gap is the same shape —
  // we don't have a *working* <capability_id>.
  const key = `gap:${capability_id}`;
  // The wanted_kind is a hint. If the capability_id contains a dot, take the
  // part before the first dot as a kind — e.g. "bua.playwright" → "bua".
  const wanted_kind = capability_id.includes(".")
    ? capability_id.split(".")[0]
    : null;

  return recordGap(deps, {
    key,
    wanted_kind,
    wanted_id: capability_id,
    reason: error.code === "invalid_capability"
      ? "capability does not exist in graph"
      : "capability exists but has no handler",
    example_task_id: task_id || null,
  });
}

/**
 * Return all live gap nodes, most recent first.
 * Used by the discovery loop.
 */
export function liveGaps(graph) {
  const gaps = [];
  for (const node of graph.capabilities().values()) {
    if (node.kind === "capability_gap" && !node.retired_at) gaps.push(node);
  }
  gaps.sort((a, b) => (b.last_seen_at || 0) - (a.last_seen_at || 0));
  return gaps;
}
