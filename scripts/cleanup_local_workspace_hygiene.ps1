[CmdletBinding()]
param(
  [switch]$Apply,
  [ValidateRange(1, 30)]
  [int]$MinimumAgeDays = 3,
  [string]$OutputPath = ''
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $Utf8NoBom
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$TmpRoot = [IO.Path]::GetFullPath((Join-Path $Root 'tmp')).TrimEnd('\')
$Cutoff = (Get-Date).AddDays(-$MinimumAgeDays)
$BrowserCleanupScript = Join-Path $PSScriptRoot 'cleanup_local_shein_browser_profile_cache.mjs'
$AllowedJunctionTargets = @(
  [IO.Path]::GetFullPath((Join-Path $Root 'profiles')).TrimEnd('\'),
  [IO.Path]::GetFullPath((Join-Path $Root 'node_modules')).TrimEnd('\')
)

function Write-AtomicJsonReport([object]$Value) {
  if ([string]::IsNullOrWhiteSpace($OutputPath)) { return }
  $resolved = [IO.Path]::GetFullPath($OutputPath)
  $parent = Split-Path -Parent $resolved
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  $temporary = "$resolved.tmp.$PID.$([guid]::NewGuid().ToString('N'))"
  $json = $Value | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText($temporary, $json, $Utf8NoBom)
  Move-Item -LiteralPath $temporary -Destination $resolved -Force
}

trap {
  $failure = [ordered]@{
    ok = $false
    mode = if ($Apply) { 'apply' } else { 'dry-run' }
    generatedAt = (Get-Date).ToString('o')
    root = $Root
    error = $_.Exception.Message
    errorType = $_.Exception.GetType().FullName
  }
  try { Write-AtomicJsonReport $failure } catch {}
  Write-Error $_.Exception.Message
  exit 1
}

function Test-ProcessReferencesPath([string]$Path) {
  $needle = [IO.Path]::GetFullPath($Path)
  return [bool](Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
    Select-Object -First 1)
}

function Remove-SafeRuntimeDirectory([System.IO.DirectoryInfo]$Directory) {
  $full = [IO.Path]::GetFullPath($Directory.FullName).TrimEnd('\')
  if (-not $full.StartsWith($TmpRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Runtime path escaped tmp root: $full"
  }
  if ($Directory.Name -notmatch '^cloud-marketing-(workers|local-runtime)-\d{8}-\d{4}$') {
    throw "Runtime path is not allowlisted: $full"
  }
  $reparsePoints = @(Get-ChildItem -LiteralPath $full -Force -Recurse -Attributes ReparsePoint -ErrorAction SilentlyContinue |
    Sort-Object { $_.FullName.Length } -Descending)
  foreach ($item in $reparsePoints) {
    $targets = @($item.Target | ForEach-Object { [IO.Path]::GetFullPath([string]$_).TrimEnd('\') })
    if ($item.LinkType -ne 'Junction' -or -not $targets.Count) {
      throw "Unsupported reparse point in runtime: $($item.FullName)"
    }
    foreach ($target in $targets) {
      if ($AllowedJunctionTargets -notcontains $target) {
        throw "Runtime junction target is not allowlisted: $($item.FullName) -> $target"
      }
    }
    [System.IO.Directory]::Delete($item.FullName)
  }
  Remove-Item -LiteralPath $full -Recurse -Force
}

$candidates = @(
  Get-ChildItem -LiteralPath $TmpRoot -Directory -Force -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -match '^cloud-marketing-(workers|local-runtime)-\d{8}-\d{4}$' -and
      $_.LastWriteTime -lt $Cutoff
    }
)

$runtime = @()
foreach ($directory in $candidates) {
  $active = Test-ProcessReferencesPath $directory.FullName
  $item = [ordered]@{
    path = $directory.FullName
    lastWriteTime = $directory.LastWriteTime.ToString('o')
    active = $active
    removed = $false
  }
  if ($Apply -and -not $active) {
    Remove-SafeRuntimeDirectory $directory
    $item.removed = $true
  }
  $runtime += [pscustomobject]$item
}

if ($Apply) {
  git -C $Root worktree prune
  git -C $Root remote prune origin 2>$null | Out-Null
}

$browserCache = $null
if ($Apply) {
  $browserOutput = & node $BrowserCleanupScript --apply --json
  $browserExit = $LASTEXITCODE
  try {
    $browserCache = ($browserOutput -join "`n") | ConvertFrom-Json
  } catch {
    throw "Browser cache cleanup returned invalid JSON: $($browserOutput -join ' ')"
  }
  if ($browserExit -ne 0 -or -not $browserCache.ok) {
    throw "Browser cache cleanup failed: $($browserCache.errors | ConvertTo-Json -Compress)"
  }
}

$branchCount = @(git -C $Root for-each-ref refs/heads --format='%(refname:short)').Count
$worktreeCount = @((git -C $Root worktree list --porcelain) | Where-Object { $_ -like 'worktree *' }).Count
$report = [ordered]@{
  ok = $true
  mode = if ($Apply) { 'apply' } else { 'dry-run' }
  generatedAt = (Get-Date).ToString('o')
  root = $Root
  minimumAgeDays = $MinimumAgeDays
  runtimeCandidates = $runtime
  browserCache = $browserCache
  branchCount = $branchCount
  worktreeCount = $worktreeCount
}
Write-AtomicJsonReport $report
$report | ConvertTo-Json -Depth 6
