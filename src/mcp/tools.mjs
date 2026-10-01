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
        "Ask agentry to reason about a failure or blockage. Returns structured analysis: what's missing, what to try immediately, and candidate fixes. A missing capability is recorded as a gap and a proposal will be emailed for approval in the background.",
      inputSchema: {
        type: "object",
        properties: {
          failure: { type: "string", description: "What went wrong — error message, stack, or description." },
          intent: { type: "string", description: "What the user originally asked for." },
          attempted: { type: "array", description: "Optional list of strategies already tried.", items: { type: "string" } },
          workspace_id: { type: "string", description: "Optional workspace id (helps correlate)." },
          session_id: { type: "string", description: "Optional session id (helps correlate)." },
        },
        required: ["failure"],
      },
    },
    async (args, ctx) => {
      const res = await deps.invoke("agentry.reason", args, { tenant: "local", by: "mcp.harness" });
      if (!res.ok) {
        return { content: [{ type: "text", text: `agentry.reason failed: ${res.error.code} — ${res.error.message}` }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(res.output, null, 2) }] };
    }
  );

  // --- agentry.status (quick, no LLM) ---
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
