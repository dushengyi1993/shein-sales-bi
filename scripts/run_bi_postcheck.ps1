param(
  [int]$DelaySeconds = 45,
  [string]$Reason = "scheduled",
  [string]$Distro = "Ubuntu-24.04",
  [string]$Container = "shein-warehouse-db",
  [string]$Database = "shein_bi",
  [string]$User = "shein"
)

$ErrorActionPreference = "Continue"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$logDir = Join-Path $repo "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$ts = Get-Date -Format "yyyyMMdd-HHmmss"
$logFile = Join-Path $logDir "bi-postcheck-$ts.log"

function Log([string]$Message) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  $line | Tee-Object -FilePath $logFile -Append
}

Log "BI postcheck scheduled reason=$Reason delaySeconds=$DelaySeconds repo=$repo"
if ($DelaySeconds -gt 0) {
  Start-Sleep -Seconds $DelaySeconds
}

try {
  Log "START Generate BI first-run check report"
  node .\scripts\check_bi_first_run.mjs 2>&1 | ForEach-Object {
    "$_" | Tee-Object -FilePath $logFile -Append
  }
  Log "OK Generate BI first-run check report"
} catch {
  Log "WARN Generate BI first-run check report failed :: $($_.Exception.Message)"
}

try {
  Log "START Refresh local BI portal first-run check status"
  node .\scripts\generate_bi_portal.mjs --distro $Distro --container $Container --database $Database --user $User 2>&1 | ForEach-Object {
    "$_" | Tee-Object -FilePath $logFile -Append
  }
  Log "OK Refresh local BI portal first-run check status"
} catch {
  Log "WARN Refresh local BI portal first-run check status failed :: $($_.Exception.Message)"
}

Log "DONE BI postcheck log=$logFile"
