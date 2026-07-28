# BI 利润与成本估算完整修复（2026-07-28）

## 事故

`SK-6863半自动意式咖啡机` 在 2026-07-27 有 4 件、净成交 `1,180.08 SAR`。旧逻辑在期初可售成本库存耗尽后，把后 3 件判成“无成本”，利润分子只剩第一件，却仍除以全部成交额，导致货号利润率显示约 `8.7%`。

这不是商品真的低利润，而是两个逻辑错误叠加：

1. “无法证明精确批次”被错误等同于“没有成本”；
2. 有成本订单的利润分子除以全部订单收入。

## 最终规则

1. **切点后有库存**：按订单发生前的移动加权成本。
2. **切点后库存缺口**：优先使用订单当时已发出但尚未到仓的完整批次加权成本；没有这类证据时沿用最近移动加权成本。
3. **切点前历史**：优先使用订单日期前已到仓批次累计加权；当时没有到仓记录时，只能使用订单日前已实际发出的批次加权。两者都没有就显示待成本，不再拿未来批次倒灌。
4. **完全无成本证据**：才保留缺成本，不把成本写成零。
5. **利润率**：利润分子与净营收分母必须来自同一成本覆盖集合。
6. **披露**：正式 BI 分别显示“库存缺口估算”“历史成本估算”“待成本”，估算不声称精确批次。
7. **估算结算**：未冻结期间的负库存估算按 FIFO 等待真实入库；到货后用实际单位成本结算原销售差额，并同步修正剩余库存价值。已冻结期间不回写。
8. **在途证据**：未关联 ET 运单的批次可使用成本表发货日；一旦已关联 ET 运单，只认 ET 实际发出时间、明确离仓节点或（保守取）已到仓时间。建单、审核时间以及“成本表写了发货但 ET 仍待发”都不能证明已在途。

## 数据结构

- `mart.product_cost_batch_timeline`：合并成本表与 ET 物理追踪证据，并标记发货日期来源/冲突。
- `fact.inventory_cost_event.estimated_unit_cost_sar / estimated_cost_basis`：保存订单发生时可用的估算证据。
- `fact.inventory_cost_ledger.estimated_quantity / valuation_basis`：保存每条销售中尚未结算的估算数量与依据。
- `fact.inventory_cost_ledger.settled_estimated_quantity / estimation_variance_sar`：记录已被后续真实入库结算的数量和成本差额，避免差额被错误留在剩余库存。
- `mart.profit_order_item.cost_estimated_quantity / cost_valuation_basis`：供利润 mart、体检和 BI 披露。
- `legacy_estimated_cost_*`：单独统计切点前历史估算，不与当前库存缺口混在一起。

## 防回归

- `scripts/test_inventory_cost_ledger.mjs`：覆盖在途成本、最近移动加权、完全缺期初、负库存到货结算、价值守恒和冻结边界。
- `scripts/smoke_warehouse_business_logic.sql`：用未来高价批次验证旧订单不会被未来成本改写。
- `scripts/test_warehouse_business_logic_contract.mjs`：锁定时间线、估算字段与利润率分母规则。
- `scripts/audit_bi_warehouse.mjs`：每日检查日货号、月汇总和货号总览的利润率分子分母一致性，并用人话披露估算与已结算数量。
- 台账写入前锁定全部源表，并用 PostgreSQL 事务快照可见性与逐表行数复核；即使导入事务早于快照开始、晚于快照提交且 `updated_at` 仍是旧时间，也会拒绝发布并要求重跑。
