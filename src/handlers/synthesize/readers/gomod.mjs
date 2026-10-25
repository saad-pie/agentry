// agentry/src/handlers/synthesize/readers/gomod.mjs
// v0.53.0 — extracted from agentry.synthesize.mjs.
// Reads a Go module's README + version from proxy.golang.org.

import { MAX_README_CHARS } from "../config.mjs";

export async function readGoModule(candidate, deps) {
  const modPath = String(candidate.name || candidate.id || "").replace(/^gomod:/, "").trim();
  const session = "synth_gomod_" + modPath.replace(/[^a-z0-9_-]/gi, "_").slice(0, 40) + "_" + Date.now().toString(36);
  const { invoke } = deps;
  const facts = {
    session, source_kind: "go_module", go_module: modPath,
    error: null, version: null, readme: null,
  };
  await invoke("agentry.os", { action: "session.create", id: session },
    { tenant: "local", by: "agentry.synthesize" });

  try {
    const script = [
      "import json, urllib.request",
      "out = {}",
      "try:",
      "    req = urllib.request.Request('https://proxy.golang.org/" + modPath + "/@latest', headers={'User-Agent':'agentry/0.31'})",
      "    with urllib.request.urlopen(req, timeout=15) as r:",
      "        d = json.load(r)",
      "    out['version'] = d.get('Version', '')",
      "except Exception as e:",
      "    out['proxy_error'] = str(e)",
      "if 'github.com' in '" + modPath + "':",
      "    parts = '" + modPath + "'.rstrip('/').split('github.com/')[-1].split('/')",
      "    if len(parts) >= 2:",
      "        for branch in ['main', 'master']:",
      "            url = 'https://raw.githubusercontent.com/' + parts[0] + '/' + parts[1] + '/' + branch + '/README.md'",
      "            try:",
      "                req = urllib.request.Request(url, headers={'User-Agent':'agentry/0.31'})",
      "                with urllib.request.urlopen(req, timeout=10) as r:",
      "                    out['readme'] = r.read().decode('utf-8', errors='replace')[:8000]",
      "                break",
      "            except Exception:",
      "                continue",
      "print(json.dumps(out))",
    ].join("\n");
    const r = await invoke("agentry.os", { action: "python.run", session, code: script, timeout_ms: 30000 },
      { tenant: "local", by: "agentry.synthesize" });
    if (r.ok && r.output && r.output.result) {
      try {
        const parsed = JSON.parse(String(r.output.result.stdout || "{}").trim());
        facts.version = parsed.version || null;
        if (parsed.readme) facts.readme = String(parsed.readme).slice(0, MAX_README_CHARS);
        if (parsed.proxy_error) facts.error = parsed.proxy_error;
      } catch {}
    }
  } catch (e) { facts.error = "gomod read threw: " + e.message; }

  return facts;
}

