// agentry/src/handlers/agentry.synthesize.mjs
//
// The teaching handler. Given an approved candidate, produce a working
// handler for the gap it fills.
//
// v0.15.29 — fill-in-the-blanks synthesis.
//   The old prompt handed the model a full reference handler and said
//   "study this shape." The model copied it, and every new capability
//   came out as the reference stretched to fit. The reference file
//   itself drifted toward whatever the last synthesis produced.
//   Replaced with: for the gap's wanted_kind, look up a shape from
//   _shapes.mjs and ask the model to fill each slot for the specific
//   capability. No reference code means no anchor to copy.
//
//   The spec now carries a plan field: one entry per shape step, each
//   with verb / what / fails_if / code. The renderer compiles the plan
//   into a single kernel script with each step as a labeled segment.
//   Steps execute in the same process so state (browser handle, db
//   connection) persists. The plan is also stored in the seed JSON for
//   audit.

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getShape } from "./_shapes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HANDLERS_DIR = process.env.AGENTRY_HANDLERS_DIR
  || "/tmp/home/.dsh/agentry-synthesized/handlers";
const SEEDS_DIR = process.env.AGENTRY_SEEDS_DIR
  || "/tmp/home/.dsh/agentry-synthesized/seeds";
const MAX_README_CHARS = 12000;
const MAX_MANIFEST_CHARS = 4000;

const INSTALLER_PATH = join(HERE, "..", "runtime", "installer.mjs").replace(/\\/g, "/");

const MODEL_CHAIN = [
  { provider: "groq", model: "openai/gpt-oss-120b" },
  { provider: "groq", model: "openai/gpt-oss-20b" },
  { provider: "groq", model: "qwen/qwen3.8-27b" },
  { provider: "google", model: "gemini-2.5-flash" },
];

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
      const readmeContent = r.output?.result?.content ?? r.output?.content;
      if (r.ok && readmeContent) {
        facts.readme = String(readmeContent).slice(0, MAX_README_CHARS);
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
      const manifestContent = r.output?.result?.content ?? r.output?.content;
      if (r.ok && manifestContent) {
        facts.manifest = String(manifestContent).slice(0, MAX_MANIFEST_CHARS);
        facts.manifest_path = name;
        break;
      }
    }
  } catch (e) {
    facts.error = "repo read threw: " + e.message;
  }

  return facts;
}

// v0.17.4 — read an npm package as the candidate source. Installs
// it into a synth session, reads README + package.json from
// node_modules, and returns a facts object shaped like the one
// readRepoTerritory produces. The prompt builder branches on
// facts.source_kind to render npm-specific guidance.
async function readNpmPackage(candidate, deps) {
  const session = "synth_npm_" + candidate.id.replace(/[^a-z0-9_.-]/gi, "_") + "_" + Date.now().toString(36);
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
    source_kind: "npm",
    npm_package_name: null,
    npm_main_entry: null,
  };

  let pkgName = String(candidate.id || "");
  if (pkgName.startsWith("npm:")) pkgName = pkgName.slice(4);
  if (!pkgName) {
    facts.error = "candidate.id missing npm package name";
    return facts;
  }
  facts.npm_package_name = pkgName;

  try {
    const installRes = await invoke("agentry.os", {
      action: "node.install",
      session,
      packages: [pkgName],
    }, { tenant: "local", by: "agentry.synthesize" });

    if (!installRes.ok) {
      facts.error = "npm install failed: " + installRes.error.message;
      return facts;
    }
    facts.cloned = true;

    const pkgDir = "node_modules/" + pkgName;

    const listRes = await invoke("agentry.os", {
      action: "fs.list",
      session,
      path: pkgDir,
    }, { tenant: "local", by: "agentry.synthesize" });

    let entries = [];
    if (listRes.ok) {
      const e = listRes.output?.result?.entries || listRes.output?.entries || [];
      entries = Array.isArray(e) ? e.map(x => typeof x === "string" ? x : x.name) : [];
    }
    facts.top_level = entries.slice(0, 40);
    facts.repo_dir = pkgDir;

    const readmeCandidates = ["README.md", "README.rst", "README.txt", "readme.md"];
    for (const name of readmeCandidates) {
      const r = await invoke("agentry.os", {
        action: "fs.read",
        session,
        path: pkgDir + "/" + name,
      }, { tenant: "local", by: "agentry.synthesize" });
      const content = r.output?.result?.content ?? r.output?.content;
      if (r.ok && content) {
        facts.readme = String(content).slice(0, MAX_README_CHARS);
        break;
      }
    }

    const manifestRes = await invoke("agentry.os", {
      action: "fs.read",
      session,
      path: pkgDir + "/package.json",
    }, { tenant: "local", by: "agentry.synthesize" });
    const manifestContent = manifestRes.output?.result?.content ?? manifestRes.output?.content;
    if (manifestRes.ok && manifestContent) {
      facts.manifest = String(manifestContent).slice(0, MAX_MANIFEST_CHARS);
      facts.manifest_path = "package.json";
      try {
        const pkgJson = JSON.parse(facts.manifest);
        facts.npm_main_entry = pkgJson.main || pkgJson.module || pkgJson.exports ? (pkgJson.main || pkgJson.module || "exports") : null;
      } catch (e) {}
    }
  } catch (e) {
    facts.error = "npm read threw: " + e.message;
  }

  return facts;
}

