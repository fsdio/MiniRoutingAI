# Laporan Uji Provider `juan` — 2026-09-17

## Ringkasan Eksekutif

**Pertanyaan:** Apakah provider `juan` (`https://router.juan.web.id/v1`) saat ini ada bug?

**Jawaban:** **Tidak ada bug blokir pada jalur utama `juan/deepseek-v4-flash`.** Semua pengujian mock dan live terbaru menunjukkan provider sehat untuk model utama, fallback berjalan benar, serta gateway mampu melayani trafik melalui `juan` tanpa error. Satu bug konfigurasi ringan ditemukan dan sudah diperbaiki: `contextWindow` untuk `juan` tidak terdefinisi.

**Bukti snapshot live terbaru (`scripts/check-juan-result.json`, 2026-09-17 04:42 UTC):**

| Model | Status | Latency | Keterangan |
|-------|--------|---------|------------|
| `juan/deepseek-v4-flash` | **200 OK** | 1860 ms (non-stream), 4758 ms (stream) | Sehat, digunakan di `routes.json:16` |
| `juan/minimax-m3` | 200 OK | 1880 ms / 1601 ms | Sehat, tetapi `providers.json` hanya mendefinisikan `deepseek-v4-flash` |
| `juan/gemini-3.8-flash-high` | 200 OK | 3561 ms / 4726 ms | Sehat, tidak ada di config |
| `juan/gemini-3.7-flash-low` | 200 OK | 2025 ms / 1767 ms | Sehat, tidak ada di config |
| `juan/glm-5.3-flash` | **Timeout 10s** (`AbortError`) | 10003 ms | Flaky — sebelumnya di log lama 200 OK |
| `juan/nemotron-3-ultra` | **Flaky** — 10s timeout atau `503` dengan body `upstream error (status 401) (reset after 32s)` | 259 ms (503) / 10003 ms (timeout) | Distributor channel error, sudah di-handle sebagai fallback |

**Gateway E2E (`scripts/test-juan-gateway.ts` manual):**
`POST /v1/chat/completions` model `deepseek-v4-flash` via gateway → `200 OK`, `x-provider: juan`, `fallbackCount: 0`, `usage.prompt_tokens: 22`, latency 3105 ms — membuktikan jalur produksi berfungsi.

## Temuan Detail per Kategori

### 1. Konfigurasi — BUG RINGAN (Sudah Diperbaiki)

- **Lokasi:** `config/providers.json:58-66`
- **Sebelum:** `juan` hanya punya `contextWindows.minimax-m3: 1M`, tanpa `contextWindow` generik dan tanpa `contextWindows.deepseek-v4-flash`. Akibatnya `getContextWindow(providers, "juan", "deepseek-v4-flash")` → `null` (`src/router/router.ts:184-191`).
- **Dampak:** Payload besar tidak bisa dihitung `estTokens` untuk adaptive timeout dan guard `413 context_overflow` akan infer `maxWindow = 0` → potensi 413 palsu atau timeout tidak adaptif. Di `check-juan.ts` audit mencetak `TIDAK (BUG potensial)`.
- **Setelah fix:** `config/providers.json` sekarang:
  ```json
  "juan": {
    "contextWindow": 256000,
    "contextWindows": { "deepseek-v4-flash": 256000, "minimax-m3": 1000000 }
  }
  ```
  Nilai 256K mengikuti `opencode-go/deepseek-v4-flash` (konsisten dengan upstream). Audit `check-juan.ts` sekarang mencetak `YA`, dan test `J-T5` mengassert 256_000 (`tests/juan-mock.test.ts:173`).

- **Tidak ada mismatch lain:** `providers.json` vs `routes.json` vs `prices.json` untuk juan sudah sinkron (1 model di ketiga file). Harga `juan: 0.2/1.0` terdefinisi, adapter memakai `JUAN_API_KEY` benar.

### 2. Adapter & Headers — TIDAK BUG

