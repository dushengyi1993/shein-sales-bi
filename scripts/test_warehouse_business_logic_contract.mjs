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
const periodManager = read('scripts/manage_accounting_period.mjs');
const openingSeed = read('scripts/seed_inventory_cost_opening_from_et.mjs');
const linkFetch = read('scripts/fetch_shein_business_domains.mjs');
const productRunner = read('scripts/run_shein_openapi_products_reconciliation.mjs');

assert.match(schema, /CREATE TABLE IF NOT EXISTS fact\.inventory_cost_opening/);
assert.match(schema, /CREATE TABLE IF NOT EXISTS fact\.inventory_cost_event/);
assert.match(schema, /CREATE TABLE IF NOT EXISTS fact\.inventory_cost_ledger/);
assert.match(schema, /CREATE TABLE IF NOT EXISTS ops\.accounting_period_close/);
assert.match(schema, /CREATE TABLE IF NOT EXISTS ops\.inventory_cost_run/);
assert.match(schema, /NULL::numeric AS estimated_on_hand_quantity/);
assert.match(schema, /'model_estimate_disabled'::text AS inventory_match_status/);
assert.match(schema, /legacy_pre_cutover_estimate/);
assert.match(schema, /future receipt can never leak backwards into current-period COGS/);
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
assert.match(schema, /LEFT JOIN mart\.return_cost_actual fa/);
assert.match(schema, /pending_revenue_risk/);
assert.match(schema, /estimated_return_delivery_fee_sar/);

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
assert.doesNotMatch(audit, /return arr\.length \? `\?\?\?/,
  'missing-store warnings must remain readable Chinese instead of mojibake');
assert.match(audit, /notes\.push\(`有 \$\{storage\.detail_scaled_days\}/,
  'conserving storage-detail scaling is an accounting note, not a recurring health warning');
assert.match(audit, /notes\.push\(`有 \$\{Number\(storage\.central_pool_fee_sar\)/,
  'a conserved CENTRAL_POOL balance is an accounting note, not an actionable health warning');

assert.match(portalGenerator, /SHEIN_BI_PROFIT_MART_SOURCE \|\| 'cache'/,
  'portal core must serve the published profit cache by default');
assert.match(portalGenerator, /Operators may still\s*\n\/\/ request `view` explicitly/);
assert.match(portalServer, /profitBackedSections = new Set\(\['profit', 'homeProfit', 'homeRankings', 'rankings', 'productSalesDaily', 'inventoryTrend'\]\)/,
  'inventory trend must use the published profit cache instead of expanding the live canonical view');
assert.match(portalGenerator, /运营可售默认只计 09 散件仓/);
assert.doesNotMatch(portalGenerator, /09散件仓 \+ 01整箱仓为可售/);
assert.match(portalClient, /运营可售默认只计 09 散件仓/);
assert.match(portalClient, /SK-03038 按已批准例外计 09\+01/);
assert.doesNotMatch(portalClient, /09散件仓 \+ 01整箱仓是可售实盘/);

assert.match(refresh, /^BEGIN ISOLATION LEVEL REPEATABLE READ;/m);
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
  'post_cutover_missing_ledger_fails_closed',
  'package_estimate_once',
  'finance_actual_replaces_estimate',
  'return_order_performance_price_actual_replaces_estimate',
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
    'finance or return-order actual cost replaces one estimate per package',
    'product-store storage allocation is conserved with CENTRAL_POOL residual',
    'repeatable-read mart publication and production regressions guarded',
  ],
}, null, 2));
