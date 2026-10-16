// agentry/src/handlers/agentry.reason.deep.mjs
//
// Deep reasoning on Groq with native tool use.
//
// v0.15.18: qwen/qwen3.8-27b on Groq is the only live non-reasoning
// tool-capable model. openai/gpt-oss-20b and 120b both emit to a
// "reasoning" field and return empty content, breaking the tool loop.
//
// v0.15.21: emit agentry.reason.deep.model_switched when the outer
// loop advances to the next model.
//
// v0.15.26: grounded capability resolution. The reasoner sees the
// current graph in its prompt, and any invented wanted_id is resolved
// against the graph before acting (exact -> prefix -> none).
//
// v0.15.27: the "missing vs existing" decision was inverted. Before,
// the prompt told the model to set missing to null when an existing
// capability solved the problem. That stranded the caller: nothing
// structured for it to invoke. New rule: if an existing capability
// solves the problem, still put its exact id in missing.wanted_id.
// missing:null now means "no capability -- retryable, in-session, or
// config problem only." Also: when a prior false gap exists under the
// proposed id, retire it.

import { recordGap } from "./agentry.capability_gap.mjs";

const PROVIDER = process.env.AGENTRY_DEEP_PROVIDER || "groq";
const MODEL = process.env.AGENTRY_DEEP_MODEL || "qwen/qwen3.8-27b";
const FALLBACK_PROVIDER = process.env.AGENTRY_DEEP_FALLBACK_PROVIDER || "google";
const FALLBACK_MODEL = process.env.AGENTRY_DEEP_FALLBACK_MODEL || "gemini-2.5-flash";
const MAX_TURNS = Number(process.env.AGENTRY_DEEP_MAX_TURNS || "5");
const MAX_TOOL_CALLS_PER_TURN = 4;

const INTERNAL_KINDS = new Set(["invoker", "agentry", "service"]);
const MAX_CAP_LIST = 60;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web. Returns a list of {title, url, snippet} objects. Use this to look up libraries, projects, or error messages you do not recognize.",
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
  {
    type: "function",
    function: {
      name: "discover_capability",
      description:
        "Search agentry's capability graph, the npm registry, the MCP server registry, GitHub, and the web for existing tools that could solve a problem. Returns ranked candidates with fit scores. Use this BEFORE deciding a capability is missing \u2014 the right tool may already exist somewhere.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Short description of what is needed, e.g. 'generate PDF from markdown'." },
          sources: { type: "array", items: { type: "string" }, description: "Optional subset of: local, npm, mcp, github, web." },
        },
        required: ["query"],
      },
    },
  },
];

