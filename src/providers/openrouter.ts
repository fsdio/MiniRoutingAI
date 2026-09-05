// src/providers/openrouter.ts — OpenRouter adapter
import { OpenAICompatibleAdapter } from "./provider.ts";

export class OpenRouterProvider extends OpenAICompatibleAdapter {
  constructor(baseURL: string, apiKeyEnv?: string) {
    super("openrouter", baseURL, apiKeyEnv, {
      "HTTP-Referer": "http://localhost:3000",
      "X-Title": "MiniRoutingAI",
    });
  }
}

export function createOpenRouterProvider(baseURL: string, apiKeyEnv = "OPENROUTER_API_KEY") {
  return new OpenRouterProvider(baseURL, apiKeyEnv);
}
