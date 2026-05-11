param(
  [string]$Date = ""
)

. "$PSScriptRoot\use_utf8.ps1"

$ErrorActionPreference = "Continue"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Get-BjDate([int]$OffsetDays) {
  $utcNow = [DateTime]::UtcNow
  return $utcNow.AddHours(8).AddDays($OffsetDays).ToString("yyyy-MM-dd")
}

$TargetDate = $Date
if ([string]::IsNullOrWhiteSpace($TargetDate)) {
  # ET 仓库库存/出库/RTV/账单是操作型数据，按当天北京时间抓最新状态。
  $TargetDate = Get-BjDate 0
}
if ([string]::IsNullOrWhiteSpace($TargetDate)) {
  # Defensive fallback for Windows scheduled runs: never pass an empty --date to Node.
  $TargetDate = [DateTime]::UtcNow.AddHours(8).ToString("yyyy-MM-dd")
}
if ($TargetDate -notmatch '^\d{4}-\d{2}-\d{2}$') {
  throw "Invalid ET sync date: $TargetDate"
}

$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node -and (Test-Path -LiteralPath "D:\Program Files\nodejs\node.exe")) {
  $Node = "D:\Program Files\nodejs\node.exe"
}
if (-not $Node) {
  throw "Cannot find node.exe. Please install Node.js or add it to PATH."
}

$ExtraPath = @(
  (Split-Path -Parent $Node),
  "$env:LOCALAPPDATA\OpenAI\Codex\bin",
  "$env:APPDATA\npm"
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
$env:PATH = (($ExtraPath + @($env:PATH)) -join ';')

$LogDir = Join-Path $Root "logs\scheduled"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$LogFile = Join-Path $LogDir "et-forwarder-daily-$Stamp.log"

function Log([string]$Message) {
  "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message |
    Out-File -FilePath $LogFile -Encoding UTF8 -Append
}

function Invoke-LoggedCommand([string]$Name, [scriptblock]$Block) {
  Log "START $Name"
  $global:LASTEXITCODE = 0
  try {
    & $Block 2>&1 | ForEach-Object {
      "$_" | Out-File -FilePath $LogFile -Encoding UTF8 -Append
    }
    $code = $global:LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
    if ($code -eq 0) { Log "OK $Name" } else { Log "WARN $Name exited with code $code" }
    return $code
  } catch {
    Log "WARN $Name failed :: $($_.Exception.Message)"
    return 1
  }
}

function Send-EtIssueAlert([string]$Message) {
  Invoke-LoggedCommand "Send ET forwarder issue alert" {
    & $Node ".\scripts\notify_sync_issue.mjs" `
      --mode "et-forwarder-daily" `
      --date $TargetDate `
      --failed-stores "ET" `
      --message $Message `
      --log-file $LogFile
  } | Out-Null
}

Log "ET forwarder daily sync start date=$TargetDate"

$FetchExitCode = Invoke-LoggedCommand "Fetch ET forwarder daily artifacts for $TargetDate" {
  & $Node ".\scripts\fetch_et_forwarder.mjs" `
    --mode daily `
    --date $TargetDate `
    --overlap-rows 5 `
    --daily-initial-pages 2 `
    --max-details 50 `
    --wait-ms 250
}

if ($FetchExitCode -ne 0) {
  Log "WARN ET fetch failed; BI will keep previous ET warehouse data."
  Send-EtIssueAlert "ET forwarder daily fetch failed; BI will keep previous ET warehouse data until login/captcha/network is fixed."
  exit 1
}

$ManifestPath = ""
try {
  $latest = Get-Content -LiteralPath ".\outputs\et-forwarder\latest-manifest.json" -Raw -Encoding UTF8 | ConvertFrom-Json
  $ManifestPath = $latest.manifestPath
} catch {
  Log "WARN cannot read latest ET manifest :: $($_.Exception.Message)"
}

if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
  Log "WARN ET latest manifest path is empty."
  Send-EtIssueAlert "ET forwarder fetch succeeded but latest manifest could not be resolved; warehouse load skipped."
  exit 1
}

$LoadExitCode = Invoke-LoggedCommand "Load ET forwarder warehouse for $TargetDate" {
  & $Node ".\scripts\load_et_forwarder_warehouse.mjs" --manifest "$ManifestPath"
}

if ($LoadExitCode -ne 0) {
  Log "WARN ET warehouse load failed; raw files remain on disk."
  Send-EtIssueAlert "ET forwarder files were fetched but warehouse load failed; raw files remain on disk for retry."
  exit 1
}

try {
  $LoadedAt = (Get-Date).ToUniversalTime().ToString("o")
  $manifest = Get-Content -LiteralPath "$ManifestPath" -Raw -Encoding UTF8 | ConvertFrom-Json
  $manifest | Add-Member -NotePropertyName loadedAt -NotePropertyValue $LoadedAt -Force
  $manifest | Add-Member -NotePropertyName loadedLogFile -NotePropertyValue $LogFile -Force
  $manifest | ConvertTo-Json -Depth 20 | Out-File -FilePath "$ManifestPath" -Encoding UTF8
  $manifest | Add-Member -NotePropertyName manifestPath -NotePropertyValue $ManifestPath -Force
  $manifest | ConvertTo-Json -Depth 20 | Out-File -FilePath ".\outputs\et-forwarder\latest-manifest.json" -Encoding UTF8
} catch {
  Log "WARN cannot update loadedAt in ET manifest :: $($_.Exception.Message)"
}

Log "ET forwarder daily sync end date=$TargetDate ok=True log=$LogFile"
exit 0
