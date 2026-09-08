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
  context_overflow: 60_000, // model tsb tidak akan sanggup untuk payload serupa
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
  if (combined.includes("context length") || combined.includes("maximum context") || combined.includes("context_length_exceeded") || combined.includes("too many tokens") || combined.includes("input length exceeds") || combined.includes("prompt is too long") || combined.includes("max_tokens") && combined.includes("exceed")) {
    return "context_overflow";
  }

  // Rate limit — 429 TANPA sinyal availability (429 + "Model is unavailable" = transient capacity, bukan kuota)
  // Juga deteksi "weekly usage limit" / "usage limit" dari Ollama (429 weekly quota) — harus rate_limit dengan cooldown panjang
  const hasUnavailableSignal = combined.includes("unavailable") || combined.includes("capacity") || combined.includes("overloaded") || combined.includes("server busy") || combined.includes("high demand");
  if ((status === 429 || combined.includes("rate limit") || combined.includes("too many requests") || combined.includes("quota exceeded") || combined.includes("weekly usage limit") || combined.includes("usage limit")) && !hasUnavailableSignal) {
    return "rate_limit";
  }

  // Transient — capacity / availability (must be before deterministic 400, karena upstream sering kirim 400 dengan body "Model is unavailable")
  // Frase "unavailable" mencakup: "Model is unavailable", "model unavailable", "resource unavailable", "service unavailable", "temporarily unavailable"
  // Juga handle Console Go missing session: https://opencode.ai/docs/go/#where-can-i-use-it
  // dan free tier restriction: "OpenCode's free tier can only be used in OpenCode"
  if (
    combined.includes("unavailable") ||
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
    combined.includes("can only be used in opencode")
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

export function computeCandidateScores(
  candidates: RouteTarget[],
  healthStore: HealthStore,
  providers: ProviderConfig[],
  requestTags?: string[],
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

    // Tag match bonus
    let tagBonus = 0;
    if (requestTags && target.tags) {
      const matches = requestTags.filter((t) => target.tags!.includes(t)).length;
      tagBonus = matches * 0.1;
    }

    // Weight from route config (default 1)
    const weight = target.weight ?? providerCfg?.defaultWeight ?? 1;

    // Combined score: health * success * latency * weight + tag bonus
    const score = healthScore * successRate * latencyScore * weight + tagBonus;

    return { target, score, healthScore, latencyScore };
  });
}

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
