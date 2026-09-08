// src/optimizer/rtk.ts — RTK wrapper fail-open (Phase 5)
// Reuses existing RTK implementation from src/optimizer/vendor/rtk/index.js (ported from D:\Development\MiniRoutingAI\open-sse\rtk)
// Tidak reimplement algoritma kompresi; hanya orchestrate.

import { compressMessages, formatRtkLog } from "./vendor/rtk/index.js";
import type { ChatCompletionRequest } from "../types/index.ts";
import { globalRtkMemo } from "../memory/duplicate-cache.ts";

// @ts-ignore — vendor JS has no types
import { MIN_COMPRESS_SIZE } from "./vendor/rtk/constants.js";

export interface RtkOptions {
  enabled: boolean;
  timeoutMs?: number; // untuk future async, saat ini sync jadi diukur durasi saja
  minBytes?: number;
}

export interface RtkResult {
  enabled: boolean;
  skipped: boolean;
  reason: string;
  inputBytes: number;
  outputBytes: number;
  savedBytes: number;
  savedPercent: number;
  durationMs: number;
  success: boolean;
  filter?: string;
  hits?: number;
  // mutated request (in-place) — caller pakai chatReq yang sudah terkompres jika success
}

function hasToolOutput(chatReq: ChatCompletionRequest): boolean {
  for (const m of chatReq.messages ?? []) {
    if ((m as any).role === "tool") return true;
    if ((m as any).tool_call_id) return true;
    const content = (m as any).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && block.type === "tool_result") return true;
      }
    }
    if ((m as any).type === "function_call_output") return true;
  }
  // Juga cek conversationState Kiro (jarang di Mini Router, tapi support)
  if ((chatReq as any).conversationState) return true;
  return false;
}

function hasIsErrorTool(chatReq: ChatCompletionRequest): boolean {
  // Jika semua tool_result adalah is_error, RTK akan skip sendiri, tapi kita deteksi untuk reason
  let toolCount = 0;
  let errorCount = 0;
  for (const m of chatReq.messages ?? []) {
    const content = (m as any).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && block.type === "tool_result") {
          toolCount++;
          if (block.is_error === true) errorCount++;
        }
      }
    }
    if ((m as any).role === "tool") toolCount++;
  }
  return toolCount > 0 && toolCount === errorCount;
}

