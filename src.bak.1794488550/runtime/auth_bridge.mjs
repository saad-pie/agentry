import { createServer } from "node:http";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const PORT = 7866, HOST = "127.0.0.1";
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || "AIzaSyCySKWHczC2XFxsZi2y0xfHvaFIxTeeUt0";
const DSH_BASE = process.env.DSH_BASE_URL || "http://127.0.0.1:7861";
const DSH_ADMIN = process.env.DSH_ADMIN_TOKEN || "dsh-admin-2024";
const SPACE_HOST = process.env.SPACE_HOST || "saadpie1-deepseek-harness.hf.space";
const WORKSPACES_DIR = "/tmp/home/.dsh/agentry-workspaces";
const DEFAULT_AGENTS_MD = join(WORKSPACES_DIR, "default", "AGENTS.md");

async function verifyFirebaseToken(idToken) {
  const res = await fetch(
    "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + FIREBASE_API_KEY,
    { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken }), signal: AbortSignal.timeout(10000) }
  );
  const data = await res.json();
  if (!res.ok || !data.users || !data.users[0]) {
    throw new Error("firebase_verify_failed: " + (data.error?.message || "HTTP " + res.status));
  }
  return data.users[0];
}

async function ensureDshUser(uid) {
  const listRes = await fetch(DSH_BASE + "/api/dsh/users", {
    headers: { "x-api-key": DSH_ADMIN }, signal: AbortSignal.timeout(5000),
  });
  if (!listRes.ok) throw new Error("dsh_list_users_failed: HTTP " + listRes.status);
  const users = await listRes.json();
  const existing = Array.isArray(users) ? users.find(u => u.name === uid) : null;
  if (existing && existing.apiKey) return { user_id: existing.id, api_key: existing.apiKey };
  const createRes = await fetch(DSH_BASE + "/api/dsh/users", {
    method: "POST",
    headers: { "x-api-key": DSH_ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ name: uid }), signal: AbortSignal.timeout(5000),
  });
  if (!createRes.ok) {
    const txt = await createRes.text().catch(() => "");
    throw new Error("dsh_create_user_failed: HTTP " + createRes.status + " " + txt.slice(0,200));
  }
  const created = await createRes.json();
  return { user_id: created.id, api_key: created.apiKey };
}

async function ensureWorkspace(uid) {
  const wsPath = join(WORKSPACES_DIR, uid);
  mkdirSync(wsPath, { recursive: true });
  const agentsPath = join(wsPath, "AGENTS.md");
  if (!existsSync(agentsPath) && existsSync(DEFAULT_AGENTS_MD)) copyFileSync(DEFAULT_AGENTS_MD, agentsPath);
  const listRes = await fetch(DSH_BASE + "/api/dsh/workspaces", {
    headers: { "x-api-key": DSH_ADMIN }, signal: AbortSignal.timeout(5000),
  });
  if (!listRes.ok) throw new Error("dsh_list_workspaces_failed: HTTP " + listRes.status);
  const wss = await listRes.json();
  const existing = Array.isArray(wss) ? wss.find(w => w.path === wsPath) : null;
  if (existing) return { workspace_id: existing.id };
  const createRes = await fetch(DSH_BASE + "/api/dsh/workspaces", {
    method: "POST",
    headers: { "x-api-key": DSH_ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ path: wsPath, name: uid }), signal: AbortSignal.timeout(5000),
  });
  if (!createRes.ok) {
    const txt = await createRes.text().catch(() => "");
    throw new Error("dsh_create_workspace_failed: HTTP " + createRes.status + " " + txt.slice(0,200));
  }
  const created = await createRes.json();
  return { workspace_id: created.id };
}

function send(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s), "access-control-allow-origin": "*" });
  res.end(s);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 100000) reject(new Error("body too large")); });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" });
    return res.end();
  }
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, service: "auth-bridge" });
  if (req.method === "POST" && req.url === "/api/auth/provision") {
    let parsed;
    try { parsed = JSON.parse(await readBody(req)); }
    catch (e) { return send(res, 400, { ok: false, error: "invalid_json", detail: e.message }); }
    const { id_token, email } = parsed;
    if (!id_token || typeof id_token !== "string") return send(res, 400, { ok: false, error: "missing_id_token" });
    try {
      const user = await verifyFirebaseToken(id_token);
      const uid = user.localId;
      if (!uid) throw new Error("firebase returned no localId");
      const dshUser = await ensureDshUser(uid);
      const ws = await ensureWorkspace(uid);
      return send(res, 200, { ok: true, url: "https://" + SPACE_HOST + "/?token=" + dshUser.api_key, uid, email: user.email || email, workspace_id: ws.workspace_id });
    } catch (e) {
      console.error("[auth-bridge] provision failed:", e.message);
      return send(res, 500, { ok: false, error: "provision_failed", detail: String(e.message).slice(0, 400) });
    }
  }
  send(res, 404, { ok: false, error: "not_found", path: req.url });
});

server.listen(PORT, HOST, () => {
  console.log("[auth-bridge] listening on http://" + HOST + ":" + PORT);
});
