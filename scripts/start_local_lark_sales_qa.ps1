$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\use_utf8.ps1"

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $Root

$LogDir = Join-Path $Root 'logs\local-lark-sales-qa'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$LogFile = Join-Path $LogDir "local-lark-sales-qa-task-$Stamp.log"

function Resolve-FirstExistingPath {
  param([string[]]$Candidates)
  foreach ($Candidate in $Candidates) {
    if ([string]::IsNullOrWhiteSpace($Candidate)) { continue }
    if (Test-Path -LiteralPath $Candidate) {
      return (Resolve-Path -LiteralPath $Candidate).Path
    }
  }
  return $null
}

$NodeBin = Resolve-FirstExistingPath @(
  $env:SHEIN_QA_NODE_BIN,
  'D:\Program Files\nodejs\node.exe',
  'C:\Program Files\nodejs\node.exe'
)
if (-not $NodeBin) {
  $NodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($NodeCommand) { $NodeBin = $NodeCommand.Source }
}
if (-not $NodeBin) { throw 'node.exe not found' }

$LarkCliBin = Resolve-FirstExistingPath @(
  $env:LARK_CLI_BIN,
  'C:\Users\dushengyi\AppData\Local\npm-cache\_npx\cca705bd6109e4e4\node_modules\@larksuite\cli\bin\lark-cli.exe'
)
if (-not $LarkCliBin) {
  $LarkCommand = Get-Command lark-cli.exe -ErrorAction SilentlyContinue
  if ($LarkCommand) { $LarkCliBin = $LarkCommand.Source }
}
if (-not $LarkCliBin) { throw 'lark-cli.exe not found' }

$env:SHEIN_QA_BI_DATA = Join-Path $Root 'tmp\cloud-bi-portal-data.json'
$env:SHEIN_QA_STATE_DIR = Join-Path $Root 'state\local_lark_sales_qa_bot'
$env:SHEIN_QA_CODEX_GATEWAY_ENABLED = '0'
$env:SHEIN_QA_LLM_ENABLED = '1'
$env:SHEIN_QA_CHART_ENABLED = '0'
$env:LARK_CLI_BIN = $LarkCliBin
Remove-Item Env:LARK_CLI_PREFIX_ARGS -ErrorAction SilentlyContinue

"[$(Get-Date -Format o)] start local lark sales QA root=$Root node=$NodeBin lark=$LarkCliBin" | Out-File -FilePath $LogFile -Encoding utf8 -Append

& $NodeBin (Join-Path $Root 'scripts\run_lark_sales_qa_event_pipe.mjs') *>> $LogFile

"[$(Get-Date -Format o)] local lark sales QA exited code=$LASTEXITCODE" | Out-File -FilePath $LogFile -Encoding utf8 -Append
exit $LASTEXITCODE
