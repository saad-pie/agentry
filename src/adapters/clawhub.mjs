// agentry/src/adapters/clawhub.mjs
//
// v0.18.4 — search ClawHub, the OpenClaw skill registry.
//
// Public JSON API. Anonymous read limit: 3000 req/min per IP. Each
// result is a SKILL.md-based skill with owner, slug, categories,
// downloads, and an install reference.

import { httpJson } from "./_registry.mjs";

export const meta = {
  name: "clawhub",
  kind: "agent_skill",
  description: "OpenClaw skill registry (ClawHub)",
};

export async function search({ query, limit = 10 }) {
  const url = "https://clawhub.ai/api/v1/search?q="
    + encodeURIComponent(query)
    + "&limit=" + Math.min(limit, 30);
  const data = await httpJson(url);
  const list = Array.isArray(data && data.results) ? data.results : [];

  const items = [];
  for (const r of list) {
    const ref = (r.install && r.install.reference)
      || (r.canonicalUrl || "").replace(/^\/+/, "").replace(/\/skills\//, "/");
    const handle = (r.native && r.native.ownerHandle)
      || (r.canonicalUrl || "").split("/").filter(Boolean)[0]
      || null;
    const slug = (r.canonicalUrl || "").split("/").filter(Boolean).pop() || r.displayName || "skill";
    const url = r.canonicalUrl
      ? "https://clawhub.ai" + r.canonicalUrl
      : ("https://clawhub.ai/" + (handle || "unknown") + "/skills/" + slug);

    items.push({
      id: "clawhub:" + (ref || slug),
      source: "clawhub",
      kind: "agent_skill",
      name: r.displayName || slug,
      url,
      description: (r.native && r.native.skill && r.native.skill.summary)
        || r.description
        || null,
      exists_locally: false,
      meta: {
        downloads: r.downloads || 0,
        owner: handle,
        categories: (r.native && r.native.skill && Array.isArray(r.native.skill.categories))
          ? r.native.skill.categories
          : [],
        featured: r.featured === true,
        install_reference: (r.install && r.install.reference) || null,
      },
    });
    if (items.length >= limit) break;
  }
  return items;
}
