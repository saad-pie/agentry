// agentry/src/adapters/web.mjs
// v0.58.9 — wraps discovery.web_search (SearXNG) so `search` covers general web.
// Requires ctx.invoke — returns [] if invoked outside a full Runtime.
// SearXNG runs on the same box: http://127.0.0.1:8080

export const meta = {
  name: "web",
  kind: "web_result",
  description: "Web search via SearXNG (fan-out to Google/DDG/Brave/etc)",
};

export async function search({ query, limit = 10, ctx }) {
  if (!ctx || typeof ctx.invoke !== "function") return [];
  try {
    const res = await ctx.invoke("discovery.web_search", {
      query: String(query || ""),
      limit: Math.min(limit * 2, 20),
    }, { tenant: "local", by: "adapter.web" });
    if (!res.ok) return [];
    const raw = (res.output && res.output.candidates) || [];
    return raw.slice(0, limit).map(r => ({
      id: r.id,
      source: "web",
      kind: "web_result",
      name: r.name,
      url: r.url,
      description: r.description || null,
      domain: r.domain || null,
      exists_locally: false,
    }));
  } catch (e) { return []; }
}
