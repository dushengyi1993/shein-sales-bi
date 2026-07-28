# SHEIN BI Ops 2026.07.28.1 发布说明

Git tag：`partner-cli-v2026.07.28.1`

## 这次解决什么

- 所有负责人、合伙人和普通运营的 CLI 只读问数，不再转给 BI 问数机器人、飞书机器人、云端 Codex gateway 或其他 LLM。
- 新增正式命令 `query`。它在当前 BI 登录账号的只读权限内，确定性选择并加载云端 BI 数据分区，返回完整结构化数据和 `aiInvoked=false`，由当前电脑上的 Codex 自己筛选、计算和说明。
- 旧命令 `ask` 改为 `query` 的兼容别名，不再访问 `/api/ops-agent/ask`，避免旧口令误触模型。
- 对链接、实时销售、利润、库存、订单、售后、评论、RTV 和物流等问数，可自动选择分区，也可用 `--sections` 精确指定。
- 查询所需分区缺失、过期或加载失败时，接口会明确失败且不返回不完整业务结果；禁止再退回浏览器抓数、本地 V3 报表或另一个问数模型。

## 权限与安全

- `query` 只读，不创建任务、不预检、不修改 SHEIN。
- `--stores` 只能缩小当前账号已有的读取范围，不能扩大权限。
- 受限读取账号只返回授权店铺的店铺级行；无法安全按店拆分的跨店聚合行会被移除，避免泄露其他店铺数据。
- 大型结构化结果支持 gzip，并建议用 `--out` 保存到临时 JSON，再由当前 Codex 本地分析，避免把多 MB 原始数据直接刷到终端。

## 使用方式

```powershell
$out = Join-Path $env:TEMP ("shein-bi-query-" + [guid]::NewGuid().ToString("N") + ".json")
& "$HOME\.shein-bi\cli\shein-bi-ops.cmd" query --text "找出点击率4%以上、近7天曝光3000以上且近7天销量为0的链接" --out $out
```

自动分区不足时：

```powershell
& "$HOME\.shein-bi\cli\shein-bi-ops.cmd" query --text "原始问题" --sections linksData,productState,productTrafficDaily --out $out
```

受管安装会在下一次业务命令前检查云端 release，校验后原子升级并重启原命令。
