param(
  [string]$TaskPrefix = "SHEIN-Sales",
  [string]$IntradayTimes = "08:10,10:10,12:10,14:10,16:10,18:10,20:10,22:10",
  [string]$YesterdayFinalTime = "00:10",
  [string]$EtForwarderTime = "04:20",
  [string]$LinkManagementTime = "05:30",
  [string]$DailyReportTime = "09:00",
  [string]$WatchdogDailyTime = "09:20",
  [string]$OpenApiYesterdayFinalTime = "00:25",
  [string]$OpenApiIntradayTimes = "12:25",
  [switch]$IncludeLinkManagement,
  [switch]$IncludeEtForwarder,
  [switch]$IncludeDailyReport,
  [switch]$IncludeWatchdog,
  [switch]$IncludeOpenApiPilot
)

. "$PSScriptRoot\use_utf8.ps1"

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$PowerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$WScript = "$env:SystemRoot\System32\wscript.exe"
$UserId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$IntradayScript = Join-Path $Root "scripts\scheduled_intraday_dsy.ps1"
$YesterdayScript = Join-Path $Root "scripts\scheduled_yesterday_final_dsy.ps1"
$EtForwarderScript = Join-Path $Root "scripts\scheduled_et_forwarder_daily.ps1"
$LinkManagementScript = Join-Path $Root "scripts\scheduled_link_management_daily.ps1"
$DailyReportScript = Join-Path $Root "scripts\scheduled_daily_report_dsy.ps1"
$WatchdogScript = Join-Path $Root "scripts\scheduled_watchdog_dsy.ps1"
$OpenApiIntradayScript = Join-Path $Root "scripts\scheduled_openapi_hl_intraday.ps1"
$OpenApiYesterdayScript = Join-Path $Root "scripts\scheduled_openapi_hl_yesterday_final.ps1"
$HiddenLauncher = Join-Path $Root "scripts\run_scheduled_hidden.vbs"

if (-not (Test-Path -LiteralPath $IntradayScript)) {
  throw "Missing script: $IntradayScript"
}
if (-not (Test-Path -LiteralPath $YesterdayScript)) {
  throw "Missing script: $YesterdayScript"
}
if (-not (Test-Path -LiteralPath $HiddenLauncher)) {
  throw "Missing hidden launcher: $HiddenLauncher"
}
if ($IncludeDailyReport -and -not (Test-Path -LiteralPath $DailyReportScript)) {
  throw "Missing script: $DailyReportScript"
}
if ($IncludeLinkManagement -and -not (Test-Path -LiteralPath $LinkManagementScript)) {
  throw "Missing script: $LinkManagementScript"
}
if ($IncludeEtForwarder -and -not (Test-Path -LiteralPath $EtForwarderScript)) {
  throw "Missing script: $EtForwarderScript"
}
if ($IncludeWatchdog -and -not (Test-Path -LiteralPath $WatchdogScript)) {
  throw "Missing script: $WatchdogScript"
}
if ($IncludeOpenApiPilot -and -not (Test-Path -LiteralPath $OpenApiIntradayScript)) {
  throw "Missing script: $OpenApiIntradayScript"
}
if ($IncludeOpenApiPilot -and -not (Test-Path -LiteralPath $OpenApiYesterdayScript)) {
  throw "Missing script: $OpenApiYesterdayScript"
}

function Register-InteractiveTask {
  param(
    [string]$TaskName,
    [string]$Description,
    [string]$ScriptPath,
    [Microsoft.Management.Infrastructure.CimInstance[]]$Trigger
  )

  $Action = New-ScheduledTaskAction `
    -Execute $WScript `
    -Argument "`"$HiddenLauncher`" `"$ScriptPath`" `"$Root`"" `
    -WorkingDirectory $Root

  $Principal = New-ScheduledTaskPrincipal `
    -UserId $UserId `
    -LogonType Interactive `
    -RunLevel Limited

  $Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 90) `
    -MultipleInstances IgnoreNew

  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Principal $Principal `
    -Settings $Settings `
    -Description $Description `
    -Force | Out-Null
}

