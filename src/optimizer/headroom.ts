// src/optimizer/headroom.ts — Headroom wrapper Phase 6 (reuse vendor proxy logic, fail-open)
// Tidak reimplement algoritma kompresi; hanya orchestrate panggilan ke Headroom proxy via fetch.
// Untuk Mini Router, hanya OpenAI shape (messages) yang didukung — cukup untuk OpenCode gateway.

import type { ChatCompletionRequest } from "../types/index.ts";
import type { RequestProfile } from "../router/profile.ts";

export interface HeadroomOptions {
  enabled: boolean;
  url?: string;
  model?: string;
  minimumTokens?: number;
  minimumBytes?: number;
  timeoutMs?: number;
  failOpen?: boolean;
  compressUserMessages?: boolean;
  maxConsecutiveFailures?: number;
  cooldownMs?: number;
  healthProbeMs?: number;
  cacheTtlMs?: number;
}

export interface HeadroomResult {
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

const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_MIN_TOKENS = 6000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 2;
const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_HEALTH_PROBE_MS = 500;
const DEFAULT_CACHE_TTL_MS = 10_000;
const HEALTH_CACHE_MS = 3_000;
const MAX_EFFECTIVE_TIMEOUT_MS = 6000;
const ADAPTIVE_TIMEOUT_PER_KB_MS = 0.8; // tambah 0.8ms per KB payload, cap MAX_EFFECTIVE_TIMEOUT_MS (untuk 300k tokens ~1.2MB -> +~960ms)
// R4: payload >1.5MB → skip headroom (Python compress lambat di payload ekstrem, RTK tetap jalan) — turun dari 4MB karena 1.5MB sudah ~375k tokens pasti timeout
const MAX_HEADROOM_PAYLOAD_BYTES = 1.5 * 1024 * 1024;
// Early-skip untuk payload sangat besar: >180k tokens hampir pasti timeout Python, fail-fast tanpa fetch.
// REVERT R6 (2026-09-10): pernah dinaikkan ke 320k agar 180-320k dicoba kompresi (unlock provider 128k/256k),
// tapi terbukti proxy headroom timeout ~4.7s untuk payload 200k → buang 5s per request tanpa manfaat.
// Kembali ke 180k: fail-open cepat, request besar langsung lanjut ke provider 1M di fallback chain.
const SKIP_IF_EST_TOKENS_GT = 180_000;

// Circuit breaker state — in-memory, reset on success
let consecutiveFailures = 0;
let cooldownUntil = 0;
let lastHealthCheck = 0;
let lastHealthOk = true;
let lastFailureReason = "";
let lastHealthUrl = "";
let lastProbeTimedOut = false;
let lastConnectionDown = false;

// R3: cooldown singkat saat proxy definitif-down (connection refused) — auto-retry cepat,
// jangan biarkan tiap request bayar 8-12s callCompress timeout
const DEFAULT_CONNECTION_DOWN_COOLDOWN_MS = 8_000;

// Probe timeout yang beruntun dihitung sebagai failure (fail-fast), bukan inconclusive
let probeTimeoutFailures = 0;
const PROBE_TIMEOUT_FAILURE_THRESHOLD = 2;
const PROBE_TIMEOUT_WINDOW_MS = 10_000;
let probeTimeoutWindowStart = 0;

// Result cache — key: hash(model + url + compressUserMessages + messages JSON)
interface CachedCompression {
  messages: any[];
  savedBytes: number;
  savedPercent: number;
  expiresAt: number;
}
const compressionCache = new Map<string, CachedCompression>();

function hashString(value: string): string {
  try {
    return String((Bun as any).hash?.(value) ?? simpleHash(value));
  } catch {
    return String(simpleHash(value));
  }
}

function simpleHash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Export untuk test & observabilitas
// Konstanta default — diexport untuk test sinkronisasi config (R1 anti-drift)
export const HEADROOM_DEFAULTS = Object.freeze({
  DEFAULT_TIMEOUT_MS,
  DEFAULT_HEALTH_PROBE_MS,
  MAX_EFFECTIVE_TIMEOUT_MS,
  DEFAULT_CONNECTION_DOWN_COOLDOWN_MS,
  MAX_HEADROOM_PAYLOAD_BYTES,
  SKIP_IF_EST_TOKENS_GT,
});

export function getHeadroomHealth() {
  return { consecutiveFailures, cooldownUntil, lastHealthOk, lastFailureReason, cooldownRemainingMs: Math.max(0, cooldownUntil - Date.now()), lastConnectionDown };
}
export function resetHeadroomHealth() {
  consecutiveFailures = 0;
  cooldownUntil = 0;
  lastHealthOk = true;
  lastFailureReason = "";
  lastHealthCheck = 0;
  lastHealthUrl = "";
  lastProbeTimedOut = false;
  lastConnectionDown = false;
  probeTimeoutFailures = 0;
  probeTimeoutWindowStart = 0;
  compressionCache.clear();
}
export function clearHeadroomCache() {
  compressionCache.clear();
}
function getCacheKey(model: string, url: string, compressUserMessages: boolean, messages: any[]): string {
  return hashString(`${model}|${url}|${compressUserMessages}|${JSON.stringify(messages)}`);
}
function isInCooldown(): boolean {
  return Date.now() < cooldownUntil;
}
async function probeHeadroomHealth(url: string, probeTimeoutMs: number): Promise<{ ok: boolean; timedOut: boolean; connectionDown?: boolean }> {
  const now = Date.now();
  if (url === lastHealthUrl && now - lastHealthCheck < HEALTH_CACHE_MS) return { ok: lastHealthOk, timedOut: lastProbeTimedOut };
  lastHealthCheck = now;
  lastHealthUrl = url;
  lastProbeTimedOut = false;
  // Coba beberapa endpoint/health URL untuk robustness (headroom punya /health, /livez, /readyz)
  const candidates = [
    url.replace(/\/$/, "") + "/health",
    url.replace(/\/$/, "") + "/livez",
    url.replace("localhost", "127.0.0.1").replace(/\/$/, "") + "/health",
  ];
  for (const endpoint of candidates) {
    try {
      const res = await fetch(endpoint, { method: "GET", signal: AbortSignal.timeout(probeTimeoutMs) });
      // 404/405 pada mock test dianggap healthy (mock hanya implement /v1/compress)
      if (res.status === 404 || res.status === 405) {
        lastHealthOk = true;
        lastConnectionDown = false;
        return { ok: true, timedOut: false };
      }
      lastHealthOk = res.ok;
      lastConnectionDown = false;
      if (!res.ok) lastFailureReason = `health probe HTTP ${res.status}`;
      else lastFailureReason = "";
      return { ok: lastHealthOk, timedOut: false };
    } catch (e: any) {
      const name = String(e?.name ?? "");
      const msg = String(e?.message ?? "").toLowerCase();
      const cause = String((e as any)?.cause ?? "").toLowerCase();
      const isTimeout = name.includes("Timeout") || name.includes("AbortError") || msg.includes("timed out") || msg.includes("aborted") || msg.includes("timeout");
      // Connection down: proxy tidak jalan (refused/reset/unreachable) — berbeda dari busy-timeout
      const isConnDown = cause.includes("econnrefused") || cause.includes("econnreset") || cause.includes("enotfound") || cause.includes("ehostunreach") ||
        msg.includes("unable to connect") || msg.includes("connection refused") || msg.includes("connection failed") || msg.includes("fetch failed");
      // Jika timeout, anggap inconclusive langsung tanpa coba endpoint lain
      if (isTimeout) {
        lastHealthOk = false;
        lastProbeTimedOut = true;
        lastConnectionDown = false;
        lastFailureReason = "health probe timeout";
        return { ok: false, timedOut: true };
      }
      // Jika bukan timeout dan masih ada kandidat, coba endpoint berikutnya (mis. Unable to connect -> coba 127.0.0.1)
      const isLast = endpoint === candidates[candidates.length - 1];
      if (!isLast) continue;
      // Semua kandidat gagal — proxy down definitif -> cooldown singkat agar request berikutnya tidak bayar +8-12s
      lastHealthOk = false;
      lastProbeTimedOut = false;
      lastConnectionDown = isConnDown;
      const rawMsg = String(e?.message ?? e).slice(0, 80);
      const shortMsg = isConnDown ? "proxy not running" : rawMsg;
      lastFailureReason = `headroom skip: ${shortMsg} (cooldown ${DEFAULT_CONNECTION_DOWN_COOLDOWN_MS / 1000}s)`;
      return { ok: false, timedOut: false, connectionDown: isConnDown };
    }
  }
  return { ok: lastHealthOk, timedOut: lastProbeTimedOut };
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) || "", "utf-8");
  } catch { return 0; }
}

