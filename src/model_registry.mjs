// agentry/src/model_registry.mjs
// The live model registry.
//
// Refreshes from the provider's /v1/models on boot and on demand.
// Exposes predicates and selectors. NOT a static allowlist — the whole
// point is that the provider is dynamic, and this mirrors its current
// state instead of freezing it.
//
// "Free" classification:
//   - limit_type "per_week"          → free-tier unlimited (unorouter, atria, ...)
//   - limit_type "fixed_token_quota" → free but bounded
//   - limit_type "per_minute"        → Google's free tier (RPM-limited)
//   - anything else                  → NOT allowed by default
//
// A model is acceptable if it's in the current snapshot AND its limit_type
// is in the accepted set.

const ACCEPTED_LIMIT_TYPES = new Set(["per_week", "fixed_token_quota", "per_minute"]);

export class ModelRegistry {
  constructor({ baseUrl, apiKey, timeoutMs = 15000 }) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.models = new Map();      // id → { id, provider, limit_type, rpm, tpm, rpd }
    this.fetchedAt = null;
    this.fetchError = null;
  }

  async refresh() {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/models`;
    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        this.fetchError = `HTTP ${res.status}`;
        return { ok: false, error: this.fetchError };
      }
      const data = await res.json();
      const list = Array.isArray(data.data) ? data.data : [];
      this.models.clear();
      for (const m of list) {
        if (!m?.id) continue;
        this.models.set(m.id, {
          id: m.id,
          provider: m.provider || "unknown",
          limit_type: m.limit_type || null,
          rpm: m.rpm ?? null,
          tpm: m.tpm ?? null,
          rpd: m.rpd ?? null,
        });
      }
      this.fetchedAt = Date.now();
      this.fetchError = null;
      return { ok: true, count: this.models.size };
    } catch (e) {
      this.fetchError = e.message;
      return { ok: false, error: e.message };
    }
  }

  /** Is this exact model id present and free-classified? */
  accepts(modelId) {
    const m = this.models.get(modelId);
    if (!m) return false;
    if (!m.limit_type) return false;
    return ACCEPTED_LIMIT_TYPES.has(m.limit_type);
  }

  /** Filter helper: all models matching a predicate. */
  candidates(predicate = () => true) {
    const out = [];
    for (const m of this.models.values()) {
      if (!m.limit_type) continue;
      if (!ACCEPTED_LIMIT_TYPES.has(m.limit_type)) continue;
      if (predicate(m)) out.push(m);
    }
    return out;
  }

  fromProvider(provider) {
    return this.candidates(m => m.provider === provider);
  }

  pick(predicate) {
    for (const m of this.models.values()) {
      if (!m.limit_type) continue;
      if (!ACCEPTED_LIMIT_TYPES.has(m.limit_type)) continue;
      if (predicate(m)) return m;
    }
    return null;
  }

  snapshot() {
    return {
      fetched_at: this.fetchedAt,
      count: this.models.size,
      error: this.fetchError,
      by_provider: this.candidates().reduce((acc, m) => {
        acc[m.provider] = (acc[m.provider] || 0) + 1;
        return acc;
      }, {}),
    };
  }
}
