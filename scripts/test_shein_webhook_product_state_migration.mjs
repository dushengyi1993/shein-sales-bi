#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const baseMigration = await fs.readFile(
  new URL('../infra/warehouse/migrations/20260727_002_shein_webhook_product_state.sql', import.meta.url),
  'utf8',
);
assert.match(baseMigration, /CREATE TABLE IF NOT EXISTS ops\.shein_webhook_product_state/);
assert.match(baseMigration, /CREATE OR REPLACE FUNCTION ops\.apply_shein_webhook_product_state/);
assert.match(baseMigration, /receipt\.status='succeeded'/);
assert.match(baseMigration, /receipt\.normalized->>'action' IN \('on_shelf','off_shelf'\)/);
assert.match(baseMigration, /ON CONFLICT \(store_key,skc\) DO NOTHING/);

for (const file of [
  new URL('../infra/warehouse/migrations/20260727_003_shein_webhook_product_state_four_states.sql', import.meta.url),
  new URL('../infra/warehouse/schema.sql', import.meta.url),
]) {
  const sql = await fs.readFile(file, 'utf8');
  assert.match(sql, /CREATE OR REPLACE FUNCTION ops\.apply_shein_webhook_product_state/);
  assert.match(sql, /v_action='wait_shelf'/);
  assert.match(sql, /v_action='sold_out'/);
  assert.match(sql, /v_action='off_shelf'/);
  assert.match(sql, /v_family='product_delete_audit' AND v_status='2'/);
  assert.match(sql, /shelf_status_code IN \('1','2','3','4'\)/);
  assert.match(sql, /action IN \('on_shelf','wait_shelf','sold_out','off_shelf'\)/);
  assert.match(sql, /'product_audit_all_channels','price_audit','rrp_review'/);
  assert.match(sql, /RETURN false;/, 'unresolved or unsupported state callbacks must be ignored');
  assert.match(sql, /EXCLUDED\.source_event_order > ops\.shein_webhook_product_state\.source_event_order/);
  assert.match(sql, /receipt\.store_key=v_store/);
  assert.match(sql, /COALESCE\(receipt\.normalized->>'skc',''\)=v_skc/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION ops\.apply_shein_webhook_product_state[\s\S]*TO shein_webhook_ops/);
  assert.doesNotMatch(sql, /GRANT (?:INSERT|UPDATE|DELETE)[^;]*ops\.shein_webhook_product_state TO shein_webhook_ops/);
}

assert.match(baseMigration, /GRANT SELECT ON TABLE ops\.shein_webhook_product_state TO shein_link_ops/);

console.log('shein_webhook_product_state_migration: exact four-state overlay and least-privilege ACL passed');
