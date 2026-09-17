// src/router/router.ts — flat sequential fallback (tanpa guard pre-skip)
// Semua kandidat di routes.json di-hit berurutan sampai sukses; gagal aktual → fallback
import { createProvider, selectProvider } from "../providers/provider.ts";
import { classifyError, shouldFallback } from "./policy.ts";
import { globalHealthStore, HealthStore } from "./health.ts";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../types/index.ts";
import type { ProvidersFile, RoutesFile, RouteTarget, RouteConfig } from "../types/index.ts";
import type { ProviderConfig } from "../types/index.ts";

export interface RouterConfig {
  providers: ProvidersFile;
  routes: RoutesFile;
}

export interface RouteAttempt {
  provider: string;
  model: string;
  success: boolean;
  status?: number;
  errorClass?: string;
  latencyMs?: number;
  skippedDueToCooldown?: boolean;
  skippedDueToContext?: boolean;
}

// Wave 1: Retry-After dari upstream (detik) → ms, untuk cooldown rate_limit
export function extractRetryAfterMs(body: unknown, headers?: any): number | undefined {
  try {
    let raw: unknown = headers?.get?.("retry-after") ?? headers?.["retry-after"];
    if (!raw && body && typeof body === "object") {
      const b: any = body as any;
      raw = b.error?.retry_after ?? b.retry_after ?? b.retryAfter;
    }
    if (raw !== undefined && raw !== null) {
      // Attempt to extract a numeric value for retry-after
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) return n * 1000;
      // HTTP-date format
      const d = Date.parse(String(raw));
      if (!Number.isNaN(d)) return Math.max(0, d - Date.now());
    }
  } catch {}
  // Format "reset after 26s" (juan distributor) — parse dari string body/message,
  // dilakukan walau header/field retry_after tidak ada
  try {
    const serialized = typeof body === "string" ? body : JSON.stringify(body) ?? "";
    const m = /reset after\s+(\d+)\s*s/i.exec(serialized);
    if (m) return Number(m[1]) * 1000;
  } catch {}
  return undefined;
}

export interface RouteResult {
  response?: ChatCompletionResponse;
  stream?: ReadableStream<Uint8Array>;
  provider: string;
  model: string;
  attempts: RouteAttempt[];
  fallbackCount: number;
  retryCount: number;
}

function resolveTargetModel(requestModel: string, targetModel: string): string {
  // If target model is specific, use it; otherwise use request model
  // For simplicity, target model overrides request model
  return targetModel;
}

export function resolveRouteKeyForModel(requestModel: string, routes: RoutesFile): string {
  const normalized = requestModel.split("/").pop() ?? requestModel;
  if (normalized.startsWith("mini-")) {
    // Warning alias legacy agar observability jelas — kanonik kini mini-routingai
    const prefixLower = requestModel.split("/")[0]?.toLowerCase() ?? "";
    if (prefixLower === "mini-9router") {
      // eslint-disable-next-line no-console
      console.warn(`[router] deprecated alias "mini-9router/${normalized}" — gunakan "mini-routingai/${normalized}"`);
    } else if (prefixLower === "miniroutingai" || prefixLower === "minirouting-ai") {
      // eslint-disable-next-line no-console
      console.warn(`[router] alias "MiniRoutingAI/${normalized}" diterima — kanonik "mini-routingai/${normalized}"`);
    }
    // Model "mini-<route>" → route bernama (mis. "mini-free" → "free", "mini-balanced" → "balanced")
    const key = normalized.slice("mini-".length);
    if (routes.routes[key]) return key;
  }
  return routes.defaultRoute ?? Object.keys(routes.routes)[0];
}

