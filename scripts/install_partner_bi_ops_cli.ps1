param(
  [string]$SourceRoot = '',
  [string]$InstallRoot = "$HOME\.shein-bi\cli",
  [string]$CodexHome = "$HOME\.codex",
  [switch]$InternalLocked
)

$ErrorActionPreference = 'Stop'
# Native command arguments (including the Node helper below) must preserve
# Unicode install paths; Windows PowerShell 5 defaults to ASCII here.
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)

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

# Shared update-lock wrapper. The normal entry path acquires the same
# InstallRoot/.update.lock ticketing protocol used by the online updater and
# the offline bootstrap (lib/cross_process_ticket_lock.mjs and the embedded
# copy inside scripts/partner_cli_bootstrap.mjs) and runs the entire install
# as an internal PowerShell process under that lock, so staging, version-tree
# swaps, bootstrap/skill/launcher/current.json publication and stale-residue
# collection are serialized with every other Partner CLI writer.
if (-not $InternalLocked) {
  $node = (Get-Command node -ErrorAction Stop).Source
  $major = [int]((& $node -p "process.versions.node.split('.')[0]").Trim())
  if ($major -lt 22) { throw "Node.js 22 or newer is required; current major version is $major" }
  $powerShellExe = (Get-Command powershell.exe -ErrorAction Stop).Source
  $installerPath = $PSCommandPath
  $lockHelper = @'
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import process from 'node:process';
import {spawn} from 'node:child_process';
(async () => {
  const [sourceRoot, installRoot, codexHome, powerShellExe, installerPath] = process.argv.slice(1);
  if (!sourceRoot || !installRoot || !powerShellExe || !installerPath) {
    process.stderr.write('Partner CLI install lock helper received incomplete arguments\n');
    process.exit(85);
  }
  let release = null;
  try {
    const lockModule = await import(pathToFileURL(path.join(sourceRoot, 'lib', 'cross_process_ticket_lock.mjs')).href);
    release = await lockModule.acquireCrossProcessTicketLock(path.join(installRoot, '.update.lock'), {
      timeoutMs: 120000,
      staleMs: 600000,
      heartbeatMs: 30000,
      pollMs: 100,
      timeoutMessage: 'Partner CLI install timed out waiting for the shared update lock',
      timeoutCode: 'PARTNER_CLI_INSTALL_LOCK_TIMEOUT',
    });
  } catch (error) {
    process.stderr.write('Partner CLI install could not acquire the shared update lock: ' + String(error && error.message || error) + '\n');
    process.exit(86);
  }
  try {
    const child = spawn(powerShellExe, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', installerPath,
      '-SourceRoot', sourceRoot,
      '-InstallRoot', installRoot,
      '-CodexHome', codexHome,
      '-InternalLocked',
    ], {stdio: 'inherit', windowsHide: true});
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (exitCode) => resolve(Number.isInteger(exitCode) ? exitCode : null));
    });
    process.exitCode = Number.isInteger(code) ? code : 87;
  } catch (error) {
    process.stderr.write('Partner CLI install failed under the shared update lock: ' + String(error && error.message || error) + '\n');
    process.exitCode = 88;
  } finally {
    try {
      if (release) await release();
    } catch {
      // lock release is best-effort
    }
  }
})();
'@
  & $node --input-type=module -e $lockHelper -- $SourceRoot $InstallRoot $CodexHome $powerShellExe $installerPath
  exit $LASTEXITCODE
}
# Constants shared with lib/partner_cli_updater.mjs and
# scripts/partner_cli_bootstrap.mjs. The staging/backup suffixes keep the
# intermediate release directories visible to the stable offline bootstrap's
# crash-recovery scan and its GC prefix.
$verifiedMarkerName = '.verified.json'
$stagingSuffix = '.tmp'
$backupSuffix = '.bak'
$pointerSchemaVersion = 2

$manifestFile = Join-Path $SourceRoot 'config\partner_cli_package.json'
if (-not (Test-Path -LiteralPath $manifestFile)) { throw "Package manifest not found: $manifestFile" }
$manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
if (-not $manifest.version -or -not $manifest.entrypoint -or -not $manifest.bootstrap -or -not $manifest.codexSkill) { throw 'Package manifest is invalid' }
if (-not $manifest.files -or @($manifest.files).Count -eq 0) { throw 'Package manifest files are missing' }
$packageVersion = [string]$manifest.version
$entrypointRelative = [string]$manifest.entrypoint
$bootstrapRelative = [string]$manifest.bootstrap
$codexSkillRelative = [string]$manifest.codexSkill

$node = (Get-Command node -ErrorAction Stop).Source
$major = [int]((& $node -p "process.versions.node.split('.')[0]").Trim())
if ($major -lt 22) { throw "Node.js 22 or newer is required; current major version is $major" }

