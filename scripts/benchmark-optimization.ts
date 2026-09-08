// scripts/benchmark-optimization.ts — Wave 5: benchmark harness reproducible (mock provider + headroom mock)
// Scenario A-F × 5 kelas task. Success = 200 + payload integrity (tool_call linkage, system intact).
// Cost = estimasi dari usage sintetis mock (bytes/4) × tarif. Zero billable.

import { createServer } from "../src/server/server.ts";
import { globalHealthStore } from "../src/router/health.ts";
import { clearMetrics } from "../src/telemetry/metrics.ts";
import { globalDuplicateCache, globalRtkMemo } from "../src/memory/duplicate-cache.ts";

const PRICE_IN = 0.2 / 1_000_000; // USD per token
const PRICE_OUT = 2.0 / 1_000_000;

// ---------- Mock upstream provider ----------
function startMockProvider() {
  let integrityFails = 0;
  return Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body: any = await req.json();
      // Integrity assertions (proxy kualitas kompresi)
      const msgs: any[] = body.messages ?? [];
      const toolCallIds = new Set<string>();
      for (const m of msgs) {
        if (m.tool_calls) for (const tc of m.tool_calls) toolCallIds.add(tc.id);
      }
      let ok = true;
      for (const m of msgs) {
        if (m.role === "system" && (!m.content || String(m.content).length === 0)) ok = false;
        if (m.role === "tool") {
          if (!m.tool_call_id || !toolCallIds.has(m.tool_call_id)) ok = false;
          if (m.content === undefined || m.content === null) ok = false;
        }
        if (m.role === "assistant" && m.tool_calls?.length) {
          for (const tc of m.tool_calls) {
            if (!tc.function?.name) ok = false;
            const args = tc.function?.arguments;
            if (typeof args === "string" && args.length > 0) {
              try { JSON.parse(args); } catch { ok = false; }
            }
          }
        }
      }
      if (!ok) {
        integrityFails++;
        return new Response(JSON.stringify({ error: { message: "payload integrity check failed", type: "invalid_request_error", code: "400" } }), { status: 400 });
      }
      const content = `done ${body.model}`;
      const promptTokens = Math.ceil(Buffer.byteLength(JSON.stringify(body), "utf-8") / 4);
      const completionTokens = 40;
      return new Response(JSON.stringify({
        id: "mock", object: "chat.completion", created: Date.now() / 1000, model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      }), { status: 200 });
    },
  });
}

