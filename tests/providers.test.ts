import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createProvider, selectProvider, OpenAICompatibleAdapter } from "../src/providers/provider.ts";
import { OpencodeGoProvider } from "../src/providers/opencode-go.ts";
import { OpenRouterProvider } from "../src/providers/openrouter.ts";
import { OllamaProvider } from "../src/providers/ollama.ts";
import { createServer } from "../src/server/server.ts";
import { clearMetrics } from "../src/telemetry/metrics.ts";

function mockCompletion(model: string, content: string) {
  return {
    id: `chatcmpl-${model}-test`,
    object: "chat.completion",
    created: 123,
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  };
}

function createMockProviderServer(
  port: number,
  expectations?: { captureHeaders?: (headers: Headers) => void; status?: number },
) {
  return Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/v1/models" || url.pathname === "/models") {
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.pathname.endsWith("/chat/completions")) {
        if (expectations?.captureHeaders) expectations.captureHeaders(req.headers);
        if (expectations?.status && expectations.status !== 200) {
          return new Response(JSON.stringify({ error: { message: `mock ${expectations.status}`, type: "mock", code: String(expectations.status) } }), {
            status: expectations.status,
            headers: { "Content-Type": "application/json" },
          });
        }
        const body: any = await req.json();
        const model = body.model ?? "unknown";
        if (body.stream === true) {
          const chunks = [
            `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { content: "Hello from " + model }, finish_reason: null }] })}\n\n`,
            `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
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
        return new Response(JSON.stringify(mockCompletion(model, `response from ${model}`)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/api/tags") {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

describe("Phase 2 — Provider abstraction", () => {
  test("selectProvider — explicit hint wins", () => {
    const providers = [
      { id: "opencode-go", baseURL: "http://a/v1", models: ["*"] },
      { id: "openrouter", baseURL: "http://b/v1", models: ["*"] },
      { id: "ollama", baseURL: "http://c/v1", models: ["*"] },
    ];
    const sel = selectProvider("any-model", providers, "openrouter");
    expect(sel?.id).toBe("openrouter");
  });

  test("selectProvider — prefix model selects correct provider", () => {
    const providers = [
      { id: "opencode-go", baseURL: "http://a/v1", models: ["opencode-go/*"] },
      { id: "openrouter", baseURL: "http://b/v1", models: ["openrouter/*"] },
      { id: "ollama", baseURL: "http://c/v1", models: ["ollama/*"] },
    ];
    expect(selectProvider("openrouter/anthropic/claude", providers)?.id).toBe("openrouter");
    expect(selectProvider("opencode-go/gpt-4", providers)?.id).toBe("opencode-go");
    expect(selectProvider("ollama/llama3", providers)?.id).toBe("ollama");
  });

  test("selectProvider — wildcard fallback", () => {
    const providers = [
      { id: "opencode-go", baseURL: "http://a/v1", models: ["opencode-go/*"] },
      { id: "fallback", baseURL: "http://b/v1", models: ["*"] },
    ];
    expect(selectProvider("unknown-model", providers)?.id).toBe("fallback");
  });

  test("createProvider — returns correct adapter types", () => {
    const a = createProvider({ id: "openrouter", baseURL: "http://x/v1" });
    const b = createProvider({ id: "opencode-go", baseURL: "http://y/v1" });
    const c = createProvider({ id: "ollama", baseURL: "http://z/v1" });
    expect(a.id).toBe("openrouter");
    expect(b.id).toBe("opencode-go");
    expect(c.id).toBe("ollama");
    // Check extra headers for openrouter
    expect((a as OpenAICompatibleAdapter)["extraHeaders"]?.["X-Title"]).toBe("MiniRoutingAI");
  });

  test("ProviderAdapter chat & stream via mock server", async () => {
    const mock = createMockProviderServer(0);
    const port = (mock as any).port;
    const base = `http://localhost:${port}/v1`;
    const adapter = createProvider({ id: "test", baseURL: base });

    const chat = await adapter.chat({ model: "test-model", messages: [{ role: "user", content: "hi" }] });
    expect(chat.model).toBe("test-model");
    expect(chat.choices[0].message?.content).toContain("response from");

    const stream = await adapter.stream({ model: "test-model", messages: [{ role: "user", content: "hi" }], stream: true });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    expect(text).toContain("Hello from");
    expect(text).toContain("[DONE]");
    mock.stop(true);
  });

  test("Provider auth header — apiKeyEnv resolved", async () => {
    process.env.TEST_PROVIDER_KEY = "sk-test-123";
    let capturedAuth = "";
    const mock = createMockProviderServer(0, {
      captureHeaders: (h) => {
        capturedAuth = h.get("authorization") ?? "";
      },
    });
    const port = (mock as any).port;
    const adapter = createProvider({ id: "test", baseURL: `http://localhost:${port}/v1`, apiKeyEnv: "TEST_PROVIDER_KEY" });
    await adapter.chat({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(capturedAuth).toBe("Bearer sk-test-123");
    mock.stop(true);
    delete process.env.TEST_PROVIDER_KEY;
  });

  test("OpenRouter adapter sends X-Title header", async () => {
    let capturedTitle = "";
    const mock = createMockProviderServer(0, {
      captureHeaders: (h) => {
        capturedTitle = h.get("x-title") ?? "";
      },
    });
    const port = (mock as any).port;
    const adapter = new OpenRouterProvider(`http://localhost:${port}/v1`);
    await adapter.chat({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(capturedTitle).toBe("MiniRoutingAI");
    mock.stop(true);
  });

  test("Adapter error handling — 401 passthrough via server", async () => {
    const mock = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/chat/completions")) {
          return new Response(JSON.stringify({ error: { message: "invalid api key", type: "auth_error", code: "401" } }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("ok", { status: 200 });
      },
    });
    const port = (mock as any).port;
    const adapter = createProvider({ id: "test", baseURL: `http://localhost:${port}/v1` });
    let threw = false;
    try {
      await adapter.chat({ model: "m", messages: [{ role: "user", content: "hi" }] });
    } catch (e: any) {
      threw = true;
      expect(e.status).toBe(401);
      expect(e.body.error.message).toContain("invalid api key");
    }
    expect(threw).toBe(true);
    mock.stop(true);
  });

  test("Adapter health — success", async () => {
    const mock = createMockProviderServer(0);
    const port = (mock as any).port;
    const adapter = createProvider({ id: "test", baseURL: `http://localhost:${port}/v1` });
    const h = await adapter.health();
    expect(h.ok).toBe(true);
    expect(typeof h.latencyMs).toBe("number");
    mock.stop(true);
  });

  test("Ollama health — via /api/tags fallback", async () => {
    const ollamaMock = Bun.serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/api/tags") return new Response(JSON.stringify({ models: [] }), { status: 200 });
        if (url.pathname.endsWith("/models")) return new Response("not found", { status: 404 });
        return new Response("not found", { status: 404 });
      },
    });
    const port = (ollamaMock as any).port;
    const adapter = new OllamaProvider(`http://localhost:${port}/v1`);
    const h = await adapter.health();
    expect(h.ok).toBe(true);
    ollamaMock.stop(true);
  });

  test("Gateway integration — explicit provider selection via model prefix (3 providers)", async () => {
    const mocks: ReturnType<typeof Bun.serve>[] = [];
    const providers: any[] = [];

    // Create 3 mock upstreams
    for (const id of ["opencode-go", "openrouter", "ollama"]) {
      const mock = createMockProviderServer(0);
      const port = (mock as any).port;
      mocks.push(mock);
      providers.push({ id, baseURL: `http://localhost:${port}/v1`, models: [`${id}/*`] });
    }
    // Add wildcard fallback to avoid mismatch
    // but we will test explicit prefixes

    const gateway = createServer({
      port: 0,
      providers: { providers },
      routes: {
        routes: { fast: { strategy: "fallback", primary: { provider: "opencode-go", model: "opencode-go/model-a" }, fallbacks: [] } },
        defaultRoute: "fast",
      },
    });
    await new Promise((r) => setTimeout(r, 150));
    const gPort = (gateway as any).port;
    const url = `http://localhost:${gPort}/v1/chat/completions`;

    clearMetrics();

    for (const id of ["opencode-go", "openrouter", "ollama"]) {
      // non-streaming
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: `${id}/test-model`, messages: [{ role: "user", content: "hi" }] }),
      });
      expect(res.status).toBe(200);
      const json: any = await res.json();
      expect(json.model).toBe(`${id}/test-model`);
      expect(json.choices[0].message.content).toContain(`response from ${id}/test-model`);
      expect(res.headers.get("x-request-id")).toBeTruthy();

      // streaming
      const sRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: `${id}/test-model`, messages: [{ role: "user", content: "hi" }], stream: true }),
      });
      expect(sRes.status).toBe(200);
      expect(sRes.headers.get("content-type")).toContain("text/event-stream");
      const reader = sRes.body!.getReader();
      const decoder = new TextDecoder();
      let full = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        full += decoder.decode(value);
      }
      expect(full).toContain(`Hello from ${id}/test-model`);
      expect(full).toContain("[DONE]");
    }

    gateway.stop(true);
    mocks.forEach((m) => m.stop(true));
  });

  test("Provider isolation — one provider error does not affect others", async () => {
    const goodMock = createMockProviderServer(0);
    const badMock = Bun.serve({
      port: 0,
      fetch: () => new Response(JSON.stringify({ error: { message: "bad", type: "error" } }), { status: 500, headers: { "Content-Type": "application/json" } }),
    });
    const goodPort = (goodMock as any).port;
    const badPort = (badMock as any).port;

    const gateway = createServer({
      port: 0,
      providers: {
        providers: [
          { id: "good", baseURL: `http://localhost:${goodPort}/v1`, models: ["good/*"] },
          { id: "bad", baseURL: `http://localhost:${badPort}/v1`, models: ["bad/*"] },
        ],
      },
      routes: { routes: { fast: { strategy: "fallback", primary: { provider: "good", model: "good/m" }, fallbacks: [] } }, defaultRoute: "fast" },
    });
    await new Promise((r) => setTimeout(r, 100));
    const gPort = (gateway as any).port;

    // good succeeds
    const goodRes = await fetch(`http://localhost:${gPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "good/test", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(goodRes.status).toBe(200);

    // bad fails but does not crash server, good still works
    const badRes = await fetch(`http://localhost:${gPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "bad/test", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(badRes.status).toBe(500);

    const goodRes2 = await fetch(`http://localhost:${gPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "good/test", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(goodRes2.status).toBe(200);

    gateway.stop(true);
    goodMock.stop(true);
    badMock.stop(true);
  });
});