function getCandidates(
  routes: RoutesFile,
  providers: ProvidersFile,
  requestModel: string,
  providerHint?: string,
  healthStore?: HealthStore,
): RouteTarget[] {
  const routeKey = resolveRouteKeyForModel(requestModel, routes);
  const route = routes.routes[routeKey];
  if (!route) return [];

  let baseCandidates: RouteTarget[] = [];
  if (route.strategy === "fallback") {
    if (route.primary) baseCandidates.push(route.primary);
    if (route.fallbacks) baseCandidates.push(...route.fallbacks);
  } else if (route.strategy === "round-robin") {
    baseCandidates = route.models ?? [];
  } else if (route.strategy === "weighted-round-robin" || route.strategy === "cache-aware-sticky") {
    if (route.primary) baseCandidates.push(route.primary);
    if (route.fallbacks) baseCandidates.push(...route.fallbacks);
  }

  // Alias model → route bernama di-resolve oleh resolveRouteKeyForModel ("mini-balanced" → "balanced", "mini-free" → "free").

  // Explicit provider selection via model prefix atau hint
  const explicit = selectProvider(requestModel, providers.providers, providerHint);
  if (explicit) {
    const isExplicitPrefix =
      (providerHint && explicit.id === providerHint) ||
      requestModel.startsWith(explicit.id + "/") ||
      (explicit.models?.some((p) => p !== "*" && (requestModel === p || requestModel.startsWith(p.replace("/*", "/")))) ?? false);

    if (isExplicitPrefix) {
      const primary = baseCandidates[0];
      const isSameAsPrimary = primary && primary.provider === explicit.id && primary.model === requestModel;
      if (!isSameAsPrimary) {
        return [{ provider: explicit.id, model: requestModel }];
      }
    }
  }

  // Health-aware ordering dinonaktifkan: flat list tanpa guard pre-skip
  // weight/healthAwareOrdering/minHealthyCandidates diabaikan — semua kandidat di-hit berurutan

  return baseCandidates;
}

function findProviderConfig(providers: ProvidersFile, providerId: string) {
  return providers.providers.find((p) => p.id === providerId) ?? null;
}

function isUnavailableSignal(body: unknown, message: string): boolean {
  const combined = `${message ?? ""} ${body ? JSON.stringify(body) : ""}`.toLowerCase();
  return (
    combined.includes("unavailable") ||
    combined.includes("service_unavailable") ||
    combined.includes("service temporarily overloaded") ||
    combined.includes("temporarily overloaded") ||
    combined.includes("capacity") ||
    combined.includes("overloaded") ||
    combined.includes("upstream request failed") ||
    combined.includes("no available channel") ||
    combined.includes("rate limit") ||
    combined.includes("too many requests") ||
    combined.includes("aborted") ||
    combined.includes("aborterror")
  );
}

function isMissingSessionSignal(body: unknown, message: string): boolean {
  const combined = `${message ?? ""} ${body ? JSON.stringify(body) : ""}`.toLowerCase();
  return combined.includes("x-opencode-session") || combined.includes("cannot be routed efficiently");
}

function isFreeTierRestrictedSignal(body: unknown, message: string): boolean {
  const combined = `${message ?? ""} ${body ? JSON.stringify(body) : ""}`.toLowerCase();
  return combined.includes("free tier") && combined.includes("can only be used in opencode");
}

// Wave 6: timeout adaptif — payload besar butuh TTFT lebih lama (reasoning model 160K tok ≈ 30-60s).
// timeout = max(base, min(estTokens × tokensPerMs, maxMs)). Payload kecil → base tetap.
export function computeAdaptiveTimeout(
  baseMs: number,
  estimatedTokens: number,
  cfg?: { enabled?: boolean; tokensPerMs?: number; maxMs?: number } | boolean,
): number {
  if (!cfg) return baseMs;
  const enabled = typeof cfg === "boolean" ? cfg : cfg.enabled !== false;
  if (!enabled) return baseMs;
  const tokensPerMs = (typeof cfg === "object" && typeof cfg.tokensPerMs === "number" && cfg.tokensPerMs > 0) ? cfg.tokensPerMs : 0.25;
  const maxMs = (typeof cfg === "object" && typeof cfg.maxMs === "number" && cfg.maxMs > 0) ? cfg.maxMs : 90_000;
  const adaptive = Math.min(estimatedTokens * tokensPerMs, maxMs);
  return Math.max(baseMs, Math.min(adaptive, maxMs));
}

