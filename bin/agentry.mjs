#!/usr/bin/env node
// agentry/bin/agentry.mjs
// The agentry CLI.
//
// Usage:
//   agentry boot                  — load graph, seed, rebuild watches. Print status.
//   agentry start                 — run the runtime + discovery loop forever.
//   agentry tick                  — run one discovery tick and exit.
//   agentry capabilities          — list live capabilities, grouped by kind.
//   agentry gaps                  — list capability gaps.
//   agentry watches               — list active watch instances.
//   agentry events [--tail N]     — dump recent events.
//
// Env:
//   AGENTRY_DIR                   — data directory (default: <home>/.agentry)

import { Runtime } from "../src/runtime.mjs";
import { liveGaps } from "../src/handlers/agentry.capability_gap.mjs";
import * as discoveryLoop from "../src/runtime/discovery_loop.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) { flags[key] = next; i++; }
      else flags[key] = true;
    }
  }
  return flags;
}

function fmtTime(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

async function withRuntime(fn) {
  const rt = new Runtime();
  await rt.boot();
  // wire invoke into deps so the discovery loop can call capabilities
  rt.deps.invoke = (cap, input, ctx) => rt.invoke(cap, input, ctx);
  return fn(rt);
}

async function cmdBoot() {
  await withRuntime(async (rt) => {
    const caps = rt.graph.capabilities();
    const byKind = {};
    for (const c of caps.values()) byKind[c.kind] = (byKind[c.kind] || 0) + 1;
    console.log("agentry boot");
    console.log("  data dir:      ", rt.config.dir);
    console.log("  capabilities:  ", caps.size);
    console.log("  by kind:       ", JSON.stringify(byKind));
    console.log("  watches:       ", [...caps.values()].filter(c => c.kind === "watch_instance").length);
    console.log("  gaps:          ", liveGaps(rt.graph).length);
  });
}

async function cmdStart() {
  await withRuntime(async (rt) => {
    console.log("agentry start — runtime + discovery loop");
    console.log("  data dir:", rt.config.dir);
    console.log("  tick interval:", rt.config.runtime.pollTickMs, "ms");
    console.log("  press Ctrl+C to stop\n");

    rt.start();

    // Discovery loop runs alongside the runtime tick. We schedule it on
    // the same cadence. Every tick of the runtime also ticks discovery.
    let running = true;
    const stop = () => { running = false; rt.stop(); console.log("\nstopping..."); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);

    // First discovery tick immediately, then on each runtime tick.
    const loopTick = async () => {
      try {
        const res = await discoveryLoop.tick(rt.deps);
        if (res && (res.created || res.gaps)) {
          console.log(`[discovery] ${fmtTime(Date.now())} gaps=${res.gaps} uncovered=${res.uncovered ?? 0} created=${res.created?.length ?? 0}`);
        }
      } catch (e) {
        console.error("[discovery] tick failed:", e.message);
      }
    };

    await loopTick();

    // Schedule repeated discovery ticks on the same cadence as the runtime.
    const interval = setInterval(async () => {
      if (!running) return;
      await loopTick();
    }, rt.config.runtime.pollTickMs);

    // Keep the process alive; interval keeps it running.
    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (!running) { clearInterval(check); clearInterval(interval); resolve(); }
      }, 500);
    });
  });
}

async function cmdTick() {
  await withRuntime(async (rt) => {
    const res = await discoveryLoop.tick(rt.deps, {
      notify: "notify.console",   // CLI tick uses console, not email
    });
    console.log(JSON.stringify(res, null, 2));
  });
}

async function cmdCapabilities() {
  await withRuntime(async (rt) => {
    const caps = rt.graph.capabilities();
    const byKind = {};
    for (const c of caps.values()) {
      (byKind[c.kind] = byKind[c.kind] || []).push(c);
    }
    for (const [kind, list] of Object.entries(byKind).sort()) {
      console.log(`\n[${kind}] (${list.length})`);
      for (const c of list) {
        const flag = c.retired_at ? " (retired)" : "";
        console.log(`  ${c.id}${flag}  v${c.version}`);
        if (c.wanted_kind) console.log(`      → wants kind: ${c.wanted_kind}, hits: ${c.hits || 0}`);
        if (c.source) console.log(`      → source: ${c.source}`);
      }
    }
  });
}

async function cmdGaps() {
  await withRuntime(async (rt) => {
    const gaps = liveGaps(rt.graph);
    if (!gaps.length) { console.log("no gaps — the graph has no unmet needs."); return; }
    console.log(`live gaps (${gaps.length}):`);
    for (const g of gaps) {
      console.log(`  ${g.id}`);
      console.log(`      wanted_kind: ${g.wanted_kind || "—"}`);
      console.log(`      hits: ${g.hits || 0}`);
      console.log(`      first_seen: ${fmtTime(g.first_seen_at)}`);
      console.log(`      last_seen:  ${fmtTime(g.last_seen_at)}`);
      console.log(`      reason: ${g.reason || "—"}`);
    }
  });
}

async function cmdWatches() {
  await withRuntime(async (rt) => {
    const watches = [...rt.graph.capabilities().values()].filter(c => c.kind === "watch_instance");
    if (!watches.length) { console.log("no active watches."); return; }
    console.log(`active watches (${watches.length}):`);
    for (const w of watches) {
      console.log(`  ${w.id}`);
      console.log(`      source: ${w.source}`);
      console.log(`      query:  ${JSON.stringify(w.query)}`);
      console.log(`      every:  ${w.interval_ms} ms`);
      console.log(`      on_new: ${w.on_new}`);
      console.log(`      reason: ${w.reason}`);
      console.log(`      last_poll: ${fmtTime(w.last_poll_at)}`);
      console.log(`      seen:  ${(w.seen_ids || []).length}`);
    }
  });
}

async function cmdEvents() {
  const flags = parseFlags(argv.slice(1));
  const tail = Number(flags.tail) || 30;
  await withRuntime(async (rt) => {
    const all = rt.events.all();
    const slice = all.slice(-tail);
    console.log(`last ${slice.length} events (of ${all.length}):`);
    for (const e of slice) {
      const { kind, at, ...rest } = e;
      const extra = Object.keys(rest).length ? " " + JSON.stringify(rest) : "";
      console.log(`  ${fmtTime(at)}  ${kind}${extra}`);
    }
  });
}

function usage() {
  console.log(`agentry — a capability graph the agent grows itself

usage:
  agentry boot           load graph, seed, rebuild watches. Print status.
  agentry start          run the runtime + discovery loop forever.
  agentry tick           run one discovery tick and exit.
  agentry capabilities   list live capabilities, grouped by kind.
  agentry gaps           list capability gaps.
  agentry watches        list active watch instances.
  agentry events [--tail N]
                         dump recent events (default 30).

env:
  AGENTRY_DIR            data directory (default: <home>/.agentry)
`);
}

try {
  switch (cmd) {
    case "boot":         await cmdBoot(); break;
    case "start":        await cmdStart(); break;
    case "tick":         await cmdTick(); break;
    case "capabilities": await cmdCapabilities(); break;
    case "gaps":         await cmdGaps(); break;
    case "watches":      await cmdWatches(); break;
    case "events":       await cmdEvents(); break;
    case undefined:
    case "--help":
    case "-h":
    case "help":         usage(); break;
    default:
      console.error(`unknown command: ${cmd}`);
      usage();
      process.exit(1);
  }
} catch (e) {
  console.error("agentry: fatal:", e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
}
