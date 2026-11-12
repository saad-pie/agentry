// agentry/src/adapters/maven.mjs
//
// v0.18.0 — search Maven Central (Java/JVM).
//
// Solr-style JSON API. Returns group:artifact coordinates, latest
// version, packaging type. No description field exists in the
// response — the reasoner will see name + coords.

import { httpJson } from "./_registry.mjs";
import { simplifyQuery } from "../util/text.mjs";

export const meta = {
  name: "maven",
  kind: "maven_artifact",
  languages: ["java", "kotlin", "scala"],
  description: "Maven Central Java/JVM artifact registry",
};

export async function search({ query, limit = 10 }) {
  // v0.58.7b — retry simplified. Maven Solr searches artifact names,
  // not natural-language queries. "convert json to yaml" returns 0, "yaml" returns 855.
  const _simple = simplifyQuery(query);
  const _queries = _simple && _simple !== String(query).toLowerCase().trim() ? [query, _simple] : [query];
  let docs = [];
  for (const _q of _queries) {
    const url = "https://search.maven.org/solrsearch/select?q="
      + encodeURIComponent(_q)
      + "&rows=" + Math.min(limit, 30)
      + "&wt=json";
    try {
      const data = await httpJson(url);
      docs = Array.isArray(data?.response?.docs) ? data.response.docs : [];
      if (docs.length > 0) break;
    } catch (e) { /* next */ }
  }

  return docs.slice(0, limit).map(d => {
    const coord = d.id || ((d.g || "") + ":" + (d.a || ""));
    return {
      id: "maven:" + coord,
      source: "maven",
      kind: "maven_artifact",
      name: coord,
      url: "https://search.maven.org/artifact/" + (d.g || "") + "/" + (d.a || ""),
      description: null,
      version: d.latestVersion || d.v || null,
      exists_locally: false,
      meta: {
        group: d.g || null,
        artifact: d.a || null,
        packaging: d.p || null,
        language: "java",
      },
    };
  });
}
