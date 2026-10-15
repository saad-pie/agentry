// agentry/src/handlers/agentry.reason.mjs
// The reasoning capability the harness calls when it hits a wall.
//
// v0.15.21: model chain reordered to match agentry.reason.deep.
// qwen first (tool-capable, non-reasoning, returns real content on
// Groq), then gemini via the atria proxy, then the gpt-oss models
// last. The old order led with gpt-oss-120b, which returns empty
// content on the tool-use path — the deep reasoner documents this
// exact failure mode and the fast path had never been reconciled.
// max_tokens stays at 3000.

import { recordGap } from "./agentry.capability_gap.mjs";

function buildModelChain(input) {
  const chain = [];
  if (input?.model && typeof input.model === "string" && input.model.length > 0) {
    chain.push({ provider: null, model: input.model, source: "harness" });
  }
  chain.push(
    { provider: "groq", model: "qwen/qwen3.8-27b", source: "primary" },
    { provider: "google", model: "gemini-2.5-flash", source: "fallback" },
    { provider: "groq", model: "openai/gpt-oss-120b", source: "fallback" },
    { provider: "groq", model: "openai/gpt-oss-20b", source: "fallback" },
  );
  const seen = new Set();
  return chain.filter(c => {
    if (seen.has(c.model)) return false;
    seen.add(c.model);
    return true;
  });
}

function systemPrompt() {
  return `You are agentry, the reasoning layer behind an autonomous agent system.
The DeepSeek Harness just hit a wall and is asking you for help.

Your job: figure out what went wrong, name the missing capability (if any),
and give the harness a concrete immediate action it can take RIGHT NOW.

Return ONLY a JSON object with this shape, nothing else:
{
  "analysis": "<2-3 sentences on what actually happened and why>",
  "missing": {
    "kind": "<one of: bua (browser), cua (computer), mua (mobile), memory, tool, notify, web, harness, unknown>",
    "wanted_id": "<dotted capability id, e.g. bua.browser>",
    "confidence": "high" | "medium" | "low"
  } | null,
  "immediate_action": "<one concrete thing the harness can try in this session, or 'none'>",
  "suggestions": ["<up to 3 short candidate fixes / projects>"]
}

Rules:
- Output only JSON. No prose.
- If the failure is due to a missing capability, fill in "missing".
- If the failure is a bug or a retry-able error, set "missing" to null and put the retry strategy in "immediate_action".
- Be specific. Prefer named projects over generic advice.`;
}

function userPrompt(input) {
  const { failure, attempted, intent, workspace_id, session_id } = input || {};
  const lines = [];
  if (intent) lines.push(`USER INTENT: ${intent}`);
  if (workspace_id) lines.push(`WORKSPACE: ${workspace_id}`);
  if (session_id) lines.push(`SESSION: ${session_id}`);
  if (attempted) lines.push(`WHAT WAS ATTEMPTED: ${JSON.stringify(attempted)}`);
  lines.push("");
  lines.push(`FAILURE / CONTEXT FROM HARNESS:`);
  lines.push(typeof failure === "string" ? failure : JSON.stringify(failure, null, 2));
  return lines.join("\n");
}

function parseJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  s = s.slice(first, last + 1);
  try { return JSON.parse(s); } catch { return null; }
}

export default async function agentryReason(input, ctx) {
  const { failure, attempted, intent, workspace_id, session_id } = input || {};
  if (!failure && !intent) throw new Error("agentry.reason requires failure or intent");

  if (typeof ctx.invoke !== "function") {
    throw new Error("agentry.reason requires ctx.invoke");
  }

  const started = Date.now();
  const messages = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: userPrompt(input) },
  ];

  const chain = buildModelChain(input);
  const attempts = [];
  let parsed = null;
  let modelUsed = null;
  let chainSource = null;

  for (const { provider, model, source } of chain) {
    try {
      const llmRes = await ctx.invoke("llm.openai_compat", {
        provider,
        model,
        messages,
        temperature: 0.1,
        max_tokens: 3000,
        accept_from: null,
      }, { tenant: "local", by: "agentry.reason" });

      if (!llmRes.ok) {
        attempts.push({
          provider, model, source, ok: false,
          code: llmRes.error.code, message: llmRes.error.message,
        });
        ctx.events.emit("agentry.reason.llm_failed", {
          provider, model, source,
          code: llmRes.error.code, message: llmRes.error.message,
        });
        continue;
      }

      const p = parseJson(llmRes.output.content);
      if (p) {
        parsed = p;
        modelUsed = llmRes.output.model || model;
        chainSource = source;
        attempts.push({ provider, model, source, ok: true });
        break;
      }
      attempts.push({ provider, model, source, ok: false, reason: "unparseable" });
      ctx.events.emit("agentry.reason.llm_unparseable", {
        provider, model, source,
        content: String(llmRes.output.content).slice(0, 300),
      });
    } catch (e) {
      attempts.push({ provider, model, source, ok: false, error: e.message });
      ctx.events.emit("agentry.reason.llm_threw", { provider, model, source, error: e.message });
    }
  }

  if (!parsed) {
    ctx.events.emit("agentry.reason.all_models_failed", {
      workspace_id: workspace_id || null,
      session_id: session_id || null,
      attempts,
    });
    throw new Error(
      `agentry.reason: all ${chain.length} models in the fallback chain failed. ` +
      `Last attempt: ${JSON.stringify(attempts[attempts.length - 1] || null)}`
    );
  }

  // Record the gap if a missing capability was identified.
  let gap_id = null;
  if (parsed.missing && parsed.missing.wanted_id) {
    const key = `gap:${parsed.missing.wanted_id}`;
    try {
      const gap = recordGap(
        { graph: ctx.graph, events: ctx.events },
        {
          key,
          wanted_kind: parsed.missing.kind || "unknown",
          wanted_id: parsed.missing.wanted_id,
          reason: `harness reasoning: ${parsed.analysis?.slice(0, 200) || "unspecified"}`,
          example_task_id: session_id || null,
        }
      );
      gap_id = gap.id;

      ctx.events.emit("agentry.reason.gap_recorded", {
        gap_id,
        wanted_kind: gap.wanted_kind,
        hits: gap.hits,
        workspace_id: workspace_id || null,
        session_id: session_id || null,
      });
    } catch (e) {
      ctx.events.emit("agentry.reason.gap_record_failed", {
        error: e.message, wanted_id: parsed.missing.wanted_id,
      });
    }
  }

  // Checkpoint on gap record.
  if (gap_id) {
    try {
      await ctx.invoke("agentry.checkpoint", {
        reason: `reason:gap_recorded:${gap_id}`,
      }, { tenant: "local", by: "agentry.reason" });
    } catch (e) {
      ctx.events.emit("reason.checkpoint_failed", { gap_id, error: e.message });
    }
  }

  ctx.events.emit("agentry.reason.completed", {
    workspace_id: workspace_id || null,
    session_id: session_id || null,
    missing: parsed.missing?.wanted_id || null,
    gap_id,
    model_used: modelUsed,
    chain_source: chainSource,
    attempts_count: attempts.length,
    ms: Date.now() - started,
  });

  return {
    output: {
      analysis: parsed.analysis,
      missing: parsed.missing,
      immediate_action: parsed.immediate_action,
      suggestions: parsed.suggestions || [],
      gap_recorded: gap_id,
      note: gap_id
        ? "A capability gap was recorded. A proposal will be generated in the background and emailed for approval."
        : "No gap recorded — this looks like a retry or in-session fix.",
      model_used: modelUsed,
      chain_source: chainSource,
    },
    cost: { time_ms: Date.now() - started },
  };
}
