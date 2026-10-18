// agentry/src/handlers/agentry.adopt.mjs
// Grows the graph. This is the handler that makes the pitch real.
//
// v0.15.5 — before writing a capability node, run synthesize → trial.
// Only write on trial pass. On trial fail, record a synthesis_attempt
// node (retired immediately) so we can inspect what the LLM tried, keep
// the gap open, and let discovery retry on the next tick.
//
// v0.32.0 — repair loop. When trial fails, invoke reason.deep in repair
// mode. If it returns rewrite_handler + patched code, sanity-check the
// patched file, re-trial, and adopt on pass. New handler id (__r<ts>)
// avoids the in_process_js HANDLERS cache: the map never reloads an id
// that already has a fn, so keeping the original handler id would silently
// run the ORIGINAL broken handler after a passing retrial.
//
// v0.32.1 — pass `failure` alongside `repair_context` in the repair
// invoke. reason.deep's seed declares `failure` as required and the
// invoker's accepts gate rejects calls that omit it, before the handler
// (and its repair branch) ever runs. The failure string is honest: it
// names the trial failure we're trying to repair. The handler's repair
// branch fires first and ignores it.
//
// Notify: routes through notify.fallback so a Gmail outage doesn't
// swallow the adoption follow-up. On failure, notify.console writes
// the full body to stdout — visible in the HF Space log.
//
// Save-on-growth: after adoption writes a new capability and retires
// the gap, force an out-of-cycle checkpoint to GitHub so growth
// survives a crash before the next autosave tick.

import { link, RELATIONS } from "../graph/edges.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const DEFAULT_NOTIFY = "notify.email.gmail";
const REASON_SEP = "::";

// v0.15.5 — this is only used if synthesis is disabled via env.
// Normal path: synthesize + trial, node written only on pass.
const SYNTHESIS_ENABLED = process.env.AGENTRY_SYNTHESIS_ENABLED !== "0";

// v0.32.0 — repair limits.
// Handlers over the cap are too large to fit in a single repair prompt
// alongside the error and spec; skip repair and mark the candidate
// failed rather than burn a call that will 413 or truncate mid-file.
const REPAIR_MAX_HANDLER_CHARS = 24000;
// Markers present in both plan handlers and skill handlers. If a marker
// is in the original handler but missing from the repaired one, the LLM
// re-derived the file instead of patching it, and dropped working
// structure. This is exactly the class of bug that v0.28.0 mature.mjs
// was built to prevent by using plan-mutation instead of full rewrite.
const REPAIR_BOILERPLATE_MARKERS = ["prepareSession", "artifact_magic"];

function buildPlaceholderCapability({ proposal, candidate, reason }) {
  // Only reached when SYNTHESIS_ENABLED=0 or synthesize/trial are not
  // available as capabilities. Keeps the previous behavior so this
  // batch can be rolled back with one env var.
  const capId = proposal.gap_wanted_id || proposal.gap_id;
  const capKind = proposal.gap_wanted_kind || "unknown";
  const now = Date.now();
  const provenance = candidate.kind === "web_result"
    ? `adopted:web:${candidate.domain || candidate.name || candidate.id}`
    : `adopted:github:${candidate.name || candidate.id}`;
  return {
    id: capId,
    kind: capKind,
    invoked_via: null,
    accepts: null,
    produces: null,
    source: provenance,
    notes: candidate.url || null,
    placeholder_reason: reason || "synthesis_disabled",
    adopted_from: {
      proposal_id: proposal.id,
      candidate_id: candidate.id,
      candidate_name: candidate.name || null,
      candidate_url: candidate.url || null,
      candidate_kind: candidate.kind || null,
      adopted_at: now,
    },
  };
}

