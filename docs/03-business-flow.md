# Business Flow

## Chat Completion Request

```text
POST /v1/chat/completions
│
├── server.ts:fetch()
│   ├── Parse & Validate Request
│   ├── Extract x-opencode-* headers → __forwardedHeaders
│   ├── Analyze Request (token estimation, profile)
│   ├── Duplicate Cache Check (tool messages)
│   └── Determine Route Key
│       └── resolveRouteKeyForModel(model, routes)
│           ├── Exact match: "free" → route "free"
│           ├── Exact match: "balanced" → route "balanced"
│           ├── mini-* prefix: "mini-free" → "free", "mini-balanced" → "balanced"
│           ├── Provider prefix from routes.json (dynamic)
│           └── Default: routes.defaultRoute ("balanced")
│
├── Router.routeChat() / routeStream()
│   ├── Get Route Config from routes.routes[routeKey]
│   ├── Get Candidates (getCandidates)
│   │   ├── Primary + Fallbacks dari route config
│   │   ├── Explicit Provider Check (selectProvider)
│   │   │   ├── providerHint from request
│   │   │   ├── Model prefix (openrouter/, opencode/, etc)
│   │   │   └── Models array match
│   │   └── Return baseCandidates (flat list: primary → fallbacks)
│   ├── Sticky Cache Reorder (cache-aware-sticky)
│   └── Sequential Fallback Loop
│       ├── For each candidate (index 0):
│       │   ├── Create Adapter (createProvider)
│       │   ├── Build Routed Request
│       │   │   ├── Override model dengan target.model
│       │   │   ├── Inject __providerOrder, __openrouterProviders
│       │   │   └── Inject __reasoning jika enabled
│       │   ├── Apply Optimizers (RTK, Headroom, Caveman, Ponytail)
│       │   ├── Call adapter.chat() / adapter.stream()
│       │   │   ├── Adaptive Timeout
│       │   │   └── Health Tracking
│       │   ├── On Success: markHealthy, stickyCache, return response
│       │   └── On Error: classifyError, markFailure, cooldown, fallback
│       └── Exhausted: throw last error with attempts
│
├── Response
│   ├── OpenAI-Compatible format
│   ├── Telemetry Log (route, provider, model, latency, tokens, fallbackCount)
│   └── Headers: x-request-id, x-route, x-provider
```