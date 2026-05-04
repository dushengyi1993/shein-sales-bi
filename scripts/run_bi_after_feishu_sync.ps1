param(
  [string]$Mode = "intraday",
  [string]$SalesDate = "",
  [string]$LinkDate = "",
  [string]$BusinessDate = "",
  [switch]$RunLinkManagement,
  [switch]$FullBusinessFetch,
  [string]$ParentLogFile = "",
  [string]$Distro = "Ubuntu-24.04",
  [string]$Container = "shein-warehouse-db",
  [string]$Database = "shein_bi",
  [string]$User = "shein",
  [switch]$DryRun
)

. "$PSScriptRoot\use_utf8.ps1"

$ErrorActionPreference = "Continue"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Get-BjDate([int]$OffsetDays) {
  $utcNow = [DateTime]::UtcNow
  return $utcNow.AddHours(8).AddDays($OffsetDays).ToString("yyyy-MM-dd")
}

if ([string]::IsNullOrWhiteSpace($SalesDate)) {
  $SalesDate = if ($Mode -eq "yesterday-final") { Get-BjDate -1 } else { Get-BjDate 0 }
}
if ([string]::IsNullOrWhiteSpace($BusinessDate)) { $BusinessDate = $SalesDate }
if ([string]::IsNullOrWhiteSpace($LinkDate)) { $LinkDate = Get-BjDate -1 }

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

$LogDir = Join-Path $Root "logs\scheduled"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$LogFile = Join-Path $LogDir "post-feishu-bi-$Mode-$Stamp.log"

function Log([string]$Message) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  $line | Out-File -FilePath $LogFile -Encoding UTF8 -Append
  if (-not [string]::IsNullOrWhiteSpace($ParentLogFile)) {
    $line | Out-File -FilePath $ParentLogFile -Encoding UTF8 -Append
  }
}

function Invoke-LoggedCommand([string]$Name, [scriptblock]$Block) {
  Log "START $Name"
  $global:LASTEXITCODE = 0
  try {
    & $Block 2>&1 | ForEach-Object {
      $text = "$_"
      $text | Out-File -FilePath $LogFile -Encoding UTF8 -Append
      if (-not [string]::IsNullOrWhiteSpace($ParentLogFile)) {
        $text | Out-File -FilePath $ParentLogFile -Encoding UTF8 -Append
      }
    }
    $code = $global:LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
    if ($code -eq 0) {
      Log "OK $Name"
      return 0
    }
    Log "WARN $Name exited with code $code"
    return $code
  } catch {
    Log "WARN $Name failed :: $($_.Exception.Message)"
    return 1
  }
}

Log "Post-Feishu BI refresh start mode=$Mode salesDate=$SalesDate linkDate=$LinkDate businessDate=$BusinessDate runLink=$RunLinkManagement fullBusiness=$FullBusinessFetch"

if ($DryRun) {
  [pscustomobject]@{
    ok = $true
    mode = "dry-run"
    script = "scripts\run_bi_after_feishu_sync.ps1"
    repo = $Root
    source = "Feishu scheduled sync post-step"
    feishuMode = $Mode
    salesDate = $SalesDate
    linkDate = $LinkDate
    businessDate = $BusinessDate
    runLinkManagement = [bool]$RunLinkManagement
    fullBusinessFetch = [bool]$FullBusinessFetch
    pipelineScript = Join-Path $Root "scripts\run_bi_daily_pipeline.ps1"
    note = "No SHEIN fetch, no Feishu sync, no database write."
  } | ConvertTo-Json -Compress
  Log "Dry-run only; no SHEIN fetch, no Feishu sync, no database write."
  exit 0
}

$LinkExitCode = 0
if ($RunLinkManagement) {
  $flagDir = Join-Path $Root "state"
  New-Item -ItemType Directory -Force -Path $flagDir | Out-Null
  $linkFlag = Join-Path $flagDir ("link-management-synced-{0}.flag" -f $LinkDate)
  if (Test-Path -LiteralPath $linkFlag) {
    Log "SKIP link-management; already synced for $LinkDate ($linkFlag)"
  } else {
    $LinkExitCode = Invoke-LoggedCommand "Run link-management sync for $LinkDate" {
      & $Node ".\scripts\run_link_management_job.mjs" --group ALL --date $LinkDate --headless-browser
    }
    if ($LinkExitCode -eq 0) {
      "syncedAt=$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" | Out-File -FilePath $linkFlag -Encoding UTF8
      Log "WROTE link-management flag $linkFlag"
    } else {
      Log "WARN link-management failed; BI will continue with latest available local link snapshot."
    }
  }
}

$BiArgs = @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", ".\scripts\run_bi_daily_pipeline.ps1",
  "-SalesDate", $SalesDate,
  "-LinkDate", $LinkDate,
  "-BusinessDate", $BusinessDate,
  "-Distro", $Distro,
  "-Container", $Container,
  "-Database", $Database,
  "-User", $User
)

if (-not $FullBusinessFetch) {
  $BiArgs += @("-SkipBusinessFetch", "-SkipBusinessLoad")
}

$BiExitCode = Invoke-LoggedCommand "Run BI warehouse/portal refresh" {
  & powershell @BiArgs
}

$Ok = ($BiExitCode -eq 0)
Log "Post-Feishu BI refresh end mode=$Mode salesDate=$SalesDate linkDate=$LinkDate businessDate=$BusinessDate linkExit=$LinkExitCode biExit=$BiExitCode ok=$Ok log=$LogFile"

# Do not fail the upstream Feishu production task because of BI-side issues.
# Feishu remains the production path during the dual-run period.
exit 0
