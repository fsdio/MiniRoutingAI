// src/server/server.ts — Bun HTTP server Phase 6 (Headroom)
import { validateChatRequest, isStreamingRequest } from "./openai.ts";
import { createTiming, computeMetrics } from "../telemetry/timing.ts";
import { logger, formatTimestampJakarta } from "../telemetry/logger.ts";
import { recordMetric, getMetricsSummary, getRecentMetrics } from "../telemetry/metrics.ts";
import { Router } from "../router/router.ts";
import { globalHealthStore } from "../router/health.ts";
import { analyzeRequest } from "../router/profile.ts";
import { runOptimizers } from "../optimizer/pipeline.ts";
import { applyHeadroom } from "../optimizer/headroom.ts";
import { applyCaveman } from "../optimizer/caveman.ts";
import { applyPonytail } from "../optimizer/ponytail.ts";
import { globalDuplicateCache } from "../memory/duplicate-cache.ts";
import { globalErrorMemory, buildFingerprintInput } from "../memory/error-memory.ts";
import { classifyError } from "../router/policy.ts";
import { normalizeChatResponse } from "../translator/request.ts";
import { createOpenAIStreamTranslator, type StreamUsage } from "../translator/stream.ts";
import { recordRequestLog, readUsageSummary } from "../telemetry/persistence.ts";
import type { ProvidersFile, RoutesFile } from "../types/index.ts";

const startTime = Date.now();
const VERSION = "0.1.0-phase6";

export interface ServerConfig {
  port: number;
  providers: ProvidersFile;
  routes: RoutesFile;
  optimization?: any;
}

