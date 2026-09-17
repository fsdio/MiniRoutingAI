# Client Setup

## OpenCode Client Setup (Wajib untuk Free Tier)

```text
OpenCode Client (Desktop/CLI/VSCode)
│
├── Authentication
│   ├── Login via OpenCode → Generate x-opencode-session (internal)
│   └── Session TIDAK bisa di-generate oleh MiniRoutingAI
│
├── Configuration
│   ├── ~/.config/opencode/config.json
│   │   └── { "api": { "baseURL": "http://localhost:3000/v1" }, "model": "mini-free" }
│   └── VSCode: settings.json → "opencode.api.baseURL": "http://localhost:3000/v1"
│
├── Headers Otomatis dari Client
│   ├── x-opencode-session: sess_... (wajib untuk free tier)
│   ├── x-opencode-client: desktop | vscode | cli
│   ├── x-opencode-version: x.x.x
│   └── x-opencode-machine-id: uuid (opsional)
│
├── Flow Request
│   ├── OpenCode → MiniRoutingAI (/v1/chat/completions)
│   ├── MiniRoutingAI extract headers → __forwardedHeaders
│   ├── Route resolution: "mini-free" → route "free"
│   ├── Primary: openrouter/free (butuh OPENROUTER_API_KEY)
│   ├── Fallbacks: ollama-cloud, opencode free models, nvidia
│   │   └── opencode free models butuh x-opencode-session (sudah dari client)
│   └── Response → OpenCode Client
│
└── Troubleshooting
    ├── 400 "missing x-opencode-session" → Client belum login/config baseURL salah
    ├── 400 "free tier restricted" → Session tidak valid/expired
    └── Fallback ke ollama-cloud/openrouter → Session tidak dikirim
```

## Generic OpenAI Client (Cursor, Continue, dll)

```text
Generic Client
│
├── Config: baseURL = http://localhost:3000/v1, apiKey = "dummy"
├── Model: "mini-free" atau "mini-balanced"
├── Tidak kirim x-opencode-session → Free tier opencode TIDAK tersedia
├── Fallback otomatis ke provider non-opencode (openrouter, ollama-cloud, nvidia)
└── Balanced route: juan/gpt-4o primary (butuh JUAN_API_KEY)
```