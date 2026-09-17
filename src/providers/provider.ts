// src/providers/provider.ts — ProviderAdapter abstraction Phase 2
import type { ChatCompletionRequest, ChatCompletionResponse, ChatCompletionChunk } from "../types/index.ts";
import { prepareOpenAIRequest } from "../translator/request.ts";
import { recordOpenCodeAuditLog } from "../telemetry/persistence.ts";

export interface HealthStatus {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export interface ProviderAdapter {
  id: string;
  chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  stream(request: ChatCompletionRequest): Promise<ReadableStream<Uint8Array>>;
  health(): Promise<HealthStatus>;
}

export interface ProviderConfig {
  id: string;
  baseURL: string;
  apiKeyEnv?: string;
  models?: string[];
}

function resolveApiKey(apiKeyEnv?: string): string | undefined {
  if (!apiKeyEnv) return undefined;
  return (process.env[apiKeyEnv] ?? (Bun.env as any)[apiKeyEnv]) as string | undefined;
}

function getHeaders(apiKey: string | undefined, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  if (extra) Object.assign(headers, extra);
  return headers;
}

// Base OpenAI-compatible adapter — shared logic, provider-specific subclasses customize headers/baseURL
export class OpenAICompatibleAdapter implements ProviderAdapter {
  public readonly id: string;
  protected baseURL: string;
  protected apiKeyEnv?: string;
  protected extraHeaders?: Record<string, string>;

  constructor(id: string, baseURL: string, apiKeyEnv?: string, extraHeaders?: Record<string, string>) {
    this.id = id;
    this.baseURL = baseURL.replace(/\/$/, "");
    this.apiKeyEnv = apiKeyEnv;
    this.extraHeaders = extraHeaders;
  }

  protected getApiKey(): string | undefined {
    return resolveApiKey(this.apiKeyEnv);
  }

