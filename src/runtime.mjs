// agentry/src/runtime.mjs
import { CapabilityGraph } from "./graph.mjs";
import { EventLog } from "./events.mjs";
import { loadConfig } from "./config.mjs";
import { loadSeed } from "./seed.mjs";
import { invoke } from "./invoke.mjs";
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

    const due = watcher.dueWatches(now);
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
