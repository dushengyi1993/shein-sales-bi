param(
  [int]$Port = 8787,
  [switch]$DisableFirewall
)

. "$PSScriptRoot\use_utf8.ps1"

$ErrorActionPreference = "Continue"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$ts = Get-Date -Format "yyyyMMdd-HHmmss"
$archiveDir = Join-Path $repo "outputs\local-bi-archive"
New-Item -ItemType Directory -Force -Path $archiveDir | Out-Null

$taskSnapshotPath = Join-Path $archiveDir "scheduled-tasks-before-$ts.json"
$summaryPath = Join-Path $archiveDir "archive-summary-$ts.json"

$tasks = Get-ScheduledTask | Where-Object { $_.TaskName -like "SHEIN-*" } | Sort-Object TaskName
$tasks | Select-Object TaskName,TaskPath,State | ConvertTo-Json -Depth 4 | Set-Content -Path $taskSnapshotPath -Encoding UTF8

$stoppedProcesses = @()
$connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($conn in $connections) {
  $owningProcessId = $conn.OwningProcess
  if ($owningProcessId -and -not ($stoppedProcesses | Where-Object { $_.Pid -eq $owningProcessId })) {
    $proc = Get-Process -Id $owningProcessId -ErrorAction SilentlyContinue
    if ($proc) {
      try {
        Stop-Process -Id $owningProcessId -Force -ErrorAction Stop
        $stoppedProcesses += [pscustomobject]@{
          Pid = $owningProcessId
          ProcessName = $proc.ProcessName
          Path = $proc.Path
          Stopped = $true
        }
      } catch {
        $stoppedProcesses += [pscustomobject]@{
          Pid = $owningProcessId
          ProcessName = $proc.ProcessName
          Path = $proc.Path
          Stopped = $false
          Error = $_.Exception.Message
        }
      }
    }
  }
}

$disabledTasks = @()
foreach ($task in $tasks) {
  try {
    Disable-ScheduledTask -TaskPath $task.TaskPath -TaskName $task.TaskName -ErrorAction Stop | Out-Null
    $disabledTasks += [pscustomobject]@{
      TaskName = $task.TaskName
      Disabled = $true
    }
  } catch {
    $disabledTasks += [pscustomobject]@{
      TaskName = $task.TaskName
      Disabled = $false
      Error = $_.Exception.Message
    }
  }
}

$firewallResult = $null
if ($DisableFirewall) {
  $rule = Get-NetFirewallRule -DisplayName "SHEIN BI Portal LAN 8787 ReadOnly" -ErrorAction SilentlyContinue
  if ($rule) {
    try {
      $rule | Set-NetFirewallRule -Enabled False -ErrorAction Stop
      $firewallResult = [pscustomobject]@{
        Rule = $rule.DisplayName
        Disabled = $true
      }
    } catch {
      $firewallResult = [pscustomobject]@{
        Rule = $rule.DisplayName
        Disabled = $false
        Error = $_.Exception.Message
        Note = "Disabling Windows Firewall rules requires elevated PowerShell."
      }
    }
  } else {
    $firewallResult = [pscustomobject]@{
      Rule = "SHEIN BI Portal LAN 8787 ReadOnly"
      Disabled = $false
      Error = "Rule not found."
    }
  }
}

$remainingListeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalAddress,LocalPort,State,OwningProcess

$summary = [pscustomobject]@{
  Timestamp = $ts
  Port = $Port
  TaskSnapshot = $taskSnapshotPath
  StoppedProcesses = $stoppedProcesses
  DisabledTasks = $disabledTasks
  Firewall = $firewallResult
  RemainingListeners = $remainingListeners
}

$summary | ConvertTo-Json -Depth 8 | Set-Content -Path $summaryPath -Encoding UTF8
$summary | ConvertTo-Json -Depth 8
