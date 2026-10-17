// agentry/src/handlers/watcher.polling.mjs
import { invoke } from "../invoke.mjs";
import { link, RELATIONS } from "../graph/edges.mjs";

const watches = new Map();
export function getWatches() { return watches; }
export function clearWatches() { watches.clear(); }

const REASON_SEP = "::";

// reason format: "<gap.id>::<source>" (new)
//                or "<gap.id>"         (legacy)
function extractGapId(reason) {
  if (typeof reason !== "string" || !reason) return null;
  if (reason.includes(REASON_SEP)) {
    return reason.split(REASON_SEP)[0];
  }
  if (reason.startsWith("gap:")) return reason;
  return null;
}

export default async function watcherPolling(input, ctx) {
  const { source, query, interval_ms, dedupe_key, on_new, reason } = input || {};
  if (!source) throw new Error("watcher.polling requires source (a discovery capability id)");
  if (!query) throw new Error("watcher.polling requires query");
  if (!interval_ms || interval_ms < 1000) throw new Error("watcher.polling requires interval_ms >= 1000");
  if (!dedupe_key) throw new Error("watcher.polling requires dedupe_key");
  if (!on_new) throw new Error("watcher.polling requires on_new (a notify capability id)");

  if (!ctx.graph.getCapability(source)) throw new Error(`watcher.polling: unknown source ${source}`);
  if (!ctx.graph.getCapability(on_new)) throw new Error(`watcher.polling: unknown on_new ${on_new}`);

  const id = `watch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const watch = {
    id, kind: "watch_instance",
    source, query, interval_ms, dedupe_key, on_new,
    seen_ids: [], last_poll_at: null, last_error: null,
    created_by: ctx.task_id || "agentry.runtime",
    reason: reason || "unspecified",
    created_at: Date.now(), updated_at: Date.now(),
  };

  ctx.graph.putCapability({ ...watch, invoked_via: null, accepts: null, produces: null });
  watches.set(id, watch);

  ctx.events.emit("watch.created", {
    watch_id: id, source, on_new, interval_ms, reason: watch.reason,
    task_id: ctx.task_id ?? null,
  });

  return { output: { watch_id: id, state: watch } };
}

export function dueWatches(now = Date.now()) {
  const due = [];
  for (const w of watches.values()) {
    const last = w.last_poll_at || 0;
    if (now - last >= w.interval_ms) due.push(w);
  }
  return due;
}

export async function pollWatch(deps, watch) {
  const { graph, events } = deps;
  const startedAt = Date.now();
  let candidates = [];
  let errorMsg = null;

  try {
    const result = await invoke(deps, watch.source, { query: watch.query, limit: 30 }, {
      task_id: null, tenant: "local", by: "runtime",
    });
    if (result.ok && Array.isArray(result.output?.candidates)) {
      candidates = result.output.candidates;
    } else if (result.ok && result.output?.results && typeof result.output.results === "object") {
      // v0.23.6 — agentry.discover shape: { results: { source: [items] } }
      // Flatten into a single candidate list so the rest of the watcher
      // (dedupe, watch_result, notify) sees uniform items.
      const flat = [];
      for (const [src, items] of Object.entries(result.output.results)) {
        if (!Array.isArray(items)) continue;
        for (const it of items) {
          if (it && typeof it === "object") flat.push({ ...it, source: it.source || src });
        }
      }
      candidates = flat;
    } else if (!result.ok) {
      errorMsg = `${result.error.code}: ${result.error.message}`;
    }
  } catch (e) {
    errorMsg = e.message;
  }

  const seen = new Set(watch.seen_ids || []);
  const fresh = [];
  for (const c of candidates) {
    const key = computeDedupe(watch.dedupe_key, c);
    if (!key) continue;
    if (!seen.has(key)) { fresh.push({ key, candidate: c }); seen.add(key); }
  }

  const updated = {
    ...watch,
    seen_ids: Array.from(seen).slice(-10000),
    last_poll_at: Date.now(),
    last_error: errorMsg,
    updated_at: Date.now(),
  };
  graph.putCapability({
    id: watch.id, kind: "watch_instance",
    seen_ids: updated.seen_ids,
    last_poll_at: updated.last_poll_at,
    last_error: updated.last_error,
    updated_at: updated.updated_at,
  });
  watches.set(watch.id, updated);

  events.emit("watch.polled", {
    watch_id: watch.id, source: watch.source,
    candidates: candidates.length, fresh: fresh.length,
    error: errorMsg, ms: Date.now() - startedAt,
  });

  // Persist fresh candidates as a `watch_result` node so the discovery
  // loop can turn them into a proposal on its next tick. The watch node
  // carries only seen_ids; the candidate objects live here.
  if (fresh.length > 0) {
    const resultId = `watch_result:${watch.id}:${Date.now()}`;
    const gapId = extractGapId(watch.reason);
    graph.putCapability({
      id: resultId,
      kind: "watch_result",
      watch_id: watch.id,
      gap_id: gapId,
      source: watch.source,
      candidates: fresh.map(f => f.candidate),
      created_at: Date.now(),
    });
    if (gapId) {
      try {
        link(graph, {
          from: resultId,
          to: gapId,
          relation: RELATIONS.WATCH_RESULT_FOR_GAP,
          meta: { source: watch.source, candidate_count: fresh.length },
        });
      } catch (e) {
        events.emit("watch.edge_write_failed", {
          watch_result_id: resultId, gap_id: gapId, error: e.message,
        });
      }
    }
    events.emit("watch.result_recorded", {
      watch_result_id: resultId,
      watch_id: watch.id,
      gap_id: gapId,
      source: watch.source,
      candidates: fresh.length,
    });
  }

  // v0.15.21: one batched notify per poll, not one per candidate.
  // Previously a watch that returned 30 fresh candidates sent 30
  // emails. Now it sends one email listing all of them. The
  // on_new handler may still fan out if it wants to; this layer
  // does not.
  let notified = 0;
  if (fresh.length > 0) {
    try {
      await invoke(deps, watch.on_new, {
        subject: `[agentry] ${fresh.length} new from ${watch.source}`,
        body_markdown: renderBatch(watch, fresh),
        priority: "normal",
        candidate_count: fresh.length,
        candidate_ids: fresh
          .map(f => f.candidate?.id || f.candidate?.url || null)
          .filter(Boolean),
      }, { task_id: null, tenant: "local", by: "runtime" });
      notified = 1;
      events.emit("watch.notified", {
        watch_id: watch.id,
        source: watch.source,
        candidate_count: fresh.length,
      });
    } catch (e) {
      events.emit("watch.notify_failed", { watch_id: watch.id, error: e.message });
    }
  }

  return { polled: true, candidates: candidates.length, fresh: fresh.length, notified, error: errorMsg };
}

function computeDedupe(expr, obj) {
  const parts = expr.split("+").map(s => s.trim());
  const values = [];
  for (const part of parts) {
    let v = obj;
    for (const p of part.split(".")) v = v?.[p];
    if (v !== undefined && v !== null) values.push(String(v));
  }
  return values.length ? values.join("|") : null;
}

function renderBatch(watch, fresh) {
  const lines = [];
  lines.push(`**Watch:** \`${watch.id}\``);
  lines.push(`**Source:** \`${watch.source}\``);
  lines.push(`**New candidates:** ${fresh.length}`);
  lines.push("");
  for (const { candidate } of fresh) {
    const id = candidate?.id || candidate?.url || "(unknown id)";
    const name = candidate?.name || candidate?.title || null;
    const url = candidate?.url || null;
    const desc = (candidate?.description || candidate?.snippet || "").slice(0, 140);
    lines.push(`- \`${id}\``);
    if (name && name !== id) lines.push(`  - name: ${name}`);
    if (url && url !== id) lines.push(`  - url: ${url}`);
    if (desc) lines.push(`  - ${desc}`);
  }
  return lines.join("\n");
}
