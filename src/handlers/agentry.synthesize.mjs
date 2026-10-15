// agentry/src/handlers/agentry.synthesize.mjs
//
// The teaching handler. Given an approved candidate, produce a working
// handler for the gap it fills — following the shape of bua.screenshot.
//
// v0.15.19:
//   - Synthesized handlers call prepareSession at the top of run().
//
// v0.15.12:
//   - Fix double-escaped kernel_script from reasoning models.
//
// v0.15.11:
//   - Synthesized handlers import installer.mjs via an absolute path.
//
// v0.15.25 — composition.
//   The spec schema now accepts two new fields:
//     capability.requires.capability: [<id>, ...]
//         Other agentry capabilities this handler depends on. Each must
//         exist in the graph or the trial fails with a named phase.
//         prepareSession recurses through these so the outer's session
//         has all inner deps installed.
//     glue.pre_invoke: { <ENV_VAR>: { capability, input_map, extract } }
//         Before running kernel_script, invoke each named capability and
//         store an extracted field of its output in an env var the
//         kernel script reads. This is how a composed handler actually
//         uses the inner capability it declared.
//   The prompt teaches the model to prefer composing over reinventing.

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HANDLERS_DIR = process.env.AGENTRY_HANDLERS_DIR
  || "/tmp/home/.dsh/agentry-synthesized/handlers";
const SEEDS_DIR = process.env.AGENTRY_SEEDS_DIR
  || "/tmp/home/.dsh/agentry-synthesized/seeds";
const REFERENCE_FILE = "bua.screenshot.mjs";
const MAX_README_CHARS = 12000;
const MAX_MANIFEST_CHARS = 4000;

// Absolute path to installer.mjs, resolved once at load. Baked into every
// synthesized handler so it can import prepareSession without depending
// on relative path resolution.
const INSTALLER_PATH = join(HERE, "..", "runtime", "installer.mjs").replace(/\\/g, "/");

const MODEL_CHAIN = [
  { provider: "groq", model: "openai/gpt-oss-120b" },
  { provider: "groq", model: "openai/gpt-oss-20b" },
  { provider: "groq", model: "qwen/qwen3.8-27b" },
  { provider: "google", model: "gemini-2.5-flash" },
];

