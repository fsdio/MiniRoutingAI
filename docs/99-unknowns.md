# Unknowns & Technical Debt

## High Priority

```text
Provider ID Canonicalization
└── providers.json masih mengandung legacy IDs: "mini-9router", "MiniRoutingAI"
    ├── Kanonik: "mini-routingai" (project) / display "MiniRoutingAI"
    ├── loadJson() memvalidasi dan warn tapi tidak auto-fix
    └── Action: Hapus alias legacy dari providers.json, update docs

Health-Aware Ordering Inconsistency
└── routes.json: healthAwareOrdering=true, minHealthyCandidates=2/3
    ├── router.ts:129-130 komentar "Health-aware ordering dinonaktifkan: flat list tanpa guard pre-skip"
    ├── getCandidates() mengabaikan weight/healthAwareOrdering/minHealthyCandidates
    ├── policy.ts:sortCandidatesByHealth() dan selectWeightedRandom() masih exist tapi @deprecated
    └── Unknown: Apakah health-aware ordering akan di-enable kembali? Jika ya, butuh refactor getCandidates()

Deprecated selectWeightedRandom()
└── policy.ts:181-199 @deprecated "Flat sequential refactor"
    ├── Masih diexport, tidak dipakai mana-mana
    ├── Masih ada test coverage? (perlu cek)
    └── Action: Hapus atau pindah ke legacy folder jika tidak dipakai
```

## Medium Priority

```text
Optimization Config Structure (config/optimization.json)
└── loadJson() load tapi struktur tidak terdokumentasi di docs/
    ├── optimization.optimizers.{rtk,headroom,caveman,ponytail} boolean/string
    ├── optimization.headroom.{enabled,url,timeoutMs,minTokens,healthProbeMs,cacheTtl,circuitBreaker}
    ├── Optimizer pipeline (src/optimizer/pipeline.ts) apply order: RTK → Headroom → Caveman → Ponytail
    └── Unknown: Valid values per field, interaction antar optimizer, default values

Headroom Proxy External Dependency
└── HEADROOM_URL=http://localhost:8787 (opsional, fail-open)
    ├── headroom-ai 0.37.0 via pipx, butuh pydantic-core==2.46.5 (version lock)
    ├── Jika tidak jalan: balanced route headroom:true skip dengan reason "missing_url"
    ├── Timeout 4000ms sinkron dengan config/optimization.json
    ├── Circuit breaker: 2 fails → cooldown 30s
    └── Unknown: Production deployment strategy (sidecar? separate VM? health check endpoint?)

OpenCode Free Tier Session Validation
└── x-opencode-session wajib untuk opencode free models
    ├── Session HANYA bisa di-generate OpenCode client (Desktop/CLI/VSCode)
    ├── MiniRoutingAI TIDAK bisa validate session sebelum forward ke upstream
    ├── Jika session invalid/expired: upstream return 400 "free tier restricted"
    ├── Fallback otomatis ke ollama-cloud/nvidia/openrouter (non-opencode)
    └── Unknown: Apakah perlu endpoint /health/check-session untuk client pre-check?

Token Estimation Accuracy
└── estTokens = Buffer.byteLength(JSON.stringify(request), "utf-8") / 4
    ├── Rough estimation, tidak pakai tokenizer sebenarnya (tiktoken)
    ├── Digunakan untuk: adaptive timeout, headroom payload cap, context overflow guard
    ├── Error margin bisa besar untuk message dengan banyak tool calls / struktur kompleks
    └── Unknown: Apakah butuh integrasi tokenizer yang benar (gpt-tokenizer / tiktoken)?

RTK/Headroom/Caveman/Ponytail Interaction
└── 4 optimizer berurutan: RTK → Headroom → Caveman → Ponytail
    ├── RTK: kompres tool output (savedBytes ~10%)
    ├── Headroom: proxy kompresi (savedBytes variabel, butuh proxy jalan)
    ├── Caveman: singkatan prompt (lite mode)
    ├── Ponytail: singkatan response (lite mode)
    ├── Order dependency: Headroom butuh RTK output? Caveman butuh Headroom output?
    ├── Token accounting (accounting.ts) track savedBytes per optimizer
    └── Unknown: Combined effect measurement, optimal config per route/model
```

## Low Priority / Future Consideration

```text
Testing Coverage
└── Tidak ada formal test framework (vitest/jest)
    ├── Hanya scripts/*.ts untuk manual/integration testing
    ├── scripts/test-opencode*.ts, test-openrouter-pin.ts, benchmark*.ts
    ├── tests/router.test.ts exist tapi coverage unknown
    └── Action: Setup vitest, add unit tests untuk resolveRouteKeyForModel, getCandidates, selectProvider

Provider Fallback When Session Missing
└── opencode free models butuh session, tapi client generic (Cursor/Continue) tidak kirim
    ├── route free: primary openrouter/free (no session), fallback opencode models (need session)
    ├── Jika client tidak kirim session → opencode fallbacks gagal "missing x-opencode-session"
    ├── HealthStore markFailure → cooldown → skip next round
    └── Unknown: Apakah perlu filter fallbacks yang butuh session jika request tidak punya session?

Config Hot Reload
└── Config di-load sekali di startup (index.ts)
    ├── Perubahan config/providers.json, routes.json butuh restart server
    ├── Tidak ada SIGHUP / file watcher untuk reload
    └── Unknown: Production requirement untuk zero-downtime config update?

Observability Completeness
├── Telemetry: /metrics (Prometheus), /debug/routes, structured JSON logs
├── Missing: Distributed tracing (OpenTelemetry), request/response body sampling
├── Log correlation: requestId di-pass tapi tidak ada trace ID propagation
└── Unknown: Integration dengan existing monitoring stack (Grafana/Datadog/NewRelic)?

Error Classification Completeness
└── classifyError() di policy.ts cover: transient, credential, rate_limit, timeout, server_error, context_overflow, deterministic
    ├── "unavailable" detection via string matching (fragile)
    ├── Provider-specific error codes tidak dinormalisasi
    └── Unknown: Apakah butuh error taxonomy formal per provider?
```

## Configuration Unknowns

```text
config/prices.json
└── Struktur: { prices: { "openrouter": { "deepseek/deepseek-v4-flash-0731": { input: 0.14, output: 0.28 } } } }
    ├── Hanya openrouter yang ada entry-nya
    ├── Digunakan di mana? (accounting.ts? telemetry?)
    └── Unknown: Apakah pricing untuk provider lain diperlukan?

config/routes.json - reasoning route
└── routes.reasoning exist tapi tidak terdokumentasi
    ├── Strategy sama tapi primary/fallbacks dengan reasoning.enabled=true
    ├── Model hints untuk reasoning tidak jelas
    └── Unknown: Kapan route ini dipilih? Via model hint "reasoning" atau explicit?
```