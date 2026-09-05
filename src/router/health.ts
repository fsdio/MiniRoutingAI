// src/router/health.ts — per-provider/model health + cooldown Phase 3

export interface HealthEntry {
  failures: number;
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
    this.failureThreshold = opts?.failureThreshold ?? 1;
    this.now = opts?.now ?? (() => Date.now());
  }

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
  }

  markFailure(provider: string, model: string, errorClass: string, opts?: { isUnavailable?: boolean }): void {
    const k = this.key(provider, model);
    const entry = this.store.get(k) ?? { failures: 0, cooldownUntil: 0, lastErrorAt: 0 };
    entry.failures += 1;
    entry.lastErrorAt = this.now();
    entry.lastErrorClass = errorClass;

    if (errorClass === "credential") {
      entry.cooldownUntil = this.now() + this.cooldownMs;
    } else if (errorClass === "transient" || errorClass === "unknown") {
      // Untuk "Model is unavailable"/capacity/overloaded → langsung cooldown tanpa tunggu threshold, agar retry OpenCode attempt #3 tidak menghantam model sama.
      const immediate = opts?.isUnavailable || this.failureThreshold <= 1;
      if (immediate || entry.failures >= this.failureThreshold) {
        entry.cooldownUntil = this.now() + this.cooldownMs;
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
