// agentry/src/handlers/synthesize/readers/repo.mjs
// v0.53.0 — extracted from agentry.synthesize.mjs.
// Reads a cloned GitHub repo's territory.

import { MAX_README_CHARS, MAX_MANIFEST_CHARS } from "../config.mjs";

export async function readRepoTerritory(candidate, deps) {
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
