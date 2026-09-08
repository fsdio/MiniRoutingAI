// scripts/test-opencode-free-deep.ts — Deep test on working models and timeout investigation
import fs from "fs";

const env = fs.readFileSync(".env", "utf8");
function getEnv(key: string): string | undefined {
  const m = env.match(new RegExp(`^${key}=(.*)$`, "m"));
  if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  return process.env[key];
}

const OPENCODE_GO_KEY = getEnv("OPENCODE_GO_API_KEY");

// Working headers from previous test
const workingHeaders = {
  "Content-Type": "application/json",
  "x-opencode-client": "desktop",
  "User-Agent": "opencode-desktop/1.0.0 (Windows NT 10.0; Win64; x64)",
  "x-opencode-version": "1.0.0",
  "x-opencode-session": "sess_" + crypto.randomUUID(),
};

async function testModel(model: string, headers: Record<string, string>, timeoutMs: number = 30000, label: string = "") {
  const url = "https://opencode.ai/zen/v1/chat/completions";
  const body = JSON.stringify({
    model,
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 10,
    stream: false,
  });

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "POST", headers, body, signal: ctrl.signal });
    const text = await res.text();
    let j: any = null;
    try { j = JSON.parse(text); } catch {}
    const msg = j?.error?.message ?? text;
    const flag = res.ok ? "✅ SUCCESS" : `❌ HTTP ${res.status}`;
    console.log(`[${flag}] ${label}${model} (${timeoutMs/1000}s timeout) -> ${String(msg).slice(0, 300)}`);
    return { ok: res.ok, status: res.status, msg: String(msg).slice(0, 300) };
  } catch (err: any) {
    const flag = err.name === "AbortError" ? "⏱️ TIMEOUT" : "❌ ERR";
    console.log(`[${flag}] ${label}${model} -> ${String(err).slice(0, 200)}`);
    return { ok: false, status: 0, msg: String(err).slice(0, 200) };
  } finally {
    clearTimeout(t);
  }
}

async function run() {
  console.log("Deep test on working models & timeout investigation\n");

  // Test mimo-v2.5-free with working headers
  console.log("\n=== mimo-v2.5-free (working model) ===");
  for (let i = 0; i < 3; i++) {
    const h = { ...workingHeaders, "x-opencode-session": "sess_" + crypto.randomUUID() };
    await testModel("mimo-v2.5-free", h, 15000, `Run ${i+1}: `);
    await new Promise(r => setTimeout(r, 500));
  }

  // Test nemotron-3-ultra-free with longer timeout
  console.log("\n=== nemotron-3-ultra-free (timeout investigation) ===");
  for (const timeout of [10000, 20000, 30000, 60000]) {
    const h = { ...workingHeaders, "x-opencode-session": "sess_" + crypto.randomUUID() };
    await testModel("nemotron-3-ultra-free", h, timeout, `Timeout ${timeout/1000}s: `);
    await new Promise(r => setTimeout(r, 500));
  }

  // Test muse-spark-1.3-contributor-free with various approaches
  console.log("\n=== muse-spark-1.3-contributor-free (500 investigation) ===");
  
  // Try with contributor tier header
  const contributorHeaders = {
    ...workingHeaders,
    "x-opencode-user-tier": "contributor",
    "x-opencode-session": "sess_" + crypto.randomUUID(),
  };
  await testModel("muse-spark-1.3-contributor-free", contributorHeaders, 15000, "With contributor tier: ");
  
  // Try with different client types
  for (const client of ["desktop", "vscode", "cli"]) {
    const h = { ...workingHeaders, "x-opencode-client": client, "x-opencode-session": "sess_" + crypto.randomUUID() };
    await testModel("muse-spark-1.3-contributor-free", h, 15000, `Client ${client}: `);
    await new Promise(r => setTimeout(r, 500));
  }

  // Try stream mode
  console.log("\n=== Streaming mode test for nemotron ===");
  const streamHeaders = { ...workingHeaders, "Accept": "text/event-stream" };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch("https://opencode.ai/zen/v1/chat/completions", {
      method: "POST",
      headers: streamHeaders,
      body: JSON.stringify({ model: "nemotron-3-ultra-free", messages: [{ role: "user", content: "hi" }], max_tokens: 10, stream: true }),
      signal: ctrl.signal,
    });
    const reader = res.body?.getReader();
    if (reader) {
      let chunks = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks++;
        if (chunks >= 3) break;
      }
      console.log(`Stream chunks received: ${chunks}`);
    }
    console.log(`Stream response status: ${res.status}`);
  } catch (err: any) {
    console.log(`Stream error: ${String(err).slice(0, 200)}`);
  } finally {
    clearTimeout(t);
  }
}

run();