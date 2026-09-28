// agentry/src/handlers/notify.email.gmail.mjs
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

let tokenCache = { access_token: null, expires_at: 0 };

async function getAccessToken({ clientId, clientSecret, refreshToken }) {
  if (tokenCache.access_token && tokenCache.expires_at - 60000 > Date.now()) {
    return tokenCache.access_token;
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`gmail: token exchange failed HTTP ${res.status} — ${text.slice(0, 200)}`);
    err.retryable = res.status >= 500;
    throw err;
  }

  const data = await res.json();
  if (!data.access_token) throw new Error("gmail: token exchange returned no access_token");

  tokenCache.access_token = data.access_token;
  tokenCache.expires_at = Date.now() + (Number(data.expires_in) || 3600) * 1000;
  return data.access_token;
}

function buildRawMessage({ from, to, subject, body_markdown }) {
  const bodyText = body_markdown || "";
  const clean = (s) => String(s || "").replace(/[\r\n]+/g, " ").trim();
  const message = [
    `From: ${clean(from)}`,
    `To: ${clean(to)}`,
    `Subject: ${clean(subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    bodyText,
  ].join("\r\n");

  return Buffer.from(message, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export default async function notifyGmail(input, ctx) {
  const { subject, body_markdown, to } = input || {};
  if (!subject) throw new Error("notify.email.gmail requires subject");
  if (!body_markdown) throw new Error("notify.email.gmail requires body_markdown");

  const cfg = ctx.config?.gmail || {};
  const { clientId, clientSecret, refreshToken, from } = cfg;
  const toAddr = to || cfg.to || cfg.from;

  if (!clientId || !clientSecret || !refreshToken || !from) {
    const err = new Error("notify.email.gmail: missing config. Need GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_FROM.");
    err.retryable = false;
    throw err;
  }

  const accessToken = await getAccessToken({ clientId, clientSecret, refreshToken });
  const raw = buildRawMessage({ from, to: toAddr, subject, body_markdown });

  const started = Date.now();
  const res = await fetch(SEND_ENDPOINT, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ raw }),
    signal: AbortSignal.timeout(15000),
  });

  if (res.status === 401) {
    tokenCache = { access_token: null, expires_at: 0 };
    const err = new Error("gmail: 401 unauthorized — token may have been revoked");
    err.retryable = false;
    throw err;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`gmail: send failed HTTP ${res.status} — ${text.slice(0, 300)}`);
    err.retryable = res.status >= 500 || res.status === 429;
    throw err;
  }

  const data = await res.json();

  return {
    output: {
      message_id: data.id || null,
      thread_id: data.threadId || null,
      to: toAddr,
      sent_at: Date.now(),
      channel: "gmail",
    },
    cost: { time_ms: Date.now() - started, http_calls: 2, money_usd: 0 },
  };
}
