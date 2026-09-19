# SHEIN BI Ops 2026.08.22.1

目标源码版本：`2026.08.22.1`

## 范围

- 待议价 `decisions` schemaVersion 1 保持向后兼容：省略 `storeKey` 时仍按标准货号覆盖全部当前待议价行。
- 新增可选 `storeKey`，允许同一标准货号在不同店铺使用不同动作，例如 DX 接受、LQ 拒绝。
- 分店规则会规范化店码并绑定 `decisionsHash`、逐项 `itemHash`、逐店 `payloadHash` 与整批 `batchHash`。
- 全局规则与分店规则重叠、同店重复或冲突、未知/空店码、规则未命中 fresh scan 时均 fail closed。
- 更新待议价 runbook 和确定性测试；不修改 automation、排班、队列、服务或其它 SHEIN 业务流程。

## 数据与迁移

- 无数据库、配置、systemd 或调度迁移。
- 发布本身不执行任何 SHEIN 待议价写入。
- 真实处理仍要求云端 fresh 19 店 scan、未过期 preflight、精确 `batchHash`、用户最终确认、逐项终态回读和全店 final scan。

## 验收与回滚

- 本地专项测试：`node scripts/test_pending_discuss_batch.mjs`、`node scripts/test_pending_discuss_daily.mjs`、语法检查与 `git diff --check`。
- 完整 CI：目标 commit 的 `npm test` 必须通过后才允许 tag、release 和生产部署。
- 云端必须精确部署到本 tag commit，并通过 `check_release_source_state`、Portal/Webhook/query health 与一次无写的分店 preflight 验证。
- 回滚点为 `2026.08.17.6`。源码回滚不会撤销已由 SHEIN 接收的议价结果；本版本部署前不执行议价写。

发布状态：源码变更待 CI；生产待部署。