  protected getHeaders(forwarded?: Record<string,string>): Record<string, string> {
    const merged = forwarded ? { ...(this.extraHeaders ?? {}), ...forwarded } : { ...(this.extraHeaders ?? {}) };
    if ((this.id === "opencode" || this.id === "opencode-go") && !merged["x-opencode-session"]) {
      merged["x-opencode-session"] = `ses_${Date.now().toString(16)}${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    }
    return getHeaders(this.getApiKey(), merged);
  }

  // Untuk forward x-opencode-session dinamis, allow override per-request
  withForwardedHeaders(forwarded: Record<string,string>): ProviderAdapter {
    // Return proxy adapter yang merge forwarded headers tanpa mutasi this
    const clone = new OpenAICompatibleAdapter(this.id, this.baseURL, this.apiKeyEnv, { ...(this.extraHeaders ?? {}), ...forwarded });
    return clone;
  }

  protected normalizeRequest(request: ChatCompletionRequest): ChatCompletionRequest {
    // Normalisasi OpenAI + provider quirks (registry), termasuk stream_options.include_usage.
    let normalized = prepareOpenAIRequest(request, this.id) as Record<string, any>;

    // OpenRouter provider pinning: deepseek → open-inference/fp8, glm-5.3-flash → relace/fp4
    if (this.id === "openrouter") {
      const OPENROUTER_PIN_MAP: Record<string, string[]> = {
        "deepseek/deepseek-v4-flash-0731": ["open-inference/fp8"],
        "z-ai/glm-5.3-flash": ["relace/fp4"],
      };
      const getPin = (model: string): string[] | undefined => {
        if (!model) return undefined;
        if (OPENROUTER_PIN_MAP[model]) return OPENROUTER_PIN_MAP[model];
        const base = model.split(":")[0];
        if (OPENROUTER_PIN_MAP[base]) return OPENROUTER_PIN_MAP[base];
        return undefined;
      };

      // Prioritas: declarative dari router (__providerOrder/__openrouterProviders) > hardcoded map
      const forwardedOrder: string[] | undefined = (request as any).__providerOrder as string[] | undefined;
      const targetProviders: string[] | undefined = (request as any).__openrouterProviders as string[] | undefined;
      let order: string[] | undefined = forwardedOrder ?? targetProviders;
      if (!order) {
        order = getPin(normalized.model ?? (request as any).model);
      }
      if (order && order.length > 0) {
        const existing = normalized.provider as Record<string, any> | undefined;
        normalized.provider = { ...(existing ?? {}), order };
      }

      const needsReasoning = !!getPin(normalized.model ?? (request as any).model) || !!order;
      const declarativeReasoning = (request as any).__reasoning as Record<string, any> | undefined;
      if (declarativeReasoning) {
        normalized.reasoning = { ...(normalized.reasoning ?? {}), ...declarativeReasoning };
      } else if (needsReasoning) {
        const existingReasoning = normalized.reasoning as Record<string, any> | undefined;
        if (!existingReasoning) {
          normalized.reasoning = { enabled: true };
        } else if (existingReasoning.enabled === undefined) {
          normalized.reasoning = { ...existingReasoning, enabled: true };
        }
      }

      if ((normalized as any).__providerOrder) delete (normalized as any).__providerOrder;
      if ((normalized as any).__openrouterProviders) delete (normalized as any).__openrouterProviders;
      if ((normalized as any).__reasoning) delete (normalized as any).__reasoning;
    } else {
      // Non-OpenRouter: terapkan declarative reasoning dari router (semua model reasoning enabled)
      const genericReasoning = (request as any).__reasoning as Record<string, any> | undefined;
      if (genericReasoning) {
        normalized.reasoning = { ...(normalized.reasoning ?? {}), ...genericReasoning };
      }
      if ((normalized as any).__reasoning) delete (normalized as any).__reasoning;
      if ((normalized as any).__providerOrder) delete (normalized as any).__providerOrder;
      if ((normalized as any).__openrouterProviders) delete (normalized as any).__openrouterProviders;
    }

    return normalized as ChatCompletionRequest;
  }

  async chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const url = `${this.baseURL}/chat/completions`;
    const forwarded = (request as any).__forwardedHeaders as Record<string,string> | undefined;
    const normalized = this.normalizeRequest({ ...request, stream: false });
    // Jangan kirim internal field ke upstream — upstream akan validasi \"Unsupported parameter\"
    if ((normalized as any).__forwardedHeaders) delete (normalized as any).__forwardedHeaders;
    if ((normalized as any).__forwardedHeaders !== undefined) delete (normalized as any).__forwardedHeaders;
    const headers = forwarded ? this.getHeaders(forwarded) : this.getHeaders();
    const start = performance.now();
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(normalized),
    });
    const latencyMs = performance.now() - start;

    if (this.id === "opencode" || this.id === "opencode-go") {
      const respHeadersObj: Record<string, string> = {};
      res.headers.forEach((v, k) => { respHeadersObj[k] = v; });
      const safeReqHeaders = { ...headers };
      if (safeReqHeaders["Authorization"]) safeReqHeaders["Authorization"] = "[REDACTED]";
      
      // Clone text for audit if failed, or get snippet if ok
      if (!res.ok) {
        const text = await res.text();
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          body = { error: { message: text, type: "upstream_error", code: String(res.status) } };
        }
        void recordOpenCodeAuditLog({
          timestamp: new Date().toISOString(),
          ts: Date.now(),
          provider: this.id,
          model: request.model,
          url,
          stream: false,
          status: res.status,
          latencyMs,
          requestHeaders: safeReqHeaders,
          responseHeaders: respHeadersObj,
          requestSummary: {
            messageCount: Array.isArray(request.messages) ? request.messages.length : 0,
            maxTokens: request.max_tokens,
            temperature: request.temperature,
          },
          responseBodySnippet: text.slice(0, 500),
          error: body,
        });
        const err = new Error(`Provider ${this.id} chat failed: ${res.status}`);
        (err as any).status = res.status;
        (err as any).body = body;
        throw err;
      } else {
        const json = (await res.json()) as ChatCompletionResponse;
        void recordOpenCodeAuditLog({
          timestamp: new Date().toISOString(),
          ts: Date.now(),
          provider: this.id,
          model: request.model,
          url,
          stream: false,
          status: res.status,
          latencyMs,
          requestHeaders: safeReqHeaders,
          responseHeaders: respHeadersObj,
          requestSummary: {
            messageCount: Array.isArray(request.messages) ? request.messages.length : 0,
            maxTokens: request.max_tokens,
            temperature: request.temperature,
          },
          responseBodySnippet: JSON.stringify(json).slice(0, 500),
          usage: json.usage,
        });
        return json;
      }
    }

    if (!res.ok) {
      const text = await res.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = { error: { message: text, type: "upstream_error", code: String(res.status) } };
      }
      const err = new Error(`Provider ${this.id} chat failed: ${res.status}`);
      (err as any).status = res.status;
      (err as any).body = body;
      throw err;
    }
    const json = (await res.json()) as ChatCompletionResponse;
    return json;
  }

  async stream(request: ChatCompletionRequest): Promise<ReadableStream<Uint8Array>> {
    const url = `${this.baseURL}/chat/completions`;
    const forwarded = (request as any).__forwardedHeaders as Record<string,string> | undefined;
    const normalized = this.normalizeRequest({ ...request, stream: true });
    if ((normalized as any).__forwardedHeaders) delete (normalized as any).__forwardedHeaders;
    if ((normalized as any).__forwardedHeaders !== undefined) delete (normalized as any).__forwardedHeaders;
    const baseHeaders = forwarded ? this.getHeaders(forwarded) : this.getHeaders();
    const start = performance.now();
    const res = await fetch(url, {
      method: "POST",
      headers: { ...baseHeaders, Accept: "text/event-stream" },
      body: JSON.stringify(normalized),
    });
    const latencyMs = performance.now() - start;

    if (this.id === "opencode" || this.id === "opencode-go") {
      const respHeadersObj: Record<string, string> = {};
      res.headers.forEach((v, k) => { respHeadersObj[k] = v; });
      const safeReqHeaders = { ...baseHeaders };
      if (safeReqHeaders["Authorization"]) safeReqHeaders["Authorization"] = "[REDACTED]";
      void recordOpenCodeAuditLog({
        timestamp: new Date().toISOString(),
        ts: Date.now(),
        provider: this.id,
        model: request.model,
        url,
        stream: true,
        status: res.status,
        latencyMs,
        requestHeaders: safeReqHeaders,
        responseHeaders: respHeadersObj,
        requestSummary: {
          messageCount: Array.isArray(request.messages) ? request.messages.length : 0,
          maxTokens: request.max_tokens,
          temperature: request.temperature,
        },
        responseBodySnippet: res.ok ? "[STREAM_INIT_OK]" : undefined,
      });
    }
    if (!res.ok) {
      const text = await res.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = { error: { message: text, type: "upstream_error", code: String(res.status) } };
      }
      const err = new Error(`Provider ${this.id} stream failed: ${res.status}`);
      (err as any).status = res.status;
      (err as any).body = body;
      throw err;
    }
    if (!res.body) throw new Error(`Provider ${this.id} returned empty stream`);
    // Pass-through without buffering — caller pipes directly to client
    return res.body;
  }

  async health(): Promise<HealthStatus> {
    const start = performance.now();
    try {
      // Try OpenAI-compatible /models endpoint; fallback to baseURL health
      const url = `${this.baseURL}/models`;
      const res = await fetch(url, { method: "GET", headers: this.getHeaders() });
      const latencyMs = performance.now() - start;
      if (res.ok) return { ok: true, latencyMs };
      // If /models returns 404, try base health
      if (res.status === 404) {
        const alt = await fetch(this.baseURL, { method: "GET" }).catch(() => null);
        if (alt && alt.ok) return { ok: true, latencyMs: performance.now() - start };
      }
      return { ok: false, latencyMs, error: `status ${res.status}` };
    } catch (e) {
      return { ok: false, latencyMs: performance.now() - start, error: String(e) };
    }
  }
}

export function createProvider(config: ProviderConfig): ProviderAdapter {
  const normalizedBase = config.baseURL.replace(/\/$/, "");
  // Provider-specific customization
  switch (config.id) {
    case "openrouter":
      return new OpenAICompatibleAdapter(config.id, normalizedBase, config.apiKeyEnv, {
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "MiniRoutingAI",
      });
    case "opencode-go":
    case "opencode_go":
      return new OpenAICompatibleAdapter(config.id, normalizedBase, config.apiKeyEnv);
    case "opencode":
      // OpenCode Free — requires full desktop fingerprint headers to bypass "only usable in OpenCode" restriction
      // Based on live testing: mimo-v2.5-free works with desktop fingerprint; muse-spark & nemotron-ultra fail (500/timeout)
      return new OpenAICompatibleAdapter(config.id, normalizedBase, undefined, {
        "x-opencode-client": "desktop",
        "User-Agent": "opencode-desktop/1.0.0 (Windows NT 10.0; Win64; x64)",
        "x-opencode-version": "1.0.0",
      });
    case "ollama":
      // Ollama OpenAI-compatible endpoint is at /v1, auth usually not required
      return new OpenAICompatibleAdapter(config.id, normalizedBase, config.apiKeyEnv);
    default:
      return new OpenAICompatibleAdapter(config.id, normalizedBase, config.apiKeyEnv);
  }
}

// Provider selection logic — explicit selection without changing server core
export function selectProvider(
  model: string,
  providers: ProviderConfig[],
  providerHint?: string,
): ProviderConfig | null {
  // 1. Explicit hint wins
  if (providerHint) {
    const found = providers.find((p) => p.id === providerHint);
    if (found) return found;
  }

  // 2. Model prefix like "openrouter/anthropic/claude" → provider "openrouter"
  const slashIdx = model.indexOf("/");
  if (slashIdx > 0) {
    const prefix = model.slice(0, slashIdx);
    const byPrefix = providers.find((p) => p.id === prefix);
    if (byPrefix) return byPrefix;
  }

  // 3. Match via models array (support "*" and glob prefix "foo/*")
  for (const p of providers) {
    if (!p.models || p.models.length === 0) continue;
    for (const pattern of p.models) {
      if (pattern === "*") return p; // wildcard matches any if no earlier match
      if (pattern.endsWith("/*")) {
        const prefix = pattern.slice(0, -2);
        if (model.startsWith(prefix + "/") || model === prefix) return p;
        // also handle "openrouter/*" already covered by slash prefix above, but keep
      } else if (pattern === model) {
        return p;
      } else if (pattern.endsWith("*")) {
        // e.g., "llama*"
        const prefix = pattern.slice(0, -1);
        if (model.startsWith(prefix)) return p;
      }
    }
  }

  // 4. Fallback: wildcard provider
  const wildcard = providers.find((p) => p.models?.includes("*"));
  if (wildcard) return wildcard;

  // 5. Single provider fallback
  if (providers.length === 1) return providers[0];

  // 6. First provider as last resort
  return providers[0] ?? null;
}
