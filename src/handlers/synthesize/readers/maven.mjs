// agentry/src/handlers/synthesize/readers/maven.mjs
// v0.56.37 — reads a Maven Central artifact's metadata + README from GitHub if available.

import { MAX_README_CHARS } from "../config.mjs";

export async function readMaven(candidate, deps) {
  const coord = String(candidate.name || candidate.id || "").replace(/^maven:/, "").trim();
  const parts = coord.split(/[:/]/);
  const groupId = parts[0] || "";
  const artifactId = parts[1] || "";

  const facts = {
    session: null,
    source_kind: "maven",
    group_id: groupId,
    artifact_id: artifactId,
    maven_coord: groupId && artifactId ? (groupId + ":" + artifactId) : coord,
    version: null,
    description: null,
    repository: null,
    readme: null,
    error: null,
  };

  if (!groupId || !artifactId) {
    facts.error = "maven candidate missing group/artifact coords";
    return facts;
  }

  // 1. Latest version from Maven Central Solr
  try {
    const url = "https://search.maven.org/solrsearch/select?q=g:" + encodeURIComponent(groupId) + "+AND+a:" + encodeURIComponent(artifactId) + "&rows=1&wt=json";
    const res = await fetch(url, { headers: { "user-agent": "agentry/0.56" }, signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const d = await res.json();
      const doc = d && d.response && Array.isArray(d.response.docs) ? d.response.docs[0] : null;
      if (doc) facts.version = doc.latestVersion || doc.v || null;
    }
  } catch (e) { facts.error = "solr: " + e.message; }
  if (!facts.version) {
    if (!facts.error) facts.error = "maven solr returned no version";
    return facts;
  }

  // 2. POM for description + repository URL
  try {
    const groupPath = groupId.replace(/\./g, "/");
    const pomUrl = "https://repo1.maven.org/maven2/" + groupPath + "/" + artifactId + "/" + facts.version + "/" + artifactId + "-" + facts.version + ".pom";
    const res = await fetch(pomUrl, { headers: { "user-agent": "agentry/0.56" }, signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const pom = await res.text();
      const getTag = (tag) => {
        const m = pom.match(new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">"));
        return m ? m[1].trim().replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">") : null;
      };
      facts.description = getTag("description");
      facts.repository = getTag("url");
      const scmMatch = pom.match(/<scm>[\s\S]*?<url>([\s\S]*?)<\/url>[\s\S]*?<\/scm>/);
      if (scmMatch) {
        const scmUrl = scmMatch[1].trim();
        if (/github\.com/.test(scmUrl)) facts.repository = scmUrl;
      }
    }
  } catch (e) { facts.error = "pom: " + e.message; }

  // 3. If repository is GitHub, fetch README
  if (facts.repository) {
    const ghMatch = facts.repository.match(/github\.com[\/:]([^\/]+)\/([^\/\.\s]+)/);
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
