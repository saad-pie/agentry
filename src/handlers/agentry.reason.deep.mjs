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
//
// v0.23.0: source preference. Prefer agentskills_code > npm > pypi >
// github > clawhub > web by fetch reliability. clawhub pages often
// 404 on raw fetch; npm/pypi install deterministically.
//
// v0.32.0: repair mode. When input.repair_context is set, run a
// separate single-shot prompt path that returns a structured
// {repair_action, patched_handler_code} decision, backed by a
// large-context model (default gemini-2.5-flash). The reasoning path
// is untouched. Repair mode's output contract is disjoint from the
// reasoning path's output contract.

import { recordGap } from "./agentry.capability_gap.mjs";
import { supportFor, synthesizableSources, unsynthesizableSources } from "../adapters/_synthesis_support.mjs";

// v0.56.45 — AnyRouter primary (large ctx, free). Groq fallback.
const PROVIDER = process.env.AGENTRY_DEEP_PROVIDER || "anyrouter";
const MODEL = process.env.AGENTRY_DEEP_MODEL || "nvidia/nemotron-3-ultra-550b-a55b";
const FALLBACK_PROVIDER = process.env.AGENTRY_DEEP_FALLBACK_PROVIDER || "groq";
const FALLBACK_MODEL = process.env.AGENTRY_DEEP_FALLBACK_MODEL || "qwen/qwen3.8-27b";
const MAX_TURNS = Number(process.env.AGENTRY_DEEP_MAX_TURNS || "5");
const MAX_TOOL_CALLS_PER_TURN = 4;

