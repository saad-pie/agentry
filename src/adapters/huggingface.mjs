// agentry/src/adapters/huggingface.mjs
//
// v0.18.0 — search Hugging Face models.
//
// Public JSON API. Returns model ids, pipeline tags, downloads, likes.

import { httpJson } from "./_registry.mjs";

export const meta = {
  name: "huggingface",
  kind: "hf_model",
  description: "Hugging Face model registry",
};

export async function search({ query, limit = 10 }) {
  const url = "https://huggingface.co/api/models?search="
    + encodeURIComponent(query)
    + "&limit=" + Math.min(limit, 30)
    + "&sort=downloads&direction=-1";
  const data = await httpJson(url);
  const list = Array.isArray(data) ? data : [];

  return list.slice(0, limit).map(m => ({
    id: "hf:" + m.modelId,
    source: "huggingface",
    kind: "hf_model",
    name: m.modelId,
    url: "https://huggingface.co/" + m.modelId,
    description: m.pipeline_tag || null,
    exists_locally: false,
    meta: {
      downloads: m.downloads || 0,
      likes: m.likes || 0,
      tags: Array.isArray(m.tags) ? m.tags.slice(0, 8) : [],
      lastModified: m.lastModified || null,
    },
  }));
}
