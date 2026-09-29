// agentry/src/invokers/in_process_js.mjs
// The ground-truth invoker.
// A capability whose `invoked_via` is "invoker.in_process_js" is expected to
// have a companion module registered in the HANDLERS map below.
//
// This is the ONLY invoker that executes JS directly. Every other invoker
// (HTTP, MCP, browser, shell) ultimately either calls out to another process
// or delegates here. This is the floor.

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { errors } from "../errors.mjs";
import { registerInvoker } from "../invoke.mjs";

/**
 * A handler is: async (input, ctx) → { output, cost? } | throws
 * The ctx has { config, graph, events, invoke, task_id, tenant, capability }.
 */
const HANDLERS = new Map();

export function registerHandler(id, fn) {
  if (typeof fn !== "function") throw errors.internal(`handler ${id} must be a function`);
  HANDLERS.set(id, fn);
}

export function listHandlers() {
  return Array.from(HANDLERS.keys());
}

/**
 * Dynamically load a handler module from disk.
 * Used by discovery: when a new capability arrives that is a JS module,
 * we load it and register its handler under the capability's id.
 */
export async function loadHandlerFromFile(id, filePath) {
  const abs = resolve(filePath);
  const mod = await import(pathToFileURL(abs).href + `?v=${Date.now()}`);
  const fn = mod.default || mod.handler;
  if (typeof fn !== "function") {
    throw errors.invalidSpec(id, `module ${filePath} must export default or named 'handler'`);
  }
  registerHandler(id, fn);
  return id;
}

// ---- the invoker function itself ----
async function inProcessJsInvoker(cap, input, context) {
  const handlerId = cap.handler || cap.id;
  const fn = HANDLERS.get(handlerId);
  if (!fn) {
    throw errors.invalidSpec(cap.id, `no handler registered for "${handlerId}"`);
  }

  // If the capability declares accepts, do a minimal shape check.
  // We do NOT enforce JSON Schema yet — that comes when we have a schema kind.
  if (cap.accepts && typeof cap.accepts === "object" && !Array.isArray(cap.accepts)) {
    for (const key of Object.keys(cap.accepts)) {
      const spec = cap.accepts[key];
      const optional = spec && typeof spec === "object" && spec.optional === true;
      if (input[key] === undefined && !optional) {
        throw errors.invalidSpec(cap.id, `missing required input: ${key}`);
      }
    }
  }

  const started = Date.now();
  // Pass invoke down so composite handlers can call other capabilities
  // through the same dispatch boundary. Set by invoke.mjs in step 4.
  const raw = await fn(input, {
    ...context,
    capability: cap,
    invoke: context.invoke || null,
  });
  const ms = Date.now() - started;

  // Handler may return { output, cost } or just output.
  if (raw && typeof raw === "object" && "output" in raw) {
    return { output: raw.output, cost: { ...(raw.cost || {}), time_ms: ms } };
  }
  return { output: raw, cost: { time_ms: ms } };
}

// ---- self-register on import ----
registerInvoker("invoker.in_process_js", inProcessJsInvoker);
