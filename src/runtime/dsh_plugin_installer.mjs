// agentry/src/runtime/dsh_plugin_installer.mjs
// v0.56.3 — install a DSH plugin via the stable dsh binary at $DSH_BIN.
// Every failure class is named. No silent no-ops.
//
// Failure classes:
//   already_installed               — success, plugin already in the profile
//   installed                       — success, fresh install
//   allow_builds_retry              — wrote allowBuilds key, retry succeeded
//   minimum_release_age_retry       — wrote exclusion, retry succeeded
//   allow_builds_retry_failed       — wrote key, retry still failed
//   minimum_release_age_retry_failed — wrote exclusion, retry still failed
//   allow_builds_write_failed       — couldn't write pnpm-workspace.yaml
//   minimum_release_age_write_failed — couldn't write pnpm-workspace.yaml
//   engines_mismatch                — DSH refused; version incompatible
//   not_found                       — package doesn't exist in registry
//   network_failure                 — transient; caller may retry later
//   dsh_binary_not_found            — $DSH_BIN missing; set env or install globally
//   invalid_spec                    — empty or non-string spec
//   unknown_failure                 — catch-all, includes stderr tail

import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function resolveDshBin() {
  if (process.env.DSH_BIN && process.env.DSH_BIN.trim()) return process.env.DSH_BIN.trim();
  const which = spawnSync("which", ["dsh"], { encoding: "utf8", timeout: 5000 });
  if (which.status === 0 && String(which.stdout || "").trim()) return String(which.stdout).trim();
  const find = spawnSync("find", ["/tmp/home/.npm/_npx", "-name", "dsh", "-type", "f", "-path", "*/.bin/dsh"], { encoding: "utf8", timeout: 10000 });
  if (find.status === 0 && String(find.stdout || "").trim()) return String(find.stdout).trim().split("\n")[0];
  return null;
}

function profileDir(profile) {
  return `/tmp/home/.dsh/profiles/${profile}`;
}

function runAdd(dshBin, profile, spec, timeout_ms) {
  const started = Date.now();
  const r = spawnSync(dshBin, ["plugin", "--profile", profile, "add", spec], {
    encoding: "utf8",
    timeout: timeout_ms,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, CI: "1", NPM_CONFIG_YES: "true" },
  });
  return {
    exit_code: r.status,
    signal: r.signal,
    stdout: String(r.stdout || ""),
    stderr: String(r.stderr || ""),
    error: r.error ? r.error.message : null,
    ms: Date.now() - started,
  };
}

