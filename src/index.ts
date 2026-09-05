// src/index.ts — entrypoint Phase 5
import { createServer } from "./server/server.ts";
import type { ProvidersFile, RoutesFile } from "./types/index.ts";

let configLoadErrors: Record<string, string> = {};

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
      return JSON.parse(text) as T;
    } catch (parseErr: any) {
      const msg = `Invalid JSON di ${path}: ${String(parseErr?.message ?? parseErr)}`;
      configLoadErrors[path] = msg;
      console.error(`[config] ❌ ${msg}`);
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
    fast: {
      strategy: "fallback",
      primary: { provider: "upstream", model: "test-model" },
      fallbacks: [],
      timeoutMs: 8000,
      retry: { maxRetries: 0, backoffMs: 0 },
    },
  },
  defaultRoute: "fast",
};

const providers = await loadJson<ProvidersFile>("config/providers.json", defaultProviders, { critical: true });
const routes = await loadJson<RoutesFile>("config/routes.json", defaultRoutes, { critical: true });
const optimization = await loadJson<any>("config/optimization.json", { optimizers: { rtk: false } });

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

createServer({ port, providers, routes, optimization });
