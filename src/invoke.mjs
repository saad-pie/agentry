// agentry/src/invoke.mjs
// The single invoke() function.
// Every side-effect in agentry goes through here. No exceptions.
//
// invoke(capabilityId, input, context) → { ok: true, output, cost, ms } | { ok: false, error }

import { errors, ok, fail } from "./errors.mjs";

/**
 * The Invoker registry. An invoker is a function:
 *   async (capability, input, context) → { output, cost } | throws AgentryError
 *
 * A capability's `invoked_via` names an invoker. Invokers are registered here.
 * This registry is the ground truth for "how things actually get called."
 * Adding a new way to call things = registering a new invoker here.
 */
const INVOKERS = new Map();

export function registerInvoker(id, fn) {
  if (typeof fn !== "function") throw errors.internal(`invoker ${id} must be a function`);
  INVOKERS.set(id, fn);
}

export function listInvokers() {
  return Array.from(INVOKERS.keys());
}

/**
 * Invoke a capability. Never throws across the boundary — errors are data.
 *
 * @param {object} deps
 * @param {CapabilityGraph} deps.graph
 * @param {EventLog}        deps.events
 * @param {object}          deps.config
 * @param {string} capabilityId
 * @param {object} input
 * @param {object} context     — { task_id?, tenant?, deadline_ms?, by? }
 * @returns {Promise<{ ok:boolean, output?:any, error?:AgentryError, cost?:object, ms:number }>}
 */
export async function invoke(deps, capabilityId, input = {}, context = {}) {
  const { graph, events } = deps;
  const startedAt = Date.now();

  // 1. Resolve the capability
  const cap = graph.getCapability(capabilityId);
  if (!cap) {
    const err = errors.invalidCapability(capabilityId);
    events.emit("invoke.failed", { capability_id: capabilityId, code: err.code, task_id: context.task_id });
    return { ...fail(err), ms: Date.now() - startedAt };
  }

  // 2. Resolve the invoker
  const invokerFn = INVOKERS.get(cap.invoked_via);
  if (!invokerFn) {
    const err = errors.notImplemented(`invoker for ${cap.invoked_via} (needed by ${capabilityId})`);
    events.emit("invoke.failed", {
      capability_id: capabilityId,
      invoker: cap.invoked_via,
      code: err.code,
      task_id: context.task_id,
    });
    return { ...fail(err), ms: Date.now() - startedAt };
  }

  // 3. Emit start event
  events.emit("invoke.started", {
    capability_id: capabilityId,
    invoker: cap.invoked_via,
    task_id: context.task_id ?? null,
    tenant: context.tenant ?? null,
    input_keys: input && typeof input === "object" ? Object.keys(input) : [],
  });

  // 4. Dispatch
  let result;
  try {
    const raw = await invokerFn(cap, input, { ...context, config: deps.config, graph, events });
    result = { ...ok(raw?.output ?? raw), cost: raw?.cost ?? {} };
  } catch (e) {
    // Any throw becomes a structured error. Never leak raw exceptions up.
    if (e?.code && e?.message && e.constructor?.name === "AgentryError") {
      result = fail(e);
    } else {
      result = fail(errors.invokerFailed(cap.invoked_via, e, { capability_id: capabilityId }));
    }
  }

  const ms = Date.now() - startedAt;

  // 5. Update reliability (last-write-wins moving average; simple, honest)
  try {
    const prev = cap.reliability || { success_rate: null, p50_ms: null, p99_ms: null };
    const prevRuns = prev.runs || 0;
    const runs = prevRuns + 1;
    const successes = (prev.successes || 0) + (result.ok ? 1 : 0);
    const nextP50 =
      prev.p50_ms == null ? ms :
      Math.round((prev.p50_ms * prevRuns + ms) / runs);
    graph.putCapability({
      id: cap.id,
      reliability: {
        ...prev,
        runs,
        successes,
        success_rate: successes / runs,
        p50_ms: nextP50,
        p99_ms: prev.p99_ms == null ? ms : Math.max(prev.p99_ms, ms),
        last_run_at: Date.now(),
      },
    });
  } catch (e) {
    // Reliability bookkeeping must never break an invoke.
    events.emit("invoke.reliability_update_failed", { capability_id: capabilityId, error: e.message });
  }

  // 6. Emit finish event
  events.emit(result.ok ? "invoke.succeeded" : "invoke.failed", {
    capability_id: capabilityId,
    invoker: cap.invoked_via,
    task_id: context.task_id ?? null,
    code: result.ok ? null : result.error.code,
    ms,
  });

  return { ...result, ms };
}
