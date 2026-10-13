// agentry/src/handlers/agentry.synthesize.mjs
//
// The teaching handler. Given an approved candidate, produce a working
// handler for the gap it fills — following the shape of bua.screenshot.
//
//   1. Resolve proposal + candidate + gap from the graph.
//   2. If candidate.kind === "repo": clone into a kernel session,
//      read README + manifest. Facts, not vibes.
//   3. Ask the LLM for a SPEC (JSON slots, not freeform code).
//   4. Render the spec into a .mjs handler + a seed .json.
//   5. Return paths. Do NOT write the graph. Trial gates that.

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HANDLERS_DIR = process.env.AGENTRY_HANDLERS_DIR
  || "/tmp/home/.dsh/agentry-synthesized/handlers";
const SEEDS_DIR = process.env.AGENTRY_SEEDS_DIR
  || "/tmp/home/.dsh/agentry-synthesized/seeds";
const REFERENCE_FILE = "bua.screenshot.mjs";
const DEFAULT_SYNTH_MODEL = process.env.AGENTRY_SYNTH_MODEL || "gpt-oss-20b:free";
const DEFAULT_SYNTH_PROVIDER = process.env.AGENTRY_SYNTH_PROVIDER || "unorouter";
const MAX_README_CHARS = 12000;
const MAX_MANIFEST_CHARS = 4000;

// ─────────────────────────────────────────────────────────────
// Repo fact gathering — deterministic, no LLM
// ─────────────────────────────────────────────────────────────

async function readRepoTerritory(candidate, deps) {
  const session = "synth_" + candidate.id.replace(/[^a-z0-9_.-]/gi, "_") + "_" + Date.now().toString(36);
  const { invoke } = deps;

  await invoke("agentry.os", { action: "session.create", id: session },
    { tenant: "local", by: "agentry.synthesize" });

  const facts = {
    session,
    cloned: false,
    readme: null,
    manifest: null,
    manifest_path: null,
    top_level: [],
    error: null,
  };

  try {
    const cloneRes = await invoke("agentry.os", {
      action: "git.clone",
      session,
      url: candidate.url,
      dir: "repo",
    }, { tenant: "local", by: "agentry.synthesize" });

    if (!cloneRes.ok) {
      facts.error = "git.clone failed: " + cloneRes.error.message;
      return facts;
    }
    facts.cloned = true;

    const listRes = await invoke("agentry.os", {
      action: "fs.list",
      session,
      path: "repo",
    }, { tenant: "local", by: "agentry.synthesize" });

    if (listRes.ok) {
      const entries = listRes.output?.result?.entries || listRes.output?.entries || [];
      facts.top_level = Array.isArray(entries)
        ? entries.slice(0, 40).map(e => (typeof e === "string" ? e : e.name))
        : [];
    }

    const readmeCandidates = ["README.md", "README.rst", "README.txt", "Readme.md", "readme.md"];
    for (const name of readmeCandidates) {
      const r = await invoke("agentry.os", {
        action: "fs.read",
        session,
        path: "repo/" + name,
      }, { tenant: "local", by: "agentry.synthesize" });
      if (r.ok && r.output?.content) {
        facts.readme = String(r.output.content).slice(0, MAX_README_CHARS);
        break;
      }
    }

    const manifestCandidates = [
      "package.json", "pyproject.toml", "setup.py", "requirements.txt",
      "Cargo.toml", "go.mod", "pom.xml",
    ];
    for (const name of manifestCandidates) {
      const r = await invoke("agentry.os", {
        action: "fs.read",
        session,
        path: "repo/" + name,
      }, { tenant: "local", by: "agentry.synthesize" });
      if (r.ok && r.output?.content) {
        facts.manifest = String(r.output.content).slice(0, MAX_MANIFEST_CHARS);
        facts.manifest_path = name;
        break;
      }
    }
  } catch (e) {
    facts.error = "repo read threw: " + e.message;
  }

  return facts;
}

