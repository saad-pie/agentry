// agentry/src/mcp/server.mjs
// Streamable-HTTP MCP server. Exposes agentry's capabilities as tools
// the DeepSeek Harness can call.
//
// Protocol: MCP over HTTP. Speaks JSON-RPC 2.0.
//   POST /mcp  — JSON-RPC requests (initialize, tools/list, tools/call)
//   GET  /mcp  — SSE stream for notifications (list_changed)
//   DELETE /mcp — session termination
//
// We implement only the subset the DSH mcp-client uses:
//   - initialize
//   - tools/list
//   - tools/call
//   - notifications/tools/list_changed (announced, not enforced)
//
// Tools are registered by name. The handler is called with the tool's
// arguments + a context object. It returns { content: [...] } or throws.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const DEFAULT_PORT = 7863;
const DEFAULT_HOST = "127.0.0.1";
const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "agentry";
const SERVER_VERSION = "0.10.0";

// ---------- tool registry ----------
const TOOLS = new Map(); // name -> { definition, handler }

/**
 * Register an MCP tool.
 * definition: { name, description, inputSchema }
 * handler: async (args, ctx) => { content: [...] } | value
 */
export function registerTool(definition, handler) {
  if (!definition?.name) throw new Error("tool.name required");
  if (typeof handler !== "function") throw new Error("handler must be a function");
  TOOLS.set(definition.name, { definition, handler });
}

export function listRegisteredTools() {
  return Array.from(TOOLS.keys());
}

// ---------- JSON-RPC helpers ----------
function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message, data) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
}

async function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", c => b += c);
    req.on("end", () => resolve(b));
  });
}

function json(res, status, body, extraHeaders = {}) {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(s),
    "access-control-allow-origin": "*",
    ...extraHeaders,
  });
  res.end(s);
}

// ---------- request handlers ----------
async function handleRpc(method, params, ctx) {
  switch (method) {
    case "initialize": {
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: true },
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
        },
      };
    }

    case "notifications/initialized": {
      // Client notification; no response needed. Return null and
      // the caller treats it as a no-content ack.
      return null;
    }

    case "tools/list": {
      const tools = [];
      for (const { definition } of TOOLS.values()) {
        tools.push({
          name: definition.name,
          description: definition.description || "",
          inputSchema: definition.inputSchema || { type: "object", properties: {} },
        });
      }
      return { tools };
    }

    case "tools/call": {
      const { name, arguments: args = {} } = params || {};
      const entry = TOOLS.get(name);
      if (!entry) {
        const err = new Error(`Unknown tool: ${name}`);
        err.code = -32601;
        throw err;
      }
      try {
        const raw = await entry.handler(args, ctx);
        // Accept a few result shapes. Canonicalize to { content: [...] }.
        if (raw && typeof raw === "object" && Array.isArray(raw.content)) {
          return raw;
        }
        // If a handler returns { output, cost }, stringify the output.
        if (raw && typeof raw === "object" && "output" in raw) {
          return { content: [{ type: "text", text: JSON.stringify(raw.output, null, 2) }] };
        }
        // Fallback: stringify whatever came back.
        return { content: [{ type: "text", text: typeof raw === "string" ? raw : JSON.stringify(raw ?? null) }] };
      } catch (e) {
        // MCP convention: tool errors are returned as isError results,
        // not transport-level errors, so the model sees them.
        return {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          isError: true,
        };
      }
    }

    case "ping":
      return {};

    default: {
      const err = new Error(`Method not supported: ${method}`);
      err.code = -32601;
      throw err;
    }
  }
}

// ---------- HTTP server ----------
export function createMcpServer({ context = {} } = {}) {
  const sessions = new Set();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    // Health check (outside MCP, for the entrypoint)
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        service: "agentry.mcp",
        version: SERVER_VERSION,
        tools: Array.from(TOOLS.keys()),
        sessions: sessions.size,
      });
    }

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        "access-control-allow-headers": "content-type, accept, mcp-session-id, authorization",
      });
      return res.end();
    }

    if (url.pathname !== "/mcp" && url.pathname !== "/") {
      return json(res, 404, { error: "not found", path: url.pathname });
    }

    // SSE stream for server->client notifications (accepted, minimal impl)
    if (req.method === "GET") {
      const sessionId = req.headers["mcp-session-id"];
      if (sessionId) sessions.add(sessionId);
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive",
        "access-control-allow-origin": "*",
      });
      // Keep alive; send a comment heartbeat
      const hb = setInterval(() => {
        try { res.write(": heartbeat\n\n"); } catch { clearInterval(hb); }
      }, 30000);
      req.on("close", () => { clearInterval(hb); if (sessionId) sessions.delete(sessionId); });
      return;
    }

    // Session termination
    if (req.method === "DELETE") {
      const sessionId = req.headers["mcp-session-id"];
      if (sessionId) sessions.delete(sessionId);
      res.writeHead(204, { "access-control-allow-origin": "*" });
      return res.end();
    }

    // JSON-RPC POST
    if (req.method === "POST") {
      const body = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return json(res, 400, rpcError(null, -32700, "Parse error"));
      }

      // Batch? The MCP SDK uses single requests. Handle both.
      const isBatch = Array.isArray(parsed);
      const requests = isBatch ? parsed : [parsed];
      const responses = [];

      for (const req0 of requests) {
        if (!req0 || typeof req0 !== "object") continue;
        const { id, method, params } = req0;

        // Notifications (no id) — handle, don't respond
        if (id === undefined || id === null) {
          try { await handleRpc(method, params, context); } catch { /* ignore */ }
          continue;
        }

        try {
          const result = await handleRpc(method, params, context);
          if (result !== null) responses.push(rpcResult(id, result));
        } catch (e) {
          responses.push(rpcError(id, e.code ?? -32603, e.message ?? "internal error"));
        }
      }

      // Assign a session id if the client didn't provide one
      const extraHeaders = {};
      if (!req.headers["mcp-session-id"]) {
        extraHeaders["mcp-session-id"] = randomBytes(16).toString("hex");
      }

      if (responses.length === 0) {
        return json(res, 202, {}, extraHeaders);
      }
      return json(res, 200, isBatch ? responses : responses[0], extraHeaders);
    }

    return json(res, 405, rpcError(null, -32600, "Method not allowed"));
  });

  return server;
}

/**
 * Start the MCP server. Returns a promise resolved once listening.
 * Registers tools via registerTool() BEFORE calling this.
 */
export function startMcpServer({ port, host, context } = {}) {
  const p = Number(port || process.env.AGENTRY_MCP_PORT || DEFAULT_PORT);
  const h = host || process.env.AGENTRY_MCP_HOST || DEFAULT_HOST;
  const server = createMcpServer({ context });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(p, h, () => {
      const addr = server.address();
      resolve({ server, host: addr.address, port: addr.port });
    });
  });
}
