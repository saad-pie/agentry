// agentry/src/handlers/synthesize/prompt/index.mjs
// v0.53.1 — extracted from agentry.synthesize.mjs.
// Builds the LLM prompt for capability synthesis. Self-contained (no imports);
// reads from arguments only.

export function buildPrompt({ gap, candidate, facts, shape }) {
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
  if (facts.source_kind === "skill") {
    repoFacts = "AGENT SKILL: " + (facts.skill_name || "(unknown)") + "\n"
      + "Source URL: " + (facts.skill_source_url || "(unknown)") + "\n"
      + "Frontmatter:\n" + JSON.stringify(facts.skill_frontmatter || {}, null, 2) + "\n\n"
      + "Body (this becomes your system prompt for the wrapped capability):\n"
      + "<<<\n" + (facts.skill_body || "(empty)").slice(0, 6000) + "\n>>>\n";
  } else if (facts.source_kind === "npm") {
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
  lines.push("    \"id\": \"<use wanted_id from THE GAP above, NOT gap_id. If THE GAP shows wanted_id: test.csv_to_xlsx and id: gap:test.csv_to_xlsx, use test.csv_to_xlsx. NO 'gap:' prefix.>\",");
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
  lines.push("      \"code\": \"<the code that runs at this step. See MODULE LOADING and STATE BETWEEN STEPS below.>\"");
  lines.push("    }");
  lines.push("    // ... one entry per shape step, in order");
  lines.push("  ],");
  lines.push("  \"accept_spec\": {");
  lines.push("    \"input\": { \"<key>\": \"<value for the acceptance probe>\" },");
  lines.push("    \"_fixtures\": { \"/abs/path/file.ext\": \"<content>\" },  // OPTIONAL: files written before probe runs");
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
  lines.push("- The plan array MUST have exactly " + shape.steps.length + " entries, in the shape's order.");
  lines.push("- Each plan entry's verb MUST match the shape's verb for that step.");
  lines.push("- Step \"emit\" MUST write a single JSON object to stdout with exactly the fields you promised in produces. Use console.log(JSON.stringify({...})).");
  lines.push("- requires.npm must be exact package names (playwright, requests, etc).");
  lines.push("- post_install is a shell one-liner or null (e.g. \"npx playwright install chromium\").");
  lines.push("- accept_spec.min_bytes is the MINIMUM byte size the acceptance probe's");
  lines.push("  output must reach for the trial to pass. Set it to 0 when the capability");
  lines.push("  produces text (HTML, JSON, plain strings, snippets). Set it to 500 or");
  lines.push("  higher only when the capability produces a binary blob (PNG, PDF, base64).");
  lines.push("  Setting it too high will fail the trial even when the plan works correctly.");
    lines.push("- FIXTURES: if any plan step reads a file path, the accept_spec MUST declare");
  lines.push("  a _fixtures entry that creates that file. Example:");
  lines.push("    \"accept_spec\": { \"input\": { \"markdown_path\": \"/tmp/in.md\" },");
  lines.push("                     \"_fixtures\": { \"/tmp/in.md\": \"# Test\\n\\nContent\" } }");
  lines.push("  The acceptance runner writes every _fixtures file before invoking the plan.");
lines.push("- The kernel session starts EMPTY. Any file your code reads must have been");
  lines.push("  written by an EARLIER step in your plan. If your execute step reads a file,");
  lines.push("  your prepare step MUST write that file first with fs.writeFileSync. Do NOT");
  lines.push("  assume files exist. Do NOT reference paths you did not create.");
  lines.push("");
  lines.push("RUNTIME RULES — the #1 source of trial failures. Read carefully.");
  lines.push("");
  lines.push("1. Module loading — inside the plan body (an async IIFE), static import");
  lines.push("   and require() both fail. Load every module with dynamic await import:");
  lines.push("     const fs = await import('node:fs');");
  lines.push("     const { writeFileSync } = await import('node:fs');");
  lines.push("     const { marked } = await import('marked');");
  lines.push("     const markdownpdf = (await import('markdown-pdf')).default;");
  lines.push("   CJS packages use .default. If unsure ESM vs CJS, use mod.default || mod.");
  lines.push("");
  lines.push("2. Inputs — read from process.env.UPPERCASE_NAME. Every accepts key");
  lines.push("   becomes an env var: input_path -> process.env.INPUT_PATH,");
  lines.push("   output_path -> process.env.OUTPUT_PATH. Prefer process.env;");
  lines.push("   globalThis.input is a fallback but not canonical.");
  lines.push("");
  lines.push("3. State between steps — assign to globalThis.X in one step, read");
  lines.push("   globalThis.X in a later step. The plan body is one scope, but a");
  lines.push("   variable typo across 4000 tokens is silent until runtime.");
  lines.push("   globalThis fails loudly when undefined.");
  lines.push("");
  lines.push("4. Plain JavaScript only — kernel_language \"node\" runs plain V8.");
  lines.push("   NEVER write JSX (<Component />) or TypeScript (: Type). Both are");
  lines.push("   SyntaxErrors. If a library's README shows JSX, rewrite as plain");
  lines.push("   function calls or pick a non-JSX library.");
  lines.push("");
  if (facts.source_kind === "npm" && facts.npm_package_name) {
    lines.push("NPM CANDIDATE — this is an npm package, not a GitHub repo.");
    lines.push("- The package is already installed in the synth session at");
    lines.push("  node_modules/" + facts.npm_package_name + ".");
    lines.push("- Your synthesized handler MUST declare requires.npm: [\"" + facts.npm_package_name + "\"].");
    lines.push("");
    lines.push("CRITICAL — DO NOT INVENT API METHODS. The trial WILL fail with");
    lines.push("`X is not a function` or `Cannot determine main export` if you guess.");
    lines.push("Follow these rules IN ORDER:");
    lines.push("");
    lines.push("1. Read the README API section above. Note EXACT function names,");
    lines.push("   method signatures, and export shapes. Copy them verbatim.");
    lines.push("");
    lines.push("2. Look at package.json `main`, `module`, `exports` fields above.");
    lines.push("   If `exports` is present, the package is ESM and you MUST use");
    lines.push("   named imports matching that shape.");
    lines.push("");
    lines.push("3. If the README shows ONLY a class (e.g. `new Foo()`), the");
    lines.push("   export is the class: `const { Foo } = await import(pkg)`.");
    lines.push("   Do NOT call `Foo.bar()` as a static method — the README would");
    lines.push("   show that pattern if it existed.");
    lines.push("");
    lines.push("4. If the README shows ONLY functions (e.g. `foo(bar)`), the");
    lines.push("   export is the function: `const { foo } = await import(pkg)`.");
    lines.push("   Do NOT wrap it in `.default()` or invent a class around it.");
    lines.push("");
    lines.push("5. If the README is empty or unhelpful, use the SAFEST pattern:");
    lines.push("    const mod = await import('" + facts.npm_package_name + "');");
    lines.push("    const pkg = mod.default || mod;");
    lines.push("    // Then inspect pkg's keys BEFORE calling anything:");
    lines.push("    if (typeof pkg !== 'function' && typeof pkg !== 'object')");
    lines.push("      throw new Error('Unexpected export shape: ' + typeof pkg);");
    lines.push("    // Now call methods you KNOW exist from the README.");
    lines.push("");
    lines.push("6. NEVER write `addTable(...)`, `getOrientation(...)`, or any");
    lines.push("   method whose name you did not see in the README above.");
    lines.push("   If unsure of the API, throw a clear error EARLY:");
    lines.push("     throw new Error('pdf-lib-table: API is <guessed>. Cannot verify.');");
    lines.push("   Better to fail fast at trial than to invent phantom methods.");
    lines.push("");
    lines.push("");
  }
  if (facts.source_kind === "npm" && facts.npm_exports) {
    const _exp = facts.npm_exports;
    const _fmt = (arr) => Array.isArray(arr) && arr.length ? arr.join(", ") : "(none)";
    lines.push("═══ VERIFIED EXPORTS — YOU MAY ONLY CALL THESE ═══");
    lines.push("These were extracted by importing the package at build time.");
    lines.push("They are the TRUTH. Anything not in this list does not exist.");
    lines.push("Calling a method not listed here → trial fails with 'X is not a function'.");
    lines.push("");
    if (_exp.top)          lines.push("top-level exports: " + _fmt(_exp.top));
    if (_exp.default)      lines.push("default export keys: " + _fmt(_exp.default));
    if (_exp.utils)        lines.push("utils keys: " + _fmt(_exp.utils));
    if (_exp.default_utils) lines.push("default.utils keys: " + _fmt(_exp.default_utils));
    if (_exp.default_is_function) lines.push("default is a FUNCTION (callable)");
    lines.push("");
    lines.push("Rule: if you need a method that is NOT in the lists above,");
    lines.push("throw a clear error at the top of the plan:");
    lines.push("  throw new Error('" + (facts.npm_package_name || "pkg") + ": required method X not in exports');");
    lines.push("Do NOT invent a method. Do NOT guess. Use ONLY what is listed.");
    lines.push("");
  }

  if (facts.source_kind === "rust_crate" && facts.crate_name) {
    lines.push("RUST CANDIDATE — this is a Rust crate, not a Node/Python package.");
    lines.push("");
    lines.push("- The kernel runs RUST via `rust-script` (crates.io + cargo built in).");
    const _version = facts.version || "*";
    lines.push("- Your synthesized capability MUST declare deps in requires.rust_crates:");
    lines.push("    \"kernel_language\": \"rust\"");
    lines.push("    \"requires\": { \"npm\": [], \"pip\": [], \"rust_crates\": [\"" + facts.crate_name + "@" + _version + "\"], \"post_install\": null, \"capability\": [] }");
    lines.push("- Do NOT declare it in requires.npm — that is for JavaScript only.");
    lines.push("- The compiler WILL PREPEND the cargo block automatically from");
    lines.push("  requires.rust_crates. Do NOT write `//! ```cargo` yourself.");
    lines.push("");
    lines.push("RUST RULES (READ TWICE):");
    lines.push("- The step.code is just `fn main() { ... }` — NO cargo header, NO shebang.");
    lines.push("  The compiler prepends the cargo block from requires.rust_crates.");
    lines.push("  Correct shape:");
    lines.push("    use " + (facts.crate_name || "").replace(/-/g, "_") + ";");
    lines.push("    fn main() {");
    lines.push("        // full logic here");
    lines.push("        println!(\"{}\" , ...);");
    lines.push("    }");
    lines.push("- Use `println!` to emit the final JSON. rust-script captures stdout.");
    lines.push("- Do NOT use `serde_json` unless listed in cargo deps. Simplest is");
    lines.push("  to build the JSON string manually with format!().");
    lines.push("- Do NOT use `?` operator without a Result-returning fn; use match/unwrap.");
    lines.push("- Errors: `panic!` on failure — exit_code will be nonzero, trial fails.");
    lines.push("- Crates often have hyphens in names (`my-crate`) but underscores in");
    lines.push("  code (`my_crate::...`). Convert accordingly.");
    lines.push("");
    lines.push("CRITICAL — RUST IS NOT JAVASCRIPT:");
    lines.push("- DO NOT write `globalThis.X` or `globalThis.X = ...` anywhere.");
    lines.push("  Rust has NO globalThis — it is JavaScript. Generated Rust with");
    lines.push("  globalThis fails compilation: 'cannot find value globalThis'.");
    lines.push("- DO NOT use `console.log`, `process.env`, `const`, `await`, `require`.");
    lines.push("- State flows via LOCAL VARIABLES inside ONE fn main(). The compiler");
    lines.push("  concatenates your 3 steps (prepare/execute/emit) into one fn main().");
    lines.push("  A `let x = ...;` declared in prepare is visible in execute and emit.");
    lines.push("  NO cross-step bus is needed. NO globalThis.");
    lines.push("");
    const _v = facts.version || "*";
    lines.push("CRITICAL — HOW TO USE THIS CRATE:");
    lines.push("- READ THE README ABOVE. It tells you what kind of crate this is.");
    lines.push("- LIBRARY crate (README shows `use foo;` examples or Cargo.toml deps):");
    lines.push("    requires: { \"rust_crates\": [\"" + facts.crate_name + "@" + _v + "\"] }");
    lines.push("    code:     use " + (facts.crate_name || "").replace(/-/g, "_") + "; fn main() { " + (facts.crate_name || "").replace(/-/g, "_") + "::<fn>(...) }");
    lines.push("- CLI BINARY crate (README says `cargo install foo` or shows shell usage):");
    lines.push("    requires: { \"rust_crates\": [], \"post_install\": \"cargo install --locked " + facts.crate_name + "\" }");
    lines.push("    code:     Command::new(\"" + facts.crate_name + "\")  // binary WILL exist at trial");
    lines.push("- Mixed (both lib + bin): prefer CLI. cargo install also installs the lib.");
    lines.push("- If README unclear: CLI. `src/main.rs` = bin, `src/lib.rs` = lib.");
    lines.push("");
    lines.push("POST_INSTALL IS THE UNIVERSAL INSTALLER (any tool, any ecosystem):");
    lines.push("- Any shell command that installs a tool goes in requires.post_install.");
    lines.push("- The pipeline runs it once per session before your code. Binary WILL exist.");
    lines.push("- Examples:");
    lines.push("    apt-get:  \"apt-get update && apt-get install -y ffmpeg\"");
    lines.push("    cargo:    \"cargo install --locked topdf\"");
    lines.push("    go:       \"GOBIN=/usr/local/bin go install github.com/x/y@latest\"");
    lines.push("    npm -g:   \"npm install -g some-cli\"");
    lines.push("    pipx:     \"pipx install yt-dlp\"");
    lines.push("    shell:    \"curl -LsSf https://example.com/install.sh | sh\"");
    lines.push("    build:    \"git clone https://github.com/x/y /tmp/y && cd /tmp/y && make && cp y /usr/local/bin/\"");
    lines.push("    download: \"curl -L https://github.com/x/y/releases/latest/download/y-linux -o /usr/local/bin/y && chmod +x /usr/local/bin/y\"");
    lines.push("- These all work. The pipeline runs them under sh. They must exit 0.");
    lines.push("- NEVER write Command::new(\"<tool>\") WITHOUT that tool being installed");
    lines.push("  by requires.post_install, requires.npm, requires.pip, or already on PATH.");
    lines.push("");
    lines.push("CRITICAL — READ ALL INPUTS FROM ENV:");
    lines.push("- accepts keys map to env vars: image_path -> IMAGE_PATH.");
    lines.push("- READ EVERY accepts key: std::env::var(\"IMAGE_PATH\").expect(...)");
    lines.push("- DO NOT hardcode /tmp/output.pdf. Use std::env::var(\"OUTPUT_PATH\").");
    lines.push("- Correct example:");
    lines.push("    fn main() {");
    lines.push("        let input_path = std::env::args().nth(1).unwrap_or_else(|| \"/tmp/in\".to_string());");
    lines.push("        // input_path is now visible below (same fn scope)");
    lines.push("        let result = do_thing(input_path);");
    lines.push("        // result is now visible below");
    lines.push("        println!(\"{{\\\"pdf_path\\\":\\\"{}\\\"}}\", result);");
    lines.push("    }");
    lines.push("- Incorrect (WILL FAIL COMPILATION):");
    lines.push("    fn main() {");
    lines.push("        globalThis.input_path = ...;   // NO SUCH THING IN RUST");
    lines.push("    }");
    lines.push("");
    if (facts.version) lines.push("Latest version: " + facts.version);
    if (facts.description) lines.push("Description: " + facts.description);
    if (facts.readme) {
      lines.push("");
      lines.push("README (first " + Math.min(facts.readme.length, 8000) + " chars):");
      lines.push("<<<");
      lines.push(facts.readme.slice(0, 8000));
      lines.push(">>>");
    }
    lines.push("");
  }

  if (facts.source_kind === "go_module" && facts.go_module) {
    lines.push("GO CANDIDATE — this is a Go module, not a Node/Python package.");
    lines.push("");
    lines.push("- The kernel runs GO with `go mod tidy` resolving imports automatically.");
    lines.push("- Your synthesized capability MUST declare:");
    lines.push("    \"kernel_language\": \"go\"");
    lines.push("    \"requires\": { \"npm\": [], \"pip\": [], \"post_install\": null, \"capability\": [] }");
    lines.push("");
    lines.push("GO RULES (READ TWICE):");
    lines.push("- The plan MUST contain EXACTLY 1 step with verb \"execute\".");
    lines.push("- The step.code is a COMPLETE Go file. Structure:");
    lines.push("    package main");
    lines.push("    import (");
    lines.push("        \"fmt\"");
    lines.push("        \"" + facts.go_module + "\"");
    lines.push("    )");
    lines.push("    func main() {");
    lines.push("        // full logic here");
    lines.push("        fmt.Println(\"{...}\")");
    lines.push("    }");
    lines.push("- Use fmt.Println to emit the final JSON. Kernel captures stdout.");
    lines.push("- Import path MUST be the module path exactly: " + facts.go_module);
    lines.push("- Do NOT use `errcheck` panics; `if err != nil { panic(err) }` is fine.");
    lines.push("- Build JSON manually with fmt.Sprintf or structs+encoding/json.");
    lines.push("");
    if (facts.version) lines.push("Latest version: " + facts.version);
    if (facts.readme) {
      lines.push("");
      lines.push("README (first " + Math.min(facts.readme.length, 8000) + " chars):");
      lines.push("<<<");
      lines.push(facts.readme.slice(0, 8000));
      lines.push(">>>");
    }
    lines.push("");
  }

  if (facts.source_kind === "pypi" && facts.pypi_package_name) {
    lines.push("PYPI CANDIDATE — this is a Python package, not a Node repo.");
    lines.push("");
    lines.push("- The package is installed in the synth session via pip. It will ALSO");
    lines.push("  be installed in the trial session via requires.pip.");
    lines.push("- Your synthesized capability MUST declare:");
    lines.push("    \"kernel_language\": \"python\"");
    lines.push("    \"requires\": { \"npm\": [], \"pip\": [\"" + facts.pypi_package_name + "\"], \"post_install\": null, \"capability\": [] }");
    lines.push("");
    lines.push("PYTHON RULES (READ TWICE):");
    lines.push("- The kernel runs PYTHON 3.11. NOT JavaScript. No const/let/await import/console.log/process.env.");
    lines.push("- Load the package at the top of the step that needs it:");
    lines.push("    import " + facts.pypi_module_name);
    lines.push("  or for a specific function:");
    lines.push("    from " + facts.pypi_module_name + " import <func>");
    lines.push("- Read env vars with: os.environ.get('NAME', '')  (import os first)");
    lines.push("- Emit the final JSON by printing exactly one object to stdout:");
    lines.push("    import json");
    lines.push("    print(json.dumps({ \"<output_key>\": <value> }))");
    lines.push("  Nothing else should print to stdout in the emit step.");
    lines.push("- Write a file: with open(path, 'wb') as f: f.write(bytes_)");
    lines.push("- Read a file:  with open(path, 'rb') as f: data = f.read()");
    lines.push("- State between steps: Python variables DO persist across steps within");
    lines.push("  the same script (no blocks). Assign x = ... in step 1, use x in step 2.");
    lines.push("- Do NOT use globalThis, that is JavaScript.");
    lines.push("");
    if (facts.summary) lines.push("PyPI summary: " + facts.summary);
    if (facts.version) lines.push("Version: " + facts.version);
    if (facts.readme) {
      lines.push("");
      lines.push("PyPI description (first " + Math.min(facts.readme.length, 8000) + " chars):");
      lines.push("<<<");
      lines.push(facts.readme.slice(0, 8000));
      lines.push(">>>");
    }
    if (facts.init_content) {
      lines.push("");
      lines.push("Module __init__.py (first 6000 chars — shows available functions):");
      lines.push("<<<");
      lines.push(facts.init_content);
      lines.push(">>>");
    }
    if (facts.top_level && facts.top_level.length) {
      lines.push("");
      lines.push("Package files:");
      lines.push(facts.top_level.join("\n"));
    }
    lines.push("");
  }

  if (facts.source_kind === "skill") {
    lines.push("SKILL CANDIDATE — this is an agent SKILL.md, not code. It is a set of");
    lines.push("instructions that go into an LLM system prompt.");
    lines.push("");
    lines.push("You must produce a spec of type \"skill_wrapper\", NOT a plan spec. Emit:");
    lines.push("{");
    lines.push("  \"type\": \"skill_wrapper\",");
    lines.push("  \"capability\": {");
    lines.push("    \"id\": \"<from THE GAP above, with any prefix like 'clawhub:' or 'agentskills:' removed>\",");
    lines.push("    \"kind\": \"agent_skill\",");
    lines.push("    \"accepts\": { \"<key>\": \"string\" | { \"type\": \"string|number|boolean\", \"optional\": true } },");
    lines.push("    \"produces\": { \"<output_key>\": \"string|number|boolean\" },");
    lines.push("    \"requires\": { \"npm\": [], \"pip\": [], \"post_install\": null, \"capability\": [] }");
    lines.push("  },");
    lines.push("  \"skill\": {");
    lines.push("    \"name\": \"<from frontmatter name, or skill name>\",");
    lines.push("    \"body\": \"<the full skill body markdown as a single JSON string. Use backslash-n for newlines.>\"");
    lines.push("  },");
    lines.push("  \"llm\": {");
    lines.push("    \"provider\": \"groq\",");
    lines.push("    \"model\": \"qwen/qwen3.8-27b\",");
    lines.push("    \"temperature\": 0.2,");
    lines.push("    \"max_tokens\": 4000");
    lines.push("  },");
    lines.push("  \"input_map\": { \"<input_key>\": \"<label that describes this input in the user message>\" },");
    lines.push("  \"accept_spec\": {");
    lines.push("    \"input\": { \"<key>\": \"<example value for the acceptance probe>\" },");
    lines.push("    \"min_bytes\": 0");
    lines.push("  }");
    lines.push("}");
    lines.push("");
    lines.push("Rules for the skill wrapper spec:");
    lines.push("- Output ONLY the JSON above. No plan field. No kernel_script. No glue.");
    lines.push("- accepts must include every input key the skill needs to do its job.");
    lines.push("- produces must include at least one output field. The LLM is prompted to");
    lines.push("  respond with JSON matching this exact shape. Add 'content' if you want the");
    lines.push("  raw LLM text as a fallback output field.");
    lines.push("- input_map lists each input key and a short label that will appear in the");
    lines.push("  user message preamble. Example: \"order_data\": \"Order JSON\".");
    lines.push("- accept_spec.input must supply values for every input key.");
    lines.push("- min_bytes: use 0. The LLM output is text, not a binary.");
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
