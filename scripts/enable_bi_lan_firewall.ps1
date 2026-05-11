param(
  [int]$Port = 8787,
  [string]$DisplayName = "SHEIN BI Portal LAN 8787 ReadOnly"
)

. "$PSScriptRoot\use_utf8.ps1"

$ErrorActionPreference = "Stop"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Administrator rights are required to configure Windows Firewall."
}

$node = (Get-Command node -ErrorAction Stop).Source
$ipConfigs = Get-NetIPConfiguration
$ipcfg = $ipConfigs | Where-Object {
  $_.IPv4Address -and
  $_.IPv4DefaultGateway -and
  $_.NetAdapter -and
  $_.NetAdapter.Status -eq "Up"
} | Select-Object -First 1

if (-not $ipcfg) {
  throw "No active LAN adapter with IPv4 default gateway was found."
}

$lanIp = $ipcfg.IPv4Address.IPAddress
$prefix = [int]$ipcfg.IPv4Address.PrefixLength
$octets = $lanIp.Split(".")
if ($prefix -eq 24) {
  $remoteAddress = "$($octets[0]).$($octets[1]).$($octets[2]).0/24"
} else {
  $remoteAddress = "LocalSubnet"
}

$nodePath = (Resolve-Path -LiteralPath $node).Path

# Windows may have created an inbound block rule for node.exe. A block rule
# wins over an allow rule, so keep it only for Public profile and add a
# narrower Private-profile allow rule for this BI portal port.
Get-NetFirewallRule -DisplayName "Node.js JavaScript Runtime" -ErrorAction SilentlyContinue |
  Where-Object { $_.Direction -eq "Inbound" -and $_.Action -eq "Block" } |
  Where-Object {
    $app = $_ | Get-NetFirewallApplicationFilter
    if (-not $app.Program) { return $false }
    $appPath = (Resolve-Path -LiteralPath $app.Program -ErrorAction SilentlyContinue).Path
    return $appPath -and ($appPath -ieq $nodePath)
  } |
  Set-NetFirewallRule -Profile Public

Get-NetFirewallRule -DisplayName $DisplayName -ErrorAction SilentlyContinue |
  Remove-NetFirewallRule -ErrorAction SilentlyContinue

New-NetFirewallRule `
  -DisplayName $DisplayName `
  -Direction Inbound `
  -Action Allow `
  -Enabled True `
  -Profile Private `
  -Program $nodePath `
  -Protocol TCP `
  -LocalPort $Port `
  -LocalAddress Any `
  -RemoteAddress $remoteAddress `
  -Description "Temporary read-only LAN access for SHEIN BI portal on TCP $Port; LocalAddress is Any because DHCP may change the PC IP." | Out-Null

[pscustomobject]@{
  ok = $true
  displayName = $DisplayName
  node = $nodePath
  currentLanIp = $lanIp
  localAddress = "Any"
  remoteAddress = $remoteAddress
  port = $Port
}
