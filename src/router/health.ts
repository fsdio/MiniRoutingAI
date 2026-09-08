// src/router/health.ts — per-provider/model health + cooldown Phase 3 (+ Wave 1: cooldown per class, success rate)

import { CLASS_COOLDOWN_MS } from "./policy.ts";

export interface HealthEntry {
  failures: number;
  successes: number;
  cooldownUntil: number; // epoch ms, 0 = healthy
  lastErrorAt: number;
  lastErrorClass?: string;
}

export class HealthStore {
  private store = new Map<string, HealthEntry>();
  private cooldownMs: number;
  private failureThreshold: number;
  private now: () => number;

  constructor(opts?: { cooldownMs?: number; failureThreshold?: number; now?: () => number }) {
    // Threshold 1 → transient/unavailable langsung cooldown di attempt pertama, mencegah looping "Model is unavailable" menghantam model yang sama berulang kali (retry attempt #2/#3 dari OpenCode).
    this.cooldownMs = opts?.cooldownMs ?? 30_000;
    // Jika cooldownMs eksplisit di-set, ia menimpa cooldown per-class (dipakai test & custom store)
    this.cooldownMsExplicit = opts?.cooldownMs !== undefined;
    this.failureThreshold = opts?.failureThreshold ?? 1;
    this.now = opts?.now ?? (() => Date.now());
  }

  private cooldownMsExplicit: boolean;

  private key(provider: string, model: string): string {
    return `${provider}:${model}`;
  }

  isHealthy(provider: string, model: string): boolean {
    const entry = this.store.get(this.key(provider, model));
    if (!entry) return true;
    if (entry.cooldownUntil === 0) return true;
    if (this.now() >= entry.cooldownUntil) {
      // cooldown expired — reset to healthy but keep entry for observation
      entry.cooldownUntil = 0;
      entry.failures = 0;
      return true;
    }
    return false;
  }

  markSuccess(provider: string, model: string): void {
    const k = this.key(provider, model);
    this.store.delete(k);
    // Track success untuk success-rate ordering (Wave 1)
    const entry = this.successes.get(k) ?? 0;
    this.successes.set(k, entry + 1);
  }

  private successes = new Map<string, number>();

  getSuccessRate(provider: string, model: string): number {
    const succ = this.successes.get(this.key(provider, model)) ?? 0;
    const entry = this.store.get(this.key(provider, model));
    const fails = entry?.failures ?? 0;
    const total = succ + fails;
    if (total === 0) return 1; // unknown = netral
    return succ / total;
  }

  markFailure(provider: string, model: string, errorClass: string, opts?: { isUnavailable?: boolean; retryAfterMs?: number }): void {
    const k = this.key(provider, model);
    const entry = this.store.get(k) ?? { failures: 0, successes: 0, cooldownUntil: 0, lastErrorAt: 0 };
    entry.failures += 1;
    entry.lastErrorAt = this.now();
    entry.lastErrorClass = errorClass;

    // Cooldown per class (Wave 1): 429 ≠ timeout ≠ 5xx. Retry-After dari upstream menang.
    // Instance cooldownMs eksplisit menimpa class default (kompatibilitas test/custom store).
    let classCooldown = !this.cooldownMsExplicit && (CLASS_COOLDOWN_MS[errorClass] !== undefined)
      ? CLASS_COOLDOWN_MS[errorClass]
      : this.cooldownMs;
    if (opts?.retryAfterMs && opts.retryAfterMs > 0 && errorClass === "rate_limit") {
      // Weekly quota (Ollama weekly limit) butuh cooldown panjang — cap 1 jam bukan 120s
      const cap = opts.retryAfterMs > 120_000 ? 3_600_000 : 120_000;
      classCooldown = Math.max(classCooldown, Math.min(opts.retryAfterMs, cap));
    }

    if (errorClass === "credential") {
      entry.cooldownUntil = this.now() + classCooldown;
    } else if (errorClass === "context_overflow") {
      // Model ini tidak sanggup payload serupa — cooldown panjang
      entry.cooldownUntil = this.now() + classCooldown;
    } else if (errorClass === "transient" || errorClass === "rate_limit" || errorClass === "timeout" || errorClass === "server_error" || errorClass === "unknown") {
      // Untuk "Model is unavailable"/capacity/overloaded → langsung cooldown tanpa tunggu threshold, agar retry OpenCode attempt #3 tidak menghantam model sama.
      const immediate = opts?.isUnavailable || this.failureThreshold <= 1;
      if (immediate || entry.failures >= this.failureThreshold) {
        entry.cooldownUntil = this.now() + classCooldown;
      }
    } else if (errorClass === "deterministic") {
      // No cooldown for deterministic — request error, not provider health
      entry.failures = Math.max(0, entry.failures - 1); // don't count deterministic toward threshold
    }

    this.store.set(k, entry);
  }

  getCooldownUntil(provider: string, model: string): number {
    return this.store.get(this.key(provider, model))?.cooldownUntil ?? 0;
  }

  getHealth(provider: string, model: string): { healthy: boolean; cooldownUntil: number; failures: number; lastErrorClass?: string } | null {
    const entry = this.store.get(this.key(provider, model));
    if (!entry) return { healthy: true, cooldownUntil: 0, failures: 0 };
    const healthy = this.isHealthy(provider, model);
    return { healthy, cooldownUntil: entry.cooldownUntil, failures: entry.failures, lastErrorClass: entry.lastErrorClass };
  }

  getCooldownRemainingMs(provider: string, model: string): number {
    const until = this.getCooldownUntil(provider, model);
    if (!until) return 0;
    return Math.max(0, until - this.now());
  }

  getState(): Record<string, HealthEntry> {
    const out: Record<string, HealthEntry> = {};
    for (const [k, v] of this.store.entries()) out[k] = { ...v };
    return out;
  }

  getCooldownSummary(): { total: number; inCooldown: number; details: Array<{ key: string; remainingMs: number; errorClass?: string }> } {
    const details: Array<{ key: string; remainingMs: number; errorClass?: string }> = [];
    let inCooldown = 0;
    for (const [k, v] of this.store.entries()) {
      if (v.cooldownUntil > this.now()) {
        inCooldown++;
        details.push({ key: k, remainingMs: v.cooldownUntil - this.now(), errorClass: v.lastErrorClass });
      }
    }
    return { total: this.store.size, inCooldown, details };
  }

  clear(): void {
    this.store.clear();
  }

  // For testing: allow manual injection of now
  setNowFn(fn: () => number) {
    this.now = fn;
  }
}

// Singleton for server use (can be replaced in tests with custom store)
export const globalHealthStore = new HealthStore();
