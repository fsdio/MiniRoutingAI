// src/types/index.ts — shared types Phase 1

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | unknown;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
  [key: string]: unknown;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  [key: string]: unknown;
}

export interface ChatChoice {
  index: number;
  message?: ChatMessage;
  delta?: Partial<ChatMessage> & { content?: string | null };
  finish_reason?: string | null;
}

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  [key: string]: unknown;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatChoice[];
  usage?: ChatUsage;
  [key: string]: unknown;
}

export interface ChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: Partial<ChatMessage> & { content?: string | null };
    finish_reason?: string | null;
  }>;
  [key: string]: unknown;
}

export interface HealthResponse {
  status: "ok" | "degraded" | "down";
  uptime: number;
  version: string;
  timestamp: string;
}

export interface ProviderConfig {
  id: string;
  baseURL: string;
  apiKeyEnv?: string;
  models?: string[];
  defaultWeight?: number;
  tags?: string[];
  avgLatencyMs?: number;
  // Capability flags (R5 anti-regresi): butuh x-opencode-session dari client agar tidak 400
  requiresSession?: boolean;
}

export interface ProvidersFile {
  providers: ProviderConfig[];
}

export interface RouteTarget {
  provider: string;
  model: string;
  weight?: number;
  tags?: string[];
}

export interface OptimizerRouteConfig {
  rtk?: boolean;
  headroom?: boolean | { enabled: boolean; minimumTokens?: number; minimumBytes?: number; timeoutMs?: number; url?: string; maxConsecutiveFailures?: number; cooldownMs?: number; healthProbeMs?: number; failOpen?: boolean; compressUserMessages?: boolean; cacheTtlMs?: number };
  caveman?: boolean | string;
  ponytail?: boolean | string;
}

export interface RouteConfig {
  strategy: "fallback" | "round-robin" | "weighted-round-robin" | "cache-aware-sticky";
  primary?: RouteTarget;
  fallbacks?: RouteTarget[];
  models?: RouteTarget[];
  timeoutMs?: number;
  retry?: { maxRetries: number; backoffMs: number };
  optimizers?: OptimizerRouteConfig;
  healthAwareOrdering?: boolean;
  minHealthyCandidates?: number;
  modelHints?: string[];
  warmThresholdRequests?: number;
  sameProviderFallback?: boolean;
}

export interface RoutesFile {
  routes: Record<string, RouteConfig>;
  defaultRoute: string;
}

export interface Timing {
  requestReceivedAt: number;
  normalizationDoneAt?: number;
  routingDoneAt?: number;
  providerRequestSentAt?: number;
  providerFirstByteAt?: number;
  providerFinishedAt?: number;
  clientFirstChunkAt?: number;
  responseFinishedAt?: number;
}
