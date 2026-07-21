#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const [portal, webhookServer, writeGate, productExecutor, maintenanceExecutor, nginx, caddy, haproxy, service, notifier, migration, contextMigration, schema] = await Promise.all([
  fs.readFile(new URL('./serve_bi_portal.mjs', import.meta.url), 'utf8'),
  fs.readFile(new URL('./serve_shein_webhook.mjs', import.meta.url), 'utf8'),
  fs.readFile(new URL('../lib/shein_webhook_write_gate.mjs', import.meta.url), 'utf8'),
  fs.readFile(new URL('./link_ops_hl_openapi_executor.mjs', import.meta.url), 'utf8'),
  fs.readFile(new URL('./link_ops_maintenance_openapi_executor.mjs', import.meta.url), 'utf8'),
  fs.readFile(new URL('../infra/nginx/shein-bi.conf', import.meta.url), 'utf8'),
  fs.readFile(new URL('../infra/caddy/Caddyfile.shein-bi', import.meta.url), 'utf8'),
  fs.readFile(new URL('../infra/haproxy/haproxy-ssh-https.cfg', import.meta.url), 'utf8'),
  fs.readFile(new URL('../infra/systemd/shein-bi-webhook.service', import.meta.url), 'utf8'),
  fs.readFile(new URL('./notify_sync_issue.mjs', import.meta.url), 'utf8'),
  fs.readFile(new URL('../infra/warehouse/migrations/20260719_001_shein_webhook_runtime.sql', import.meta.url), 'utf8'),
  fs.readFile(new URL('../infra/warehouse/migrations/20260721_001_shein_webhook_product_context.sql', import.meta.url), 'utf8'),
  fs.readFile(new URL('../infra/warehouse/schema.sql', import.meta.url), 'utf8'),
]);