function generateRequestId(): string {
  // Prefer native crypto.randomUUID, fallback to random
  try {
    const uuid = crypto.randomUUID();
    return `req_${uuid.replace(/-/g, "").slice(0, 16)}`;
  } catch {
    return `req_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  }
}

function getRouter(config: ServerConfig): Router {
  return new Router({ providers: config.providers, routes: config.routes }, { healthStore: globalHealthStore });
}

export function createServer(config: ServerConfig) {
  const server = Bun.serve({
    port: config.port,
    idleTimeout: 60,
    async fetch(req) {
      const timing = createTiming();
      const requestId = generateRequestId();
      const url = new URL(req.url);
      const method = req.method.toUpperCase();
      const path = url.pathname;

      // Always attach requestId to response
      const baseHeaders = { "x-request-id": requestId };

      try {
        // Health — include headroom aggregated status untuk watchdog
        if (method === "GET" && (path === "/health" || path === "/healthz")) {
          let headroomStatus: any = undefined;
          try {
            const { getHeadroomHealth } = await import("../optimizer/headroom.ts");
            headroomStatus = getHeadroomHealth();
          } catch {}
          const uptime = (Date.now() - startTime) / 1000;
          // Config health: jika routes/providers gagal load, status degraded
          let configHealth: any = undefined;
          try {
            const { getConfigLoadErrors } = await import("../index.ts");
            const errs = getConfigLoadErrors();
            configHealth = Object.keys(errs).length ? { status: "degraded", errors: errs } : { status: "ok" };
          } catch {}
          // Provider health summary
          let providerHealth: any = undefined;
          try {
            const summary = globalHealthStore.getCooldownSummary();
            providerHealth = summary;
          } catch {}
          const degraded = (configHealth?.status === "degraded") || (providerHealth && providerHealth.inCooldown > providerHealth.total * 0.5 && providerHealth.total > 0);
          const body = JSON.stringify({
            status: degraded ? "degraded" : "ok",
            uptime,
            version: VERSION,
            timestamp: formatTimestampJakarta(new Date()),
            headroom: headroomStatus ? { cooldownRemainingMs: headroomStatus.cooldownRemainingMs, consecutiveFailures: headroomStatus.consecutiveFailures, lastHealthOk: headroomStatus.lastHealthOk } : undefined,
            config: configHealth,
            providersHealth: providerHealth,
          });
          timing.responseFinishedAt = performance.now();
          const m = computeMetrics(timing);
          recordMetric({
            requestId,
            status: 200,
            timestamp: Date.now(),
            totalLatencyMs: m.totalLatency,
            gatewayOverheadMs: m.gatewayOverhead,
          });
          logger.debug("health check", { requestId, method, path, status: 200, latencyMs: m.totalLatency });
          return new Response(body, {
            status: 200,
            headers: { "Content-Type": "application/json", ...baseHeaders },
          });
        }

        if (method === "GET" && path === "/metrics") {
          const summary = getMetricsSummary();
          timing.responseFinishedAt = performance.now();
          return new Response(JSON.stringify(summary, null, 2), {
            status: 200,
            headers: { "Content-Type": "application/json", ...baseHeaders },
          });
        }

        if (method === "GET" && path === "/debug/routes") {
          // sanitize: remove secrets, only expose provider id and baseURL without key
          let configErrors: Record<string, string> = {};
          try {
            const { getConfigLoadErrors } = await import("../index.ts");
            configErrors = getConfigLoadErrors();
          } catch {}
          const sanitized = {
            configValid: Object.keys(configErrors).length === 0,
            configErrors: Object.keys(configErrors).length ? configErrors : undefined,
            loadedAt: new Date().toISOString(),
            routes: config.routes.routes,
            defaultRoute: config.routes.defaultRoute,
            providers: config.providers.providers.map((p) => ({
              id: p.id,
              baseURL: p.baseURL,
              models: p.models,
            })),
            health: globalHealthStore.getCooldownSummary(),
          };
          return new Response(JSON.stringify(sanitized, null, 2), {
            status: 200,
            headers: { "Content-Type": "application/json", ...baseHeaders },
          });
        }

        if (method === "GET" && path === "/debug/recent") {
          const recent = getRecentMetrics();
          return new Response(JSON.stringify(recent, null, 2), {
            status: 200,
            headers: { "Content-Type": "application/json", ...baseHeaders },
          });
        }

        if (method === "GET" && path === "/debug/headroom") {
          try {
            const { getHeadroomHealth } = await import("../optimizer/headroom.ts");
            const h = getHeadroomHealth();
            return new Response(JSON.stringify({ enabled: true, ...h, timestamp: Date.now() }, null, 2), {
              status: 200,
              headers: { "Content-Type": "application/json", ...baseHeaders },
            });
          } catch {
            return new Response(JSON.stringify({ enabled: false, reason: "headroom module not loaded" }, null, 2), {
              status: 200,
              headers: { "Content-Type": "application/json", ...baseHeaders },
            });
          }
        }

        if (method === "GET" && path === "/usage") {
          const summary = await readUsageSummary();
          return new Response(JSON.stringify(summary, null, 2), {
            status: 200,
            headers: { "Content-Type": "application/json", ...baseHeaders },
          });
        }

        // Chat completions
        if (method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
          let body: unknown;
          let rawText = "";
          try {
            rawText = await req.text();
            if (!rawText || rawText.trim() === "") {
              return new Response(JSON.stringify({ error: { message: "Empty request body", type: "invalid_request_error", code: null } }), {
                status: 400,
                headers: { "Content-Type": "application/json", ...baseHeaders },
              });
            }
            body = JSON.parse(rawText);
          } catch (e) {
            return new Response(
              JSON.stringify({ error: { message: "Invalid JSON body", type: "invalid_request_error", code: null } }),
              { status: 400, headers: { "Content-Type": "application/json", ...baseHeaders } },
            );
          }

          const validation = validateChatRequest(body);
          if (!validation.valid) {
            const errRes = validation.error!;
            const newHeaders = new Headers(errRes.headers);
            newHeaders.set("x-request-id", requestId);
            timing.responseFinishedAt = performance.now();
            const m = computeMetrics(timing);
            logger.warn("validation failed", { requestId, method, path, status: errRes.status });
            recordMetric({
              requestId,
              status: errRes.status,
              timestamp: Date.now(),
              totalLatencyMs: m.totalLatency,
              gatewayOverheadMs: m.gatewayOverhead,
            });
            return new Response(errRes.body, { status: errRes.status, headers: newHeaders });
          }

          const chatReq = validation.request!;
          const streaming = isStreamingRequest(chatReq);
          timing.normalizationDoneAt = performance.now();

          // Profiling stage — Request Analyzer
          const rawBodyBytes = Buffer.byteLength(rawText, "utf-8");
          let profile = analyzeRequest(chatReq, rawBodyBytes);
          let defaultRouteName = config.routes.defaultRoute ?? Object.keys(config.routes.routes)[0] ?? "fast";

          // Duplicate Cache — Phase 10 (check before optimizers)
          let duplicateCacheHits = 0;
          for (const m of chatReq.messages as any[]) {
            if (m.role === "tool" && typeof m.content === "string") {
              const toolName = m.tool_call_id ?? m.name ?? "tool";
              const cached = globalDuplicateCache.get(toolName, m.content);
              if (cached !== null) {
                duplicateCacheHits++;
                // Serve from cache (content already same, just count hit)
                // Optionally we could replace with cached to ensure consistency
              } else {
                // Only cache read-only tools, globalDuplicateCache will filter mutating
                globalDuplicateCache.set(toolName, m.content, m.content);
              }
            }
          }
          if (duplicateCacheHits > 0) logger.debug("duplicate-cache", { requestId, hits: duplicateCacheHits, ttlMs: 3000 });

          // RTK Optimizer — Phase 5 (fail-open, after profiling before routing)
          const routeCfg = config.routes.routes[defaultRouteName];
          const routeRtk = routeCfg?.optimizers?.rtk;
          const globalRtk = config.optimization?.optimizers?.rtk;
          let rtkEnabled = false;
          if (routeRtk !== undefined) rtkEnabled = !!routeRtk;
          else if (globalRtk !== undefined) {
            if (typeof globalRtk === "boolean") rtkEnabled = globalRtk;
            else if (typeof globalRtk === "object") rtkEnabled = !!globalRtk.enabled;
          }
          const rtkOpts = typeof globalRtk === "object" && globalRtk !== null && typeof globalRtk !== "boolean"
            ? { enabled: rtkEnabled, minBytes: (globalRtk as any).minBytes, timeoutMs: (globalRtk as any).timeoutMs }
            : { enabled: rtkEnabled };
          const pipelineResult = runOptimizers(chatReq, { rtk: rtkOpts.enabled ? rtkOpts : false });
          const rtkResult = pipelineResult.rtk!;
          // Re-analyze after RTK if it succeeded (bytes changed)
          if (rtkResult && !rtkResult.skipped && rtkResult.success) {
            profile = analyzeRequest(chatReq, Buffer.byteLength(JSON.stringify(chatReq), "utf-8"));
          }
          // RTK stage — konsolidasi ke baris chat (debug jika LOG_LEVEL=debug)

          // Headroom Optimizer — Phase 6 (fail-open, after RTK before routing)
          const routeHeadroom = routeCfg?.optimizers?.headroom;
          const globalHeadroom = config.optimization?.optimizers?.headroom;
          let headroomEnabled = false;
          let headroomOpts: any = { enabled: false };
          if (routeHeadroom !== undefined) {
            if (typeof routeHeadroom === "boolean") {
              headroomEnabled = routeHeadroom;
              // boolean per-route overrides enabled but inherits other global fields (url, minimumTokens)
              const globalObj = typeof globalHeadroom === "object" && globalHeadroom !== null ? globalHeadroom : {};
              headroomOpts = { ...(globalObj as any), enabled: headroomEnabled };
            } else if (typeof routeHeadroom === "object") {
              headroomEnabled = !!(routeHeadroom as any).enabled;
              const globalObj = typeof globalHeadroom === "object" && globalHeadroom !== null ? globalHeadroom : {};
              headroomOpts = { ...(globalObj as any), ...(routeHeadroom as any), enabled: headroomEnabled };
            }
          } else if (globalHeadroom !== undefined) {
            if (typeof globalHeadroom === "boolean") headroomEnabled = globalHeadroom;
            else if (typeof globalHeadroom === "object") headroomEnabled = !!(globalHeadroom as any).enabled;
            headroomOpts = typeof globalHeadroom === "object" ? (globalHeadroom as any) : { enabled: headroomEnabled };
          }
          // Ensure url from env if not set in config
          if (headroomOpts && !headroomOpts.url) {
            const envUrl = process.env.HEADROOM_URL ?? (Bun.env as any).HEADROOM_URL;
            if (envUrl) headroomOpts.url = envUrl;
          }
          // Re-analyze profile after RTK for Headroom threshold (already done above if RTK success)
          const headroomProfile = profile;
          const headroomResult = await applyHeadroom(chatReq, headroomProfile, {
            enabled: headroomEnabled,
            url: headroomOpts.url,
            model: chatReq.model,
            minimumTokens: headroomOpts.minimumTokens ?? (globalHeadroom as any)?.minimumTokens ?? 10000,
            minimumBytes: headroomOpts.minimumBytes ?? (globalHeadroom as any)?.minimumBytes,
            timeoutMs: headroomOpts.timeoutMs ?? 500,
            maxConsecutiveFailures: headroomOpts.maxConsecutiveFailures ?? (globalHeadroom as any)?.maxConsecutiveFailures,
            cooldownMs: headroomOpts.cooldownMs ?? (globalHeadroom as any)?.cooldownMs,
            healthProbeMs: headroomOpts.healthProbeMs ?? (globalHeadroom as any)?.healthProbeMs,
            failOpen: headroomOpts.failOpen ?? (globalHeadroom as any)?.failOpen ?? true,
            compressUserMessages: headroomOpts.compressUserMessages ?? (globalHeadroom as any)?.compressUserMessages,
            cacheTtlMs: headroomOpts.cacheTtlMs ?? (globalHeadroom as any)?.cacheTtlMs,
          });
          // Re-analyze after Headroom if success
          if (headroomResult && !headroomResult.skipped && headroomResult.success) {
            profile = analyzeRequest(chatReq, Buffer.byteLength(JSON.stringify(chatReq), "utf-8"));
          }
          // Headroom stage — konsolidasi ke baris chat

          // Caveman — Phase 7 (no LLM call, system prompt steering)
          const routeCaveman = routeCfg?.optimizers?.caveman;
          const globalCaveman = config.optimization?.optimizers?.caveman;
          let cavemanMode: string = "off";
          if (routeCaveman !== undefined) {
            if (typeof routeCaveman === "boolean") cavemanMode = routeCaveman ? "lite" : "off";
            else if (typeof routeCaveman === "string") cavemanMode = routeCaveman;
            else if (typeof routeCaveman === "object") cavemanMode = (routeCaveman as any).mode ?? ((routeCaveman as any).enabled ? "lite" : "off");
          } else if (globalCaveman !== undefined) {
            if (typeof globalCaveman === "boolean") cavemanMode = globalCaveman ? "lite" : "off";
            else if (typeof globalCaveman === "string") cavemanMode = globalCaveman;
            else if (typeof globalCaveman === "object") cavemanMode = (globalCaveman as any).mode ?? ((globalCaveman as any).enabled ? "lite" : "off");
          }
          const cavemanResult = applyCaveman(chatReq, cavemanMode);
          // Adaptive Routing — Phase 11 (decide route based on profile if enabled)
          const adaptiveEnabled = (config.optimization as any)?.optimizers?.adaptive?.enabled ?? false;
          let adaptiveReason = "disabled";
          let originalRoute = defaultRouteName;
          if (adaptiveEnabled) {
            if (profile.estimatedTokens < 1000 && config.routes.routes["fast"]) {
              defaultRouteName = "fast";
              adaptiveReason = "small_context_fast";
            } else if (profile.estimatedTokens < 30000 && config.routes.routes["balanced"]) {
              defaultRouteName = "balanced";
              adaptiveReason = "medium_context_balanced";
            } else if (config.routes.routes["balanced"]) {
              defaultRouteName = "balanced";
              adaptiveReason = "large_context_balanced";
            } else if (config.routes.routes["adaptive"]) {
              defaultRouteName = "adaptive";
              adaptiveReason = "large_adaptive";
            }
            if (adaptiveReason !== "disabled") logger.debug("adaptive-routing", { requestId, originalRoute, selectedRoute: defaultRouteName, estimatedTokens: profile.estimatedTokens, reason: adaptiveReason });
          }
          // Caveman — konsolidasi ke baris chat

          // Ponytail — Phase 8 (YAGNI steering)
          const routePonytail = routeCfg?.optimizers?.ponytail;
          const globalPonytail = config.optimization?.optimizers?.ponytail;
          let ponytailMode: string = "off";
          if (routePonytail !== undefined) {
            if (typeof routePonytail === "boolean") ponytailMode = routePonytail ? "lite" : "off";
            else if (typeof routePonytail === "string") ponytailMode = routePonytail;
            else if (typeof routePonytail === "object") ponytailMode = (routePonytail as any).mode ?? ((routePonytail as any).enabled ? "lite" : "off");
          } else if (globalPonytail !== undefined) {
            if (typeof globalPonytail === "boolean") ponytailMode = globalPonytail ? "lite" : "off";
            else if (typeof globalPonytail === "string") ponytailMode = globalPonytail;
            else if (typeof globalPonytail === "object") ponytailMode = (globalPonytail as any).mode ?? ((globalPonytail as any).enabled ? "lite" : "off");
          }
          const ponytailResult = applyPonytail(chatReq, ponytailMode);
          // Ponytail — konsolidasi ke baris chat

          // Duplicate Tool Cache — Phase 10 (check cache for tool outputs, TTL 3s)
          // Scan tool messages for cache hits
          let cacheHits = 0;
          for (const m of chatReq.messages) {
            if ((m as any).role === "tool" && (m as any).tool_call_id) {
              const cached = globalDuplicateCache.get((m as any).tool_call_id, (m as any).content);
              // Actually key should be tool name + content hash; for demo we use tool_call_id
              // If hit, we could serve cached (but we already have content, so just count)
              if (cached && cached === (m as any).content) cacheHits++;
            }
          }
          if (cacheHits > 0) logger.debug("duplicate-cache", { requestId, hits: cacheHits });

          const router = getRouter(config);
          timing.routingDoneAt = performance.now();

          if (!streaming) {
            timing.providerRequestSentAt = performance.now();
            try {
              const result = await router.routeChat(chatReq);
              timing.providerFirstByteAt = timing.providerFinishedAt = performance.now();
              timing.clientFirstChunkAt = performance.now();
              timing.responseFinishedAt = performance.now();
              const m = computeMetrics(timing);
              const response = normalizeChatResponse(chatReq.model, result.response);
              const usage: any = (response as any)?.usage ?? {};
              const inputTokens = usage.prompt_tokens ?? "unknown";
              const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? "unknown";
              const cachedTokens = usage.cached_tokens ?? usage.cached_input_tokens ?? "unknown";
              logger.info("chat", {
                requestId,
                route: defaultRouteName,
                provider: result.provider,
                model: result.model,
                status: 200,
                totalLatencyMs: m.totalLatency,
                providerLatencyMs: m.providerLatency,
                gatewayOverheadMs: m.gatewayOverhead,
                ttftMs: m.ttft,
                fallbackCount: result.fallbackCount,
                inputTokens,
                outputTokens,
                cachedInputTokens: cachedTokens,
                estimatedTokens: profile.estimatedTokens,
                rtk: { enabled: rtkResult.enabled, savedBytes: rtkResult.savedBytes, savedPercent: Number(rtkResult.savedPercent.toFixed(1)) },
                headroom: { enabled: headroomResult.enabled, savedBytes: headroomResult.savedBytes, savedPercent: Number(headroomResult.savedPercent.toFixed(1)), reason: headroomResult.reason },
                caveman: cavemanResult.mode,
                ponytail: ponytailResult.mode,
              });
              recordMetric({
                requestId,
                route: defaultRouteName,
                provider: result.provider,
                model: result.model,
                status: 200,
                timestamp: Date.now(),
                totalLatencyMs: m.totalLatency,
                gatewayOverheadMs: m.gatewayOverhead,
                providerLatencyMs: m.providerLatency,
                generationLatencyMs: m.generationLatency,
                ttftMs: m.ttft,
                inputTokens,
                outputTokens,
                cachedInputTokens: cachedTokens,
                bodyBytes: profile.bodyBytes,
                messageBytes: profile.messageBytes,
                toolBytes: profile.toolBytes,
                toolHistoryBytes: profile.toolHistoryBytes,
                estimatedTokens: profile.estimatedTokens,
                fallbackCount: result.fallbackCount,
                retryCount: result.retryCount,
                rtk: rtkResult,
                rtkDurationMs: rtkResult.durationMs,
                headroom: headroomResult,
                headroomDurationMs: headroomResult.durationMs,
              });
              void recordRequestLog({
                requestId,
                route: defaultRouteName,
                provider: result.provider,
                model: result.model,
                status: 200,
                stream: false,
                ts: Date.now(),
                totalLatencyMs: m.totalLatency,
                ttftMs: m.ttft,
                inputTokens,
                outputTokens,
                cachedInputTokens: cachedTokens,
                rtkSavedBytes: rtkResult.savedBytes,
                headroomSavedBytes: headroomResult.savedBytes,
              });
              return new Response(JSON.stringify(response), {
                status: 200,
                headers: { "Content-Type": "application/json", ...baseHeaders, "x-provider": result.provider, "x-fallback-count": String(result.fallbackCount) },
              });
            } catch (err: any) {
              const status = err.status ?? (err.body?.error?.code ? parseInt(err.body.error.code) : 502) ?? 502;
              let resolvedStatus = typeof status === "number" && !isNaN(status) ? status : 502;
              const attempts: any[] = (err as any).attempts ?? [];
              const errorClassForLog = classifyError(resolvedStatus, err.body, err.message);
              // Jika upstream kirim 400 tapi isinya "Model is unavailable" (transient), promosikan ke 503 agar client tidak anggap deterministic
              const bodyStrLower = err.body ? JSON.stringify(err.body).toLowerCase() : "";
              const msgLower = String(err.message ?? "").toLowerCase();
              const isUnavailable = bodyStrLower.includes("unavailable") || msgLower.includes("unavailable") || bodyStrLower.includes("capacity") || msgLower.includes("capacity");
              if (isUnavailable && errorClassForLog === "transient" && (resolvedStatus === 400 || resolvedStatus === 404)) {
                resolvedStatus = 503;
              }
              let errorBody: string;
              let errorJson: any = null;
              if (err.body) {
                errorBody = typeof err.body === "string" ? err.body : JSON.stringify(err.body);
                try { errorJson = JSON.parse(errorBody); } catch { errorJson = null; errorBody = JSON.stringify({ error: { message: String(err.message ?? err.body), type: "upstream_error", code: String(resolvedStatus) } }); }
                // Jika semua fallback habis dan isUnavailable, enrich body dengan attempts & hint
                if (attempts.length > 0) {
                  try {
                    const parsed = errorJson ?? JSON.parse(errorBody);
                    parsed.error = parsed.error ?? { message: String(err.message ?? "Upstream error") };
                    parsed.error.attempts = attempts.map((a: any) => ({ provider: a.provider, model: a.model, status: a.status, errorClass: a.errorClass, skippedDueToCooldown: a.skippedDueToCooldown }));
                    parsed.error.fallbackCount = attempts.filter((a: any) => a.skippedDueToCooldown || !a.success).length;
                    parsed.error.route = defaultRouteName;
                    if (isUnavailable) {
                      parsed.error.hint = "Model is unavailable di provider primary. Gateway sudah coba fallback (" + attempts.length + " attempts). Jika semua gagal, periksa config/routes.json — urutan fallback mungkin stale. Cek /debug/routes & /metrics. Model yang sering unavailable akan di-cooldown 30s.";
                      parsed.error.code = "model_unavailable";
                    }
                    errorBody = JSON.stringify(parsed);
                  } catch {}
                }
              } else {
                const msg = String(err.message ?? "Upstream error");
                if (msg.toLowerCase().includes("fetch failed") || msg.toLowerCase().includes("connection") || resolvedStatus === 502) {
                  timing.responseFinishedAt = performance.now();
                  const m = computeMetrics(timing);
                  logger.error("upstream fetch failed", { requestId, route: defaultRouteName, model: chatReq.model, error: msg, latencyMs: m.totalLatency, attempts: attempts.length });
                  recordMetric({ requestId, route: defaultRouteName, model: chatReq.model, status: 502, timestamp: Date.now(), totalLatencyMs: m.totalLatency, gatewayOverheadMs: m.gatewayOverhead, rtk: rtkResult, rtkDurationMs: rtkResult.durationMs, headroom: headroomResult, headroomDurationMs: headroomResult.durationMs });
                  const hint = chatReq.model === "mini-balanced" || chatReq.model === "mini-balanced-cloud"
                    ? " Hint: model mini-balanced → ollama cloud https://ollama.com/v1 (periksa OLLAMA_BASE_URL & OLLAMA_API_KEY; cek config/providers.json)."
                    : chatReq.model.includes("ollama") || msg.toLowerCase().includes("ollama.com") || msg.toLowerCase().includes("11434")
                      ? " Hint: periksa OLLAMA_BASE_URL (cloud: https://ollama.com/v1 + OLLAMA_API_KEY, lokal: http://localhost:11434/v1)."
                      : isUnavailable ? " Hint: Model is unavailable — gateway akan fallback otomatis. Jika looping, cek HealthStore cooldown & urutan fallback di config/routes.json."
                      : "";
                  return new Response(JSON.stringify({ error: { message: `Upstream connection failed: ${msg}.${hint} Is the computer able to access the url? Periksa koneksi & API key.`, type: "server_error", code: "upstream_unavailable", provider: defaultRouteName, model: chatReq.model, attempts } }), {
                    status: 502, headers: { "Content-Type": "application/json", ...baseHeaders, "x-attempts": String(attempts.length), "x-error-class": errorClassForLog },
                  });
                }
                errorBody = JSON.stringify({ error: { message: msg, type: "upstream_error", code: String(resolvedStatus), attempts: attempts.length ? attempts : undefined } });
              }
              timing.providerFinishedAt = performance.now();
              timing.responseFinishedAt = performance.now();
              const m = computeMetrics(timing);
              const attemptedProvider = (attempts[0]?.provider) ?? (err.attempts?.[0]?.provider) ?? "unknown";
              // Error Memory — Phase 9: remember deterministic/transient failures
              try {
                const category = errorClassForLog;
                const fpInput = buildFingerprintInput(attemptedProvider, chatReq.model, category, String(err.message ?? err.body ?? ""), undefined);
                const entry = globalErrorMemory.remember(fpInput);
                logger.debug("error-memory", { requestId, fingerprint: entry.fingerprint.slice(0,12), category, count: entry.count, cooldownUntil: entry.cooldownUntil });
              } catch {}
              const logLevel = isUnavailable ? "warn" : "warn";
              logger.warn("upstream error passthrough", { requestId, route: defaultRouteName, provider: attemptedProvider, status: resolvedStatus, errorClass: errorClassForLog, isUnavailable, attempts: attempts.length, latencyMs: m.totalLatency, bodyPreview: (() => { try { return JSON.stringify(err.body).slice(0,300); } catch { return String(err.body).slice(0,300); } })() });
              recordMetric({
                requestId,
                route: defaultRouteName,
                provider: attemptedProvider,
                model: chatReq.model,
                status: resolvedStatus,
                timestamp: Date.now(),
                totalLatencyMs: m.totalLatency,
                gatewayOverheadMs: m.gatewayOverhead,
                providerLatencyMs: m.providerLatency,
                ttftMs: m.ttft,
                bodyBytes: profile.bodyBytes,
                messageBytes: profile.messageBytes,
                toolBytes: profile.toolBytes,
                toolHistoryBytes: profile.toolHistoryBytes,
                estimatedTokens: profile.estimatedTokens,
                rtk: rtkResult,
                rtkDurationMs: rtkResult.durationMs,
                headroom: headroomResult,
                headroomDurationMs: headroomResult.durationMs,
                caveman: cavemanResult,
                ponytail: ponytailResult,
                duplicateCacheHits,
                errorMemoryHits: globalErrorMemory.size(),
              });
              return new Response(errorBody, { status: resolvedStatus, headers: { "Content-Type": "application/json", ...baseHeaders, "x-attempts": String(attempts.length), "x-error-class": errorClassForLog } });
            }
          }

          // Streaming path via router
          timing.providerRequestSentAt = performance.now();
          try {
            const result = await router.routeStream(chatReq);
            const upstreamStream = result.stream!;
            const providerId = result.provider;
            const modelUsed = result.model;
            let streamUsage: StreamUsage | null = null;
            const translator = createOpenAIStreamTranslator({
              provider: providerId,
              model: modelUsed,
              body: chatReq,
              onStreamComplete: (_content, _thinking, usage) => {
                streamUsage = usage;
              },
            });
            const transformedStream = upstreamStream.pipeThrough(translator);
            let firstChunkSent = false;
            let clientAborted = false;
            let activeReader: any = null;
            const stream = new ReadableStream({
              async start(controller) {
                const reader = transformedStream.getReader();
                activeReader = reader;
                const abortHandler = () => {
                  clientAborted = true;
                  try { reader.cancel("client aborted"); } catch {}
                };
                req.signal?.addEventListener("abort", abortHandler, { once: true });
                let providerFirstByteRecorded = false;
                try {
                  while (true) {
                    if (clientAborted || req.signal?.aborted) break;
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (!providerFirstByteRecorded) {
                      timing.providerFirstByteAt = performance.now();
                      providerFirstByteRecorded = true;
                    }
                    if (!firstChunkSent) {
                      timing.clientFirstChunkAt = performance.now();
                      firstChunkSent = true;
                    }
                    try { controller.enqueue(value); } catch { break; }
                  }
                  timing.providerFinishedAt = performance.now();
                  timing.responseFinishedAt = performance.now();
                  const m = computeMetrics(timing);
                  logger.info("chat", {
                    requestId,
                    route: defaultRouteName,
                    provider: providerId,
                    model: modelUsed,
                    status: 200,
                    totalLatencyMs: m.totalLatency,
                    providerLatencyMs: m.providerLatency,
                    gatewayOverheadMs: m.gatewayOverhead,
                    ttftMs: m.ttft,
                    fallbackCount: result.fallbackCount,
                    estimatedTokens: profile.estimatedTokens,
                    rtk: { enabled: rtkResult.enabled, savedBytes: rtkResult.savedBytes, savedPercent: Number(rtkResult.savedPercent.toFixed(1)) },
                    headroom: { enabled: headroomResult.enabled, savedBytes: headroomResult.savedBytes, savedPercent: Number(headroomResult.savedPercent.toFixed(1)), reason: headroomResult.reason },
                    caveman: cavemanResult.mode,
                    ponytail: ponytailResult.mode,
                  });
                  recordMetric({
                    requestId,
                    route: defaultRouteName,
                    provider: providerId,
                    model: modelUsed,
                    status: 200,
                    timestamp: Date.now(),
                    totalLatencyMs: m.totalLatency,
                    gatewayOverheadMs: m.gatewayOverhead,
                    providerLatencyMs: m.providerLatency,
                    generationLatencyMs: m.generationLatency,
                    ttftMs: m.ttft,
                    bodyBytes: profile.bodyBytes,
                    messageBytes: profile.messageBytes,
                    toolBytes: profile.toolBytes,
                    toolHistoryBytes: profile.toolHistoryBytes,
                    estimatedTokens: profile.estimatedTokens,
                    fallbackCount: result.fallbackCount,
                    inputTokens: streamUsage?.prompt_tokens ?? "unknown",
                    outputTokens: streamUsage?.completion_tokens ?? "unknown",
                    rtk: rtkResult,
                    rtkDurationMs: rtkResult.durationMs,
                    headroom: headroomResult,
                    headroomDurationMs: headroomResult.durationMs,
                  });
                  void recordRequestLog({
                    requestId,
                    route: defaultRouteName,
                    provider: providerId,
                    model: modelUsed,
                    status: 200,
                    stream: true,
                    ts: Date.now(),
                    totalLatencyMs: m.totalLatency,
                    ttftMs: m.ttft,
                    inputTokens: streamUsage?.prompt_tokens ?? "unknown",
                    outputTokens: streamUsage?.completion_tokens ?? "unknown",
                    rtkSavedBytes: rtkResult.savedBytes,
                    headroomSavedBytes: headroomResult.savedBytes,
                  });
                  try { controller.close(); } catch {}
                } catch (err) {
                  if (!clientAborted && !req.signal?.aborted) logger.error("stream error", { requestId, error: String(err) });
                  else logger.debug("stream aborted", { requestId, reason: clientAborted ? "client aborted" : String(err) });
                  try { controller.error(err); } catch {}
                } finally {
                  try { reader.releaseLock(); } catch {}
                  req.signal?.removeEventListener("abort", abortHandler);
                }
              },
              cancel(reason) {
                clientAborted = true;
                if (activeReader) {
                  try { activeReader.cancel(reason); } catch {}
                }
                // Jangan cancel transformedStream yang sedang locked — reader.cancel cukup
              },
            });
            return new Response(stream, {
              status: 200,
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                ...baseHeaders,
                "x-provider": providerId,
                "x-fallback-count": String(result.fallbackCount),
              },
            });
          } catch (err: any) {
            const status = err.status ?? 502;
            const attempts: any[] = (err as any).attempts ?? [];
            const errorClassForLog = classifyError(status, err.body, err.message);
            let resolvedStatus = status;
            const bodyStrLower = err.body ? JSON.stringify(err.body).toLowerCase() : "";
            const msgLower = String(err.message ?? "").toLowerCase();
            const isUnavailable = bodyStrLower.includes("unavailable") || msgLower.includes("unavailable") || bodyStrLower.includes("no available channel") || msgLower.includes("no available channel") || bodyStrLower.includes("capacity") || bodyStrLower.includes("rate limit");
            if (isUnavailable && errorClassForLog === "transient" && (status === 400 || status === 404)) resolvedStatus = 503;
            // Jika semua attempts adalah cooldown, beri Retry-After agar opencode tidak retry membabi-buta setiap 2s
            const allCooldown = attempts.length > 0 && attempts.every((a: any) => a.skippedDueToCooldown || a.errorClass === "cooldown");
            const cooldownSummary = globalHealthStore.getCooldownSummary();
            const maxRemainingMs = Math.max(0, ...cooldownSummary.details.map((d) => d.remainingMs), 0);
            const retryAfterSec = allCooldown ? Math.max(5, Math.ceil(maxRemainingMs / 1000)) : 0;
            let errorBody: string;
            if (err.body) {
              errorBody = typeof err.body === "string" ? err.body : JSON.stringify(err.body);
              // Enrich dengan attempts jika ada
              if (attempts.length > 0) {
                try {
                  const parsed = JSON.parse(errorBody);
                  parsed.error = parsed.error ?? { message: String(err.message ?? "Upstream stream error") };
                  parsed.error.attempts = attempts;
                  parsed.error.route = defaultRouteName;
                  parsed.error.cooldowns = cooldownSummary;
                  if (allCooldown) {
                    parsed.error.code = "all_providers_cooldown";
                    parsed.error.hint = `All stream providers failed or in cooldown (${attempts.length} attempts, ${cooldownSummary.inCooldown} in cooldown). Retry-After ${retryAfterSec}s. Cek /debug/routes & logs/mini-routingai.log. Cooldown akan reset ~${Math.ceil(maxRemainingMs / 1000)}s.`;
                    parsed.error.retryAfter = retryAfterSec;
                  } else if (isUnavailable) parsed.error.hint = "Model is unavailable (stream). Gateway fallback sebelum first chunk; jika semua gagal cek fallback chain.";
                  errorBody = JSON.stringify(parsed);
                } catch {}
              }
            } else {
              const msg = err.message ?? "Upstream stream error";
              // Khusus kasus All stream providers failed or cooldown tanpa body
              const isAllCooldownMsg = msgLower.includes("all stream providers failed") || msgLower.includes("all providers failed");
              const enriched: any = { message: isAllCooldownMsg ? `All stream providers failed or cooldown (attempts=${attempts.length}, cooldowns=${cooldownSummary.inCooldown}) — Retry-After ${retryAfterSec}s` : msg, type: "upstream_error", code: isAllCooldownMsg || allCooldown ? "all_providers_cooldown" : String(resolvedStatus), attempts: attempts.length ? attempts : undefined, route: defaultRouteName, cooldowns: cooldownSummary, retryAfter: retryAfterSec || undefined };
              if (isUnavailable && !allCooldown) enriched.hint = "Model is unavailable (stream). Gateway fallback sebelum first chunk; jika semua gagal cek fallback chain.";
              if (isAllCooldownMsg || allCooldown) enriched.hint = `All ${attempts.length} providers in cooldown/failure. Tunggu ${retryAfterSec}s atau cek /debug/routes. Fallback chain: ${attempts.map((a: any) => a.provider + "/" + a.model).join(", ")}`;
              errorBody = JSON.stringify({ error: enriched });
            }
            timing.providerFinishedAt = performance.now();
            timing.responseFinishedAt = performance.now();
            const m = computeMetrics(timing);
            logger.warn("upstream stream error", { requestId, route: defaultRouteName, status: resolvedStatus, errorClass: errorClassForLog, isUnavailable, allCooldown, attempts: attempts.length, cooldowns: cooldownSummary.inCooldown, retryAfterSec, error: String(err).slice(0,500) });
            recordMetric({ requestId, route: defaultRouteName, model: chatReq.model, status: resolvedStatus, timestamp: Date.now(), totalLatencyMs: m.totalLatency, gatewayOverheadMs: m.gatewayOverhead, rtk: rtkResult, rtkDurationMs: rtkResult.durationMs, headroom: headroomResult, headroomDurationMs: headroomResult.durationMs });
            const respHeaders: Record<string, string> = { "Content-Type": "application/json", ...baseHeaders, "x-attempts": String(attempts.length), "x-error-class": errorClassForLog };
            if (retryAfterSec > 0) respHeaders["Retry-After"] = String(retryAfterSec);
            if (allCooldown) respHeaders["x-cooldown"] = "1";
            return new Response(errorBody, { status: resolvedStatus, headers: respHeaders });
          }
        }

        // 404
        timing.responseFinishedAt = performance.now();
        return new Response(JSON.stringify({ error: { message: `Not found: ${method} ${path}`, type: "invalid_request_error", code: "not_found" } }), {
          status: 404,
          headers: { "Content-Type": "application/json", ...baseHeaders },
        });
      } catch (err) {
        timing.responseFinishedAt = performance.now();
        logger.error("unhandled server error", { requestId, error: String(err) });
        return new Response(JSON.stringify({ error: { message: "Internal server error", type: "server_error", code: null } }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...baseHeaders },
        });
      }
    },
  });

  logger.info(`MiniRoutingAI listening on http://localhost:${config.port}`, { port: config.port });
  return server;
}
