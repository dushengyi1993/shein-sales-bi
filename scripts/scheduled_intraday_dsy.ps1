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
$LogFile = Join-Path $LogDir "intraday-15stores-$Stamp.log"
$RunStartedAt = Get-Date

function Test-AllStoreSalesFilesReady([string]$Date) {
  $stores = @('DL','DX','FY','LQ','NM','HL','JY','ZL','TS','MZ','CX','YJ','XL','QY','QH')
  foreach ($store in $stores) {
    $file = Join-Path $Root ("outputs\shein_fetch\{0}\{1}.json" -f $store, $Date)
    if (-not (Test-Path -LiteralPath $file)) { return $false }
    if ((Get-Item -LiteralPath $file).Length -le 20) { return $false }
  }
  return $true
}

function Parse-JsonLinesFromLog([string]$File) {
  $items = @()
  if (-not (Test-Path -LiteralPath $File)) { return $items }
  foreach ($line in Get-Content -LiteralPath $File) {
    $t = [string]$line
    $t = $t.Trim()
    if (-not $t.StartsWith('{')) { continue }
    try {
      $items += ($t | ConvertFrom-Json)
    } catch {}
  }
  return $items
}

function Send-SyncIssueAlert([string]$Mode, [string]$Date, [string]$Reason) {
  $items = Parse-JsonLinesFromLog $LogFile
  $failed = @()
  $loginRequired = @()
  foreach ($item in $items) {
    if ($null -ne $item.storeKey -and $item.ok -eq $false) { $failed += [string]$item.storeKey }
    if ($item.loginRequiredStores) { $loginRequired += @($item.loginRequiredStores | ForEach-Object { [string]$_ }) }
    if ($item.failedStores) { $failed += @($item.failedStores | ForEach-Object { [string]$_.storeKey }) }
  }
  $failed = @($failed | Where-Object { $_ } | Sort-Object -Unique)
  $loginRequired = @($loginRequired | Where-Object { $_ } | Sort-Object -Unique)
  if ($failed.Count -eq 0 -and $loginRequired.Count -eq 0 -and [string]::IsNullOrWhiteSpace($Reason)) { return }
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Send sync issue alert failed=$($failed -join ',') loginRequired=$($loginRequired -join ',')" | Out-File -FilePath $LogFile -Encoding UTF8 -Append
  & $Node ".\scripts\notify_sync_issue.mjs" `
    --mode $Mode `
    --date $Date `
    --failed-stores ($failed -join ',') `
    --login-required-stores ($loginRequired -join ',') `
    --message $Reason `
    --log-file $LogFile 2>&1 |
    ForEach-Object { $_ | Out-File -FilePath $LogFile -Encoding UTF8 -Append }
}

