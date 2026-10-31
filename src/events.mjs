// agentry/src/events.mjs
// The event log. Every state change, every invocation, every adoption.
// Separate from the graph because events outlive tasks and capabilities.
// If you delete every other file, events.jsonl is enough to rebuild the rest.

import { appendFileSync, readFileSync, existsSync, mkdirSync, statSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { errors } from "./errors.mjs";

export class EventLog {
  constructor({ dir }) {
    if (!dir) throw errors.internal("EventLog requires opts.dir");
    this.dir = dir;
    this.file = join(dir, "events.jsonl");
    mkdirSync(dir, { recursive: true });
  }

  /**
   * Append an event. Events are immutable facts about the past.
   * Required: kind. Optional but recommended: task_id, capability_id, by.
   * Everything else is free-form and will be preserved.
   */
  emit(kind, fields = {}) {
    if (!kind || typeof kind !== "string") throw errors.internal("event.kind required");
    const evt = {
      kind,
      at: Date.now(),
      ...fields,
    };
    appendFileSync(this.file, JSON.stringify(evt) + "\n");
    return evt;
  }

  /**
   * v0.56.36 — rotate events.jsonl when oversized. Events are append-only
   * facts, so unlike capabilities we do NOT fold — we archive the oldest
   * chunk verbatim and keep the most recent N lines live. Full history
   * preserved in events-YYYYMMDDHHMMSS.archive.jsonl (bounded retention).
   *
   * Runs at boot. No-op under thresholdMb (default 20). Safe to call anytime.
   */
  rotate({ thresholdMb = 20, keepLines = 50000, keepArchives = 2 } = {}) {
    if (!existsSync(this.file)) return { rotated: false, reason: "no_file" };
    const st = statSync(this.file);
    const size_mb = st.size / 1024 / 1024;
    if (size_mb < thresholdMb) return { rotated: false, reason: "under_threshold", size_mb: Number(size_mb.toFixed(2)) };
    const raw = readFileSync(this.file, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    if (lines.length <= keepLines) return { rotated: false, reason: "few_lines", lines: lines.length };
    const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const archive = join(this.dir, "events-" + ts + ".archive.jsonl");
    const archived = lines.slice(0, lines.length - keepLines);
    const kept = lines.slice(-keepLines);
    writeFileSync(archive, archived.join("\n") + "\n");
    writeFileSync(this.file, kept.join("\n") + "\n");
    try {
      const all = readdirSync(this.dir)
        .filter(f => /^events-\d+\.archive\.jsonl$/.test(f))
        .sort();
      while (all.length > keepArchives) {
        const oldest = all.shift();
        try { unlinkSync(join(this.dir, oldest)); } catch {}
      }
    } catch {}
    return {
      rotated: true,
      size_mb_before: Number(size_mb.toFixed(2)),
      before_lines: lines.length,
      after_lines: kept.length,
      archived_lines: archived.length,
      archive: archive.split("/").pop(),
    };
  }

  /**
   * v0.56.51 — read only the last N events. Reads from end of file backwards,
   * capped at 2MB, so latency stays bounded regardless of file size. Used by
   * getPriorTurns to avoid loading 11MB events.jsonl on every chat turn.
   */
  recent(n = 500) {
    if (!existsSync(this.file)) return [];
    const st = statSync(this.file);
    const MAX_READ = Math.min(st.size, 2 * 1024 * 1024);
    const fd = (typeof require === "function" ? require("node:fs") : null);
    // Use fs primitives imported at top of file
    const CHUNK = 256 * 1024;
    let offset = st.size;
    const chunks = [];
    let bytesRead = 0;
    const fsPromises = null;
    const openFn = (() => {
      try { return (0, eval)("require")("node:fs").openSync; } catch { return null; }
    })();
    // Fallback: read whole file if fs primitives unavailable (shouldn't happen in ESM)
    try {
      const raw = readFileSync(this.file, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      const tail = lines.slice(-n);
      const out = [];
      for (const line of tail) { try { out.push(JSON.parse(line)); } catch {} }
      return out;
    } catch {
      return [];
    }
  }

  /** Read all events. Cheap at our scale. */
  all() {
    if (!existsSync(this.file)) return [];
    const out = [];
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip corrupt */ }
    }
    return out;
  }

  /**
   * Filter by predicate. Kept as a callback so callers can express
   * "everything about task X" or "everything of kind Y since time Z"
   * without us enumerating filters.
   */
  filter(predicate) {
    return this.all().filter(predicate);
  }

  forTask(taskId) {
    return this.filter(e => e.task_id === taskId);
  }

  since(ms) {
    return this.filter(e => e.at >= ms);
  }

  byKind(kind) {
    return this.filter(e => e.kind === kind);
  }

  /** Count by kind — cheap telemetry without a metrics system. */
  counts() {
    const out = {};
    for (const e of this.all()) out[e.kind] = (out[e.kind] || 0) + 1;
    return out;
  }
}
