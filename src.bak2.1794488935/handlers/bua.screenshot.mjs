// agentry/src/handlers/bua.screenshot.mjs
//
// Seed handler: render a page in headless Chromium and return a PNG.
// Self-contained — declares its deps in REQUIRES and calls
// prepareSession() at the top of run() so any caller in any session
// gets a working install on first use.
//
// v0.16.3 — restored. The file had been overwritten by a synthesized
// bua.browser handler at some point, which made bua.screenshot fail
// with ERR_MODULE_NOT_FOUND on playwright.

import { prepareSession } from "./_installer_import.mjs";

const CAP_ID = "bua.screenshot";
const CAP_KIND = "bua";

const ACCEPTS = {
  url: "string",
  width: { type: "number", optional: true },
  height: { type: "number", optional: true },
  full_page: { type: "boolean", optional: true },
  session: { type: "string", optional: true },
  timeout_ms: { type: "number", optional: true },
};

const PRODUCES = {
  png_base64: "string",
  bytes: "number",
  url: "string",
  captured_at: "number",
  width: "number",
  height: "number",
};

const REQUIRES = {
  npm: ["playwright"],
  pip: [],
  post_install: "npx playwright install chromium",
};

const DEFAULT_TIMEOUT_MS = 90000;

const KERNEL_SCRIPT = [
  'import { chromium } from "playwright";',
  'const url = process.env.BUA_URL;',
  'const width = Number(process.env.BUA_WIDTH || 1280);',
  'const height = Number(process.env.BUA_HEIGHT || 720);',
  'const fullPage = process.env.BUA_FULL === "1";',
  'const browser = await chromium.launch({ headless: true });',
  'try {',
  '  const context = await browser.newContext({ viewport: { width, height } });',
  '  const page = await context.newPage();',
  '  await page.goto(url, { waitUntil: "networkidle", timeout: 25000 });',
  '  const buf = await page.screenshot({ fullPage, type: "png" });',
  '  const png_base64 = buf.toString("base64");',
  '  const bytes = Math.floor((png_base64.length * 3) / 4);',
  '  console.log(JSON.stringify({ png_base64, bytes, url, captured_at: Date.now(), width, height }));',
  '} finally {',
  '  await browser.close();',
  '}',
].join("\n");

export const capability = {
  id: CAP_ID,
  kind: CAP_KIND,
  invoked_via: "invoker.in_process_js",
  accepts: ACCEPTS,
  produces: PRODUCES,
  requires: REQUIRES,
};

export async function accept(deps, opts = {}) {
  const session = opts.session || (CAP_ID + "-accept-test");
  await prepareSession(deps, { capId: CAP_ID, session });
  const probe = await run({ url: "https://example.com", width: 640, height: 480 }, deps, { session });
  const out = probe.output || probe;
  const minBytes = 500;
  if (minBytes > 0) {
    const size = typeof out.bytes === "number" ? out.bytes : 0;
    if (size < minBytes) {
      throw new Error("accept: output too small (" + size + " < " + minBytes + ")");
    }
  }
  return { ok: true, session, output: out };
}

async function run(input, ctx, opts = {}) {
  const session = opts.session || input.session || (CAP_ID + "-default");
  const timeout_ms = input.timeout_ms || DEFAULT_TIMEOUT_MS;

  if (typeof ctx.invoke !== "function") {
    throw new Error(CAP_ID + " requires ctx.invoke");
  }

  await prepareSession(ctx, { capId: CAP_ID, session });

  await ctx.invoke("agentry.os", { action: "session.create", id: session },
    { tenant: "local", by: CAP_ID });

  const env = {
    BUA_URL: input.url === undefined || input.url === null ? "" : String(input.url),
    BUA_WIDTH: input.width === undefined || input.width === null ? "" : String(input.width),
    BUA_HEIGHT: input.height === undefined || input.height === null ? "" : String(input.height),
    BUA_FULL: input.full_page === true ? "1" : "",
  };

  const res = await ctx.invoke("agentry.os", {
    action: "node.run",
    session,
    code: KERNEL_SCRIPT,
    env,
    timeout_ms,
  }, { tenant: "local", by: CAP_ID });

  if (!res.ok) {
    throw new Error(CAP_ID + ": kernel call failed — " + res.error.code + ": " + res.error.message);
  }

  const r = res.output.result || res.output;
  const exitCode = r.exit_code ?? r.exitCode ?? 0;
  if (exitCode !== 0) {
    throw new Error(CAP_ID + ": kernel exited " + exitCode + " — " + String(r.stderr || "").slice(0, 300));
  }

  const stdout = String(r.stdout || "");
  if (!stdout.trim()) throw new Error(CAP_ID + ": kernel produced no output");

  const raw = JSON.parse(stdout);
  return {
    output: {
      png_base64: raw.png_base64,
      bytes: raw.bytes,
      url: raw.url,
      captured_at: raw.captured_at,
      width: raw.width,
      height: raw.height,
    },
    cost: { time_ms: r.ms || 0 },
  };
}

export default run;