function renderAdoptionEmail({ proposal, adopted, failed, retiredGap, retiredWatches }) {
  const lines = [];

  if (adopted.length) {
    lines.push(`Capability added: ${adopted.map(a => `\`${a.capability_id}\``).join(", ")}`);
    lines.push("");
    lines.push(`Kind: ${proposal.gap_wanted_kind || "unknown"}`);
    lines.push(`Gap filled: ${proposal.gap_id || "—"}`);
    lines.push("");
    lines.push("─── Auto-synthesized handlers ───");
    lines.push("");
    for (const a of adopted) {
      lines.push(`• \`${a.capability_id}\``);
      if (a.handler_path) lines.push(`  handler: \`${a.handler_path}\``);
      if (a.repaired) lines.push(`  ⚑ adopted via repair (original: \`${a.original_handler_path || "?"}\`)`);
      if (a.candidate_url) lines.push(`  source: ${a.candidate_url}`);
      if (a.trial_session) lines.push(`  trial session: \`${a.trial_session}\``);
      if (a.placeholder) lines.push(`  ⚠ placeholder (no handler) — synthesis was disabled`);
    }
    if (failed && failed.length) {
      lines.push("");
      lines.push("─── Failed (gap stays open, will retry next discovery) ───");
      lines.push("");
      for (const f of failed) {
        lines.push(`• \`${f.capability_id}\` — ${f.phase}: ${f.error}`);
        if (f.repair_attempted) lines.push(`  ⚑ repair attempted: ${f.repair_note || "(no note)"}`);
        if (f.handler_path) lines.push(`  attempt: \`${f.handler_path}\``);
        if (f.repaired_handler_path) lines.push(`  repaired: \`${f.repaired_handler_path}\``);
      }
    }
    lines.push("");
    lines.push(`Retired gap: \`${retiredGap || "none"}\``);
    lines.push(`Retired watches: ${retiredWatches.length ? retiredWatches.map(w => `\`${w}\``).join(", ") : "none"}`);
  } else {
    lines.push(`Proposal processed — nothing adopted.`);
    lines.push("");
    lines.push(`Proposal: \`${proposal.id}\``);
    lines.push(`Gap: \`${proposal.gap_id || "—"}\``);
    lines.push(`Wanted kind: ${proposal.gap_wanted_kind || "unknown"}`);
    lines.push("");
    if (failed && failed.length) {
      lines.push("─── Synthesis failures ───");
      lines.push("");
      for (const f of failed) {
        lines.push(`• \`${f.capability_id}\` — ${f.phase}: ${f.error}`);
        if (f.repair_attempted) lines.push(`  ⚑ repair attempted: ${f.repair_note || "(no note)"}`);
        if (f.handler_path) lines.push(`  attempt: \`${f.handler_path}\``);
        if (f.repaired_handler_path) lines.push(`  repaired: \`${f.repaired_handler_path}\``);
      }
      lines.push("");
      lines.push("The gap remains open. Discovery will retry on the next tick. Watches for this gap have been retired to prevent repeat emails; new watches will be created when the gap is re-observed.");
    } else {
      lines.push("The gap remains open. Discovery will propose again if a new candidate appears.");
    }
  }
  return lines.join("\n");
}

// v0.15.5 — record what the LLM tried so a human can inspect it without
// polluting the live capability set. Retired immediately.
function recordSynthesisAttempt(ctx, { proposal, candidate, phase, error, synthesis }) {
  try {
    const id = `synthesis_attempt:${proposal.id}:${candidate.id}:${Date.now()}`;
    ctx.graph.putCapability({
      id,
      kind: "synthesis_attempt",
      proposal_id: proposal.id,
      candidate_id: candidate.id,
      candidate_url: candidate.url || null,
      gap_id: proposal.gap_id || null,
      phase,
      error: String(error || "").slice(0, 800),
      handler_path: synthesis?.handler_path || null,
      seed_path: synthesis?.seed_path || null,
      capability_id_attempted: synthesis?.capability_id || null,
      retired_at: Date.now(),
      retired_reason: "synthesis_attempt_record",
    });
    ctx.events.emit("adoption.synthesis_attempt_recorded", {
      proposal_id: proposal.id,
      candidate_id: candidate.id,
      phase,
      error_preview: String(error || "").slice(0, 120),
      attempt_id: id,
    });
  } catch (e) {
    ctx.events.emit("adoption.synthesis_attempt_record_failed", { error: e.message });
  }
}

// v0.32.0 — sanity-check a repaired handler before re-trial. Four gates:
//   1. node --check (syntax)
//   2. exports: default, accept, capability
//   3. boilerplate markers preserved from original
// Any failure → caller marks candidate failed, does not re-trial.
function checkRepairedHandler(path, originalSource) {
  const res = spawnSync("node", ["--check", path], { encoding: "utf8", timeout: 15000 });
  if (res.status !== 0) {
    return { ok: false, phase: "syntax", detail: String(res.stderr || "").slice(0, 300) };
  }

  let src = "";
  try { src = readFileSync(path, "utf8"); }
  catch (e) { return { ok: false, phase: "read", detail: e.message }; }

  if (!/\bexport\s+default\b/.test(src)) {
    return { ok: false, phase: "exports", detail: "missing export default" };
  }
  if (!/export\s+(?:async\s+)?function\s+accept\b/.test(src)) {
    return { ok: false, phase: "exports", detail: "missing export accept" };
  }
  if (!/export\s+const\s+capability\b/.test(src)) {
    return { ok: false, phase: "exports", detail: "missing export capability" };
  }

  for (const marker of REPAIR_BOILERPLATE_MARKERS) {
    if (originalSource.includes(marker) && !src.includes(marker)) {
      return {
        ok: false,
        phase: "boilerplate_dropped",
        detail: "marker '" + marker + "' present in original but missing from repair — LLM re-derived instead of patching",
      };
    }
  }

  return { ok: true };
}

