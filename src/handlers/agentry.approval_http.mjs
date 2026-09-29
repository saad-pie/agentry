// agentry/src/handlers/agentry.approval_http.mjs
// The approval HTTP endpoint.
//
// Two routes, one job: record an approve/reject decision on a proposal
// that already exists in the graph. Does NOT adopt anything itself.
// Adoption is a separate handler that reads decisions from the graph.
//
// Runs on 127.0.0.1:7862 by default. nginx routes /agentry/* here.
//
// Auth: the token in the URL is the credential. Tokens are single-use
// and expire with the proposal. No login, no session.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const DEFAULT_PORT = 7862;
const DEFAULT_HOST = "127.0.0.1";

/**
 * HTML page shown after a decision is recorded. Kept inline and simple —
 * no external CSS, no fonts, no dependencies.
 */
function page(title, body) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", monospace;
         max-width: 620px; margin: 3rem auto; padding: 0 1rem; color: #222;
         background: #fafafa; line-height: 1.5; }
  h1 { font-size: 1.4rem; margin-bottom: 0.3rem; }
  h2 { font-size: 1rem; color: #666; font-weight: normal; margin-top: 0; }
  pre { background: #f0f0f0; padding: 1rem; border-radius: 6px;
        overflow-x: auto; font-size: 0.85rem; }
  .ok { color: #157347; }
  .no { color: #b02a37; }
  .dim { color: #888; font-size: 0.85rem; }
</style>
</head>
<body>
<h1>${title}</h1>
${body}
<hr>
<p class="dim">agentry approval service</p>
</body>
</html>`;
}

/**
 * Look up a token across all live proposals and return the match, or null.
 * Bounded: only considers proposals that are still pending and unexpired.
 */
function lookupToken(graph, token) {
  const now = Date.now();
  for (const node of graph.capabilities().values()) {
    if (node.kind !== "proposal") continue;
    if (node.state !== "pending") continue;
    if (node.tokens_expires_at && node.tokens_expires_at < now) continue;
    const hit = node.tokens && node.tokens[token];
    if (hit) return { proposal: node, ...hit };
  }
  return null;
}

/**
 * Record a decision on the proposal node. Idempotent-ish: if the same
 * token is clicked twice, the second call is a no-op unless the state
 * changed (e.g. you changed your mind). We allow changes; the last
 * decision wins.
 */
function recordDecision(graph, events, proposal, candidateId, decision) {
  const now = Date.now();
  const decisions = { ...(proposal.decisions || {}) };
  const prev = decisions[candidateId];
  decisions[candidateId] = {
    decision,               // "approved" | "rejected"
    at: now,
    by: "human:approval_url",
    previous: prev?.decision || null,
  };

  // Compute the new overall state.
  //   - any decision → proposal becomes "in_review"
  //   - all candidates decided → proposal becomes "decided"
  const totalCandidates = Array.isArray(proposal.analysis?.candidates)
    ? proposal.analysis.candidates.length
    : (proposal.candidates || []).length;
  const decided = Object.keys(decisions).length;
  const newState = decided >= totalCandidates && totalCandidates > 0
    ? "decided"
    : "in_review";

  graph.putCapability({
    id: proposal.id,
    kind: "proposal",
    state: newState,
    decisions,
    updated_at: now,
  });

  events.emit("proposal.decision_recorded", {
    proposal_id: proposal.id,
    candidate_id: candidateId,
    decision,
    previous: prev?.decision || null,
    state: newState,
    decided_count: decided,
    total_candidates: totalCandidates,
  });

  return { state: newState, decided, total: totalCandidates, previous: prev?.decision || null };
}

export function startApprovalServer({ graph, events, config, port, host }) {
  const p = Number(port || process.env.AGENTRY_APPROVAL_PORT || DEFAULT_PORT);
  const h = host || process.env.AGENTRY_APPROVAL_HOST || DEFAULT_HOST;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const path = url.pathname;

    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");

    // Health
    if (req.method === "GET" && path === "/agentry/health") {
      const body = JSON.stringify({
        ok: true,
        service: "agentry.approval",
        proposals_pending: [...graph.capabilities().values()]
          .filter(c => c.kind === "proposal" && c.state === "pending").length,
        uptime_s: Math.round(process.uptime()),
      });
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(body);
    }

    // Root: small status page (no sensitive info)
    if (req.method === "GET" && (path === "/agentry" || path === "/agentry/")) {
      const pending = [...graph.capabilities().values()]
        .filter(c => c.kind === "proposal" && c.state === "pending").length;
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(page("agentry approval service", `
        <h2>${pending} pending proposal(s)</h2>
        <p class="dim">Approve/reject links are in the emails you receive.</p>
      `));
    }

    // Approve
    const mApprove = path.match(/^\/agentry\/approve\/([a-f0-9]{32})$/);
    if (req.method === "GET" && mApprove) {
      const token = mApprove[1];
      const hit = lookupToken(graph, token);
      if (!hit) {
        res.writeHead(404, { "content-type": "text/html" });
        return res.end(page("Token not found", `
          <p class="no">This approval link is unknown, expired, or already used on a proposal that has moved to a different state.</p>
          <p class="dim">If you got this from an email more than a week old, the token has expired. Ask the agent to propose again.</p>
        `));
      }
      const info = recordDecision(graph, events, hit.proposal, hit.candidate_id, "approved");
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(page("Approved", `
        <p class="ok">✓ Approved <code>${hit.candidate_id}</code></p>
        <p>Proposal: <code>${hit.proposal_id}</code></p>
        <p>Progress: ${info.decided}/${info.total} candidates decided${info.state === "decided" ? " — proposal complete" : ""}</p>
        ${info.previous ? `<p class="dim">(changed from <code>${info.previous}</code>)</p>` : ""}
        <p class="dim">Adoption happens on the next runtime tick. You'll get a follow-up email when it's done.</p>
      `));
    }

    // Reject
    const mReject = path.match(/^\/agentry\/reject\/([a-f0-9]{32})$/);
    if (req.method === "GET" && mReject) {
      const token = mReject[1];
      const hit = lookupToken(graph, token);
      if (!hit) {
        res.writeHead(404, { "content-type": "text/html" });
        return res.end(page("Token not found", `
          <p class="no">This rejection link is unknown, expired, or already used on a proposal that has moved to a different state.</p>
        `));
      }
      const info = recordDecision(graph, events, hit.proposal, hit.candidate_id, "rejected");
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(page("Rejected", `
        <p class="no">✗ Rejected <code>${hit.candidate_id}</code></p>
        <p>Proposal: <code>${hit.proposal_id}</code></p>
        <p>Progress: ${info.decided}/${info.total} candidates decided${info.state === "decided" ? " — proposal complete" : ""}</p>
        ${info.previous ? `<p class="dim">(changed from <code>${info.previous}</code>)</p>` : ""}
        <p class="dim">Nothing will be adopted for this candidate.</p>
      `));
    }

    res.writeHead(404, { "content-type": "text/html" });
    return res.end(page("Not found", `<p class="dim">No route for ${path}</p>`));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(p, h, () => {
      const addr = server.address();
      events.emit("approval.server_started", { host: addr.address, port: addr.port });
      resolve(server);
    });
  });
}
