# 本地 BI 封存快照（2026-05-15）

本目录保存本地 BI 切换到云端后的非敏感恢复参考。

- `scheduled-tasks-before.json`：封存前本地 `SHEIN-*` Windows 计划任务名称和状态快照。
- 本地 `8787` BI 服务已停止。
- 本地 `SHEIN-*` Windows 计划任务已禁用，避免和云端重复跑数。
- 原 Windows 防火墙规则 `SHEIN BI Portal LAN 8787 ReadOnly` 需要管理员权限才能禁用；当前没有服务监听 `8787`，因此局域网无法访问本地 BI。

如需复核或再次封存，运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/archive_local_bi.ps1
```

如需同时禁用防火墙规则，必须使用管理员 PowerShell：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/archive_local_bi.ps1 -DisableFirewall
```

除非用户明确要求回滚，不要重新启用本地 BI 服务或本地计划任务。
