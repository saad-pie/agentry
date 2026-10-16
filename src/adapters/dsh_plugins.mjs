// agentry/src/adapters/dsh_plugins.mjs
//
// v0.18.4 — search DeepSeek Harness plugins on npm.
//
// DSH plugins are published to npm under the @deepseek-ai scope.
// This adapter wraps the npm search with a scope prefix, then
// re-tags the results as `dsh_plugin`.

import { search as npmSearch } from "./npm.mjs";

export const meta = {
  name: "dsh_plugins",
  kind: "dsh_plugin",
  description: "DeepSeek Harness plugins (@deepseek-ai on npm)",
};

export async function search({ query, limit = 10 }) {
  const scoped = "@deepseek-ai " + String(query || "").trim();
  const npmItems = await npmSearch({ query: scoped, limit: Math.min(limit * 2, 30) });

  const items = [];
  for (const n of npmItems) {
    if (!n.name || !n.name.startsWith("@deepseek-ai/")) continue;
    items.push({
      id: "dsh_plugin:" + n.name.slice("@deepseek-ai/".length),
      source: "dsh_plugins",
      kind: "dsh_plugin",
      name: n.name,
      url: n.url,
      description: n.description,
      version: n.version,
      published_at: n.published_at,
      exists_locally: false,
      meta: { ...(n.meta || {}), language: "javascript" },
    });
    if (items.length >= limit) break;
  }
  return items;
}
