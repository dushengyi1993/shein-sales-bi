param(
  [string]$HostName = "127.0.0.1",
  [int]$Port = 8787,
  [switch]$Lan,
  [switch]$ReadOnly,
  [switch]$NoAuth
)

. "$PSScriptRoot\use_utf8.ps1"

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

if ($Lan) {
  $HostName = "0.0.0.0"
}

$argsList = @('.\scripts\serve_bi_portal.mjs', '--host', $HostName, '--port', $Port)
if ($ReadOnly) {
  $argsList += '--read-only'
}
if ($NoAuth) {
  $argsList += '--no-auth'
}

node @argsList
