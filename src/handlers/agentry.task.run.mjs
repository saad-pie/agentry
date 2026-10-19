// agentry/src/handlers/agentry.task.run.mjs
// v0.33.1 — task primitive.
//
// A task is a plan of capability invocations executed in sequence, with
// persistent state in the graph. It is the runtime: the thing that calls
// capabilities on your behalf.
//
// v0.33.1 fix: extractArtifacts also scans step INPUT for path-like
// fields pointing to files that now exist. Some handlers (modbender QR
// skill) write to save_path but don't echo the path in output, violating
// their own produces contract. The runtime observes the session — if the
// caller committed to a path and the file exists afterward, it's an
// artifact. Handlers will always be inconsistent about this.
//
// Design:
//   - task node written via graph.putCapability (kind: "task")
//   - per-step putCapability so a mid-run crash leaves resumable state
//   - state: created → running → done | failed | handoff
//   - budget enforced per step; exhaustion → handoff (not failure)
//   - artifacts extracted from step outputs AND step inputs
//   - trace: {step, capability_id, ok, ms, cost, input_keys, output_keys, error?}
//
// Substitution in step input (string values starting with "$"):
//   $intent              — the task's intent
//   $prev                — previous step's full output
//   $prev.field.sub      — path into previous step's output
//   $last_artifact       — last file-path artifact from any prior step
//
// NOT in v1 (deliberate):
//   - retry on failure (future: task.retry)
//   - handoff to another owner (future: task.handoff)
//   - $step.N references (needs persisted step outputs — future)
//   - parallel steps (future: task.run_dag)
//   - resume $prev across process restarts (step outputs are in-memory only)

import { statSync, readFileSync } from "node:fs";

const MAX_ERROR_LEN = 400;
const ARTIFACT_PATH_PATTERN = /(_path$|^path$|artifact_path$|_file$|^save_path$|^dstPath$|^srcPath$|^output_path$|^input_path$)/i;
const ARTIFACT_B64_PATTERN = /_base64$/i;
const FILE_EXT_PATTERN = /\.(png|jpg|jpeg|pdf|mp4|mp3|wav|json|txt|md|csv|html|zip|gif|webp)$/i;

function genTaskId() {
  return "task_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function looksLikePath(key, val) {
  if (typeof val !== "string" || !val) return false;
  if (ARTIFACT_PATH_PATTERN.test(key)) return true;
  if (FILE_EXT_PATTERN.test(val)) return true;
  return false;
}

function extractArtifacts(output, stepInput, stepIndex) {
  const artifacts = [];
  const seenPaths = new Set();

  // 1. From output — the well-behaved case
  if (output && typeof output === "object") {
    for (const [key, val] of Object.entries(output)) {
      if (typeof val !== "string" || !val) continue;
      if (ARTIFACT_PATH_PATTERN.test(key)) {
        try {
          const st = statSync(val);
          if (st.isFile() && st.size > 0) {
            const magic = readFileSync(val).slice(0, 8).toString("hex");
            artifacts.push({ kind: "file", field: key, path: val, bytes: st.size, magic, from_step: stepIndex });
            seenPaths.add(val);
          }
        } catch {}
      } else if (ARTIFACT_B64_PATTERN.test(key)) {
        try {
          const buf = Buffer.from(val, "base64");
          if (buf.length > 0) {
            artifacts.push({ kind: "base64", field: key, bytes: buf.length, magic: buf.slice(0, 8).toString("hex"), from_step: stepIndex });
          }
        } catch {}
      }
    }
  }

  // 2. From input — the "handler wrote to save_path but didn't echo it" case.
  // If the caller declared a path and the file exists now, it's an artifact.
  if (stepInput && typeof stepInput === "object") {
    for (const [key, val] of Object.entries(stepInput)) {
      if (!looksLikePath(key, val)) continue;
      if (seenPaths.has(val)) continue;
      try {
        const st = statSync(val);
        if (st.isFile() && st.size > 0) {
          const magic = readFileSync(val).slice(0, 8).toString("hex");
          artifacts.push({ kind: "file", field: "input:" + key, path: val, bytes: st.size, magic, from_step: stepIndex, from_input: true });
          seenPaths.add(val);
        }
      } catch {}
    }
  }

  // 3. Bytes-only fallback for outputs that report size without a path
  if (artifacts.length === 0 && output && typeof output === "object" && typeof output.bytes === "number" && output.bytes > 0) {
    artifacts.push({ kind: "bytes_only", bytes: output.bytes, from_step: stepIndex });
  }

  return artifacts;
}

function resolveRef(ref, stepOutputs, artifacts, intent) {
  if (ref === "$intent") return intent;
  if (ref === "$prev") return stepOutputs.length > 0 ? stepOutputs[stepOutputs.length - 1] : undefined;
  if (ref.startsWith("$prev.")) {
    let v = stepOutputs.length > 0 ? stepOutputs[stepOutputs.length - 1] : undefined;
    for (const p of ref.slice(6).split(".")) v = v?.[p];
    return v;
  }
  if (ref === "$last_artifact") {
    // Prefer file-path artifacts over base64/bytes_only.
    for (let i = artifacts.length - 1; i >= 0; i--) {
      const a = artifacts[i];
      if (a.kind === "file" && a.path) return a.path;
    }
    return undefined;
  }
  return ref;
}