$IntradayTriggers = @()
$IntradayScheduleTimes = @()
foreach ($TimeText in ($IntradayTimes -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
  $At = [datetime]::ParseExact($TimeText, "HH:mm", $null)
  $IntradayTriggers += New-ScheduledTaskTrigger -Daily -At $At
  $IntradayScheduleTimes += $At.ToString("HH:mm")
}

$YesterdayAt = [datetime]::ParseExact($YesterdayFinalTime, "HH:mm", $null)
$YesterdayTrigger = New-ScheduledTaskTrigger -Daily -At $YesterdayAt
$EtForwarderAt = [datetime]::ParseExact($EtForwarderTime, "HH:mm", $null)
$EtForwarderTrigger = New-ScheduledTaskTrigger -Daily -At $EtForwarderAt
$LinkManagementAt = [datetime]::ParseExact($LinkManagementTime, "HH:mm", $null)
$LinkManagementTrigger = New-ScheduledTaskTrigger -Daily -At $LinkManagementAt
$DailyReportAt = [datetime]::ParseExact($DailyReportTime, "HH:mm", $null)
$DailyReportTrigger = New-ScheduledTaskTrigger -Daily -At $DailyReportAt
$WatchdogLogonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId
$WatchdogDailyTrigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::ParseExact($WatchdogDailyTime, "HH:mm", $null))
$OpenApiIntradayTriggers = @()
$OpenApiIntradayScheduleTimes = @()
foreach ($TimeText in ($OpenApiIntradayTimes -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
  $At = [datetime]::ParseExact($TimeText, "HH:mm", $null)
  $OpenApiIntradayTriggers += New-ScheduledTaskTrigger -Daily -At $At
  $OpenApiIntradayScheduleTimes += $At.ToString("HH:mm")
}
$OpenApiYesterdayAt = [datetime]::ParseExact($OpenApiYesterdayFinalTime, "HH:mm", $null)
$OpenApiYesterdayTrigger = New-ScheduledTaskTrigger -Daily -At $OpenApiYesterdayAt

$LegacyIntradayTaskName = "$TaskPrefix-DSY-Intraday-6H"
$IntradayTaskName = "$TaskPrefix-15Stores-Intraday-Daytime"
$YesterdayTaskName = "$TaskPrefix-15Stores-YesterdayFinal-0010"
$EtForwarderTaskName = "$TaskPrefix-ETForwarder-" + ($EtForwarderTime -replace ":", "")
$LinkManagementTaskName = "$TaskPrefix-15Stores-LinkManagement-" + ($LinkManagementTime -replace ":", "")
$DailyReportTaskName = "$TaskPrefix-15Stores-DailyReport-0900"
$WatchdogTaskName = "$TaskPrefix-15Stores-Watchdog-Logon"
$OpenApiIntradayTaskName = "$TaskPrefix-OpenAPI-HL-Intraday-" + ($OpenApiIntradayScheduleTimes -join "-" -replace ":", "")
$OpenApiYesterdayTaskName = "$TaskPrefix-OpenAPI-HL-YesterdayFinal-" + ($OpenApiYesterdayFinalTime -replace ":", "")

foreach ($LegacyName in @($LegacyIntradayTaskName, "$TaskPrefix-DSY-Intraday-3H", "$TaskPrefix-DSY-YesterdayFinal-0200", "$TaskPrefix-DSY-DailyReport-0900", "$TaskPrefix-DSY-Watchdog-Logon", "$TaskPrefix-15Stores-Intraday-3H", "$TaskPrefix-15Stores-YesterdayFinal-0200", "$TaskPrefix-15Stores-LinkManagement-0340", "$TaskPrefix-15Stores-LinkManagement-0510")) {
  if (Get-ScheduledTask -TaskName $LegacyName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $LegacyName -Confirm:$false
  }
}

if (-not $IncludeDailyReport -and (Get-ScheduledTask -TaskName $DailyReportTaskName -ErrorAction SilentlyContinue)) {
  Unregister-ScheduledTask -TaskName $DailyReportTaskName -Confirm:$false
}

if (-not $IncludeLinkManagement -and (Get-ScheduledTask -TaskName $LinkManagementTaskName -ErrorAction SilentlyContinue)) {
  Unregister-ScheduledTask -TaskName $LinkManagementTaskName -Confirm:$false
}

if (-not $IncludeEtForwarder -and (Get-ScheduledTask -TaskName $EtForwarderTaskName -ErrorAction SilentlyContinue)) {
  Unregister-ScheduledTask -TaskName $EtForwarderTaskName -Confirm:$false
}

Register-InteractiveTask `
  -TaskName $IntradayTaskName `
  -Description "SHEIN all-store intraday sales sync at daytime checkpoints $($IntradayScheduleTimes -join ', '), Beijing time. Workspace: $Root" `
  -ScriptPath $IntradayScript `
  -Trigger $IntradayTriggers

Register-InteractiveTask `
  -TaskName $YesterdayTaskName `
  -Description "SHEIN all-store previous-day final sales sync after midnight at $YesterdayFinalTime Beijing time. Workspace: $Root" `
  -ScriptPath $YesterdayScript `
  -Trigger @($YesterdayTrigger)

if ($IncludeLinkManagement) {
  Register-InteractiveTask `
    -TaskName $LinkManagementTaskName `
    -Description "SHEIN all-store link-management + business-domain fetch at $LinkManagementTime Beijing time. Fetches previous complete day links, after-sales, stock, comments, fulfillment, finance and quality files; BI loads them later. Workspace: $Root" `
    -ScriptPath $LinkManagementScript `
    -Trigger @($LinkManagementTrigger)
}

if ($IncludeEtForwarder) {
  Register-InteractiveTask `
    -TaskName $EtForwarderTaskName `
    -Description "ET forwarder warehouse read-only sync at $EtForwarderTime Beijing time. Uses incremental overlap cursor, loads local warehouse tables, and never writes to ET backend. Workspace: $Root" `
    -ScriptPath $EtForwarderScript `
    -Trigger @($EtForwarderTrigger)
}

if ($IncludeDailyReport) {
  Register-InteractiveTask `
    -TaskName $DailyReportTaskName `
    -Description "SHEIN all-store daily Lark report at $DailyReportTime Beijing time, using the morning sync data. Workspace: $Root" `
    -ScriptPath $DailyReportScript `
    -Trigger @($DailyReportTrigger)
}

if ($IncludeWatchdog) {
  Register-InteractiveTask `
    -TaskName $WatchdogTaskName `
    -Description "SHEIN all-store watchdog at Windows logon and $WatchdogDailyTime. It catches up missed final syncs after reboot/offline time and does not run an extra today sync. Workspace: $Root" `
    -ScriptPath $WatchdogScript `
    -Trigger @($WatchdogLogonTrigger, $WatchdogDailyTrigger)
}

if ($IncludeOpenApiPilot) {
  Register-InteractiveTask `
    -TaskName $OpenApiYesterdayTaskName `
    -Description "SHEIN official OpenAPI pilot for HL previous-day final sales reconciliation at $OpenApiYesterdayFinalTime Beijing time. Writes only parallel OpenAPI tables and BI reconciliation. Workspace: $Root" `
    -ScriptPath $OpenApiYesterdayScript `
    -Trigger @($OpenApiYesterdayTrigger)

  Register-InteractiveTask `
    -TaskName $OpenApiIntradayTaskName `
    -Description "SHEIN official OpenAPI pilot for HL intraday sales reconciliation at $($OpenApiIntradayScheduleTimes -join ', ') Beijing time. Writes only parallel OpenAPI tables and BI reconciliation. Workspace: $Root" `
    -ScriptPath $OpenApiIntradayScript `
    -Trigger $OpenApiIntradayTriggers
}

$Tasks = Get-ScheduledTask -TaskName "$TaskPrefix-*" | Select-Object TaskName, State, TaskPath
$Result = [ordered]@{
  ok = $true
  user = $UserId
  workspace = $Root
  intraday = @{
    taskName = $IntradayTaskName
    schedule = "Daily at " + ($IntradayScheduleTimes -join ", ")
    script = $IntradayScript
  }
  yesterdayFinal = @{
    taskName = $YesterdayTaskName
    schedule = "Daily at $YesterdayFinalTime"
    script = $YesterdayScript
  }
  etForwarder = if ($IncludeEtForwarder) {
    @{
      taskName = $EtForwarderTaskName
      schedule = "Daily at $EtForwarderTime"
      script = $EtForwarderScript
    }
  } else {
    @{
      installed = $false
      reason = "Pass -IncludeEtForwarder to install the ET forwarder warehouse sync."
    }
  }
  linkManagement = if ($IncludeLinkManagement) {
    @{
      taskName = $LinkManagementTaskName
      schedule = "Daily at $LinkManagementTime"
      script = $LinkManagementScript
    }
  } else {
    @{
      installed = $false
      reason = "Pass -IncludeLinkManagement to install the daily link-management sync."
    }
  }
  dailyReport = if ($IncludeDailyReport) {
    @{
      taskName = $DailyReportTaskName
      schedule = "Daily at $DailyReportTime"
      script = $DailyReportScript
    }
  } else {
    @{
      installed = $false
      reason = "Pass -IncludeDailyReport after confirming report recipient, content, and identity."
    }
  }
  watchdog = if ($IncludeWatchdog) {
    @{
      taskName = $WatchdogTaskName
      schedule = "At Windows logon and daily at $WatchdogDailyTime"
      script = $WatchdogScript
    }
  } else {
    @{
      installed = $false
      reason = "Pass -IncludeWatchdog to install reboot/logon recovery and catch-up."
    }
  }
  openApiPilot = if ($IncludeOpenApiPilot) {
    @{
      yesterdayFinal = @{
        taskName = $OpenApiYesterdayTaskName
        schedule = "Daily at $OpenApiYesterdayFinalTime"
        script = $OpenApiYesterdayScript
      }
      intraday = @{
        taskName = $OpenApiIntradayTaskName
        schedule = "Daily at " + ($OpenApiIntradayScheduleTimes -join ", ")
        script = $OpenApiIntradayScript
      }
    }
  } else {
    @{
      installed = $false
      reason = "Pass -IncludeOpenApiPilot to install HL official OpenAPI pilot reconciliation tasks."
    }
  }
  legacyRemoved = $true
  tasks = $Tasks
}

$Result | ConvertTo-Json -Depth 6
