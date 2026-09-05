// scripts/check-unavailable.ts — cek live model mana yang Model is unavailable
import fs from "fs";

const providers: any[] = JSON.parse(fs.readFileSync("config/providers.json", "utf8")).providers;
const routes = JSON.parse(fs.readFileSync("config/routes.json", "utf8"));
const env = fs.readFileSync(".env", "utf8");
function getEnv(key: string): string | undefined {
  const m = env.match(new RegExp(`^${key}=(.*)$`, "m"));
  if (!m) return process.env[key];
  return m[1].trim().replace(/^["']|["']$/g, "");
}
for (const p of providers) {
  if (p.apiKeyEnv) {
    const v = getEnv(p.apiKeyEnv);
    if (v) process.env[p.apiKeyEnv] = v;
  }
}
function headersFor(p: any): Record<string,string> {
  const h: Record<string,string> = { "Content-Type": "application/json" };
  const key = p.apiKeyEnv ? process.env[p.apiKeyEnv] : undefined;
  if (p.id === "opencode") {
    h["x-opencode-client"] = "desktop";
  } else if (p.id === "openrouter") {
    h["HTTP-Referer"] = "http://localhost:3000";
    h["X-Title"] = "MiniRoutingAI";
    if (key) h["Authorization"] = `Bearer ${key}`;
  } else {
    if (key) h["Authorization"] = `Bearer ${key}`;
  }
  return h;
}
async function testTarget(providerId: string, model: string) {
  const p = providers.find(x => x.id === providerId);
  if (!p) return { providerId, model, status: 0, ok: false, error: "provider not found" };
  const url = `${p.baseURL.replace(/\/$/,"")}/chat/completions`;
  const body = JSON.stringify({ model, messages: [{role:"user", content:"hi"}], max_tokens: 5, stream: false });
  const controller = new AbortController();
  const t = setTimeout(()=>controller.abort(), 7000);
  try {
    const res = await fetch(url, { method:"POST", headers: headersFor(p), body, signal: controller.signal });
    const text = await res.text();
    let json: any=null;
    try { json = JSON.parse(text); } catch {}
    const msg = json?.error?.message ?? text;
    const lower = String(msg).toLowerCase();
    const isUnavailable = lower.includes("unavailable") || lower.includes("capacity") || lower.includes("overloaded");
    const isNotFound = lower.includes("model not found") || lower.includes("model_not_found");
    return { providerId, model, status: res.status, ok: res.ok, isUnavailable, isNotFound, msg: String(msg).slice(0,300) };
  } catch (e:any) {
    return { providerId, model, status: 0, ok: false, isUnavailable: String(e).toLowerCase().includes("unavailable"), msg: String(e).slice(0,300) };
  } finally { clearTimeout(t); }
}

const targets: any[] = [routes.routes.balanced.primary, ...routes.routes.balanced.fallbacks];
console.log(`Testing ${targets.length} route targets live (7s timeout each)...\n`);
const results:any[]=[];
for (const t of targets) {
  const r = await testTarget(t.provider, t.model);
  results.push(r);
  const flag = r.isUnavailable ? "UNAVAILABLE ❌" : r.ok ? "OK ✅" : r.isNotFound ? "NOT_FOUND" : `ERR ${r.status}`;
  console.log(`${flag}  ${r.providerId}/${r.model}  status=${r.status}  msg=${r.msg}`);
  await new Promise(res=>setTimeout(res, 300)); // jeda rate limit
}
console.log("\n=== SUMMARY ===");
const unavailable = results.filter(r=>r.isUnavailable);
const notFound = results.filter(r=>r.isNotFound);
const ok = results.filter(r=>r.ok);
console.log(`OK: ${ok.length}, UNAVAILABLE: ${unavailable.length}, NOT_FOUND: ${notFound.length}, OTHER ERR: ${results.length - ok.length - unavailable.length - notFound.length}`);
if (unavailable.length) {
  console.log("\nUNAVAILABLE list (akan dihapus):");
  for (const r of unavailable) console.log(` - ${r.providerId}/${r.model} status=${r.status} msg=${r.msg}`);
}
fs.writeFileSync("scripts/check-unavailable-result.json", JSON.stringify(results, null, 2));
console.log("\nSaved to scripts/check-unavailable-result.json");
