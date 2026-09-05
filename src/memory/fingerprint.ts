// src/memory/fingerprint.ts — SHA-256 fingerprint for Error Memory (Phase 9)
import { createHash } from "crypto";

export interface FingerprintInput {
  provider: string;
  model: string;
  operation?: string; // chat
  toolName?: string;
  errorCategory: string;
  errorSignature: string; // normalized error message
  requestCharacteristics?: string; // e.g., hasTools, messageCount bucket
}

export function fingerprint(input: FingerprintInput): string {
  const normalized = {
    provider: input.provider,
    model: input.model,
    operation: input.operation ?? "chat",
    toolName: input.toolName ?? "",
    errorCategory: input.errorCategory,
    errorSignature: input.errorSignature.trim().slice(0, 500), // cap
    requestCharacteristics: input.requestCharacteristics ?? "",
  };
  const json = JSON.stringify(normalized);
  return createHash("sha256").update(json).digest("hex");
}
