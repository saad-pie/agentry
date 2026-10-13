// agentry/src/handlers/agentry.trial.mjs
//
// Trial a synthesized handler in an isolated session.
//
//   1. Write a trial node so prepareSession can read `requires`.
//   2. Prepare the trial session (npm + post_install via installer).
//   3. import() the handler with cache-busting.
//   4. Call accept().
//   5. On pass: keep the node (clear trial marker), return {ok: true}.
//      On fail: retire the trial node, keep the gap, return {ok: false}.
//
// Does NOT retire the gap. Does NOT email. Adopt owns that.
// Does NOT copy the handler into src/handlers. The handler lives at
// handler_file; the runtime lazy-loads it via the in_process_js patch.

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

export default async function agentryTrial(input, ctx) {
  const { capability_id, handler_path, seed_path, session } = input || {};
  if (!capability_id) throw new Error("agentry.trial requires capability_id");
  if (!handler_path) throw new Error("agentry.trial requires handler_path");
  if (typeof ctx.invoke !== "function") throw new Error("agentry.trial requires ctx.invoke");

  const started = Date.now();
  const { graph, events } = ctx;
  const trialSession = session || `trial_${capability_id.replace(/[^a-z0-9_.-]/gi, "_")}_${Date.now().toString(36)}`;

  events.emit("trial.started", { capability_id, handler_path, session: trialSession });

  // ── 1. Trial node (needed for prepareSession to read `requires`) ──
  let seedSpec = null;
  if (seed_path) {
    try { seedSpec = JSON.parse(readFileSync(seed_path, "utf8")); }
    catch (e) { events.emit("trial.seed_read_failed", { seed_path, error: e.message }); }
  }

  const trialNode = {
    id: capability_id,
    kind: seedSpec?.kind || "unknown",
    invoked_via: "invoker.in_process_js",
    handler: capability_id,
    handler_file: handler_path,
    accepts: seedSpec?.accepts || null,
    produces: seedSpec?.produces || null,
    requires: seedSpec?.requires || {},
    source: seedSpec?.source || "synthesized:trial",
    notes: seedSpec?.notes || null,
    trial: true,
    trial_started_at: Date.now(),
  };

  try {
    graph.putCapability(trialNode);
    events.emit("trial.node_written", { capability_id, handler_file: handler_path });
  } catch (e) {
    events.emit("trial.node_write_failed", { capability_id, error: e.message });
    return {
      output: { ok: false, phase: "node_write", error: e.message, session: trialSession },
      cost: { time_ms: Date.now() - started },
    };
  }

  // ── 2. Prepare session ──
  try {
    const { prepareSession } = await import("../runtime/installer.mjs");
    const prep = await prepareSession(ctx, { capId: capability_id, session: trialSession });
    events.emit("trial.prepared", { capability_id, session: trialSession, prep });
  } catch (e) {
    events.emit("trial.prepare_failed", { capability_id, session: trialSession, error: e.message });
    _retire(ctx, capability_id, `trial prepare: ${e.message}`);
    return {
      output: { ok: false, phase: "prepare", error: e.message, session: trialSession, handler_path },
      cost: { time_ms: Date.now() - started },
    };
  }

  // ── 3. Import ──
  let mod;
  try {
    const abs = resolve(handler_path);
    mod = await import(pathToFileURL(abs).href + `?trial=${Date.now()}`);
  } catch (e) {
    events.emit("trial.import_failed", { capability_id, handler_path, error: e.message });
    _retire(ctx, capability_id, `trial import: ${e.message}`);
    return {
      output: { ok: false, phase: "import", error: e.message, session: trialSession, handler_path },
      cost: { time_ms: Date.now() - started },
    };
  }

  if (typeof mod.default !== "function") {
    _retire(ctx, capability_id, "trial: no default export");
    return {
      output: { ok: false, phase: "import", error: "no default export", session: trialSession, handler_path },
      cost: { time_ms: Date.now() - started },
    };
  }
  if (typeof mod.accept !== "function") {
    _retire(ctx, capability_id, "trial: no accept export");
    return {
      output: { ok: false, phase: "accept_export", error: "no accept export", session: trialSession, handler_path },
      cost: { time_ms: Date.now() - started },
    };
  }

  // ── 4. accept() ──
  let acceptResult;
  try {
    acceptResult = await mod.accept(ctx, { session: trialSession });
  } catch (e) {
    events.emit("trial.accept_threw", { capability_id, session: trialSession, error: e.message });
    _retire(ctx, capability_id, `trial accept: ${e.message}`);
    return {
      output: { ok: false, phase: "accept", error: e.message, session: trialSession, handler_path },
      cost: { time_ms: Date.now() - started },
    };
  }

  // ── 5. Pass. Clear the trial marker. ──
  try {
    graph.putCapability({
      id: capability_id,
      kind: trialNode.kind,
      trial: false,
      trial_passed_at: Date.now(),
      trial_session: trialSession,
    });
  } catch (e) {
    events.emit("trial.marker_clear_failed", { capability_id, error: e.message });
  }

  events.emit("trial.completed", {
    capability_id, session: trialSession, ok: true, ms: Date.now() - started,
    accept: acceptResult,
  });

  return {
    output: {
      ok: true, capability_id, session: trialSession,
      handler_path, accept: acceptResult,
    },
    cost: { time_ms: Date.now() - started },
  };
}

function _retire(ctx, capabilityId, reason) {
  try {
    ctx.graph.retireCapability(capabilityId, reason);
    ctx.events.emit("trial.node_retired", { capability_id: capabilityId, reason });
  } catch (e) {
    ctx.events.emit("trial.node_retire_failed", { capability_id: capabilityId, error: e.message });
  }
}
