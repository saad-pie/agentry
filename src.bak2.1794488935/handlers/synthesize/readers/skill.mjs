// agentry/src/handlers/synthesize/readers/skill.mjs
// v0.53.0 — extracted from agentry.synthesize.mjs.
// Reads an agent SKILL.md. Includes HTML extract + frontmatter parser.

export async function readAgentSkill(candidate, deps) {
  const facts = {
    source_kind: "skill",
    skill_name: null,
    skill_body: null,
    skill_frontmatter: null,
    skill_source_url: null,
    error: null,
  };

  const src = String(candidate.source || "");
  const id = String(candidate.id || "");
  const meta = candidate.meta || {};
  const session = "synth_skill_" + id.replace(/[^a-z0-9_.-]/gi, "_").slice(0, 40) + "_" + Date.now().toString(36);

  try {
    if (src === "agentskills_code" && meta.repo && meta.path) {
      // Raw GitHub URL. HEAD works because raw.githubusercontent.com
      // resolves HEAD to the default branch.
      const rawUrl = "https://raw.githubusercontent.com/" + meta.repo + "/HEAD/" + meta.path;
      facts.skill_source_url = rawUrl;
      const res = await fetch(rawUrl, {
        headers: { "user-agent": "agentry/0.1.0" },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) { facts.error = "fetch " + rawUrl + " HTTP " + res.status; return facts; }
      let raw = await res.text();
      const htmlExtract = extractFromHtml(raw);
      if (htmlExtract) raw = htmlExtract;
      if (!raw || raw.length < 50 || /^\s*<!doctype html/i.test(raw) || /^\s*<html/i.test(raw)) {
        facts.error = "agentskills fetch returned HTML or empty content (" + raw.length + " bytes) from " + rawUrl;
        return facts;
      }
      const parsed = parseSkillMarkdown(raw);
      facts.skill_name = parsed.name || meta.skill_name || "skill";
      facts.skill_body = parsed.body;
      facts.skill_frontmatter = parsed.frontmatter;
      return facts;
    }

    if (src === "clawhub") {
      // ClawHub: try the skill detail API first.
      const ref = meta.install_reference || (candidate.id || "").replace(/^clawhub:/, "");
      const tries = [
        "https://clawhub.ai/api/v1/skills/" + ref,
        "https://clawhub.ai/api/v1/skills/" + ref + "/content",
      ];
      for (const url of tries) {
        try {
          const res = await fetch(url, {
            headers: { "accept": "application/json", "user-agent": "agentry/0.1.0" },
            signal: AbortSignal.timeout(10000),
          });
          if (!res.ok) continue;
          const data = await res.json();
          let content = data.content || data.body || data.markdown || null;
          if (!content) continue;
          const htmlExtract = extractFromHtml(content);
          if (htmlExtract) content = htmlExtract;
          if (!content || content.length < 50) continue;
          const parsed = parseSkillMarkdown(content);
          facts.skill_source_url = url;
          facts.skill_name = parsed.name || candidate.name || "skill";
          facts.skill_body = parsed.body;
          facts.skill_frontmatter = parsed.frontmatter;
          return facts;
        } catch (e) { continue; }
      }
      facts.error = "clawhub skill fetch failed for " + ref;
      return facts;
    }

    // Fallback: if we have a URL, try to fetch it as raw text.
    if (candidate.url) {
      try {
        const res = await fetch(candidate.url, {
          headers: { "user-agent": "agentry/0.1.0" },
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) {
          const raw = await res.text();
          const parsed = parseSkillMarkdown(raw);
          facts.skill_source_url = candidate.url;
          facts.skill_name = parsed.name || candidate.name || "skill";
          facts.skill_body = parsed.body;
          facts.skill_frontmatter = parsed.frontmatter;
          return facts;
        }
      } catch (e) { /* fall through */ }
    }

    facts.error = "unsupported skill source: " + src + " (id " + id + ")";
    return facts;
  } catch (e) {
    facts.error = "skill read threw: " + e.message;
    return facts;
  }
}

// v0.19.1 — HTML safety net. If a fetch returns GitHub's blob-view HTML
// or any other HTML wrapper, extract the actual markdown from the first
// <pre> block. If nothing can be extracted, return null so the caller
// knows to fail cleanly rather than feed 250 KB of HTML to the LLM.
export function extractFromHtml(raw) {
  const text = String(raw || "");
  if (!/^\s*<!doctype html/i.test(text) && !/^\s*<html/i.test(text)) {
    return null;   // not HTML, caller should use as-is
  }
  // GitHub blob view wraps file content in <div class="highlight ...">
  // with a <pre> containing the raw text. Try that first.
  const preMatch = text.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  if (preMatch) {
    let inner = preMatch[1];
    // Strip syntax-highlight spans but keep text.
    inner = inner.replace(/<[^>]+>/g, "");
    // Decode the basic HTML entities GitHub uses in code.
    inner = inner.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
                 .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
                 .replace(/&amp;/g, "&");
    inner = inner.trim();
    if (inner.length > 100) return inner;
  }
  return null;
}

// Parse a SKILL.md file into { name, description, frontmatter, body }.
// Frontmatter is YAML between --- lines at the top of the file. We only
// extract a handful of scalar fields; complex YAML is left as raw text.
export function parseSkillMarkdown(raw) {
  const text = String(raw || "");
  const out = { name: null, description: null, frontmatter: null, body: text };

  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return out;

  const fmText = m[1];
  const body = m[2];
  out.body = body;

  const fm = {};
  for (const line of fmText.split("\n")) {
    const mm = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.+)$/);
    if (!mm) continue;
    let v = mm[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    fm[mm[1]] = v;
  }
  out.frontmatter = fm;
  out.name = fm.name || null;
  out.description = fm.description || null;
  return out;
}

// ─────────────────────────────────────────────────────────────
// The prompt — fill in the blanks, do not copy a reference
// ─────────────────────────────────────────────────────────────

