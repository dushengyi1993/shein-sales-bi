# 营销零写入预校验阻断分类修复

目标版本：`2026.08.03.10`
发布日期：2026-08-03

## 1. 修正内容

- 普通漂移、新链接/重新上架/漏兜底和人工特殊恢复统一使用库存事务失败分类器。
- 只有实际写过平台库存且恢复或活动保护回读不安全时，才标记 `inventory_transaction_restore_failed`。
- 平台预校验在任何库存写入前拒绝的，标记 `inventory_transaction_or_enrollment_blocked`，作为业务阻断保留证据并继续其他安全组。

## 2. 当日影响

- 2026-08-03 MZ、TS 漂移组 `writeAttempted=false`，旧调用层仍误报库存恢复失败并会让 repair queue 失败。
- 发布后重新评估当天队列；真实平台阻断不再中断后续 fallback。
- 不修改现有 systemd timer。

## 3. 验证

- `smoke_marketing_activity_inventory_integration.mjs`：`44` 项通过。
- 库存事务、repair queue 和 repair status 专项测试通过。
- 完整 `npm test`、CI、云端测试和 release source state 检查必须通过。

## 4. 发布与回滚

- GitHub `main`、tag `2026.08.03.10` 与云端 `/opt/shein-bi/app` 必须指向同一 commit。
- 云端执行 `node scripts/check_release_source_state.mjs --expected-commit 2026.08.03.10 --record-deployment 2026.08.03.10` 并取得 `ok=true`。
- 回滚点为 `2026.08.03.9`；回滚前确认没有活动库存事务处于临时补量窗口。
