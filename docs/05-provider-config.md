# Provider & Route Configuration

## config/providers.json

```text
ProvidersFile
│
├── providers: ProviderConfig[]
│   ├── id: string (unique)
│   ├── baseURL: string (upstream endpoint)
│   ├── apiKeyEnv: string (env var name, optional)
│   ├── models: string[] (model IDs supported)
│   ├── defaultWeight: number (fallback weight)
│   ├── avgLatencyMs: number (estimasi untuk ordering)
│   ├── requiresSession: boolean (x-opencode-session required)
│   ├── contextWindow: number (default context window)
│   └── contextWindows: Record<string, number> (per-model override)
│
├── Contoh Entry
│   ├── openrouter: baseURL=openrouter.ai, models=["deepseek/deepseek-v4-flash-0731", "openrouter/free"]
│   ├── opencode: baseURL=opencode.ai/zen/v1, models=["mimo-v2.5-free", ...], requiresSession=true
│   ├── opencode-go: baseURL=opencode.ai/zen/go/v1, models=["deepseek-v4-flash", ...], requiresSession=true
│   ├── juan: baseURL=router.juan.web.id, models=["gpt-4o"]
│   ├── ollama-cloud: baseURL=ollama.com, models=["nemotron-3-ultra:cloud"]
│   └── nvidia: baseURL=integrate.api.nvidia.com, models=["nvidia/nemotron-3-ultra-550b-a55b"]
```

## config/routes.json

```text
RoutesFile
│
├── routes: Record<string, RouteConfig>
│   ├── free
│   │   ├── strategy: "cache-aware-sticky"
│   │   ├── primary: { provider, model, weight }
│   │   ├── fallbacks: RouteTarget[]
│   │   ├── timeoutMs, adaptiveTimeout, retry
│   │   ├── optimizers: { rtk, headroom, caveman, ponytail }
│   │   ├── healthAwareOrdering, minHealthyCandidates
│   │   └── modelHints: ["coding", "debug", ...]
│   ├── balanced
│   │   ├── strategy: "cache-aware-sticky"
│   │   ├── primary: { provider: "juan", model: "gpt-4o" }
│   │   ├── fallbacks: [opencode-go, openrouter/deepseek, juan]
│   │   └── optimizers: sama
│   └── reasoning (optional)
│       └── strategy, primary, fallbacks dengan reasoning.enabled=true
│
├── defaultRoute: "balanced"
└── Dynamic Provider→Route Mapping (resolveRouteKeyForModel)
    └── Scan routes.routes → build providerToRoute map → priority: primary > fallbacks
```