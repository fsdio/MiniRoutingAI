// src/router/policy.ts — error classification + retry/fallback policy Phase 3
import type { RouteTarget, ProviderConfig } from "../types/index.ts";
import { HealthStore } from "./health.ts";

export type ErrorClass = "deterministic" | "transient" | "credential" | "unknown" | "rate_limit" | "timeout" | "server_error" | "context_overflow";

// Cooldown per class (ms) — bedakan 429/5xx/timeout/connection, jangan flat.
export const CLASS_COOLDOWN_MS: Record<string, number> = {
  rate_limit: 20_000,
  server_error: 30_000,
  timeout: 8_000,
  transient: 15_000,
  credential: 30_000,
  context_overflow: 15_000, // sebelumnya 60s memblokir request kecil berikutnya; 15s cukup untuk fail-fast tanpa lockout panjang
  deterministic: 0,
  unknown: 15_000,
};

export function classifyError(status?: number, body?: unknown, message?: string): ErrorClass {
  const msg = (message ?? "").toLowerCase();
  const bodyStr = body ? JSON.stringify(body).toLowerCase() : "";

  const combined = `${msg} ${bodyStr}`;

  // Credential first (more specific)
  if (status === 401) return "credential";
  if (combined.includes("invalid api key") || combined.includes("invalid_api_key") || combined.includes("expired authentication") || combined.includes("unauthorized") || combined.includes("authentication")) {
    // But avoid misclassifying 400 invalid request as credential
    if (status !== 400) return "credential";
  }

  // Context overflow — payload melebihi context window model (biasanya 400, kadang 413/500).
  // Cek sebelum transient agar tidak dianggap "retryable" buta; butuh model context lebih besar atau kompresi.
  // Termasuk 413 (Payload Too Large) dari router local guard dan "prompt too large" dari error message.
  if (status === 413 || combined.includes("context length") || combined.includes("maximum context") || combined.includes("context_length_exceeded") || combined.includes("too many tokens") || combined.includes("input length exceeds") || combined.includes("prompt is too long") || combined.includes("prompt too large") || combined.includes("context_overflow") || combined.includes("max_tokens") && combined.includes("exceed")) {
    return "context_overflow";
  }

  // Rate limit — 429 TANPA sinyal availability (429 + "Model is unavailable" = transient capacity, bukan kuota)
  // Juga deteksi "weekly usage limit" / "usage limit" dari Ollama (429 weekly quota) — harus rate_limit dengan cooldown panjang
  // Dan kuota akun/provider habis: "insufficient balance"/"insufficient_user_quota" (biasanya dibungkus 400/503 oleh distributor) —
  // bukan server error; retry membabi-buta tidak akan membantu sampai saldo/top-up.
  const hasUnavailableSignal = combined.includes("unavailable") || combined.includes("service_unavailable") || combined.includes("temporarily overloaded") || combined.includes("capacity") || combined.includes("overloaded") || combined.includes("server busy") || combined.includes("high demand") || combined.includes("no available channel");
  const isQuotaError = combined.includes("insufficient balance") || combined.includes("credit insufficient") || combined.includes("insufficient_user_quota") || combined.includes("insufficient quota") || combined.includes("no credit") || combined.includes("out of credits") || combined.includes("prompt tokens limit exceeded") || combined.includes("openrouter.ai/settings/credits");
  if ((status === 429 || combined.includes("rate limit") || combined.includes("too many requests") || combined.includes("quota exceeded") || combined.includes("weekly usage limit") || combined.includes("usage limit") || isQuotaError) && !hasUnavailableSignal) {
    return "rate_limit";
  }

  // Transient — capacity / availability (must be before deterministic 400, karena upstream sering kirim 400 dengan body "Model is unavailable")
  // Frase "unavailable" mencakup: "Model is unavailable", "model unavailable", "resource unavailable", "service unavailable", "temporarily unavailable"
  // Juga handle Console Go missing session: https://opencode.ai/docs/go/#where-can-i-use-it
  // dan free tier restriction: "OpenCode's free tier can only be used in OpenCode"
  // Tambahan: "No available channel" dari juan/distributor adalah kapasitas transient, bukan deterministic
  if (
    combined.includes("unavailable") ||
    combined.includes("service_unavailable") ||
    combined.includes("service temporarily overloaded") ||
    combined.includes("temporarily overloaded") ||
    combined.includes("capacity") ||
    combined.includes("overloaded") ||
    combined.includes("server busy") ||
    combined.includes("high demand") ||
    combined.includes("try again") ||
    combined.includes("upstream request failed") ||
    combined.includes("x-opencode-session") ||
    combined.includes("missing x-opencode") ||
    combined.includes("cannot be routed efficiently") ||
    combined.includes("free tier") ||
    combined.includes("can only be used in opencode") ||
    combined.includes("no available channel") ||
    combined.includes("no available") && combined.includes("channel")
  ) {
    return "transient";
  }

  // Deterministic — only after checking transient availability above
  // Jangan klasifikasikan 400 sebagai deterministic jika body mengandung unavailable (sudah handled di atas)
  if (combined.includes("invalid request") || combined.includes("invalid tool") || combined.includes("model not found") || combined.includes("unsupported capability") || combined.includes("model_not_found")) {
    return "deterministic";
  }
  if (status === 400) return "deterministic";
  if (status === 404 && combined.includes("model")) return "deterministic";

  // Timeout sebelum 5xx (timeout bisa datang sebagai 408 atau network error)
  if (status === 408 || combined.includes("timeout") || combined.includes("timed out")) return "timeout";

  // Status-based
  if (status === 502 || status === 503 || status === 504 || status === 500) return "server_error";
  if (status !== undefined && status >= 500) return "server_error";
  if (combined.includes("connection reset")) return "timeout";

  // Unknown: no status (network error) treat as transient for fallback, but spec says unknown separate
  if (status === undefined) {
    if (combined.includes("fetch failed") || combined.includes("connection")) return "timeout";
    return "unknown";
  }

  return "unknown";
}

