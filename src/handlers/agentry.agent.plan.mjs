// agentry/src/handlers/agentry.agent.plan.mjs
// v0.47.0 — agent generates its own plan from an intent.
//
// v0.38.0: initial planner. Excluded kind:"agent" from the enumeration
//          to prevent the planner seeing itself — but that also hid
//          agentry.agent.dsh, so agentic tasks never routed to it.
// v0.41.0: replace kind-based exclusion with explicit PLANNER_EXCLUDED_IDS.
// v0.46.2: post-plan canonicalization (safety net).
// v0.47.1: replace rules 8+9 with anti-duplication (rule 8 vs 9 caused
//          the LLM to wrap QR→PDF in DSH bookends to satisfy both).
//
// v0.47.0: THE BIG ONE. Prior rules 1, 8, 10, 13 contradicted each other —
//          rule 1 explicitly permitted inventing new ids, then rules 8/10/13
//          tried to walk it back with "PREFER" and "USE EXISTING". The LLM
//          read rule 1 first and invented freely. This version replaces them
//          with ONE rule: work down a selection hierarchy (exact → adapted
//          → invent). Inventing requires a `justification` listing which
//          available capabilities were checked. validatePlan enforces it.
//          Canonicalization stays as a safety net but is expected to be
//          silent. If it fires, the prompt is still under-performing.

// v0.56.48 — planner gets fallback chain. Prior version was single-model;
// any 429 killed the whole task at step 0 with no chance to try another.
const PLANNER_CHAIN = (() => {
  const env = process.env.AGENTRY_PLANNER_PROVIDER;
  const envModel = process.env.AGENTRY_PLANNER_MODEL;
  if (env && envModel) return [{ provider: env, model: envModel }];
  return [
    { provider: "orcarouter", model: "tencent/hy4-preview-free" },
    { provider: "orcarouter", model: "z-ai/glm-5.3-flash-free" },
    { provider: "groq", model: "openai/gpt-oss-120b" },
    { provider: "google", model: "gemini-2.5-flash" },
  ];
})();
const PROVIDER = PLANNER_CHAIN[0].provider;
const MODEL = PLANNER_CHAIN[0].model;
const DEFAULT_MAX_STEPS = 8;
const MAX_CAPABILITIES_IN_PROMPT = 120;
const INTERNAL_KINDS = new Set(["invoker", "agentry", "service"]);

const PLANNER_EXCLUDED_IDS = new Set([
  "agentry.agent.plan",
  "agentry.agent.boot",
  "agentry.agent.task",
  "agentry.task.run",
  "agentry.proposal",
  "agentry.adopt",
  "agentry.synthesize",
  "agentry.trial",
  "agentry.mature",
  "agentry.discover",
  "agentry.ensure",
  "agentry.checkpoint",
  "agentry.reason",
  "agentry.reason.deep",
  "agentry.reason.harness",
  "agentry.chat",
  "agentry.os",
  "agentry.message.send",
  "agentry.message.read",
  "agentry.ensure",
  "agentry.checkpoint",
  "agent.dsh",
  "agent.dsh_poll",
]);

