// src/providers/provider.ts — ProviderAdapter abstraction Phase 2
import type { ChatCompletionRequest, ChatCompletionResponse, ChatCompletionChunk } from "../types/index.ts";
import { prepareOpenAIRequest } from "../translator/request.ts";

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

  protected getHeaders(): Record<string, string> {
    return getHeaders(this.getApiKey(), this.extraHeaders);
  }

  protected normalizeRequest(request: ChatCompletionRequest): ChatCompletionRequest {
    // Normalisasi OpenAI + provider quirks (registry), termasuk stream_options.include_usage.
    return prepareOpenAIRequest(request, this.id) as ChatCompletionRequest;
  }

  async chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const url = `${this.baseURL}/chat/completions`;
    const normalized = this.normalizeRequest({ ...request, stream: false });
    const res = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(normalized),
    });
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
    const normalized = this.normalizeRequest({ ...request, stream: true });
    const res = await fetch(url, {
      method: "POST",
      headers: { ...this.getHeaders(), Accept: "text/event-stream" },
      body: JSON.stringify(normalized),
    });
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
      // OpenCode Free — noAuth, transport headers x-opencode-client
      return new OpenAICompatibleAdapter(config.id, normalizedBase, undefined, {
        "x-opencode-client": "desktop",
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
