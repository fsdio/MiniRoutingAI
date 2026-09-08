// scripts/test-opencode.ts — Deep test opencode-go & opencode (free) providers with various headers
import fs from "fs";

const providersConfig = JSON.parse(fs.readFileSync("config/providers.json", "utf8"));
const envContent = fs.readFileSync(".env", "utf8");

function getEnv(key: string): string | undefined {
  const m = envContent.match(new RegExp(`^${key}=(.*)$`, "m"));
  if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  return process.env[key];
}

const OPENCODE_GO_API_KEY = getEnv("OPENCODE_GO_API_KEY");
const OPENCODE_GO_BASE_URL = getEnv("OPENCODE_GO_BASE_URL") ?? "https://opencode.ai/zen/go/v1";

function headersForOpenCodeGo(providerId: string, apiKey?: string, sessionId?: string, clientId?: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) h["Authorization"] = `Bearer ${apiKey}`;
  if (sessionId) h["x-opencode-session"] = sessionId;
  if (clientId) h["x-opencode-client"] = clientId;
  else h["x-opencode-client"] = "desktop"; // default
  return h;
}

function headersForOpenCodeFree(providerId: string, clientId?: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  // Free tier doesn't use Bearer auth but requires x-opencode-client
  h["x-opencode-client"] = clientId ?? "desktop";
  return h;
}

async function testModel(provider: any, model: string, headers: Record<string, string>, label: string) {
  const url = `${provider.baseURL.replace(/\/$/,"")}/chat/completions`;
  const body = JSON.stringify({ model, messages: [{role:"user", content:"hi"}], max_tokens: 10, stream: false });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { method: "POST", headers, body, signal: ctrl.signal });
    const txt = await res.text();
    let j: any = null;
    try { j = JSON.parse(txt); } catch {}
    const msg = j?.error?.message ?? txt;
    const lower = String(msg).toLowerCase();
    const isUnavailable = lower.includes("unavailable") || lower.includes("capacity") || lower.includes("overloaded") || lower.includes("no available channel");
    const isNotFound = lower.includes("model not found") || lower.includes("model_not_found");
    const isSessionMissing = lower.includes("x-opencode-session") || lower.includes("missing x-opencode");
    const isFreeTierRestricted = lower.includes("free tier") && lower.includes("can only be used in opencode");
    
    console.log(`\n=== ${label} ===`);
    console.log(`Model: ${model}`);
    console.log(`Status: ${res.status} ${res.ok ? "✅ OK" : "❌ FAIL"}`);
    console.log(`Headers sent: ${JSON.stringify(headers)}`);
    console.log(`Response: ${String(msg).slice(0, 500)}`);
    
    return {
      provider: provider.id,
      model,
      status: res.status,
      ok: res.ok,
      isUnavailable,
      isNotFound,
      isSessionMissing,
      isFreeTierRestricted,
      msg: String(msg).slice(0, 500)
    };
  } catch (e: any) {
    console.log(`\n=== ${label} ===`);
    console.log(`Model: ${model}`);
    console.log(`Status: 0 (ERROR) ❌`);
    console.log(`Headers sent: ${JSON.stringify(headers)}`);
    console.log(`Error: ${String(e).slice(0, 300)}`);
    return { provider: provider.id, model, status: 0, ok: false, isUnavailable: false, isNotFound: false, isSessionMissing: String(e).toLowerCase().includes("unavailable"), isFreeTierRestricted: false, msg: String(e).slice(0, 300) };
  } finally { clearTimeout(t); }
}

