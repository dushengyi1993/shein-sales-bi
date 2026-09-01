#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const sql = await fs.readFile(
  new URL('../infra/warehouse/migrations/20260723_001_webhook_primary_sales.sql', import.meta.url),
  'utf8',
);
const semanticSql = await fs.readFile(
  new URL('../infra/warehouse/migrations/20260823_001_primary_sales_semantic_promotion.sql', import.meta.url),
  'utf8',
);

assert.match(sql, /primary_sales_enabled[\s\S]*?'false'/);
assert.match(sql, /primary_sales_cutover_date[\s\S]*?'2099-01-01'/);
assert.match(sql, /CREATE OR REPLACE FUNCTION ops\.configure_shein_webhook_primary_sales/);
assert.match(sql, /CREATE OR REPLACE FUNCTION ops\.promote_openapi_sales_slice/);
assert.match(sql, /CREATE TRIGGER trg_openapi_order_header_primary/);
assert.match(sql, /CREATE TRIGGER trg_openapi_order_item_primary/);
assert.match(sql, /CREATE TRIGGER trg_openapi_order_payment_primary/);
assert.match(sql, /PERFORM ops\.refresh_primary_store_daily_sales/);
assert.match(sql, /p_end_date-p_start_date>31/);
assert.match(sql, /REVOKE ALL ON TABLE ops\.shein_webhook_runtime_setting FROM PUBLIC/);
assert.match(sql, /REVOKE ALL ON FUNCTION ops\.configure_shein_webhook_primary_sales\(boolean,date\) FROM PUBLIC/);
assert.match(sql, /REVOKE ALL ON FUNCTION ops\.promote_openapi_sales_slice\(date,date\) FROM PUBLIC/);
assert.doesNotMatch(sql, /GRANT\s+ALL/i);

for (const functionName of [
  'mirror_openapi_order_header_to_primary',
  'mirror_openapi_order_item_to_primary',
  'mirror_openapi_order_payment_to_primary',
]) {
  const functionBody = semanticSql.slice(
    semanticSql.indexOf(`CREATE OR REPLACE FUNCTION ops.${functionName}`),
    semanticSql.indexOf('$$;', semanticSql.indexOf(`CREATE OR REPLACE FUNCTION ops.${functionName}`)) + 3,
  );
  assert.match(functionBody, /current_setting\('shein_bi\.bulk_openapi_sales_reconcile', true\) = 'on'/,
    `${functionName} must bypass only inside the bulk transaction GUC`);
  assert.match(functionBody, /TG_OP='DELETE'[\s\S]*RETURN OLD/,
    `${functionName} bulk delete must return OLD without mirroring`);
  assert.match(functionBody, /RETURN NEW/,
    `${functionName} bulk insert/update must return NEW without mirroring`);
}
assert.match(semanticSql, /CREATE OR REPLACE FUNCTION ops\.promote_openapi_sales_slice_v2\(\s*p_start_date date,\s*p_end_date date\s*\)/);
assert.match(semanticSql, /FROM dim\.store\s+ORDER BY store_key[\s\S]*pg_advisory_xact_lock\(hashtextextended\('shein-openapi-order:'/,
  'v2 must take the loader-compatible sorted store locks before comparing rows');
assert.equal((semanticSql.match(/jsonb_populate_record\(NULL::fact\./g) || []).length >= 6, true,
  'v2 must project all source rows through the target row types for comparison and replacement');
assert.equal((semanticSql.match(/FULL\s+JOIN\s+target_rows/g) || []).length, 3,
  'v2 must use one PK FULL JOIN difference set per table pair');
assert.match(semanticSql, /to_jsonb\(projected_row\) - 'updated_at'/,
  'source comparison must retain every projected field except target updated_at');
assert.match(semanticSql, /to_jsonb\(target_row\) - 'updated_at'/,
  'target comparison must exclude only updated_at');
assert.match(semanticSql, /RETURN QUERY SELECT false,[\s\S]*0::bigint, 0::bigint, 0::bigint, 0::bigint/,
  'v2 no-change path must explicitly return changed=false and zero writes/daily');
assert.match(semanticSql, /CREATE OR REPLACE FUNCTION ops\.promote_openapi_sales_slice\([\s\S]*FROM ops\.promote_openapi_sales_slice_v2\(p_start_date, p_end_date\)/,
  'the old signature must delegate to v2 rather than retain blind replacement');
assert.match(semanticSql, /SELECT promotion\.headers_written, promotion\.items_written,[\s\S]*FROM ops\.promote_openapi_sales_slice_v2\(p_start_date, p_end_date\) AS promotion/,
  'the compatibility wrapper must qualify v2 output columns to avoid PL\/pgSQL output-variable ambiguity');
assert.doesNotMatch(semanticSql, /CREATE OR REPLACE FUNCTION ops\.promote_openapi_sales_slice\([\s\S]*?\$\$;[\s\S]*?DELETE FROM fact\.order_payment_flag[\s\S]*?CREATE OR REPLACE FUNCTION ops\.promote_openapi_sales_slice_v2/,
  'the compatibility wrapper must not contain the old blind delete/insert body');
assert.match(semanticSql, /REVOKE ALL ON FUNCTION ops\.promote_openapi_sales_slice_v2\(date,date\) FROM PUBLIC/);
assert.match(semanticSql, /REVOKE ALL ON FUNCTION ops\.promote_openapi_sales_slice\(date,date\) FROM PUBLIC/);

console.log('webhook_primary_sales_migration: bulk trigger bypass, locked semantic v2 promotion, compatibility wrapper and ACL passed');
