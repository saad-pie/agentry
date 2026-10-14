// agentry/src/handlers/notify.email.gmail.mjs
//
// SMTP-based Gmail notifier. Uses nodemailer + a Google App Password.
// No OAuth, no refresh token, no user cap, no 7-day expiry.
//
// Same input/output contract as the previous OAuth version:
//   input:  { subject, body_markdown, to? }
//   output: { message_id, thread_id, to, sent_at, channel }
//
// Reads credentials from config.gmail or env:
//   SMTP_HOST (default smtp.gmail.com)
//   SMTP_PORT (default 465)
//   SMTP_USER (required)
//   SMTP_PASS (required, 16-char app password)
//   SMTP_FROM (defaults to SMTP_USER)
//   GMAIL_TO  (optional default recipient)

import nodemailer from "nodemailer";

let _transporter = null;
let _transporterKey = null;

function resolveConfig(ctx) {
  const gmail = ctx?.config?.gmail || {};
  const host = gmail.smtpHost || process.env.SMTP_HOST || "smtp.gmail.com";
  const port = Number(gmail.smtpPort || process.env.SMTP_PORT || "465");
  const user = gmail.smtpUser || process.env.SMTP_USER || null;
  const pass = gmail.smtpPass || process.env.SMTP_PASS || null;
  const from = gmail.smtpFrom || process.env.SMTP_FROM || user;
  const defaultTo = gmail.to || process.env.GMAIL_TO || user;
  return { host, port, user, pass, from, defaultTo };
}

function getTransporter(cfg) {
  const key = `${cfg.host}:${cfg.port}:${cfg.user}`;
  if (_transporter && _transporterKey === key) return _transporter;

  _transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    requireTLS: cfg.port !== 465,
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
  });
  _transporterKey = key;
  return _transporter;
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

  if (!cfg.user || !cfg.pass) {
    const err = new Error(
      "notify.email.gmail: missing credentials. Need SMTP_USER and SMTP_PASS env vars (Google App Password, not your account password)."
    );
    err.retryable = false;
    throw err;
  }
  if (!cfg.from) {
    const err = new Error("notify.email.gmail: missing sender. Set SMTP_FROM or SMTP_USER.");
    err.retryable = false;
    throw err;
  }
  if (!toAddr) {
    const err = new Error("notify.email.gmail: no recipient. Pass 'to' or set GMAIL_TO.");
    err.retryable = false;
    throw err;
  }

  const started = Date.now();
  const transporter = getTransporter(cfg);

  try {
    const info = await transporter.sendMail({
      from: cfg.from,
      to: toAddr,
      subject,
      text: String(body_markdown),
      html: bodyToHtml(body_markdown),
    });

    ctx?.events?.emit("notify.email.gmail.sent", {
      to: toAddr,
      subject,
      message_id: info.messageId || null,
      response: info.response || null,
      ms: Date.now() - started,
    });

    return {
      output: {
        message_id: info.messageId || null,
        thread_id: null,
        to: toAddr,
        sent_at: Date.now(),
        channel: "gmail.smtp",
      },
      cost: { time_ms: Date.now() - started, http_calls: 1, money_usd: 0 },
    };
  } catch (e) {
    const err = new Error(`notify.email.gmail: send failed — ${e.message}`);
    err.retryable = /ECONN|ETIMEDOUT|4\d\d/.test(String(e.code || "") + " " + String(e.responseCode || ""));
    err.smtp_code = e.code || null;
    err.smtp_response = e.responseCode || null;
    ctx?.events?.emit("notify.email.gmail.failed", {
      to: toAddr,
      subject,
      error: e.message,
      code: e.code || null,
      responseCode: e.responseCode || null,
    });
    throw err;
  }
}