Push-Location $Root
try {
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] SHEIN 15-store intraday sync start" | Out-File -FilePath $LogFile -Encoding UTF8
  & $Node ".\scripts\run_sales_sync_job.mjs" --mode intraday --group DSY --no-monthly --no-compact-display --no-dashboard 2>&1 |
    ForEach-Object { $_ | Out-File -FilePath $LogFile -Encoding UTF8 -Append }
  $DsyExitCode = $LASTEXITCODE
  & $Node ".\scripts\run_sales_sync_job.mjs" --mode intraday --group LGM --no-monthly --no-compact-display --no-dashboard 2>&1 |
    ForEach-Object { $_ | Out-File -FilePath $LogFile -Encoding UTF8 -Append }
  $LgmExitCode = $LASTEXITCODE
  $MonthlyExitCode = 0
  $CompactExitCode = 0
  $DashboardExitCode = 0
  $BiPostExitCode = 0
  if ($DsyExitCode -eq 0 -and $LgmExitCode -eq 0) {
    $Month = Get-Date -Format "yyyy-MM"
    & $Node ".\scripts\generate_monthly_sales_table.mjs" --month $Month --include-lgm 2>&1 |
      ForEach-Object { $_ | Out-File -FilePath $LogFile -Encoding UTF8 -Append }
    $MonthlyExitCode = $LASTEXITCODE
    if ($MonthlyExitCode -eq 0) {
      "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Publish dashboards before compact display tables." | Out-File -FilePath $LogFile -Encoding UTF8 -Append
      & $Node ".\scripts\setup_lark_dashboard_main_v3.mjs" --month $Month 2>&1 |
        ForEach-Object { $_ | Out-File -FilePath $LogFile -Encoding UTF8 -Append }
      $DashboardExitCode = $LASTEXITCODE
      if ($DashboardExitCode -eq 0) {
        & $Node ".\scripts\setup_lark_dashboard_previous_month.mjs" 2>&1 |
          ForEach-Object { $_ | Out-File -FilePath $LogFile -Encoding UTF8 -Append }
        $DashboardExitCode = $LASTEXITCODE
      }
    }
    if ($MonthlyExitCode -eq 0) {
      & $Node ".\scripts\generate_compact_display_tables.mjs" --group ALL --current-month $Month --recent-months 2 2>&1 |
        ForEach-Object { $_ | Out-File -FilePath $LogFile -Encoding UTF8 -Append }
      $CompactExitCode = $LASTEXITCODE
    }
  } else {
    $DashboardExitCode = 0
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Skip dashboard refresh because one group failed." | Out-File -FilePath $LogFile -Encoding UTF8 -Append
  }
  $ReportExitCode = 0
  $ExitCodeBeforeReport = if ($DsyExitCode -ne 0) { $DsyExitCode } elseif ($LgmExitCode -ne 0) { $LgmExitCode } elseif ($MonthlyExitCode -ne 0) { $MonthlyExitCode } elseif ($CompactExitCode -ne 0) { $CompactExitCode } elseif ($DashboardExitCode -ne 0) { $DashboardExitCode } else { 0 }
  $ReportFlag = Join-Path $Root ("state\daily-report-sent-" + (Get-Date -Format "yyyyMMdd") + ".flag")
  $ShouldSendDailyReport = ($ExitCodeBeforeReport -eq 0 -and $RunStartedAt.Hour -ge 8 -and $RunStartedAt.Hour -lt 12 -and -not (Test-Path -LiteralPath $ReportFlag))
  if ($ShouldSendDailyReport) {
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Morning intraday sync succeeded; send daily report now." | Out-File -FilePath $LogFile -Encoding UTF8 -Append
    & $Node ".\scripts\send_daily_lark_report.mjs" --send --visual 2>&1 |
      ForEach-Object { $_ | Out-File -FilePath $LogFile -Encoding UTF8 -Append }
    $ReportExitCode = $LASTEXITCODE
    if ($ReportExitCode -eq 0) {
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ReportFlag) | Out-Null
      "sentAt=$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" | Out-File -FilePath $ReportFlag -Encoding UTF8
    }
  }
  $ExitCode = if ($ExitCodeBeforeReport -ne 0) { $ExitCodeBeforeReport } elseif ($ReportExitCode -ne 0) { $ReportExitCode } else { 0 }
  $Today = Get-Date -Format "yyyy-MM-dd"
  $Yesterday = (Get-Date).AddDays(-1).ToString("yyyy-MM-dd")
  $SalesFilesReadyForBi = Test-AllStoreSalesFilesReady $Today
  if ($ExitCode -eq 0 -or $SalesFilesReadyForBi) {
    # Link management has its own 05:30 daily task.  Do not run it again from
    # daytime intraday sales sync; otherwise BI refresh is delayed by the heavy
    # link fetch + Feishu link-table write path.
    $RunLinkForMorning = $false
    $FullBusinessForMorning = ($RunStartedAt.Hour -ge 8 -and $RunStartedAt.Hour -lt 12)
    $PostArgs = @(
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", ".\scripts\run_bi_after_feishu_sync.ps1",
      "-Mode", "intraday",
      "-SalesDate", $Today,
      "-LinkDate", $Yesterday,
      "-BusinessDate", $Today,
      "-ParentLogFile", $LogFile
    )
    if ($RunLinkForMorning) { $PostArgs += "-RunLinkManagement" }
    if ($FullBusinessForMorning) { $PostArgs += "-FullBusinessFetch" }
    if ($ExitCode -eq 0) {
      "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Feishu intraday succeeded; refresh BI dual-run slice sales=$Today link=$Yesterday business=$Today runLink=$RunLinkForMorning fullBusiness=$FullBusinessForMorning." | Out-File -FilePath $LogFile -Encoding UTF8 -Append
    } else {
      "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Feishu intraday returned $ExitCode but 15 local sales files are ready; refresh BI sales slice anyway. sales=$Today link=$Yesterday business=$Today runLink=$RunLinkForMorning fullBusiness=$FullBusinessForMorning." | Out-File -FilePath $LogFile -Encoding UTF8 -Append
    }
    & powershell @PostArgs 2>&1 |
      ForEach-Object { $_ | Out-File -FilePath $LogFile -Encoding UTF8 -Append }
    $BiPostExitCode = $LASTEXITCODE
    if ($BiPostExitCode -ne 0) {
      "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] WARN BI post-refresh returned $BiPostExitCode; keep Feishu task result unchanged." | Out-File -FilePath $LogFile -Encoding UTF8 -Append
    }
  } else {
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Skip BI post-refresh because Feishu intraday/report failed." | Out-File -FilePath $LogFile -Encoding UTF8 -Append
  }
  if ($ExitCode -ne 0) {
    Send-SyncIssueAlert "intraday" $Today "?????????????????????? 15 ???????? BI ??????"
  }
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] SHEIN 15-store intraday sync end, dsy=$DsyExitCode, lgm=$LgmExitCode, monthly=$MonthlyExitCode, compact=$CompactExitCode, dashboard=$DashboardExitCode, report=$ReportExitCode, biPost=$BiPostExitCode, exit=$ExitCode" | Out-File -FilePath $LogFile -Encoding UTF8 -Append
  exit $ExitCode
}
finally {
  Pop-Location
}