async function runTests() {
  console.log("=".repeat(60));
  console.log("TESTING OPENCODE PROVIDERS WITH VARIOUS HEADERS");
  console.log("=".repeat(60));

  const results: any[] = [];

  // === OPENCODE-GO TESTS ===
  const opencodeGoProvider = providersConfig.providers.find((p: any) => p.id === "opencode-go");
  if (opencodeGoProvider) {
    console.log("\n" + "=".repeat(60));
    console.log("PROVIDER: opencode-go (Console Go)");
    console.log("=".repeat(60));

    // Test 1: With session + client headers (full proper headers)
    for (const model of opencodeGoProvider.models) {
      const sessionId = `ses_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const h = headersForOpenCodeGo(opencodeGoProvider.id, OPENCODE_GO_API_KEY, sessionId, "desktop");
      const r = await testModel(opencodeGoProvider, model, h, `opencode-go / ${model} (session + desktop)`);
      results.push(r);
      await new Promise(res => setTimeout(res, 1000));
    }

    // Test 2: With only client header (no session)
    for (const model of opencodeGoProvider.models) {
      const h = headersForOpenCodeGo(opencodeGoProvider.id, OPENCODE_GO_API_KEY, undefined, "desktop");
      const r = await testModel(opencodeGoProvider, model, h, `opencode-go / ${model} (desktop only, NO session)`);
      results.push(r);
      await new Promise(res => setTimeout(res, 1000));
    }

    // Test 3: With session + cli client
    for (const model of opencodeGoProvider.models) {
      const sessionId = `ses_cli_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const h = headersForOpenCodeGo(opencodeGoProvider.id, OPENCODE_GO_API_KEY, sessionId, "cli");
      const r = await testModel(opencodeGoProvider, model, h, `opencode-go / ${model} (session + cli)`);
      results.push(r);
      await new Promise(res => setTimeout(res, 1000));
    }
  }

  // === OPENCODE FREE TESTS ===
  const opencodeFreeProvider = providersConfig.providers.find((p: any) => p.id === "opencode");
  if (opencodeFreeProvider) {
    console.log("\n" + "=".repeat(60));
    console.log("PROVIDER: opencode (Free Tier)");
    console.log("=".repeat(60));

    // Test 1: desktop client
    for (const model of opencodeFreeProvider.models) {
      const h = headersForOpenCodeFree(opencodeFreeProvider.id, "desktop");
      const r = await testModel(opencodeFreeProvider, model, h, `opencode / ${model} (desktop)`);
      results.push(r);
      await new Promise(res => setTimeout(res, 1000));
    }

    // Test 2: vscode client
    for (const model of opencodeFreeProvider.models) {
      const h = headersForOpenCodeFree(opencodeFreeProvider.id, "vscode");
      const r = await testModel(opencodeFreeProvider, model, h, `opencode / ${model} (vscode)`);
      results.push(r);
      await new Promise(res => setTimeout(res, 1000));
    }

    // Test 3: cli client
    for (const model of opencodeFreeProvider.models) {
      const h = headersForOpenCodeFree(opencodeFreeProvider.id, "cli");
      const r = await testModel(opencodeFreeProvider, model, h, `opencode / ${model} (cli)`);
      results.push(r);
      await new Promise(res => setTimeout(res, 1000));
    }
  }

  // === SUMMARY ===
  console.log("\n" + "=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));
  
  const ok = results.filter(r => r.ok);
  const sessionMissing = results.filter(r => r.isSessionMissing);
  const freeTierRestricted = results.filter(r => r.isFreeTierRestricted);
  const unavailable = results.filter(r => r.isUnavailable);
  const notFound = results.filter(r => r.isNotFound);
  const other = results.filter(r => !r.ok && !r.isSessionMissing && !r.isFreeTierRestricted && !r.isUnavailable && !r.isNotFound);

  console.log(`Total tests: ${results.length}`);
  console.log(`✅ OK: ${ok.length}`);
  console.log(`🔴 Session Missing: ${sessionMissing.length}`);
  console.log(`🔴 Free Tier Restricted: ${freeTierRestricted.length}`);
  console.log(`🔴 Unavailable: ${unavailable.length}`);
  console.log(`🔴 Not Found: ${notFound.length}`);
  console.log(`🔴 Other Errors: ${other.length}`);

  // Detail per provider/model
  console.log("\n--- Detail Results ---");
  for (const r of results) {
    const status = r.ok ? "✅" : (r.isSessionMissing ? "🔴 SESSION" : r.isFreeTierRestricted ? "🔴 FREE_TIER" : r.isUnavailable ? "🔴 UNAVAIL" : r.isNotFound ? "🔴 NOTFOUND" : "❌ ERR");
    console.log(`${status} ${r.provider}/${r.model} - HTTP ${r.status}`);
  }

  fs.writeFileSync("scripts/test-opencode-result.json", JSON.stringify(results, null, 2));
  console.log("\nSaved detailed results to scripts/test-opencode-result.json");
}

runTests();