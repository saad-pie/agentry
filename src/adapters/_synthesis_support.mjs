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
  "hermes_atlas":     { synthesizable: "partial",     runtime: "hermes_repo_never_wired" },

  // Discovery-only — no synthesis path exists
  "crates":           { synthesizable: false, runtime: "rust_missing" },
  "maven":            { synthesizable: false, runtime: "jvm_missing" },
  "nuget":            { synthesizable: false, runtime: "dotnet_missing" },
  "gomod":            { synthesizable: false, runtime: "go_missing" },
  "huggingface":      { synthesizable: false, runtime: "model_not_runtime_lib" },
  "dsh_plugins":      { synthesizable: false, runtime: "plugin_lifecycle" },
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
