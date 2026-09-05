// src/providers/ollama.ts — Ollama adapter (OpenAI-compatible via /v1)
import { OpenAICompatibleAdapter } from "./provider.ts";

export class OllamaProvider extends OpenAICompatibleAdapter {
  constructor(baseURL: string, apiKeyEnv?: string) {
    super("ollama", baseURL, apiKeyEnv);
  }

  // Ollama's OpenAI-compatible endpoint sometimes expects slightly different handling,
  // but for /v1/chat/completions it is compatible. Keep normalization minimal.
  protected normalizeRequest(request: any): any {
    // Ollama does not require extra headers; ensure stream is boolean
    return super.normalizeRequest(request);
  }

  async health(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    const start = performance.now();
    try {
      // Ollama health is typically GET /api/tags on host without /v1
      const baseWithoutV1 = this["baseURL"].replace(/\/v1$/, "");
      const res = await fetch(`${baseWithoutV1}/api/tags`, { method: "GET" });
      const latencyMs = performance.now() - start;
      if (res.ok) return { ok: true, latencyMs };
      // fallback to OpenAI /models
      return super.health();
    } catch (e) {
      // fallback
      return super.health();
    }
  }
}

export function createOllamaProvider(baseURL: string, apiKeyEnv?: string) {
  return new OllamaProvider(baseURL, apiKeyEnv);
}
