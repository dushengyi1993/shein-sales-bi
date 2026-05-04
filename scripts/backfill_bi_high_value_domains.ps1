param(
  [string]$StartDate = "2025-09-26",
  [string]$EndDate = "",
  [string]$Domains = "waybill,fulfillment,finance",
  [int]$WindowDays = 30,
  [int]$PageSize = 50,
  [int]$MaxPages = 50,
  [int]$WaitMs = 1800,
  [string]$Stores = "DL,DX,FY,LQ,NM,HL,JY,ZL,TS,MZ,CX,YJ,XL,QY,QH",
  [int]$BatchSize = 2,
  [int]$FetchTimeoutMinutes = 12,
  [int]$MaxJobs = 0,
  [string]$StopBefore = "",
  [ValidateSet("headless","background","visible")]
  [string]$BrowserMode = "background",
  [switch]$NoLaunch,
  [switch]$DryRun,
  [switch]$SkipExisting,
  [switch]$FetchOnly,
  [switch]$NoLoad
)

. "$PSScriptRoot\use_utf8.ps1"

$ErrorActionPreference = "Stop"
$Repo = Split-Path -Parent $PSScriptRoot
Set-Location $Repo

function Get-BjDate([int]$offsetDays) {
  $tz = [System.TimeZoneInfo]::FindSystemTimeZoneById("China Standard Time")
  $now = [System.TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow, $tz)
  return $now.Date.AddDays($offsetDays).ToString("yyyy-MM-dd")
}

if ([string]::IsNullOrWhiteSpace($EndDate)) {
  $EndDate = Get-BjDate 0
}

$start = [DateTime]::ParseExact($StartDate, "yyyy-MM-dd", $null)
$end = [DateTime]::ParseExact($EndDate, "yyyy-MM-dd", $null)
if ($end -lt $start) { throw "EndDate must be >= StartDate" }

$anchors = New-Object System.Collections.Generic.List[string]
$cursor = $start.AddDays($WindowDays - 1)
while ($cursor -le $end) {
  $anchors.Add($cursor.ToString("yyyy-MM-dd"))
  $cursor = $cursor.AddDays($WindowDays)
}
if ($anchors.Count -eq 0 -or $anchors[$anchors.Count - 1] -ne $EndDate) {
  $anchors.Add($EndDate)
}

$storeKeys = $Stores.Split(",") | ForEach-Object { $_.Trim().ToUpperInvariant() } | Where-Object { $_ }
$storesConfig = Get-Content -Raw -LiteralPath (Join-Path $Repo "config\stores.json") | ConvertFrom-Json
$storeByKey = @{}
foreach ($s in $storesConfig.stores) { $storeByKey[$s.storeKey.ToUpperInvariant()] = $s }

function Test-CdpPort([int]$Port) {
  try {
    $client = [System.Net.Sockets.TcpClient]::new()
    $iar = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(1000, $false)
    if ($ok) { $client.EndConnect($iar) }
    $client.Close()
    return $ok
  } catch {
    return $false
  }
}

function Ensure-StoreBrowser([string]$StoreKey) {
  if ($NoLaunch) { return }
  $store = $storeByKey[$StoreKey.ToUpperInvariant()]
  if (-not $store) { throw "Unknown store in config: $StoreKey" }
  $port = [int]$store.port
  if (Test-CdpPort $port) { return }
  Write-Host "[launch] $StoreKey CDP $port is closed; launching $BrowserMode browser"
  node .\scripts\launch_store_browser.mjs $StoreKey "--$BrowserMode" | Out-Host
  $deadline = (Get-Date).AddSeconds(45)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if (Test-CdpPort $port) {
      Write-Host "[launch-ok] $StoreKey CDP $port"
      return
    }
  }
  throw "CDP port $port did not open for $StoreKey after launching browser"
}

$planned = @()
foreach ($date in $anchors) {
  foreach ($store in $storeKeys) {
    $file = Join-Path $Repo "outputs\shein_business_domains\$store\$date.json"
    if ($SkipExisting -and (Test-Path -LiteralPath $file)) {
      Write-Host "[skip] $date $store already exists"
      continue
    }
    $planned += [pscustomobject]@{ Date = $date; Store = $store; File = $file }
  }
}

if ($MaxJobs -gt 0 -and $planned.Count -gt $MaxJobs) {
  $planned = @($planned | Select-Object -First $MaxJobs)
}

$stopBeforeTime = $null
if (-not [string]::IsNullOrWhiteSpace($StopBefore)) {
  $parsed = [DateTime]::MinValue
  if ([DateTime]::TryParse($StopBefore, [ref]$parsed)) {
    $stopBeforeTime = $parsed
  } else {
    $today = (Get-Date).ToString("yyyy-MM-dd")
    $stopBeforeTime = [DateTime]::Parse("$today $StopBefore")
  }
}

Write-Host "BI high-value backfill domains=$Domains start=$StartDate end=$EndDate windowDays=$WindowDays plannedJobs=$($planned.Count)"
foreach ($job in $planned) { Write-Host "  - $($job.Date) $($job.Store)" }

