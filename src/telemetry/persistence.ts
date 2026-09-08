// src/telemetry/persistence.ts — persist usage & request log ke disk (JSONL), dengan rotasi.
import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface OpenCodeAuditLogEntry {
  timestamp: string;
  ts: number;
  provider: string;
  model: string;
  url: string;
  stream: boolean;
  status: number;
  latencyMs: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestSummary: {
    messageCount: number;
    maxTokens?: number;
    temperature?: number;
  };
  responseBodySnippet?: string;
  usage?: any;
  error?: any;
}

export interface RequestLogEntry {
  requestId: string;
  ts: number;
  route?: string;
  provider?: string;
  model?: string;
  status: number;
  stream?: boolean;
  totalLatencyMs?: number | null;
  ttftMs?: number | null;
  inputTokens?: number | string | null;
  outputTokens?: number | string | null;
  cachedInputTokens?: number | string | null;
  rtkSavedBytes?: number;
  headroomSavedBytes?: number;
  errorClass?: string;
  [key: string]: unknown;
}

const MAX_BYTES = 5 * 1024 * 1024;

export function usageDir(): string {
  return process.env.DATA_DIR ?? join(process.cwd(), "data");
}

export function usageFilePath(): string {
  return join(usageDir(), "usage.jsonl");
}

async function ensureDir(): Promise<void> {
  const dir = usageDir();
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}

export async function recordRequestLog(entry: RequestLogEntry): Promise<void> {
  try {
    await ensureDir();
    const path = usageFilePath();
    const st = await stat(path).catch(() => null);
    if (st && st.size > MAX_BYTES) {
      await rename(path, `${path}.1`).catch(() => {});
    }
    await appendFile(path, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // Kegagalan persist tidak boleh menggagalkan request.
  }
}

export interface OpenCodeAuditLogEntry {
  timestamp: string;
  ts: number;
  provider: string;
  model: string;
  url: string;
  stream: boolean;
  status: number;
  latencyMs: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestSummary: {
    messageCount: number;
    maxTokens?: number;
    temperature?: number;
  };
  responseBodySnippet?: string;
  usage?: any;
  error?: any;
}

export async function recordOpenCodeAuditLog(entry: OpenCodeAuditLogEntry): Promise<void> {
  try {
    const logsDir = join(process.cwd(), "logs");
    if (!existsSync(logsDir)) await mkdir(logsDir, { recursive: true });
    const auditFile = join(logsDir, "opencode-audit.jsonl");
    await appendFile(auditFile, JSON.stringify(entry) + "\n", "utf-8");
  } catch {}
}

export async function readUsageEntries(): Promise<RequestLogEntry[]> {
  try {
    const text = await readFile(usageFilePath(), "utf-8").catch(() => "");
    const entries: RequestLogEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {}
    }
    return entries;
  } catch {
    return [];
  }
}

export async function readUsageSummary(): Promise<ReturnType<typeof buildSummary>> {
  return buildSummary(await readUsageEntries());
}

