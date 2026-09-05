// src/providers/opencode-go.ts — OpenCode Go adapter (OpenAI-compatible)
import { OpenAICompatibleAdapter } from "./provider.ts";

export class OpencodeGoProvider extends OpenAICompatibleAdapter {
  constructor(baseURL: string, apiKeyEnv?: string) {
    super("opencode-go", baseURL, apiKeyEnv);
  }

  // Currently no special normalization; placeholder for future Go-specific quirks
  protected normalizeRequest(request: any): any {
    return super.normalizeRequest(request);
  }
}

export function createOpencodeGoProvider(baseURL: string, apiKeyEnv = "OPENCODE_GO_API_KEY") {
  return new OpencodeGoProvider(baseURL, apiKeyEnv);
}
