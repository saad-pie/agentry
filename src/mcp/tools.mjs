// agentry/src/mcp/tools.mjs
// Registers agentry's capabilities as MCP tools.
// Called once at MCP server startup, with the runtime's deps.

import { registerTool } from "./server.mjs";

export function registerAgentryTools(deps) {
  // --- agentry.reason ---
  registerTool(
    {
      name: "reason",
      description:
        "Ask agentry to reason about a failure or blockage. By default this is the DEEP path: agentry asks the harness itself to investigate with its own tools (web search, fetch, file reads) before answering. If the deep path fails, agentry falls back to a fast raw-LLM reasoner. Returns structured JSON: what's missing, what to try immediately, candidate fixes. A missing capability is recorded as a gap and a proposal will be emailed for approval. IMPORTANT: pass your own model id in the `model` field so agentry can reason with the same model you're using — it's the one we know is working right now. Pass depth=\"fast\" only when you know the failure is trivial (a retry, a typo, a missing credential) and don't want the deep reasoning round-trip.",
      inputSchema: {
        type: "object",
        properties: {
          failure: { type: "string", description: "What went wrong — error message, stack, or description." },
          intent: { type: "string", description: "What the user originally asked for." },
          attempted: { type: "array", description: "Optional list of strategies already tried.", items: { type: "string" } },
          workspace_id: { type: "string", description: "Optional workspace id (helps correlate)." },
          session_id: { type: "string", description: "Optional session id (helps correlate)." },
          model: {
            type: "string",
            description:
              "Strongly recommended. The model id YOU are currently running as (e.g. 'deepseek-v4.1-flash:free'). agentry uses this for its fast-path reasoning fallback. The deep path uses the harness itself and doesn't need it, but if the deep path fails, this is what saves us.",
          },
          depth: {
            type: "string",
            enum: ["deep", "fast"],
            description:
              "Defaults to 'deep'. Use 'fast' only when the failure is trivial: a retry, a typo, a missing credential. Use 'deep' (or omit) for anything that needs investigation, comparison, or research.",
          },
        },
        required: ["failure"],
      },
    },
    async (args, ctx) => {
      const depth = args.depth || "deep";

      if (depth === "deep") {
        // Try deep first. Fall back to fast on any error.
        try {
          const deepRes = await deps.invoke("agentry.reason.harness", args, { tenant: "local", by: "mcp.harness" });
          if (deepRes.ok) {
            return { content: [{ type: "text", text: JSON.stringify({ ...deepRes.output, depth_used: "deep" }, null, 2) }] };
          }
          deps.events.emit("mcp.reason.deep_failed_falling_back", {
            code: deepRes.error.code,
            message: deepRes.error.message,
          });
        } catch (e) {
          deps.events.emit("mcp.reason.deep_threw_falling_back", { error: e.message });
        }
      }

      // Fast path (or fallback from deep).
      const fastRes = await deps.invoke("agentry.reason", args, { tenant: "local", by: "mcp.harness" });
      if (!fastRes.ok) {
        return {
          content: [{ type: "text", text: `agentry.reason failed: ${fastRes.error.code} — ${fastRes.error.message}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: JSON.stringify({ ...fastRes.output, depth_used: "fast" }, null, 2) }] };
    }
  );

  // --- agentry.status ---
  registerTool(
    {
      name: "status",
      description:
        "Return agentry's current state: number of capabilities, recent gaps, active watches. Cheap; call this to know what agentry can help with right now.",
      inputSchema: { type: "object", properties: {} },
    },
    async (_args, _ctx) => {
      const caps = deps.graph.capabilities();
      const byKind = {};
      for (const c of caps.values()) byKind[c.kind] = (byKind[c.kind] || 0) + 1;
      const gaps = [];
      for (const c of caps.values()) {
        if (c.kind === "capability_gap" && !c.retired_at) {
          gaps.push({ id: c.id, wanted_kind: c.wanted_kind, hits: c.hits || 0 });
        }
      }
      gaps.sort((a, b) => b.hits - a.hits);
      const watches = [];
      for (const c of caps.values()) {
        if (c.kind === "watch_instance") {
          watches.push({ id: c.id, source: c.source, reason: c.reason });
        }
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            capabilities: caps.size,
            by_kind: byKind,
            gaps: gaps.slice(0, 20),
            watches: watches.slice(0, 20),
          }, null, 2),
        }],
      };
    }
  );
}