function resolveStepInput(inputSpec, stepOutputs, artifacts, intent) {
  if (inputSpec === null || typeof inputSpec !== "object" || Array.isArray(inputSpec)) {
    return inputSpec;
  }
  const out = {};
  for (const [key, val] of Object.entries(inputSpec)) {
    if (typeof val === "string" && val.startsWith("$")) {
      out[key] = resolveRef(val, stepOutputs, artifacts, intent);
    } else if (Array.isArray(val)) {
      out[key] = val.map(v => typeof v === "string" && v.startsWith("$") ? resolveRef(v, stepOutputs, artifacts, intent) : v);
    } else if (val && typeof val === "object") {
      out[key] = resolveStepInput(val, stepOutputs, artifacts, intent);
    } else {
      out[key] = val;
    }
  }
  return out;
}

function budgetExhausted(budget, spent) {
  return (budget.cost_usd - spent.cost_usd) <= 0
      || (budget.tokens - spent.tokens) <= 0
      || (budget.time_ms - spent.time_ms) <= 0;
}

export default async function agentryTaskRun(input, ctx) {
  const { intent, plan, task_id, session_id, parent_task_id, budget: budgetOverride } = input || {};
  if (typeof ctx.invoke !== "function") throw new Error("agentry.task.run requires ctx.invoke");

  const graph = ctx.graph;
  const events = ctx.events;
  const started = Date.now();

  // ── Resolve or create task node ──
  let task;
  let isNew = false;

  if (task_id) {
    task = graph.getCapability(task_id);
    if (!task) throw new Error("agentry.task.run: task not found: " + task_id);
    if (task.kind !== "task") throw new Error("agentry.task.run: " + task_id + " is kind " + task.kind + ", not task");
    if (task.state === "done") {
      return {
        output: { ok: true, task_id, state: "done", already_done: true, artifacts: task.artifacts || [], trace: task.trace || [] },
        cost: { time_ms: Date.now() - started },
      };
    }
  } else {
    if (!Array.isArray(plan) || plan.length === 0) {
      throw new Error("agentry.task.run requires either task_id (resume) or non-empty plan array (new)");
    }
    const id = genTaskId();
    const bud = {
      cost_usd: Number(budgetOverride?.cost_usd ?? 0.10),
      tokens: Number(budgetOverride?.tokens ?? 50000),
      time_ms: Number(budgetOverride?.time_ms ?? 120000),
    };
    task = {
      id,
      kind: "task",
      intent: intent || null,
      plan,
      state: "created",
      owner_agent: null,
      parent_task_id: parent_task_id || null,
      session_id: session_id || null,
      budget: { ...bud, spent_cost_usd: 0, spent_tokens: 0, spent_time_ms: 0 },
      artifacts: [],
      trace: [],
      error: null,
      step_index: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
      completed_at: null,
    };
    graph.putCapability(task);
    isNew = true;
    events.emit("task.created", { task_id: id, plan_steps: plan.length, intent: intent || null });
  }

  // ── Load budget, trace, artifacts from node ──
  const startIndex = Number(task.step_index || 0);
  const budget = {
    cost_usd: Number(task.budget?.cost_usd ?? 0.10),
    tokens: Number(task.budget?.tokens ?? 50000),
    time_ms: Number(task.budget?.time_ms ?? 120000),
  };
  const spent = {
    cost_usd: Number(task.budget?.spent_cost_usd || 0),
    tokens: Number(task.budget?.spent_tokens || 0),
    time_ms: Number(task.budget?.spent_time_ms || 0),
  };
  const trace = Array.isArray(task.trace) ? [...task.trace] : [];
  const artifacts = Array.isArray(task.artifacts) ? [...task.artifacts] : [];
  const stepOutputs = []; // in-memory only; enables $prev within a single run
  const taskSession = session_id || task.session_id || ("task_" + task.id);

  const runningTask = { ...task, state: "running", step_index: startIndex, updated_at: Date.now() };
  graph.putCapability(runningTask);
  events.emit("task.running", { task_id: task.id, from_step: startIndex, resume: !isNew });

  // ── Execute each step ──
  for (let i = startIndex; i < task.plan.length; i++) {
    const step = task.plan[i];

    if (!step || typeof step !== "object" || !step.capability_id) {
      const err = { step: i, code: "invalid_step", message: "step missing capability_id" };
      graph.putCapability({ ...runningTask, state: "failed", error: err, trace, artifacts, step_index: i, updated_at: Date.now() });
      events.emit("task.failed", { task_id: task.id, step: i, code: "invalid_step" });
      return { output: { ok: false, task_id: task.id, error: err, artifacts, trace }, cost: { time_ms: Date.now() - started } };
    }

    if (budgetExhausted(budget, spent)) {
      const remaining = {
        cost_usd: budget.cost_usd - spent.cost_usd,
        tokens: budget.tokens - spent.tokens,
        time_ms: budget.time_ms - spent.time_ms,
      };
      graph.putCapability({
        ...runningTask, state: "handoff", step_index: i, trace, artifacts,
        budget: { ...budget, spent_cost_usd: spent.cost_usd, spent_tokens: spent.tokens, spent_time_ms: spent.time_ms },
        updated_at: Date.now(),
      });
      events.emit("task.handoff", { task_id: task.id, step: i, remaining });
      return {
        output: { ok: false, task_id: task.id, state: "handoff", reason: "budget_exhausted", step: i, remaining, artifacts, trace },
        cost: { time_ms: Date.now() - started },
      };
    }

    let stepInput;
    try {
      stepInput = resolveStepInput(step.input || {}, stepOutputs, artifacts, task.intent);
    } catch (e) {
      const err = { step: i, code: "input_resolve_failed", message: e.message };
      graph.putCapability({ ...runningTask, state: "failed", error: err, trace, artifacts, step_index: i, updated_at: Date.now() });
      events.emit("task.failed", { task_id: task.id, step: i, code: "input_resolve_failed" });
      return { output: { ok: false, task_id: task.id, error: err, artifacts, trace }, cost: { time_ms: Date.now() - started } };
    }
    if (stepInput.session === undefined) stepInput.session = taskSession;

    const stepStarted = Date.now();
    let stepRes;
    try {
      stepRes = await ctx.invoke(step.capability_id, stepInput, {
        tenant: "local",
        by: "agentry.task.run",
        task_id: task.id,
      });
    } catch (e) {
      stepRes = { ok: false, error: { code: "internal", message: e.message } };
    }
    const stepMs = Date.now() - stepStarted;

    const stepCost = stepRes.cost || {};
    spent.cost_usd += Number(stepCost.money_usd || 0);
    spent.tokens += Number(stepCost.tokens || 0);
    spent.time_ms += stepMs;

    const entry = {
      step: i,
      capability_id: step.capability_id,
      ok: stepRes.ok === true,
      ms: stepMs,
      cost: { money_usd: Number(stepCost.money_usd || 0), tokens: Number(stepCost.tokens || 0) },
      input_keys: Object.keys(stepInput),
      output_keys: stepRes.ok ? Object.keys(stepRes.output || {}) : null,
      error: stepRes.ok ? null : {
        code: stepRes.error?.code || "unknown",
        message: String(stepRes.error?.message || "").slice(0, MAX_ERROR_LEN),
      },
    };
    trace.push(entry);

    if (!stepRes.ok) {
      const err = { step: i, capability_id: step.capability_id, code: entry.error.code, message: entry.error.message };
      graph.putCapability({
        ...runningTask, state: "failed", error: err, trace, artifacts, step_index: i,
        budget: { ...budget, spent_cost_usd: spent.cost_usd, spent_tokens: spent.tokens, spent_time_ms: spent.time_ms },
        updated_at: Date.now(),
      });
      events.emit("task.failed", { task_id: task.id, step: i, capability_id: step.capability_id, code: entry.error.code });
      return { output: { ok: false, task_id: task.id, error: err, artifacts, trace }, cost: { time_ms: Date.now() - started } };
    }

    stepOutputs.push(stepRes.output);
    // v0.33.1 — pass stepInput so artifacts include files the handler wrote
    // to a caller-provided path but didn't echo back.
    const stepArtifacts = extractArtifacts(stepRes.output, stepInput, i);
    for (const a of stepArtifacts) artifacts.push(a);

    events.emit("task.step", {
      task_id: task.id, step: i, capability_id: step.capability_id,
      ok: true, ms: stepMs, artifacts: stepArtifacts.length,
    });

    graph.putCapability({
      ...runningTask, trace, artifacts, step_index: i + 1,
      budget: { ...budget, spent_cost_usd: spent.cost_usd, spent_tokens: spent.tokens, spent_time_ms: spent.time_ms },
      updated_at: Date.now(),
    });
  }

  // ── Done ──
  const doneTask = {
    ...runningTask,
    state: "done",
    trace, artifacts,
    step_index: task.plan.length,
    budget: { ...budget, spent_cost_usd: spent.cost_usd, spent_tokens: spent.tokens, spent_time_ms: spent.time_ms },
    completed_at: Date.now(),
    updated_at: Date.now(),
  };
  graph.putCapability(doneTask);
  events.emit("task.done", {
    task_id: task.id, steps: task.plan.length,
    artifacts: artifacts.length, ms: Date.now() - started,
  });

  return {
    output: { ok: true, task_id: task.id, state: "done", artifacts, trace, ms: Date.now() - started },
    cost: { time_ms: Date.now() - started },
  };
}
