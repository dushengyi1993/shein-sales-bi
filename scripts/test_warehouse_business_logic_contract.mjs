#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const schema = read('infra/warehouse/schema.sql');
const refresh = read('scripts/refresh_profit_marts.sql');
const smokeSql = read('scripts/smoke_warehouse_business_logic.sql');
const audit = read('scripts/audit_bi_warehouse.mjs');
const portalGenerator = read('scripts/generate_bi_portal.mjs');
const portalServer = read('scripts/serve_bi_portal.mjs');
const portalClient = read('scripts/bi_app/client.js');
const costRebuild = read('scripts/rebuild_inventory_cost_ledger.mjs');
const costLedger = read('lib/inventory_cost_ledger.mjs');
const periodManager = read('scripts/manage_accounting_period.mjs');
const openingSeed = read('scripts/seed_inventory_cost_opening_from_et.mjs');
const linkFetch = read('scripts/fetch_shein_business_domains.mjs');
const productRunner = read('scripts/run_shein_openapi_products_reconciliation.mjs');

assert.match(schema, /CREATE TABLE IF NOT EXISTS fact\.inventory_cost_opening/);
assert.match(schema, /CREATE TABLE IF NOT EXISTS fact\.inventory_cost_event/);
assert.match(schema, /CREATE TABLE IF NOT EXISTS fact\.inventory_cost_ledger/);
assert.match(schema, /CREATE TABLE IF NOT EXISTS ops\.accounting_period_close/);
assert.match(schema, /CREATE TABLE IF NOT EXISTS ops\.inventory_cost_run/);
assert.match(
  schema,
  /CREATE OR REPLACE VIEW mart\.inventory_cost_sale_assignment AS[\s\S]*unvalued_quantity,\s*valuation_status,\s*ledger_version,\s*calculated_at,[\s\S]*estimated_quantity/,
  'new assignment fields must append after the production view signature for an in-place upgrade',
);
assert.match(schema, /NULL::numeric AS estimated_on_hand_quantity/);
assert.match(schema, /'model_estimate_disabled'::text AS inventory_match_status/);
assert.match(schema, /legacy_pre_cutover_estimate/);
assert.match(schema, /open-period shortfall may later be explicitly[\s\S]*settled by its receipt/);
assert.match(schema, /CREATE OR REPLACE VIEW mart\.product_cost_batch_timeline/);
assert.match(schema, /et_shipment_tracking/);
assert.match(schema, /coalesce\(o\.ship_time, te\.departure_track_at\) AS departure_at/);
assert.doesNotMatch(schema, /coalesce\(o\.ship_time, te\.departure_track_at, o\.check_time, o\.create_time\) AS departure_at/,
  'shipment creation/checking is not physical in-transit cost evidence');
assert.match(schema, /WHEN se\.ship_order_id IS NOT NULL[\s\S]*THEN coalesce\(se\.departure_at::date,se\.arrival_at::date\)/,
  'a linked ET shipment must override an unverified spreadsheet departure date');
assert.match(schema, /shipped_date_source/);
assert.match(schema, /declared_but_et_not_departed/);
assert.match(schema, /legacy_past_arrived_weighted_pre_cutover/);
assert.match(schema, /legacy_shipped_weighted_pre_cutover/);
assert.doesNotMatch(schema, /legacy_earliest_complete_batch_pre_cutover/,
  'a pre-cutover sale must not use a batch first shipped after the order date');
assert.match(costLedger, /estimated_inventory_gap_in_transit_cost/,
  'a temporary inventory gap must prefer cost evidence that already existed at sale time');
assert.match(costLedger, /estimated_inventory_gap_last_moving_average/,
  'a sale after a known-cost stock count reaches zero must retain the last moving-average cost as a bounded fallback');
assert.match(costLedger, /shortfallQueues/,
  'negative inventory estimates must remain traceable until receipt settlement');
