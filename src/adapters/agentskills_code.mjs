// agentry/src/adapters/agentskills_code.mjs
//
// v0.18.4 — search for SKILL.md files across GitHub.
//
// SKILL.md is the open agent-skills convention used by Claude Code,
// OpenAI Codex, Cursor, OpenClaw, and 40+ other agents. Search is
// performed via GitHub's code search API, filtered to
// filename:SKILL.md. This adapter covers every SKILL.md-based system
// in one search.
//
// Needs a GitHub token for reasonable rate limits (5000/hr). Falls
// back to unauthenticated (60/hr) if config.github.token is unset.

import { httpJson } from "./_registry.mjs";

export const meta = {
  name: "agentskills_code",
  kind: "agent_skill",
  description: "Agent skills (SKILL.md) across all GitHub repos",
};

export async function search({ query, limit = 10, ctx }) {
  const token = ctx && ctx.config && ctx.config.github && ctx.config.github.token;
  const headers = { accept: "application/vnd.github.text-match+json" };
  if (token) headers["authorization"] = "Bearer " + token;

  const q = "filename:SKILL.md " + query;
  const url = "https://api.github.com/search/code?q="
    + encodeURIComponent(q)
    + "&per_page=" + Math.min(limit, 30);

  let data;
  try {
    data = await httpJson(url, { headers, timeoutMs: 15000 });
  } catch (e) {
    return [];
  }
  const items = Array.isArray(data && data.items) ? data.items : [];

  return items.slice(0, limit).map(it => {
    const repo = (it.repository && it.repository.full_name) || null;
    const path = it.path || "";
    // Extract the skill's parent directory as the skill name:
    //   skills/pdf-tools/SKILL.md  →  pdf-tools
    const parts = path.split("/").filter(Boolean);
    const skillSlug = parts.length >= 2 ? parts[parts.length - 2] : (parts[0] || "skill");
    const htmlUrl = it.html_url
      || (repo ? "https://github.com/" + repo + "/blob/HEAD/" + path : null);

    return {
      id: "agentskills:" + (repo ? repo + ":" + path : path),
      source: "agentskills_code",
      kind: "agent_skill",
      name: skillSlug,
      url: htmlUrl,
      description: null,
      exists_locally: false,
      meta: {
        repo,
        path,
        skill_name: skillSlug,
      },
    };
  });
}
