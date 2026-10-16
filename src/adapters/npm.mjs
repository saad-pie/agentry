// agentry/src/adapters/npm.mjs
//
// v0.18.0 — search the public npm registry.
//
// Uses the same endpoint the inline handler used. No scoring; the
// LLM ranks. Returns the raw top-N from npm's search API.

import { httpJson } from "./_registry.mjs";

export const meta = {
  name: "npm",
  kind: "npm_package",
  languages: ["javascript"],
  description: "Public npm package registry",
};

const NPM_REGISTRY = "https://registry.npmjs.org/-/v1/search";

export async function search({ query, limit = 10 }) {
  const url = NPM_REGISTRY
    + "?text=" + encodeURIComponent(query)
    + "&size=" + Math.min(limit * 2, 30);
  const data = await httpJson(url);
  const objects = Array.isArray(data && data.objects) ? data.objects : [];

  const items = [];
  for (const o of objects) {
    const p = (o && o.package) || {};
    if (!p.name) continue;
    items.push({
      id: "npm:" + p.name,
      source: "npm",
      kind: "npm_package",
      name: p.name,
      url: (p.links && p.links.npm) || ("https://www.npmjs.com/package/" + p.name),
      description: p.description || null,
      version: p.version || null,
      published_at: p.date || null,
      keywords: Array.isArray(p.keywords) ? p.keywords.slice(0, 8) : [],
      exists_locally: false,
      meta: {
        publisher: (p.publisher && p.publisher.username) || null,
      },
    });
    if (items.length >= limit) break;
  }
  return items;
}
