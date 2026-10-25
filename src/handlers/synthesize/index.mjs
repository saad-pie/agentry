// agentry/src/handlers/agentry.synthesize.mjs
//
// The teaching handler. Given an approved candidate, produce a working
// handler for the gap it fills.
//
// v0.15.29 — fill-in-the-blanks synthesis.
// v0.17.4 — npm candidate support (readNpmPackage).
// v0.17.5 — prompt says session starts empty.
// v0.17.6 — ESM rule (wrong, corrected in v0.17.9).
// v0.17.7 — cross-section spec consistency validator.
// v0.17.8 — cross-step state via globalThis.
// v0.17.9 — correct module-loading rule: dynamic import only.
// v0.53.4 — moved from agentry.synthesize.mjs. That file is now a re-export.

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getShape } from "../_shapes.mjs";
import {
  HANDLERS_DIR, SEEDS_DIR, MODEL_CHAIN,
} from "./config.mjs";
import { readRepoTerritory } from "./readers/repo.mjs";
import { readNpmPackage } from "./readers/npm.mjs";
import { readPyPiPackage } from "./readers/pypi.mjs";
import { readCrate } from "./readers/crate.mjs";
import { readGoModule } from "./readers/gomod.mjs";
import { readAgentSkill } from "./readers/skill.mjs";
import { buildPrompt } from "./prompt/index.mjs";
import { pickReferenceHandlers } from "./references.mjs";
import { renderHandler } from "./render/plan.mjs";
import { renderSkillHandler } from "./render/skill.mjs";
import { renderSeed } from "./render/seed.mjs";
import { autoFixtures } from "./fixtures.mjs";
import { extractJson } from "./validate/json.mjs";
import { validatePlan } from "./validate/plan.mjs";
import { validateSpecConsistency } from "./validate/spec.mjs";

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
  if (candidate.kind === "agent_skill") {
    try {
      facts = await readAgentSkill(candidate, ctx);
      events.emit("synthesize.skill_read", {
        proposal_id, candidate_id,
        skill_name: facts.skill_name,
        skill_source_url: facts.skill_source_url,
        body_len: facts.skill_body ? facts.skill_body.length : 0,
        error: facts.error,
      });
    } catch (e) {
      events.emit("synthesize.skill_read_failed", { proposal_id, candidate_id, error: e.message });
    }
  } else if (candidate.kind === "npm_package") {
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
  } else if (candidate.kind === "python_package" || candidate.source === "pypi" || String(candidate.id || "").startsWith("pypi:")) {
    try {
      facts = await readPyPiPackage(candidate, ctx);
      events.emit("synthesize.pypi_read", {
        proposal_id, candidate_id,
        installed: facts.installed,
        package_name: facts.pypi_package_name,
        module_name: facts.pypi_module_name,
        version: facts.version,
        readme_len: facts.readme ? facts.readme.length : 0,
        init_len: facts.init_content ? facts.init_content.length : 0,
        top_level_count: facts.top_level.length,
        error: facts.error,
      });
    } catch (e) {
      events.emit("synthesize.pypi_read_failed", { proposal_id, candidate_id, error: e.message });
    }
  } else if (candidate.kind === "rust_crate" || candidate.source === "crates" || String(candidate.id || "").startsWith("crates:")) {
    try {
      facts = await readCrate(candidate, ctx);
      events.emit("synthesize.crate_read", {
        proposal_id, candidate_id,
        crate_name: facts.crate_name, version: facts.version,
        readme_len: facts.readme ? facts.readme.length : 0,
        error: facts.error,
      });
    } catch (e) {
      events.emit("synthesize.crate_read_failed", { proposal_id, candidate_id, error: e.message });
    }
  } else if (candidate.kind === "go_module" || candidate.source === "gomod" || String(candidate.id || "").startsWith("gomod:")) {
    try {
      facts = await readGoModule(candidate, ctx);
      events.emit("synthesize.gomod_read", {
        proposal_id, candidate_id,
        go_module: facts.go_module, version: facts.version,
        readme_len: facts.readme ? facts.readme.length : 0,
        error: facts.error,
      });
    } catch (e) {
      events.emit("synthesize.gomod_read_failed", { proposal_id, candidate_id, error: e.message });
    }
  } else if (candidate.kind === "dsh_plugin" || String(candidate.id || "").startsWith("dsh_plugin:")) {
    const _id = String(candidate.id || "");
    const _pkg = _id.startsWith("dsh_plugin:") ? _id.slice("dsh_plugin:".length) : _id;
    try {
      facts = await readNpmPackage({ ...candidate, id: "npm:" + _pkg }, ctx);
      events.emit("synthesize.dsh_plugin_read", { proposal_id, candidate_id, package_name: _pkg, error: facts.error });
    } catch (e) {
      events.emit("synthesize.dsh_plugin_read_failed", { proposal_id, candidate_id, error: e.message });
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

  {
    const _isSkill = candidate.source === "clawhub"
      || candidate.source === "agentskills_code"
      || candidate.source === "hermes_atlas"
      || candidate.kind === "agent_skill"
      || candidate.kind === "hermes_repo"
      || (facts && facts.source_kind === "skill");
    const _body = facts && typeof facts.skill_body === "string" ? facts.skill_body.trim() : "";
    if (_isSkill && _body.length === 0) {
      const _why = (facts && facts.error) || "skill_body_missing";
      events.emit("synthesize.skill_body_empty", { proposal_id, candidate_id, reason: _why });
      throw new Error("agentry.synthesize: skill candidate " + candidate.id + " has empty SKILL.md body (" + _why + "). Refusing to fabricate.");
    }
  }
  // v0.31.10 — hard-fail when readCrate flagged the candidate as unusable.
  // Belt: readCrate sets rejected_reason. Suspenders: this catches anything
  // else with a blockers array. Emits candidate_rejected so the pipeline
  // records the specific reason, then throws — candidate marked failed,
  // gap re-opens, next candidate tried.
  if (facts && facts.rejected_reason) {
    events.emit("synthesize.candidate_rejected", {
      proposal_id, candidate_id,
      reason: facts.rejected_reason,
      blockers: facts.blockers || [facts.rejected_reason],
      categories: facts.categories || [],
    });
    throw new Error("agentry.synthesize: candidate " + candidate.id + " rejected — " + String(facts.error || facts.rejected_reason).slice(0, 400));
  }

  const _hasReadme = facts.readme && facts.readme.length > 500;
  const _refs = _hasReadme
    ? []
    : pickReferenceHandlers(gap.wanted_description || candidate.id, gap.wanted_kind || "tool", 2);
  events.emit("synthesize.references_picked", {
    proposal_id, candidate_id,
    count: _refs.length,
    ids: _refs.map(r => r.id),
    skipped_has_readme: _hasReadme,
  });
  const prompt = buildPrompt({ gap, candidate, facts, shape, references: _refs });

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
        max_tokens: 3500,
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

  // v0.19.3 — detect spec type early so validation branches correctly.
  // A skill_wrapper spec has no glue (that is plan-only). Before this,
  // every skill spec failed the "missing capability.id or glue" check.
  const isSkillWrapper = spec.type === "skill_wrapper";

  if (!spec.capability?.id) {
    throw new Error("agentry.synthesize: spec missing capability.id");
  }

  // v0.23.1 — namespace capability.id by candidate.
  // Reasoner's gap.wanted_id is the same across all candidates in a
  // proposal. When adopt expands candidates (npm:*, agentskills:*),
  // the LLM returns the same capability.id for each, causing handler
  // path collisions and silent overwrites. Derive from candidate.id
  // so every candidate writes a distinct handler file.
  {
    // v0.31.4 — source-aware namespacing. Prior version stripped the
    // source prefix, so `crates:topdf` and `npm:topdf` both became
    // `topdf` — same graph node, and a trial failure for one retired
    // the other. Now the source prefix is preserved:
    //   crates:topdf   -> crates_topdf
    //   npm:topdf      -> npm_topdf
    //   pypi:img2pdf   -> pypi_img2pdf
    //   pdf-lib-table  -> pdf-lib-table  (no source, unchanged)
    const _candId = String(candidate.id || "");
    const _srcMatch = _candId.match(/^([a-z][a-z0-9_]*):(.*)$/i);
    let _norm;
    if (_srcMatch) {
      const _src = _srcMatch[1].toLowerCase().replace(/[^a-z0-9]/g, "_");
      const _rest = _srcMatch[2].replace(/^[^a-zA-Z0-9]+/, "").replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
      _norm = (_rest ? (_src + "_" + _rest) : _src).slice(0, 80);
    } else {
      _norm = _candId.replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
    }
    if (_norm && spec.capability.id !== _norm) {
      events.emit("synthesize.capability_id_namespaced", {
        original: spec.capability.id,
        normalized: _norm,
        candidate_id: candidate.id,
        source_preserved: Boolean(_srcMatch),
      });
      spec.capability.id = _norm;
    }
  }
  if (!isSkillWrapper && !spec.glue) {
    throw new Error("agentry.synthesize: plan spec missing glue");
  }
  if (isSkillWrapper && (!spec.skill || !spec.skill.body)) {
    throw new Error("agentry.synthesize: skill_wrapper spec missing skill.body");
  }

  // Normalize the capability id into a filesystem-safe form:
  //   1. strip "gap:" prefix if the LLM echoed it
  //   2. strip "clawhub:", "agentskills:", "hermes_atlas:" for skill
  //      candidates (they come from discover and are not valid file chars)
  //   3. drop trailing "/SKILL.md" and ".md"
  //   4. replace any remaining non [a-zA-Z0-9_.-] with underscore
  if (typeof spec.capability.id === "string") {
    let id = spec.capability.id;
    const original = id;
    if (id.startsWith("gap:")) id = id.slice(4);
    if (isSkillWrapper) {
      if (id.startsWith("clawhub:")) id = id.slice("clawhub:".length);
      else if (id.startsWith("agentskills:")) id = id.slice("agentskills:".length);
      else if (id.startsWith("hermes_atlas:")) id = id.slice("hermes_atlas:".length);
    }
    id = id.replace(/\/SKILL\.md$/i, "").replace(/\.md$/i, "");
    id = id.replace(/[^a-zA-Z0-9_.-]/g, "_");
    spec.capability.id = id;
    if (id !== original) {
      events.emit("synthesize.id_normalized", {
        proposal_id, candidate_id,
        original,
        normalized: id,
        is_skill_wrapper: isSkillWrapper,
      });
    }
  }

  if (!isSkillWrapper) {
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
  } else {
    // Skill wrapper validation: must have skill.body and input_map,
    // and each input_map key must be an accepts key. Every throw here
    // emits an event so silent failures become visible.
    const fail = (check, detail) => {
      events.emit("synthesize.skill_invalid", {
        proposal_id, candidate_id,
        capability_id: spec.capability.id,
        check,
        detail,
        spec_preview: JSON.stringify({
          has_skill: Boolean(spec.skill),
          skill_keys: spec.skill ? Object.keys(spec.skill) : [],
          body_len: spec.skill && spec.skill.body ? String(spec.skill.body).length : 0,
          has_input_map: Boolean(spec.input_map),
          input_map_keys: spec.input_map ? Object.keys(spec.input_map) : [],
          accepts_keys: Object.keys(spec.capability.accepts || {}),
          accept_spec_keys: Object.keys(spec.accept_spec?.input || {}),
        }).slice(0, 500),
        model_used: llmUsed ? (llmUsed.provider + "/" + llmUsed.model) : null,
      });
      throw new Error("agentry.synthesize: skill_wrapper failed [" + check + "]: " + detail);
    };

    if (!spec.skill || !spec.skill.body || !String(spec.skill.body).trim()) {
      fail("missing_skill_body", "spec.skill.body is empty or absent");
    }
    if (!spec.skill.name || !String(spec.skill.name).trim()) {
      // Name is used only for logging; fill with a default.
      spec.skill.name = spec.capability.id;
    }
    if (!spec.input_map || typeof spec.input_map !== "object") {
      fail("missing_input_map", "spec.input_map is not an object");
    }
    const acceptsKeys = new Set(Object.keys(spec.capability.accepts || {}));
    for (const k of Object.keys(spec.input_map)) {
      if (!acceptsKeys.has(k)) {
        fail("input_map_key_not_in_accepts", "input_map key \"" + k + "\" is not declared in accepts");
      }
    }
    const acceptKeys = new Set(Object.keys(spec.accept_spec?.input || {}));
    for (const k of acceptsKeys) {
      const spec2 = spec.capability.accepts[k];
      const optional = spec2 && typeof spec2 === "object" && spec2.optional === true;
      if (!optional && !acceptKeys.has(k)) {
        fail("accept_spec_missing_key", "accept_spec.input is missing required key \"" + k + "\"");
      }
    }
  }

  // v0.19.4 — glue is optional. Plan specs have it; skill_wrapper
  // specs do not. Using spec.glue.pre_invoke directly threw a
  // "Cannot read properties of undefined" on every skill spec.
  const composedDeclared = new Set(
    Array.isArray(spec.capability.requires?.capability)
      ? spec.capability.requires.capability
      : []
  );
  const preInvokeCaps = Object.values(spec.glue?.pre_invoke || {})
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

  autoFixtures(spec);
  const renderedHandler = isSkillWrapper ? renderSkillHandler(spec) : renderHandler(spec);
  writeFileSync(handlerPath, renderedHandler);

  // v0.24.0 — pre-flight validation. Catch syntax errors before
  // declaring synthesize_completed. Prior versions let broken handlers
  // reach trial, where the error surfaced 60s later as "kernel exited 1".
  {
    const lang = spec.kernel_language === "python" ? "python" : "node";
    const _src = String(renderedHandler);
    // Language sanity: if node, reject obvious python; if python, reject obvious node
    const _isSkill = spec.type === "skill_wrapper";
    if (!_isSkill) {
      if (lang === "node" && /^\s*def\s+\w+\s*\(|^\s*from\s+\w+\s+import\s+|^\s*import\s+\w+\s*$/m.test(_src)) {
        events.emit("synthesize.language_mismatch", { proposal_id, candidate_id, capability_id: spec.capability.id, declared: "node", looks_like: "python" });
        throw new Error("agentry.synthesize: kernel_language=node but code contains Python syntax. Rejecting.");
      }
      if (lang === "python" && /await\s+import|(?:const|let|var)\s+\w+\s*=|\(async\s*\(\)\s*=>/.test(_src)) {
        events.emit("synthesize.language_mismatch", { proposal_id, candidate_id, capability_id: spec.capability.id, declared: "python", looks_like: "node" });
        throw new Error("agentry.synthesize: kernel_language=python but code contains JS syntax. Rejecting.");
      }
    }
    // Syntax check the rendered handler
    const { spawnSync } = await import("node:child_process");
    const _check = spawnSync("node", ["--check", handlerPath], { encoding: "utf8", timeout: 15000 });
    if (_check.status !== 0) {
      events.emit("synthesize.syntax_error", {
        proposal_id, candidate_id, capability_id: spec.capability.id,
        stderr: String(_check.stderr || "").slice(0, 500),
      });
      throw new Error("agentry.synthesize: rendered handler failed node --check: " + String(_check.stderr || "").slice(0, 300));
    }
  }

  writeFileSync(seedPath, JSON.stringify(renderSeed(spec, handlerPath), null, 2));

  events.emit("synthesize.completed", {
    proposal_id, candidate_id, gap_id: gap.id,
    capability_id: spec.capability.id,
    kind: spec.capability.kind,
    spec_type: spec.type || "plan",
    wanted_kind: gap.wanted_kind || null,
    shape_steps: shape.steps.length,
    plan_steps: spec.plan ? spec.plan.length : 0,
    handler_path: handlerPath,
    seed_path: seedPath,
    composed_capabilities: [...composedDeclared],
    pre_invoke_count: preInvokeCaps.length,
    spec_type: spec.type || "plan",
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
      plan_steps: spec.plan ? spec.plan.length : 0,
      composed_capabilities: [...composedDeclared],
      model_used: llmUsed ? (llmUsed.provider + "/" + llmUsed.model) : (llmRes.output.model || null),
    },
    cost: { time_ms: Date.now() - started },
  };
}

