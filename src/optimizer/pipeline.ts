// src/optimizer/pipeline.ts — Optimizer pipeline Phase 5 (extensible untuk Phase 6+)
// Saat ini hanya RTK, tapi struktur pipeline memungkinkan tambah Headroom/Caveman nanti tanpa ubah server.ts.

import { applyRtk, type RtkOptions, type RtkResult } from "./rtk.ts";
import { applyHeadroom, type HeadroomOptions, type HeadroomResult } from "./headroom.ts";
import { applyCaveman, type CavemanResult } from "./caveman.ts";
import { applyPonytail, type PonytailResult } from "./ponytail.ts";
import type { ChatCompletionRequest } from "../types/index.ts";
import type { RequestProfile } from "../router/profile.ts";

export interface OptimizerConfig {
  rtk?: boolean | { enabled: boolean; minBytes?: number; timeoutMs?: number; failOpen?: boolean };
  headroom?: boolean | { enabled: boolean; minimumTokens?: number; minimumBytes?: number; timeoutMs?: number; failOpen?: boolean; url?: string; maxConsecutiveFailures?: number; cooldownMs?: number; healthProbeMs?: number; compressUserMessages?: boolean; cacheTtlMs?: number };
  caveman?: boolean | string | { enabled: boolean; mode?: string };
  ponytail?: boolean | string | { enabled: boolean; mode?: string };
}

export interface PipelineResult {
  request: ChatCompletionRequest;
  rtk: RtkResult | null;
  headroom: HeadroomResult | null;
  caveman: CavemanResult | null;
  ponytail: PonytailResult | null;
}

function resolveRtkOptions(cfg?: OptimizerConfig): RtkOptions {
  if (!cfg) return { enabled: false };
  const rtk = cfg.rtk;
  if (rtk === undefined || rtk === false) return { enabled: false };
  if (rtk === true) return { enabled: true };
  return {
    enabled: (rtk as any).enabled ?? false,
    timeoutMs: (rtk as any).timeoutMs ?? 500,
    minBytes: (rtk as any).minBytes ?? undefined,
  };
}

function resolveHeadroomOptions(cfg?: OptimizerConfig): HeadroomOptions {
  if (!cfg) return { enabled: false };
  const h = cfg.headroom;
  if (h === undefined || h === false) return { enabled: false };
  if (h === true) return { enabled: true, url: process.env.HEADROOM_URL ?? (Bun.env as any).HEADROOM_URL };
  return {
    enabled: (h as any).enabled ?? false,
    minimumTokens: (h as any).minimumTokens ?? 6000,
    minimumBytes: (h as any).minimumBytes ?? 8000,
    timeoutMs: (h as any).timeoutMs ?? 6000,
    url: (h as any).url ?? process.env.HEADROOM_URL ?? (Bun.env as any).HEADROOM_URL,
    failOpen: (h as any).failOpen ?? true,
    maxConsecutiveFailures: (h as any).maxConsecutiveFailures ?? 3,
    cooldownMs: (h as any).cooldownMs ?? 30_000,
    healthProbeMs: (h as any).healthProbeMs ?? 500,
    compressUserMessages: (h as any).compressUserMessages ?? false,
    cacheTtlMs: (h as any).cacheTtlMs ?? 10_000,
  };
}

function resolveCavemanMode(cfg?: OptimizerConfig): string {
  if (!cfg) return "off";
  const c = cfg.caveman;
  if (c === undefined || c === false) return "off";
  if (c === true) return "lite";
  if (typeof c === "string") return c;
  if (typeof c === "object") {
    if ((c as any).enabled === false) return "off";
    return (c as any).mode ?? "lite";
  }
  return "off";
}

function resolvePonytailMode(cfg?: OptimizerConfig): string {
  if (!cfg) return "off";
  const p = cfg.ponytail;
  if (p === undefined || p === false) return "off";
  if (p === true) return "lite";
  if (typeof p === "string") return p;
  if (typeof p === "object") {
    if ((p as any).enabled === false) return "off";
    return (p as any).mode ?? "lite";
  }
  return "off";
}

export function runOptimizers(
  chatReq: ChatCompletionRequest,
  optimizerCfg?: OptimizerConfig,
): PipelineResult {
  const rtkOpts = resolveRtkOptions(optimizerCfg);
  const rtkResult = applyRtk(chatReq, rtkOpts);
  const cavemanMode = resolveCavemanMode(optimizerCfg);
  const cavemanResult = applyCaveman(chatReq, cavemanMode);
  const ponytailMode = resolvePonytailMode(optimizerCfg);
  const ponytailResult = applyPonytail(chatReq, ponytailMode);
  return {
    request: chatReq,
    rtk: rtkResult,
    headroom: null, // async
    caveman: cavemanResult,
    ponytail: ponytailResult,
  };
}

export async function runOptimizersAsync(
  chatReq: ChatCompletionRequest,
  profile: RequestProfile,
  optimizerCfg?: OptimizerConfig,
): Promise<PipelineResult> {
  const rtkOpts = resolveRtkOptions(optimizerCfg);
  const rtkResult = applyRtk(chatReq, rtkOpts);
  const headroomOpts = resolveHeadroomOptions(optimizerCfg);
  const headroomResult = await applyHeadroom(chatReq, profile, headroomOpts);
  const cavemanMode = resolveCavemanMode(optimizerCfg);
  const cavemanResult = applyCaveman(chatReq, cavemanMode);
  const ponytailMode = resolvePonytailMode(optimizerCfg);
  const ponytailResult = applyPonytail(chatReq, ponytailMode);
  return {
    request: chatReq,
    rtk: rtkResult,
    headroom: headroomResult,
    caveman: cavemanResult,
    ponytail: ponytailResult,
  };
}
