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
//
// v0.15.25: new export `recordComposedDepGap` for the composition case —
// when capability A declares `requires.capability: ["B"]` and B isn't in
// the graph, the gap must be recorded against B, not against A. Otherwise
// discovery proposes candidates for the outer capability's kind, which is
// the wrong problem to solve.

import { errors } from "../errors.mjs";

const GAP_KINDS = new Set([
  "invalid_capability",  // A: capability id doesn't exist in the graph
  "invalid_spec",        // B: capability exists but no handler is registered
]);

// Derive a wanted_kind from a dotted capability id. "bua.browser" → "bua".
// Used in two places now (observeFailure and recordComposedDepGap) so it
// lives in one.
function deriveWantedKind(capabilityId) {
  if (typeof capabilityId !== "string" || !capabilityId.includes(".")) return null;
  return capabilityId.split(".")[0];
}

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
 * @param {object} gap        — { key, wanted_kind, wanted_id, reason, example_task_id? }
 * @returns {object}          — the updated gap node
 */
export function recordGap(deps, gap) {
  const { graph, events } = deps;
  if (!gap?.key) throw errors.invalidRequest("recordGap requires gap.key");

  const existing = graph.getCapability(gap.key);
  const now = Date.now();

  // v0.19.3 — preserve wanted_kind / wanted_id / reason from the
  // existing gap node when the caller does not supply them. Before
  // this, observeFailure (which derives wanted_kind from a dotted
  // capability_id and yields null when there is no dot) was
  // overwriting a good wanted_kind with null on every trial failure,
  // which broke shape lookup on the retry.
  const prevKind = existing && existing.wanted_kind ? existing.wanted_kind : null;
  const prevId = existing && existing.wanted_id ? existing.wanted_id : null;
  const prevReason = existing && existing.reason ? existing.reason : null;
  const prevDesc = existing && existing.wanted_description ? existing.wanted_description : null;

  // v0.52.9 — derive wanted_description from wanted_id (strip kind prefix, dots→space)
  // when caller didn't supply one. Fixes observeFailure gaps, whose only "desc"
  // was the boilerplate reason "capability does not exist in graph".
  const _deriveDesc = (wid, kind) => {
    if (!wid || typeof wid !== "string") return null;
    let s = wid.replace(/^[a-z]+:/i, "");
    if (kind && typeof kind === "string" && s.startsWith(kind + ".")) s = s.slice(kind.length + 1);
    s = s.replace(/[._:]+/g, " ").replace(/\s+/g, " ").trim();
    return s.length >= 4 ? s : null;
  };
  const _fallbackDesc = gap.wanted_id ? _deriveDesc(gap.wanted_id, gap.wanted_kind) : null;

  const node = {
    id: gap.key,
    kind: "capability_gap",
    wanted_kind: gap.wanted_kind != null ? gap.wanted_kind : prevKind,
    wanted_id: gap.wanted_id != null ? gap.wanted_id : prevId,
    wanted_description:
      gap.wanted_description != null
        ? gap.wanted_description
        : (prevDesc != null ? prevDesc : _fallbackDesc),
    reason: gap.reason != null ? gap.reason : prevReason,
    example_task_id: gap.example_task_id || null,
    origin_conversation_id: gap.origin_conversation_id || (existing && existing.origin_conversation_id) || null,
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
    wanted_description: node.wanted_description,
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
  // v0.21.0 — runtime failures on adopted capabilities re-open a gap.
  // v0.23.3 — EXCEPT for seeded infrastructure. llm.*, notify.*,
  // invoker.*, discovery.*, agentry.* failures are health (rate limits,
  // upstream outages), not missing capabilities. Otherwise every groq
  // 429 creates a fake gap and the reasoner proposes nonsense fixes.
  const _SEEDED_PREFIXES = ["llm.", "notify.", "invoker.", "discovery.", "agentry."];
  const _isSeeded = _SEEDED_PREFIXES.some(p => String(capability_id).startsWith(p));
  const _RUNTIME_CODES = new Set(["handler_threw", "invoker_failed", "runtime_error", "skill_runner_failed"]);
  if (!_isSeeded && _RUNTIME_CODES.has(error.code)) {
    return recordGap(deps, {
      key: "gap:" + capability_id,
      wanted_kind: deriveWantedKind(capability_id),
      wanted_id: capability_id,
      reason: ("invoke_failed: " + error.code + ": " + String(error.message || "")).slice(0, 300),
      example_task_id: task_id || null,
    });
  }
  if (!GAP_KINDS.has(error.code)) return null;
  if (!isGapReason(error.code, error.message)) return null;

  // Gap key: derived from what was missing. If the capability_id itself
  // doesn't exist, the gap is "we don't have <capability_id>". If the
  // capability_id exists but has no handler, the gap is the same shape —
  // we don't have a *working* <capability_id>.
  const key = `gap:${capability_id}`;

  return recordGap(deps, {
    key,
    wanted_kind: deriveWantedKind(capability_id),
    wanted_id: capability_id,
    reason: error.code === "invalid_capability"
      ? "capability does not exist in graph"
      : "capability exists but has no handler",
    example_task_id: task_id || null,
  });
}

/**
 * v0.15.25 — Record a gap for a composed capability that is declared by
 * another capability but does not exist in the graph. The gap is
 * attributed to the *missing inner* capability, not the outer one.
 * Discovery will then search for candidates of the inner's kind.
 *
 * @param {object} deps
 * @param {object} args — { outer_capability_id, missing_capability_id, example_task_id? }
 * @returns {object|null} — the gap node, or null if inputs are invalid
 */
export function recordComposedDepGap(deps, { outer_capability_id, missing_capability_id, example_task_id = null }) {
  if (!outer_capability_id || !missing_capability_id) return null;
  const key = `gap:${missing_capability_id}`;
  return recordGap(deps, {
    key,
    wanted_kind: deriveWantedKind(missing_capability_id),
    wanted_id: missing_capability_id,
    reason: `composed capability ${outer_capability_id} requires it, but it is not in the graph`,
    example_task_id,
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