// ─────────────────────────────────────────────────────────────
// The prompt — fill in the blanks, do not copy a reference
// ─────────────────────────────────────────────────────────────

function buildPrompt({ gap, candidate, facts, shape }) {
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

  let repoFacts;
  if (facts.source_kind === "npm") {
    repoFacts = "NPM PACKAGE: " + (facts.npm_package_name || "(unknown name)") + "\n"
      + "Install path (relative to session): " + (facts.repo_dir || "(unknown)") + "\n"
      + (facts.npm_main_entry ? "Main entry per package.json: " + facts.npm_main_entry + "\n" : "")
      + "Files in package:\n" + (facts.top_level.join("\n") || "(none listed)") + "\n\n"
      + (facts.readme ? "README:\n<<<\n" + facts.readme + "\n>>>\n\n" : "")
      + (facts.manifest ? "package.json:\n<<<\n" + facts.manifest + "\n>>>\n" : "");
  } else if (facts.cloned) {
    repoFacts = "Repo directory: " + (facts.repo_dir || "(unknown)") + "\n"
      + "Top-level files:\n" + (facts.top_level.join("\n") || "(none listed)") + "\n\n"
      + (facts.readme ? "README:\n<<<\n" + facts.readme + "\n>>>\n\n" : "")
      + (facts.manifest ? (facts.manifest_path + ":\n<<<\n" + facts.manifest + "\n>>>\n") : "");
  } else {
    repoFacts = "(no repo facts available — candidate kind is " + candidate.kind + ")";
  }

  const lines = [];
  lines.push("You are agentry's code synthesizer.");
  lines.push("");
  lines.push("A gap has been approved for adoption. You will be given a SHAPE —");
  lines.push("a fixed list of steps that every capability of this kind follows.");
  lines.push("Your job is to fill in each step for THIS specific gap. You are");
  lines.push("NOT copying a reference. You are reasoning about what this");
  lines.push("capability needs to do, step by step, in the shape's order.");
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
  lines.push("=== THE SHAPE — fill every slot, do not add or skip steps ===");
  lines.push("Kind: " + (gap.wanted_kind || "unknown"));
  lines.push("Description: " + shape.description);
  lines.push("");
  for (let i = 0; i < shape.steps.length; i++) {
    const s = shape.steps[i];
    lines.push("Step " + (i + 1) + " — " + s.verb);
    lines.push("  why:      " + s.why);
    lines.push("  fails if: " + s.fails_if);
    lines.push("  produces: " + s.produces);
    lines.push("");
  }
  lines.push("=== PRODUCE THIS JSON ===");
  lines.push("{");
  lines.push("  \"capability\": {");
  lines.push("    \"id\": \"<exact dotted id from THE GAP above>\",");
  lines.push("    \"kind\": \"<" + (gap.wanted_kind || "unknown") + ">\",");
  lines.push("    \"accepts\": { \"<key>\": \"string\" | { \"type\": \"string|number|boolean\", \"optional\": true } },");
  lines.push("    \"produces\": { \"<output_key>\": \"string|number|boolean\" },");
  lines.push("    \"requires\": {");
  lines.push("      \"npm\": [\"<pkg>\"],");
  lines.push("      \"pip\": [\"<pkg>\"],");
  lines.push("      \"post_install\": \"<shell cmd or null>\",");
  lines.push("      \"capability\": [\"<other.cap.id>\"]");
  lines.push("    }");
  lines.push("  },");
  lines.push("  \"plan\": [");
  lines.push("    {");
  lines.push("      \"step\": 1,");
  lines.push("      \"verb\": \"<verb from the shape, exact>\",");
  lines.push("      \"what\": \"<one sentence: what THIS capability does at this step>\",");
  lines.push("      \"fails_if\": \"<the specific failure mode for THIS capability at this step>\",");
  lines.push("      \"code\": \"<the code that runs at this step, in the SAME kernel process. Use variables set by earlier steps. One statement per line.>\"");
  lines.push("    }");
  lines.push("    // ... one entry per shape step, in order");
  lines.push("  ],");
  lines.push("  \"accept_spec\": {");
  lines.push("    \"input\": { \"<key>\": \"<value for the acceptance probe>\" },");
  lines.push("    \"min_bytes\": 500");
  lines.push("  },");
  lines.push("  \"kernel_language\": \"node\" | \"python\",");
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
  lines.push("- The plan array MUST have exactly " + shape.steps.length + " entries, in the shape's order.");
  lines.push("- Each plan entry's verb MUST match the shape's verb for that step.");
  lines.push("- Code from step N runs in the same process as code from step N-1.");
  lines.push("- CRITICAL: Pass state between steps via globalThis. Assign to globalThis.X in");
  lines.push("  an earlier step and read globalThis.X in a later step. Do NOT pass state via");
  lines.push("  bare variables. The compiled script puts every step inside ONE async IIFE");
  lines.push("  but a variable typo across 4000 tokens of spec is a silent runtime failure;");
  lines.push("  globalThis.X fails loudly the moment it is referenced undefined.");
  lines.push("  Correct: prepare step writes `globalThis.inputPath = path;`.");
  lines.push("           execute step reads `const p = globalThis.inputPath;`.");
  lines.push("- Step \"emit\" MUST write a single JSON object to stdout with exactly the fields you promised in produces. Use console.log(JSON.stringify({...})).");
  lines.push("- requires.npm must be exact package names (playwright, requests, etc).");
  lines.push("- post_install is a shell one-liner or null (e.g. \"npx playwright install chromium\").");
  lines.push("- The kernel script is an ES module. require() is NOT defined. Use");
  lines.push("  import, or `const x = (await import(\"pkg\")).default` for CJS modules.");
  lines.push("- The kernel session starts EMPTY. Any file your code reads must have been");
  lines.push("  written by an EARLIER step in your plan. If your execute step reads a file,");
  lines.push("  your prepare step MUST write that file first with fs.writeFileSync. Do NOT");
  lines.push("  assume files exist. Do NOT reference paths you did not create.");
  lines.push("");
  if (facts.source_kind === "npm" && facts.npm_package_name) {
    lines.push("NPM CANDIDATE — this is an npm package, not a GitHub repo.");
    lines.push("- The package is already installed in the synth session at");
    lines.push("  node_modules/" + facts.npm_package_name + ".");
    lines.push("- Your synthesized handler MUST declare requires.npm: [\"" + facts.npm_package_name + "\"].");
    lines.push("- In your plan's code, IMPORT the package. Do NOT reimplement what it does.");
    lines.push("- Common import patterns for this package:");
    lines.push("    import pkg from '" + facts.npm_package_name + "';           // ESM default");
    lines.push("    import { fn } from '" + facts.npm_package_name + "';        // ESM named");
    lines.push("    const pkg = (await import('" + facts.npm_package_name + "')).default;  // ESM dynamic default");
    lines.push("    const mod = await import('" + facts.npm_package_name + "');  // ESM dynamic namespace");
    lines.push("- Read the README carefully. It shows the exact usage pattern.");
    lines.push("- CRITICAL: The kernel script runs as an ES module (.mjs).");
    lines.push("  require() DOES NOT EXIST. Every reference in the README that uses");
    lines.push("  require() must be rewritten as import, or as await import() inside");
    lines.push("  an async function (the plan already runs inside an async IIFE).");
    lines.push("  CJS packages with module.exports are reachable as:");
    lines.push("    const pkg = (await import('" + facts.npm_package_name + "')).default;");
    lines.push("  If the CJS module exports a function, .default is that function.");
    lines.push("");
  }
  lines.push("COMPOSITION:");
  lines.push("- requires.capability lists OTHER agentry capabilities this handler needs.");
  lines.push("- glue.pre_invoke lets this handler USE those capabilities. Each entry invokes");
  lines.push("  one capability before the kernel script runs and stores an extracted field");
  lines.push("  of its output in an env var. Any capability used in pre_invoke MUST also be");
  lines.push("  listed in requires.capability.");
  lines.push("- Prefer composing existing capabilities over reinventing their work.");
  lines.push("");
  lines.push("ESCAPING:");
  lines.push("- Inside code strings, each real newline must be a single backslash-n in");
  lines.push("  the JSON. The JSON parser turns it into a real newline.");
  lines.push("- Do NOT add extra backslashes. Write \"playwright\", not \\\"playwright\\\".");

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────
// Rendering — plan → single kernel script + seed JSON
// ─────────────────────────────────────────────────────────────

function indentBlock(s, prefix) {
  return String(s || "").split("\n").map(line => prefix + line).join("\n");
}

function compilePlanToScript(plan) {
  const parts = [];
  parts.push("(async () => {");
  for (const step of plan) {
    parts.push("");
    parts.push("  // -- step " + step.step + ": " + step.verb + " --");
    if (step.what) parts.push("  // what: " + String(step.what).replace(/\n/g, "\n  // "));
    if (step.fails_if) parts.push("  // fails_if: " + String(step.fails_if).replace(/\n/g, "\n  // "));
    parts.push("  // BEGIN " + step.verb);
    // Decode each step's code individually BEFORE joining. The outer
    // decode below is a no-op because the joined string always contains
    // real newlines; per-step is the only place literal \n sequences
    // can be detected and fixed.
    const rawCode = String(step.code || "").trim();
    const code = decodeIfDoubleEscaped(rawCode);
    if (code) parts.push(indentBlock(code, "  "));
    parts.push("  // END " + step.verb);
  }
  parts.push("");
  parts.push("})().catch(e => { console.error(String((e && e.stack) || e)); process.exit(1); });");
  return parts.join("\n");
}

function renderHandler(spec) {
  const { capability, glue } = spec;
  const lang = spec.kernel_language === "python" ? "python" : "node";
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
  const compiled = compilePlanToScript(spec.plan || []);
  const cleanScript = decodeIfDoubleEscaped(compiled);
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
  out.push("  {");
  out.push("    const { prepareSession } = await import(" + JSON.stringify(INSTALLER_PATH) + ");");
  out.push("    await prepareSession(ctx, { capId: CAP_ID, session });");
  out.push("  }");
  out.push("");
  out.push("  await ctx.invoke(\"agentry.os\", { action: \"session.create\", id: session },");
  out.push("    { tenant: \"local\", by: CAP_ID });");
  out.push("");
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
    plan: spec.plan || null,
    source: "synthesized:agentry.synthesize",
    notes: "Auto-generated. Regenerate rather than edit. Plan is auditable.",
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
// Plan validation — the shape's step list is the contract
// ─────────────────────────────────────────────────────────────

function validatePlan(plan, shape, capability_id) {
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

// v0.17.7 — spec consistency. The LLM writes one JSON document but
// rarely holds the same name across all its sections. Example from
// real output: plan code reads process.env.MARKDOWN_PATH, but
// env_map declares MARKDOWN and accept_spec supplies "markdown".
// Three names, one concept, three different keys. Nothing in the
// plan validator catches that. Nothing in the trial catches it either
// — the trial just fails at runtime with "Missing markdown_path"
// and we pay a full trial cycle for a bug we could detect statically.
//
// This function cross-references the four sections that must agree:
//   plan[].code           — the actual code that runs
//   glue.env_map          — declares which input key maps to which env var
//   accept_spec.input     — supplies the values used by the trial probe
//   capability.produces   — declares what the emit step must output
function validateSpecConsistency(spec, capability_id) {
  const plan = Array.isArray(spec.plan) ? spec.plan : [];
  const glue = spec.glue || {};
  const envMap = glue.env_map || {};
  const acceptInput = spec.accept_spec && spec.accept_spec.input ? spec.accept_spec.input : {};
  const produces = spec.capability && spec.capability.produces ? spec.capability.produces : {};

  // Check 1 — every process.env.X referenced in plan code must be a
  // key in env_map. Catches MARKDOWN_PATH vs MARKDOWN.
  const envKeysUsed = new Set();
  for (const step of plan) {
    const code = String(step.code || "");
    for (const m of code.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      envKeysUsed.add(m[1]);
    }
    for (const m of code.matchAll(/process\.env\[["']([A-Za-z_][A-Za-z0-9_]*)["']\]/g)) {
      envKeysUsed.add(m[1]);
    }
  }
  const envMapKeys = new Set(Object.keys(envMap));
  for (const key of envKeysUsed) {
    if (!envMapKeys.has(key)) {
      return {
        ok: false,
        check: "env_var_not_in_env_map",
        detail: "plan reads process.env." + key + " but env_map has no such key. env_map keys: " + ([...envMapKeys].join(", ") || "(none)"),
      };
    }
  }

  // Check 2 — every env_map value (the input key on the outer side)
  // must exist as a key in accept_spec.input. Catches "env_map needs
  // input markdown but the trial probe supplies nothing."
  const acceptKeys = new Set(Object.keys(acceptInput));
  for (const [envKey, inputKey] of Object.entries(envMap)) {
    if (typeof inputKey !== "string") continue;
    if (!acceptKeys.has(inputKey)) {
      return {
        ok: false,
        check: "env_map_input_not_in_accept_spec",
        detail: "env_map[\"" + envKey + "\"] maps from input \"" + inputKey + "\" but accept_spec.input has no such key. accept_spec.input keys: " + ([...acceptKeys].join(", ") || "(none)"),
      };
    }
  }

  // Check 3 — every key declared in capability.produces must appear as
  // a literal substring in the emit step's code. Catches "produces
  // declares pdf_path but emit writes { pdf: ... }".
  const emitStep = plan.find(s => s && s.verb === "emit");
  const emitCode = emitStep ? String(emitStep.code || "") : "";
  for (const key of Object.keys(produces)) {
    if (key === "captured_at" || key === "bytes") continue; // runtime-injected
    if (!emitCode.includes(key)) {
      return {
        ok: false,
        check: "produces_key_not_emitted",
        detail: "produces declares \"" + key + "\" but the emit step never references it.",
      };
    }
  }

  return { ok: true };
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

  const shape = getShape(gap.wanted_kind || "unknown");

  events.emit("synthesize.started", {
    proposal_id, candidate_id, gap_id: gap.id,
    candidate_kind: candidate.kind,
    wanted_kind: gap.wanted_kind || null,
    shape_verbs: shape.steps.map(s => s.verb),
  });

  let facts = { cloned: false, session: null, error: null, top_level: [], readme: null, manifest: null, repo_dir: null, source_kind: null };
  if (candidate.kind === "npm_package") {
    try {
      facts = await readNpmPackage(candidate, ctx);
      events.emit("synthesize.npm_read", {
        proposal_id, candidate_id,
        installed: facts.cloned, error: facts.error,
        npm_package_name: facts.npm_package_name,
        readme_len: facts.readme ? facts.readme.length : 0,
        manifest: facts.manifest_path,
        top_level_count: facts.top_level.length,
      });
    } catch (e) {
      events.emit("synthesize.npm_read_failed", { proposal_id, candidate_id, error: e.message });
    }
  } else if (candidate.kind === "repo" && candidate.url) {
    try {
      facts = await readRepoTerritory(candidate, ctx);
      facts.source_kind = "github";
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

  const prompt = buildPrompt({ gap, candidate, facts, shape });

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
  if (!spec.capability?.id || !spec.glue) {
    throw new Error("agentry.synthesize: spec missing capability.id or glue");
  }

  if (typeof spec.capability.id === "string" && spec.capability.id.startsWith("gap:")) {
    const stripped = spec.capability.id.slice(4);
    if (stripped) {
      events.emit("synthesize.id_stripped", {
        proposal_id, candidate_id,
        original: spec.capability.id,
        normalized: stripped,
      });
      spec.capability.id = stripped;
    }
  }

  try {
    validatePlan(spec.plan, shape, spec.capability.id);
  } catch (e) {
    events.emit("synthesize.plan_invalid", {
      proposal_id, candidate_id,
      capability_id: spec.capability.id,
      wanted_kind: gap.wanted_kind || null,
      error: e.message,
    });
    throw e;
  }

  // v0.17.7 — cross-section consistency. Rejects the spec before a
  // trial cycle if the plan, env_map, accept_spec, and produces
  // sections disagree with each other.
  const consistency = validateSpecConsistency(spec, spec.capability.id);
  if (!consistency.ok) {
    events.emit("synthesize.spec_inconsistent", {
      proposal_id, candidate_id,
      capability_id: spec.capability.id,
      check: consistency.check,
      detail: consistency.detail,
      model_used: llmUsed ? (llmUsed.provider + "/" + llmUsed.model) : null,
    });
    throw new Error("agentry.synthesize: spec failed consistency check [" + consistency.check + "]: " + consistency.detail);
  }

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
    wanted_kind: gap.wanted_kind || null,
    shape_steps: shape.steps.length,
    plan_steps: spec.plan.length,
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
      plan_steps: spec.plan.length,
      composed_capabilities: [...composedDeclared],
      model_used: llmUsed ? (llmUsed.provider + "/" + llmUsed.model) : (llmRes.output.model || null),
    },
    cost: { time_ms: Date.now() - started },
  };
}
