// agentry/src/mcp/tools.mjs
// Registers agentry's capabilities as MCP tools.
// Called once at MCP server startup, with the runtime's deps.
//
// v0.15.15: deep path calls agentry.reason.deep (Groq with native tool
// use) instead of agentry.reason.harness (DSH, broken because the
// harness had no LLM API key). Same fallback semantics.
//
// v0.15.23: added ensure_capability. This is the blocking wait. The
// harness calls it when it needs a capability that doesn't yet exist.
// agentry checks the graph, records a gap if needed, and then polls
// until the capability is adopted (or the timeout elapses). No kernel
// calls in the poll loop — just an in-memory cache invalidate and a
// graph read, both of which are already cheap.

import { existsSync } from "node:fs";
import { registerTool } from "./server.mjs";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Return the capability node if it exists, is not retired, and — when
// it carries a handler_file — the file it points at actually exists on
// disk. This last check matters: a graph record can survive an npm
// reinstall that wipes the handler the record pointed at, and in that
// state the capability is nominally "in the graph" but unusable.
function checkAvailable(deps, capabilityId) {
  if (typeof deps.graph.invalidateCache === "function") deps.graph.invalidateCache();
  const cap = deps.graph.getCapability(capabilityId);
  if (!cap) return null;
  if (cap.retired_at) return null;
  if (typeof cap.handler_file === "string" && cap.handler_file.length > 0) {
    if (!existsSync(cap.handler_file)) {
      deps.events.emit("mcp.ensure_capability.handler_missing", {
        capability_id: capabilityId,
        handler_file: cap.handler_file,
      });
      return null;
    }
  }
  return cap;
}

function okResult(cap, reason) {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        available: true,
        capability_id: cap.id,
        kind: cap.kind,
        handler_file: cap.handler_file || null,
        accepts: cap.accepts || null,
        produces: cap.produces || null,
        requires: cap.requires || null,
        reason,
      }, null, 2),
    }],
  };
}

