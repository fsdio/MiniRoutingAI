// scripts/test-openrouter-pin.ts — Lapis A mock test untuk pinning OpenRouter
import { OpenAICompatibleAdapter } from "../src/providers/provider.ts";
import { Router } from "../src/router/router.ts";
import { HealthStore } from "../src/router/health.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`PASS: ${msg}`);
  else { console.error(`FAIL: ${msg}`); failures++; }
}

async function testAdapterMock() {
  console.log("\n=== Lapis A: Adapter Mock (OpenAICompatibleAdapter id=openrouter) ===");
  const originalFetch = (global as any).fetch;
  let captured: any = null;
  (global as any).fetch = async (_url: any, opts: any) => {
    captured = JSON.parse(opts.body);
    return new Response(JSON.stringify({ id: "x", object: "chat.completion", created: 123, model: captured.model, choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const adapter = new OpenAICompatibleAdapter("openrouter", "https://openrouter.ai/api/v1", undefined, { "HTTP-Referer": "http://localhost:3000", "X-Title": "MiniRoutingAI" });
  captured = null;
  await adapter.chat({ model: "deepseek/deepseek-v4-flash-0731", messages: [{ role: "user", content: "hi" }] } as any);
  assert(captured?.provider?.order?.[0] === "open-inference/fp8", "T-01 deepseek chat provider.order=open-inference/fp8");
  assert(captured?.reasoning?.enabled === true, "T-01 deepseek chat reasoning.enabled=true");
  assert(captured?.stream === false, "T-01 deepseek chat stream=false");
  captured = null;
  await adapter.chat({ model: "z-ai/glm-5.3-flash", messages: [{ role: "user", content: "hi" }] } as any);
  assert(captured?.provider?.order?.[0] === "relace/fp4", "T-02 z-ai chat provider.order=relace/fp4");
  assert(captured?.reasoning?.enabled === true, "T-02 z-ai chat reasoning.enabled=true");
  captured = null;
  (global as any).fetch = async (_url: any, opts: any) => {
    captured = JSON.parse(opts.body);
    const stream = new ReadableStream({ start(c) { c.close(); } });
    return new Response(stream as any, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  await adapter.stream({ model: "deepseek/deepseek-v4-flash-0731", messages: [{ role: "user", content: "hi" }] } as any);
  assert(captured?.provider?.order?.[0] === "open-inference/fp8", "T-03 deepseek stream provider.order=open-inference/fp8");
  assert(captured?.reasoning?.enabled === true, "T-03 deepseek stream reasoning.enabled=true");
  captured = null;
  await adapter.stream({ model: "z-ai/glm-5.3-flash", messages: [{ role: "user", content: "hi" }] } as any);
  assert(captured?.provider?.order?.[0] === "relace/fp4", "T-04 z-ai stream provider.order=relace/fp4");
  assert(captured?.reasoning?.enabled === true, "T-04 z-ai stream reasoning.enabled=true");
  (global as any).fetch = async (_url: any, opts: any) => {
    captured = JSON.parse(opts.body);
    return new Response(JSON.stringify({ id: "x", object: "chat.completion", created: 123, model: captured.model, choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  captured = null;
  await adapter.chat({ model: "nvidia/nemotron-3-ultra-550b-a55b", messages: [{ role: "user", content: "hi" }] } as any);
  assert(captured?.provider === undefined, "T-06 negatif nvidia tidak ter-pin provider");
  assert(captured?.reasoning === undefined, "T-06 negatif nvidia tidak ter-pin reasoning");
  captured = null;
  await adapter.chat({ model: "deepseek/deepseek-v4-flash-0731", messages: [{ role: "user", content: "hi" }], __providerOrder: ["relace/fp4"] } as any);
  assert(captured?.provider?.order?.[0] === "relace/fp4", "Declarative __providerOrder override PASS");
  (global as any).fetch = originalFetch;
}

async function testRouterMock() {
  console.log("\n=== Lapis A: Router Mock (declarative providers dari routes.json) ===");
  const providers = await Bun.file("config/providers.json").json();
  const routes = await Bun.file("config/routes.json").json();
  assert(!JSON.stringify(routes).includes('"tags"'), "T-07 routes.json tidak mengandung tags");
  assert(!JSON.stringify(providers).includes('"tags"'), "T-07 providers.json tidak mengandung tags");
  const balOpenrouter = routes.routes.balanced.fallbacks.filter((f: any) => f.provider === "openrouter");
  const zaiEntry = balOpenrouter.find((f: any) => f.model === "z-ai/glm-5.3-flash");
  const deepseekEntry = balOpenrouter.find((f: any) => f.model === "deepseek/deepseek-v4-flash-0731");
  assert(zaiEntry?.providers?.[0] === "relace/fp4", "routes.json z-ai providers=relace/fp4");
  assert(zaiEntry?.reasoning?.enabled === true, "routes.json z-ai reasoning.enabled=true");
  assert(deepseekEntry?.providers?.[0] === "open-inference/fp8", "routes.json deepseek providers=open-inference/fp8");
  assert(deepseekEntry?.reasoning?.enabled === true, "routes.json deepseek reasoning.enabled=true");
  assert(routes.routes.free.fallbacks.length === 3, "free fallbacks length 3 (hanya opencode free)");
  assert(!routes.routes.free.fallbacks.some((f: any) => f.model.includes(":free") && f.provider === "openrouter"), "free tidak ada openrouter :free stale");
  let captured: any = null;
  const origFetch = (global as any).fetch;
  (global as any).fetch = async (url: any, opts: any) => {
    if (String(url).includes("/chat/completions")) {
      captured = JSON.parse(opts.body);
      return new Response(JSON.stringify({ id: "x", object: "chat.completion", created: 123, model: captured.model, choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
  const router = new Router({ providers, routes }, { healthStore: new HealthStore() });
  captured = null;
  await router.routeChat({ model: "z-ai/glm-5.3-flash", messages: [{ role: "user", content: "hi" }] } as any);
  assert(captured?.provider?.order?.[0] === "relace/fp4", "Router explicit z-ai provider pin PASS");
  assert(captured?.reasoning?.enabled === true, "Router explicit z-ai reasoning PASS");
  captured = null;
  await router.routeChat({ model: "deepseek/deepseek-v4-flash-0731", messages: [{ role: "user", content: "hi" }] } as any);
  assert(captured?.provider?.order?.[0] === "open-inference/fp8", "Router explicit deepseek provider pin PASS");
  assert(captured?.reasoning?.enabled === true, "Router explicit deepseek reasoning PASS");
  let callCount = 0;
  let capturedCalls: any[] = [];
  (global as any).fetch = async (url: any, opts: any) => {
    if (String(url).includes("/chat/completions")) {
      const body = JSON.parse(opts.body);
      capturedCalls.push(body);
      callCount++;
      if (callCount <= 4) return new Response(JSON.stringify({ error: { message: "unavailable", type: "server_error" } }), { status: 503, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ id: "x", object: "chat.completion", created: 123, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("ok", { status: 200 });
  };
  capturedCalls = [];
  callCount = 0;
  const router2 = new Router({ providers, routes }, { healthStore: new HealthStore() });
  await router2.routeChat({ model: "mini-balanced", messages: [{ role: "user", content: "hi" }] } as any);
  const glmCall = capturedCalls.find((c) => c.model === "z-ai/glm-5.3-flash");
  assert(glmCall?.provider?.order?.[0] === "relace/fp4", "T-05 balanced fallback z-ai pin via declarative PASS");
  const dsCall = capturedCalls.find((c) => c.model === "deepseek/deepseek-v4-flash-0731");
  if (dsCall) assert(dsCall?.provider?.order?.[0] === "open-inference/fp8", "T-05 balanced fallback deepseek pin PASS");
  (global as any).fetch = origFetch;
}

async function main() {
  await testAdapterMock();
  await testRouterMock();
  console.log(`\n=== RINGKASAN: ${failures === 0 ? "SEMUA PASS" : `${failures} FAIL`} ===`);
  if (failures > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
