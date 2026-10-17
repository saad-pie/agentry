// agentry/src/handlers/agentry.mature.mjs
// v0.28.0 — surgical mutation.
//
// Prior versions asked the LLM to return a full plan spec, then rendered
// it from scratch. For narrow rubrics (add a title, force a page break),
// the LLM re-derived v1's working steps each time and re-introduced bugs
// (Buffer.from(undefined), WinAnsi newline, pdfBytes never set). Three
// attempts v69/v72/v77 all failed the same way.
//
// v0.28.0 flips the contract: LLM returns MUTATIONS against v1's plan.
// agentry applies them; un-mutated steps are byte-for-byte v1. The LLM
// cannot break working code because it never touches it.

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreOutput } from "../runtime/quality.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HANDLERS_DIR = process.env.AGENTRY_HANDLERS_DIR || "/tmp/home/.dsh/agentry-synthesized/handlers";
const SEEDS_DIR = process.env.AGENTRY_SEEDS_DIR || "/tmp/home/.dsh/agentry-synthesized/seeds";
const INSTALLER_PATH = join(HERE, "..", "runtime", "installer.mjs").replace(/\\/g, "/");

const MODEL_CHAIN = [
  { provider: "groq", model: "openai/gpt-oss-120b" },
  { provider: "groq", model: "openai/gpt-oss-20b" },
  { provider: "groq", model: "qwen/qwen3.8-27b" },
  { provider: "google", model: "gemini-2.5-flash" },
];

function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  const body = s.slice(first, last + 1);
  try { return JSON.parse(body); } catch {}
  let out = "", inStr = false, esc = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (esc) { out += c; esc = false; continue; }
    if (inStr && c === "\\") { out += c; esc = true; continue; }
    if (c === '"') { out += c; inStr = !inStr; continue; }
    if (inStr && c === "\n") { out += "\\n"; continue; }
    if (inStr && c === "\r") { out += "\\r"; continue; }
    if (inStr && c === "\t") { out += "\\t"; continue; }
    out += c;
  }
  try { return JSON.parse(out); } catch { return null; }
}

// Apply mutation list to a plan. Deep-clones v1 plan; mutations only
// add/replace/remove steps; untouched steps stay verbatim.
function applyMutations(v1Plan, mutations) {
  const plan = v1Plan.map(s => ({ ...s }));
  const log = [];
  for (const m of mutations) {
    if (!m || typeof m !== "object" || !m.type) { log.push({ skipped: "no_type", m }); continue; }
    if (m.type === "insert_after") {
      const afterIdx = plan.findIndex(s => Number(s.step) === Number(m.after_step));
      if (afterIdx < 0) { log.push({ skipped: "after_step_not_found", step: m.after_step, mutation: m }); continue; }
      plan.splice(afterIdx + 1, 0, { ...(m.step || {}), step: 0 });
      log.push({ applied: "insert_after", after: m.after_step });
    } else if (m.type === "append") {
      plan.push({ ...(m.step || {}), step: 0 });
      log.push({ applied: "append" });
    } else if (m.type === "replace_step") {
      const idx = plan.findIndex(s => Number(s.step) === Number(m.step_to_replace));
      if (idx < 0) { log.push({ skipped: "replace_target_not_found", step: m.step_to_replace, mutation: m }); continue; }
      const prev = plan[idx];
      plan[idx] = { ...(m.step || {}), verb: (m.step && m.step.verb) || prev.verb, step: prev.step };
      log.push({ applied: "replace_step", step: m.step_to_replace });
    } else if (m.type === "remove_step") {
      const idx = plan.findIndex(s => Number(s.step) === Number(m.step_to_remove));
      if (idx >= 0) { plan.splice(idx, 1); log.push({ applied: "remove_step", step: m.step_to_remove }); }
      else { log.push({ skipped: "remove_target_not_found", step: m.step_to_remove, mutation: m }); }
    } else {
      log.push({ skipped: "unknown_type", type: m.type });
    }
  }
  for (let i = 0; i < plan.length; i++) plan[i].step = i + 1;
  return { plan, log };
}