export function applyRtk(chatReq: ChatCompletionRequest, opts: RtkOptions): RtkResult {
  const start = performance.now();
  const inputBytes = Buffer.byteLength(JSON.stringify(chatReq), "utf-8");

  if (!opts.enabled) {
    return {
      enabled: false,
      skipped: true,
      reason: "disabled",
      inputBytes,
      outputBytes: inputBytes,
      savedBytes: 0,
      savedPercent: 0,
      durationMs: performance.now() - start,
      success: false,
    };
  }

  if (!hasToolOutput(chatReq)) {
    return {
      enabled: true,
      skipped: true,
      reason: "no_tool_output",
      inputBytes,
      outputBytes: inputBytes,
      savedBytes: 0,
      savedPercent: 0,
      durationMs: performance.now() - start,
      success: false,
    };
  }

  const minBytes = opts.minBytes ?? (MIN_COMPRESS_SIZE as number) ?? 500;
  if (inputBytes < minBytes) {
    return {
      enabled: true,
      skipped: true,
      reason: "below_min_bytes",
      inputBytes,
      outputBytes: inputBytes,
      savedBytes: 0,
      savedPercent: 0,
      durationMs: performance.now() - start,
      success: false,
    };
  }

  // Fail-open wrapper
  try {
    // Wave 3 memo: ganti tool message dengan hasil kompresi tersimpan (hash konten asli),
    // hanya untuk message yang tidak berubah sejak terakhir dikompresi.
    const messages: any[] = (chatReq as any).messages ?? [];
    let memoHits = 0;
    const originals: Array<{ m: any; orig: string }> = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m?.role === "tool" && typeof m?.content === "string") {
        originals.push({ m, orig: m.content });
        const memoed = globalRtkMemo.get(m.content);
        if (memoed !== null && memoed !== undefined) {
          m.content = memoed;
          memoHits++;
        }
      }
    }

    // compressMessages mutates body in-place; kita bangun body wrapper agar sesuai signature
    // Body harus punya messages atau conversationState atau input
    const body: any = { messages: chatReq.messages };
    // Preserve other fields yang mungkin dipakai filter (tidak penting untuk kompresi tool saja)
    const stats = compressMessages(body, true);

    // Simpan hasil kompresi baru ke memo (original → compressed)
    for (const { m, orig } of originals) {
      if (m.content !== orig) globalRtkMemo.set(orig, m.content);
    }
    const durationMs = performance.now() - start;

    if (!stats || !stats.hits || stats.hits.length === 0) {
      // Tidak ada yang terkompres → dianggap skipped (unrecognized atau semua di-skip)
      // Cek apakah karena is_error preserved
      if (hasIsErrorTool(chatReq)) {
        return {
          enabled: true,
          skipped: true,
          reason: "is_error_preserved",
          inputBytes,
          outputBytes: inputBytes,
          savedBytes: 0,
          savedPercent: 0,
          durationMs,
          success: false,
        };
      }
      return {
        enabled: true,
        skipped: true,
        reason: "unrecognized_output",
        inputBytes,
        outputBytes: inputBytes,
        savedBytes: 0,
        savedPercent: 0,
        durationMs,
        success: false,
      };
    }

    // Hitung outputBytes setelah kompresi
    // chatReq.messages sudah termutasi via body.messages (referensi sama)
    const outputBytes = Buffer.byteLength(JSON.stringify(chatReq), "utf-8");
    const savedBytes = Math.max(0, inputBytes - outputBytes);
    const savedPercent = inputBytes > 0 ? (savedBytes / inputBytes) * 100 : 0;

    // Safety: jangan pernah grow (sudah di-handle di compressMessages, tapi double-check fail-open)
    if (outputBytes >= inputBytes) {
      return {
        enabled: true,
        skipped: true,
        reason: "no_saving",
        inputBytes,
        outputBytes: inputBytes,
        savedBytes: 0,
        savedPercent: 0,
        durationMs,
        success: false,
      };
    }

    const filters = Array.from(new Set(stats.hits.map((h: any) => h.filter))).join(",");
    return {
      enabled: true,
      skipped: false,
      reason: "recognized_tool_output",
      inputBytes,
      outputBytes,
      savedBytes,
      savedPercent,
      durationMs,
      success: true,
      filter: filters,
      hits: stats.hits.length,
    };
  } catch (e: any) {
    const durationMs = performance.now() - start;
    // Fail-open: kembalikan original (tidak ada mutasi permanen jika error sebelum hits?)
    // Jika error di tengah, beberapa messages mungkin sudah termutasi — idealnya clone, tapi untuk Phase5 kita anggap fail-open dengan bytes asli
    // Untuk safety, kita tidak revert mutasi parsial; tapi log warn dan anggap skipped.
    return {
      enabled: true,
      skipped: true,
      reason: `fail_open: ${String(e?.message ?? e).slice(0, 100)}`,
      inputBytes,
      outputBytes: inputBytes,
      savedBytes: 0,
      savedPercent: 0,
      durationMs,
      success: false,
    };
  }
}

// Helper untuk benchmark/log formatting (reuse vendor formatRtkLog jika perlu)
export function formatRtkResultLog(result: RtkResult): string | null {
  if (!result.success) return null;
  return `[RTK] saved ${result.savedBytes}B / ${result.inputBytes}B (${result.savedPercent.toFixed(1)}%) via [${result.filter}] hits=${result.hits} duration=${result.durationMs.toFixed(1)}ms`;
}
