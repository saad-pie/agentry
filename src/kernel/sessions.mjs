// agentry/src/kernel/sessions.mjs
//
// Session store. A session is an isolated workspace for one agent.
// Each session has its own cwd, env, and process table. Filesystems
// are shared under /work by default; a session can be scoped to a
// subdirectory if the caller wants stronger isolation.

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, normalize } from "node:path";
import { randomBytes } from "node:crypto";

const SESSION_DIR_NAME = "sessions";
const WORK_DIR_NAME = "work";

export class SessionStore {
  constructor({ root }) {
    if (!root) throw new Error("SessionStore requires root");
    this.root = root;
    this.sessionsFile = join(root, SESSION_DIR_NAME, "index.json");
    this.workRoot = join(root, WORK_DIR_NAME);
    mkdirSync(join(root, SESSION_DIR_NAME), { recursive: true });
    mkdirSync(this.workRoot, { recursive: true });
    this._cache = this._load();
  }

  _load() {
    if (!existsSync(this.sessionsFile)) return new Map();
    try {
      const raw = readFileSync(this.sessionsFile, "utf8");
      const obj = JSON.parse(raw);
      return new Map(Object.entries(obj));
    } catch {
      return new Map();
    }
  }

  _persist() {
    const obj = Object.fromEntries(this._cache);
    writeFileSync(this.sessionsFile, JSON.stringify(obj, null, 2));
  }

  get(id) {
    return this._cache.get(id) || null;
  }

  list() {
    return Array.from(this._cache.values());
  }

  create({ id, cwd = ".", env = {} } = {}) {
    const sid = id || `sess_${randomBytes(8).toString("hex")}`;
    if (this._cache.has(sid)) {
      return { created: false, session: this._cache.get(sid) };
    }
    const sessionRoot = join(this.workRoot, sid);
    mkdirSync(sessionRoot, { recursive: true });
    const session = {
      id: sid,
      root: sessionRoot,
      cwd,
      env,
      created_at: Date.now(),
      last_used_at: Date.now(),
    };
    this._cache.set(sid, session);
    this._persist();
    return { created: true, session };
  }

  touch(id) {
    const s = this._cache.get(id);
    if (!s) return null;
    s.last_used_at = Date.now();
    this._persist();
    return s;
  }

  setCwd(id, cwd) {
    const s = this._cache.get(id);
    if (!s) return null;
    s.cwd = cwd;
    s.last_used_at = Date.now();
    this._persist();
    return s;
  }

  setEnv(id, key, value) {
    const s = this._cache.get(id);
    if (!s) return null;
    if (value === null || value === undefined) {
      delete s.env[key];
    } else {
      s.env[key] = String(value);
    }
    s.last_used_at = Date.now();
    this._persist();
    return s;
  }

  /**
   * Resolve a caller-supplied path against the session's cwd, enforcing
   * that the result stays inside the session root. Returns the absolute
   * path or throws.
   */
  resolvePath(sessionId, path) {
    const s = this._cache.get(sessionId);
    if (!s) throw new Error(`unknown session: ${sessionId}`);
    const base = resolve(s.root, s.cwd);
    const abs = resolve(base, path);
    const normalizedRoot = normalize(s.root);
    const normalizedAbs = normalize(abs);
    if (!normalizedAbs.startsWith(normalizedRoot)) {
      throw new Error(`path escapes session root: ${path}`);
    }
    return normalizedAbs;
  }
}
