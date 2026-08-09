#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const schema = read('infra/warehouse/schema.sql');
const migration = read('infra/warehouse/migrations/20260802_001_order_status_effective_evidence.sql');
const portal = read('scripts/generate_bi_portal.mjs');
const recheck = read('scripts/recheck_order_statuses.mjs');
const watchdog = read('scripts/cloud_ops_watchdog.mjs');
const closureUnit = read('infra/systemd/shein-bi-cloud-order-closure.service');
const closureScript = read('scripts/cloud_order_closure.sh');
const closureCoordinator = read('scripts/cloud_order_closure_coordinator.sh');

for (const source of [schema, migration, recheck]) {
  assert.match(source, /CREATE OR REPLACE VIEW ops\.order_status_recheck_effective/);
  assert.match(source, /oi\.order_item_key AS fact_order_item_key/);
  assert.match(source, /rs\.lifecycle_status_group = 'returning'[\s\S]*THEN 100/);
  assert.match(source, /rs\.lifecycle_status_group = 'done'[\s\S]*THEN 90/);
  assert.match(source, /rs\.last_checked_at DESC NULLS LAST/);
  assert.match(source, /dim\.product_canonical_sn\(rs\.standard_goods_sn\)/);
}

assert.match(portal, /FROM ops\.order_status_recheck_effective rs/);
assert.match(portal, /ON rs\.fact_order_item_key = r\.order_item_key/);
assert.match(portal, /rs\.lifecycle_status_group IN \('returning','abnormal','done'\)/);
assert.match(portal, /coalesce\(rs\.lifecycle_status_group,'cancelled'\) = 'cancelled'/);
assert.match(portal, /已出库后平台取消（待复查）/);
assert.match(portal, /nullif\(rs\.latest_page_status_desc,''\)/);

assert.match(recheck, /WITH et_outbound_orders AS/);
assert.match(recheck, /eo\.order_no IS NOT NULL/);
assert.match(recheck, /coalesce\(rs\.lifecycle_status_group,'cancelled'\) = 'cancelled'/);
assert.match(recheck, /fetch_shein_openapi_sales\.mjs/);
assert.match(recheck, /\['openapi', 'webapi', 'auto', 'browser'\]/);
assert.match(closureUnit, /SHEIN_SALES_TRANSPORT=openapi/);
assert.match(closureUnit, /cloud_order_closure_coordinator\.sh/);
assert.match(closureScript, /--transport openapi/);
assert.match(closureCoordinator, /retrying inside the same daily run/);
assert.match(closureCoordinator, /status" -ne 75/);
assert.match(closureCoordinator, /resource deferral persisted until the start deadline/);
assert.match(closureCoordinator, /while true; do/);
assert.match(closureCoordinator, /sleep "\$RETRY_DELAY_SEC"/);
assert.match(closureCoordinator, /SHEIN_BI_ORDER_CLOSURE_DEADLINE_EPOCH/);
assert.match(closureCoordinator, /run_host_heavy_job\.sh/);
assert.match(closureCoordinator, /run_pipeline_stage\.sh/);
assert.doesNotMatch(closureUnit, /--transport webapi/);
assert.doesNotMatch(closureScript, /--transport webapi/);
assert.match(watchdog, /LEFT JOIN ops\.order_status_recheck_effective rs/);

for (const source of [portal, recheck, watchdog]) {
  assert.doesNotMatch(
    source,
    /LEFT JOIN ops\.order_status_recheck_state rs\s+ON rs\.order_item_key = oi\.order_item_key/,
    'status consumers must not require unstable technical item-key equality',
  );
}

console.log('order_status_effective_evidence_contract: checks passed');
