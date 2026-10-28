// agentry/src/handlers/synthesize/readers/nuget.mjs
// v0.56.37 — reads a NuGet package's metadata + README from GitHub if available.

import { MAX_README_CHARS } from "../config.mjs";

export async function readNuget(candidate, deps) {
  const pkgId = String(candidate.name || candidate.id || "").replace(/^nuget:/, "").trim();
  const facts = {
    session: null,
    source_kind: "nuget",
    package_id: pkgId,
    version: null,
    description: null,
    authors: null,
    repository: null,
    readme: null,
    error: null,
  };

  if (!pkgId) {
    facts.error = "nuget candidate missing package id";
    return facts;
  }

  // 1. NuGet registration API for version + metadata
  try {
    const regUrl = "https://api.nuget.org/v3/registration5-semver1/" + encodeURIComponent(pkgId.toLowerCase()) + "/index.json";
    const res = await fetch(regUrl, { headers: { "user-agent": "agentry/0.56" }, signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const d = await res.json();
      const items = d && Array.isArray(d.items) ? d.items : [];
      if (items.length > 0) {
        const latest = items[items.length - 1];
        const inner = latest.items && Array.isArray(latest.items) ? latest.items[latest.items.length - 1] : null;
        const entry = inner && inner.catalogEntry ? inner.catalogEntry : null;
        if (entry) {
          facts.version = entry.version || null;
          facts.description = entry.description || null;
          facts.authors = Array.isArray(entry.authors)
            ? entry.authors.join(", ")
            : (typeof entry.authors === "string" ? entry.authors : null);
          if (entry.projectUrl) facts.repository = entry.projectUrl;
        }
      }
    }
  } catch (e) { facts.error = "nuget reg: " + e.message; }
  if (!facts.version) {
    if (!facts.error) facts.error = "nuget registration returned no version";
    return facts;
  }

  // 2. If repository is GitHub, fetch README
  if (facts.repository) {
    const ghMatch = facts.repository.match(/github\.com[\/:]([^\/]+)\/([^\/\.\s\?]+)/);
    if (ghMatch) {
      const owner = ghMatch[1];
      const repo = ghMatch[2].replace(/\.git$/, "");
      for (const branch of ["main", "master"]) {
        try {
          const readmeUrl = "https://raw.githubusercontent.com/" + owner + "/" + repo + "/" + branch + "/README.md";
          const res = await fetch(readmeUrl, { headers: { "user-agent": "agentry/0.56" }, signal: AbortSignal.timeout(10000) });
          if (res.ok) {
            facts.readme = (await res.text()).slice(0, MAX_README_CHARS);
            break;
          }
        } catch {}
      }
    }
  }

  return facts;
}