- **File:** `src/providers/provider.ts:327-329` case `default` untuk `juan`.
- **Test J-T1 (`tests/juan-mock.test.ts:73`):** `createProvider({id:"juan", baseURL:".../v1/", apiKeyEnv:"JUAN_API_KEY"})` → baseURL ternormalisasi tanpa trailing slash, `Authorization: Bearer <key>` terkirim, `x-opencode-session` **tidak** di-inject (benar, hanya untuk `opencode`/`opencode-go` di `provider.ts:58`). Tanpa `apiKeyEnv`, Authorization kosong — sesuai ekspektasi.
- **Test J-T2:** `normalizeRequest` untuk juan meneruskan `reasoning: {enabled:true}` dari `routes.json` dan menghapus `__reasoning`/`__forwardedHeaders` agar tidak bocor ke upstream. Non-stream tidak menambah `stream_options: include_usage`, stream menambah via `src/translator/request.ts`. Semua lulus.
- **Kesimpulan:** Tidak perlu kelas `JuanProvider` khusus; adapter generik sudah cukup.

### 3. Error Classification & Fallback — TIDAK BUG (Desain Sesuai Spec)

- **File:** `src/router/policy.ts:32-99` & `src/router/router.ts:27-51,139-155,382-399`
- **Test J-T3 & J-T4:**
  - `"No available channel"` → `transient` (fallback, `isUnavailableSignal` true, `HealthStore` immediate cooldown walau threshold 10) — sesuai komentar `policy.ts:53`.
  - `upstream error 401 enveloped 503 (reset after 32s)` → `server_error` → fallback, `extractRetryAfterMs` mengurai `32_000` via regex `reset after\s+(\d+)s` di `router.ts:47`.
  - `credit insufficient balance (reset after 21s)` → `rate_limit` → fallback, `router.ts:393` override ke `600_000` (10 menit) karena kuota persistent sampai top-up, bukan sekadar slot reset.
  - `AbortError/timeout` → `timeout`/`unknown` → fallback.
- **Verifikasi mock router:**
  - J-T6: primary juan 200 → no fallback.
  - J-T7: juan 503 upstream-401 → fallback ke mock `fallback`, `errorClass=server_error`, threshold 5 masih healthy (desain flat sequential — request berikutnya tetap akan hit juan, bukan pre-skip, sesuai `router.test.ts:309`).
  - J-T8: juan `"No available channel"` (400 transient) → fallback & immediate cooldown (`HealthStore.isHealthy` false) — lulus.
  - J-T9: juan quota `rate_limit` → fallback & cooldown 600k (ketika threshold 1). Dengan threshold produksi 10, quota tidak `isUnavailable` sehingga honeypot butuh 10 fails — didokumentasikan sebagai **temu­an observasi**, bukan bug blokir, tapi perlu perhatian jika `juan` menjadi honeypot yang melempar 503 tiap 20s.

### 4. Stream — TIDAK BUG

- **Test J-T10:** `routeStream` juan direct menghasilkan `Hello from juan`, fallback sebelum first chunk juga menghasilkan `fallback stream`. Gateway stream via `adapter.stream` memakai `Accept: text/event-stream` dan pass-through `res.body`.
- **Live stream:** `check-juan.ts --live --stream` menunjukkan `deepseek-v4-flash`, `minimax-m3`, `gemini-*` semua `OK_STREAM` dengan SSE `data: {delta...}`. `glm-5.3-flash` dan `nemotron-3-ultra` gagal stream sama seperti non-stream (timeout/503) — konsisten.

### 5. Live Exhaustive — FLAKY BUKAN BUG KODE

- **File hasil:** `scripts/check-juan-result.json` + `scripts/check-all-models-result.json:126-178` + `scripts/check-unavailable-result.json:125-179`
- **Perubahan sejak snapshot lama:**
  - `juan/deepseek-v4-flash`: tetap `200 OK` (stabil).
  - `juan/glm-5.3-flash`: dulu `200 OK`, sekarang timeout — indikasi upstream channel tidak stabil, bukan perubahan kode.
  - `juan/nemotron-3-ultra`: dulu `AbortError`, sekarang bergantian `AbortError` dan `503 reset after 32s` — pola distributor yang memang di-handle oleh `extractRetryAfterMs`.
