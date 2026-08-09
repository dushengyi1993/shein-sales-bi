[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$CleanupScript = Join-Path $PSScriptRoot 'cleanup_local_workspace_hygiene.ps1'
$LogDir = Join-Path $Root 'logs'
$LogFile = Join-Path $LogDir 'local-workspace-hygiene-latest.json'
$TaskName = 'SHEIN-BI-Local-Workspace-Hygiene'

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$command = "& '$($CleanupScript.Replace("'", "''"))' -Apply -MinimumAgeDays 3 | Set-Content -LiteralPath '$($LogFile.Replace("'", "''"))' -Encoding UTF8"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command `"$command`"" -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At '18:20'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Safely prunes stale SHEIN BI local marketing runtimes and Git worktree metadata.' -Force | Out-Null

$task = Get-ScheduledTask -TaskName $TaskName
[ordered]@{
  ok = $true
  taskName = $TaskName
  state = [string]$task.State
  cleanupScript = $CleanupScript
  logFile = $LogFile
  nextRunTime = (Get-ScheduledTaskInfo -TaskName $TaskName).NextRunTime.ToString('o')
} | ConvertTo-Json -Depth 3
