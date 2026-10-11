// agentry/src/handlers/discovery.web_search.mjs
//
// Search the open web via a self-hosted SearXNG instance.
// SearXNG fans out to Google, DuckDuckGo, Brave, Wikipedia, GitHub,
// StackOverflow, arxiv and returns aggregated JSON. No API key, no quota.
//
// Config:
//   SEARXNG_URL (env)  — default http://127.0.0.1:8080

const DEFAULT_SEARXNG_URL = "http://127.0.0.1:8080";
const DEFAULT_TIMEOUT_MS = 25000;
const MAX_RESULTS = 20;

function searxngBase(ctx) {
  const fromConfig = ctx?.config?.searxng?.url;
  const fromEnv = process.env.SEARXNG_URL;
  const raw = fromConfig || fromEnv || DEFAULT_SEARXNG_URL;
  return String(raw).replace(/\/+$/, "");
}

export default async function discoveryWebSearch(input, ctx) {
  const { query, limit = 10 } = input || {};
  if (!query || typeof query !== "string") {
    throw new Error("discovery.web_search requires query (string)");
  }

  const base = searxngBase(ctx);
  const num = Math.min(Number(limit) || 10, MAX_RESULTS);

  const params = new URLSearchParams({
    q: query,
    format: "json",
    language: "en",
    safesearch: "0",
  });
  const url = `${base}/search?${params.toString()}`;

  const started = Date.now();
  let res;
  try {
    res = await fetch(url, {
      headers: {
        "accept": "application/json",
        "user-agent": "agentry/0.1.0",
      },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (e) {
    const err = new Error(
      `web_search: fetch failed against ${base}: ${e.message}. ` +
      `Is the SearXNG instance up? Check SEARXNG_URL.`
    );
    err.retryable = true;
    throw err;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`web_search: HTTP ${res.status} from ${base} — ${body.slice(0, 200)}`);
    err.retryable = res.status >= 500 || res.status === 429;
    throw err;
  }

  const data = await res.json().catch(() => null);
  const raw = Array.isArray(data?.results) ? data.results : [];

  const candidates = raw.slice(0, num).map((r, idx) => {
    let domain = null;
    try { domain = new URL(r.url).hostname.replace(/^www\./, ""); } catch {}
    return {
      id: r.url,
      kind: "web_result",
      source: "searxng",
      name: r.title || null,
      url: r.url || null,
      description: r.content || null,
      snippet: r.content || null,
      domain,
      stars: null,
      language: null,
      topics: [],
      license: null,
      pushed_at: null,
      rank: idx + 1,
      engines: Array.isArray(r.engines) ? r.engines : null,
    };
  });

  return {
    output: {
      candidates,
      meta: {
        query,
        count: candidates.length,
        engine: "searxng",
        searxng_url: base,
        raw_count: raw.length,
      },
    },
    cost: { time_ms: Date.now() - started, http_calls: 1, money_usd: 0 },
  };
}
