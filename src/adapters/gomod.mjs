// agentry/src/adapters/gomod.mjs
//
// v0.18.0 — search Go modules via pkg.go.dev.
//
// pkg.go.dev has no public JSON search API. We scrape the search
// results page. If the markup changes, this returns [] gracefully.

import { httpText } from "./_registry.mjs";

export const meta = {
  name: "gomod",
  kind: "go_module",
  languages: ["go"],
  description: "pkg.go.dev public Go module index",
};

export async function search({ query, limit = 10 }) {
  const url = "https://pkg.go.dev/search?q=" + encodeURIComponent(query) + "&m=package";
  const html = await httpText(url);

  const items = [];
  const seen = new Set();

  // pkg.go.dev renders results as anchors of the form
  //   <a href="/<module_path>@<version>"> or href="/<module_path>">
  // Filter to entries that look like module paths (contain a dot or
  // slash and start with a letter).
  const re = /<a[^>]+href="\/([a-z0-9][^"@\s]*?)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const path = m[1];
    if (!path || path.startsWith("_") || path.startsWith("about") || path.startsWith("search")) continue;
    if (!path.includes("/") && !path.includes(".")) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    items.push({
      id: "gomod:" + path,
      source: "gomod",
      kind: "go_module",
      name: path,
      url: "https://pkg.go.dev/" + path,
      description: null,
      exists_locally: false,
      meta: { language: "go" },
    });
    if (items.length >= limit) break;
  }

  return items;
}