# MoveFileExW is the same same-directory atomic replace primitive that Node's
# fs.rename uses on Windows; never rename the live target away or delete it
# before the replacement is in place.
if (-not ('NativeFs' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NativeFs {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool MoveFileExW(string existing, string target, int flags);
}
'@
}

# Rebuild the deterministic Partner CLI bundle hash with the packaged
# lib/partner_cli_release.mjs so the installer reuses the exact release/manifest
# hash semantics of the updater and the offline bootstrap. buildPartnerCliRelease
# also validates that every manifest file exists and the entrypoint/bootstrap/
# codex skill are present, so a successful run is already a full-tree check.
function Get-PartnerReleaseHash {
  param(
    [Parameter(Mandatory = $true)][string]$RootPath,
    [Parameter(Mandatory = $true)][string]$ExpectedVersion
  )
  $helper = @'
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import process from 'node:process';
(async () => {
  const root = process.argv[1];
  try {
    const mod = await import(pathToFileURL(path.join(root, 'lib', 'partner_cli_release.mjs')).href);
    const release = await mod.buildPartnerCliRelease({sourceRoot: root});
    process.stdout.write(JSON.stringify({ok: true, version: release.manifest.version, bundleSha256: release.manifest.bundleSha256, fileCount: release.manifest.files.length}));
  } catch (error) {
    process.stdout.write(JSON.stringify({ok: false, error: String(error && error.message || error)}));
  }
})();
'@
  $raw = (& $node --input-type=module -e $helper -- $RootPath) | Out-String
  if ($LASTEXITCODE -ne 0) { throw "Partner CLI release verification failed for ${RootPath} (node exit $LASTEXITCODE)" }
  $details = $null
  try { $details = $raw | ConvertFrom-Json } catch { }
  if (-not $details -or -not $details.ok) { throw "Partner CLI release verification failed for ${RootPath}: $($details.error)" }
  if ($details.version -ne $ExpectedVersion) { throw "Partner CLI release version mismatch for ${RootPath}: $($details.version) != $ExpectedVersion" }
  $hash = [string]$details.bundleSha256
  if ($hash -notmatch '^[a-f0-9]{64}$') { throw "Partner CLI bundleSha256 is invalid for $RootPath" }
  return $hash
}

# Publish one file atomically: write to a unique temp beside the target, flush
# to disk, then MoveFileExW with MOVEFILE_REPLACE_EXISTING in the same
# directory. On failure the previous target remains in place.
function Invoke-AtomicReplace {
  param(
    [Parameter(Mandatory = $true)][string]$Target,
    [string]$Source = '',
    [AllowNull()][string]$Content = $null
  )
  $dir = [IO.Path]::GetDirectoryName($Target)
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $leaf = [IO.Path]::GetFileName($Target)
  $temp = Join-Path $dir ('.' + $leaf + '.' + [Guid]::NewGuid().ToString('N') + $stagingSuffix)
  try {
    # PowerShell 5 coerces a [string] default of $null to '' when the
    # parameter is only default-bound, so branch on explicit binding only.
    if ($PSBoundParameters.ContainsKey('Content')) {
      [IO.File]::WriteAllText($temp, $Content, (New-Object System.Text.UTF8Encoding($false)))
    } elseif ($Source -ne '') {
      Copy-Item -LiteralPath $Source -Destination $temp -Force
    } else {
      throw 'Invoke-AtomicReplace requires either -Source or -Content'
    }
    $flush = [IO.File]::Open($temp, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite)
    try { $flush.Flush($true) } finally { $flush.Dispose() }
    $replaced = $false
    $lastError = 0
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
      if ([NativeFs]::MoveFileExW($temp, $Target, 1)) { $replaced = $true; break }
      $lastError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      if ($attempt -lt 4) { Start-Sleep -Milliseconds ([int](50 * [Math]::Pow(2, $attempt))) }
    }
    if (-not $replaced) { throw "Failed to atomically replace $Target (win32 error $lastError); previous target was left in place" }
  } finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
  }
}

function Write-PartnerJsonFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][AllowNull()]$Value
  )
  Invoke-AtomicReplace -Target $Path -Content ($Value | ConvertTo-Json)
}

$versionsRoot = Join-Path $InstallRoot 'versions'
$versionRoot = Join-Path $versionsRoot $packageVersion

# The local source tree is the trusted anchor for an offline install: the staged
# copy must rebuild to exactly the same deterministic bundle hash.
$expectedHash = Get-PartnerReleaseHash -RootPath $SourceRoot -ExpectedVersion $packageVersion

