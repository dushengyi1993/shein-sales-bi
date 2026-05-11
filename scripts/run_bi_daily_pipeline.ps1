param(
  [string]$SalesDate = "",
  [string]$LinkDate = "",
  [string]$BusinessDate = "",
  [switch]$SkipBusinessFetch,
  [switch]$SkipSalesLinkLoad,
  [switch]$SkipBusinessLoad,
  [switch]$SkipRtvVerify,
  [string]$Distro = "Ubuntu-24.04",
  [string]$Container = "shein-warehouse-db",
  [string]$Database = "shein_bi",
  [string]$User = "shein"
)

. "$PSScriptRoot\use_utf8.ps1"

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Get-BjDate([int]$OffsetDays) {
  $utcNow = [DateTime]::UtcNow
  return $utcNow.AddHours(8).AddDays($OffsetDays).ToString("yyyy-MM-dd")
}

if ([string]::IsNullOrWhiteSpace($SalesDate)) { $SalesDate = Get-BjDate 0 }
if ([string]::IsNullOrWhiteSpace($BusinessDate)) { $BusinessDate = $SalesDate }
if ([string]::IsNullOrWhiteSpace($LinkDate)) { $LinkDate = Get-BjDate -1 }

$ts = Get-Date -Format "yyyyMMdd-HHmmss"
$logDir = Join-Path $repo "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "bi-daily-pipeline-$ts.log"

function Log([string]$Message) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  $line | Tee-Object -FilePath $logFile -Append
}

function Run-Step([string]$Name, [scriptblock]$Block) {
  Log "START $Name"
  $oldErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $global:LASTEXITCODE = 0
  try {
    & $Block 2>&1 | ForEach-Object {
      "$_" | Tee-Object -FilePath $logFile -Append
    }
    $exitCode = $global:LASTEXITCODE
    if ($null -ne $exitCode -and $exitCode -ne 0) {
      throw "Native command exited with code $exitCode"
    }
    Log "OK $Name"
  } catch {
    Log "FAIL $Name :: $($_.Exception.Message)"
    throw
  } finally {
    $ErrorActionPreference = $oldErrorActionPreference
  }
}

function Run-NonBlocking-Step([string]$Name, [scriptblock]$Block) {
  Log "START $Name"
  $oldErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $global:LASTEXITCODE = 0
  try {
    & $Block 2>&1 | ForEach-Object {
      "$_" | Tee-Object -FilePath $logFile -Append
    }
    $exitCode = $global:LASTEXITCODE
    if ($null -ne $exitCode -and $exitCode -ne 0) {
      Log "WARN $Name exited with code $exitCode"
    } else {
      Log "OK $Name"
    }
  } catch {
    Log "WARN $Name :: $($_.Exception.Message)"
  } finally {
    $ErrorActionPreference = $oldErrorActionPreference
  }
}

