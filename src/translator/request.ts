// src/translator/request.ts — normalisasi request OpenAI sebelum dikirim ke provider
import { getRequestTranslator } from "./registry.ts";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../types/index.ts";

export interface PrepareOptions {
  stream?: boolean;
}

export function prepareOpenAIRequest(
  request: ChatCompletionRequest,
  providerId?: string,
  opts: PrepareOptions = {},
): Record<string, any> {
  const req: Record<string, any> = { ...(request as Record<string, any>) };
  const stream = opts.stream ?? request.stream ?? false;
  if (stream) {
    // Minta upstream mengirim usage di chunk terakhir (untuk capture token).
    req.stream_options = { ...(req.stream_options ?? {}), include_usage: true };
  }
  const custom = getRequestTranslator(providerId);
  return custom(req, { stream });
}

// Normalisasi respons non-streaming ke bentuk kanonik OpenAI (default: as-is).
export function normalizeChatResponse(model: string, response?: ChatCompletionResponse): ChatCompletionResponse {
  return {
    id: response?.id ?? `chatcmpl-${Date.now()}`,
    object: response?.object ?? "chat.completion",
    created: response?.created ?? Math.floor(Date.now() / 1000),
    model: response?.model ?? model,
    choices: response?.choices ?? [],
    usage: response?.usage,
  };
}
