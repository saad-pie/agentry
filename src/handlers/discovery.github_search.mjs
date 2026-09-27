// agentry/src/handlers/discovery.github_search.mjs
const GITHUB_API = "https://api.github.com/search/repositories";

export default async function discoveryGithubSearch(input, ctx) {
  const { query, limit = 30 } = input || {};
  if (!query || typeof query !== "object") {
    throw new Error("discovery.github_search requires query (object)");
  }

  const { token, userAgent } = ctx.config.github || {};

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    params.set(k, String(v));
  }
  params.set("per_page", String(Math.min(Number(limit) || 30, 100)));

  const url = `${GITHUB_API}?${params.toString()}`;

  const headers = {
    "accept": "application/vnd.github+json",
    "user-agent": userAgent || "agentry/0.1.0",
    "x-github-api-version": "2022-11-28",
  };
  if (token) headers["authorization"] = `Bearer ${token}`;

  const started = Date.now();
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  } catch (e) {
    const err = new Error(`github_search: fetch failed: ${e.message}`);
    err.retryable = true;
    throw err;
  }

  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    const resetEpoch = res.headers.get("x-ratelimit-reset");
    const retryAfter = res.headers.get("retry-after");
    const resetMs = resetEpoch ? Number(resetEpoch) * 1000 : null;
    const waitMs = retryAfter ? Number(retryAfter) * 1000 : resetMs ? Math.max(0, resetMs - Date.now()) : 60000;

    const err = new Error(`github_search: rate limited (remaining=${remaining}, reset in ${Math.round(waitMs/1000)}s)`);
    err.retryable = true;
    err.retry_after_ms = waitMs;
    throw err;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`github_search: HTTP ${res.status} — ${body.slice(0, 200)}`);
    err.retryable = res.status >= 500;
    throw err;
  }

  const data = await res.json().catch(() => null);
  const items = Array.isArray(data?.items) ? data.items : [];

  const candidates = items.map(repo => ({
    id: repo.full_name,
    kind: "repo",
    source: "github",
    name: repo.full_name,
    url: repo.html_url,
    description: repo.description,
    stars: repo.stargazers_count,
    language: repo.language,
    topics: repo.topics || [],
    license: repo.license?.spdx_id || null,
    pushed_at: repo.pushed_at,
    updated_at: repo.updated_at,
    archived: repo.archived,
    has_issues: repo.has_issues,
    open_issues: repo.open_issues_count,
    default_branch: repo.default_branch,
  }));

  return {
    output: {
      candidates,
      meta: {
        query,
        count: candidates.length,
        total_matches: data?.total_count ?? null,
        rate_limit_remaining: res.headers.get("x-ratelimit-remaining"),
        rate_limit_limit: res.headers.get("x-ratelimit-limit"),
        authenticated: Boolean(token),
      },
    },
    cost: { time_ms: Date.now() - started, http_calls: 1 },
  };
}
