# 营销报名零库存恢复与延迟回读修复

目标版本：`2026.08.03.5`
发布日期：2026-08-03

## 1. 修正内容

- 活动库存事务允许把平台可用库存精确恢复到报名之前的 `0`，不再把零库存误判为非法参数。
- 恢复阶段幂等键支持覆盖量 `0`，仍保留事务 hash、目标、阶段和重试次数。
- 库存写后回读窗口扩展为最多 `10` 次、每次间隔 `3` 秒，覆盖 SHEIN OpenAPI 的延迟一致性；超时仍 fail closed。
- 新增零库存恢复和延迟回读测试，继续验证提交成功、提交失败、锁定量变化、恢复失败及恢复后活动失效等边界。

## 2. 事故处置

- 2026-08-03 营销修复队列处理 DX `JD-389` 时，临时补到活动最低可用库存 `10` 后触发旧版零值校验错误。
- 修复 worker 已在发现后停止，库存 live 回读最终恢复为 `total/usable/locked = 0/0/0`；未留下永久补量。
- 发布后从原 repair queue 继续处理，不修改现有 systemd timer。

## 3. 验证

- `smoke_marketing_activity_inventory_transaction.mjs`：`35` 项通过。
- `smoke_marketing_activity_inventory_integration.mjs`：`34` 项通过。
- `smoke_authorized_fallback_inventory_top_up.mjs`：通过，旧永久补量执行入口保持禁用。
- 完整 `npm test`、云端相同专项测试和 release source state 检查必须在部署前后通过。

## 4. 发布与回滚

- GitHub `main`、tag `2026.08.03.5` 与云端 `/opt/shein-bi/app` 必须指向同一 commit。
- 云端执行 `node scripts/check_release_source_state.mjs --expected-commit 2026.08.03.5 --record-deployment 2026.08.03.5` 并取得 `ok=true`。
- 回滚点为 `2026.08.03.4`；回滚前必须确认没有活动库存事务处于临时补量窗口。
