// agentry/src/handlers/bua.screenshot.mjs
//
// BROWSER USE AGENT — screenshot.
//
// This is the REFERENCE IMPLEMENTATION for an adopted capability.
// Every capability agentry adopts should look like this: a small,
// single-purpose handler that shells into the OS kernel, uses the
// dependency declared in its capability node, and returns a typed
// result.
//
// Contract:
//   input:  { url, width?, height?, full_page?, session?, timeout_ms? }
//   output: { png_base64, bytes, url, captured_at, width, height }
//
// Depends on: microsoft/playwright (npm: playwright)
// Uses the OS kernel for: node.install (playwright), node.run (the
// actual browser work).

const CAP_ID = "bua.screenshot";

const ADOPTED_FROM = {
  candidate_id: "microsoft/playwright",
  candidate_url: "https://github.com/microsoft/playwright",
  candidate_kind: "repo",
};

const REQUIRES = {
  npm: ["playwright"],
  // Post-install: download the chromium binary into the session's
  // browser cache. --with-deps is not used here; the container already
  // has the system libraries from the Dockerfile.
  post_install: "npx playwright install chromium",
};

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const DEFAULT_TIMEOUT_MS = 30000;

export const capability = {
  id: CAP_ID,
  kind: "bua",
  accepts: {
    url: "string",
    width: { type: "number", optional: true },
    height: { type: "number", optional: true },
    full_page: { type: "boolean", optional: true },
    session: { type: "string", optional: true },
    timeout_ms: { type: "number", optional: true },
  },
  produces: {
    png_base64: "string",
    bytes: "number",
    url: "string",
    captured_at: "number",
    width: "number",
    height: "number",
  },
  requires: REQUIRES,
  adopted_from: ADOPTED_FROM,
};

// Acceptance test.
//
// Self-contained: prepares its own session, then probes example.com.
// The installer is idempotent — after the first run, prepareSession
// is a no-op because the session carries a `prepared:bua.screenshot`
// marker in its env.
//
// Uses a DEDICATED session ("bua-accept-test") so the test never
// collides with runtime invocations that might be using a different
// session name.
export async function accept(deps, { session = "bua-accept-test" } = {}) {
  const { prepareSession } = await import("../runtime/installer.mjs");
  await prepareSession(deps, { capId: CAP_ID, session });

  const probe = await run(
    { url: "https://example.com", width: 640, height: 480, session },
    deps
  );
  const out = probe.output || probe;
  if (!out.png_base64 || out.png_base64.length < 1000) {
    throw new Error(
      `accept: PNG too small (${out.png_base64?.length || 0} bytes encoded)`
    );
  }
  if (out.url !== "https://example.com") {
    throw new Error(`accept: URL mismatch (${out.url})`);
  }
  return { ok: true, bytes: out.bytes, session };
}

async function run(input, ctx) {
  const {
    url,
    width = DEFAULT_WIDTH,
    height = DEFAULT_HEIGHT,
    full_page = false,
    session = "bua-default",
    timeout_ms = DEFAULT_TIMEOUT_MS,
  } = input || {};

  if (!url || typeof url !== "string") {
    throw new Error("bua.screenshot requires url (string)");
  }
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new Error(`bua.screenshot requires http(s) URL, got: ${url}`);
  }

  if (typeof ctx.invoke !== "function") {
    throw new Error("bua.screenshot requires ctx.invoke");
  }

  // Ensure the session exists.
  await ctx.invoke(
    "agentry.os",
    { action: "session.create", id: session },
    { tenant: "local", by: CAP_ID }
  );

  // The script that does the actual work. Runs inside the session
  // via node.run.
  const script = `
    import { chromium } from "playwright";
    const url = process.env.BUA_URL;
    const width = Number(process.env.BUA_WIDTH || 1280);
    const height = Number(process.env.BUA_HEIGHT || 720);
    const fullPage = process.env.BUA_FULL === "1";

    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width, height } });
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "networkidle", timeout: 25000 });
      const buf = await page.screenshot({ fullPage, type: "png" });
      process.stdout.write(buf.toString("base64"));
    } finally {
      await browser.close();
    }
  `;

  const res = await ctx.invoke(
    "agentry.os",
    {
      action: "node.run",
      session,
      code: script,
      env: {
        BUA_URL: url,
        BUA_WIDTH: String(width),
        BUA_HEIGHT: String(height),
        BUA_FULL: full_page ? "1" : "0",
      },
      timeout_ms,
    },
    { tenant: "local", by: CAP_ID }
  );

  if (!res.ok) {
    throw new Error(
      `bua.screenshot: os call failed — ${res.error.code}: ${res.error.message}`
    );
  }

  const result = res.output.result;
  if (result.exit_code !== 0) {
    const stderr = String(result.stderr || "").slice(0, 300);
    if (
      stderr.includes("Executable doesn't exist") ||
      stderr.includes("playwright install")
    ) {
      throw new Error(
        `bua.screenshot: playwright browser not installed in session "${session}". ` +
          `Run: ${REQUIRES.post_install}`
      );
    }
    throw new Error(
      `bua.screenshot: playwright exited ${result.exit_code} — ${stderr}`
    );
  }

  const png_base64 = String(result.stdout || "").trim();
  if (!png_base64) {
    throw new Error("bua.screenshot: playwright produced no output");
  }

  const bytes = Math.floor((png_base64.length * 3) / 4);

  return {
    output: {
      png_base64,
      bytes,
      url,
      captured_at: Date.now(),
      width,
      height,
    },
    cost: {
      time_ms: result.ms || 0,
      browser_ms: result.ms || 0,
      money_usd: 0,
    },
  };
}

export default run;
