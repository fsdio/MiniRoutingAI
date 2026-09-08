// src/telemetry/accounting.ts — Token accounting & cost per request (Wave 0)
// Bedakan tiga angka: estimatedTokens (bytes/4 pre-optimizer), compressedTokens (bytes/4 yang
// benar-benar dikirim upstream), actualBillableTokens (usage dari provider). Jangan dicampur.

export interface OptimizerSavings {
  rtkSavedBytes: number;
  headroomSavedBytes: number;
  cavemanInjectedBytes: number;
  ponytailInjectedBytes: number;
}

export interface ProviderUsage {
  prompt_tokens?: number | string | null;
  completion_tokens?: number | string | null;
  total_tokens?: number | string | null;
  cached_tokens?: number | string | null;
  [key: string]: unknown;
}

export interface Accounting {
  // Token pipeline (estimasi bytes/4, konsisten dengan profile.ts)
  originalInputTokens: number; // SEBELUM optimizer
  rtkSavedTokens: number;
  headroomSavedTokens: number;
  cavemanInjectedTokens: number; // positif = penambahan context
  ponytailInjectedTokens: number;
  finalUpstreamInputTokens: number; // SETELAH optimizer (payload aktual ke provider)

  // Actual usage dari provider (source of truth billable)
  actualPromptTokens: number | null;
  actualOutputTokens: number | null;
  actualTotalTokens: number | null;
  cachedInputTokens: number | null;

  // Fallback
  fallbackAttempts: number;
  fallbackTokens: number; // estimasi input tokens terbakar di attempt yang gagal setelah sampai upstream
  finalSuccessTokens: number | null; // actualTotalTokens attempt sukses
  fallbackByClass: Record<string, number> | null; // Wave 6: breakdown per errorClass

  // Derived metrics
  compressionRatio: number; // original / final (1.0 = tanpa kompresi)
  actualTokenReduction: number | null; // (estimatedFinal - actualPrompt) / estimatedFinal, null jika usage tidak ada
  fallbackTax: number; // fallbackTokens / (fallbackTokens + finalUpstreamInputTokens), 0 jika tanpa fallback
  cacheableTokens: number | null; // Wave 2: estimasi prefix stabil vs request sebelumnya (kandidat prompt cache)

  // Cost (USD)
  estimatedCost: number | null; // dari finalUpstreamInputTokens × tarif
  actualCost: number | null; // dari actual usage × tarif
}

export interface PriceEntry {
  inputPerMillion?: number;
  outputPerMillion?: number;
  cachedInputPerMillion?: number;
}

export type PriceTable = Record<string, PriceEntry>;

const DIVISOR = 4; // bytes/4; dikalibrasi ulang di Wave 5 dari data actual

export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function createAccounting(originalEstimatedTokens: number): Accounting {
  return {
    originalInputTokens: originalEstimatedTokens,
    rtkSavedTokens: 0,
    headroomSavedTokens: 0,
    cavemanInjectedTokens: 0,
    ponytailInjectedTokens: 0,
    finalUpstreamInputTokens: originalEstimatedTokens,
    actualPromptTokens: null,
    actualOutputTokens: null,
    actualTotalTokens: null,
    cachedInputTokens: null,
    fallbackAttempts: 0,
    fallbackTokens: 0,
    finalSuccessTokens: null,
    fallbackByClass: null,
    compressionRatio: 1,
    actualTokenReduction: null,
    fallbackTax: 0,
    cacheableTokens: null,
    estimatedCost: null,
    actualCost: null,
  } as Accounting;
}

export function applyOptimizerSavings(acc: Accounting, s: OptimizerSavings, finalEstimatedTokens: number): void {
  acc.rtkSavedTokens = Math.ceil(s.rtkSavedBytes / DIVISOR);
  acc.headroomSavedTokens = Math.ceil(s.headroomSavedBytes / DIVISOR);
  acc.cavemanInjectedTokens = Math.ceil(s.cavemanInjectedBytes / DIVISOR);
  acc.ponytailInjectedTokens = Math.ceil(s.ponytailInjectedBytes / DIVISOR);
  acc.finalUpstreamInputTokens = finalEstimatedTokens;
  acc.compressionRatio = acc.finalUpstreamInputTokens > 0
    ? Number((acc.originalInputTokens / acc.finalUpstreamInputTokens).toFixed(3))
    : 1;
}

