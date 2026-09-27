// agentry/src/events.mjs
// The event log. Every state change, every invocation, every adoption.
// Separate from the graph because events outlive tasks and capabilities.
// If you delete every other file, events.jsonl is enough to rebuild the rest.

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
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
