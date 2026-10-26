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

  // ── 2.4 v0.56.7 — mechanical funnel ──
  // Try discover → proposal → adopt BEFORE DSH. Mechanical runs the full
  // synth+trial pipeline with the npm/pypi/skills adapters. If a candidate
  // is adoptable, DSH never gets called. This is the fix for "DSH is the
  // head" — it's the last resort, not the first responder.
  //
  // Bounded: mechanical gets min(90s, 60% of remaining budget). If it fails
  // or runs out, DSH gets whatever's left. Total is still timeout_ms.
  {
    const _remainingMs = Math.max(2000, Math.min(600000, Number(timeout_ms) || 180000));
    const _mechanicalBudgetMs = Math.min(90000, Math.floor(_remainingMs * 0.6));
    const _mechStart = Date.now();
    const _mechDeadline = _mechStart + _mechanicalBudgetMs;
    const _intent = (wanted_description || capability_id || "").trim();
    let _mechReason = "skipped";
    let _mechAdopted = false;
    if (_intent.length >= 4) {
      try {
        events.emit("ensure.mechanical_started", {
          capability_id, intent: _intent, budget_ms: _mechanicalBudgetMs,
        });
        const _disc = await ctx.invoke("agentry.discover", {
          query: _intent,
          sources: ["npm", "pypi", "agentskills_code", "clawhub"],
          limit: 10,
        }, { tenant: "local", by: "agentry.ensure", task_id: ctx.task_id });
        const _candidates = [];
        if (_disc.ok && _disc.output && _disc.output.results) {
          for (const _src of ["npm", "pypi", "agentskills_code", "clawhub"]) {
            const _items = _disc.output.results[_src] || [];
            for (const _it of _items) {
              if (_it && _it.id) _candidates.push(_it);
              if (_candidates.length >= 10) break;
            }
            if (_candidates.length >= 10) break;
          }
        }
        if (_candidates.length === 0) {
          _mechReason = "no_candidates";
        } else if (Date.now() >= _mechDeadline) {
          _mechReason = "budget_exhausted_after_discover";
        } else {
          const _gapObj = gapId ? graph.getCapability(gapId) : null;
          if (!_gapObj) {
            _mechReason = "no_gap_node";
          } else {
            const _prop = await ctx.invoke("agentry.proposal", {
              gap: _gapObj,
              candidates: _candidates,
              notify: "notify.console",
            }, { tenant: "local", by: "agentry.ensure", task_id: ctx.task_id });
            if (!_prop.ok || !_prop.output || !_prop.output.proposal_id) {
              _mechReason = "proposal_failed:" + String(_prop.error && _prop.error.code || "no_proposal");
            } else if (Date.now() >= _mechDeadline) {
              _mechReason = "budget_exhausted_after_proposal";
            } else {
              const _propNode = graph.getCapability(_prop.output.proposal_id);
              const _recommendedId = (_propNode && _propNode.analysis && _propNode.analysis.recommended_id) || null;
              if (!_recommendedId) {
                _mechReason = "no_recommendation";
              } else {
                events.emit("ensure.mechanical_adopting", {
                  capability_id, proposal_id: _prop.output.proposal_id,
                  recommended_id: _recommendedId,
                  candidates_count: _candidates.length,
                });
                const _adopt = await ctx.invoke("agentry.adopt", {
                  proposal_id: _prop.output.proposal_id,
                  id_override: capability_id,
                }, { tenant: "local", by: "agentry.ensure", task_id: ctx.task_id });
                if (_adopt.ok && _adopt.output && Array.isArray(_adopt.output.adopted) && _adopt.output.adopted.length > 0) {
                  cap = checkAvailable(graph, capability_id);
                  if (cap) {
                    _mechAdopted = true;
                    _mechReason = "adopted";
                  } else {
                    _mechReason = "adopted_but_not_available";
                  }
                } else {
                  const _why = (_adopt.output && _adopt.output.failed && _adopt.output.failed[0] && _adopt.output.failed[0].error) || (_adopt.error && _adopt.error.message) || "no_adopted";
                  _mechReason = "adopt_failed:" + String(_why).slice(0, 200);
                }
              }
            }
          }
        }
      } catch (e) {
        _mechReason = "mechanical_threw:" + String(e.message || "").slice(0, 200);
      }
    } else {
      _mechReason = "intent_too_short";
    }
    if (_mechAdopted && cap) {
      events.emit("ensure.mechanical_adopted", {
        capability_id, gap_id: gapId,
        kind: cap.kind, handler_file: cap.handler_file || null,
        waited_ms: Date.now() - started,
        reason: "mechanical",
      });
      return {
        output: {
          ok: true, available: true, capability_id,
          kind: cap.kind, handler_file: cap.handler_file || null,
          gap_id: gapId, waited_ms: Date.now() - started,
          reason: "mechanical_adopted",
        },
        cost: { time_ms: Date.now() - started },
      };
    }
    events.emit("ensure.mechanical_not_adopted", {
      capability_id, gap_id: gapId,
      reason: _mechReason,
      ms: Date.now() - _mechStart,
    });
  }

  // ── 2.5 v0.52.26 — DSH fast path ──
  // v0.52.26 FIX: prior version referenced `timeoutMs` here, but timeoutMs
  // is declared in step 3 below. TDZ ReferenceError. Now compute an
  // independent dshTimeoutMs from the raw input param.
  // v0.52.27 — cap raised from 60000 to 180000. The 60s cap cut DSH off
  // mid-work on md_to_pdf (60148ms elapsed, no final emitted, treated as
  // clean exit). The successful png_to_jpg probe took ~90s with 300s outer.
  // 180s gives DSH room for install + test + iterate without killing valid
  // work, while still bounding worst-case latency.
  const _totalMs = Math.max(2000, Math.min(600000, Number(timeout_ms) || 180000));
  const _ensureDeadline = started + _totalMs;
  const _dshTimeoutMs = Math.max(30000, Math.min(_totalMs - (Date.now() - started), 180000));
  const _hasSynthesisHint = !!(wanted_kind || wanted_description);
  if (_hasSynthesisHint) {
    try {
      const dshSynth = await ctx.invoke("agentry.synthesize_via_dsh", {
        capability_id,
        intent: wanted_description || capability_id,
        wanted_kind: wanted_kind || "tool",
        wanted_description: wanted_description || null,
        timeout_ms: _dshTimeoutMs,
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
  const timeoutMs = _totalMs;
  const deadline = _ensureDeadline;
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
