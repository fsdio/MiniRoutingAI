// src/router/router.ts — deterministic fallback router Phase 3
import { createProvider, selectProvider } from "../providers/provider.ts";
import { classifyError, shouldFallback, sortCandidatesByHealth, selectWeightedRandom } from "./policy.ts";
import { globalHealthStore, HealthStore } from "./health.ts";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../types/index.ts";
import type { ProvidersFile, RoutesFile, RouteTarget } from "../types/index.ts";
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

function getCandidates(
  routes: RoutesFile,
  providers: ProvidersFile,
  requestModel: string,
  providerHint?: string,
  healthStore?: HealthStore,
): RouteTarget[] {
  const defaultRouteName = routes.defaultRoute ?? Object.keys(routes.routes)[0];
  const route = routes.routes[defaultRouteName];
  if (!route) return [];

  let baseCandidates: RouteTarget[] = [];
  if (route.strategy === "fallback") {
    if (route.primary) baseCandidates.push(route.primary);
    if (route.fallbacks) baseCandidates.push(...route.fallbacks);
  } else if (route.strategy === "round-robin") {
    baseCandidates = route.models ?? [];
  } else if (route.strategy === "weighted-round-robin") {
    if (route.primary) baseCandidates.push(route.primary);
    if (route.fallbacks) baseCandidates.push(...route.fallbacks);
  }

  // Virtual route: mini-balanced adalah alias untuk balanced chain (gateway MiniRoutingAI / mini-routingai).
  // Tangani semua varian: "mini-balanced", "mini-9router/mini-balanced", "mini-routingai/mini-balanced", "MiniRoutingAI/mini-balanced" (case-insensitive)
  const normalizedModel = requestModel.split("/").pop() ?? requestModel;
  if (normalizedModel === "mini-balanced" || normalizedModel === "mini-balanced-cloud") {
    // Warning untuk alias legacy agar observability jelas — kanonik kini mini-routingai
    const prefixLower = requestModel.split("/")[0]?.toLowerCase() ?? "";
    if (prefixLower === "mini-9router") {
      // eslint-disable-next-line no-console
      console.warn(`[router] deprecated alias "mini-9router/${normalizedModel}" — gunakan "mini-routingai/${normalizedModel}"`);
    } else if (prefixLower === "miniroutingai" || prefixLower === "minirouting-ai") {
      // eslint-disable-next-line no-console
      console.warn(`[router] alias "MiniRoutingAI/${normalizedModel}" diterima — kanonik "mini-routingai/${normalizedModel}"`);
    }
    return baseCandidates;
  }

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

export class Router {
  private healthStore: HealthStore;
  private timeoutMs: number;

  constructor(
    private config: RouterConfig,
    opts?: { healthStore?: HealthStore; timeoutMs?: number },
  ) {
    this.healthStore = opts?.healthStore ?? globalHealthStore;
    // timeout from route or default 8000
    const defaultRoute = this.config.routes.routes[this.config.routes.defaultRoute];
    this.timeoutMs = opts?.timeoutMs ?? defaultRoute?.timeoutMs ?? 8000;
  }

  async routeChat(request: ChatCompletionRequest): Promise<RouteResult> {
    const providerHint = (request as any).provider as string | undefined;
    const defaultRouteName = this.config.routes.defaultRoute ?? Object.keys(this.config.routes.routes)[0];
    const route = this.config.routes.routes[defaultRouteName];
    
    const candidates = getCandidates(this.config.routes, this.config.providers, request.model, providerHint, this.healthStore);
    if (candidates.length === 0) {
      throw Object.assign(new Error("No route candidates"), { status: 404, body: { error: { message: "No route configured", type: "invalid_request_error" } } });
    }

    const attempts: RouteAttempt[] = [];
    let fallbackCount = 0;
    let retryCount = 0;
    let firstError: any = null;

    // For weighted-round-robin, we select candidates dynamically
    const isWeightedRoundRobin = route?.strategy === "weighted-round-robin";
    let remainingCandidates = [...candidates];

    while (remainingCandidates.length > 0) {
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

      const adapter = createProvider(providerCfg);
      const routedRequest: ChatCompletionRequest = {
        ...request,
        model: resolveTargetModel(request.model, target.model),
        stream: false,
      };

      const start = performance.now();
      try {
        // Timeout via AbortSignal
        const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
        // Note: adapter.chat doesn't currently accept signal; we wrap with Promise.race for timeout
        const chatPromise = adapter.chat(routedRequest);
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(Object.assign(new Error("timeout"), { status: 408 })), this.timeoutMs),
        );
        // Use race, but also respect abort signal if adapter supports it in future
        void timeoutSignal; // suppress unused

        const response = await Promise.race([chatPromise, timeoutPromise]);
        const latencyMs = performance.now() - start;
        this.healthStore.markSuccess(target.provider, target.model);
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

        // Record health based on error class — untuk "Model is unavailable" langsung cooldown agar lopping tidak terjadi
        if (errorClass === "transient" || errorClass === "credential" || errorClass === "unknown") {
          const isUnavailable = isUnavailableSignal(body, message);
          this.healthStore.markFailure(target.provider, target.model, errorClass, { isUnavailable });
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

    // All candidates skipped or failed — attach attempts if possible
    if (firstError) {
      (firstError as any).attempts = attempts;
      throw firstError;
    }
    throw Object.assign(new Error("All providers failed or skipped due to cooldown"), { status: 502, attempts });
  }

  async routeStream(request: ChatCompletionRequest): Promise<RouteResult> {
    const providerHint = (request as any).provider as string | undefined;
    const defaultRouteName = this.config.routes.defaultRoute ?? Object.keys(this.config.routes.routes)[0];
    const route = this.config.routes.routes[defaultRouteName];
    
    const candidates = getCandidates(this.config.routes, this.config.providers, request.model, providerHint, this.healthStore);
    if (candidates.length === 0) {
      throw Object.assign(new Error("No route candidates"), { status: 404 });
    }

    const attempts: RouteAttempt[] = [];
    let fallbackCount = 0;

    const isWeightedRoundRobin = route?.strategy === "weighted-round-robin";
    let remainingCandidates = [...candidates];

    while (remainingCandidates.length > 0) {
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

      const adapter = createProvider(providerCfg);
      const routedRequest: ChatCompletionRequest = {
        ...request,
        model: resolveTargetModel(request.model, target.model),
        stream: true,
      };

      const start = performance.now();
      try {
        const stream = await adapter.stream(routedRequest);
        const latencyMs = performance.now() - start;
        // Stream success is determined before any data — mark success
        this.healthStore.markSuccess(target.provider, target.model);
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

        if (errorClass === "transient" || errorClass === "credential" || errorClass === "unknown") {
          const isUnavailable = isUnavailableSignal(body, message);
          this.healthStore.markFailure(target.provider, target.model, errorClass, { isUnavailable });
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