// v0.32.0 — the repair attempt itself. Reads the failing handler, asks
// reason.deep for a fix-or-reject decision, and if a fixed file comes
// back, sanity-checks it and re-trials. On trial pass, adopts with a
// fresh handler id (cache safety, see file header).
async function tryRepairAndRetrial(ctx, { proposal_id, proposal, candidate, synthesis, errMsg, phase, events, graph }) {
  // 1. Read original handler source.
  let handler_code = "";
  try {
    handler_code = readFileSync(synthesis.handler_path, "utf8");
  } catch (e) {
    events.emit("adoption.repair_handler_read_failed", {
      proposal_id, candidate_id: candidate.id,
      handler_path: synthesis.handler_path, error: e.message,
    });
    return { adopted: null, repaired_handler_path: null, repair_attempted: false, repair_note: "handler_read_failed: " + e.message.slice(0, 150) };
  }

  if (handler_code.length > REPAIR_MAX_HANDLER_CHARS) {
    events.emit("adoption.repair_skipped_too_large", {
      proposal_id, candidate_id: candidate.id,
      handler_path: synthesis.handler_path,
      handler_chars: handler_code.length,
      limit: REPAIR_MAX_HANDLER_CHARS,
    });
    return {
      adopted: null, repaired_handler_path: null, repair_attempted: true,
      repair_note: "handler too large to repair in one shot (" + handler_code.length + " > " + REPAIR_MAX_HANDLER_CHARS + " chars)",
    };
  }

  // 2. Ask reason.deep for a decision.
  // v0.32.1 — pass `failure` alongside `repair_context`. The seed for
  // reason.deep declares `failure` as a required accept and the invoker
  // enforces accepts BEFORE the handler runs. The failure string here is
  // the honest reason we're calling: the trial failure we're repairing.
  // The handler's `if (repair_context)` branch fires first and ignores it.
  let repairRes;
  try {
    repairRes = await ctx.invoke("agentry.reason.deep", {
      failure: "repair mode: " + synthesis.capability_id + " failed trial at phase \"" + phase + "\"",
      repair_context: {
        error: errMsg,
        phase,
        handler_code,
        spec: synthesis.spec || null,
        capability_id: synthesis.capability_id,
      },
    }, { tenant: "local", by: "agentry.adopt" });
  } catch (e) {
    events.emit("adoption.repair_threw", { proposal_id, candidate_id: candidate.id, error: e.message });
    return { adopted: null, repaired_handler_path: null, repair_attempted: true, repair_note: "reason.deep threw: " + e.message.slice(0, 150) };
  }

  if (!repairRes.ok) {
    events.emit("adoption.repair_failed", {
      proposal_id, candidate_id: candidate.id,
      code: repairRes.error?.code || "unknown",
      message: String(repairRes.error?.message || "").slice(0, 300),
    });
    return {
      adopted: null, repaired_handler_path: null, repair_attempted: true,
      repair_note: "reason.deep error: " + String(repairRes.error?.message || "unknown").slice(0, 150),
    };
  }

  const repair = repairRes.output || {};
  events.emit("adoption.repair_decided", {
    proposal_id, candidate_id: candidate.id,
    capability_id: synthesis.capability_id,
    repair_action: repair.repair_action || null,
    has_patched_code: !!repair.patched_handler_code,
    model_used: repair.model_used || null,
    reason_for_action: repair.reason_for_action ? String(repair.reason_for_action).slice(0, 200) : null,
  });

  if (repair.repair_action !== "rewrite_handler" || !repair.patched_handler_code) {
    return {
      adopted: null, repaired_handler_path: null, repair_attempted: true,
      repair_note: "reasoner: " + (repair.repair_action || "none")
        + (repair.reason_for_action ? " (" + String(repair.reason_for_action).slice(0, 150) + ")" : ""),
    };
  }

  // 3. Write repaired file. Timestamp suffix prevents collision if the
  // same capability is repaired twice across ticks.
  const ts = Date.now().toString(36);
  const repaired_path = synthesis.handler_path.replace(/\.mjs$/, "") + ".r" + ts + ".mjs";
  try {
    writeFileSync(repaired_path, repair.patched_handler_code, "utf8");
  } catch (e) {
    events.emit("adoption.repair_write_failed", {
      proposal_id, candidate_id: candidate.id, repaired_path, error: e.message,
    });
    return { adopted: null, repaired_handler_path: null, repair_attempted: true, repair_note: "write_failed: " + e.message.slice(0, 150) };
  }

  // 4. Sanity check.
  const sanity = checkRepairedHandler(repaired_path, handler_code);
  if (!sanity.ok) {
    events.emit("adoption.repair_sanity_failed", {
      proposal_id, candidate_id: candidate.id, repaired_path,
      phase: sanity.phase, detail: sanity.detail,
    });
    return {
      adopted: null, repaired_handler_path: repaired_path, repair_attempted: true,
      repair_note: "repaired handler failed " + sanity.phase + ": " + sanity.detail,
    };
  }

  // 5. Re-trial.
  let trialRes2;
  try {
    trialRes2 = await ctx.invoke("agentry.trial", {
      capability_id: synthesis.capability_id,
      handler_path: repaired_path,
      seed_path: synthesis.seed_path,
    }, { tenant: "local", by: "agentry.adopt" });
  } catch (e) {
    events.emit("adoption.repair_trial_threw", {
      proposal_id, candidate_id: candidate.id, repaired_path, error: e.message,
    });
    return { adopted: null, repaired_handler_path: repaired_path, repair_attempted: true, repair_note: "retrial threw: " + e.message.slice(0, 150) };
  }

  if (!trialRes2.ok || !trialRes2.output?.ok) {
    const errMsg2 = trialRes2.error?.message || trialRes2.output?.error || "retrial failed";
    const phase2 = trialRes2.output?.phase || "trial";
    events.emit("adoption.repair_trial_failed", {
      proposal_id, candidate_id: candidate.id,
      repaired_path, phase: phase2, error: String(errMsg2).slice(0, 400),
    });
    recordSynthesisAttempt(ctx, {
      proposal, candidate,
      phase: `repair_trial_${phase2}`,
      error: errMsg2,
      synthesis: { ...synthesis, handler_path: repaired_path },
    });
    return {
      adopted: null, repaired_handler_path: repaired_path, repair_attempted: true,
      repair_note: "retrial failed [" + phase2 + "]: " + String(errMsg2).slice(0, 180),
    };
  }

  // 6. Trial passed. Adopt with a FRESH handler id. The in_process_js
  // HANDLERS map keys on handler id and never reloads an existing fn.
  // Reusing synthesis.capability_id would run the original broken handler
  // in the same process. __r<ts> guarantees a cache miss and lazy-load of
  // the repaired file.
  const trial2 = trialRes2.output;
  const new_handler_id = synthesis.capability_id + "__r" + ts;
  const node = {
    id: synthesis.capability_id,
    kind: synthesis.kind,
    invoked_via: "invoker.in_process_js",
    handler: new_handler_id,
    handler_file: repaired_path,
    accepts: synthesis.spec?.capability?.accepts || null,
    produces: synthesis.spec?.capability?.produces || null,
    requires: synthesis.spec?.capability?.requires || {},
    source: "synthesized:repair:" + (
      candidate.kind === "npm_package" ? "npm" :
      candidate.kind === "mcp_server" ? "mcp" :
      candidate.kind === "rust_crate" ? "crates" :
      candidate.kind === "go_module" ? "gomod" :
      candidate.kind === "python_package" ? "pypi" :
      candidate.kind === "agent_skill" ? "skill" :
      candidate.kind === "repo" ? "github" : "web"
    ) + ":" + candidate.id,
    notes: candidate.url || null,
    trial: false,
    trial_passed_at: Date.now(),
    repaired_at: Date.now(),
    original_handler_file: synthesis.handler_path,
    original_trial_error: String(errMsg).slice(0, 400),
    adopted_from: {
      proposal_id: proposal.id,
      candidate_id: candidate.id,
      candidate_name: candidate.name || null,
      candidate_url: candidate.url || null,
      candidate_kind: candidate.kind || null,
      synthesized_at: Date.now(),
      handler_path: repaired_path,
      original_handler_path: synthesis.handler_path,
      seed_path: synthesis.seed_path,
      trial_session: trial2.session,
      repair_action: "rewrite_handler",
      repair_reason: repair.reason_for_action || null,
    },
  };

  try {
    graph.putCapability(node);
  } catch (e) {
    events.emit("adoption.repair_capability_add_failed", {
      proposal_id, candidate_id: candidate.id, error: e.message,
    });
    return { adopted: null, repaired_handler_path: repaired_path, repair_attempted: true, repair_note: "node write failed: " + e.message.slice(0, 150) };
  }

  try {
    if (proposal.gap_id) {
      link(graph, {
        from: node.id, to: proposal.gap_id,
        relation: RELATIONS.CAPABILITY_SATISFIES_GAP,
        meta: { via_proposal: proposal.id, candidate_id: candidate.id, repaired: true },
      });
    }
    if (candidate.id) {
      link(graph, {
        from: node.id, to: candidate.id,
        relation: RELATIONS.CAPABILITY_SOURCED_FROM,
        meta: { candidate_url: candidate.url || null, candidate_kind: candidate.kind || null, repaired: true },
      });
    }
    link(graph, {
      from: proposal.id, to: node.id,
      relation: RELATIONS.PROPOSAL_ADOPTED_CAPABILITY,
      meta: { via_candidate_id: candidate.id, repaired: true },
    });
  } catch (e) {
    events.emit("adoption.repair_edge_write_failed", {
      proposal_id, candidate_id: candidate.id, error: e.message,
    });
  }

  events.emit("adoption.capability_added_repaired", {
    proposal_id, candidate_id: candidate.id,
    capability_id: node.id, kind: node.kind,
    original_handler_path: synthesis.handler_path,
    repaired_handler_path: repaired_path,
    new_handler_id,
    repair_reason: repair.reason_for_action ? String(repair.reason_for_action).slice(0, 200) : null,
  });

  return {
    adopted: {
      candidate_id: candidate.id,
      candidate_url: candidate.url || null,
      capability_id: node.id,
      kind: node.kind,
      handler_path: repaired_path,
      original_handler_path: synthesis.handler_path,
      trial_session: trial2.session,
      repaired: true,
    },
    repaired_handler_path: repaired_path,
    repair_attempted: true,
    repair_note: "adopted after repair",
  };
}

