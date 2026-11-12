// agentry/src/adapters/pypi.mjs
//
// v0.18.2 — search PyPI via SearXNG.
//
// PyPI's HTML search was JS-rendered as of late 2026. The old scrape
// returned a 3 KB shell with no /project/ links. Rewritten to route
// through the local SearXNG instance with a `site:pypi.org` filter,
// then parse pypi.org/project/<name> URLs out of the web results.
// Same shape, different mechanism.

export const meta = {
  name: "pypi",
  kind: "python_package",
  languages: ["python"],
  description: "Public Python Package Index (via web search)",
};

export async function search({ query, limit = 10, ctx }) {
  if (!ctx || typeof ctx.invoke !== "function") return [];

  const res = await ctx.invoke("discovery.web_search", {
    query: "site:pypi.org " + query,
    limit: Math.min(limit * 3, 30),
  }, { tenant: "local", by: "adapter.pypi" });

  if (!res.ok) return [];
  const raw = (res.output && res.output.candidates) || [];

  const items = [];
  const seen = new Set();

  for (const r of raw) {
    const url = String(r.url || "");
    const m = url.match(/^https?:\/\/pypi\.org\/project\/([^\/?#]+)/i);
    if (!m) continue;
    const name = decodeURIComponent(m[1]);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    items.push({
      id: "pypi:" + name,
      source: "pypi",
      kind: "python_package",
      name,
      url: "https://pypi.org/project/" + name + "/",
      description: r.description || null,
      exists_locally: false,
      meta: { language: "python", via: "searxng" },
    });
    if (items.length >= limit) break;
  }

  return items;
}
