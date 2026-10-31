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
import { isSynthesizable, supportFor } from "../adapters/_synthesis_support.mjs";

// v0.56.45 — AnyRouter primary
const MODEL_CHAIN = [
  { provider: "ollama", model: "beam:cloud" },
  { provider: "orcarouter", model: "tencent/hy4-preview-free" },
  { provider: "orcarouter", model: "z-ai/glm-5.3-flash-free" },
  { provider: "groq", model: "openai/gpt-oss-120b" },
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

// v0.23.8 — rank candidates by installable prefix.
// Discovery returns 200+ candidates from all 14 adapters. Sending all to
// the LLM blows context (proposal.created with candidates:207, model_used:null
// because every LLM call failed). Cap to top 15 installable-first.
const PREFIX_RANK = {
  "dsh_plugin:": 110,
  "npm:": 100, "pypi:": 95, "agentskills:": 90, "clawhub:": 85,
  "hermes_atlas:": 80, "mcp:": 75, "crates:": 70, "gomod:": 65,
  "maven:": 60, "nuget:": 55, "huggingface:": 50,
};

export function rankCandidates(candidates, intent) {
  // v0.24.3 — skip type-only packages before scoring.
  // v0.52.11 — also skip browser-only packages (-wasm, worker). Those need
  // Worker/WebAssembly globals Node doesn't provide; trial always fails.
  // v0.56.44 — direction-aware ranking
  const _targetWord = (() => {
    const _h = String(intent || "").toLowerCase();
    const _m = _h.match(/(?:to|into|as)\s+([a-z][a-z0-9]{2,15})\b/);
    return _m ? _m[1] : null;
  })();
  const _READER_ONLY = /\b(?:reader|read|parse|decode|load|inspect)\b/i;
  const _WRITER_WORD = /\b(?:write|writer|create|encode|save|convert|generate|output|produce|compose|export)\b/i;
  const filtered = candidates.filter(c =>
    !isTypeOnlyPackage(c && c.id) && !isBrowserOnlyPackage(c && c.id)
  );
  const scored = filtered.map((c, idx) => {
    const id = String(c.id || "");
    let rank = 10;
    for (const [pre, r] of Object.entries(PREFIX_RANK)) {
      if (id.startsWith(pre)) { rank = r; break; }
    }
    const stars = Number(c.stars) || 0;
    const _synth = isSynthesizable(c);
    // v0.29.1 — synthesizable candidates rank above unsynthesizable at every
    // prefix level. A crates candidate with 1000 stars still loses to any
    // synthesizable candidate. Prevents stall on unbuildable sources.
    let _bonus = 0;
    const _hay = (id + " " + String(c.name || "") + " " + String(c.description || "")).toLowerCase();
    if (_targetWord) {
      if (id.toLowerCase().includes(":" + _targetWord)) _bonus += 25;
      else if (_hay.includes(_targetWord)) _bonus += 10;
    }
    const _desc = String(c.description || "");
    if (_desc && _READER_ONLY.test(_desc) && !_WRITER_WORD.test(_desc)) _bonus -= 30;
    return { c, rank, stars, idx, synth: _synth ? 1 : 0, bonus: _bonus };
  });
  scored.sort((a, b) => {
    if (b.synth !== a.synth) return b.synth - a.synth;
    if ((b.bonus || 0) !== (a.bonus || 0)) return (b.bonus || 0) - (a.bonus || 0);
    if (b.rank !== a.rank) return b.rank - a.rank;
    if (b.stars !== a.stars) return b.stars - a.stars;
    return a.idx - b.idx;
  });
  return scored.map(x => x.c);
}

// v0.56.45 — raise 15 -> 30. 15-cap silently pruned crates/gomod/maven/nuget.
// 30 candidates x ~200 tokens = 6K input, still safe under groq's 8K TPM if
// fallback triggers. AnyRouter's 1M context handles it trivially.
const MAX_LLM_CANDIDATES = 30;

// v0.24.3 — filter type-only packages (@types/*, types-*) before ranking.
// They have no runtime code, only .d.ts files, so synthesis produces a
// handler that "passes" trial against an empty implementation. This bit
// us when types_react-native-pdf-lib got adopted as a capability.
function isTypeOnlyPackage(id) {
  if (!id) return false;
  const s = String(id);
  if (s.includes("@types/")) return true;
  if (s.startsWith("types-") || s.startsWith("types:") || s.startsWith("types_")) return true;
  if (/\/types\//i.test(s)) return true;
  return false;
}

// v0.52.11 — browser-only packages. Contain Web Worker or WebAssembly
// APIs that Node doesn't provide (no Worker global, no browser wasm loader).
// Trial fails with `Worker is not defined` on every attempt. Reject before
// the LLM sees them, or before fallbackPicks.
function isBrowserOnlyPackage(id) {
  if (!id) return false;
  const s = String(id).toLowerCase();
  if (s.includes("-wasm") || s.includes("/wasm")) return true;
  if (s.includes("worker")) return true;
  return false;
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
  const ranked = rankCandidates(candidates, gap.wanted_description || gap.wanted_id || "");
  // v0.52.11 — filter by isSynthesizable before auto-pick. Prior version chose
  // via PREFIX_RANK alone, which still qualified hermes_atlas (rank 80) even
  // after isSynthesizable was marked false. Result: fallback picked a skill
  // candidate that always threw skill_body_missing.
  const _synthOk = ranked.filter(c => isSynthesizable(c));
  const pool = _synthOk.length > 0 ? _synthOk : ranked;
  const installable = pool.find(c => {
    const id = String(c.id || "");
    return Object.keys(PREFIX_RANK).some(pre => id.startsWith(pre));
  });
  return {
    candidates: pool.slice(0, MAX_LLM_CANDIDATES).map(c => ({
      id: c.id,
      fit: null,
      confidence: installable && c.id === installable.id ? "medium" : "unknown",
      why: c.description || "(no description)",
      risks: [],
    })),
    recommended_id: installable?.id || null,
    summary: `Found ${candidates.length} candidate(s) for gap "${gap.wanted_kind || gap.id}". LLM analysis unavailable — ` +
             (installable
               ? `auto-picking installable candidate "${installable.id}" for trial (trial will verify).`
               : "sending raw candidates for review."),
    llm_failed: true,
  };
}

async function analyze(deps, gap, candidates) {
  const ranked = rankCandidates(candidates, gap.wanted_description || gap.wanted_id || "").slice(0, MAX_LLM_CANDIDATES);
  const messages = [
    { role: "system", content: systemPrompt() },
    { role: "user",   content: userPrompt(gap, ranked) },
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

// v0.51.0 — always auto-decide. The approval gate is gone. Every proposal
// is written in state "decided" with the reasoner's recommended candidate
// pre-approved. Trial is the safety net — a bad pick fails synth or trial,
// candidate marked failed, gap stays open, next tick retries. The user
// gets one notification per adoption attempt with candidates + outcome.
//
// If the LLM returned no viable candidate (recommended_id null), the
// proposal is still "decided" but with empty decisions. adopt() then
// writes it as rejected without an attempt, and skips the email — no
// notification for "nothing found" gaps, only for actual attempts.
function buildDecisions(analysis) {
  if (!analysis || !analysis.recommended_id) return { recommended: null, decisions: {} };
  const rec = (analysis.candidates || []).find(c => c.id === analysis.recommended_id);
  if (!rec) return { recommended: null, decisions: {} };
  return {
    recommended: rec,
    decisions: {
      [rec.id]: {
        decision: "approved",
        at: Date.now(),
        auto: true,
        confidence: rec.confidence,
        fit: rec.fit,
      },
    },
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

  // v0.29.1 — if every candidate comes from a search-only source, reject
  // the proposal early. Prevents wasting 5-10s on a synthesis attempt for a
  // candidate that has no runtime kernel. Reasoner will retry with a
  // different query on the next gap tick.
  const _synthCount = candidates.filter(c => isSynthesizable(c)).length;
  if (_synthCount === 0) {
    const _sources = [...new Set(candidates.map(c => c.source || "(unknown)"))];
    ctx.events.emit("proposal.rejected_no_synthesizable_candidates", {
      gap_id: gap.id, candidate_count: candidates.length, sources: _sources,
    });
    return {
      output: {
        proposal_id: null, gap_id: gap.id, rejected: true,
        reason: "no_synthesizable_candidates",
        sources: _sources,
        note: "Discovery found candidates but synthesis has no runtime for any source. Sources: " + _sources.join(", ") + ". Reasoner should retry with a query targeting a synthesizable source (npm, pypi, agentskills_code, clawhub, or github repos).",
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

  // v0.51.0 — always auto-decide. Every proposal goes to state "decided".
  const { recommended: chosen, decisions: proposalDecisions } = buildDecisions(analysis);
  const now = Date.now();

  const proposalNode = {
    id: proposalId,
    kind: "proposal",
    state: "decided",
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
    decisions: proposalDecisions,
    auto_approved: Boolean(chosen),
    created_at: now,
    updated_at: now,
  };
  ctx.graph.putCapability(proposalNode);
  try {
    link(ctx.graph, {
      from: proposalId,
      to: gap.id,
      relation: RELATIONS.PROPOSAL_SATISFIES_GAP,
      meta: { auto_approved: Boolean(chosen) },
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
    auto_approved: Boolean(chosen),
  });

  // v0.51.0 — no notification from proposal. adopt() sends the single
  // notification per decision (candidates + chosen + outcome). Prior
  // version sent a "pending" email that never got actioned.
  const notified = false;
  const deliveredVia = null;
  const fallbackUsed = false;

  ctx.events.emit("proposal.auto_decided", {
    proposal_id: proposalId,
    gap_id: gap.id,
    gap_wanted_kind: gap.wanted_kind,
    recommended_id: chosen?.id || null,
    confidence: chosen?.confidence || null,
    candidate_count: analysis.candidates?.length || 0,
  });

  return {
    output: {
      proposal_id: proposalId,
      gap_id: gap.id,
      candidates_reviewed: analysis.candidates.length,
      recommended_id: analysis.recommended_id || null,
      model_used: modelUsed,
      provider_used: providerUsed,
      auto_approved: Boolean(chosen),
      auto_approved_candidate_id: chosen?.id || null,
      notified,
      delivered_via: deliveredVia,
      fallback_used: fallbackUsed,
      approval_urls_available: Boolean(APPROVAL_BASE_URL),
    },
    cost: { time_ms: Date.now() - started },
  };
}
