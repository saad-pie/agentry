// agentry/src/handlers/agentry.reason.deep.mjs
//
// Deep reasoning on Groq with native tool use.
//
// The model can call web_search and fetch_url before answering. It
// iterates in a loop until it stops calling tools and produces the
// final JSON. No DSH, no gateway, no queue — just the model and a
// tool loop we fully control.
//
// Same input/output contract as agentry.reason and
// agentry.reason.harness. Callers can drop this in place of either.
//
//   input:  { failure, attempted?, intent?, workspace_id?, session_id? }
//   output: { analysis, missing, immediate_action, gap_recorded,
//             suggestions, model_used, turns, tools_used }

import { recordGap } from "./agentry.capability_gap.mjs";

const PROVIDER = process.env.AGENTRY_DEEP_PROVIDER || "groq";
const MODEL = process.env.AGENTRY_DEEP_MODEL || "openai/gpt-oss-120b";
const FALLBACK_MODEL = process.env.AGENTRY_DEEP_FALLBACK_MODEL || "openai/gpt-oss-20b";
const MAX_TURNS = Number(process.env.AGENTRY_DEEP_MAX_TURNS || "5");
const MAX_TOOL_CALLS_PER_TURN = 4;

// Tool schemas the model can call. Keep this small and precise —
// every tool is a surface the model can waste a turn on.
const TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web. Returns a list of {title, url, snippet} objects. Use this to look up libraries, projects, or error messages you don't recognize.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." },
          limit: { type: "number", description: "Max results, default 8." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description:
        "Fetch the plain-text content of a URL. Returns up to 20000 characters. Use this to read a GitHub README, an npm page, or a docs page after finding it via web_search.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http(s) URL." },
        },
        required: ["url"],
      },
    },
  },
];

function systemPrompt() {
  return `You are agentry's deep reasoner.

An agent hit a wall. Your job: figure out what actually happened, name
the missing capability if there is one, and give a concrete next step.

You have tools. Use them. Do not answer from memory when a search
would tell you the truth. Specifically:
  - If you don't recognize a project name in the failure, web_search it.
  - If a specific library or repo is named, fetch_url its README.
  - If the failure mentions an error you've never seen, search the error.
  - Iterate: search → read → think → answer. Two rounds is often enough.

When you have enough, STOP calling tools and reply with ONLY a JSON
object, no prose, no fences:

{
  "analysis": "<2-3 sentences: what actually happened and why>",
  "missing": {
    "kind": "<bua|cua|mua|memory|tool|notify|web|harness|unknown>",
    "wanted_id": "<dotted capability id, e.g. bua.browser>",
    "confidence": "high" | "medium" | "low"
  } | null,
  "immediate_action": "<one concrete thing the caller can try right now, or 'none'>",
  "suggestions": ["<up to 3 short candidate fixes / projects>"]
}

Rules:
- Output only the JSON object as your final message.
- If the failure is a missing capability, fill in "missing".
- If it's a retryable error or an in-session bug, set "missing" to null
  and describe the retry strategy in "immediate_action".
- Prefer naming a specific project and version over generic advice.
- If you searched, name what you found in "analysis".`;
}

