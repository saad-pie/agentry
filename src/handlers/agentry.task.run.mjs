// agentry/src/handlers/agentry.task.run.mjs
// v0.44.0 — $tmp substitution → /tmp/agentry-scratch
//
// v0.43.1 — failure returns carry state:"failed"
//
// v0.42.0 — task primitive with retry-on-missing + tool_calls
//          artifact extraction.
//
// v0.37.0 — retry-on-missing-capability.
//
// v0.33.0: initial primitive.
// v0.33.1: extractArtifacts scans step input for path-like fields (some
//          handlers write to save_path but don't echo it back).
// v0.33.2: $last_artifact belt+suspenders, resolved_small_input in trace.
// v0.37.0: on step failure with error.code === "invalid_capability",
//          call agentry.ensure(capability_id) once, then retry the step
//          once. If ensure times out or retry fails, task fails with
//          retry metadata in the trace. Disable via
//          input.retry_on_missing_capability=false. This is the loop
//          that closes: agent hits a wall -> agentry builds the tool ->
//          agent continues.
//
// Design:
//   - task node written via graph.putCapability (kind: "task")
//   - per-step putCapability so a mid-run crash leaves resumable state
//   - state: created → running → done | failed | handoff
//   - budget enforced per step; exhaustion → handoff
//   - artifacts extracted from step outputs AND step inputs
//   - trace: {step, capability_id, ok, ms, cost, input_keys,
//             resolved_small_input, output_keys, error, retry?}
//
// Substitution in step input (string values starting with "$"):
//   $intent              — the task's intent
//   $prev                — previous step's full output
//   $prev.field.sub      — path into previous step's output
//   $last_artifact       — last file path from any prior step
//
// NOT in v1 (deliberate):
//   - retry beyond one attempt per step (future: task.retry)
//   - handoff to another owner (future: task.handoff)
//   - $step.N references (needs persisted step outputs)
//   - parallel steps (future: task.run_dag)
//   - resume $prev across process restarts (in-memory only)

import { statSync, readFileSync, mkdirSync } from "node:fs";

const MAX_ERROR_LEN = 400;
const ARTIFACT_PATH_PATTERN = /(_path$|^path$|artifact_path$|_file$|^save_path$|^dstPath$|^srcPath$|^output_path$|^input_path$)/i;
const ARTIFACT_B64_PATTERN = /_base64$/i;
const FILE_EXT_PATTERN = /\.(png|jpg|jpeg|pdf|mp4|mp3|wav|json|txt|md|csv|html|zip|gif|webp)$/i;
// v0.53.5 — raised 120s -> 180s. ensure -> synthesize_via_dsh -> DSH
// timeouts were capped here below the caller's 180s intent, making
// every DSH run look like a model failure at exactly 90-120s.
const DEFAULT_ENSURE_TIMEOUT_MS = 180000;

function genTaskId() {
  return "task_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function looksLikePath(key, val) {
  if (typeof val !== "string" || !val) return false;
  if (ARTIFACT_PATH_PATTERN.test(key)) return true;
  if (FILE_EXT_PATTERN.test(val)) return true;
  return false;
}

// v0.44.1 — resolve a path that may be relative to the session workdir.
// LLMs often emit bare filenames like "world_qr.png" even when told not
// to; the file exists at <session-workdir>/world_qr.png but statSync on
// the bare string from the runtime process misses it. Try absolute-first,
// then session-relative. Return the resolved absolute path, or null.
function resolveExistingPath(path, session) {
  if (!path || typeof path !== "string") return null;
  // Try as-is (absolute or CWD-relative)
  try {
    const st = statSync(path);
    if (st.isFile() && st.size > 0) return path;
  } catch {}
  // Try session workdir (kernel convention)
  if (session && !path.startsWith("/")) {
    const candidates = [
      "/tmp/home/.dsh/agentry-kernel/work/" + session + "/" + path,
      "/tmp/home/.dsh/" + path,
      "/tmp/home/.dsh/agentry-scratch/" + path,
    ];
    for (const c of candidates) {
      try {
        const st = statSync(c);
        if (st.isFile() && st.size > 0) return c;
      } catch {}
    }
  }
  return null;
}

