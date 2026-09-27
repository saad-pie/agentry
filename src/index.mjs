// agentry/src/index.mjs
// The public API of agentry.
// Import from "agentry" and get these names. Nothing else is stable.

export { errors, CODES, AgentryError, ok, fail } from "./errors.mjs";
export { CapabilityGraph } from "./graph.mjs";
export { EventLog } from "./events.mjs";
export { loadConfig, assertConfigured } from "./config.mjs";
export { invoke, registerInvoker, listInvokers } from "./invoke.mjs";

// Side-effect import: registering the ground-truth invoker.
// Anyone who imports agentry gets invoker.in_process_js for free.
import "./invokers/in_process_js.mjs";
