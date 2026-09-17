# Startup Flow

```text
Application
│
├── src/index.ts
│   └── Bootstrap
│       ├── Load config/providers.json → ProvidersFile
│       ├── Load config/routes.json → RoutesFile
│       ├── Load config/prices.json → PricesFile
│       ├── Load config/optimization.json → OptimizationConfig
│       ├── Create Provider Adapters (createProvider per provider)
│       ├── Initialize Router (Router class)
│       │   ├── HealthStore (global health tracking)
│       │   ├── StickyCacheStore (session affinity)
│       │   └── Route config from routes.json
│       ├── Create HTTP Server (src/server/server.ts)
│       │   ├── Middleware: validation, headers, logging
│       │   ├── Route: POST /v1/chat/completions (chat & stream)
│       │   ├── Route: GET /debug/routes (observability)
│       │   └── Route: GET /metrics (Prometheus)
│       └── Start listening on PORT (default 3000)
│
├── Server Ready
│   ├── Health checks: /debug/routes, /metrics
│   └── Accepting requests
```