if ($DryRun) {
  Write-Host "DryRun only. No SHEIN fetch, no warehouse load."
  exit 0
}

$logDir = Join-Path $Repo "logs\bi-domain-backfill"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Start-FetchJob($job) {
  $date = $job.Date
  $store = $job.Store
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $stdout = Join-Path $logDir "domain-backfill-$date-$store-$stamp.out.log"
  $stderr = Join-Path $logDir "domain-backfill-$date-$store-$stamp.err.log"
  Write-Host "=== fetch high-value business domains $date $store ==="
  Ensure-StoreBrowser $store
  $argList = @(
    ".\scripts\fetch_shein_business_domains.mjs",
    "--store", $store,
    "--date", $date,
    "--domains", $Domains,
    "--page-size", "$PageSize",
    "--max-pages", "$MaxPages",
    "--wait-ms", "$WaitMs",
    "--store-attempts", "2",
    "--relogin-headless",
    "--json"
  )
  $process = Start-Process -FilePath "node" -ArgumentList $argList -WorkingDirectory $Repo -NoNewWindow -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  return [pscustomobject]@{
    Date = $date
    Store = $store
    File = $job.File
    Stdout = $stdout
    Stderr = $stderr
    Process = $process
    StartedAt = Get-Date
    TimedOut = $false
  }
}

function Complete-FetchJob($r) {
  $date = $r.Date
  $store = $r.Store
  $process = $r.Process
  if (-not $process.HasExited) {
    try { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } catch {}
    $r.TimedOut = $true
    Write-Host "[timeout] $date $store after $FetchTimeoutMinutes minutes. Logs: $($r.Stdout) / $($r.Stderr)"
    return $false
  }
  $process.Refresh()
  $exitCode = $process.ExitCode
  if ($null -eq $exitCode) {
    $exitCode = if (Test-Path -LiteralPath $r.File) { 0 } else { -1 }
  }
  if ($exitCode -ne 0) {
    Write-Host "[failed] $date $store exit=$exitCode"
    Write-Host "[stdout tail]"
    if (Test-Path -LiteralPath $r.Stdout) { Get-Content -LiteralPath $r.Stdout -Tail 40 }
    Write-Host "[stderr tail]"
    if (Test-Path -LiteralPath $r.Stderr) { Get-Content -LiteralPath $r.Stderr -Tail 80 }
    return $false
  }
  if (Test-Path -LiteralPath $r.Stdout) { Get-Content -LiteralPath $r.Stdout -Tail 5 }
  Write-Host "[ok] $date $store -> $($r.File)"
  return $true
}

$failedJobs = New-Object System.Collections.Generic.List[string]
for ($i = 0; $i -lt $planned.Count; $i += [Math]::Max(1, $BatchSize)) {
  if ($null -ne $stopBeforeTime -and (Get-Date) -ge $stopBeforeTime) {
    Write-Host "[stop-before] reached $StopBefore, no new batch will be started."
    break
  }
  $batch = @($planned[$i..([Math]::Min($planned.Count - 1, $i + [Math]::Max(1, $BatchSize) - 1))])
  Write-Host "=== batch $([Math]::Floor($i / [Math]::Max(1, $BatchSize)) + 1) size=$($batch.Count) ==="
  $running = @()
  foreach ($job in $batch) {
    $running += Start-FetchJob $job
  }
  $deadline = (Get-Date).AddSeconds($FetchTimeoutMinutes * 60)
  while ($true) {
    $active = @($running | Where-Object { -not $_.Process.HasExited })
    if ($active.Count -eq 0) { break }
    if ((Get-Date) -ge $deadline) { break }
    Start-Sleep -Seconds 2
    foreach ($r in $running) { try { $r.Process.Refresh() } catch {} }
  }
  foreach ($r in $running) {
    if (-not (Complete-FetchJob $r)) {
      $failedJobs.Add("$($r.Date) $($r.Store)") | Out-Null
    }
  }
}

if ($failedJobs.Count -gt 0) {
  throw "High-value domain backfill had $($failedJobs.Count) failed jobs: $($failedJobs -join ', ')"
}

if ($FetchOnly -or $NoLoad) {
  Write-Host "FetchOnly/NoLoad requested. Skip warehouse load and portal refresh."
  exit 0
}

Write-Host "=== load business-domain history into BI warehouse ==="
node .\scripts\load_bi_business_domains.mjs
if ($LASTEXITCODE -ne 0) { throw "load_bi_business_domains failed" }

Write-Host "=== audit BI warehouse ==="
node .\scripts\audit_bi_warehouse.mjs
if ($LASTEXITCODE -ne 0) { throw "audit_bi_warehouse failed" }

Write-Host "=== regenerate local BI portal and briefing ==="
node .\scripts\generate_bi_portal.mjs
if ($LASTEXITCODE -ne 0) { throw "generate_bi_portal failed" }
node .\scripts\generate_bi_briefing.mjs
if ($LASTEXITCODE -ne 0) { throw "generate_bi_briefing failed" }

Write-Host "BI high-value backfill completed."
