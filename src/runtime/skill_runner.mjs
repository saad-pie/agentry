// agentry/src/runtime/skill_runner.mjs
//
// v0.20.0 — the skill execution engine. Shared by every agent_skill
// wrapper. Runs the LLM in a tool loop so a SKILL.md can actually do
// work (write files, run shell, execute node) instead of narrating.
//
// The LLM is prompted to reply with a JSON object that has at least:
//   { status: "awaiting_input" | "complete", content: "..." }
// while it can also call tools mid-turn.

const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write a UTF-8 text file inside the session workspace. Creates parent directories.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path inside the session workspace." },
          content: { type: "string", description: "The file content." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file from the session workspace. Returns up to 20000 characters.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List the files and directories inside the session workspace at a given path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path, '.' for workspace root." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_shell",
      description: "Run a shell command in the session workspace. Returns stdout, stderr, and exit_code.",
      parameters: {
        type: "object",
        properties: {
          cmd: { type: "string" },
          timeout_ms: { type: "number" },
        },
        required: ["cmd"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_node",
      description: "Run a Node.js script in the session workspace. Returns stdout, stderr, and exit_code.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string" },
          timeout_ms: { type: "number" },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_python",
      description: "Run Python code in the session workspace. Returns stdout, stderr, and exit_code.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string" },
          timeout_ms: { type: "number" },
        },
        required: ["code"],
      },
    },
  },
];

async function execToolCall(ctx, session, capId, call) {
  const name = call?.function?.name;
  let args;
  try { args = JSON.parse(call?.function?.arguments || "{}"); }
  catch (e) { return { error: "tool args not JSON: " + e.message }; }

  try {
    if (name === "write_file") {
      const r = await ctx.invoke("agentry.os", {
        action: "fs.write", session, path: args.path, content: String(args.content ?? ""),
      }, { tenant: "local", by: capId });
      if (!r.ok) return { error: r.error.code + ": " + r.error.message };
      return { ok: true, path: args.path, bytes: String(args.content ?? "").length };
    }
    if (name === "read_file") {
      const r = await ctx.invoke("agentry.os", {
        action: "fs.read", session, path: args.path,
      }, { tenant: "local", by: capId });
      if (!r.ok) return { error: r.error.code + ": " + r.error.message };
      const c = r.output?.result?.content ?? r.output?.content ?? "";
      return { path: args.path, content: String(c).slice(0, 20000) };
    }
    if (name === "list_files") {
      const r = await ctx.invoke("agentry.os", {
        action: "fs.list", session, path: args.path || ".",
      }, { tenant: "local", by: capId });
      if (!r.ok) return { error: r.error.code + ": " + r.error.message };
      const e = r.output?.result?.entries || r.output?.entries || [];
      return { path: args.path || ".", entries: Array.isArray(e) ? e.slice(0, 200) : [] };
    }
    if (name === "run_shell") {
      const r = await ctx.invoke("agentry.os", {
        action: "shell.spawn", session, cmd: "sh", args: ["-c", String(args.cmd || "")],
        timeout_ms: Math.min(Number(args.timeout_ms) || 60000, 120000),
      }, { tenant: "local", by: capId });
      if (!r.ok) return { error: r.error.code + ": " + r.error.message };
      const pid = r.output?.result?.pid;
      if (!pid) return { error: "shell.spawn returned no pid" };
      const read = await ctx.invoke("agentry.os", {
        action: "shell.read", session, pid, wait_ms: Math.min(Number(args.timeout_ms) || 60000, 120000),
      }, { tenant: "local", by: capId });
      if (!read.ok) return { error: read.error.code + ": " + read.error.message };
      const out = read.output?.result || {};
      return {
        stdout: String(out.stdout || "").slice(0, 20000),
        stderr: String(out.stderr || "").slice(0, 4000),
        exit_code: out.exit_code ?? 0,
      };
    }
    if (name === "run_node") {
      const r = await ctx.invoke("agentry.os", {
        action: "node.run", session, code: String(args.code || ""),
        timeout_ms: Math.min(Number(args.timeout_ms) || 60000, 120000),
      }, { tenant: "local", by: capId });
      if (!r.ok) return { error: r.error.code + ": " + r.error.message };
      const out = r.output?.result || {};
      return {
        stdout: String(out.stdout || "").slice(0, 20000),
        stderr: String(out.stderr || "").slice(0, 4000),
        exit_code: out.exit_code ?? 0,
      };
    }
    if (name === "run_python") {
      const r = await ctx.invoke("agentry.os", {
        action: "python.run", session, code: String(args.code || ""),
        timeout_ms: Math.min(Number(args.timeout_ms) || 60000, 120000),
      }, { tenant: "local", by: capId });
      if (!r.ok) return { error: r.error.code + ": " + r.error.message };
      const out = r.output?.result || {};
      return {
        stdout: String(out.stdout || "").slice(0, 20000),
        stderr: String(out.stderr || "").slice(0, 4000),
        exit_code: out.exit_code ?? 0,
      };
    }
    return { error: "unknown tool: " + name };
  } catch (e) {
    return { error: "tool " + name + " threw: " + e.message };
  }
}

