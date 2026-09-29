// agentry/src/handlers/llm.openai_compat.mjs
// OpenAI-compatible chat completions with dynamic model verification.
//
// New: accepts `accept_from` — a predicate spec describing which models
// are acceptable responses. If set, and the provider returns a model that
// doesn't satisfy the predicate, the handler rejects with a `substituted`
// error. If not set, no verification (backwards compatible).

import { ModelRegistry } from "../model_registry.mjs";

// One registry per process. Refreshed on first use and every 10 min.
let REGISTRY = null;
let REGISTRY_LAST_REFRESH = 0;
const REGISTRY_REFRESH_MS = 10 * 60 * 1000;

async function getRegistry(ctx) {
  const cfg = ctx.config?.llm || {};
  const baseUrl = cfg.baseUrl || "https://antigravity-seven-delta.vercel.app/v1";
  const apiKey = cfg.apiKey || "antigravity-free";
  if (!REGISTRY) REGISTRY = new ModelRegistry({ baseUrl, apiKey });
  if (Date.now() - REGISTRY_LAST_REFRESH > REGISTRY_REFRESH_MS || REGISTRY.models.size === 0) {
    await REGISTRY.refresh();
    REGISTRY_LAST_REFRESH = Date.now();
  }
  return REGISTRY;
}

function satisfies(modelEntry, acceptFrom) {
  if (!acceptFrom) return true;
  if (!modelEntry) return false;
  if (acceptFrom.model && modelEntry.id !== acceptFrom.model) return false;
  if (acceptFrom.provider && modelEntry.provider !== acceptFrom.provider) return false;
  if (acceptFrom.limit_type && modelEntry.limit_type !== acceptFrom.limit_type) return false;
  return true;
}

export default async function llmOpenAICompat(input, ctx) {
  const {
    model,
    messages,
    temperature = 0.2,
    max_tokens = 1024,
    response_format,       // optional: { type: "json_object" }
    timeout_ms = 30000,
    accept_from,           // optional: { model?, provider?, limit_type? }
  } = input || {};

  if (!model) throw new Error("llm.openai_compat requires 'model'");
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("llm.openai_compat requires non-empty 'messages' array");
  }

  const cfg = ctx.config?.llm || {};
  const baseUrl = cfg.baseUrl || "https://antigravity-seven-delta.vercel.app/v1";
  const apiKey = cfg.apiKey || "antigravity-free";
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  const body = { model, messages, temperature, max_tokens };
  if (response_format) body.response_format = response_format;

  const started = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
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
  const returnedModelId = data?.model || model;

  // ---- dynamic verification against the live registry ----
  if (accept_from) {
    const reg = await getRegistry(ctx);
    const entry = reg.models.get(returnedModelId);
    if (!entry) {
      const err = new Error(
        `llm: returned model "${returnedModelId}" is not in the current /v1/models snapshot. Rejected.`
      );
      err.retryable = false;
      err.substituted = true;
      err.reason = "not_in_snapshot";
      throw err;
    }
    if (!satisfies(entry, accept_from)) {
      const err = new Error(
        `llm: returned model "${returnedModelId}" does not satisfy accept_from ${JSON.stringify(accept_from)}. Rejected.`
      );
      err.retryable = false;
      err.substituted = true;
      err.reason = "accept_from_mismatch";
      err.returned_model = returnedModelId;
      throw err;
    }
  }

  return {
    output: {
      content,
      model: returnedModelId,
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