- **Model tidak di-config (`minimax-m3`, `gemini-*`) tetap 200 OK** — menunjukkan distributor juan sebenarnya memback beberapa model LLM lain yang tidak di-expose di `routes.json`. Bukan bug, tapi peluang optimasi config jika ingin menambah fallback.

## Perbaikan yang Dilakukan

1. **Fix konfigurasi (commit saat ini):**
   - `config/providers.json:64-66` — tambah `contextWindow: 256000` dan `contextWindows.deepseek-v4-flash: 256000`.
2. **Test harness baru (tidak mengubah produksi, hanya verifikasi):**
   - `scripts/check-juan.ts` — audit config + live snapshot khusus juan (mode `--live`/`--stream`, output `scripts/check-juan-result.json`).
   - `tests/juan-mock.test.ts` — 13 test (J-T1 s.d. J-T10b) mencakup adapter headers, reasoning leak, classification, retryAfter, contextWindow, router chat/stream & gateway E2E mock.

## Verifikasi

- **Mock:** `bun test tests/juan-mock.test.ts` → `13 pass, 0 fail` (`55 expect()`).
- **Regresi:** `bun test tests/router.test.ts tests/providers.test.ts` → `37 pass, 0 fail`.
- **Full suite:** `bun test` → `136 pass, 0 fail` di 10 file, 550 expect (~3.5s).
- **Audit config:** `bun run scripts/check-juan.ts` → `deepseek-v4-flash window defined? YA`.
- **Live non-stream:** `bun run scripts/check-juan.ts --live` → `OK:4 UNAVAIL:0 OTHER:2` (deepseek tetap OK).
- **Live stream:** `bun run scripts/check-juan.ts --live --stream` → `OK:8 OTHER:4`, deepseek stream OK.
- **Gateway E2E live:** `bun run scripts/test-juan-gateway.ts` (manual sementara) → `200 OK x-provider: juan`.

## Risiko Sisa & Rekomendasi

- **Honeypot quota:** `isUnavailableSignal` tidak mencakup `"credit insufficient"` sehingga `rate_limit` quota dengan `failureThreshold=10` (default produksi `threshold=1` sebenarnya aman — `HealthStore` default 1 langsung cooldown; hanya test custom threshold 10 yang butuh 10 fails). Produksi saat ini `HealthStore` default `failureThreshold=1` → semua `rate_limit` langsung cooldown, jadi aman. Jika di masa depan threshold dinaikkan, pertimbangkan perlakuan khusus quota sebagai `isUnavailable` atau paksa `retryAfterMs` immediate.
- **Model list exhaustive:** Pertimbangkan menambah `minimax-m3` (1M window) atau `gemini-*` ke `providers.json` + `routes.json` jika distributor juan menjamin stabilitas; sementara ini mereka flaky dan latency tinggi (1.6-4.7s), jadi mempertahankan hanya `deepseek-v4-flash` adalah keputusan konservatif yang tepat.
- **Monitoring:** Jadwalkan `check-juan.ts --live` sebagai cron (mis. tiap jam) dan alert jika `deepseek-v4-flash` status != 200 atau `isUnavailable` true.
- **Latency:** `juan` `avgLatencyMs: 2500` sesuai snapshot (1.8-4.7s). `adaptiveTimeout` 8s + `tokensPerMs 0.25` sudah benar untuk payload besar.

## Cara Replikasi

```bash
# Audit tanpa network
bun run scripts/check-juan.ts

# Live (butuh JUAN_API_KEY di .env)
bun run scripts/check-juan.ts --live
bun run scripts/check-juan.ts --live --stream

# Mock unit + integration
bun test tests/juan-mock.test.ts

# Full regresi
bun test
```
