// agentry/src/graph.mjs
// The capability graph. Append-only. Replayable. One file, one truth.
//
// Design rules:
//   - Every node is a JSON line in capabilities.jsonl.
//   - Current state of a node = fold all lines with the same id, in order.
//   - No mutations. To change a node, append a new line with a bumped version.
//   - Delete is not a thing. Mark `retired_at` and stop selecting it.
//   - Rebuild from disk on every read. Cheap at our scale. Always correct.
//   - The graph owns exactly six fields on a node: id, kind, version,
//     discovered_at, updated_at, retired_at. Every other field belongs to
//     the caller and is preserved verbatim. This is what makes capabilities
//     open-ended — a gap node can carry `hits`, a watch node can carry
//     `seen_ids`, and the graph doesn't need to know about either.

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { errors } from "./errors.mjs";

export class CapabilityGraph {
  /**
   * @param {object} opts
   * @param {string} opts.dir       — directory for JSONL files
   */
  constructor({ dir }) {
    if (!dir) throw errors.internal("CapabilityGraph requires opts.dir");
    this.dir = dir;
    this.capsFile = join(dir, "capabilities.jsonl");
    this.tasksFile = join(dir, "tasks.jsonl");
    mkdirSync(dir, { recursive: true });
    this._cache = null;
  }

  // ---------- cache ----------
  /**
   * Clear the in-memory cache so the next read re-reads from disk.
   * Needed because multiple processes (the MCP server, the discovery
   * loop, the CLI) share the same JSONL files. When one process writes
   * a node, the others still hold stale in-memory snapshots until they
   * invalidate.
   */
  invalidateCache() {
    this._cache = null;
  }

  // ---------- low-level: append + read ----------
  _append(file, obj) {
    appendFileSync(file, JSON.stringify(obj) + "\n");
    this._cache = null; // invalidate
  }

  _readAll(file) {
    if (!existsSync(file)) return [];
    const raw = readFileSync(file, "utf8");
    const out = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch (e) {
        // A corrupt line is not fatal; log and skip. Append-only means we can
        // always find the last good version of anything.
        console.error(`[graph] skipping malformed line in ${file}: ${e.message}`);
      }
    }
    return out;
  }

  // ---------- capability views ----------
  /**
   * Fold capabilities.jsonl into the current set of live capabilities.
   * A capability is a node; every write is a new line with the same id and
   * a bumped `version`. The last line wins for that id.
   */
  capabilities() {
    if (this._cache?.caps) return this._cache.caps;
    const map = new Map();
    for (const line of this._readAll(this.capsFile)) {
      if (!line.id) continue;
      map.set(line.id, line); // last wins
    }
    const live = new Map();
    for (const [id, cap] of map) {
      if (cap.retired_at) continue;
      live.set(id, cap);
    }
    this._cache = { ...(this._cache || {}), caps: live };
    return live;
  }

  getCapability(id) {
    return this.capabilities().get(id) || null;
  }

  /**
   * Add or update a capability.
   *
   * Graph-owned fields (always set by this method, never by the caller in
   * a way that can be silently overwritten by a spread):
   *   id, kind, version, discovered_at, updated_at
   *
   * Standard fields with defaults (preserved if set, else defaulted):
   *   accepts, produces, cost, limits, reliability, invoked_via, source,
   *   retired_at, notes
   *
   * Everything else the caller passes is preserved verbatim. That's how
   * kind-specific fields (wanted_kind, hits, seen_ids, ...) survive.
   *
   * Bumps `version` automatically if the id already exists.
   */
  putCapability(cap) {
    if (!cap?.id) throw errors.invalidCapability("<no id>", { reason: "id required" });
    const existing = this.getCapability(cap.id);
    const now = Date.now();

    // Order matters:
    //   1. Start from the existing node so kind-specific fields survive.
    //   2. Overlay the caller's fields.
    //   3. Force graph-owned fields to their correct values.
    //   4. Apply defaults only where nothing has been set anywhere.
    const node = {
      // (1) preserve existing
      ...(existing || {}),
      // (2) overlay caller
      ...cap,
      // (3) graph-owned fields always win
      id: cap.id,
      kind: cap.kind || existing?.kind || "unknown",
      version: (existing?.version || 0) + 1,
      discovered_at: existing?.discovered_at ?? now,
      updated_at: now,
      // (4) defaults only where nothing is set
      accepts: cap.accepts ?? existing?.accepts ?? null,
      produces: cap.produces ?? existing?.produces ?? null,
      cost: cap.cost ?? existing?.cost ?? {},
      limits: cap.limits ?? existing?.limits ?? {},
      reliability: cap.reliability ?? existing?.reliability
        ?? { success_rate: null, p50_ms: null, p99_ms: null },
      invoked_via: cap.invoked_via ?? existing?.invoked_via ?? null,
      source: cap.source ?? existing?.source ?? "unknown",
      notes: cap.notes ?? existing?.notes ?? null,
      retired_at: cap.retired_at ?? existing?.retired_at ?? null,
    };

    this._append(this.capsFile, node);
    return node;
  }

  /** Retire a capability. Data stays; it just stops being selected. */
  retireCapability(id, reason = null) {
    const existing = this.getCapability(id);
    if (!existing) throw errors.invalidCapability(id);
    const node = {
      ...existing,
      version: existing.version + 1,
      retired_at: Date.now(),
      retired_reason: reason,
      updated_at: Date.now(),
    };
    this._append(this.capsFile, node);
    return node;
  }

  /**
   * Select capabilities matching a predicate, sorted by a scoring function.
   * This is the ground floor of election — the caller supplies the scorer.
   * Returning [] is valid (a gap).
   */
  select(predicate = () => true, score = () => 0, limit = Infinity) {
    const out = [];
    for (const cap of this.capabilities().values()) {
      if (predicate(cap)) out.push({ cap, score: score(cap) });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit === Infinity ? out.length : limit).map(x => x.cap);
  }

  /** Find gaps: kinds that are referenced but have zero live capabilities. */
  gapsFor(kinds = []) {
    const have = new Set();
    for (const cap of this.capabilities().values()) have.add(cap.kind);
    return kinds.filter(k => !have.has(k));
  }

  // ---------- task views ----------
  /** Fold tasks.jsonl into current tasks. Same model as capabilities. */
  tasks() {
    if (this._cache?.tasks) return this._cache.tasks;
    const map = new Map();
    for (const line of this._readAll(this.tasksFile)) {
      if (!line.id) continue;
      map.set(line.id, { ...(map.get(line.id) || {}), ...line });
    }
    this._cache = { ...(this._cache || {}), tasks: map };
    return map;
  }

  getTask(id) {
    return this.tasks().get(id) || null;
  }

  putTask(task) {
    if (!task?.id) throw errors.internal("task.id required");
    this._append(this.tasksFile, task);
    return task;
  }
}
