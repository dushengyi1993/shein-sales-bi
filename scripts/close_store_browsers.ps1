param(
  [string]$Group = "DSY",
  [string]$Stores = "",
  [switch]$WhatIf
)

. "$PSScriptRoot\use_utf8.ps1"

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$StoresPath = Join-Path $Root "config\stores.json"
if (-not (Test-Path -LiteralPath $StoresPath)) {
  throw "Missing stores config: $StoresPath"
}

$Config = Get-Content -LiteralPath $StoresPath -Raw -Encoding UTF8 | ConvertFrom-Json

if ($Stores.Trim()) {
  $TargetKeys = $Stores.Split(",") | ForEach-Object { $_.Trim().ToUpperInvariant() } | Where-Object { $_ }
}
else {
  $GroupObj = $Config.groups.$Group
  if (-not $GroupObj) {
    throw "Unknown group: $Group"
  }
  $TargetKeys = @($GroupObj | ForEach-Object { [string]$_ })
}

$Results = @()

foreach ($Key in $TargetKeys) {
  $Store = $Config.stores | Where-Object { $_.storeKey -eq $Key } | Select-Object -First 1
  if (-not $Store) {
    $Results += [ordered]@{ storeKey = $Key; ok = $false; action = "missing-store-config" }
    continue
  }

  $Port = [int]$Store.port
  $Conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $Conn) {
    $Results += [ordered]@{ storeKey = $Key; port = $Port; ok = $true; action = "already-closed" }
    continue
  }

  $ProcessId = [int]$Conn.OwningProcess
  $Proc = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
  $CommandLine = [string]$Proc.CommandLine
  $ExpectedProfileDir = Join-Path (Join-Path $Root "profiles") "persistent-$($Store.profileKey)-profile"
  $IsWorkspaceStoreChrome = $CommandLine.IndexOf($ExpectedProfileDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0

  if (-not $IsWorkspaceStoreChrome) {
    $Results += [ordered]@{
      storeKey = $Key
      port = $Port
      pid = $ProcessId
      ok = $false
      action = "skipped-non-workspace-process"
    }
    continue
  }

  if ($WhatIf) {
    $Results += [ordered]@{ storeKey = $Key; port = $Port; pid = $ProcessId; ok = $true; action = "would-close" }
    continue
  }

  Stop-Process -Id $ProcessId -Force
  $Results += [ordered]@{ storeKey = $Key; port = $Port; pid = $ProcessId; ok = $true; action = "closed" }
}

[ordered]@{
  ok = -not ($Results | Where-Object { -not $_.ok })
  group = $Group
  stores = $TargetKeys
  whatIf = [bool]$WhatIf
  results = $Results
} | ConvertTo-Json -Depth 6
