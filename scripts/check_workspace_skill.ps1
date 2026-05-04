. "$PSScriptRoot\use_utf8.ps1"
$ErrorActionPreference = "Stop"
$workspaceSkill = Join-Path (Get-Location) "skills\shein-sales-ops\SKILL.md"
if (-not (Test-Path -LiteralPath $workspaceSkill)) { throw "workspace skill not found: $workspaceSkill" }
Write-Output "workspace skill OK: $workspaceSkill"
Write-Output "注意：根据用户要求，本项目 skill 只保存在工作区，不同步到 C 盘全局 skills。"
