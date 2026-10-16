// agentry/src/handlers/agentry.discover.mjs
//
// v0.17.3 — discover returns raw results, grouped by source. No
// scoring, no ranking, no recommendation. The LLM reads the results
// and decides what to name. Scoring was a heuristic that fought the
// reasoner; the reasoner is the ranking system.
//
// Sources (each optional):
//   local   — every live capability in the graph
//   npm     — public npm registry search
//   github  — delegates to discovery.github_search
//   web     — delegates to discovery.web_search
//   mcp     — ModelContextProtocol registry (disabled by default;
//             the public endpoint URL is not currently known)
//
// Every source returns { items: [...], error?: string }. The main
// handler merges into results keyed by source. No filtering, no
// deduping, no fit.

const NPM_REGISTRY = "https://registry.npmjs.org/-/v1/search";
const MCP_REGISTRY_CANDIDATES = [
  "https://registry.modelcontextprotocol.io/v0/servers",
  "https://registry.modelcontextprotocol.io/v1/servers",
];

const DEFAULT_LIMIT = 10;
const DEFAULT_SOURCES = ["local", "npm", "github", "web"];

function searchLocal(graph, limit) {
  const items = [];
  for (const c of graph.capabilities().values()) {
    if (c.retired_at) continue;
    if (!c.invoked_via) continue;
    if (c.kind === "edge") continue;
    items.push({
      id: c.id,
      source: "local",
      kind: c.kind,
      name: c.id,
      url: null,
      description: c.notes || null,
      accepts: c.accepts || null,
      produces: c.produces || null,
      exists_locally: true,
    });
    if (items.length >= limit) break;
  }
  return { items };
}

async function searchNpm(query, limit) {
  const url = NPM_REGISTRY + "?text=" + encodeURIComponent(query) + "&size=" + Math.min(limit * 2, 30);
  let res;
  try {
    res = await fetch(url, {
      headers: { "user-agent": "agentry/0.1.0" },
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    return { items: [], error: "npm fetch failed: " + e.message };
  }
  if (!res.ok) return { items: [], error: "npm HTTP " + res.status };
  const data = await res.json().catch(() => null);
  const objects = Array.isArray(data?.objects) ? data.objects : [];
  const items = [];
  for (const o of objects) {
    const p = o?.package || {};
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
    });
    if (items.length >= limit) break;
  }
  return { items };
}

async function searchMcp(query, limit) {
  const q = encodeURIComponent(query);
  let lastErr = null;
  for (const base of MCP_REGISTRY_CANDIDATES) {
    try {
      const res = await fetch(base + "?search=" + q + "&limit=" + limit, {
        headers: { "accept": "application/json", "user-agent": "agentry/0.1.0" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) { lastErr = "HTTP " + res.status; continue; }
      const data = await res.json().catch(() => null);
      const list =
        (Array.isArray(data?.servers) && data.servers) ||
        (Array.isArray(data?.items) && data.items) ||
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
      return { items };
    } catch (e) {
      lastErr = e.message;
      continue;
    }
  }
  return { items: [], error: "mcp registry unreachable (" + (lastErr || "no response") + ")" };
}

async function searchGithub(ctx, query, limit) {
  try {
    const res = await ctx.invoke("discovery.github_search", {
      query: { q: query, sort: "stars", order: "desc" },
      limit: Math.min(limit * 2, 30),
    }, { tenant: "local", by: "agentry.discover" });
    if (!res.ok) return { items: [], error: "github: " + res.error.code };
    const raw = (res.output && res.output.candidates) || [];
    const items = raw.slice(0, limit).map(r => ({
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
    }));
    return { items };
  } catch (e) {
    return { items: [], error: "github threw: " + e.message };
  }
}

async function searchWeb(ctx, query, limit) {
  try {
    const res = await ctx.invoke("discovery.web_search", {
      query,
      limit: Math.min(limit * 2, 20),
    }, { tenant: "local", by: "agentry.discover" });
    if (!res.ok) return { items: [], error: "web: " + res.error.code };
    const raw = (res.output && res.output.candidates) || [];
    const items = raw.slice(0, limit).map(r => ({
      id: r.id,
      source: "web",
      kind: "web_result",
      name: r.name,
      url: r.url,
      description: r.description || null,
      domain: r.domain || null,
      exists_locally: false,
    }));
    return { items };
  } catch (e) {
    return { items: [], error: "web threw: " + e.message };
  }
}

export default async function agentryDiscover(input, ctx) {
  const started = Date.now();
  const { graph, events } = ctx;

  const query = String((input && input.query) || "").trim();
  if (!query) throw new Error("agentry.discover requires query (string)");

  const limit = Math.max(1, Math.min(Number(input && input.limit) || DEFAULT_LIMIT, 30));
  const sources = Array.isArray(input && input.sources) && input.sources.length
    ? input.sources
    : DEFAULT_SOURCES;

  events.emit("discover.started", { query, sources, limit });

  const results = {};
  const errors = {};

  if (sources.includes("local")) {
    try {
      const r = searchLocal(graph, limit);
      results.local = r.items;
      if (r.error) errors.local = r.error;
    } catch (e) {
      errors.local = e.message;
      results.local = [];
    }
  }

  const parallel = [];
  const names = [];
  if (sources.includes("npm"))    { parallel.push(searchNpm(query, limit));                 names.push("npm"); }
  if (sources.includes("mcp"))    { parallel.push(searchMcp(query, limit));                 names.push("mcp"); }
  if (sources.includes("github")) { parallel.push(searchGithub(ctx, query, limit));         names.push("github"); }
  if (sources.includes("web"))    { parallel.push(searchWeb(ctx, query, limit));            names.push("web"); }

  const settled = await Promise.allSettled(parallel);
  settled.forEach((r, i) => {
    const src = names[i];
    if (r.status === "fulfilled") {
      results[src] = r.value.items || [];
      if (r.value.error) errors[src] = r.value.error;
    } else {
      results[src] = [];
      errors[src] = (r.reason && r.reason.message) || "unknown";
    }
  });

  const counts = {};
  for (const [k, v] of Object.entries(results)) counts[k] = v.length;

  events.emit("discover.completed", {
    query,
    sources,
    counts,
    errors,
  });

  return {
    output: {
      query,
      results,
      counts,
      searched: sources,
      errors: Object.keys(errors).length ? errors : null,
      elapsed_ms: Date.now() - started,
    },
    cost: { time_ms: Date.now() - started, http_calls: parallel.length },
  };
}
