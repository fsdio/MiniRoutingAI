# MiniRoutingAI

Lightweight Bun + TypeScript LLM gateway — OpenAI-compatible.

## Quick Start

```bash
cp .env.example .env
# isi API keys di .env
bun install
bun run dev
```

Server: `http://localhost:3000`

- `POST /v1/chat/completions` — OpenAI-compatible (streaming & non-streaming)
- `GET /health`
- `GET /metrics`
- `GET /debug/routes`

## Menjalankan di Background (Windows)

Gateway dirancang sebagai 1 proses lokal ringan. Untuk jalan terus di background tanpa jaga terminal:

```powershell
# Menu interaktif (start/stop/restart/status/logs/headroom/keluar)
# Tip: gunakan pwsh jika tersedia, fallback powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1
powershell -ExecutionPolicy Bypass -File scripts/manage.ps1

# Atau subcommand non-interaktif (CI-safe, exit 1 jika subcommand salah)
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1 start     # start (log: logs/mini-routingai.log, pid: .mini-routingai.pid)
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1 stop      # stop
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1 restart   # restart
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1 restart-all # restart gateway + headroom
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1 status    # status
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1 logs      # tail log
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1 help      # bantuan

# Atau via npm script
bun run start:bg
bun run stop
bun run restart
bun run status
bun run logs
bun run headroom:start
bun run headroom:stop
bun run headroom:restart
bun run restart:all

# Lihat log live
Get-Content logs/mini-routingai.log -Tail 50 -Wait
```

Port default 3000 (`PORT` di `.env`). Ganti port: set `PORT` di `.env`.

Headroom proxy (opsional, hanya jika `balanced` headroom:true dan mau real compress):

```powershell
# Start headroom proxy (discovery portabel via $env:USERPROFILE/$env:LOCALAPPDATA/pipx, cek port 8787)
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1 headroom-start
# stop headroom
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1 headroom-stop
# restart headroom
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1 headroom-restart
# Validasi: jika path typo /script/manage.ps1 dipakai, script akan warning dan arahkan ke scripts/manage.ps1
```

## Benchmark

```bash
bun run benchmark            # Phase 4: direct vs mini + Phase 5 RTK OFF vs ON + Phase 6 Headroom OFF vs ON (mock 15ms)
# Headroom benchmark butuh mock proxy otomatis; untuk real provider, set OPENROUTER_API_KEY di .env dan HEADROOM_URL
HEADROOM_URL=http://localhost:8787 bun run benchmark
```

## Providers

- **Ollama Cloud** — `providers.json: ollama-cloud → https://ollama.com/v1` (dinamis via `OLLAMA_CLOUD_BASE_URL` di `.env`, butuh `OLLAMA_CLOUD_API_KEY`). Model cloud: `nemotron-3-ultra:cloud`, `gemma4:31b`.
- **Console Go (`opencode-go`)** — `https://opencode.ai/zen/go/v1` membutuhkan `x-opencode-session` (lihat https://opencode.ai/docs/go/#where-can-i-use-it). Gateway meneruskan `x-opencode-session`/`x-opencode-client` dari client; jika header tidak ada, `mini-balanced` otomatis fallback ke `ollama-cloud`/`openrouter` tanpa error.
- **OpenCode Free** — `https://opencode.ai/zen/v1` tidak butuh session, kirim `x-opencode-client: desktop`.

## Optimizers

- **RTK** — `config/routes.json: fast {rtk:false}` vs `balanced {rtk:true}` (tool_output dedup, git diff/grep, fail-open, duration <1ms)
 - **Headroom** — `config/routes.json: fast {headroom:false}` vs `balanced {headroom:true}` (context compression via `POST {HEADROOM_URL}/v1/compress`, threshold `minimumTokens:6000` + `minimumBytes:8000`, timeout 8000ms (adaptif +1.5ms/KB, cap 12000ms), `healthProbeMs:1000ms`, `cacheTtlMs:10000`, fail-open). Default `enabled:false`; `balanced` opt-in. Jalankan `headroom proxy --port 8787` sebelum benchmark real provider. Mode `token` (maksimalkan penghematan; benchmark: ±27% hemat, ~10ms setelah warm). Proxy dijalankan dengan `--mode token` oleh `scripts/manage.ps1`. Troubleshooting timeout: `powershell -File scripts/manage.ps1 status`, `Get-Content logs/headroom.log -Tail 50`, `curl http://localhost:3000/debug/headroom` & `curl http://localhost:8787/health`.
- **Mini-Balanced** — alias virtual `mini-balanced`/`mini-balanced-cloud` → chain `balanced` (primary `ollama-cloud`, fallback `opencode-go`, `opencode`, `openrouter`...). Saat `x-opencode-session` ada, gateway meneruskannya ke `opencode-go` (Console Go); jika tidak ada, `opencode-go` diskip otomatis agar tidak `missing x-opencode-session`.
- **Mini-Free** — alias virtual `mini-free` → chain `free` (`config/routes.json`): primary `opencode` (zen/v1 `*-free`), fallback `openrouter` varian `*:free`. Semua kandidat full-free; dipilih saat `x-opencode-session` tersedia untuk model `opencode`, selain itu `openrouter :free`.

### Invarian Config (anti-regresi, dijaga `tests/anti-regresi.test.ts`)

- `config/*.json` mendukung **JSONC**: `//` komentar di awal baris, `/* block */`, dan trailing comma dibersihkan otomatis oleh gateway (`src/index.ts:stripJsonCommentsAndTrailingComma`, string-safe — koma dalam value `"..., }"` tidak dihapus).
- `headroom.timeoutMs >= 2 × healthProbeMs` dan `timeoutMs <= MAX_EFFECTIVE_TIMEOUT_MS (12000)`.
- Payload `bodyBytes > 4MB` → headroom skip (`payload_too_large_for_headroom`), RTK tetap jalan.
- Proxy definitif-down (connection refused) → cooldown singkat 5s (`DEFAULT_CONNECTION_DOWN_COOLDOWN_MS`), bukan 30s; auto-retry tanpa restart.
- Provider yang butuh `x-opencode-session`: set `"requiresSession": true` di `config/providers.json` (dipakai router, jangan hardcode id).
- `bunfig.toml` set `MINI_NO_LISTEN=1` saat `bun test` agar import `src/index.ts` tidak bind port 3000.