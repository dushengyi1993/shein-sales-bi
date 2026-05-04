param()

. "$PSScriptRoot\use_utf8.ps1"

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$portal = Join-Path $repo "outputs\bi-portal\index.html"

if (-not (Test-Path -LiteralPath $portal)) {
  throw "SHEIN BI portal not found: $portal. Please run scripts\run_bi_daily_pipeline.ps1 first."
}

Start-Process -FilePath $portal
