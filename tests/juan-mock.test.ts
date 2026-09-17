import { describe, test, expect } from "bun:test";
import { createProvider, OpenAICompatibleAdapter } from "../src/providers/provider.ts";
import { Router, extractRetryAfterMs, getContextWindow } from "../src/router/router.ts";
import { HealthStore } from "../src/router/health.ts";
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
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  };
}

function createMockServer(handler: (req: Request) => Response | Promise<Response>) {
  return Bun.serve({ port: 0, fetch: handler });
}

// Helper: capturer untuk juan body & headers
function createMockJuanServer(
  mode: "ok" | "no-channel" | "upstream-401-reset32s" | "timeout" | "rate-limit-insufficient",
  opts?: { captureBody?: (b: any) => void; captureHeaders?: (h: Headers) => void },
) {
  return Bun.serve({
    port: 0,
    fetch: async (req) => {
      if (opts?.captureHeaders) opts.captureHeaders(req.headers);
      const url = new URL(req.url);
      if (url.pathname.endsWith("/chat/completions")) {
        if (opts?.captureBody) {
          try { const b = await req.clone().json(); opts.captureBody(b); } catch {}
        }
        if (mode === "ok") {
          const body: any = await req.json();
          return new Response(JSON.stringify(mockCompletion(body.model)), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (mode === "no-channel") {
          return new Response(JSON.stringify({ error: { message: "No available channel", type: "capacity_error" } }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        if (mode === "upstream-401-reset32s") {
          return new Response(
            JSON.stringify({ error: { message: "[openai-compatible-chat-.../nemotron-3-ultra] [401]: {\"error\":{\"message\":\"upstream error (status 401)\"}} (reset after 32s)", type: "server_error" } }),
            { status: 503, headers: { "Content-Type": "application/json" } },
          );
        }
        if (mode === "rate-limit-insufficient") {
          return new Response(
            JSON.stringify({ error: { message: "credit insufficient balance: balance=205 required=32472 (reset after 21s)", type: "api_error", code: "insufficient_user_quota" } }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        if (mode === "timeout") {
          // never resolve — caller will hit router 8s timeout; shorten for test via delayed response
          await new Promise((r) => setTimeout(r, 5000));
          return new Response(JSON.stringify(mockCompletion("late")), { status: 200 });
        }
      }
      if (url.pathname === "/v1/models" || url.pathname === "/models") {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

describe("Provider juan — audit & bug surface (J-T1..J-T10)", () => {
  // J-T1: adapter juan headers & baseURL normalization
  test("J-T1 createProvider juan — headers & baseURL", async () => {
    process.env.JUAN_API_KEY = "sk-test-juan-123";
    let capturedAuth = "";
    let capturedSession: string | null = "unset";
    const mock = createMockJuanServer("ok", {
      captureHeaders: (h) => {
        capturedAuth = h.get("authorization") ?? "";
        capturedSession = h.get("x-opencode-session");
      },
    });
    const port = (mock as any).port;
    const adapter = createProvider({ id: "juan", baseURL: `http://localhost:${port}/v1/`, apiKeyEnv: "JUAN_API_KEY" });
    // baseURL harus dinormalisasi tanpa trailing slash: src/providers/provider.ts:47
    expect((adapter as OpenAICompatibleAdapter)["baseURL"]).toBe(`http://localhost:${port}/v1`);
    expect(adapter.id).toBe("juan");
    // juan tidak boleh auto-inject x-opencode-session (hanya opencode/opencode-go)
    expect((adapter as OpenAICompatibleAdapter)["extraHeaders"]).toBeUndefined();

    await adapter.chat({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] });
    expect(capturedAuth).toBe("Bearer sk-test-juan-123");
    expect(capturedSession).toBeNull(); // tidak ada session injection untuk juan

    mock.stop(true);
    delete process.env.JUAN_API_KEY;
  });

  test("J-T1b juan tanpa apiKeyEnv tidak kirim Authorization", async () => {
    let capturedAuth = "present";
    const mock = createMockJuanServer("ok", { captureHeaders: (h) => { capturedAuth = h.get("authorization") ?? ""; } });
    const port = (mock as any).port;
    const adapter = createProvider({ id: "juan", baseURL: `http://localhost:${port}/v1` });
    await adapter.chat({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] });
    expect(capturedAuth).toBe("");
    mock.stop(true);
  });

  // J-T2: reasoning & internal fields not leaked
  test("J-T2 juan normalizeRequest — reasoning enabled terkirim, __reasoning tidak bocor", async () => {
    let capturedBody: any = null;
    const mock = createMockJuanServer("ok", { captureBody: (b) => { capturedBody = b; } });
    const port = (mock as any).port;
    const adapter = createProvider({ id: "juan", baseURL: `http://localhost:${port}/v1` });

    // via Router path: request carries __reasoning
    const req: any = {
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
      __reasoning: { enabled: true },
      __forwardedHeaders: { "x-opencode-session": "sess-test" },
    };
    await adapter.chat(req);
    expect(capturedBody.reasoning).toBeDefined();
    expect(capturedBody.reasoning.enabled).toBe(true);
    expect(capturedBody.__reasoning).toBeUndefined();
    expect(capturedBody.__forwardedHeaders).toBeUndefined();
    // juan generic path seharusnya TIDAK menambahkan stream_options.include_usage untuk non-stream
    expect(capturedBody.stream_options).toBeUndefined();

    mock.stop(true);
  });

  test("J-T2b juan stream — stream_options.include_usage via translator", async () => {
    // cek prepareOpenAIRequest langsung
    const { prepareOpenAIRequest } = await import("../src/translator/request.ts");
    const req: any = { model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }], stream: true };
    const normalized = prepareOpenAIRequest(req, "juan", { stream: true });
    expect(normalized.stream_options).toBeDefined();
    expect(normalized.stream_options.include_usage).toBe(true);
  });

  // J-T3: classifyError untuk sampel juan
  test("J-T3 classifyError — sampel juan distributor", () => {
    expect(classifyError(400, { error: { message: "No available channel" } })).toBe("transient");
    expect(classifyError(400, { error: { message: "no available channel" } }, "No available channel")).toBe("transient");
    // upstream 401 enveloped dalam 503 dengan reset hint harus server_error (fallback-able) bukan credential locking
    const enveloped = { error: { message: "[openai-compatible-chat...] [401]: upstream error (status 401) (reset after 32s)" } };
    expect(classifyError(503, enveloped)).toBe("server_error");
    expect(shouldFallback(classifyError(503, enveloped))).toBe(true);
    // insufficient balance harus rate_limit bukan server_error
    const quota = { error: { message: "credit insufficient balance: balance=205 required=32472 (reset after 21s)", code: "insufficient_user_quota" } };
    expect(classifyError(400, quota)).toBe("rate_limit");
    expect(classifyError(503, quota)).toBe("rate_limit");
    // AbortError / timeout
    expect(classifyError(undefined, null, "AbortError: The operation was aborted.")).toBe("unknown"); // tanpa status = unknown (router akan tetap fallback via shouldFallback unknown=true untuk retry)
    expect(classifyError(408, null, "timeout")).toBe("timeout");
    expect(classifyError(undefined, null, "timeout")).toBe("timeout");
  });

  // J-T4: extractRetryAfterMs untuk hint juan
  test("J-T4 extractRetryAfterMs — reset after Ns dari juan", () => {
    expect(extractRetryAfterMs({ error: { message: "credit insufficient balance (reset after 21s)" } })).toBe(21_000);
    expect(extractRetryAfterMs({ error: { message: "[401]: upstream error (reset after 32s)" } })).toBe(32_000);
    expect(extractRetryAfterMs({ error: { message: "capacity (reset after 26s)" } })).toBe(26_000);
    // via headers
    expect(extractRetryAfterMs(undefined, { "retry-after": "5" })).toBe(5_000);
    expect(extractRetryAfterMs(undefined, new Headers({ "retry-after": "25" }))).toBe(25_000);
    expect(extractRetryAfterMs({})).toBeUndefined();
  });

  // J-T5: getContextWindow untuk juan — setelah fix deepseek-only
  test("J-T5 getContextWindow — juan deepseek-v4-flash FIXED 256k", async () => {
    const providers = JSON.parse(await Bun.file("config/providers.json").text());
    // setelah fix deepseek-only, juan hanya punya deepseek-v4-flash 256k; minimax-m3 fallback ke default 256k
    expect(getContextWindow(providers, "juan", "deepseek-v4-flash")).toBe(256_000);
    expect(getContextWindow(providers, "juan", "minimax-m3")).toBe(256_000);
    // provider tidak ada → null
    expect(getContextWindow(providers, "juan-notfound", "m")).toBeNull();
    // opencode-go juga deepseek-only sekarang
    expect(getContextWindow(providers, "opencode-go", "deepseek-v4-flash")).toBe(256_000);
  });

  // J-T6: Router primary=juan sukses
  test("J-T6 Router primary=juan sukses (200) — no fallback", async () => {
    const juanMock = createMockJuanServer("ok");
    const fallbackMock = createMockServer(async (req) => {
      const b: any = await req.json();
      return new Response(JSON.stringify(mockCompletion(b.model)), { status: 200 });
    });
    const router = new Router(
      {
        providers: {
          providers: [
            { id: "juan", baseURL: `http://localhost:${(juanMock as any).port}/v1` },
            { id: "fallback", baseURL: `http://localhost:${(fallbackMock as any).port}/v1` } as any,
          ],
        } as any,
        routes: {
          routes: {
            fast: { strategy: "fallback", primary: { provider: "juan", model: "deepseek-v4-flash" }, fallbacks: [{ provider: "fallback", model: "m-b" }] },
          },
          defaultRoute: "fast",
        } as any,
      },
      { healthStore: new HealthStore({ cooldownMs: 10_000, failureThreshold: 1 }) },
    );
    const result = await router.routeChat({ model: "x", messages: [{ role: "user", content: "hi" }] });
    expect(result.provider).toBe("juan");
    expect(result.model).toBe("deepseek-v4-flash");
    expect(result.fallbackCount).toBe(0);
    expect(result.attempts[0].success).toBe(true);
    juanMock.stop(true);
    fallbackMock.stop(true);
  });

  // J-T7: juan 503 upstream-401 + reset 32s → fallback
  test("J-T7 juan 503 upstream-401 reset32s → fallback sukses & retryAfter diparse", async () => {
    const juanMock = createMockJuanServer("upstream-401-reset32s");
    const fallbackMock = createMockServer(async (req) => {
      const b: any = await req.json();
      return new Response(JSON.stringify(mockCompletion(b.model)), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const health = new HealthStore({ cooldownMs: 5000, failureThreshold: 5 });
    const router = new Router(
      {
        providers: {
          providers: [
            { id: "juan", baseURL: `http://localhost:${(juanMock as any).port}/v1` },
            { id: "fallback", baseURL: `http://localhost:${(fallbackMock as any).port}/v1` },
          ],
        } as any,
        routes: {
          routes: {
            fast: { strategy: "fallback", primary: { provider: "juan", model: "deepseek-v4-flash" }, fallbacks: [{ provider: "fallback", model: "openrouter/free" }] },
          },
          defaultRoute: "fast",
        } as any,
      },
      { healthStore: health },
    );
    const result = await router.routeChat({ model: "x", messages: [{ role: "user", content: "hi" }] });
    expect(result.provider).toBe("fallback");
    expect(result.fallbackCount).toBe(1);
    expect(result.attempts[0].provider).toBe("juan");
    expect(result.attempts[0].errorClass).toBe("server_error");
    // health juan harus masuk cooldown walau threshold 5 karena 503 + server_error + retryAfter? Sebenarnya isUnavailable false, tapi failureThreshold 5: butuh 5 fails untuk cooldown.
    // Namun router.ts menandai isUnavailable = isUnavailableSignal || missingSession || freeTier. Untuk pesan \"upstream error 401\" tidak kena isUnavailable, jadi threshold berlaku.
    // Dokumentasikan: untuk case ini fallback terjadi tapi cooldown tidak langsung jika threshold tinggi — ini observasi penting (potensi honeypot 20s).
    // Dengan threshold 5, setelah 1 fail masih healthy → flat sequential akan tetap hit juan di request berikutnya (bukan pre-skip) — sesuai desain flat.
    const expectedHealthyAfterOneFail = true; // threshold 5 -> 1 fail masih healthy
    expect(health.isHealthy("juan", "deepseek-v4-flash")).toBe(expectedHealthyAfterOneFail);
    juanMock.stop(true);
    fallbackMock.stop(true);
  });

  // J-T8: juan No available channel (400) transient → fallback & immediate cooldown via isUnavailable
  test("J-T8 juan No available channel (400) transient → fallback & cooldown immediate", async () => {
    const juanMock = createMockJuanServer("no-channel");
    const fallbackMock = createMockServer(async (req) => {
      const b: any = await req.json();
      return new Response(JSON.stringify(mockCompletion(b.model)), { status: 200 });
    });
    const health = new HealthStore({ cooldownMs: 5000, failureThreshold: 10 });
    const router = new Router(
      {
        providers: {
          providers: [
            { id: "juan", baseURL: `http://localhost:${(juanMock as any).port}/v1` },
            { id: "fallback", baseURL: `http://localhost:${(fallbackMock as any).port}/v1` },
          ],
        } as any,
        routes: {
          routes: {
            fast: { strategy: "fallback", primary: { provider: "juan", model: "deepseek-v4-flash" }, fallbacks: [{ provider: "fallback", model: "m-b" }] },
          },
          defaultRoute: "fast",
        } as any,
      },
      { healthStore: health },
    );
    const result = await router.routeChat({ model: "x", messages: [{ role: "user", content: "hi" }] });
    expect(result.provider).toBe("fallback");
    expect(result.attempts[0].errorClass).toBe("transient");
    // transient + isUnavailable=true harus langsung cooldown walau threshold 10 (health.ts:91)
    expect(health.isHealthy("juan", "deepseek-v4-flash")).toBe(false);
    juanMock.stop(true);
    fallbackMock.stop(true);
  });

  // J-T9: juan insufficient balance rate_limit dengan reset 21s → fallback & HealthStore cap
  test("J-T9 juan insufficient balance rate_limit → fallback", async () => {
    const juanMock = createMockJuanServer("rate-limit-insufficient");
    const fallbackMock = createMockServer(async (req) => {
      const b: any = await req.json();
      return new Response(JSON.stringify(mockCompletion(b.model)), { status: 200 });
    });
    // Threshold 1 agar rate_limit langsung cooldown dan retryAfter terlihat. Dengan threshold 10 (produksi), quota tidak isUnavailable sehingga honeypot butuh 10 fails — ini adalah temuan bug potensial.
    const health = new HealthStore({ cooldownMs: 5000, failureThreshold: 1 });
    const router = new Router(
      {
        providers: {
          providers: [
            { id: "juan", baseURL: `http://localhost:${(juanMock as any).port}/v1` },
            { id: "fallback", baseURL: `http://localhost:${(fallbackMock as any).port}/v1` },
          ],
        } as any,
        routes: {
          routes: {
            fast: { strategy: "fallback", primary: { provider: "juan", model: "deepseek-v4-flash" }, fallbacks: [{ provider: "fallback", model: "m-b" }] },
          },
          defaultRoute: "fast",
        } as any,
      },
      { healthStore: health },
    );
    const result = await router.routeChat({ model: "x", messages: [{ role: "user", content: "hi" }] });
    expect(result.provider).toBe("fallback");
    expect(result.attempts[0].errorClass).toBe("rate_limit");
    // rate_limit + retryAfter 600_000 override (quota persistent 10 menit) — HealthStore pakai max(classCooldown, retryAfter)
    const remaining = health.getCooldownRemainingMs("juan", "deepseek-v4-flash");
    expect(remaining).toBeGreaterThan(15_000); // minimal 21s override, aktual 600_000
    juanMock.stop(true);
    fallbackMock.stop(true);
  });

  // J-T10: stream
  test("J-T10 juan stream sukses direct & fallback sebelum first chunk", async () => {
    // direct stream
    const juanStreamMock = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/chat/completions")) {
          const body: any = await req.json();
          if (body.stream) {
            const chunks = [
              `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { content: "Hello from juan" }, finish_reason: null }] })}\n\n`,
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
        }
        return new Response("not found", { status: 404 });
      },
    });
    const routerStream = new Router(
      {
        providers: { providers: [{ id: "juan", baseURL: `http://localhost:${(juanStreamMock as any).port}/v1` }] } as any,
        routes: { routes: { fast: { strategy: "fallback", primary: { provider: "juan", model: "deepseek-v4-flash" }, fallbacks: [] } }, defaultRoute: "fast" } as any,
      },
      { healthStore: new HealthStore({ cooldownMs: 5000, failureThreshold: 1 }) },
    );
    const sRes = await routerStream.routeStream({ model: "x", messages: [{ role: "user", content: "hi" }], stream: true });
    expect(sRes.provider).toBe("juan");
    const reader = sRes.stream!.getReader();
    const decoder = new TextDecoder();
    let full = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      full += decoder.decode(value);
    }
    expect(full).toContain("Hello from juan");
    juanStreamMock.stop(true);

    // fallback stream when juan fails pre-handshake
    const juanFailStream = createMockJuanServer("no-channel");
    const fallbackStream = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/chat/completions")) {
          const body: any = await req.json();
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
        return new Response("not found", { status: 404 });
      },
    });
    const routerFallbackStream = new Router(
      {
        providers: {
          providers: [
            { id: "juan", baseURL: `http://localhost:${(juanFailStream as any).port}/v1` },
            { id: "fallback", baseURL: `http://localhost:${(fallbackStream as any).port}/v1` },
          ],
        } as any,
        routes: {
          routes: { fast: { strategy: "fallback", primary: { provider: "juan", model: "deepseek-v4-flash" }, fallbacks: [{ provider: "fallback", model: "m-b" }] } },
          defaultRoute: "fast",
        } as any,
      },
      { healthStore: new HealthStore({ cooldownMs: 5000, failureThreshold: 1 }) },
    );
    const sRes2 = await routerFallbackStream.routeStream({ model: "x", messages: [{ role: "user", content: "hi" }], stream: true });
    expect(sRes2.provider).toBe("fallback");
    expect(sRes2.fallbackCount).toBe(1);
    const reader2 = sRes2.stream!.getReader();
    let full2 = "";
    while (true) {
      const { done, value } = await reader2.read();
      if (done) break;
      full2 += decoder.decode(value);
    }
    expect(full2).toContain("fallback stream");
    juanFailStream.stop(true);
    fallbackStream.stop(true);
  });

  test("J-T10b Gateway E2E juan fallback via server (mock)", async () => {
    const juanMock = createMockJuanServer("no-channel");
    const fallbackMock = createMockServer(async (req) => {
      const b: any = await req.json();
      return new Response(JSON.stringify(mockCompletion(b.model)), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const gateway = createServer({
      port: 0,
      providers: {
        providers: [
          { id: "juan", baseURL: `http://localhost:${(juanMock as any).port}/v1`, models: ["*"] },
          { id: "fallback", baseURL: `http://localhost:${(fallbackMock as any).port}/v1`, models: ["*"] },
        ],
      } as any,
      routes: {
        routes: {
          fast: { strategy: "fallback", primary: { provider: "juan", model: "deepseek-v4-flash" }, fallbacks: [{ provider: "fallback", model: "m-b" }] },
        },
        defaultRoute: "fast",
      } as any,
    });
    await new Promise((r) => setTimeout(r, 150));
    const gPort = (gateway as any).port;
    clearMetrics();
    const res = await fetch(`http://localhost:${gPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "any", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.model).toBe("m-b");
    expect(res.headers.get("x-provider")).toBe("fallback");
    expect(res.headers.get("x-fallback-count")).toBe("1");
    gateway.stop(true);
    juanMock.stop(true);
    fallbackMock.stop(true);
  });
});