function buildMutationPrompt({ cap, v1Plan, v1Seed, v1Quality, rubric }) {
  const lines = [];
  lines.push("You are agentry's maturation synthesizer (MUTATION MODE).");
  lines.push("");
  lines.push("The capability already exists and works. v1's PLAN is shown below.");
  lines.push("You MUST return MUTATIONS against that plan, not a full new plan.");
  lines.push("Untouched steps stay byte-for-byte v1 — you cannot break them.");
  lines.push("");
  lines.push("=== CAPABILITY ===");
  lines.push(JSON.stringify({ id: cap.id, kind: cap.kind, accepts: cap.accepts, produces: cap.produces, requires: cap.requires }, null, 2));
  lines.push("");
  lines.push("=== V1 PLAN (working steps — do NOT re-derive these) ===");
  lines.push(JSON.stringify(v1Plan.map(s => ({ step: s.step, verb: s.verb, what: s.what || "", fails_if: s.fails_if || "", code: s.code || "" })), null, 2));
  lines.push("");
  lines.push("=== V1 QUALITY (baseline to beat) ===");
  lines.push(JSON.stringify(v1Quality, null, 2));
  lines.push("");
  lines.push("=== RUBRIC — what v2 must improve ===");
  lines.push(String(rubric));
  lines.push("");
  lines.push("=== MUTATION TYPES (choose the ones that implement the rubric) ===");
  lines.push("- insert_after: add a new step after step N (use for new behaviour)");
  lines.push("- replace_step: rewrite step N in place (use only if step N itself is wrong)");
  lines.push("- append: add a step at the very end (use for final emit changes, rare)");
  lines.push("- remove_step: delete step N (rare)");
  lines.push("");
  lines.push("=== CRITICAL RULES ===");
  lines.push("- Do NOT re-implement v1's existing steps. Only add/replace/remove as needed.");
  lines.push("- Each `step.code` is raw JavaScript (or Python if v1 kernel_language is python).");
  lines.push("  - Node: plain JS, no JSX, no TS. Use `await import(...)` for npm packages.");
  lines.push("  - State between steps: `globalThis.X = ...` in one step, `globalThis.X` in later steps.");
  lines.push("  - Env vars: `process.env.IMAGE_PATH` style (already mapped for v1's accepts).");
  lines.push("- pdf-lib StandardFonts (Helvetica, Helvetica-Bold) CANNOT encode newlines.");
  lines.push("  If drawing text, split by newlines and call drawText per line.");
  lines.push("- Each new step MUST have verb, what, fails_if, code.");
  lines.push("");
  lines.push("=== OUTPUT SHAPE ===");
  lines.push(JSON.stringify({
    mutations: [
      { type: "insert_after", after_step: 2, step: { verb: "draw_title", what: "...", fails_if: "...", code: "..." } },
    ],
    reasoning: "one sentence",
  }, null, 2));
  return lines.join("\n");
}

