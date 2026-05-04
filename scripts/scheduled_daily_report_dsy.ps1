param()

. "$PSScriptRoot\use_utf8.ps1"

$ErrorActionPreference = "Continue"

$Root = Split-Path -Parent $PSScriptRoot
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
$LogFile = Join-Path $LogDir "daily-report-15stores-$Stamp.log"
$ReportFlag = Join-Path $Root ("state\daily-report-sent-" + (Get-Date -Format "yyyyMMdd") + ".flag")

Push-Location $Root
try {
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] SHEIN 15-store daily report start" | Out-File -FilePath $LogFile -Encoding UTF8
  if (Test-Path -LiteralPath $ReportFlag) {
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Daily report already sent today; skip." | Out-File -FilePath $LogFile -Encoding UTF8 -Append
    exit 0
  }
  & $Node ".\scripts\send_daily_lark_report.mjs" --send --visual 2>&1 |
    ForEach-Object { $_ | Out-File -FilePath $LogFile -Encoding UTF8 -Append }
  $ExitCode = $LASTEXITCODE
  if ($ExitCode -eq 0) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ReportFlag) | Out-Null
    "sentAt=$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" | Out-File -FilePath $ReportFlag -Encoding UTF8
  }
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] SHEIN 15-store daily report end, exit=$ExitCode" | Out-File -FilePath $LogFile -Encoding UTF8 -Append
  exit $ExitCode
}
finally {
  Pop-Location
}


