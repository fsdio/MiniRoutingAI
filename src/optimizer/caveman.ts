// src/optimizer/caveman.ts — Caveman prompt steering Phase 7 (no LLM call)
// Reuse vendor prompts, simple OpenAI messages injection (fail-open)

import { CAVEMAN_PROMPTS } from "./vendor/rtk/cavemanPrompts.js";

export type CavemanMode = "off" | "lite" | "full" | "ultra";
const VALID_MODES = new Set(["off", "lite", "full", "ultra"]);

function getPrompt(mode: string): string | null {
  if (!mode || mode === "off") return null;
  const m = mode.toLowerCase();
  if (!VALID_MODES.has(m)) return null;
  // Map lite/full/ultra to vendor prompts
  if (m === "lite") return CAVEMAN_PROMPTS["lite"];
  if (m === "full") return CAVEMAN_PROMPTS["full"];
  if (m === "ultra") return CAVEMAN_PROMPTS["ultra"];
  return null;
}

const SEP = "\n\n";

function hasPrompt(haystack: string, prompt: string): boolean {
  if (!haystack) return false;
  if (haystack === prompt) return true;
  return haystack.split(SEP).includes(prompt);
}

export interface CavemanResult {
  enabled: boolean;
  skipped: boolean;
  reason: string;
  mode: string;
  injectedBytes: number;
}

export function applyCaveman(chatReq: any, mode: string | boolean): CavemanResult {
  const modeStr = typeof mode === "boolean" ? (mode ? "lite" : "off") : (mode as string) ?? "off";
  const prompt = getPrompt(modeStr);
  if (!prompt) {
    return { enabled: false, skipped: true, reason: modeStr === "off" ? "disabled" : "invalid_mode", mode: modeStr, injectedBytes: 0 };
  }
  try {
    const messages = chatReq.messages;
    if (!Array.isArray(messages)) return { enabled: true, skipped: true, reason: "no_messages", mode: modeStr, injectedBytes: 0 };
    // Check duplicate
    for (const m of messages) {
      if (m.role === "system" || m.role === "developer") {
        const content = typeof m.content === "string" ? m.content : "";
        if (hasPrompt(content, prompt)) {
          return { enabled: true, skipped: true, reason: "already_injected", mode: modeStr, injectedBytes: 0 };
        }
      }
    }
    const idx = messages.findIndex((m: any) => m && (m.role === "system" || m.role === "developer"));
    const bytes = Buffer.byteLength(prompt, "utf-8");
    if (idx >= 0) {
      const msg = messages[idx];
      const curr = typeof msg.content === "string" ? msg.content : "";
      msg.content = curr ? `${curr}${SEP}${prompt}` : prompt;
    } else {
      messages.unshift({ role: "system", content: prompt });
    }
    return { enabled: true, skipped: false, reason: "injected", mode: modeStr, injectedBytes: bytes };
  } catch (e: any) {
    return { enabled: true, skipped: true, reason: `fail_open: ${String(e?.message ?? e).slice(0,100)}`, mode: modeStr, injectedBytes: 0 };
  }
}
