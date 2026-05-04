param(
  [string]$Distro = "Ubuntu-24.04",
  [string]$Container = "shein-warehouse-db",
  [string]$Database = "shein_bi",
  [string]$User = "shein",
  [switch]$DryRun
)

. "$PSScriptRoot\use_utf8.ps1"

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Get-BjDate([int]$OffsetDays) {
  $utcNow = [DateTime]::UtcNow
  return $utcNow.AddHours(8).AddDays($OffsetDays).ToString("yyyy-MM-dd")
}

# Daily BI refresh is intended to run after the final yesterday sales job and
# after the 05:30 link-management job. Therefore all business dates default to
# Beijing yesterday.
$targetDate = Get-BjDate -1
$pipelineScript = Join-Path $repo "scripts\run_bi_daily_pipeline.ps1"

if ($DryRun) {
  [pscustomobject]@{
    ok = $true
    mode = "dry-run"
    repo = $repo
    pipelineScript = $pipelineScript
    salesDate = $targetDate
    linkDate = $targetDate
    businessDate = $targetDate
    distro = $Distro
    container = $Container
    database = $Database
    user = $User
    note = "No SHEIN fetch, no Feishu sync, no database write."
  } | ConvertTo-Json -Compress
  exit 0
}

powershell -NoProfile -ExecutionPolicy Bypass -File $pipelineScript `
  -SalesDate $targetDate `
  -LinkDate $targetDate `
  -BusinessDate $targetDate `
  -Distro $Distro `
  -Container $Container `
  -Database $Database `
  -User $User
