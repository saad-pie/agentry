// agentry/src/graph/runs.mjs
//
// v0.16.1 — runs as a separate append-only log.
//
// Before this, invoke() wrote a reliability update to the capability
// node on EVERY call. One JSON line per invoke, forever, in
// capabilities.jsonl. That's why a graph with 32 live nodes was 865
// lines and growing linearly with total invocations. And the
// reliability block was a scalar snapshot with no history — no way
// to ask "what did this capability do last Tuesday in session X."
//
// Runs now go to their own file: runs.jsonl. Same append-only model,
// but NOT autosaved (individual runs are working data, not durable
// state; the aggregated reliability on the capability node is what
// survives). Capability reliability is a periodic rollup over the
// runs log.

import { appendFileSync, readFileSync, existsSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const RUNS_FILE = "runs.jsonl";
const MAX_RUNS_BYTES = 8 * 1024 * 1024;
const KEEP_LINES = 5000;

function runsPath(graph) {
  return join(graph.dir, RUNS_FILE);
}

function rid() {
  return "run_" + Date.now().toString(36) + "_" + randomBytes(4).toString("hex");
}

export function recordRun(graph, run) {
  if (!run || !run.capability_id) return null;
  const rec = {
    id: rid(),
    capability_id: run.capability_id,
    session_id: run.session_id || null,
    tenant: run.tenant || null,
    by: run.by || null,
    task_id: run.task_id || null,
    ok: run.ok === true,
    ms: Number(run.ms) || 0,
    error_code: run.error_code || null,
    error_message: run.error_message ? String(run.error_message).slice(0, 300) : null,
    cost: run.cost || null,
    at: Date.now(),
  };
  try {
    appendFileSync(runsPath(graph), JSON.stringify(rec) + "\n");
    maybeTruncate(graph);
  } catch (e) {}
  return rec;
}

function maybeTruncate(graph) {
  try {
    const p = runsPath(graph);
    if (!existsSync(p)) return;
    if (statSync(p).size < MAX_RUNS_BYTES) return;
    const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
    writeFileSync(p, lines.slice(-KEEP_LINES).join("\n") + "\n");
  } catch (e) {}
}

export function readRuns(graph) {
  const p = runsPath(graph);
  if (!existsSync(p)) return [];
  const raw = readFileSync(p, "utf8");
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch (e) {}
  }
  return out;
}

export function findRuns(graph, filter = {}) {
  const { capability_id, session_id, ok, since } = filter;
  return readRuns(graph).filter(r => {
    if (capability_id !== undefined && r.capability_id !== capability_id) return false;
    if (session_id !== undefined && r.session_id !== session_id) return false;
    if (ok !== undefined && r.ok !== ok) return false;
    if (since !== undefined && r.at < since) return false;
    return true;
  });
}

export function rollupReliability(graph, events) {
  const all = readRuns(graph);
  if (!all.length) return { rolled: 0, runs: 0 };

  const byCap = new Map();
  for (const r of all) {
    if (!byCap.has(r.capability_id)) byCap.set(r.capability_id, []);
    byCap.get(r.capability_id).push(r);
  }

  let rolled = 0;
  for (const [capId, runs] of byCap) {
    const cap = graph.getCapability(capId);
    if (!cap) continue;
    if (cap.kind === "edge") continue;

    const sortedMs = runs.map(r => r.ms).filter(n => Number.isFinite(n)).sort((a, b) => a - b);
    const successes = runs.filter(r => r.ok).length;
    const p50 = sortedMs.length ? sortedMs[Math.floor(sortedMs.length * 0.50)] : null;
    const p99 = sortedMs.length ? sortedMs[Math.floor(sortedMs.length * 0.99)] : null;
    const lastRunAt = runs.reduce((a, r) => Math.max(a, r.at || 0), 0);

    try {
      graph.putCapability({
        id: capId,
        reliability: {
          runs: runs.length,
          successes,
          success_rate: runs.length ? successes / runs.length : null,
          p50_ms: p50,
          p99_ms: p99,
          last_run_at: lastRunAt || null,
        },
      });
      rolled++;
    } catch (e) {
      events?.emit("runs.rollup_write_failed", { capability_id: capId, error: e.message });
    }
  }

  events?.emit("runs.rollup_completed", { capabilities: rolled, runs: all.length });
  return { rolled, runs: all.length };
}

export function startRollupTimer(graph, events, intervalMs = 300000) {
  const ms = Math.max(30000, Number(intervalMs) || 300000);
  const t = setInterval(() => {
    try { rollupReliability(graph, events); } catch (e) {
      events?.emit("runs.rollup_failed", { error: e.message });
    }
  }, ms);
  if (typeof t.unref === "function") t.unref();
  return t;
}