// ---------- Mock headroom proxy ----------
function startMockHeadroom() {
  return Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/health")) return new Response("ok");
      if (url.pathname.endsWith("/v1/compress")) {
        const body: any = await req.json();
        const messages = (body.messages ?? []).map((m: any) => {
          if (m.role === "developer") return m;
          if (typeof m.content === "string" && m.content.length > 300) {
            return { ...m, content: `${m.content.slice(0, 120)}[...compressed:${m.content.length}B]` };
          }
          return m;
        });
        return new Response(JSON.stringify({ messages }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

// ---------- Task fixtures (5 kelas × 2 task) ----------
function toolMsg(id: string, content: string): any {
  return { role: "tool", tool_call_id: id, content };
}
function assistantToolCalls(calls: Array<{ id: string; name: string; args: any }>): any {
  return {
    role: "assistant",
    content: null,
    tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })),
  };
}
function noisy(n: number, seed = "x"): string {
  return Array.from({ length: n }, (_, i) => `${seed}-${i}: ${Math.random().toString(36).slice(2, 12)}`).join("\n");
}

function buildTasks(): Record<string, any[]> {
  const fileRead = (name: string, lines: number) => `${name}\n${noisy(lines, "line")}`;
  return {
    simple: [
      [{ role: "user", content: "Fix typo in README: 'recieve' → 'receive'. Output: one-line sed command." }],
      [{ role: "user", content: "What does `Array.prototype.flat(depth)` do? Answer in one sentence." }],
    ],
    debugging: [
      [
        { role: "user", content: "App crashes on /api/users. Find root cause from logs." },
        assistantToolCalls([{ id: "t1", name: "bash", args: { cmd: "npm test" } }]),
        toolMsg("t1", `Error: Cannot read property 'id' of undefined\n${noisy(400, "stack")}\nError: Cannot read property 'id' of undefined\n${noisy(200, "stack2")}`),
        { role: "user", content: "Continue diagnosis." },
      ],
      [
        { role: "user", content: "CI pipeline red. Analyze failure." },
        assistantToolCalls([{ id: "t2", name: "bash", args: { cmd: "gh run view" } }]),
        toolMsg("t2", `FAIL tests/auth.test.ts\n${noisy(300, "log")}\nFAIL tests/auth.test.ts\n${noisy(100, "log2")}`),
      ],
    ],
    refactoring: [
      [
        { role: "user", content: "Refactor getUserData to async/await." },
        assistantToolCalls([{ id: "t3", name: "read", args: { file: "src/user.ts" } }]),
        toolMsg("t3", fileRead("src/user.ts", 900)),
      ],
      [
        { role: "user", content: "Split this module into two files, keep exports stable." },
        assistantToolCalls([{ id: "t4", name: "read", args: { file: "src/router.ts" } }]),
        toolMsg("t4", fileRead("src/router.ts", 1200)),
        assistantToolCalls([{ id: "t5", name: "read", args: { file: "src/router.ts" } }]),
        toolMsg("t5", fileRead("src/router.ts", 1200)),
      ],
    ],
    "multi-file": [
      [
        { role: "user", content: "Add validation to all API handlers listed by grep." },
        assistantToolCalls([{ id: "t6", name: "grep", args: { pattern: "export function handle" } }]),
        toolMsg("t6", noisy(500, "hit")),
        assistantToolCalls([{ id: "t7", name: "read", args: { file: "src/a.ts" } }]),
        toolMsg("t7", fileRead("src/a.ts", 400)),
        assistantToolCalls([{ id: "t8", name: "read", args: { file: "src/b.ts" } }]),
        toolMsg("t8", fileRead("src/b.ts", 400)),
      ],
      [
        { role: "user", content: "Update DB schema and all call sites." },
        assistantToolCalls([
          { id: "t9", name: "git_diff", args: {} },
          { id: "t10", name: "read", args: { file: "src/schema.ts" } },
        ]),
        toolMsg("t9", `diff --git a/src/schema.ts b/src/schema.ts\n${noisy(600, "diff")}`),
        toolMsg("t10", fileRead("src/schema.ts", 500)),
      ],
    ],
    architecture: [
      [
        { role: "user", content: "Evaluate whether to introduce an event bus. Summarize tradeoffs." },
        assistantToolCalls([{ id: "t11", name: "tree", args: { path: "src" } }]),
        toolMsg("t11", noisy(800, "tree")),
        { role: "user", content: "Now draft migration steps for the highest-risk module." },
        assistantToolCalls([{ id: "t12", name: "read", args: { file: "src/events.ts" } }]),
        toolMsg("t12", fileRead("src/events.ts", 700)),
      ],
      [
        { role: "user", content: "Review the auth design for security gaps." },
        assistantToolCalls([{ id: "t13", name: "grep", args: { pattern: "jwt" } }]),
        toolMsg("t13", noisy(700, "jwt")),
        { role: "user", content: "Prioritize the top 3 fixes with code sketches." },
      ],
    ],
  };
}

// ---------- Scenarios ----------
type Scenario = { name: string; optimizers: any };
function buildScenarios(headroomUrl: string): Scenario[] {
  return [
    { name: "A-baseline", optimizers: { rtk: false, headroom: false, caveman: false, ponytail: false } },
    { name: "B-rtk", optimizers: { rtk: { enabled: true, minBytes: 500 }, headroom: false, caveman: false, ponytail: false } },
    { name: "C-r+h", optimizers: { rtk: { enabled: true, minBytes: 500 }, headroom: { enabled: true, url: headroomUrl, minimumTokens: 3000, minimumBytes: 4000, timeoutMs: 4000, healthProbeMs: 500, compressUserMessages: true }, caveman: false, ponytail: false } },
    { name: "D-r+h+cav", optimizers: { rtk: { enabled: true, minBytes: 500 }, headroom: { enabled: true, url: headroomUrl, minimumTokens: 3000, minimumBytes: 4000, timeoutMs: 4000, healthProbeMs: 500, compressUserMessages: true }, caveman: "lite", ponytail: false } },
    { name: "E-r+h+pony", optimizers: { rtk: { enabled: true, minBytes: 500 }, headroom: { enabled: true, url: headroomUrl, minimumTokens: 3000, minimumBytes: 4000, timeoutMs: 4000, healthProbeMs: 500, compressUserMessages: true }, caveman: false, ponytail: "lite" } },
    { name: "F-full", optimizers: { rtk: { enabled: true, minBytes: 500 }, headroom: { enabled: true, url: headroomUrl, minimumTokens: 3000, minimumBytes: 4000, timeoutMs: 4000, healthProbeMs: 500, compressUserMessages: true }, caveman: "lite", ponytail: "lite" } },
  ];
}

// ---------- Runner ----------
interface TaskResult {
  scenario: string;
  taskClass: string;
  success: boolean;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  fallbackCount: number;
  originalInputTokens: number;
  rtkSavedTokens: number;
  headroomSavedTokens: number;
}

async function runTask(port: number, messages: any[]): Promise<{ status: number; accounting: any; fallbackCount: number; latencyMs: number; errorClass?: string }> {
  const start = performance.now();
  try {
    const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "balanced", messages }),
    });
    const latencyMs = performance.now() - start;
    await res.text();
    return { status: res.status, accounting: null, fallbackCount: Number(res.headers.get("x-fallback-count") ?? 0), latencyMs, errorClass: res.headers.get("x-error-class") ?? undefined };
  } catch (e: any) {
    return { status: 0, accounting: null, fallbackCount: 0, latencyMs: performance.now() - start, errorClass: String(e?.message ?? e) };
  }
}

