// agentry/src/handlers/notify.email.gmail.mjs
//
// HTTP email notifier via Resend. HF Spaces block outbound SMTP
// (ports 25/465/587), so the SMTP path can't work from inside a
// Space. Resend is an HTTPS API on 443 — no port restrictions, no
// OAuth, no app passwords, no user cap.
//
// Same input/output contract as before:
//   input:  { subject, body_markdown, to? }
//   output: { message_id, thread_id, to, sent_at, channel }
//
// Env:
//   RESEND_API_KEY  (required)  — starts with re_
//   RESEND_FROM     (required)  — e.g. onboarding@resend.dev
//   GMAIL_TO        (optional)  — default recipient

const ENDPOINT = "https://api.resend.com/emails";

function resolveConfig(ctx) {
  const gmail = ctx?.config?.gmail || {};
  return {
    apiKey: gmail.resendApiKey || process.env.RESEND_API_KEY || null,
    from: gmail.resendFrom || process.env.RESEND_FROM || null,
    defaultTo: gmail.to || process.env.GMAIL_TO || null,
  };
}

function bodyToHtml(bodyMarkdown) {
  const escaped = String(bodyMarkdown || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;font-size:13px;line-height:1.5;">${escaped}</div>`;
}

export default async function notifyGmail(input, ctx) {
  const { subject, body_markdown, to } = input || {};
  if (!subject) throw new Error("notify.email.gmail requires subject");
  if (!body_markdown) throw new Error("notify.email.gmail requires body_markdown");

  const cfg = resolveConfig(ctx);
  const toAddr = to || cfg.defaultTo;

  if (!cfg.apiKey) {
    const err = new Error("notify.email.gmail: RESEND_API_KEY env var is required");
    err.retryable = false;
    throw err;
  }
  if (!cfg.from) {
    const err = new Error("notify.email.gmail: RESEND_FROM env var is required");
    err.retryable = false;
    throw err;
  }
  if (!toAddr) {
    const err = new Error("notify.email.gmail: no recipient. Pass 'to' or set GMAIL_TO.");
    err.retryable = false;
    throw err;
  }

  const started = Date.now();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${cfg.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: cfg.from,
      to: [toAddr],
      subject,
      text: String(body_markdown),
      html: bodyToHtml(body_markdown),
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (res.status === 401 || res.status === 403) {
    const text = await res.text().catch(() => "");
    const err = new Error(`notify.email.gmail: auth failed HTTP ${res.status} — ${text.slice(0, 200)}`);
    err.retryable = false;
    throw err;
  }
  if (res.status === 429) {
    const err = new Error("notify.email.gmail: rate limited by Resend");
    err.retryable = true;
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`notify.email.gmail: send failed HTTP ${res.status} — ${text.slice(0, 300)}`);
    err.retryable = res.status >= 500;
    throw err;
  }

  const data = await res.json().catch(() => ({}));
  ctx?.events?.emit("notify.email.gmail.sent", {
    to: toAddr,
    subject,
    message_id: data.id || null,
    ms: Date.now() - started,
  });

  return {
    output: {
      message_id: data.id || null,
      thread_id: null,
      to: toAddr,
      sent_at: Date.now(),
      channel: "resend",
    },
    cost: { time_ms: Date.now() - started, http_calls: 1, money_usd: 0 },
  };
}
