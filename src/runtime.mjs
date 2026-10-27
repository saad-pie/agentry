// agentry/src/runtime.mjs
import { CapabilityGraph } from "./graph.mjs";
import { EventLog } from "./events.mjs";
import { loadConfig } from "./config.mjs";
import { loadSeed } from "./seed.mjs";
import { invoke } from "./invoke.mjs";
import { startRollupTimer } from "./graph/runs.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import "./invokers/in_process_js.mjs";
import "./handlers/_register.mjs";
import * as watcher from "./handlers/watcher.polling.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

export class Runtime {
  constructor(opts = {}) {
    this.config = opts.config || loadConfig();
    this.graph = new CapabilityGraph({ dir: this.config.dir });
    this.events = new EventLog({ dir: this.config.dir });
    this.deps = { graph: this.graph, events: this.events, config: this.config };
    this.running = false;
    this.tickTimer = null;
    this.tickCount = 0;
  }

  async boot() {
    this.events.emit("runtime.boot.started", { dir: this.config.dir });

    // v0.56.31 — auto-compact capabilities.jsonl if oversized. Fold-on-read
    // only uses the last line per id, so compacting to one line per id is
    // semantically identical. Runs before seed/watches load so the faster
    // file is what everything downstream reads. Idempotent, safe, no-op
    // below 10 MB.
    try {
      const _compact = this.graph.compact();
      if (_compact.compacted) {
        this.events.emit("runtime.boot.compacted", _compact);
      }
    } catch (e) {
      this.events.emit("runtime.boot.compact_failed", { error: String(e.message || e).slice(0, 300) });
    }

    // v0.56.36 — rotate events.jsonl at boot if oversized. Same threshold
    // concept as graph.compact but different strategy: events are facts, so
    // archive oldest chunk verbatim rather than fold. Full history preserved.
    try {
      const _rot = this.events.rotate();
      if (_rot.rotated) {
        this.events.emit("runtime.boot.events_rotated", _rot);
      }
    } catch (e) {
      this.events.emit("runtime.boot.events_rotate_failed", { error: String(e.message || e).slice(0, 300) });
    }

    const seedResult = loadSeed({
      graph: this.graph,
      events: this.events,
      seedDir: join(__dirname, "..", "seed"),
    });
    this.events.emit("runtime.boot.seeded", seedResult);

    watcher.clearWatches();
    for (const cap of this.graph.capabilities().values()) {
      if (cap.kind === "watch_instance") watcher.getWatches().set(cap.id, cap);
    }
    this.events.emit("runtime.boot.watches_loaded", { count: watcher.getWatches().size });

    // v0.16.1 — periodic reliability rollup over runs.jsonl.
    startRollupTimer(
      this.graph,
      this.events,
      Number(process.env.AGENTRY_ROLLUP_MS) || 300000
    );

    this.events.emit("runtime.boot.completed", {
      capabilities: this.graph.capabilities().size,
      watches: watcher.getWatches().size,
    });

    return {
      capabilities: this.graph.capabilities().size,
      watches: watcher.getWatches().size,
      seeded: seedResult,
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.events.emit("runtime.started", { tick_ms: this.config.runtime.pollTickMs });
    this._scheduleTick(0);
  }

  stop() {
    this.running = false;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = null;
    this.events.emit("runtime.stopped", { tick_count: this.tickCount });
  }

  _scheduleTick(delayMs) {
    if (!this.running) return;
    this.tickTimer = setTimeout(() => this._tick().catch(e => {
      this.events.emit("runtime.tick.error", { error: e.message });
    }).finally(() => this._scheduleTick(this.config.runtime.pollTickMs)), delayMs);
  }

  async _tick() {
    this.tickCount++;
    const now = Date.now();
    this.events.emit("runtime.tick", { n: this.tickCount, at: now });

    // v0.52.1 — read watches from graph each tick instead of the in-process
    // Map. Prior version used watcher.dueWatches(now) which iterates the
    // module-level `watches` Map. That Map is populated at Runtime.boot()
    // and by watcherPolling() on create — but in practice only ~10 of 100
    // watches were ever visible to _tick, so 90 sat with last_poll_at=null
    // for hours. Reading from graph is cross-process safe and reflects
    // ground truth (capabilities.jsonl). Cost is one invalidateCache +
    // one fold per tick — same work as boot(), negligible at our scale.
    if (typeof this.graph.invalidateCache === "function") this.graph.invalidateCache();
    const due = [];
    for (const cap of this.graph.capabilities().values()) {
      if (cap.kind !== "watch_instance") continue;
      if (cap.retired_at) continue;
      // v0.52.2 — skip watches whose source is not a real discovery capability.
      // Legacy watches (pre-v0.15.5) have source:"unknown" from graph.putCapability
      // default and were never polled until v0.52.1 exposed them. They fail on
      // every poll and eat file I/O on 62880-line capabilities.jsonl. Skip here
      // AND retire in the cleanup script; skip is defense in depth.
      const src = String(cap.source || "");
      if (!/^(discovery|agentry)\./.test(src)) continue;
      const interval = Number(cap.interval_ms) || 300000;
      const last = Number(cap.last_poll_at) || 0;
      if (now - last >= interval) due.push(cap);
    }
    if (!due.length) return;

    const max = this.config.runtime.watchMaxConcurrent;
    const batch = due.slice(0, max);
    const results = await Promise.allSettled(batch.map(w => watcher.pollWatch(this.deps, w)));
    const summary = results.map((r, i) => ({
      watch_id: batch[i].id,
      ok: r.status === "fulfilled",
      ...(r.status === "fulfilled" ? r.value : { error: r.reason?.message }),
    }));
    this.events.emit("runtime.tick.watches_polled", { count: batch.length, summary });
  }

  invoke(capabilityId, input, context = {}) {
    return invoke(this.deps, capabilityId, input, context);
  }
  createWatch(spec) {
    return this.invoke("watcher.polling", spec, { tenant: "local", by: "runtime" });
  }
  notify(spec, channel = "notify.console") {
    return this.invoke(channel, spec, { tenant: "local", by: "runtime" });
  }
}