function classify(r) {
  const out = (r.stdout || "") + "\n" + (r.stderr || "");
  if (r.exit_code === 0) {
    if (/already\b.*\b(present|installed)/i.test(out)) return { class: "already_installed" };
    return { class: "installed" };
  }
  // allowBuilds — pnpm prints "Ignored build scripts: <name>" or names the key
  if (/allowBuilds|Ignored build scripts|approve-builds|Blocked by allowBuilds/i.test(out)) {
    const m = out.match(/Ignored build scripts:?\s*([^\n]+)/i)
           || out.match(/allowBuilds:?\s*\n?\s*([a-z@][^\s:\n]+):\s*true/i);
    return { class: "allow_builds", pkg: m ? m[1].trim() : null, raw: out.slice(-800) };
  }
  // minimumReleaseAge — pnpm prints ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED
  if (/ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED|minimumReleaseAge/i.test(out)) {
    const m = out.match(/([a-z@][a-z0-9._\-\/@]*@[0-9][^\s,;)'"]*)/i);
    return { class: "minimum_release_age", pkg: m ? m[1] : null, raw: out.slice(-800) };
  }
  // engines.dsh mismatch
  if (/engines\.dsh|unsupported.*dsh|requires.*dsh.*(version|range)|peer.*@deepseek-ai\/dsh/i.test(out)) {
    return { class: "engines_mismatch", raw: out.slice(-800) };
  }
  // not found
  if (/ERR_PNPM_FETCH_404|404 Not Found|not found in registry|package not found/i.test(out)) {
    return { class: "not_found", raw: out.slice(-800) };
  }
  // network
  if (/ERR_PNPM_META_FETCH_FAIL|ENOTFOUND|ETIMEDOUT|ECONNRESET|socket hang up|EAI_AGAIN/i.test(out)) {
    return { class: "network_failure", raw: out.slice(-800) };
  }
  return { class: "unknown_failure", raw: out.slice(-1000) };
}

function appendYamlKey(profile, key, entry) {
  const dir = profileDir(profile);
  mkdirSync(dir, { recursive: true });
  const wsPath = join(dir, "pnpm-workspace.yaml");
  let content = existsSync(wsPath) ? readFileSync(wsPath, "utf8") : "";
  if (new RegExp("^" + key + ":", "m").test(content)) {
    // append under existing block
    if (!content.includes(entry)) {
      content = content.replace(new RegExp("^(" + key + ":\\s*\\n)", "m"), "$1  " + entry + "\n");
    }
  } else {
    content += (content && !content.endsWith("\n") ? "\n" : "") + key + ":\n  " + entry + "\n";
  }
  writeFileSync(wsPath, content);
  return wsPath;
}

export async function installDshPlugin({ profile = "headless", spec, timeout_ms = 180000 } = {}) {
  if (!spec || typeof spec !== "string") {
    return { ok: false, reason: "invalid_spec", detail: "spec must be a non-empty string", retried: false };
  }
  const dshBin = resolveDshBin();
  if (!dshBin) {
    return { ok: false, reason: "dsh_binary_not_found", detail: "cannot locate dsh; set DSH_BIN env var or install globally", retried: false };
  }
  const t0 = Date.now();
  let r = runAdd(dshBin, profile, spec, timeout_ms);
  let c = classify(r);

  if (c.class === "already_installed" || c.class === "installed") {
    return { ok: true, reason: c.class, ms: Date.now() - t0, retried: false };
  }

  if (c.class === "allow_builds" && c.pkg) {
    try {
      const wsPath = appendYamlKey(profile, "allowBuilds", c.pkg + ": true");
      r = runAdd(dshBin, profile, spec, timeout_ms);
      c = classify(r);
      if (c.class === "already_installed" || c.class === "installed") {
        return { ok: true, reason: "allow_builds_retry", allow_builds_key: c.pkg, ws_path: wsPath, ms: Date.now() - t0, retried: true };
      }
      return { ok: false, reason: "allow_builds_retry_failed", detail: (c.raw || r.stderr || "").slice(0, 500), ms: Date.now() - t0, retried: true };
    } catch (e) {
      return { ok: false, reason: "allow_builds_write_failed", detail: e.message, ms: Date.now() - t0, retried: false };
    }
  }

  if (c.class === "minimum_release_age" && c.pkg) {
    try {
      const wsPath = appendYamlKey(profile, "minimumReleaseAgeExclude", "- '" + c.pkg + "'");
      r = runAdd(dshBin, profile, spec, timeout_ms);
      c = classify(r);
      if (c.class === "already_installed" || c.class === "installed") {
        return { ok: true, reason: "minimum_release_age_retry", excluded: c.pkg, ws_path: wsPath, ms: Date.now() - t0, retried: true };
      }
      return { ok: false, reason: "minimum_release_age_retry_failed", detail: (c.raw || r.stderr || "").slice(0, 500), ms: Date.now() - t0, retried: true };
    } catch (e) {
      return { ok: false, reason: "minimum_release_age_write_failed", detail: e.message, ms: Date.now() - t0, retried: false };
    }
  }

  return {
    ok: false,
    reason: c.class,
    detail: (c.raw || r.error || r.stderr || "").slice(0, 500),
    ms: Date.now() - t0,
    retried: false,
  };
}