// ─────────────────────────────────────────────────────────────
// The prompt — assembled by concatenation, no nested backticks
// ─────────────────────────────────────────────────────────────

function buildPrompt({ gap, candidate, facts, referenceHandler }) {
  const gapJson = JSON.stringify({
    id: gap.id,
    wanted_id: gap.wanted_id || gap.id.replace(/^gap:/, ""),
    wanted_kind: gap.wanted_kind,
    reason: gap.reason || null,
  }, null, 2);

  const candidateJson = JSON.stringify({
    id: candidate.id,
    name: candidate.name || null,
    url: candidate.url || null,
    kind: candidate.kind || null,
    description: candidate.description || null,
  }, null, 2);

  const repoFacts = facts.cloned
    ? "Top-level files:\n" + (facts.top_level.join("\n") || "(none listed)") + "\n\n"
      + (facts.readme ? "README:\n<<<\n" + facts.readme + "\n>>>\n\n" : "")
      + (facts.manifest ? (facts.manifest_path + ":\n<<<\n" + facts.manifest + "\n>>>\n") : "")
    : "(no repo facts available — candidate kind is " + candidate.kind + ")";

  const lines = [];
  lines.push("You are agentry's code synthesizer.");
  lines.push("");
  lines.push("A gap has been approved for adoption. Produce a JSON spec that fills");
  lines.push("slots in a handler template. The runtime renders your spec into a real");
  lines.push(".mjs file. Do NOT write the handler yourself.");
  lines.push("");
  lines.push("Return ONLY a JSON object. No prose. No markdown fences.");
  lines.push("");
  lines.push("=== THE GAP ===");
  lines.push(gapJson);
  lines.push("");
  lines.push("=== THE CANDIDATE ===");
  lines.push(candidateJson);
  lines.push("");
  lines.push("=== REPO FACTS ===");
  lines.push(repoFacts);
  lines.push("");
  lines.push("=== THE REFERENCE HANDLER — study this shape ===");
  lines.push("The template exports capability, accept, and a default run(input, ctx).");
  lines.push("It uses ctx.invoke(\"agentry.os\", { action: \"node.run\", session, code, env })");
  lines.push("to run a Node script inside a kernel session. Your kernel_script will be");
  lines.push("run the same way. The script's stdout becomes the handler's output.");
  lines.push("");
  lines.push("--- BEGIN REFERENCE HANDLER ---");
  lines.push(referenceHandler);
  lines.push("--- END REFERENCE HANDLER ---");
  lines.push("");
  lines.push("=== PRODUCE THIS JSON ===");
  lines.push("{");
  lines.push("  \"capability\": {");
  lines.push("    \"id\": \"<dotted id, e.g. 'bua.browser'>\",");
  lines.push("    \"kind\": \"<bua|cua|mua|memory|tool|notify|web|harness|unknown>\",");
  lines.push("    \"accepts\": { \"<key>\": \"string\" | { \"type\": \"string|number|boolean\", \"optional\": true } },");
  lines.push("    \"produces\": { \"<output_key>\": \"string|number|boolean\" },");
  lines.push("    \"requires\": {");
  lines.push("      \"npm\": [\"<pkg>\"],");
  lines.push("      \"pip\": [\"<pkg>\"],");
  lines.push("      \"post_install\": \"<shell cmd or null>\"");
  lines.push("    }");
  lines.push("  },");
  lines.push("  \"accept_spec\": {");
  lines.push("    \"input\": { \"<key>\": \"<value for the acceptance probe>\" },");
  lines.push("    \"min_bytes\": 500");
  lines.push("  },");
  lines.push("  \"kernel_language\": \"node\" | \"python\",");
  lines.push("  \"kernel_script\": \"<the code that runs in the kernel session. Reads env vars set by the handler. Writes its result to stdout.>\",");
  lines.push("  \"glue\": {");
  lines.push("    \"env_map\": { \"<ENV_VAR>\": \"<input_key>\" },");
  lines.push("    \"result_parse\": \"stdout_text\" | \"stdout_json\",");
  lines.push("    \"output_map\": { \"<output_key>\": \"<dot.path into parsed result>\" }");
  lines.push("  }");
  lines.push("}");
  lines.push("");
  lines.push("Rules:");
  lines.push("- Output ONLY JSON. No prose. No fences.");
  lines.push("- kernel_script runs in a kernel session. It reads env vars (from env_map)");
  lines.push("  and writes its result to stdout. For binary outputs, write base64.");
  lines.push("- If you cannot produce a working handler, output: { \"error\": \"<reason>\" }");
  lines.push("- Prefer ONE npm package over five. Prefer an API call over spawning a browser.");
  lines.push("- requires.npm must be exact package names (playwright, requests, etc).");
  lines.push("- post_install is a shell one-liner or null (e.g. \"npx playwright install chromium\").");

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────
// Rendering — spec → .mjs + .json
// ─────────────────────────────────────────────────────────────

function renderHandler(spec) {
  const { capability, glue, kernel_script, kernel_language } = spec;
  const lang = kernel_language === "python" ? "python" : "node";
  const action = lang === "python" ? "python.run" : "node.run";

  const out = [];
  out.push("// agentry — synthesized handler for " + capability.id);
  out.push("// Generated by agentry.synthesize. Regenerate, do not hand-edit.");
  out.push("// Kind: " + capability.kind);
  out.push("// Kernel language: " + lang);
  out.push("");
  out.push("const CAP_ID = " + JSON.stringify(capability.id) + ";");
  out.push("const CAP_KIND = " + JSON.stringify(capability.kind) + ";");
  out.push("const ACCEPTS = " + JSON.stringify(capability.accepts || {}, null, 2) + ";");
  out.push("const PRODUCES = " + JSON.stringify(capability.produces || {}, null, 2) + ";");
  out.push("const REQUIRES = " + JSON.stringify(capability.requires || {}, null, 2) + ";");
  out.push("const ENV_MAP = " + JSON.stringify(glue.env_map || {}, null, 2) + ";");
  out.push("const OUTPUT_MAP = " + JSON.stringify(glue.output_map || {}, null, 2) + ";");
  out.push("const RESULT_PARSE = " + JSON.stringify(glue.result_parse || "stdout_text") + ";");
  out.push("const KERNEL_ACTION = " + JSON.stringify(action) + ";");
  out.push("const KERNEL_SCRIPT = " + JSON.stringify(kernel_script || "") + ";");
  out.push("");
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
  out.push("export async function accept(deps, opts = {}) {");
  out.push("  const session = opts.session || (CAP_ID + \"-accept-test\");");
  out.push("  const { prepareSession } = await import(\"../runtime/installer.mjs\");");
  out.push("  await prepareSession(deps, { capId: CAP_ID, session });");
  out.push("  const probe = await run(" + JSON.stringify(spec.accept_spec?.input || {}) + ", deps, { session });");
  out.push("  const out = probe.output || probe;");
  out.push("  const minBytes = " + (spec.accept_spec?.min_bytes ?? 0) + ";");
  out.push("  if (minBytes > 0) {");
  out.push("    const size = typeof out.bytes === \"number\" ? out.bytes : 0;");
  out.push("    if (size < minBytes) {");
  out.push("      throw new Error(\"accept: output too small (\" + size + \" < \" + minBytes + \")\");");
  out.push("    }");
  out.push("  }");
  out.push("  return { ok: true, session, output: out };");
  out.push("}");
  out.push("");
  out.push("async function run(input, ctx, opts = {}) {");
  out.push("  const session = opts.session || input.session || (CAP_ID + \"-default\");");
  out.push("  const timeout_ms = input.timeout_ms || DEFAULT_TIMEOUT_MS;");
  out.push("");
  out.push("  if (typeof ctx.invoke !== \"function\") {");
  out.push("    throw new Error(CAP_ID + \" requires ctx.invoke\");");
  out.push("  }");
  out.push("");
  out.push("  await ctx.invoke(\"agentry.os\", { action: \"session.create\", id: session },");
  out.push("    { tenant: \"local\", by: CAP_ID });");
  out.push("");
  out.push("  const env = {};");
  out.push("  for (const [envKey, inputKey] of Object.entries(ENV_MAP)) {");
  out.push("    const v = input[inputKey];");
  out.push("    env[envKey] = v === undefined || v === null ? \"\" : String(v);");
  out.push("  }");
  out.push("");
  out.push("  const res = await ctx.invoke(\"agentry.os\", {");
  out.push("    action: KERNEL_ACTION,");
  out.push("    session,");
  out.push("    code: KERNEL_SCRIPT,");
  out.push("    env,");
  out.push("    timeout_ms,");
  out.push("  }, { tenant: \"local\", by: CAP_ID });");
  out.push("");
  out.push("  if (!res.ok) {");
  out.push("    throw new Error(CAP_ID + \": kernel call failed — \" + res.error.code + \": \" + res.error.message);");
  out.push("  }");
  out.push("");
  out.push("  const r = res.output.result || res.output;");
  out.push("  const exitCode = r.exit_code ?? r.exitCode ?? 0;");
  out.push("  if (exitCode !== 0) {");
  out.push("    throw new Error(CAP_ID + \": kernel exited \" + exitCode + \" — \" + String(r.stderr || \"\").slice(0, 300));");
  out.push("  }");
  out.push("");
  out.push("  const stdout = String(r.stdout || \"\");");
  out.push("  if (!stdout.trim()) {");
  out.push("    throw new Error(CAP_ID + \": kernel produced no output\");");
  out.push("  }");
  out.push("");
  out.push("  let raw;");
  out.push("  if (RESULT_PARSE === \"stdout_json\") {");
  out.push("    try { raw = JSON.parse(stdout); }");
  out.push("    catch (e) { throw new Error(CAP_ID + \": stdout not JSON — \" + e.message); }");
  out.push("  } else {");
  out.push("    raw = stdout.trim();");
  out.push("  }");
  out.push("");
  out.push("  const output = {};");
  out.push("  for (const [outKey, path] of Object.entries(OUTPUT_MAP)) {");
  out.push("    let v = raw;");
  out.push("    for (const p of String(path).split(\".\")) v = v?.[p];");
  out.push("    output[outKey] = v;");
  out.push("  }");
  out.push("  if (output.bytes === undefined) {");
  out.push("    output.bytes = typeof raw === \"string\" ? Buffer.byteLength(raw) : JSON.stringify(raw).length;");
  out.push("  }");
  out.push("  output.captured_at = Date.now();");
  out.push("");
  out.push("  return { output, cost: { time_ms: r.ms || 0 } };");
  out.push("}");
  out.push("");
  out.push("export default run;");
  out.push("");

  return out.join("\n");
}

function renderSeed(spec, handlerPath) {
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
    source: "synthesized:agentry.synthesize",
    notes: "Auto-generated. Regenerate rather than edit.",
  };
}

