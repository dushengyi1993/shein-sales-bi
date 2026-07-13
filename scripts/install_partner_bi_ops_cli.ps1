param(
  [string]$SourceRoot = '',
  [string]$InstallRoot = "$HOME\.shein-bi\cli",
  [string]$CodexHome = "$HOME\.codex"
)

$ErrorActionPreference = 'Stop'
if (-not $SourceRoot) {
  $candidate = $PSScriptRoot
  if (-not (Test-Path -LiteralPath (Join-Path $candidate 'config\partner_cli_package.json'))) {
    $candidate = Split-Path -Parent $PSScriptRoot
  }
  $SourceRoot = $candidate
}
$SourceRoot = [IO.Path]::GetFullPath($SourceRoot)
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$CodexHome = [IO.Path]::GetFullPath($CodexHome)
$manifestFile = Join-Path $SourceRoot 'config\partner_cli_package.json'
if (-not (Test-Path -LiteralPath $manifestFile)) { throw "Package manifest not found: $manifestFile" }
$manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
if (-not $manifest.version -or -not $manifest.entrypoint -or -not $manifest.bootstrap -or -not $manifest.codexSkill) { throw 'Package manifest is invalid' }
$node = (Get-Command node -ErrorAction Stop).Source
$major = [int]((& $node -p "process.versions.node.split('.')[0]").Trim())
if ($major -lt 22) { throw "Node.js 22 or newer is required; current major version is $major" }
$versionRoot = Join-Path (Join-Path $InstallRoot 'versions') ([string]$manifest.version)
foreach ($relative in @($manifest.files)) {
  $relative = [string]$relative
  if ([IO.Path]::IsPathRooted($relative) -or @($relative -split '[\\/]').Contains('..')) { throw "Unsafe package path: $relative" }
  $source = Join-Path $SourceRoot ([string]$relative)
  if (-not (Test-Path -LiteralPath $source)) { throw "Required package file not found: $relative" }
  $target = Join-Path $versionRoot ([string]$relative)
  New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
  Copy-Item -LiteralPath $source -Destination $target -Force
}
New-Item -ItemType Directory -Path (Join-Path $versionRoot 'config') -Force | Out-Null
Copy-Item -LiteralPath $manifestFile -Destination (Join-Path $versionRoot 'config\partner_cli_package.json') -Force
$bootstrapSource = Join-Path $versionRoot ([string]$manifest.bootstrap)
if (-not (Test-Path -LiteralPath $bootstrapSource)) { throw "Bootstrap file not found: $($manifest.bootstrap)" }
$bootstrap = Join-Path $InstallRoot 'bootstrap.mjs'
Copy-Item -LiteralPath $bootstrapSource -Destination $bootstrap -Force
$skillSource = Join-Path $versionRoot ([string]$manifest.codexSkill)
if (-not (Test-Path -LiteralPath $skillSource)) { throw "Codex skill not found: $($manifest.codexSkill)" }
$skillTarget = Join-Path $CodexHome 'skills\shein-bi-ops\SKILL.md'
New-Item -ItemType Directory -Path (Split-Path -Parent $skillTarget) -Force | Out-Null
Copy-Item -LiteralPath $skillSource -Destination $skillTarget -Force
$launcher = Join-Path $InstallRoot 'shein-bi-ops.cmd'
$entry = Join-Path $versionRoot ([string]$manifest.entrypoint)
$launcherText = "@echo off`r`nnode `"%~dp0bootstrap.mjs`" %*`r`n"
[IO.File]::WriteAllText($launcher, $launcherText, [Text.Encoding]::ASCII)
$current = @{schemaVersion=2; version=[string]$manifest.version; entrypoint=$entry; entrypointRelative=[string]$manifest.entrypoint; installedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $InstallRoot 'current.json'), $current + "`n", (New-Object Text.UTF8Encoding($false)))
& $node $bootstrap version | Out-Null
Write-Output "Installed SHEIN BI Ops CLI $($manifest.version)"
Write-Output "Launcher: $launcher"
Write-Output "Codex skill: $skillTarget"
Write-Output "Login: `"$launcher`" login --username <BI account>"