export function shouldRetry(errorClass: ErrorClass): boolean {
  if (errorClass === "context_overflow" || errorClass === "credential" || errorClass === "deterministic") return false;
  return errorClass === "transient" || errorClass === "rate_limit" || errorClass === "timeout" || errorClass === "server_error" || errorClass === "unknown";
}

export function shouldFallback(errorClass: ErrorClass): boolean {
  return shouldRetry(errorClass);
}

export function isDeterministic(errorClass: ErrorClass): boolean {
  return errorClass === "deterministic";
}

export function isCredential(errorClass: ErrorClass): boolean {
  return errorClass === "credential";
}

export interface CandidateScore {
  target: RouteTarget;
  score: number;
  healthScore: number;
  latencyScore: number;
}

/** @deprecated Flat sequential refactor — scoring/health ordering dihapus; semua kandidat di-hit berurutan tanpa guard pre-skip */
export function computeCandidateScores(
  candidates: RouteTarget[],
  healthStore: HealthStore,
  providers: ProviderConfig[],
  _requestTags?: string[],
): CandidateScore[] {
  return candidates.map((target) => {
    const providerCfg = providers.find((p) => p.id === target.provider);
    const health = healthStore.getHealth(target.provider, target.model);

    // Health score: 0 (cooldown) to 1 (healthy)
    const healthScore = health?.healthy ? 1 : 0;

    // Success rate (Wave 1): historikal per provider:model, netral 1.0 jika belum ada data
    const successRate = healthStore.getSuccessRate?.(target.provider, target.model) ?? 1;

    // Latency score: inverse of avg latency (normalized)
    const avgLatency = providerCfg?.avgLatencyMs ?? 2000;
    const latencyScore = 1 / (avgLatency / 1000); // normalize to seconds

    // Weight from route config (default 1)
    const weight = target.weight ?? providerCfg?.defaultWeight ?? 1;

    // Combined score: health * success * latency * weight (tags sudah dihapus)
    const score = healthScore * successRate * latencyScore * weight;

    return { target, score, healthScore, latencyScore };
  });
}

/** @deprecated Flat sequential refactor — health-aware ordering dihapus; flat list tanpa guard pre-skip */
export function sortCandidatesByHealth(
  candidates: RouteTarget[],
  healthStore: HealthStore,
  providers: ProviderConfig[],
  requestTags?: string[],
  minHealthy?: number,
): RouteTarget[] {
  const scored = computeCandidateScores(candidates, healthStore, providers, requestTags);
  
  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);
  
  // Filter: ensure minimum healthy candidates if configured
  if (minHealthy !== undefined && minHealthy > 0) {
    const healthyCount = scored.filter((s) => s.healthScore > 0).length;
    if (healthyCount < minHealthy) {
      // Include some unhealthy if not enough healthy
      console.warn(`[policy] Only ${healthyCount} healthy candidates, minHealthy=${minHealthy}. Including cooldown models.`);
    }
  }
  
  return scored.map((s) => s.target);
}

/** @deprecated Flat sequential refactor — weighted random dihapus; sequential flat list tanpa guard pre-skip */
export function selectWeightedRandom(
  candidates: RouteTarget[],
  healthStore: HealthStore,
  providers: ProviderConfig[],
  requestTags?: string[],
): RouteTarget | null {
  const healthy = candidates.filter((c) => healthStore.isHealthy(c.provider, c.model));
  if (healthy.length === 0) return null;
  
  const scored = computeCandidateScores(healthy, healthStore, providers, requestTags);
  const totalWeight = scored.reduce((sum, s) => sum + s.score, 0);
  if (totalWeight <= 0) return healthy[0];
  
  let random = Math.random() * totalWeight;
  for (const { target, score } of scored) {
    random -= score;
    if (random <= 0) return target;
  }
  return scored[scored.length - 1].target;
}
