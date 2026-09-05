// src/memory/error-memory.ts — Ephemeral in-memory Error Memory (Phase 9), no DB

import { fingerprint, type FingerprintInput } from "./fingerprint.ts";

export interface ErrorMemoryEntry {
  fingerprint: string;
  category: string;
  provider: string;
  model: string;
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
  cooldownUntil: number;
  ttl: number;
}

export class ErrorMemory {
  private store = new Map<string, ErrorMemoryEntry>();
  private ttlMs: number;
  private cooldownMs: number;

  constructor(opts?: { ttlMs?: number; cooldownMs?: number }) {
    this.ttlMs = opts?.ttlMs ?? 5 * 60 * 1000; // 5 min default
    this.cooldownMs = opts?.cooldownMs ?? 30_000;
  }

  remember(input: FingerprintInput, ttlMs?: number, cooldownMs?: number): ErrorMemoryEntry {
    const fp = fingerprint(input);
    const now = Date.now();
    const existing = this.store.get(fp);
    if (existing) {
      existing.count += 1;
      existing.lastSeenAt = now;
      // Extend cooldown for transient/credential
      if (input.errorCategory === "transient" || input.errorCategory === "credential") {
        existing.cooldownUntil = now + (cooldownMs ?? this.cooldownMs);
      }
      // Update TTL
      existing.ttl = now + (ttlMs ?? this.ttlMs);
      return existing;
    }
    const entry: ErrorMemoryEntry = {
      fingerprint: fp,
      category: input.errorCategory,
      provider: input.provider,
      model: input.model,
      firstSeenAt: now,
      lastSeenAt: now,
      count: 1,
      cooldownUntil: input.errorCategory === "deterministic" ? 0 : now + (cooldownMs ?? this.cooldownMs),
      ttl: now + (ttlMs ?? this.ttlMs),
    };
    // For deterministic, we don't cooldown provider but remember fingerprint to avoid retry same request
    if (input.errorCategory === "deterministic") {
      entry.cooldownUntil = 0; // deterministic doesn't cooldown provider, but we remember to not retry same fingerprint quickly
      // For demo, set short cooldown 5s for deterministic fingerprint dedup
      entry.cooldownUntil = now + 5000;
    }
    this.store.set(fp, entry);
    this.cleanup();
    return entry;
  }

  has(fingerprint: string): boolean {
    const entry = this.store.get(fingerprint);
    if (!entry) return false;
    if (Date.now() > entry.ttl) {
      this.store.delete(fingerprint);
      return false;
    }
    return true;
  }

  isCooldown(fingerprint: string): boolean {
    const entry = this.store.get(fingerprint);
    if (!entry) return false;
    if (Date.now() > entry.cooldownUntil) return false;
    return true;
  }

  get(fingerprint: string): ErrorMemoryEntry | undefined {
    const entry = this.store.get(fingerprint);
    if (!entry) return undefined;
    if (Date.now() > entry.ttl) {
      this.store.delete(fingerprint);
      return undefined;
    }
    return entry;
  }

  shouldSkip(input: FingerprintInput): boolean {
    const fp = fingerprint(input);
    return this.isCooldown(fp);
  }

  clear() { this.store.clear(); }

  size() { this.cleanup(); return this.store.size; }

  private cleanup() {
    const now = Date.now();
    for (const [k, v] of this.store.entries()) {
      if (now > v.ttl) this.store.delete(k);
    }
  }

  getAll(): ErrorMemoryEntry[] { this.cleanup(); return Array.from(this.store.values()); }
}

export const globalErrorMemory = new ErrorMemory();

// Helper to build fingerprint input from error
export function buildFingerprintInput(provider: string, model: string, errorCategory: string, errorMessage: string, toolName?: string): FingerprintInput {
  // Normalize error signature: lower case, trim, remove numbers? Keep simple
  const sig = errorMessage.toLowerCase().replace(/\d+/g, "#").slice(0, 200);
  return {
    provider,
    model,
    operation: "chat",
    toolName,
    errorCategory,
    errorSignature: sig,
    requestCharacteristics: toolName ? `tool:${toolName}` : "",
  };
}
