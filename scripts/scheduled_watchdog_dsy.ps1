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
$LogFile = Join-Path $LogDir "watchdog-15stores-$Stamp.log"
$FeishuBasePauseFlag = Join-Path $Root "state\feishu-base-sync-paused.flag"
$FeishuBasePaused = Test-Path -LiteralPath $FeishuBasePauseFlag

Push-Location $Root
try {
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] SHEIN all-store watchdog start" | Out-File -FilePath $LogFile -Encoding UTF8
  if ($FeishuBasePaused) {
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Feishu Base/table/dashboard writes are paused by state\feishu-base-sync-paused.flag; watchdog only catches up local fetch/alerts." | Out-File -FilePath $LogFile -Encoding UTF8 -Append
  }
  & $Node ".\scripts\watchdog_sales_automation.mjs" --group DSY --no-sync-today --send-alert 2>&1 |
    ForEach-Object { $_ | Out-File -FilePath $LogFile -Encoding UTF8 -Append }
  $DsyExitCode = $LASTEXITCODE
  & $Node ".\scripts\watchdog_sales_automation.mjs" --group LGM --no-sync-today --send-alert 2>&1 |
    ForEach-Object { $_ | Out-File -FilePath $LogFile -Encoding UTF8 -Append }
  $LgmExitCode = $LASTEXITCODE
  $MonthlyExitCode = 0
  $CompactExitCode = 0
  $DashboardExitCode = 0
  if ($DsyExitCode -eq 0 -and $LgmExitCode -eq 0 -and -not $FeishuBasePaused) {
    $Month = Get-Date -Format "yyyy-MM"
    & $Node ".\scripts\generate_monthly_sales_table.mjs" --month $Month --include-lgm 2>&1 |
      ForEach-Object { $_ | Out-File -FilePath $LogFile -Encoding UTF8 -Append }
    $MonthlyExitCode = $LASTEXITCODE
    if ($MonthlyExitCode -eq 0) {
      & $Node ".\scripts\generate_compact_display_tables.mjs" --group ALL --current-month $Month --recent-months 2 2>&1 |
        ForEach-Object { $_ | Out-File -FilePath $LogFile -Encoding UTF8 -Append }
      $CompactExitCode = $LASTEXITCODE
    }
    if ($MonthlyExitCode -eq 0 -and $CompactExitCode -eq 0) {
      & $Node ".\scripts\setup_lark_dashboard_main_v3.mjs" --month $Month 2>&1 |
        ForEach-Object { $_ | Out-File -FilePath $LogFile -Encoding UTF8 -Append }
      $DashboardExitCode = $LASTEXITCODE
      if ($DashboardExitCode -eq 0) {
        & $Node ".\scripts\setup_lark_dashboard_previous_month.mjs" 2>&1 |
          ForEach-Object { $_ | Out-File -FilePath $LogFile -Encoding UTF8 -Append }
        $DashboardExitCode = $LASTEXITCODE
      }
    }
  } elseif ($FeishuBasePaused) {
    $DashboardExitCode = 0
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Skip Feishu monthly/display/dashboard refresh because Feishu Base sync is paused." | Out-File -FilePath $LogFile -Encoding UTF8 -Append
  } else {
    $DashboardExitCode = 0
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Skip dashboard refresh because one group failed." | Out-File -FilePath $LogFile -Encoding UTF8 -Append
  }
  $ExitCode = if ($DsyExitCode -ne 0) { $DsyExitCode } elseif ($LgmExitCode -ne 0) { $LgmExitCode } elseif ($MonthlyExitCode -ne 0) { $MonthlyExitCode } elseif ($CompactExitCode -ne 0) { $CompactExitCode } elseif ($DashboardExitCode -ne 0) { $DashboardExitCode } else { 0 }
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] SHEIN all-store watchdog end, dsy=$DsyExitCode, lgm=$LgmExitCode, monthly=$MonthlyExitCode, compact=$CompactExitCode, dashboard=$DashboardExitCode, exit=$ExitCode" | Out-File -FilePath $LogFile -Encoding UTF8 -Append
  exit $ExitCode
}
finally {
  Pop-Location
}
