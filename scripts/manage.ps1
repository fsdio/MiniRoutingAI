# scripts/manage.ps1 — Menu manajemen MiniRoutingAI (Windows + Bun)
# Penggunaan:
#   powershell -ExecutionPolicy Bypass -File scripts/manage.ps1          # menu interaktif
#   powershell -ExecutionPolicy Bypass -File scripts/manage.ps1 start    # subcommand non-interaktif
#   powershell -ExecutionPolicy Bypass -File scripts/manage.ps1 stop
#   powershell -ExecutionPolicy Bypass -File scripts/manage.ps1 restart
#   powershell -ExecutionPolicy Bypass -File scripts/manage.ps1 status
#   powershell -ExecutionPolicy Bypass -File scripts/manage.ps1 logs
#   powershell -ExecutionPolicy Bypass -File scripts/manage.ps1 headroom-start
#   powershell -ExecutionPolicy Bypass -File scripts/manage.ps1 headroom-stop
# Log: logs/mini-routingai.log | PID: .mini-routingai.pid / .headroom.pid

param([string]$Command = "")

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $Root

$LogDir = Join-Path $Root "logs"
$RouterPidFile = Join-Path $Root ".mini-routingai.pid"
$RouterLogFile = Join-Path $LogDir "mini-routingai.log"
$HeadroomPidFile = Join-Path $Root ".headroom.pid"
$HeadroomLogFile = Join-Path $LogDir "headroom.log"
$DefaultPort = 3000

function Get-RouterPort {
  if ($env:PORT) { return [int]$env:PORT }
  if (Test-Path (Join-Path $Root ".env")) {
    $m = Select-String -Path (Join-Path $Root ".env") -Pattern '^\s*PORT\s*=\s*(\d+)' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($m -and $m.Matches[0].Groups[1].Success) { return [int]$m.Matches[0].Groups[1].Value }
  }
  return $DefaultPort
}

