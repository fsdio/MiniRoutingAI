// scripts/test-opencode-free-bypass.ts — Test various header permutations & fingerprints for OpenCode free tier
import fs from "fs";

const env = fs.readFileSync(".env", "utf8");
function getEnv(key: string): string | undefined {
  const m = env.match(new RegExp(`^${key}=(.*)$`, "m"));
  if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  return process.env[key];
}

const OPENCODE_GO_KEY = getEnv("OPENCODE_GO_API_KEY");

const models = [
  "muse-spark-1.3-contributor-free",
  "mimo-v2.5-free",
  "nemotron-3-ultra-free"
];

const headerCombinations: Array<{ name: string; url: string; headers: Record<string, string> }> = [
  {
    name: "1. Official desktop user-agent + client desktop",
    url: "https://opencode.ai/zen/v1/chat/completions",
    headers: {
      "Content-Type": "application/json",
      "x-opencode-client": "desktop",
      "User-Agent": "opencode-desktop/1.0.0 (Windows NT 10.0; Win64; x64)",
      "x-opencode-version": "1.0.0",
      "x-opencode-session": "sess_" + crypto.randomUUID(),
    }
  },
  {
    name: "2. VSCode extension header style",
    url: "https://opencode.ai/zen/v1/chat/completions",
    headers: {
      "Content-Type": "application/json",
      "x-opencode-client": "vscode",
      "User-Agent": "OpenCode-VSCode/0.5.0",
      "x-opencode-version": "0.5.0",
      "x-opencode-session": "sess_" + crypto.randomUUID(),
    }
  },
  {
    name: "3. CLI header style with machine-id",
    url: "https://opencode.ai/zen/v1/chat/completions",
    headers: {
      "Content-Type": "application/json",
      "x-opencode-client": "cli",
      "User-Agent": "opencode-cli/1.2.0",
      "x-opencode-machine-id": crypto.randomUUID(),
      "x-opencode-session": "sess_" + crypto.randomUUID(),
    }
  },
  {
    name: "4. Contributor tier header",
    url: "https://opencode.ai/zen/v1/chat/completions",
    headers: {
      "Content-Type": "application/json",
      "x-opencode-client": "desktop",
      "x-opencode-user-tier": "contributor",
      "x-opencode-session": "sess_" + crypto.randomUUID(),
    }
  },
  {
    name: "5. Via opencode-go endpoint with OpenCode Go API key",
    url: "https://opencode.ai/zen/go/v1/chat/completions",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENCODE_GO_KEY}`,
      "x-opencode-client": "desktop",
      "x-opencode-session": "sess_" + crypto.randomUUID(),
    }
  },
  {
    name: "6. Electron desktop headers",
    url: "https://opencode.ai/zen/v1/chat/completions",
    headers: {
      "Content-Type": "application/json",
      "x-opencode-client": "desktop",
      "Origin": "vscode-file://vscode-app",
      "Sec-Fetch-Site": "cross-site",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) OpenCode/1.0.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36",
    }
  }
];

async function run() {
  console.log("Starting OpenCode Free Tier Bypass / Fingerprint Experiments...\n");
  for (const combo of headerCombinations) {
    console.log(`\n======================================================`);
    console.log(`COMBINATION: ${combo.name}`);
    console.log(`URL: ${combo.url}`);
    console.log(`======================================================`);

    for (const model of models) {
      const body = JSON.stringify({
        model,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 5,
        stream: false,
      });

      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch(combo.url, {
          method: "POST",
          headers: combo.headers,
          body,
          signal: ctrl.signal,
        });
        const text = await res.text();
        let j: any = null;
        try { j = JSON.parse(text); } catch {}
        const msg = j?.error?.message ?? text;
        const flag = res.ok ? "✅ SUCCESS" : `❌ HTTP ${res.status}`;
        console.log(`[${flag}] ${model} -> ${String(msg).slice(0, 200)}`);
      } catch (err: any) {
        console.log(`[❌ ERR] ${model} -> ${String(err).slice(0, 150)}`);
      } finally {
        clearTimeout(t);
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

run();