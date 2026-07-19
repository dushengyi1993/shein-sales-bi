#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const [portal, writeGate, nginx, caddy, service, notifier, migration, schema] = await Promise.all([
  fs.readFile(new URL('./serve_bi_portal.mjs', import.meta.url), 'utf8'),
  fs.readFile(new URL('../lib/shein_webhook_write_gate.mjs', import.meta.url), 'utf8'),
  fs.readFile(new URL('../infra/nginx/shein-bi.conf', import.meta.url), 'utf8'),
  fs.readFile(new URL('../infra/caddy/Caddyfile.shein-bi', import.meta.url), 'utf8'),
  fs.readFile(new URL('../infra/systemd/shein-bi-webhook.service', import.meta.url), 'utf8'),
  fs.readFile(new URL('./notify_sync_issue.mjs', import.meta.url), 'utf8'),
  fs.readFile(new URL('../infra/warehouse/migrations/20260719_001_shein_webhook_runtime.sql', import.meta.url), 'utf8'),
  fs.readFile(new URL('../infra/warehouse/schema.sql', import.meta.url), 'utf8'),
]);

assert.match(portal, /\/api\/shein\/webhook\/summary/);
assert.match(portal, /\/api\/shein\/webhook\/events/);
assert.match(portal, /actorStores\.includes\('\*'\) \? '\*' : actorStores/);
assert.match(portal, /listEvents\(\{\s*allowedStores,/);
assert.match(writeGate, /listStoreGates\(\{storeKeys: writeStores, blockingOnly: true\}\)/);
assert.match(writeGate, /平台动态安全闸门当前不可用，真实提交已按失败关闭处理/);
assert.ok((portal.match(/await evaluateWebhookWriteGates\(\)/g) || []).length >= 2, 'execute must check platform gates at preflight and immediately before write');
assert.match(writeGate, /probeSummary\.generatedAtMs\) > gateAt/);
assert.match(writeGate, /probeSummary\?\.fresh === true/);

assert.match(nginx, /location = \/api\/shein\/webhook\/v1\/events/);
assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:8792/);
assert.match(nginx, /allow 120\.24\.77\.228;/);
assert.match(nginx, /deny all;/);
assert.match(nginx, /proxy_connect_timeout 250ms;/);
assert.match(nginx, /proxy_read_timeout 1400ms;/);

assert.match(caddy, /https:\/\/sa\.dushengyi\.cc:8443/);
assert.match(caddy, /path \/api\/shein\/webhook\/v1\/events/);
assert.match(caddy, /remote_ip 173\.245\.48\.0\/20/);
assert.match(caddy, /header_up X-Real-IP \{http\.request\.header\.CF-Connecting-IP\}/);

assert.match(service, /^User=sheinops$/m);
assert.match(service, /^Environment=SHEIN_WEBHOOK_HOST=127\.0\.0\.1$/m);
assert.match(service, /^Environment=SHEIN_WEBHOOK_WORKER_ENABLED=1$/m);
assert.match(service, /^Environment=SHEIN_WEBHOOK_INGRESS_BUDGET_MS=1200$/m);
assert.match(service, /^Environment=SHEIN_OPENAPI_REQUEST_TIMEOUT_MS=30000$/m);
assert.match(service, /^EnvironmentFile=\/srv\/shein-bi\/secrets\/webhook-warehouse\.env$/m);
assert.match(service, /^Environment=SHEIN_WAREHOUSE_PG_USER=shein_webhook_ops$/m);
assert.match(service, /^NoNewPrivileges=true$/m);
assert.doesNotMatch(service, /lark_sales_qa_bot|shein-bi-lark-sales-qa/);
assert.match(notifier, /isWebhook/);
assert.match(notifier, /详情与普通动态请到 BI「平台动态」查看/);
assert.match(notifier, /if \(!isWebhook && !res\.ok/);

for (const sql of [migration, schema]) {
  assert.match(sql, /event_data text NOT NULL/);
  assert.doesNotMatch(sql, /decrypted_payload/i);
  assert.match(sql, /GRANT SELECT \(id, received_at, processed_at, store_key, event_code, normalized, severity, status, title, summary, business_key, action_state, duplicate_count\) ON TABLE ops\.shein_webhook_receipt TO shein_link_ops/);
  assert.doesNotMatch(sql, /GRANT SELECT, INSERT, UPDATE ON TABLE ops\.shein_webhook_receipt TO shein_link_ops/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON TABLE ops\.shein_webhook_receipt TO shein_webhook_ops/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE fact\.openapi_order_item TO shein_webhook_ops/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE fact\.openapi_return_item TO shein_webhook_ops/);
  assert.doesNotMatch(sql, /GRANT .*fact\.openapi_(?:order|return).* TO shein_link_ops/);
  assert.doesNotMatch(sql, /GRANT .*fact\.openapi_daily|GRANT .*reconciliation/i);
}

console.log('shein_webhook_portal_contract: auth-scoped read model, write gate, ciphertext schema, ingress and P0 notifier passed');
