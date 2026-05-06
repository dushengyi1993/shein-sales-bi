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

if ([string]::IsNullOrWhiteSpace($Date)) {
  # Run after midnight for the previous complete business day.
  $Date = Get-BjDate -1
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
$LogFile = Join-Path $LogDir "link-management-daily-$Stamp.log"

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

function Get-LinkJobFailureSummary([string]$TargetDate) {
  $jobDir = Join-Path $Root "logs\jobs"
  if (-not (Test-Path -LiteralPath $jobDir)) {
    return [pscustomobject]@{ failedStores = @(); summaryFile = "" }
  }
  $latest = Get-ChildItem -LiteralPath $jobDir -Filter ("link-management-{0}-*.json" -f $TargetDate) -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $latest) {
    return [pscustomobject]@{ failedStores = @(); summaryFile = "" }
  }
  try {
    $summary = Get-Content -LiteralPath $latest.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    $failed = @($summary.stores | Where-Object { -not $_.ok } | ForEach-Object { $_.storeKey })
    return [pscustomobject]@{ failedStores = $failed; summaryFile = $latest.FullName }
  } catch {
    return [pscustomobject]@{ failedStores = @(); summaryFile = $latest.FullName }
  }
}

function Send-LinkIssueAlert([int]$ExitCode, [string]$TargetDate) {
  $failure = Get-LinkJobFailureSummary $TargetDate
  $failedStores = ($failure.failedStores -join ',')
  if ([string]::IsNullOrWhiteSpace($failedStores)) { $failedStores = "UNKNOWN" }
  $message = "Link-management daily sync had partial failures; successful stores were synced and BI refresh will continue."
  if (-not [string]::IsNullOrWhiteSpace($failure.summaryFile)) {
    $message = "$message jobSummary=$($failure.summaryFile)"
  }
  Invoke-LoggedCommand "Send link-management issue alert" {
    & $Node ".\scripts\notify_sync_issue.mjs" `
      --mode "link-management-daily" `
      --date $TargetDate `
      --failed-stores $failedStores `
      --message $message `
      --log-file $LogFile
  } | Out-Null
}

Log "SHEIN link-management + business-domain daily fetch start date=$Date"

$LinkExitCode = Invoke-LoggedCommand "Run link-management fetch/local artifacts for $Date" {
  & $Node ".\scripts\run_link_management_job.mjs" --group ALL --date $Date --headless-browser --allow-partial --no-lark
}

if ($LinkExitCode -ne 0) {
  Log "WARN link-management fetch returned non-zero; will alert, continue business-domain fetch, and let 07:00 BI refresh use latest available link snapshot."
  Send-LinkIssueAlert -ExitCode $LinkExitCode -TargetDate $Date
}

$BusinessExitCode = Invoke-LoggedCommand "Fetch SHEIN business domains for $Date" {
  & $Node ".\scripts\fetch_shein_business_domains.mjs" `
    --group ALL `
    --date $Date `
    --wait-ms 2000 `
    --max-pages 20 `
    --store-attempts 2 `
    --relogin-headless `
    --json
}

if ($BusinessExitCode -ne 0) {
  Log "WARN business-domain fetch returned non-zero; successful stores/domains remain on disk and 07:00 BI refresh will load what is available."
  Invoke-LoggedCommand "Send business-domain issue alert" {
    & $Node ".\scripts\notify_sync_issue.mjs" `
      --mode "business-domain-daily" `
      --date $Date `
      --failed-stores "UNKNOWN" `
      --message "05:30 business-domain fetch had partial failures; successful stores/domains were saved and 07:00 BI refresh will continue with available data." `
      --log-file $LogFile
  } | Out-Null
}

$Ok = ($LinkExitCode -eq 0 -and $BusinessExitCode -eq 0)
Log "SHEIN link-management + business-domain daily fetch end date=$Date linkExit=$LinkExitCode businessExit=$BusinessExitCode ok=$Ok log=$LogFile"

if ($Ok) { exit 0 }
exit 1
