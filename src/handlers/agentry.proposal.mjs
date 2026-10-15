// agentry/src/handlers/agentry.proposal.mjs
// Turns a (gap, candidates) pair into a reviewed proposal.
//
// v0.15.15: at most one open proposal per gap.
//
// v0.15.22: the "open" predicate was widened from
//   (state === "pending" || state === "in_review")
// to
//   (!adopted_at && !retired_at)
// The old predicate missed proposals in state "decided" that hadn't
// yet been picked up by the discovery loop's adoption pass. That was
// latent while every proposal went through human approval, but it
// becomes a live bug the moment auto-adoption is introduced.
//
// v0.15.23: auto-approval by kind whitelist. If the gap's wanted_kind
// is in config.runtime.adoptionAutoKinds AND the reasoner recommended a
// candidate with confidence "high", the proposal node is written in
// state "decided" with a pre-filled decisions map and the approval
// email is skipped. The discovery loop's Pass 2 picks it up on the
// next tick exactly like a human-approved proposal.
//
// The whitelist is deterministic by design. Fit scores drift across
// model swaps (we've seen three different models rank three different
// top candidates for the same gap), so a numeric threshold is unstable.
// A kind list is not. bua/cua/mua/memory stay human-gated.

import { randomBytes } from "node:crypto";
import { link, RELATIONS } from "../graph/edges.mjs";

const MODEL_CHAIN = [
  { provider: "groq", model: "openai/gpt-oss-120b" },
  { provider: "groq", model: "openai/gpt-oss-20b" },
  { provider: "groq", model: "qwen/qwen3.8-27b" },
  { provider: "google", model: "gemini-2.5-flash" },
];

const ACCEPT_FREE_OR_QUOTA = null;
const APPROVAL_BASE_URL = process.env.AGENTRY_APPROVAL_BASE_URL || null;
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function systemPrompt() {
  return `You are a capability reviewer for an autonomous agent.

You will be given:
1. A "gap" — something the agent tried to do and could not.
2. A list of "candidates" — each is either:
   - kind "repo":       a GitHub repository with stars, language,
                        pushed_at, license.
   - kind "web_result": a web search result with title, url,
                        description/snippet, domain.

For repo candidates, judge on: fit, stars, recency, license, activity.
For web_result candidates, judge on: fit, the specificity of the
description/snippet, the credibility of the domain (official docs,
github.com, npmjs.com, pypi.org are strong; random blogs are weak),
and whether the title names a specific tool or project.

Recommend only tools that are open source, actively maintained, and
actually solve the gap. Set fit <= 0.2 for abandoned projects, vague
blog posts, and anything you would not stake your reputation on.

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
- If nothing is a good fit, set recommended_id to null.
- Return every input candidate exactly once, in the same order.`;
}