export function registerAgentryTools(deps) {
  // --- agentry.reason ---
  registerTool(
    {
      name: "reason",
      description:
        "Ask agentry to reason about a failure or blockage. By default this is the DEEP path: agentry runs a tool loop on Groq (web_search, fetch_url) to investigate before answering. If the deep path fails, agentry falls back to a fast raw-LLM reasoner. Returns structured JSON: what's missing, what to try immediately, candidate fixes. A missing capability is recorded as a gap and a proposal will be emailed for approval. Pass depth=\"fast\" only when you know the failure is trivial (a retry, a typo, a missing credential) and don't want the deep reasoning round-trip.",
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
              "Optional. The model id YOU are currently running as. agentry uses this for its fast-path reasoning fallback.",
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
          const deepRes = await deps.invoke("agentry.reason.deep", args, { tenant: "local", by: "mcp.deep" });
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
      const fastRes = await deps.invoke("agentry.reason", args, { tenant: "local", by: "mcp.fast" });
      if (!fastRes.ok) {
        return {
          content: [{ type: "text", text: `agentry.reason failed: ${fastRes.error.code} — ${fastRes.error.message}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: JSON.stringify({ ...fastRes.output, depth_used: "fast" }, null, 2) }] };
    }
  );

  // --- agentry.ensure_capability ---
  registerTool(
    {
      name: "ensure_capability",
      description:
        "Block until a capability is usable. Call this when you need a capability that may not exist yet and you cannot proceed without it: agentry checks the graph, records a gap if needed, and waits (up to timeout_ms) for the pipeline to synthesize and adopt the capability. Returns { available, capability_id, handler_file, kind, reason }. If the timeout elapses, returns { available: false, gap_id, proposal_id, reason: 'timeout' } so you can inspect the proposal or try again later. Do NOT call this for config gaps (missing API keys, wrong credentials) or for capabilities you know exist — it will just return immediately, wasting a round-trip.",
      inputSchema: {
        type: "object",
        properties: {
          capability_id: {
            type: "string",
            description: "Dotted capability id, e.g. 'bua.browser' or 'bua.screenshot'.",
          },
          timeout_ms: {
            type: "number",
            description: "Max ms to wait. Default 300000 (5 minutes).",
          },
          wait: {
            type: "boolean",
            description: "Default true. Set false to just check existence and return immediately.",
          },
          workspace_id: { type: "string", description: "Optional, for correlating the recorded gap." },
          session_id: { type: "string", description: "Optional, for correlating the recorded gap." },
        },
        required: ["capability_id"],
      },
    },
    async (args, _ctx) => {
      const capabilityId = String(args.capability_id || "").trim();
      if (!capabilityId) {
        return {
          content: [{ type: "text", text: "ensure_capability: capability_id is required" }],
          isError: true,
        };
      }
      const wait = args.wait !== false;
      const timeoutMs = Math.max(1000, Number(args.timeout_ms) || 300000);
      const pollMs = 3000;
      const startedAt = Date.now();

      // 1. Immediate check — covers the common case where the capability
      //    already exists and no work is needed.
      let cap = checkAvailable(deps, capabilityId);
      if (cap) return okResult(cap, "already_available");

      // 2. Ensure a gap exists so the discovery loop has something to
      //    pick up. Only reason when there is no gap yet — avoids
      //    burning a deep-reasoning round-trip on every call.
      const gapKey = `gap:${capabilityId}`;
      if (typeof deps.graph.invalidateCache === "function") deps.graph.invalidateCache();
      const existingGap = deps.graph.getCapability(gapKey);
      let gapId = existingGap ? gapKey : null;

      if (!existingGap) {
        deps.events.emit("mcp.ensure_capability.reasoning", { capability_id: capabilityId });
        try {
          const reasonRes = await deps.invoke("agentry.reason", {
            failure:
              `The DeepSeek Harness attempted to use capability "${capabilityId}" but no such capability exists in agentry's capability graph. The harness is blocking until it becomes available.`,
            intent: `Use capability "${capabilityId}".`,
            workspace_id: args.workspace_id || null,
            session_id: args.session_id || null,
          }, { tenant: "local", by: "mcp.ensure_capability" });
          if (reasonRes.ok && reasonRes.output?.gap_recorded) {
            gapId = reasonRes.output.gap_recorded;
          }
        } catch (e) {
          deps.events.emit("mcp.ensure_capability.reason_failed", {
            capability_id: capabilityId,
            error: e.message,
          });
        }
        // Re-check: the reasoner may have recorded the gap itself.
        if (typeof deps.graph.invalidateCache === "function") deps.graph.invalidateCache();
        if (deps.graph.getCapability(gapKey)) gapId = gapKey;
      }

      if (!wait) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              available: false,
              capability_id: capabilityId,
              gap_id: gapId,
              reason: "not_yet_available",
              note: gapId
                ? "A gap has been recorded. The discovery loop will propose and adopt candidates in the background."
                : "No gap recorded — the reasoner may have decided this is not a capability gap.",
            }, null, 2),
          }],
        };
      }

      // 3. Poll. Each iteration re-reads the graph from disk so we see
      //    nodes written by the discovery process.
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await sleep(pollMs);
        cap = checkAvailable(deps, capabilityId);
        if (cap) {
          const waitedMs = Date.now() - startedAt;
          deps.events.emit("mcp.ensure_capability.available", {
            capability_id: capabilityId,
            waited_ms: waitedMs,
          });
          return okResult(cap, "became_available");
        }
      }

      // 4. Timeout. Try to give the caller a proposal id so they can
      //    inspect or approve manually.
      if (typeof deps.graph.invalidateCache === "function") deps.graph.invalidateCache();
      let proposalId = null;
      if (gapId) {
        for (const node of deps.graph.capabilities().values()) {
          if (
            node.kind === "proposal" &&
            node.gap_id === gapId &&
            !node.adopted_at &&
            !node.retired_at
          ) {
            proposalId = node.id;
            break;
          }
        }
      }

      deps.events.emit("mcp.ensure_capability.timeout", {
        capability_id: capabilityId,
        gap_id: gapId,
        proposal_id: proposalId,
        timeout_ms: timeoutMs,
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            available: false,
            capability_id: capabilityId,
            gap_id: gapId,
            proposal_id: proposalId,
            reason: "timeout",
            timeout_ms: timeoutMs,
            note:
              "Timed out waiting for the capability. The discovery loop may still be working on it. Check the proposal state or call again with a longer timeout.",
          }, null, 2),
        }],
      };
    }
  );

  // --- agentry.invoke ---
  registerTool(
    {
      name: "invoke",
      description:
        "Run a capability by id and return its output. Use this after ensure_capability confirms a capability exists and you need to actually execute it. The response contains the capability's output object. If you are unsure what input shape a capability takes, call ensure_capability first (it returns accepts/produces) or status. Do NOT call this for capabilities that do not exist yet — call ensure_capability first, then invoke. Errors are returned as isError results with the capability's error code and message.",
      inputSchema: {
        type: "object",
        properties: {
          capability_id: {
            type: "string",
            description: "Dotted capability id, e.g. 'bua.browser' or 'bua.screenshot'.",
          },
          input: {
            type: "object",
            description: "The capability's input object. See the capability's accepts block via ensure_capability or status.",
          },
          timeout_ms: {
            type: "number",
            description: "Optional. Overrides the capability's default timeout.",
          },
          session_id: {
            type: "string",
            description: "Optional. Pass a session id to reuse an existing kernel session.",
          },
        },
        required: ["capability_id"],
      },
    },
    async (args, _ctx) => {
      const capabilityId = String(args.capability_id || "").trim();
      if (!capabilityId) {
        return {
          content: [{ type: "text", text: "invoke: capability_id is required" }],
          isError: true,
        };
      }
      const input = (args.input && typeof args.input === "object") ? { ...args.input } : {};
      if (args.session_id && !input.session) input.session = String(args.session_id);
      if (args.timeout_ms && !input.timeout_ms) input.timeout_ms = Number(args.timeout_ms);

      // v0.17.12 — MCP runs in its own process with its own graph cache.
      // The discovery loop and the shell bridge write capabilities to
      // capabilities.jsonl from other processes. Without an invalidate
      // here, invoke() reads a stale map and refuses to see newly
      // adopted capabilities until MCP restarts. Same reason
      // ensure_capability already invalidates in checkAvailable.
      if (typeof deps.graph.invalidateCache === "function") deps.graph.invalidateCache();

      const startedAt = Date.now();
      const res = await deps.invoke(capabilityId, input, {
        tenant: "mcp", by: "mcp.invoke",
      });
      const ms = Date.now() - startedAt;

      if (!res.ok) {
        deps.events.emit("mcp.invoke.failed", {
          capability_id: capabilityId,
          code: res.error?.code || null,
          ms,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: false,
              capability_id: capabilityId,
              error: { code: res.error?.code || null, message: res.error?.message || "unknown" },
              ms,
            }, null, 2),
          }],
          isError: true,
        };
      }

      deps.events.emit("mcp.invoke.succeeded", {
        capability_id: capabilityId,
        ms,
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            capability_id: capabilityId,
            ms,
            output: res.output,
          }, null, 2),
        }],
      };
    }
  );

  // --- agentry.discover ---
  registerTool(
    {
      name: "discover",
      description:
        "Search for existing capabilities, npm packages, GitHub repos, and web resources that could solve a problem. Returns RAW results grouped by source (local, npm, github, web). Read them carefully and pick the one that best matches the task. Use this BEFORE synthesizing a new capability from scratch \u2014 the right tool may already exist.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Short description of what is needed, e.g. 'generate PDF from markdown'.",
          },
          sources: {
            type: "array",
            items: { type: "string", enum: ["local", "npm", "mcp", "github", "web"] },
            description: "Optional. Default: all.",
          },
          limit: {
            type: "number",
            description: "Optional. Max candidates returned. Default 20.",
          },
        },
        required: ["query"],
      },
    },
    async (args, _ctx) => {
      const query = String(args.query || "").trim();
      if (!query) {
        return {
          content: [{ type: "text", text: "discover: query is required" }],
          isError: true,
        };
      }
      const res = await deps.invoke("agentry.discover", {
        query,
        sources: Array.isArray(args.sources) && args.sources.length ? args.sources : undefined,
        limit: Math.min(Number(args.limit) || 20, 50),
      }, { tenant: "mcp", by: "mcp.discover" });
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `discover failed: ${res.error.code}: ${res.error.message}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(res.output, null, 2) }],
      };
    }
  );

  // --- agentry.chat (v0.50.0 — the parent loop) ---
  registerTool(
    {
      name: "chat",
      description:
        "Talk to agentry in natural language. Give it a task intent; it plans (agent.plan), executes the plan (agent.task), and returns a summary plus the full structured trace. This is the primary tool — use it when you want agentry to decide HOW to accomplish something, not just to invoke a specific capability. Returns {ok, message, conversation_id, agent_id, plan, task, executed, error}. conversation_id maintains thread continuity across calls. For direct capability invocation where you already know the capability_id, use 'invoke' instead.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "Natural-language task description. E.g. 'generate a QR for hello and save as PDF'." },
          conversation_id: { type: "string", description: "Optional. Reuse a prior conversation for continuity — prior turns are passed to the planner." },
          agent_id: { type: "string", description: "Optional. Use a specific agent. If absent, chat auto-boots a per-conversation agent." },
          max_steps: { type: "number", description: "Optional. Max plan steps (default 8)." },
          execute_default: { type: "boolean", description: "Default true. Set false for plan-only mode (returns plan without side effects)." },
        },
        required: ["message"],
      },
    },
    async (args, _ctx) => {
      const message = String(args.message || "").trim();
      if (!message) {
        return { content: [{ type: "text", text: "chat: message is required" }], isError: true };
      }
      if (typeof deps.graph.invalidateCache === "function") deps.graph.invalidateCache();
      const input = { message };
      if (args.conversation_id) input.conversation_id = String(args.conversation_id);
      if (args.agent_id) input.agent_id = String(args.agent_id);
      if (typeof args.max_steps === "number") input.max_steps = args.max_steps;
      if (typeof args.execute_default === "boolean") input.execute_default = args.execute_default;

      const startedAt = Date.now();
      const res = await deps.invoke("agentry.chat", input, { tenant: "mcp", by: "mcp.chat" });
      const ms = Date.now() - startedAt;

      if (!res.ok) {
        deps.events.emit("mcp.chat.failed", {
          code: res.error?.code || null,
          message: String(res.error?.message || "").slice(0, 300),
          ms,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: false,
              message: String(res.error?.message || "unknown error"),
              error: { code: res.error?.code || null, message: res.error?.message || "unknown" },
              ms,
            }, null, 2),
          }],
          isError: true,
        };
      }

      const o = res.output || {};
      deps.events.emit("mcp.chat.succeeded", {
        conversation_id: o.conversation_id,
        agent_id: o.agent_id,
        executed: o.executed,
        steps: (o.plan || []).length,
        artifacts: (o.task?.artifacts || []).length,
        state: o.task?.state || null,
        ms,
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: o.ok === true,
            message: o.message,
            conversation_id: o.conversation_id,
            agent_id: o.agent_id,
            executed: o.executed === true,
            plan: (o.plan || []).map(s => s.capability_id),
            task: o.task ? {
              task_id: o.task.task_id,
              state: o.task.state,
              artifacts: (o.task.artifacts || []).map(a => ({
                kind: a.kind, path: a.path || null, bytes: a.bytes || 0,
              })),
              trace_summary: (o.task.trace || []).map(t => ({
                step: t.step, cap: t.capability_id, ok: t.ok, ms: t.ms,
              })),
              error: o.task.error || null,
            } : null,
            error: o.error || null,
            ms,
          }, null, 2),
        }],
      };
    }
  );

  // --- agentry.status ---
  // v0.16.2 — richer output so a caller can decide what to invoke
  // without a second round-trip. Lists each live invokable capability
  // with its accepts/produces. The bare counts are still present for
  // callers that only want a summary.
  registerTool(
    {
      name: "status",
      description:
        "Return agentry's current state. `invokable` = real capabilities (callable now). `metadata` = graph bookkeeping (gaps, watches, edges, watch_results) — not capabilities. `nodes_total` = sum of both. `by_source` breaks invokable into bootstrap (seeds), synthesized (auto-generated), hand_written (declared by dev). Call this to know what agentry can do right now and how to invoke it.",
      inputSchema: {
        type: "object",
        properties: {
          verbose: {
            type: "boolean",
            description: "Default true. Set false to omit the per-capability list and return only counts.",
          },
        },
      },
    },
    async (args, _ctx) => {
      const verbose = args?.verbose !== false;
      const caps = deps.graph.capabilities();
      const byKind = {};
      const invokable = [];
      for (const c of caps.values()) {
        byKind[c.kind] = (byKind[c.kind] || 0) + 1;
        if (c.retired_at) continue;
        if (!c.invoked_via) continue;
        if (c.kind === "edge") continue;
        invokable.push({
          id: c.id,
          kind: c.kind,
          accepts: c.accepts || null,
          produces: c.produces || null,
        });
      }
      invokable.sort((a, b) => a.id.localeCompare(b.id));

      const gaps = [];
      for (const c of caps.values()) {
        if (c.kind === "capability_gap" && !c.retired_at) {
          gaps.push({ id: c.id, wanted_kind: c.wanted_kind, hits: c.hits || 0 });
        }
      }
      gaps.sort((a, b) => b.hits - a.hits);

      const watches = [];
      for (const c of caps.values()) {
        if (c.kind === "watch_instance" && !c.retired_at) {
          watches.push({ id: c.id, source: c.source, reason: c.reason });
        }
      }

      let _inv = 0, _bootstrap = 0, _synth = 0, _hand = 0, _meta = 0;
      for (const c of caps.values()) {
        if (c.retired_at) continue;
        if (c.kind === "edge" || c.kind === "capability_gap" || c.kind === "watch_instance" || c.kind === "watch_result" || c.kind === "proposal" || c.kind === "synthesis_attempt") { _meta++; continue; }
        if (!c.invoked_via) { _meta++; continue; }
        _inv++;
        const _src = String(c.source || "");
        if (_src.startsWith("seed:")) _bootstrap++;
        else if (_src.startsWith("dsh_synth:") || _src.startsWith("synthesized:")) _synth++;
        else if (_src.startsWith("hand-written:") || _src.startsWith("adopted:")) _hand++;
      }
      const out = {
        nodes_total: caps.size,
        invokable: _inv,
        by_source: { bootstrap: _bootstrap, synthesized: _synth, hand_written: _hand },
        metadata: _meta,
        by_kind: byKind,
        gaps: gaps.slice(0, 20),
        watches: watches.slice(0, 20),
      };
      if (verbose) out.invokable = invokable;

      return {
        content: [{
          type: "text",
          text: JSON.stringify(out, null, 2),
        }],
      };
    }
  );
}
