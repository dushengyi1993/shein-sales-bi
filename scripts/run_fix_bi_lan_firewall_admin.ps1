$ErrorActionPreference = 'Continue'
try {
  Write-Host '正在修复 SHEIN BI 局域网访问防火墙规则...' -ForegroundColor Cyan
  & 'E:\Codex WorkSpace\Shein销售统计\scripts\fix_bi_lan_firewall.ps1'
  Write-Host ''
  Write-Host '完成。如果上面 ok=true，局域网访问规则已修复。' -ForegroundColor Green
} catch {
  Write-Host ''
  Write-Host '执行失败：' -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host $_.ScriptStackTrace
}
Write-Host ''
Read-Host '请把窗口内容发给 Codex；按回车关闭窗口'
