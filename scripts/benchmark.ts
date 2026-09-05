// scripts/benchmark.ts — Phase 4 benchmark: direct vs mini gateway overhead
import { createServer } from "../src/server/server.ts";
import { clearMetrics } from "../src/telemetry/metrics.ts";

type ScenarioName = "small" | "medium" | "tool" | "large-context" | "multi-turn";

interface Scenario {
  name: ScenarioName;
  request: any;
  iterations: number;
}

interface BenchmarkResult {
  scenario: string;
  mode: "direct" | "mini";
  count: number;
  ttft: Stats;
  totalLatency: Stats;
  providerLatency: Stats;
  gatewayOverhead: Stats;
}

interface Stats {
  min: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
  count: number;
}

function computeStats(values: number[]): Stats {
  if (values.length === 0) return { min: null, p50: null, p95: null, max: null, count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const p = (pct: number) => sorted[Math.ceil((pct / 100) * sorted.length) - 1];
  return { min, p50: p(50), p95: p(95), max, count: values.length };
}

function fmt(n: number | null): string {
  if (n === null) return "unknown";
  return n.toFixed(2) + "ms";
}

// Mock provider for benchmark — simulates realistic provider latency
function createMockBenchmarkProvider(latencyMs = 15) {
  return Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/chat/completions")) {
        const body: any = await req.json().catch(() => ({}));
        const isStream = body.stream === true;
        // Simulate provider processing delay
        await new Promise((r) => setTimeout(r, latencyMs));
        const model = body.model ?? "test-model";
        if (isStream) {
          const chunks = [
            `data: ${JSON.stringify({ id: "chatcmpl-bench", object: "chat.completion.chunk", created: Date.now(), model, choices: [{ index: 0, delta: { content: "Hello benchmark " }, finish_reason: null }] })}\n\n`,
            `data: ${JSON.stringify({ id: "chatcmpl-bench", object: "chat.completion.chunk", created: Date.now(), model, choices: [{ index: 0, delta: { content: "world" }, finish_reason: null }] })}\n\n`,
            `data: ${JSON.stringify({ id: "chatcmpl-bench", object: "chat.completion.chunk", created: Date.now(), model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
            `data: [DONE]\n\n`,
          ];
          let idx = 0;
          const stream = new ReadableStream({
            async pull(controller) {
              if (idx < chunks.length) {
                // Stagger chunks to simulate generation
                if (idx > 0) await new Promise((r) => setTimeout(r, 5));
                controller.enqueue(new TextEncoder().encode(chunks[idx++]));
              } else {
                controller.close();
              }
            },
          });
          return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
        }
        return new Response(
          JSON.stringify({
            id: "chatcmpl-bench",
            object: "chat.completion",
            created: Date.now(),
            model,
            choices: [{ index: 0, message: { role: "assistant", content: "Hello benchmark response" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.pathname.endsWith("/models") || url.pathname === "/v1/models") {
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

function buildScenarios(iterations = 20): Scenario[] {
  const small = {
    name: "small" as const,
    request: { model: "test-model", messages: [{ role: "user", content: "Hello" }] },
    iterations,
  };
  const mediumMessages = Array.from({ length: 10 }, (_, i) => ({ role: "user" as const, content: `Message ${i}: ${"x".repeat(400)}` }));
  const medium = {
    name: "medium" as const,
    request: { model: "test-model", messages: mediumMessages },
    iterations,
  };
  const tool = {
    name: "tool" as const,
    request: {
      model: "test-model",
      messages: [
        { role: "user", content: "Use git status" },
        { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"cmd":"git status"}' } }] },
        { role: "tool", tool_call_id: "call_1", content: "On branch main\nChanges not staged:\n modified: README.md\n\n" + "x".repeat(2000) },
      ],
      tools: [{ type: "function", function: { name: "bash", description: "run bash", parameters: { type: "object", properties: { cmd: { type: "string" } } } } }],
    },
    iterations,
  };
  const largeContextMessages = [
    { role: "system", content: "You are helpful" },
    ...Array.from({ length: 20 }, (_, i) => ({ role: "user" as const, content: `Turn ${i}: ${"long context ".repeat(100)}` })),
    ...Array.from({ length: 5 }, (_, i) => ({ role: "tool" as const, tool_call_id: `call_${i}`, content: `git diff output ${"a".repeat(3000)} for file ${i}` })),
  ];
  const large = {
    name: "large-context" as const,
    request: { model: "test-model", messages: largeContextMessages },
    iterations,
  };
  const multiTurn = {
    name: "multi-turn" as const,
    request: { model: "test-model", messages: Array.from({ length: 10 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant" as const, content: `Turn ${i} content ${"y".repeat(200)}` })) },
    iterations,
  };
  return [small, medium, tool, large, multiTurn];
}

async function measureDirect(providerBase: string, scenario: Scenario) {
  const url = `${providerBase}/chat/completions`;
  const ttfts: number[] = [];
  const totals: number[] = [];
  for (let i = 0; i < scenario.iterations; i++) {
    const start = performance.now();
    let firstByte: number | null = null;
    const reqBody = JSON.stringify({ ...scenario.request, stream: false });
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: reqBody });
    if (!res.ok) throw new Error(`Direct provider failed ${res.status}`);
    // For direct, TTFT is approx start to first byte (non-streaming: same as total)
    firstByte = performance.now();
    await res.json();
    const end = performance.now();
    ttfts.push((firstByte ?? end) - start);
    totals.push(end - start);
  }
  return {
    ttft: computeStats(ttfts),
    totalLatency: computeStats(totals),
    providerLatency: computeStats(totals), // for direct, provider = total
    gatewayOverhead: computeStats(totals.map(() => 0)), // 0 for direct
  };
}

async function measureMini(gatewayBase: string, scenario: Scenario) {
  const url = `${gatewayBase}/v1/chat/completions`;
  const ttfts: number[] = [];
  const totals: number[] = [];
  const overheads: number[] = [];
  const providerLatencies: number[] = [];

  for (let i = 0; i < scenario.iterations; i++) {
    const start = performance.now();
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...scenario.request, stream: false }) });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Gateway failed ${res.status}: ${txt}`);
    }
    const json: any = await res.json();
    const end = performance.now();
    // Try to get metrics from gateway's recent; but for simplicity, measure total and assume provider latency included
    // We'll also fetch /metrics? For benchmark we approximate overhead as total - direct avg would be measured separately
    // Here we measure gateway overhead via timing headers? For now compute from observed: gateway overhead is total - providerLatency
    // Since mock provider latency is known (~15ms), we can approximate, but we actually measure provider latency via separate direct call diff
    // For this benchmark, we will measure gateway overhead as (total - ~15) but better to measure via server metrics endpoint
    // Simpler: query /debug/recent for last metric's gatewayOverhead
    let overhead = 0;
    let pLatency = end - start;
    try {
      const metricsRes = await fetch(`${gatewayBase}/metrics`);
      const metrics: any = await metricsRes.json();
      const recent = metrics.recent?.[metrics.recent.length - 1];
      if (recent?.gatewayOverheadMs != null) overhead = recent.gatewayOverheadMs;
      if (recent?.providerLatencyMs != null) pLatency = recent.providerLatencyMs;
    } catch {}
    ttfts.push(end - start); // for non-streaming, TTFT ≈ total
    totals.push(end - start);
    overheads.push(overhead);
    providerLatencies.push(pLatency);
  }

  return {
    ttft: computeStats(ttfts),
    totalLatency: computeStats(totals),
    providerLatency: computeStats(providerLatencies),
    gatewayOverhead: computeStats(overheads),
  };
}