function Start-Router {
  $port = Get-RouterPort

  # Migrasi pid legacy mini-9router -> mini-routingai
  $LegacyPidFile = Join-Path $Root ".mini-9router.pid"
  if (Test-Path $LegacyPidFile) {
    try {
      Write-Host "[mini-routingai] Migrasi: ditemukan pid legacy .mini-9router.pid -> .mini-routingai.pid" -ForegroundColor Yellow
      $legacyContent = (Get-Content $LegacyPidFile -Raw).Trim()
      if ($legacyContent -and -not (Test-Path $RouterPidFile)) {
        Copy-Item $LegacyPidFile $RouterPidFile -Force
        Write-Host "[mini-routingai] Migrasi pid selesai" -ForegroundColor Gray
      }
      Remove-Item $LegacyPidFile -Force -ErrorAction SilentlyContinue
      Write-Host "[mini-routingai] Legacy pid file dihapus" -ForegroundColor Gray
    } catch { Write-Host "[mini-routingai] Gagal migrasi pid legacy: $_" -ForegroundColor Yellow }
  }

  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

  if (Test-Path $RouterPidFile) {
    $oldPid = (Get-Content $RouterPidFile -Raw).Trim()
    if ($oldPid) {
      $proc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
      if ($proc) {
        Write-Host "[mini-routingai] Sudah berjalan (PID $oldPid). Gunakan menu Stop dulu." -ForegroundColor Yellow
        try { $h = Invoke-WebRequest -Uri "http://localhost:${port}/health" -UseBasicParsing -TimeoutSec 2; Write-Host "[mini-routingai] Health: $($h.Content)" -ForegroundColor Green } catch {}
        return
      } else {
        Remove-Item $RouterPidFile -Force -ErrorAction SilentlyContinue
      }
    }
  }

  try { $null = Get-Command bun -ErrorAction Stop } catch {
    Write-Host "[mini-routingai] ERROR: 'bun' tidak ditemukan di PATH. Install dari https://bun.sh" -ForegroundColor Red
    return
  }

  if (-not (Test-Path ".env")) {
    if (Test-Path ".env.example") {
      Write-Host "[mini-routingai] .env tidak ada, buat dari .env.example" -ForegroundColor Yellow
      Copy-Item ".env.example" ".env" -Force
      Write-Host "[mini-routingai] .env dibuat, silakan isi API keys di .env" -ForegroundColor Gray
    }
  }

  Write-Host "[mini-routingai] Starting di background..." -ForegroundColor Cyan
  Write-Host "  Root: $Root"
  Write-Host "  Log : $RouterLogFile"
  Write-Host "  Port: $port"

  $psArgs = "-NoProfile -ExecutionPolicy Bypass -Command `"Set-Location '$Root'; bun run src/index.ts 2>&1 | Tee-Object -FilePath '$RouterLogFile' -Append`""
  try {
    $proc = Start-Process -FilePath "powershell" -ArgumentList $psArgs -WindowStyle Hidden -PassThru
    $proc.Id | Set-Content $RouterPidFile -Encoding utf8
    Write-Host "[mini-routingai] PID $($proc.Id) disimpan ke .mini-routingai.pid" -ForegroundColor Green
  } catch {
    Write-Host "[mini-routingai] Gagal Start-Process, coba fallback Start-Job..." -ForegroundColor Yellow
    $job = Start-Job -ScriptBlock { Set-Location $using:Root; bun run src/index.ts }
    $job.Id | Set-Content $RouterPidFile -Encoding utf8
    Write-Host "[mini-routingai] Job $($job.Id) disimpan" -ForegroundColor Green
  }

  Write-Host "[mini-routingai] Menunggu health..." -ForegroundColor Gray
  for ($i = 0; $i -lt 6; $i++) {
    Start-Sleep -Seconds 1
    try {
      $r = Invoke-WebRequest -Uri "http://localhost:${port}/health" -UseBasicParsing -TimeoutSec 2
      if ($r.StatusCode -eq 200) {
        Write-Host "[mini-routingai] Health OK: $($r.Content)" -ForegroundColor Green
        Write-Host "[mini-routingai] Gateway: http://localhost:${port}" -ForegroundColor Green
        Write-Host "[mini-routingai] Metrics: http://localhost:${port}/metrics" -ForegroundColor Gray
        Write-Host "[mini-routingai] Log tail: Get-Content ${RouterLogFile} -Tail 20 -Wait" -ForegroundColor Gray
        return
      }
    } catch { Start-Sleep -Milliseconds 500 }
  }
  Write-Host "[mini-routingai] Health belum OK setelah 6s, cek log: ${RouterLogFile}" -ForegroundColor Yellow
  Get-Content $RouterLogFile -Tail 30 -ErrorAction SilentlyContinue | Write-Host -ForegroundColor Gray
}

function Stop-Router {
  $ErrorActionPreference = "SilentlyContinue"

  if (-not (Test-Path $RouterPidFile)) {
    Write-Host "[mini-routingai] PID file tidak ada, cari proses bun..." -ForegroundColor Yellow
    $procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*bun*src/index.ts*" }
    if ($procs) {
      foreach ($p in $procs) {
        Write-Host "[mini-routingai] Ditemukan PID $($p.ProcessId): $($p.CommandLine)" -ForegroundColor Gray
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Host "[mini-routingai] Dihentikan PID $($p.ProcessId)" -ForegroundColor Green
      }
    } else {
      Write-Host "[mini-routingai] Tidak ada proses bun terdeteksi. Cek manual: Get-Process bun,powershell" -ForegroundColor Gray
    }
    return
  }

  $pidStr = (Get-Content $RouterPidFile -Raw).Trim()
  if (-not $pidStr) {
    Remove-Item $RouterPidFile -Force
    Write-Host "[mini-routingai] PID file kosong, dihapus" -ForegroundColor Yellow
    return
  }

  $targetPid = 0
  if ([int]::TryParse($pidStr, [ref]$targetPid)) {
    $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
    if ($proc) {
      Write-Host "[mini-routingai] Menghentikan PID $targetPid ($($proc.ProcessName))..." -ForegroundColor Cyan
      $children = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $targetPid }
      foreach ($c in $children) {
        try { Stop-Process -Id $c.ProcessId -Force; Write-Host "[mini-routingai] Child $($c.ProcessId) dihentikan" -ForegroundColor Gray } catch {}
      }
      Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 1
      if (-not (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) {
        Write-Host "[mini-routingai] Dihentikan" -ForegroundColor Green
      } else {
        Write-Host "[mini-routingai] Gagal hentikan, coba taskkill" -ForegroundColor Red
        taskkill /PID $targetPid /T /F | Out-Null
      }
    } else {
      Write-Host "[mini-routingai] PID $targetPid sudah tidak ada" -ForegroundColor Yellow
    }
    Remove-Item $RouterPidFile -Force -ErrorAction SilentlyContinue
    Write-Host "[mini-routingai] PID file dihapus" -ForegroundColor Gray
  } else {
    try {
      $job = Get-Job -Id $targetPid -ErrorAction SilentlyContinue
      if ($job) { Stop-Job $job -ErrorAction SilentlyContinue; Remove-Job $job -Force; Write-Host "[mini-routingai] Job dihentikan" -ForegroundColor Green }
    } catch {}
    Remove-Item $RouterPidFile -Force -ErrorAction SilentlyContinue
  }

  $orphans = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*bun*src/index.ts*" }
  foreach ($o in $orphans) {
    try { Stop-Process -Id $o.ProcessId -Force; Write-Host "[mini-routingai] Orphan bun $($o.ProcessId) dibersihkan" -ForegroundColor Gray } catch {}
  }
}

function Restart-Router {
  Write-Host "[mini-routingai] Restart..." -ForegroundColor Cyan
  Stop-Router
  Start-Sleep -Seconds 2
  Start-Router
  Show-Status
}

function Restart-Router-And-Headroom {
  Write-Host "[mini-routingai] Stop Headroom dulu..." -ForegroundColor Cyan
  Stop-Headroom
  Write-Host "[mini-routingai] Restart MiniRoutingAI..." -ForegroundColor Cyan
  Stop-Router
  Start-Sleep -Seconds 2
  Start-Router
  Write-Host "[mini-routingai] Start Headroom lagi..." -ForegroundColor Cyan
  Start-Headroom
  Show-Status
}

function Show-Status {
  $ErrorActionPreference = "SilentlyContinue"
  $port = Get-RouterPort

  Write-Host "=== MiniRoutingAI Status ===" -ForegroundColor Cyan
  Write-Host "Root: $Root" -ForegroundColor Gray

  if (Test-Path $RouterPidFile) {
    $pidStr = (Get-Content $RouterPidFile -Raw).Trim()
    Write-Host "PID file: $RouterPidFile -> $pidStr" -ForegroundColor Gray
    try {
      $proc = Get-Process -Id ([int]$pidStr) -ErrorAction SilentlyContinue
      if ($proc) {
        Write-Host "Process: RUNNING (PID $pidStr, $($proc.ProcessName), CPU $($proc.CPU))" -ForegroundColor Green
      } else {
        Write-Host "Process: NOT FOUND (PID $pidStr stale)" -ForegroundColor Red
      }
    } catch { Write-Host "Process: UNKNOWN" -ForegroundColor Yellow }
  } else {
    Write-Host "PID file: tidak ada (mungkin belum start atau sudah stop)" -ForegroundColor Yellow
  }

  try {
    $r = Invoke-WebRequest -Uri "http://localhost:${port}/health" -UseBasicParsing -TimeoutSec 3
    Write-Host "Health: OK" -ForegroundColor Green
    Write-Host "  $($r.Content)" -ForegroundColor Gray
  } catch {
    $msg = $_.Exception.Message
    Write-Host "Health: FAIL - http://localhost:${port}/health tidak merespon ($msg)" -ForegroundColor Red
  }

  try {
    $m = Invoke-WebRequest -Uri "http://localhost:${port}/metrics" -UseBasicParsing -TimeoutSec 3
    $mj = $m.Content | ConvertFrom-Json
    Write-Host "Metrics: count $($mj.count), P50 overhead $($mj.gatewayOverhead.p50) ms, recent $($mj.recent.Count) " -ForegroundColor Gray
    if ($mj.headroom) { Write-Host "Headroom metrics: fails=$($mj.headroom.fails) timeouts=$($mj.headroom.timeouts) cooldowns=$($mj.headroom.cooldowns)" -ForegroundColor Gray }
  } catch { Write-Host "Metrics: tidak bisa diakses" -ForegroundColor Yellow }

  try {
    $hr = Invoke-WebRequest -Uri "http://localhost:${port}/debug/headroom" -UseBasicParsing -TimeoutSec 2
    $hj = $hr.Content | ConvertFrom-Json
    $cd = if ($hj.cooldownRemainingMs -gt 0) { "cooldown $($hj.cooldownRemainingMs)ms ($($hj.consecutiveFailures) fails)" } else { "healthy" }
    Write-Host "Headroom: $cd, lastHealthOk=$($hj.lastHealthOk), lastReason=$($hj.lastFailureReason)" -ForegroundColor Gray
  } catch { Write-Host "Headroom debug: tidak bisa diakses" -ForegroundColor Yellow }

  # Log rotation hint
  if (Test-Path $RouterLogFile) {
    try { $sz = (Get-Item $RouterLogFile).Length; if ($sz -gt 50MB) { Write-Host "Log >50MB ($([math]::Round($sz/1MB,1))MB) - pertimbangkan rotate: Remove-Item $RouterLogFile -Force" -ForegroundColor Yellow } } catch {}
    Write-Host "`nLog tail (${RouterLogFile}):" -ForegroundColor Cyan
    Get-Content $RouterLogFile -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
  } else {
    Write-Host "Log: ${RouterLogFile} belum ada" -ForegroundColor Yellow
  }

  if (Test-Path $HeadroomLogFile) {
    try { $hsz = (Get-Item $HeadroomLogFile).Length; if ($hsz -gt 50MB) { Write-Host "Headroom log >50MB" -ForegroundColor Yellow } } catch {}
    Write-Host "`nHeadroom log tail (${HeadroomLogFile}):" -ForegroundColor Cyan
    Get-Content $HeadroomLogFile -Tail 10 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
  }

  $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*src/index.ts*" }
  if ($procs) {
    Write-Host "`nBun processes:" -ForegroundColor Cyan
    $procs | ForEach-Object { Write-Host "  PID $($_.ProcessId): $($_.CommandLine)" -ForegroundColor Gray }
  }
}

