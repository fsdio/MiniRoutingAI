// scripts/check-juan.ts — snapshot live khusus provider juan (J-T11/J-T12)
// Usage: bun run scripts/check-juan.ts [--live] [--stream] [--gateway]
//  --live     : hit upstream juan real (butuh JUAN_API_KEY di .env)
//  default    : hanya audit config tanpa network
import fs from "fs";

const providers: any[] = JSON.parse(fs.readFileSync("config/providers.json", "utf8")).providers;
const routes = JSON.parse(fs.readFileSync("config/routes.json", "utf8"));
const prices = JSON.parse(fs.readFileSync("config/prices.json", "utf8"));

let envText = "";
try { envText = fs.readFileSync(".env", "utf8"); } catch {}
function getEnv(key: string): string | undefined {
  const m = envText.match(new RegExp(`^${key}=(.*)$`, "m"));
  if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  return process.env[key];
}
for (const p of providers) {
  if (p.apiKeyEnv) {
    const v = getEnv(p.apiKeyEnv);
    if (v) (process.env as any)[p.apiKeyEnv] = v;
  }
}

const juanCfg = providers.find((x) => x.id === "juan");
console.log("=== JUAN CONFIG AUDIT ===");
console.log(JSON.stringify(juanCfg, null, 2));
console.log("\n=== JUAN ROUTE TARGETS (balanced) ===");
const balanced = routes.routes.balanced;
const juanTargets = [...(balanced.fallbacks ?? []), balanced.primary].filter((x: any) => x.provider === "juan");
console.log(JSON.stringify(juanTargets, null, 2));
console.log("\n=== JUAN PRICE ===");
console.log(JSON.stringify(prices.prices?.["juan"] ?? "MISSING", null, 2));

// mismatch audit
const mismatchedRoute = juanTargets.filter((t: any) => !juanCfg.models.includes(t.model));
const unusedProvider = juanCfg.models.filter((m: string) => !juanTargets.some((t: any) => t.model === m));
console.log(`\nMismatched (route not in provider.models): ${mismatchedRoute.length ? JSON.stringify(mismatchedRoute) : "0 - OK"}`);
console.log(`Unused provider models not in route: ${unusedProvider.length ? JSON.stringify(unusedProvider) : "0 - OK"}`);
console.log(`contextWindow generic: ${juanCfg.contextWindow ?? "null (BUG: tidak ada default)"}`);
console.log(`contextWindows: ${JSON.stringify(juanCfg.contextWindows ?? {})}`);
const hasDeepseekWindow = !!(juanCfg.contextWindows?.["deepseek-v4-flash"] ?? juanCfg.contextWindow);
console.log(`deepseek-v4-flash window defined? ${hasDeepseekWindow ? "YA" : "TIDAK (BUG potensial — getContextWindow null)"}`);

function headersFor(p: any): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const key = p.apiKeyEnv ? (process.env as any)[p.apiKeyEnv] : undefined;
  if (p.id === "opencode") h["x-opencode-client"] = "desktop";
  else if (p.id === "openrouter") {
    h["HTTP-Referer"] = "http://localhost:3000";
    h["X-Title"] = "MiniRoutingAI";
    if (key) h["Authorization"] = `Bearer ${key}`;
  } else {
    if (key) h["Authorization"] = `Bearer ${key}`;
  }
  return h;
}

async function testTarget(providerId: string, model: string, opts?: { stream?: boolean; withReasoning?: boolean }) {
  const p = providers.find((x) => x.id === providerId);
  if (!p) return { providerId, model, status: 0, ok: false, error: "provider not found" };
  const url = `${p.baseURL.replace(/\/$/, "")}/chat/completions`;
  const bodyObj: any = {
    model,
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 5,
    stream: !!opts?.stream,
  };
  if (opts?.withReasoning) bodyObj.reasoning = { enabled: true };
  if (opts?.stream) bodyObj.stream_options = { include_usage: true };
  const body = JSON.stringify(bodyObj);
  const headers = headersFor(p);
  // capture body for audit
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10_000);
  const start = performance.now();
  try {
    const res = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
    const text = await res.text();
    const latencyMs = Math.round(performance.now() - start);
    let json: any = null;
    try { json = JSON.parse(text); } catch {}
    const msg = json?.error?.message ?? text;
    const lower = String(msg).toLowerCase();
    const isUnavailable =
      lower.includes("unavailable") ||
      lower.includes("capacity") ||
      lower.includes("overloaded") ||
      lower.includes("no available channel") ||
      lower.includes("rate limit");
    const isNotFound = lower.includes("model not found") || lower.includes("model_not_found");
    const hasResetHint = /reset after\s+\d+\s*s/i.test(String(msg));
    return {
      providerId, model, status: res.status, ok: res.ok, latencyMs,
      isUnavailable, isNotFound, hasResetHint,
      msg: String(msg).slice(0, 400),
      usage: json?.usage ?? null,
      headers: Object.fromEntries(res.headers.entries()),
    };
  } catch (e: any) {
    return { providerId, model, status: 0, ok: false, latencyMs: Math.round(performance.now() - start), isUnavailable: String(e).toLowerCase().includes("unavailable"), msg: String(e).slice(0, 400) };
  } finally { clearTimeout(t); }
}