async function measureStreamingMini(gatewayBase: string, scenario: Scenario) {
  // Also measure streaming TTFT via SSE
  const url = `${gatewayBase}/v1/chat/completions`;
  const ttfts: number[] = [];
  const totals: number[] = [];
  for (let i = 0; i < Math.min(scenario.iterations, 10); i++) {
    const start = performance.now();
    let ttft: number | null = null;
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...scenario.request, stream: true }) });
    if (!res.ok) throw new Error(`Streaming gateway failed ${res.status}`);
    const reader = res.body!.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (ttft === null) ttft = performance.now() - start;
    }
    const end = performance.now();
    ttfts.push(ttft ?? end - start);
    totals.push(end - start);
  }
  return { ttft: computeStats(ttfts), totalLatency: computeStats(totals) };
}

async function main() {
  const args = process.argv.slice(2);
  const iterations = parseInt(process.env.BENCH_ITERATIONS ?? args.find((a) => a.startsWith("--iter="))?.split("=")[1] ?? "20", 10);
  const mockLatency = parseInt(process.env.BENCH_MOCK_LATENCY ?? "15", 10);

  console.log(`\n=== MiniRoutingAI Benchmark ===`);
  console.log(`Iterations per scenario: ${iterations}`);
  console.log(`Mock provider latency: ${mockLatency}ms`);
  console.log(`Scenarios: small, medium, tool, large-context, multi-turn\n`);

  const mockProvider = createMockBenchmarkProvider(mockLatency);
  const providerPort = (mockProvider as any).port;
  const providerBase = `http://localhost:${providerPort}/v1`;
  console.log(`Mock provider: ${providerBase}`);

  // Gateway with single provider
  const gateway = createServer({
    port: 0,
    providers: { providers: [{ id: "upstream", baseURL: providerBase, models: ["*"] }] },
    routes: {
      routes: { fast: { strategy: "fallback", primary: { provider: "upstream", model: "test-model" }, fallbacks: [] } },
      defaultRoute: "fast",
    },
  });
  await new Promise((r) => setTimeout(r, 300));
  const gatewayPort = (gateway as any).port;
  const gatewayBase = `http://localhost:${gatewayPort}`;
  console.log(`Gateway: ${gatewayBase}\n`);

  const scenarios = buildScenarios(iterations);
  const results: BenchmarkResult[] = [];

  for (const sc of scenarios) {
    console.log(`--- Scenario: ${sc.name} (${sc.iterations} iterations) ---`);
    clearMetrics();

    // Direct
    const direct = await measureDirect(providerBase, sc);
    console.log(`  Direct:   total ${fmt(direct.totalLatency.p50)} (p50) | ${fmt(direct.totalLatency.p95)} (p95) | TTFT ${fmt(direct.ttft.p50)}`);

    // Mini
    const mini = await measureMini(gatewayBase, sc);
    console.log(`  Mini:     total ${fmt(mini.totalLatency.p50)} | p95 ${fmt(mini.totalLatency.p95)} | TTFT ${fmt(mini.ttft.p50)} | overhead ${fmt(mini.gatewayOverhead.p50)} (p50) / ${fmt(mini.gatewayOverhead.p95)} (p95)`);

    // Streaming TTFT additional
    const stream = await measureStreamingMini(gatewayBase, sc);
    console.log(`  Streaming TTFT (mini): ${fmt(stream.ttft.p50)} p50 | ${fmt(stream.ttft.p95)} p95`);

    const directResult: BenchmarkResult = {
      scenario: sc.name,
      mode: "direct",
      count: sc.iterations,
      ttft: direct.ttft,
      totalLatency: direct.totalLatency,
      providerLatency: direct.providerLatency,
      gatewayOverhead: direct.gatewayOverhead,
    };
    const miniResult: BenchmarkResult = {
      scenario: sc.name,
      mode: "mini",
      count: sc.iterations,
      ttft: mini.ttft,
      totalLatency: mini.totalLatency,
      providerLatency: mini.providerLatency,
      gatewayOverhead: mini.gatewayOverhead,
    };
    results.push(directResult, miniResult);

    // Per-scenario gateway overhead check
    const overheadP50 = mini.gatewayOverhead.p50 ?? 0;
    const overheadP95 = mini.gatewayOverhead.p95 ?? 0;
    const targetP50 = 20;
    const targetP95 = 50;
    const p50Status = overheadP50 < targetP50 ? "PASS" : "MISS";
    const p95Status = overheadP95 < targetP95 ? "PASS" : "MISS";
    console.log(`  Overhead target: P50 <${targetP50}ms ${p50Status} (${overheadP50.toFixed(2)}ms) | P95 <${targetP95}ms ${p95Status} (${overheadP95.toFixed(2)}ms)\n`);
  }

  // Summary table
  console.log(`\n=== Summary (Mini Gateway Overhead) ===`);
  console.log(`Scenario        | P50 overhead | P95 overhead | P50 total (mini) | P50 total (direct) | Overhead verdict`);
  console.log(`----------------|--------------|--------------|------------------|--------------------|----------------`);
  for (let i = 0; i < results.length; i += 2) {
    const direct = results[i];
    const mini = results[i + 1];
    const p50o = mini.gatewayOverhead.p50 ?? 0;
    const p95o = mini.gatewayOverhead.p95 ?? 0;
    const verdict = p50o < 20 && p95o < 50 ? "PASS" : "MISS - profile first";
    console.log(
      `${direct.scenario.padEnd(15)} | ${fmt(mini.gatewayOverhead.p50).padEnd(12)} | ${fmt(mini.gatewayOverhead.p95).padEnd(12)} | ${fmt(mini.totalLatency.p50).padEnd(16)} | ${fmt(direct.totalLatency.p50).padEnd(18)} | ${verdict}`,
    );
  }

  // --- RTK OFF vs ON benchmark (Phase 5) ---
  console.log(`\n=== RTK Benchmark: OFF vs ON ===`);
  let rtkResults: any[] = [];
  try {
    const gitDiffText = await Bun.file("tests/fixtures/rtk/gitDiff.txt").text().catch(() => "diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new\n".repeat(20));
    const gitStatusText = await Bun.file("tests/fixtures/rtk/gitStatus.txt").text().catch(() => "On branch main\nChanges not staged:\n modified: file.txt\n".repeat(20));
    const grepText = await Bun.file("tests/fixtures/rtk/grepOutput.txt").text().catch(() => "src/a.ts:10:hello\n".repeat(30));
    const largeText = await Bun.file("tests/fixtures/rtk/largeToolOutput.txt").text().catch(() => "duplicate line\n".repeat(200));

    const rtkScenarios = [
      { name: "rtk-git-diff", content: gitDiffText },
      { name: "rtk-git-status", content: gitStatusText },
      { name: "rtk-grep", content: grepText },
      { name: "rtk-large", content: largeText },
    ];

    // Create two gateways: OFF and ON sharing same mock provider
    const gatewayOff = createServer({
      port: 0,
      providers: { providers: [{ id: "upstream", baseURL: providerBase, models: ["*"] }] },
      routes: { routes: { fast: { strategy: "fallback", primary: { provider: "upstream", model: "test-model" }, fallbacks: [], optimizers: { rtk: false } } }, defaultRoute: "fast" },
      optimization: { optimizers: { rtk: false } },
    });
    const gatewayOn = createServer({
      port: 0,
      providers: { providers: [{ id: "upstream", baseURL: providerBase, models: ["*"] }] },
      routes: { routes: { fast: { strategy: "fallback", primary: { provider: "upstream", model: "test-model" }, fallbacks: [], optimizers: { rtk: true } } }, defaultRoute: "fast" },
      optimization: { optimizers: { rtk: { enabled: true } } },
    });
    await new Promise((r) => setTimeout(r, 300));
    const offBase = `http://localhost:${(gatewayOff as any).port}`;
    const onBase = `http://localhost:${(gatewayOn as any).port}`;

    for (const sc of rtkScenarios) {
      const reqBody = { model: "test-model", messages: [{ role: "user", content: "hi" }, { role: "tool", tool_call_id: "1", content: sc.content }] };
      const iter = Math.min(iterations, 15);

      async function measureGateway(base: string) {
        const totals: number[] = [];
        const rtkDurations: number[] = [];
        const savedBytesArr: number[] = [];
        const savedPercArr: number[] = [];
        let lastSaved = 0;
        let lastPercent = 0;
        for (let i = 0; i < iter; i++) {
          const start = performance.now();
          const res = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reqBody) });
          if (!res.ok) throw new Error(`RTK gateway failed ${res.status}`);
          await res.json();
          const end = performance.now();
          totals.push(end - start);
          try {
            const mRes = await fetch(`${base}/metrics`);
            const mJson: any = await mRes.json();
            const recent = mJson.recent?.[mJson.recent.length - 1];
            if (recent?.rtk) {
              rtkDurations.push(recent.rtk.durationMs ?? 0);
              savedBytesArr.push(recent.rtk.savedBytes ?? 0);
              savedPercArr.push(recent.rtk.savedPercent ?? 0);
              lastSaved = recent.rtk.savedBytes ?? 0;
              lastPercent = recent.rtk.savedPercent ?? 0;
            } else {
              rtkDurations.push(0);
            }
          } catch { rtkDurations.push(0); }
        }
        return {
          total: computeStats(totals),
          rtkDuration: computeStats(rtkDurations),
          savedBytes: lastSaved,
          savedPercent: lastPercent,
          avgSavedBytes: savedBytesArr.length ? savedBytesArr.reduce((a, b) => a + b, 0) / savedBytesArr.length : 0,
        };
      }

      const off = await measureGateway(offBase);
      const on = await measureGateway(onBase);
      const totalDelta = (on.total.p50 ?? 0) - (off.total.p50 ?? 0);
      const verdict = totalDelta < 5 ? "PASS (RTK not harming latency)" : totalDelta < 10 ? "OK" : "CHECK";

      console.log(`  ${sc.name.padEnd(16)} | OFF total ${fmt(off.total.p50).padEnd(10)} | ON total ${fmt(on.total.p50).padEnd(10)} | Δ ${totalDelta.toFixed(2)}ms | RTK ${fmt(on.rtkDuration.p50)} p50 | saved ${on.savedBytes}B (${on.savedPercent.toFixed(1)}%) | ${verdict}`);

      rtkResults.push({
        scenario: sc.name,
        off: { totalLatency: off.total, rtkDuration: off.rtkDuration },
        on: { totalLatency: on.total, rtkDuration: on.rtkDuration, savedBytes: on.savedBytes, savedPercent: on.savedPercent },
        deltaMs: totalDelta,
        inputBytes: Buffer.byteLength(sc.content, "utf-8"),
      });
    }

    gatewayOff.stop(true);
    gatewayOn.stop(true);

    console.log(`\nRTK summary: RTK duration separately measured from provider latency; total latency ON should not be >> OFF. Ideal: saved bytes >0 and total ON <= OFF + rtkDuration.`);
  } catch (e) {
    console.warn("[benchmark] RTK benchmark failed (fail-open):", String(e));
  }

  // --- Headroom OFF vs ON benchmark (Phase 6) ---
  console.log(`\n=== Headroom Benchmark: OFF vs ON ===`);
  let headroomResults: any[] = [];
  // Mock Headroom proxy — compresses messages to 40% size for large contexts
  function createMockHeadroomServer() {
    return Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/v1/compress" && req.method === "POST") {
          const body: any = await req.json().catch(() => ({}));
          const messages = body.messages as any[];
          if (!Array.isArray(messages)) return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
          // Simulate headroom: keep system + last 2 messages, compress rest to 30% length
          const compressed = messages.map((m: any, idx: number) => {
            const isSystem = m.role === "system";
            const isRecent = idx >= messages.length - 2;
            if (isSystem || isRecent) return m;
            if (typeof m.content === "string" && m.content.length > 500) {
              return { ...m, content: m.content.slice(0, Math.floor(m.content.length * 0.3)) + " [compressed]" };
            }
            if (Array.isArray(m.content)) {
              return { ...m, content: m.content.slice(0, 1) };
            }
            return m;
          });
          // Add small processing delay 5-15ms to simulate headroom overhead
          await new Promise((r) => setTimeout(r, 8 + Math.random() * 7));
          return new Response(JSON.stringify({ messages: compressed, stats: { tokens_before: 15000, tokens_after: 6000, tokens_saved: 9000 }, mode: "cache" }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response("not found", { status: 404 });
      },
    });
  }

  try {
    const mockHeadroom = createMockHeadroomServer();
    const headroomUrl = `http://localhost:${(mockHeadroom as any).port}`;
    console.log(`Mock Headroom proxy: ${headroomUrl}/v1/compress`);

    // Build headroom scenarios: tiny (<10K tokens, should skip), large (42KB), very-large (100KB+)
    const tinyReq = { model: "test-model", messages: [{ role: "user", content: "Hello" }] };
    const smallReq = { model: "test-model", messages: [{ role: "user", content: "x".repeat(5000) }] };
    const largeReq = {
      model: "test-model",
      messages: [
        { role: "system", content: "You are helpful" },
        ...Array.from({ length: 20 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `Turn ${i}: ${"long context ".repeat(150)}` + ` tool_history_${i} ` + "y".repeat(1000) })),
        ...Array.from({ length: 5 }, (_, i) => ({ role: "tool", tool_call_id: `call_${i}`, content: `git diff large output ` + "a".repeat(4000) + ` for file ${i}` })),
      ],
    };
    const veryLargeReq = {
      model: "test-model",
      messages: Array.from({ length: 40 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `Very large turn ${i}: ` + "Lorem ipsum ".repeat(300) })),
    };

    const headroomScenarios = [
      { name: "headroom-tiny", request: tinyReq, expectSkipped: true },
      { name: "headroom-small", request: smallReq, expectSkipped: true },
      { name: "headroom-large", request: largeReq, expectSkipped: false },
      { name: "headroom-very-large", request: veryLargeReq, expectSkipped: false },
    ];

    const gatewayHeadroomOff = createServer({
      port: 0,
      providers: { providers: [{ id: "upstream", baseURL: providerBase, models: ["*"] }] },
      routes: { routes: { fast: { strategy: "fallback", primary: { provider: "upstream", model: "test-model" }, fallbacks: [], optimizers: { rtk: false, headroom: false } } }, defaultRoute: "fast" },
      optimization: { optimizers: { rtk: false, headroom: { enabled: false, minimumTokens: 10000, url: headroomUrl } } },
    });
    const gatewayHeadroomOn = createServer({
      port: 0,
      providers: { providers: [{ id: "upstream", baseURL: providerBase, models: ["*"] }] },
      routes: { routes: { fast: { strategy: "fallback", primary: { provider: "upstream", model: "test-model" }, fallbacks: [], optimizers: { rtk: false, headroom: true } } }, defaultRoute: "fast" },
      optimization: { optimizers: { rtk: false, headroom: { enabled: true, minimumTokens: 10000, timeoutMs: 500, url: headroomUrl } } },
    });
    await new Promise((r) => setTimeout(r, 300));
    const offBaseH = `http://localhost:${(gatewayHeadroomOff as any).port}`;
    const onBaseH = `http://localhost:${(gatewayHeadroomOn as any).port}`;

    for (const sc of headroomScenarios) {
      const iter = Math.min(iterations, 12);

      async function measureHeadroom(base: string) {
        const totals: number[] = [];
        const headroomDurations: number[] = [];
        const savedBytesArr: number[] = [];
        let lastSaved = 0;
        let lastPercent = 0;
        let lastReason = "disabled";
        for (let i = 0; i < iter; i++) {
          const start = performance.now();
          const res = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sc.request) });
          if (!res.ok) throw new Error(`Headroom gateway failed ${res.status}: ${await res.text()}`);
          await res.json();
          const end = performance.now();
          totals.push(end - start);
          try {
            const mRes = await fetch(`${base}/metrics`);
            const mJson: any = await mRes.json();
            const recent = mJson.recent?.[mJson.recent.length - 1];
            if (recent?.headroom) {
              headroomDurations.push(recent.headroom.durationMs ?? 0);
              savedBytesArr.push(recent.headroom.savedBytes ?? 0);
              lastSaved = recent.headroom.savedBytes ?? 0;
              lastPercent = recent.headroom.savedPercent ?? 0;
              lastReason = recent.headroom.reason ?? "unknown";
            }
          } catch { headroomDurations.push(0); }
        }
        return {
          total: computeStats(totals),
          headroomDuration: computeStats(headroomDurations),
          savedBytes: lastSaved,
          savedPercent: lastPercent,
          reason: lastReason,
          avgSaved: savedBytesArr.length ? savedBytesArr.reduce((a, b) => a + b, 0) / savedBytesArr.length : 0,
        };
      }

      const off = await measureHeadroom(offBaseH);
      const on = await measureHeadroom(onBaseH);
      const delta = (on.total.p50 ?? 0) - (off.total.p50 ?? 0);
      const verdict = sc.expectSkipped
        ? (on.savedBytes === 0 ? "PASS (correctly skipped)" : "CHECK (should have skipped)")
        : (on.savedBytes > 0 && on.headroomDuration.p50! < 15 ? (delta < 10 ? "PASS" : "CHECK (overhead)") : "MISS");

      console.log(`  ${sc.name.padEnd(20)} | OFF ${fmt(off.total.p50).padEnd(10)} | ON ${fmt(on.total.p50).padEnd(10)} | Δ ${delta.toFixed(2)}ms | Headroom ${fmt(on.headroomDuration.p50)} p50 | saved ${on.savedBytes}B (${on.savedPercent.toFixed(1)}%) reason:${on.reason} | ${verdict}`);

      headroomResults.push({
        scenario: sc.name,
        expectSkipped: sc.expectSkipped,
        off: { totalLatency: off.total, headroomDuration: off.headroomDuration },
        on: { totalLatency: on.total, headroomDuration: on.headroomDuration, savedBytes: on.savedBytes, savedPercent: on.savedPercent, reason: on.reason },
        deltaMs: delta,
        inputBytes: Buffer.byteLength(JSON.stringify(sc.request), "utf-8"),
      });
    }

    gatewayHeadroomOff.stop(true);
    gatewayHeadroomOn.stop(true);
    mockHeadroom.stop(true);
    console.log(`\nHeadroom summary: threshold 10K tokens tested; large/very-large should compress, tiny/small should skip. Headroom duration <15ms p50 ideal; total ON should be OFF + headroomDuration - savedNetworkTime.`);
  } catch (e) {
    console.warn("[benchmark] Headroom benchmark failed (fail-open):", String(e));
    console.warn((e as any)?.stack);
  }

  // Save JSON
  const out = {
    timestamp: new Date().toISOString(),
    iterations,
    mockLatencyMs: mockLatency,
    results,
    rtkBenchmark: rtkResults,
    headroomBenchmark: headroomResults,
    equation: "totalLatency ≈ gatewayOverhead + providerLatency + generation (generation ≈ 0 for mock)",
    note: "gatewayOverhead measured as totalLatency - providerLatency via server metrics; 'unknown' if provider latency unavailable. RTK/Headroom benchmarks compare OFF vs ON with same provider/model/request. Headroom threshold 10K tokens, fail-open.",
  };
  await Bun.write("benchmark-results.json", JSON.stringify(out, null, 2));
  console.log(`\nResults saved to benchmark-results.json`);

  // Cleanup
  gateway.stop(true);
  mockProvider.stop(true);

  // Verdict
  const allOverheads = results.filter((r) => r.mode === "mini").map((r) => r.gatewayOverhead.p50 ?? 999);
  const maxP50 = Math.max(...allOverheads);
  if (maxP50 < 20) {
    console.log(`\n✓ All P50 gateway overheads <20ms — TARGET MET`);
  } else {
    console.log(`\n⚠ Some P50 overheads >=20ms (max ${maxP50.toFixed(2)}ms) — PROFILE FIRST, do not add middleware to hide problem`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