// Some reasoning models emit code as a string with literal \n and \"
// sequences inside their JSON, and those survive JSON.parse as two
// characters instead of one. Symptom: the kernel script has no real
// newlines but many "\n" substrings, and node fails to parse it.
//
// Detect that pattern precisely and decode once. If the string already
// contains real newlines (which is what a well-behaved model emits), we
// leave it alone — we don't want to touch legitimate escape sequences
// inside regex or string literals.
function decodeIfDoubleEscaped(s) {
  if (typeof s !== "string" || !s.length) return s;
  if (s.includes("\n")) return s;
  if (!s.includes("\\n")) return s;
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\");
}

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
    repo_dir: null,
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

    const rootListRes = await invoke("agentry.os", {
      action: "fs.list",
      session,
      path: ".",
    }, { tenant: "local", by: "agentry.synthesize" });

    let rootEntries = [];
    if (rootListRes.ok) {
      const e = rootListRes.output?.result?.entries || rootListRes.output?.entries || [];
      rootEntries = Array.isArray(e) ? e.map(x => typeof x === "string" ? x : x.name) : [];
    }

    const repoCandidates = [
      "repo",
      candidate.name,
      candidate.id.split("/").pop(),
      ...rootEntries.filter(n => !n.startsWith(".") && n !== "package.json"),
    ].filter(Boolean);

    let repoDir = null;
    for (const dir of repoCandidates) {
      const check = await invoke("agentry.os", {
        action: "fs.list",
        session,
        path: dir,
      }, { tenant: "local", by: "agentry.synthesize" });
      if (check.ok) {
        const inner = check.output?.result?.entries || check.output?.entries || [];
        if (Array.isArray(inner) && inner.length > 0) {
          repoDir = dir;
          facts.top_level = inner.slice(0, 40).map(x => typeof x === "string" ? x : x.name);
          break;
        }
      }
    }

    if (!repoDir) {
      facts.error = "could not find cloned repo dir. session root: " + JSON.stringify(rootEntries);
      return facts;
    }
    facts.repo_dir = repoDir;

    const readmeCandidates = ["README.md", "README.rst", "README.txt", "Readme.md", "readme.md"];
    for (const name of readmeCandidates) {
      const r = await invoke("agentry.os", {
        action: "fs.read",
        session,
        path: repoDir + "/" + name,
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
        path: repoDir + "/" + name,
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
// The prompt
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
    ? "Repo directory: " + (facts.repo_dir || "(unknown)") + "\n"
      + "Top-level files:\n" + (facts.top_level.join("\n") || "(none listed)") + "\n\n"
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
  lines.push("      \"post_install\": \"<shell cmd or null>\",");
  lines.push("      \"capability\": [\"<other.cap.id>\"]");
  lines.push("    }");
  lines.push("  },");
  lines.push("  \"accept_spec\": {");
  lines.push("    \"input\": { \"<key>\": \"<value for the acceptance probe>\" },");
  lines.push("    \"min_bytes\": 500");
  lines.push("  },");
  lines.push("  \"kernel_language\": \"node\" | \"python\",");
  lines.push("  \"kernel_script\": \"<the code that runs in the kernel session. Reads env vars set by the handler. Writes its result to stdout.>\",");
  lines.push("  \"glue\": {");
  lines.push("    \"pre_invoke\": {");
  lines.push("      \"<ENV_VAR>\": {");
  lines.push("        \"capability\": \"<other.cap.id>\",");
  lines.push("        \"input_map\": { \"<inner_input_key>\": \"<outer_input_key>\" },");
  lines.push("        \"extract\": \"<dot.path into inner output>\"");
  lines.push("      }");
  lines.push("    },");
  lines.push("    \"env_map\": { \"<ENV_VAR>\": \"<input_key>\" },");
  lines.push("    \"result_parse\": \"stdout_text\" | \"stdout_json\",");
  lines.push("    \"output_map\": { \"<output_key>\": \"<dot.path into parsed result>\" }");
  lines.push("  }");
  lines.push("}");
  lines.push("");
  lines.push("Rules:");
  lines.push("- Output ONLY JSON. No prose. No fences.");
  lines.push("- kernel_script runs in a kernel session. It reads env vars (from env_map");
  lines.push("  and pre_invoke) and writes its result to stdout. For binary outputs,");
  lines.push("  write base64.");
  lines.push("- If you cannot produce a working handler, output: { \"error\": \"<reason>\" }");
  lines.push("- Prefer ONE npm package over five. Prefer an API call over spawning a browser.");
  lines.push("- requires.npm must be exact package names (playwright, requests, etc).");
  lines.push("- post_install is a shell one-liner or null (e.g. \"npx playwright install chromium\").");
  lines.push("");
  lines.push("COMPOSITION — read carefully:");
  lines.push("- requires.capability lists OTHER agentry capabilities this handler needs.");
  lines.push("  Each id must already exist in the graph or the trial will fail. Omit the");
  lines.push("  field entirely (or use []) if there are none.");
  lines.push("- glue.pre_invoke lets this handler actually USE those capabilities. Each");
  lines.push("  entry invokes one capability before the kernel script runs and stores an");
  lines.push("  extracted field of its output in an env var. input_map maps each inner");
  lines.push("  input key to an outer input key. extract is a dot path into the inner's");
  lines.push("  output object.");
  lines.push("- Any capability used in glue.pre_invoke MUST also be listed in");
  lines.push("  requires.capability. If you list one and not the other, the composition");
  lines.push("  will not be prepared and the trial will fail.");
  lines.push("- Prefer composing existing capabilities over reinventing their work. If a");
  lines.push("  capability already exists that does part of the job, use pre_invoke to");
  lines.push("  call it and build on its output rather than duplicating its logic in");
  lines.push("  kernel_script.");
  lines.push("- accept_spec.input must include values for every outer input key that a");
  lines.push("  pre_invoke.input_map reads. Otherwise the acceptance probe cannot run.");
  lines.push("");
  lines.push("IMPORTANT — kernel_script escaping:");
  lines.push("- Inside the kernel_script string, each real newline must be a single");
  lines.push("  backslash-n in the JSON, which the JSON parser turns into a newline.");
  lines.push("- Do NOT add extra backslashes. Write \"playwright\", not \\\"playwright\\\".");
  lines.push("  If you emit extra backslashes, the runtime receives a one-line script");
  lines.push("  full of \\n sequences and node fails to parse it.");

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
  out.push("const PRE_INVOKE = " + JSON.stringify(glue.pre_invoke || {}, null, 2) + ";");
  out.push("const OUTPUT_MAP = " + JSON.stringify(glue.output_map || {}, null, 2) + ";");
  out.push("const RESULT_PARSE = " + JSON.stringify(glue.result_parse || "stdout_text") + ";");
  out.push("const KERNEL_ACTION = " + JSON.stringify(action) + ";");
  const cleanScript = decodeIfDoubleEscaped(kernel_script || "");
  out.push("const KERNEL_SCRIPT = " + JSON.stringify(cleanScript) + ";");
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
  out.push("  const { prepareSession } = await import(" + JSON.stringify(INSTALLER_PATH) + ");");
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
  // v0.15.19: ensure this session has the deps this capability declares.
  // v0.15.25: prepareSession recurses through requires.capability, so a
  // composed handler also gets its inner capabilities' deps installed.
  out.push("  {");
  out.push("    const { prepareSession } = await import(" + JSON.stringify(INSTALLER_PATH) + ");");
  out.push("    await prepareSession(ctx, { capId: CAP_ID, session });");
  out.push("  }");
  out.push("");
  out.push("  await ctx.invoke(\"agentry.os\", { action: \"session.create\", id: session },");
  out.push("    { tenant: \"local\", by: CAP_ID });");
  out.push("");
  // v0.15.25: pre_invoke. Call composed capabilities and store extracted
  // fields in `pre` — they get merged into the kernel env below.
  out.push("  const pre = {};");
  out.push("  for (const [envKey, spec] of Object.entries(PRE_INVOKE)) {");
  out.push("    const innerInput = {};");
  out.push("    for (const [innerKey, outerKey] of Object.entries(spec.input_map || {})) {");
  out.push("      innerInput[innerKey] = input[outerKey];");
  out.push("    }");
  out.push("    const innerRes = await ctx.invoke(spec.capability, innerInput);");
  out.push("    if (!innerRes.ok) {");
  out.push("      throw new Error(CAP_ID + \": pre_invoke \" + spec.capability + \" failed: \" + innerRes.error.code + \": \" + innerRes.error.message);");
  out.push("    }");
  out.push("    let v = innerRes.output;");
  out.push("    for (const p of String(spec.extract || \"\").split(\".\")) v = v?.[p];");
  out.push("    pre[envKey] = v === undefined || v === null ? \"\" : String(v);");
  out.push("  }");
  out.push("");
  out.push("  const env = {};");
  out.push("  for (const [envKey, inputKey] of Object.entries(ENV_MAP)) {");
  out.push("    const v = input[inputKey];");
  out.push("    env[envKey] = v === undefined || v === null ? \"\" : String(v);");
  out.push("  }");
  out.push("  for (const [k, v] of Object.entries(pre)) env[k] = v;");
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

  let facts = { cloned: false, session: null, error: null, top_level: [], readme: null, manifest: null, repo_dir: null };
  if (candidate.kind === "repo" && candidate.url) {
    try {
      facts = await readRepoTerritory(candidate, ctx);
      events.emit("synthesize.repo_read", {
        proposal_id, candidate_id,
        cloned: facts.cloned, error: facts.error,
        repo_dir: facts.repo_dir,
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

  const messages = [
    { role: "system", content: "You output only JSON. No prose. No fences." },
    { role: "user", content: prompt },
  ];

  let llmRes = null;
  let llmUsed = null;
  const attempts = [];

  for (const { provider, model } of MODEL_CHAIN) {
    let r;
    try {
      r = await ctx.invoke("llm.openai_compat", {
        provider,
        model,
        messages,
        temperature: 0.1,
        max_tokens: 8000,
      }, { tenant: "local", by: "agentry.synthesize" });
    } catch (e) {
      attempts.push({ provider, model, ok: false, error: e.message });
      continue;
    }

    attempts.push({
      provider, model,
      ok: r.ok,
      code: r.ok ? null : r.error?.code,
      message: r.ok ? null : String(r.error?.message || "").slice(0, 150),
    });

    if (!r.ok) continue;

    const s = extractJson(r.output.content);
    if (s) {
      llmRes = r;
      llmUsed = { provider, model };
      break;
    }
    attempts[attempts.length - 1].ok = false;
    attempts[attempts.length - 1].reason = "unparseable";
    attempts[attempts.length - 1].preview = String(r.output.content || "").slice(0, 200);
  }

  if (!llmRes) {
    events.emit("synthesize.all_models_failed", {
      proposal_id, candidate_id, attempts,
    });
    throw new Error("agentry.synthesize: all " + MODEL_CHAIN.length + " models failed. attempts=" + JSON.stringify(attempts));
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

  // v0.15.25 — composition coherence check.
  // Any capability named in glue.pre_invoke must also be in
  // requires.capability. The prompt tells the LLM this, but enforce it
  // here so a forgetful model doesn't produce a spec that fails only
  // at trial time.
  const composedDeclared = new Set(
    Array.isArray(spec.capability.requires?.capability)
      ? spec.capability.requires.capability
      : []
  );
  const preInvokeCaps = Object.values(spec.glue.pre_invoke || {})
    .map(e => e?.capability)
    .filter(Boolean);
  const missingDecl = preInvokeCaps.filter(c => !composedDeclared.has(c));
  if (missingDecl.length) {
    events.emit("synthesize.composition_mismatch", {
      proposal_id, candidate_id,
      capability_id: spec.capability.id,
      missing_declarations: missingDecl,
    });
    throw new Error(
      "agentry.synthesize: pre_invoke references capabilities not declared in requires.capability: "
      + missingDecl.join(", ")
    );
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
    composed_capabilities: [...composedDeclared],
    pre_invoke_count: preInvokeCaps.length,
    model_used: llmUsed ? (llmUsed.provider + "/" + llmUsed.model) : null,
    ms: Date.now() - started,
  });

  return {
    output: {
      capability_id: spec.capability.id,
      kind: spec.capability.kind,
      handler_path: handlerPath,
      seed_path: seedPath,
      repo_session: facts.session,
      repo_dir: facts.repo_dir,
      repo_read: facts.cloned,
      spec,
      composed_capabilities: [...composedDeclared],
      model_used: llmUsed ? (llmUsed.provider + "/" + llmUsed.model) : (llmRes.output.model || null),
    },
    cost: { time_ms: Date.now() - started },
  };
}
