# 营销漂移业务阻断汇总修复

目标版本：`2026.08.03.11`
发布日期：2026-08-03

## 1. 修正内容

- drift repair 汇总把 `inventory_transaction_or_enrollment_blocked` 纳入终态业务阻断。
- 未写库存的预校验拒绝，以及写后已安全恢复的业务拒绝，不再计入 `failedGroups`。
- 实际写过库存且恢复/活动保护不安全的结果仍计入 `failedGroups` 和 `unsafeGroups`。

## 2. 当日影响

- 2026-08-03 drift 结果已达到 `3` 组完成、`5` 组业务阻断、`0` 组真实恢复失败，但旧汇总仍把后五组计为失败并中断 fallback。
- 发布后 repair worker 将以退出码 `4` 保存 drift 业务阻断，继续执行剩余 fallback 组。
- 不修改现有 systemd timer。

## 3. 验证

- `smoke_limited_repair_status.mjs` 覆盖零写入阻断、安全恢复阻断与真实不安全恢复三种分支。
- repair queue 和库存事务集成专项测试通过。
- 完整 `npm test`、CI、云端测试和 release source state 检查必须通过。

## 4. 发布与回滚

- GitHub `main`、tag `2026.08.03.11` 与云端 `/opt/shein-bi/app` 必须指向同一 commit。
- 云端执行 `node scripts/check_release_source_state.mjs --expected-commit 2026.08.03.11 --record-deployment 2026.08.03.11` 并取得 `ok=true`。
- 回滚点为 `2026.08.03.10`。
