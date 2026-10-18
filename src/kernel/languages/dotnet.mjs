// agentry/src/kernel/languages/dotnet.mjs
// .NET 8 — writes Program.cs, creates a project if needed, runs `dotnet run`.
// Package refs via inline #:package directive (dotnet 9+ feature) or
// by adding <PackageReference> to the .csproj before running.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 240000;
const MAX_OUTPUT_BYTES = 1 * 1024 * 1024;

function runSync(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { timeout: opts.timeout || DEFAULT_TIMEOUT_MS, encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES * 4, ...opts });
  return { stdout: r.stdout || "", stderr: r.stderr || "", exit_code: typeof r.status === "number" ? r.status : -1, signal: r.signal, error: r.error ? r.error.message : null };
}

export async function dotnetRun(sessions, { session, code, file, args = [], cwd, env = {}, timeout_ms = DEFAULT_TIMEOUT_MS, project_name } = {}) {
  const s = sessions.get(session);
  if (!s) { const e = new Error(`unknown session: ${session}`); e.code = "NOT_FOUND"; throw e; }
  if (!code && !file) { const e = new Error("dotnet.run requires 'code' or 'file'"); e.code = "INVALID_REQUEST"; throw e; }

  const projName = (project_name || "AgentryApp_" + Date.now().toString(36)).replace(/[^A-Za-z0-9_]/g, "");
  const projDir = sessions.resolvePath(session, "dotnet_proj_" + projName);
  mkdirSync(projDir, { recursive: true });

  let source;
  if (code) {
    source = code;
  } else {
    const filePath = sessions.resolvePath(session, file);
    if (!existsSync(filePath)) { const e = new Error(`script not found: ${file}`); e.code = "NOT_FOUND"; throw e; }
    const fs = await import("node:fs");
    source = fs.readFileSync(filePath, "utf8");
  }
  writeFileSync(join(projDir, "Program.cs"), source);

  const mergedEnv = { ...process.env, ...s.env, ...env };
  mergedEnv.DOTNET_CLI_TELEMETRY_OPTOUT = "1";
  mergedEnv.DOTNET_NOLOGO = "1";
  mergedEnv.DOTNET_SKIP_FIRST_TIME_EXPERIENCE = "1";

  // Init project if not present
  const csproj = join(projDir, projName + ".csproj");
  if (!existsSync(csproj)) {
    const init = runSync("dotnet", ["new", "console", "-n", projName, "-o", ".", "--force"], { cwd: projDir, env: mergedEnv, timeout: 60000 });
    if (init.exit_code !== 0) {
      return { stdout: init.stdout, stderr: init.stderr, exit_code: init.exit_code, script_path: "(inline)", lang: "dotnet", runner: "dotnet-new", error: init.error };
    }
  }

  const r = runSync("dotnet", ["run", "--project", csproj, "--", ...args], { cwd: projDir, env: mergedEnv, timeout: timeout_ms });
  return { stdout: r.stdout, stderr: r.stderr, exit_code: r.exit_code, signal: r.signal, script_path: code ? "(inline)" : file, lang: "dotnet", runner: "dotnet-run", error: r.error };
}

export function dotnetVersion() {
  const r = runSync("dotnet", ["--version"], { timeout: 10000 });
  return { version: (r.stdout || r.stderr || "").trim(), exit_code: r.exit_code };
}
