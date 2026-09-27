// agentry/src/seed.mjs
// Load seed capabilities into the graph on first run.
// Idempotent: re-running skips anything already in the graph.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { errors } from "./errors.mjs";

export function loadSeed({ graph, events, seedDir }) {
  if (!existsSync(seedDir)) {
    events.emit("seed.missing_dir", { dir: seedDir });
    return { loaded: 0, skipped: 0, missing: seedDir };
  }

  const files = readdirSync(seedDir).filter(f => f.endsWith(".json")).sort();
  let loaded = 0, skipped = 0;

  for (const file of files) {
    const path = join(seedDir, file);
    let spec;
    try {
      spec = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      events.emit("seed.parse_failed", { file, error: e.message });
      continue;
    }
    if (!spec.id) {
      events.emit("seed.invalid", { file, reason: "no id" });
      continue;
    }

    const existing = graph.getCapability(spec.id);
    if (existing) { skipped++; continue; }

    try {
      const node = graph.putCapability({ ...spec, source: spec.source || `seed:${file}` });
      events.emit("seed.loaded", { file, capability_id: node.id, version: node.version });
      loaded++;
    } catch (e) {
      events.emit("seed.put_failed", { file, capability_id: spec.id, error: e.message });
    }
  }

  return { loaded, skipped, files: files.length };
}
