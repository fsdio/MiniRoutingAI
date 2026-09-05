import { describe, test, expect } from "bun:test";
import { createOpenAIStreamTranslator } from "../src/translator/stream.ts";
import { prepareOpenAIRequest } from "../src/translator/request.ts";

const enc = new TextEncoder();

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

function collect() {
  let content = "";
  let usage: any = null;
  let ttft: number | null = null;
  const onStreamComplete = (_c: string, _t: string, u: any, t: number | null) => {
    content = _c;
    usage = u;
    ttft = t;
  };
  return { onStreamComplete, get content() { return content; }, get usage() { return usage; }, get ttft() { return ttft; } };
}

describe("translator/request — prepareOpenAIRequest", () => {
  test("stream=true menambah stream_options.include_usage", () => {
    const out = prepareOpenAIRequest({ model: "m", messages: [{ role: "user", content: "hi" }], stream: true } as any);
    expect(out.stream_options).toEqual({ include_usage: true });
  });

  test("stream=false tidak menambah stream_options", () => {
    const out = prepareOpenAIRequest({ model: "m", messages: [{ role: "user", content: "hi" }], stream: false } as any);
    expect(out.stream_options).toBeUndefined();
  });

  test("tetap mempertahankan stream_options yang sudah ada", () => {
    const out = prepareOpenAIRequest({ model: "m", messages: [], stream: true, stream_options: { include_usage: false } } as any);
    expect(out.stream_options).toEqual({ include_usage: true });
  });
});

describe("translator/stream — createOpenAIStreamTranslator", () => {
  test("akumulasi content + ekstrak usage dari chunk", async () => {
    const c = collect();
    const tr = createOpenAIStreamTranslator({ provider: "upstream", body: {}, onStreamComplete: c.onStreamComplete });
    const out = await readAll(sseStream([
      'data: {"id":"a","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}\n\n',
      'data: {"id":"a","model":"m","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
      "data: [DONE]\n\n",
    ]).pipeThrough(tr));
    expect(out).toContain("data: [DONE]");
    expect(c.content).toBe("Hi!");
    expect(c.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  test("inject estimated usage saat finish chunk tanpa usage", async () => {
    const c = collect();
    const tr = createOpenAIStreamTranslator({ provider: "upstream", body: { messages: [{ role: "user", content: "hello world" }] }, onStreamComplete: c.onStreamComplete });
    const out = await readAll(sseStream([
      'data: {"object":"chat.completion.chunk","created":1,"id":"b","model":"m","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]).pipeThrough(tr));
    const finishLine = out.split("\n").find((l) => l.startsWith("data:") && l.includes("\"finish_reason\""))!;
    expect(finishLine).toContain("\"usage\"");
    expect(c.usage?.prompt_tokens).toBeGreaterThan(0);
  });

  test("inject object/created + strip prompt_filter_results & tool_calls kosong", async () => {
    const tr = createOpenAIStreamTranslator({ provider: "upstream", body: {} });
    const out = await readAll(sseStream([
      'data: {"id":"c","created":1,"model":"m","prompt_filter_results":[],"choices":[{"index":0,"delta":{"tool_calls":[],"content":"x"},"finish_reason":null}]}\n\n',
      "data: [DONE]\n\n",
    ]).pipeThrough(tr));
    expect(out).not.toContain("prompt_filter_results");
    expect(out).not.toContain("\"tool_calls\":[]");
    const dataLine = out.split("\n").find((l) => l.startsWith("data:") && !l.includes("[DONE]"))!;
    expect(JSON.parse((dataLine as any).slice(5)).object).toBe("chat.completion.chunk");
  });

  test("baris non-JSON di-skip tanpa melempar", async () => {
    const c = collect();
    const tr = createOpenAIStreamTranslator({ provider: "upstream", body: {}, onStreamComplete: c.onStreamComplete });
    const out = await readAll(sseStream([
      "data: {not valid json}\n\n",
      'data: {"id":"d","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
      "data: [DONE]\n\n",
    ]).pipeThrough(tr));
    expect(out).not.toContain("not valid");
    expect(c.content).toBe("ok");
  });

  test("emit [DONE] bila provider tidak mengirim", async () => {
    const tr = createOpenAIStreamTranslator({ provider: "upstream", body: {} });
    const out = await readAll(sseStream([
      'data: {"id":"e","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
    ]).pipeThrough(tr));
    expect(out.trim().endsWith("data: [DONE]")).toBe(true);
  });
});
