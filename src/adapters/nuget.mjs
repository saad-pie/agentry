// agentry/src/adapters/nuget.mjs
//
// v0.18.0 — search NuGet (.NET).
//
// Clean JSON API. Returns name, description, version, authors,
// downloads.

import { httpJson } from "./_registry.mjs";

export const meta = {
  name: "nuget",
  kind: "nuget_package",
  languages: ["csharp", "fsharp", "dotnet"],
  description: "NuGet .NET package registry",
};

export async function search({ query, limit = 10 }) {
  const url = "https://azuresearch-usnc.nuget.org/query?q="
    + encodeURIComponent(query)
    + "&take=" + Math.min(limit, 30);
  const data = await httpJson(url);
  const list = Array.isArray(data && data.data) ? data.data : [];

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
