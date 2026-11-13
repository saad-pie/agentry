// agentry/src/handlers/agentry.build_from_plan.mjs
// v0.58.6 — strong-model fast path. DSH writes the plan, agentry wraps + trials.

import { writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const HANDLERS_DIR = process.env.AGENTRY_HANDLERS_DIR || "/tmp/home/.dsh/agentry-synthesized/handlers";
const SEEDS_DIR = process.env.AGENTRY_SEEDS_DIR || "/tmp/home/.dsh/agentry-synthesized/seeds";

function sanitizeId(id) {
  return String(id || "task_" + Date.now()).toLowerCase().replace(/^gap:/, "").replace(/[^a-z0-9_.-]+/g, "_").slice(0, 80);
}

function deriveEnvMap(accepts) {
  const map = {};
  for (const k of Object.keys(accepts || {})) map[k.toUpperCase()] = k;
  return map;
}

function renderHandlerFromPlan(spec) {
  const { capability, plan, glue } = spec;
  const lang = ["python", "rust", "go", "java", "dotnet"].includes(spec.kernel_language)
    ? spec.kernel_language : "node";
  const action = lang === "python" ? "python.run"
    : lang === "rust" ? "rust.run"
    : lang === "go" ? "go.run"
    : lang === "java" ? "java.run"
    : lang === "dotnet" ? "dotnet.run"
    : "node.run";

  const parts = [];
  if (lang === "node") {
    parts.push('globalThis.input = (() => { try { return JSON.parse(process.env.__AGENTRY_INPUT_JSON || "{}"); } catch { return {}; } })();');
    parts.push("(async () => {");
    for (const step of plan) {
      const code = String(step.code || "").trim();
      parts.push("  { // step " + (step.step || step.verb));
      if (step.verb) parts.push("    // BEGIN " + step.verb);
      parts.push(code.split("\n").map(l => "    " + l).join("\n"));
      parts.push("    // END " + (step.verb || ""));
      parts.push("  }");
    }
    parts.push("})().catch(e => { console.error(String((e && e.stack) || e)); process.exit(1); });");
  } else {
    for (const step of plan) {
      parts.push(String(step.code || "").trim());
      parts.push("");
    }
  }
  const script = parts.join("\n");

  const envMap = glue && glue.env_map ? glue.env_map : deriveEnvMap(capability.accepts);
  const requires = capability.requires || { npm: [], pip: [], post_install: null, capability: [] };

  const out = [];
  out.push("// agentry — handler from DSH plan for " + capability.id);
  out.push("// v0.58.6 — built via agentry.build_from_plan (strong-model fast path)");
  out.push("");
  out.push("const CAP_ID = " + JSON.stringify(capability.id) + ";");
  out.push("const CAP_KIND = " + JSON.stringify(capability.kind || "tool") + ";");
  out.push("const ACCEPTS = " + JSON.stringify(capability.accepts || {}, null, 2) + ";");
  out.push("const PRODUCES = " + JSON.stringify(capability.produces || {}, null, 2) + ";");
  out.push("const REQUIRES = " + JSON.stringify(requires, null, 2) + ";");
  out.push("const ENV_MAP = " + JSON.stringify(envMap, null, 2) + ";");
  out.push("const KERNEL_SCRIPT = " + JSON.stringify(script) + ";");
  out.push("const KERNEL_ACTION = " + JSON.stringify(action) + ";");
  out.push("const DEFAULT_TIMEOUT_MS = 90000;");
  out.push("");
  out.push("export const capability = { id: CAP_ID, kind: CAP_KIND, invoked_via: \"invoker.in_process_js\", accepts: ACCEPTS, produces: PRODUCES, requires: REQUIRES };");
  out.push("");
  out.push("async function run(input, ctx, opts = {}) {");
  out.push("  const session = opts.session || input.session || (CAP_ID + \"-default\");");
  out.push("  if (typeof ctx.invoke !== \"function\") throw new Error(CAP_ID + \" requires ctx.invoke\");");
  out.push("  const { prepareSession } = await import(\"/tmp/home/.dsh/node_modules/agentry/src/runtime/installer.mjs\");");
  out.push("  await prepareSession(ctx, { capId: CAP_ID, session, requires_override: REQUIRES });");
  out.push("  await ctx.invoke(\"agentry.os\", { action: \"session.create\", id: session });");
  out.push("  const env = {};");
  out.push("  for (const [envKey, inputKey] of Object.entries(ENV_MAP)) {");
  out.push("    const v = input[inputKey];");
  out.push("    env[envKey] = v === undefined || v === null ? \"\" : String(v);");
  out.push("  }");
  out.push("  try { env.__AGENTRY_INPUT_JSON = JSON.stringify(input || {}); } catch (e) { env.__AGENTRY_INPUT_JSON = \"{}\"; }");
  out.push("  const res = await ctx.invoke(\"agentry.os\", { action: KERNEL_ACTION, session, code: KERNEL_SCRIPT, env, timeout_ms: input.timeout_ms || DEFAULT_TIMEOUT_MS });");
  out.push("  if (!res.ok) throw new Error(CAP_ID + \": kernel failed — \" + res.error.code + \": \" + res.error.message);");
  out.push("  const r = res.output.result || res.output;");
  out.push("  const exitCode = r.exit_code ?? r.exitCode ?? 0;");
  out.push("  if (exitCode !== 0) throw new Error(CAP_ID + \": exit \" + exitCode + \" — \" + String(r.stderr || \"\").slice(0, 300));");
  out.push("  const stdout = String(r.stdout || \"\").trim();");
  out.push("  if (!stdout) throw new Error(CAP_ID + \": no stdout\");");
  out.push("  let parsed;");
  out.push("  try { parsed = JSON.parse(stdout); }");
  out.push("  catch (e) { throw new Error(CAP_ID + \": stdout not JSON — \" + e.message); }");
  out.push("  return { output: parsed };");
  out.push("}");
  out.push("");
  out.push("export async function accept(deps, opts = {}) {");
  out.push("  const session = opts.session || (CAP_ID + \"-accept\");");
  out.push("  const { prepareSession } = await import(\"/tmp/home/.dsh/node_modules/agentry/src/runtime/installer.mjs\");");
  out.push("  await prepareSession(deps, { capId: CAP_ID, session, requires_override: REQUIRES });");
  out.push("  const FIXTURES = " + JSON.stringify(spec.accept_spec?._fixtures || {}) + ";");
  out.push("  if (Object.keys(FIXTURES).length > 0) {");
  out.push("    const fs = await import(\"node:fs\"); const path = await import(\"node:path\");");
  out.push("    for (const [fp, content] of Object.entries(FIXTURES)) {");
  out.push("      try { fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, String(content)); } catch (e) {}");
  out.push("    }");
  out.push("  }");
  out.push("  const probe = await run(" + JSON.stringify(spec.accept_spec?.input || {}) + ", deps, { session });");
  out.push("  const out = probe.output || probe;");
  out.push("  const PROD = " + JSON.stringify(capability.produces || {}) + ";");
  out.push("  const _missing = Object.keys(PROD).filter(k => out[k] === undefined || out[k] === null);");
  out.push("  if (_missing.length > 0) throw new Error(\"accept: handler returned null/undefined for: \" + _missing.join(\", \"));");
  out.push("  return { ok: true, session, output: out };");
  out.push("}");
  out.push("");
  out.push("export default run;");

  return out.join("\n");
}

export default async function agentryBuildFromPlan(input, ctx) {
  const { gap_id, capability_id, plan_spec, candidate, model_tier } = input || {};
  const _tierHint = model_tier || (plan_spec && plan_spec.model_tier) || "balanced";
  if (!plan_spec || typeof plan_spec !== "object") throw new Error("agentry.build_from_plan requires plan_spec");
  if (typeof ctx.invoke !== "function") throw new Error("agentry.build_from_plan requires ctx.invoke");

  const started = Date.now();
  const graph = ctx.graph, events = ctx.events;

  const capId = plan_spec.capability?.id
    || capability_id
    || (gap_id ? gap_id.replace(/^gap:/, "") : null)
    || (candidate && sanitizeId(candidate.id))
    || ("task_" + Date.now().toString(36));
  const safeId = sanitizeId(capId);

  if (typeof graph.invalidateCache === "function") graph.invalidateCache();
  const existing = graph.getCapability(capId);
  if (existing && !existing.retired_at && existing.trial_passed_at && existing.handler_file) {
    events.emit("build_from_plan.already_exists", { capability_id: capId });
    return {
      output: { ok: true, capability_id: capId, handler_path: existing.handler_file, already_existed: true },
      cost: { time_ms: Date.now() - started },
    };
  }

  const plan = Array.isArray(plan_spec.plan) ? plan_spec.plan : [];
  if (plan.length === 0) return { output: { ok: false, reason: "empty_plan", phase: "validate" }, cost: { time_ms: Date.now() - started } };
  for (let i = 0; i < plan.length; i++) {
    if (!plan[i] || typeof plan[i] !== "object" || !String(plan[i].code || "").trim()) {
      return { output: { ok: false, reason: "plan_step_" + i + "_missing_code", phase: "validate" }, cost: { time_ms: Date.now() - started } };
    }
  }
  if (!plan_spec.accepts || typeof plan_spec.accepts !== "object") {
    return { output: { ok: false, reason: "missing_accepts", phase: "validate" }, cost: { time_ms: Date.now() - started } };
  }
  if (!plan_spec.produces || typeof plan_spec.produces !== "object") {
    return { output: { ok: false, reason: "missing_produces", phase: "validate" }, cost: { time_ms: Date.now() - started } };
  }

  const spec = {
    capability: {
      id: capId,
      kind: plan_spec.kind || "tool",
      accepts: plan_spec.accepts,
      produces: plan_spec.produces,
      requires: plan_spec.requires || { npm: [], pip: [], post_install: null, capability: [] },
    },
    plan,
    accept_spec: plan_spec.accept_spec || { input: {}, min_bytes: 0 },
    kernel_language: plan_spec.kernel_language || "node",
    glue: plan_spec.glue || { env_map: deriveEnvMap(plan_spec.accepts) },
  };

  mkdirSync(HANDLERS_DIR, { recursive: true });
  mkdirSync(SEEDS_DIR, { recursive: true });
  const handlerPath = join(HANDLERS_DIR, safeId + ".mjs");
  const seedPath = join(SEEDS_DIR, safeId + ".json");

  try {
    writeFileSync(handlerPath, renderHandlerFromPlan(spec));
  } catch (e) {
    return { output: { ok: false, reason: "render_failed: " + e.message, phase: "render" }, cost: { time_ms: Date.now() - started } };
  }

  const chk = spawnSync(process.execPath, ["--check", handlerPath], { encoding: "utf8", timeout: 15000 });
  if (chk.status !== 0) {
    try { unlinkSync(handlerPath); } catch {}
    return {
      output: { ok: false, reason: "syntax_error", phase: "syntax", stderr: String(chk.stderr || "").slice(0, 500) },
      cost: { time_ms: Date.now() - started },
    };
  }

  // v0.58.6d — write seed BEFORE trial. Trial reads `requires` from the seed
  // file via seed_path. Prior version wrote it AFTER trial, so trial saw
  // empty requires, installed nothing, kernel failed with "Cannot find
  // package 'cbor-x'". This order fix makes install work correctly.
  try {
    writeFileSync(seedPath, JSON.stringify({
      id: capId,
      kind: spec.capability.kind,
      invoked_via: "invoker.in_process_js",
      handler: safeId,
      handler_file: handlerPath,
      accepts: spec.capability.accepts,
      produces: spec.capability.produces,
      requires: spec.capability.requires,
      source: "dsh_plan:pending_trial",
    }, null, 2));
  } catch (e) {
    return { output: { ok: false, reason: "seed_write_failed: " + e.message, phase: "seed" }, cost: { time_ms: Date.now() - started } };
  }

  events.emit("build_from_plan.trial_started", { capability_id: capId, handler_path: handlerPath });
  let trialResult;
  try {
    trialResult = await ctx.invoke("agentry.trial", {
      capability_id: capId,
      handler_path: handlerPath,
      seed_path: seedPath,
    }, { tenant: "local", by: "agentry.build_from_plan" });
  } catch (e) {
    try { unlinkSync(handlerPath); } catch {}
    return { output: { ok: false, reason: "trial_threw: " + e.message, phase: "trial" }, cost: { time_ms: Date.now() - started } };
  }

  if (!trialResult.ok || !trialResult.output || trialResult.output.ok !== true) {
    try { unlinkSync(handlerPath); } catch {}
    const phase = (trialResult.output && trialResult.output.phase) || "trial";
    const errMsg = (trialResult.output && trialResult.output.error) || (trialResult.error && trialResult.error.message) || "trial failed";
    events.emit("build_from_plan.trial_failed", { capability_id: capId, phase, error: String(errMsg).slice(0, 300) });
    return {
      output: {
        ok: false,
        phase,
        reason: "trial_failed",
        error: String(errMsg).slice(0, 500),
        hint: "Fix the plan code and call build_from_plan again with the same gap_id/capability_id.",
      },
      cost: { time_ms: Date.now() - started },
    };
  }

  // v0.58.6d — seed already written before trial; just add graph node
  graph.putCapability({
    id: capId,
    kind: spec.capability.kind,
    invoked_via: "invoker.in_process_js",
    handler: safeId,
    handler_file: handlerPath,
    accepts: spec.capability.accepts,
    produces: spec.capability.produces,
    requires: spec.capability.requires,
    source: "dsh_plan:verified",
    tier: "ephemeral",
    tier_hint: _tierHint,
    seed_path: seedPath,
    trial_passed_at: Date.now(),
    trial_session: trialResult.output.session,
  });

  if (gap_id) {
    try {
      graph.invalidateCache();
      const gap = graph.getCapability(gap_id);
      if (gap && !gap.retired_at) {
        graph.retireCapability(gap_id, "build_from_plan: successful adoption");
        events.emit("build_from_plan.gap_retired", { gap_id, capability_id: capId });
      }
    } catch (e) {
      events.emit("build_from_plan.gap_retire_failed", { gap_id, error: String(e.message || "").slice(0, 200) });
    }
  }

  events.emit("build_from_plan.succeeded", {
    capability_id: capId, handler_path: handlerPath, ms: Date.now() - started,
  });

  return {
    output: {
      ok: true,
      capability_id: capId,
      handler_path: handlerPath,
      seed_path: seedPath,
      ms: Date.now() - started,
      hint: "Capability built and trial-verified. Call invoke() now.",
    },
    cost: { time_ms: Date.now() - started },
  };
}
