// agentry/src/handlers/agentry.reason.mjs
// The reasoning capability the harness calls when it hits a wall.
//
// Contract:
//   input:  { failure, attempted?, intent?, workspace_id?, session_id? }
//   output: { analysis, missing, immediate_action, gap_recorded, suggestions }
//
// Speed: uses llm.openai_compat directly (fast, ~2s).
// The gap is recorded synchronously (cheap). The proposal is generated
// later by the discovery loop, NOT during this call.

import { recordGap } from "./agentry.capability_gap.mjs";

const REASONING_MODEL = process.env.AGENTRY_REASON_MODEL || "space-bunny-alpha:free";

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

  // 1. Ask the LLM to reason about the failure.
  const messages = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: userPrompt(input) },
  ];

  const llmRes = await ctx.invoke("llm.openai_compat", {
    model: REASONING_MODEL,
    messages,
    temperature: 0.1,
    max_tokens: 800,
    accept_from: null,   // permissive — provider routes to whatever free model
  }, { tenant: "local", by: "agentry.reason" });

  if (!llmRes.ok) {
    throw new Error(`agentry.reason: LLM call failed — ${llmRes.error.code}: ${llmRes.error.message}`);
  }

  const parsed = parseJson(llmRes.output.content) || {
    analysis: "LLM returned unparseable output; no structured analysis available.",
    missing: null,
    immediate_action: "retry once, then report the limitation to the user",
    suggestions: [],
    _parse_failed: true,
    _raw: String(llmRes.output.content).slice(0, 500),
  };

  // 2. If a missing capability was identified, record the gap NOW.
  //    The discovery loop will propose a fix on its next tick.
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
      ctx.events.emit("agentry.reason.gap_record_failed", { error: e.message, wanted_id: parsed.missing.wanted_id });
    }
  }

  ctx.events.emit("agentry.reason.completed", {
    workspace_id: workspace_id || null,
    session_id: session_id || null,
    missing: parsed.missing?.wanted_id || null,
    gap_id,
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
    },
    cost: { time_ms: Date.now() - started },
  };
}
