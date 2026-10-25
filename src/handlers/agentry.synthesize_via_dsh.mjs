// agentry/src/handlers/agentry.synthesize_via_dsh.mjs
// v0.52.25 — DSH-driven synthesis.
//
// Given a capability_id + intent, calls agentry.agent.dsh with a prompt
// that returns a JSON spec (package_name + code_body + test fixture),
// renders the spec into a pipeline-shaped handler file, VERIFIES via
// real execution against the fixture, writes graph node + runtime seed.
//
// Fast path for agentry.ensure BEFORE the polling loop. Success means
// the capability is invokable in 60-90s instead of waiting ~10min for
// the mechanical discovery pipeline.
//
// Design:
//   - DSH does the hard part: pick package, install, write working code.
//   - We render boilerplate: exact pipeline template, node --check,
//     prepareSession wiring, output shape.
//   - Verify via real invocation before writing to graph. Fail = retire
//     trial node, return {verified:false}.
//   - No registerHandler call needed: in_process_js lazy-loads via
//     cap.handler_file with a Date.now() cache-buster on first invoke.

import { writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { extractJson } from "./synthesize/validate/json.mjs";
import { pickReferenceHandlers, formatReferences } from "./synthesize/references.mjs";

const HANDLERS_DIR = process.env.AGENTRY_HANDLERS_DIR || "/tmp/home/.dsh/agentry-synthesized/handlers";
const SEEDS_DIR = process.env.AGENTRY_SEEDS_DIR || "/tmp/home/.dsh/agentry-synthesized/seeds";
const INSTALLER_PATH = "/tmp/home/.dsh/node_modules/agentry/src/runtime/installer.mjs";

function sanitizeId(id) {
  let s = String(id || "").toLowerCase();
  s = s.replace(/^gap:/i, "");
  s = s.replace(/^[a-z]+:/i, "");
  s = s.replace(/[^a-z0-9_.-]+/g, "_");
  return s.slice(0, 80);
}

function buildDshPrompt({ capability_id, intent, wanted_kind, wanted_description, accepts_hint, produces_hint, references }) {
  const accepts = accepts_hint || { input_path: "string", output_path: "string" };
  const produces = produces_hint || { output_path: "string", bytes: "number" };
  const env_map = Object.keys(accepts).map(k => k.toUpperCase()).join(", ");
  const L = [];
  L.push("GAP: capability `" + capability_id + "` is needed.");
  L.push("Intent: " + (intent || capability_id));
  if (wanted_kind) L.push("Wanted kind: " + wanted_kind);
  if (wanted_description) L.push("Wanted description: " + wanted_description);
  L.push("");
  if (references && references.length) {
    L.push(references);
    L.push("CRITICAL: study the reference above. Your test_script and code_body MUST use the same patterns: await import() for modules (NEVER require), process.env.UPPER_CASE for inputs, console.log(JSON.stringify({...})) as the last line. Copy the STRUCTURE, adapt the package.");
    L.push("");
  }
  L.push("TASK: Return a JSON SPEC describing a working Node.js implementation.");
  L.push("DO NOT write the full handler file — our code renders the pipeline template around your spec.");
  L.push("");
  L.push("CRITICAL BUDGET CONSTRAINT: your reasoning must be brief. Do NOT write essays, do NOT plan aloud, do NOT narrate. Do your work, return the JSON. If you exhaust your token budget thinking, you cannot finish the task. Aim for 200 tokens of reasoning max, then act.");
  L.push("");
  L.push("STEPS:");
  L.push("1. Pick the correct npm package. Must install cleanly in Node, no browser, no external CLI binary, no remote API key. NEVER pick puppeteer, playwright, or node-html-to-image - they download ~200MB Chromium and time out. For HTML to PNG/PDF, prefer takumi-js (pure Rust, no browser).");
  L.push("2. `cd /tmp && npm install <pkg>` to verify it installs. Then `node -e \"import('<pkg>').then(m=>console.log('ok'))\"` to verify it loads.");
  L.push("3. Write a small test script that: creates a real fixture, runs the operation, verifies output byte length or magic bytes.");
  L.push("4. Return the JSON below. NO prose. NO markdown fences. Just the JSON.");
  L.push("");
  L.push("RETURN THIS JSON SHAPE:");
  L.push("{");
  L.push('  "package_name": "<npm package name>",');
  L.push('  "test_script": "<JS code that imports the package and runs the ACTUAL operation on test_input_path, writing to test_output_path. This is what we run FIRST to verify the package works in this environment. If this does not create test_output_path with >0 bytes, your approach is wrong.>",');
  L.push('  "code_body": "<JS code that runs in an async kernel function. Read inputs from process.env.UPPERCASE_KEY. Write output file. Last line must be console.log(JSON.stringify({...})).>",');
  L.push('  "accepts": ' + JSON.stringify(accepts) + ",");
  L.push('  "produces": ' + JSON.stringify(produces) + ",");
  L.push('  "test_fixture": "<bash command creating a real fixture file at test_input_path>",');
  L.push('  "test_input_path": "/tmp/dsh_test_input.<ext>",');
  L.push('  "test_output_path": "/tmp/dsh_test_output.<ext>"');
  L.push("}");
  L.push("");
  L.push("RULES:");
  L.push("- CRITICAL: many packages change APIs between major versions. Do NOT assume pipe patterns work. Check the ACTUAL version's README/API. If the current README shows `await pkg(...)` (promise), await it. If it shows `.pipe()` (stream), use pipe. If unsure, wrap in try/catch and log the error so we can see it.");
  L.push("- test_script MUST be a complete working script that takes test_input_path and produces test_output_path. Run the ACTUAL operation. If test_script doesn't create the output file, your code_body won't either. Fix the approach BEFORE returning the spec.");
  L.push("- code_body runs INSIDE an async function body. Use `const fs = await import('node:fs')` for imports. NO top-level imports.");
  L.push("- Inputs come from process.env." + env_map + ". NOT function parameters.");
  L.push("- Emit final output with `console.log(JSON.stringify({...}))` as the LAST line.");
  L.push("- test_fixture MUST create the file at test_input_path. For binary use base64: `node -e \"require('fs').writeFileSync('/tmp/x.png', Buffer.from('<b64>', 'base64'))\"`.");
  L.push("- Your budget is precious. Do NOT spend it on research, essays, or narration. Pick a package, verify it installs, write the test_script, run it, FIX any errors, THEN return the spec. If you cannot make it work after 2 attempts, return `{\"error\": \"<reason>\"}` instead of a spec.");
  return L.join("\n");
}

function renderHandler(spec, capability_id) {
  const id = capability_id;
  const safeId = sanitizeId(capability_id);
  const accepts = spec.accepts || {};
  const produces = spec.produces || {};
  const requires = { npm: [spec.package_name], pip: [], post_install: null, capability: [] };
  const env_map = {};
  for (const k of Object.keys(accepts)) env_map[k.toUpperCase()] = k;
  const code = String(spec.code_body || "");
  const out = [];
  out.push("// agentry — DSH-synthesized handler for " + id);
  out.push("// v0.52.25 — Generated by agentry.synthesize_via_dsh. Regenerate, do not hand-edit.");
  out.push("");
  out.push("const CAP_ID = " + JSON.stringify(id) + ";");
  out.push("const CAP_KIND = " + JSON.stringify(spec.kind || "tool") + ";");
  out.push("const ACCEPTS = " + JSON.stringify(accepts, null, 2) + ";");
  out.push("const PRODUCES = " + JSON.stringify(produces, null, 2) + ";");
  out.push("const REQUIRES = " + JSON.stringify(requires, null, 2) + ";");
  out.push("const ENV_MAP = " + JSON.stringify(env_map, null, 2) + ";");
  out.push("const KERNEL_SCRIPT = " + JSON.stringify(code) + ";");
  out.push("const DEFAULT_TIMEOUT_MS = 90000;");
  out.push("");
  out.push("export const capability = {");
  out.push("  id: CAP_ID,");
  out.push("  kind: CAP_KIND,");
  out.push("  invoked_via: \"invoker.in_process_js\",");
  out.push("  accepts: ACCEPTS,");
  out.push("  produces: PRODUCES,");
  out.push("  requires: REQUIRES,");
  out.push("};");
  out.push("");
  out.push("async function _prepare(ctx, session) {");
  out.push("  const { prepareSession } = await import(" + JSON.stringify(INSTALLER_PATH) + ");");
  out.push("  await prepareSession(ctx, { capId: CAP_ID, session, requires_override: REQUIRES });");
  out.push("}");
  out.push("");
  out.push("async function run(input, ctx, opts = {}) {");
  out.push("  const session = opts.session || input.session || (CAP_ID + \"-default\");");
  out.push("  if (typeof ctx.invoke !== \"function\") throw new Error(CAP_ID + \" requires ctx.invoke\");");
  out.push("  await _prepare(ctx, session);");
  out.push("  await ctx.invoke(\"agentry.os\", { action: \"session.create\", id: session });");
  out.push("  const env = {};");
  out.push("  for (const [envKey, inputKey] of Object.entries(ENV_MAP)) {");
  out.push("    const v = input[inputKey];");
  out.push("    env[envKey] = v === undefined || v === null ? \"\" : String(v);");
  out.push("  }");
  out.push("  const timeout_ms = input.timeout_ms || DEFAULT_TIMEOUT_MS;");
  out.push("  const res = await ctx.invoke(\"agentry.os\", {");
  out.push("    action: \"node.run\", session, code: KERNEL_SCRIPT, env, timeout_ms,");
  out.push("  }, { tenant: \"local\", by: CAP_ID });");
  out.push("  if (!res.ok) throw new Error(CAP_ID + \": kernel call failed — \" + (res.error?.message || \"unknown\"));");
  out.push("  const r = res.output.result || {};");
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
  out.push("  // Verification happened during DSH synthesis; this is a no-op pass.");
  out.push("  return { ok: true };");
  out.push("}");
  out.push("");
  out.push("export default run;");
  out.push("");
  return out.join("\n");
}

function parseDshSpec(text) {
  if (!text) return null;
  let s = String(text).trim();
  // v0.52.30 — prior version used `/```(?:json)?\s*([\s\S]*?)```/` (lazy).
  // If DSH's JSON contains ``` inside a code-fence *inside a string value*
  // (e.g. test_script with ```javascript), the lazy match grabbed the
  // INNER backticks and truncated the JSON to garbage. That's why v0.52.29
  // returned no_spec with a valid 1708-char JSON that we mangled.
  // Fix: only strip fence if it wraps the ENTIRE string. Use anchored
  // greedy match. If content starts with `{`, treat as raw JSON — never
  // fence-strip.
  if (!s.startsWith("{")) {
    const wholeFence = s.match(/^```(?:json)?\s*\n?([\s\S]*)\n?```\s*$/);
    if (wholeFence) s = wholeFence[1].trim();
  }
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  s = s.slice(first, last + 1);
  try { return JSON.parse(s); } catch (e) {
    // Log detailed parse failure for future debugging
    if (typeof globalThis !== "undefined") globalThis.__LAST_DSH_PARSE_ERR = {
      error: e.message,
      len: s.length,
      head: s.slice(0, 200),
      tail: s.slice(-200),
    };
    return null;
  }
}

export default async function agentrySynthesizeViaDsh(input, ctx) {
  const { capability_id, intent, wanted_kind, wanted_description, accepts_hint, produces_hint, timeout_ms } = input || {};
  if (!capability_id) throw new Error("agentry.synthesize_via_dsh requires capability_id");
  if (typeof ctx.invoke !== "function") throw new Error("agentry.synthesize_via_dsh requires ctx.invoke");

  const started = Date.now();
  const events = ctx.events;
  const graph = ctx.graph;
  const timeoutMs = Math.max(30000, Math.min(300000, Number(timeout_ms) || 180000));
  const safeId = sanitizeId(capability_id);

  events.emit("dsh_synth.started", { capability_id, intent, wanted_kind, timeout_ms: timeoutMs });

  // ── 1. Ask DSH for a spec ──
  const _refs = pickReferenceHandlers(String(intent || capability_id), wanted_kind || "tool", 2);
  events.emit("dsh_synth.references_picked", { capability_id, count: _refs.length, ids: _refs.map(r => r.id) });
  const prompt = buildDshPrompt({ capability_id, intent, wanted_kind, wanted_description, accepts_hint, produces_hint, references: formatReferences(_refs) });
  let dshRes;
  try {
    dshRes = await ctx.invoke("agentry.agent.dsh", { prompt, timeout_ms: timeoutMs },
      { tenant: "local", by: "agentry.synthesize_via_dsh" });
  } catch (e) {
    events.emit("dsh_synth.dsh_threw", { capability_id, error: e.message });
    return { output: { verified: false, capability_id, reason: "dsh_threw: " + e.message }, cost: { time_ms: Date.now() - started } };
  }
  if (!dshRes.ok) {
    events.emit("dsh_synth.dsh_failed", { capability_id, error: dshRes.error?.message });
    return { output: { verified: false, capability_id, reason: "dsh_failed: " + (dshRes.error?.message || "unknown") }, cost: { time_ms: Date.now() - started } };
  }
  const finalText = String(dshRes.output?.final || "");
  const spec = extractJson(finalText);
  if (!spec) {
    // v0.52.27 — log the full DSH result shape so next debug doesn't need
    // a separate probe. Prior version only logged final_preview which was
    // empty when DSH timed out with no final event.
    const _tc = dshRes.output?.tool_calls || [];
    events.emit("dsh_synth.no_spec", {
      capability_id,
      final_preview: finalText.slice(0, 300),
      final_len: finalText.length,
      exit_code: dshRes.output?.exit_code ?? null,
      timed_out: dshRes.output?.timed_out === true,
      duration_ms: dshRes.output?.duration_ms ?? null,
      tool_calls_count: _tc.length,
      tool_calls: _tc.map(t => t.tool).slice(0, 20),
      messages_count: (dshRes.output?.messages || []).length,
      stderr_preview: String(dshRes.output?.stderr || "").slice(0, 300),
      parse_error: (typeof globalThis !== "undefined" && globalThis.__LAST_DSH_PARSE_ERR) || null,
    });
    if (typeof globalThis !== "undefined") delete globalThis.__LAST_DSH_PARSE_ERR;
    return { output: { verified: false, capability_id, reason: "no_spec_in_dsh_output" }, cost: { time_ms: Date.now() - started } };
  }
  if (spec.error) {
    events.emit("dsh_synth.spec_error", { capability_id, error: String(spec.error).slice(0, 200) });
    return { output: { verified: false, capability_id, reason: "dsh_reported_error: " + String(spec.error).slice(0, 200) }, cost: { time_ms: Date.now() - started } };
  }
  if (!spec.package_name || !spec.code_body) {
    events.emit("dsh_synth.incomplete_spec", { capability_id, has_pkg: !!spec.package_name, has_code: !!spec.code_body });
    return { output: { verified: false, capability_id, reason: "incomplete_spec" }, cost: { time_ms: Date.now() - started } };
  }
  // v0.52.28 — require test_script. This is what we run BEFORE rendering the
  // handler. If the package's API doesn't work in this environment, test_script
  // fails and we abort early instead of producing a broken handler.
  if (!spec.test_script) {
    events.emit("dsh_synth.missing_test_script", { capability_id, package_name: spec.package_name });
    return { output: { verified: false, capability_id, reason: "missing_test_script" }, cost: { time_ms: Date.now() - started } };
  }

  // ── 1.5 v0.52.29 — run test_script FIRST ──
  // v0.52.28 asked DSH to provide a test_script field but never ran it.
  // That made the field a suggestion, not a constraint. This block actually
  // executes test_script against the real package (installed fresh), verifies
  // the output file appears with >0 bytes, and only THEN proceeds to render
  // the handler. If test_script fails, we return early with a specific reason
  // so the caller knows it's a package/API issue (e.g. markdown-pdf@11 uses
  // Promise not stream) — not a handler-render issue.
  const preTestSession = "dsh_synth_preverify_" + safeId + "_" + Date.now().toString(36);
  try {
    await ctx.invoke("agentry.os", { action: "session.create", id: preTestSession });

    const installRes = await ctx.invoke("agentry.os", {
      action: "node.install", session: preTestSession, packages: [spec.package_name],
    }, { tenant: "local", by: "agentry.synthesize_via_dsh" });
    if (!installRes.ok) {
      events.emit("dsh_synth.pretest_install_failed", { capability_id, package_name: spec.package_name, error: installRes.error?.message });
      return { output: { verified: false, capability_id, reason: "pretest_install_failed: " + (installRes.error?.message || "unknown") }, cost: { time_ms: Date.now() - started } };
    }

    const fixtureCmd = String(spec.test_fixture || "");
    if (fixtureCmd) {
      const fixRes = await ctx.invoke("agentry.os", { action: "shell.spawn", session: preTestSession, cmd: "sh", args: ["-c", fixtureCmd], timeout_ms: 30000 });
      const fixPid = fixRes.output?.result?.pid;
      if (fixPid) {
        await ctx.invoke("agentry.os", { action: "shell.read", session: preTestSession, pid: fixPid, wait_ms: 30000 });
      }
    }

    const testEnv = {
      INPUT_PATH: spec.test_input_path || "/tmp/dsh_test_input",
      OUTPUT_PATH: spec.test_output_path || "/tmp/dsh_test_output",
    };
    const testRes = await ctx.invoke("agentry.os", {
      action: "node.run", session: preTestSession, code: String(spec.test_script),
      env: testEnv, timeout_ms: 45000,
    }, { tenant: "local", by: "agentry.synthesize_via_dsh" });
    const testStderr = String(testRes.output?.result?.stderr || "");
    const testExitCode = testRes.output?.result?.exit_code;
    if (!testRes.ok || (testExitCode !== 0 && testExitCode !== null && testExitCode !== undefined)) {
      events.emit("dsh_synth.pretest_failed", {
        capability_id, package_name: spec.package_name,
        exit_code: testExitCode,
        stderr: testStderr.slice(0, 500),
      });
      return { output: { verified: false, capability_id, reason: "pretest_failed: exit " + testExitCode + " — " + testStderr.slice(0, 200) }, cost: { time_ms: Date.now() - started } };
    }

    const outCheck = await ctx.invoke("agentry.os", {
      action: "shell.spawn", session: preTestSession, cmd: "sh",
      args: ["-c", "test -s '" + testEnv.OUTPUT_PATH + "' && stat -c %s '" + testEnv.OUTPUT_PATH + "'"],
      timeout_ms: 5000,
    });
    const outPid = outCheck.output?.result?.pid;
    let outBytes = 0;
    if (outPid) {
      const outRead = await ctx.invoke("agentry.os", { action: "shell.read", session: preTestSession, pid: outPid, wait_ms: 5000 });
      outBytes = parseInt(String(outRead.output?.result?.stdout || "0").trim(), 10);
    }
    if (!outBytes || outBytes <= 0) {
      events.emit("dsh_synth.pretest_no_output", { capability_id, package_name: spec.package_name, output_path: testEnv.OUTPUT_PATH });
      return { output: { verified: false, capability_id, reason: "pretest_no_output: " + testEnv.OUTPUT_PATH }, cost: { time_ms: Date.now() - started } };
    }

    events.emit("dsh_synth.pretest_passed", { capability_id, package_name: spec.package_name, output_bytes: outBytes });
  } catch (e) {
    events.emit("dsh_synth.pretest_threw", { capability_id, error: e.message });
    return { output: { verified: false, capability_id, reason: "pretest_threw: " + e.message }, cost: { time_ms: Date.now() - started } };
  }

  // ── 2. Render handler ──
  mkdirSync(HANDLERS_DIR, { recursive: true });
  mkdirSync(SEEDS_DIR, { recursive: true });
  const handlerPath = join(HANDLERS_DIR, safeId + ".mjs");
  const seedPath = join(SEEDS_DIR, safeId + ".json");

  try {
    writeFileSync(handlerPath, renderHandler(spec, capability_id));
  } catch (e) {
    events.emit("dsh_synth.render_failed", { capability_id, error: e.message });
    return { output: { verified: false, capability_id, reason: "render_failed: " + e.message }, cost: { time_ms: Date.now() - started } };
  }

  // ── 3. Syntax check ──
  const check = spawnSync("node", ["--check", handlerPath], { encoding: "utf8", timeout: 15000 });
  if (check.status !== 0) {
    events.emit("dsh_synth.syntax_error", { capability_id, stderr: String(check.stderr || "").slice(0, 400) });
    try { unlinkSync(handlerPath); } catch {}
    return { output: { verified: false, capability_id, reason: "syntax_error: " + String(check.stderr || "").slice(0, 200) }, cost: { time_ms: Date.now() - started } };
  }

  // ── 4. Write trial graph node (verification target) ──
  const trialCapId = "_trial_" + safeId + "_" + Date.now().toString(36);
  graph.putCapability({
    id: trialCapId, kind: "tool",
    invoked_via: "invoker.in_process_js",
    handler: safeId,
    handler_file: handlerPath,
    accepts: spec.accepts || {},
    produces: spec.produces || {},
    requires: { npm: [spec.package_name], pip: [], post_install: null, capability: [] },
    source: "dsh_synth:trial",
    trial: true,
  });

  // ── 5. Verify via real execution ──
  const testSession = "dsh_synth_verify_" + safeId + "_" + Date.now().toString(36);
  let verified = false;
  let reason = "unknown";
  try {
    await ctx.invoke("agentry.os", { action: "session.create", id: testSession });

    const fixtureCmd = String(spec.test_fixture || "");
    if (fixtureCmd) {
      const fixtureRes = await ctx.invoke("agentry.os", { action: "shell.spawn", session: testSession, cmd: "sh", args: ["-c", fixtureCmd], timeout_ms: 30000 });
      const fixturePid = fixtureRes.output?.result?.pid;
      if (fixturePid) {
        const read = await ctx.invoke("agentry.os", { action: "shell.read", session: testSession, pid: fixturePid, wait_ms: 30000 });
        const ec = read.output?.result?.exit_code;
        if (ec !== 0 && ec !== null && ec !== undefined) {
          throw new Error("fixture_cmd_failed: exit " + ec + " — " + String(read.output?.result?.stderr || "").slice(0, 200));
        }
      }
    }

    const testInput = {};
    for (const k of Object.keys(spec.accepts || {})) {
      if (k === "input_path" || k.endsWith("_path") || k.endsWith("_file")) {
        testInput[k] = spec.test_input_path || "/tmp/dsh_test_input";
      } else if (k === "output_path") {
        testInput[k] = spec.test_output_path || "/tmp/dsh_test_output";
      } else {
        testInput[k] = "test";
      }
    }
    testInput.session = testSession;

    const invRes = await ctx.invoke(trialCapId, testInput, { tenant: "local", by: "agentry.synthesize_via_dsh" });
    if (!invRes.ok) throw new Error("invoke_failed: " + (invRes.error?.message || "unknown"));

    const outPath = spec.test_output_path;
    if (outPath) {
      const statRes = await ctx.invoke("agentry.os", { action: "shell.spawn", session: testSession, cmd: "sh", args: ["-c", "test -s '" + outPath + "' && stat -c %s '" + outPath + "'"], timeout_ms: 5000 });
      const statPid = statRes.output?.result?.pid;
      if (statPid) {
        const read = await ctx.invoke("agentry.os", { action: "shell.read", session: testSession, pid: statPid, wait_ms: 5000 });
        const bytes = parseInt(String(read.output?.result?.stdout || "0").trim(), 10);
        if (!bytes || bytes <= 0) throw new Error("output_file_empty_or_missing: " + outPath);
      }
    }
    verified = true;
  } catch (e) {
    reason = e.message;
    events.emit("dsh_synth.verify_failed", { capability_id, reason });
  }

  try {
    const _tg = graph.getCapability("gap:" + trialCapId);
    if (_tg && !_tg.retired_at) graph.retireCapability(_tg.id, "trial_ephemeral_failed");
  } catch {}

  try { graph.retireCapability(trialCapId, "trial verification complete"); } catch {}

  if (!verified) {
    try { unlinkSync(handlerPath); } catch {}
    events.emit("dsh_synth.failed", { capability_id, reason, ms: Date.now() - started });
    return { output: { verified: false, capability_id, reason }, cost: { time_ms: Date.now() - started } };
  }

  // ── 6. Write real graph node + seed ──
  const seedContent = {
    id: capability_id, kind: "tool", invoked_via: "invoker.in_process_js",
    handler: safeId, handler_file: handlerPath,
    accepts: spec.accepts, produces: spec.produces,
    requires: { npm: [spec.package_name], pip: [], post_install: null, capability: [] },
    source: "dsh_synth:verified",
  };
  try { writeFileSync(seedPath, JSON.stringify(seedContent, null, 2)); } catch {}
  graph.putCapability(seedContent);

  try {
    const gapKey = "gap:" + capability_id;
    const gapNode = graph.getCapability(gapKey);
    if (gapNode && !gapNode.retired_at) {
      graph.retireCapability(gapKey, "resolved_by_dsh_synthesis");
      events.emit("dsh_synth.gap_retired", { capability_id, gap_id: gapKey });
    }
  } catch (e) {
    events.emit("dsh_synth.gap_retire_failed", { capability_id, error: e.message });
  }

  events.emit("dsh_synth.completed", {
    capability_id, handler_path: handlerPath, package: spec.package_name,
    ms: Date.now() - started,
  });

  return {
    output: {
      verified: true, capability_id, handler_path: handlerPath,
      seed_path: seedPath, package_name: spec.package_name,
      accepts: spec.accepts, produces: spec.produces,
    },
    cost: { time_ms: Date.now() - started },
  };
}