New-Item -ItemType Directory -Path $versionsRoot -Force | Out-Null
$stagingName = '.' + $packageVersion + '.' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmss') + '.' + [Guid]::NewGuid().ToString('N') + $stagingSuffix
$staging = Join-Path $versionsRoot $stagingName
$staged = $false
$swapBackupDir = ''
$published = $false

try {
  # Copy the whole release into a unique staging directory under the same
  # versions root. The final version directory is never written file by file.
  New-Item -ItemType Directory -Path $staging -Force | Out-Null
  $staged = $true
  foreach ($relative in @($manifest.files)) {
    $relative = [string]$relative
    if ([IO.Path]::IsPathRooted($relative) -or @($relative -split '[\\/]').Contains('..')) { throw "Unsafe package path: $relative" }
    $source = Join-Path $SourceRoot $relative
    if (-not (Test-Path -LiteralPath $source)) { throw "Required package file not found: $relative" }
    $target = Join-Path $staging $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $target -Force
  }
  New-Item -ItemType Directory -Path (Join-Path $staging 'config') -Force | Out-Null
  Copy-Item -LiteralPath $manifestFile -Destination (Join-Path $staging 'config\partner_cli_package.json') -Force

  # Full verification of the staged tree before anything published is touched.
  $stagedHash = Get-PartnerReleaseHash -RootPath $staging -ExpectedVersion $packageVersion
  if ($stagedHash -ne $expectedHash) {
    throw "Partner CLI staged release bundle hash mismatch: $stagedHash != $expectedHash"
  }
  $bundleSha256 = $stagedHash
 $stagedEntrypoint = Join-Path $staging $entrypointRelative
 if (-not (Test-Path -LiteralPath $stagedEntrypoint -PathType Leaf)) { throw "Staged entrypoint is not a regular file: $entrypointRelative" }
  # Runnability gate BEFORE anything is published: the candidate entrypoint
  # and bootstrap must prove runnable from the staged tree now, because after
  # the version tree is swapped in and current.json moves, no further step may
  # fail the install. Running the packaged entrypoint is independent of the
  # current pointer; --check parses the exact shipped bootstrap file.
  $gateOutput = (& $node (Join-Path $staging $entrypointRelative) version) | Out-String
  if ($LASTEXITCODE -ne 0) { throw 'Partner CLI staged entrypoint is not runnable before publish' }
  if (-not $gateOutput -or $gateOutput -notmatch [regex]::Escape($packageVersion)) {
    throw 'Partner CLI staged entrypoint did not report its version before publish'
  }
  & $node --check (Join-Path $staging $bootstrapRelative) 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Partner CLI staged bootstrap failed its syntax/runnable check before publish' }
  # Publish the immutable version tree with same-directory renames only. A

  # Publish the immutable version tree with same-directory renames only. A
  # verified existing tree is reused; anything that no longer rebuilds to the
  # release hash is moved aside to a .bak and atomically replaced.
  $existing = Test-Path -LiteralPath $versionRoot
  $existingValid = $false
  if ($existing) {
    try { $existingValid = ((Get-PartnerReleaseHash -RootPath $versionRoot -ExpectedVersion $packageVersion) -eq $bundleSha256) } catch { $existingValid = $false }
  }
  if ($existing -and -not $existingValid) {
    $swapBackupDir = Join-Path $versionsRoot ('.' + $packageVersion + '.' + [Guid]::NewGuid().ToString('N') + $backupSuffix)
    Rename-Item -LiteralPath $versionRoot -NewName (Split-Path -Leaf $swapBackupDir)
    try {
      Rename-Item -LiteralPath $staging -NewName (Split-Path -Leaf $versionRoot)
      $published = $true
      $staged = $false
    } catch {
      if (-not (Test-Path -LiteralPath $versionRoot)) {
        Rename-Item -LiteralPath $swapBackupDir -NewName (Split-Path -Leaf $versionRoot) -ErrorAction SilentlyContinue
      }
      $swapBackupDir = ''
      throw
    }
  } elseif (-not $existing) {
    Rename-Item -LiteralPath $staging -NewName (Split-Path -Leaf $versionRoot)
    $published = $true
    $staged = $false
  }
  if (-not (Test-Path -LiteralPath $versionRoot)) { throw 'Partner CLI version directory is missing after publish' }

  # Terminal verification of the published tree; restore the preserved tree if
  # it unexpectedly fails.
  $finalHash = Get-PartnerReleaseHash -RootPath $versionRoot -ExpectedVersion $packageVersion
  if ($finalHash -ne $bundleSha256) {
    if ($published -and $swapBackupDir -and (Test-Path -LiteralPath $swapBackupDir)) {
      if (Test-Path -LiteralPath $versionRoot) { Remove-Item -LiteralPath $versionRoot -Recurse -Force }
      Rename-Item -LiteralPath $swapBackupDir -NewName (Split-Path -Leaf $versionRoot)
    }
    $swapBackupDir = ''
    throw 'Partner CLI published release verification failed; the previous version was restored'
  }

  # Write the .verified.json marker before the pointer moves. It is the
  # offline recovery anchor that lets the stable bootstrap promote this tree
  # if a later step fails.
  Write-PartnerJsonFile -Path (Join-Path $versionRoot $verifiedMarkerName) -Value @{
    schemaVersion = $pointerSchemaVersion
    version = $packageVersion
    bundleSha256 = $bundleSha256
    entrypoint = $entrypointRelative
    verifiedAt = [DateTime]::UtcNow.ToString('o')
  }

  if ($swapBackupDir -and (Test-Path -LiteralPath $swapBackupDir)) {
    Remove-Item -LiteralPath $swapBackupDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  $swapBackupDir = ''

  # Publish bootstrap, Codex skill and launcher atomically, then the pointer.
  $bootstrapSource = Join-Path $versionRoot $bootstrapRelative
  if (-not (Test-Path -LiteralPath $bootstrapSource -PathType Leaf)) { throw "Bootstrap file not found: $bootstrapRelative" }
  Invoke-AtomicReplace -Target (Join-Path $InstallRoot 'bootstrap.mjs') -Source $bootstrapSource

  $skillSource = Join-Path $versionRoot $codexSkillRelative
  if (-not (Test-Path -LiteralPath $skillSource -PathType Leaf)) { throw "Codex skill not found: $codexSkillRelative" }
  $skillTarget = Join-Path (Join-Path $CodexHome 'skills\shein-bi-ops') 'SKILL.md'
  Invoke-AtomicReplace -Target $skillTarget -Source $skillSource

  $launcher = Join-Path $InstallRoot 'shein-bi-ops.cmd'
  $launcherText = "@echo off`r`nnode `"%~dp0bootstrap.mjs`" %*`r`n"
  Invoke-AtomicReplace -Target $launcher -Content $launcherText

  # Only now may stale crash-recovery evidence (.tmp staging / .bak backups)
  # for this version be collected, because the canonical version root has
  # passed full verification and is marker-anchored.
  $residuePrefix = '.' + $packageVersion + '.*'
  Get-ChildItem -LiteralPath $versionsRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like $residuePrefix -and ($_.Name.EndsWith($stagingSuffix) -or $_.Name.EndsWith($backupSuffix)) } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

 # Pointer last: current.json only ever references a fully verified tree that
  # has a valid bundleSha256, a compatible .verified.json marker, a runnable
  # entrypoint and bootstrap, and a published launcher/skill on disk.
  Write-PartnerJsonFile -Path (Join-Path $InstallRoot 'current.json') -Value @{
    schemaVersion = $pointerSchemaVersion
    version = $packageVersion
    entrypoint = (Join-Path $versionRoot $entrypointRelative)
    entrypointRelative = $entrypointRelative
    bundleSha256 = $bundleSha256
    installedAt = [DateTime]::UtcNow.ToString('o')
  }

  # Post-pointer smoke is informational only: the pointer cannot be atomically
  # reverted here, so a failure must not fail the install. The runnability gate
  # above already proved the exact chain this smoke exercises; a warning keeps
  # the state observable while leaving the fully verified install in place.
  try {
    $smokeNode = $node
    if ($env:SHEIN_BI_OPS_TEST_POST_POINTER_SMOKE_NODE) {
      $smokeNode = $env:SHEIN_BI_OPS_TEST_POST_POINTER_SMOKE_NODE
    }
    $smokeOutput = (& $smokeNode (Join-Path $InstallRoot 'bootstrap.mjs') version) | Out-String
    if ($LASTEXITCODE -ne 0 -or -not $smokeOutput -or $smokeOutput -notmatch [regex]::Escape($packageVersion)) {
      Write-Warning 'Partner CLI managed bootstrap smoke after pointer publish reported an issue (non-fatal)'
    }
  } catch {
    Write-Warning ('Partner CLI managed bootstrap smoke after pointer publish could not start (non-fatal): ' + $_.Exception.Message) -WarningAction Continue
  }

  Write-Output "Installed SHEIN BI Ops CLI $packageVersion"
  Write-Output "Bundle SHA256: $bundleSha256"
  Write-Output "Launcher: $launcher"
  Write-Output "Codex skill: $skillTarget"
  Write-Output "Login: `"$launcher`" login --username <BI account>"
} finally {
  if ($swapBackupDir -and (Test-Path -LiteralPath $swapBackupDir)) { Remove-Item -LiteralPath $swapBackupDir -Recurse -Force -ErrorAction SilentlyContinue }
  if ($staged -and (Test-Path -LiteralPath $staging)) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
}
