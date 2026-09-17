# Migrasi DeepSeek-Only — 2026-09-17

## Ringkasan
MiniRoutingAI diubah dari multi-model (nemotron, minimax, glm, gemini, free tier) menjadi **single-model gateway deepseek-v4-flash**.

**Alasan:** permintaan user untuk menyederhanakan biaya/latensi/observability dan memprioritaskan `deepseek-v4-flash` (terutama via `juan`).

## Perubahan Config

### `config/providers.json`
- Sebelum: 6 provider (`opencode-go` 2 models, `openrouter` 3 models, `nvidia`, `ollama-cloud`, `opencode` 3 models, `juan`).
- Sesudah: 3 provider deepseek-only:
  ```json
  { "id":"juan", "models":["deepseek-v4-flash"], "weight":10, "contextWindow":256000 }
  { "id":"opencode-go", "models":["deepseek-v4-flash"], "weight":9, "requiresSession":true }
  { "id":"openrouter", "models":["deepseek/deepseek-v4-flash-0731"], "weight":7 }
  ```
- `nvidia`, `ollama-cloud`, `opencode` dihapus hard (history git tetap menyimpan versi lama).
- `contextWindows` disederhanakan: hanya `deepseek-v4-flash:256000` (hapus `minimax-m3`).

### `config/routes.json`
- `balanced.primary`: `juan/deepseek-v4-flash` (weight 10) — prioritas tertinggi.
- `balanced.fallbacks`: `opencode-go/deepseek-v4-flash` (9) → `openrouter/deepseek/deepseek-v4-flash-0731` (7, pin `open-inference/fp8`).
- `free`: sebelumnya heterogen (`openrouter/free`, `nvidia`, `opencode` free) kini **identik dengan balanced** (deepseek-only). `mini-free` tetap berfungsi tapi kini mengarah ke deepseek.
- `healthAwareOrdering: false`, `minHealthyCandidates: 2` (flat sequential, urutan array = prioritas).

### `config/prices.json`
- Hapus `nvidia`, `ollama-cloud`, `opencode` (0.0). Sisakan `juan` (0.2/1.0), `opencode-go` (0.5/2.0), `openrouter` (0.0).

## Verifikasi
- `bun run scripts/check-juan.ts` → `YA` (window 256k)
- `bun test` → 136 pass 0 fail (update `tests/juan-mock.test.ts:173` untuk `minimax-m3` fallback ke default)
- Gateway live:
  - `POST /v1/chat/completions {model:"deepseek-v4-flash"}` → `200 x-provider: juan`
  - `POST {model:"mini-balanced"}` → `200 x-provider: juan`
  - `POST {model:"mini-free"}` → `200 x-provider: juan` (sebelumnya free tier)
  - `POST {model:"juan/deepseek-v4-flash"}` → `503 No available channel` (prefix explicit mengirim model `juan/deepseek-v4-flash` ke upstream, bukan `deepseek-v4-flash`; gunakan model tanpa prefix)

## Rollback
```bash
git checkout HEAD~1 -- config/providers.json config/routes.json config/prices.json
# atau restore dari git history
```

## Risiko Sisa
- Kehilangan redundansi heterogen: jika ketiga deepseek down → 502. Mitigasi: pertahankan monitoring `scripts/check-juan.ts --live`.
- `opencode-go` butuh `x-opencode-session`; jika client tidak mengirim, `juan` akan menangani (karena juan primary). Jika juan juga down, `opencode-go` akan 400 `missing session` sebelum fallback ke `openrouter` — sudah di-handle `isMissingSessionSignal`.
- Cache-aware-sticky: warm session akan menahan provider sukses sebelumnya di posisi 0 (override flat priority) hingga `sessionTtlMs:300000`.

## Cara Ganti Prioritas
Untuk prioritaskan `opencode-go` first (latensi 800ms terendah), tukar `balanced.primary` ↔ `fallbacks[0]`:
```json
primary: {provider:"opencode-go", model:"deepseek-v4-flash"}
fallbacks: [{provider:"juan", ...}, {provider:"openrouter", ...}]
```
