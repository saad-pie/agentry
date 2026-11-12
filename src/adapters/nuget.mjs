// agentry/src/adapters/nuget.mjs
//
// v0.18.0 — search NuGet (.NET).
//
// Clean JSON API. Returns name, description, version, authors,
// downloads.

import { httpJson } from "./_registry.mjs";
import { simplifyQuery } from "../util/text.mjs";

export const meta = {
  name: "nuget",
  kind: "nuget_package",
  languages: ["csharp", "fsharp", "dotnet"],
  description: "NuGet .NET package registry",
};

export async function search({ query, limit = 10 }) {
  // v0.58.7b — retry simplified (same reason as maven)
  const _simple = simplifyQuery(query);
  const _queries = _simple && _simple !== String(query).toLowerCase().trim() ? [query, _simple] : [query];
  let list = [];
  for (const _q of _queries) {
    const url = "https://azuresearch-usnc.nuget.org/query?q="
      + encodeURIComponent(_q)
      + "&take=" + Math.min(limit, 30);
    try {
      const data = await httpJson(url);
      list = Array.isArray(data && data.data) ? data.data : [];
      if (list.length > 0) break;
    } catch (e) { /* next */ }
  }

  return list.slice(0, limit).map(p => ({
    id: "nuget:" + p.id,
    source: "nuget",
    kind: "nuget_package",
    name: p.id,
    url: "https://www.nuget.org/packages/" + p.id,
    description: p.description || null,
    version: p.version || null,
    exists_locally: false,
    meta: {
      authors: Array.isArray(p.authors) ? p.authors : null,
      downloads: p.totalDownloads || 0,
      projectUrl: p.projectUrl || null,
      language: "csharp",
    },
  }));
}