export function recordFallbackAttempt(acc: Accounting, estimatedInputTokens: number, errorClass?: string): void {
  acc.fallbackAttempts += 1;
  acc.fallbackTokens += estimatedInputTokens;
  acc.fallbackTax = acc.fallbackTokens + acc.finalUpstreamInputTokens > 0
    ? Number((acc.fallbackTokens / (acc.fallbackTokens + acc.finalUpstreamInputTokens)).toFixed(4))
    : 0;
  if (errorClass) {
    acc.fallbackByClass = acc.fallbackByClass ?? {};
    acc.fallbackByClass[errorClass] = (acc.fallbackByClass[errorClass] ?? 0) + 1;
  }
}

export function applyActualUsage(acc: Accounting, usage: ProviderUsage | null | undefined, prices: PriceTable, provider?: string, model?: string): void {
  const prompt = num(usage?.prompt_tokens);
  const completion = num(usage?.completion_tokens) ?? num(usage?.output_tokens);
  const total = num(usage?.total_tokens) ?? (prompt !== null && completion !== null ? prompt + completion : null);
  const cached = num(usage?.cached_tokens) ?? num(usage?.cached_input_tokens) ?? num(usage?.prompt_cache_hit_tokens);

  acc.actualPromptTokens = prompt;
  acc.actualOutputTokens = completion;
  acc.actualTotalTokens = total;
  acc.cachedInputTokens = cached;
  acc.finalSuccessTokens = total;

  const price = lookupPrice(prices, provider, model);
  if (!price) return;
  if (prompt !== null || completion !== null) {
    const cachedTok = cached ?? 0;
    const uncached = (prompt ?? 0) - cachedTok;
    let cost = 0;
    if (uncached > 0) cost += (uncached * (price.inputPerMillion ?? 0)) / 1_000_000;
    if (cachedTok > 0) cost += (cachedTok * (price.cachedInputPerMillion ?? price.inputPerMillion ?? 0)) / 1_000_000;
    if (completion !== null) cost += (completion * (price.outputPerMillion ?? 0)) / 1_000_000;
    acc.actualCost = Number(cost.toFixed(6));
    acc.estimatedCost = Number((((acc.finalUpstreamInputTokens * (price.inputPerMillion ?? 0)) / 1_000_000) + (((acc.actualOutputTokens ?? 0) * (price.outputPerMillion ?? 0)) / 1_000_000)).toFixed(6));
  }
}

export function lookupPrice(prices: PriceTable, provider?: string, model?: string): PriceEntry | null {
  if (!provider) return null;
  const exact = model ? prices[`${provider}:${model}`] : undefined;
  if (exact) return exact;
  const byProvider = prices[provider];
  if (byProvider) return byProvider;
  return null;
}

export function finalizeAccounting(acc: Accounting): Accounting {
  // actualTokenReduction: seberapa jauh payload terkirim (estimasi) vs actual yang ditagih provider
  // (menangkap efek provider-side caching/dedup). null jika actual usage tidak tersedia.
  if (acc.actualPromptTokens !== null && acc.finalUpstreamInputTokens > 0) {
    acc.actualTokenReduction = Number(Math.max(0, (acc.finalUpstreamInputTokens - acc.actualPromptTokens) / acc.finalUpstreamInputTokens).toFixed(4));
  }
  return acc;
}

export function accountToLogFields(acc: Accounting): Record<string, unknown> {
  return {
    tokens: {
      originalInput: acc.originalInputTokens,
      rtkSaved: acc.rtkSavedTokens,
      headroomSaved: acc.headroomSavedTokens,
      cavemanInjected: acc.cavemanInjectedTokens,
      ponytailInjected: acc.ponytailInjectedTokens,
      finalUpstreamInput: acc.finalUpstreamInputTokens,
      actualPrompt: acc.actualPromptTokens,
      actualOutput: acc.actualOutputTokens,
      actualTotal: acc.actualTotalTokens,
      cachedInput: acc.cachedInputTokens,
    },
    fallback: { attempts: acc.fallbackAttempts, tokens: acc.fallbackTokens, tax: acc.fallbackTax, byClass: acc.fallbackByClass ?? undefined },
    cost: { estimated: acc.estimatedCost, actual: acc.actualCost },
    compressionRatio: acc.compressionRatio,
    actualTokenReduction: acc.actualTokenReduction,
    cacheableTokens: acc.cacheableTokens,
  };
}
