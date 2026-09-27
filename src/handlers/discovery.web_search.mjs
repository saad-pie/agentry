// agentry/src/handlers/discovery.web_search.mjs
const CSE_ENDPOINT = "https://www.googleapis.com/customsearch/v1";

export default async function discoveryWebSearch(input, ctx) {
  const { query, limit = 10 } = input || {};
  if (!query || typeof query !== "string") {
    throw new Error("discovery.web_search requires query (string)");
  }

  const { key, cx } = ctx.config.googleCse || {};
  if (!key || !cx) {
    const err = new Error("discovery.web_search: missing credentials. Set GOOGLE_CSE_KEY and GOOGLE_CSE_CX.");
    err.retryable = false;
    throw err;
  }

  const num = Math.min(Number(limit) || 10, 10);
  const params = new URLSearchParams({ key, cx, q: query, num: String(num) });
  const url = `${CSE_ENDPOINT}?${params.toString()}`;

  const started = Date.now();
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  } catch (e) {
    const err = new Error(`web_search: fetch failed: ${e.message}`);
    err.retryable = true;
    throw err;
  }

  if (res.status === 429) {
    const err = new Error("web_search: daily quota exceeded");
    err.retryable = false;
    throw err;
  }
  if (res.status === 403) {
    const body = await res.json().catch(() => ({}));
    const reason = body?.error?.errors?.[0]?.reason || "unknown";
    const err = new Error(`web_search: 403 ${reason}`);
    err.retryable = reason === "rateLimitExceeded" || reason === "userRateLimitExceeded";
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`web_search: HTTP ${res.status} — ${body.slice(0, 200)}`);
    err.retryable = res.status >= 500;
    throw err;
  }

  const data = await res.json().catch(() => null);
  const items = Array.isArray(data?.items) ? data.items : [];

  const candidates = items.map((it, idx) => {
    const link = it.link || "";
    let domain = null;
    try { domain = new URL(link).hostname.replace(/^www\./, ""); } catch {}
    return {
      id: link,
      kind: "web_result",
      source: "google_cse",
      name: it.title || null,
      url: link,
      domain,
      snippet: it.snippet || null,
      displayed_link: it.displayLink || null,
      rank: idx + 1,
      meta: it.pagemap ? { pagemap_keys: Object.keys(it.pagemap) } : undefined,
    };
  });

  return {
    output: {
      candidates,
      meta: {
        query,
        count: candidates.length,
        total_results: data?.searchInformation?.totalResults ?? null,
        formatted_total: data?.searchInformation?.formattedTotalResults ?? null,
        search_time_s: data?.searchInformation?.searchTime ?? null,
        quota_ceiling: 10,
      },
    },
    cost: { time_ms: Date.now() - started, http_calls: 1, money_usd: 0 },
  };
}
