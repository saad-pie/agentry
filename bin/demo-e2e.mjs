#!/usr/bin/env node
// agentry/bin/demo-e2e.mjs
//
// End-to-end demo: a weak model is asked to fetch a URL. It cannot.
// Agentry reasons about the failure, synthesizes a capability if none
// exists, and the same weak model (via its caller) gets the result.
//
// Run: node bin/demo-e2e.mjs
//
// Uses llm.openai_compat directly (weak model), agentry.reason.deep
// (strong reasoner), agentry.synthesize + agentry.trial (pipeline),
// and the adopted capability (invocation).

const { Runtime } = await import("../src/runtime.mjs");
const rt = new Runtime(); await rt.boot();
rt.deps.invoke = (cap, input, ctx) => rt.invoke(cap, input, ctx);

const TASK_TEXT = "Take a screenshot of https://example.com and report the PNG byte size.";
const WEAK_MODEL = "allam-2-7b";
const CANDIDATE = {
  id: "node-fetch/node-fetch",
  kind: "repo",
  name: "node-fetch/node-fetch",
  url: "https://github.com/node-fetch/node-fetch",
  description: "A light-weight module that brings Fetch API to Node.js",
};

const line = (s) => console.log(s);
const step = (n, s) => { line(""); line("[" + n + "/5] " + s); };

line("=========== AGENTRY END-TO-END DEMO ===========");

// ── 1. Weak model alone ──
step(1, "weak model alone (" + WEAK_MODEL + ")");
const r1 = await rt.invoke("llm.openai_compat", {
  provider: "groq", model: WEAK_MODEL,
  messages: [{ role: "user", content: TASK_TEXT + " If you cannot do this, reply with exactly: I_CANNOT" }],
  temperature: 0.1, max_tokens: 200,
}, { tenant: "local", by: "demo" });
const baseline = r1.ok ? String(r1.output.content).trim().slice(0, 180) : "(LLM error)";
line("    baseline: " + JSON.stringify(baseline));

// ── 2. Reasoner diagnoses ──
step(2, "agentry.reason.deep diagnoses");
const r2 = await rt.invoke("agentry.reason.deep", {
  failure: "Model asked to fetch a URL and return status + body length. It replied: " + baseline,
  intent: TASK_TEXT,
  attempted: ["direct LLM prompt"],
}, { tenant: "local", by: "demo" });
if (!r2.ok) { line("    reasoner failed: " + JSON.stringify(r2.error).slice(0, 300)); process.exit(1); }
const o = r2.output;
line("    model_used:          " + o.model_used);
line("    analysis:            " + String(o.analysis || "").slice(0, 200));
line("    missing:             " + JSON.stringify(o.missing));
line("    existing_capability: " + JSON.stringify(o.existing_capability));

// ── 3. Capability already exists? ──
const target = (o.existing_capability && o.existing_capability.id)
  || (o.missing && o.missing.wanted_id);
if (!target) { line("    no capability named — aborting"); process.exit(0); }

step(3, "target capability: " + target);
let cap = rt.graph.getCapability(target);

if (!cap) {
  line("    does not exist — synthesizing");
  const proposalId = "proposal_demo_" + Date.now();
  rt.graph.putCapability({
    id: proposalId, kind: "proposal", state: "decided",
    gap_id: "gap:" + target,
    gap_wanted_kind: o.missing?.kind || "web",
    gap_wanted_id: target,
    analysis: { recommended_id: CANDIDATE.id, summary: "demo" },
    candidates: [CANDIDATE],
    decisions: { [CANDIDATE.id]: { decision: "approved", at: Date.now() } },
    created_at: Date.now(), updated_at: Date.now(),
  });

  const syn = await rt.invoke("agentry.synthesize", {
    proposal_id: proposalId, candidate_id: CANDIDATE.id,
  }, { tenant: "local", by: "demo" });
  line("    synthesize.ok:     " + syn.ok);
  if (!syn.ok) { line("    error: " + JSON.stringify(syn.error).slice(0, 400)); process.exit(1); }
  line("    capability_id:     " + syn.output.capability_id);
  line("    plan_steps:        " + syn.output.plan_steps);
  line("    plan verbs:        " + JSON.stringify(syn.output.spec.plan.map(p => p.verb)));
  line("    repo README chars: " + (syn.output.spec.plan ? "see events" : "n/a"));

  line("    running trial...");
  const trial = await rt.invoke("agentry.trial", {
    capability_id: syn.output.capability_id,
    handler_path: syn.output.handler_path,
    seed_path: syn.output.seed_path,
  }, { tenant: "local", by: "demo" });
  line("    trial.ok:          " + (trial.output?.ok === true));
  if (!trial.output?.ok) {
    line("    phase: " + (trial.output?.phase || "n/a"));
    line("    error: " + String(trial.output?.error || "").slice(0, 300));
    process.exit(1);
  }

  rt.graph.putCapability({
    id: syn.output.capability_id,
    kind: syn.output.kind,
    invoked_via: "invoker.in_process_js",
    handler: syn.output.capability_id,
    handler_file: syn.output.handler_path,
    accepts: syn.output.spec.capability.accepts || {},
    produces: syn.output.spec.capability.produces || {},
    requires: syn.output.spec.capability.requires || {},
    source: "demo:synthesized",
    trial: false,
    trial_passed_at: Date.now(),
  });
  if (typeof rt.graph.invalidateCache === "function") rt.graph.invalidateCache();
  cap = rt.graph.getCapability(syn.output.capability_id);
  line("    adopted:           " + cap.id + " (" + cap.kind + ")");
}

// ── 4. Invoke the capability ──
step(4, "invoking " + target + " from a cold session");
const cold = "demo-cold-" + Date.now();
const input = { session: cold };
const accepts = cap.accepts || {};
if (accepts.url) input.url = "https://example.com";
if (accepts.timeout_ms) input.timeout_ms = 15000;
line("    input: " + JSON.stringify(input));
const r4 = await rt.invoke(target, input, { tenant: "local", by: "demo" });
line("    ok: " + r4.ok);
if (r4.ok) {
  const out = r4.output || {};
  line("    status: " + (out.status ?? "(none)"));
  line("    bytes:  " + (out.bytes ?? out.body_length ?? "(none)"));
  line("    keys:   " + JSON.stringify(Object.keys(out)).slice(0, 200));
} else {
  line("    error: " + JSON.stringify(r4.error).slice(0, 400));
}

// ── 5. Summary ──
step(5, "summary");
line("    weak alone:         " + baseline);
line("    weak + agentry:     " + (r4.ok ? "succeeded via " + target : "FAILED"));
line("    capability source:  " + (cap.source || "unknown"));
line("");
line("=========== DEMO END ===========");