// Wave 6: context window per provider (default) + override per model.
export function getContextWindow(providers: ProvidersFile, providerId: string, model: string): number | null {
  const cfg = providers.providers.find((p) => p.id === providerId);
  if (!cfg) return null;
  const perModel = (cfg as any).contextWindows?.[model];
  if (typeof perModel === "number") return perModel;
  const providerDefault = (cfg as any).contextWindow;
  return typeof providerDefault === "number" ? providerDefault : null;
}

/** @deprecated Flat sequential tanpa guard pre-skip — semua kandidat di-hit berurutan */
function orderCandidatesByContextWindow(candidates: RouteTarget[], _providers: ProvidersFile): RouteTarget[] {
  return [...candidates];
}

export interface StickyCacheEntry {
  currentTarget: RouteTarget;
  requestCount: number;
  lastActiveTs: number;
}

export class StickyCacheStore {
  private cache = new Map<string, StickyCacheEntry>();

  get(sessionKey: string, ttlMs: number = 300_000): StickyCacheEntry | undefined {
    const state = this.cache.get(sessionKey);
    if (!state) return undefined;
    if (Date.now() - state.lastActiveTs > ttlMs) {
      this.cache.delete(sessionKey);
      return undefined;
    }
    return state;
  }

  set(sessionKey: string, target: RouteTarget): void {
    const existing = this.cache.get(sessionKey);
    this.cache.set(sessionKey, {
      currentTarget: target,
      requestCount: existing ? existing.requestCount + 1 : 1,
      lastActiveTs: Date.now(),
    });
  }

  clear(): void {
    this.cache.clear();
  }
}

export const globalStickyCacheStore = new StickyCacheStore();

export class Router {
  private healthStore: HealthStore;
  private stickyStore: StickyCacheStore;
  private timeoutMs: number;

  constructor(
    private config: RouterConfig,
    opts?: { healthStore?: HealthStore; stickyStore?: StickyCacheStore; timeoutMs?: number },
  ) {
    this.healthStore = opts?.healthStore ?? globalHealthStore;
    this.stickyStore = opts?.stickyStore ?? globalStickyCacheStore;
    // timeout from route or default 8000
    const defaultRoute = this.config.routes.routes[this.config.routes.defaultRoute];
    this.timeoutMs = opts?.timeoutMs ?? defaultRoute?.timeoutMs ?? 8000;
  }

  private getSessionKey(request: ChatCompletionRequest): string {
    const forwardedHeaders = (request as any).__forwardedHeaders as Record<string, string> | undefined;
    return forwardedHeaders?.["x-opencode-session"] ?? 
           forwardedHeaders?.["x-request-id"] ?? 
           "default-session";
  }

  private isTargetHealthy(target: RouteTarget): boolean {
    return this.healthStore.isHealthy(target.provider, target.model);
  }

  private orderCandidatesForSticky(
    sessionKey: string,
    candidates: RouteTarget[],
    route: RouteConfig,
  ): RouteTarget[] {
    // Sticky pasca-sukses saja: pindahkan target sukses terakhir ke indeks 0 tanpa health check
    const ttlMs = (route as any)?.optimizers?.cacheAffinity?.sessionTtlMs ?? 300_000;
    const sticky = this.stickyStore.get(sessionKey, ttlMs);
    if (!sticky) return [...candidates];
    const current = sticky.currentTarget;
    const foundIndex = candidates.findIndex((c) => c.provider === current.provider && c.model === current.model);
    if (foundIndex === -1) return [...candidates];
    const primary = candidates[foundIndex];
    const rest = candidates.filter((_, idx) => idx !== foundIndex);
    if (route.sameProviderFallback !== false) {
      const sameProviderRest = rest.filter((c) => c.provider === primary.provider);
      const otherProviderRest = rest.filter((c) => c.provider !== primary.provider);
      return [primary, ...sameProviderRest, ...otherProviderRest];
    }
    return [primary, ...rest];
  }

