# BI 业务逻辑加固收口（2026-07-18）

## 已落地口径

1. 利润与售后风险分层：已落定利润单独核算；未结售后仅以风险/参考影响展示，不能提前改写最终损益。
2. 退货费：已结算财务核对单优先，其次使用退货单商品行 `performancePrice` 实际费用；两者都没有且确为退货包裹时才按 `13.88 SAR` 估算。生产已见 `13.88 / 14.35 / 16.77 SAR`，不再把大包裹一律写死为 13.88。
3. 成本：首个可信 ET 实盘日前的历史继续保留并明确标为 `legacy_pre_cutover_estimate`，因为无法反推当时卖的是哪一批；不得伪装成精确批次成本。切点期初只能使用生效日前一日 ET 结存，切点以后采用移动加权平均成本，缺台账就显示缺失，未来入库不再反向改价。冻结会计期间不可重建改写。
4. 库存：运营可售默认仅 ET `09`；仅 `SK-03038` 例外可取 `09+01`。全仓物理量独立展示；ET 匹配缺失或证据过期均为 `unknown`，绝不转为零或用成本表推算。
5. 仓储费：按货号证据分配，继而按货号 × 店铺销量分配；无证据余额入 `CENTRAL_POOL`，并以每日总账、货号与店铺分配三层对账。

## 自动化完成定义

- 浏览器任务由任务 × 店铺租约隔离；有效租约不被清理，失效/死亡 owner 的租约由每小时清理回收。
- 营销 guard 已改为纯 session HTTP，只读阶段不启动浏览器、不申请浏览器租约、也不执行浏览器清理。只有 repair worker 或仍需浏览器的独立抓取任务才先取得本任务租约，并只清理自己实际拥有的店铺；systemd 层不再叠加 `ExecStartPre/ExecStartPost`，统一清理器仅在每小时 `:15` 回收无有效租约的孤儿进程。
- 营销流程已瘦身为“分钟级完整巡检 + queue 修复 worker”解耦：巡检最长 `30` 分钟、只读、不持有写授权；当天成功后后续窗口只作失败重试。worker 在 `10:50`、`12:50`、`14:50`、`16:50`、`18:50` 执行，每轮总预算 `8` 组、最长 `40` 分钟，阶段间共享剩余预算并按成功组 resume；最终必须全店 live readback。
- 云端证据：`2026-07-17` 的全在售兜底产生 `74` 条；`2026-07-18` 基准切换产生 `61` 条、`32` 个活动组。旧流程将全量扫描与 61 条同步写入串成一个 service，并在日更、营销 stack review、价格扫描之间重复抓同一事实，叠加四层清理后约一小时被杀。拆分后 `2026-07-18 21:06` 的 19 店完整巡检耗时 `157s`，活动价 `1516` 行、19/19 店成功、Chrome `0 -> 0`；实时 15% 券 active `7` 个，与当前/未来普通活动和限时折扣重叠均为 `0`，最终 guard 为 `0 blocker / 0 source warning`。
- 旧 `coupon submit / low-price / old-ordinary` 五份中间扫描只保留历史审计。当次 19 店实时券集合与当次普通活动/限时折扣价格层都完整时，直接生成当前结论；任一店、券规则或价格层不完整则 fail closed，不以“删掉旧检查”换取假绿。
- dry-run 不得触发删除。真实替换统一由事务执行器完成旧活动快照、删除、创建、精确回读和失败补偿；安全恢复旧保护仍计为未完成，不能“全绿”。
- “已提交”不是完成；只有最终成功回读确认活动、价格、库存与覆盖事实后才可计为完成。
- 利润 mart 不再把同一组复杂视图依赖重复计算 6 次：先物化订单成本一次，再按“货号仓储 → 货号×店铺 → 店铺 → 利润聚合”依赖顺序复用当轮 cache。生产备份克隆库首轮实测由约 `1083s` 降至约 `206s`，最终生产刷新进一步稳定到约 `119s`，且三层仓储分配最大差额低于 `0.000001 SAR`。

## 2026-07-16/17 抓数故障与修复

| 日期 | 根因 | 修复与防回归 |
| --- | --- | --- |
| 2026-07-16 | 业务域抓取错误路径引用了未同步的 `fssync`，使既有结果保护分支异常。 | 补齐 `node:fs` 同步依赖，保留已有结果/零行保护；抓取失败不以空结果覆盖先前事实。 |
| 2026-07-17 | 多店并行 OpenAPI loader 同时执行 schema DDL，与数据 upsert 竞争，触发 PostgreSQL deadlock。 | 调度先单进程 `--ensure-only` 完成 migration，所有并行 worker 使用 `--skip-ensure`，只做数据加载。 |

以上变更只收紧数据解释与运行完成标准；OpenAPI 双跑仍是隔离对账层，不切换生产销售事实源。

## 核对入口

- 退货与利润：`mart.finance_return_cost_actual`、`mart.profit_*`。
- 成本：`fact.inventory_cost_opening`、`fact.inventory_cost_ledger`、`ops.accounting_period_close`。
- 库存：ET 投影、`mart.inventory_projection` 与线上 BI section。
- 仓储：`mart.storage_fee_product_daily`、`mart.storage_fee_product_store_daily`、`mart.storage_fee_daily_reconciliation`。
- 回归：`scripts/test_shein_finance_check_orders.mjs`、`scripts/test_inventory_cost_ledger.mjs`、`scripts/test_inventory_projection_contract.mjs`、`scripts/test_warehouse_business_logic_contract.mjs`、`scripts/smoke_browser_task_lease.mjs`、`scripts/smoke_cloud_marketing_live_guard_resilience.mjs`。
