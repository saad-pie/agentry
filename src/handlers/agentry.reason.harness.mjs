// agentry/src/handlers/agentry.reason.harness.mjs
//
// The reasoning capability backed by the DeepSeek Harness itself.
//
// Same input/output contract as agentry.reason. Different backend:
// instead of asking a raw LLM one question, we submit a task to the
// harness, which can search, fetch, read, iterate — then answer.
//
// Recursion is prevented by submitting to a dedicated workspace that
// has no AGENTS.md. The harness session running there has no bridge
// instructions, so it cannot call agentry back.
//
// v0.15.14: pass provider + model explicitly. The DSH gateway pins a
// workspace to a model on first submit; without a provider the default
// was unorouter/gpt-oss-20b:free, which returns empty output. The
// reasoner-groq workspace is fresh, so the first submit pins it to
// groq/openai/gpt-oss-120b permanently.
//
// Contract:
//   input:  { failure, attempted?, intent?, workspace_id?, session_id? }
//   output: { analysis, missing, immediate_action, gap_recorded, suggestions, model_used, harness_task_id }

import { recordGap } from "./agentry.capability_gap.mjs";

const DEFAULT_WORKSPACE_NAME = process.env.AGENTRY_REASONER_WORKSPACE || "reasoner-groq";
const DEFAULT_PROVIDER = process.env.AGENTRY_REASONER_PROVIDER || "groq";
const DEFAULT_MODEL = process.env.AGENTRY_REASONER_MODEL || "openai/gpt-oss-120b";
const MAX_WAIT_MS = 120000;
const POLL_INTERVAL_MS = 3000;

function systemPromptForHarness() {
  return `You are agentry's reasoning layer.

The DeepSeek Harness just hit a wall, and the meta-system (agentry) is asking you to think about why. You are NOT acting as the user's agent in this task. You are acting as a diagnostician.

You have tools available in this session. USE THEM. Before answering:
  - Search the web if you need to know what tool or library solves this.
  - Fetch a page if you need current documentation.
  - Read files if they're referenced in the failure.
  - Reason step by step.

Do NOT call agentry. You are the reasoner, not the requester. No curl to port 7863. That would recurse.

When you're ready, respond with ONLY a single JSON object, nothing else:

{
  "analysis": "<2-3 sentences on what actually happened and why>",
  "missing": {
    "kind": "<one of: bua (browser), cua (computer), mua (mobile), memory, tool, notify, web, harness, unknown>",
    "wanted_id": "<dotted capability id, e.g. bua.browser>",
    "confidence": "high" | "medium" | "low"
  } | null,
  "immediate_action": "<one concrete thing the harness can try right now, or 'none'>",
  "suggestions": ["<up to 3 short candidate fixes / projects>"]
}

Rules:
- Output only the JSON. No prose before or after.
- If the failure is due to a missing capability, fill in "missing".
- If it's a retryable error or a bug in the caller's code, set "missing"
  to null and put the retry strategy in "immediate_action".
- Be specific. Prefer naming a real project with a version over
  generic advice. "playwright@1.50" beats "a browser automation library".
- If you searched, name what you found.`;
}

function buildTaskPrompt(input) {
  const { failure, attempted, intent, workspace_id, session_id } = input || {};
  const lines = [];
  lines.push(systemPromptForHarness());
  lines.push("");
  lines.push("────");
  lines.push("");
  if (intent) lines.push(`USER INTENT: ${intent}`);
  if (workspace_id) lines.push(`CALLER WORKSPACE: ${workspace_id}`);
  if (session_id) lines.push(`CALLER SESSION: ${session_id}`);
  if (attempted) lines.push(`WHAT WAS ATTEMPTED: ${JSON.stringify(attempted)}`);
  lines.push("");
  lines.push("FAILURE / CONTEXT FROM HARNESS:");
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

export default async function agentryReasonHarness(input, ctx) {
  const { failure, intent, workspace_id, session_id } = input || {};
  if (!failure && !intent) throw new Error("agentry.reason.harness requires failure or intent");

  if (typeof ctx.invoke !== "function") {
    throw new Error("agentry.reason.harness requires ctx.invoke");
  }

  const started = Date.now();

  // v0.56.42 — replaced legacy agent.dsh + agent.dsh_poll with a
  // direct synchronous call to agentry.agent.dsh (headless). Legacy path
  // silently returned "done" with no real output. Headless returns
  // final/messages/tool_calls synchronously.
  const prompt = buildTaskPrompt(input);
  const result = await ctx.invoke("agentry.agent.dsh", {
    prompt,
    timeout_ms: MAX_WAIT_MS,
  }, { tenant: "local", by: "agentry.reason.harness" });

  if (!result.ok) {
    throw new Error(
      `agentry.reason.harness: headless call failed — ${result.error.code}: ${result.error.message}`
    );
  }

  const taskId = result.output.session_id || ("harness_" + Date.now().toString(36));

  ctx.events.emit("agentry.reason.harness.submitted", {
    ksess: result.output.session_id || null,
    workspace_id: workspace_id || null,
    session_id: session_id || null,
  });

  let rawOutput = String(result.output.final || "");
  if ((!rawOutput || rawOutput.trim() === "") && Array.isArray(result.output.messages)) {
    for (let i = result.output.messages.length - 1; i >= 0; i--) {
      const m = result.output.messages[i];
      if (m?.role === "assistant" && typeof m.text === "string" && m.text.trim()) {
        rawOutput = m.text;
        break;
      }
    }
  }

  if (!rawOutput || typeof rawOutput !== "string" || rawOutput.trim() === "") {
    ctx.events.emit("agentry.reason.harness.empty_output", {
      ksess: result.output.session_id || null,
      messages_count: Array.isArray(result.output.messages) ? result.output.messages.length : 0,
    });
    throw new Error("agentry.reason.harness: harness returned empty output");
  }

  const parsed = parseJson(rawOutput);
  if (!parsed) {
    throw new Error(
      `agentry.reason.harness: could not parse JSON from harness output. Raw: ${rawOutput.slice(0, 300)}`
    );
  }

  // 4. Record the gap.
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
          reason: `harness deep reasoning: ${parsed.analysis?.slice(0, 200) || "unspecified"}`,
          example_task_id: session_id || null,
        }
      );
      gap_id = gap.id;
      ctx.events.emit("agentry.reason.harness.gap_recorded", {
        gap_id,
        wanted_kind: gap.wanted_kind,
        hits: gap.hits,
      });
    } catch (e) {
      ctx.events.emit("agentry.reason.harness.gap_record_failed", {
        error: e.message,
        wanted_id: parsed.missing.wanted_id,
      });
    }
  }

  ctx.events.emit("agentry.reason.harness.completed", {
    task_id: taskId,
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
      model_used: `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`,
      harness_task_id: taskId,
    },
    cost: { time_ms: Date.now() - started, http_calls: 2 },
  };
}
