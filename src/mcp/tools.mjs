// agentry/src/mcp/tools.mjs
// v0.58.1 — DSH-native. Seven primitives. No chat. No ensure_capability.
// No discover-as-MCP-tool. DSH drives; agentry serves.
//
// Tools:
//   reason   — reasoner (kept; DSH uses it when stuck)
//   check    — does this capability exist? returns matches or gap
//   search   — raw adapter fan-out, DSH picks adapters
//   build    — synthesize from DSH-chosen candidate
//   invoke   — run a capability
//   status   — list live capabilities
//   trace    — events for a capability

import { registerTool } from "./server.mjs";

export function registerAgentryTools(deps) {
  // ───────── reason ─────────
  registerTool({
    name: "reason",
    description: "Ask agentry's reasoner to diagnose a failure or gap. Deep path (Groq tool loop with web_search/fetch_url) by default. Returns structured analysis: what's missing, immediate action, candidate fixes. Use when you're stuck.",
    inputSchema: {
      type: "object",
      properties: {
        failure: { type: "string", description: "What went wrong." },
        intent: { type: "string", description: "Original user intent." },
        attempted: { type: "array", items: { type: "string" }, description: "Strategies already tried." },
        depth: { type: "string", enum: ["deep", "fast"], description: "Default 'deep'." },
      },
      required: ["failure"],
    },
  }, async (args, _ctx) => {
    const depth = args.depth || "deep";
    if (depth === "deep") {
      try {
        const r = await deps.invoke("agentry.reason.deep", args, { tenant: "mcp", by: "mcp.reason" });
        if (r.ok) return { content: [{ type: "text", text: JSON.stringify({ ...r.output, depth_used: "deep" }, null, 2) }] };
      } catch (e) {}
    }
    const r = await deps.invoke("agentry.reason", args, { tenant: "mcp", by: "mcp.reason.fast" });
    if (!r.ok) return { content: [{ type: "text", text: `reason failed: ${r.error?.code}: ${r.error?.message}` }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify({ ...r.output, depth_used: "fast" }, null, 2) }] };
  });

  // ───────── check ─────────
  registerTool({
    name: "check",
    description: "Does agentry have a capability for this intent? Returns {exists:true, capability_id, matches:[...]} when one or more candidates match — YOU pick which to invoke. Returns {exists:false, gap_id, capability_id} when nothing matches; a gap is auto-created and you should call search() next.",
    inputSchema: {
      type: "object",
      properties: {
        intent_or_id: { type: "string", description: "Natural language intent OR exact capability id." },
        wanted_kind: { type: "string", description: "Optional kind hint ('tool', 'web', 'notify', ...)." },
      },
      required: ["intent_or_id"],
    },
  }, async (args, _ctx) => {
    if (typeof deps.graph.invalidateCache === "function") deps.graph.invalidateCache();
    const r = await deps.invoke("agentry.check", args, { tenant: "mcp", by: "mcp.check" });
    if (!r.ok) return { content: [{ type: "text", text: JSON.stringify({ exists: false, error: { code: r.error?.code, message: r.error?.message } }, null, 2) }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(r.output, null, 2) }] };
  });

  // ───────── search ─────────
  registerTool({
    name: "search",
    description: "Search external registries. Returns RAW results grouped by adapter — no ranking, no filtering, no recommendation. YOU read them and pick one, then call build(). Adapters: npm, pypi, crates, gomod, maven, nuget, agentskills_code, clawhub, hermes_atlas, dsh_plugins, github, web, mcp.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language search query." },
        adapters: { type: "array", items: { type: "string" }, description: "Optional subset of adapter names. Omit to search all." },
        limit: { type: "number", description: "Max results per adapter, default 10." },
      },
      required: ["query"],
    },
  }, async (args, _ctx) => {
    const r = await deps.invoke("agentry.search", args, { tenant: "mcp", by: "mcp.search" });
    if (!r.ok) return { content: [{ type: "text", text: JSON.stringify({ error: { code: r.error?.code, message: r.error?.message } }, null, 2) }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(r.output, null, 2) }] };
  });

  // ───────── build ─────────
  registerTool({
    name: "build",
    description: "Synthesize a capability from a candidate YOU chose. Pass gap_id (from check()) and one full candidate object (from search()). Agentry synthesizes the handler, trials it against magic bytes, and adopts on success. Returns {ok:true, capability_id, handler_path} or {ok:false, reason}.",
    inputSchema: {
      type: "object",
      properties: {
        gap_id: { type: "string", description: "The gap_id from check() when exists was false." },
        candidate: { type: "object", description: "Full candidate object from search()." },
        wanted_kind: { type: "string", description: "Optional kind hint." },
        model_tier: { type: "string", enum: ["fast", "balanced", "strong"], description: "Quality tier. Default 'balanced'. Matches the user's [fast]/[balanced]/[strong] prefix." },
      },
      required: ["gap_id", "candidate"],
    },
  }, async (args, _ctx) => {
    const r = await deps.invoke("agentry.build_from_candidate", args, { tenant: "mcp", by: "mcp.build" });
    if (!r.ok) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code: r.error?.code, message: r.error?.message } }, null, 2) }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(r.output, null, 2) }] };
  });

  // ───────── build_from_plan ─────────
  registerTool({
    name: "build_from_plan",
    description: "v0.58.6 — STRONG-MODEL fast path. YOU write the plan (prepare/execute/emit code blocks). Agentry renders the handler, trials it, and adopts on pass. 15-30s vs 45-75s for build(). Use this when you can read the package README and write working code yourself. Use build() only for background/weak-model synthesis.",
    inputSchema: {
      type: "object",
      properties: {
        gap_id: { type: "string", description: "Gap id from check(). Optional if capability_id provided." },
        capability_id: { type: "string", description: "Desired capability id. Optional if gap_id provided." },
        candidate: { type: "object", description: "Candidate object from search(). Used for kind/source hints." },
        model_tier: { type: "string", enum: ["fast", "balanced", "strong"], description: "Quality tier hint. Stored on the capability for downstream promotion. Default 'balanced'. Matches the user's [fast]/[balanced]/[strong] prefix." },
        plan_spec: {
          type: "object",
          description: "The plan. Shape: { accepts, produces, requires, plan:[{verb, code}], accept_spec }",
          properties: {
            accepts: { type: "object" },
            produces: { type: "object" },
            requires: { type: "object" },
            kernel_language: { type: "string" },
            plan: { type: "array", items: { type: "object", properties: { verb: { type: "string" }, code: { type: "string" } }, required: ["code"] } },
            accept_spec: { type: "object" },
          },
          required: ["accepts", "produces", "plan"],
        },
      },
      required: ["plan_spec"],
    },
  }, async (args, _ctx) => {
    if (typeof deps.graph.invalidateCache === "function") deps.graph.invalidateCache();
    const r = await deps.invoke("agentry.build_from_plan", args, { tenant: "mcp", by: "mcp.build_from_plan" });
    if (!r.ok) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code: r.error?.code, message: r.error?.message } }, null, 2) }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(r.output, null, 2) }], isError: r.output?.ok === false };
  });

  // ───────── invoke ─────────
  registerTool({
    name: "invoke",
    description: "Run a capability by id. Returns {ok, output, error, ms}. Input shape depends on the capability — use status() or check() to see accepts/produces.",
    inputSchema: {
      type: "object",
      properties: {
        capability_id: { type: "string" },
        input: { type: "object" },
      },
      required: ["capability_id"],
    },
  }, async (args, _ctx) => {
    if (typeof deps.graph.invalidateCache === "function") deps.graph.invalidateCache();
    const r = await deps.invoke(args.capability_id, args.input || {}, { tenant: "mcp", by: "mcp.invoke" });
    return {
      content: [{ type: "text", text: JSON.stringify({
        ok: r.ok,
        output: r.output || null,
        error: r.error ? { code: r.error.code, message: r.error.message } : null,
        ms: r.ms,
      }, null, 2) }],
      isError: !r.ok,
    };
  });

  // ───────── status ─────────
  registerTool({
    name: "status",
    description: "List every live capability with accepts/produces. Use before deciding to invoke or build.",
    inputSchema: {
      type: "object",
      properties: {
        verbose: { type: "boolean", description: "Default true. Include per-capability list." },
      },
    },
  }, async (args, _ctx) => {
    if (typeof deps.graph.invalidateCache === "function") deps.graph.invalidateCache();
    const caps = deps.graph.capabilities();
    const invokable = [];
    const SKIP = new Set(["agent","edge","capability_gap","watch_instance","proposal","synthesis_attempt","task","message"]);
    for (const c of caps.values()) {
      if (c.retired_at || !c.invoked_via || SKIP.has(c.kind)) continue;
      invokable.push({ id: c.id, kind: c.kind, accepts: c.accepts || null, produces: c.produces || null });
    }
    invokable.sort((a, b) => a.id.localeCompare(b.id));
    const out = { count: invokable.length };
    if (args?.verbose !== false) out.invokable = invokable;
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  });

  // ───────── trace ─────────
  registerTool({
    name: "trace",
    description: "Reconstruct the event timeline for a capability. Useful for debugging builds and trials.",
    inputSchema: {
      type: "object",
      properties: {
        capability_id: { type: "string" },
        gap_id: { type: "string" },
        limit: { type: "number", description: "Default 1000." },
      },
    },
  }, async (args, _ctx) => {
    if (typeof deps.graph.invalidateCache === "function") deps.graph.invalidateCache();
    const r = await deps.invoke("agentry.trace", {
      capability_id: args.capability_id,
      gap_id: args.gap_id,
      limit: Math.min(Number(args.limit) || 1000, 2000),
    }, { tenant: "mcp", by: "mcp.trace" });
    if (!r.ok) return { content: [{ type: "text", text: JSON.stringify({ error: { code: r.error?.code, message: r.error?.message } }, null, 2) }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(r.output, null, 2) }] };
  });
}
