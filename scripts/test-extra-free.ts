// scripts/test-extra-free.ts
import { createProvider } from "../src/providers/provider.ts";

const freeAdapter = createProvider({
  id: "opencode",
  baseURL: "https://opencode.ai/zen/v1",
});

const modelsToTest = [
  "mimo-v2.5-free",
  "nemotron-3-ultra-free",
  "deepseek-v4-flash-free",
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
  "x-preview-f-free"
];

for (const model of modelsToTest) {
  try {
    const res = await freeAdapter.chat({
      model,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 5,
    } as any);
    console.log(`[✅ 200 OK] ${model} -> ID: ${res.id}`);
  } catch (e: any) {
    console.log(`[❌ ${e.status}] ${model} -> ${JSON.stringify(e.body)}`);
  }
}