assert.match(portal, /\/api\/shein\/webhook\/summary/);
assert.match(portal, /\/api\/shein\/webhook\/events/);
assert.match(portal, /actorStores\.includes\('\*'\) \? '\*' : actorStores/);
assert.match(portal, /listEvents\(\{\s*allowedStores,/);
assert.match(writeGate, /listStoreGates\(\{storeKeys: writeStores, blockingOnly: true\}\)/);
assert.match(writeGate, /平台动态安全闸门当前不可用，真实提交已按失败关闭处理/);
assert.ok((portal.match(/await evaluateWebhookWriteGates\(\)/g) || []).length >= 2, 'execute must check platform gates at preflight and immediately before write');
assert.ok((portal.match(/beforeStoreWrite: store => evaluateWebhookWriteGates\(\[store\]\)/g) || []).length >= 2, 'every store executor must recheck its own gate');
assert.match(writeGate, /probeSummary\.generatedAtMs\) > gateAt/);
assert.match(writeGate, /probeSummary\?\.fresh === true/);
for (const executor of [productExecutor, maintenanceExecutor]) {
  assert.match(executor, /import \{runSheinWebhookExternalWriteGuarded\} from '\.\.\/lib\/shein_webhook_external_write_guard\.mjs';/);
  assert.match(executor, /runSheinWebhookExternalWriteGuarded\(\{[\s\S]*?writeStores:\s*\[[^\]]+\][\s\S]*?write:\s*\(\)\s*=>\s*client\.request\(/);
}
assert.match(productExecutor, /runSheinWebhookExternalWriteGuarded\(\{[\s\S]*?publishOrEdit/);
assert.match(maintenanceExecutor, /for\s*\(const p of payloads\)[\s\S]*?runSheinWebhookExternalWriteGuarded\(/, 'maintenance must recheck immediately before every payload write');

assert.match(nginx, /location = \/api\/shein\/webhook\/v1\/events/);
assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:8792/);
assert.match(nginx, /allow 120\.24\.77\.228;/);
assert.match(nginx, /deny all;/);
assert.match(nginx, /proxy_connect_timeout 250ms;/);
assert.match(nginx, /proxy_read_timeout 1400ms;/);

assert.match(caddy, /https:\/\/sa\.dushengyi\.cc:8443/);
assert.match(caddy, /https:\/\/sa\.dushengyi\.cc:10443/);
assert.match(caddy, /path \/api\/shein\/webhook\/v1\/events/);
assert.match(caddy, /remote_ip 173\.245\.48\.0\/20/);
assert.match(caddy, /header_up X-Real-IP \{http\.request\.header\.CF-Connecting-IP\}/);
assert.match(haproxy, /acl is_shein_bi_sni req\.ssl_sni -i sa\.dushengyi\.cc/);
assert.match(haproxy, /acl is_cloudflare src 173\.245\.48\.0\/20/);
const proxyReject = haproxy.indexOf('tcp-request content reject if is_tls is_shein_bi_sni !is_cloudflare');
const proxyTlsAccept = haproxy.indexOf('tcp-request content accept if is_tls');
assert.ok(proxyReject >= 0 && proxyTlsAccept > proxyReject, 'Cloudflare/SNI reject must run before TLS acceptance');
assert.doesNotMatch(haproxy, /tcp-request content accept if \{ req\.len gt 0 \}/, 'partial first bytes must not bypass TLS SNI inspection');

assert.match(service, /^User=sheinops$/m);
assert.match(service, /^Environment=SHEIN_WEBHOOK_HOST=127\.0\.0\.1$/m);
assert.match(service, /^Environment=SHEIN_WEBHOOK_WORKER_ENABLED=1$/m);
assert.match(service, /^Environment=SHEIN_WEBHOOK_INGRESS_BUDGET_MS=1200$/m);
assert.match(service, /^Environment=SHEIN_OPENAPI_REQUEST_TIMEOUT_MS=30000$/m);
assert.match(service, /^EnvironmentFile=\/srv\/shein-bi\/secrets\/webhook-warehouse\.env$/m);
assert.match(service, /^Environment=SHEIN_WAREHOUSE_PG_USER=shein_webhook_ops$/m);
assert.match(service, /^NoNewPrivileges=true$/m);
assert.match(service, /^ProtectSystem=strict$/m);
assert.match(service, /^PrivateTmp=true$/m);
assert.doesNotMatch(service, /lark_sales_qa_bot|shein-bi-lark-sales-qa/);
assert.doesNotMatch(webhookServer, /createConfiguredLinkOpsStoreGateway|linkOpsGateway/, 'webhook DB role must not touch mutable link-ops tables');
assert.match(notifier, /isWebhook/);
assert.match(notifier, /SHEIN 平台发来一项需要人工处理的变化/);
assert.doesNotMatch(notifier, /详情与普通动态请到 BI「平台动态」查看|该消息仅用于平台高优先级异常/);
assert.match(notifier, /if \(!isWebhook && !res\.ok/);

for (const sql of [migration, schema]) {
  assert.match(sql, /event_data text NOT NULL/);
  assert.match(sql, /source_event_order numeric\(30,0\)/);
  assert.match(sql, /JOIN ops\.shein_webhook_receipt AS receipt ON receipt\.id=gate\.source_receipt_id/);
  assert.doesNotMatch(sql, /decrypted_payload/i);
  assert.match(sql, /GRANT SELECT \(id, received_at, processed_at, store_key, event_code, normalized, severity, status, title, summary, business_key, action_state, duplicate_count\) ON TABLE ops\.shein_webhook_receipt TO shein_link_ops/);
  assert.doesNotMatch(sql, /GRANT SELECT, INSERT, UPDATE ON TABLE ops\.shein_webhook_receipt TO shein_link_ops/);
  assert.match(sql, /GRANT SELECT ON TABLE ops\.shein_webhook_store_gate TO shein_link_ops/);
  assert.doesNotMatch(sql, /GRANT SELECT, INSERT, UPDATE ON TABLE ops\.shein_webhook_store_gate TO shein_link_ops/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION ops\.reopen_shein_webhook_authorization_gate\(text,bigint,text\) TO shein_link_ops/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON TABLE ops\.shein_webhook_receipt TO shein_webhook_ops/);
  assert.match(sql, /GRANT SELECT ON TABLE fact\.openapi_order_item TO shein_webhook_ops/);
  assert.match(sql, /GRANT SELECT ON TABLE fact\.openapi_return_item TO shein_webhook_ops/);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON TABLE fact\.openapi_order_item FROM shein_webhook_ops/);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON TABLE fact\.openapi_return_item FROM shein_webhook_ops/);
  assert.doesNotMatch(sql, /GRANT [^;\n]*(?:INSERT|UPDATE|DELETE)[^;\n]*fact\.openapi_[^;\n]* TO shein_webhook_ops/);
  assert.match(sql, /source_snapshot_at timestamptz/);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION ops\.prepare_shein_webhook_(?:order|return)_replace[^;]* TO shein_webhook_ops/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION ops\.apply_shein_webhook_order_snapshot\(text,text,timestamptz,jsonb,jsonb,jsonb\) TO shein_webhook_ops/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION ops\.apply_shein_webhook_return_snapshot\(text,text,timestamptz,jsonb,jsonb\) TO shein_webhook_ops/);
  assert.doesNotMatch(sql, /GRANT .*fact\.openapi_(?:order|return).* TO shein_link_ops/);
  assert.doesNotMatch(sql, /GRANT .*fact\.openapi_daily|GRANT .*reconciliation/i);
}

for (const sql of [contextMigration, schema]) {
  assert.match(sql, /CREATE OR REPLACE FUNCTION ops\.get_shein_webhook_product_context/);
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /REVOKE ALL ON FUNCTION ops\.get_shein_webhook_product_context\(text,text,timestamptz\) FROM PUBLIC/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION ops\.get_shein_webhook_product_context\(text,text,timestamptz\) TO shein_webhook_ops/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION ops\.get_shein_webhook_product_context\(text,text,timestamptz\) TO shein_link_ops/);
  assert.doesNotMatch(contextMigration, /GRANT SELECT ON (?:TABLE )?(?:fact|mart)\./, 'context roles must not receive raw mart SELECT');
}

console.log('shein_webhook_portal_contract: auth-scoped read model, write gate, ciphertext schema, ingress and P0 notifier passed');
