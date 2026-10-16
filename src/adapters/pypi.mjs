// agentry/src/adapters/pypi.mjs
//
// v0.18.0 — search PyPI (Python Package Index).
//
// PyPI has no public JSON search API — only per-package JSON at
// /pypi/<name>/json. Bulk search is HTML only. We scrape the search
// results page with a two-tier regex; if PyPI's markup drifts, this
// adapter returns [] and the caller continues.

import { httpText } from "./_registry.mjs";

export const meta = {
  name: "pypi",
  kind: "python_package",
  languages: ["python"],
  description: "Public Python Package Index",
};

export async function search({ query, limit = 10 }) {
  const url = "https://pypi.org/search/?q=" + encodeURIComponent(query);
  const html = await httpText(url);

  const items = [];
  const seen = new Set();

  // Tier 1: modern markup. <a class="package-snippet" href="/project/NAME/">
  //   inside which <span class="package-snippet__name">NAME</span>
  //   and <p class="package-snippet__description">DESC</p>
  const re1 = /<a[^>]*class="package-snippet"[^>]*href="\/project\/([^\/"]+)\/?"[\s\S]*?<span[^>]*class="package-snippet__name"[^>]*>([^<]+)<\/span>[\s\S]*?<p[^>]*class="package-snippet__description"[^>]*>([^<]*)<\/p>/g;
  let m;
  while ((m = re1.exec(html)) !== null) {
    const pkg = m[2].trim() || m[1].trim();
    if (seen.has(pkg)) continue;
    seen.add(pkg);
    items.push({
      id: "pypi:" + pkg,
      source: "pypi",
      kind: "python_package",
      name: pkg,
      url: "https://pypi.org/project/" + m[1].trim() + "/",
      description: m[3].trim() || null,
      exists_locally: false,
      meta: { language: "python" },
    });
    if (items.length >= limit) break;
  }

  // Tier 2 (fallback): just find /project/NAME/ links and take the slug.
  if (items.length === 0) {
    const re2 = /href="\/project\/([^\/"]+)\/?"/g;
    while ((m = re2.exec(html)) !== null) {
      const pkg = m[1].trim();
      if (!pkg || seen.has(pkg)) continue;
      seen.add(pkg);
      items.push({
        id: "pypi:" + pkg,
        source: "pypi",
        kind: "python_package",
        name: pkg,
        url: "https://pypi.org/project/" + pkg + "/",
        description: null,
        exists_locally: false,
        meta: { language: "python" },
      });
      if (items.length >= limit) break;
    }
  }

  return items;
}
