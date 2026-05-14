param(
  [int]$Port = 8787,
  [string]$RuleName = "SHEIN BI Portal LAN 8787 ReadOnly",
  [string]$RemoteAddress = ""
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$ReportDir = Join-Path $Root "outputs\reports"
New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $isAdmin) {
  throw "This script must be run as Administrator because Windows Firewall rules are machine-wide."
}

$lanIp = Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -like "192.168.*" -and $_.PrefixLength -le 32 } |
  Sort-Object InterfaceMetric |
  Select-Object -First 1

if (-not $lanIp) {
  throw "Cannot detect a 192.168.x.x LAN IPv4 address."
}

if ([string]::IsNullOrWhiteSpace($RemoteAddress)) {
  $parts = $lanIp.IPAddress.Split(".")
  $RemoteAddress = "{0}.{1}.{2}.0/24" -f $parts[0], $parts[1], $parts[2]
}

$oldRules = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
if ($oldRules) {
  $oldRules | Remove-NetFirewallRule
}

New-NetFirewallRule `
  -DisplayName $RuleName `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort $Port `
  -Profile Private `
  -RemoteAddress $RemoteAddress | Out-Null

$rule = Get-NetFirewallRule -DisplayName $RuleName
$address = $rule | Get-NetFirewallAddressFilter
$portFilter = $rule | Get-NetFirewallPortFilter

$report = [pscustomobject]@{
  ok = $true
  fixedAt = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
  lanIp = $lanIp.IPAddress
  url = "http://$($lanIp.IPAddress):$Port/"
  ruleName = $RuleName
  localAddress = $address.LocalAddress
  remoteAddress = $address.RemoteAddress
  protocol = $portFilter.Protocol
  localPort = $portFilter.LocalPort
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$reportPath = Join-Path $ReportDir "bi-firewall-lan-fix-$stamp.json"
$report | ConvertTo-Json -Depth 5 | Out-File -FilePath $reportPath -Encoding UTF8
$report | ConvertTo-Json -Depth 5
