// agentry/src/handlers/notify.fallback.mjs
//
// Notify with automatic fallback.
//
// Tries the primary notify capability first. If it fails (missing
// credentials, network error, upstream down), falls back to the
// console, which writes to stdout — visible in the HF Space log.
//
// Use this for any notify path that must not silently fail.
//
// Input:  { subject, body_markdown, priority?, primary? }
// Output: { delivered_at, channel, primary_ok, fallback_used, primary_error? }

const DEFAULT_PRIMARY = "notify.email.gmail";
const DEFAULT_FALLBACK = "notify.console";

export default async function notifyFallback(input, ctx) {
  const {
    subject,
    body_markdown,
    priority = "normal",
    primary = DEFAULT_PRIMARY,
    fallback = DEFAULT_FALLBACK,
  } = input || {};

  if (!subject) throw new Error("notify.fallback requires subject");
  if (!body_markdown) throw new Error("notify.fallback requires body_markdown");

  if (typeof ctx.invoke !== "function") {
    throw new Error("notify.fallback requires ctx.invoke — was it invoked through the runtime?");
  }

  // Try primary.
  let primaryOk = false;
  let primaryError = null;
  let primaryOutput = null;

  try {
    const res = await ctx.invoke(primary, { subject, body_markdown, priority }, {
      tenant: "local", by: "notify.fallback",
    });
    if (res.ok) {
      primaryOk = true;
      primaryOutput = res.output;
      ctx.events.emit("notify.fallback.primary_ok", {
        primary, subject: subject.slice(0, 120),
      });
    } else {
      primaryError = `${res.error.code}: ${res.error.message}`;
    }
  } catch (e) {
    primaryError = e.message;
  }

  // If primary failed, fall through to the console.
  if (!primaryOk) {
    ctx.events.emit("notify.fallback.primary_failed", {
      primary, error: primaryError, subject: subject.slice(0, 120),
    });

    const fallbackSubject = `[FALLBACK: ${primary} failed] ${subject}`;
    const fallbackBody =
      `**Primary notify channel failed.**\n\n` +
      `- primary: \`${primary}\`\n` +
      `- error: \`${primaryError || "unknown"}\`\n\n` +
      `---\n\n` +
      body_markdown;

    try {
      const res = await ctx.invoke(fallback, {
        subject: fallbackSubject,
        body_markdown: fallbackBody,
        priority,
      }, { tenant: "local", by: "notify.fallback" });

      if (!res.ok) {
        throw new Error(`${res.error.code}: ${res.error.message}`);
      }

      ctx.events.emit("notify.fallback.used", {
        primary, fallback, subject: subject.slice(0, 120),
      });

      return {
        output: {
          delivered_at: Date.now(),
          channel: fallback,
          primary_ok: false,
          fallback_used: true,
          primary_error: primaryError,
        },
      };
    } catch (e) {
      ctx.events.emit("notify.fallback.all_failed", {
        primary, fallback, primary_error: primaryError, fallback_error: e.message,
      });
      throw new Error(
        `notify.fallback: both primary (${primary}) and fallback (${fallback}) failed. ` +
        `primary: ${primaryError}. fallback: ${e.message}`
      );
    }
  }

  // Primary succeeded — done.
  return {
    output: {
      delivered_at: Date.now(),
      channel: primary,
      primary_ok: true,
      fallback_used: false,
      message_id: primaryOutput?.message_id || null,
    },
  };
}
