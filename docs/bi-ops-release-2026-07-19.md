# 2026.07.19.1 发布说明

## 发布结论

本版完成 ET 仓储费历史重述、自动日更和利润守恒验收，并移除仓储费日更对库存趋势的无关慢刷新；同时收口营销 repair 最终回读的证据刷新顺序。生产已部署并完成全历史回灌。

## 主要变更

- 新增 canonical 仓储费账单层，已支付账单替换同业务键等待支付账单，避免状态迁移重复扣费。
- 以 ET 最终账单为应付总额，以 `ExportStoreFee` 明细为货号分摊权重；46 个历史不一致日按最终账单缩放。
- 新增 `shein-bi-cloud-et-storage-fee.service/.timer`，每日 `14:10` 只读同步仓储费总账和全量 SKU 明细。
- 新任务与通用 ET 共用 profile 互斥锁，但隔离状态、输出、日志和 Chrome 临时目录。
- 利润 cache 使用 canonical 明细源，并对总账、货号、店铺、店铺×货号四层做生产对账。
- 仓储费日更只预热 `profit/homeProfit`；`inventoryTrend` 改走已发布利润 cache，线上强制刷新从 12 分钟以上降至约 13 秒。
- 审计增加重复替换链、缺明细、缩放日期、最新账期与多层守恒检查。
- 营销 repair 最终闭环固定为 session HTTP stack review → 最新价格栈扫描 → guard 重建，避免长批次跨活动开始时间后使用旧价格快照或旧优惠券证据误报 blocker。

## 生产验收

- 覆盖：`2025-11-17..2026-07-19`；
- 246 条原始行 → 245 条 canonical 账单；
- 20,822 条 SKU 明细，245/245 天覆盖，缺明细 0；
- 显示账单 `93,684.68 RMB`，50% 实付 `46,842.34 RMB`，折 `26,023.52 SAR`；
- store/product/product-store 与总账差额均为 0；
- 正式 systemd 日更结果 `success`，耗时约 3 分 47 秒；
- 通用 ET timer 已恢复，两个 ET service 最近结果均为 `success`；
- 专用 profile Chrome 残留 0，长时间 inventory SQL 残留 0；
- 本地完整测试：94/94 通过。

详细口径与差异见 [ET 仓储费历史重述与自动同步](storage-fee-history-restatement-2026-07-19.md)。

## 备份与回滚

- 数据库：`/srv/shein-bi/backups/auto/20260719-122326`；
- 代码/unit：`/srv/shein-bi/backups/releases/2026.07.19.1-storage-fee-20260719-124608`；
- 两处备份均在部署前生成，代码备份带 SHA256 清单。

回滚不得手工改利润数字：停 timer、恢复 schema/脚本/unit、重建 cache、运行仓储费对账与仓库审计。
