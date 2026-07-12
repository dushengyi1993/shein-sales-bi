param(
  [string]$BaseUrl = 'https://sa.dushengyi.cc',
  [string]$CredentialFile = "$HOME\.codex\owner-knowledge\device.json",
  [string]$StateFile = "$HOME\.codex\owner-knowledge\sync-state.json",
  [string]$TaskName = 'SHEIN-Owner-Knowledge-Sync',
  [int]$IntervalSeconds = 60,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed $TaskName"
  exit 0
}

$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $PSScriptRoot 'owner_knowledge_sync.mjs'
if (-not (Test-Path -LiteralPath $script)) { throw "Sync script not found: $script" }
if (-not (Test-Path -LiteralPath $CredentialFile)) { throw "Device credential not found: $CredentialFile" }
$node = (Get-Command node -ErrorAction Stop).Source

$arguments = @(
  ('"{0}"' -f $script),
  'watch',
  '--base-url', ('"{0}"' -f $BaseUrl),
  '--credential-file', ('"{0}"' -f $CredentialFile),
  '--state-file', ('"{0}"' -f $StateFile),
  '--project-root', ('"{0}"' -f $root),
  '--interval-seconds', [string][Math]::Max(15, $IntervalSeconds)
) -join ' '

$action = New-ScheduledTaskAction -Execute $node -Argument $arguments -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'One-way owner Codex and CLI knowledge sync to SHEIN BI. Coworker accounts cannot publish back.' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Installed and started $TaskName"
