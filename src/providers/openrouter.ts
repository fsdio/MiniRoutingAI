// src/providers/openrouter.ts — OpenRouter adapter dengan provider pinning
import { OpenAICompatibleAdapter } from "./provider.ts";

// Mapping model → provider fisik OpenRouter (sesuai curl acuan)
// deepseek/deepseek-v4-flash-0731 → open-inference/fp8
// z-ai/glm-5.3-flash → relace/fp4
export const OPENROUTER_MODEL_PROVIDER_MAP: Record<string, string[]> = {
  "deepseek/deepseek-v4-flash-0731": ["open-inference/fp8"],
  "z-ai/glm-5.3-flash": ["relace/fp4"],
};

export function getPinnedProviderOrder(model: string): string[] | undefined {
  if (!model) return undefined;
  // exact match dulu
  if (OPENROUTER_MODEL_PROVIDER_MAP[model]) return OPENROUTER_MODEL_PROVIDER_MAP[model];
  // handle suffix :free atau varian lain — cek base sebelum colon
  const base = model.split(":")[0];
  if (OPENROUTER_MODEL_PROVIDER_MAP[base]) return OPENROUTER_MODEL_PROVIDER_MAP[base];
  return undefined;
}

export class OpenRouterProvider extends OpenAICompatibleAdapter {
  constructor(baseURL: string, apiKeyEnv?: string) {
    super("openrouter", baseURL, apiKeyEnv, {
      "HTTP-Referer": "http://localhost:3000",
      "X-Title": "MiniRoutingAI",
    });
  }

  protected normalizeRequest(request: import("../types/index.ts").ChatCompletionRequest): import("../types/index.ts").ChatCompletionRequest {
    const normalized = super.normalizeRequest(request) as Record<string, any>;
    // Jika router sudah injeksi via __providerOrder / providers, hormati itu (prioritas declarative dari routes.json)
    const forwardedOrder: string[] | undefined = (request as any).__providerOrder as string[] | undefined;
    const targetProviders: string[] | undefined = (request as any).__openrouterProviders as string[] | undefined;
    let order: string[] | undefined = forwardedOrder ?? targetProviders;

    // Fallback ke hardcoded map bila tidak ada declarative order
    if (!order) {
      order = getPinnedProviderOrder(normalized.model ?? (request as any).model);
    }

    if (order && order.length > 0) {
      const existing = normalized.provider as Record<string, any> | undefined;
      normalized.provider = {
        ...(existing ?? {}),
        order,
        // Jangan set allow_fallbacks:false — jika model down, router akan fallback ke model lain (sesuai instruksi user)
      };
    }

    // Reasoning: untuk dua model tersebut, pastikan enabled:true (merge, jangan override paksa)
    const needsReasoning = !!getPinnedProviderOrder(normalized.model ?? (request as any).model) || !!order;
    // Juga jika declarative reasoning ada di request
    const declarativeReasoning = (request as any).__reasoning as Record<string, any> | undefined;
    if (declarativeReasoning) {
      normalized.reasoning = { ...(normalized.reasoning ?? {}), ...declarativeReasoning };
    } else if (needsReasoning) {
      const existingReasoning = normalized.reasoning as Record<string, any> | undefined;
      if (!existingReasoning) {
        normalized.reasoning = { enabled: true };
      } else if (existingReasoning.enabled === undefined) {
        normalized.reasoning = { ...existingReasoning, enabled: true };
      }
      // jika sudah ada enabled (true/false) dari client, hormati nilai client (tidak override)
    }

    // Bersihkan internal fields agar tidak terkirim ke upstream sebagai param tak dikenal
    if ((normalized as any).__providerOrder) delete (normalized as any).__providerOrder;
    if ((normalized as any).__openrouterProviders) delete (normalized as any).__openrouterProviders;
    if ((normalized as any).__reasoning) delete (normalized as any).__reasoning;

    return normalized as import("../types/index.ts").ChatCompletionRequest;
  }
}

export function createOpenRouterProvider(baseURL: string, apiKeyEnv = "OPENROUTER_API_KEY") {
  return new OpenRouterProvider(baseURL, apiKeyEnv);
}
