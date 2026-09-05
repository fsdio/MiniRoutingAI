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
