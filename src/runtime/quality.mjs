// agentry/src/runtime/quality.mjs
// Deterministic quality scoring for capability outputs.
// Used by agentry.mature to decide if v2 beats v1.
//
// Scoring is heuristic and shape-driven, not semantic. For PDFs:
//   - pages * 1000    (a text stamper is 1 page; a renderer is 1-N)
//   - bytes           (bigger = more content, up to a point)
//   - distinct fonts * 200  (stamper has 1; renderer has regular + bold + heading)
//   - images * 300    (does it embed the screenshot?)
//   - compressed * 50 (proper renderers compress streams)
//
// This is a proxy for "did the capability actually improve structure",
// not "is the PDF beautiful". A human still eyeballs final adoption.

export async function scorePDF(bytes) {
  if (!bytes || bytes.length < 20) {
    return { score: 0, reason: "too_small", bytes: bytes ? bytes.length : 0 };
  }
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const magic = buf.slice(0, 5).toString("latin1");
  if (magic !== "%PDF-") {
    return { score: 0, reason: "not_pdf", magic, bytes: buf.length };
  }
  const text = buf.toString("latin1");
  const pages = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
  const fonts = new Set();
  for (const m of text.matchAll(/\/BaseFont\s*\/([A-Za-z0-9+\-]+)/g)) {
    fonts.add(m[1]);
  }
  const hasImages = /\/Subtype\s*\/Image/.test(text);
  const compressed = /\/Filter\s*\/FlateDecode/.test(text);
  const byteCount = buf.length;
  const score =
    pages * 1000 +
    byteCount +
    fonts.size * 200 +
    (hasImages ? 300 : 0) +
    (compressed ? 50 : 0);
  return {
    score,
    pages,
    fonts: fonts.size,
    has_images: hasImages,
    compressed,
    bytes: byteCount,
    magic,
  };
}

export async function scorePNG(bytes) {
  if (!bytes || bytes.length < 24) {
    return { score: 0, reason: "too_small", bytes: bytes ? bytes.length : 0 };
  }
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const magic = buf.slice(0, 8).toString("hex");
  if (magic !== "89504e470d0a1a0a") {
    return { score: 0, reason: "not_png", magic, bytes: buf.length };
  }
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const score = Math.min(buf.length / 100, 500) + Math.min((w * h) / 1000, 500);
  return { score, width: w, height: h, bytes: buf.length };
}

export async function scoreOutput(cap, output) {
  const produces = cap.produces || {};
  const o = output || {};

  if (produces.pdf_base64) {
    if (!o.pdf_base64) return { score: 0, reason: "no_pdf_base64" };
    return await scorePDF(Buffer.from(String(o.pdf_base64), "base64"));
  }
  if (produces.pdf_path) {
    if (!o.pdf_path) return { score: 0, reason: "no_pdf_path" };
    const fs = await import("node:fs");
    if (!fs.existsSync(o.pdf_path)) return { score: 0, reason: "pdf_path_missing", path: o.pdf_path };
    return await scorePDF(fs.readFileSync(o.pdf_path));
  }
  if (produces.png_base64) {
    if (!o.png_base64) return { score: 0, reason: "no_png_base64" };
    return await scorePNG(Buffer.from(String(o.png_base64), "base64"));
  }
  // Unknown output — bytes as proxy
  const size = JSON.stringify(o).length;
  return { score: Math.min(size / 100, 500), reason: "generic", bytes: size };
}

// isTypeOnlyPackage — filters @types/*, types-*, and other
// type-only packages that have no runtime code. Prior versions
// adopted types_react-native-pdf-lib (which is just .d.ts files)
// as a capability because trial "passed" on an empty handler.
export function isTypeOnlyPackage(id) {
  if (!id) return false;
  const s = String(id);
  if (s.includes("@types/")) return true;
  if (s.startsWith("types-") || s.startsWith("types:") || s.startsWith("types_")) return true;
  if (/\/types\//i.test(s)) return true;
  return false;
}