function enumerateCapabilities(graph, skillsFilter) {
  const out = [];
  for (const cap of graph.capabilities().values()) {
    if (cap.retired_at) continue;
    if (!cap.invoked_via) continue;
    if (INTERNAL_KINDS.has(cap.kind)) continue;
    if (PLANNER_EXCLUDED_IDS.has(cap.id)) continue;
    // v0.47.2 — exclude infra capability families. llm.*, notify.*, watcher.*,
    // discovery.* are primitives the planner sits above, not work units.
    // Without this, llm.openai_compat leaks into plans whenever the intent
    // contains something code-shaped (Date.now(), variables, etc).
    if (/^(llm|notify|watcher|discovery)\./.test(cap.id)) continue;
    if (cap.kind === "proposal" || cap.kind === "capability_gap" ||
        cap.kind === "watch_instance" || cap.kind === "synthesis_attempt" ||
        cap.kind === "edge" || cap.kind === "task" || cap.kind === "message") {
      continue;
    }
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
    "\n    accepts: " + (c.accepts.length ? c.accepts.join(", ") : "(none)") +
    "\n    produces: " + (c.produces.length ? c.produces.join(", ") : "(none)")
  ).join("\n");

  return "You are agentry's planner. Produce a plan that accomplishes the INTENT.\n\n" +
    "=== AVAILABLE CAPABILITIES ===\n" +
    (capLines || "  (none)") + "\n\n" +
    "=== INTENT ===\n" +
    intent + "\n\n" +
    "=== SELECTION HIERARCHY — check in order, stop at first match ===\n" +
    "\n" +
    "(a) EXACT MATCH\n" +
    "    A capability's `accepts` covers this step's required inputs AND\n" +
    "    its `produces` covers the required outputs. Use its exact id,\n" +
    "    verbatim. This is the expected case for 90%+ of steps.\n" +
    "\n" +
    "(b) ADAPTED MATCH\n" +
    "    A capability covers most of it — you can pass extra fields it\n" +
    "    ignores, drop optional inputs, or reuse an accepts key with\n" +
    "    similar semantics. Use its exact id.\n" +
    "\n" +
    "(c) INVENT — last resort\n" +
    "    NO available capability can work even after adapting. You MUST\n" +
    "    include all three fields:\n" +
    "      - wanted_kind: \"tool\" | \"web\" | \"notify\" | \"memory\" | \"harness\"\n" +
    "      - wanted_description: short search-friendly phrase (3-10 words)\n" +
    "      - justification: which available capabilities you checked and\n" +
    "        why each was insufficient (2-4 sentences)\n" +
    "    A step missing `justification` will be rejected by validation.\n" +
    "    Inventing when a real cap fits is a failure of this planner.\n" +
    "\n" +
    "=== OUTPUT — one JSON object, no prose, no fences ===\n" +
    "{\n" +
    "  \"steps\": [\n" +
    "    { \"capability_id\": \"<exact id>\", \"input\": {...}, \"why\": \"<short>\" }\n" +
    "    // OR for invented steps (rule c):\n" +
    "    // { \"capability_id\": \"<new dotted id>\", \"input\": {...}, \"why\": \"<short>\",\n" +
    "    //   \"wanted_kind\": \"tool\", \"wanted_description\": \"...\", \"justification\": \"...\" }\n" +
    "  ],\n" +
    "  \"reasoning\": \"<one sentence: overall approach>\"\n" +
    "}\n\n" +
    "=== RULES ===\n" +
    "1. Work down the hierarchy. Try (a), then (b), then (c). Only invent\n" +
    "   when you have ruled out every available capability.\n" +
    "2. Read `accepts` precisely. The step's input keys MUST match what the\n" +
    "   capability expects. Do not pass fields it does not declare.\n" +
    "3. Step inputs may reference prior step outputs:\n" +
    "   - \"$intent\"            → the raw intent string\n" +
    "   - \"$last_artifact\"     → file path from the most recent step\n" +
    "   - \"$prev.field.sub\"    → specific field from the previous step\n" +
    "   - \"$tmp/x.ext\"         → writable scratch directory\n" +
    "4. Path inputs must be absolute (\"/tmp/x.png\") or \"$tmp/x.png\".\n" +
    "   Do not invent $ tokens — only $intent, $last_artifact, $prev, $tmp.\n" +
    "5. If a capability's `produces` already returns a path or `data_url`,\n" +
    "   the file exists. Do NOT add a save/write step. Reference it via\n" +
    "   \"$last_artifact\" or \"$prev.<field>\" in the next step.\n" +
    "6. Use ≤ " + maxSteps + " steps. Fewer is better. Do not add filler steps.\n" +
    "7. Output ONLY the JSON object as your final message.\n" +
    "8. EACH STEP IS ONE CAPABILITY INVOCATION. Do not add a step whose\n" +
    "   only job is to invoke, wrap, verify, or duplicate the work of other\n" +
    "   steps. If a task needs generating a QR then saving as PDF, that is\n" +
    "   TWO steps (modbender → pdf-lib-table), not one DSH step wrapping\n" +
    "   both, and not a trailing DSH step to 'verify' after the fact.\n" +
    "9. If a capability's `accepts` field is `prompt` (e.g.\n" +
    "   agentry.agent.dsh), it accepts a whole task description as a string.\n" +
    "   Use it ONLY when the intent itself requires writing code, running\n" +
    "   commands to verify, iterating on failures, or exploring a filesystem.\n" +
    "   Do NOT use it for one-shot transformations that a direct capability\n" +
    "   can already accomplish — those are 2 steps (produce → consume), not\n" +
    "   wrapped in an agent. The result of a DSH step is in `final`; chain\n" +
    "   via \"$prev.final\" if a later step needs it.\n" +
    "\n" +
    "10. NOVEL TASK DISAMBIGUATION — when no capability fits and you are\n" +
    "    choosing between INVENT (rule 1c) and DSH (rule 9), the decision\n" +
    "    hinges on REPEATABILITY, not complexity:\n" +
    "    - INVENT if the task is a repeatable TRANSFORMATION: convert X to Y,\n" +
    "      extract Z from W, render N from M, transform any file of type A\n" +
    "      into type B. The pattern recurs across inputs. Capabilities save\n" +
    "      the next hundred callers 100+ seconds each.\n" +
    "    - ROUTE TO DSH if the task is one-off EXPLORATION: research a topic,\n" +
    "      find the best of N alternatives, debug this specific failure,\n" +
    "      browse a specific website, or produce a specific answer that will\n" +
    "      not be asked again. Capabilities here would be permanent overhead\n" +
    "      for a query that runs once.\n" +
    "    Default when unsure: INVENT. If the pattern was real, it saves time.\n" +
    "    If it was not, the capability sits unused and harmless.";
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

// Safety net: only fires when the LLM's invented id has a wanted_description
// that keyword-matches an existing capability. Expect this to be silent on
// a well-functioning prompt. If it fires on >5% of plans, revisit the prompt.
function canonicalizePlan(steps, capabilities) {
  const capIds = new Set(capabilities.map(c => c.id));
  const out = [];
  for (const step of steps) {
    if (capIds.has(step.capability_id)) { out.push(step); continue; }
    if (!step.wanted_description) { out.push(step); continue; }
    const desc = String(step.wanted_description).toLowerCase();
    const keywords = desc.split(/[^a-z0-9]+/).filter(w => w.length > 2);
    let best = null, bestScore = 0;
    for (const cap of capabilities) {
      const corpus = (cap.id + " " + (cap.kind || "") + " " + (cap.accepts || []).join(" ") + " " + (cap.produces || [])).toLowerCase();
      let score = 0;
      for (const kw of keywords) if (corpus.includes(kw)) score++;
      if (score > bestScore) { bestScore = score; best = cap; }
    }
    if (best && bestScore >= 2) {
      out.push({
        ...step,
        capability_id: best.id,
        original_planned_id: step.capability_id,
        canonicalized: true,
        invented: false,
        wanted_kind: undefined,
        wanted_description: undefined,
        justification: undefined,
      });
    } else { out.push(step); }
  }
  return out;
}

function validatePlan(parsed, maxSteps, capabilities) {
  if (!parsed || !Array.isArray(parsed.steps)) {
    return { ok: false, reason: "steps_not_array" };
  }
  if (parsed.steps.length === 0) {
    return { ok: false, reason: "no_steps" };
  }
  if (parsed.steps.length > maxSteps) {
    return { ok: false, reason: "too_many_steps: " + parsed.steps.length + " > " + maxSteps };
  }
  const capIds = new Set(capabilities.map(c => c.id));
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
    if (s.why) step.why = String(s.why).slice(0, 300);

    if (!capIds.has(s.capability_id)) {
      if (!s.justification || typeof s.justification !== "string" || !s.justification.trim()) {
        return { ok: false, reason: "step " + i + " invents \"" + s.capability_id + "\" without justification (rule 1c)" };
      }
      if (!s.wanted_description || typeof s.wanted_description !== "string" || !s.wanted_description.trim()) {
        return { ok: false, reason: "step " + i + " invents \"" + s.capability_id + "\" without wanted_description (rule 1c)" };
      }
      step.invented = true;
      step.wanted_kind = String(s.wanted_kind || "tool");
      step.wanted_description = String(s.wanted_description).slice(0, 300);
      step.justification = String(s.justification).slice(0, 800);
    }
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

  const capabilities = enumerateCapabilities(graph, skillsFilter);
  events.emit("agent.plan.started", {
    intent: String(intent).slice(0, 200),
    agent_id: agent_id || null,
    capabilities_considered: capabilities.length,
    max_steps: maxSteps,
    execute: execute === true,
  });

  const messages = [
    { role: "system", content: "You output only JSON. No prose. No fences." },
    { role: "user", content: buildPlanPrompt({ intent: String(intent), capabilities, maxSteps }) },
  ];

  let llmRes = null;
  const _attempts = [];
  for (const _pm of PLANNER_CHAIN) {
    try {
      const _r = await ctx.invoke("llm.openai_compat", {
        provider: _pm.provider,
        model: _pm.model,
        messages,
        temperature: 0.1,
        max_tokens: 2500,
        timeout_ms: 45000,
      }, { tenant: "local", by: "agentry.agent.plan" });
      if (_r.ok) {
        const _peek = parseJson(_r.output.content);
        if (_peek && Array.isArray(_peek.steps) && _peek.steps.length > 0) {
          llmRes = _r;
          _attempts.push({ provider: _pm.provider, model: _pm.model, ok: true });
          break;
        }
        _attempts.push({ provider: _pm.provider, model: _pm.model, ok: false, reason: "no_usable_json" });
      } else {
        _attempts.push({ provider: _pm.provider, model: _pm.model, ok: false, code: _r.error?.code });
      }
    } catch (e) {
      _attempts.push({ provider: _pm.provider, model: _pm.model, ok: false, threw: e.message });
    }
  }
  if (!llmRes) {
    events.emit("agent.plan.all_models_failed", { attempts: _attempts });
    throw new Error("agentry.agent.plan: all planner models failed. attempts=" + JSON.stringify(_attempts).slice(0, 500));
  }

  const parsed = parseJson(llmRes.output.content);
  if (!parsed) {
    events.emit("agent.plan.unparseable", { preview: String(llmRes.output.content || "").slice(0, 300) });
    throw new Error("agentry.agent.plan: could not parse JSON. Raw: " + String(llmRes.output.content || "").slice(0, 300));
  }

  let validation = validatePlan(parsed, maxSteps, capabilities);

  // v0.50.1 — a brain that can't decide should delegate, not fail. When the
  // LLM returns ZERO steps, retry once with a sharper prompt; if still empty,
  // fall back to a single DSH step carrying the intent verbatim. This mirrors
  // how Hermes delegates to OpenCode when its own skills don't cover a case.
  if (!validation.ok && validation.reason === "no_steps") {
    events.emit("agent.plan.empty_steps", { intent: String(intent).slice(0, 200) });

    const retryPrompt = buildPlanPrompt({ intent: String(intent), capabilities, maxSteps }) +
      " ||| RETRY REQUIRED: You returned ZERO steps. This is unacceptable. Return at least ONE step. If no available capability fits, use EXACTLY capability_id 'agentry.agent.dsh' with input: { prompt: <the user's original intent message, verbatim> }.";

    try {
      const retryRes = await ctx.invoke("llm.openai_compat", {
        provider: PROVIDER,
        model: MODEL,
        messages: [
          { role: "system", content: "You output only JSON. No prose. No fences." },
          { role: "user", content: retryPrompt },
        ],
        temperature: 0.1,
        max_tokens: 2000,
        timeout_ms: 30000,
      }, { tenant: "local", by: "agentry.agent.plan" });
      if (retryRes.ok) {
        const retryParsed = parseJson(retryRes.output.content);
        if (retryParsed) {
          const rv = validatePlan(retryParsed, maxSteps, capabilities);
          if (rv.ok) {
            validation = rv;
            events.emit("agent.plan.empty_steps_retry_ok", { steps: rv.steps.length });
          }
        }
      }
    } catch (e) {
      events.emit("agent.plan.empty_steps_retry_failed", { error: e.message });
    }

    if (!validation.ok) {
      events.emit("agent.plan.empty_steps_dsh_fallback", { intent: String(intent).slice(0, 200) });
      validation = {
        ok: true,
        steps: [{
          capability_id: "agentry.agent.dsh",
          input: { prompt: String(intent) },
          why: "planner returned empty; delegating entire intent to DSH",
        }],
      };
    }
  }

  if (!validation.ok) {
    events.emit("agent.plan.invalid", { reason: validation.reason });
    throw new Error("agentry.agent.plan: invalid plan: " + validation.reason);
  }

  const canonicalSteps = canonicalizePlan(validation.steps, capabilities);
  const rewrites = canonicalSteps.filter(s => s.canonicalized);
  if (rewrites.length > 0) {
    events.emit("agent.plan.canonicalized", {
      rewrite_count: rewrites.length,
      rewrites: rewrites.map(r => ({
        from: r.original_planned_id,
        to: r.capability_id,
        description: r.wanted_description || null,
      })),
      warning: "prompt fix should have prevented this — check rule 1 compliance",
    });
  }

  const inventedSteps = canonicalSteps.filter(s => s.invented);
  if (inventedSteps.length > 0) {
    events.emit("agent.plan.invented", {
      count: inventedSteps.length,
      steps: inventedSteps.map(s => ({
        capability_id: s.capability_id,
        wanted_description: s.wanted_description,
        justification: s.justification,
      })),
    });
  }

  events.emit("agent.plan.completed", {
    intent: String(intent).slice(0, 200),
    steps: canonicalSteps.length,
    exact_matches: canonicalSteps.filter(s => !s.invented && !s.canonicalized).length,
    canonicalized: rewrites.length,
    invented: inventedSteps.length,
    model_used: llmRes.output.model || MODEL,
    ms: Date.now() - started,
  });

  const output = {
    ok: true,
    plan: canonicalSteps,
    agent_id: agent_id || null,
    model_used: llmRes.output.model || (PROVIDER + "/" + MODEL),
    reasoning: parsed.reasoning || null,
    capabilities_considered: capabilities.length,
    steps: canonicalSteps.length,
    ...(rewrites.length > 0 ? { canonicalized_count: rewrites.length } : {}),
    ...(inventedSteps.length > 0 ? { invented_count: inventedSteps.length } : {}),
  };

  if (execute === true) {
    if (!agent_id) {
      output.executed = false;
      output.execute_error = "execute=true requires agent_id";
    } else {
      try {
        const taskRes = await ctx.invoke("agentry.agent.task", {
          agent_id,
          intent: String(intent),
          plan: canonicalSteps,
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
