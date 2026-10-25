// agentry/src/adapters/_synthesis_support.mjs
//
// Single source of truth for "can this discovery source produce a working
// capability, or is it search-only?"
//
// v0.29.1 — surfaced because the handover doc implied "14 sources" meant
// "14 sources we can build from." Reality: discovery fans out to all 14
// via agentry.discover (v0.23.6). But synthesis.mjs only has branches for
// agent_skill, npm_package, python_package/pypi:, and repo (github).
// crates / maven / nuget / gomod / huggingface / dsh_plugins have no
// runtime kernel (no rustc/go/java/dotnet in the Dockerfile) and no
// read* function. They are search-only.

export const SYNTHESIS_SUPPORT = {
  // Full synthesis
  "npm":              { synthesizable: true,  runtime: "node" },
  "pypi":             { synthesizable: true,  runtime: "python" },
  "agentskills_code": { synthesizable: true,  runtime: "skill_wrapper" },
  "clawhub":          { synthesizable: true,  runtime: "skill_wrapper" },
  "github":           { synthesizable: true,  runtime: "repo" },
  "local":            { synthesizable: false, runtime: "existing_graph" },

  // Partial / conditional
  "web":              { synthesizable: "conditional", runtime: "repo_if_github_url" },
  // v0.52.10 — hermes_atlas path always fails: readAgentSkill fetches
  // https://github.com/<repo>/HEAD/... which 404s on most repos, and even
  // when it does return content, SKILL.md body is often empty → trial
  // throws skill_body_missing. Re-enable when readAgentSkill learns to
  // handle raw repo URLs. Until then rely on clawhub / agentskills_code /
  // npm / pypi, all of which have working fetchers.
  "hermes_atlas":     { synthesizable: false,        runtime: "hermes_repo_never_wired" },

  // Discovery-only — no synthesis path exists
  "crates":           { synthesizable: true,  runtime: "rust" },
  "maven":            { synthesizable: false, runtime: "jvm_missing" },
  "nuget":            { synthesizable: false, runtime: "dotnet_missing" },
  "gomod":            { synthesizable: true,  runtime: "go" },
  "huggingface":      { synthesizable: false, runtime: "model_not_runtime_lib" },
  "dsh_plugins":      { synthesizable: true,  runtime: "node" },
};

export function supportFor(source) {
  return SYNTHESIS_SUPPORT[source] || { synthesizable: false, runtime: "unknown" };
}

export function isSynthesizable(candidate) {
  const s = supportFor(candidate?.source || "");
  return s.synthesizable === true || s.synthesizable === "conditional" || s.synthesizable === "partial";
}

export function unsynthesizableSources() {
  return Object.entries(SYNTHESIS_SUPPORT)
    .filter(([, v]) => v.synthesizable === false)
    .map(([k]) => k);
}

export function synthesizableSources() {
  return Object.entries(SYNTHESIS_SUPPORT)
    .filter(([, v]) => v.synthesizable === true || v.synthesizable === "conditional" || v.synthesizable === "partial")
    .map(([k]) => k);
}
