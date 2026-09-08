// src/telemetry/metrics.ts — Phase 4 extended
export interface RtkMetric {
  enabled: boolean;
  skipped: boolean;
  reason: string;
  inputBytes: number;
  outputBytes: number;
  savedBytes: number;
  savedPercent: number;
  durationMs: number;
  success: boolean;
  filter?: string;
  hits?: number;
}

export interface HeadroomMetric {
  enabled: boolean;
  skipped: boolean;
  reason: string;
  inputBytes: number;
  outputBytes: number;
  savedBytes: number;
  savedPercent: number;
  durationMs: number;
  success: boolean;
  inputMessages?: number;
  outputMessages?: number;
  estimatedInputTokensBefore?: number;
  estimatedInputTokensAfter?: number;
  compressionMode?: string;
  endpoint?: string;
}

export interface CavemanMetric {
  enabled: boolean;
  skipped: boolean;
  reason: string;
  mode: string;
  injectedBytes: number;
}

export interface PonytailMetric {
  enabled: boolean;
  skipped: boolean;
  reason: string;
  mode: string;
  injectedBytes: number;
}

export interface RequestMetric {
  requestId: string;
  route?: string;
  provider?: string;
  model?: string;
  ttftMs?: number | null;
  totalLatencyMs?: number | null;
  gatewayOverheadMs?: number | null;
  providerLatencyMs?: number | null;
  generationLatencyMs?: number | null;
  normalizationMs?: number | null;
  routingMs?: number | null;
  rtkDurationMs?: number | null;
  headroomDurationMs?: number | null;
  inputTokens?: number | string;
  outputTokens?: number | string;
  cachedInputTokens?: number | string;
  bodyBytes?: number;
  messageBytes?: number;
  toolBytes?: number;
  toolHistoryBytes?: number;
  fallbackCount?: number;
  retryCount?: number;
  estimatedTokens?: number;
  rtk?: RtkMetric | null;
  headroom?: HeadroomMetric | null;
  caveman?: CavemanMetric | null;
  ponytail?: PonytailMetric | null;
  duplicateCacheHits?: number;
  errorMemoryHits?: number;
  accounting?: any;
  status: number;
  timestamp: number;
}

const recentMetrics: RequestMetric[] = [];
const MAX_RECENT = 100;

export function recordMetric(m: RequestMetric) {
  recentMetrics.push(m);
  if (recentMetrics.length > MAX_RECENT) recentMetrics.shift();
}

export function getRecentMetrics(): RequestMetric[] {
  return [...recentMetrics];
}

export function getMetricsSummary() {
  const latencies = recentMetrics
    .map((m) => m.totalLatencyMs)
    .filter((v): v is number => typeof v === "number");
  const overheads = recentMetrics
    .map((m) => m.gatewayOverheadMs)
    .filter((v): v is number => typeof v === "number");
  const ttfts = recentMetrics
    .map((m) => m.ttftMs)
    .filter((v): v is number => typeof v === "number");
  const providerLatencies = recentMetrics
    .map((m) => m.providerLatencyMs)
    .filter((v): v is number => typeof v === "number");
  const headroomFails = recentMetrics.filter((m) => m.headroom && !m.headroom.success && m.headroom.enabled && m.headroom.skipped).length;
  const headroomTimeouts = recentMetrics.filter((m) => m.headroom?.reason?.includes("timeout") || m.headroom?.reason?.includes("headroom_proxy timeout")).length;
  const headroomCooldowns = recentMetrics.filter((m) => m.headroom?.reason?.includes("headroom_cooldown")).length;
  const headroomDurations = recentMetrics.map((m) => m.headroomDurationMs).filter((v): v is number => typeof v === "number");
  const timeoutRate = recentMetrics.length > 0 ? headroomTimeouts / recentMetrics.length : 0;

  return {
    count: recentMetrics.length,
    latencies: computeStats(latencies),
    gatewayOverhead: computeStats(overheads),
    ttft: computeStats(ttfts),
    providerLatency: computeStats(providerLatencies),
    headroom: { fails: headroomFails, timeouts: headroomTimeouts, cooldowns: headroomCooldowns, timeoutRate: Number(timeoutRate.toFixed(3)), avgDurationMs: computeStats(headroomDurations) },
    recent: recentMetrics.slice(-10),
  };
}

export function computeStats(values: number[]) {
  if (values.length === 0) return { min: null, p50: null, p95: null, max: null, count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  return { min, p50, p95, max, count: values.length };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

export function clearMetrics() {
  recentMetrics.length = 0;
}
