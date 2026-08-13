param(
  [string]$BaseUrl = 'https://sa.dushengyi.cc',
  [string]$CredentialFile = "$HOME\.codex\owner-knowledge\device.json",
  [string]$TaskName = 'SHEIN-Owner-Knowledge-Completion-Uploader',
  [int]$IntervalSeconds = 30,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$LegacyTaskName = 'SHEIN-Owner-Knowledge-Sync'
Unregister-ScheduledTask -TaskName $LegacyTaskName -Confirm:$false -ErrorAction SilentlyContinue
if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "已移除负责人规则任务结束上传器"
  exit 0
}

$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $PSScriptRoot 'owner_knowledge_sync.mjs'
$node = (Get-Command node -ErrorAction Stop).Source
$wscript = "$env:SystemRoot\System32\wscript.exe"
$hiddenLauncher = Join-Path $PSScriptRoot 'run_scheduled_hidden.vbs'
if (-not (Test-Path -LiteralPath $CredentialFile)) { throw "负责人设备凭据不存在：$CredentialFile" }

function Quote([string]$Value) { return '"' + $Value.Replace('"', '""') + '"' }
$arguments = @(
  (Quote $hiddenLauncher), 'run', (Quote $node), (Quote $root), (Quote $script), 'upload',
  '--base-url', (Quote $BaseUrl), '--credential-file', (Quote $CredentialFile),
  '--interval-seconds', [string][Math]::Max(5, $IntervalSeconds)
) -join ' '

$action = New-ScheduledTaskAction -Execute $wscript -Argument $arguments -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description '仅上传负责人任务结束规则检查单；不扫描历史会话；全程隐藏运行。' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "已安装并启动 $TaskName"
