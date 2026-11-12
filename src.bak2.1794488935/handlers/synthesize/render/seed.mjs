// agentry/src/handlers/synthesize/render/seed.mjs
// v0.53.3 — extracted from agentry.synthesize.mjs.

export function renderSeed(spec, handlerPath) {
  const { capability } = spec;
  return {
    id: capability.id,
    kind: capability.kind,
    invoked_via: "invoker.in_process_js",
    handler: capability.id,
    handler_file: handlerPath,
    accepts: capability.accepts || {},
    produces: capability.produces || {},
    requires: capability.requires || {},
    plan: spec.plan || null,
    invoke_timeout_ms: Number(spec.invoke_timeout_ms) || 90000,
    source: "synthesized:agentry.synthesize",
    notes: "Auto-generated. Regenerate rather than edit. Plan is auditable.",
  };
}

// v0.23.1 — repair raw control characters inside JSON string literals.
// LLMs sometimes emit SKILL.md bodies with literal newlines inside a
// JSON string value; strict JSON.parse rejects that. Walk the text,
// track string boundaries, escape only inside strings.
