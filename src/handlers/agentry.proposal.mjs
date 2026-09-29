// agentry/src/handlers/agentry.proposal.mjs
// Turns a (gap, candidates) pair into a reviewed proposal.
//
// Uses the LLM to score each candidate against the gap. Composes a
// structured proposal node, generates per-candidate approval tokens,
// and sends an email with approve/reject URLs.
//
// The proposal does NOT adopt. Adoption is a separate, human-gated step.
// This handler's only output is: a graph node + an email.

import { randomBytes } from "node:crypto";

// Model selection is dynamic. We ask the handler to accept any model
// whose provider is free-tier. That way if gpt-oss-20b:free is
// unavailable and the router serves something else free, we still
// accept it — because both are free and live.
//
// The handler verifies the returned model against the live registry
// when accept_from is set. ACCEPT_FREE_OR_QUOTA = null means "don't
// verify" (permissive, for first-day observation). Set to
// { limit_type: "per_week" } to enforce strict free-only.
const PRIMARY_LLM = "gpt-oss-20b:free";
const FALLBACK_LLM = "qwen3.6-plus:free";
const ACCEPT_FREE = { limit_type: "per_week" };   // strict: only unlimited-free
const ACCEPT_FREE_OR_QUOTA = null;                // permissive: any free-classified

// If this env var is set, it's used to build approve/reject URLs.
// On the Space it will be https://<space-host>/agentry
const APPROVAL_BASE_URL = process.env.AGENTRY_APPROVAL_BASE_URL || null;

// How long an approval token is valid, in ms. 7 days.
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function systemPrompt() {
  return `You are a capability reviewer for an autonomous agent.

You will be given:
  1. A "gap" — something the agent tried to do and could not, described
     by its wanted kind and the missing capability id.
  2. A list of "candidates" — repositories or tools found by a search.

For each candidate, decide how well it fills the gap.

Return ONLY a JSON object with this exact shape, nothing else:
{
  "candidates": [
    {
      "id": "<exact candidate id from input>",
      "fit": <number between 0 and 1>,
      "confidence": "high" | "medium" | "low",
      "why": "<one sentence, 20-40 words>",
      "risks": ["<short phrase>", ...]
    }
  ],
  "recommended_id": "<id of the single best candidate, or null>",
  "summary": "<two sentences: what was found, what you recommend>"
}

Rules:
- Do not add any text outside the JSON object.
- If a candidate is clearly irrelevant, set fit <= 0.2 and confidence "high".
- Be conservative: prefer well-known, actively maintained projects.
- If nothing is a good fit, set recommended_id to null.
- Return every input candidate exactly once, in the same order.`;
}

function userPrompt(gap, candidates) {
  const trimmed = candidates.map(c => ({
    id: c.id,
    name: c.name,
    url: c.url,
    description: c.description || null,
    stars: c.stars ?? null,
    language: c.language ?? null,
    topics: c.topics || [],
    pushed_at: c.pushed_at ?? null,
    license: c.license ?? null,
  }));
  return `GAP:
  wanted_kind: ${gap.wanted_kind || "unknown"}
  wanted_id:   ${gap.wanted_id || "unknown"}
  reason:      ${gap.reason || "unspecified"}

CANDIDATES (${trimmed.length}):
${JSON.stringify(trimmed, null, 2)}`;
}

function parseProposalJSON(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace <= firstBrace) return null;
  s = s.slice(firstBrace, lastBrace + 1);
  try {
    const parsed = JSON.parse(s);
    if (!parsed || !Array.isArray(parsed.candidates)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function fallbackProposal(gap, candidates) {
  return {
    candidates: candidates.map(c => ({
      id: c.id,
      fit: null,
      confidence: "unknown",
      why: c.description || "(no description)",
      risks: [],
    })),
    recommended_id: null,
    summary: `Found ${candidates.length} candidate(s) for gap "${gap.wanted_kind || gap.id}". LLM analysis unavailable — sending raw candidates for your review.`,
    llm_failed: true,
  };
}

async function analyze(deps, gap, candidates) {
  const messages = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: userPrompt(gap, candidates) },
  ];

  for (const model of [PRIMARY_LLM, FALLBACK_LLM]) {
    try {
      const res = await deps.invoke("llm.openai_compat", {
        model,
        messages,
        temperature: 0.1,
        max_tokens: 1500,
        // Per-call policy. null = accept whatever the provider returns
        // (useful for a first day of observation). Set to
        // { limit_type: "per_week" } to enforce free-only.
        accept_from: ACCEPT_FREE_OR_QUOTA,
      }, { tenant: "local", by: "agentry.proposal" });

      if (!res.ok) {
        deps.events.emit("proposal.llm_failed", {
          model,
          code: res.error.code,
          message: res.error.message,
          substituted: res.error.substituted === true,
          reason: res.error.reason || null,
        });
        continue;
      }
      const parsed = parseProposalJSON(res.output.content);
      if (parsed) return { proposal: parsed, model_used: res.output.model || model };
      deps.events.emit("proposal.llm_unparseable", {
        model,
        content: String(res.output.content).slice(0, 300),
      });
    } catch (e) {
      deps.events.emit("proposal.llm_threw", { model, error: e.message });
    }
  }
  return null;
}

function newToken() {
  return randomBytes(16).toString("hex");
}

