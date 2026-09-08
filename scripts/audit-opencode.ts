// scripts/audit-opencode.ts — Comprehensive audit runner for OpenCode providers
import fs from "fs";
import { createProvider } from "../src/providers/provider.ts";

const providersConfig = JSON.parse(fs.readFileSync("config/providers.json", "utf8"));
const envContent = fs.readFileSync(".env", "utf8");

function getEnv(key: string): string | undefined {
  const m = envContent.match(new RegExp(`^${key}=(.*)$`, "m"));
  if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  return process.env[key];
}

for (const p of providersConfig.providers) {
  if (p.apiKeyEnv) {
    const val = getEnv(p.apiKeyEnv);
    if (val) process.env[p.apiKeyEnv] = val;
  }
}

async function runAudit() {
  console.log("==================================================================");
  console.log("🚀 STARTING FULL OPENCODE WIRE AUDIT & TELEMETRY RECORDING");
  console.log("==================================================================\n");

  const opencodeGoConfig = providersConfig.providers.find((p: any) => p.id === "opencode-go");
  const opencodeFreeConfig = providersConfig.providers.find((p: any) => p.id === "opencode");

  const goAdapter = createProvider(opencodeGoConfig);
  const freeAdapter = createProvider(opencodeFreeConfig);

  // === AUDIT 1: opencode-go Multi-turn Warm Cache Test ===
  console.log("------------------------------------------------------------------");
  console.log("AUDIT 1: opencode-go (Console Go) — Cache Warm Multi-turn Audit");
  console.log("------------------------------------------------------------------");

  const sessionGo = `audit_session_${Date.now()}`;
  const largeSystemPrompt = "You are a professional software architect. Always explain with high precision. " + "System rule context ".repeat(50);

  for (const model of opencodeGoConfig.models) {
    console.log(`\nTesting ${model} on opencode-go (Turn 1 - Cold Context):`);
    try {
      const res1 = await goAdapter.chat({
        model,
        messages: [
          { role: "system", content: largeSystemPrompt },
          { role: "user", content: "Hello, what is your name?" }
        ],
        max_tokens: 10,
        __forwardedHeaders: {
          "x-opencode-session": sessionGo,
          "x-opencode-client": "desktop"
        }
      } as any);
      console.log(`Turn 1 Status: OK ✅ | ID: ${res1.id} | Usage:`, res1.usage);

      await new Promise(r => setTimeout(r, 1000));

      console.log(`Testing ${model} on opencode-go (Turn 2 - Warm Cache Expected):`);
      const res2 = await goAdapter.chat({
        model,
        messages: [
          { role: "system", content: largeSystemPrompt },
          { role: "user", content: "Hello, what is your name?" },
          { role: "assistant", content: "I am an AI assistant." },
          { role: "user", content: "Can you confirm our previous context?" }
        ],
        max_tokens: 10,
        __forwardedHeaders: {
          "x-opencode-session": sessionGo,
          "x-opencode-client": "desktop"
        }
      } as any);
      console.log(`Turn 2 Status: OK ✅ | ID: ${res2.id} | Usage:`, res2.usage);
    } catch (err: any) {
      console.log(`Failed: ${err.message} (status: ${err.status})`);
    }
  }

  // === AUDIT 2: opencode (Free Tier) Fingerprint Bypass Audit ===
  console.log("\n------------------------------------------------------------------");
  console.log("AUDIT 2: opencode (Free Tier) — Fingerprint Bypass & Model Status");
  console.log("------------------------------------------------------------------");

  for (const model of opencodeFreeConfig.models) {
    console.log(`\nTesting ${model} on opencode Free:`);
    try {
      const res = await freeAdapter.chat({
        model,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 10,
      } as any);
      console.log(`Status: OK ✅ | Model: ${res.model} | Response:`, JSON.stringify(res.choices[0]?.message));
    } catch (err: any) {
      console.log(`Status: FAIL ❌ | HTTP ${err.status} | Error:`, JSON.stringify(err.body));
    }
  }

  // === AUDIT 3: Streaming Mode Audit ===
  console.log("\n------------------------------------------------------------------");
  console.log("AUDIT 3: Streaming Mode Audit on OpenCode Providers");
  console.log("------------------------------------------------------------------");

  // Test streaming on mimo-v2.5-free
  console.log("\nStreaming on mimo-v2.5-free:");
  try {
    const stream = await freeAdapter.stream({
      model: "mimo-v2.5-free",
      messages: [{ role: "user", content: "Count 1 to 3" }],
      max_tokens: 10,
      stream: true,
    });
    const reader = stream.getReader();
    let chunkCount = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunkCount++;
      if (chunkCount >= 3) break;
    }
    console.log(`Streaming Status: OK ✅ (Received ${chunkCount} chunks)`);
    try { await reader.cancel(); } catch {}
  } catch (err: any) {
    console.log(`Streaming Status: FAIL ❌ | Error: ${err.message}`);
  }

  // Test streaming on opencode-go deepseek-v4-flash
  console.log("\nStreaming on opencode-go deepseek-v4-flash:");
  try {
    const stream = await goAdapter.stream({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "Count 1 to 3" }],
      max_tokens: 10,
      stream: true,
      __forwardedHeaders: {
        "x-opencode-session": `stream_sess_${Date.now()}`,
        "x-opencode-client": "desktop"
      }
    } as any);
    const reader = stream.getReader();
    let chunkCount = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunkCount++;
      if (chunkCount >= 3) break;
    }
    console.log(`Streaming Status: OK ✅ (Received ${chunkCount} chunks)`);
    try { await reader.cancel(); } catch {}
  } catch (err: any) {
    console.log(`Streaming Status: FAIL ❌ | Error: ${err.message}`);
  }

  console.log("\n==================================================================");
  console.log("📊 AUDIT COMPLETED. READING RECORDED WIRE LOGS:");
  console.log("==================================================================");

  if (fs.existsSync("logs/opencode-audit.jsonl")) {
    const lines = fs.readFileSync("logs/opencode-audit.jsonl", "utf8").trim().split("\n").filter(Boolean);
    console.log(`Total logged audit events: ${lines.length}`);
    const last3 = lines.slice(-3);
    for (const l of last3) {
      const parsed = JSON.parse(l);
      console.log(`\n[${parsed.timestamp}] ${parsed.provider}/${parsed.model} -> HTTP ${parsed.status} (${parsed.latencyMs.toFixed(1)}ms) [stream=${parsed.stream}]`);
      console.log(`  Req Headers:`, Object.keys(parsed.requestHeaders).join(", "));
      console.log(`  Resp Headers:`, Object.keys(parsed.responseHeaders).slice(0, 8).join(", "));
    }
  }
}

runAudit();