// v0.32.0 — repair uses a larger-context model by default. Groq's 8K
// TPM is overrun by handler code + spec + error in a single input;
// Gemini 2.5 flash takes it comfortably. Overridable per env.
const REPAIR_PROVIDER = process.env.AGENTRY_REPAIR_PROVIDER || "google";
const REPAIR_MODEL = process.env.AGENTRY_REPAIR_MODEL || "gemini-2.5-flash";

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
        "Search agentry's capability graph, the npm registry, GitHub, and the web for existing tools that could solve a problem. Returns RAW results grouped by source (local, npm, github, web). READ them carefully and pick the one that best matches the task. Use this BEFORE deciding a capability is missing \u2014 the right tool may already exist somewhere.",
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
    "    needed (e.g. \"generate PDF from markdown\"). It returns raw\n" +
    "    results grouped by source. READ them carefully. Pick the one that\n" +
    "    best matches the task and put its exact id in missing.wanted_id.\n" +
    "    When more than one candidate fits, prefer sources in this order\n" +
    "    (most to least reliable for our pipeline):\n" +
    "      agentskills_code > npm > pypi > crates > gomod > github > clawhub > web\n" +
    "\n" +
    "    CRITICAL — synthesis support boundary:\n" +
    "    Sources that CANNOT be synthesized (no runtime kernel, roadmap only):\n" +
    "      " + unsynthesizableSources().join(", ") + "\n" +
    "    If a candidate from one of those sources looks perfect, do NOT pick it.\n" +
    "    The gap would be created but synthesis would fail and waste cycles.\n" +
    "    Instead pick the best candidate from a synthesizable source:\n" +
    "      " + synthesizableSources().join(", ") + "\n" +
    "    Only pick an unsynthesizable source if NO synthesizable candidate exists\n" +
    "    AND set confidence to \"low\" so the pipeline knows this is a fallback.\n" +
    "    agentskills_code serves raw SKILL.md (reliable fetch). npm and\n" +
    "    pypi install deterministically. github clones cleanly. clawhub\n" +
    "    serves HTML pages that often 404 on raw fetch \u2014 pick it only\n" +
    "    when no other source has a match. web results are last resort.\n" +
    "    BEFORE picking any candidate, apply this FILTER:\n" +
    "    - REJECT candidates whose categories/description indicate they are\n" +
    "      API clients or SDKs (categories: api-bindings, http-client,\n" +
    "      web-programming; description starting with 'API for', 'SDK for',\n" +
    "      'REST client', or containing 'remote API' / 'requires API key').\n" +
    "    - REJECT candidates that need GPU, display, wasm, android, ios, or\n" +
    "      a runtime not in [node, python, rust, go, java, dotnet].\n" +
    "    - PREFER candidates that: install offline (cargo/npm/pip/apt/go),\n" +
    "      take a file path in and produce a file path out, need no\n" +
    "      credentials. This rule OVERRIDES the source preference list.\n" +
    "    Prefer a specific id ONLY if it is installable (npm:*, pypi:*,\n" +
    "    mcp:*) or a real skill (clawhub:*, agentskills:*, hermes_atlas:*)\n" +
    "    that clearly fits.\n" +
    "    If the only matches are loose (github repos, articles, tutorials,\n" +
    "    unrelated tools), do NOT pick a specific one \u2014 INVENT a\n" +
    "    descriptive dotted capability id (e.g. pdf.from_image,\n" +
    "    chart.render, csv.parse) and put a short natural-language\n" +
    "    phrase in wanted_description. Discovery will find the real\n" +
    "    installable package for that description.\n" +
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
    "    \"wanted_description\": \"<short search-friendly phrase describing what the capability should do, e.g. 'convert PNG screenshot to PDF file'>\",\n" +
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
    "- wanted_description MUST be a short search phrase (3-10 words)\n" +
    "  describing the CAPABILITY in natural language, not its id.\n" +
    "  Example: for wanted_id \"pdf.render_image\", use \"convert PNG\n" +
    "  screenshot to PDF file\". This becomes the discovery search query.\n" +
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
  const raw = res.output?.results || {};
  const results = {};
  for (const [src, items] of Object.entries(raw)) {
    if (!Array.isArray(items)) continue;
    results[src] = items.slice(0, 10).map(it => {
      const entry = {
        id: it.id,
        source: src,
        name: it.name || it.id,
        description: String(it.description || "").slice(0, 200),
        url: it.url || null,
        exists_locally: it.exists_locally === true,
      };
      if (it.stars != null) entry.stars = it.stars;
      if (it.version) entry.version = it.version;
      if (it.produces) entry.produces = it.produces;
      if (it.accepts) entry.accepts = it.accepts;
      return entry;
    });
  }
  return {
    query,
    results,
    errors: res.output?.errors || null,
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

// ── v0.32.0 — repair mode helpers ──────────────────────────────
// Disjoint from the reasoning path. Different output contract, different
// model default, different prompt. Does not touch tools, does not touch
// graph state, does not write gaps.

function repairSystemPrompt() {
  return "You are agentry's repair engineer. A synthesized handler failed trial.\n\n" +
    "Return exactly one of four decisions.\n\n" +
    "REWRITE_HANDLER — the failure is a fixable bug:\n" +
    "  * wrong API call shape\n" +
    "  * wrong arg order or missing arg\n" +
    "  * wrong module import name (e.g. 'pdf-lib' vs 'pdf-lib/cjs')\n" +
    "  * logic error (wrong variable, wrong loop bound, wrong cast)\n" +
    "  * missing null check, unhandled error path, wrong JSON shape on emit\n" +
    "  Return the FULL corrected handler in patched_handler_code.\n\n" +
    "DIFFERENT_CANDIDATE — the library/tool itself is wrong:\n" +
    "  * needs a remote API or credentials\n" +
    "  * needs a runtime we don't have (GPU, browser, wasm)\n" +
    "  * output shape is fundamentally incompatible with what the spec wants\n" +
    "  * the fix would require a DIFFERENT npm/pip/crates dependency\n" +
    "  (Do NOT return rewrite_handler if the fix requires changing deps —\n" +
    "   trial installs deps from the seed file BEFORE importing your code;\n" +
    "   a dep change won't take effect and the retrial will fail identically.)\n\n" +
    "UNSOLVABLE — no candidate from this source could satisfy the spec.\n\n" +
    "NONE — no clear repair path; err toward this when uncertain.\n\n" +
    "PRESERVATION RULES for rewrite_handler (violating these guarantees retrial failure):\n" +
    "  * Preserve ALL THREE exports exactly:\n" +
    "      export const capability = {...}\n" +
    "      export async function accept(deps, opts = {}) {...}\n" +
    "      export default run;  (or 'export default <fn>' at the file end)\n" +
    "  * Preserve every top-level const declaration (CAP_ID, ACCEPTS, PRODUCES,\n" +
    "    REQUIRES, ENV_MAP, PRE_INVOKE, OUTPUT_MAP, RESULT_PARSE, KERNEL_ACTION,\n" +
    "    KERNEL_SCRIPT / SKILL_BODY / LLM_*, REQUIRES). Do not delete any.\n" +
    "  * Preserve the prepareSession call — installer wiring must survive.\n" +
    "  * Preserve the artifact_magic verification block — Phase 1 honesty\n" +
    "    invariant. If the original handler checks magic bytes, the repaired\n" +
    "    one must too.\n" +
    "  * Change ONLY the code inside functions and the KERNEL_SCRIPT body\n" +
    "    (or skill body prompt). That is where the bug lives.\n" +
    "  * Same dependencies. Same accepts. Same produces. Same env_map.\n" +
    "  * Same ES module structure. Same imports.\n" +
    "  * The repaired file must pass `node --check`. Your output is checked\n" +
    "    for syntax + exports + preservation before trial runs. Failure on\n" +
    "    any of these gates rejects the repair without trying it.\n\n" +
    "Output ONLY this JSON, no prose, no fences:\n\n" +
    "{\n" +
    "  \"analysis\": \"<1-2 sentences: the actual root cause>\",\n" +
    "  \"repair_action\": \"rewrite_handler\" | \"different_candidate\" | \"unsolvable\" | \"none\",\n" +
    "  \"patched_handler_code\": \"<full corrected handler file>\" | null,\n" +
    "  \"reason_for_action\": \"<short justification>\"\n" +
    "}\n\n" +
    "Rules:\n" +
    "- Prefer rewrite_handler when the failure names a specific API/arg/import/logic bug.\n" +
    "- Use different_candidate only when the whole library is unfit.\n" +
    "- Do NOT invent API surface. If you are unsure how the library's API works,\n" +
    "  return 'none' rather than guessing — guessing guarantees another failure.\n" +
    "- Do not include ``` fences inside patched_handler_code.\n" +
    "- Output only the JSON object as your final message.";
}

function repairUserPrompt(repair_context) {
  const { error, phase, handler_code, spec, capability_id } = repair_context || {};
  const lines = [];
  if (capability_id) lines.push("CAPABILITY: " + capability_id);
  if (phase) lines.push("FAILED PHASE: " + phase);
  lines.push("");
  lines.push("TRIAL ERROR:");
  lines.push(String(error || "(none)").slice(0, 4000));
  lines.push("");
  lines.push("CURRENT HANDLER CODE:");
  lines.push("```js");
  lines.push(String(handler_code || ""));
  lines.push("```");
  if (spec) {
    lines.push("");
    lines.push("SPEC (accepts, produces, requires, plan):");
    lines.push("```json");
    lines.push(JSON.stringify(spec, null, 2).slice(0, 8000));
    lines.push("```");
  }
  return lines.join("\n");
}

function stripFences(code) {
  if (!code) return null;
  let s = String(code).trim();
  const m = s.match(/^```(?:js|javascript|mjs)?\s*\n([\s\S]*?)\n```$/);
  if (m) s = m[1];
  return s;
}

export default async function agentryReasonDeep(input, ctx) {
  const { failure, intent, workspace_id, session_id, repair_context } = input || {};

  // ── v0.32.0 — repair mode branch ──
  // Separate from the reasoning path entirely. No tools, no graph
  // state, no gap recording. Different model default (large context).
  if (repair_context) {
    if (typeof ctx.invoke !== "function") throw new Error("agentry.reason.deep requires ctx.invoke");
    const repairStarted = Date.now();
    // v0.32.3 — repair generates a full patched handler (up to ~8KB,
    // ~2000 tokens) on top of processing the failing handler + spec in
    // the input. The default 30s timeout in llm.openai_compat aborts at
    // ~half the budget gemini-flash needs through the antigravity proxy.
    // 120s with env override; if the model itself can't do it in 2 min,
    // that's a signal to swap models, not to raise this further.
    const repairTimeoutMs = Number(process.env.AGENTRY_REPAIR_TIMEOUT_MS || "120000");
    const r = await ctx.invoke("llm.openai_compat", {
      provider: REPAIR_PROVIDER,
      model: REPAIR_MODEL,
      messages: [
        { role: "system", content: repairSystemPrompt() },
        { role: "user", content: repairUserPrompt(repair_context) },
      ],
      temperature: 0.1,
      max_tokens: 8000,
      timeout_ms: repairTimeoutMs,
    }, { tenant: "local", by: "agentry.reason.deep" });
    if (!r.ok) {
      throw new Error("agentry.reason.deep repair: " + r.error.code + ": " + r.error.message);
    }
    const repairContent = String(r.output.content || "");
    const repairParsed = parseJson(repairContent);
    if (!repairParsed) {
      ctx.events.emit("agentry.reason.deep.repair_unparseable", {
        preview: repairContent.slice(0, 300),
      });
      throw new Error("agentry.reason.deep repair: could not parse JSON. Raw: " + repairContent.slice(0, 300));
    }
    const patched = stripFences(repairParsed.patched_handler_code) || null;
    ctx.events.emit("agentry.reason.deep.repair_completed", {
      repair_action: repairParsed.repair_action || null,
      has_patched_code: !!patched,
      model: REPAIR_PROVIDER + "/" + REPAIR_MODEL,
      ms: Date.now() - repairStarted,
    });
    return {
      output: {
        analysis: repairParsed.analysis || null,
        repair_action: repairParsed.repair_action || "none",
        patched_handler_code: patched,
        reason_for_action: repairParsed.reason_for_action || null,
        model_used: REPAIR_PROVIDER + "/" + REPAIR_MODEL,
      },
      cost: { time_ms: Date.now() - repairStarted, http_calls: 1 },
    };
  }
  // ── end repair mode ──

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

  // v0.31.9 — deterministic kind from wanted_id prefix. The LLM's
  // kind enum (bua|cua|mua|memory|tool|notify|web|harness|unknown) is
  // undefined in the prompt, so it guesses. img2pdf got "cua" because
  // "image" pattern-matched "computer use" -> getShape("cua") returned
  // perceive/decide/act verbs for a library wrapper. That mis-shaped the
  // synthesis prompt and wasted trial attempts. Override from prefix.
  if (rawMissing && rawMissing.wanted_id) {
    const _wid = String(rawMissing.wanted_id);
    const _origKind = rawMissing.kind;
    if (_wid.startsWith("bua.")) rawMissing.kind = "bua";
    else if (_wid.startsWith("cua.")) rawMissing.kind = "cua";
    else if (_wid.startsWith("mua.")) rawMissing.kind = "mua";
    else if (_wid.startsWith("memory.")) rawMissing.kind = "memory";
    else if (_wid.startsWith("notify.")) rawMissing.kind = "notify";
    else if (_wid.startsWith("web.")) rawMissing.kind = "web";
    else if (_wid.startsWith("harness.") || _wid.startsWith("agent.")) rawMissing.kind = "harness";
    else if (/^(crates|npm|pypi|gomod|maven|nuget|clawhub|agentskills|hermes_atlas|github|mcp|apt|docker):/.test(_wid)) rawMissing.kind = "tool";
    if (_origKind !== rawMissing.kind) {
      ctx.events.emit("agentry.reason.deep.kind_overridden", {
        wanted_id: _wid, from: _origKind, to: rawMissing.kind,
      });
    }
  }

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
            wanted_description: rawMissing.wanted_description || null,
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
