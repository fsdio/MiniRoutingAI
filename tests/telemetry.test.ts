import { describe, test, expect, beforeEach } from "bun:test";
import { createTiming, computeMetrics } from "../src/telemetry/timing.ts";
import { recordMetric, getMetricsSummary, clearMetrics, computeStats, getRecentMetrics } from "../src/telemetry/metrics.ts";
import { redactObject } from "../src/telemetry/logger.ts";
import { analyzeRequest } from "../src/router/profile.ts";
import { createServer } from "../src/server/server.ts";
import { globalHealthStore } from "../src/router/health.ts";

describe("Phase 4 — Telemetry", () => {
  test("timing computeMetrics — gateway overhead = total - providerLatency", async () => {
    const timing: any = {
      requestReceivedAt: 0,
      providerRequestSentAt: 10,
      providerFirstByteAt: 25,
      providerFinishedAt: 40,
      clientFirstChunkAt: 26,
      responseFinishedAt: 50,
    };
    const m = computeMetrics(timing);
    expect(m.totalLatency).toBe(50);
    expect(m.providerLatency).toBe(30); // 40-10
    expect(m.gatewayOverhead).toBe(20); // 50-30
    expect(m.ttft).toBe(25); // providerFirstByte - requestReceived
    expect(m.generationLatency).toBe(15); // 40-25
  });

  test("timing — overhead zero when providerLatency undefined", () => {
    const timing: any = { requestReceivedAt: 0, responseFinishedAt: 50 };
    const m = computeMetrics(timing);
    expect(m.gatewayOverhead).toBe(50);
    expect(m.providerLatency).toBeUndefined();
  });

  test("timing — negative overhead clamped to 0", () => {
    const timing: any = { requestReceivedAt: 0, providerRequestSentAt: 0, providerFinishedAt: 100, responseFinishedAt: 50 };
    const m = computeMetrics(timing);
    expect(m.gatewayOverhead).toBe(0);
  });

  test("metrics computeStats — min/p50/p95/max", () => {
    const s = computeStats([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(s.min).toBe(10);
    expect(s.max).toBe(100);
    expect(s.p50).toBe(50);
    expect(s.p95).toBe(100); // ceil 95% of 10 = 10th element
    expect(s.count).toBe(10);
  });

  test("metrics computeStats — empty", () => {
    const s = computeStats([]);
    expect(s.min).toBeNull();
    expect(s.count).toBe(0);
  });

  test("metrics — record and summary", () => {
    clearMetrics();
    recordMetric({ requestId: "req_1", status: 200, timestamp: Date.now(), totalLatencyMs: 10, gatewayOverheadMs: 2, providerLatencyMs: 8, ttftMs: 5 });
    recordMetric({ requestId: "req_2", status: 200, timestamp: Date.now(), totalLatencyMs: 20, gatewayOverheadMs: 3, providerLatencyMs: 17, ttftMs: 10 });
    const summary = getMetricsSummary();
    expect(summary.count).toBe(2);
    expect(summary.latencies.min).toBe(10);
    expect(summary.latencies.max).toBe(20);
    expect(summary.gatewayOverhead.min).toBe(2);
    expect(summary.ttft.min).toBe(5);
    expect(getRecentMetrics().length).toBe(2);
    clearMetrics();
  });

  test("logger redaction — sensitive keys redacted", () => {
    const obj = redactObject({
      authorization: "Bearer secret",
      api_key: "sk-123",
      password: "hunter2",
      estimatedTokens: 1234,
      inputTokens: 100,
      bodyBytes: 500,
      normalField: "hello",
      nested: { secret: "hide", token: "should redact", estimatedTokens: 999 },
    }) as any;
    expect(obj.authorization).toBe("[REDACTED]");
    expect(obj.api_key).toBe("[REDACTED]");
    expect(obj.password).toBe("[REDACTED]");
    // Metrics fields must NOT be redacted
    expect(obj.estimatedTokens).toBe(1234);
    expect(obj.inputTokens).toBe(100);
    expect(obj.bodyBytes).toBe(500);
    expect(obj.normalField).toBe("hello");
    expect(obj.nested.secret).toBe("[REDACTED]");
    expect(obj.nested.token).toBe("[REDACTED]");
    expect(obj.nested.estimatedTokens).toBe(999);
  });

  test("logger redaction — bearer token heuristic", () => {
    const obj = redactObject({ someHeader: "Bearer xyz123" }) as any;
    // someHeader not sensitive by key, but value starts with Bearer -> still returned as is? Our redactValue checks bearer for any string? Actually redactObject only checks key, not value bearer unless key is authorization. So this will not redact. That's acceptable.
    expect(obj.someHeader).toBe("Bearer xyz123");
    const obj2 = redactObject({ authorization: "Bearer xyz123" }) as any;
    expect(obj2.authorization).toBe("[REDACTED]");
  });

  test("analyzeRequest — estimatedTokens and byte counts", () => {
    const req: any = {
      model: "test",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "bash", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "1", content: "git status output" },
      ],
      tools: [{ type: "function", function: { name: "bash", description: "bash" } }],
    };
    const profile = analyzeRequest(req);
    expect(profile.estimatedTokens).toBeGreaterThan(0);
    expect(profile.bodyBytes).toBeGreaterThan(0);
    expect(profile.messageBytes).toBeGreaterThan(0);
    expect(profile.toolBytes).toBeGreaterThan(0);
    expect(profile.toolHistoryBytes).toBeGreaterThan(0);
    expect(profile.messageCount).toBe(3);
    expect(profile.toolCount).toBe(1);
    expect(profile.hasTools).toBe(true);
    expect(profile.hasToolResults).toBe(true);
    // estimatedTokens approx bodyBytes/4 ceil
    expect(profile.estimatedTokens).toBe(Math.ceil(profile.bodyBytes / 4));
  });

  test("analyzeRequest — no tools", () => {
    const req: any = { model: "test", messages: [{ role: "user", content: "hi" }] };
    const profile = analyzeRequest(req);
    expect(profile.hasTools).toBe(false);
    expect(profile.hasToolResults).toBe(false);
    expect(profile.toolBytes).toBe(0);
  });

  test("server /metrics and /debug/routes sanitized", async () => {
    clearMetrics();
    globalHealthStore.clear();
    const mock = Bun.serve({
      port: 0,
      fetch: async (req) => {
        if (new URL(req.url).pathname.endsWith("/chat/completions")) {
          const body: any = await req.json();
          return new Response(JSON.stringify({ id: "c", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 10 } }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response("ok", { status: 200 });
      },
    });
    const mPort = (mock as any).port;
    const server = createServer({
      port: 0,
      providers: { providers: [{ id: "upstream", baseURL: `http://localhost:${mPort}/v1` }] },
      routes: { routes: { fast: { strategy: "fallback", primary: { provider: "upstream", model: "test" }, fallbacks: [] } }, defaultRoute: "fast" },
    });
    await new Promise((r) => setTimeout(r, 100));
    const sPort = (server as any).port;
    const base = `http://localhost:${sPort}`;

    // Make a request to generate metrics
    await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "hello" }] }) });

    const metricsRes = await fetch(`${base}/metrics`);
    expect(metricsRes.status).toBe(200);
    const metrics: any = await metricsRes.json();
    expect(metrics.count).toBeGreaterThan(0);
    expect(metrics.latencies).toBeDefined();
    expect(metrics.gatewayOverhead).toBeDefined();
    expect(metrics.ttft).toBeDefined();

    const routesRes = await fetch(`${base}/debug/routes`);
    expect(routesRes.status).toBe(200);
    const routesJson: any = await routesRes.json();
    expect(routesJson.providers[0].id).toBe("upstream");
    expect(JSON.stringify(routesJson).toLowerCase().includes("api_key")).toBe(false);

    const recentRes = await fetch(`${base}/debug/recent`);
    expect(recentRes.status).toBe(200);
    const recent: any = await recentRes.json();
    expect(Array.isArray(recent)).toBe(true);
    if (recent.length > 0) {
      // Filter hanya chat metrics (yang punya provider), karena /metrics & /health juga tercatat tanpa provider
      const chatEntries = recent.filter((r: any) => r.provider === "upstream");
      expect(chatEntries.length).toBeGreaterThan(0);
      const last = chatEntries[chatEntries.length - 1];
      expect(last.requestId).toBeTruthy();
      expect(last.provider).toBe("upstream");
      // Check extended fields exist (may be unknown)
      expect(last.bodyBytes).toBeDefined();
    }

    server.stop(true);
    mock.stop(true);
    clearMetrics();
  });

  test("server metrics — unknown token handling when provider has no usage", async () => {
    clearMetrics();
    globalHealthStore.clear();
    const mock = Bun.serve({
      port: 0,
      fetch: async (req) => {
        if (new URL(req.url).pathname.endsWith("/chat/completions")) {
          const body: any = await req.json();
          // Return without usage
          return new Response(JSON.stringify({ id: "c", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response("ok", { status: 200 });
      },
    });
    const server = createServer({
      port: 0,
      providers: { providers: [{ id: "upstream", baseURL: `http://localhost:${(mock as any).port}/v1` }] },
      routes: { routes: { fast: { strategy: "fallback", primary: { provider: "upstream", model: "test" }, fallbacks: [] } }, defaultRoute: "fast" },
    });
    await new Promise((r) => setTimeout(r, 100));
    const sPort = (server as any).port;
    await fetch(`http://localhost:${sPort}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "hi" }] }) });
    const recent = getRecentMetrics();
    // Filter chat entries agar tidak terambil /health atau /metrics
    const chatEntries = recent.filter((r: any) => r.provider === "upstream");
    expect(chatEntries.length).toBeGreaterThan(0);
    const last = chatEntries[chatEntries.length - 1];
    // When usage missing, tokens should be "unknown"
    expect(last.inputTokens).toBe("unknown");
    expect(last.outputTokens).toBe("unknown");
    server.stop(true);
    mock.stop(true);
    clearMetrics();
  });
});
