// src/telemetry/logger.ts — structured JSON logger dengan redaction
const SENSITIVE_KEYS = new Set([
  "authorization",
  "api_key",
  "apikey",
  "password",
  "secret",
  "cookie",
  "x-api-key",
  "api-key",
]);

// Token-related keys: only exact "token" or suffix like "_token" / "access_token" — not "estimatedTokens" metrics
function isTokenSensitiveKey(lower: string): boolean {
  if (lower === "token") return true;
  if (lower.endsWith("_token") || lower.endsWith("-token")) return true;
  if (lower === "access_token" || lower === "refresh_token" || lower === "id_token") return true;
  return false;
}

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SENSITIVE_KEYS.has(lower)) return true;
  if (isTokenSensitiveKey(lower)) return true;
  for (const k of SENSITIVE_KEYS) {
    if (lower.includes(k)) return true;
  }
  // For token, only check via isTokenSensitiveKey, not substring includes("token")
  return false;
}

export function redactValue(key: string, value: unknown): unknown {
  if (isSensitiveKey(key)) return "[REDACTED]";
  if (typeof value === "string" && value.length > 0) {
    // Heuristic: bearer tokens
    if (value.toLowerCase().startsWith("bearer ")) return "[REDACTED]";
    if (key.toLowerCase().includes("authorization")) return "[REDACTED]";
  }
  return value;
}

export function redactObject(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(redactObject);

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (isSensitiveKey(k)) {
      out[k] = "[REDACTED]";
    } else if (typeof v === "object" && v !== null) {
      out[k] = redactObject(v);
    } else if (typeof v === "string" && k.toLowerCase().includes("authorization")) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = v;
    }
  }
  return out;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  requestId?: string;
  method?: string;
  path?: string;
  status?: number;
  latencyMs?: number;
  provider?: string;
  model?: string;
  route?: string;
  ttftMs?: number;
  gatewayOverheadMs?: number;
  providerLatencyMs?: number;
  [key: string]: unknown;
}

export function formatTimestampJakarta(d: Date): string {
  // Asia/Jakarta WIB = UTC+7 tanpa DST. Shift UTC → WIB lalu label +07:00.
  // ponytail: jika butuh TZ lain, ganti ke Intl.DateTimeFormat dengan LOG_TZ.
  const shifted = new Date(d.getTime() + 7 * 3600 * 1000);
  return shifted.toISOString().slice(0, 19) + "+07:00";
}

function log(level: LogLevel, message: string, fields: LogFields = {}) {
  const envLevel = (process.env.LOG_LEVEL || Bun.env.LOG_LEVEL || "info").toLowerCase();
  const order: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  if ((order[level] ?? 1) < (order[envLevel] ?? 1)) return;

  const entry = {
    timestamp: formatTimestampJakarta(new Date()),
    level,
    message,
    ...(redactObject(fields) as Record<string, unknown>),
  };
  const line = JSON.stringify(entry);
  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (msg: string, fields?: LogFields) => log("debug", msg, fields),
  info: (msg: string, fields?: LogFields) => log("info", msg, fields),
  warn: (msg: string, fields?: LogFields) => log("warn", msg, fields),
  error: (msg: string, fields?: LogFields) => log("error", msg, fields),
};
