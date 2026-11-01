// agentry/src/handlers/agentry.chat.mjs
// v0.58.0 — LOOKUP ONLY. No planning. No task wrapping. No agent boot.
//
// DSH is the brain. This is a capability index. It answers one question:
// "given this intent, what capabilities in the graph are relevant?"
//
// Returns ONE of four states:
//   { state: "candidates", candidates: [{id, kind, accepts, produces, why, score}] }
//   { state: "queued", capability_building, gap_id, eta_s }
//   { state: "no_match", hint }
//
// DSH decides: invoke one of the candidates, call ensure_capability to
// build what's missing, or use its own tools directly. Agentry never invokes
// from chat. Agentry never plans from chat.

const SKIP_KINDS = new Set(["agent","edge","capability_gap","watch_instance","proposal","synthesis_attempt","task","message"]);

function deriveDescription(message) {
  const m = String(message).match(/\b(?:convert|change|transform|turn)\s+(?:the\s+)?([a-zA-Z0-9]+)\s+(?:file\s+)?(?:to|into)\s+([a-zA-Z0-9]+)\b/i);
  if (m) return "convert " + m[1].toLowerCase() + " to " + m[2].toLowerCase();
  return String(message).slice(0, 120).trim();
}

function deriveCapabilityId(message) {
  const m = String(message).match(/\b(?:convert|change|transform|turn)\s+(?:the\s+)?([a-zA-Z0-9]+)\s+(?:file\s+)?(?:to|into)\s+([a-zA-Z0-9]+)\b/i);
  if (m) return (m[1] + "_to_" + m[2]).toLowerCase().replace(/[^a-z0-9_]/g, "_");
  return null;
}

export default async function agentryChat(input, ctx) {
  const { message, conversation_id } = input || {};
  if (!message || typeof message !== "string" || !message.trim()) {
    throw new Error("agentry.chat requires message (non-empty string)");
  }
  if (typeof ctx.invoke !== "function") throw new Error("agentry.chat requires ctx.invoke");

  const graph = ctx.graph, events = ctx.events;
  const started = Date.now();
  const conversationId = conversation_id || ("conv_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6));

  if (typeof graph.invalidateCache === "function") graph.invalidateCache();
  events.emit("chat.user_turn", { conversation_id: conversationId, message: String(message).slice(0, 2000) });

  // ── 1. Score live caps by token overlap (no direction heuristic) ──
  const tokens = String(message).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
  const candidates = [];
  for (const c of graph.capabilities().values()) {
    if (c.retired_at || !c.invoked_via || SKIP_KINDS.has(c.kind)) continue;
    const hay = (String(c.id) + " " + String(c.notes || "") + " " + String(c.description || "")).toLowerCase();
    let score = 0;
    for (const t of tokens) if (hay.includes(t)) score++;
    if (score >= 2) {
      candidates.push({
        id: c.id,
        kind: c.kind,
        accepts: Object.keys(c.accepts || {}),
        produces: Object.keys(c.produces || {}),
        why: String(c.notes || c.description || c.id).slice(0, 120),
        score,
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, 5);

  // ── 2. Candidates exist — return them, let DSH pick ──
  if (top.length > 0) {
    events.emit("chat.candidates_returned", { conversation_id: conversationId, count: top.length, ids: top.map(c => c.id) });
    return {
      output: {
        state: "candidates",
        conversation_id: conversationId,
        candidates: top,
        hint: "Pick one and call invoke({capability_id, input}). If none fit, call ensure_capability or use your own tools.",
      },
      cost: { time_ms: Date.now() - started },
    };
  }

  // ── 3. No candidates — derive description + build capability id ──
  const desc = deriveDescription(message);
  const capId = deriveCapabilityId(message);
  if (desc && desc.length >= 6) {
    const buildId = capId || ("task_" + Date.now().toString(36));
    const gapId = "gap:" + buildId;
    try {
      const { recordGap } = await import("./agentry.capability_gap.mjs");
      recordGap({ graph, events }, {
        key: gapId,
        wanted_kind: "tool",
        wanted_id: buildId,
        origin_conversation_id: conversationId,
        wanted_description: desc,
        reason: "chat.no_candidates",
      });
      ctx.invoke("agentry.build", { gap_id: gapId }, { tenant: "local", by: "chat.build" })
        .catch(e => events.emit("chat.build_async_failed", { gap_id: gapId, error: String(e.message || "").slice(0, 200) }));
      events.emit("chat.queued", { conversation_id: conversationId, gap_id: gapId, capability_building: buildId });
      return {
        output: {
          state: "queued",
          conversation_id: conversationId,
          capability_building: buildId,
          gap_id: gapId,
          eta_s: 90,
          hint: "Capability being built. Retry in ~90s, or use your own tools to accomplish this now.",
        },
        cost: { time_ms: Date.now() - started },
      };
    } catch (e) {
      events.emit("chat.gap_record_failed", { gap_id: gapId, error: e.message });
    }
  }

  // ── 4. Nothing matched, nothing to build — hand off ──
  events.emit("chat.no_match", { conversation_id: conversationId });
  return {
    output: {
      state: "no_match",
      conversation_id: conversationId,
      hint: "No capability available. Use your own tools (bash, node, python, web_fetch) or call discover() / ensure_capability().",
    },
    cost: { time_ms: Date.now() - started },
  };
}
