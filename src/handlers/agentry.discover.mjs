// agentry/src/handlers/agentry.discover.mjs
//
// v0.17.3 — discover returns raw results, grouped by source. No
// scoring, no ranking, no recommendation. The LLM reads the results
// and decides what to name.
//
// v0.18.0 — local and npm sources migrated to the adapter registry
// (src/adapters/). New sources drop into that directory as files
// and are picked up automatically. github / web / mcp stay inline
// for now and will migrate in later rounds.

import { runAdapters } from "../adapters/_registry.mjs";

const MCP_REGISTRY_CANDIDATES = [
  "https://registry.modelcontextprotocol.io/v0/servers",
  "https://registry.modelcontextprotocol.io/v1/servers",
];

const DEFAULT_LIMIT = 10;
const DEFAULT_SOURCES = ["local", "npm", "pypi", "crates", "maven", "nuget", "gomod", "huggingface", "clawhub", "hermes_atlas", "agentskills_code", "dsh_plugins", "github", "web"];

// ─── Inline adapters not yet migrated to the registry ───
// These will move to src/adapters/ in subsequent rounds.

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

// ─── Main handler ───

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

  // ── Adapter-backed sources (registry) ──
  const REGISTRY_SOURCES = ["local", "npm", "pypi", "crates", "maven", "nuget", "gomod", "huggingface", "clawhub", "hermes_atlas", "agentskills_code", "dsh_plugins"];
  const adapterSources = sources.filter(s => REGISTRY_SOURCES.includes(s));
  const adapterRun = adapterSources.length
    ? await runAdapters({ query, limit, sources: adapterSources, ctx })
    : { results: {}, errors: {}, counts: {}, sources: [] };

  const results = { ...adapterRun.results };
  const errors = { ...adapterRun.errors };

  // ── Inline sources (still in this file) ──
  const inlineNames = [];
  const inlinePromises = [];

  if (sources.includes("mcp")) {
    inlineNames.push("mcp");
    inlinePromises.push(searchMcp(query, limit));
  }
  if (sources.includes("github")) {
    inlineNames.push("github");
    inlinePromises.push(searchGithub(ctx, query, limit));
  }
  if (sources.includes("web")) {
    inlineNames.push("web");
    inlinePromises.push(searchWeb(ctx, query, limit));
  }

  const settled = await Promise.allSettled(inlinePromises);
  settled.forEach((r, i) => {
    const name = inlineNames[i];
    if (r.status === "fulfilled") {
      results[name] = r.value.items || [];
      if (r.value.error) errors[name] = r.value.error;
    } else {
      results[name] = [];
      errors[name] = (r.reason && r.reason.message) || "unknown";
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
    cost: { time_ms: Date.now() - started, http_calls: 0 },
  };
}
