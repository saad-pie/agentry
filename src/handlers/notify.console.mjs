// agentry/src/handlers/notify.console.mjs
export default async function notifyConsole(input, ctx) {
  const { subject, body_markdown, priority = "normal" } = input || {};
  if (!subject) throw new Error("notify.console requires subject");
  if (!body_markdown) throw new Error("notify.console requires body_markdown");

  const banner = `─── [notify.console] ${String(priority).toUpperCase()} ───`;
  const trailer = "─".repeat(banner.length);
  const ts = new Date().toISOString();
  process.stdout.write(
    `\n${banner}\n${ts}  ${subject}\n${trailer}\n${body_markdown}\n${trailer}\n\n`
  );

  return { output: { delivered_at: Date.now(), channel: "console" } };
}
