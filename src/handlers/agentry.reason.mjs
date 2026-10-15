// agentry/src/handlers/agentry.reason.mjs
// The reasoning capability the harness calls when it hits a wall.
//
// v0.15.21: model chain reordered to match agentry.reason.deep.
//
// v0.15.26 — grounded capability resolution. Same change as the deep
// reasoner: inject the current capability list into the system prompt,
// resolve any invented wanted_id against the graph (exact -> prefix ->
// none), and if the resolved id already exists, return it in
// existing_capability instead of recording a gap.

import { recordGap } from "./agentry.capability_gap.mjs";

const INTERNAL_KINDS = new Set(["invoker", "agentry", "service"]);
const MAX_CAP_LIST = 60;

function buildModelChain(input) {
  const chain = [];
  if (input?.model && typeof input.model === "string" && input.model.length > 0) {
    chain.push({ provider: null, model: input.model, source: "harness" });
  }
  chain.push(
    { provider: "groq", model: "qwen/qwen3.8-27b", source: "primary" },
    { provider: "google", model: "gemini-2.5-flash", source: "fallback" },
    { provider: "groq", model: "openai/gpt-oss-120b", source: "fallback" },
    { provider: "groq", model: "openai/gpt-oss-20b", source: "fallback" },
  );
  const seen = new Set();
  return chain.filter(c => {
    if (seen.has(c.model)) return false;
    seen.add(c.model);
    return true;
  });
}