// Auto-derive env_map from plan code + accepts keys.
function autoDeriveEnvMap(spec, v1Cap) {
  const accepts = v1Cap.accepts || {};
  const existing = (spec.glue && spec.glue.env_map) || {};
  const derived = { ...existing };
  const lookup = {};
  for (const k of Object.keys(accepts)) {
    lookup[k.toUpperCase().replace(/[^A-Z0-9]/g, "_")] = k;
    lookup[k] = k;
  }
  const envVars = new Set();
  for (const step of spec.plan || []) {
    const code = String(step.code || "");
    for (const m of code.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) envVars.add(m[1]);
    for (const m of code.matchAll(/process\.env\[["']([A-Za-z_][A-Za-z0-9_]*)["']\]/g)) envVars.add(m[1]);
  }
  const added = [];
  for (const v of envVars) {
    if (derived[v]) continue;
    const match = lookup[v] || lookup[v.toLowerCase()];
    if (match) { derived[v] = match; added.push([v, match]); }
  }
  spec.glue = spec.glue || {};
  spec.glue.env_map = derived;
  return { env_map: derived, added };
}

function compileJS(plan) {
  const parts = [];
  parts.push("(async () => {");
  for (const step of plan) {
    parts.push("");
    parts.push("  // -- step " + step.step + ": " + step.verb + " --");
    if (step.what) parts.push("  // " + String(step.what).replace(/\n/g, "\n  // "));
    const code = String(step.code || "").trim();
    if (code) for (const line of code.split("\n")) parts.push("  " + line);
  }
  parts.push("");
  parts.push("})().catch(e => { console.error(String((e && e.stack) || e)); process.exit(1); });");
  return parts.join("\n");
}

function compilePY(plan) {
  const parts = ["# generated by agentry.mature", "import sys", ""];
  for (const step of plan) {
    parts.push("# -- step " + step.step + ": " + step.verb + " --");
    const code = String(step.code || "").trim();
    if (code) parts.push(code);
    parts.push("");
  }
  return parts.join("\n");
}

function renderV2Handler({ v2Id, v1Cap, spec }) {
  const lang = spec.kernel_language === "python" ? "python" : "node";
  const action = lang === "python" ? "python.run" : "node.run";
  const o = [];
  o.push("// agentry — matured handler for " + v2Id);
  o.push("// Maturation of " + v1Cap.id + ". Regenerate, do not hand-edit.");
  o.push("");
  o.push("const CAP_ID = " + JSON.stringify(v2Id) + ";");
  o.push("const CAP_KIND = " + JSON.stringify(v1Cap.kind) + ";");
  o.push("const ACCEPTS = " + JSON.stringify(v1Cap.accepts || {}, null, 2) + ";");
  o.push("const PRODUCES = " + JSON.stringify(v1Cap.produces || {}, null, 2) + ";");
  o.push("const REQUIRES = " + JSON.stringify(v1Cap.requires || {}, null, 2) + ";");
  o.push("const ENV_MAP = " + JSON.stringify((spec.glue && spec.glue.env_map) || {}, null, 2) + ";");
  o.push("const OUTPUT_MAP = " + JSON.stringify((spec.glue && spec.glue.output_map) || {}, null, 2) + ";");
  o.push("const RESULT_PARSE = " + JSON.stringify((spec.glue && spec.glue.result_parse) || "stdout_json") + ";");
  o.push("const KERNEL_ACTION = " + JSON.stringify(action) + ";");
  const compiled = lang === "python" ? compilePY(spec.plan) : compileJS(spec.plan);
  o.push("const KERNEL_SCRIPT = " + JSON.stringify(compiled) + ";");
  o.push("const DEFAULT_TIMEOUT_MS = 90000;");
  o.push("");
  o.push("export const capability = { id: CAP_ID, kind: CAP_KIND, invoked_via: \"invoker.in_process_js\", accepts: ACCEPTS, produces: PRODUCES, requires: REQUIRES };");
  o.push("");
  o.push("export async function accept(deps, opts = {}) {");
  o.push("  const session = opts.session || (CAP_ID + \"-accept-test\");");
  o.push("  const { prepareSession } = await import(" + JSON.stringify(INSTALLER_PATH) + ");");
  o.push("  await prepareSession(deps, { capId: CAP_ID, session });");
  o.push("  const probe = await run(" + JSON.stringify((spec.accept_spec && spec.accept_spec.input) || {}) + ", deps, { session });");
  o.push("  const out = probe.output || probe;");
  o.push("  if (out.status === \"awaiting_input\") throw new Error(\"accept: awaiting_input is not a trial pass\");");
  o.push("  return { ok: true, session, output: out };");
  o.push("}");
  o.push("");
  o.push("async function run(input, ctx, opts = {}) {");
  o.push("  const session = opts.session || input.session || (CAP_ID + \"-default\");");
  o.push("  const { prepareSession } = await import(" + JSON.stringify(INSTALLER_PATH) + ");");
  o.push("  await prepareSession(ctx, { capId: CAP_ID, session });");
  o.push("  await ctx.invoke(\"agentry.os\", { action: \"session.create\", id: session }, { tenant: \"local\", by: CAP_ID });");
  o.push("  const env = {};");
  o.push("  for (const [envKey, inputKey] of Object.entries(ENV_MAP)) {");
  o.push("    const v = input[inputKey];");
  o.push("    env[envKey] = v === undefined || v === null ? \"\" : String(v);");
  o.push("  }");
  o.push("  const res = await ctx.invoke(\"agentry.os\", { action: KERNEL_ACTION, session, code: KERNEL_SCRIPT, env, timeout_ms: DEFAULT_TIMEOUT_MS }, { tenant: \"local\", by: CAP_ID });");
  o.push("  if (!res.ok) throw new Error(CAP_ID + \": kernel failed — \" + res.error.code + \": \" + res.error.message);");
  o.push("  const r = res.output.result || res.output;");
  o.push("  const exitCode = r.exit_code ?? r.exitCode ?? 0;");
  o.push("  if (exitCode !== 0) throw new Error(CAP_ID + \": kernel exited \" + exitCode + \" — \" + String(r.stderr || \"\").slice(0, 300));");
  o.push("  const stdout = String(r.stdout || \"\");");
  o.push("  if (!stdout.trim()) throw new Error(CAP_ID + \": kernel produced no output\");");
  o.push("  let raw;");
  o.push("  if (RESULT_PARSE === \"stdout_json\") {");
  o.push("    try { raw = JSON.parse(stdout); } catch (e) { throw new Error(CAP_ID + \": stdout not JSON — \" + e.message); }");
  o.push("  } else { raw = stdout.trim(); }");
  o.push("  const output = {};");
  o.push("  for (const [outKey, path] of Object.entries(OUTPUT_MAP)) {");
  o.push("    let v = raw;");
  o.push("    for (const p of String(path).split(\".\")) v = v?.[p];");
  o.push("    output[outKey] = v;");
  o.push("  }");
  o.push("  if (output.bytes === undefined) output.bytes = typeof raw === \"string\" ? Buffer.byteLength(raw) : JSON.stringify(raw).length;");
  o.push("  if (output.status === undefined) output.status = \"complete\";");
  o.push("  output.captured_at = Date.now();");
  o.push("  return { output, cost: { time_ms: r.ms || 0 } };");
  o.push("}");
  o.push("");
  o.push("export default run;");
  return o.join("\n");
}

export default async function agentryMature(input, ctx) {
  const { capability_id, rubric, probe_input } = input || {};
  if (!capability_id) throw new Error("agentry.mature requires capability_id");
  if (!rubric || String(rubric).trim().length < 20) {
    throw new Error("agentry.mature requires a rubric of at least 20 chars");
  }

  const { graph, events, invoke } = ctx;
  const cap = graph.getCapability(capability_id);
  if (!cap) throw new Error("agentry.mature: capability not found: " + capability_id);
  if (!cap.handler_file || !existsSync(cap.handler_file)) {
    throw new Error("agentry.mature: capability has no handler_file on disk: " + capability_id);
  }

  const v1SeedPath = cap.handler_file.replace("/handlers/", "/seeds/").replace(/\.mjs$/, ".json");
  let v1Seed = null;
  if (existsSync(v1SeedPath)) { try { v1Seed = JSON.parse(readFileSync(v1SeedPath, "utf8")); } catch {} }

  // v0.28.0 — MUST have a plan spec for surgical mutation
  const v1Plan = v1Seed && Array.isArray(v1Seed.plan) ? v1Seed.plan : null;
  if (!v1Plan || v1Plan.length === 0) {
    return {
      output: {
        matured: false,
        reason: "v1_capability_has_no_plan_spec",
        note: "Surgical mutation requires v1 seed to contain a plan array. Hand-written handlers (like pdf.render) cannot be matured via this path. Synthesized capabilities can.",
        v1_seed_path: v1SeedPath,
        v1_seed_has_plan: Boolean(v1Seed && v1Seed.plan),
      },
      cost: { time_ms: 0 },
    };
  }

  const probeIn = probe_input && typeof probe_input === "object"
    ? probe_input
    : (v1Seed && v1Seed.accept_spec && v1Seed.accept_spec.input) || {};

  if (!probeIn || Object.keys(probeIn).length === 0) {
    return { output: { matured: false, reason: "no_probe_input", capability_id }, cost: { time_ms: 0 } };
  }

  events.emit("mature.started", { capability_id, rubric: String(rubric).slice(0, 200), mode: "surgical_mutation", v1_plan_steps: v1Plan.length });

  // Score v1 with a fresh invoke
  let v1Quality = null;
  try {
    const r = await invoke(capability_id, probeIn, { tenant: "local", by: "agentry.mature" });
    if (!r.ok) {
      return { output: { matured: false, reason: "v1_invoke_failed", v1_error: r.error }, cost: { time_ms: 0 } };
    }
    v1Quality = await scoreOutput(cap, r.output);
  } catch (e) {
    return { output: { matured: false, reason: "v1_probe_threw", v1_error: e.message }, cost: { time_ms: 0 } };
  }
  events.emit("mature.v1_scored", { capability_id, v1_quality: v1Quality });

  // Mutation prompt
  const prompt = buildMutationPrompt({ cap, v1Plan, v1Seed, v1Quality, rubric: String(rubric) });
  let mutationResponse = null, llmUsed = null;
  const attempts = [];
  for (const { provider, model } of MODEL_CHAIN) {
    try {
      const r = await invoke("llm.openai_compat", {
        provider, model,
        messages: [
          { role: "system", content: "You output only JSON. No prose. No fences." },
          { role: "user", content: prompt },
        ],
        temperature: 0.15, max_tokens: 4000,
      }, { tenant: "local", by: "agentry.mature" });
      attempts.push({ provider, model, ok: r.ok, code: r.ok ? null : r.error?.code });
      if (!r.ok) continue;
      const parsed = extractJson(r.output.content);
      if (parsed && Array.isArray(parsed.mutations) && parsed.mutations.length > 0) {
        mutationResponse = parsed;
        llmUsed = { provider, model };
        break;
      }
      attempts[attempts.length - 1].reason = "unparseable_or_no_mutations";
    } catch (e) { attempts.push({ provider, model, ok: false, error: e.message }); }
  }
  if (!mutationResponse) {
    return { output: { matured: false, reason: "llm_failed", attempts, v1_quality: v1Quality }, cost: { time_ms: 0 } };
  }

  // Apply mutations to v1 plan
  const { plan: v2Plan, log: mutationLog } = applyMutations(v1Plan, mutationResponse.mutations);
  if (v2Plan.length === v1Plan.length && mutationLog.every(l => l.skipped)) {
    return {
      output: {
        matured: false,
        reason: "no_mutations_applied",
        mutation_log: mutationLog,
        raw_mutations_from_llm: mutationResponse.mutations,
        llm_reasoning: mutationResponse.reasoning || null,
        v1_plan_steps: v1Plan.length,
        v1_plan_step_numbers: v1Plan.map(s => s.step),
        v1_quality: v1Quality,
      },
      cost: { time_ms: 0 },
    };
  }
  events.emit("mature.mutations_applied", { capability_id, mutation_log: mutationLog, v1_plan_steps: v1Plan.length, v2_plan_steps: v2Plan.length });

  // Build v2 spec: mutated plan + preserved v1 fields
  const v2Spec = {
    type: "plan",
    capability: { id: cap.id, kind: cap.kind, accepts: cap.accepts, produces: cap.produces, requires: cap.requires },
    plan: v2Plan,
    accept_spec: { input: probeIn },
    kernel_language: (v1Seed && v1Seed.kernel_language) || "node",
    glue: {
      env_map: (v1Seed && v1Seed.glue && v1Seed.glue.env_map) || {},
      result_parse: (v1Seed && v1Seed.glue && v1Seed.glue.result_parse) || "stdout_json",
      output_map: (v1Seed && v1Seed.glue && v1Seed.glue.output_map) ||
        Object.fromEntries(Object.keys(cap.produces || {}).map(k => [k, k])),
    },
  };

  const _deriveResult = autoDeriveEnvMap(v2Spec, cap);
  if (_deriveResult.added.length > 0) {
    events.emit("mature.env_map_derived", { capability_id, added: _deriveResult.added });
  }

  const v2Id = capability_id + "__v" + (cap.version + 1);
  const v2HandlerPath = join(HANDLERS_DIR, v2Id + ".mjs");
  const v2SeedPath = join(SEEDS_DIR, v2Id + ".json");
  mkdirSync(HANDLERS_DIR, { recursive: true });
  mkdirSync(SEEDS_DIR, { recursive: true });
  writeFileSync(v2HandlerPath, renderV2Handler({ v2Id, v1Cap: cap, spec: v2Spec }));
  const v2Seed = {
    id: v2Id, kind: cap.kind, invoked_via: "invoker.in_process_js",
    handler: v2Id, handler_file: v2HandlerPath,
    accepts: cap.accepts, produces: cap.produces, requires: cap.requires,
    plan: v2Plan, accept_spec: { input: probeIn },
    kernel_language: v2Spec.kernel_language,
    glue: v2Spec.glue,
    source: "matured:" + capability_id,
    maturation_mutations: mutationResponse.mutations,
    maturation_reasoning: mutationResponse.reasoning || null,
  };
  writeFileSync(v2SeedPath, JSON.stringify(v2Seed, null, 2));

  const { spawnSync } = await import("node:child_process");
  const chk = spawnSync("node", ["--check", v2HandlerPath], { encoding: "utf8", timeout: 15000 });
  if (chk.status !== 0) {
    events.emit("mature.v2_syntax_failed", { capability_id, v2_id: v2Id, stderr: String(chk.stderr || "").slice(0, 500) });
    return { output: { matured: false, reason: "v2_syntax_invalid", v2_handler: v2HandlerPath, stderr: String(chk.stderr || "").slice(0, 400), v1_quality: v1Quality, mutation_log: mutationLog }, cost: { time_ms: 0 } };
  }

  const trial = await invoke("agentry.trial", {
    capability_id: v2Id, handler_path: v2HandlerPath, seed_path: v2SeedPath,
  }, { tenant: "local", by: "agentry.mature" });
  if (!trial.ok || !trial.output?.ok) {
    events.emit("mature.v2_trial_failed", { capability_id, v2_id: v2Id, phase: trial.output?.phase, error: trial.output?.error });
    return { output: { matured: false, reason: "v2_trial_failed", v2_id: v2Id, v2_handler: v2HandlerPath, phase: trial.output?.phase, error: trial.output?.error, v1_quality: v1Quality, mutation_log: mutationLog }, cost: { time_ms: 0 } };
  }

  let v2Quality = null;
  try {
    const r = await invoke(v2Id, probeIn, { tenant: "local", by: "agentry.mature" });
    if (!r.ok) {
      return { output: { matured: false, reason: "v2_invoke_failed", v2_error: r.error, v1_quality: v1Quality, mutation_log: mutationLog }, cost: { time_ms: 0 } };
    }
    v2Quality = await scoreOutput(cap, r.output);
  } catch (e) {
    return { output: { matured: false, reason: "v2_probe_threw", v2_error: e.message, v1_quality: v1Quality, mutation_log: mutationLog }, cost: { time_ms: 0 } };
  }

  const delta = v2Quality.score - v1Quality.score;
  events.emit("mature.v2_scored", { capability_id, v2_id: v2Id, v1_quality: v1Quality, v2_quality: v2Quality, delta });

  if (delta <= 0) {
    try { graph.retireCapability(v2Id, "maturation did not improve (delta=" + delta + ")"); } catch {}
    return { output: { matured: false, reason: "v2_quality_not_higher", v1_quality: v1Quality, v2_quality: v2Quality, delta, mutation_log: mutationLog }, cost: { time_ms: 0 } };
  }

  const v1HandlerFile = cap.handler_file;
  graph.putCapability({
    id: capability_id, kind: cap.kind, invoked_via: "invoker.in_process_js",
    handler: v2Id, handler_file: v2HandlerPath,
    accepts: cap.accepts, produces: cap.produces, requires: cap.requires,
    v1_handler_file: v1HandlerFile,
    v1_quality: v1Quality, v2_quality: v2Quality,
    matured_at: Date.now(),
    maturation_rubric: String(rubric).slice(0, 500),
    maturation_mutations: mutationResponse.mutations,
    model_used: llmUsed ? (llmUsed.provider + "/" + llmUsed.model) : null,
  });

  events.emit("mature.adopted", {
    capability_id, v1_handler_file: v1HandlerFile, v2_handler_file: v2HandlerPath,
    delta, v1_quality: v1Quality, v2_quality: v2Quality,
    model_used: llmUsed ? (llmUsed.provider + "/" + llmUsed.model) : null,
  });

  return {
    output: {
      matured: true, capability_id, v2_id: v2Id,
      v1_handler_file: v1HandlerFile, v2_handler_file: v2HandlerPath,
      v1_quality: v1Quality, v2_quality: v2Quality, delta,
      mutation_log: mutationLog,
      model_used: llmUsed ? (llmUsed.provider + "/" + llmUsed.model) : null,
    },
    cost: { time_ms: 0 },
  };
}
