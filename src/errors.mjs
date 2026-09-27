// agentry/src/errors.mjs
// The error envelope. Every failure in the system flows through this shape.
// Matches AgentSky's convention: { error: { code, message } }

export class AgentryError extends Error {
  constructor(code, message, meta = {}) {
    super(message);
    this.name = "AgentryError";
    this.code = code;
    this.meta = meta;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(Object.keys(this.meta).length ? { meta: this.meta } : {}),
      },
    };
  }
}

// --- Error codes ---
// These are *codes*, not kinds. They're stable enough to be a closed set
// because they describe the transport/invocation layer, not the capabilities.
// A capability can *say* it failed with a code, but the code universe is here.

export const CODES = {
  // Request/input shape
  INVALID_REQUEST: "invalid_request",         // malformed input to invoke()
  INVALID_CAPABILITY: "invalid_capability",   // capability_id not in graph
  INVALID_STATE: "invalid_state",             // task not in a state that allows this
  INVALID_SPEC: "invalid_spec",               // capability's accepts/produces rejected input

  // Auth/scope
  FORBIDDEN: "forbidden",                     // capability not allowed for this tenant/task

  // Budget/limits
  INSUFFICIENT_BUDGET: "insufficient_budget", // out of tokens, time, or cost
  RATE_LIMITED: "rate_limited",               // source-side limit hit (respect Retry-After if present)

  // Resolution
  NOT_FOUND: "not_found",                     // capability exists in graph but invoker can't reach it

  // Concurrency
  CONFLICT: "conflict",                       // version mismatch, concurrent write
  STALE: "stale",                             // expectedVersion did not match

  // Invocation failures
  INVOKER_FAILED: "invoker_failed",           // the invoker itself threw before the capability ran
  CAPABILITY_FAILED: "capability_failed",     // the capability ran and reported failure

  // Discovery
  DISCOVERY_FAILED: "discovery_failed",       // a discovery source couldn't be reached
  ADOPTION_REJECTED: "adoption_rejected",     // candidate failed trial

  // System
  INTERNAL: "internal",                       // unexpected; always logged with stack
  NOT_IMPLEMENTED: "not_implemented",         // path exists in design, not yet in code
};

// --- Convenience constructors ---
// These are the ONLY ways code should create errors. No `new Error()` elsewhere.

export const errors = {
  invalidRequest: (message, meta) => new AgentryError(CODES.INVALID_REQUEST, message, meta),
  invalidCapability: (id, meta) => new AgentryError(CODES.INVALID_CAPABILITY, `capability not found: ${id}`, { capability_id: id, ...meta }),
  invalidState: (taskId, state, wanted, meta) => new AgentryError(CODES.INVALID_STATE, `task ${taskId} is in state "${state}", expected ${wanted}`, { task_id: taskId, state, wanted, ...meta }),
  invalidSpec: (id, reason, meta) => new AgentryError(CODES.INVALID_SPEC, `capability ${id} rejected input: ${reason}`, { capability_id: id, ...meta }),
  forbidden: (id, why, meta) => new AgentryError(CODES.FORBIDDEN, `capability ${id} not allowed: ${why}`, { capability_id: id, ...meta }),
  insufficientBudget: (taskId, what, meta) => new AgentryError(CODES.INSUFFICIENT_BUDGET, `task ${taskId} exhausted: ${what}`, { task_id: taskId, what, ...meta }),
  rateLimited: (source, retryAfterMs, meta) => new AgentryError(CODES.RATE_LIMITED, `rate limited by ${source}`, { source, retry_after_ms: retryAfterMs, ...meta }),
  notFound: (what, meta) => new AgentryError(CODES.NOT_FOUND, `not found: ${what}`, meta),
  conflict: (what, meta) => new AgentryError(CODES.CONFLICT, `conflict: ${what}`, meta),
  stale: (what, expected, got, meta) => new AgentryError(CODES.STALE, `stale write: expected ${expected}, got ${got}`, { what, expected, got, ...meta }),
  invokerFailed: (invokerId, cause, meta) => new AgentryError(CODES.INVOKER_FAILED, `invoker ${invokerId} failed: ${cause?.message || cause}`, { invoker_id: invokerId, cause: cause?.message, ...meta }),
  capabilityFailed: (id, reason, meta) => new AgentryError(CODES.CAPABILITY_FAILED, `capability ${id} failed: ${reason}`, { capability_id: id, ...meta }),
  discoveryFailed: (source, cause, meta) => new AgentryError(CODES.DISCOVERY_FAILED, `discovery source ${source} failed: ${cause?.message || cause}`, { source, cause: cause?.message, ...meta }),
  adoptionRejected: (id, reason, meta) => new AgentryError(CODES.ADOPTION_REJECTED, `adoption of ${id} rejected: ${reason}`, { capability_id: id, ...meta }),
  internal: (message, meta) => new AgentryError(CODES.INTERNAL, message, meta),
  notImplemented: (what, meta) => new AgentryError(CODES.NOT_IMPLEMENTED, `not implemented: ${what}`, meta),
};

// --- Invoke result helper ---
// Every invoke() returns one of these. Never throws across the boundary —
// errors are data, so the caller can decide whether to retry, hand off, or fail.
export function ok(output, extra = {}) {
  return { ok: true, output, ...extra };
}
export function fail(error) {
  // Ensure it's an AgentryError; wrap anything else.
  if (!(error instanceof AgentryError)) {
    error = errors.internal(error?.message || String(error), { cause: error?.stack });
  }
  return { ok: false, error };
}
