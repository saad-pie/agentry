// agentry/src/handlers/agentry.agent.plan.mjs
// v0.38.0 — agent generates its own plan from an intent.
//
// Given an intent and an agent (optional), produce a plan (array of
// {capability_id, input} steps) that a caller can hand to
// agentry.task.run or agentry.agent.task.
//
// Design:
//   - Input: {intent, agent_id?, skills?, max_steps?, execute?}
//   - agent_id given: filter available capabilities to agent.skills
//   - agent_id omitted: use all invokable capabilities
//   - LLM produces {steps: [...], reasoning: "..."} via groq gpt-oss-120b
//   - Steps may reference capabilities that don't exist yet; the planner
//     sets wanted_kind + wanted_description for those, which task.run's
//     retry-on-missing path picks up
//   - execute=true: plan is passed directly to agentry.agent.task
//   - Returns {ok, plan, agent_id, model_used, reasoning, executed?}
//
// The prompt is the load-bearing piece. If planning quality is poor, tune
// the prompt, not the model. gpt-oss-120b reliably produces structured
// JSON under 1s in this deployment.

const PROVIDER = process.env.AGENTRY_PLANNER_PROVIDER || "groq";
const MODEL = process.env.AGENTRY_PLANNER_MODEL || "openai/gpt-oss-120b";
const DEFAULT_MAX_STEPS = 8;
const MAX_CAPABILITIES_IN_PROMPT = 60;
const INTERNAL_KINDS = new Set(["invoker", "agentry", "service"]);

