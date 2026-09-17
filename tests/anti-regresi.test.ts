// tests/anti-regresi.test.ts — R1/R2/R3/R4/R6: deteksi drift config & regresi perilaku baru
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { stripJsonCommentsAndTrailingComma } from "../src/index.ts";
import { HEADROOM_DEFAULTS, applyHeadroom, resetHeadroomHealth, getHeadroomHealth, clearHeadroomCache } from "../src/optimizer/headroom.ts";
import type { RequestProfile } from "../src/router/profile.ts";

function mockProfile(estimatedTokens = 15000, bodyBytes = 20000, toolHistoryBytes = 0, messageCount = 2): RequestProfile {
  return {
    estimatedTokens, bodyBytes, messageBytes: bodyBytes - 200, toolBytes: 0, toolHistoryBytes,
    messageCount, toolCount: 0, toolResultCount: 0, hasTools: false, hasToolResults: false,
  };
}

describe("Anti-regresi — stripJsonCommentsAndTrailingComma (R2)", () => {
  test("trailing comma dihapus", () => {
    const cleaned = stripJsonCommentsAndTrailingComma('{"a":1,  }');
    expect(JSON.parse(cleaned)).toEqual({ a: 1 });
  });
  test("koma di dalam string value TIDAK dihapus (data-safe)", () => {
    const src = '{"content":"hasil tool, } koma","list":[1,2],}';
    const cleaned = stripJsonCommentsAndTrailingComma(src);
    const parsed = JSON.parse(cleaned);
    expect(parsed.content).toBe("hasil tool, } koma"); // string utuh
    expect(parsed.list).toEqual([1, 2]); // trailing comma array terhapus
  });
  test("// dalam URL string tidak dihapus", () => {
    const src = '{"url":"https://example.com//path"}';
    const cleaned = stripJsonCommentsAndTrailingComma(src);
    expect(JSON.parse(cleaned).url).toBe("https://example.com//path");
  });
  test("// komentar & /* block */ dihapus", () => {
    const src = '{\n  // comment line\n  "a": 1, /* block */\n}';
    expect(JSON.parse(stripJsonCommentsAndTrailingComma(src))).toEqual({ a: 1 });
  });
});

describe("Anti-regresi — config vs konstanta (R1 anti-drift)", () => {
  test("config/optimization.json headroom konsisten dengan konstanta headroom.ts", async () => {
    const cfg: any = await Bun.file("config/optimization.json").json();
    const h = cfg?.optimizers?.headroom ?? {};
    // Invarian: timeout >= 2x healthProbeMs; timeout <= MAX_EFFECTIVE; payload cap ada
    if (h.timeoutMs !== undefined) {
      expect(h.timeoutMs).toBeGreaterThanOrEqual((h.healthProbeMs ?? HEADROOM_DEFAULTS.DEFAULT_HEALTH_PROBE_MS) * 2);
      expect(h.timeoutMs).toBeLessThanOrEqual(HEADROOM_DEFAULTS.MAX_EFFECTIVE_TIMEOUT_MS);
    }
    expect(HEADROOM_DEFAULTS.MAX_EFFECTIVE_TIMEOUT_MS).toBeGreaterThanOrEqual(HEADROOM_DEFAULTS.DEFAULT_TIMEOUT_MS);
    expect(HEADROOM_DEFAULTS.MAX_HEADROOM_PAYLOAD_BYTES).toBeGreaterThan(0);
    expect(HEADROOM_DEFAULTS.DEFAULT_CONNECTION_DOWN_COOLDOWN_MS).toBeGreaterThan(0);
  });
});

describe("Anti-regresi — headroom proxy connection-down (R3)", () => {
  beforeEach(() => {
    resetHeadroomHealth();
    clearHeadroomCache();
  });
  afterEach(() => {
    resetHeadroomHealth();
  });

  test("proxy mati → skip cepat (<1s), cooldown singkat aktif, TIDAK bayar timeout penuh", async () => {
    // Port yang pasti kosong — koneksi ditolak cepat
    const url = "http://127.0.0.1:59999";
    const req: any = { model: "test", messages: [{ role: "user", content: "x".repeat(20000) }] };
    const start = performance.now();
    const r1 = await applyHeadroom(req, mockProfile(15000, 20000), { enabled: true, url, minimumTokens: 10000, healthProbeMs: 300 });
    const elapsed = performance.now() - start;
    expect(r1.skipped).toBe(true);
    expect(r1.success).toBe(false);
    expect(elapsed).toBeLessThan(1000); // bukan 8-12s callCompress timeout
    expect(r1.reason).toContain("proxy not running");
    expect(getHeadroomHealth().cooldownRemainingMs).toBeGreaterThan(0);
    expect(getHeadroomHealth().lastConnectionDown).toBe(true);
    // Request kedua dalam cooldown → skip instan (0 fetch)
    const start2 = performance.now();
    const r2 = await applyHeadroom({ model: "test", messages: [{ role: "user", content: "x".repeat(20000) }] } as any, mockProfile(15000, 20000), { enabled: true, url, minimumTokens: 10000, healthProbeMs: 300 });
    expect(performance.now() - start2).toBeLessThan(50);
    expect(r2.reason).toContain("headroom_cooldown");
  });

  test("payload >1.5MB → skip payload_too_large_for_headroom tanpa fetch", async () => {
    const bigContent = "x".repeat(Math.ceil(1.5 * 1024 * 1024) + 1000);
    const req: any = { model: "test", messages: [{ role: "user", content: bigContent }] };
    const r = await applyHeadroom(req, mockProfile(1_000_000, Math.ceil(1.5 * 1024 * 1024) + 2000), { enabled: true, url: "http://127.0.0.1:59999", minimumTokens: 0, minimumBytes: 0, healthProbeMs: 0 });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe("payload_too_large_for_headroom");
  });

  test("payload >180k tokens → early skip payload_too_large_expected_timeout", async () => {
    const req: any = { model: "test", messages: [{ role: "user", content: "x".repeat(20000) }] };
    const r = await applyHeadroom(req, mockProfile(200_000, 500_000), { enabled: true, url: "http://127.0.0.1:59999", minimumTokens: 0, minimumBytes: 0, healthProbeMs: 0 });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe("payload_too_large_expected_timeout");
  });
});
