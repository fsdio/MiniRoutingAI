// src/router/router.ts — deterministic fallback router Phase 3
import { createProvider, selectProvider } from "../providers/provider.ts";
import { classifyError, shouldFallback, sortCandidatesByHealth, selectWeightedRandom } from "./policy.ts";
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
    if (raw === undefined || raw === null) return undefined;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n * 1000;
    // HTTP-date format
    const d = Date.parse(String(raw));
    if (!Number.isNaN(d)) return Math.max(0, d - Date.now());
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

  // Health-aware ordering for weighted-round-robin
  if (route.strategy === "weighted-round-robin" && route.healthAwareOrdering && healthStore) {
    const requestTags = route.modelHints ?? [];
    baseCandidates = sortCandidatesByHealth(
      baseCandidates,
      healthStore,
      providers.providers,
      requestTags,
      route.minHealthyCandidates
    );
  }

  return baseCandidates;
}

function findProviderConfig(providers: ProvidersFile, providerId: string) {
  return providers.providers.find((p) => p.id === providerId) ?? null;
}

function isUnavailableSignal(body: unknown, message: string): boolean {
  const combined = `${message ?? ""} ${body ? JSON.stringify(body) : ""}`.toLowerCase();
  return (
    combined.includes("unavailable") ||
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
    const ttlMs = (route as any)?.optimizers?.cacheAffinity?.sessionTtlMs ?? 300_000;
    const sticky = this.stickyStore.get(sessionKey, ttlMs);
    if (!sticky) {
      return [...candidates];
    }

    const current = sticky.currentTarget;
    const isHealthy = this.isTargetHealthy(current);
    const foundIndex = candidates.findIndex((c) => c.provider === current.provider && c.model === current.model);

    if (isHealthy && foundIndex !== -1) {
      const primary = candidates[foundIndex];
      const rest = candidates.filter((_, idx) => idx !== foundIndex);
      if (route.sameProviderFallback !== false) {
        const sameProviderRest = rest.filter((c) => c.provider === primary.provider);
        const otherProviderRest = rest.filter((c) => c.provider !== primary.provider);
        return [primary, ...sameProviderRest, ...otherProviderRest];
      }
      return [primary, ...rest];
    } else if (foundIndex !== -1 && route.sameProviderFallback !== false) {
      const sameProvider = candidates.filter((c) => c.provider === current.provider && (c.model !== current.model || isHealthy));
      const otherProvider = candidates.filter((c) => c.provider !== current.provider);
      return [...sameProvider, ...otherProvider];
    }

    return [...candidates];
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
    let cooldownWaited = false;
    // Wave 6: estimasi ukuran payload untuk adaptive timeout & contextWindow guard
    const estTokens = Math.ceil(Buffer.byteLength(JSON.stringify(request), "utf-8") / 4);
    const effTimeoutMs = computeAdaptiveTimeout(route?.timeoutMs ?? this.timeoutMs, estTokens, (route as any)?.adaptiveTimeout);

    // For weighted-round-robin, we select candidates dynamically
    const isWeightedRoundRobin = route?.strategy === "weighted-round-robin";
    const isSticky = route?.strategy === "cache-aware-sticky";
    const sessionKey = this.getSessionKey(request);

    let remainingCandidates = [...candidates];
    if (isSticky) {
      remainingCandidates = this.orderCandidatesForSticky(sessionKey, remainingCandidates, route);
    }

    while (remainingCandidates.length > 0 || !cooldownWaited) {
      if (remainingCandidates.length === 0) {
        // Semua kandidat di-skip karena cooldown: tunggu cooldown terpendek (maks 10s)
        // lalu coba sekali lagi, daripada langsung 502 dan biarkan client retry membabi-buta.
        cooldownWaited = true;
        const remaining = candidates
          .map((c) => this.healthStore.getCooldownRemainingMs(c.provider, c.model))
          .filter((ms) => ms > 0);
        const waitMs = remaining.length > 0 ? Math.min(Math.min(...remaining) + 50, 10_000) : 0;
        if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
        remainingCandidates = [...candidates];
        if (remainingCandidates.length === 0) break;
        continue;
      }
      // Select next candidate: weighted random for weighted-round-robin, sequential for fallback
      let target: RouteTarget;
      let targetIndex: number;
      
      if (isWeightedRoundRobin) {
        target = selectWeightedRandom(remainingCandidates, this.healthStore, this.config.providers.providers, route.modelHints) ?? remainingCandidates[0];
        targetIndex = remainingCandidates.findIndex((c) => c.provider === target.provider && c.model === target.model);
      } else {
        target = remainingCandidates[0];
        targetIndex = 0;
      }

      const isFallback = attempts.some((a) => a.success) || attempts.length > 0;

      // Health check: skip if in cooldown
      if (!this.healthStore.isHealthy(target.provider, target.model)) {
        attempts.push({
          provider: target.provider,
          model: target.model,
          success: false,
          skippedDueToCooldown: true,
          errorClass: "cooldown",
        });
        if (isFallback) fallbackCount++;
        remainingCandidates.splice(targetIndex, 1);
        continue;
      }

      const providerCfg = findProviderConfig(this.config.providers, target.provider);
      if (!providerCfg) {
        attempts.push({ provider: target.provider, model: target.model, success: false, errorClass: "deterministic" });
        if (!firstError) firstError = Object.assign(new Error(`Provider ${target.provider} not found`), { status: 404 });
        remainingCandidates.splice(targetIndex, 1);
        continue;
      }

      // Wave 6: contextWindow guard — jangan bakar token di model yang pasti gagal muat
      const ctxWindow = getContextWindow(this.config.providers, target.provider, target.model);
      if (ctxWindow !== null && estTokens * 1.1 > ctxWindow) {
        attempts.push({ provider: target.provider, model: target.model, success: false, errorClass: "context_overflow", skippedDueToContext: true });
        remainingCandidates.splice(targetIndex, 1);
        continue;
      }

      const adapter = createProvider(providerCfg);
      const routedRequest: ChatCompletionRequest = {
        ...request,
        model: resolveTargetModel(request.model, target.model),
        stream: false,
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
    let cooldownWaited = false;
    // Wave 6: estTokens + adaptive timeout (stream path — TTFT reasoning butuh waktu)
    const estTokens = Math.ceil(Buffer.byteLength(JSON.stringify(request), "utf-8") / 4);
    const effTimeoutMs = computeAdaptiveTimeout(route?.timeoutMs ?? this.timeoutMs, estTokens, (route as any)?.adaptiveTimeout);

    const isWeightedRoundRobin = route?.strategy === "weighted-round-robin";
    const isSticky = route?.strategy === "cache-aware-sticky";
    const sessionKey = this.getSessionKey(request);

    let remainingCandidates = [...candidates];
    if (isSticky) {
      remainingCandidates = this.orderCandidatesForSticky(sessionKey, remainingCandidates, route);
    }

    while (remainingCandidates.length > 0 || !cooldownWaited) {
      if (remainingCandidates.length === 0) {
        // Semua kandidat di-skip karena cooldown: tunggu cooldown terpendek (maks 10s)
        // lalu coba sekali lagi, daripada langsung 502 dan biarkan client retry membabi-buta.
        cooldownWaited = true;
        const remaining = candidates
          .map((c) => this.healthStore.getCooldownRemainingMs(c.provider, c.model))
          .filter((ms) => ms > 0);
        const waitMs = remaining.length > 0 ? Math.min(Math.min(...remaining) + 50, 10_000) : 0;
        if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
        remainingCandidates = [...candidates];
        if (remainingCandidates.length === 0) break;
        continue;
      }
      let target: RouteTarget;
      let targetIndex: number;
      
      if (isWeightedRoundRobin) {
        target = selectWeightedRandom(remainingCandidates, this.healthStore, this.config.providers.providers, route.modelHints) ?? remainingCandidates[0];
        targetIndex = remainingCandidates.findIndex((c) => c.provider === target.provider && c.model === target.model);
      } else {
        target = remainingCandidates[0];
        targetIndex = 0;
      }

      const isFallback = attempts.some((a) => a.success) || attempts.length > 0;

      if (!this.healthStore.isHealthy(target.provider, target.model)) {
        attempts.push({ provider: target.provider, model: target.model, success: false, skippedDueToCooldown: true, errorClass: "cooldown" });
        if (isFallback) fallbackCount++;
        remainingCandidates.splice(targetIndex, 1);
        continue;
      }

      const providerCfg = findProviderConfig(this.config.providers, target.provider);
      if (!providerCfg) {
        attempts.push({ provider: target.provider, model: target.model, success: false, errorClass: "deterministic" });
        remainingCandidates.splice(targetIndex, 1);
        continue;
      }

      // Wave 6: contextWindow guard (stream)
      const ctxWindowS = getContextWindow(this.config.providers, target.provider, target.model);
      if (ctxWindowS !== null && estTokens * 1.1 > ctxWindowS) {
        attempts.push({ provider: target.provider, model: target.model, success: false, errorClass: "context_overflow", skippedDueToContext: true });
        remainingCandidates.splice(targetIndex, 1);
        continue;
      }

      const adapter = createProvider(providerCfg);
      const routedRequest: ChatCompletionRequest = {
        ...request,
        model: resolveTargetModel(request.model, target.model),
        stream: true,
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

    throw Object.assign(new Error("All stream providers failed or cooldown"), { status: 502, attempts });
  }
}
