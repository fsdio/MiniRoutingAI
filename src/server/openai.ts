// src/server/openai.ts — validasi & handler POST /v1/chat/completions Phase 1
import { jsonErrorResponse } from "./errors.ts";
import type { ChatCompletionRequest } from "../types/index.ts";

export interface ValidationResult {
  valid: boolean;
  error?: Response;
  request?: ChatCompletionRequest;
}

export function validateChatRequest(body: unknown): ValidationResult {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return {
      valid: false,
      error: jsonErrorResponse("Invalid request body: expected JSON object", 400),
    };
  }

  const obj = body as Record<string, unknown>;

  if (typeof obj.model !== "string" || obj.model.trim() === "") {
    return {
      valid: false,
      error: jsonErrorResponse("Missing or invalid 'model' field", 400, "invalid_request_error", "invalid_model"),
    };
  }

  if (!Array.isArray(obj.messages) || obj.messages.length === 0) {
    return {
      valid: false,
      error: jsonErrorResponse(
        "Missing or invalid 'messages' field: expected non-empty array",
        400,
        "invalid_request_error",
        "invalid_messages",
      ),
    };
  }

  for (let i = 0; i < obj.messages.length; i++) {
    const m = (obj.messages as unknown[])[i];
    if (m === null || typeof m !== "object" || Array.isArray(m)) {
      return {
        valid: false,
        error: jsonErrorResponse(`Invalid message at index ${i}: expected object`, 400),
      };
    }
    const msg = m as Record<string, unknown>;
    if (typeof msg.role !== "string" || typeof msg.content === "undefined") {
      return {
        valid: false,
        error: jsonErrorResponse(`Invalid message at index ${i}: missing role or content`, 400),
      };
    }
  }

  if (obj.stream !== undefined && typeof obj.stream !== "boolean") {
    return {
      valid: false,
      error: jsonErrorResponse("'stream' must be a boolean if provided", 400),
    };
  }

  return { valid: true, request: obj as unknown as ChatCompletionRequest };
}

export function isStreamingRequest(body: ChatCompletionRequest): boolean {
  return body.stream === true;
}
