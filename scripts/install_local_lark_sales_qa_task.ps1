$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\use_utf8.ps1"

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$TaskName = 'SHEIN-Local-Lark-Sales-QA'
$StartScript = Join-Path $Root 'scripts\start_local_lark_sales_qa.ps1'

if (-not (Test-Path -LiteralPath $StartScript)) {
  throw "start script not found: $StartScript"
}

$PwshCommand = Get-Command pwsh.exe -ErrorAction SilentlyContinue
$Pwsh = $null
if ($PwshCommand) { $Pwsh = $PwshCommand.Source }
if (-not $Pwsh) {
  $Pwsh = 'C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.1.0_x64__8wekyb3d8bbwe\pwsh.exe'
}
if (-not (Test-Path -LiteralPath $Pwsh)) {
  throw "pwsh.exe not found: $Pwsh"
}

$CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$Argument = "-NoProfile -ExecutionPolicy Bypass -File `"$StartScript`""
$Action = New-ScheduledTaskAction -Execute $Pwsh -Argument $Argument -WorkingDirectory $Root
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $CurrentUser
$Principal = New-ScheduledTaskPrincipal -UserId $CurrentUser -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 2) `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Days 3650)

$Task = New-ScheduledTask -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings `
  -Description 'Start SHEIN local Lark sales QA event listener on user logon.'

Register-ScheduledTask -TaskName $TaskName -InputObject $Task -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 5

Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State, TaskPath
