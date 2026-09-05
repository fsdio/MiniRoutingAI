// src/translator/registry.ts — extensible translator registry (pola MiniRoutingAI open-sse/translator)
// Saat ini hanya OpenAI yang terdaftar. Tambah Claude/Gemini = register + import di index.

export type RequestTranslator = (req: Record<string, any>, opts: { stream?: boolean }) => Record<string, any>;
export type StreamChunkNormalizer = (chunk: any) => any;

const requestTranslators = new Map<string, RequestTranslator>();
const streamChunkNormalizers = new Map<string, StreamChunkNormalizer>();

const identityRequest: RequestTranslator = (req) => req;
const identityChunk: StreamChunkNormalizer = (chunk) => chunk;

export function registerRequestTranslator(providerId: string, fn: RequestTranslator): void {
  requestTranslators.set(providerId, fn);
}

export function registerStreamChunkNormalizer(providerId: string, fn: StreamChunkNormalizer): void {
  streamChunkNormalizers.set(providerId, fn);
}

export function getRequestTranslator(providerId?: string): RequestTranslator {
  if (providerId && requestTranslators.has(providerId)) return requestTranslators.get(providerId)!;
  return identityRequest;
}

export function getStreamChunkNormalizer(providerId?: string): StreamChunkNormalizer {
  if (providerId && streamChunkNormalizers.has(providerId)) return streamChunkNormalizers.get(providerId)!;
  return identityChunk;
}