function enumerateCapabilities(graph, skillsFilter) {
  const out = [];
  for (const cap of graph.capabilities().values()) {
    if (cap.retired_at) continue;
    if (!cap.invoked_via) continue;
    if (INTERNAL_KINDS.has(cap.kind)) continue;
    if (cap.kind === "task" || cap.kind === "agent" || cap.kind === "message" || cap.kind === "proposal" || cap.kind === "capability_gap" || cap.kind === "watch_instance" || cap.kind === "synthesis_attempt") continue;
    if (cap.kind === "edge") continue;
    if (Array.isArray(skillsFilter) && skillsFilter.length > 0) {
      if (!skillsFilter.includes(cap.id)) continue;
    }
    out.push({
      id: cap.id,
      kind: cap.kind,
      accepts: cap.accepts ? Object.keys(cap.accepts) : [],
      produces: cap.produces ? Object.keys(cap.produces) : [],
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out.slice(0, MAX_CAPABILITIES_IN_PROMPT);
}

function buildPlanPrompt({ intent, capabilities, maxSteps }) {
  const capLines = capabilities.map(c =>
    "  - id: " + c.id +
    "\n    kind: " + c.kind +
    "\n    accepts: " + (c.accepts.length ? c.accepts.join(", ") : "(none)") +
    "\n    produces: " + (c.produces.length ? c.produces.join(", ") : "(none)")
  ).join("\n");

  return "You are agentry's planner. Given an INTENT and a list of AVAILABLE\n" +
    "CAPABILITIES, produce a plan (ordered steps) that accomplishes the intent.\n\n" +
    "=== AVAILABLE CAPABILITIES (invoke through agentry.task.run) ===\n" +
    (capLines || "  (none — you will need to invent capability ids)") + "\n\n" +
    "=== INTENT ===\n" +
    intent + "\n\n" +
    "=== OUTPUT — a single JSON object, no prose, no fences ===\n" +
    "{\n" +
    "  \"steps\": [\n" +
    "    {\n" +
    "      \"capability_id\": \"<from AVAILABLE CAPABILITIES, or a NEW dotted id>\",\n" +
    "      \"input\": { \"<key>\": \"<value>\" },\n" +
    "      \"why\": \"<one short sentence>\"\n" +
    "    }\n" +
    "  ],\n" +
    "  \"reasoning\": \"<one short sentence: overall approach>\"\n" +
    "}\n\n" +
    "=== RULES ===\n" +
    "1. Each step's capability_id MUST be either:\n" +
    "   (a) an exact id from AVAILABLE CAPABILITIES, or\n" +
    "   (b) a NEW dotted id (e.g. \"bua.browser\", \"pdf.from_image\") if the intent\n" +
    "       needs a capability that is not yet available.\n" +
    "2. For NEW capabilities, ALSO include \"wanted_kind\" and\n" +
    "   \"wanted_description\" fields on the step. Example:\n" +
    "     { \"capability_id\": \"pdf.from_image\",\n" +
    "       \"wanted_kind\": \"tool\",\n" +
    "       \"wanted_description\": \"convert PNG image to PDF file\",\n" +
    "       \"input\": { \"image_path\": \"$last_artifact\" } }\n" +
    "3. Step inputs may reference PRIOR step outputs:\n" +
    "   - \"$last_artifact\"  -> file path from the most recent step's output\n" +
    "   - \"$prev.field.sub\" -> a specific field path from the previous step\n" +
    "   - \"$intent\"         -> the raw intent string\n" +
    "4. Steps MUST be ≤ " + maxSteps + " in count. If the intent can be done in fewer\n" +
    "   steps, do fewer. Do not add filler.\n" +
    "5. Read capability `accepts` lists carefully — the step's `input` keys\n" +
    "   MUST match what the capability expects. Mismatched keys will fail trial.\n" +
    "6. Do NOT invent fields inside AVAILABLE capabilities. If a capability\n" +
    "   accepts only {image_path}, do not pass {image_path, title}.\n" +
    "7. Output ONLY the JSON object as your final message.";
}

function parseJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  s = s.slice(first, last + 1);
  try { return JSON.parse(s); } catch { return null; }
}

function validatePlan(parsed, maxSteps) {
  if (!parsed || !Array.isArray(parsed.steps)) {
    return { ok: false, reason: "steps_not_array" };
  }
  if (parsed.steps.length === 0) {
    return { ok: false, reason: "no_steps" };
  }
  if (parsed.steps.length > maxSteps) {
    return { ok: false, reason: "too_many_steps: " + parsed.steps.length + " > " + maxSteps };
  }
  const cleaned = [];
  for (let i = 0; i < parsed.steps.length; i++) {
    const s = parsed.steps[i];
    if (!s || typeof s !== "object" || !s.capability_id || typeof s.capability_id !== "string") {
      return { ok: false, reason: "step " + i + " missing capability_id" };
    }
    const step = {
      capability_id: s.capability_id,
      input: (s.input && typeof s.input === "object") ? s.input : {},
    };
    if (s.wanted_kind) step.wanted_kind = String(s.wanted_kind);
    if (s.wanted_description) step.wanted_description = String(s.wanted_description);
    if (s.why) step.why = String(s.why).slice(0, 300);
    cleaned.push(step);
  }
  return { ok: true, steps: cleaned };
}

export default async function agentryAgentPlan(input, ctx) {
  const { intent, agent_id, skills, max_steps, execute } = input || {};
  if (!intent || String(intent).trim().length < 3) {
    throw new Error("agentry.agent.plan requires intent (>=3 chars)");
  }
  if (typeof ctx.invoke !== "function") throw new Error("agentry.agent.plan requires ctx.invoke");

  const graph = ctx.graph;
  const events = ctx.events;
  const started = Date.now();
  const maxSteps = Math.max(1, Math.min(20, Number(max_steps) || DEFAULT_MAX_STEPS));

  // ── 1. Resolve agent context (optional) ──
  let agent = null;
  let skillsFilter = null;
  if (agent_id) {
    agent = graph.getCapability(agent_id);
    if (!agent) throw new Error("agentry.agent.plan: agent not found: " + agent_id);
    if (agent.kind !== "agent") throw new Error("agentry.agent.plan: " + agent_id + " is kind " + agent.kind + ", not agent");
    if (agent.retired_at) throw new Error("agentry.agent.plan: agent is retired: " + agent_id);
    if (Array.isArray(agent.skills) && agent.skills.length > 0) {
      skillsFilter = agent.skills;
    }
  } else if (Array.isArray(skills) && skills.length > 0) {
    skillsFilter = skills;
  }

  // ── 2. Enumerate available capabilities ──
  const capabilities = enumerateCapabilities(graph, skillsFilter);
  events.emit("agent.plan.started", {
    intent: String(intent).slice(0, 200),
    agent_id: agent_id || null,
    capabilities_considered: capabilities.length,
    max_steps: maxSteps,
    execute: execute === true,
  });

  // ── 3. Ask the LLM ──
  const messages = [
    { role: "system", content: "You output only JSON. No prose. No fences." },
    { role: "user", content: buildPlanPrompt({ intent: String(intent), capabilities, maxSteps }) },
  ];

  let llmRes;
  try {
    llmRes = await ctx.invoke("llm.openai_compat", {
      provider: PROVIDER,
      model: MODEL,
      messages,
      temperature: 0.1,
      max_tokens: 2000,
      timeout_ms: 30000,
    }, { tenant: "local", by: "agentry.agent.plan" });
  } catch (e) {
    events.emit("agent.plan.llm_threw", { error: e.message });
    throw new Error("agentry.agent.plan: llm threw: " + e.message);
  }
  if (!llmRes.ok) {
    events.emit("agent.plan.llm_failed", {
      code: llmRes.error?.code, message: String(llmRes.error?.message || "").slice(0, 300),
    });
    throw new Error("agentry.agent.plan: llm failed: " + (llmRes.error?.message || "unknown"));
  }

  const parsed = parseJson(llmRes.output.content);
  if (!parsed) {
    events.emit("agent.plan.unparseable", { preview: String(llmRes.output.content || "").slice(0, 300) });
    throw new Error("agentry.agent.plan: could not parse JSON. Raw: " + String(llmRes.output.content || "").slice(0, 300));
  }

  // ── 4. Validate ──
  const validation = validatePlan(parsed, maxSteps);
  if (!validation.ok) {
    events.emit("agent.plan.invalid", { reason: validation.reason });
    throw new Error("agentry.agent.plan: invalid plan: " + validation.reason);
  }

  events.emit("agent.plan.completed", {
    intent: String(intent).slice(0, 200),
    steps: validation.steps.length,
    model_used: llmRes.output.model || MODEL,
    ms: Date.now() - started,
  });

  const output = {
    ok: true,
    plan: validation.steps,
    agent_id: agent_id || null,
    model_used: llmRes.output.model || (PROVIDER + "/" + MODEL),
    reasoning: parsed.reasoning || null,
    capabilities_considered: capabilities.length,
    steps: validation.steps.length,
  };

  // ── 5. Optional: execute via agent.task ──
  if (execute === true) {
    if (!agent_id) {
      output.executed = false;
      output.execute_error = "execute=true requires agent_id (agent.plan does not create tasks without an owner)";
    } else {
      try {
        const taskRes = await ctx.invoke("agentry.agent.task", {
          agent_id,
          intent: String(intent),
          plan: validation.steps,
        }, { tenant: "local", by: "agentry.agent.plan" });
        output.executed = true;
        output.task = taskRes.output || {};
      } catch (e) {
        output.executed = false;
        output.execute_error = "agent.task threw: " + e.message;
        events.emit("agent.plan.execute_failed", { agent_id, error: e.message });
      }
    }
  }

  return {
    output,
    cost: {
      time_ms: Date.now() - started,
      http_calls: 1,
      tokens: llmRes.output.usage?.total_tokens || null,
    },
  };
}