function userPrompt(input) {
  const { failure, attempted, intent, workspace_id, session_id } = input || {};
  const lines = [];
  if (intent) lines.push(`USER INTENT: ${intent}`);
  if (workspace_id) lines.push(`WORKSPACE: ${workspace_id}`);
  if (session_id) lines.push(`SESSION: ${session_id}`);
  if (attempted) lines.push(`WHAT WAS ATTEMPTED: ${JSON.stringify(attempted)}`);
  lines.push("");
  lines.push("FAILURE / CONTEXT:");
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

// ─── tool implementations ───────────────────────────────────────────

async function runWebSearch(ctx, args) {
  const query = String(args?.query || "").slice(0, 500);
  const limit = Math.min(Number(args?.limit || 8), 20);
  if (!query) return { error: "web_search: query is required" };

  const res = await ctx.invoke("discovery.web_search", { query, limit },
    { tenant: "local", by: "agentry.reason.deep" });
  if (!res.ok) {
    return { error: `web_search failed: ${res.error.code}: ${res.error.message}` };
  }
  const candidates = res.output?.candidates || [];
  return {
    query,
    results: candidates.slice(0, limit).map(c => ({
      title: c.name || null,
      url: c.url || null,
      snippet: (c.description || c.snippet || "").slice(0, 300),
    })),
  };
}

async function runFetchUrl(ctx, args) {
  const url = String(args?.url || "").trim();
  if (!url || !/^https?:\/\//.test(url)) {
    return { error: "fetch_url: url must be absolute http(s)" };
  }

  // Run inside a kernel session so we don't depend on Node's fetch
  // handling of arbitrary HTML.
  const session = "deep_fetch_" + Date.now().toString(36);

  const script = `
    const url = process.env.FETCH_URL;
    const res = await fetch(url, {
      headers: { "user-agent": "agentry-deep-reasoner/0.1" },
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    process.stdout.write(JSON.stringify({
      status: res.status,
      content_type: res.headers.get("content-type") || "",
      text: text.slice(0, 20000),
    }));
  `;

  const r = await ctx.invoke("agentry.os", {
    action: "node.run",
    session,
    code: script,
    env: { FETCH_URL: url },
    timeout_ms: 20000,
  }, { tenant: "local", by: "agentry.reason.deep" });

  if (!r.ok) {
    return { error: `fetch_url kernel call failed: ${r.error.code}: ${r.error.message}` };
  }

  const raw = String(r.output?.result?.stdout || "");
  if (!raw.trim()) return { error: "fetch_url: no output" };

  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { error: "fetch_url: bad response shape" }; }

  // Strip HTML tags if the response is HTML. Crude but sufficient.
  let text = parsed.text || "";
  if (/text\/html/i.test(parsed.content_type)) {
    text = text
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  return {
    url,
    status: parsed.status,
    content_type: parsed.content_type,
    text: text.slice(0, 20000),
  };
}

async function executeTool(ctx, call) {
  const name = call?.function?.name;
  let args = {};
  try { args = JSON.parse(call?.function?.arguments || "{}"); }
  catch (e) { return { error: `tool args not JSON: ${e.message}` }; }

  try {
    if (name === "web_search") return await runWebSearch(ctx, args);
    if (name === "fetch_url") return await runFetchUrl(ctx, args);
    return { error: `unknown tool: ${name}` };
  } catch (e) {
    return { error: `tool ${name} threw: ${e.message}` };
  }
}

// ─── the handler ────────────────────────────────────────────────────

export default async function agentryReasonDeep(input, ctx) {
  const { failure, intent, workspace_id, session_id } = input || {};
  if (!failure && !intent) throw new Error("agentry.reason.deep requires failure or intent");
  if (typeof ctx.invoke !== "function") throw new Error("agentry.reason.deep requires ctx.invoke");

  const started = Date.now();
  const messages = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: userPrompt(input) },
  ];

  const toolsUsed = [];
  const attempts = [];
  let finalContent = null;
  let modelUsed = null;

  // Try the primary model; if the entire loop fails to produce JSON,
  // retry once on the fallback model before giving up.
  const modelChain = [MODEL];
  if (FALLBACK_MODEL && FALLBACK_MODEL !== MODEL) modelChain.push(FALLBACK_MODEL);

  outer:
  for (const model of modelChain) {
    messages.length = 2; // reset conversation on model change
    toolsUsed.length = 0;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const r = await ctx.invoke("llm.openai_compat", {
        provider: PROVIDER,
        model,
        messages,
        tools: TOOLS,
        tool_choice: "auto",
        temperature: 0.1,
        max_tokens: 4000,
      }, { tenant: "local", by: "agentry.reason.deep" });

      if (!r.ok) {
        attempts.push({ model, turn, ok: false, code: r.error.code, message: r.error.message });
        ctx.events.emit("agentry.reason.deep.llm_failed", {
          model, turn, code: r.error.code, message: r.error.message,
        });
        continue outer;
      }

      modelUsed = r.output.model || model;
      const toolCalls = Array.isArray(r.output.tool_calls) ? r.output.tool_calls : [];

      // No tool calls → this is the model's final answer.
      if (toolCalls.length === 0) {
        finalContent = String(r.output.content || "");
        attempts.push({ model, turn, ok: true, final: true });
        break outer;
      }

      // Append the assistant's tool-call message to the conversation.
      messages.push({
        role: "assistant",
        content: r.output.content || null,
        tool_calls: toolCalls,
      });

      // Execute each tool call and append results.
      const calls = toolCalls.slice(0, MAX_TOOL_CALLS_PER_TURN);
      for (const call of calls) {
        const toolName = call?.function?.name || "unknown";
        toolsUsed.push(toolName);
        const result = await executeTool(ctx, call);
        ctx.events.emit("agentry.reason.deep.tool_called", {
          tool: toolName,
          url: result.url || null,
          query: result.query || null,
          error: result.error || null,
          result_size: JSON.stringify(result).length,
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: toolName,
          content: JSON.stringify(result).slice(0, 20000),
        });
      }
    }

    if (finalContent) break;
  }

  if (!finalContent) {
    ctx.events.emit("agentry.reason.deep.no_final_answer", {
      attempts,
      turns: MAX_TURNS,
      model_chain: modelChain,
    });
    throw new Error(
      `agentry.reason.deep: no final answer after ${MAX_TURNS} turns on ${modelChain.length} model(s). Last attempt: ${JSON.stringify(attempts[attempts.length - 1] || null)}`
    );
  }

  const parsed = parseJson(finalContent);
  if (!parsed) {
    ctx.events.emit("agentry.reason.deep.unparseable", {
      preview: finalContent.slice(0, 300),
    });
    throw new Error(
      `agentry.reason.deep: could not parse JSON from final answer. Raw: ${finalContent.slice(0, 300)}`
    );
  }

  // Record the gap.
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
          reason: `deep reasoning: ${parsed.analysis?.slice(0, 200) || "unspecified"}`,
          example_task_id: session_id || null,
        }
      );
      gap_id = gap.id;
      ctx.events.emit("agentry.reason.deep.gap_recorded", {
        gap_id,
        wanted_kind: gap.wanted_kind,
        hits: gap.hits,
      });
    } catch (e) {
      ctx.events.emit("agentry.reason.deep.gap_record_failed", {
        error: e.message,
        wanted_id: parsed.missing.wanted_id,
      });
    }
  }

  ctx.events.emit("agentry.reason.deep.completed", {
    model_used: modelUsed,
    turns: attempts.filter(a => a.ok).length,
    tools_used: toolsUsed,
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
      model_used: `${PROVIDER}/${modelUsed || MODEL}`,
      tools_used: toolsUsed,
    },
    cost: { time_ms: Date.now() - started, http_calls: attempts.length + toolsUsed.length },
  };
}
