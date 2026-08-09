[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$CleanupScript = Join-Path $PSScriptRoot 'cleanup_local_workspace_hygiene.ps1'
$LogDir = Join-Path $Root 'logs'
$LogFile = Join-Path $LogDir 'local-workspace-hygiene-latest.json'
$TaskName = 'SHEIN-BI-Local-Workspace-Hygiene'

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$CleanupScript`" -Apply -MinimumAgeDays 3 -OutputPath `"$LogFile`""
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $Root
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
  arguments = $arguments
  nextRunTime = (Get-ScheduledTaskInfo -TaskName $TaskName).NextRunTime.ToString('o')
} | ConvertTo-Json -Depth 3