  // R5: provider butuh session diambil dari config (requiresSession), bukan hardcode id.
  // Fallback legacy hardcode hanya jika providers.json belum punya flag (kompatibilitas).
  private providerRequiresSession(providerId: string): boolean {
    const cfg = findProviderConfig(this.config.providers, providerId);
    if (cfg && cfg.requiresSession !== undefined) return cfg.requiresSession;
    return providerId === "opencode" || providerId === "opencode-go";
  }

  async routeChat(request: ChatCompletionRequest): Promise<RouteResult> {
    const providerHint = (request as any).provider as string | undefined;
    const route = this.config.routes.routes[resolveRouteKeyForModel(request.model, this.config.routes)];
    
    const candidates = getCandidates(this.config.routes, this.config.providers, request.model, providerHint, this.healthStore);
    if (candidates.length === 0) {
      throw Object.assign(new Error("No route candidates"), { status: 404, body: { error: { message: "No route configured", type: "invalid_request_error" } } });
    }

    const attempts: RouteAttempt[] = [];
    let fallbackCount = 0;
    let retryCount = 0;
    let firstError: any = null;
    // estTokens hanya untuk adaptive timeout (bukan guard pre-skip)
    const estTokens = Math.ceil(Buffer.byteLength(JSON.stringify(request), "utf-8") / 4);
    const effTimeoutMs = computeAdaptiveTimeout(route?.timeoutMs ?? this.timeoutMs, estTokens, (route as any)?.adaptiveTimeout);

    const isSticky = route?.strategy === "cache-aware-sticky";
    const sessionKey = this.getSessionKey(request);

    // Flat list tanpa guard pre-skip: primary + fallbacks sesuai urutan config
    let remainingCandidates = [...candidates];
    if (isSticky) {
      remainingCandidates = this.orderCandidatesForSticky(sessionKey, remainingCandidates, route);
    }

    while (remainingCandidates.length > 0) {
      // Sequential flat list — selalu ambil indeks 0
      const target: RouteTarget = remainingCandidates[0];
      const targetIndex = 0;

      const isFallback = attempts.length > 0;

      const providerCfg = findProviderConfig(this.config.providers, target.provider);
      if (!providerCfg) {
        attempts.push({ provider: target.provider, model: target.model, success: false, errorClass: "deterministic" });
        if (!firstError) firstError = Object.assign(new Error(`Provider ${target.provider} not found`), { status: 404 });
        remainingCandidates.splice(targetIndex, 1);
        continue;
      }

      const adapter = createProvider(providerCfg);
      const routedRequest: ChatCompletionRequest = {
        ...request,
        model: resolveTargetModel(request.model, target.model),
        stream: false,
        ...(target.providers ? { __providerOrder: target.providers, __openrouterProviders: target.providers } as any : {}),
        ...(target.reasoning ? { __reasoning: target.reasoning } as any : {}),
      };

      const start = performance.now();
      try {
        // Timeout via AbortSignal (Wave 6: adaptif terhadap payload)
        const timeoutSignal = AbortSignal.timeout(effTimeoutMs);
        // Note: adapter.chat doesn't currently accept signal; we wrap with Promise.race for timeout
        const chatPromise = adapter.chat(routedRequest);
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(Object.assign(new Error("timeout"), { status: 408 })), effTimeoutMs),
        );
        // Use race, but also respect abort signal if adapter supports it in future
        void timeoutSignal; // suppress unused

        const response = await Promise.race([chatPromise, timeoutPromise]);
        const latencyMs = performance.now() - start;
        this.healthStore.markSuccess(target.provider, target.model);
        if (isSticky) {
          this.stickyStore.set(sessionKey, target);
        }
        attempts.push({ provider: target.provider, model: target.model, success: true, status: 200, latencyMs });
        return {
          response,
          provider: target.provider,
          model: target.model,
          attempts,
          fallbackCount,
          retryCount,
        };
      } catch (err: any) {
        const latencyMs = performance.now() - start;
        const status: number | undefined = err.status;
        const body = err.body;
        const message = err.message ?? "";
        const errorClass = classifyError(status, body, message);
        attempts.push({
          provider: target.provider,
          model: target.model,
          success: false,
          status,
          errorClass,
          latencyMs,
        });

        // Record health based on error class — untuk "Model is unavailable" langsung cooldown agar looping tidak terjadi
        if (errorClass === "transient" || errorClass === "credential" || errorClass === "unknown" || errorClass === "rate_limit" || errorClass === "timeout" || errorClass === "server_error" || errorClass === "context_overflow") {
          const isUnavailable = isUnavailableSignal(body, message) || isMissingSessionSignal(body, message) || isFreeTierRestrictedSignal(body, message);
          // Weekly usage limit (Ollama 429 weekly quota) → cooldown 1 jam agar tidak retry tiap 20s
          let retryAfter = extractRetryAfterMs(body, err.headers);
          const lower = `${message ?? ""} ${body ? JSON.stringify(body) : ""}`.toLowerCase();
          if (!retryAfter && lower.includes("weekly usage limit")) retryAfter = 3_600_000;
          else if (!retryAfter && lower.includes("usage limit")) retryAfter = 600_000;
          // Kuota saldo/account habis (insufficient_user_quota / credit insufficient / prompt tokens limit) — PERSISTEN sampai top-up.
          // Hint "reset after Ns" dari distributor adalah reset slot request, BUKAN isi ulang saldo → cooldown panjang,
          // jangan biarkan provider menjadi honeypot yang menghantam ulang dan melempar 503 tiap ~20s.
          if (lower.includes("insufficient balance") || lower.includes("insufficient_user_quota") || lower.includes("credit insufficient") || lower.includes("no credit") || lower.includes("prompt tokens limit exceeded") || lower.includes("openrouter.ai/settings/credits")) retryAfter = 600_000;
          this.healthStore.markFailure(target.provider, target.model, errorClass, { isUnavailable, retryAfterMs: retryAfter });
          if (isMissingSessionSignal(body, message)) {
            // Log hint untuk missing session agar observability jelas
            // eslint-disable-next-line no-console
            console.warn(`[router] missing x-opencode-session for ${target.provider}/${target.model} - akan fallback`);
          }
          if (isFreeTierRestrictedSignal(body, message)) {
            // eslint-disable-next-line no-console
            console.warn(`[router] free tier restricted for ${target.provider}/${target.model} — akan fallback ke non-free`);
          }
        } else if (errorClass === "deterministic") {
          // Don't mark failure for deterministic (don't penalize provider)
        }

        if (!firstError) firstError = err;
        // Attach attempts to error for server to log observability
        (err as any).attempts = [...attempts];

        // Decide whether to fallback
        if (shouldFallback(errorClass)) {
          remainingCandidates.splice(targetIndex, 1);
          if (remainingCandidates.length > 0) {
            fallbackCount++;
            // Optional backoff
            const backoff = route?.retry?.backoffMs ?? 0;
            if (backoff > 0) await new Promise((r) => setTimeout(r, backoff));
            continue; // try next candidate
          } else {
            // No more candidates — throw last error with attempts
            throw err;
          }
        } else {
          // Deterministic or credential — do not retry/fallback
          throw err;
        }
      }
    }

    // Graceful 413 jika semua provider benar-benar mengembalikan context_overflow (bukan pre-skip)
    const isAllContextOverflowChat = attempts.length > 0 && attempts.every((a) => a.errorClass === "context_overflow");
    if (isAllContextOverflowChat) {
      const maxWindow = Math.max(0, ...candidates.map((c) => getContextWindow(this.config.providers, c.provider, c.model) ?? 0));
      const err: any = Object.assign(new Error(`All providers context_overflow: estTokens ${estTokens} exceeds max window ${maxWindow}`), {
        status: 413,
        body: {
          error: {
            message: `Prompt too large: ~${estTokens} tokens exceeds max context window ${maxWindow}. Kurangi riwayat tool atau pakai model 1M (minimax-m3/gemini).`,
            type: "invalid_request_error",
            code: "context_overflow",
            estTokens,
            maxWindow,
            attempts,
          },
        },
        attempts,
      });
      err.attempts = attempts;
      throw err;
    }
    // All candidates skipped or failed - attach attempts if possible
    if (firstError) {
      (firstError as any).attempts = attempts;
      throw firstError;
    }
    throw Object.assign(new Error("All providers failed or skipped due to cooldown"), { status: 502, attempts });
  }

  async routeStream(request: ChatCompletionRequest): Promise<RouteResult> {
    const providerHint = (request as any).provider as string | undefined;
    const route = this.config.routes.routes[resolveRouteKeyForModel(request.model, this.config.routes)];
    
    const candidates = getCandidates(this.config.routes, this.config.providers, request.model, providerHint, this.healthStore);
    if (candidates.length === 0) {
      throw Object.assign(new Error("No route candidates"), { status: 404 });
    }

    const attempts: RouteAttempt[] = [];
    let fallbackCount = 0;
    // estTokens hanya untuk adaptive timeout (bukan guard pre-skip)
    const estTokens = Math.ceil(Buffer.byteLength(JSON.stringify(request), "utf-8") / 4);
    const effTimeoutMs = computeAdaptiveTimeout(route?.timeoutMs ?? this.timeoutMs, estTokens, (route as any)?.adaptiveTimeout);

    const isSticky = route?.strategy === "cache-aware-sticky";
    const sessionKey = this.getSessionKey(request);

    // Flat list tanpa guard pre-skip: primary + fallbacks sesuai urutan config
    let remainingCandidates = [...candidates];
    if (isSticky) {
      remainingCandidates = this.orderCandidatesForSticky(sessionKey, remainingCandidates, route);
    }

    while (remainingCandidates.length > 0) {
      // Sequential flat list — selalu ambil indeks 0
      const target: RouteTarget = remainingCandidates[0];
      const targetIndex = 0;

      const isFallback = attempts.length > 0;

      const providerCfg = findProviderConfig(this.config.providers, target.provider);
      if (!providerCfg) {
        attempts.push({ provider: target.provider, model: target.model, success: false, errorClass: "deterministic" });
        remainingCandidates.splice(targetIndex, 1);
        continue;
      }

      const adapter = createProvider(providerCfg);
      const routedRequest: ChatCompletionRequest = {
        ...request,
        model: resolveTargetModel(request.model, target.model),
        stream: true,
        ...(target.providers ? { __providerOrder: target.providers, __openrouterProviders: target.providers } as any : {}),
        ...(target.reasoning ? { __reasoning: target.reasoning } as any : {}),
      };

      const start = performance.now();
      try {
        // Wave 6: bungkus handshake stream (s.d. headers) dengan timeout adaptif
        const stream = await Promise.race([
          adapter.stream(routedRequest),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(Object.assign(new Error("timeout"), { status: 408 })), effTimeoutMs),
          ),
        ]);
        const latencyMs = performance.now() - start;
        // Stream success is determined before any data — mark success
        this.healthStore.markSuccess(target.provider, target.model);
        if (isSticky) {
          this.stickyStore.set(sessionKey, target);
        }
        attempts.push({ provider: target.provider, model: target.model, success: true, status: 200, latencyMs });
        return {
          stream,
          provider: target.provider,
          model: target.model,
          attempts,
          fallbackCount,
          retryCount: 0,
        };
      } catch (err: any) {
        const latencyMs = performance.now() - start;
        const status: number | undefined = err.status;
        const body = err.body;
        const message = err.message ?? "";
        const errorClass = classifyError(status, body, message);
        attempts.push({ provider: target.provider, model: target.model, success: false, status, errorClass, latencyMs });

        if (errorClass === "transient" || errorClass === "credential" || errorClass === "unknown" || errorClass === "rate_limit" || errorClass === "timeout" || errorClass === "server_error" || errorClass === "context_overflow") {
          const isUnavailable = isUnavailableSignal(body, message) || isMissingSessionSignal(body, message) || isFreeTierRestrictedSignal(body, message);
          let retryAfter = extractRetryAfterMs(body, err.headers);
          const lower2 = `${message ?? ""} ${body ? JSON.stringify(body) : ""}`.toLowerCase();
          if (!retryAfter && lower2.includes("weekly usage limit")) retryAfter = 3_600_000;
          else if (!retryAfter && lower2.includes("usage limit")) retryAfter = 600_000;
          // Kuota saldo/account habis (insufficient_user_quota / credit insufficient / prompt tokens limit) — PERSISTEN sampai top-up.
          // Hint "reset after Ns" dari distributor adalah reset slot request, BUKAN isi ulang saldo → cooldown panjang,
          // jangan biarkan provider menjadi honeypot yang menghantam ulang dan melempar 503 tiap ~20s.
          if (lower2.includes("insufficient balance") || lower2.includes("insufficient_user_quota") || lower2.includes("credit insufficient") || lower2.includes("no credit") || lower2.includes("prompt tokens limit exceeded") || lower2.includes("openrouter.ai/settings/credits")) retryAfter = 600_000;
          this.healthStore.markFailure(target.provider, target.model, errorClass, { isUnavailable, retryAfterMs: retryAfter });
          if (isMissingSessionSignal(body, message)) {
            // eslint-disable-next-line no-console
            console.warn(`[router] missing x-opencode-session for ${target.provider}/${target.model} (stream) — akan fallback`);
          }
          if (isFreeTierRestrictedSignal(body, message)) {
            // eslint-disable-next-line no-console
            console.warn(`[router] free tier restricted for ${target.provider}/${target.model} (stream) — akan fallback`);
          }
        }

        (err as any).attempts = [...attempts];

        if (shouldFallback(errorClass)) {
          remainingCandidates.splice(targetIndex, 1);
          if (remainingCandidates.length > 0) {
            fallbackCount++;
            const backoff = route?.retry?.backoffMs ?? 0;
            if (backoff > 0) await new Promise((r) => setTimeout(r, backoff));
            continue;
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }
    }

    const isAllContextOverflowStream = attempts.length > 0 && attempts.every((a) => a.errorClass === "context_overflow");
    // Jika semua provider benar-benar mengembalikan context_overflow/timeout/rate_limit (bukan pre-skip),
    // payload memang terlalu besar untuk semua model yang dicoba.
    const maxWindowAmongCandidates = Math.max(0, ...candidates.map((c) => getContextWindow(this.config.providers, c.provider, c.model) ?? 0));
    const allProvidersFailedOrUnavailable = attempts.length > 0 && attempts.every(
      (a) => a.errorClass === "context_overflow" || a.errorClass === "cooldown" || a.errorClass === "timeout" || a.errorClass === "rate_limit",
    );
    const isContextOverflowRootCause = isAllContextOverflowStream || (allProvidersFailedOrUnavailable && maxWindowAmongCandidates > 0 && estTokens * 1.05 > maxWindowAmongCandidates);
    if (isContextOverflowRootCause) {
      const maxWindow = maxWindowAmongCandidates;
      const err: any = Object.assign(new Error(`All stream providers context_overflow: estTokens ${estTokens} exceeds max available window ${maxWindow}`), {
        status: 413,
        body: {
          error: {
            message: `Stream prompt too large: ~${estTokens} tokens exceeds max available context window ${maxWindow}. Provider dengan window besar (minimax-m3) sedang unavailable. Kurangi riwayat atau tunggu beberapa saat.`,
            type: "invalid_request_error",
            code: "context_overflow",
            estTokens,
            maxWindow,
            attempts,
          },
        },
        attempts,
      });
      err.attempts = attempts;
      throw err;
    }
    throw Object.assign(new Error("All stream providers failed or cooldown"), { status: 502, attempts });
  }
}