// Accounting per request diambil dari /debug/recent (in-memory metrics ring buffer)
async function fetchRecentAccounting(port: number): Promise<any[]> {
  const res = await fetch(`http://localhost:${port}/debug/recent`);
  const arr: any[] = (await res.json()) as any[];
  return arr.filter((m) => m.accounting);
}

async function main() {
  const provider = startMockProvider();
  const headroom = startMockHeadroom();
  const scenarios = buildScenarios(`http://localhost:${(headroom as any).port}`);
  const tasks = buildTasks();
  const results: TaskResult[] = [];

  for (const sc of scenarios) {
    // Reset state antar scenario
    clearMetrics();
    globalHealthStore.clear();
    globalDuplicateCache.clear();
    globalRtkMemo.clear();
    const server = createServer({
      port: 0,
      providers: { providers: [{ id: "mock", baseURL: `http://localhost:${(provider as any).port}/v1`, models: ["*"], defaultWeight: 10 }] },
      routes: {
        routes: {
          balanced: {
            strategy: "fallback",
            primary: { provider: "mock", model: "mock-model" },
            fallbacks: [],
            timeoutMs: 8000,
            retry: { maxRetries: 0, backoffMs: 0 },
            optimizers: sc.optimizers,
          },
        },
        defaultRoute: "balanced",
      },
      optimization: { optimizers: sc.optimizers },
      prices: { mock: { inputPerMillion: 0.2, outputPerMillion: 2.0 } },
    } as any);
    const port = server.port ?? 0;

    for (const [taskClass, msgsList] of Object.entries(tasks)) {
      for (const messages of msgsList) {
        const r = await runTask(port, messages);
        results.push({
          scenario: sc.name,
          taskClass,
          success: r.status === 200,
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: r.latencyMs,
          fallbackCount: r.fallbackCount,
          originalInputTokens: 0,
          rtkSavedTokens: 0,
          headroomSavedTokens: 0,
        });
      }
    }
    // Gabungkan accounting dari /debug/recent (SEBELUM server.stop)
    const recents = await fetchRecentAccounting(port);
    const chatAccs = recents.filter((m) => m.route === "balanced" && m.status === 200);
    let idx = 0;
    for (const r of results) {
      if (r.scenario !== sc.name || r.inputTokens !== 0) continue;
      const acc = chatAccs[idx++]?.accounting;
      if (!acc) continue;
      const t = acc.tokens ?? {};
      r.inputTokens = typeof t.actualPrompt === "number" ? t.actualPrompt : 0;
      r.outputTokens = typeof t.actualOutput === "number" ? t.actualOutput : 40;
      r.originalInputTokens = t.originalInput ?? 0;
      r.rtkSavedTokens = t.rtkSaved ?? 0;
      r.headroomSavedTokens = t.headroomSaved ?? 0;
    }
    server.stop(true);
  }
  provider.stop(true);
  headroom.stop(true);

  // ---------- Report ----------
  const byScenario = new Map<string, TaskResult[]>();
  for (const r of results) {
    const arr = byScenario.get(r.scenario) ?? [];
    arr.push(r);
    byScenario.set(r.scenario, arr);
  }

  console.log("\n=== BENCHMARK OPTIMIZATION — Mock Provider (deterministik) ===\n");
  const header = ["scenario", "success", "avgInTok", "totInTok", "totOutTok", "estCostUSD", "avgLatMs", "fallbacks", "rtkTok", "headroomTok", "score"];
  console.log(header.join("\t"));
  const costs = new Map<string, number>();
  for (const [name, rs] of byScenario) {
    const successRate = rs.filter((r) => r.success).length / rs.length;
    const totIn = rs.reduce((s, r) => s + r.inputTokens, 0);
    const totOut = rs.reduce((s, r) => s + r.outputTokens, 0);
    const avgIn = Math.round(totIn / rs.length);
    const estCost = totIn * PRICE_IN + totOut * PRICE_OUT;
    costs.set(name, estCost);
    const avgLat = Math.round(rs.reduce((s, r) => s + r.latencyMs, 0) / rs.length);
    const fb = rs.reduce((s, r) => s + r.fallbackCount, 0);
    const rtkTok = rs.reduce((s, r) => s + r.rtkSavedTokens, 0);
    const hrTok = rs.reduce((s, r) => s + r.headroomSavedTokens, 0);
    const score = successRate / Math.max(estCost, 1e-9);
    console.log([name, `${(successRate * 100).toFixed(0)}%`, avgIn, totIn, totOut, estCost.toFixed(6), avgLat, fb, rtkTok, hrTok, score.toFixed(0)].join("\t"));
  }

  const baseline = costs.get("A-baseline") ?? 1;
  console.log("\n=== Cost vs baseline & per-task-class (input tokens) ===");
  for (const [name] of byScenario) {
    const c = costs.get(name)!;
    console.log(`${name}: cost reduction = ${(((baseline - c) / baseline) * 100).toFixed(1)}%`);
  }
  console.log("\n=== Per task class (avg input tokens) ===");
  const classes = Object.keys(tasks);
  console.log(["class", ...byScenario.keys()].join("\t"));
  for (const cls of classes) {
    const row = [cls];
    for (const [, rs] of byScenario) {
      const sub = rs.filter((r) => r.taskClass === cls);
      const avg = Math.round(sub.reduce((s, r) => s + r.inputTokens, 0) / Math.max(1, sub.length));
      row.push(String(avg));
    }
    console.log(row.join("\t"));
  }
  const totalFails = results.filter((r) => !r.success).length;
  console.log(`\nIntegrity failures (payload rusak oleh kompresi): ${totalFails}`);
  if (totalFails > 0) {
    for (const r of results.filter((x) => !x.success)) console.log(`  FAIL: ${r.scenario} / ${r.taskClass}`);
  }
}

main();