function listLiveCapabilities(graph) {
  const out = [];
  for (const cap of graph.capabilities().values()) {
    if (cap.retired_at) continue;
    if (!cap.invoked_via) continue;
    if (INTERNAL_KINDS.has(cap.kind)) continue;
    out.push({ id: cap.id, kind: cap.kind });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out.slice(0, MAX_CAP_LIST);
}

function systemPrompt(graph) {
  const caps = listLiveCapabilities(graph);
  const capLines = caps.length
    ? caps.map(c => "  " + c.id + "  (" + c.kind + ")").join("\n")
    : "  (none)";

  return "You are agentry's deep reasoner.\n\n" +
    "An agent hit a wall. Your job: figure out what actually happened, name\n" +
    "the missing capability if there is one, and give a concrete next step.\n\n" +
    "You have tools. Use them. Do not answer from memory when a search\n" +
    "would tell you the truth. Specifically:\n" +
    "  - If you do not recognize a project name in the failure, web_search it.\n" +
    "  - If a specific library or repo is named, fetch_url its README.\n" +
    "  - If the failure mentions an error you have never seen, search the error.\n" +
    "  - Iterate: search -> read -> think -> answer. Two rounds is often enough.\n\n" +
    "=== CAPABILITIES CURRENTLY IN THE GRAPH ===\n" +
    capLines + "\n\n" +
    "CRITICAL RULE about the list above:\n" +
    "  - If an existing capability already does the job, put ITS EXACT ID\n" +
    "    in missing.wanted_id with confidence \"high\". The caller will\n" +
    "    invoke it directly. Do NOT set missing to null in this case.\n" +
    "  - Do NOT invent a new capability id that only differs in punctuation\n" +
    "    or word order from one you see in the list.\n" +
    "  - If NO existing capability solves the problem, call the\n" +
    "    discover_capability tool with a short query describing what is\n" +
    "    needed (e.g. \"generate PDF from markdown\"). It searches npm,\n" +
    "    the MCP registry, GitHub, and the web. If its top candidate\n" +
    "    scores fit >= 0.6, prefer that candidate: set missing.wanted_id\n" +
    "    to the candidate's id.\n" +
    "  - Set missing to null ONLY when no capability -- existing, discovered,\n" +
    "    or new -- would solve the problem. That means: a retryable error,\n" +
    "    an in-session bug, or a config problem (missing API key, missing\n" +
    "    credential). In those cases, describe the fix in immediate_action.\n\n" +
    "When you have enough, STOP calling tools and reply with ONLY a JSON\n" +
    "object, no prose, no fences:\n\n" +
    "{\n" +
    "  \"analysis\": \"<2-3 sentences: what actually happened and why>\",\n" +
    "  \"missing\": {\n" +
    "    \"kind\": \"<bua|cua|mua|memory|tool|notify|web|harness|unknown>\",\n" +
    "    \"wanted_id\": \"<dotted capability id, e.g. bua.browser>\",\n" +
    "    \"confidence\": \"high\" | \"medium\" | \"low\"\n" +
    "  } | null,\n" +
    "  \"immediate_action\": \"<one concrete thing the caller can try right now, or none>\",\n" +
    "  \"suggestions\": [\"<up to 3 short candidate fixes / projects>\"]\n" +
    "}\n\n" +
    "Rules:\n" +
    "- Output only the JSON object as your final message.\n" +
    "- If an existing capability solves the problem, still fill in missing\n" +
    "  with its exact wanted_id. Do NOT set missing to null. The caller\n" +
    "  reads missing.wanted_id to know what to invoke.\n" +
    "- Set missing to null ONLY for retryable errors, in-session bugs, or\n" +
    "  config problems (missing API keys, credentials).\n" +
    "- Prefer naming a specific project and version over generic advice.\n" +
    "- If you searched, name what you found in \"analysis\".";
}

function userPrompt(input) {
  const { failure, attempted, intent, workspace_id, session_id } = input || {};
  const lines = [];
  if (intent) lines.push("USER INTENT: " + intent);
  if (workspace_id) lines.push("WORKSPACE: " + workspace_id);
  if (session_id) lines.push("SESSION: " + session_id);
  if (attempted) lines.push("WHAT WAS ATTEMPTED: " + JSON.stringify(attempted));
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

function resolveWantedId(graph, wantedId) {
  if (!wantedId) return { resolved: wantedId, matched_via: "none" };
  const exact = graph.getCapability(wantedId);
  if (exact && !exact.retired_at) {
    return { resolved: wantedId, matched_via: "exact" };
  }
  const segments = String(wantedId).split(".");
  for (let i = segments.length - 1; i >= 1; i--) {
    const candidate = segments.slice(0, i).join(".");
    const cap = graph.getCapability(candidate);
    if (cap && !cap.retired_at) {
      return { resolved: candidate, matched_via: "prefix" };
    }
  }
  return { resolved: wantedId, matched_via: "none" };
}

async function runWebSearch(ctx, args) {
  const query = String(args?.query || "").slice(0, 500);
  const limit = Math.min(Number(args?.limit || 8), 20);
  if (!query) return { error: "web_search: query is required" };

  const res = await ctx.invoke("discovery.web_search", { query, limit },
    { tenant: "local", by: "agentry.reason.deep" });
  if (!res.ok) {
    return { error: "web_search failed: " + res.error.code + ": " + res.error.message };
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

  const session = "deep_fetch_" + Date.now().toString(36);

  const script = [
    "const url = process.env.FETCH_URL;",
    "const res = await fetch(url, {",
    "  headers: { \"user-agent\": \"agentry-deep-reasoner/0.1\" },",
    "  signal: AbortSignal.timeout(15000),",
    "});",
    "const text = await res.text();",
    "process.stdout.write(JSON.stringify({",
    "  status: res.status,",
    "  content_type: res.headers.get(\"content-type\") || \"\",",
    "  text: text.slice(0, 20000),",
    "}));",
  ].join("\n");

  const r = await ctx.invoke("agentry.os", {
    action: "node.run",
    session,
    code: script,
    env: { FETCH_URL: url },
    timeout_ms: 20000,
  }, { tenant: "local", by: "agentry.reason.deep" });

  if (!r.ok) {
    return { error: "fetch_url kernel call failed: " + r.error.code + ": " + r.error.message };
  }

  const raw = String(r.output?.result?.stdout || "");
  if (!raw.trim()) return { error: "fetch_url: no output" };

  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { error: "fetch_url: bad response shape" }; }

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

async function runDiscover(ctx, args) {
  const query = String(args?.query || "").slice(0, 500);
  if (!query) return { error: "discover_capability: query is required" };
  const sources = Array.isArray(args?.sources) && args.sources.length ? args.sources : undefined;
  const res = await ctx.invoke("agentry.discover", {
    query,
    sources,
    limit: 10,
  }, { tenant: "local", by: "agentry.reason.deep" });
  if (!res.ok) {
    return { error: "discover_capability failed: " + res.error.code + ": " + res.error.message };
  }
  const candidates = (res.output?.candidates || []).slice(0, 10).map(c => ({
    id: c.id,
    source: c.source,
    kind: c.kind,
    name: c.name,
    description: String(c.description || "").slice(0, 200),
    fit: c.fit,
    exists_locally: c.exists_locally,
  }));
  return {
    query,
    candidates,
    recommendation: res.output?.recommendation || null,
  };
}

async function executeTool(ctx, call) {
  const name = call?.function?.name;
  let args = {};
  try { args = JSON.parse(call?.function?.arguments || "{}"); }
  catch (e) { return { error: "tool args not JSON: " + e.message }; }

  try {
    if (name === "web_search") return await runWebSearch(ctx, args);
    if (name === "fetch_url") return await runFetchUrl(ctx, args);
    if (name === "discover_capability") return await runDiscover(ctx, args);
    return { error: "unknown tool: " + name };
  } catch (e) {
    return { error: "tool " + name + " threw: " + e.message };
  }
}

export default async function agentryReasonDeep(input, ctx) {
  const { failure, intent, workspace_id, session_id } = input || {};
  if (!failure && !intent) throw new Error("agentry.reason.deep requires failure or intent");
  if (typeof ctx.invoke !== "function") throw new Error("agentry.reason.deep requires ctx.invoke");

  const started = Date.now();
  const messages = [
    { role: "system", content: systemPrompt(ctx.graph) },
    { role: "user", content: userPrompt(input) },
  ];

  const toolsUsed = [];
  const attempts = [];
  let finalContent = null;
  let modelUsed = null;

  const modelChain = [{ provider: PROVIDER, model: MODEL }];
  if (FALLBACK_MODEL && (FALLBACK_MODEL !== MODEL || FALLBACK_PROVIDER !== PROVIDER)) {
    modelChain.push({ provider: FALLBACK_PROVIDER, model: FALLBACK_MODEL });
  }

  outer:
  for (let mi = 0; mi < modelChain.length; mi++) {
    const { provider, model } = modelChain[mi];
    messages.length = 2;
    toolsUsed.length = 0;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const r = await ctx.invoke("llm.openai_compat", {
        provider,
        model,
        messages,
        tools: TOOLS,
        temperature: 0.1,
        max_tokens: 4000,
      }, { tenant: "local", by: "agentry.reason.deep" });

      if (!r.ok) {
        attempts.push({ provider, model, turn, ok: false, code: r.error.code, message: r.error.message });
        ctx.events.emit("agentry.reason.deep.llm_failed", {
          provider, model, turn, code: r.error.code, message: r.error.message,
        });
        const next = modelChain[mi + 1];
        if (next) {
          ctx.events.emit("agentry.reason.deep.model_switched", {
            from: { provider, model },
            to: { provider: next.provider, model: next.model },
            reason: "llm_failed",
            turn,
            error_code: r.error.code,
            error_message: r.error.message,
          });
        }
        continue outer;
      }

      modelUsed = r.output.model || model;
      const toolCalls = Array.isArray(r.output.tool_calls) ? r.output.tool_calls : [];

      if (toolCalls.length === 0) {
        finalContent = String(r.output.content || "");
        attempts.push({ provider, model, turn, ok: true, final: true });
        break outer;
      }

      messages.push({
        role: "assistant",
        content: r.output.content || null,
        tool_calls: toolCalls,
      });

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

    const next = modelChain[mi + 1];
    if (next) {
      ctx.events.emit("agentry.reason.deep.model_switched", {
        from: { provider, model },
        to: { provider: next.provider, model: next.model },
        reason: "no_final_content",
        turns: MAX_TURNS,
      });
    }
  }

  if (!finalContent) {
    ctx.events.emit("agentry.reason.deep.no_final_answer", {
      attempts,
      turns: MAX_TURNS,
      model_chain: modelChain,
    });
    throw new Error(
      "agentry.reason.deep: no final answer after " + MAX_TURNS + " turns on " + modelChain.length + " model(s). Last attempt: " + JSON.stringify(attempts[attempts.length - 1] || null)
    );
  }

  const parsed = parseJson(finalContent);
  if (!parsed) {
    ctx.events.emit("agentry.reason.deep.unparseable", {
      preview: finalContent.slice(0, 300),
    });
    throw new Error(
      "agentry.reason.deep: could not parse JSON from final answer. Raw: " + finalContent.slice(0, 300)
    );
  }

  let gap_id = null;
  let existing_capability = null;
  let proposed_id = null;
  let resolved_id = null;
  let matched_via = null;

  const rawMissing = parsed.missing;
  if (rawMissing && rawMissing.wanted_id) {
    proposed_id = rawMissing.wanted_id;
    const res = resolveWantedId(ctx.graph, proposed_id);
    resolved_id = res.resolved;
    matched_via = res.matched_via;

    if (resolved_id !== proposed_id) {
      ctx.events.emit("agentry.reason.deep.wanted_id_resolved", {
        proposed: proposed_id,
        resolved: resolved_id,
        matched_via,
      });
    }

    const existing = ctx.graph.getCapability(resolved_id);
    if (existing && !existing.retired_at) {
      existing_capability = {
        id: existing.id,
        kind: existing.kind,
        handler_file: existing.handler_file || null,
        handler: existing.handler || null,
      };
      ctx.events.emit("agentry.reason.deep.existing_capability_matched", {
        proposed: proposed_id,
        matched_id: existing.id,
        matched_via,
      });
      if (proposed_id && proposed_id !== resolved_id) {
        const stale = ctx.graph.getCapability("gap:" + proposed_id);
        if (stale && !stale.retired_at) {
          try {
            ctx.graph.retireCapability("gap:" + proposed_id,
              "superseded: " + resolved_id + " already exists");
            ctx.events.emit("agentry.reason.deep.false_gap_retired", {
              retired_gap_id: "gap:" + proposed_id,
              superseded_by: resolved_id,
            });
          } catch (e) {
            ctx.events.emit("agentry.reason.deep.false_gap_retire_failed", {
              gap_id: "gap:" + proposed_id,
              error: e.message,
            });
          }
        }
      }
    } else {
      const key = "gap:" + resolved_id;
      try {
        const gap = recordGap(
          { graph: ctx.graph, events: ctx.events },
          {
            key,
            wanted_kind: rawMissing.kind || "unknown",
            wanted_id: resolved_id,
            reason: "deep reasoning: " + (parsed.analysis?.slice(0, 200) || "unspecified"),
            example_task_id: session_id || null,
          }
        );
        gap_id = gap.id;
        ctx.events.emit("agentry.reason.deep.gap_recorded", {
          gap_id,
          wanted_kind: gap.wanted_kind,
          hits: gap.hits,
          proposed_id,
          resolved_id,
        });
      } catch (e) {
        ctx.events.emit("agentry.reason.deep.gap_record_failed", {
          error: e.message,
          wanted_id: resolved_id,
        });
      }
    }
  }

  ctx.events.emit("agentry.reason.deep.completed", {
    model_used: modelUsed,
    turns: attempts.filter(a => a.ok).length,
    tools_used: toolsUsed,
    gap_id,
    existing_capability_id: existing_capability?.id || null,
    ms: Date.now() - started,
  });

  const missing = rawMissing
    ? Object.assign({}, rawMissing, {
        wanted_id: resolved_id || rawMissing.wanted_id,
      }, proposed_id && resolved_id !== proposed_id ? { proposed_id } : {})
    : null;

  const note = existing_capability
    ? "Capability " + existing_capability.id + " already exists in the graph. Invoke it directly."
    : (gap_id
        ? "A capability gap was recorded. A proposal will be generated in the background."
        : "No gap recorded. Retryable, in-session, or config problem.");

  return {
    output: {
      analysis: parsed.analysis,
      missing,
      immediate_action: parsed.immediate_action,
      suggestions: parsed.suggestions || [],
      gap_recorded: gap_id,
      existing_capability,
      note,
      model_used: modelUsed || (PROVIDER + "/" + MODEL),
      tools_used: toolsUsed,
    },
    cost: { time_ms: Date.now() - started, http_calls: attempts.length + toolsUsed.length },
  };
}
