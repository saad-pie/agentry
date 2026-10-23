// agentry/src/handlers/agentry.ensure.mjs
// v0.36.0 — the vision loop, exposed as a capability.
//
// Ports the mcp/tools.mjs ensure_capability logic into a capability any
// handler can invoke. When a task step needs a capability that doesn't
// exist, the caller (typically agentry.task.run after a not_found
// failure) calls this to trigger acquisition and wait for the result.
//
// Difference from mcp ensure_capability: no agentry.reason call. The
// caller already knows the capability_id, so the gap is recorded directly
// with wanted_id=<capability_id>. The reasoner is for discovery of WHAT
// is needed; here we already know what.
//
// Behavior:
//   1. checkAvailable — graph lookup + handler_file existence check
//   2. If missing: recordGap with wanted_id=capability_id
//   3. Poll graph until capability appears or timeout elapses
//   4. Return { available, capability_id, kind, handler_file, gap_id, waited_ms, reason }

import { existsSync } from "node:fs";
import { recordGap } from "./agentry.capability_gap.mjs";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function checkAvailable(graph, capabilityId) {
  if (typeof graph.invalidateCache === "function") graph.invalidateCache();
  const cap = graph.getCapability(capabilityId);
  if (!cap) return null;
  if (cap.retired_at) return null;
  if (typeof cap.handler_file === "string" && cap.handler_file.length > 0) {
    if (!existsSync(cap.handler_file)) return null;
  }
  return cap;
}

export default async function agentryEnsure(input, ctx) {
  const { capability_id, timeout_ms, wanted_kind, wanted_description } = input || {};
  if (!capability_id) throw new Error("agentry.ensure requires capability_id");
  if (typeof ctx.invoke !== "function") throw new Error("agentry.ensure requires ctx.invoke");

  const graph = ctx.graph;
  const events = ctx.events;
  const started = Date.now();

  // ── 1. Immediate check ──
  let cap = checkAvailable(graph, capability_id);
  if (cap) {
    events.emit("ensure.already_available", { capability_id });
    return {
      output: {
        ok: true, available: true, capability_id,
        kind: cap.kind, handler_file: cap.handler_file || null,
        reason: "already_available", waited_ms: Date.now() - started,
      },
      cost: { time_ms: Date.now() - started },
    };
  }

  // ── 2. Record gap if not already open ──
  const gapKey = "gap:" + capability_id;
  let gapId = null;
  const existingGap = graph.getCapability(gapKey);
  if (existingGap && !existingGap.retired_at) {
    gapId = existingGap.id;
    events.emit("ensure.gap_reused", { capability_id, gap_id: gapId });
  } else {
    try {
      const gap = recordGap(
        { graph, events },
        {
          key: gapKey,
          wanted_kind: wanted_kind || "tool",
          wanted_id: capability_id,
          wanted_description: wanted_description || ("ensure: " + capability_id),
          reason: "agentry.ensure: caller requested, not yet in graph",
          example_task_id: ctx.task_id || null,
        }
      );
      gapId = gap.id;
      events.emit("ensure.gap_recorded", { capability_id, gap_id: gapId, wanted_kind: gap.wanted_kind });
    } catch (e) {
      events.emit("ensure.gap_record_failed", { capability_id, error: e.message });
    }
  }

  // ── 2.5 v0.52.25 — DSH fast path ──
  // If caller provided wanted_kind or wanted_description (i.e. reasoner
  // already diagnosed a real missing capability), try DSH-driven synthesis
  // BEFORE the polling loop. DSH returns a working handler in 45-90s vs
  // the mechanical pipeline's ~10min. Falls through to poll loop on any
  // DSH failure — pipeline remains the safety net.
  const _hasSynthesisHint = !!(wanted_kind || wanted_description);
  if (_hasSynthesisHint) {
    try {
      const dshSynth = await ctx.invoke("agentry.synthesize_via_dsh", {
        capability_id,
        intent: wanted_description || capability_id,
        wanted_kind: wanted_kind || "tool",
        wanted_description: wanted_description || null,
        timeout_ms: Math.min(timeoutMs, 60000),
      }, { tenant: "local", by: "agentry.ensure", task_id: ctx.task_id });
      if (dshSynth.ok && dshSynth.output?.verified) {
        cap = checkAvailable(graph, capability_id);
        if (cap) {
          events.emit("ensure.dsh_synthesized", {
            capability_id, handler_path: dshSynth.output.handler_path,
            package_name: dshSynth.output.package_name,
            waited_ms: Date.now() - started,
          });
          return {
            output: {
              ok: true, available: true, capability_id,
              kind: cap.kind, handler_file: cap.handler_file || null,
              gap_id: gapId, waited_ms: Date.now() - started,
              reason: "dsh_synthesized",
            },
            cost: { time_ms: Date.now() - started },
          };
        }
      }
      events.emit("ensure.dsh_synth_not_verified", {
        capability_id,
        reason: dshSynth.output?.reason || "unknown",
        waited_ms: Date.now() - started,
      });
    } catch (e) {
      events.emit("ensure.dsh_synth_threw", { capability_id, error: e.message });
    }
  }

  // ── 3. Poll ──
  const pollMs = 2000;
  const timeoutMs = Math.max(2000, Math.min(600000, Number(timeout_ms) || 120000));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    cap = checkAvailable(graph, capability_id);
    if (cap) {
      events.emit("ensure.became_available", { capability_id, waited_ms: Date.now() - started });
      return {
        output: {
          ok: true, available: true, capability_id,
          kind: cap.kind, handler_file: cap.handler_file || null,
          gap_id: gapId, waited_ms: Date.now() - started,
          reason: "became_available",
        },
        cost: { time_ms: Date.now() - started },
      };
    }
  }

  // ── 4. Timeout ──
  let proposalId = null;
  if (gapId) {
    for (const node of graph.capabilities().values()) {
      if (node.kind === "proposal" && node.gap_id === gapId && !node.adopted_at && !node.retired_at) {
        proposalId = node.id;
        break;
      }
    }
  }
  events.emit("ensure.timeout", { capability_id, gap_id: gapId, proposal_id: proposalId, timeout_ms: timeoutMs });
  return {
    output: {
      ok: false, available: false, capability_id,
      gap_id: gapId, proposal_id: proposalId,
      waited_ms: Date.now() - started, reason: "timeout",
    },
    cost: { time_ms: Date.now() - started },
  };
}
