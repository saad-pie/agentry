// agentry/src/handlers/agentry.discover.mjs
//
// v0.17.1 — unified capability discovery.
//
// The reasoner used to guess whether a capability exists locally, or
// jump straight to synthesis. Neither is right: the ecosystem has
// thousands of pre-built tools (npm, MCP servers, GitHub repos) that
// already solve most problems. This handler searches all of them.
//
// Sources (each optional):
//   local   — agentry capability graph (semantic match on id + produces)
//   npm     — public npm registry search API
//   mcp     — ModelContextProtocol server registry
//   github  — delegates to discovery.github_search
//   web     — delegates to discovery.web_search
//
// Every source returns the same envelope shape: { candidates, error? }.
// The main handler merges, dedupes by id, ranks by fit, and returns a
// recommendation. Sources that fail do not take down the whole call.

const NPM_REGISTRY = "https://registry.npmjs.org/-/v1/search";
const MCP_REGISTRY_CANDIDATES = [
  "https://registry.modelcontextprotocol.io/v0/servers",
  "https://registry.modelcontextprotocol.io/v1/servers",
];

const DEFAULT_LIMIT = 20;
// mcp disabled pending the correct registry URL (as of 2026-10-16
// the public endpoint is not at any of the guessed hostnames). It can
// still be requested explicitly via input.sources = ["mcp", ...].
const DEFAULT_SOURCES = ["local", "npm", "github", "web"];

// Source credibility. Local wins because it is already tested and
// installed. MCP is agent-native and curated. npm is the largest
// package ecosystem. GitHub repos are variable. Web results are the
// noisiest.
const SOURCE_WEIGHTS = {
  local: 1.0,
  mcp: 0.9,
  npm: 0.8,
  github: 0.7,
  web: 0.5,
};

function tokenize(s) {
  return String(s || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 2);
}

function keywordOverlap(queryTokens, text) {
  if (!queryTokens.length) return 0;
  const textTokens = new Set(tokenize(text));
  if (!textTokens.size) return 0;
  let hits = 0;
  for (const t of queryTokens) if (textTokens.has(t)) hits++;
  return hits / queryTokens.length;
}

function recencyBoost(iso) {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  const days = (Date.now() - t) / (1000 * 60 * 60 * 24);
  if (days < 30) return 0.2;
  if (days < 180) return 0.1;
  if (days < 365) return 0.05;
  return 0;
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return Number(n.toFixed(3));
}

function starsBoost(stars) {
  if (!Number.isFinite(stars) || stars <= 0) return 0;
  if (stars > 10000) return 0.2;
  if (stars > 1000) return 0.1;
  if (stars > 100) return 0.05;
  return 0.02;
}

async function searchLocal(graph, queryTokens, limit) {
  const out = [];
  for (const c of graph.capabilities().values()) {
    if (c.retired_at) continue;
    if (!c.invoked_via) continue;
    if (c.kind === "edge") continue;
    const producesKeys = Object.keys(c.produces || {}).join(" ");
    const acceptsKeys = Object.keys(c.accepts || {}).join(" ");
    const text = [c.id, c.kind, producesKeys, acceptsKeys, c.notes || ""].join(" ");
    const overlap = keywordOverlap(queryTokens, text);
    if (overlap === 0) continue;
    const fit = SOURCE_WEIGHTS.local * overlap;
    out.push({
      id: c.id,
      source: "local",
      kind: c.kind,
      name: c.id,
      url: null,
      description: c.notes || null,
      produces: c.produces || null,
      accepts: c.accepts || null,
      fit: clamp01(fit),
      exists_locally: true,
    });
  }
  out.sort((a, b) => b.fit - a.fit);
  return out.slice(0, limit);
}

async function searchNpm(query, queryTokens, limit) {
  const url = NPM_REGISTRY + "?text=" + encodeURIComponent(query) + "&size=" + Math.min(limit * 2, 50);
  let res;
  try {
    res = await fetch(url, {
      headers: { "user-agent": "agentry/0.1.0" },
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    return { candidates: [], error: "npm fetch failed: " + e.message };
  }
  if (!res.ok) return { candidates: [], error: "npm HTTP " + res.status };
  const data = await res.json().catch(() => null);
  const objects = Array.isArray(data?.objects) ? data.objects : [];
  const out = [];
  for (const o of objects) {
    const p = o?.package || {};
    if (!p.name) continue;
    const text = [p.name, p.description || "", (p.keywords || []).join(" ")].join(" ");
    const overlap = keywordOverlap(queryTokens, text);
    if (overlap === 0) continue;
    const fit = SOURCE_WEIGHTS.npm * overlap + recencyBoost(p.date);
    out.push({
      id: "npm:" + p.name,
      source: "npm",
      kind: "npm_package",
      name: p.name,
      url: (p.links && p.links.npm) || ("https://www.npmjs.com/package/" + p.name),
      description: p.description || null,
      version: p.version || null,
      published_at: p.date || null,
      fit: clamp01(fit),
      exists_locally: false,
    });
  }
  out.sort((a, b) => b.fit - a.fit);
  return { candidates: out.slice(0, limit) };
}

async function searchMcp(query, queryTokens, limit) {
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
      const out = [];
      for (const s of list) {
        const name = s.name || s.id || (s.server && s.server.name);
        const desc = s.description || (s.server && s.server.description) || "";
        if (!name) continue;
        const text = [name, desc].join(" ");
        const overlap = keywordOverlap(queryTokens, text);
        if (overlap === 0) continue;
        const fit = SOURCE_WEIGHTS.mcp * overlap;
        out.push({
          id: "mcp:" + name,
          source: "mcp",
          kind: "mcp_server",
          name,
          url: s.url || s.homepage || s.repository || null,
          description: desc || null,
          version: s.version || (s.server && s.server.version) || null,
          fit: clamp01(fit),
          exists_locally: false,
        });
      }
      out.sort((a, b) => b.fit - a.fit);
      return { candidates: out.slice(0, limit) };
    } catch (e) {
      lastErr = e.message;
      continue;
    }
  }
  return { candidates: [], error: "mcp registry unreachable (" + (lastErr || "no response") + ")" };
}

