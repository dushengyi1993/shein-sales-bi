param(
  [string]$OutputDir = '',
  [string]$SourceRoot = ''
)

$ErrorActionPreference = 'Stop'
if (-not $SourceRoot) { $SourceRoot = Split-Path -Parent $PSScriptRoot }
$SourceRoot = [IO.Path]::GetFullPath($SourceRoot)
if (-not $OutputDir) { $OutputDir = Join-Path $SourceRoot 'outputs\releases' }
$OutputDir = [IO.Path]::GetFullPath($OutputDir)
$manifestFile = Join-Path $SourceRoot 'config\partner_cli_package.json'
$manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
$name = "shein-bi-ops-cli-$($manifest.version)"
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ($name + '-' + [Guid]::NewGuid().ToString('N'))
$stage = Join-Path $tempRoot $name

function Get-Sha256Hex([string]$Path) {
  $stream = $null
  $sha = $null
  try {
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    return ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant()
  } finally {
    if ($sha) { $sha.Dispose() }
    if ($stream) { $stream.Dispose() }
  }
}

try {
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  foreach ($relative in @($manifest.files)) {
    $relative = [string]$relative
    if ([IO.Path]::IsPathRooted($relative) -or @($relative -split '[\\/]').Contains('..')) { throw "Unsafe package path: $relative" }
    $source = Join-Path $SourceRoot ([string]$relative)
    if (-not (Test-Path -LiteralPath $source)) { throw "Required package file not found: $relative" }
    $target = Join-Path $stage ([string]$relative)
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $target -Force
  }
  New-Item -ItemType Directory -Path (Join-Path $stage 'config') -Force | Out-Null
  Copy-Item -LiteralPath $manifestFile -Destination (Join-Path $stage 'config\partner_cli_package.json') -Force
  Copy-Item -LiteralPath (Join-Path $SourceRoot 'scripts\install_partner_bi_ops_cli.ps1') -Destination (Join-Path $stage 'install.ps1') -Force
  New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
  $zip = Join-Path $OutputDir ($name + '.zip')
  Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
  Compress-Archive -LiteralPath $stage -DestinationPath $zip -CompressionLevel Optimal
  $hash = Get-Sha256Hex $zip
  [IO.File]::WriteAllText($zip + '.sha256', "$hash  $([IO.Path]::GetFileName($zip))`n", [Text.Encoding]::ASCII)
  Write-Output $zip
  Write-Output "SHA256=$hash"
} finally {
  if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
