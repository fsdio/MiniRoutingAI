// src/router/policy.ts — error classification + retry/fallback policy Phase 3
import type { RouteTarget, ProviderConfig } from "../types/index.ts";
import { HealthStore } from "./health.ts";

export type ErrorClass = "deterministic" | "transient" | "credential" | "unknown";

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

  // Transient — capacity / availability (must be before deterministic 400, karena upstream sering kirim 400 dengan body "Model is unavailable")
  // Frase "unavailable" mencakup: "Model is unavailable", "model unavailable", "resource unavailable", "service unavailable", "temporarily unavailable"
  if (
    combined.includes("unavailable") ||
    combined.includes("capacity") ||
    combined.includes("overloaded") ||
    combined.includes("rate limit") ||
    combined.includes("too many requests") ||
    combined.includes("server busy") ||
    combined.includes("high demand") ||
    combined.includes("try again") ||
    combined.includes("upstream request failed")
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

  // Transient — status codes
  if (status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return "transient";
  if (combined.includes("timeout") || combined.includes("timed out") || combined.includes("connection reset")) {
    return "transient";
  }
  if (status !== undefined && status >= 500) return "transient";

  // Unknown: no status (network error) treat as transient for fallback, but spec says unknown separate
  if (status === undefined) {
    if (combined.includes("fetch failed") || combined.includes("connection")) return "transient";
    return "unknown";
  }

  return "unknown";
}

export function shouldRetry(errorClass: ErrorClass): boolean {
  return errorClass === "transient" || errorClass === "unknown";
}

export function shouldFallback(errorClass: ErrorClass): boolean {
  return errorClass === "transient" || errorClass === "unknown";
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
    
    // Combined score: health * latency * weight + tag bonus
    const score = healthScore * latencyScore * weight + tagBonus;
    
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