function listLiveCapabilities(graph) {
  const out = [];
  for (const cap of graph.capabilities().values()) {
    if (cap.retired_at) continue;
    if (!cap.invoked_via) continue;
    if (INTERNAL_KINDS.has(cap.kind)) continue;
    out.push({ id: cap.id, kind: cap.kind });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out.slice(0, MAX_CAP_LIST);
}

function systemPrompt(graph) {
  const caps = listLiveCapabilities(graph);
  const capLines = caps.length
    ? caps.map(c => "  " + c.id + "  (" + c.kind + ")").join("\n")
    : "  (none)";

  return "You are agentry, the reasoning layer behind an autonomous agent system.\n" +
    "The DeepSeek Harness just hit a wall and is asking you for help.\n\n" +
    "Your job: figure out what went wrong, name the missing capability (if any),\n" +
    "and give the harness a concrete immediate action it can take RIGHT NOW.\n\n" +
    "=== CAPABILITIES CURRENTLY IN THE GRAPH ===\n" +
    capLines + "\n\n" +
    "CRITICAL RULE about the list above:\n" +
    "  - Before you decide a capability is missing, check the list. If a\n" +
    "    capability already exists that could do what the task needs, set\n" +
    "    \"missing\" to null and name that capability in \"immediate_action\".\n" +
    "  - Do NOT invent a new capability id that only differs in punctuation\n" +
    "    or word order from one you see in the list.\n" +
    "  - Only set \"missing\" when NO existing capability can do the job.\n\n" +
    "Return ONLY a JSON object with this shape, nothing else:\n" +
    "{\n" +
    "  \"analysis\": \"<2-3 sentences on what actually happened and why>\",\n" +
    "  \"missing\": {\n" +
    "    \"kind\": \"<one of: bua, cua, mua, memory, tool, notify, web, harness, unknown>\",\n" +
    "    \"wanted_id\": \"<dotted capability id, e.g. bua.browser>\",\n" +
    "    \"confidence\": \"high\" | \"medium\" | \"low\"\n" +
    "  } | null,\n" +
    "  \"immediate_action\": \"<one concrete thing the harness can try in this session, or none>\",\n" +
    "  \"suggestions\": [\"<up to 3 short candidate fixes / projects>\"]\n" +
    "}\n\n" +
    "Rules:\n" +
    "- Output only JSON. No prose.\n" +
    "- If an existing capability solves the problem, set \"missing\" to null\n" +
    "  and name it in \"immediate_action\".\n" +
    "- If the failure is due to a missing capability (and none exists), fill in \"missing\".\n" +
    "- If the failure is a bug or a retry-able error, set \"missing\" to null\n" +
    "  and put the retry strategy in \"immediate_action\".\n" +
    "- Be specific. Prefer named projects over generic advice.";
}

function userPrompt(input) {
  const { failure, attempted, intent, workspace_id, session_id } = input || {};
  const lines = [];
  if (intent) lines.push("USER INTENT: " + intent);
  if (workspace_id) lines.push("WORKSPACE: " + workspace_id);
  if (session_id) lines.push("SESSION: " + session_id);
  if (attempted) lines.push("WHAT WAS ATTEMPTED: " + JSON.stringify(attempted));
  lines.push("");
  lines.push("FAILURE / CONTEXT FROM HARNESS:");
  lines.push(typeof failure === "string" ? failure : JSON.stringify(failure, null, 2));
  return lines.join("\n");
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

function resolveWantedId(graph, wantedId) {
  if (!wantedId) return { resolved: wantedId, matched_via: "none" };
  const exact = graph.getCapability(wantedId);
  if (exact && !exact.retired_at) {
    return { resolved: wantedId, matched_via: "exact" };
  }
  const segments = String(wantedId).split(".");
  for (let i = segments.length - 1; i >= 1; i--) {
    const candidate = segments.slice(0, i).join(".");
    const cap = graph.getCapability(candidate);
    if (cap && !cap.retired_at) {
      return { resolved: candidate, matched_via: "prefix" };
    }
  }
  return { resolved: wantedId, matched_via: "none" };
}

export default async function agentryReason(input, ctx) {
  const { failure, attempted, intent, workspace_id, session_id } = input || {};
  if (!failure && !intent) throw new Error("agentry.reason requires failure or intent");

  if (typeof ctx.invoke !== "function") {
    throw new Error("agentry.reason requires ctx.invoke");
  }

  const started = Date.now();
  const messages = [
    { role: "system", content: systemPrompt(ctx.graph) },
    { role: "user", content: userPrompt(input) },
  ];

  const chain = buildModelChain(input);
  const attempts = [];
  let parsed = null;
  let modelUsed = null;
  let chainSource = null;

  for (const { provider, model, source } of chain) {
    try {
      const llmRes = await ctx.invoke("llm.openai_compat", {
        provider,
        model,
        messages,
        temperature: 0.1,
        max_tokens: 3000,
        accept_from: null,
      }, { tenant: "local", by: "agentry.reason" });

      if (!llmRes.ok) {
        attempts.push({
          provider, model, source, ok: false,
          code: llmRes.error.code, message: llmRes.error.message,
        });
        ctx.events.emit("agentry.reason.llm_failed", {
          provider, model, source,
          code: llmRes.error.code, message: llmRes.error.message,
        });
        continue;
      }

      const p = parseJson(llmRes.output.content);
      if (p) {
        parsed = p;
        modelUsed = llmRes.output.model || model;
        chainSource = source;
        attempts.push({ provider, model, source, ok: true });
        break;
      }
      attempts.push({ provider, model, source, ok: false, reason: "unparseable" });
      ctx.events.emit("agentry.reason.llm_unparseable", {
        provider, model, source,
        content: String(llmRes.output.content).slice(0, 300),
      });
    } catch (e) {
      attempts.push({ provider, model, source, ok: false, error: e.message });
      ctx.events.emit("agentry.reason.llm_threw", { provider, model, source, error: e.message });
    }
  }

  if (!parsed) {
    ctx.events.emit("agentry.reason.all_models_failed", {
      workspace_id: workspace_id || null,
      session_id: session_id || null,
      attempts,
    });
    throw new Error(
      "agentry.reason: all " + chain.length + " models in the fallback chain failed. " +
      "Last attempt: " + JSON.stringify(attempts[attempts.length - 1] || null)
    );
  }

  let gap_id = null;
  let existing_capability = null;
  let proposed_id = null;
  let resolved_id = null;
  let matched_via = null;

  const rawMissing = parsed.missing;
  if (rawMissing && rawMissing.wanted_id) {
    proposed_id = rawMissing.wanted_id;
    const res = resolveWantedId(ctx.graph, proposed_id);
    resolved_id = res.resolved;
    matched_via = res.matched_via;

    if (resolved_id !== proposed_id) {
      ctx.events.emit("agentry.reason.wanted_id_resolved", {
        proposed: proposed_id,
        resolved: resolved_id,
        matched_via,
      });
    }

    const existing = ctx.graph.getCapability(resolved_id);
    if (existing && !existing.retired_at) {
      existing_capability = {
        id: existing.id,
        kind: existing.kind,
        handler_file: existing.handler_file || null,
      };
      ctx.events.emit("agentry.reason.existing_capability_matched", {
        proposed: proposed_id,
        matched_id: existing.id,
        matched_via,
      });
    } else {
      const key = "gap:" + resolved_id;
      try {
        const gap = recordGap(
          { graph: ctx.graph, events: ctx.events },
          {
            key,
            wanted_kind: rawMissing.kind || "unknown",
            wanted_id: resolved_id,
            reason: "harness reasoning: " + (parsed.analysis?.slice(0, 200) || "unspecified"),
            example_task_id: session_id || null,
          }
        );
        gap_id = gap.id;

        ctx.events.emit("agentry.reason.gap_recorded", {
          gap_id,
          wanted_kind: gap.wanted_kind,
          hits: gap.hits,
          proposed_id,
          resolved_id,
          workspace_id: workspace_id || null,
          session_id: session_id || null,
        });
      } catch (e) {
        ctx.events.emit("agentry.reason.gap_record_failed", {
          error: e.message, wanted_id: resolved_id,
        });
      }
    }
  }

  if (gap_id) {
    try {
      await ctx.invoke("agentry.checkpoint", {
        reason: "reason:gap_recorded:" + gap_id,
      }, { tenant: "local", by: "agentry.reason" });
    } catch (e) {
      ctx.events.emit("reason.checkpoint_failed", { gap_id, error: e.message });
    }
  }

  ctx.events.emit("agentry.reason.completed", {
    workspace_id: workspace_id || null,
    session_id: session_id || null,
    missing: resolved_id || null,
    gap_id,
    existing_capability_id: existing_capability?.id || null,
    model_used: modelUsed,
    chain_source: chainSource,
    attempts_count: attempts.length,
    ms: Date.now() - started,
  });

  const missing = rawMissing
    ? Object.assign({}, rawMissing, {
        wanted_id: resolved_id || rawMissing.wanted_id,
      }, proposed_id && resolved_id !== proposed_id ? { proposed_id } : {})
    : null;

  const note = existing_capability
    ? "Capability " + existing_capability.id + " already exists in the graph. Invoke it directly — no gap recorded."
    : (gap_id
        ? "A capability gap was recorded. A proposal will be generated in the background and emailed for approval."
        : "No gap recorded — this looks like a retry or in-session fix.");

  return {
    output: {
      analysis: parsed.analysis,
      missing,
      immediate_action: parsed.immediate_action,
      suggestions: parsed.suggestions || [],
      gap_recorded: gap_id,
      existing_capability,
      note,
      model_used: modelUsed,
      chain_source: chainSource,
    },
    cost: { time_ms: Date.now() - started },
  };
}
