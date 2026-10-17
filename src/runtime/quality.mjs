// agentry/src/runtime/quality.mjs
// Deterministic quality scoring for capability outputs.
//
// v0.24.4 — decompress FlateDecode streams before scanning. pdf-lib
// (and every modern PDF writer) stores objects inside compressed
// ObjStm streams. Raw-string scans of /Type /Page and /BaseFont return
// zero on any pdf-lib output. Prior version scored a real 53830-byte
// image-embedding PDF as { pages: 0, fonts: 0, score: 54180 } — the
// byte term dominated and the structural terms were dead. Now we
// inflate every stream and scan both raw and decompressed content.

import { inflateSync } from "node:zlib";

export async function scorePDF(bytes) {
  if (!bytes || bytes.length < 20) {
    return { score: 0, reason: "too_small", bytes: bytes ? bytes.length : 0 };
  }
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const magic = buf.slice(0, 5).toString("latin1");
  if (magic !== "%PDF-") {
    return { score: 0, reason: "not_pdf", magic, bytes: buf.length };
  }
  const raw = buf.toString("latin1");

  let pageHits = 0;
  const fonts = new Set();
  let hasImages = false;
  let compressed = /\/Filter\s*\/FlateDecode/.test(raw);

  function scan(content) {
    // Count /Type /Page but NOT /Type /Pages
    pageHits += (content.match(/\/Type\s*\/Page(?![s])/g) || []).length;
    for (const m of content.matchAll(/\/BaseFont\s*\/([A-Za-z0-9+\-_.]+)/g)) {
      fonts.add(m[1]);
    }
    if (/\/Subtype\s*\/Image/.test(content)) hasImages = true;
  }

  // Scan raw first (uncompressed objects)
  scan(raw);

  // Then inflate every stream and scan
  const streamRe = /stream\r?\n/g;
  let m;
  let streams = 0;
  let inflateOk = 0;
  while ((m = streamRe.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) continue;
    const slice = buf.slice(start, end);
    streams++;
    try {
      const inflated = inflateSync(slice).toString("latin1");
      inflateOk++;
      scan(inflated);
    } catch {}
  }

  const pages = pageHits;
  const byteCount = buf.length;
  const score =
    pages * 1000 +
    byteCount +
    fonts.size * 200 +
    (hasImages ? 300 : 0) +
    (compressed ? 50 : 0);

  return {
    score, pages, fonts: fonts.size,
    has_images: hasImages, compressed,
    streams_scanned: streams, streams_inflated: inflateOk,
    bytes: byteCount, magic,
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
  const size = JSON.stringify(o).length;
  return { score: Math.min(size / 100, 500), reason: "generic", bytes: size };
}

export function isTypeOnlyPackage(id) {
  if (!id) return false;
  const s = String(id);
  if (s.includes("@types/")) return true;
  if (s.startsWith("types-") || s.startsWith("types:") || s.startsWith("types_")) return true;
  if (/\/types\//i.test(s)) return true;
  return false;
}
