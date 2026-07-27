#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const files = [
  new URL('../infra/warehouse/migrations/20260727_002_shein_webhook_product_state.sql', import.meta.url),
  new URL('../infra/warehouse/schema.sql', import.meta.url),
];

for (const file of files) {
  const sql = await fs.readFile(file, 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ops\.shein_webhook_product_state/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION ops\.apply_shein_webhook_product_state/);
  assert.match(sql, /v_family='product_shelves' AND v_action='off_shelf'/);
  assert.match(sql, /v_family='product_delete_audit' AND v_status='2'/);
  assert.match(sql, /RETURN false;/, 'ambiguous pending-state callbacks must be ignored');
  assert.match(sql, /EXCLUDED\.source_event_order > ops\.shein_webhook_product_state\.source_event_order/);
  assert.match(sql, /receipt\.store_key=v_store/);
  assert.match(sql, /COALESCE\(receipt\.normalized->>'skc',''\)=v_skc/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION ops\.apply_shein_webhook_product_state[\s\S]*TO shein_webhook_ops/);
  assert.match(sql, /GRANT SELECT ON TABLE ops\.shein_webhook_product_state TO shein_link_ops/);
  assert.doesNotMatch(sql, /GRANT (?:INSERT|UPDATE|DELETE)[^;]*ops\.shein_webhook_product_state TO shein_webhook_ops/);
  assert.match(sql, /receipt\.status='succeeded'/);
  assert.match(sql, /receipt\.normalized->>'action' IN \('on_shelf','off_shelf'\)/);
  assert.match(sql, /ON CONFLICT \(store_key,skc\) DO NOTHING/);
}

console.log('shein_webhook_product_state_migration: monotonic event overlay and least-privilege ACL passed');
