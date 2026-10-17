// agentry — hand-written PDF renderer using Python reportlab.
// Pure Python, no phantomjs, no npm deps. Anchors the demo.
// v0.22.0

const CAP_ID = "pdf.render";

export const capability = {
  id: CAP_ID,
  kind: "tool",
  invoked_via: "invoker.in_process_js",
  accepts: {
    markdown: "string",
    title: { type: "string", optional: true },
    output_path: { type: "string", optional: true },
  },
  produces: { pdf_path: "string", bytes: "number" },
  requires: { pip: ["reportlab"], npm: [], post_install: null, capability: [] },
};

function pyScript(md, title, out) {
  return `
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
from reportlab.lib.enums import TA_LEFT
md = ${JSON.stringify(md)}
title = ${JSON.stringify(title)}
out = ${JSON.stringify(out)}
styles = getSampleStyleSheet()
body = ParagraphStyle('body', parent=styles['Normal'], fontSize=11, leading=14, alignment=TA_LEFT)
h1 = ParagraphStyle('h1', parent=styles['Heading1'], fontSize=20, leading=24, spaceAfter=12)
h2 = ParagraphStyle('h2', parent=styles['Heading2'], fontSize=16, leading=20, spaceAfter=10)
h3 = ParagraphStyle('h3', parent=styles['Heading3'], fontSize=13, leading=16, spaceAfter=8)
def flow(text):
    story = []; buf = []
    def flush():
        if buf:
            story.append(Paragraph(' '.join(buf).strip(), body)); story.append(Spacer(1, 6)); buf.clear()
    for line in text.split('\\n'):
        s = line.rstrip()
        if not s: flush(); continue
        if s.startswith('### '): flush(); story.append(Paragraph(s[4:], h3))
        elif s.startswith('## '): flush(); story.append(Paragraph(s[3:], h2))
        elif s.startswith('# '): flush(); story.append(Paragraph(s[2:], h1))
        elif s.startswith('- ') or s.startswith('* '): flush(); story.append(Paragraph('&bull; ' + s[2:], body))
        else: buf.append(s)
    flush(); return story
doc = SimpleDocTemplate(out, pagesize=letter, leftMargin=inch, rightMargin=inch, topMargin=inch, bottomMargin=inch, title=title or "Report")
doc.build(flow(md))
print(out)
`;
}

async function run(input, ctx, opts = {}) {
  const md = String(input.markdown || "");
  if (!md.trim()) throw new Error(CAP_ID + ": markdown required");
  const title = String(input.title || "");
  const outPath = String(input.output_path || `/tmp/home/.dsh/agentry-kernel/work/${CAP_ID}-${Date.now()}.pdf`);
  const session = opts.session || input.session || (CAP_ID + "-" + Date.now().toString(36));

  const { prepareSession } = await import("../runtime/installer.mjs");
  await prepareSession(ctx, { capId: CAP_ID, session });

  const { mkdirSync, statSync, openSync, readSync, closeSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(outPath), { recursive: true });

  const t0 = Date.now();
  const r = await ctx.invoke("agentry.os", {
    action: "python.run",
    session,
    code: pyScript(md, title, outPath),
    timeout_ms: 60000,
  }, { tenant: "local", by: CAP_ID });

  if (!r.ok) throw new Error(CAP_ID + ": python.run failed — " + r.error.code + ": " + r.error.message);
  const res = r.output.result || r.output;
  const exit = res.exit_code ?? 0;
  if (exit !== 0) throw new Error(CAP_ID + ": python exit " + exit + " — " + String(res.stderr || "").slice(0, 300));

  let st;
  try { st = statSync(outPath); } catch (e) { throw new Error(CAP_ID + ": pdf not found at " + outPath); }
  if (st.size < 100) throw new Error(CAP_ID + ": pdf too small (" + st.size + ")");
  const fd = openSync(outPath, "r"); const buf = Buffer.alloc(5); readSync(fd, buf, 0, 5, 0); closeSync(fd);
  const magic = buf.toString("latin1");
  if (magic !== "%PDF-") throw new Error(CAP_ID + ": not a pdf (magic=" + magic + ")");

  return {
    output: { pdf_path: outPath, bytes: st.size, artifact_magic: magic, captured_at: Date.now() },
    cost: { time_ms: Date.now() - t0, http_calls: 0 },
  };
}

export async function accept(deps, opts = {}) {
  const session = opts.session || (CAP_ID + "-accept-" + Date.now().toString(36));
  const probe = await run({ markdown: "# Test\n\n## Section\n\nA test paragraph.", title: "Accept" }, deps, { session });
  const out = probe.output || probe;
  if (!out.pdf_path) throw new Error("accept: no pdf_path");
  return { ok: true, session, output: out };
}

export default run;
