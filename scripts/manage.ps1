# scripts/manage.ps1 - Menu manajemen MiniRoutingAI (Windows + Bun)
# Penggunaan:
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1          # menu interaktif
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1 start    # subcommand non-interaktif
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1 stop
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1 restart
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1 status
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1 logs
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1 headroom-start
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1 headroom-stop
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1 headroom-restart
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/manage.ps1 restart-all
# Alias typo: /script/manage.ps1 akan diberi warning dan diarahkan ke scripts/manage.ps1
# Log: logs/mini-routingai.log | PID: .mini-routingai.pid / .headroom.pid

param(
  [string]$Command = "",
  [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

# Fallback PSScriptRoot jika dipanggil via pwsh -Command
if (-not $PSScriptRoot -or $PSScriptRoot -eq "") {
  $PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path -ErrorAction SilentlyContinue
  if (-not $PSScriptRoot) { $PSScriptRoot = (Get-Location).Path }
}
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..") -ErrorAction SilentlyContinue).Path
if (-not $Root) { $Root = (Resolve-Path ".." -ErrorAction SilentlyContinue).Path }
if (-not $Root) { $Root = $PSScriptRoot }
Set-Location $Root -ErrorAction SilentlyContinue

# Warning untuk typo path /script/ vs /scripts/
if ($MyInvocation.MyCommand.Path -match "[/\\]script[/\\]manage\.ps1" -and $MyInvocation.MyCommand.Path -notmatch "[/\\]scripts[/\\]") {
  Write-Host "[manage] Warning: path typo '/script/manage.ps1' terdeteksi, gunakan 'scripts/manage.ps1'" -ForegroundColor Yellow
}

$LogDir = Join-Path $Root "logs"
$RouterPidFile = Join-Path $Root ".mini-routingai.pid"
$RouterLogFile = Join-Path $LogDir "mini-routingai.log"
$HeadroomPidFile = Join-Path $Root ".headroom.pid"
$HeadroomLogFile = Join-Path $LogDir "headroom.log"
$DefaultPort = 3000

function Get-PowerShellHost {
  # Prefer pwsh (PowerShell 7), fallback ke powershell (5.1) untuk kompatibilitas
  try {
    $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
    if ($pwsh) { return $pwsh.Source }
  } catch {}
  try {
    $ps = Get-Command powershell -ErrorAction SilentlyContinue
    if ($ps) { return $ps.Source }
  } catch {}
  return "powershell"
}

function Get-RouterPort {
  # Validasi env PORT 1024-65535
  if ($env:PORT -and $env:PORT -match '^\d+$') {
    $p = [int]$env:PORT
    if ($p -ge 1024 -and $p -le 65535) { return $p }
  }
  $envFile = Join-Path $Root ".env"
  if (Test-Path $envFile) {
    try {
      $m = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($m -and $m.Matches[0].Groups[1].Success) {
        $p = [int]$m.Matches[0].Groups[1].Value
        if ($p -ge 1024 -and $p -le 65535) { return $p }
      }
    } catch {}
  }
  return $DefaultPort
}

function Test-JsonValid {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return $true } # fallback handled di src/index.ts
  try {
    $txt = Get-Content $Path -Raw -ErrorAction Stop
    # Strip JSONC: // line comments (hanya di awal baris) dan /* block */ agar konsisten dengan src/index.ts stripJsonComments
    # Jangan hapus // di dalam string seperti \"https://\" -> hanya hapus baris yang mulai dengan optional whitespace + //
    $cleaned = $txt -replace '(?m)^\s*//.*$',''
    $cleaned = $cleaned -replace '(?s)/\*.*?\*/',''
    $cleaned = $cleaned -replace ',(\s*[}\]])','$1'
    $null = $cleaned | ConvertFrom-Json -ErrorAction Stop
    return $true
  } catch {
    Write-Host "[config] Invalid JSON di ${Path}: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "[config] Hint: cek koma/trailing comma/kutip atau komentar // di ${Path}. Jalankan: bun -e `"JSON.parse(await Bun.file('$Path').text())`"" -ForegroundColor Yellow
    return $false
  }
}

function Clear-LogIfNeeded {
  param([string]$Path)
  try {
    if (Test-Path $Path) {
      $sz = (Get-Item $Path -ErrorAction SilentlyContinue).Length
      if ($sz -and $sz -gt 50MB) {
        $old = "$Path.old"
        try { Move-Item $Path $old -Force -ErrorAction SilentlyContinue; Write-Host "[log] Rotasi: $Path -> $old ($([math]::Round($sz/1MB,1))MB)" -ForegroundColor Gray } catch {}
      }
      # Truncate agar tail hanya berisi run saat ini
      try { Clear-Content $Path -ErrorAction SilentlyContinue } catch {
        try { Remove-Item $Path -Force -ErrorAction SilentlyContinue; New-Item -ItemType File -Path $Path | Out-Null } catch {}
      }
    }
    try { Add-Content $Path "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss K')] === Log cleaned at start ===" -ErrorAction SilentlyContinue } catch {}
  } catch {}
}

function Test-PortFree {
  param([int]$Port)
  # Prefer TcpClient quiet (tanpa output host) untuk hindari spam Test-NetConnection :: di menu
  try {
    $client = [System.Net.Sockets.TcpClient]::new()
    $ar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    $ok = $ar.AsyncWaitHandle.WaitOne(300)
    try { $client.Close() } catch {}
    if ($ok) {
      # Jika connect berhasil, port terpakai (meski TcpClient.Connected tidak reliable setelah Close)
      # Coba konfirmasi via Get-NetTCPConnection
      try {
        $tcp = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($tcp) { return @{ free = $false; owner = $tcp.OwningProcess } }
      } catch {}
      return @{ free = $false; owner = $null }
    }
  } catch {}
  try {
    $tcp = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
    if ($tcp) {
      $owner = $tcp | Select-Object -First 1 -ExpandProperty OwningProcess -ErrorAction SilentlyContinue
      return @{ free = $false; owner = $owner }
    }
  } catch {}
  # Fallback Test-NetConnection quiet (InformationLevel Quiet menghindari output host)
  try {
    $t = Test-NetConnection -ComputerName '127.0.0.1' -Port $Port -WarningAction SilentlyContinue -InformationLevel Quiet -ErrorAction SilentlyContinue
    if ($t -and $t.TcpTestSucceeded) { return @{ free = $false; owner = $null } }
  } catch {}
  return @{ free = $true; owner = $null }
}

function Show-Help {
  Write-Host 'MiniRoutingAI Manager -- scripts/manage.ps1' -ForegroundColor Cyan
  Write-Host ''
  Write-Host 'Usage:' -ForegroundColor Gray
  Write-Host '  pwsh -File scripts/manage.ps1 <command>        # non-interaktif (CI safe)' -ForegroundColor White
  Write-Host '  pwsh -File scripts/manage.ps1                  # menu interaktif (hanya jika UserInteractive)' -ForegroundColor White
  Write-Host ''
  Write-Host 'Commands:' -ForegroundColor Gray
  Write-Host '  start              Start MiniRoutingAI (background, log: logs/mini-routingai.log) - log dibersihkan dulu' -ForegroundColor White
  Write-Host '  stop               Stop MiniRoutingAI + bersihkan orphan bun' -ForegroundColor White
  Write-Host '  restart            Restart MiniRoutingAI (log dibersihkan)' -ForegroundColor White
  Write-Host '  restart-all        Restart MiniRoutingAI + Headroom (kedua log dibersihkan)' -ForegroundColor White
  Write-Host '  status             Tampilkan health, metrics, headroom cooldown, log tail' -ForegroundColor White
  Write-Host '  logs               Tail 50 baris logs/mini-routingai.log' -ForegroundColor White
  Write-Host '  headroom-start     Start Headroom proxy (port 8787, mode token) - log dibersihkan' -ForegroundColor White
  Write-Host '  headroom-stop      Stop Headroom proxy + orphan' -ForegroundColor White
  Write-Host '  headroom-restart   Restart Headroom proxy (log dibersihkan)' -ForegroundColor White
  Write-Host '  help, --help, -h   Tampilkan bantuan ini' -ForegroundColor White
  Write-Host ''
  Write-Host 'Catatan log:' -ForegroundColor Gray
  Write-Host '  Setiap start/restart log dibersihkan (truncate, rotasi >50MB -> .old) agar tail hanya berisi run saat ini.' -ForegroundColor DarkGray
  Write-Host ''
  Write-Host 'Examples:' -ForegroundColor Gray
  Write-Host '  pwsh -File scripts/manage.ps1 status' -ForegroundColor DarkGray
  Write-Host '  pwsh -File scripts/manage.ps1 start; Get-Content logs/mini-routingai.log -Tail 20 -Wait' -ForegroundColor DarkGray
  Write-Host ''
  Write-Host 'Troubleshooting headroom timeout:' -ForegroundColor Gray
  Write-Host '  pwsh -File scripts/manage.ps1 status; Get-Content logs/headroom.log -Tail 50; curl http://127.0.0.1:8787/health; curl http://127.0.0.1:8787/livez' -ForegroundColor DarkGray
}

if ($Help) { Show-Help; exit 0 }
if ($Command -in @("-h","--help","help","-Help","--Help")) { Show-Help; exit 0 }

function Start-Router {
  $port = Get-RouterPort

  # Preflight config JSON
  $cfgOk = $true
  foreach ($p in @("config/providers.json","config/routes.json","config/optimization.json")) {
    if (-not (Test-JsonValid (Join-Path $Root $p))) { $cfgOk = $false }
  }
  if (-not $cfgOk) {
    Write-Host "[mini-routingai] Config JSON invalid - perbaiki sebelum start (lihat pesan di atas)" -ForegroundColor Red
    return
  }

  # Port free check
  $pf = Test-PortFree -Port $port
  if (-not $pf.free) {
    $ownerInfo = if ($pf.owner) { " (OwningProcess PID $($pf.owner))" } else { "" }
    Write-Host "[mini-routingai] Port $port sudah terpakai$ownerInfo - cek proses lain atau ganti PORT di .env" -ForegroundColor Yellow
    # lanjut tetap coba start, tapi beri warning
  }

  # Migrasi pid legacy mini-9router -> mini-routingai
  $LegacyPidFile = Join-Path $Root ".mini-9router.pid"
  if (Test-Path $LegacyPidFile) {
    try {
      Write-Host "[mini-routingai] Migrasi: ditemukan pid legacy .mini-9router.pid -> .mini-routingai.pid" -ForegroundColor Yellow
      $legacyContent = (Get-Content $LegacyPidFile -Raw -ErrorAction SilentlyContinue | ForEach-Object { $_.Trim() })
      if ($legacyContent -and -not (Test-Path $RouterPidFile)) {
        Copy-Item $LegacyPidFile $RouterPidFile -Force -ErrorAction SilentlyContinue
        Write-Host "[mini-routingai] Migrasi pid selesai" -ForegroundColor Gray
      }
      Remove-Item $LegacyPidFile -Force -ErrorAction SilentlyContinue
      Write-Host "[mini-routingai] Legacy pid file dihapus" -ForegroundColor Gray
    } catch { Write-Host "[mini-routingai] Gagal migrasi pid legacy: $_" -ForegroundColor Yellow }
  }

  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  # Bersihkan log di setiap start/restart agar tail hanya berisi run saat ini (request user)
  Clear-LogIfNeeded $RouterLogFile

  if (Test-Path $RouterPidFile) {
    $raw = ""
    try { $raw = (Get-Content $RouterPidFile -Raw -ErrorAction SilentlyContinue).Trim() } catch {}
    # Robust parse: ambil token angka pertama
    $oldPid = $null
    if ($raw -match '(\d+)') { $oldPid = $Matches[1] }
    if ($oldPid) {
      $proc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
      if ($proc) {
        Write-Host "[mini-routingai] Sudah berjalan (PID $oldPid). Gunakan stop dulu." -ForegroundColor Yellow
        try {
          $h = Invoke-WebRequest -Uri "http://localhost:${port}/health" -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
          if ($h -and $h.Content) { Write-Host "[mini-routingai] Health: $($h.Content)" -ForegroundColor Green }
        } catch {}
        return
      } else {
        Write-Host "[mini-routingai] Stale PID $oldPid tidak ditemukan - menghapus file" -ForegroundColor Gray
        Remove-Item $RouterPidFile -Force -ErrorAction SilentlyContinue
      }
    } else {
      Write-Host "[mini-routingai] PID file korup/kosong - menghapus" -ForegroundColor Yellow
      Remove-Item $RouterPidFile -Force -ErrorAction SilentlyContinue
    }
  }

  try { $null = Get-Command bun -ErrorAction Stop } catch {
    Write-Host "[mini-routingai] ERROR: 'bun' tidak ditemukan di PATH. Install dari https://bun.sh" -ForegroundColor Red
    return
  }

  if (-not (Test-Path ".env")) {
    if (Test-Path ".env.example") {
      Write-Host "[mini-routingai] .env tidak ada, buat dari .env.example" -ForegroundColor Yellow
      Copy-Item ".env.example" ".env" -Force -ErrorAction SilentlyContinue
      Write-Host "[mini-routingai] .env dibuat, silakan isi API keys di .env" -ForegroundColor Gray
    }
  }

  Write-Host "[mini-routingai] Starting di background..." -ForegroundColor Cyan
  Write-Host "  Root: $Root"
  Write-Host "  Log : $RouterLogFile"
  Write-Host "  Port: $port"

  # Tulis header log
  try { Add-Content -Path $RouterLogFile -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss K')] Starting MiniRoutingAI port $port" -ErrorAction SilentlyContinue } catch {}

  $psHost = Get-PowerShellHost
  # Gunakan WorkingDirectory agar $Root dengan spasi aman; hindari Set-Location di string
  $bunCmd = "bun run src/index.ts 2>&1 | Tee-Object -FilePath '$RouterLogFile' -Append"
  $psArgs = "-NoProfile -ExecutionPolicy Bypass -Command `"$bunCmd`""
  $started = $false
  try {
    $proc = Start-Process -FilePath $psHost -ArgumentList $psArgs -WorkingDirectory $Root -WindowStyle Hidden -PassThru -ErrorAction Stop
    # Validasi proses tidak langsung exit
    Start-Sleep -Milliseconds 500
    $check = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
    if (-not $check) {
      throw "Proses $($proc.Id) langsung exit - cek $RouterLogFile"
    }
    "$($proc.Id)" | Set-Content $RouterPidFile -Encoding utf8 -NoNewline -ErrorAction Stop
    Write-Host "[mini-routingai] PID $($proc.Id) disimpan ke .mini-routingai.pid (host: $psHost)" -ForegroundColor Green
    $started = $true
  } catch {
    Write-Host "[mini-routingai] Gagal Start-Process ($psHost): $_" -ForegroundColor Yellow
    Write-Host "[mini-routingai] Cek log $RouterLogFile untuk detail" -ForegroundColor Gray
    # Jangan fallback ke Start-Job yang simpan job.Id ke .pid (membingungkan Stop-Router)
    try { Get-Content $RouterLogFile -Tail 10 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray } } catch {}
    return
  }

  if (-not $started) { return }

  Write-Host "[mini-routingai] Menunggu health..." -ForegroundColor Gray
  for ($i = 1; $i -le 10; $i++) {
    Start-Sleep -Seconds 1
    # Deteksi proses mati cepat (mis. Invalid JSON -> exit 1) agar tidak buang 10x timeout
    $alive = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
    if (-not $alive) {
      Write-Host "[mini-routingai] Proses $($proc.Id) mati sebelum health OK (percobaan $i) - cek log ${RouterLogFile}" -ForegroundColor Red
      try { Get-Content $RouterLogFile -Tail 20 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray } } catch {}
      # Bersihkan PID stale agar status tidak menunjukkan RUNNING
      try { Remove-Item $RouterPidFile -Force -ErrorAction SilentlyContinue; Write-Host "[mini-routingai] PID file dihapus (stale)" -ForegroundColor Yellow } catch {}
      if (Select-String -Path $RouterLogFile -Pattern "Invalid JSON" -SimpleMatch -ErrorAction SilentlyContinue) {
        Write-Host "[mini-routingai] Hint: Perbaiki JSON sebelum restart (hapus // komentar di config/*.json)" -ForegroundColor Yellow
      }
      return
    }
    try {
      $r = Invoke-WebRequest -Uri "http://localhost:${port}/health" -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
      if ($r -and $r.StatusCode -eq 200) {
        Write-Host "[mini-routingai] Health OK (percobaan $i): $($r.Content)" -ForegroundColor Green
        Write-Host "[mini-routingai] Gateway: http://localhost:${port}" -ForegroundColor Green
        Write-Host "[mini-routingai] Metrics: http://localhost:${port}/metrics" -ForegroundColor Gray
        Write-Host "[mini-routingai] Log tail: Get-Content ${RouterLogFile} -Tail 20 -Wait" -ForegroundColor Gray
        return
      } else {
        $code = if ($r) { $r.StatusCode } else { "no-response" }
        Write-Host "[mini-routingai] Health percobaan $i/10: HTTP $code" -ForegroundColor Gray
      }
    } catch {
      Write-Host "[mini-routingai] Health percobaan $i/10 belum OK: $($_.Exception.Message)" -ForegroundColor Gray
    }
  }
  Write-Host "[mini-routingai] Health belum OK setelah 10s, cek log: ${RouterLogFile}" -ForegroundColor Yellow
  # Jika proses sudah mati setelah loop, bersihkan PID
  if (-not (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue)) {
    Write-Host "[mini-routingai] Proses $($proc.Id) ternyata mati - cek Invalid JSON" -ForegroundColor Red
    try { Remove-Item $RouterPidFile -Force -ErrorAction SilentlyContinue } catch {}
  }
  try { Get-Content $RouterLogFile -Tail 30 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray } } catch {}
}

function Stop-Router {
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = "SilentlyContinue"

  try {
    if (-not (Test-Path $RouterPidFile)) {
      Write-Host "[mini-routingai] PID file tidak ada, cari proses bun..." -ForegroundColor Yellow
      $found = $false
      # Prefer Get-Process (ringan, tanpa WMI/admin)
      foreach ($p in (Get-Process -Name "bun" -ErrorAction SilentlyContinue)) {
        try {
          $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId = $($p.Id)" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty CommandLine -ErrorAction SilentlyContinue)
          if ($cmd -and $cmd -like "*src/index.ts*") {
            Write-Host "[mini-routingai] Ditemukan PID $($p.Id): $cmd" -ForegroundColor Gray
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
            Write-Host "[mini-routingai] Dihentikan PID $($p.Id)" -ForegroundColor Green
            $found = $true
          }
        } catch {}
      }
      if (-not $found) {
        foreach ($p in (Get-Process -Name "bun","node" -ErrorAction SilentlyContinue)) {
          # fallback kasar: cek MainModule path
          if ($p.Path -like "*bun*") {
            Write-Host "[mini-routingai] Kandidat bun PID $($p.Id) ($($p.ProcessName)) - skip otomatis (tidak ada CommandLine)" -ForegroundColor DarkGray
          }
        }
        Write-Host "[mini-routingai] Tidak ada proses bun terdeteksi untuk src/index.ts" -ForegroundColor Gray
      }
      return
    }

    $raw = ""
    try { $raw = (Get-Content $RouterPidFile -Raw -ErrorAction SilentlyContinue).Trim() } catch {}
    if (-not $raw -or $raw -eq "") {
      Remove-Item $RouterPidFile -Force -ErrorAction SilentlyContinue
      Write-Host "[mini-routingai] PID file kosong, dihapus" -ForegroundColor Yellow
      return
    }

    # Robust parse: ambil angka pertama; jika tidak ada → anggap korup
    $targetPid = 0
    $matched = $false
    if ($raw -match '(\d+)') {
      $candidate = $Matches[1]
      if ([int]::TryParse($candidate, [ref]$targetPid)) { $matched = $true }
    }
    if (-not $matched) {
      Write-Host "[mini-routingai] PID file korup ('$raw') - menghapus" -ForegroundColor Yellow
      Remove-Item $RouterPidFile -Force -ErrorAction SilentlyContinue
      return
    }

    $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
    if ($proc) {
      Write-Host "[mini-routingai] Menghentikan PID $targetPid ($($proc.ProcessName))..." -ForegroundColor Cyan
      # Anak via WMI jika tersedia
      try {
        $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $targetPid" -ErrorAction SilentlyContinue
        foreach ($c in $children) {
          try { Stop-Process -Id $c.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host "[mini-routingai] Child $($c.ProcessId) dihentikan" -ForegroundColor Gray } catch {}
        }
      } catch {}
      Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 1
      if (-not (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) {
        Write-Host "[mini-routingai] Dihentikan" -ForegroundColor Green
      } else {
        Write-Host "[mini-routingai] Gagal hentikan, coba taskkill" -ForegroundColor Red
        try { taskkill /PID $targetPid /T /F 2>&1 | Out-Null } catch {}
      }
    } else {
      Write-Host "[mini-routingai] PID $targetPid sudah tidak ada (stale)" -ForegroundColor Yellow
    }
    Remove-Item $RouterPidFile -Force -ErrorAction SilentlyContinue
    Write-Host "[mini-routingai] PID file dihapus" -ForegroundColor Gray

    # Orphan bun src/index.ts - ringan
    try {
      foreach ($p in (Get-Process -Name "bun" -ErrorAction SilentlyContinue)) {
        $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId = $($p.Id)" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty CommandLine -ErrorAction SilentlyContinue)
        if ($cmd -and $cmd -like "*bun*src/index.ts*") {
          try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; Write-Host "[mini-routingai] Orphan bun $($p.Id) dibersihkan" -ForegroundColor Gray } catch {}
        }
      }
    } catch {}
  } finally {
    $ErrorActionPreference = $prevEAP
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
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = "SilentlyContinue"
  try {
    $port = Get-RouterPort

    Write-Host "=== MiniRoutingAI Status ===" -ForegroundColor Cyan
    Write-Host "Root: $Root" -ForegroundColor Gray

    if (Test-Path $RouterPidFile) {
      $raw = ""
      try { $raw = (Get-Content $RouterPidFile -Raw -ErrorAction SilentlyContinue).Trim() } catch {}
      $pidStr = if ($raw -match '(\d+)') { $Matches[1] } else { $raw }
      Write-Host "PID file: $RouterPidFile -> $pidStr" -ForegroundColor Gray
      try {
        $pidInt = 0
        if ([int]::TryParse($pidStr, [ref]$pidInt)) {
          $proc = Get-Process -Id $pidInt -ErrorAction SilentlyContinue
          if ($proc) {
            Write-Host "Process: RUNNING (PID $pidStr, $($proc.ProcessName), CPU $($proc.CPU))" -ForegroundColor Green
          } else {
            Write-Host "Process: NOT FOUND (PID $pidStr stale)" -ForegroundColor Red
          }
        } else {
          Write-Host "Process: UNKNOWN (PID korup: $pidStr)" -ForegroundColor Yellow
        }
      } catch { Write-Host "Process: UNKNOWN" -ForegroundColor Yellow }
    } else {
      Write-Host "PID file: tidak ada (mungkin belum start atau sudah stop)" -ForegroundColor Yellow
    }

    try {
      $r = Invoke-WebRequest -Uri "http://localhost:${port}/health" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
      if ($r.StatusCode -eq 200) {
        Write-Host "Health: OK" -ForegroundColor Green
        Write-Host "  $($r.Content)" -ForegroundColor Gray
      } else {
        Write-Host "Health: HTTP $($r.StatusCode) - $($r.Content)" -ForegroundColor Yellow
      }
    } catch {
      $msg = $_.Exception.Message
      Write-Host "Health: FAIL - http://localhost:${port}/health tidak merespon ($msg)" -ForegroundColor Red
    }

    try {
      $m = Invoke-WebRequest -Uri "http://localhost:${port}/metrics" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
      if ($m.StatusCode -eq 200) {
        $mj = $null
        try { $mj = $m.Content | ConvertFrom-Json -ErrorAction Stop } catch { $mj = $null }
        if ($mj) {
          $cnt = 0
          try { $cnt = @($mj.recent).Count } catch { $cnt = $mj.count }
          $p50 = ""
          try { $p50 = $mj.gatewayOverhead.p50 } catch {}
          Write-Host "Metrics: count $($mj.count) (recent $cnt), P50 overhead $p50 ms" -ForegroundColor Gray
          if ($mj.headroom) {
            $hr = $mj.headroom
            $tr = if ($null -ne $hr.timeoutRate) { " rate=$($hr.timeoutRate)" } else { "" }
            Write-Host "Headroom metrics: fails=$($hr.fails) timeouts=$($hr.timeouts) cooldowns=$($hr.cooldowns)$tr" -ForegroundColor Gray
          }
        } else {
          Write-Host "Metrics: invalid JSON" -ForegroundColor Yellow
        }
      } else {
        Write-Host "Metrics: HTTP $($m.StatusCode)" -ForegroundColor Yellow
      }
    } catch { Write-Host "Metrics: tidak bisa diakses ($($_.Exception.Message))" -ForegroundColor Yellow }

    try {
      $hr = Invoke-WebRequest -Uri "http://localhost:${port}/debug/headroom" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
      if ($hr.StatusCode -eq 200) {
        $hj = $null
        try { $hj = $hr.Content | ConvertFrom-Json -ErrorAction Stop } catch {}
        if ($hj) {
          $cd = if ($hj.cooldownRemainingMs -gt 0) { "cooldown $($hj.cooldownRemainingMs)ms ($($hj.consecutiveFailures) fails)" } else { "healthy" }
          Write-Host "Headroom: $cd, lastHealthOk=$($hj.lastHealthOk), lastReason=$($hj.lastFailureReason)" -ForegroundColor Gray
        }
      }
    } catch { Write-Host "Headroom debug: tidak bisa diakses" -ForegroundColor Yellow }

    # Log rotation hint
    if (Test-Path $RouterLogFile) {
      try { $sz = (Get-Item $RouterLogFile -ErrorAction SilentlyContinue).Length; if ($sz -gt 50MB) { Write-Host "Log >50MB ($([math]::Round($sz/1MB,1))MB) - pertimbangkan rotate: Remove-Item $RouterLogFile -Force" -ForegroundColor Yellow } } catch {}
      Write-Host "`nLog tail (${RouterLogFile}):" -ForegroundColor Cyan
      Get-Content $RouterLogFile -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
    } else {
      Write-Host "Log: ${RouterLogFile} belum ada" -ForegroundColor Yellow
    }

    if (Test-Path $HeadroomLogFile) {
      try { $hsz = (Get-Item $HeadroomLogFile -ErrorAction SilentlyContinue).Length; if ($hsz -gt 50MB) { Write-Host "Headroom log >50MB" -ForegroundColor Yellow } } catch {}
      Write-Host "`nHeadroom log tail (${HeadroomLogFile}):" -ForegroundColor Cyan
      Get-Content $HeadroomLogFile -Tail 10 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
    }

    # Bun processes - ringan tanpa WMI CommandLine jika tidak perlu
    try {
      $bunProcs = Get-Process -Name "bun" -ErrorAction SilentlyContinue
      if ($bunProcs) {
        Write-Host "`nBun processes:" -ForegroundColor Cyan
        foreach ($bp in $bunProcs) {
          $cmd = ""
          try { $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId = $($bp.Id)" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty CommandLine -ErrorAction SilentlyContinue) } catch {}
          if ($cmd) { Write-Host "  PID $($bp.Id): $cmd" -ForegroundColor Gray }
          else { Write-Host "  PID $($bp.Id): bun (no CommandLine)" -ForegroundColor DarkGray }
        }
      }
    } catch {}
  } finally {
    $ErrorActionPreference = $prevEAP
  }
}

function Show-Logs {
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = "SilentlyContinue"
  try {
    if (-not (Test-Path $RouterLogFile)) { Write-Host "Log belum ada: $RouterLogFile" -ForegroundColor Yellow; return }
    Get-Content $RouterLogFile -Tail 50 -ErrorAction SilentlyContinue
  } finally { $ErrorActionPreference = $prevEAP }
}

function Find-HeadroomBin {
  # Portabel: cek env + wildcard + PATH
  $candidates = @()
  # 1. Env-driven
  if ($env:HEADROOM_BIN -and (Test-Path $env:HEADROOM_BIN)) { $candidates += $env:HEADROOM_BIN }
  # 2. User profile wildcard (Python 3.10-3.14)
  foreach ($base in @($env:USERPROFILE, $env:LOCALAPPDATA, $env:APPDATA)) {
    if (-not $base) { continue }
    foreach ($pat in @("Programs\Python\Python*\Scripts\headroom.exe","pipx\venvs\headroom-ai\Scripts\headroom.exe","pipx\venvs\headroom-ai\Scripts\headroom")) {
      try {
        $full = Join-Path $base $pat
        $hits = Resolve-Path $full -ErrorAction SilentlyContinue
        foreach ($h in $hits) { if (Test-Path $h.Path) { $candidates += $h.Path } }
      } catch {}
    }
  }
  # 3. PIPX_HOME
  if ($env:PIPX_HOME) {
    $p = Join-Path $env:PIPX_HOME "venvs\headroom-ai\Scripts\headroom.exe"
    if (Test-Path $p) { $candidates += $p }
  }
  # 4. Hardcode legacy (kompat)
  foreach ($p in @("C:\Users\kings\AppData\Local\Programs\Python\Python314\Scripts\headroom.exe","C:\Users\kings\pipx\venvs\headroom-ai\Scripts\headroom.exe")) {
    if ((Test-Path $p) -and ($candidates -notcontains $p)) { $candidates += $p }
  }
  # 5. PATH
  try {
    $cmd = Get-Command headroom -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -and (Test-Path $cmd.Source)) { $candidates += $cmd.Source }
    elseif ($cmd) { $candidates += "headroom" }
  } catch {}

  foreach ($c in $candidates) {
    if ($c -eq "headroom") { return "headroom" }
    if (Test-Path $c) { return $c }
  }
  # Final fallback: coba headroom di PATH tanpa test
  try { $null = Get-Command headroom -ErrorAction Stop; return "headroom" } catch {}
  return $null
}

