// agentry/src/handlers/synthesize/readers/pypi.mjs
// v0.53.0 — extracted from agentry.synthesize.mjs.
// Reads a PyPI package + its __init__.py content.

import { MAX_README_CHARS } from "../config.mjs";

export async function readPyPiPackage(candidate, deps) {
  const pkgName = String(candidate.name || candidate.id || "").replace(/^pypi:/, "").trim();
  const moduleGuess = pkgName.replace(/-/g, "_");
  const session = "synth_pypi_" + pkgName.replace(/[^a-z0-9_.-]/gi, "_").slice(0, 40) + "_" + Date.now().toString(36);
  const { invoke } = deps;

  const facts = {
    session, source_kind: "pypi",
    pypi_package_name: pkgName,
    pypi_module_name: moduleGuess,
    installed: false, error: null,
    init_content: null, readme: null,
    top_level: [], version: null, summary: null,
  };

  await invoke("agentry.os", { action: "session.create", id: session },
    { tenant: "local", by: "agentry.synthesize" });

  try {
    const inst = await invoke("agentry.os", {
      action: "python.install", session, packages: [pkgName], timeout_ms: 120000,
    }, { tenant: "local", by: "agentry.synthesize" });
    if (!inst.ok) {
      facts.error = "pip install failed: " + inst.error.message;
      return facts;
    }
    facts.installed = true;
  } catch (e) {
    facts.error = "pip install threw: " + e.message;
    return facts;
  }

  try {
    const metaScript = [
      "import json, urllib.request",
      "try:",
      "    req = urllib.request.Request('https://pypi.org/pypi/" + pkgName + "/json', headers={'User-Agent':'agentry/0.24'})",
      "    with urllib.request.urlopen(req, timeout=15) as r:",
      "        d = json.load(r)",
      "    info = d.get('info', {})",
      "    print(json.dumps({'summary': info.get('summary',''), 'description': (info.get('description') or '')[:8000], 'version': info.get('version','')}))",
      "except Exception as e:",
      "    print(json.dumps({'error': str(e)}))",
    ].join("\n");
    const meta = await invoke("agentry.os", { action: "python.run", session, code: metaScript, timeout_ms: 25000 },
      { tenant: "local", by: "agentry.synthesize" });
    if (meta.ok && meta.output && meta.output.result) {
      try {
        const parsed = JSON.parse(String(meta.output.result.stdout || "{}").trim());
        if (parsed.description) facts.readme = String(parsed.description).slice(0, MAX_README_CHARS);
        if (parsed.summary) facts.summary = String(parsed.summary).slice(0, 500);
        if (parsed.version) facts.version = String(parsed.version);
      } catch {}
    }
  } catch {}

  try {
    const inspectScript = [
      "import importlib, json, os",
      "names = ['" + moduleGuess + "', '" + pkgName + "']",
      "out = {'tried': names}",
      "for name in names:",
      "    try:",
      "        m = importlib.import_module(name)",
      "        f = getattr(m, '__file__', None)",
      "        out['module'] = name",
      "        out['path'] = f",
      "        out['dir'] = os.path.dirname(f) if f else None",
      "        out['doc'] = (getattr(m, '__doc__', '') or '')[:2000]",
      "        break",
      "    except Exception as e:",
      "        out.setdefault('errors', []).append(name + ': ' + str(e))",
      "print(json.dumps(out))",
    ].join("\n");
    const r = await invoke("agentry.os", { action: "python.run", session, code: inspectScript, timeout_ms: 20000 },
      { tenant: "local", by: "agentry.synthesize" });
    if (r.ok && r.output && r.output.result) {
      try {
        const parsed = JSON.parse(String(r.output.result.stdout || "{}").trim());
        if (parsed.module) facts.pypi_module_name = String(parsed.module);
        if (parsed.path) {
          const read = await invoke("agentry.os", { action: "fs.read", session, path: parsed.path },
            { tenant: "local", by: "agentry.synthesize" });
          if (read.ok) {
            const c = read.output?.result?.content ?? read.output?.content ?? "";
            facts.init_content = String(c).slice(0, 6000);
          }
        }
        if (parsed.dir) {
          const ls = await invoke("agentry.os", { action: "fs.list", session, path: parsed.dir },
            { tenant: "local", by: "agentry.synthesize" });
          if (ls.ok) {
            const entries = ls.output?.result?.entries || ls.output?.entries || [];
            facts.top_level = Array.isArray(entries)
              ? entries.slice(0, 40).map(x => typeof x === "string" ? x : x.name)
              : [];
          }
        }
      } catch {}
    }
  } catch {}

  return facts;
}

// v0.31.0 — read a Rust crate. Uses crates.io API for metadata +
// GitHub raw README when repo is on GitHub. No runtime install needed:
// rust-script handles inline cargo deps in synthesized handlers, so
// the LLM writes `//! \`\`\`cargo\ncrate = "ver"\n//! \`\`\`` at the top
// of the .rs script and rust-script downloads automatically.