const args = process.argv.slice(2);
const doLive = args.includes("--live");
const doStream = args.includes("--stream");

if (!doLive) {
  console.log("\n=== MODE: AUDIT ONLY (tanpa network) ===");
  console.log("Jalankan dengan --live untuk hit upstream juan real.");
  console.log("Contoh: bun run scripts/check-juan.ts --live --stream");
  // juga test helper pure (tanpa network): extractRetryAfterMs & classifyError
  const { extractRetryAfterMs } = await import("../src/router/router.ts");
  const { classifyError } = await import("../src/router/policy.ts");
  console.log("\n=== PURE HELPER TEST (tanpa network) ===");
  const bodyReset = { error: { message: "upstream error (status 401) (reset after 32s)" } };
  console.log(`extractRetryAfterMs reset 32s => ${extractRetryAfterMs(bodyReset)} (expect 32000)`);
  console.log(`classify \"No available channel\" => ${classifyError(400, { error: { message: "No available channel" } })} (expect transient)`);
  console.log(`classify upstream 401 enveloped 503 => ${classifyError(503, bodyReset)} (expect server_error)`);
  console.log("\nAudit selesai. Tidak ada network call.");
  process.exit(0);
}

// LIVE MODE
console.log("\n=== LIVE MODE: hitting juan upstream ===");
const liveModels = [
  ...juanCfg.models,
  // tambahan model yang pernah muncul di log lama untuk exhaustive J-T12
  "glm-5.3-flash", "minimax-m3", "gemini-3.8-flash-high", "gemini-3.7-flash-low", "nemotron-3-ultra",
].filter((v, i, a) => a.indexOf(v) === i);

const results: any[] = [];
for (const model of liveModels) {
  // non-stream
  const r = await testTarget("juan", model, { withReasoning: true });
  results.push({ ...r, stream: false });
  const flag = r.isUnavailable ? "UNAVAILABLE" : r.ok ? "OK" : r.isNotFound ? "NOT_FOUND" : `ERR_${r.status}`;
  console.log(`${flag}  juan/${model}  status=${r.status}  latency=${(r as any).latencyMs}ms  resetHint=${(r as any).hasResetHint}  msg=${(r as any).msg.slice(0, 120)}`);
  await new Promise((res) => setTimeout(res, 600));
  if (doStream) {
    const rs = await testTarget("juan", model, { stream: true, withReasoning: true });
    results.push({ ...rs, stream: true });
    const flagS = rs.isUnavailable ? "UNAVAILABLE_STREAM" : rs.ok ? "OK_STREAM" : `ERR_${rs.status}_STREAM`;
    console.log(`  ↳ ${flagS} stream  status=${rs.status}  msg=${String((rs as any).msg).slice(0, 80)}`);
    await new Promise((res) => setTimeout(res, 600));
  }
}
console.log("\n=== SUMMARY ===");
const ok = results.filter((r) => r.ok);
const unav = results.filter((r) => r.isUnavailable);
console.log(`OK:${ok.length} UNAVAIL:${unav.length} OTHER:${results.length - ok.length - unav.length}  (total tests: ${results.length})`);
fs.writeFileSync("scripts/check-juan-result.json", JSON.stringify({ timestamp: new Date().toISOString(), juanCfg, juanTargets, results }, null, 2));
console.log("Saved to scripts/check-juan-result.json");
