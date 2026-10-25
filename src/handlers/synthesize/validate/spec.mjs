// agentry/src/handlers/synthesize/validate/spec.mjs
// v0.53.3 — extracted from agentry.synthesize.mjs.

export function validateSpecConsistency(spec, capability_id) {
  // v0.31.0 — Rust/Go use single-step full-program plans. The standard
  // env_map/emit-step checks don't apply because the program IS the emit.
  // v0.31.2 — reject globalThis explicitly. LLM copies it from the shared
  // prompt's JS guidance; Rust/Go have no globalThis. Fail at synthesis
  // (~2s) instead of trial (~30s waiting on rust-script compile).
  if (spec.kernel_language === "rust" || spec.kernel_language === "go") {
    const allCode = (Array.isArray(spec.plan) ? spec.plan : [])
      .map(s => String(s.code || ""))
      .join("\n");
    if (/globalThis\./.test(allCode)) {
      return {
        ok: false,
        check: "rust_go_uses_globalThis",
        detail: "Generated " + spec.kernel_language + " code contains 'globalThis.X' — that is JavaScript. Use local variables inside ONE fn main (or func main). All state flows through shared function scope.",
      };
    }
    if (spec.kernel_language === "rust" && /console\.log|process\.env|await\s+import/.test(allCode)) {
      return {
        ok: false,
        check: "rust_uses_js_apis",
        detail: "Generated Rust code contains JS-only calls (console.log / process.env / await import). Use println! / std::env::var / use statements.",
      };
    }
    // v0.31.7 — Command::new(<tool>) is legal if post_install or
    // requires.npm/pip installs it, or if it's a known system tool.
    // Simple token scan; no regex-inside-regex.
    if (spec.kernel_language === "rust" || spec.kernel_language === "go" || spec.kernel_language === "java" || spec.kernel_language === "dotnet") {
      const req = (spec.capability && spec.capability.requires) || {};
      const postInstall = String(req.post_install || "");
      const npmPkgs = Array.isArray(req.npm) ? req.npm.join(" ") : "";
      const pipPkgs = Array.isArray(req.pip) ? req.pip.join(" ") : "";
      const installedBlob = (postInstall + " " + npmPkgs + " " + pipPkgs).toLowerCase();
      const SYSTEM = new Set(["sh", "bash", "ls", "cat", "echo", "which", "python3", "python", "node", "git", "curl", "cp", "mv", "rm", "mkdir", "true", "false", "env"]);

      // scan Command::new("X") or exec("X") by splitting, no regex groups
      const marker = "Command::new(";
      let idx = 0;
      while ((idx = allCode.indexOf(marker, idx)) !== -1) {
        idx += marker.length;
        // skip whitespace
        while (idx < allCode.length && /\s/.test(allCode[idx])) idx++;
        const q = allCode[idx];
        if (q !== '"' && q !== "'") continue;
        idx++;
        let tool = "";
        while (idx < allCode.length && allCode[idx] !== q) {
          tool += allCode[idx];
          idx++;
        }
        idx++;
        if (!tool || SYSTEM.has(tool)) continue;
        const toolLower = tool.toLowerCase();
        const known = installedBlob.includes(toolLower)
          || (Array.isArray(req.rust_crates) && req.rust_crates.some(c => String(c).split("@")[0].toLowerCase() === toolLower && false));
        if (!known) {
          return {
            ok: false,
            check: "command_without_install",
            detail: "Command::new(\"" + tool + "\") but requires.post_install (or requires.npm / requires.pip) does not install it. Add \"apt-get install -y " + tool + "\" or \"cargo install --locked " + tool + "\" or another installer to post_install, or switch to library usage (use " + tool.replace(/-/g, "_") + ";).",
          };
        }
      }
    }
    if (spec.kernel_language === "go" && /console\.log|process\.env|await\s+import/.test(allCode)) {
      return {
        ok: false,
        check: "go_uses_js_apis",
        detail: "Generated Go code contains JS-only calls. Use fmt.Println / os.Getenv / import.",
      };
    }
    return { ok: true };
  }
  const plan = Array.isArray(spec.plan) ? spec.plan : [];
  const glue = spec.glue || {};
  const envMap = glue.env_map || {};
  const acceptInput = spec.accept_spec && spec.accept_spec.input ? spec.accept_spec.input : {};
  const produces = spec.capability && spec.capability.produces ? spec.capability.produces : {};

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
  // v0.52.11 — auto-derive missing env_map entries from accepts. Common LLM
  // mistake: writes process.env.OUTPUT_PATH but forgets the env_map entry.
  // That's mechanical, not a bug worth rejecting. Derive OUTPUT_PATH -> output_path
  // (lowercase match against accepts keys) and proceed.
  const _acceptDeclared = spec.capability && spec.capability.accepts ? spec.capability.accepts : {};
  for (const key of envKeysUsed) {
    if (envMapKeys.has(key)) continue;
    const lower = key.toLowerCase();
    if (_acceptDeclared[lower] !== undefined) {
      if (!spec.glue) spec.glue = {};
      if (!spec.glue.env_map) spec.glue.env_map = envMap;
      spec.glue.env_map[key] = lower;
      envMapKeys.add(key);
    }
  }
  for (const key of envKeysUsed) {
    if (!envMapKeys.has(key)) {
      return {
        ok: false,
        check: "env_var_not_in_env_map",
        detail: "plan reads process.env." + key + " but env_map has no such key. env_map keys: " + ([...envMapKeys].join(", ") || "(none)"),
      };
    }
  }

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

  // v0.23.2 — required accepts keys must appear in accept_spec.input.
  // Plan specs (npm, github) didn't have this check; the analogous check
  // for skill_wrapper exists in the skill branch, but plan specs slipped
  // through and failed at trial time with "missing <key>".
  {
    const acceptsDeclared = spec.capability && spec.capability.accepts ? spec.capability.accepts : {};
    for (const k of Object.keys(acceptsDeclared)) {
      const spec2 = acceptsDeclared[k];
      const optional = spec2 && typeof spec2 === "object" && spec2.optional === true;
      if (!optional && !acceptKeys.has(k)) {
        return {
          ok: false,
          check: "accept_spec_missing_key",
          detail: "accept_spec.input is missing required key \"" + k + "\". accept_spec.input keys: " + ([...acceptKeys].join(", ") || "(none)"),
        };
      }
    }
  }

  const emitStep = plan.find(s => s && s.verb === "emit");
  const emitCode = emitStep ? String(emitStep.code || "") : "";
  for (const key of Object.keys(produces)) {
    if (key === "captured_at" || key === "bytes") continue;
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

