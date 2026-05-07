param(
  [ValidateSet("intraday", "yesterday-final")]
  [string]$Mode = "intraday",
  [string]$Store = "HL",
  [string]$Date,
  [switch]$SkipPortalRefresh
)

. "$PSScriptRoot\use_utf8.ps1"

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node -and (Test-Path -LiteralPath "D:\Program Files\nodejs\node.exe")) {
  $Node = "D:\Program Files\nodejs\node.exe"
}
if (-not $Node) {
  throw "Cannot find node.exe. Please install Node.js or add it to PATH."
}

$ExtraPath = @(
  (Split-Path -Parent $Node),
  "$env:LOCALAPPDATA\OpenAI\Codex\bin",
  "$env:APPDATA\npm"
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
$env:PATH = (($ExtraPath + @($env:PATH)) -join ';')

function Get-BjDate([int]$OffsetDays) {
  return [DateTime]::UtcNow.AddHours(8).AddDays($OffsetDays).ToString("yyyy-MM-dd")
}

$Store = $Store.ToUpperInvariant()
if ([string]::IsNullOrWhiteSpace($Date)) {
  if ($Mode -eq "yesterday-final") {
    $Date = Get-BjDate -1
  } else {
    $Date = Get-BjDate 0
  }
}

$OpenApiConfig = Join-Path $Root "config\shein_openapi.local.json"
if (-not (Test-Path -LiteralPath $OpenApiConfig)) {
  throw "Missing OpenAPI local config: $OpenApiConfig"
}

$LogDir = Join-Path $Root "logs\scheduled"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$LogFile = Join-Path $LogDir ("openapi-{0}-{1}-{2}.log" -f $Store.ToLowerInvariant(), $Mode, $Stamp)

function Write-Log([string]$Message) {
  $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
  $line | Out-File -FilePath $LogFile -Encoding UTF8 -Append
  Write-Output $line
}

function Invoke-LoggedNodeStep([string]$Name, [string[]]$Arguments) {
  Write-Log "START $Name"
  $stdoutFile = [System.IO.Path]::GetTempFileName()
  $stderrFile = [System.IO.Path]::GetTempFileName()
  $process = Start-Process `
    -FilePath $Node `
    -ArgumentList $Arguments `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -Wait `
    -PassThru `
    -RedirectStandardOutput $stdoutFile `
    -RedirectStandardError $stderrFile
  if (Test-Path -LiteralPath $stdoutFile) {
    Get-Content -LiteralPath $stdoutFile -ErrorAction SilentlyContinue |
      ForEach-Object { $_ | Out-File -FilePath $LogFile -Encoding UTF8 -Append }
  }
  if (Test-Path -LiteralPath $stderrFile) {
    Get-Content -LiteralPath $stderrFile -ErrorAction SilentlyContinue |
      ForEach-Object { $_ | Out-File -FilePath $LogFile -Encoding UTF8 -Append }
  }
  Remove-Item -LiteralPath $stdoutFile, $stderrFile -Force -ErrorAction SilentlyContinue
  $code = $process.ExitCode
  if ($code -ne 0) {
    Write-Log "ERROR $Name exited with $code"
    throw "$Name failed with exit code $code"
  }
  Write-Log "OK $Name"
}

Push-Location $Root
try {
  Write-Log "SHEIN OpenAPI HL reconciliation start mode=$Mode store=$Store date=$Date"
  $BrowserFile = Join-Path $Root ("outputs\shein_fetch\{0}\{1}.json" -f $Store, $Date)
  if (-not (Test-Path -LiteralPath $BrowserFile)) {
    Write-Log "WARN browser comparison file is missing: $BrowserFile; reconciliation status may become missing_browser."
  }

  Invoke-LoggedNodeStep "Fetch SHEIN OpenAPI sales" @(
    ".\scripts\fetch_shein_openapi_sales.mjs",
    $Store,
    "--date",
    $Date
  )

  Invoke-LoggedNodeStep "Load OpenAPI sales into parallel warehouse and reconcile" @(
    ".\scripts\load_shein_openapi_sales_warehouse.mjs",
    "--store",
    $Store,
    "--date",
    $Date
  )

  if (-not $SkipPortalRefresh) {
    Invoke-LoggedNodeStep "Regenerate local BI portal with OpenAPI reconciliation" @(
      ".\scripts\generate_bi_portal.mjs"
    )
  } else {
    Write-Log "Skip BI portal refresh because -SkipPortalRefresh was set."
  }

  $Result = [ordered]@{
    ok = $true
    mode = $Mode
    store = $Store
    date = $Date
    logFile = $LogFile
    openApiFile = "outputs\shein_openapi_fetch\$Store\$Date.json"
    browserFile = "outputs\shein_fetch\$Store\$Date.json"
    refreshedPortal = -not $SkipPortalRefresh
  }
  ($Result | ConvertTo-Json -Depth 4) | Out-File -FilePath $LogFile -Encoding UTF8 -Append
  Write-Log "SHEIN OpenAPI HL reconciliation end exit=0"
  exit 0
} catch {
  Write-Log ("SHEIN OpenAPI HL reconciliation failed: " + $_.Exception.Message)
  exit 1
} finally {
  Pop-Location
}