function userPrompt(gap, candidates) {
  const trimmed = candidates.map(c => ({
    id: c.id,
    kind: c.kind || "repo",
    name: c.name,
    url: c.url,
    description: c.description || null,
    stars: c.stars ?? null,
    language: c.language ?? null,
    license: c.license ?? null,
    pushed_at: c.pushed_at ?? null,
    topics: c.topics || [],
    domain: c.domain ?? null,
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
    { role: "user",   content: userPrompt(gap, candidates) },
  ];

  for (const { provider, model } of MODEL_CHAIN) {
    try {
      const res = await deps.invoke("llm.openai_compat", {
        provider,
        model,
        messages,
        temperature: 0.1,
        max_tokens: 4000,
        accept_from: ACCEPT_FREE_OR_QUOTA,
      }, { tenant: "local", by: "agentry.proposal" });

      if (!res.ok) {
        deps.events.emit("proposal.llm_failed", {
          provider, model,
          code: res.error.code,
          message: res.error.message,
          substituted: res.error.substituted === true,
        });
        continue;
      }

      const parsed = parseProposalJSON(res.output.content);
      if (parsed) {
        return { proposal: parsed, model_used: res.output.model || model, provider_used: provider };
      }
      deps.events.emit("proposal.llm_unparseable", {
        provider, model,
        content: String(res.output.content).slice(0, 300),
      });
    } catch (e) {
      deps.events.emit("proposal.llm_threw", { provider, model, error: e.message });
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

// v0.15.23 — the auto-approval gate.
// Returns the recommended candidate if this proposal qualifies for
// automatic approval, else null. Null means "fall through to email".
function shouldAutoApprove(gap, analysis, config) {
  if (!analysis || !analysis.recommended_id) return null;
  const autoKinds = config?.runtime?.adoptionAutoKinds;
  if (!Array.isArray(autoKinds) || autoKinds.length === 0) return null;
  if (!gap.wanted_kind || !autoKinds.includes(gap.wanted_kind)) return null;
  const recommended = (analysis.candidates || []).find(c => c.id === analysis.recommended_id);
  if (!recommended) return null;
  if (recommended.confidence !== "high") return null;
  return recommended;
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
    if (raw.kind)     lines.push(`  kind: ${raw.kind}`);
    if (raw.name && raw.name !== c.id) lines.push(`  name: ${raw.name}`);
    if (raw.url)      lines.push(`  url:  ${raw.url}`);
    if (raw.stars != null) lines.push(`  stars: ${raw.stars}`);
    if (raw.language) lines.push(`  lang: ${raw.language}`);
    if (raw.domain)   lines.push(`  domain: ${raw.domain}`);
    if (c.fit != null) lines.push(`  fit:  ${c.fit}  (confidence: ${c.confidence})`);
    if (c.why)        lines.push(`  why:  ${c.why}`);
    if (Array.isArray(c.risks) && c.risks.length) lines.push(`  risks: ${c.risks.join(", ")}`);
    const tok = perCandidateTokens[c.id];
    if (tok && approveBase) {
      lines.push(`  approve: ${approveBase.approve.replace("__TOKEN__", tok)}`);
      lines.push(`  reject:  ${approveBase.reject.replace("__TOKEN__", tok)}`);
    }
    lines.push("");
  }

  lines.push(analysis.recommended_id ? `Recommended: ${analysis.recommended_id}` : "Recommended: none");
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

  // Dedupe: at most one open proposal per gap.
  const openProposal = [...ctx.graph.capabilities().values()].find(
    (c) =>
      c.kind === "proposal" &&
      !c.adopted_at &&
      !c.retired_at &&
      c.gap_id === gap.id
  );

  if (openProposal) {
    ctx.events.emit("proposal.deduped", {
      gap_id: gap.id,
      existing_proposal_id: openProposal.id,
      existing_state: openProposal.state,
      candidates_in_existing: (openProposal.candidates || []).length,
    });
    return {
      output: {
        proposal_id: openProposal.id,
        gap_id: gap.id,
        deduped: true,
        existing_state: openProposal.state,
        notified: false,
        reason: "proposal_already_open_for_gap",
      },
      cost: { time_ms: 0 },
    };
  }

  const started = Date.now();
  const deps = {
    graph: ctx.graph, events: ctx.events, config: ctx.config, invoke: ctx.invoke,
  };

  const result = await analyze(deps, gap, candidates);
  const analysis = result?.proposal ?? fallbackProposal(gap, candidates);
  const modelUsed = result?.model_used ?? null;
  const providerUsed = result?.provider_used ?? null;

  const proposalId = `proposal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const perCandidateTokens = {};
  const tokenIndex = {};
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  for (const c of analysis.candidates) {
    const t = newToken();
    perCandidateTokens[c.id] = t;
    tokenIndex[t] = { candidate_id: c.id, proposal_id: proposalId };
  }

  const candidatesById = {};
  for (const c of candidates) candidatesById[c.id] = c;
  gap._candidatesById = candidatesById;
  gap._proposalId = proposalId;

  // v0.15.23 — auto-approval decision is made before the node is written,
  // so the node goes into the graph already in its final state.
  const autoApproved = shouldAutoApprove(gap, analysis, ctx.config);
  const now = Date.now();

  const proposalNode = {
    id: proposalId,
    kind: "proposal",
    state: autoApproved ? "decided" : "pending",
    gap_id: gap.id,
    gap_wanted_kind: gap.wanted_kind || null,
    gap_wanted_id: gap.wanted_id || null,
    model_used: modelUsed,
    provider_used: providerUsed,
    analysis,
    candidates: candidates.map(c => ({
      id: c.id,
      kind: c.kind || null,
      name: c.name,
      url: c.url,
      stars: c.stars ?? null,
      language: c.language ?? null,
      license: c.license ?? null,
      domain: c.domain ?? null,
    })),
    tokens: tokenIndex,
    tokens_expires_at: expiresAt,
    decisions: autoApproved
      ? {
          [autoApproved.id]: {
            decision: "approved",
            at: now,
            auto: true,
            confidence: autoApproved.confidence,
            fit: autoApproved.fit,
          },
        }
      : {},
    auto_approved: Boolean(autoApproved),
    created_at: now,
    updated_at: now,
  };
  ctx.graph.putCapability(proposalNode);
  try {
    link(ctx.graph, {
      from: proposalId,
      to: gap.id,
      relation: RELATIONS.PROPOSAL_SATISFIES_GAP,
      meta: { auto_approved: Boolean(autoApproved) },
    });
  } catch (e) {
    ctx.events.emit("proposal.edge_write_failed", {
      proposal_id: proposalId, gap_id: gap.id, error: e.message,
    });
  }
  ctx.events.emit("proposal.created", {
    proposal_id: proposalId,
    gap_id: gap.id,
    candidates: candidates.length,
    model_used: modelUsed,
    provider_used: providerUsed,
    recommended_id: analysis.recommended_id || null,
    auto_approved: Boolean(autoApproved),
  });

  let notified = false;
  let deliveredVia = null;
  let fallbackUsed = false;

  if (autoApproved) {
    ctx.events.emit("proposal.auto_approved", {
      proposal_id: proposalId,
      gap_id: gap.id,
      gap_wanted_kind: gap.wanted_kind,
      recommended_id: autoApproved.id,
      confidence: autoApproved.confidence,
      fit: autoApproved.fit ?? null,
      reason: "kind_whitelist_high_confidence",
    });
  } else {
    const approveBase = approvalTemplates();
    const body = renderEmail({ gap, analysis, perCandidateTokens, approveBase });
    const subject = `[agentry] proposal: ${analysis.recommended_id || `${candidates.length} candidates`} for ${gap.wanted_kind || gap.id}`;

    const notifyRes = await deps.invoke("notify.fallback", {
      subject,
      body_markdown: body,
      primary: notify,
      fallback: "notify.console",
    }, {
      tenant: "local", by: "agentry.proposal",
    });

    if (!notifyRes.ok) {
      ctx.events.emit("proposal.notify_failed", {
        proposal_id: proposalId,
        code: notifyRes.error.code,
        message: notifyRes.error.message,
      });
    } else {
      notified = true;
      deliveredVia = notifyRes.output.channel;
      fallbackUsed = notifyRes.output.fallback_used;
      ctx.events.emit("proposal.notified", {
        proposal_id: proposalId,
        channel: notifyRes.output.channel,
        primary_ok: notifyRes.output.primary_ok,
        fallback_used: notifyRes.output.fallback_used,
        message_id: notifyRes.output.message_id || null,
      });
    }
  }

  return {
    output: {
      proposal_id: proposalId,
      gap_id: gap.id,
      candidates_reviewed: analysis.candidates.length,
      recommended_id: analysis.recommended_id || null,
      model_used: modelUsed,
      provider_used: providerUsed,
      auto_approved: Boolean(autoApproved),
      auto_approved_candidate_id: autoApproved?.id || null,
      notified,
      delivered_via: deliveredVia,
      fallback_used: fallbackUsed,
      approval_urls_available: Boolean(APPROVAL_BASE_URL),
    },
    cost: { time_ms: Date.now() - started },
  };
}
