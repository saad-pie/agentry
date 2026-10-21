// agentry/src/handlers/agentry.agent.boot.mjs
// v0.34.0 — agent identity.
//
// An agent is a persistent named node in the graph with a home kernel
// session. It's the runtime's unit of identity: tasks have owner_agent,
// messages are from_agent/to_agent, PPECC spawns child agents.
//
// Grok Bot parallel: "each bot gets its own cloud VM with persistent
// filesystem, memory, and preferences." In agentry, that's a graph node
// (kind: "agent") whose home_session is a kernel session that survives
// across tasks and MCP restarts (kernel persists sessions on disk).
//
// Idempotent: pass agent_id → same agent returned. No agent_id → new one.
//
// Design:
//   - agent node written via putCapability (kind: "agent")
//   - home_session created via agentry.os session.create
//   - skills[] declares which capabilities this agent may invoke
//     (empty/null = unrestricted; populated = subset)
//   - parent_agent_id enables PPECC — agents booting agents
//   - memory_refs[] reserved for the memory layer (Qdrant/Obsidian);
//     unused in v1 but persisted
//   - task_count: incremented by agent.task on each completed task
//     (agent.task ships separately; agent.boot just initializes to 0)

import { randomBytes } from "node:crypto";

function genAgentId(name) {
  const slug = String(name || "agent").toLowerCase().replace(/[^a-z0-9_-]+/g, "_").slice(0, 40) || "agent";
  const ts = Date.now().toString(36);
  const rnd = randomBytes(3).toString("hex");
  return slug + "_" + ts + "_" + rnd;
}

export default async function agentryAgentBoot(input, ctx) {
  const { agent_id, name, skills, parent_agent_id, memory_refs, home_session: homeSessionOverride, force_new } = input || {};
  if (typeof ctx.invoke !== "function") throw new Error("agentry.agent.boot requires ctx.invoke");

  const graph = ctx.graph;
  const events = ctx.events;
  const started = Date.now();

  // ── Idempotent path: return existing agent ──
  if (agent_id && !force_new) {
    const existing = graph.getCapability(agent_id);
    if (existing) {
      if (existing.kind !== "agent") {
        throw new Error("agentry.agent.boot: " + agent_id + " exists but is kind " + existing.kind + ", not agent");
      }
      if (existing.retired_at) {
        throw new Error("agentry.agent.boot: " + agent_id + " is retired");
      }
      events.emit("agent.boot.existing", {
        agent_id, home_session: existing.home_session, task_count: existing.task_count || 0,
      });
      return {
        output: {
          ok: true,
          agent_id,
          existing: true,
          home_session: existing.home_session,
          skills: existing.skills || [],
          parent_agent_id: existing.parent_agent_id || null,
          task_count: existing.task_count || 0,
          state: existing.state || "active",
          node_version: existing.version,
        },
        cost: { time_ms: Date.now() - started },
      };
    }
    // agent_id given but doesn't exist yet — create with this id
  }

  // ── Create path ──
  const id = (agent_id && !force_new) ? agent_id : genAgentId(name);
  const homeSession = homeSessionOverride || ("agent_" + id + "_home");

  // Create kernel session (idempotent — if it already exists, kernel returns it)
  // v0.48.0 — verify with session.get. Same silent-failure class as agent.dsh.
  let sessionRes;
  try {
    sessionRes = await ctx.invoke("agentry.os", { action: "session.create", id: homeSession },
      { tenant: "local", by: "agentry.agent.boot" });
    if (!sessionRes.ok) {
      throw new Error("session.create returned ok=false: " + (sessionRes.error?.message || "unknown"));
    }
    const verify = await ctx.invoke("agentry.os", { action: "session.get", session: homeSession },
      { tenant: "local", by: "agentry.agent.boot" });
    if (!verify.ok) {
      throw new Error("session.get after create failed: " + (verify.error?.message || "unknown"));
    }
  } catch (e) {
    throw new Error("agentry.agent.boot: session setup failed: " + e.message);
  }

  // v0.45.0 — agent instances are NOT invokable capabilities. They are
  // targets for agentry.agent.task and chat.mjs. Setting invoked_via made
  // them appear in planner enumeration as if they could be called directly,
  // causing "no handler registered for agentry.agent.run" failures.
  // Removed invoked_via + handler + accepts/produces/requires.
  const node = {
    id,
    kind: "agent",
    name: name || id,
    home_session: homeSession,
    skills: Array.isArray(skills) ? skills : [],
    memory_refs: Array.isArray(memory_refs) ? memory_refs : [],
    parent_agent_id: parent_agent_id || null,
    task_count: 0,
    state: "active",
    created_at: Date.now(),
    updated_at: Date.now(),
    booted_at: Date.now(),
  };

  graph.putCapability(node);
  events.emit("agent.boot.created", {
    agent_id: id, name: node.name, home_session: homeSession,
    parent_agent_id: node.parent_agent_id, skills_count: node.skills.length,
  });

  return {
    output: {
      ok: true,
      agent_id: id,
      existing: false,
      home_session: homeSession,
      skills: node.skills,
      parent_agent_id: node.parent_agent_id,
      task_count: 0,
      state: "active",
      node_version: node.version,
    },
    cost: { time_ms: Date.now() - started },
  };
}
