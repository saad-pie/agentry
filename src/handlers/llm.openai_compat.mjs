// agentry/src/handlers/llm.openai_compat.mjs
// OpenAI-compatible chat completions with dynamic model verification.
//
// v0.15.16: accepts `tools` and `tool_choice` for native function
// calling, and surfaces `tool_calls` from the response.
//
// v0.23.2: multi-key rotation. Providers (currently groq) may expose
// a `keys[]` array. On 429 from one key, rotate to the next key and
// retry the SAME model before giving up. Key rotation is provider-
// local — it does not change the model, it just changes the account
// the request is billed to. Combined with the caller's model chain
// this multiplies throughput 4x on groq free tier.

import { ModelRegistry } from "../model_registry.mjs";

let REGISTRY = null;
let REGISTRY_LAST_REFRESH = 0;
const REGISTRY_REFRESH_MS = 10 * 60 * 1000;

// Per-provider key rotation cursor. Module-scope Map: process-lifetime.
// Resets to 0 on MCP restart. Good enough — the goal is "on 429, try a
// different key," not "track which key is best."
const KEY_CURSOR = new Map();

function pickApiKey(providerCfg, provider) {
  const keys = providerCfg?.keys;
  if (!Array.isArray(keys) || keys.length === 0) return providerCfg?.apiKey || null;
  const idx = (KEY_CURSOR.get(provider) || 0) % keys.length;
  return keys[idx];
}

function rotateKey(providerCfg, provider) {
  const keys = providerCfg?.keys;
  if (!Array.isArray(keys) || keys.length < 2) return false;
  const cur = KEY_CURSOR.get(provider) || 0;
  KEY_CURSOR.set(provider, (cur + 1) % keys.length);
  return true;
}

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
    provider,
    messages,
    temperature = 0.2,
    max_tokens = 1024,
    response_format,
    timeout_ms = 30000,
    accept_from,
    tools,
    tool_choice,
  } = input || {};

  if (!model) throw new Error("llm.openai_compat requires 'model'");
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("llm.openai_compat requires non-empty 'messages' array");
  }

  const cfg = ctx.config?.llm || {};
  const providers = cfg.providers || {};

  let providerCfg = null;
  let baseUrl;
  let initialKey;

  if (provider) {
    providerCfg = providers[provider];
    if (!providerCfg) {
      throw new Error(`llm.openai_compat: unknown provider "${provider}" — add it to config.llm.providers`);
    }
    if (!providerCfg.apiKey && (!Array.isArray(providerCfg.keys) || providerCfg.keys.length === 0)) {
      throw new Error(`llm.openai_compat: provider "${provider}" has no apiKey configured`);
    }
    baseUrl = providerCfg.baseUrl;
    initialKey = pickApiKey(providerCfg, provider);
  } else {
    baseUrl = cfg.baseUrl || "https://antigravity-seven-delta.vercel.app/v1";
    initialKey = cfg.apiKey || "antigravity-free";
  }

  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body = { model, messages, temperature, max_tokens };
  if (response_format) body.response_format = response_format;
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools;
    if (tool_choice) body.tool_choice = tool_choice;
  }

  const started = Date.now();
  const maxAttempts = providerCfg && Array.isArray(providerCfg.keys)
    ? Math.max(1, providerCfg.keys.length)
    : 1;
  let lastErr = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let apiKey = attempt === 0 ? initialKey : pickApiKey(providerCfg, provider);
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
      const cause = e.cause;
      const detail = [
        e.message,
        cause?.code ? `code=${cause.code}` : null,
        cause?.message ? `cause=${cause.message}` : null,
      ].filter(Boolean).join(" | ");
      const err = new Error(`llm: fetch failed: ${detail}`);
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
      lastErr = new Error("llm: rate limited by provider");
      lastErr.retryable = true;
      lastErr.retry_after_ms = retryAfter ? Number(retryAfter) * 1000 : 30000;

      if (providerCfg && rotateKey(providerCfg, provider) && attempt + 1 < maxAttempts) {
        ctx.events?.emit?.("llm.key_rotated", {
          provider,
          model,
          attempt: attempt + 1,
          max_attempts: maxAttempts,
          retry_after_ms: lastErr.retry_after_ms,
        });
        continue;
      }
      throw lastErr;
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
    const tool_calls = Array.isArray(choice.message?.tool_calls) ? choice.message.tool_calls : [];
    const usage = data?.usage || {};
    const returnedModelId = data?.model || model;

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
        tool_calls,
        usage: {
          prompt_tokens: usage.prompt_tokens ?? null,
          completion_tokens: usage.completion_tokens ?? null,
          total_tokens: usage.total_tokens ?? null,
        },
      },
      cost: {
        time_ms: Date.now() - started,
        http_calls: attempt + 1,
        tokens: usage.total_tokens ?? null,
        money_usd: 0,
      },
    };
  }

  throw lastErr || new Error("llm: exhausted key rotation without response");
}