function extractArtifacts(output, stepInput, stepIndex) {
  const artifacts = [];
  const seenPaths = new Set();

  if (output && typeof output === "object") {
    for (const [key, val] of Object.entries(output)) {
      if (typeof val !== "string" || !val) continue;
      if (ARTIFACT_PATH_PATTERN.test(key)) {
        const resolved = resolveExistingPath(val, stepInput?.session);
        if (resolved) {
          const st = statSync(resolved);
          const magic = readFileSync(resolved).slice(0, 8).toString("hex");
          artifacts.push({ kind: "file", field: key, path: resolved, bytes: st.size, magic, from_step: stepIndex });
          seenPaths.add(resolved);
        }
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

  if (stepInput && typeof stepInput === "object") {
    for (const [key, val] of Object.entries(stepInput)) {
      if (!looksLikePath(key, val)) continue;
      if (seenPaths.has(val)) continue;
      const resolved = resolveExistingPath(val, stepInput?.session);
      if (resolved) {
        const st = statSync(resolved);
        const magic = readFileSync(resolved).slice(0, 8).toString("hex");
        artifacts.push({ kind: "file", field: "input:" + key, path: resolved, bytes: st.size, magic, from_step: stepIndex, from_input: true });
        seenPaths.add(resolved);
      }
    }
  }

  // v0.42.0 — tool_calls artifact extraction. DSH (agentry.agent.dsh)
  // returns { tool_calls: [{ tool, input: { file_path, ... }, result }] }.
  // Files created/modified by those tools live on disk but aren't
  // top-level output fields, so the output-scan above misses them.
  // Extract every path-like input to a non-read tool that resolves to
  // a real file. Downstream steps can then reference them via $last_artifact.
  if (output && Array.isArray(output.tool_calls)) {
    for (const tc of output.tool_calls) {
      if (!tc || typeof tc !== "object" || !tc.input || typeof tc.input !== "object") continue;
      const tool = String(tc.tool || "").toLowerCase();
      // Read-only tools' inputs point at pre-existing files, not artifacts
      // this step produced. Skip them so we don't claim credit for inputs.
      if (tool === "read" || tool === "list" || tool === "search" ||
          tool === "grep" || tool === "glob" || tool === "ls") continue;
      for (const [key, val] of Object.entries(tc.input)) {
        if (!looksLikePath(key, val)) continue;
        if (seenPaths.has(val)) continue;
        const resolved = resolveExistingPath(val, stepInput?.session);
        if (resolved) {
          const st = statSync(resolved);
          const magic = readFileSync(resolved).slice(0, 8).toString("hex");
          artifacts.push({
            kind: "file",
            field: "tool_call:" + (tc.tool || "?") + ":" + key,
            path: resolved,
            bytes: st.size,
            magic,
            from_step: stepIndex,
            from_tool_call: true,
          });
          seenPaths.add(resolved);
        }
      }
    }
  }

  // v0.47.4 — DSH discovered_files. agentry.agent.dsh now returns a
  // discovered_files array built by walking its cwd. These are real files
  // produced by the DSH step that wouldn't be caught by the tool_calls
  // scan (bash-based writes have no file_path field).
  if (output && Array.isArray(output.discovered_files)) {
    for (const f of output.discovered_files) {
      if (!f || !f.path || seenPaths.has(f.path)) continue;
      artifacts.push({
        kind: "file",
        field: "dsh.discovered:" + (f.path.split("/").pop() || "file"),
        path: f.path,
        bytes: f.bytes || 0,
        magic: f.magic || null,
        from_step: stepIndex,
        from_dsh_discovery: true,
      });
      seenPaths.add(f.path);
    }
  }


  if (artifacts.length === 0 && output && typeof output === "object" && typeof output.bytes === "number" && output.bytes > 0) {
    artifacts.push({ kind: "bytes_only", bytes: output.bytes, from_step: stepIndex });
  }

  return artifacts;
}

function resolveRef(ref, stepOutputs, artifacts, intent) {
  if (ref === "$intent") return intent;
  if (ref === "$prev") return stepOutputs.length > 0 ? stepOutputs[stepOutputs.length - 1] : undefined;
  if (ref.startsWith("$prev.")) {
    const prevIndex = stepOutputs.length - 1;
    let v = prevIndex >= 0 ? stepOutputs[prevIndex] : undefined;
    for (const p of ref.slice(6).split(".")) v = v?.[p];
    // v0.48.0 — if the field exists as a KEY but its value is null/undefined
    // (modbender returns path:null despite having a path field), and the
    // field name is path-like, fall back to any file artifact from that step.
    if (v === undefined || v === null) {
      const fieldName = ref.slice(6).split(".")[0];
      if (/path|file/i.test(fieldName)) {
        for (let i = artifacts.length - 1; i >= 0; i--) {
          const a = artifacts[i];
          if (a.from_step === prevIndex && a.kind === "file" && a.path) return a.path;
        }
      }
    }
    return v;
  }
  // v0.44.0 — $tmp substitution. LLMs naturally write "$tmp/x.png" as a
  // path prefix; resolve it to a shared writable scratch directory so
  // the file actually lands on disk where downstream steps can read it.
  if (ref === "$tmp") return "/tmp/agentry-scratch";
  if (ref.startsWith("$tmp/")) return "/tmp/agentry-scratch/" + ref.slice(5);
  if (ref === "$last_artifact") {
    for (let i = artifacts.length - 1; i >= 0; i--) {
      const a = artifacts[i];
      if (a.kind === "file" && a.path) return a.path;
    }
    for (let i = stepOutputs.length - 1; i >= 0; i--) {
      const out = stepOutputs[i];
      if (out && typeof out === "object") {
        for (const [k, v] of Object.entries(out)) {
          if (typeof v === "string" && v && ARTIFACT_PATH_PATTERN.test(k)) return v;
        }
      }
    }
    return undefined;
  }
  // v0.44.2 — string-embedded substitution. LLMs naturally write templates
  // like "![]($last_artifact)" or "See output at $prev.path". If the string
  // starts with $, the branches above handle the whole-value case. If $var
  // appears INSIDE a longer string, substitute in place. Only recognized
  // tokens are replaced; unrecognized $foo is left literal.
  if (typeof ref === "string" && ref.length > 1 && !ref.startsWith("$") && ref.includes("$")) {
    // v0.46.1 — exclude bare $prev from mid-string substitution (returns
    // an object, stringified would be [object Object]). Only $prev.field.sub
    // is safe inside a template string.
    return ref.replace(/(\$(?:last_artifact|intent|tmp(?:\/[\w.\-\/]+)?|prev\.[\w.]+))/g, (m) => {
      const v = resolveRef(m, stepOutputs, artifacts, intent);
      return v === undefined ? m : String(v);
    });
  }


  return ref;
}

function resolveStepInput(inputSpec, stepOutputs, artifacts, intent) {
  if (inputSpec === null || typeof inputSpec !== "object" || Array.isArray(inputSpec)) {
    return inputSpec;
  }
  const out = {};
  for (const [key, val] of Object.entries(inputSpec)) {
    // v0.46.1 — call resolveRef for ANY string containing $, not just
    // strings that START with $. The mid-string substitution lives inside
    // resolveRef (v0.44.2) but was unreachable because this gate rejected
    // markdown templates like "![]($last_artifact)".
    if (typeof val === "string" && val.includes("$")) {
      out[key] = resolveRef(val, stepOutputs, artifacts, intent);
    } else if (Array.isArray(val)) {
      out[key] = val.map(v => typeof v === "string" && v.includes("$") ? resolveRef(v, stepOutputs, artifacts, intent) : v);
    } else if (val && typeof val === "object") {
      out[key] = resolveStepInput(val, stepOutputs, artifacts, intent);
    } else {
      out[key] = val;
    }
  }
  return out;
}

function smallInput(stepInput) {
  const out = {};
  if (!stepInput || typeof stepInput !== "object") return out;
  for (const [k, v] of Object.entries(stepInput)) {
    if (typeof v === "string" && v.length < 300) out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (v === null) out[k] = null;
    else if (v === undefined) out[k] = "undefined";
    else if (typeof v === "string") out[k] = "<string:" + v.length + ">";
    else out[k] = "<" + typeof v + ">";
  }
  return out;
}

function budgetExhausted(budget, spent) {
  return (budget.cost_usd - spent.cost_usd) <= 0
      || (budget.tokens - spent.tokens) <= 0
      || (budget.time_ms - spent.time_ms) <= 0;
}

export default async function agentryTaskRun(input, ctx) {
  const {
    intent, plan, task_id, session_id, parent_task_id, budget: budgetOverride,
    retry_on_missing_capability, ensure_timeout_ms,
  } = input || {};
  if (typeof ctx.invoke !== "function") throw new Error("agentry.task.run requires ctx.invoke");

  const retryOnMissing = retry_on_missing_capability !== false;
  const ensureTimeout = Math.max(2000, Math.min(600000, Number(ensure_timeout_ms) || DEFAULT_ENSURE_TIMEOUT_MS));

  const graph = ctx.graph;
  const events = ctx.events;
  const started = Date.now();

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
      id, kind: "task", intent: intent || null, plan,
      state: "created", owner_agent: null,
      parent_task_id: parent_task_id || null, session_id: session_id || null,
      budget: { ...bud, spent_cost_usd: 0, spent_tokens: 0, spent_time_ms: 0 },
      artifacts: [], trace: [], error: null, step_index: 0,
      created_at: Date.now(), updated_at: Date.now(), completed_at: null,
    };
    graph.putCapability(task);
    isNew = true;
    events.emit("task.created", { task_id: id, plan_steps: plan.length, intent: intent || null });
  }

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
  const stepOutputs = [];
  const taskSession = session_id || task.session_id || ("task_" + task.id);

  // v0.44.0 — ensure scratch dir exists so $tmp/... resolves to a real path.
  try { mkdirSync("/tmp/agentry-scratch", { recursive: true }); } catch {}

  const runningTask = { ...task, state: "running", step_index: startIndex, updated_at: Date.now() };
  graph.putCapability(runningTask);
  events.emit("task.running", { task_id: task.id, from_step: startIndex, resume: !isNew });

  for (let i = startIndex; i < task.plan.length; i++) {
    const step = task.plan[i];

    if (!step || typeof step !== "object" || !step.capability_id) {
      const err = { step: i, code: "invalid_step", message: "step missing capability_id" };
      graph.putCapability({ ...runningTask, state: "failed", error: err, trace, artifacts, step_index: i, updated_at: Date.now() });
      events.emit("task.failed", { task_id: task.id, step: i, code: "invalid_step" });
      return { output: { ok: false, state: "failed", task_id: task.id, error: err, artifacts, trace }, cost: { time_ms: Date.now() - started } };
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
        tenant: "local", by: "agentry.task.run", task_id: task.id,
      });
    } catch (e) {
      stepRes = { ok: false, error: { code: "internal", message: e.message } };
    }
    let stepMs = Date.now() - stepStarted;
    let retryInfo = null;

    // ── v0.37.0 — retry-on-missing-capability ──
    if (!stepRes.ok && stepRes.error?.code === "invalid_capability" && retryOnMissing) {
      retryInfo = {
        attempted: true,
        original_error: {
          code: stepRes.error.code,
          message: String(stepRes.error.message || "").slice(0, MAX_ERROR_LEN),
        },
      };
      events.emit("task.retry.started", {
        task_id: task.id, step: i, capability_id: step.capability_id,
        ensure_timeout_ms: ensureTimeout,
      });

      // v0.44.3 — if the step has no wanted_kind / wanted_description, the
      // planner thought the capability already existed. That's almost always
      // a hallucinated id (e.g. "pdf.from_image", "file.write_base64"). Don't
      // wait 2 minutes for adoption that was never going to happen. Short-
      // circuit to 5s so the task fails fast and the caller can retry with a
      // corrected plan.
      const isPlannedNewCap = !!(step.wanted_kind || step.wanted_description);
      // v0.52.25 — bumped from 30000 to 90000 because agentry.ensure now
      // tries DSH-driven synthesis (60s) before the polling fallback. Prior
      // 30s would cut DSH off before it finished installing packages.
      const effectiveEnsureTimeout = isPlannedNewCap
        ? Math.min(ensureTimeout, 180000)
        : Math.min(ensureTimeout, 5000);
      let ensureRes;
      const ensureStarted = Date.now();
      try {
        ensureRes = await ctx.invoke("agentry.ensure", {
          capability_id: step.capability_id,
          timeout_ms: effectiveEnsureTimeout,
          wanted_kind: step.wanted_kind || "tool",
          wanted_description: step.wanted_description || null,
        }, { tenant: "local", by: "agentry.task.run", task_id: task.id });
      } catch (e) {
        ensureRes = { ok: false, error: { message: e.message } };
      }
      const ensureMs = Date.now() - ensureStarted;
      const ensureOut = ensureRes.ok ? (ensureRes.output || {}) : {};
      retryInfo.ensure = {
        available: ensureOut.available === true,
        gap_id: ensureOut.gap_id || null,
        proposal_id: ensureOut.proposal_id || null,
        reason: ensureOut.reason || (ensureRes.error?.message || "ensure_threw"),
        waited_ms: ensureMs,
      };
      events.emit("task.retry.ensure", {
        task_id: task.id, step: i, capability_id: step.capability_id,
        available: retryInfo.ensure.available,
        gap_id: retryInfo.ensure.gap_id,
        reason: retryInfo.ensure.reason,
        waited_ms: ensureMs,
      });

      if (ensureOut.available === true) {
        // v0.56.40 — remap step input to match newly-adopted capability accepts.
        // The planner invents input keys before the capability exists; the
        // synthesizer picks its own from the shape. When they disagree, the
        // invoker accepts-gate rejects with "missing required input: X".
        try {
          const _newCap = ctx.graph.getCapability(step.capability_id);
          if (_newCap && _newCap.accepts && typeof _newCap.accepts === "object") {
            const _missing = Object.keys(_newCap.accepts).filter(k => {
              const _s = _newCap.accepts[k];
              const _opt = _s && typeof _s === "object" && _s.optional === true;
              return !_opt && stepInput[k] === undefined;
            });
            if (_missing.length > 0) {
              const _fs = await import("node:fs");
              const _remapped = { ...stepInput };
              for (const _missKey of _missing) {
                if (!/_path$|_file$/.test(_missKey)) continue;
                const _isInput = /input|_in$|^src|source/i.test(_missKey);
                const _isOutput = /output|_out$|^dst|dest|target/i.test(_missKey);
                const _extMatch = _missKey.match(/_([a-z0-9]+)(?:_path|_file)$/i);
                if (_extMatch) {
                  const _hintExt = _extMatch[1].toLowerCase();
                  for (const [_k, _v] of Object.entries(stepInput)) {
                    if (typeof _v === "string" && _v.toLowerCase().endsWith("." + _hintExt)) {
                      _remapped[_missKey] = _v;
                      break;
                    }
                  }
                }
                if (_remapped[_missKey] === undefined && _isInput !== _isOutput) {
                  const _usedVals = new Set(Object.values(_remapped).filter(v => typeof v === "string"));
                  for (const [_k, _v] of Object.entries(stepInput)) {
                    if (typeof _v !== "string" || !_v.startsWith("/") || _usedVals.has(_v)) continue;
                    let _exists = false;
                    try { _exists = _fs.statSync(_v).isFile(); } catch {}
                    if (_isInput && _exists) { _remapped[_missKey] = _v; break; }
                    if (_isOutput && !_exists) { _remapped[_missKey] = _v; break; }
                  }
                }
                if (_remapped[_missKey] === undefined && task.intent) {
                  const _paths = [...String(task.intent).matchAll(/\/[\w./-]+/g)].map(m => m[0])
                    .filter(p => (p.split("/").pop() || "").includes("."));
                  const _usedVals = new Set(Object.values(_remapped).filter(v => typeof v === "string"));
                  for (const _p of _paths) {
                    if (_usedVals.has(_p)) continue;
                    let _exists = false;
                    try { _exists = _fs.statSync(_p).isFile(); } catch {}
                    if (_isInput && _exists) { _remapped[_missKey] = _p; break; }
                    if (_isOutput && !_exists) { _remapped[_missKey] = _p; break; }
                  }
                }
              }
              if (_missing.every(k => _remapped[k] !== undefined)) {
                events.emit("task.retry.input_remapped", {
                  task_id: task.id, step: i, capability_id: step.capability_id,
                  missing_keys: _missing,
                  mapped: Object.fromEntries(_missing.map(k => [k, _remapped[k]])),
                  original_keys: Object.keys(stepInput),
                });
                stepInput = _remapped;
              } else {
                events.emit("task.retry.remap_incomplete", {
                  task_id: task.id, step: i, capability_id: step.capability_id,
                  missing_keys: _missing,
                  still_missing: _missing.filter(k => _remapped[k] === undefined),
                  original_keys: Object.keys(stepInput),
                });
              }
            }
          }
        } catch (e) {
          events.emit("task.retry.remap_threw", { task_id: task.id, error: e.message });
        }
        const retryStarted = Date.now();
        try {
          stepRes = await ctx.invoke(step.capability_id, stepInput, {
            tenant: "local", by: "agentry.task.run", task_id: task.id,
          });
        } catch (e) {
          stepRes = { ok: false, error: { code: "internal", message: e.message } };
        }
        stepMs = Date.now() - retryStarted;
        retryInfo.retry_ok = stepRes.ok === true;
        retryInfo.retry_ms = stepMs;
        events.emit(stepRes.ok ? "task.retry.succeeded" : "task.retry.failed", {
          task_id: task.id, step: i, capability_id: step.capability_id, ms: stepMs,
        });
      } else {
        events.emit("task.retry.ensure_unavailable", {
          task_id: task.id, step: i, capability_id: step.capability_id,
          reason: retryInfo.ensure.reason,
        });
      }
    }

    const stepCost = stepRes.cost || {};
    spent.cost_usd += Number(stepCost.money_usd || 0);
    spent.tokens += Number(stepCost.tokens || 0);
    spent.time_ms += stepMs + (retryInfo ? (retryInfo.ensure.waited_ms || 0) : 0);

    const entry = {
      step: i,
      capability_id: step.capability_id,
      ok: stepRes.ok === true,
      ms: stepMs,
      cost: { money_usd: Number(stepCost.money_usd || 0), tokens: Number(stepCost.tokens || 0) },
      input_keys: Object.keys(stepInput),
      resolved_small_input: smallInput(stepInput),
      output_keys: stepRes.ok ? Object.keys(stepRes.output || {}) : null,
      error: stepRes.ok ? null : {
        code: stepRes.error?.code || "unknown",
        message: String(stepRes.error?.message || "").slice(0, MAX_ERROR_LEN),
      },
      ...(retryInfo ? { retry: retryInfo } : {}),
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
      return { output: { ok: false, state: "failed", task_id: task.id, error: err, artifacts, trace }, cost: { time_ms: Date.now() - started } };
    }

    stepOutputs.push(stepRes.output);
    const stepArtifacts = extractArtifacts(stepRes.output, stepInput, i);
    for (const a of stepArtifacts) artifacts.push(a);

    events.emit("task.step", {
      task_id: task.id, step: i, capability_id: step.capability_id,
      ok: true, ms: stepMs, artifacts: stepArtifacts.length,
      ...(retryInfo ? { retried: true } : {}),
    });

    graph.putCapability({
      ...runningTask, trace, artifacts, step_index: i + 1,
      budget: { ...budget, spent_cost_usd: spent.cost_usd, spent_tokens: spent.tokens, spent_time_ms: spent.time_ms },
      updated_at: Date.now(),
    });
  }

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
