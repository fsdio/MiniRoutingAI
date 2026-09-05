import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordRequestLog, readUsageEntries, readUsageSummary } from "../src/telemetry/persistence.ts";

let dir: string;
let prev: string | undefined;

beforeAll(() => {
  prev = process.env.DATA_DIR;
  dir = mkdtempSync(join(tmpdir(), "mnr-usage-"));
  process.env.DATA_DIR = dir;
});

afterAll(() => {
  if (prev === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe("telemetry/persistence", () => {
  test("records entries and reads them back", async () => {
    await recordRequestLog({ requestId: "r1", ts: 1000, route: "fast", provider: "a", model: "m", status: 200, inputTokens: 10, outputTokens: 5, totalLatencyMs: 20 });
    await recordRequestLog({ requestId: "r2", ts: 2000, route: "fast", provider: "a", model: "m", status: 200, inputTokens: 30, outputTokens: 7, totalLatencyMs: 40 });
    const entries = await readUsageEntries();
    expect(entries.length).toBe(2);
    expect(entries[0].requestId).toBe("r1");
    expect(entries[1].requestId).toBe("r2");
  });

  test("summary aggregates tokens and latencies", async () => {
    const summary = await readUsageSummary();
    expect(summary.count).toBe(2);
    expect(summary.totalInputTokens).toBe(40);
    expect(summary.totalOutputTokens).toBe(12);
    expect(summary.latency.p50).toBe(20);
    expect(summary.latency.max).toBe(40);
    expect(summary.byRoute.fast.count).toBe(2);
  });
});
