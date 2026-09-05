import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { applyHeadroom, resetHeadroomHealth, getHeadroomHealth, clearHeadroomCache } from "../src/optimizer/headroom.ts";
import { createServer } from "../src/server/server.ts";
import { clearMetrics, getRecentMetrics } from "../src/telemetry/metrics.ts";
import type { RequestProfile } from "../src/router/profile.ts";

function mockProfile(estimatedTokens = 500, bodyBytes = 2000, toolHistoryBytes = 0, messageCount = 5): RequestProfile {
  return {
    estimatedTokens,
    bodyBytes,
    messageBytes: bodyBytes - 200,
    toolBytes: 0,
    toolHistoryBytes,
    messageCount,
    toolCount: 0,
    toolResultCount: 0,
    hasTools: false,
    hasToolResults: false,
  };
}

function chatReq(messages: any[], model = "test-model") {
  return { model, messages } as any;
}

function createMockHeadroomServer(handler: (req: Request) => Response | Promise<Response>) {
  return Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/health" || url.pathname.endsWith("/health")) {
        return new Response("ok", { status: 200 });
      }
      return handler(req);
    },
  });
}

describe("Phase 6 — Headroom", () => {
  beforeEach(() => {
    resetHeadroomHealth();
    clearMetrics();
  });

  test("disabled → skipped disabled", async () => {
    const req = chatReq([{ role: "user", content: "hello".repeat(5000) }]);
    const profile = mockProfile(15000, 20000);
    const result = await applyHeadroom(req, profile, { enabled: false, url: "http://localhost:8787" });
    expect(result.enabled).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("disabled");
    expect(result.success).toBe(false);
  });

  test("below threshold (small) → skipped below_min_tokens", async () => {
    const req = chatReq([{ role: "user", content: "tiny" }]);
    const profile = mockProfile(500, 1000); // 500 tokens < 10000
    const result = await applyHeadroom(req, profile, { enabled: true, url: "http://localhost:8787", minimumTokens: 10000 });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("below_min_tokens");
  });

  test("missing_url → skipped", async () => {
    const req = chatReq([{ role: "user", content: "x".repeat(50000) }]);
    const profile = mockProfile(15000, 50000);
    const prev = process.env.HEADROOM_URL;
    delete process.env.HEADROOM_URL;
    const result = await applyHeadroom(req, profile, { enabled: true, minimumTokens: 10000 });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("missing_url");
    if (prev) process.env.HEADROOM_URL = prev;
  });

  test("large context → compress success", async () => {
    const content = "A".repeat(5000) + " B".repeat(5000);
    const req = chatReq([
      { role: "system", content: "You are helpful" },
      { role: "user", content: content },
      { role: "assistant", content: "response".repeat(100) },
      { role: "user", content: "another large content ".repeat(500) },
    ]);
    const profile = mockProfile(15000, 20000, 5000, 10);

    // Mock headroom that compresses messages to half
    const mock = createMockHeadroomServer(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/v1/compress" && req.method === "POST") {
        const body: any = await req.json();
        const compressed = body.messages.map((m: any) => {
          if (typeof m.content === "string") return { ...m, content: m.content.slice(0, Math.floor(m.content.length * 0.4)) };
          if (Array.isArray(m.content)) return { ...m, content: m.content.slice(0, 1) };
          return m;
        });
        return new Response(JSON.stringify({ messages: compressed, stats: { tokens_before: 15000, tokens_after: 6000, tokens_saved: 9000 } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    });
    const port = (mock as any).port;
    const url = `http://localhost:${port}`;

    const before = JSON.stringify(req);
    const result = await applyHeadroom(req, profile, { enabled: true, url, minimumTokens: 10000, timeoutMs: 500 });
    expect(result.success).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.savedBytes).toBeGreaterThan(0);
    expect(result.savedPercent).toBeGreaterThan(5);
    expect(result.outputBytes).toBeLessThan(result.inputBytes);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeLessThan(500);
    expect(result.inputMessages).toBe(4);
    expect(result.outputMessages).toBe(4);
    expect(JSON.stringify(req).length).toBeLessThan(before.length);

    mock.stop(true);
  });

  test("compression saves nothing → skip no_saving", async () => {
    const req = chatReq([{ role: "user", content: "x".repeat(20000) }]);
    const profile = mockProfile(15000, 20000);

    // Mock returns same messages (no saving)
    const mock = createMockHeadroomServer(async (req) => {
      const body: any = await req.json();
      return new Response(JSON.stringify({ messages: body.messages }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const result = await applyHeadroom(req, profile, { enabled: true, url: `http://localhost:${(mock as any).port}`, minimumTokens: 10000 });
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("no_saving");
    mock.stop(true);
  });

  test("proxy throws / timeout → fail-open", async () => {
    const req = chatReq([{ role: "user", content: "x".repeat(20000) }]);
    const profile = mockProfile(15000, 20000);
    const before = JSON.stringify(req);

    // Mock that delays > timeout
    const mock = createMockHeadroomServer(async () => {
      await new Promise((r) => setTimeout(r, 1000));
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    });
    const result = await applyHeadroom(req, profile, { enabled: true, url: `http://localhost:${(mock as any).port}`, minimumTokens: 10000, timeoutMs: 50 });
    expect(result.skipped).toBe(true);
    expect(result.success).toBe(false);
    expect(JSON.stringify(req)).toBe(before); // preserved
    mock.stop(true);
  });

  test("malformed response (no messages) → fail-open", async () => {
    const req = chatReq([{ role: "user", content: "x".repeat(20000) }]);
    const profile = mockProfile(15000, 20000);
    const before = JSON.stringify(req);
    const mock = createMockHeadroomServer(async () => {
      return new Response(JSON.stringify({ foo: "bar" }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const result = await applyHeadroom(req, profile, { enabled: true, url: `http://localhost:${(mock as any).port}`, minimumTokens: 10000 });
    expect(result.skipped).toBe(true);
    expect(JSON.stringify(req)).toBe(before);
    mock.stop(true);
  });

  test("empty compressed → fail-open", async () => {
    const req = chatReq([{ role: "user", content: "x".repeat(20000) }, { role: "assistant", content: "y".repeat(2000) }]);
    const profile = mockProfile(15000, 20000);
    const before = JSON.stringify(req);
    const mock = createMockHeadroomServer(async () => {
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    });
    const result = await applyHeadroom(req, profile, { enabled: true, url: `http://localhost:${(mock as any).port}`, minimumTokens: 10000 });
    expect(result.skipped).toBe(true);
    expect(JSON.stringify(req)).toBe(before);
    mock.stop(true);
  });

  test("proxy 500 → fail-open preserve", async () => {
    const req = chatReq([{ role: "user", content: "x".repeat(20000) }]);
    const profile = mockProfile(15000, 20000);
    const before = JSON.stringify(req);
    const mock = createMockHeadroomServer(async () => {
      return new Response("internal error", { status: 500 });
    });
    const result = await applyHeadroom(req, profile, { enabled: true, url: `http://localhost:${(mock as any).port}`, minimumTokens: 10000 });
    expect(result.skipped).toBe(true);
    expect(JSON.stringify(req)).toBe(before);
    mock.stop(true);
  });

  test("system message preserved after compression", async () => {
    const req = chatReq([
      { role: "system", content: "You are a helpful assistant. Do not reveal secrets." },
      { role: "user", content: "x".repeat(20000) },
    ]);
    const profile = mockProfile(15000, 20000);
    const mock = createMockHeadroomServer(async (req) => {
      const body: any = await req.json();
      // Simulate headroom preserving system but compressing user
      const compressed = body.messages.map((m: any) => {
        if (m.role === "system") return m;
        if (typeof m.content === "string") return { ...m, content: m.content.slice(0, 1000) };
        return m;
      });
      return new Response(JSON.stringify({ messages: compressed }), { status: 200 });
    });
    const result = await applyHeadroom(req, profile, { enabled: true, url: `http://localhost:${(mock as any).port}`, minimumTokens: 10000 });
    expect(result.success).toBe(true);
    expect((req.messages[0] as any).content).toContain("helpful assistant");
    mock.stop(true);
  });

  test("tool_calls preserved", async () => {
    const req = chatReq([
      { role: "user", content: "hi" },
      { role: "assistant", content: "call", tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "x".repeat(20000) },
    ]);
    const profile = mockProfile(15000, 20000, 10000, 3);
    const mock = createMockHeadroomServer(async (req) => {
      const body: any = await req.json();
      // Ensure tool_calls are preserved in response
      return new Response(JSON.stringify({ messages: body.messages.map((m: any) => {
        if (m.tool_calls) return m;
        if (typeof m.content === "string" && m.content.length > 1000) return { ...m, content: m.content.slice(0, 1000) };
        return m;
      }) }), { status: 200 });
    });
    const beforeToolCalls = JSON.stringify((req.messages[1] as any).tool_calls);
    const result = await applyHeadroom(req, profile, { enabled: true, url: `http://localhost:${(mock as any).port}`, minimumTokens: 10000 });
    expect(result.success).toBe(true);
    expect(JSON.stringify((req.messages[1] as any).tool_calls)).toBe(beforeToolCalls);
    mock.stop(true);
  });

  test("message ordering preserved", async () => {
    const req = chatReq([
      { role: "system", content: "system" },
      { role: "user", content: "user1 ".repeat(5000) },
      { role: "assistant", content: "assistant1" },
      { role: "user", content: "user2 ".repeat(5000) },
    ]);
    const profile = mockProfile(15000, 25000, 0, 4);
    const mock = createMockHeadroomServer(async (req) => {
      const body: any = await req.json();
      return new Response(JSON.stringify({ messages: body.messages.slice(0, 2).concat(body.messages.slice(2).map((m: any) => ({ ...m, content: typeof m.content === "string" ? m.content.slice(0, 100) : m.content }))) }), { status: 200 });
    });
    const result = await applyHeadroom(req, profile, { enabled: true, url: `http://localhost:${(mock as any).port}`, minimumTokens: 10000 });
    expect(result.success).toBe(true);
    expect((req.messages[0] as any).role).toBe("system");
    expect((req.messages[1] as any).role).toBe("user");
    expect((req.messages[2] as any).role).toBe("assistant");
    mock.stop(true);
  });

  test("streaming request compatibility", async () => {
    // Headroom runs before routing, so streaming flag should not affect it
    const content = "x".repeat(20000);
    const req = chatReq([{ role: "user", content }, { role: "tool", tool_call_id: "1", content: "y".repeat(10000) }], "test");
    (req as any).stream = true;
    const profile = mockProfile(15000, 30000, 10000, 2);
    const mockHeadroom = createMockHeadroomServer(async (req) => {
      const body: any = await req.json();
      return new Response(JSON.stringify({ messages: body.messages.map((m: any) => typeof m.content === "string" ? { ...m, content: m.content.slice(0, 500) } : m) }), { status: 200 });
    });
    const result = await applyHeadroom(req, profile, { enabled: true, url: `http://localhost:${(mockHeadroom as any).port}`, minimumTokens: 10000 });
    expect(result.success).toBe(true);
    expect((req as any).stream).toBe(true); // streaming flag preserved
    mockHeadroom.stop(true);
  });

  test("RTK + Headroom combined", async () => {
    // Create a request with both tool output (RTK) and large history (Headroom)
    const gitDiff = await Bun.file("tests/fixtures/rtk/gitDiff.txt").text();
    const largeHistory = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `History ${i} ` + "z".repeat(2000) }));
    // We test via gateway integration with both enabled
    const mockProvider = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body: any = await req.json();
        return new Response(JSON.stringify({ id: "c", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), { status: 200 });
      },
    });
    const mockHeadroom = createMockHeadroomServer(async (req) => {
      const body: any = await req.json();
      // Simple headroom: truncate large history to 50%
      const compressed = body.messages.map((m: any) => {
        if (typeof m.content === "string" && m.content.length > 1000) return { ...m, content: m.content.slice(0, 500) };
        return m;
      });
      return new Response(JSON.stringify({ messages: compressed }), { status: 200 });
    });

    const gateway = createServer({
      port: 0,
      providers: { providers: [{ id: "upstream", baseURL: `http://localhost:${(mockProvider as any).port}/v1` }] },
      routes: { routes: { fast: { strategy: "fallback", primary: { provider: "upstream", model: "test" }, fallbacks: [], optimizers: { rtk: true, headroom: true } } }, defaultRoute: "fast" },
      optimization: { optimizers: { rtk: { enabled: true }, headroom: { enabled: true, minimumTokens: 500, timeoutMs: 500, url: `http://localhost:${(mockHeadroom as any).port}` } } },
    });
    await new Promise((r) => setTimeout(r, 100));
    const port = (gateway as any).port;
    clearMetrics();
    const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test",
        messages: [
          { role: "user", content: "hi" },
          { role: "tool", tool_call_id: "1", content: gitDiff },
          ...largeHistory,
        ],
      }),
    });
    expect(res.status).toBe(200);
    const metric = getRecentMetrics().slice(-1)[0] as any;
    expect(metric.rtk).toBeDefined();
    expect(metric.headroom).toBeDefined();
    expect(metric.rtk.enabled).toBe(true);
    expect(metric.headroom.enabled).toBe(true);
    // Both should have attempted; at least one should succeed (RTK will succeed for gitDiff, Headroom for history)
    expect(metric.rtk.success || metric.headroom.success).toBe(true);
    gateway.stop(true);
    mockProvider.stop(true);
    mockHeadroom.stop(true);
  });

  test("per-route override", async () => {
    const reqLarge = chatReq([{ role: "user", content: "x".repeat(30000) }]);
    const profile = mockProfile(15000, 30000);

    // Route fast disabled, balanced enabled — test via gateway
    const mockHeadroom = createMockHeadroomServer(async (req) => {
      const body: any = await req.json();
      return new Response(JSON.stringify({ messages: body.messages.map((m: any) => ({ ...m, content: m.content.slice(0, 100) })) }), { status: 200 });
    });
    const mockProvider = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body: any = await req.json();
        return new Response(JSON.stringify({ id: "c", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), { status: 200 });
      },
    });

    const gatewayFast = createServer({
      port: 0,
      providers: { providers: [{ id: "upstream", baseURL: `http://localhost:${(mockProvider as any).port}/v1` }] },
      routes: { routes: { fast: { strategy: "fallback", primary: { provider: "upstream", model: "test" }, fallbacks: [], optimizers: { rtk: false, headroom: false } } }, defaultRoute: "fast" },
      optimization: { optimizers: { rtk: false, headroom: { enabled: true, minimumTokens: 500, url: `http://localhost:${(mockHeadroom as any).port}` } } },
    });
    await new Promise((r) => setTimeout(r, 100));
    clearMetrics();
    const resFast = await fetch(`http://localhost:${(gatewayFast as any).port}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "x".repeat(20000) }] }),
    });
    expect(resFast.status).toBe(200);
    const metricFast = getRecentMetrics().slice(-1)[0] as any;
    expect(metricFast.headroom.enabled).toBe(false); // per-route false overrides global true

    const gatewayBalanced = createServer({
      port: 0,
      providers: { providers: [{ id: "upstream", baseURL: `http://localhost:${(mockProvider as any).port}/v1` }] },
      routes: { routes: { balanced: { strategy: "fallback", primary: { provider: "upstream", model: "test" }, fallbacks: [], optimizers: { rtk: false, headroom: true } } }, defaultRoute: "balanced" },
      optimization: { optimizers: { headroom: { enabled: false, minimumTokens: 500 } } },
    });
    await new Promise((r) => setTimeout(r, 100));
    clearMetrics();
    const resBal = await fetch(`http://localhost:${(gatewayBalanced as any).port}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "x".repeat(20000) }] }),
    });
    expect(resBal.status).toBe(200);
    const metricBal = getRecentMetrics().slice(-1)[0] as any;
    expect(metricBal.headroom.enabled).toBe(true); // per-route true overrides global false

    gatewayFast.stop(true);
    gatewayBalanced.stop(true);
    mockProvider.stop(true);
    mockHeadroom.stop(true);
  });

  test("telemetry — headroom metrics in /metrics and /debug/recent", async () => {
    const mockHeadroom = createMockHeadroomServer(async (req) => {
      const body: any = await req.json();
      return new Response(JSON.stringify({ messages: body.messages.map((m: any) => ({ ...m, content: typeof m.content === "string" ? m.content.slice(0, 100) : m.content })) }), { status: 200 });
    });
    const mockProvider = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body: any = await req.json();
        return new Response(JSON.stringify({ id: "c", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), { status: 200 });
      },
    });
    const gateway = createServer({
      port: 0,
      providers: { providers: [{ id: "upstream", baseURL: `http://localhost:${(mockProvider as any).port}/v1` }] },
      routes: { routes: { fast: { strategy: "fallback", primary: { provider: "upstream", model: "test" }, fallbacks: [], optimizers: { headroom: true } } }, defaultRoute: "fast" },
      optimization: { optimizers: { headroom: { enabled: true, minimumTokens: 500, url: `http://localhost:${(mockHeadroom as any).port}` } } },
    });
    await new Promise((r) => setTimeout(r, 100));
    const port = (gateway as any).port;
    await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "x".repeat(20000) }] }),
    });
    const metricsRes = await fetch(`http://localhost:${port}/metrics`);
    expect(metricsRes.status).toBe(200);
    const metrics: any = await metricsRes.json();
    expect(metrics.recent.length).toBeGreaterThan(0);
    const recentRes = await fetch(`http://localhost:${port}/debug/recent`);
    const recent: any = await recentRes.json();
    const last = recent[recent.length - 1];
    expect(last.headroom).toBeDefined();
    expect(last.headroom.inputBytes).toBeGreaterThan(0);
    expect(last.headroom.savedBytes).toBeGreaterThanOrEqual(0);
    expect(last.headroom.durationMs).toBeGreaterThanOrEqual(0);
    gateway.stop(true);
    mockProvider.stop(true);
    mockHeadroom.stop(true);
  });

  test("global config headroom enabled but route disabled → skip", async () => {
    const req = chatReq([{ role: "user", content: "x".repeat(30000) }]);
    const profile = mockProfile(15000, 30000);
    // Simulate server resolution: route rtk false overrides global true
    // Directly test applyHeadroom with enabled false
    const result = await applyHeadroom(req, profile, { enabled: false, url: "http://localhost:8787" });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("disabled");
  });

  test("function.arguments JSON deep integrity after Headroom", async () => {
    const argsObj = { cmd: "ls -la", path: "/tmp", flags: ["-a", "-l"] };
    const argsStr = JSON.stringify(argsObj);
    const req = chatReq([
      { role: "user", content: "hi" },
      { role: "assistant", content: "call", tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: argsStr } }] },
      { role: "tool", tool_call_id: "call_1", content: "x".repeat(25000) },
    ]);
    const profile = mockProfile(15000, 30000, 10000, 3);
    const beforeArgs = (req.messages[1] as any).tool_calls[0].function.arguments;
    const mock = createMockHeadroomServer(async (req) => {
      const body: any = await req.json();
      // Simulate headroom that tries to compress tool result but must not touch tool_calls
      return new Response(JSON.stringify({ messages: body.messages.map((m: any) => {
        if (m.tool_calls) return m; // preserve
        if (typeof m.content === "string" && m.content.length > 1000) return { ...m, content: m.content.slice(0, 800) };
        return m;
      }) }), { status: 200 });
    });
    const result = await applyHeadroom(req, profile, { enabled: true, url: `http://localhost:${(mock as any).port}`, minimumTokens: 10000 });
    expect(result.success).toBe(true);
    const afterArgs = (req.messages[1] as any).tool_calls[0].function.arguments;
    expect(afterArgs).toBe(beforeArgs); // string preserved
    // Deep JSON parse must succeed and be equal
    expect(JSON.parse(afterArgs)).toEqual(argsObj);
    // Also ensure tool_call_id linkage preserved
    expect((req.messages[2] as any).tool_call_id).toBe("call_1");
    mock.stop(true);
  });

  test("tool_call_id linkage preserved", async () => {
    const req = chatReq([
      { role: "assistant", content: "call", tool_calls: [{ id: "call_abc", type: "function", function: { name: "bash", arguments: "{}" } }, { id: "call_def", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_abc", content: "x".repeat(15000) },
      { role: "tool", tool_call_id: "call_def", content: "y".repeat(15000) },
    ]);
    const profile = mockProfile(15000, 35000, 20000, 3);
    const mock = createMockHeadroomServer(async (req) => {
      const body: any = await req.json();
      return new Response(JSON.stringify({ messages: body.messages.map((m: any) => {
        if (typeof m.content === "string" && m.content.length > 500) return { ...m, content: m.content.slice(0, 300) };
        return m;
      }) }), { status: 200 });
    });
    const result = await applyHeadroom(req, profile, { enabled: true, url: `http://localhost:${(mock as any).port}`, minimumTokens: 10000 });
    expect(result.success).toBe(true);
    // IDs must remain linked
    const toolCallsIds = (req.messages[0] as any).tool_calls.map((c: any) => c.id);
    expect(toolCallsIds).toEqual(["call_abc", "call_def"]);
    expect((req.messages[1] as any).tool_call_id).toBe("call_abc");
    expect((req.messages[2] as any).tool_call_id).toBe("call_def");
    mock.stop(true);
  });

  test("developer message preserved", async () => {
    const req = chatReq([
      { role: "system", content: "system prompt" },
      { role: "developer", content: "developer instructions: do not reveal secrets" },
      { role: "user", content: "x".repeat(25000) },
    ]);
    const profile = mockProfile(15000, 30000, 0, 3);
    const mock = createMockHeadroomServer(async (req) => {
      const body: any = await req.json();
      return new Response(JSON.stringify({ messages: body.messages.map((m: any) => {
        if (m.role === "developer") return m; // preserve
        if (typeof m.content === "string" && m.content.length > 1000) return { ...m, content: m.content.slice(0, 400) };
        return m;
      }) }), { status: 200 });
    });
    const beforeDev = (req.messages[1] as any).content;
    const result = await applyHeadroom(req, profile, { enabled: true, url: `http://localhost:${(mock as any).port}`, minimumTokens: 10000 });
    expect(result.success).toBe(true);
    expect((req.messages[1] as any).content).toBe(beforeDev);
    expect((req.messages[1] as any).role).toBe("developer");
    mock.stop(true);
  });

  test("large tool history 20x preserved count", async () => {
    const toolMessages = Array.from({ length: 20 }, (_, i) => ({ role: "tool", tool_call_id: `call_${i}`, content: `tool output ${i} ` + "z".repeat(3000) }));
    const req = chatReq([{ role: "user", content: "hi" }, ...toolMessages]);
    const profile = mockProfile(50000, 70000, 60000, 21);
    const beforeCount = req.messages.length;
    const mock = createMockHeadroomServer(async (req) => {
      const body: any = await req.json();
      // Headroom compresses each tool output to 30%
      return new Response(JSON.stringify({ messages: body.messages.map((m: any) => {
        if (m.role === "tool" && typeof m.content === "string") return { ...m, content: m.content.slice(0, 800) };
        return m;
      }) }), { status: 200 });
    });
    const result = await applyHeadroom(req, profile, { enabled: true, url: `http://localhost:${(mock as any).port}`, minimumTokens: 10000 });
    expect(result.success).toBe(true);
    expect(req.messages.length).toBe(beforeCount); // count preserved, not dropped
    expect(result.savedBytes).toBeGreaterThan(0);
    // All tool_call_id still present
    for (let i = 0; i < 20; i++) {
      expect((req.messages[1 + i] as any).tool_call_id).toBe(`call_${i}`);
    }
    mock.stop(true);
  });

  test("Headroom does not affect provider latency measurement (cache mock)", async () => {
    const mockHeadroom = createMockHeadroomServer(async (req) => {
      const body: any = await req.json();
      return new Response(JSON.stringify({ messages: body.messages.map((m: any) => ({ ...m, content: typeof m.content === "string" ? m.content.slice(0, 500) : m.content })) }), { status: 200 });
    });
    const mockProvider = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/chat/completions")) {
          const body: any = await req.json();
          // Simulate provider with cache: if body is smaller, provider latency slightly less but still 15ms base
          await new Promise((r) => setTimeout(r, 15));
          return new Response(JSON.stringify({ id: "c", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, cached_tokens: 200, completion_tokens: 10 } }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const gateway = createServer({
      port: 0,
      providers: { providers: [{ id: "upstream", baseURL: `http://localhost:${(mockProvider as any).port}/v1` }] },
      routes: { routes: { fast: { strategy: "fallback", primary: { provider: "upstream", model: "test" }, fallbacks: [], optimizers: { headroom: true } } }, defaultRoute: "fast" },
      optimization: { optimizers: { headroom: { enabled: true, minimumTokens: 500, url: `http://localhost:${(mockHeadroom as any).port}` } } },
    });
    await new Promise((r) => setTimeout(r, 100));
    clearMetrics();
    const res = await fetch(`http://localhost:${(gateway as any).port}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "x".repeat(20000) }, { role: "tool", tool_call_id: "1", content: "y".repeat(15000) }] }),
    });
    expect(res.status).toBe(200);
    const metric = getRecentMetrics().slice(-1)[0] as any;
    expect(metric.providerLatencyMs).toBeGreaterThan(0);
    expect(metric.headroomDurationMs).toBeGreaterThanOrEqual(0);
    expect(metric.headroomDurationMs).toBeLessThan(metric.totalLatencyMs ?? 1000);
    // Provider latency should be measured separately from headroomDuration
    expect(metric.gatewayOverheadMs).toBeGreaterThanOrEqual(0);
    gateway.stop(true);
    mockProvider.stop(true);
    mockHeadroom.stop(true);
  });

  test("compressUserMessages forwarded to proxy config", async () => {
    let receivedConfig: any = null;
    const req = chatReq([{ role: "system", content: "sys" }, { role: "user", content: "x".repeat(20000) }]);
    const profile = mockProfile(15000, 20000);
    const mock = createMockHeadroomServer(async (req) => {
      const body: any = await req.json();
      receivedConfig = body.config;
      return new Response(JSON.stringify({ messages: body.messages.map((m: any) => ({ ...m, content: typeof m.content === "string" ? m.content.slice(0, 500) : m.content })) }), { status: 200 });
    });
    await applyHeadroom(req, profile, { enabled: true, url: `http://localhost:${(mock as any).port}`, minimumTokens: 10000, compressUserMessages: true });
    expect(receivedConfig).toEqual({ compress_user_messages: true });
    mock.stop(true);
  });

  test("cache reuse: identical request within TTL → single proxy call", async () => {
    let calls = 0;
    const req = chatReq([{ role: "user", content: "x".repeat(20000) }]);
    const profile = mockProfile(15000, 20000);
    const mock = createMockHeadroomServer(async (req) => {
      calls++;
      const body: any = await req.json();
      return new Response(JSON.stringify({ messages: body.messages.map((m: any) => ({ ...m, content: m.content.slice(0, 500) })) }), { status: 200 });
    });
    const url = `http://localhost:${(mock as any).port}`;
    clearHeadroomCache();
    const r1 = await applyHeadroom(req, profile, { enabled: true, url, minimumTokens: 10000, cacheTtlMs: 3000 });
    expect(r1.success).toBe(true);
    expect(calls).toBe(1);
    const req2 = chatReq([{ role: "user", content: "x".repeat(20000) }]);
    const r2 = await applyHeadroom(req2, profile, { enabled: true, url, minimumTokens: 10000, cacheTtlMs: 3000 });
    expect(r2.reason).toBe("cached");
    expect(r2.success).toBe(true);
    expect(calls).toBe(1);
    mock.stop(true);
  });

  test("circuit-breaker trip on health-probe failure → cooldown skip", async () => {
    const mock = Bun.serve({
      port: 0,
      fetch: async () => new Response("down", { status: 500 }),
    });
    const req = chatReq([{ role: "user", content: "x".repeat(20000) }]);
    const profile = mockProfile(15000, 20000);
    const url = `http://localhost:${(mock as any).port}`;
    resetHeadroomHealth();
    clearHeadroomCache();
    for (let i = 0; i < 2; i++) {
      const r = await applyHeadroom(req, profile, { enabled: true, url, minimumTokens: 10000, maxConsecutiveFailures: 2, cooldownMs: 60000, healthProbeMs: 500 });
      expect(r.skipped).toBe(true);
      expect(r.reason).toContain("headroom_unhealthy");
    }
    expect(getHeadroomHealth().consecutiveFailures).toBeGreaterThanOrEqual(2);
    const r3 = await applyHeadroom(req, profile, { enabled: true, url, minimumTokens: 10000, maxConsecutiveFailures: 2, cooldownMs: 60000, healthProbeMs: 500 });
    expect(r3.skipped).toBe(true);
    expect(r3.reason).toContain("headroom_cooldown");
    resetHeadroomHealth();
    mock.stop(true);
  });

  test("threshold combined: minimumBytes & minimumTokens gate independently (AND)", async () => {
    const req = chatReq([{ role: "user", content: "x".repeat(20000) }]);
    // bodyBytes >= minimumBytes but estimatedTokens < minimumTokens → skip below_min_tokens
    const r1 = await applyHeadroom(req, mockProfile(500, 12000), { enabled: true, url: "http://localhost:8787", minimumTokens: 10000, minimumBytes: 6000 });
    expect(r1.skipped).toBe(true);
    expect(r1.reason).toBe("below_min_tokens");
    // bodyBytes < minimumBytes → skip below_min_bytes (tokens irrelevant)
    const r2 = await applyHeadroom(req, mockProfile(15000, 3000), { enabled: true, url: "http://localhost:8787", minimumTokens: 10000, minimumBytes: 6000 });
    expect(r2.skipped).toBe(true);
    expect(r2.reason).toBe("below_min_bytes");
  });

  test("probe timeout → fail-open compress succeeds (no breaker trip)", async () => {
    resetHeadroomHealth();
    clearHeadroomCache();
    // /health yang lambat (timeout), /v1/compress sukses cepat
    const mock = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/health")) {
          await new Promise((r) => setTimeout(r, 500));
          return new Response("ok", { status: 200 });
        }
        if (url.pathname.endsWith("/v1/compress")) {
          const body: any = await req.json();
          return new Response(JSON.stringify({ messages: body.messages.map((m: any) => ({ ...m, content: typeof m.content === "string" ? m.content.slice(0, 500) : m.content })) }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const req = chatReq([{ role: "user", content: "x".repeat(30000) }]);
    const profile = mockProfile(15000, 30000);
    const url = `http://localhost:${(mock as any).port}`;
    // healthProbeMs kecil → /health timeout (inconclusive), tetap fail-open ke compress
    const result = await applyHeadroom(req, profile, { enabled: true, url, minimumTokens: 10000, healthProbeMs: 100, timeoutMs: 800 });
    expect(result.success).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.reason).toBe("compressed");
    expect(getHeadroomHealth().consecutiveFailures).toBe(0); // timeout tidak dihitung sebagai failure
    resetHeadroomHealth();
    mock.stop(true);
  });

  test("probe timeout fail-open → refresh health cache on success", async () => {
    resetHeadroomHealth();
    clearHeadroomCache();
    let healthCalls = 0;
    let compressCalls = 0;
    const mock = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/health")) {
          healthCalls++;
          await new Promise((r) => setTimeout(r, 400));
          return new Response("ok", { status: 200 });
        }
        if (url.pathname.endsWith("/v1/compress")) {
          compressCalls++;
          const body: any = await req.json();
          return new Response(JSON.stringify({ messages: body.messages.map((m: any) => ({ ...m, content: typeof m.content === "string" ? m.content.slice(0, 500) : m.content })) }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const req = chatReq([{ role: "user", content: "x".repeat(30000) }]);
    const profile = mockProfile(15000, 30000);
    const url = `http://localhost:${(mock as any).port}`;
    // First: probe timeout (inconclusive) → fail-open compress success → refresh health
    const r1 = await applyHeadroom(req, profile, { enabled: true, url, minimumTokens: 10000, healthProbeMs: 100, timeoutMs: 800, cacheTtlMs: 0 });
    expect(r1.success).toBe(true);
    expect(healthCalls).toBe(1);
    expect(getHeadroomHealth().lastHealthOk).toBe(true);
    // Second request reuses request content (new object), probe cached healthy → no re-probe
    const req2 = chatReq([{ role: "user", content: "x".repeat(30000) }]);
    const r2 = await applyHeadroom(req2, profile, { enabled: true, url, minimumTokens: 10000, healthProbeMs: 100, timeoutMs: 800, cacheTtlMs: 0 });
    expect(r2.success).toBe(true);
    // Probes di-cache healthy → tidak re-probe ke /health
    expect(healthCalls).toBe(1);
    resetHeadroomHealth();
    mock.stop(true);
  });
});
