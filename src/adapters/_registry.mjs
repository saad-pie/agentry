// agentry/src/adapters/_registry.mjs
//
// v0.18.0 — adapter registry for agentry.discover.
//
// Every searchable source becomes a file in this directory with two
// exports:
//   meta   — { name, kind, languages?, description }
//   search — async ({ query, limit, ctx }) => [items]
//
// The registry loads every `*.mjs` file that does not start with an
// underscore, reads its meta, and exposes it for the discover
// handler. One bad adapter does not take down the whole search:
// load failures and search failures are recorded and skipped.

import { readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── HTTP helpers so adapters don't repeat boilerplate ───

const DEFAULT_UA = "agentry/0.1.0";
const DEFAULT_TIMEOUT_MS = 10000;

export async function httpJson(url, opts = {}) {
  const res = await fetch(url, {
    headers: {
      "accept": "application/json",
      "user-agent": opts.userAgent || DEFAULT_UA,
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(opts.timeoutMs || DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error("HTTP " + res.status + " from " + url);
    err.status = res.status;
    throw err;
  }
  return await res.json();
}

export async function httpText(url, opts = {}) {
  const res = await fetch(url, {
    headers: {
      "accept": opts.accept || "text/html,application/xhtml+xml",
      "user-agent": opts.userAgent || DEFAULT_UA,
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(opts.timeoutMs || DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error("HTTP " + res.status + " from " + url);
    err.status = res.status;
    throw err;
  }
  return await res.text();
}

// ─── Adapter registry ───

const ADAPTERS = new Map();  // name -> { meta, search, file }

let _loaded = false;
let _loadErrors = [];

export async function loadAdapters() {
  if (_loaded) return { loaded: [...ADAPTERS.keys()], errors: _loadErrors };
  _loaded = true;
  _loadErrors = [];

  let files = [];
  try {
    files = readdirSync(__dirname)
      .filter(f => f.endsWith(".mjs") && !f.startsWith("_"))
      .sort();
  } catch (e) {
    _loadErrors.push({ file: "(readdir)", error: e.message });
    return { loaded: [], errors: _loadErrors };
  }

  for (const file of files) {
    const name = basename(file, ".mjs");
    try {
      const mod = await import(pathToFileURL(join(__dirname, file)).href);
      if (!mod.meta || typeof mod.meta.name !== "string" || !mod.meta.name) {
        _loadErrors.push({ file, error: "missing or invalid meta.name" });
        continue;
      }
      if (typeof mod.search !== "function") {
        _loadErrors.push({ file, error: "missing search() export" });
        continue;
      }
      ADAPTERS.set(mod.meta.name, { meta: mod.meta, search: mod.search, file });
    } catch (e) {
      _loadErrors.push({ file, error: e.message });
    }
  }

  return { loaded: [...ADAPTERS.keys()], errors: _loadErrors };
}

export function listAdapters() {
  return [...ADAPTERS.values()].map(a => ({
    name: a.meta.name,
    kind: a.meta.kind,
    description: a.meta.description,
    languages: a.meta.languages || null,
  }));
}

export function hasAdapter(name) {
  return ADAPTERS.has(name);
}

// ─── Run selected adapters in parallel ───
//
// sources: array of adapter names, or null/undefined for all.
// Returns { results: { name: [items] }, errors: { name: msg }, counts: { name: n } }
//
// An adapter that throws is recorded in errors and returns [].
// The whole call never fails.

export async function runAdapters({ query, limit = 10, sources = null, ctx = {} }) {
  await loadAdapters();

  const selected = sources && sources.length
    ? [...ADAPTERS.values()].filter(a => sources.includes(a.meta.name))
    : [...ADAPTERS.values()];

  if (selected.length === 0) {
    return { results: {}, errors: {}, counts: {}, sources: [] };
  }

  const names = selected.map(a => a.meta.name);
  const settled = await Promise.allSettled(
    selected.map(a => a.search({ query, limit, ctx }))
  );

  const results = {};
  const errors = {};

  settled.forEach((r, i) => {
    const name = names[i];
    if (r.status === "fulfilled" && Array.isArray(r.value)) {
      results[name] = r.value;
    } else if (r.status === "fulfilled") {
      results[name] = [];
      errors[name] = "adapter returned non-array";
    } else {
      results[name] = [];
      errors[name] = (r.reason && r.reason.message) || "unknown";
    }
  });

  const counts = {};
  for (const [k, v] of Object.entries(results)) counts[k] = v.length;

  return { results, errors, counts, sources: names };
}
