# 营销库存事务业务阻断分类修复

目标版本：`2026.08.03.7`
发布日期：2026-08-03

## 1. 修正内容

- 限时折扣批次同时包含“临时补量目标”和“平台硬拒绝目标”时，恢复后活动校验只核对本次实际临时补量的 SKC。
- 临时补量 SKC 已按目标价格、活动库存和截止时间精确覆盖，且库存已恢复一致时，平台对同批其他 SKC 的拒绝归类为业务阻断，不再误报库存恢复失败。
- 临时补量目标缺失、错价、库存不足、截止时间不足，或库存恢复不精确时仍 fail closed。

## 2. 当日影响

- 2026-08-03 第一轮 8 个漂移组均已完成库存恢复，但旧调用层将平台 `0004/0006` 等业务阻断误标为 `inventory_transaction_restore_failed`，导致 repair queue 提前停止。
- 发布后从当天 repair queue 重新评估；已安全恢复的组保留业务阻断证据，其他组和 fallback 继续执行。
- 不修改现有 systemd timer。

## 3. 验证

- `smoke_marketing_activity_inventory_integration.mjs`：`38` 项通过。
- `smoke_marketing_activity_inventory_transaction.mjs`：`35` 项通过。
- repair queue 和 repair status 专项测试通过。
- 完整 `npm test`、CI、云端测试和 release source state 检查必须通过。

## 4. 发布与回滚

- GitHub `main`、tag `2026.08.03.7` 与云端 `/opt/shein-bi/app` 必须指向同一 commit。
- 云端执行 `node scripts/check_release_source_state.mjs --expected-commit 2026.08.03.7 --record-deployment 2026.08.03.7` 并取得 `ok=true`。
- 回滚点为 `2026.08.03.6`；回滚前确认没有活动库存事务处于临时补量窗口。
