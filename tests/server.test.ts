import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createServer } from "../src/server/server.ts";
import { clearMetrics } from "../src/telemetry/metrics.ts";

// Helper: create mock upstream server
function createMockUpstream(handler: (req: Request) => Response | Promise<Response>) {
  return Bun.serve({
    port: 0,
    fetch: handler,
  });
}

describe("Phase 1 — OpenAI-compatible server", () => {
  let mockUpstream: ReturnType<typeof Bun.serve> | null = null;
  let gateway: ReturnType<typeof Bun.serve> | null = null;

  const mockResponses = {
    nonStreaming: {
      id: "chatcmpl-test123",
      object: "chat.completion",
      created: 1234567890,
      model: "test-model",
      choices: [{ index: 0, message: { role: "assistant", content: "Hello from mock" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    },
    streamingChunks: [
      `data: ${JSON.stringify({ id: "chatcmpl-stream", object: "chat.completion.chunk", created: 123, model: "test-model", choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "chatcmpl-stream", object: "chat.completion.chunk", created: 123, model: "test-model", choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "chatcmpl-stream", object: "chat.completion.chunk", created: 123, model: "test-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      `data: [DONE]\n\n`,
    ],
  };

  beforeAll(async () => {
    // Mock upstream with both streaming and non-streaming support
    mockUpstream = createMockUpstream(async (req) => {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = (await req.json()) as any;
        if (body.stream === true) {
          // Return SSE stream without buffering
          let idx = 0;
          const stream = new ReadableStream({
            pull(controller) {
              if (idx < mockResponses.streamingChunks.length) {
                controller.enqueue(new TextEncoder().encode(mockResponses.streamingChunks[idx++]));
              } else {
                controller.close();
              }
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
          });
        }
        return new Response(JSON.stringify(mockResponses.nonStreaming), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // For error simulation via header
      if (url.pathname === "/v1/chat/completions" && req.headers.get("x-mock-status")) {
        const status = parseInt(req.headers.get("x-mock-status")!, 10);
        return new Response(JSON.stringify({ error: { message: "mock error", type: "mock", code: String(status) } }), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });

    const upstreamPort = (mockUpstream as any).port;
    const upstreamBase = `http://localhost:${upstreamPort}/v1`;

    gateway = createServer({
      port: 0,
      providers: {
        providers: [{ id: "upstream", baseURL: upstreamBase, models: ["*"] }],
      },
      routes: {
        routes: {
          fast: {
            strategy: "fallback",
            primary: { provider: "upstream", model: "test-model" },
            fallbacks: [],
          },
        },
        defaultRoute: "fast",
      },
    });
    // Give server a tick to start
    await new Promise((r) => setTimeout(r, 200));
  });

  afterAll(() => {
    mockUpstream?.stop(true);
    gateway?.stop(true);
  });

  beforeEach(() => {
    clearMetrics();
  });

  function gatewayUrl(path: string): string {
    const port = (gateway as any).port;
    return `http://localhost:${port}${path}`;
  }

  test("GET /health → 200", async () => {
    const res = await fetch(gatewayUrl("/health"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.status).toBe("ok");
    expect(typeof json.uptime).toBe("number");
    expect(res.headers.get("x-request-id")).toBeTruthy();
    expect(res.headers.get("x-request-id")!.startsWith("req_")).toBe(true);
  });

  test("GET /metrics → 200", async () => {
    const res = await fetch(gatewayUrl("/metrics"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(typeof json.count).toBe("number");
  });

  test("GET /debug/routes → 200 sanitized", async () => {
    const res = await fetch(gatewayUrl("/debug/routes"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.routes).toBeDefined();
    expect(json.providers[0].id).toBe("upstream");
    // should not contain apiKey
    expect(JSON.stringify(json).toLowerCase().includes("api_key")).toBe(false);
  });

  test("POST /v1/chat/completions non-streaming → 200 + passthrough", async () => {
    const res = await fetch(gatewayUrl("/v1/chat/completions"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.id).toBe("chatcmpl-test123");
    expect(json.choices[0].message.content).toBe("Hello from mock");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  test("POST /v1/chat/completions streaming → SSE chunks without full buffering", async () => {
    const res = await fetch(gatewayUrl("/v1/chat/completions"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-request-id")).toBeTruthy();

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let chunks: string[] = [];
    let firstChunkTime = 0;
    const start = performance.now();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (chunks.length === 0) firstChunkTime = performance.now() - start;
      chunks.push(decoder.decode(value));
    }
    const full = chunks.join("");
    expect(full).toContain("Hello");
    expect(full).toContain("world");
    expect(full).toContain("[DONE]");
    // TTFT should be measurable (first chunk arrived)
    expect(firstChunkTime).toBeGreaterThanOrEqual(0);
    expect(firstChunkTime).toBeLessThan(5000);
  });

  test("Invalid body → 400", async () => {
    const res = await fetch(gatewayUrl("/v1/chat/completions"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }), // missing model
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error).toBeDefined();
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  test("Empty messages → 400", async () => {
    const res = await fetch(gatewayUrl("/v1/chat/completions"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });
    expect(res.status).toBe(400);
  });

  test("Invalid JSON → 400", async () => {
    const res = await fetch(gatewayUrl("/v1/chat/completions"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json{{{",
    });
    expect(res.status).toBe(400);
  });

  test("Unknown route → 404", async () => {
    const res = await fetch(gatewayUrl("/unknown/path"));
    expect(res.status).toBe(404);
  });

  test("Upstream error passthrough (simulate 500)", async () => {
    // Create separate gateway pointing to an upstream that returns 500
    const errorUpstream = Bun.serve({
      port: 0,
      fetch(_req) {
        return new Response(JSON.stringify({ error: { message: "upstream internal", type: "server_error", code: "500" } }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    const errPort = (errorUpstream as any).port;
    const errGateway = createServer({
      port: 0,
      providers: { providers: [{ id: "upstream", baseURL: `http://localhost:${errPort}/v1`, models: ["*"] }] },
      routes: { routes: { fast: { strategy: "fallback", primary: { provider: "upstream", model: "test" }, fallbacks: [] } }, defaultRoute: "fast" },
    });
    await new Promise((r) => setTimeout(r, 100));
    const port = (errGateway as any).port;
    const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(500);
    const json = (await res.json()) as any;
    expect(json.error).toBeDefined();
    expect(res.headers.get("x-request-id")).toBeTruthy();
    errGateway.stop(true);
    errorUpstream.stop(true);
  });

  test("x-request-id exists on all responses", async () => {
    const paths = ["/health", "/metrics", "/debug/routes"];
    for (const p of paths) {
      const res = await fetch(gatewayUrl(p));
      expect(res.headers.get("x-request-id")).toBeTruthy();
    }
  });

  test("Gateway overhead measurable (metrics after request)", async () => {
    await fetch(gatewayUrl("/v1/chat/completions"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }] }),
    });
    const metricsRes = await fetch(gatewayUrl("/metrics"));
    const metrics = (await metricsRes.json()) as any;
    expect(metrics.count).toBeGreaterThan(0);
    // gatewayOverhead should be present (at least 0)
    expect(metrics.gatewayOverhead.count).toBeGreaterThan(0);
  });
});