function approvalTemplates() {
  if (!APPROVAL_BASE_URL) return null;
  const base = APPROVAL_BASE_URL.replace(/\/+$/, "");
  return {
    approve: `${base}/approve/__TOKEN__`,
    reject:  `${base}/reject/__TOKEN__`,
  };
}

function renderEmail({ gap, analysis, perCandidateTokens, approveBase }) {
  const lines = [];
  lines.push(`Gap: ${gap.wanted_kind || "?"}  (${gap.wanted_id || gap.id})`);
  lines.push(`Reason: ${gap.reason || "unspecified"}`);
  lines.push("");
  lines.push(analysis.summary || "(no summary)");
  lines.push("");
  lines.push("─── Candidates ───");
  lines.push("");

  for (const c of analysis.candidates) {
    const raw = (gap._candidatesById && gap._candidatesById[c.id]) || {};
    lines.push(`• ${c.id}`);
    if (raw.name && raw.name !== c.id) lines.push(`  name: ${raw.name}`);
    if (raw.url) lines.push(`  url:  ${raw.url}`);
    if (raw.stars != null) lines.push(`  stars: ${raw.stars}`);
    if (raw.language) lines.push(`  lang: ${raw.language}`);
    if (c.fit != null) lines.push(`  fit:  ${c.fit}  (confidence: ${c.confidence})`);
    if (c.why) lines.push(`  why:  ${c.why}`);
    if (Array.isArray(c.risks) && c.risks.length) lines.push(`  risks: ${c.risks.join(", ")}`);
    const tok = perCandidateTokens[c.id];
    if (tok && approveBase) {
      lines.push(`  approve: ${approveBase.approve.replace("__TOKEN__", tok)}`);
      lines.push(`  reject:  ${approveBase.reject.replace("__TOKEN__", tok)}`);
    }
    lines.push("");
  }

  if (analysis.recommended_id) {
    lines.push(`Recommended: ${analysis.recommended_id}`);
  } else {
    lines.push("Recommended: none");
  }
  lines.push("");
  lines.push(`(Proposal ${gap._proposalId || ""})`);
  return lines.join("\n");
}

export default async function agentryProposal(input, ctx) {
  const { gap, candidates, notify = "notify.email.gmail" } = input || {};
  if (!gap || typeof gap !== "object") throw new Error("agentry.proposal requires gap");
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("agentry.proposal requires non-empty candidates array");
  }

  if (typeof ctx.invoke !== "function") {
    throw new Error("agentry.proposal requires ctx.invoke — was it invoked through the runtime?");
  }

  const started = Date.now();
  const deps = {
    graph: ctx.graph,
    events: ctx.events,
    config: ctx.config,
    invoke: ctx.invoke,
  };

  // 1. Analyze
  const result = await analyze(deps, gap, candidates);
  const analysis = result?.proposal ?? fallbackProposal(gap, candidates);
  const modelUsed = result?.model_used ?? null;

  // 2. Build per-candidate approval tokens
  const proposalId = `proposal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const perCandidateTokens = {};
  const tokenIndex = {};
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  for (const c of analysis.candidates) {
    const t = newToken();
    perCandidateTokens[c.id] = t;
    tokenIndex[t] = { candidate_id: c.id, proposal_id: proposalId };
  }

  // 3. Attach raw candidate info for rendering
  const candidatesById = {};
  for (const c of candidates) candidatesById[c.id] = c;
  gap._candidatesById = candidatesById;
  gap._proposalId = proposalId;

  // 4. Record the proposal as a graph node
  const proposalNode = {
    id: proposalId,
    kind: "proposal",
    state: "pending",
    gap_id: gap.id,
    gap_wanted_kind: gap.wanted_kind || null,
    gap_wanted_id: gap.wanted_id || null,
    model_used: modelUsed,
    analysis,
    candidates: candidates.map(c => ({
      id: c.id,
      name: c.name,
      url: c.url,
      stars: c.stars ?? null,
      language: c.language ?? null,
      license: c.license ?? null,
    })),
    tokens: tokenIndex,
    tokens_expires_at: expiresAt,
    decisions: {},
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  ctx.graph.putCapability(proposalNode);
  ctx.events.emit("proposal.created", {
    proposal_id: proposalId,
    gap_id: gap.id,
    candidates: candidates.length,
    model_used: modelUsed,
    recommended_id: analysis.recommended_id || null,
  });

  // 5. Send the email
  const approveBase = approvalTemplates();
  const body = renderEmail({ gap, analysis, perCandidateTokens, approveBase });
  const subject = `[agentry] proposal: ${analysis.recommended_id || `${candidates.length} candidates`} for ${gap.wanted_kind || gap.id}`;

  const notifyRes = await deps.invoke(notify, { subject, body_markdown: body }, {
    tenant: "local",
    by: "agentry.proposal",
  });

  if (!notifyRes.ok) {
    ctx.events.emit("proposal.notify_failed", {
      proposal_id: proposalId,
      code: notifyRes.error.code,
      message: notifyRes.error.message,
    });
  } else {
    ctx.events.emit("proposal.notified", {
      proposal_id: proposalId,
      channel: notify,
      message_id: notifyRes.output.message_id || null,
    });
  }

  return {
    output: {
      proposal_id: proposalId,
      gap_id: gap.id,
      candidates_reviewed: analysis.candidates.length,
      recommended_id: analysis.recommended_id || null,
      model_used: modelUsed,
      notified: notifyRes.ok,
      approval_urls_available: Boolean(approveBase),
    },
    cost: { time_ms: Date.now() - started },
  };
}
