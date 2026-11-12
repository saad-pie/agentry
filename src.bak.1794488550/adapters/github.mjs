// agentry/src/adapters/github.mjs
// v0.58.9 — wraps discovery.github_search capability so `search` covers GitHub.
// Rate limit: 5000/hr with GH_TOKEN (Space sets it), 60/hr unauth.
// Requires ctx.invoke — returns [] if invoked outside a full Runtime.

export const meta = {
  name: "github",
  kind: "repo",
  description: "GitHub repository search",
};

export async function search({ query, limit = 10, ctx }) {
  if (!ctx || typeof ctx.invoke !== "function") return [];
  try {
    const res = await ctx.invoke("discovery.github_search", {
      query: { q: String(query || ""), sort: "stars", order: "desc" },
      limit: Math.min(limit * 2, 30),
    }, { tenant: "local", by: "adapter.github" });
    if (!res.ok) return [];
    const raw = (res.output && res.output.candidates) || [];
    return raw.slice(0, limit).map(r => ({
      id: r.id,
      source: "github",
      kind: "repo",
      name: r.name,
      url: r.url,
      description: r.description || null,
      stars: r.stars == null ? null : r.stars,
      language: r.language || null,
      license: r.license || null,
      pushed_at: r.pushed_at || null,
      exists_locally: false,
      meta: { stars: r.stars, language: r.language, license: r.license, pushed_at: r.pushed_at },
    }));
  } catch (e) { return []; }
}
