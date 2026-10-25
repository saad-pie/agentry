// agentry/src/handlers/synthesize/readers/crate.mjs
// v0.53.0 — extracted from agentry.synthesize.mjs.
// Reads a Rust crate's README + categories from crates.io.

import { MAX_README_CHARS } from "../config.mjs";

export async function readCrate(candidate, deps) {
  const crateName = String(candidate.name || candidate.id || "").replace(/^crates:/, "").trim();
  const session = "synth_crate_" + crateName.replace(/[^a-z0-9_-]/gi, "_").slice(0, 40) + "_" + Date.now().toString(36);
  const { invoke } = deps;
  const facts = {
    session, source_kind: "rust_crate", crate_name: crateName,
    error: null, version: null, description: null, repository: null, readme: null,
  };
  await invoke("agentry.os", { action: "session.create", id: session },
    { tenant: "local", by: "agentry.synthesize" });

  try {
    const script = [
      "import json, urllib.request",
      "out = {}",
      "try:",
      "    req = urllib.request.Request('https://crates.io/api/v1/crates/" + crateName + "', headers={'User-Agent':'agentry/0.31'})",
      "    with urllib.request.urlopen(req, timeout=15) as r:",
      "        d = json.load(r)",
      "    c = d.get('crate', {})",
      "    out['version'] = c.get('max_version', '')",
      "    out['description'] = c.get('description', '')",
      "    out['repository'] = c.get('repository', '')",
      "    out['categories'] = [cat for cat in (c.get('categories') or []) if isinstance(cat, str)]",
      "    out['keywords'] = [kw for kw in (c.get('keywords') or []) if isinstance(kw, str)]",
      "except Exception as e:",
      "    out['meta_error'] = str(e)",
      "repo = out.get('repository', '')",
      "if repo and 'github.com' in repo:",
      "    parts = repo.rstrip('/').split('github.com/')[-1].split('/')",
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
        facts.description = parsed.description || null;
        facts.repository = parsed.repository || null;
        facts.categories = Array.isArray(parsed.categories) ? parsed.categories : [];
        facts.keywords = Array.isArray(parsed.keywords) ? parsed.keywords : [];
        if (parsed.readme) facts.readme = String(parsed.readme).slice(0, MAX_README_CHARS);
        if (parsed.meta_error) facts.error = parsed.meta_error;

        // v0.31.10 — API-client / SDK crates cannot solve local-artifact
        // tasks. Categories tell the truth. api2convert had
        // ["multimedia","api-bindings","web-programming::http-client"]
        // and required an api2convert.com API key. Reasoner picked it
        // because keywords matched; categories are definitive.
        const _blockers = [];
        if (facts.categories.some(c => /api-bindings|web-programming::http-client|web-programming::api-wrapper/i.test(c))) {
          _blockers.push("requires_remote_api");
        }
        if (facts.categories.some(c => /web-programming::wasm|gpu|gui|android|ios|embedded/i.test(c))) {
          _blockers.push("requires_runtime_we_dont_have");
        }
        if (_blockers.length > 0) {
          facts.rejected_reason = _blockers[0];
          facts.blockers = _blockers;
          facts.error = "crate " + crateName + " cannot run locally: blockers=[" + _blockers.join(",") + "] categories=[" + facts.categories.join(",") + "]";
        }
      } catch {}
    }
  } catch (e) { facts.error = "crate read threw: " + e.message; }

  return facts;
}

// v0.31.0 — read a Go module. proxy.golang.org for latest version +
// raw GitHub README when module path is on github.com. No runtime
// install needed: `go mod tidy` inside the kernel session resolves
// imports automatically, so synthesized code just declares imports.
