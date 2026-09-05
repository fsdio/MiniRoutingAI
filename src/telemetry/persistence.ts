// src/telemetry/persistence.ts — persist usage & request log ke disk (JSONL), dengan rotasi.
import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

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
  }

  return {
    count: entries.length,
    failed,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    latency: percentileStats(latencies),
    byRoute: Object.fromEntries(byRoute),
  };
}

function percentileStats(values: number[]) {
  if (!values.length) return { count: 0, min: null, p50: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const p = (n: number) => sorted[Math.max(0, Math.min(Math.ceil((n / 100) * sorted.length) - 1, sorted.length - 1))];
  return { count: values.length, min: sorted[0], p50: p(50), p95: p(95), max: sorted[sorted.length - 1] };
}
