// agentry/src/handlers/llm.openai_compat.mjs
// Talks to an OpenAI-compatible /v1/chat/completions endpoint.
//
// Config comes from config.llm: { baseUrl, apiKey, metaFile }.
// The provider and model are passed per-call so the graph can route.
//
// This handler does NOT choose a model. That's election's job. It takes
// a model id and a chat request, and returns the assistant's reply.

export default async function llmOpenAICompat(input, ctx) {
  const {
    model,
    messages,
    temperature = 0.2,
    max_tokens = 1024,
    response_format, // optional: { type: "json_object" }
    timeout_ms = 30000,
  } = input || {};

  if (!model) throw new Error("llm.openai_compat requires 'model'");
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("llm.openai_compat requires non-empty 'messages' array");
  }

  const cfg = ctx.config?.llm || {};
  const baseUrl = cfg.baseUrl || "https://antigravity-seven-delta.vercel.app/v1";
  const apiKey = cfg.apiKey || "antigravity-free";

  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  const body = {
    model,
    messages,
    temperature,
    max_tokens,
  };
  if (response_format) body.response_format = response_format;

  const started = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout_ms),
    });
  } catch (e) {
    const err = new Error(`llm: fetch failed: ${e.message}`);
    err.retryable = true;
    throw err;
  }

  if (res.status === 401 || res.status === 403) {
    const text = await res.text().catch(() => "");
    const err = new Error(`llm: auth failed HTTP ${res.status} — ${text.slice(0, 200)}`);
    err.retryable = false;
    throw err;
  }
  if (res.status === 429) {
    const retryAfter = res.headers.get("retry-after");
    const err = new Error("llm: rate limited by provider");
    err.retryable = true;
    err.retry_after_ms = retryAfter ? Number(retryAfter) * 1000 : 30000;
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`llm: HTTP ${res.status} — ${text.slice(0, 300)}`);
    err.retryable = res.status >= 500;
    throw err;
  }

  const data = await res.json().catch(() => null);
  const choice = data?.choices?.[0];
  if (!choice) {
    const err = new Error("llm: no choices in response");
    err.retryable = true;
    throw err;
  }

  const content = choice.message?.content ?? "";
  const finish_reason = choice.finish_reason ?? null;
  const usage = data?.usage || {};

  return {
    output: {
      content,
      model: data?.model || model,
      finish_reason,
      usage: {
        prompt_tokens: usage.prompt_tokens ?? null,
        completion_tokens: usage.completion_tokens ?? null,
        total_tokens: usage.total_tokens ?? null,
      },
    },
    cost: {
      time_ms: Date.now() - started,
      http_calls: 1,
      tokens: usage.total_tokens ?? null,
      money_usd: 0,
    },
  };
}