function Start-Headroom {
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = "Stop"
  try {
    $port = 8787

    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    # Bersihkan log headroom di setiap start/restart
    Clear-LogIfNeeded $HeadroomLogFile

    if (Test-Path $HeadroomPidFile) {
      $raw = ""
      try { $raw = (Get-Content $HeadroomPidFile -Raw -ErrorAction SilentlyContinue).Trim() } catch {}
      $old = if ($raw -match '(\d+)') { $Matches[1] } else { $raw }
      $proc = Get-Process -Id $old -ErrorAction SilentlyContinue
      if ($proc) { Write-Host "[headroom] Sudah jalan PID $old ($($proc.ProcessName))" -ForegroundColor Yellow; return }
      else {
        Write-Host "[headroom] Stale PID $old - menghapus" -ForegroundColor Gray
        Remove-Item $HeadroomPidFile -Force -ErrorAction SilentlyContinue
      }
    }

    # Port conflict check
    $pf = Test-PortFree -Port $port
    if (-not $pf.free) {
      $owner = if ($pf.owner) { " (PID $($pf.owner))" } else { "" }
      Write-Host "[headroom] Port $port sudah terpakai$owner - stop proses tersebut atau ganti port" -ForegroundColor Yellow
      return
    }

    $headroomBin = Find-HeadroomBin
    if (-not $headroomBin) {
      Write-Host "[headroom] ERROR: headroom tidak ditemukan. Install: pipx install headroom-ai" -ForegroundColor Red
      Write-Host "[headroom] Cek: Get-Command headroom; pipx list; pip show headroom-ai" -ForegroundColor Gray
      return
    }
    Write-Host "[headroom] Menggunakan bin: $headroomBin" -ForegroundColor Gray

    Write-Host "[headroom] Starting proxy di port $port (log $HeadroomLogFile)..." -ForegroundColor Cyan
    try { Add-Content -Path $HeadroomLogFile -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss K')] Starting headroom proxy port $port bin=$headroomBin" -ErrorAction SilentlyContinue } catch {}

    $psHost = Get-PowerShellHost
    # Quoting aman untuk path dengan spasi
    $proxyCmd = "& '$headroomBin' proxy --port $port --mode token 2>&1 | Tee-Object -FilePath '$HeadroomLogFile' -Append"
    $psArgs = "-NoProfile -ExecutionPolicy Bypass -Command `"$proxyCmd`""
    $proc = Start-Process -FilePath $psHost -ArgumentList $psArgs -WorkingDirectory $Root -WindowStyle Hidden -PassThru -ErrorAction Stop
    Start-Sleep -Milliseconds 700
    $chk = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
    if (-not $chk) {
      Write-Host "[headroom] Proses $($proc.Id) langsung exit - cek $HeadroomLogFile" -ForegroundColor Red
      try { Get-Content $HeadroomLogFile -Tail 20 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray } } catch {}
      return
    }
    "$($proc.Id)" | Set-Content $HeadroomPidFile -Encoding utf8 -NoNewline -ErrorAction Stop
    Write-Host "[headroom] PID $($proc.Id) -> .headroom.pid (host: $psHost)" -ForegroundColor Green

    # Polling health hingga 15s (warmup Python bisa >10s, mode token cold start) - fallback /livez -> /health, IPv4 dulu
    $ok = $false
    $healthUrls = @("http://127.0.0.1:$port/livez","http://127.0.0.1:$port/health","http://localhost:$port/health")
    for ($i = 1; $i -le 15; $i++) {
      Start-Sleep -Seconds 1
      # Cek proses masih hidup, jika mati langsung break
      $alive = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
      if (-not $alive) {
        Write-Host "[headroom] Proses $($proc.Id) mati sebelum health OK - cek log $HeadroomLogFile" -ForegroundColor Red
        try { Get-Content $HeadroomLogFile -Tail 20 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray } } catch {}
        break
      }
      foreach ($hu in $healthUrls) {
        try {
          $r = Invoke-WebRequest -Uri $hu -UseBasicParsing -TimeoutSec 3 -ErrorAction SilentlyContinue
          if ($r -and $r.StatusCode -in @(200,204)) { Write-Host "[headroom] Health OK (percobaan $i): $($r.StatusCode) - $hu" -ForegroundColor Green; $ok = $true; break }
        } catch {}
        # Fallback HttpClient 3s (lebih andal di PS5)
        if (-not $ok) {
          try {
            $hc = [System.Net.Http.HttpClient]::new()
            $hc.Timeout = [TimeSpan]::FromSeconds(3)
            $res = $hc.GetAsync($hu).GetAwaiter().GetResult()
            if ($res.IsSuccessStatusCode) { Write-Host "[headroom] Health OK via HttpClient (percobaan $i): $hu" -ForegroundColor Green; $ok = $true; try { $hc.Dispose() } catch {}; break }
            try { $hc.Dispose() } catch {}
          } catch {}
        }
      }
      if ($ok) { break }
      if ($i % 5 -eq 0) { Write-Host "[headroom] Health percobaan $i/15 belum OK - proses $($proc.Id) masih hidup, tail log:" -ForegroundColor Gray; try { Get-Content $HeadroomLogFile -Tail 5 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray } } catch {} }
      else { Write-Host "[headroom] Health percobaan $i/15 belum OK: timeout" -ForegroundColor Gray }
    }
    if (-not $ok) {
      $stillAlive = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
      if ($stillAlive) {
        # Proses hidup tapi health timeout - kemungkinan IPv6 vs IPv4 atau endpoint, anggap degraded success
        Write-Host "[headroom] Health belum OK setelah 15s tapi proses $($proc.Id) masih hidup - cek manual: curl http://127.0.0.1:$port/health & curl http://127.0.0.1:$port/livez" -ForegroundColor Yellow
        Write-Host "[headroom] Hint: Get-Content $HeadroomLogFile -Tail 50 | cek traceback Python / port conflict. Coba: headroom proxy --port $port --mode token secara manual" -ForegroundColor Gray
      } else {
        Write-Host "[headroom] Health belum OK dan proses mati - cek log $HeadroomLogFile" -ForegroundColor Red
      }
      try { Get-Content $HeadroomLogFile -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray } } catch {}
    }
    # Validasi compress endpoint cepat (pakai 127.0.0.1)
    try {
      $testBody = '{"messages":[{"role":"user","content":"ping"}],"model":"test"}'
      $cr = Invoke-WebRequest -Uri "http://127.0.0.1:$port/v1/compress" -Method POST -Body $testBody -ContentType "application/json" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
      if ($cr.StatusCode -eq 200) { Write-Host "[headroom] Compress probe: $($cr.StatusCode) OK" -ForegroundColor Green }
      else { Write-Host "[headroom] Compress probe: HTTP $($cr.StatusCode) (coba curl http://127.0.0.1:$port/v1/compress)" -ForegroundColor Yellow }
    } catch {
      # Fallback localhost
      try {
        $testBody2 = '{"messages":[{"role":"user","content":"ping"}],"model":"test"}'
        $cr2 = Invoke-WebRequest -Uri "http://localhost:$port/v1/compress" -Method POST -Body $testBody2 -ContentType "application/json" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
        if ($cr2.StatusCode -eq 200) { Write-Host "[headroom] Compress probe (localhost): $($cr2.StatusCode) OK" -ForegroundColor Green }
        else { throw $_.Exception.Message }
      } catch { Write-Host "[headroom] Compress probe gagal (masih warmup?): $($_.Exception.Message) - coba manual curl" -ForegroundColor Yellow }
    }
  } catch {
    Write-Host "[headroom] Gagal start: $_" -ForegroundColor Red
    Write-Host "[headroom] Cek log $HeadroomLogFile dan 'Get-Command headroom'" -ForegroundColor Gray
  } finally {
    $ErrorActionPreference = $prevEAP
  }
}

function Stop-Headroom {
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = "SilentlyContinue"
  try {
    if (Test-Path $HeadroomPidFile) {
      $raw = ""
      try { $raw = (Get-Content $HeadroomPidFile -Raw -ErrorAction SilentlyContinue).Trim() } catch {}
      $pidStr = if ($raw -match '(\d+)') { $Matches[1] } else { $raw }
      if ($pidStr -match '^\d+$') {
        try {
          $proc = Get-Process -Id ([int]$pidStr) -ErrorAction SilentlyContinue
          if ($proc) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue; Write-Host "[headroom] PID $pidStr dihentikan" -ForegroundColor Green }
          else { Write-Host "[headroom] PID $pidStr sudah tidak ada (stale)" -ForegroundColor Gray }
        } catch {}
      } else {
        Write-Host "[headroom] PID file korup ('$raw')" -ForegroundColor Yellow
      }
      Remove-Item $HeadroomPidFile -Force -ErrorAction SilentlyContinue
    } else { Write-Host "[headroom] PID file tidak ada" -ForegroundColor Yellow }

    # Orphan headroom*proxy* - ringan Get-Process dulu
    try {
      foreach ($p in (Get-Process -Name "headroom","python","python3" -ErrorAction SilentlyContinue)) {
        try {
          $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId = $($p.Id)" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty CommandLine -ErrorAction SilentlyContinue)
          if ($cmd -and $cmd -like "*headroom*proxy*") {
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
            Write-Host "[headroom] Orphan $($p.Id) dibersihkan: $cmd" -ForegroundColor Gray
          }
        } catch {}
      }
    } catch {}
    # Fallback WMI sweep jika masih ada
    try {
      $orphans = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*headroom*proxy*" }
      foreach ($o in $orphans) { try { Stop-Process -Id $o.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host "[headroom] Orphan $($o.ProcessId) dibersihkan" -ForegroundColor Gray } catch {} }
    } catch {}
  } finally { $ErrorActionPreference = $prevEAP }
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
  Write-Host "Ketik angka atau kata (start/stop/restart/status/logs/headroom-start/headroom-stop/restart-all/help)" -ForegroundColor DarkGray
}

function Invoke-CommandByName {
  param([string]$Name)
  $n = $Name.Trim().ToLower()
  switch ($n) {
    "start"            { Start-Router; return $true }
    "stop"             { Stop-Router; return $true }
    "restart"          { Restart-Router; return $true }
    "restart-all"      { Restart-Router-And-Headroom; return $true }
    "status"           { Show-Status; return $true }
    "logs"             { Show-Logs; return $true }
    "headroom-start"   { Start-Headroom; return $true }
    "headroom-stop"    { Stop-Headroom; return $true }
    "headroom-restart" { Stop-Headroom; Start-Sleep -Seconds 1; Start-Headroom; return $true }
    "help"             { Show-Help; return $true }
    "--help"           { Show-Help; return $true }
    "-h"               { Show-Help; return $true }
    default            { return $false }
  }
}

# --- Entrypoint non-interaktif (CI-safe) ---
if ($Command -ne "") {
  $ok = Invoke-CommandByName $Command
  if (-not $ok) {
    Write-Host "Subcommand tidak dikenal: $Command" -ForegroundColor Yellow
    Show-Help
    exit 1
  }
  exit 0
}

# Jika stdin di-redirect atau tidak interaktif, jangan masuk menu infinite (hang di CI)
$isInteractive = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected -and $Host.Name -ne "ServerRemoteHost"
if (-not $isInteractive) {
  Write-Host "Tidak ada subcommand dan sesi tidak interaktif - gunakan: pwsh -File scripts/manage.ps1 <start|stop|restart|status|logs|headroom-start|headroom-stop|help>" -ForegroundColor Yellow
  Show-Help
  exit 1
}

# --- Menu interaktif ---
while ($true) {
  Show-Menu
  try { $choice = (Read-Host "Pilih [0-8] atau ketik perintah").Trim().ToLower() } catch { Write-Host "Input error: $_" -ForegroundColor Red; continue }
  if (-not $choice) { continue }
  switch -Regex ($choice) {
    "^(1|start)$"                          { Start-Router }
    "^(2|stop)$"                           { Stop-Router }
    "^(3|restart)$"                        { Restart-Router }
    "^(4|status)$"                         { Show-Status }
    "^(5|logs)$"                          { Show-Logs }
    "^(6|headroom-start)$"                { Start-Headroom }
    "^(7|headroom-stop)$"                 { Stop-Headroom }
    "^(8|restart-all)$"                   { Restart-Router-And-Headroom }
    "^(0|q|keluar|quit|exit)$"            { Write-Host "Keluar." -ForegroundColor Gray; exit 0 }
    "^(help|--help|-h)$"                  { Show-Help }
    default                               { Write-Host "Pilihan tidak valid: $choice - ketik 'help' untuk daftar perintah" -ForegroundColor Yellow }
  }
}