function Show-Logs {
  $ErrorActionPreference = "SilentlyContinue"
  if (-not (Test-Path $RouterLogFile)) { Write-Host "Log belum ada: $RouterLogFile" -ForegroundColor Yellow; return }
  Get-Content $RouterLogFile -Tail 50
}

function Start-Headroom {
  $ErrorActionPreference = "Stop"
  $port = 8787

  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

  if (Test-Path $HeadroomPidFile) {
    $old = (Get-Content $HeadroomPidFile -Raw).Trim()
    $proc = Get-Process -Id $old -ErrorAction SilentlyContinue
    if ($proc) { Write-Host "[headroom] Sudah jalan PID $old" -ForegroundColor Yellow; return }
    else { Remove-Item $HeadroomPidFile -Force -ErrorAction SilentlyContinue }
  }

  $headroomBin = $null
  foreach ($cand in @("C:\Users\kings\AppData\Local\Programs\Python\Python314\Scripts\headroom.exe", "C:\Users\kings\pipx\venvs\headroom-ai\Scripts\headroom.exe", "headroom")) {
    if (Test-Path $cand) { $headroomBin = $cand; break }
    try { $null = Get-Command headroom -ErrorAction Stop; $headroomBin = "headroom"; break } catch {}
  }
  if (-not $headroomBin) {
    Write-Host "[headroom] ERROR: headroom tidak ditemukan. Install: pipx install headroom-ai" -ForegroundColor Red
    return
  }

  Write-Host "[headroom] Starting proxy di port $port (log $HeadroomLogFile)..." -ForegroundColor Cyan
  $psArgs = "-NoProfile -ExecutionPolicy Bypass -Command `"& '$headroomBin' proxy --port $port --mode token 2>&1 | Tee-Object -FilePath '$HeadroomLogFile' -Append`""
  try {
    $proc = Start-Process -FilePath "powershell" -ArgumentList $psArgs -WindowStyle Hidden -PassThru
    $proc.Id | Set-Content $HeadroomPidFile -Encoding utf8
    Write-Host "[headroom] PID $($proc.Id) -> .headroom.pid" -ForegroundColor Green
    Start-Sleep -Seconds 3
    try {
      $r = Invoke-WebRequest -Uri "http://localhost:$port/health" -UseBasicParsing -TimeoutSec 2
      Write-Host "[headroom] Health: $($r.StatusCode)" -ForegroundColor Green
    } catch { Write-Host "[headroom] Health belum OK, cek log $HeadroomLogFile" -ForegroundColor Yellow }
  } catch { Write-Host "[headroom] Gagal start: $_" -ForegroundColor Red }
}

function Stop-Headroom {
  $ErrorActionPreference = "SilentlyContinue"
  if (Test-Path $HeadroomPidFile) {
    $pidStr = (Get-Content $HeadroomPidFile -Raw).Trim()
    try { $proc = Get-Process -Id ([int]$pidStr) -ErrorAction SilentlyContinue; if ($proc) { Stop-Process -Id $proc.Id -Force; Write-Host "[headroom] PID $pidStr dihentikan" -ForegroundColor Green } } catch {}
    Remove-Item $HeadroomPidFile -Force -ErrorAction SilentlyContinue
  } else { Write-Host "[headroom] PID file tidak ada" -ForegroundColor Yellow }
  $orphans = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*headroom*proxy*" }
  foreach ($o in $orphans) { try { Stop-Process -Id $o.ProcessId -Force; Write-Host "[headroom] Orphan $($o.ProcessId) dibersihkan" -ForegroundColor Gray } catch {} }
}

function Show-Menu {
  Write-Host ""
  Write-Host "=== MiniRoutingAI Manager ===" -ForegroundColor Cyan
  Write-Host "1. Start MiniRoutingAI"
  Write-Host "2. Stop MiniRoutingAI"
  Write-Host "3. Restart MiniRoutingAI"
  Write-Host "4. Status"
  Write-Host "5. Logs (tail 50)"
  Write-Host "6. Start Headroom"
  Write-Host "7. Stop Headroom"
  Write-Host "8. Restart MiniRoutingAI + Headroom"
  Write-Host "0. Keluar"
  Write-Host ""
}

function Invoke-CommandByName {
  param([string]$Name)
  switch ($Name) {
    "start"          { Start-Router }
    "stop"           { Stop-Router }
    "restart"        { Restart-Router }
    "restart-all"    { Restart-Router-And-Headroom }
    "status"         { Show-Status }
    "logs"           { Show-Logs }
    "headroom-start" { Start-Headroom }
    "headroom-stop"  { Stop-Headroom }
    "headroom-restart" { Stop-Headroom; Start-Sleep -Seconds 1; Start-Headroom }
    default          { return $false }
  }
  return $true
}

if ($Command -ne "") {
  if (-not (Invoke-CommandByName $Command)) {
    Write-Host "Subcommand tidak dikenal: $Command" -ForegroundColor Yellow
    Show-Menu
  }
  exit 0
}

# --- BAGIAN YANG DIPERBAIKI ---
while ($true) {
  Show-Menu
  # Menggunakan ToLower() dan Trim() agar bisa mengetik langsung kata "restart" / "start" tanpa loop error
  $choice = (Read-Host "Pilih [0-8] atau ketik perintah").Trim().ToLower()
  
  switch -Regex ($choice) {
    "^(1|start)$" { Start-Router }
    "^(2|stop)$" { Stop-Router }
    "^(3|restart)$" { Restart-Router }
    "^(4|status)$" { Show-Status }
    "^(5|logs)$" { Show-Logs }
    "^(6|headroom-start)$" { Start-Headroom }
    "^(7|headroom-stop)$" { Stop-Headroom }
    "^(8|restart-all)$" { Restart-Router-And-Headroom }
    "^(0|q|keluar|quit|exit)$" { Write-Host "Keluar." -ForegroundColor Gray; exit 0 }
    default { Write-Host "Pilihan tidak valid, coba lagi." -ForegroundColor Yellow }
  }
}