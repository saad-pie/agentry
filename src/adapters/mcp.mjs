// agentry/src/adapters/mcp.mjs
// v0.58.9 — search the MCP server registry.
// Public JSON API on registry.modelcontextprotocol.io (v0 + v1 fallback).
// Retries with simplified query on empty result — registry matches names,
// not natural language.

const MCP_REGISTRY_CANDIDATES = [
  "https://registry.modelcontextprotocol.io/v0/servers",
  "https://registry.modelcontextprotocol.io/v1/servers",
];

import { simplifyQuery } from "../util/text.mjs";

async function searchOnce(query, limit) {
  const q = encodeURIComponent(query);
  for (const base of MCP_REGISTRY_CANDIDATES) {
    try {
      const res = await fetch(base + "?search=" + q + "&limit=" + limit, {
        headers: { accept: "application/json", "user-agent": "agentry/0.58.9" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const data = await res.json().catch(() => null);
      const list =
        (Array.isArray(data && data.servers) && data.servers) ||
        (Array.isArray(data && data.items) && data.items) ||
        (Array.isArray(data) && data) ||
        [];
      const items = [];
      for (const s of list) {
        const name = s.name || s.id || (s.server && s.server.name);
        if (!name) continue;
        items.push({
          id: "mcp:" + name,
          source: "mcp",
          kind: "mcp_server",
          name,
          url: s.url || s.homepage || s.repository || null,
          description: s.description || (s.server && s.server.description) || null,
          version: s.version || (s.server && s.server.version) || null,
          exists_locally: false,
        });
        if (items.length >= limit) break;
      }
      return items;
    } catch (e) { continue; }
  }
  return [];
}

export const meta = {
  name: "mcp",
  kind: "mcp_server",
  description: "MCP server registry (registry.modelcontextprotocol.io)",
};

export async function search({ query, limit = 10 }) {
  const simple = simplifyQuery(query);
  const tries = simple && simple !== String(query).toLowerCase().trim()
    ? [query, simple]
    : [query];
  for (const q of tries) {
    const items = await searchOnce(q, limit);
    if (items.length > 0) return items;
  }
  return [];
}
