// agentry/src/adapters/crates.mjs
//
// v0.18.0 — search crates.io (Rust).
//
// Clean JSON API. Returns name, description, max_version, downloads,
// repository URL. Requires a specific User-Agent — crates.io blocks
// generic ones with a 403.

import { httpJson } from "./_registry.mjs";

export const meta = {
  name: "crates",
  kind: "crate",
  languages: ["rust"],
  description: "crates.io public Rust registry",
};

export async function search({ query, limit = 10 }) {
  const url = "https://crates.io/api/v1/crates?q="
    + encodeURIComponent(query)
    + "&per_page=" + Math.min(limit, 30);
  const data = await httpJson(url, { userAgent: "agentry/0.1.0 (rust adapter)" });
  const crates = Array.isArray(data && data.crates) ? data.crates : [];

  return crates.slice(0, limit).map(c => ({
    id: "crates:" + c.name,
    source: "crates",
    kind: "crate",
    name: c.name,
    url: "https://crates.io/crates/" + c.name,
    description: c.description || null,
    version: c.max_version || null,
    exists_locally: false,
    meta: {
      downloads: c.downloads || 0,
      repository: c.repository || null,
      language: "rust",
    },
  }));
}
