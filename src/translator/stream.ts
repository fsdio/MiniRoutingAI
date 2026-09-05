// src/translator/stream.ts — SSE transform stream (OpenAI passthrough-normalize + usage capture)
// Tiru pola createSSEStream(mode=PASSTHROUGH) MiniRoutingAI open-sse/utils/stream.js, versi lean:
// parse chunk, normalisasi ke bentuk kanonik OpenAI, akumulasi content/reasoning, ekstrak & merge
// usage, inject estimated usage pada finish chunk bila kosong, emit [DONE] bila provider tidak mengirim.
import { getStreamChunkNormalizer } from "./registry.ts";

export interface StreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  [key: string]: unknown;
}

export type OnStreamComplete = (
  content: string,
  thinking: string,
  usage: StreamUsage | null,
  ttftAt: number | null,
) => void;

export interface CreateStreamTranslatorOptions {
  provider?: string;
  model?: string;
  body?: any;
  onStreamComplete?: OnStreamComplete;
}

function hasValidUsage(u: StreamUsage | null | undefined): u is StreamUsage {
  return !!u && (typeof u.prompt_tokens === "number" || typeof u.completion_tokens === "number" || typeof u.total_tokens === "number");
}

function extractUsage(chunk: any): StreamUsage | null {
  if (!chunk) return null;
  const u = chunk.usage ?? chunk.choices?.[0]?.usage;
  return hasValidUsage(u) ? u : null;
}

function mergeUsage(a: StreamUsage | null, b: StreamUsage | null): StreamUsage | null {
  if (!b) return a;
  if (!a) return b;
  return { ...a, ...b };
}

function estimateUsage(body: any, completionChars: number): StreamUsage {
  const promptChars = JSON.stringify(body?.messages ?? []).length;
  const promptTokens = Math.max(1, Math.ceil(promptChars / 4));
  const completionTokens = Math.max(1, Math.ceil(completionChars / 4));
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
}

function canonicalizeChunk(parsed: any): any {
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.choices !== undefined) {
    if (!parsed.object) parsed.object = "chat.completion.chunk";
    if (!parsed.created) parsed.created = Math.floor(Date.now() / 1000);
    for (const c of parsed.choices ?? []) {
      if (c.content_filter_results !== undefined) delete c.content_filter_results;
      if (c.delta?.tool_calls && Array.isArray(c.delta.tool_calls) && c.delta.tool_calls.length === 0) {
        delete c.delta.tool_calls;
      }
    }
  }
  if (parsed.prompt_filter_results !== undefined) delete parsed.prompt_filter_results;
  return parsed;
}

export function createOpenAIStreamTranslator(opts: CreateStreamTranslatorOptions): TransformStream<Uint8Array, Uint8Array> {
  const { provider, model, body, onStreamComplete } = opts;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const encoder = new TextEncoder();
  let buffer = "";
  let usage: StreamUsage | null = null;
  let content = "";
  let thinking = "";
  let totalChars = 0;
  let ttftAt: number | null = null;
  let doneSent = false;
  let finalized = false;

  const normalize = getStreamChunkNormalizer(provider);
  void model;

  const finalize = () => {
    if (finalized) return;
    finalized = true;
    let finalUsage = usage;
    if (!hasValidUsage(finalUsage) && totalChars > 0) {
      finalUsage = estimateUsage(body, totalChars);
      usage = finalUsage;
    }
    if (onStreamComplete) onStreamComplete(content, thinking, finalUsage, ttftAt);
  };

  return new TransformStream({
    transform(chunk, controller) {
      if (ttftAt === null) ttftAt = Date.now();
      const text = decoder.decode(chunk, { stream: true });
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") {
          doneSent = true;
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          continue;
        }
        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        const normalized = normalize(canonicalizeChunk(parsed));
        if (!normalized) continue;
        const delta = normalized.choices?.[0]?.delta ?? {};
        if (typeof delta.content === "string" && delta.content !== "") {
          content += delta.content;
          totalChars += delta.content.length;
        }
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content !== "") {
          thinking += delta.reasoning_content;
          totalChars += delta.reasoning_content.length;
        }
        const extracted = extractUsage(normalized);
        if (extracted) usage = mergeUsage(usage, extracted);
        const finish = normalized.choices?.[0]?.finish_reason;
        if (finish && !hasValidUsage(normalized.usage)) {
          const est = estimateUsage(body, totalChars);
          normalized.usage = est;
          usage = est;
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(normalized)}\n\n`));
      }
    },
    flush(controller) {
      const rem = decoder.decode();
      if (rem) buffer += rem;
      if (buffer.trim()) {
        const trimmed = buffer.trim();
        const data = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
        if (data && data !== "[DONE]") {
          try {
            const parsed = JSON.parse(data);
            const normalized = normalize(canonicalizeChunk(parsed));
            if (normalized) controller.enqueue(encoder.encode(`data: ${JSON.stringify(normalized)}\n\n`));
          } catch {}
        }
      }
      if (!doneSent) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        doneSent = true;
      }
      finalize();
    },
  });
}
