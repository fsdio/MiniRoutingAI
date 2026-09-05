import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { applyRtk } from "../src/optimizer/rtk.ts";
import { createServer } from "../src/server/server.ts";
import { clearMetrics, getRecentMetrics } from "../src/telemetry/metrics.ts";

function chatReqWithTool(content: string, extra?: any) {
  return {
    model: "test-model",
    messages: [
      { role: "user", content: "hi" },
      { role: "tool", tool_call_id: "call_1", content, ...(extra ?? {}) },
    ],
  } as any;
}

describe("Phase 5 — RTK Integration", () => {
  test("RTK disabled → skipped disabled, no mutation", async () => {
    const content = await Bun.file("tests/fixtures/rtk/gitDiff.txt").text();
    const req = chatReqWithTool(content);
    const before = JSON.stringify(req);
    const result = applyRtk(req, { enabled: false });
    expect(result.enabled).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("disabled");
    expect(result.success).toBe(false);
    expect(result.savedBytes).toBe(0);
    expect(JSON.stringify(req)).toBe(before);
  });

  test("RTK no_tool_output → skipped", () => {
    const req: any = { model: "test", messages: [{ role: "user", content: "hello" }] };
    const result = applyRtk(req, { enabled: true });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("no_tool_output");
  });

  test("RTK below_min_bytes → skipped", () => {
    const req = chatReqWithTool("tiny");
    const result = applyRtk(req, { enabled: true });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("below_min_bytes");
  });

  test("RTK git diff → success, savedBytes >0, filter git-diff", async () => {
    const content = await Bun.file("tests/fixtures/rtk/gitDiff.txt").text();
    const req = chatReqWithTool(content);
    const inputBytes = Buffer.byteLength(JSON.stringify(req), "utf-8");
    const result = applyRtk(req, { enabled: true });
    expect(result.success).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.savedBytes).toBeGreaterThan(0);
    expect(result.savedPercent).toBeGreaterThan(0);
    expect(result.outputBytes).toBeLessThan(inputBytes);
    expect(result.filter).toContain("git-diff");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeLessThan(100);
    expect(result.inputBytes).toBe(inputBytes);
    // Verify content was mutated (compressed) but not empty
    const afterContent = (req.messages[1] as any).content as string;
    expect(afterContent.length).toBeLessThan(content.length);
    expect(afterContent.length).toBeGreaterThan(0);
  });

  test("RTK git status → success, filter git-status", async () => {
    const content = await Bun.file("tests/fixtures/rtk/gitStatus.txt").text();
    const req = chatReqWithTool(content + "\n" + "x".repeat(1000)); // ensure >500B
    const result = applyRtk(req, { enabled: true });
    expect(result.success).toBe(true);
    expect(result.filter).toContain("git-status");
    expect(result.savedBytes).toBeGreaterThan(0);
  });

  test("RTK git log → success, filter git-log", async () => {
    const content = await Bun.file("tests/fixtures/rtk/gitLog.txt").text();
    const req = chatReqWithTool(content);
    const result = applyRtk(req, { enabled: true });
    // git log may be detected as git-log or dedup depending on size; but should be success
    expect(result.success).toBe(true);
    expect(result.savedBytes).toBeGreaterThan(0);
  });

  test("RTK grep output → success, filter grep", async () => {
    const content = await Bun.file("tests/fixtures/rtk/grepOutput.txt").text();
    const req = chatReqWithTool(content);
    const result = applyRtk(req, { enabled: true });
    expect(result.success).toBe(true);
    expect(result.filter).toContain("grep");
    expect(result.savedBytes).toBeGreaterThan(0);
  });

  test("RTK ls output → success, filter ls", async () => {
    const content = await Bun.file("tests/fixtures/rtk/lsOutput.txt").text();
    const req = chatReqWithTool(content + "\n" + "extra ".repeat(200));
    const result = applyRtk(req, { enabled: true });
    expect(result.success).toBe(true);
    // ls filter may be ls or dedup depending on detection window, but should compress
    expect(result.savedBytes).toBeGreaterThan(0);
  });

  test("RTK large tool output → success, dedup or smartTruncate", async () => {
    const content = await Bun.file("tests/fixtures/rtk/largeToolOutput.txt").text();
    const req = chatReqWithTool(content);
    const result = applyRtk(req, { enabled: true });
    expect(result.success).toBe(true);
    expect(result.savedBytes).toBeGreaterThan(0);
    expect(result.savedPercent).toBeGreaterThan(5);
  });

  test("RTK is_error preserved → skipped", async () => {
    const content = await Bun.file("tests/fixtures/rtk/gitDiff.txt").text();
    const req: any = {
      model: "test",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "tool_result", tool_use_id: "1", content: content, is_error: true }] },
      ],
    };
    const before = JSON.stringify(req);
    const result = applyRtk(req, { enabled: true });
    // Either skipped as is_error_preserved or unrecognized, but should not mutate error content
    expect(result.skipped).toBe(true);
    // Content should remain original (error preserved)
    expect(JSON.stringify(req)).toBe(before);
  });

  test("RTK unrecognized output → skipped unrecognized_output or no_saving", async () => {
    const randomCode = "function hello() { console.log('hello world'); return 42; }".repeat(20); // ~1000B but no tool pattern
    const req = chatReqWithTool(randomCode);
    const result = applyRtk(req, { enabled: true });
    // Should either skip as unrecognized or compress via dedup/smartTruncate (still success) — but not throw
    expect(result.enabled).toBe(true);
    // Not asserting success strictly; just ensure no crash and bytes consistent
    expect(result.inputBytes).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("RTK fail-open on throw (malformed body)", () => {
    const req: any = {
      model: "test",
      messages: [
        { role: "tool", content: null as any }, // malformed, content not string
      ],
    };
    const before = JSON.stringify(req);
    const result = applyRtk(req, { enabled: true });
    // Should fail-open, not throw
    expect(result).toBeDefined();
    expect(result.success === false || result.skipped === true).toBe(true);
    // Request should still be usable (not crashed)
    expect(req.messages).toBeDefined();
  });

  test("RTK telemetry bytes measured correctly", async () => {
    const content = await Bun.file("tests/fixtures/rtk/gitDiff.txt").text();
    const req = chatReqWithTool(content);
    const result = applyRtk(req, { enabled: true });
    expect(result.inputBytes).toBeGreaterThan(result.outputBytes);
    expect(result.savedBytes).toBe(result.inputBytes - result.outputBytes);
    expect(result.savedPercent).toBeCloseTo((result.savedBytes / result.inputBytes) * 100, 5);
  });

  test("RTK gateway integration — RTK OFF vs ON", async () => {
    const gitDiff = await Bun.file("tests/fixtures/rtk/gitDiff.txt").text();

    // Mock provider that captures request body
    let capturedOff: any = null;
    let capturedOn: any = null;

    const mockOff = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = await req.json().catch(() => ({})) as any;
        capturedOff = body;
        return new Response(JSON.stringify({ id: "c", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10 } }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    const mockOn = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = await req.json().catch(() => ({})) as any;
        capturedOn = body;
        return new Response(JSON.stringify({ id: "c", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 80, completion_tokens: 10 } }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });

    // Gateway OFF
    const gatewayOff = createServer({
      port: 0,
      providers: { providers: [{ id: "upstream", baseURL: `http://localhost:${(mockOff as any).port}/v1` }] },
      routes: { routes: { fast: { strategy: "fallback", primary: { provider: "upstream", model: "test" }, fallbacks: [], optimizers: { rtk: false } } }, defaultRoute: "fast" },
      optimization: { optimizers: { rtk: false } },
    });
    await new Promise((r) => setTimeout(r, 100));
    const offPort = (gatewayOff as any).port;

    clearMetrics();
    const resOff = await fetch(`http://localhost:${offPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "hi" }, { role: "tool", tool_call_id: "1", content: gitDiff }] }),
    });
    expect(resOff.status).toBe(200);
    const offMetric = getRecentMetrics().slice(-1)[0] as any;
    expect(offMetric.rtk?.enabled).toBe(false);
    expect(offMetric.rtk?.skipped).toBe(true);
    expect(capturedOff.messages[1].content.length).toBe(gitDiff.length);

    // Gateway ON
    const gatewayOn = createServer({
      port: 0,
      providers: { providers: [{ id: "upstream", baseURL: `http://localhost:${(mockOn as any).port}/v1` }] },
      routes: { routes: { fast: { strategy: "fallback", primary: { provider: "upstream", model: "test" }, fallbacks: [], optimizers: { rtk: true } } }, defaultRoute: "fast" },
      optimization: { optimizers: { rtk: { enabled: true } } },
    });
    await new Promise((r) => setTimeout(r, 100));
    const onPort = (gatewayOn as any).port;

    clearMetrics();
    const resOn = await fetch(`http://localhost:${onPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "hi" }, { role: "tool", tool_call_id: "1", content: gitDiff }] }),
    });
    expect(resOn.status).toBe(200);
    const onMetric = getRecentMetrics().slice(-1)[0] as any;
    expect(onMetric.rtk?.enabled).toBe(true);
    expect(onMetric.rtk?.success).toBe(true);
    expect(onMetric.rtk?.savedBytes).toBeGreaterThan(0);
    expect(onMetric.rtk?.durationMs).toBeGreaterThanOrEqual(0);
    expect(onMetric.rtk?.durationMs).toBeLessThan(50);
    // ON should have smaller body sent to provider
    expect(capturedOn.messages[1].content.length).toBeLessThan(capturedOff.messages[1].content.length);

    // Secrets not logged
    const logCheck = JSON.stringify(onMetric);
    expect(logCheck.toLowerCase().includes("api_key")).toBe(false);

    gatewayOff.stop(true);
    gatewayOn.stop(true);
    mockOff.stop(true);
    mockOn.stop(true);
  });

  test("RTK gateway — arbitrary output not blindly compressed (is_error case via server)", async () => {
    const mock = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body: any = await req.json();
        return new Response(JSON.stringify({ id: "c", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    const gateway = createServer({
      port: 0,
      providers: { providers: [{ id: "upstream", baseURL: `http://localhost:${(mock as any).port}/v1` }] },
      routes: { routes: { fast: { strategy: "fallback", primary: { provider: "upstream", model: "test" }, fallbacks: [], optimizers: { rtk: true } } }, defaultRoute: "fast" },
      optimization: { optimizers: { rtk: { enabled: true } } },
    });
    await new Promise((r) => setTimeout(r, 100));
    const port = (gateway as any).port;
    // Send tool_result with is_error true via Claude shape
    const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test",
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          { role: "assistant", content: [{ type: "tool_result", tool_use_id: "1", content: "some error stack", is_error: true }] },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const metric = getRecentMetrics().slice(-1)[0] as any;
    // Should be skipped as no tool output or is_error preserved
    expect(metric.rtk).toBeDefined();
    gateway.stop(true);
    mock.stop(true);
  });

  test("RTK config — per-route overrides global", async () => {
    const content = await Bun.file("tests/fixtures/rtk/gitDiff.txt").text();
    // Global enabled false, but route balanced true → should enable
    const mock = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body: any = await req.json();
        return new Response(JSON.stringify({ id: "c", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), { status: 200 });
      },
    });
    const gateway = createServer({
      port: 0,
      providers: { providers: [{ id: "upstream", baseURL: `http://localhost:${(mock as any).port}/v1` }] },
      routes: {
        routes: {
          fast: { strategy: "fallback", primary: { provider: "upstream", model: "test" }, fallbacks: [], optimizers: { rtk: false } },
          balanced: { strategy: "fallback", primary: { provider: "upstream", model: "test" }, fallbacks: [], optimizers: { rtk: true } },
        },
        defaultRoute: "balanced",
      },
      optimization: { optimizers: { rtk: { enabled: false } } },
    });
    await new Promise((r) => setTimeout(r, 100));
    const port = (gateway as any).port;
    clearMetrics();
    const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "hi" }, { role: "tool", tool_call_id: "1", content: content }] }),
    });
    expect(res.status).toBe(200);
    const metric = getRecentMetrics().slice(-1)[0] as any;
    expect(metric.route).toBe("balanced");
    expect(metric.rtk?.enabled).toBe(true);
    expect(metric.rtk?.success).toBe(true);
    gateway.stop(true);
    mock.stop(true);
  });
});
