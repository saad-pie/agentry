// agentry/src/adapters/hermes_atlas.mjs
//
// v0.18.4 — search the Hermes Atlas ecosystem catalog.
//
// A curated JSON list of 240+ repos in the Nous Research / Hermes
// ecosystem, maintained at ksimback/hermes-ecosystem. The list is
// static — we fetch it once per process, cache it, then filter
// client-side on query tokens.

import { httpJson } from "./_registry.mjs";

export const meta = {
  name: "hermes_atlas",
  kind: "hermes_repo",
  description: "Curated Hermes / Nous Research ecosystem catalog",
};

const SOURCE_URL =
  "https://raw.githubusercontent.com/ksimback/hermes-ecosystem/main/data/repos.json";

let _cache = null;      // [{...}]
let _cacheAt = 0;
const CACHE_TTL_MS = 60 * 60 * 1000;   // refresh hourly

async function loadCatalog() {
  const now = Date.now();
  if (_cache && (now - _cacheAt) < CACHE_TTL_MS) return _cache;
  try {
    const data = await httpJson(SOURCE_URL, { timeoutMs: 15000 });
    _cache = Array.isArray(data) ? data : [];
    _cacheAt = now;
  } catch (e) {
    if (!_cache) _cache = [];
  }
  return _cache;
}

function tokens(s) {
  return String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2);
}

export async function search({ query, limit = 10 }) {
  const list = await loadCatalog();
  if (!list.length) return [];

  const qTokens = tokens(query);
  if (qTokens.length === 0) {
    return list.slice(0, limit).map(toItem);
  }

  // Score by token overlap against name + description + category.
  // Return top `limit` matches. Falls back to full list if no hits.
  const scored = [];
  for (const r of list) {
    const hay = [r.name, r.repo, r.description, r.category].filter(Boolean).join(" ").toLowerCase();
    let hits = 0;
    for (const t of qTokens) if (hay.includes(t)) hits++;
    if (hits > 0) scored.push({ r, score: hits });
  }
  scored.sort((a, b) => b.score - a.score || (b.r.stars || 0) - (a.r.stars || 0));

  if (scored.length === 0) return [];
  return scored.slice(0, limit).map(x => toItem(x.r));
}

function toItem(r) {
  const fullName = (r.owner || "") + "/" + (r.repo || r.name || "");
  return {
    id: "hermes_atlas:" + fullName,
    source: "hermes_atlas",
    kind: "hermes_repo",
    name: r.name || fullName,
    url: r.url || ("https://github.com/" + fullName),
    description: r.description || null,
    exists_locally: false,
    meta: {
      owner: r.owner || null,
      repo: r.repo || null,
      stars: r.stars || 0,
      official: r.official === true,
      category: r.category || null,
    },
  };
}
