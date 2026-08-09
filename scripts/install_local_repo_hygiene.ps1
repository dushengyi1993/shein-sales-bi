[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')

if (-not (Test-Path -LiteralPath (Join-Path $Root '.git'))) {
  throw "Not a Git worktree: $Root"
}

git -C $Root config core.hooksPath .githooks
git -C $Root config fetch.prune true
git -C $Root config pull.ff only

$result = [ordered]@{
  ok = $true
  root = $Root
  hooksPath = (git -C $Root config --get core.hooksPath)
  fetchPrune = (git -C $Root config --get fetch.prune)
  pullFf = (git -C $Root config --get pull.ff)
}

if ($result.hooksPath -ne '.githooks' -or $result.fetchPrune -ne 'true' -or $result.pullFf -ne 'only') {
  throw "Local Git hygiene configuration did not persist: $($result | ConvertTo-Json -Compress)"
}

$result | ConvertTo-Json -Depth 3