assert.match(costLedger, /state\.value \+= eventCostSar - estimationVarianceSar/,
  'receipt settlement must conserve inventory value and transfer only the estimate variance');
assert.match(costLedger, /valued_after_inventory_gap_receipt/,
  'a fully settled shortfall must stop appearing as a live estimate');
assert.match(costRebuild, /b\.shipped_date <= sale\.effective_date/);
assert.match(costRebuild, /b\.arrived_date > sale\.effective_date/);
assert.match(costRebuild, /past_arrived_weighted_as_of_sale/);
assert.match(costRebuild, /mart\.product_cost_batch_timeline/);
assert.match(schema, /known_risk_adjusted_net_revenue_sar/);
assert.match(refresh, /known_risk_adjusted_net_revenue_sar/);
assert.match(schema, /estimated_cost_revenue_sar/);
assert.match(refresh, /estimated_cost_revenue_sar/);
assert.match(schema, /legacy_estimated_cost_revenue_sar/);
assert.match(refresh, /legacy_estimated_cost_revenue_sar/);
assert.match(schema, /cost_estimated_quantity/);
assert.match(schema, /settled_estimated_quantity/);
assert.match(schema, /estimation_variance_sar/);
assert.match(costRebuild, /const SOURCE_TABLES[\s\S]*'fact\.order_item'[\s\S]*'ops\.accounting_period_close'/);
assert.match(costRebuild, /LOCK TABLE\s+\$\{SOURCE_TABLES\.join\('[\s\S]*IN SHARE MODE/);
assert.match(costRebuild, /inventory-cost source changed after snapshot/);
assert.match(costRebuild, /txid_current_snapshot\(\)::text/);
assert.match(costRebuild, /txid_visible_in_snapshot/);
assert.match(costRebuild, /rows_not_visible_in_snapshot/);
assert.match(schema, /nullif\(b\.known_risk_adjusted_net_revenue_sar,0\)/,
  'risk profit and its denominator must describe the same cost-covered rows');
assert.doesNotMatch(schema, /FILTER \(WHERE p\.missing_cost_lines = 0\)/,
  'a mixed known/missing daily row must not erase the known-cost product margin');
assert.doesNotMatch(refresh, /FILTER \(WHERE p\.missing_cost_lines = 0\)/,
  'published product margins must guard on covered revenue, not whole-row missing flags');
assert.match(costRebuild, /Refusing to rewrite frozen accounting periods/);
assert.match(costRebuild, /frozenRowsTouched/);
assert.match(costRebuild, /latestApprovedOpeningDate/);
assert.match(costRebuild, /SELECT max\(effective_date\) FROM fact\.inventory_cost_opening WHERE status='approved'/);
assert.match(periodManager, /period has % unvalued sale rows/);
assert.match(openingSeed, /b\.target_date < \$\{date\}/, 'opening must use the prior close, never a same-day stock snapshot');
assert.doesNotMatch(openingSeed, /b\.target_date <= \$\{date\}/, 'same-day opening would double count same-day movements');
assert.match(openingSeed, /Refusing non-prior-day ET opening snapshot/);

assert.match(schema, /CREATE TABLE IF NOT EXISTS fact\.openapi_finance_check_order/);
assert.match(schema, /CREATE TABLE IF NOT EXISTS fact\.openapi_finance_check_order_item/);
assert.match(schema, /CREATE OR REPLACE VIEW mart\.finance_return_cost_actual/);
assert.match(schema, /finance_check_order_actual/);
assert.match(schema, /return_order_performance_price_actual/);
assert.match(schema, /CREATE OR REPLACE VIEW mart\.return_cost_package_actual/);
assert.match(schema, /CREATE OR REPLACE VIEW mart\.return_package_catalog/);
assert.match(schema, /CREATE OR REPLACE VIEW mart\.after_sales_settlement_detail/);
assert.match(schema, /WHEN realized_reversal THEN 'realized'/);
assert.match(schema, /WHEN pending_revenue_risk THEN 'pending'/);
assert.match(schema, /LEFT JOIN mart\.return_cost_actual fa/);
assert.match(schema, /pending_revenue_risk/);
assert.match(schema, /estimated_return_delivery_fee_sar/);
assert.match(schema, /after_sales_allocated AS/);
assert.match(schema, /after_sales_candidate AS/);
assert.match(schema, /after_sales_contribution AS/);
assert.match(schema, /sum\(pending_revenue_contribution_sar\) AS pending_revenue_impact_before_cap_sar/);
assert.match(schema, /estimated_return_delivery_fee_sar\s+\* greatest\(line_gross_revenue_sar,0\) \/ matched_gross_revenue_sar/);
assert.match(schema, /AND NOT has_actual_return_cost/);
const profitAccounting = schema.slice(
  schema.indexOf('CREATE OR REPLACE VIEW mart.profit_order_item AS'),
  schema.indexOf('CREATE OR REPLACE VIEW mart.product_display_by_match_key AS'),
);
assert.match(
  profitAccounting,
  /cost_unvalued_quantity,\s*cost_valuation_status,\s*cost_ledger_version,\s*cost_cutover_date,[\s\S]*pending_impact_amount_sar,[\s\S]*cost_estimated_quantity,\s*cost_settled_estimated_quantity,\s*cost_valuation_basis/,
  'new profit fields must append after the production view signature for an in-place upgrade',
);
const afterSalesAccounting = profitAccounting.slice(0, profitAccounting.indexOf('rtv_match AS ('));
assert.doesNotMatch(
  afterSalesAccounting,
  /LEFT JOIN LATERAL[\s\S]*?LIMIT 1/,
  'profit accounting must not discard a second realized or pending after-sales candidate',
);
assert.match(schema, /rtv_allocated AS/);
assert.match(schema, /total_rtv_received_quantity \* line_quantity \/ matched_quantity/);
assert.match(schema, /WHEN line_quantity <= 0 OR coalesce\(total_rtv_received_quantity,0\) <= 0 THEN 0/);
assert.doesNotMatch(
  schema,
  /WHEN matched_row_number = 1 THEN total_rtv_received_quantity/,
  'a zero-quantity order line must never receive an RTV recovery fallback',
);
assert.match(schema, /greatest\(\s*sum\([\s\S]*?max\(coalesce\(rdest\.final_09_quantity,0\)\)\s*\) AS et_received_to_09_qty/);
assert.doesNotMatch(schema, /\)\s*\+ max\(coalesce\(rdest(?:_any)?\.final_09_quantity,0\)\) AS et_received_to_09_qty/);

assert.match(schema, /CREATE OR REPLACE VIEW mart\.storage_fee_product_store_daily/);
assert.match(schema, /SELECT d\.date, d\.match_key, 'CENTRAL_POOL'::text, 'CENTRAL_POOL'::text/);
assert.match(schema, /CREATE OR REPLACE VIEW mart\.storage_fee_daily_reconciliation/);
assert.match(audit, /max_product_store_delta_sar/);
assert.match(audit, /允许误差 0\.01 SAR/);
assert.match(audit, /FROM mart\.storage_fee_store_daily_cache/);
assert.match(audit, /FROM mart\.storage_fee_product_daily_cache/);
assert.match(audit, /FROM mart\.storage_fee_product_store_daily_cache/);
assert.doesNotMatch(audit, /FROM mart\.storage_fee_daily_reconciliation/,
  'post-refresh audit must reconcile published caches instead of recomputing canonical storage views');
assert.match(audit, /FROM mart\.return_cost_actual/);
assert.match(audit, /mart\.return_order_performance_cost_reconciliation/);
assert.match(audit, /SELECT store_key FROM fact\.openapi_store_daily_sales WHERE date = \(SELECT sales_date FROM latest\)/,
  'sales coverage must count a successful zero-sale OpenAPI probe instead of treating no order row as a missing store');
assert.match(audit, /sales_probe_store_count/);
assert.match(audit, /sales_coverage_is_event_driven_today/);
assert.match(audit, /ops\.shein_webhook_primary_sales_enabled\(current_date\)/);
assert.match(audit, /按 0 销量处理，不判为数据缺失/);
assert.doesNotMatch(audit, /linkLagDaysFromSales/,
  'real-time Webhook sales must not make the slower daily link snapshot look stale');
assert.match(audit, /linkLagDaysFromBusiness/);
assert.match(audit, /请确认每日慢变数据同步是否成功完成/);
assert.match(audit, /cross_store_after_sales_orders/);
assert.match(audit, /unique_skc_store_mismatch_rows/);
assert.match(audit, /primary_openapi_store_mismatch_orders/);
assert.match(audit, /daily_sales_reconciliation_rows/);
assert.match(audit, /cost_estimation/);
assert.match(audit, /profit_margin_invariant/);
assert.match(audit, /product_mismatch_rows/);
assert.match(audit, /利润率分子分母口径不一致/);
assert.match(audit, /已退款可能无法冲减净销量和利润/);
assert.doesNotMatch(audit, /return arr\.length \? `\?\?\?/,
  'missing-store warnings must remain readable Chinese instead of mojibake');
assert.match(audit, /notes\.push\(`有 \$\{storage\.detail_scaled_days\}/,
  'conserving storage-detail scaling is an accounting note, not a recurring health warning');
assert.match(audit, /notes\.push\(`有 \$\{Number\(storage\.central_pool_fee_sar\)/,
  'a conserved CENTRAL_POOL balance is an accounting note, not an actionable health warning');

assert.match(portalGenerator, /SHEIN_BI_PROFIT_MART_SOURCE \|\| 'cache'/,
  'portal core must serve the published profit cache by default');
assert.match(portalGenerator, /Operators may still\s*\n\/\/ request `view` explicitly/);
assert.match(portalGenerator, /FROM mart\.profit_order_item_cache\s+WHERE created_date=current_date/,
  'today live profit must use the atomically published canonical accounting cache');
assert.doesNotMatch(portalGenerator, /live_unit_cost_sar/,
  'today live profit must not value a partially assigned line using a whole-line fallback unit cost');
assert.match(portalGenerator, /freshness\.cache_matches_source/,
  'today live sales must detect an existing order row whose amount or quantity changed after accounting publication');
assert.match(portalGenerator, /abs\(coalesce\(pc\.gross_revenue_sar,0\)-oi\.gross_revenue_sar\) <= 0\.005/);
assert.match(portalGenerator, /NOT freshness\.cache_matches_source[\s\S]*?AS accounting_pending/,
  'changed existing rows, not only brand-new rows, must be labelled as awaiting accounting');
assert.match(portalGenerator, /FROM mart\.storage_fee_store_daily_cache\s+WHERE date=current_date/,
  'today storage allocation must use the same atomically published per-store accounting snapshot');
assert.match(portalServer, /profitBackedSections = new Set\(\['profit', 'homeProfit', 'homeRankings', 'rankings', 'productSalesDaily', 'inventoryTrend'\]\)/,
  'inventory trend must use the published profit cache instead of expanding the live canonical view');
assert.match(portalGenerator, /运营可售默认只计 09 散件仓/);
assert.doesNotMatch(portalGenerator, /09散件仓 \+ 01整箱仓为可售/);
assert.match(portalClient, /运营可售默认只计 09 散件仓/);
assert.match(portalClient, /SK-03038 按已批准例外计 09\+01/);
assert.doesNotMatch(portalClient, /09散件仓 \+ 01整箱仓是可售实盘/);
assert.match(portalClient, /function auditMessages\(\)/);
assert.match(portalClient, /class="audit-reasons"/);
assert.match(portalClient, /function returnSettlementKey\(r\)/);
assert.match(portalClient, /退款待落定 \$\{M2\(orderTop\.pendingAmount\)\} SAR/);
assert.match(portalClient, /待决金额只作风险提示，不会提前冲减净销量或已落定利润/);
assert.doesNotMatch(portalClient, /function salesReturnReconciliation\(s,orderSummary\)/,
  'the homepage should not add a redundant gross-to-net formula when the two totals are already visible');
assert.match(portalClient, /const caseNote=`退款待落定 \$\{M\(settlement\.pendingCases\)\}`/);
assert.doesNotMatch(portalClient, /const caseNote=`退款已落定/,
  'compact return summaries should only call out pending refunds');
assert.match(portalClient, /\['refund_pending','退款待落定'\]/,
  'pending refund applications must have a directly visible filter on the return page');
assert.match(portalClient, /status==='refund_pending'&&returnSettlementKey\(r\)!=='pending'/);
assert.match(portalGenerator, /LEFT JOIN mart\.after_sales_settlement_detail settlement/);
assert.match(portalGenerator, /id="auditReasons"/);

assert.match(refresh, /^BEGIN ISOLATION LEVEL REPEATABLE READ;/m);
assert.match(refresh, /pg_advisory_xact_lock\(hashtextextended\('shein-profit-mart-refresh', 0\)\)/);
assert.match(refresh, /mart\.profit_daily_store_product/);
assert.match(refresh, /mart\.storage_fee_product_store_daily_cache_new/);
assert.equal((refresh.match(/FROM mart\.profit_order_item;/g) || []).length, 1,
  'the expensive canonical order-item view must be materialized once per refresh');
assert.match(refresh, /FROM mart\.profit_order_item_cache_new/);
assert.match(refresh, /FROM mart\.storage_fee_product_daily_cache_new/);
assert.match(refresh, /FROM mart\.storage_fee_product_store_daily_cache_new/);
assert.match(refresh, /dependency-ordered cache refresh; canonical conserving storage allocation computed once/);
assert.doesNotMatch(refresh, /CREATE UNLOGGED TABLE mart\.storage_fee_store_daily_cache_new AS\s*SELECT \* FROM mart\.storage_fee_store_daily/,
  'downstream caches must not recompute the entire canonical dependency tree');

for (const contract of [
  'pending_refund_is_risk_not_realized',
  'legacy_history_is_labeled_before_cutover',
  'legacy_no_arrival_uses_only_already_shipped_cost',
  'legacy_future_only_cost_stays_missing',
  'cost_timeline_uses_destination_arrival_only',
  'cost_timeline_requires_physical_departure',
  'post_cutover_missing_ledger_fails_closed',
  'package_estimate_once',
  'partial_refund_and_split_package_fee',
  'pending_partial_refund',
  'split_order_item_rtv_is_allocated_once',
  'zero_quantity_order_must_not_receive_rtv_recovery',
  'finance_actual_replaces_estimate',
  'return_order_performance_price_actual_replaces_estimate',
  'mixed_package_actual_replaces_all_estimate',
  'realized_and_pending_candidates_both_survive',
  'storage_active_link_or_central_pool',
  'storage_reconciles',
]) {
  assert.match(smokeSql, new RegExp(contract));
}

// Regression guards for the two real July cloud incidents: the business-domain
// fetcher must import synchronous fs helpers, and parallel product loaders must
// not each execute warehouse DDL.
assert.match(linkFetch, /import fssync from 'node:fs'/);
assert.match(productRunner, /--skip-ensure/);

console.log(JSON.stringify({
  ok: true,
  contracts: [
    'time-bounded moving-average COGS with frozen periods',
    'pending after-sales separated from realized refunds',
    'partial realized and pending refunds are capped and prorated across split order items',
    'RTV received quantity is conserved across split order items',
    'zero-quantity order lines never receive RTV recovery value',
    'finance or return-order actual cost replaces one estimate per package',
    'product-store storage allocation is conserved with CENTRAL_POOL residual',
    'repeatable-read mart publication and production regressions guarded',
  ],
}, null, 2));
