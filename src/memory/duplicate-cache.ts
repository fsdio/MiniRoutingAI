// src/memory/duplicate-cache.ts — Duplicate Read-Only Tool Cache (Phase 10), TTL 2-5s, no filesystem watcher

export type ToolType = "read-only" | "mutating" | "unknown";

const READ_ONLY_TOOLS = new Set([
  "git_status", "git status",
  "git_log", "git log",
  "git_diff", "git diff",
  "ls", "tree", "find", "grep", "rg",
  "read", "read_file", "glob", "search",
]);

const MUTATING_TOOLS = new Set([
  "git_commit", "git commit",
  "git_push", "git push",
  "rm", "mv", "cp", "write", "edit", "deploy",
]);

export function classifyTool(toolName: string, args?: any): ToolType {
  const normalized = toolName.toLowerCase().replace(/[-_]/g, "_");
  if (MUTATING_TOOLS.has(toolName.toLowerCase()) || MUTATING_TOOLS.has(normalized)) return "mutating";
  if (READ_ONLY_TOOLS.has(toolName.toLowerCase()) || READ_ONLY_TOOLS.has(normalized)) return "read-only";
  // Heuristic: if args contain file writes, treat as mutating
  const argsStr = args ? JSON.stringify(args).toLowerCase() : "";
  if (argsStr.includes("write") || argsStr.includes("commit") || argsStr.includes("push")) return "mutating";
  // Default: unknown → treat as mutating (safe)
  return "unknown";
}

export interface CacheEntry {
  key: string;
  value: string; // tool result content
  expiresAt: number;
  toolName: string;
}

export class DuplicateCache {
  private store = new Map<string, CacheEntry>();
  private ttlMs: number;

  constructor(opts?: { ttlMs?: number }) {
    this.ttlMs = opts?.ttlMs ?? 3000; // default 3s
  }

  private makeKey(toolName: string, args: any): string {
    // Deterministic key: toolName + stable JSON of args
    try {
      const argsStr = args ? JSON.stringify(args, Object.keys(args).sort()) : "";
      return `${toolName}:${argsStr}`;
    } catch { return `${toolName}:${String(args)}`; }
  }

  get(toolName: string, args: any): string | null {
    if (classifyTool(toolName, args) !== "read-only") return null; // never cache mutating/unknown
    const key = this.makeKey(toolName, args);
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  set(toolName: string, args: any, value: string, ttlMs?: number): void {
    if (classifyTool(toolName, args) !== "read-only") return; // never cache mutating
    // Do not cache errors or empty
    if (!value || value.includes("error") || value.trim() === "") return;
    // Do not cache huge (>100KB) to avoid memory
    if (Buffer.byteLength(value, "utf-8") > 100 * 1024) return;
    const key = this.makeKey(toolName, args);
    this.store.set(key, {
      key,
      value,
      expiresAt: Date.now() + (ttlMs ?? this.ttlMs),
      toolName,
    });
  }

  has(toolName: string, args: any): boolean {
    return this.get(toolName, args) !== null;
  }

  clear() { this.store.clear(); }
  size() { this.cleanup(); return this.store.size; }

  setTtl(ttlMs: number) { this.ttlMs = ttlMs; }

  private cleanup() {
    const now = Date.now();
    for (const [k, v] of this.store.entries()) if (now > v.expiresAt) this.store.delete(k);
  }
}

export const globalDuplicateCache = new DuplicateCache({ ttlMs: 3000 });

// Wave 3: RTK memoisasi — hash konten tool output asli → hasil terkompresi.
// Menghilangkan re-work RTK per request (empiris: rtkSavedBytes konstan 15906 = pekerjaan ulang tiap request).
// TTL 10 menit, LRU maks 300 entri, hanya konten > 4KB yang layak dimemo.
class RtkMemoCache {
  private store = new Map<string, { value: string; expiresAt: number }>();
  private ttlMs = 600_000;
  private maxEntries = 300;
  private minBytes = 4096;

  static hash(s: string): string {
    // FNV-1a 64-bit-ish (cukup untuk memo, bukan kripto)
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < s.length; i++) {
      h1 ^= s.charCodeAt(i);
      h1 = Math.imul(h1, 16777619) >>> 0;
      h2 = (Math.imul(h2 ^ s.charCodeAt(i), 2246822519) >>> 0) + i;
    }
    return `${h1.toString(36)}${(h2 >>> 0).toString(36)}`;
  }

  get(original: string): string | null {
    if (Buffer.byteLength(original, "utf-8") < this.minBytes) return null;
    const k = RtkMemoCache.hash(original);
    const e = this.store.get(k);
    if (!e) return null;
    if (Date.now() > e.expiresAt) { this.store.delete(k); return null; }
    return e.value;
  }

  set(original: string, compressed: string): void {
    if (Buffer.byteLength(original, "utf-8") < this.minBytes) return;
    if (compressed === original) return;
    const k = RtkMemoCache.hash(original);
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(k, { value: compressed, expiresAt: Date.now() + this.ttlMs });
  }

  clear() { this.store.clear(); }
  size() { return this.store.size; }
}

export const globalRtkMemo = new RtkMemoCache();