function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  try { return JSON.parse(s.slice(first, last + 1)); } catch { return null; }
}

// ─────────────────────────────────────────────────────────────
// The handler
// ─────────────────────────────────────────────────────────────

export default async function agentrySynthesize(input, ctx) {
  const { proposal_id, candidate_id } = input || {};
  if (!proposal_id) throw new Error("agentry.synthesize requires proposal_id");
  if (!candidate_id) throw new Error("agentry.synthesize requires candidate_id");
  if (typeof ctx.invoke !== "function") throw new Error("agentry.synthesize requires ctx.invoke");

  const started = Date.now();
  const { graph, events } = ctx;

  const proposal = graph.getCapability(proposal_id);
  if (!proposal) throw new Error("agentry.synthesize: proposal not found: " + proposal_id);

  const candidate = (proposal.candidates || []).find(c => c.id === candidate_id);
  if (!candidate) throw new Error("agentry.synthesize: candidate " + candidate_id + " not in proposal");

  const gap = proposal.gap_id ? graph.getCapability(proposal.gap_id) : null;
  if (!gap) throw new Error("agentry.synthesize: gap " + proposal.gap_id + " not found");

  events.emit("synthesize.started", {
    proposal_id, candidate_id, gap_id: gap.id,
    candidate_kind: candidate.kind,
  });

  let facts = { cloned: false, session: null, error: null, top_level: [], readme: null, manifest: null };
  if (candidate.kind === "repo" && candidate.url) {
    try {
      facts = await readRepoTerritory(candidate, ctx);
      events.emit("synthesize.repo_read", {
        proposal_id, candidate_id,
        cloned: facts.cloned, error: facts.error,
        readme_len: facts.readme ? facts.readme.length : 0,
        manifest: facts.manifest_path,
        top_level_count: facts.top_level.length,
      });
    } catch (e) {
      events.emit("synthesize.repo_read_failed", { proposal_id, candidate_id, error: e.message });
    }
  }

  const referenceHandler = readFileSync(join(HERE, REFERENCE_FILE), "utf8");
  const prompt = buildPrompt({ gap, candidate, facts, referenceHandler });

  const llmRes = await ctx.invoke("llm.openai_compat", {
    model: DEFAULT_SYNTH_MODEL,
    provider: DEFAULT_SYNTH_PROVIDER,
    messages: [
      { role: "system", content: "You output only JSON. No prose. No fences." },
      { role: "user", content: prompt },
    ],
    temperature: 0.1,
    max_tokens: 4000,
  }, { tenant: "local", by: "agentry.synthesize" });

  if (!llmRes.ok) {
    events.emit("synthesize.llm_failed", {
      proposal_id, candidate_id,
      code: llmRes.error.code, message: llmRes.error.message,
    });
    throw new Error("agentry.synthesize: llm failed — " + llmRes.error.code + ": " + llmRes.error.message);
  }

  const spec = extractJson(llmRes.output.content);
  if (!spec) {
    events.emit("synthesize.unparseable", {
      proposal_id, candidate_id,
      preview: String(llmRes.output.content || "").slice(0, 300),
    });
    throw new Error("agentry.synthesize: could not parse spec from LLM output");
  }
  if (spec.error) {
    events.emit("synthesize.refused", { proposal_id, candidate_id, reason: spec.error });
    throw new Error("agentry.synthesize: LLM declined — " + spec.error);
  }
  if (!spec.capability?.id || !spec.kernel_script || !spec.glue) {
    throw new Error("agentry.synthesize: spec missing capability.id, kernel_script, or glue");
  }

  mkdirSync(HANDLERS_DIR, { recursive: true });
  mkdirSync(SEEDS_DIR, { recursive: true });

  const handlerPath = join(HANDLERS_DIR, spec.capability.id + ".mjs");
  const seedPath = join(SEEDS_DIR, spec.capability.id + ".json");

  writeFileSync(handlerPath, renderHandler(spec));
  writeFileSync(seedPath, JSON.stringify(renderSeed(spec, handlerPath), null, 2));

  events.emit("synthesize.completed", {
    proposal_id, candidate_id, gap_id: gap.id,
    capability_id: spec.capability.id,
    kind: spec.capability.kind,
    handler_path: handlerPath,
    seed_path: seedPath,
    ms: Date.now() - started,
  });

  return {
    output: {
      capability_id: spec.capability.id,
      kind: spec.capability.kind,
      handler_path: handlerPath,
      seed_path: seedPath,
      repo_session: facts.session,
      repo_read: facts.cloned,
      spec,
      model_used: llmRes.output.model || DEFAULT_SYNTH_MODEL,
    },
    cost: { time_ms: Date.now() - started },
  };
}