function buildSummary(entries: RequestLogEntry[]) {
  const byRoute = new Map<string, { count: number; inputTokens: number; outputTokens: number }>();
  const latencies: number[] = [];
  let failed = 0;
  let totalInput = 0;
  let totalOutput = 0;

  // Accounting aggregates (Wave 0)
  let actualPrompt = 0;
  let actualOutput = 0;
  let actualCost = 0;
  let estimatedCost = 0;
  let fallbackTokens = 0;
  let fallbackAttempts = 0;
  const fallbackByClass: Record<string, number> = {};
  let cachedTokensSeen = 0;
  let entriesWithUsage = 0;
  let entriesWithCacheInfo = 0;
  let compressionRatios: number[] = [];
  let upstreamSentTokens = 0; // finalUpstreamInputTokens (estimasi payload dikirim)
  let cacheableTokens = 0;

  for (const e of entries) {
    if (typeof e.totalLatencyMs === "number") latencies.push(e.totalLatencyMs);
    if (typeof e.status === "number" && e.status >= 400) failed++;
    const route = e.route ?? "default";
    const rec = byRoute.get(route) ?? { count: 0, inputTokens: 0, outputTokens: 0 };
    rec.count++;
    rec.inputTokens += typeof e.inputTokens === "number" ? e.inputTokens : 0;
    rec.outputTokens += typeof e.outputTokens === "number" ? e.outputTokens : 0;
    byRoute.set(route, rec);
    totalInput += typeof e.inputTokens === "number" ? e.inputTokens : 0;
    totalOutput += typeof e.outputTokens === "number" ? e.outputTokens : 0;

    const acc: any = (e as any).accounting;
    if (acc) {
      const ap = typeof acc.tokens?.actualPrompt === "number" ? acc.tokens.actualPrompt : 0;
      const ao = typeof acc.tokens?.actualOutput === "number" ? acc.tokens.actualOutput : 0;
      if (ap > 0 || ao > 0) {
        entriesWithUsage++;
        actualPrompt += ap;
        actualOutput += ao;
      }
      const ci = acc.tokens?.cachedInput;
      if (typeof ci === "number") {
        entriesWithCacheInfo++;
        cachedTokensSeen += ci;
      }
      const fu = typeof acc.tokens?.finalUpstreamInput === "number" ? acc.tokens.finalUpstreamInput : 0;
      upstreamSentTokens += fu;
      if (typeof acc.compressionRatio === "number" && acc.compressionRatio > 0) compressionRatios.push(acc.compressionRatio);
      if (typeof acc.cost?.actual === "number") actualCost += acc.cost.actual;
      if (typeof acc.cost?.estimated === "number") estimatedCost += acc.cost.estimated;
      if (typeof acc.fallback?.tokens === "number") fallbackTokens += acc.fallback.tokens;
      if (typeof acc.fallback?.attempts === "number") fallbackAttempts += acc.fallback.attempts;
      const byC = acc.fallback?.byClass;
      if (byC && typeof byC === "object") {
        for (const [k, v] of Object.entries(byC)) {
          fallbackByClass[k] = (fallbackByClass[k] ?? 0) + (typeof v === "number" ? v : 0);
        }
      }
      if (typeof acc.cacheableTokens === "number") cacheableTokens += acc.cacheableTokens;
    }
  }

  const avgCompressionRatio = compressionRatios.length > 0
    ? Number((compressionRatios.reduce((s, v) => s + v, 0) / compressionRatios.length).toFixed(3))
    : null;
  const cacheHitRate = entriesWithUsage > 0 ? Number((cachedTokensSeen / Math.max(1, actualPrompt)).toFixed(4)) : null;

  return {
    count: entries.length,
    failed,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    latency: percentileStats(latencies),
    byRoute: Object.fromEntries(byRoute),
    accounting: {
      entriesWithActualUsage: entriesWithUsage,
      actualPromptTokens: actualPrompt,
      actualOutputTokens: actualOutput,
      actualCostUSD: Number(actualCost.toFixed(6)),
      estimatedCostUSD: Number(estimatedCost.toFixed(6)),
      upstreamSentTokensEstimate: upstreamSentTokens,
      compressionRatioAvg: avgCompressionRatio,
      cacheHitRate,
      cachedInputTokensSeen: cachedTokensSeen,
      cacheableTokensEstimate: cacheableTokens,
      fallbackAttempts,
      fallbackTokensEstimate: fallbackTokens,
      fallbackByClass,
      fallbackTax: fallbackTokens + upstreamSentTokens > 0
        ? Number((fallbackTokens / (fallbackTokens + upstreamSentTokens)).toFixed(4))
        : 0,
    },
  };
}

function percentileStats(values: number[]) {
  if (!values.length) return { count: 0, min: null, p50: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const p = (n: number) => sorted[Math.max(0, Math.min(Math.ceil((n / 100) * sorted.length) - 1, sorted.length - 1))];
  return { count: values.length, min: sorted[0], p50: p(50), p95: p(95), max: sorted[sorted.length - 1] };
}
