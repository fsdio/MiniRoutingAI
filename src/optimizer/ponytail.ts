// src/optimizer/ponytail.ts — Ponytail YAGNI prompt steering Phase 8 (no LLM call)

import { PONYTAIL_PROMPTS } from "./vendor/rtk/ponytailPrompt.js";

export type PonytailMode = "off" | "lite" | "full" | "ultra";
const VALID = new Set(["off", "lite", "full", "ultra"]);

function getPrompt(mode: string): string | null {
  if (!mode || mode === "off") return null;
  const m = mode.toLowerCase();
  if (!VALID.has(m)) return null;
  if (m === "lite") return PONYTAIL_PROMPTS["lite"];
  if (m === "full") return PONYTAIL_PROMPTS["full"];
  if (m === "ultra") return PONYTAIL_PROMPTS["ultra"];
  return null;
}
const SEP = "\n\n";
function hasPrompt(h: string, p: string): boolean {
  if (!h) return false;
  if (h === p) return true;
  return h.split(SEP).includes(p);
}
export interface PonytailResult {
  enabled: boolean;
  skipped: boolean;
  reason: string;
  mode: string;
  injectedBytes: number;
}
export function applyPonytail(chatReq: any, mode: string | boolean): PonytailResult {
  const modeStr = typeof mode === "boolean" ? (mode ? "lite" : "off") : (mode as string) ?? "off";
  const prompt = getPrompt(modeStr);
  if (!prompt) return { enabled: false, skipped: true, reason: modeStr === "off" ? "disabled" : "invalid_mode", mode: modeStr, injectedBytes: 0 };
  try {
    const messages = chatReq.messages;
    if (!Array.isArray(messages)) return { enabled: true, skipped: true, reason: "no_messages", mode: modeStr, injectedBytes: 0 };
    for (const m of messages) {
      if (m.role === "system" || m.role === "developer") {
        const c = typeof m.content === "string" ? m.content : "";
        if (hasPrompt(c, prompt)) return { enabled: true, skipped: true, reason: "already_injected", mode: modeStr, injectedBytes: 0 };
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