export default async function agentryAdopt(input, ctx) {
  const { proposal_id } = input || {};
  if (!proposal_id) throw new Error("agentry.adopt requires proposal_id");
  if (typeof ctx.invoke !== "function") {
    throw new Error("agentry.adopt requires ctx.invoke");
  }

  const started = Date.now();
  const graph = ctx.graph;
  const events = ctx.events;
  const notifyCap = input.notify || DEFAULT_NOTIFY;

  const proposal = graph.getCapability(proposal_id);
  if (!proposal) throw new Error(`agentry.adopt: proposal not found: ${proposal_id}`);
  if (proposal.kind !== "proposal") throw new Error(`agentry.adopt: ${proposal_id} is kind "${proposal.kind}", not "proposal"`);

  if (proposal.adopted_at) {
    return { output: { adopted: [], failed: [], retired_gap: null, retired_watches: [], notified: false, reason: "already_adopted" }, cost: { time_ms: Date.now() - started } };
  }
  if (proposal.state !== "decided") {
    return { output: { adopted: [], failed: [], retired_gap: null, retired_watches: [], notified: false, reason: `state_is_${proposal.state || "unknown"}` }, cost: { time_ms: Date.now() - started } };
  }

  // v0.17.5 — retry cap. A proposal whose synthesis repeatedly fails
  // used to be re-processed on every discovery tick, sending a fresh
  // email each time. Now: up to MAX_RETRIES attempts, then rejected.
  const MAX_RETRIES = Number(process.env.AGENTRY_ADOPT_MAX_RETRIES || "3");
  const priorAttempts = Number(proposal.synthesis_attempt_count || 0);
  if (priorAttempts >= MAX_RETRIES) {
    events.emit("adoption.retry_exhausted", {
      proposal_id,
      attempts: priorAttempts,
      last_phase: proposal.last_failed_phase || null,
      last_error: String(proposal.last_failed_error || "").slice(0, 200),
    });
    try {
      graph.putCapability({
        id: proposal.id,
        kind: "proposal",
        state: "rejected",
        adopted_at: Date.now(),
        retry_exhausted: true,
        retry_count: priorAttempts,
        notes: "Retry cap (" + MAX_RETRIES + ") reached after repeated synthesis failures.",
      });
    } catch (e) {
      events.emit("adoption.retry_reject_failed", { proposal_id, error: e.message });
    }
    return {
      output: { adopted: [], failed: [], retired_gap: null, retired_watches: [], notified: false, reason: "retry_exhausted", attempts: priorAttempts },
      cost: { time_ms: Date.now() - started },
    };
  }

  // v0.23.0 — candidates expansion before the retry loop.
  // Reasoner proposals usually contain 1 candidate (the id reasoner
  // picked). Adopt already loops through candidates but has nothing
  // to iterate on retry — same 1 candidate, same failure, 3x. So on
  // every pass, if candidate count < 10, run discovery inline and
  // append fresh npm/agentskills candidates. Deduped against already-
  // attempted ids, so repeated calls converge rather than loop.
  if (proposal.gap_wanted_id && (proposal.candidates || []).length < 10) {
    try {
      const _attempted = new Set([
        ...(proposal.candidates || []).map(c => c.id),
        ...((proposal.failed_syntheses || []).map(f => f.candidate_id)),
      ]);
      const _query = String(proposal.gap_wanted_id).replace(/^[a-z]+:/, "");
      const _disc = await ctx.invoke("agentry.discover", {
        query: _query,
        sources: ["npm", "agentskills_code"],
        limit: 10,
      }, { tenant: "local", by: "agentry.adopt" });
      if (_disc.ok && _disc.output && _disc.output.results) {
        const _fresh = [];
        for (const _src of ["npm", "agentskills_code"]) {
          const _items = _disc.output.results[_src] || [];
          for (const _it of _items) {
            if (!_it || !_it.id || _attempted.has(_it.id)) continue;
            const _kind = _src === "npm" ? "npm_package" : "agent_skill";
            _fresh.push({
              id: _it.id,
              source: _src,
              kind: _kind,
              name: _it.name || _it.id,
              url: _it.url || null,
              description: _it.description || null,
              meta: {},
            });
            _attempted.add(_it.id);
            if (_fresh.length >= 5) break;
          }
          if (_fresh.length >= 5) break;
        }
        if (_fresh.length > 0) {
          const _newCandidates = [...(proposal.candidates || []), ..._fresh];
          const _newDecisions = { ...(proposal.decisions || {}) };
          for (const _f of _fresh) {
            _newDecisions[_f.id] = { decision: "approved", at: Date.now(), auto: true, source: "expansion" };
          }
          try {
            graph.putCapability({
              id: proposal.id,
              kind: "proposal",
              candidates: _newCandidates,
              decisions: _newDecisions,
            });
            events.emit("adoption.candidates_expanded", {
              proposal_id,
              added: _fresh.map(f => f.id),
              total: _newCandidates.length,
            });
            proposal.candidates = _newCandidates;
            proposal.decisions = _newDecisions;
          } catch (e) {
            events.emit("adoption.expansion_write_failed", { proposal_id, error: e.message });
          }
        }
      }
    } catch (e) {
      events.emit("adoption.expansion_threw", { proposal_id, error: e.message });
    }
  }

  const decisions = proposal.decisions || {};
  const approved = Object.entries(decisions)
    .filter(([, d]) => d?.decision === "approved")
    .map(([candidateId, d]) => ({ candidateId, decidedAt: d.at }));

  const candidateById = new Map();
  for (const c of proposal.candidates || []) candidateById.set(c.id, c);

  const adopted = [];
  const failed = [];
  const now = Date.now();

  // ── Batch 14: synthesize → trial → adopt on pass ──
  const synthCap = graph.getCapability("agentry.synthesize");
  const trialCap = graph.getCapability("agentry.trial");
  const synthesisAvailable = SYNTHESIS_ENABLED && synthCap && trialCap;

  if (!synthesisAvailable) {
    events.emit("adoption.synthesis_unavailable", {
      proposal_id,
      enabled: SYNTHESIS_ENABLED,
      has_synthesize: !!synthCap,
      has_trial: !!trialCap,
    });
  }

  for (const { candidateId } of approved) {
    const candidate = candidateById.get(candidateId);
    if (!candidate) {
      events.emit("adoption.candidate_missing", { proposal_id, candidate_id: candidateId });
      continue;
    }

    // ── Fallback path: no synthesis available ──
    if (!synthesisAvailable) {
      const node = buildPlaceholderCapability({
        proposal, candidate,
        reason: !SYNTHESIS_ENABLED ? "synthesis_disabled" : "synthesis_capabilities_missing",
      });
      try {
        graph.putCapability(node);
        adopted.push({
          candidate_id: candidateId,
          candidate_url: candidate.url || null,
          capability_id: node.id,
          kind: node.kind,
          placeholder: true,
        });
        events.emit("adoption.capability_added_placeholder", {
          proposal_id, candidate_id: candidateId,
          capability_id: node.id, kind: node.kind, source: node.source,
          reason: node.placeholder_reason,
        });
      } catch (e) {
        events.emit("adoption.capability_add_failed", { proposal_id, candidate_id: candidateId, error: e.message });
        failed.push({ candidate_id: candidateId, capability_id: node.id, phase: "node_write", error: e.message });
      }
      continue;
    }

    // ── Synthesis path ──
    let synthesis = null;
    try {
      const synRes = await ctx.invoke("agentry.synthesize", {
        proposal_id,
        candidate_id: candidateId,
      }, { tenant: "local", by: "agentry.adopt" });

      if (!synRes.ok) {
        const errMsg = synRes.error.message;
        events.emit("adoption.synthesize_failed", {
          proposal_id, candidate_id: candidateId,
          code: synRes.error.code, message: errMsg,
        });
        recordSynthesisAttempt(ctx, { proposal, candidate, phase: "synthesize", error: errMsg });
        failed.push({
          candidate_id: candidateId,
          capability_id: proposal.gap_wanted_id || proposal.gap_id,
          phase: "synthesize",
          error: errMsg,
        });
        continue;
      }

      synthesis = synRes.output;
      events.emit("adoption.synthesize_completed", {
        proposal_id, candidate_id: candidateId,
        capability_id: synthesis.capability_id,
        handler_path: synthesis.handler_path,
      });
    } catch (e) {
      events.emit("adoption.synthesize_threw", { proposal_id, candidate_id: candidateId, error: e.message });
      recordSynthesisAttempt(ctx, { proposal, candidate, phase: "synthesize_threw", error: e.message });
      failed.push({
        candidate_id: candidateId,
        capability_id: proposal.gap_wanted_id || proposal.gap_id,
        phase: "synthesize",
        error: e.message,
      });
      continue;
    }

    // ── Trial ──
    let trial = null;
    try {
      const trialRes = await ctx.invoke("agentry.trial", {
        capability_id: synthesis.capability_id,
        handler_path: synthesis.handler_path,
        seed_path: synthesis.seed_path,
      }, { tenant: "local", by: "agentry.adopt" });

      if (!trialRes.ok || !trialRes.output?.ok) {
        const errMsg = trialRes.error?.message || trialRes.output?.error || "trial failed";
        const phase = trialRes.output?.phase || "trial";
        events.emit("adoption.trial_failed", {
          proposal_id, candidate_id: candidateId,
          capability_id: synthesis.capability_id,
          phase,
          error: errMsg,
        });
        recordSynthesisAttempt(ctx, {
          proposal, candidate, phase: `trial_${phase}`,
          error: errMsg, synthesis,
        });

        // v0.32.0 — repair attempt before marking the candidate failed.
        // One attempt per candidate per adopt tick. If repair adopts,
        // the candidate lands in `adopted` (not both lists).
        const repair = await tryRepairAndRetrial(ctx, {
          proposal_id, proposal, candidate, synthesis, errMsg, phase, events, graph,
        });

        if (repair.adopted) {
          adopted.push(repair.adopted);
          continue;
        }

        failed.push({
          candidate_id: candidateId,
          capability_id: synthesis.capability_id,
          phase: `trial_${phase}`,
          error: errMsg,
          handler_path: synthesis.handler_path,
          repair_attempted: repair.repair_attempted,
          repair_note: repair.repair_note || null,
          repaired_handler_path: repair.repaired_handler_path || null,
        });
        continue;
      }

      trial = trialRes.output;
      events.emit("adoption.trial_completed", {
        proposal_id, candidate_id: candidateId,
        capability_id: synthesis.capability_id,
        session: trial.session,
      });
    } catch (e) {
      events.emit("adoption.trial_threw", { proposal_id, candidate_id: candidateId, error: e.message });
      recordSynthesisAttempt(ctx, { proposal, candidate, phase: "trial_threw", error: e.message, synthesis });
      failed.push({
        candidate_id: candidateId,
        capability_id: synthesis.capability_id,
        phase: "trial_threw",
        error: e.message,
        handler_path: synthesis.handler_path,
      });
      continue;
    }

    // ── Pass. Write the real capability node. ──
    const node = {
      id: synthesis.capability_id,
      kind: synthesis.kind,
      invoked_via: "invoker.in_process_js",
      handler: synthesis.capability_id,
      handler_file: synthesis.handler_path,
      accepts: synthesis.spec?.capability?.accepts || null,
      produces: synthesis.spec?.capability?.produces || null,
      requires: synthesis.spec?.capability?.requires || {},
      source: "synthesized:" + (
        candidate.kind === "npm_package" ? "npm" :
        candidate.kind === "mcp_server" ? "mcp" :
        candidate.kind === "rust_crate" ? "crates" :
        candidate.kind === "go_module" ? "gomod" :
        candidate.kind === "python_package" ? "pypi" :
        candidate.kind === "agent_skill" ? "skill" :
        candidate.kind === "repo" ? "github" : "web"
      ) + ":" + candidate.id,
      notes: candidate.url || null,
      trial: false,
      trial_passed_at: Date.now(),
      adopted_from: {
        proposal_id: proposal.id,
        candidate_id: candidate.id,
        candidate_name: candidate.name || null,
        candidate_url: candidate.url || null,
        candidate_kind: candidate.kind || null,
        synthesized_at: now,
        handler_path: synthesis.handler_path,
        seed_path: synthesis.seed_path,
        trial_session: trial.session,
      },
    };

    try {
      graph.putCapability(node);
      adopted.push({
        candidate_id: candidateId,
        candidate_url: candidate.url || null,
        capability_id: node.id,
        kind: node.kind,
        handler_path: synthesis.handler_path,
        trial_session: trial.session,
      });
      events.emit("adoption.capability_added", {
        proposal_id, candidate_id: candidateId,
        capability_id: node.id, kind: node.kind,
        handler_path: synthesis.handler_path,
        source: node.source,
      });
      // v0.16.0 — typed edges for this adoption.
      try {
        if (proposal.gap_id) {
          link(graph, {
            from: node.id,
            to: proposal.gap_id,
            relation: RELATIONS.CAPABILITY_SATISFIES_GAP,
            meta: { via_proposal: proposal.id, candidate_id: candidate.id },
          });
        }
        if (candidate.id) {
          link(graph, {
            from: node.id,
            to: candidate.id,
            relation: RELATIONS.CAPABILITY_SOURCED_FROM,
            meta: { candidate_url: candidate.url || null, candidate_kind: candidate.kind || null },
          });
        }
        link(graph, {
          from: proposal.id,
          to: node.id,
          relation: RELATIONS.PROPOSAL_ADOPTED_CAPABILITY,
          meta: { via_candidate_id: candidate.id },
        });
      } catch (e) {
        events.emit("adoption.edge_write_failed", {
          proposal_id, candidate_id: candidateId, capability_id: node.id, error: e.message,
        });
      }
    } catch (e) {
      events.emit("adoption.capability_add_failed", { proposal_id, candidate_id: candidateId, error: e.message });
      failed.push({
        candidate_id: candidateId,
        capability_id: synthesis.capability_id,
        phase: "node_write",
        error: e.message,
        handler_path: synthesis.handler_path,
      });
    }
  }

  // ── Retire gap only if at least one capability landed ──
  let retiredGap = null;
  if (adopted.length > 0 && proposal.gap_id) {
    const gap = graph.getCapability(proposal.gap_id);
    if (gap && !gap.retired_at) {
      try {
        graph.retireCapability(proposal.gap_id, `adopted via proposal ${proposal_id}`);
        retiredGap = proposal.gap_id;
        events.emit("adoption.gap_retired", { proposal_id, gap_id: proposal.gap_id });
      } catch (e) {
        events.emit("adoption.gap_retire_failed", { proposal_id, gap_id: proposal.gap_id, error: e.message });
      }
    }
  }

  // ── Retire watches: exact gap_id OR prefix "<gap_id>::" ──
  const retiredWatches = [];
  if (proposal.gap_id) {
    const exact = proposal.gap_id;
    const prefix = `${proposal.gap_id}${REASON_SEP}`;
    for (const cap of graph.capabilities().values()) {
      if (cap.kind !== "watch_instance") continue;
      if (cap.retired_at) continue;
      const r = cap.reason;
      const isMatch = r === exact || (typeof r === "string" && r.startsWith(prefix));
      if (!isMatch) continue;
      try {
        graph.retireCapability(cap.id, `proposal ${proposal_id} decided`);
        retiredWatches.push(cap.id);
        events.emit("adoption.watch_retired", { proposal_id, watch_id: cap.id, gap_id: proposal.gap_id });
      } catch (e) {
        events.emit("adoption.watch_retire_failed", { proposal_id, watch_id: cap.id, error: e.message });
      }
    }
  }

  // v0.17.5 — attempt counting. Every failed tick increments; at
  // MAX_RETRIES we reject. Otherwise the proposal stays "decided" and
  // will be retried on the next discovery tick. No email on retries.
  const lastFailed = failed.length ? failed[failed.length - 1] : null;
  const newAttempts = priorAttempts + (failed.length > 0 && adopted.length === 0 ? 1 : 0);
  const wasAdopted = adopted.length > 0;
  const retryExhausted = !wasAdopted && newAttempts >= MAX_RETRIES;
  const scheduledRetry = !wasAdopted && !retryExhausted && failed.length > 0;
  const terminal = !scheduledRetry;

  graph.putCapability({
    id: proposal.id,
    kind: "proposal",
    ...(terminal ? { adopted_at: now } : {}),
    state: wasAdopted ? "adopted" : (retryExhausted ? "rejected" : (scheduledRetry ? "decided" : "rejected")),
    adopted_capability_ids: adopted.map(a => a.capability_id),
    failed_syntheses: failed.map(f => ({
      candidate_id: f.candidate_id,
      capability_id: f.capability_id,
      phase: f.phase,
      error: f.error,
      ...(f.repair_attempted ? { repair_attempted: true, repair_note: f.repair_note || null } : {}),
    })),
    synthesis_attempt_count: newAttempts,
    last_failed_phase: lastFailed ? lastFailed.phase : (proposal.last_failed_phase || null),
    last_failed_error: lastFailed ? String(lastFailed.error || "").slice(0, 400) : (proposal.last_failed_error || null),
    retry_exhausted: retryExhausted || undefined,
    retired_gap_id: retiredGap,
    retired_watch_ids: retiredWatches,
  });

  if (scheduledRetry) {
    events.emit("adoption.retry_scheduled", {
      proposal_id,
      attempt: newAttempts,
      max_retries: MAX_RETRIES,
      last_phase: lastFailed ? lastFailed.phase : null,
    });
    return {
      output: {
        adopted, failed,
        retired_gap: retiredGap,
        retired_watches: retiredWatches,
        notified: false,
        reason: "retry_scheduled",
        attempt: newAttempts,
        max_retries: MAX_RETRIES,
      },
      cost: { time_ms: Date.now() - started },
    };
  }

  events.emit("proposal.adopted", {
    proposal_id, adopted, failed,
    retired_gap: retiredGap, retired_watches: retiredWatches,
    decision: adopted.length > 0 ? "adopted" : "rejected",
    attempt: newAttempts,
    retry_exhausted: retryExhausted,
  });

  // ─── Checkpoint on growth ───
  if (adopted.length > 0) {
    try {
      await ctx.invoke("agentry.checkpoint", {
        reason: `adopt:${adopted.length}_capabilities`,
      }, { tenant: "local", by: "agentry.adopt" });
    } catch (e) {
      events.emit("adoption.checkpoint_failed", { proposal_id, error: e.message });
    }
  }

  const body = renderAdoptionEmail({ proposal, adopted, failed, retiredGap, retiredWatches });
  const subject = adopted.length > 0
    ? `[agentry] adopted: ${adopted.map(a => a.capability_id).join(", ")}`
    : (failed.length > 0
        ? `[agentry] synthesis failed: ${proposal.gap_wanted_kind || proposal.id}`
        : `[agentry] rejected: ${proposal.gap_wanted_kind || proposal.id}`);

  let notified = false;
  try {
    const notifyRes = await ctx.invoke("notify.fallback", {
      subject,
      body_markdown: body,
      primary: notifyCap,
      fallback: "notify.console",
    }, { tenant: "local", by: "agentry.adopt" });
    notified = notifyRes.ok === true;
    if (!notified) {
      events.emit("adoption.notify_failed", {
        proposal_id,
        code: notifyRes.error?.code,
        message: notifyRes.error?.message,
      });
    } else {
      events.emit("adoption.notified", {
        proposal_id,
        channel: notifyRes.output.channel,
        primary_ok: notifyRes.output.primary_ok,
        fallback_used: notifyRes.output.fallback_used,
        message_id: notifyRes.output.message_id || null,
      });
    }
  } catch (e) {
    events.emit("adoption.notify_threw", { proposal_id, error: e.message });
  }

  return {
    output: {
      adopted,
      failed,
      retired_gap: retiredGap,
      retired_watches: retiredWatches,
      notified,
      delivered_via: notified ? "notify.fallback" : null,
      reason: adopted.length > 0
        ? "adopted"
        : (failed.length > 0 ? "synthesis_failed" : "rejected"),
    },
    cost: { time_ms: Date.now() - started },
  };
}
