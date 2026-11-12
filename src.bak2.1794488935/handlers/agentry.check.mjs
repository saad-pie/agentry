// agentry/src/handlers/agentry.check.mjs
// v0.58.1 — does this capability exist? Returns matches OR creates a gap.
// No planning. No invoke. No boot. DSH decides.

import { recordGap } from "./agentry.capability_gap.mjs";

const SKIP_KINDS = new Set(["agent","edge","capability_gap","watch_instance","proposal","synthesis_attempt","task","message"]);

function tokenize(s) {
  return String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
}

function deriveCapabilityId(intent) {
  const m = String(intent || "").match(/\b(?:convert|change|transform|turn)\s+(?:the\s+)?([a-zA-Z0-9]+)\s+(?:file\s+)?(?:to|into)\s+([a-zA-Z0-9]+)\b/i);
  if (m) return (m[1] + "_to_" + m[2]).toLowerCase().replace(/[^a-z0-9_]/g, "_");
  return "task_" + Date.now().toString(36);
}

export default async function agentryCheck(input, ctx) {
  const { intent_or_id, wanted_kind } = input || {};
  if (!intent_or_id || typeof intent_or_id !== "string") throw new Error("agentry.check requires intent_or_id");

  const graph = ctx.graph, events = ctx.events;
  const started = Date.now();
  if (typeof graph.invalidateCache === "function") graph.invalidateCache();

  // 1. Exact match
  const exact = graph.getCapability(intent_or_id);
  if (exact && !exact.retired_at && exact.invoked_via) {
    events.emit("check.exact_match", { capability_id: intent_or_id });
    return {
      output: {
        exists: true,
        capability_id: exact.id,
        matches: [{
          id: exact.id, kind: exact.kind,
          accepts: Object.keys(exact.accepts || {}),
          produces: Object.keys(exact.produces || {}),
          why: String(exact.notes || exact.description || exact.id).slice(0, 120),
          score: 999,
        }],
        hint: "Exact match. Call invoke() with capability_id and input.",
      },
      cost: { time_ms: Date.now() - started },
    };
  }

  // 2. Token overlap across live caps
  const tokens = tokenize(intent_or_id);
  const matches = [];
  for (const c of graph.capabilities().values()) {
    if (c.retired_at || !c.invoked_via || SKIP_KINDS.has(c.kind)) continue;
    const hay = (String(c.id) + " " + String(c.notes || "") + " " + String(c.description || "")).toLowerCase();
    let score = 0;
    for (const t of tokens) if (hay.includes(t)) score++;
    if (score >= 2) {
      matches.push({
        id: c.id, kind: c.kind,
        accepts: Object.keys(c.accepts || {}),
        produces: Object.keys(c.produces || {}),
        why: String(c.notes || c.description || c.id).slice(0, 120),
        score,
      });
    }
  }
  matches.sort((a, b) => b.score - a.score);

  if (matches.length > 0) {
    events.emit("check.matches", { intent: String(intent_or_id).slice(0, 100), count: matches.length, top: matches[0].id });
    return {
      output: {
        exists: true,
        capability_id: matches[0].id,
        matches: matches.slice(0, 10),
        hint: "Pick one of matches and call invoke(). If none are right, call check() with the exact id you want, or describe what you need and call search().",
      },
      cost: { time_ms: Date.now() - started },
    };
  }

  // 3. No match — create gap
  const capId = deriveCapabilityId(intent_or_id);
  const gapId = "gap:" + capId;
  try {
    recordGap({ graph, events }, {
      key: gapId,
      wanted_kind: wanted_kind || "tool",
      wanted_id: capId,
      wanted_description: String(intent_or_id).slice(0, 200),
      reason: "check.no_match",
    });
    events.emit("check.gap_created", { gap_id: gapId, capability_id: capId });
  } catch (e) {
    events.emit("check.gap_create_failed", { gap_id: gapId, error: e.message });
  }

  return {
    output: {
      exists: false,
      gap_id: gapId,
      capability_id: capId,
      matches: [],
      hint: "No match. Gap created. Call search() to find packages, pick ONE candidate, call build() with gap_id and that candidate.",
    },
    cost: { time_ms: Date.now() - started },
  };
}
