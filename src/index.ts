// src/index.ts — entrypoint Phase 5
import { createServer } from "./server/server.ts";
import type { ProvidersFile, RoutesFile } from "./types/index.ts";

let configLoadErrors: Record<string, string> = {};

function stripJsonCommentsAndTrailingComma(src: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  let inLineComment = false;
  let inBlockComment = false;
  // Posisi koma terakhir di luar string (untuk trailing comma removal yang string-safe)
  let lastCommaIdx = -1;
  let trailingRemoved = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1] ?? "";
    if (inLineComment) {
      if (c === "\n") { inLineComment = false; out += c; }
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") { inBlockComment = false; i++; }
      continue;
    }
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    // not in string/comment
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && next === "/") { inLineComment = true; i++; continue; }
    if (c === "/" && next === "*") { inBlockComment = true; i++; continue; }
    if (c === ",") { lastCommaIdx = out.length; out += c; continue; }
    if ((c === "}" || c === "]") && lastCommaIdx >= 0) {
      // Ada koma sebelum bracket penutup, dan di antara koma & bracket hanya whitespace → trailing comma, hapus
      const between = out.slice(lastCommaIdx + 1);
      if (/^\s*$/.test(between)) {
        out = out.slice(0, lastCommaIdx) + c;
        trailingRemoved++;
        // Cari koma sebelumnya (di luar string) — sederhana: reset; struktur nested aman karena koma sebelum bracket terakhir selalu ditemukan ulang saat berikutnya muncul
        lastCommaIdx = -1;
        continue;
      }
      lastCommaIdx = -1;
      out += c;
      continue;
    }
    out += c;
  }
  return out;
}

async function loadJson<T>(path: string, fallback: T, opts?: { critical?: boolean }): Promise<T> {
  try {
    const file = Bun.file(path);
    const exists = await file.exists();
    if (!exists) {
      if (opts?.critical) {
        console.warn(`[config] ${path} tidak ditemukan, menggunakan fallback`);
      }
      return fallback;
    }
    const text = await file.text();
    try {
      const cleaned = stripJsonCommentsAndTrailingComma(text);
      return JSON.parse(cleaned) as T;
    } catch (parseErr: any) {
      const msg = `Invalid JSON di ${path}: ${String(parseErr?.message ?? parseErr)}`;
      configLoadErrors[path] = msg;
      console.error(`[config] X ${msg}`);
      console.error(`[config] Hint: cek koma, trailing comma, atau kutip di ${path}. Jalankan: bun -e "JSON.parse(await Bun.file('${path}').text())" untuk detail`);
      if (opts?.critical) {
        console.error(`[config] CRITICAL: ${path} adalah config kritis — gateway akan exit (1). Perbaiki JSON sebelum restart.`);
        process.exit(1);
      }
      return fallback;
    }
  } catch (e: any) {
    const msg = `Failed to load ${path}: ${String(e?.message ?? e)}`;
    configLoadErrors[path] = msg;
    console.warn(`[config] ⚠️ ${msg}, menggunakan fallback`);
    if (opts?.critical) {
      console.error(`[config] CRITICAL fallback untuk ${path} — pertimbangkan exit.`);
    }
    return fallback;
  }
}

export function getConfigLoadErrors(): Record<string, string> {
  return { ...configLoadErrors };
}

// Export untuk unit test (anti-regresi R2)
export { stripJsonCommentsAndTrailingComma };

// Import test memakai MINI_NO_LISTEN=1 agar tidak konflik port 3000 (anti-regresi.test.ts hanya butuh export util)
const port = Number(process.env.PORT ?? Bun.env.PORT ?? 3000);

const defaultProviders: ProvidersFile = {
  providers: [
    {
      id: "upstream",
      baseURL: process.env.UPSTREAM_BASE_URL ?? (Bun.env.UPSTREAM_BASE_URL as string) ?? "http://localhost:11434/v1",
      apiKeyEnv: "UPSTREAM_API_KEY",
      models: ["*"],
    },
  ],
};

const defaultRoutes: RoutesFile = {
  routes: {
    balanced: {
      strategy: "fallback",
      primary: { provider: "upstream", model: "test-model" },
      fallbacks: [],
      timeoutMs: 8000,
      retry: { maxRetries: 0, backoffMs: 0 },
    },
  },
  defaultRoute: "balanced",
};

const providers = await loadJson<ProvidersFile>("config/providers.json", defaultProviders, { critical: true });
const routes = await loadJson<RoutesFile>("config/routes.json", defaultRoutes, { critical: true });
const optimization = await loadJson<any>("config/optimization.json", { optimizers: { rtk: false } });
const prices = await loadJson<Record<string, any>>("config/prices.json", { prices: {} });
const priceTable = (prices as any)?.prices ?? {};

// Validasi provider rename: kanonik kini mini-routingai; MiniRoutingAI dan mini-9router adalah alias deprecated
const legacyIds = providers.providers.filter((p) => ["mini-9router", "MiniRoutingAI"].includes(p.id)).map((p) => p.id);
if (legacyIds.length) {
  console.warn(`[config] ⚠️ providers.json masih mengandung id legacy ${legacyIds.join(", ")}. Kanonik kini "mini-routingai" (project) / display "MiniRoutingAI". Hapus alias legacy.`);
}
if (Object.keys(configLoadErrors).length > 0) {
  console.warn(`[config] Load errors: ${JSON.stringify(configLoadErrors)}`);
}

// Allow env override for upstream & Ollama Cloud baseURL (dinamis, tanpa hardcode provider)
if (process.env.UPSTREAM_BASE_URL || Bun.env.UPSTREAM_BASE_URL) {
  const envUrl = (process.env.UPSTREAM_BASE_URL ?? Bun.env.UPSTREAM_BASE_URL) as string;
  if (providers.providers[0]) {
    providers.providers[0].baseURL = envUrl;
  }
}
if (process.env.OLLAMA_CLOUD_BASE_URL || (Bun.env as any).OLLAMA_CLOUD_BASE_URL) {
  const envUrl = (process.env.OLLAMA_CLOUD_BASE_URL ?? (Bun.env as any).OLLAMA_CLOUD_BASE_URL) as string;
  const p = providers.providers.find((x) => x.id === "ollama-cloud");
  if (p) p.baseURL = envUrl;
}

if (process.env.MINI_NO_LISTEN !== "1") {
  createServer({ port, providers, routes, optimization, prices: priceTable });
}
