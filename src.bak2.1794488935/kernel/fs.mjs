// agentry/src/kernel/fs.mjs
//
// Filesystem primitives. All paths are resolved against the session's
// cwd and enforced to stay inside the session root.

import {
  readFileSync, writeFileSync, mkdirSync, rmSync,
  existsSync, readdirSync, statSync,
} from "node:fs";
import { dirname } from "node:path";

const MAX_READ_BYTES = 5 * 1024 * 1024;   // 5 MB
const MAX_WRITE_BYTES = 5 * 1024 * 1024;  // 5 MB

export function fsRead(sessions, { session, path, encoding = "utf8" }) {
  const abs = sessions.resolvePath(session, path);
  if (!existsSync(abs)) {
    const e = new Error(`not found: ${path}`);
    e.code = "NOT_FOUND";
    throw e;
  }
  const stat = statSync(abs);
  if (stat.isDirectory()) {
    const e = new Error(`is a directory: ${path}`);
    e.code = "IS_DIRECTORY";
    throw e;
  }
  if (stat.size > MAX_READ_BYTES) {
    const e = new Error(`file too large: ${stat.size} bytes (max ${MAX_READ_BYTES})`);
    e.code = "TOO_LARGE";
    throw e;
  }
  const content = readFileSync(abs, encoding);
  return { content, bytes: stat.size, mtime: stat.mtimeMs };
}

export function fsWrite(sessions, { session, path, content, encoding = "utf8" }) {
  const abs = sessions.resolvePath(session, path);
  const buf = Buffer.from(content, encoding);
  if (buf.length > MAX_WRITE_BYTES) {
    const e = new Error(`write too large: ${buf.length} bytes (max ${MAX_WRITE_BYTES})`);
    e.code = "TOO_LARGE";
    throw e;
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, buf);
  return { bytes_written: buf.length };
}

export function fsList(sessions, { session, path = "." }) {
  const abs = sessions.resolvePath(session, path);
  if (!existsSync(abs)) {
    const e = new Error(`not found: ${path}`);
    e.code = "NOT_FOUND";
    throw e;
  }
  const stat = statSync(abs);
  if (!stat.isDirectory()) {
    const e = new Error(`not a directory: ${path}`);
    e.code = "NOT_DIRECTORY";
    throw e;
  }
  const entries = readdirSync(abs, { withFileTypes: true }).map(d => {
    const entryPath = `${path === "." ? "" : path + "/"}${d.name}`;
    let size = null;
    try { size = statSync(`${abs}/${d.name}`).size; } catch {}
    return {
      name: d.name,
      type: d.isDirectory() ? "dir" : d.isFile() ? "file" : "other",
      size,
      path: entryPath,
    };
  });
  return { entries };
}
