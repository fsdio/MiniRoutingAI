import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Router } from "../src/router/router.ts";
import { HealthStore, globalHealthStore } from "../src/router/health.ts";
import { classifyError, shouldFallback } from "../src/router/policy.ts";
import { createServer } from "../src/server/server.ts";
import { clearMetrics } from "../src/telemetry/metrics.ts";

function mockCompletion(model: string) {
  return {
    id: `chatcmpl-${model}`,
    object: "chat.completion",
    created: 123,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: `ok from ${model}` }, finish_reason: "stop" }],
  };
}

function createMockServer(handler: (req: Request) => Response | Promise<Response>) {
  return Bun.serve({ port: 0, fetch: handler });
}

describe("Phase 3 — Routing + Fallback", () => {
  test("classifyError — deterministic 400", () => {
    expect(classifyError(400, { error: { message: "invalid request" } })).toBe("deterministic");
    expect(classifyError(400)).toBe("deterministic");
  });
  test("classifyError — transient 500/429/408/503", () => {
    expect(classifyError(500)).toBe("server_error");
    expect(classifyError(429)).toBe("rate_limit");
    expect(classifyError(408)).toBe("timeout");
    expect(classifyError(503)).toBe("server_error");
    expect(classifyError(undefined, null, "timeout")).toBe("timeout");
    // Wave 1: subclass tetap fallback-able
    expect(shouldFallback("server_error")).toBe(true);
    expect(shouldFallback("rate_limit")).toBe(true);
    expect(shouldFallback("timeout")).toBe(true);
    expect(shouldFallback("context_overflow")).toBe(false);
  });
  test("classifyError — credential 401", () => {
    expect(classifyError(401)).toBe("credential");
    // 400 is deterministic even if message contains invalid api key (status takes precedence)
    expect(classifyError(400, null, "invalid api key")).toBe("deterministic");
    expect(classifyError(undefined, { error: { message: "invalid api key" } })).toBe("credential");
    expect(classifyError(401, { error: { message: "invalid request" } })).toBe("credential");
  });
  test("classifyError — unknown", () => {
    expect(classifyError(418)).toBe("unknown");
  });

  test("HealthStore — cooldown and recovery", async () => {
    let now = 1000;
    const store = new HealthStore({ cooldownMs: 1000, failureThreshold: 2, now: () => now });
    expect(store.isHealthy("p1", "m1")).toBe(true);
    store.markFailure("p1", "m1", "transient");
    expect(store.isHealthy("p1", "m1")).toBe(true); // only 1 failure, threshold 2
    store.markFailure("p1", "m1", "transient");
    expect(store.isHealthy("p1", "m1")).toBe(false); // 2 failures → cooldown
    now += 500;
    expect(store.isHealthy("p1", "m1")).toBe(false);
    now += 600; // total 1100 > cooldown
    expect(store.isHealthy("p1", "m1")).toBe(true); // recovered
    // success clears
    store.markFailure("p1", "m1", "transient");
    store.markFailure("p1", "m1", "transient");
    expect(store.isHealthy("p1", "m1")).toBe(false);
    store.markSuccess("p1", "m1");
    expect(store.isHealthy("p1", "m1")).toBe(true);
  });

  test("HealthStore — deterministic does not trigger cooldown", () => {
    const store = new HealthStore({ cooldownMs: 5000, failureThreshold: 1 });
    store.markFailure("p", "m", "deterministic");
    expect(store.isHealthy("p", "m")).toBe(true);
    store.markFailure("p", "m", "deterministic");
    store.markFailure("p", "m", "deterministic");
    expect(store.isHealthy("p", "m")).toBe(true);
  });

  test("HealthStore — credential triggers immediate cooldown", () => {
    const store = new HealthStore({ cooldownMs: 5000, failureThreshold: 5 });
    store.markFailure("p", "m", "credential");
    expect(store.isHealthy("p", "m")).toBe(false);
  });

  // Helper to create router with mocks
  test("Router — primary success → fallback not called", async () => {
    let primaryCalled = 0;
    let fallbackCalled = 0;
    const primaryMock = createMockServer(async (req) => {
      primaryCalled++;
      const body: any = await req.json();
      return new Response(JSON.stringify(mockCompletion(body.model)), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const fallbackMock = createMockServer(async (req) => {
      fallbackCalled++;
      const body: any = await req.json();
      return new Response(JSON.stringify(mockCompletion(body.model)), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const pPort = (primaryMock as any).port;
    const fPort = (fallbackMock as any).port;

    const router = new Router(
      {
        providers: {
          providers: [
            { id: "primary", baseURL: `http://localhost:${pPort}/v1`, models: ["*"] },
            { id: "fallback", baseURL: `http://localhost:${fPort}/v1`, models: ["*"] },
          ],
        },
        routes: {
          routes: {
            fast: {
              strategy: "fallback",
              primary: { provider: "primary", model: "model-a" },
              fallbacks: [{ provider: "fallback", model: "model-b" }],
              timeoutMs: 2000,
            },
          },
          defaultRoute: "fast",
        },
      },
      { healthStore: new HealthStore({ cooldownMs: 10000, failureThreshold: 10 }) },
    );

    const result = await router.routeChat({ model: "test-model", messages: [{ role: "user", content: "hi" }] });
    expect(result.provider).toBe("primary");
    expect(result.response?.model).toBe("model-a");
    expect(result.fallbackCount).toBe(0);
    expect(primaryCalled).toBe(1);
    expect(fallbackCalled).toBe(0);

    primaryMock.stop(true);
    fallbackMock.stop(true);
  });

  test("Router — primary transient failure → fallback can be called", async () => {
    const primaryMock = createMockServer(() =>
      new Response(JSON.stringify({ error: { message: "capacity", type: "server_error" } }), { status: 500, headers: { "Content-Type": "application/json" } }),
    );
    const fallbackMock = createMockServer(async (req) => {
      const body: any = await req.json();
      return new Response(JSON.stringify(mockCompletion(body.model)), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const pPort = (primaryMock as any).port;
    const fPort = (fallbackMock as any).port;

    const router = new Router(
      {
        providers: {
          providers: [
            { id: "primary", baseURL: `http://localhost:${pPort}/v1` },
            { id: "fallback", baseURL: `http://localhost:${fPort}/v1` },
          ],
        },
        routes: {
          routes: {
            fast: {
              strategy: "fallback",
              primary: { provider: "primary", model: "m-a" },
              fallbacks: [{ provider: "fallback", model: "m-b" }],
            },
          },
          defaultRoute: "fast",
        },
      },
      { healthStore: new HealthStore({ cooldownMs: 10000, failureThreshold: 10 }) },
    );

    const result = await router.routeChat({ model: "any", messages: [{ role: "user", content: "hi" }] });
    expect(result.provider).toBe("fallback");
    expect(result.model).toBe("m-b");
    expect(result.fallbackCount).toBe(1);
    expect(result.attempts.length).toBe(2);
    expect(result.attempts[0].errorClass).toBe("transient");
    expect(result.attempts[1].success).toBe(true);

    primaryMock.stop(true);
    fallbackMock.stop(true);
  });

  test("Router — multiple fallbacks chain", async () => {
    const p1 = createMockServer(() => new Response(JSON.stringify({ error: { message: "error" } }), { status: 500, headers: { "Content-Type": "application/json" } }));
    const p2 = createMockServer(() => new Response(JSON.stringify({ error: { message: "error" } }), { status: 502, headers: { "Content-Type": "application/json" } }));
    const p3 = createMockServer(async (req) => {
      const b: any = await req.json();
      return new Response(JSON.stringify(mockCompletion(b.model)), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const router = new Router(
      {
        providers: {
          providers: [
            { id: "p1", baseURL: `http://localhost:${(p1 as any).port}/v1` },
            { id: "p2", baseURL: `http://localhost:${(p2 as any).port}/v1` },
            { id: "p3", baseURL: `http://localhost:${(p3 as any).port}/v1` },
          ],
        },
        routes: {
          routes: {
            fast: {
              strategy: "fallback",
              primary: { provider: "p1", model: "m1" },
              fallbacks: [
                { provider: "p2", model: "m2" },
                { provider: "p3", model: "m3" },
              ],
            },
          },
          defaultRoute: "fast",
        },
      },
      { healthStore: new HealthStore({ cooldownMs: 10000, failureThreshold: 10 }) },
    );
    const result = await router.routeChat({ model: "x", messages: [{ role: "user", content: "hi" }] });
    expect(result.provider).toBe("p3");
    expect(result.fallbackCount).toBe(2);
    expect(result.attempts.length).toBe(3);
    p1.stop(true);
    p2.stop(true);
    p3.stop(true);
  });

  test("Router — deterministic failure → not retried/fallback", async () => {
    let fallbackCalled = 0;
    const primaryMock = createMockServer(() =>
      new Response(JSON.stringify({ error: { message: "invalid request: bad tool schema", type: "invalid_request_error" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const fallbackMock = createMockServer(() => {
      fallbackCalled++;
      return new Response(JSON.stringify(mockCompletion("fallback")), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const router = new Router(
      {
        providers: {
          providers: [
            { id: "primary", baseURL: `http://localhost:${(primaryMock as any).port}/v1` },
            { id: "fallback", baseURL: `http://localhost:${(fallbackMock as any).port}/v1` },
          ],
        },
        routes: {
          routes: {
            fast: { strategy: "fallback", primary: { provider: "primary", model: "m-a" }, fallbacks: [{ provider: "fallback", model: "m-b" }] },
          },
          defaultRoute: "fast",
        },
      },
      { healthStore: new HealthStore({ cooldownMs: 10000, failureThreshold: 10 }) },
    );
    let err: any = null;
    try {
      await router.routeChat({ model: "x", messages: [{ role: "user", content: "hi" }] });
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(err.status).toBe(400);
    expect(fallbackCalled).toBe(0);
    primaryMock.stop(true);
    fallbackMock.stop(true);
  });

  test("Router — credential failure → no retry loop", async () => {
    let primaryAttempts = 0;
    let fallbackCalled = 0;
    const primaryMock = createMockServer(() => {
      primaryAttempts++;
      return new Response(JSON.stringify({ error: { message: "invalid api key", type: "auth_error" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });
    const fallbackMock = createMockServer(() => {
      fallbackCalled++;
      return new Response(JSON.stringify(mockCompletion("f")), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const router = new Router(
      {
        providers: {
          providers: [
            { id: "primary", baseURL: `http://localhost:${(primaryMock as any).port}/v1` },
            { id: "fallback", baseURL: `http://localhost:${(fallbackMock as any).port}/v1` },
          ],
        },
        routes: {
          routes: {
            fast: { strategy: "fallback", primary: { provider: "primary", model: "m-a" }, fallbacks: [{ provider: "fallback", model: "m-b" }] },
          },
          defaultRoute: "fast",
        },
      },
      { healthStore: new HealthStore({ cooldownMs: 10000, failureThreshold: 10 }) },
    );
    let err: any = null;
    try {
      await router.routeChat({ model: "x", messages: [{ role: "user", content: "hi" }] });
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(err.status).toBe(401);
    expect(primaryAttempts).toBe(1);
    expect(fallbackCalled).toBe(0);
    primaryMock.stop(true);
    fallbackMock.stop(true);
  });

  test("Router — cooldown skips failing provider", async () => {
    let primaryCalled = 0;
    const primaryMock = createMockServer(() => {
      primaryCalled++;
      return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503, headers: { "Content-Type": "application/json" } });
    });
    const fallbackMock = createMockServer(async (req) => {
      const b: any = await req.json();
      return new Response(JSON.stringify(mockCompletion(b.model)), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    let now = Date.now();
    const store = new HealthStore({ cooldownMs: 5000, failureThreshold: 1, now: () => now });
    const router = new Router(
      {
        providers: {
          providers: [
            { id: "primary", baseURL: `http://localhost:${(primaryMock as any).port}/v1` },
            { id: "fallback", baseURL: `http://localhost:${(fallbackMock as any).port}/v1` },
          ],
        },
        routes: {
          routes: {
            fast: { strategy: "fallback", primary: { provider: "primary", model: "m-a" }, fallbacks: [{ provider: "fallback", model: "m-b" }] },
          },
          defaultRoute: "fast",
        },
      },
      { healthStore: store },
    );

    // First call: primary fails transient → fallback, primary marked cooldown
    const r1 = await router.routeChat({ model: "x", messages: [{ role: "user", content: "hi" }] });
    expect(r1.provider).toBe("fallback");
    expect(primaryCalled).toBe(1);
    expect(store.isHealthy("primary", "m-a")).toBe(false);

    // Second call immediately: primary should be skipped due to cooldown, directly fallback
    primaryCalled = 0;
    const r2 = await router.routeChat({ model: "x", messages: [{ role: "user", content: "hi" }] });
    expect(r2.provider).toBe("fallback");
    expect(primaryCalled).toBe(0);
    expect(r2.attempts[0].skippedDueToCooldown).toBe(true);

    // After cooldown expires, primary should be tried again
    now += 6000;
    expect(store.isHealthy("primary", "m-a")).toBe(true);
    // Make primary now succeed
    primaryMock.stop(true);
    const primaryMock2 = createMockServer(async (req) => {
      primaryCalled++;
      const b: any = await req.json();
      return new Response(JSON.stringify(mockCompletion(b.model)), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    // Need new router with same store but new provider URL
    const router2 = new Router(
      {
        providers: {
          providers: [
            { id: "primary", baseURL: `http://localhost:${(primaryMock2 as any).port}/v1` },
            { id: "fallback", baseURL: `http://localhost:${(fallbackMock as any).port}/v1` },
          ],
        },
        routes: {
          routes: {
            fast: { strategy: "fallback", primary: { provider: "primary", model: "m-a" }, fallbacks: [{ provider: "fallback", model: "m-b" }] },
          },
          defaultRoute: "fast",
        },
      },
      { healthStore: store },
    );
    primaryCalled = 0;
    const r3 = await router2.routeChat({ model: "x", messages: [{ role: "user", content: "hi" }] });
    expect(r3.provider).toBe("primary");
    expect(primaryCalled).toBe(1);

    fallbackMock.stop(true);
    primaryMock2.stop(true);
  });

  test("Gateway integration — fallback via server (primary 500 → fallback success)", async () => {
    // Use real gateway server with router
    const primaryMock = createMockServer(() =>
      new Response(JSON.stringify({ error: { message: "internal error" } }), { status: 500, headers: { "Content-Type": "application/json" } }),
    );
    const fallbackMock = createMockServer(async (req) => {
      const b: any = await req.json();
      return new Response(JSON.stringify(mockCompletion(b.model)), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const pPort = (primaryMock as any).port;
    const fPort = (fallbackMock as any).port;

    // Need fresh health store for this test
    const { globalHealthStore } = await import("../src/router/health.ts");
    globalHealthStore.clear();

    const gateway = createServer({
      port: 0,
      providers: {
        providers: [
          { id: "primary", baseURL: `http://localhost:${pPort}/v1` },
          { id: "fallback", baseURL: `http://localhost:${fPort}/v1` },
        ],
      },
      routes: {
        routes: {
          fast: { strategy: "fallback", primary: { provider: "primary", model: "m-a" }, fallbacks: [{ provider: "fallback", model: "m-b" }] },
        },
        defaultRoute: "fast",
      },
    });
    await new Promise((r) => setTimeout(r, 150));
    const gPort = (gateway as any).port;
    clearMetrics();

    const res = await fetch(`http://localhost:${gPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "any-model", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.model).toBe("m-b"); // fallback model
    expect(res.headers.get("x-provider")).toBe("fallback");
    expect(res.headers.get("x-fallback-count")).toBe("1");
    expect(res.headers.get("x-request-id")).toBeTruthy();

    gateway.stop(true);
    primaryMock.stop(true);
    fallbackMock.stop(true);
    globalHealthStore.clear();
  });

  test("Gateway integration — deterministic 400 does not fallback", async () => {
    const primaryMock = createMockServer(() =>
      new Response(JSON.stringify({ error: { message: "invalid request", type: "invalid_request_error" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const fallbackMock = createMockServer(async (req) => {
      const b: any = await req.json();
      return new Response(JSON.stringify(mockCompletion(b.model)), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const { globalHealthStore } = await import("../src/router/health.ts");
    globalHealthStore.clear();
    const gateway = createServer({
      port: 0,
      providers: {
        providers: [
          { id: "primary", baseURL: `http://localhost:${(primaryMock as any).port}/v1` },
          { id: "fallback", baseURL: `http://localhost:${(fallbackMock as any).port}/v1` },
        ],
      },
      routes: {
        routes: {
          fast: { strategy: "fallback", primary: { provider: "primary", model: "m-a" }, fallbacks: [{ provider: "fallback", model: "m-b" }] },
        },
        defaultRoute: "fast",
      },
    });
    await new Promise((r) => setTimeout(r, 100));
    const gPort = (gateway as any).port;
    const res = await fetch(`http://localhost:${gPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "any", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(400);
    const json: any = await res.json();
    expect(json.error).toBeDefined();
    gateway.stop(true);
    primaryMock.stop(true);
    fallbackMock.stop(true);
    globalHealthStore.clear();
  });

  test("Router — streaming fallback before first chunk", async () => {
    const primaryMock = createMockServer(() =>
      new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503, headers: { "Content-Type": "application/json" } }),
    );
    const fallbackMock = createMockServer(async (req) => {
      const body: any = await req.json();
      if (body.stream) {
        const chunks = [
          `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { content: "fallback stream" }, finish_reason: null }] })}\n\n`,
          `data: [DONE]\n\n`,
        ];
        let idx = 0;
        const stream = new ReadableStream({
          pull(controller) {
            if (idx < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[idx++]));
            else controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response(JSON.stringify(mockCompletion(body.model)), { status: 200 });
    });

    const router = new Router(
      {
        providers: {
          providers: [
            { id: "primary", baseURL: `http://localhost:${(primaryMock as any).port}/v1` },
            { id: "fallback", baseURL: `http://localhost:${(fallbackMock as any).port}/v1` },
          ],
        },
        routes: {
          routes: {
            fast: { strategy: "fallback", primary: { provider: "primary", model: "m-a" }, fallbacks: [{ provider: "fallback", model: "m-b" }] },
          },
          defaultRoute: "fast",
        },
      },
      { healthStore: new HealthStore({ cooldownMs: 10000, failureThreshold: 10 }) },
    );

    const result = await router.routeStream({ model: "x", messages: [{ role: "user", content: "hi" }], stream: true });
    expect(result.provider).toBe("fallback");
    expect(result.fallbackCount).toBe(1);
    const reader = result.stream!.getReader();
    const decoder = new TextDecoder();
    let full = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      full += decoder.decode(value);
    }
    expect(full).toContain("fallback stream");
    primaryMock.stop(true);
    fallbackMock.stop(true);
  });

  // === New: Model is unavailable fix verification ===
  test("classifyError — Model is unavailable harus transient (fallback)", () => {
    expect(classifyError(400, { error: { message: "Model is unavailable." } })).toBe("transient");
    expect(classifyError(400, { error: { message: "Model is unavailable" } }, "Model is unavailable.")).toBe("transient");
    expect(classifyError(404, { error: { message: "Model is unavailable" } })).toBe("transient");
    expect(classifyError(503, { error: { message: "Model is unavailable" } })).toBe("transient");
    expect(classifyError(429, { error: { message: "Model is unavailable" } })).toBe("transient");
    expect(classifyError(undefined, { error: { message: "Model is unavailable" } }, "Upstream request failed: Model is unavailable.")).toBe("transient");
    expect(classifyError(400, null, "upstream request failed: model is unavailable")).toBe("transient");
    // Pastikan model not found tetap deterministic (jangan tertukar)
    expect(classifyError(404, { error: { message: "model not found" } })).toBe("deterministic");
    expect(classifyError(400, { error: { message: "invalid request: model not found" } })).toBe("deterministic");
  });

  test("Router — Model is unavailable (400) transient fallback → success", async () => {
    let fallbackCalled = 0;
    const primaryMock = createMockServer(() =>
      new Response(JSON.stringify({ error: { message: "Model is unavailable.", type: "server_error" } }), { status: 400, headers: { "Content-Type": "application/json" } }),
    );
    const fallbackMock = createMockServer(async (req) => {
      fallbackCalled++;
      const b: any = await req.json();
      return new Response(JSON.stringify(mockCompletion(b.model)), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const router = new Router(
      {
        providers: {
          providers: [
            { id: "primary", baseURL: `http://localhost:${(primaryMock as any).port}/v1` },
            { id: "fallback", baseURL: `http://localhost:${(fallbackMock as any).port}/v1` },
          ],
        },
        routes: {
          routes: {
            fast: { strategy: "fallback", primary: { provider: "primary", model: "m-a" }, fallbacks: [{ provider: "fallback", model: "m-b" }] },
          },
          defaultRoute: "fast",
        },
      },
      { healthStore: new HealthStore({ cooldownMs: 10000, failureThreshold: 10 }) },
    );
    const result = await router.routeChat({ model: "x", messages: [{ role: "user", content: "hi" }] });
    expect(result.provider).toBe("fallback");
    expect(result.fallbackCount).toBe(1);
    expect(fallbackCalled).toBe(1);
    expect(result.attempts[0].errorClass).toBe("transient");
    primaryMock.stop(true);
    fallbackMock.stop(true);
  });

  test("HealthStore — Model is unavailable langsung cooldown (threshold 1 & isUnavailable)", async () => {
    let now = 1000;
    const store = new HealthStore({ cooldownMs: 5000, failureThreshold: 10, now: () => now });
    // Transient biasa tanpa unavailable butuh threshold 10 → tidak cooldown di 1 failure
    store.markFailure("p", "m", "transient");
    expect(store.isHealthy("p", "m")).toBe(true);
    store.clear();
    // Dengan isUnavailable true, langsung cooldown walau threshold 10
    const store2 = new HealthStore({ cooldownMs: 5000, failureThreshold: 10, now: () => now });
    (store2 as any).markFailure("p", "m", "transient", { isUnavailable: true });
    expect(store2.isHealthy("p", "m")).toBe(false);
    now += 6000;
    expect(store2.isHealthy("p", "m")).toBe(true);
  });

  test("HealthStore — global default threshold 1 immediate cooldown untuk transient", () => {
    const store = new HealthStore({ cooldownMs: 5000 }); // default threshold 1
    store.markFailure("p", "m", "transient");
    expect(store.isHealthy("p", "m")).toBe(false);
  });

  test("Router — cache-aware-sticky keeps same target across requests for warm cache", async () => {
    let p1Called = 0;
    let p2Called = 0;
    const p1Mock = createMockServer(async (req) => {
      p1Called++;
      const body: any = await req.json();
      return new Response(JSON.stringify(mockCompletion(body.model)), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const p2Mock = createMockServer(async (req) => {
      p2Called++;
      const body: any = await req.json();
      return new Response(JSON.stringify(mockCompletion(body.model)), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const router = new Router({
      providers: {
        providers: [
          { id: "ollama-cloud", baseURL: `http://localhost:${(p1Mock as any).port}/v1` },
          { id: "opencode-go", baseURL: `http://localhost:${(p2Mock as any).port}/v1` },
        ],
      },
      routes: {
        routes: {
          balanced: {
            strategy: "cache-aware-sticky",
            primary: { provider: "ollama-cloud", model: "nemotron-3-ultra:cloud" },
            fallbacks: [{ provider: "opencode-go", model: "deepseek-v4-flash" }],
          },
        },
        defaultRoute: "balanced",
      },
    });

    const sessionReq = {
      model: "mini-balanced",
      messages: [{ role: "user" as const, content: "hi" }],
      __forwardedHeaders: { "x-opencode-session": "sess-123" },
    };

    // 5 consecutive requests
    for (let i = 0; i < 5; i++) {
      const res = await router.routeChat(sessionReq as any);
      expect(res.provider).toBe("ollama-cloud");
      expect(res.model).toBe("nemotron-3-ultra:cloud");
    }

    expect(p1Called).toBe(5);
    expect(p2Called).toBe(0);

    p1Mock.stop(true);
    p2Mock.stop(true);
  });

  test("Router — cache-aware-sticky tries same provider fallbacks first before next provider", async () => {
    let p1m1Called = 0;
    let p1m2Called = 0;
    let p2Called = 0;

    const p1Mock = createMockServer(async (req) => {
      const body: any = await req.json();
      if (body.model === "m1") {
        p1m1Called++;
        return new Response(JSON.stringify({ error: { message: "Model is unavailable" } }), { status: 503, headers: { "Content-Type": "application/json" } });
      }
      p1m2Called++;
      return new Response(JSON.stringify(mockCompletion(body.model)), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const p2Mock = createMockServer(async (req) => {
      p2Called++;
      const body: any = await req.json();
      return new Response(JSON.stringify(mockCompletion(body.model)), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const healthStore = new HealthStore({ cooldownMs: 10000, failureThreshold: 1 });
    const router = new Router(
      {
        providers: {
          providers: [
            { id: "ollama-cloud", baseURL: `http://localhost:${(p1Mock as any).port}/v1` },
            { id: "opencode-go", baseURL: `http://localhost:${(p2Mock as any).port}/v1` },
          ],
        },
        routes: {
          routes: {
            balanced: {
              strategy: "cache-aware-sticky",
              sameProviderFallback: true,
              primary: { provider: "ollama-cloud", model: "m1" },
              fallbacks: [
                { provider: "ollama-cloud", model: "m2" },
                { provider: "opencode-go", model: "m3" },
              ],
            },
          },
          defaultRoute: "balanced",
        },
      },
      { healthStore },
    );

    const res = await router.routeChat({
      model: "mini-balanced",
      messages: [{ role: "user" as const, content: "hi" }],
      __forwardedHeaders: { "x-opencode-session": "sess-sticky-fallback" },
    } as any);

    expect(res.provider).toBe("ollama-cloud");
    expect(res.model).toBe("m2");
    expect(p1m1Called).toBe(1);
    expect(p1m2Called).toBe(1);
    expect(p2Called).toBe(0);

    p1Mock.stop(true);
    p2Mock.stop(true);
  });
});
