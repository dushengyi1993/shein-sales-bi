param(
  [string]$Distro = "Ubuntu-24.04",
  [string]$Container = "shein-warehouse-db",
  [string]$Database = "shein_bi",
  [string]$User = "shein"
)

. "$PSScriptRoot\use_utf8.ps1"

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$schemaPath = Join-Path $repo "infra\warehouse\schema.sql"
if (-not (Test-Path -LiteralPath $schemaPath)) {
  throw "Schema file not found: $schemaPath"
}

$wslSchemaPath = (wsl -d $Distro -- wslpath -a "$schemaPath").Trim()
wsl -d $Distro -- bash -lc "sudo docker exec -i $Container psql -U $User -d $Database -v ON_ERROR_STOP=1 < '$wslSchemaPath'"

Write-Output "BI warehouse schema initialized."