async function searchGithub(ctx, query, queryTokens, limit) {
  try {
    const res = await ctx.invoke("discovery.github_search", {
      query: { q: query, sort: "stars", order: "desc" },
      limit: Math.min(limit * 2, 30),
    }, { tenant: "local", by: "agentry.discover" });
    if (!res.ok) return { candidates: [], error: "github: " + res.error.code };
    const raw = (res.output && res.output.candidates) || [];
    const out = [];
    for (const r of raw) {
      const text = [r.name || "", r.description || "", (r.topics || []).join(" ")].join(" ");
      const overlap = keywordOverlap(queryTokens, text);
      if (overlap === 0) continue;
      const boost = (recencyBoost(r.pushed_at) + starsBoost(r.stars)) * 0.3;
      const fit = SOURCE_WEIGHTS.github * overlap + boost;
      out.push({
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
        fit: Number(Math.min(fit, 1).toFixed(3)),
        exists_locally: false,
      });
    }
    out.sort((a, b) => b.fit - a.fit);
    return { candidates: out.slice(0, limit) };
  } catch (e) {
    return { candidates: [], error: "github threw: " + e.message };
  }
}

async function searchWeb(ctx, query, queryTokens, limit) {
  try {
    const res = await ctx.invoke("discovery.web_search", {
      query,
      limit: Math.min(limit * 2, 20),
    }, { tenant: "local", by: "agentry.discover" });
    if (!res.ok) return { candidates: [], error: "web: " + res.error.code };
    const raw = (res.output && res.output.candidates) || [];
    const out = [];
    for (const r of raw) {
      const text = [r.name || "", r.description || "", r.domain || ""].join(" ");
      const overlap = keywordOverlap(queryTokens, text);
      if (overlap === 0) continue;
      const fit = SOURCE_WEIGHTS.web * overlap;
      out.push({
        id: r.id,
        source: "web",
        kind: "web_result",
        name: r.name,
        url: r.url,
        description: r.description || null,
        domain: r.domain || null,
        fit: Number(fit.toFixed(3)),
        exists_locally: false,
      });
    }
    out.sort((a, b) => b.fit - a.fit);
    return { candidates: out.slice(0, limit) };
  } catch (e) {
    return { candidates: [], error: "web threw: " + e.message };
  }
}

export default async function agentryDiscover(input, ctx) {
  const started = Date.now();
  const { graph, events } = ctx;

  const query = String((input && input.query) || "").trim();
  if (!query) throw new Error("agentry.discover requires query (string)");

  const limit = Math.max(1, Math.min(Number(input && input.limit) || DEFAULT_LIMIT, 50));
  const sources = Array.isArray(input && input.sources) && input.sources.length
    ? input.sources
    : DEFAULT_SOURCES;

  const queryTokens = tokenize(query);

  events.emit("discover.started", { query, sources, limit });

  const results = [];
  const errors = {};

  if (sources.includes("local")) {
    try {
      const local = await searchLocal(graph, queryTokens, limit);
      results.push.apply(results, local);
    } catch (e) {
      errors.local = e.message;
    }
  }

  const parallel = [];
  const parallelNames = [];
  if (sources.includes("npm"))    { parallel.push(searchNpm(query, queryTokens, limit)); parallelNames.push("npm"); }
  if (sources.includes("mcp"))    { parallel.push(searchMcp(query, queryTokens, limit)); parallelNames.push("mcp"); }
  if (sources.includes("github")) { parallel.push(searchGithub(ctx, query, queryTokens, limit)); parallelNames.push("github"); }
  if (sources.includes("web"))    { parallel.push(searchWeb(ctx, query, queryTokens, limit)); parallelNames.push("web"); }

  const settled = await Promise.allSettled(parallel);
  settled.forEach((r, i) => {
    const src = parallelNames[i];
    if (r.status === "fulfilled") {
      results.push.apply(results, r.value.candidates || []);
      if (r.value.error) errors[src] = r.value.error;
    } else {
      errors[src] = (r.reason && r.reason.message) || "unknown";
    }
  });

  const seen = new Set();
  const deduped = [];
  const sorted = results.slice().sort((a, b) => b.fit - a.fit);
  for (const c of sorted) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    deduped.push(c);
    if (deduped.length >= limit) break;
  }

  const topFit = deduped.length ? deduped[0].fit : null;
  const recommendation = deduped.length
    ? (topFit >= 0.6
        ? "Adopt " + deduped[0].id + " (source: " + deduped[0].source + ", fit: " + topFit + ")."
        : "Nothing scores above 0.6. Consider synthesizing from scratch.")
    : "No candidates found. Synthesize from scratch.";

  events.emit("discover.completed", {
    query,
    sources,
    candidates_total: deduped.length,
    top_id: deduped.length ? deduped[0].id : null,
    top_source: deduped.length ? deduped[0].source : null,
    top_fit: topFit,
    errors,
  });

  return {
    output: {
      query,
      candidates: deduped,
      searched: sources,
      errors: Object.keys(errors).length ? errors : null,
      recommendation,
      elapsed_ms: Date.now() - started,
    },
    cost: { time_ms: Date.now() - started, http_calls: parallel.length },
  };
}
