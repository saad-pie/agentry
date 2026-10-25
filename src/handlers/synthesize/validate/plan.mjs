// agentry/src/handlers/synthesize/validate/plan.mjs
// v0.53.3 — extracted from agentry.synthesize.mjs.

export function validatePlan(plan, shape, capability_id) {
  if (!Array.isArray(plan)) {
    throw new Error("agentry.synthesize: spec.plan is not an array (" + capability_id + ")");
  }
  if (plan.length !== shape.steps.length) {
    throw new Error(
      "agentry.synthesize: plan length " + plan.length +
      " does not match shape length " + shape.steps.length +
      " for " + capability_id
    );
  }
  for (let i = 0; i < shape.steps.length; i++) {
    const entry = plan[i];
    const expectedVerb = shape.steps[i].verb;
    if (!entry || typeof entry !== "object") {
      throw new Error("agentry.synthesize: plan[" + i + "] is not an object");
    }
    if (entry.verb !== expectedVerb) {
      throw new Error(
        "agentry.synthesize: plan[" + i + "].verb \"" + entry.verb +
        "\" does not match shape verb \"" + expectedVerb + "\""
      );
    }
    if (!entry.what || typeof entry.what !== "string" || !entry.what.trim()) {
      throw new Error("agentry.synthesize: plan[" + i + "] (" + expectedVerb + ") missing 'what'");
    }
    if (!entry.code || typeof entry.code !== "string" || !entry.code.trim()) {
      throw new Error("agentry.synthesize: plan[" + i + "] (" + expectedVerb + ") missing 'code'");
    }
  }
}

// v0.17.7 — spec consistency. Cross-references the four sections that
// must agree: plan code, env_map, accept_spec, produces.
