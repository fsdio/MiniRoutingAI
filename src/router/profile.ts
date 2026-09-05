// src/router/profile.ts — Request Analyzer Phase 4
import type { ChatCompletionRequest } from "../types/index.ts";

export interface RequestProfile {
  estimatedTokens: number;
  bodyBytes: number;
  messageBytes: number;
  toolBytes: number;
  toolHistoryBytes: number;
  messageCount: number;
  toolCount: number;
  toolResultCount: number;
  hasTools: boolean;
  hasToolResults: boolean;
}

export function analyzeRequest(request: ChatCompletionRequest, rawBodyBytes?: number): RequestProfile {
  const bodyString = JSON.stringify(request);
  const bodyBytes = rawBodyBytes ?? Buffer.byteLength(bodyString, "utf-8");

  let messageBytes = 0;
  let toolBytes = 0;
  let toolHistoryBytes = 0;
  let toolResultCount = 0;

  for (const m of request.messages ?? []) {
    const msgStr = JSON.stringify(m);
    const bytes = Buffer.byteLength(msgStr, "utf-8");
    // Heuristic: tool messages contain tool results
    if ((m as any).role === "tool" || (m as any).tool_call_id) {
      toolHistoryBytes += bytes;
      toolResultCount++;
    }
    messageBytes += bytes;
  }

  if (request.tools) {
    const toolsStr = JSON.stringify(request.tools);
    toolBytes = Buffer.byteLength(toolsStr, "utf-8");
  }

  // Also count tool_calls in assistant messages as tool history
  for (const m of request.messages ?? []) {
    if ((m as any).tool_calls) {
      const tcStr = JSON.stringify((m as any).tool_calls);
      toolHistoryBytes += Buffer.byteLength(tcStr, "utf-8");
    }
  }

  const toolCount = Array.isArray(request.tools) ? request.tools.length : 0;
  const messageCount = request.messages?.length ?? 0;
  const hasTools = toolCount > 0;
  const hasToolResults = toolResultCount > 0;

  // Estimated tokens: ~ bytes / 4 (common heuristic), ceil
  const estimatedTokens = Math.ceil(bodyBytes / 4);

  return {
    estimatedTokens,
    bodyBytes,
    messageBytes,
    toolBytes,
    toolHistoryBytes,
    messageCount,
    toolCount,
    toolResultCount,
    hasTools,
    hasToolResults,
  };
}