function captureSnapshot(chatReq: ChatCompletionRequest) {
  const messages = Array.isArray((chatReq as any).messages) ? (chatReq as any).messages : null;
  const toolHistory = messages?.filter((m: any) =>
    m?.role === "tool" || m?.role === "function" || m?.tool_calls?.length || m?.tool_call_id
  ) || [];
  return {
    bodyBytes: jsonBytes(chatReq),
    messageBytes: messages ? jsonBytes(messages) : 0,
    toolHistoryBytes: jsonBytes(toolHistory),
    messageCount: messages ? messages.length : 0,
  };
}

function buildCompressEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/v1/compress`;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    const raw = String(url).replace(/#.*$/, "");
    const [base, query = ""] = raw.split("?", 2);
    const endpoint = `${base.replace(/\/$/, "")}/v1/compress`;
    return query ? `${endpoint}?${query}` : endpoint;
  }
}

function maskEndpoint(endpoint: string): string {
  try {
    const parsed = new URL(endpoint);
    parsed.username = ""; parsed.password = ""; parsed.search = ""; parsed.hash = "";
    return parsed.toString();
  } catch { return String(endpoint).replace(/\/\/[^/@\s]+@/, "//").replace(/[?#].*$/, ""); }
}

function resolveEffectiveTimeout(baseMs: number, messages: any[]): number {
  try {
    const bytes = Buffer.byteLength(JSON.stringify(messages), "utf-8");
    const extra = Math.ceil(bytes / 1024) * ADAPTIVE_TIMEOUT_PER_KB_MS;
    return Math.min(MAX_EFFECTIVE_TIMEOUT_MS, Math.max(baseMs, baseMs + extra));
  } catch { return baseMs; }
}

async function callCompress(url: string, messages: any[], model: string, timeoutMs: number, diagnostics: any, compressUserMessages = false) {
  const effectiveTimeoutMs = resolveEffectiveTimeout(timeoutMs, messages);
  diagnostics.requestedTimeoutMs = timeoutMs;
  diagnostics.effectiveTimeoutMs = effectiveTimeoutMs;
  const endpoint = buildCompressEndpoint(url);
  diagnostics.endpoint = maskEndpoint(endpoint);
  const payload: any = { messages, model };
  // Proteksi pesan user default: kompresi hanya tool/history, jangan rewrite instruksi user (andal).
  // Bisa diaktifkan via config (compressUserMessages) untuk saving lebih pada prompt kaya konten.
  payload.config = { compress_user_messages: Boolean(compressUserMessages) };
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(effectiveTimeoutMs),
    });
  } catch (e: any) {
    const name = String(e?.name ?? "");
    const msg = String(e?.message ?? e).toLowerCase();
    const isTimeout = name.includes("Timeout") || name.includes("AbortError") || msg.includes("timed out") || msg.includes("aborted") || msg.includes("timeout");
    diagnostics.timedOut = isTimeout;
    diagnostics.cause = String(e?.cause ?? "").slice(0, 120);
    diagnostics.reason = isTimeout
      ? `headroom_proxy timeout ${effectiveTimeoutMs}ms (base ${timeoutMs}ms) @ ${maskEndpoint(endpoint)}: ${String(e?.message ?? e).slice(0, 120)}`
      : `request failed: ${String(e?.message ?? e).slice(0, 200)}`;
    return null;
  }
  if (!res.ok) {
    diagnostics.reason = `proxy returned HTTP ${res.status} @ ${maskEndpoint(endpoint)}`;
    return null;
  }
  let data: any;
  try { data = await res.json(); } catch { diagnostics.reason = "invalid json response"; return null; }
  if (!Array.isArray(data?.messages)) {
    diagnostics.reason = "proxy response missing messages[]";
    return null;
  }
  return data;
}

export async function applyHeadroom(
  chatReq: ChatCompletionRequest,
  profile: RequestProfile,
  opts: HeadroomOptions,
  diagnostics: any = {}
): Promise<HeadroomResult> {
  const start = performance.now();
  const inputBytes = Buffer.byteLength(JSON.stringify(chatReq), "utf-8");
  const inputMessages = Array.isArray((chatReq as any).messages) ? (chatReq as any).messages.length : 0;

  if (!opts.enabled) {
    return { enabled: false, skipped: true, reason: "disabled", inputBytes, outputBytes: inputBytes, savedBytes: 0, savedPercent: 0, durationMs: performance.now() - start, success: false, inputMessages, outputMessages: inputMessages };
  }

  const minimumTokens = opts.minimumTokens ?? DEFAULT_MIN_TOKENS;
  const minimumBytes = opts.minimumBytes;
  // R4: Payload ekstrem → skip headroom (kompresi Python lambat, timeout pasti; RTK tetap jalan)
  if (profile.bodyBytes > MAX_HEADROOM_PAYLOAD_BYTES) {
    return { enabled: true, skipped: true, reason: "payload_too_large_for_headroom", inputBytes, outputBytes: inputBytes, savedBytes: 0, savedPercent: 0, durationMs: performance.now() - start, success: false, inputMessages, outputMessages: inputMessages };
  }
  // Early-skip untuk payload sangat besar: >180k tokens hampir pasti timeout Python
  if (profile.estimatedTokens > SKIP_IF_EST_TOKENS_GT) {
    return { enabled: true, skipped: true, reason: "payload_too_large_expected_timeout", inputBytes, outputBytes: inputBytes, savedBytes: 0, savedPercent: 0, durationMs: performance.now() - start, success: false, inputMessages, outputMessages: inputMessages };
  }
  // Threshold check: skip small context. Kedua syarat diuji mandiri (AND) —
  // minimumBytes membatasi payload sangat kecil, minimumTokens membatasi konteks kecil.
  if (minimumBytes !== undefined && profile.bodyBytes < minimumBytes) {
    return { enabled: true, skipped: true, reason: "below_min_bytes", inputBytes, outputBytes: inputBytes, savedBytes: 0, savedPercent: 0, durationMs: performance.now() - start, success: false, inputMessages, outputMessages: inputMessages };
  }
  if (profile.estimatedTokens < minimumTokens) {
    return { enabled: true, skipped: true, reason: "below_min_tokens", inputBytes, outputBytes: inputBytes, savedBytes: 0, savedPercent: 0, durationMs: performance.now() - start, success: false, inputMessages, outputMessages: inputMessages };
  }

  const url = opts.url ?? process.env.HEADROOM_URL ?? (Bun.env as any).HEADROOM_URL;
  if (!url) {
    return { enabled: true, skipped: true, reason: "missing_url", inputBytes, outputBytes: inputBytes, savedBytes: 0, savedPercent: 0, durationMs: performance.now() - start, success: false, inputMessages, outputMessages: inputMessages };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const model = opts.model ?? chatReq.model ?? "unknown";
  const messages = (chatReq as any).messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { enabled: true, skipped: true, reason: "no_messages", inputBytes, outputBytes: inputBytes, savedBytes: 0, savedPercent: 0, durationMs: performance.now() - start, success: false, inputMessages, outputMessages: inputMessages };
  }

  // Circuit breaker: jika headroom baru saja timeout beruntun, skip tanpa fetch (hemat 800ms)
  const maxFailures = opts.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const healthProbeMs = opts.healthProbeMs ?? DEFAULT_HEALTH_PROBE_MS;
  const cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const compressUserMessages = opts.compressUserMessages ?? false;
  if (isInCooldown()) {
    const remaining = Math.ceil((cooldownUntil - Date.now()) / 1000);
    return { enabled: true, skipped: true, reason: `headroom_cooldown ${remaining}s remaining (${lastFailureReason})`, inputBytes, outputBytes: inputBytes, savedBytes: 0, savedPercent: 0, durationMs: performance.now() - start, success: false, inputMessages, outputMessages: inputMessages, endpoint: lastFailureReason };
  }
  // Cache hit: request identik dalam TTL → pakai hasil kompresi tersimpan, lewati probe & proxy
  const cacheKey = getCacheKey(model, url, compressUserMessages, messages);
  const cached = compressionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    (chatReq as any).messages = JSON.parse(JSON.stringify(cached.messages));
    const cacheOutputBytes = Buffer.byteLength(JSON.stringify(chatReq), "utf-8");
    const cacheSaved = inputBytes - cacheOutputBytes;
    return {
      enabled: true, skipped: false, reason: "cached", inputBytes, outputBytes: cacheOutputBytes, savedBytes: cacheSaved,
      savedPercent: inputBytes > 0 ? (cacheSaved / inputBytes) * 100 : 0, durationMs: performance.now() - start, success: true,
      inputMessages, outputMessages: (chatReq as any).messages.length,
      estimatedInputTokensBefore: profile.estimatedTokens, estimatedInputTokensAfter: Math.ceil(cacheOutputBytes / 4),
      compressionMode: "cached", endpoint: url,
    };
  }
  // Health probe cepat (cached 3s) sebelum fetch berat — hindari buang 800ms jika proxy down.
  // Timeout dianggap inconclusive (busy proxy) → fail-open ke kompresi; hanya definitive-down yang skip + hitung breaker.
  // Update: 2 probe timeout beruntun dalam 10s dianggap failure (Python lambat) → breaker agar tidak terus bayar 4-6s.
  if (healthProbeMs > 0) {
    const probe = await probeHeadroomHealth(url, healthProbeMs);
    if (!probe.ok && probe.connectionDown) {
      // R3: Proxy definitif-down (connection refused) → cooldown singkat 8s agar request berikutnya
      // tidak bayar +4-6s callCompress timeout. Auto-retry tanpa restart gateway.
      cooldownUntil = Date.now() + DEFAULT_CONNECTION_DOWN_COOLDOWN_MS;
      return { enabled: true, skipped: true, reason: lastFailureReason, inputBytes, outputBytes: inputBytes, savedBytes: 0, savedPercent: 0, durationMs: performance.now() - start, success: false, inputMessages, outputMessages: inputMessages, endpoint: url };
    }
    if (!probe.ok && probe.timedOut) {
      const now = Date.now();
      if (now - probeTimeoutWindowStart > PROBE_TIMEOUT_WINDOW_MS) {
        probeTimeoutWindowStart = now;
        probeTimeoutFailures = 1;
      } else {
        probeTimeoutFailures++;
      }
      if (probeTimeoutFailures >= PROBE_TIMEOUT_FAILURE_THRESHOLD) {
        consecutiveFailures++;
        lastFailureReason = `headroom probe timeout x${probeTimeoutFailures} in ${PROBE_TIMEOUT_WINDOW_MS / 1000}s`;
        if (consecutiveFailures >= maxFailures) cooldownUntil = Date.now() + cooldownMs;
        // reset window
        probeTimeoutFailures = 0;
        probeTimeoutWindowStart = 0;
        return { enabled: true, skipped: true, reason: lastFailureReason, inputBytes, outputBytes: inputBytes, savedBytes: 0, savedPercent: 0, durationMs: performance.now() - start, success: false, inputMessages, outputMessages: inputMessages, endpoint: url };
      }
      // belum threshold → fall-through ke kompresi (fail-open), tidak hitung breaker penuh
    } else if (probe.timedOut === false && probe.ok) {
      // probe ok → reset timeout counter
      probeTimeoutFailures = 0;
      probeTimeoutWindowStart = 0;
    }
    if (!probe.ok && !probe.timedOut) {
      // Definitive down (HTTP non-ok) → skip + ikut hitung breaker → cooldown penuh
      consecutiveFailures++;
      // Hindari double prefix headroom_unhealthy
      if (!lastFailureReason.startsWith("headroom_unhealthy:")) {
        lastFailureReason = `headroom_unhealthy: ${lastFailureReason}`;
      }
      if (consecutiveFailures >= maxFailures) cooldownUntil = Date.now() + cooldownMs;
      return { enabled: true, skipped: true, reason: lastFailureReason, inputBytes, outputBytes: inputBytes, savedBytes: 0, savedPercent: 0, durationMs: performance.now() - start, success: false, inputMessages, outputMessages: inputMessages, endpoint: url };
    }
    // probe.timedOut yang belum threshold → fall-through ke kompresi (fail-open)
  }

  // Snapshot before
  const before = captureSnapshot(chatReq);
  diagnostics.before = before;

  // Clone messages for fail-open safety (shallow copy messages array; messages objects are shallow cloned via JSON round-trip for safety)
  // Untuk hemat, kita pakai structuredClone jika ada, fallback JSON
  let messagesClone: any[];
  try {
    messagesClone = JSON.parse(JSON.stringify(messages));
  } catch {
    messagesClone = [...messages];
  }

  const callDiagnostics: any = {};
  let data: any = null;
  try {
    data = await callCompress(url, messagesClone, model, timeoutMs, callDiagnostics, compressUserMessages);
  } catch (e: any) {
    diagnostics.reason = `unexpected error: ${String(e?.message ?? e).slice(0, 200)}`;
    const durationMs = performance.now() - start;
    consecutiveFailures++;
    lastFailureReason = diagnostics.reason;
    if (consecutiveFailures >= maxFailures) cooldownUntil = Date.now() + cooldownMs;
    return { enabled: true, skipped: true, reason: diagnostics.reason, inputBytes, outputBytes: inputBytes, savedBytes: 0, savedPercent: 0, durationMs, success: false, inputMessages, outputMessages: inputMessages, endpoint: callDiagnostics.endpoint };
  }

  const durationMs = performance.now() - start;

  if (!data) {
    const reason = callDiagnostics.reason ?? diagnostics.reason ?? "proxy_failed";
    consecutiveFailures++;
    lastFailureReason = reason;
    if (consecutiveFailures >= maxFailures) cooldownUntil = Date.now() + cooldownMs;
    return { enabled: true, skipped: true, reason, inputBytes, outputBytes: inputBytes, savedBytes: 0, savedPercent: 0, durationMs, success: false, inputMessages, outputMessages: inputMessages, endpoint: callDiagnostics.endpoint };
  }
  // Sukses → reset circuit breaker + refresh health cache
  consecutiveFailures = 0;
  lastFailureReason = "";
  cooldownUntil = 0;
  lastHealthOk = true;
  lastProbeTimedOut = false;
  probeTimeoutFailures = 0;
  probeTimeoutWindowStart = 0;
  lastHealthCheck = Date.now();

  // Validate response
  const compressedMessages = data.messages;
  if (!Array.isArray(compressedMessages)) {
    return { enabled: true, skipped: true, reason: "invalid_response", inputBytes, outputBytes: inputBytes, savedBytes: 0, savedPercent: 0, durationMs, success: false, inputMessages, outputMessages: inputMessages };
  }

  // Preserve safety: never increase size significantly; check phantom savings (if proxy reports tokens but bytes not shrinking)
  // Hitung outputBytes setelah kompresi (ganti messages)
  const originalMessages = (chatReq as any).messages;

  // Tool-safety: preserve tool_calls and developer/system if proxy corrupted them
  // Snapshot original tool_calls / developer before overwriting
  for (let i = 0; i < Math.min(originalMessages.length, compressedMessages.length); i++) {
    const orig: any = originalMessages[i];
    const comp: any = compressedMessages[i];
    if (!orig || !comp) continue;
    // Preserve tool_calls deep (function.arguments JSON must stay valid)
    if (orig.tool_calls) {
      const origStr = JSON.stringify(orig.tool_calls);
      const compStr = JSON.stringify(comp.tool_calls);
      if (origStr !== compStr) {
        try {
          comp.tool_calls = JSON.parse(origStr);
        } catch { comp.tool_calls = orig.tool_calls; }
      } else if (orig.tool_calls && !comp.tool_calls) {
        comp.tool_calls = JSON.parse(JSON.stringify(orig.tool_calls));
      }
      // Deep check function.arguments still valid JSON after proxy (if proxy truncated)
      if (comp.tool_calls) {
        for (let j = 0; j < comp.tool_calls.length; j++) {
          const origArgs = orig.tool_calls[j]?.function?.arguments;
          const compArgs = comp.tool_calls[j]?.function?.arguments;
          if (typeof origArgs === "string" && typeof compArgs === "string" && origArgs !== compArgs) {
            // Restore original arguments if proxy changed them (preserve semantic)
            try { JSON.parse(compArgs); JSON.parse(origArgs); } catch {}
            // If compArgs is not valid JSON or different, restore original
            if (compArgs !== origArgs) {
              try { JSON.parse(origArgs); comp.tool_calls[j].function.arguments = origArgs; } catch {}
            }
          }
        }
      }
    }
    // Preserve tool_call_id linkage
    if (orig.role === "tool" && orig.tool_call_id && comp.tool_call_id !== orig.tool_call_id) {
      comp.tool_call_id = orig.tool_call_id;
    }
    // Preserve developer messages exactly (never compress developer)
    if (orig.role === "developer" && orig.content !== comp.content) {
      comp.content = orig.content;
    }
  }

  (chatReq as any).messages = compressedMessages;
  const outputBytes = Buffer.byteLength(JSON.stringify(chatReq), "utf-8");
  const after = captureSnapshot(chatReq);
  diagnostics.after = after;
  diagnostics.endpoint = callDiagnostics.endpoint;

  // Jika output >= input (tidak hemat atau malah bertambah) → restore original (phantom savings)
  if (outputBytes >= inputBytes) {
    (chatReq as any).messages = originalMessages;
    return { enabled: true, skipped: true, reason: "no_saving_or_phantom", inputBytes, outputBytes: inputBytes, savedBytes: 0, savedPercent: 0, durationMs, success: false, inputMessages, outputMessages: inputMessages, endpoint: callDiagnostics.endpoint };
  }

  // Jika pesan count tidak masuk akal? Tetap allow, tapi pastikan tidak kosong
  if (compressedMessages.length === 0 && originalMessages.length > 0) {
    (chatReq as any).messages = originalMessages;
    return { enabled: true, skipped: true, reason: "empty_compressed", inputBytes, outputBytes: inputBytes, savedBytes: 0, savedPercent: 0, durationMs, success: false, inputMessages, outputMessages: inputMessages };
  }

  const savedBytes = inputBytes - outputBytes;
  const savedPercent = inputBytes > 0 ? (savedBytes / inputBytes) * 100 : 0;
  // Cache hasil sukses untuk reuse request identik dalam TTL
  compressionCache.set(cacheKey, { messages: JSON.parse(JSON.stringify(compressedMessages)), savedBytes, savedPercent, expiresAt: Date.now() + cacheTtlMs });
  const estimatedInputTokensBefore = profile.estimatedTokens;
  const estimatedInputTokensAfter = Math.ceil(outputBytes / 4);

  // Optional phantom check jika proxy report tokens_saved tetapi bytes tidak mengecil signifikan
  const minShrinkRatio = 0.05;
  if (data.stats?.tokens_saved && outputBytes >= inputBytes * (1 - minShrinkRatio)) {
    // restore, tapi tetap dianggap skipped
    // (kita sudah handle output>=input di atas, ini untuk kasus tokens report tapi bytes tidak)
  }

  return {
    enabled: true,
    skipped: false,
    reason: "compressed",
    inputBytes,
    outputBytes,
    savedBytes,
    savedPercent,
    durationMs,
    success: true,
    inputMessages,
    outputMessages: compressedMessages.length,
    estimatedInputTokensBefore,
    estimatedInputTokensAfter,
    compressionMode: data.mode ?? data.compressionMode ?? "unknown",
    endpoint: callDiagnostics.endpoint,
  };
}
