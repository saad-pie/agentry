// agentry/src/adapters/dsh_plugins.mjs
// v0.53.7 — search DSH plugin catalog (jsdelivr CDN) instead of npm grep.
import { httpJson } from "./_registry.mjs";

export const meta = { name: "dsh_plugins", kind: "dsh_plugin", description: "DeepSeek Harness community plugin catalog (jsdelivr CDN)" };

const URL = "https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json";
const TTL = 3600000;
let _c = null, _at = 0;

async function load() {
  if (_c && Date.now() - _at < TTL) return _c;
  try {
    const d = await httpJson(URL, { timeoutMs: 15000 });
    _c = Array.isArray(d?.plugins) ? d.plugins : [];
    _at = Date.now();
  } catch { if (!_c) _c = []; }
  return _c;
}

function tokens(s) {
  return String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2);
}

function item(p) {
  if (!p.name) return null;
  const v = Array.isArray(p.versions) ? p.versions[p.versions.length - 1] : null;
  return {
    id: "dsh_plugin:" + p.name, source: "dsh_plugins", kind: "dsh_plugin",
    name: p.title || p.name, url: p.repository?.url || null,
    description: p.description?.en || p.description?.zh || null,
    version: v?.version || null, exists_locally: false,
    meta: { install_target: p.name, category: p.metadata?.category || null, keywords: p.metadata?.keywords || [], language: "javascript" },
  };
}

export async function search({ query, limit = 10 }) {
  const cat = await load();
  if (!cat.length) return [];
  const qt = tokens(query);
  if (!qt.length) return cat.slice(0, limit).map(item).filter(Boolean);
  const scored = [];
  for (const p of cat) {
    const h = [p.name, p.title, p.description?.en, p.description?.zh, p.metadata?.category, ...(p.metadata?.keywords || [])].filter(Boolean).join(" ").toLowerCase();
    let n = 0;
    for (const t of qt) if (h.includes(t)) n++;
    if (n > 0) scored.push({ p, n });
  }
  scored.sort((a, b) => b.n - a.n);
  return scored.slice(0, limit).map(x => item(x.p)).filter(Boolean);
}