$script:PostCheckStarted = $false
function Start-DelayedPostCheck([string]$Reason) {
  if ($script:PostCheckStarted) { return }
  $script:PostCheckStarted = $true
  try {
    Log "START delayed BI postcheck reason=$Reason"
    Start-Process -FilePath "powershell.exe" `
      -ArgumentList @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", ".\scripts\run_bi_postcheck.ps1",
        "-DelaySeconds", "45",
        "-Reason", $Reason,
        "-Distro", $Distro,
        "-Container", $Container,
        "-Database", $Database,
        "-User", $User
      ) `
      -WorkingDirectory $repo `
      -WindowStyle Hidden | Out-Null
    Log "OK delayed BI postcheck scheduled"
  } catch {
    Log "WARN delayed BI postcheck schedule failed :: $($_.Exception.Message)"
  }
}

trap {
  Log "TRAP BI daily pipeline failed :: $($_.Exception.Message)"
  Start-DelayedPostCheck "failure"
  throw
}

function Get-LatestDashboardJson() {
  $dir = Join-Path $repo "outputs\link-dashboard"
  if (-not (Test-Path -LiteralPath $dir)) { return "" }
  $preferred = Join-Path $dir ("link-ops-dashboard-{0}.json" -f $LinkDate)
  if (Test-Path -LiteralPath $preferred) { return (Resolve-Path -LiteralPath $preferred).Path }
  $file = Get-ChildItem -LiteralPath $dir -Filter "link-ops-dashboard-*.json" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($null -eq $file) { return "" }
  return $file.FullName
}

function Get-LinkFileCount([string]$Date) {
  $dir = Join-Path $repo "outputs\shein_links"
  if (-not (Test-Path -LiteralPath $dir)) { return 0 }
  return @(
    Get-ChildItem -LiteralPath $dir -Recurse -File -Filter "$Date.json" -ErrorAction SilentlyContinue
  ).Count
}

function Get-LatestAvailableLinkDate([string]$PreferredDate) {
  $dir = Join-Path $repo "outputs\shein_links"
  if (-not (Test-Path -LiteralPath $dir)) { return "" }
  $dates = Get-ChildItem -LiteralPath $dir -Recurse -File -Filter "*.json" -ErrorAction SilentlyContinue |
    Where-Object { $_.BaseName -match '^\d{4}-\d{2}-\d{2}$' } |
    ForEach-Object { $_.BaseName } |
    Sort-Object -Unique
  if (-not $dates -or $dates.Count -eq 0) { return "" }
  $eligible = @($dates | Where-Object { $_ -le $PreferredDate })
  if ($eligible.Count -gt 0) { return ($eligible | Select-Object -Last 1) }
  return ($dates | Select-Object -Last 1)
}

function Resolve-LinkDate() {
  $count = Get-LinkFileCount $LinkDate
  if ($count -gt 0) {
    Log "Link source date $LinkDate has $count store files."
    return
  }
  $fallback = Get-LatestAvailableLinkDate $LinkDate
  if ([string]::IsNullOrWhiteSpace($fallback)) {
    Log "WARN no local SHEIN link files found; BI will keep existing warehouse link slices if any."
    return
  }
  $fallbackCount = Get-LinkFileCount $fallback
  Log "WARN link source date $LinkDate has no files; falling back to latest available link date $fallback ($fallbackCount store files)."
  $script:LinkDate = $fallback
}

Log "BI daily pipeline repo=$repo salesDate=$SalesDate linkDate=$LinkDate businessDate=$BusinessDate"
Resolve-LinkDate
Log "BI daily pipeline effective dates salesDate=$SalesDate linkDate=$LinkDate businessDate=$BusinessDate"

Run-Step "Initialize warehouse schema" {
  powershell -ExecutionPolicy Bypass -File .\scripts\init_bi_warehouse.ps1 `
    -Distro $Distro -Container $Container -Database $Database -User $User
}

if (-not $SkipSalesLinkLoad) {
  $dashboardJson = Get-LatestDashboardJson
  if ([string]::IsNullOrWhiteSpace($dashboardJson)) {
    Log "WARN no link dashboard json found; sales/link warehouse load will skip action candidates."
    Run-Step "Load sales/link warehouse" {
      node .\scripts\load_bi_warehouse.mjs --sales-date $SalesDate --link-date $LinkDate `
        --distro $Distro --container $Container --database $Database --user $User
    }
  } else {
    Log "Using dashboard json: $dashboardJson"
    Run-Step "Load sales/link warehouse" {
      node .\scripts\load_bi_warehouse.mjs --sales-date $SalesDate --link-date $LinkDate --dashboard-json "$dashboardJson" `
        --distro $Distro --container $Container --database $Database --user $User
    }
  }
}

if (-not $SkipBusinessFetch) {
  Run-NonBlocking-Step "Fetch SHEIN business domains for all enabled stores" {
    node .\scripts\fetch_shein_business_domains.mjs --group ALL --date $BusinessDate --wait-ms 2000 --max-pages 20
  }
}

if (-not $SkipBusinessLoad) {
  Run-Step "Load SHEIN business domains into warehouse" {
    node .\scripts\load_bi_business_domains.mjs --date $BusinessDate `
      --distro $Distro --container $Container --database $Database --user $User
  }
}

if (-not $SkipRtvVerify) {
  Run-NonBlocking-Step "Verify SHEIN RTV tracking handoff" {
    node .\scripts\verify_shein_rtv_tracking.mjs --priority high,medium,low --include-no-cases --limit 120 --case-limit 60 --max-runtime-ms 3600000 `
      --distro $Distro --container $Container --database $Database --user $User
  }
} else {
  Log "SKIP Verify SHEIN RTV tracking handoff"
}

Run-NonBlocking-Step "Import product costs and monthly storage fees if provided" {
  node .\scripts\import_product_costs.mjs --dir .\inputs\costs `
    --distro $Distro --container $Container --database $Database --user $User
}

Run-Step "Audit BI warehouse" {
  node .\scripts\audit_bi_warehouse.mjs --distro $Distro --container $Container --database $Database --user $User
}

Run-Step "Generate local BI portal" {
  node .\scripts\generate_bi_portal.mjs --distro $Distro --container $Container --database $Database --user $User
}

Run-NonBlocking-Step "Check BI portal UI smoke" {
  node .\scripts\check_bi_portal_ui.mjs --json
}

Log "DONE BI daily pipeline log=$logFile"

Run-NonBlocking-Step "Refresh local BI portal status after DONE" {
  node .\scripts\generate_bi_portal.mjs --distro $Distro --container $Container --database $Database --user $User
}

Run-Step "Generate BI Markdown briefing" {
  node .\scripts\generate_bi_briefing.mjs
}

Run-Step "Refresh local BI portal briefing status" {
  node .\scripts\generate_bi_portal.mjs --distro $Distro --container $Container --database $Database --user $User
}

Run-NonBlocking-Step "Generate BI first-run check report" {
  node .\scripts\check_bi_first_run.mjs
}

Run-Step "Refresh local BI portal first-run check status" {
  node .\scripts\generate_bi_portal.mjs --distro $Distro --container $Container --database $Database --user $User
}

Write-Output "BI daily pipeline completed. Log: $logFile"
Start-DelayedPostCheck "success"