export function buildSystemPrompt(skillPreamble, skillBody) {
  return (skillPreamble || "") + "\n\n---SKILL INSTRUCTIONS BELOW---\n\n" + (skillBody || "");
}

export function defaultPreamble() {
  return [
    "You are executing a skill. The skill's instructions follow at the end of this system message.",
    "",
    "You have tools: write_file, read_file, list_files, run_shell, run_node, run_python.",
    "USE THEM. If the skill says to save a file, call write_file. If it says to run code, call run_node or run_shell. Do NOT narrate actions you could take — take them.",
    "",
    "MULTI-TURN BEHAVIOR:",
    "If the skill needs more information from the user before it can complete, ask for exactly what you need and, when you stop calling tools, reply with ONLY this JSON:",
    "{\"status\":\"awaiting_input\",\"content\":\"<your question>\"}",
    "",
    "If the skill has completed its work, reply with ONLY this JSON:",
    "{\"status\":\"complete\",\"content\":\"<the finished result>\"}",
    "",
    "You may include additional fields in the final JSON if the skill naturally produces them.",
    "If this is a follow-up turn, do not repeat questions that were already answered.",
    "Do not include prose outside the JSON in your final response.",
  ].join("\n");
}

// v0.20.2 — provider chain. Groq rate limits are real and long. If
// the primary throws rate_limited (or any hard fail), try the next
// provider in the chain. Same model family if possible.
function buildChain(provider, model) {
  const chain = [];
  if (provider && model) chain.push({ provider, model });
  // Fallback order: gemini via the atria proxy, then back to groq
  // with a smaller model. Skip duplicates.
  const extra = [
    { provider: "google", model: "gemini-2.5-flash" },
    { provider: "groq", model: "openai/gpt-oss-20b" },
  ];
  for (const e of extra) {
    if (chain.some(c => c.provider === e.provider && c.model === e.model)) continue;
    chain.push(e);
  }
  return chain;
}

export async function runSkill({
  ctx,
  session,
  capId,
  provider,
  model,
  temperature = 0.2,
  maxTokens = 4000,
  systemPrompt,
  history = [],
  userMessage,
  maxTurns = 10,
}) {
  if (typeof ctx.invoke !== "function") throw new Error(capId + " requires ctx.invoke");

  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userMessage },
  ];

  let lastContent = null;
  const chain = buildChain(provider, model);
  let chainIdx = 0;
  let currentProvider = chain[chainIdx].provider;
  let currentModel = chain[chainIdx].model;

  for (let turn = 0; turn < maxTurns; turn++) {
    const r = await ctx.invoke("llm.openai_compat", {
      provider: currentProvider, model: currentModel, messages, tools: TOOL_DEFS,
      temperature, max_tokens: maxTokens,
    }, { tenant: "local", by: capId });

    if (!r.ok) {
      const code = r.error.code || "";
      const msg = String(r.error.message || "");
      const isRateLimit = code === "rate_limited" || /rate limit|429/i.test(msg);
      // v0.20.2 — fail over to the next provider on rate limit or
      // transient failures. Non-transient (invalid spec, missing key)
      // still throw.
      const canFailOver = isRateLimit
        || /invoker_failed/i.test(code)
        || code === "internal";
      if (canFailOver && chainIdx + 1 < chain.length) {
        chainIdx += 1;
        currentProvider = chain[chainIdx].provider;
        currentModel = chain[chainIdx].model;
        ctx.events.emit("skill_runner.provider_switched", {
          capability_id: capId,
          from: { provider, model },
          to: { provider: currentProvider, model: currentModel },
          reason: isRateLimit ? "rate_limited" : code,
          turn,
        });
        // Retry the same turn on the new provider.
        turn -= 1;
        continue;
      }
      throw new Error(capId + ": LLM call failed — " + code + ": " + msg);
    }

    const toolCalls = Array.isArray(r.output.tool_calls) ? r.output.tool_calls : [];
    lastContent = r.output.content || null;

    if (toolCalls.length === 0) {
      // Final response. Parse.
      return parseFinal(capId, lastContent);
    }

    messages.push({
      role: "assistant",
      content: r.output.content || null,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      const result = await execToolCall(ctx, session, capId, call);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call?.function?.name || "unknown",
        content: JSON.stringify(result).slice(0, 20000),
      });
    }
  }

  throw new Error(capId + ": tool loop exhausted after " + maxTurns + " turns without final JSON");
}

function parseFinal(capId, content) {
  if (!content || !String(content).trim()) {
    throw new Error(capId + ": LLM produced no final content");
  }
  let s = String(content).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last <= first) {
    // Model returned prose instead of JSON. Wrap it.
    return { status: "complete", content: String(content), raw: String(content) };
  }
  try {
    const parsed = JSON.parse(s.slice(first, last + 1));
    return parsed;
  } catch (e) {
    return { status: "complete", content: String(content), raw: String(content) };
  }
}
