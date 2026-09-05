// src/telemetry/timing.ts — Phase 4 extended timing points
import type { Timing } from "../types/index.ts";

export function createTiming(): Timing {
  return {
    requestReceivedAt: performance.now(),
  };
}

export function computeMetrics(timing: Timing) {
  const totalLatency =
    timing.responseFinishedAt !== undefined
      ? timing.responseFinishedAt - timing.requestReceivedAt
      : undefined;

  const providerLatency =
    timing.providerRequestSentAt !== undefined &&
    timing.providerFinishedAt !== undefined
      ? timing.providerFinishedAt - timing.providerRequestSentAt
      : undefined;

  // Generation latency when available (providerFinished - providerFirstByte)
  const generationLatency =
    timing.providerFirstByteAt !== undefined &&
    timing.providerFinishedAt !== undefined
      ? timing.providerFinishedAt - timing.providerFirstByteAt
      : undefined;

  const ttft =
    timing.providerFirstByteAt !== undefined
      ? timing.providerFirstByteAt - timing.requestReceivedAt
      : timing.clientFirstChunkAt !== undefined
        ? timing.clientFirstChunkAt - timing.requestReceivedAt
        : undefined;

  let gatewayOverhead: number | undefined = undefined;
  if (totalLatency !== undefined) {
    if (providerLatency !== undefined) {
      gatewayOverhead = totalLatency - providerLatency;
      if (gatewayOverhead < 0) gatewayOverhead = 0;
    } else {
      gatewayOverhead = totalLatency;
    }
  }

  const normalizationMs =
    timing.normalizationDoneAt !== undefined
      ? timing.normalizationDoneAt - timing.requestReceivedAt
      : undefined;
  const profilingMs =
    timing.routingDoneAt !== undefined && timing.normalizationDoneAt !== undefined
      ? timing.routingDoneAt - timing.normalizationDoneAt
      : undefined;
  const routingMs =
    timing.providerRequestSentAt !== undefined && timing.routingDoneAt !== undefined
      ? timing.providerRequestSentAt - timing.routingDoneAt
      : undefined;

  return {
    totalLatency,
    providerLatency,
    generationLatency,
    ttft,
    gatewayOverhead,
    normalizationMs,
    profilingMs,
    routingMs,
  };
}

export function nowMs(): number {
  return performance.now();
}
