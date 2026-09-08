// scripts/test-free-session.ts
import { createProvider } from "../src/providers/provider.ts";

const freeAdapter = createProvider({
  id: "opencode",
  baseURL: "https://opencode.ai/zen/v1",
});

const sessionId = `sess_${crypto.randomUUID()}`;

console.log("Testing mimo-v2.5-free WITH x-opencode-session header:");
try {
  const res = await freeAdapter.chat({
    model: "mimo-v2.5-free",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 10,
    __forwardedHeaders: {
      "x-opencode-session": sessionId,
      "x-opencode-client": "desktop",
      "User-Agent": "opencode-desktop/1.0.0 (Windows NT 10.0; Win64; x64)",
      "x-opencode-version": "1.0.0",
    }
  } as any);
  console.log("SUCCESS ✅:", JSON.stringify(res.choices[0]?.message));
} catch (e: any) {
  console.log("FAIL ❌:", e.message, JSON.stringify(e.body));
}