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
# Menu interaktif (start/stop/restart/status/logs/headroom/debug/keluar)
# Tip: gunakan pwsh jika tersedia, fallback powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1
powershell -ExecutionPolicy Bypass -File scripts/manage.ps1

# Atau subcommand non-interaktif (CI-safe, exit 1 jika subcommand salah)
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1 start     # start router + headroom (log: logs/mini-routingai.log, pid: .mini-routingai.pid / .headroom.pid)
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1 stop      # stop router + headroom
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1 restart   # restart router + headroom
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1 status    # status gabungan router + headroom
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1 logs      # tail log
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1 help      # bantuan

# Atau via npm script
bun run start:bg
bun run stop
bun run restart
bun run status
bun run logs
bun run restart:all

# Debug headroom saja (standalone)
bun run headroom:start
bun run headroom:stop
bun run headroom:restart

# Lihat log live
Get-Content logs/mini-routingai.log -Tail 50 -Wait
```

Port default 3000 (`PORT` di `.env`). Ganti port: set `PORT` di `.env`.

Headroom proxy (opsional, debug sekadar — start/stop/restart sudah otomatis berjalan bersamaan router)

```powershell
# Debug sekar dijalankan router + headroom secara gabungan:
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1 headroom-start
# (jika perlu stop headroom saja)
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1 headroom-stop
# (jika perlu restart headroom saja)
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1 headroom-restart
```

Catatan: `start`/`stop`/`restart` di manage.ps1 **selalu** mengelola kedua router dan headroom bersamaan. 
Perintah `headroom-start/stop/restart` hanya untuk kasus debug/restart headroom stand-alone jika router mati atau perlu dipisah.

## Benchmark

```bash
bun run benchmark            # Phase 4: direct vs mini + Phase 5 RTK OFF vs ON + Phase 6 Headroom OFF vs ON (mock 15ms)
# Headroom benchmark butuh mock proxy otomatis; untuk real provider, set OPENROUTER_API_KEY di .env dan HEADROOM_URL
HEADROOM_URL=http://localhost:8787 bun run benchmark
```

## Providers (DeepSeek-Only, 2026-09-17)

MiniRoutingAI kini **hanya melayani `deepseek-v4-flash`** (single-model gateway).

- **juan** — `providers.json: juan → https://router.juan.web.id/v1` (`JUAN_API_KEY`, `deepseek-v4-flash`, `contextWindow:256000`, prioritized `primary` di `balanced`/`free`, weight 10).
- **opencode-go** — `https://opencode.ai/zen/go/v1` (`deepseek-v4-flash` saja, weight 9, `requiresSession:true`).
- **openrouter** — `https://openrouter.ai/api/v1` (`deepseek/deepseek-v4-flash-0731` via `open-inference/fp8`, weight 7).

Provider non-deepseek (`nvidia`, `ollama-cloud`, `opencode`) telah dihapus dari `config/providers.json`/`prices.json` pada migrasi deepseek-only. Untuk rollback lihat `docs/deepseek-only-migration.md`.

## Optimizers

- **RTK** — `config/routes.json: fast {rtk:false}` vs `balanced {rtk:true}` (tool_output dedup, git diff/grep, fail-open, duration <1ms)
 - **Headroom** — `config/routes.json: fast {headroom:false}` vs `balanced {headroom:true}` (context compression via `POST {HEADROOM_URL}/v1/compress`, threshold `minimumTokens:6000` + `minimumBytes:8000`, timeout 8000ms (adaptif +1.5ms/KB, cap 12000ms), `healthProbeMs:1000ms`, `cacheTtlMs:10000`, fail-open). Default `enabled:false`; `balanced` opt-in. Jalankan `headroom proxy --port 8787` sebelum benchmark real provider. Mode `token` (maksimalkan penghematan; benchmark: ±27% hemat, ~10ms setelah warm). Proxy dijalankan dengan `--mode token` oleh `scripts/manage.ps1`. Troubleshooting timeout: `powershell -File scripts/manage.ps1 status`, `Get-Content logs/headroom.log -Tail 50`, `curl http://localhost:3000/debug/headroom` & `curl http://localhost:8787/health`. Jika log berisi `SystemError: pydantic-core incompatible` (pydantic 2.13.5 butuh `pydantic-core==2.46.5`): jalankan `python -m pip install --force-reinstall "pydantic-core==2.46.5"` atau `pipx reinstall headroom-ai`.
- **Mini-Balanced** — alias virtual `mini-balanced`/`mini-balanced-cloud` → chain `balanced` (primary `juan/deepseek-v4-flash`, fallback `opencode-go/deepseek-v4-flash` → `openrouter/deepseek/deepseek-v4-flash-0731`). Flat sequential; `juan` prioritas tertinggi (weight 10).
- **Mini-Free** — alias virtual `mini-free` → chain `free` (kini identik dengan `balanced`, deepseek-only). Sebelumnya full-free (`openrouter/free` + `opencode` free) telah di-retire pada migrasi deepseek-only.

### Invarian Config (anti-regresi, dijaga `tests/anti-regresi.test.ts`)

- `config/*.json` mendukung **JSONC**: `//` komentar di awal baris, `/* block */`, dan trailing comma dibersihkan otomatis oleh gateway (`src/index.ts:stripJsonCommentsAndTrailingComma`, string-safe — koma dalam value `"..., }"` tidak dihapus).
- `headroom.timeoutMs >= 2 × healthProbeMs` dan `timeoutMs <= MAX_EFFECTIVE_TIMEOUT_MS (12000)`.
- Payload `bodyBytes > 4MB` → headroom skip (`payload_too_large_for_headroom`), RTK tetap jalan.
- Proxy definitif-down (connection refused) → cooldown singkat 5s (`DEFAULT_CONNECTION_DOWN_COOLDOWN_MS`), bukan 30s; auto-retry tanpa restart.
- Provider yang butuh `x-opencode-session`: set `"requiresSession": true` di `config/providers.json` (dipakai router, jangan hardcode id).
- `bunfig.toml` set `MINI_NO_LISTEN=1` saat `bun test` agar import `src/index.ts` tidak bind port 3000.