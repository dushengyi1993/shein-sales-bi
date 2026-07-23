#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const sql = await fs.readFile(
  new URL('../infra/warehouse/migrations/20260723_001_webhook_primary_sales.sql', import.meta.url),
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

console.log('webhook_primary_sales_migration: default-off cutover, bounded promotion, triggers and ACL passed');
