// agentry/src/handlers/synthesize/readers/npm.mjs
// v0.53.0 — extracted from agentry.synthesize.mjs.
// Reads an npm package + inspects its runtime export surface.

import { MAX_README_CHARS, MAX_MANIFEST_CHARS } from "../config.mjs";

export async function readNpmPackage(candidate, deps) {
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
    // v0.52.14 — inspect the ACTUAL exports of the installed package.
    // LLMs hallucinate method names from memory (e.g. XLSX.utils.csv_to_sheet
    // doesn't exist; the real API is XLSX.read + utils.aoa_to_sheet). Dumping
    // the real export surface as a hard constraint prevents phantom methods.
    try {
      const inspectCode = [
        "const pkgName = process.env.PKG_NAME;",
        "try {",
        "  const mod = await import(pkgName);",
        "  const keyList = (o) => { try { return o ? Object.keys(o).filter(k => !k.startsWith('_')).slice(0, 40) : null; } catch { return null; } };",
        "  const out = {",
        "    top: keyList(mod),",
        "    default: keyList(mod.default),",
        "    utils: keyList(mod.utils || mod.default?.utils),",
        "    default_utils: keyList(mod.default?.utils),",
        "    default_is_function: typeof mod.default === 'function',",
        "  };",
        "  console.log(JSON.stringify(out));",
        "} catch (e) { console.log(JSON.stringify({ error: e.message })); }",
      ].join("\n");
      const inspRes = await invoke("agentry.os", {
        action: "node.run", session, code: inspectCode,
        env: { PKG_NAME: facts.npm_package_name }, timeout_ms: 15000,
      }, { tenant: "local", by: "agentry.synthesize" });
      if (inspRes.ok) {
        const stdout = String(inspRes.output?.result?.stdout || "").trim();
        if (stdout) {
          try {
            const parsed = JSON.parse(stdout);
            if (!parsed.error) facts.npm_exports = parsed;
          } catch {}
        }
      }
    } catch (e) {}
  } catch (e) {
    facts.error = "npm read threw: " + e.message;
  }

  return facts;
}

// v0.19.0 — read an agent SKILL.md as the candidate source.
// Fetches the raw file (for agentskills_code) or the ClawHub API
// detail (for clawhub), extracts frontmatter + body, and returns
// a facts object with source_kind = "skill".
// v0.24.1 — read a PyPI package: pip install, read module __init__.py,
// fetch pypi metadata, list package files. Mirrors readNpmPackage.
