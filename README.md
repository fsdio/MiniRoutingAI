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
powershell -ExecutionPolicy Bypass -File scripts/manage.ps1

# Atau subcommand non-interaktif
powershell -ExecutionPolicy Bypass -File scripts/manage.ps1 start     # start (log: logs/mini-routingai.log, pid: .mini-routingai.pid)
powershell -ExecutionPolicy Bypass -File scripts/manage.ps1 stop      # stop
powershell -ExecutionPolicy Bypass -File scripts/manage.ps1 restart   # restart
powershell -ExecutionPolicy Bypass -File scripts/manage.ps1 status    # status
powershell -ExecutionPolicy Bypass -File scripts/manage.ps1 logs      # tail log

# Atau via npm script
bun run start:bg
bun run stop
bun run restart
bun run status
bun run logs

# Lihat log live
Get-Content logs/mini-routingai.log -Tail 50 -Wait
```

Port default 3000 (`PORT` di `.env`). Ganti port: set `PORT` di `.env`.

Headroom proxy (opsional, hanya jika `balanced` headroom:true dan mau real compress):

```powershell
# Start headroom proxy
powershell -ExecutionPolicy Bypass -File scripts/manage.ps1 headroom-start
# stop headroom
powershell -ExecutionPolicy Bypass -File scripts/manage.ps1 headroom-stop
```

## Benchmark

```bash
bun run benchmark            # Phase 4: direct vs mini + Phase 5 RTK OFF vs ON + Phase 6 Headroom OFF vs ON (mock 15ms)
# Headroom benchmark butuh mock proxy otomatis; untuk real provider, set OPENROUTER_API_KEY di .env dan HEADROOM_URL
HEADROOM_URL=http://localhost:8787 bun run benchmark
```

## Providers

- **Ollama Cloud** — `providers.json: ollama-cloud → https://ollama.com/v1` (dinamis via `OLLAMA_CLOUD_BASE_URL` di `.env`, butuh `OLLAMA_CLOUD_API_KEY`). Model cloud: `nemotron-3-ultra:cloud`, `gemma4:31b`.

## Optimizers

- **RTK** — `config/routes.json: fast {rtk:false}` vs `balanced {rtk:true}` (tool_output dedup, git diff/grep, fail-open, duration <1ms)
- **Headroom** — `config/routes.json: fast {headroom:false}` vs `balanced {headroom:true}` (context compression via `POST {HEADROOM_URL}/v1/compress`, threshold `minimumTokens:4000`, timeout 6000ms, fail-open). Default `enabled:false`; `balanced` opt-in. Jalankan `headroom proxy --port 8787` sebelum benchmark real provider. Mode `token` (maksimalkan penghematan; benchmark: ±27% hemat, ~10ms setelah warm). Proxy dijalankan dengan `--mode token` oleh `scripts/manage.ps1`.