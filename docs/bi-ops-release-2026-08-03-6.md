# 每日库存巡检自动执行

目标版本：`2026.08.03.6`
发布日期：2026-08-03

## 1. 变更

- 每天 `09:35` 在生成当天库存计划后自动执行安全行，不再逐日等待人工确认。
- 保留当天 64 位 `payloadHash`、ET/linksData/OpenAPI 新鲜度、四态、SKU、销量/曝光和实时库存门禁。
- 自动执行仅允许固定 systemd 授权 ID 与 `cloud_daily_inventory_replenishment_guard` 上下文。
- 增加跨进程锁、同 hash 完整结果去重和逐行执行授权审计字段。
- 单条 blocker 继续失败关闭并进入 `09:45` 事后审计报告，不中断其他安全行。

## 2. 验证

- `node scripts/test_inventory_replenishment_policy.mjs`
- `bash -n scripts/cloud_daily_inventory_replenishment_guard.sh`
- `git diff --check`
- `npm test`

## 3. 部署

- GitHub `main`、tag `2026.08.03.6` 与云端 `/opt/shein-bi/app` 必须指向同一 commit。
- 安装并重载 `shein-bi-daily-inventory-replenishment-guard.service`，保留现有 `09:35` timer，不创建重复定时器。
- 云端运行 `node scripts/check_release_source_state.mjs --expected-commit 2026.08.03.6 --record-deployment 2026.08.03.6` 并取得 `ok=true`。
- 回滚点为 `2026.08.03.5`；回滚会恢复人工确认模式。
