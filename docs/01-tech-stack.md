# Tech Stack

```text
Application
├── Language
│   └── TypeScript (Node.js 20+)
├── Runtime
│   └── Node.js / Bun
├── Framework
│   └── Custom HTTP Router (no Express/Fastify)
├── Build
│   └── TypeScript Compiler (tsc) + pnpm
├── API
│   └── OpenAI-Compatible /v1/chat/completions
├── Configuration
│   ├── config/providers.json     # Upstream provider definitions
│   ├── config/routes.json        # Routing strategies & fallbacks
│   ├── config/prices.json        # Token pricing per model
│   └── config/optimization.json  # Optimizer configs (RTK, Headroom, Caveman, Ponytail)
├── External Services (Upstream Providers)
│   ├── openrouter (openrouter.ai)
│   ├── juan (router.juan.web.id)
│   ├── opencode-go (opencode.ai/zen/go/v1)
│   ├── opencode (opencode.ai/zen/v1) — free tier
│   ├── ollama-cloud (ollama.com)
│   └── nvidia (integrate.api.nvidia.com)
├── Optimizers
│   ├── RTK (Response Token Killer)
│   ├── Headroom (Proxy Compression)
│   ├── Caveman (Prompt Compression)
│   └── Ponytail (Response Compression)
├── Infrastructure
│   ├── Docker (optional)
│   └── Systemd / PM2 untuk production
└── Testing
    ├── Unit tests (vitest)
    ├── Integration tests (scripts/*.ts)
    └── Benchmark scripts
```