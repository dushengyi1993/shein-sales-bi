#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

const generator = read('scripts/generate_bi_portal.mjs');
const client = read('scripts/bi_app/client.js');
const reconcile = read('scripts/cloud_openapi_product_reconciliation.sh');
const refresh = read('scripts/cloud_openapi_stock_refresh.sh');
const service = read('infra/systemd/shein-bi-cloud-openapi-stock-refresh.service');
const timer = read('infra/systemd/shein-bi-cloud-openapi-stock-refresh.timer');

assert.match(generator, /openapi_inventory_current AS \(/,
  'linksData must overlay the current OpenAPI inventory source');
assert.match(generator, /p\.has_stock IS TRUE[\s\S]*p\.fetched_at >= now\(\) - interval '45 minutes'/,
  'OpenAPI inventory older than 45 minutes must not be presented as current');
assert.match(generator, /oic\.store_key = l\.store_key AND oic\.skc = l\.skc/,
  'OpenAPI stock must join by exact store and SKC');
assert.match(generator, /openapi_usable_inventory/,
  'linksData must publish current OpenAPI usable stock');
assert.match(generator, /inventoryStock: `[\s\S]*FROM fact\.openapi_product_link[\s\S]*interval '45 minutes'/,
  'the frequent inventory section must be a lightweight standalone OpenAPI query');

assert.match(client, /openapi_inventory_shelf_status_code/,
  'the inventory matrix must use the OpenAPI shelf state');
assert.match(client, /openapi_usable_inventory/,
  'the inventory matrix must use the OpenAPI usable inventory');
assert.match(client, /inventory:\['inventoryTrend','linksData','inventoryStock'\]/,
  'the inventory page must load the independent current-stock section');
assert.match(client, /A\(D\.inventoryStock\)/,
  'the independent current-stock section must overlay the slower link metadata');
assert.match(client, /45 分钟内的 OpenAPI 当前库存/,
  'the operator copy must disclose the inventory freshness gate');

assert.match(reconcile, /openapi-product-reconciliation\.lock/,
  'full and stock-only product reconciliation must share one lock');
assert.match(reconcile, /flock -w 900 9/,
  'OpenAPI inventory refresh must wait boundedly rather than overlap another reconciliation');

assert.match(refresh, /SHEIN_OPENAPI_PRODUCT_RECONCILE_SKIP_DETAILS=1/,
  'the frequent inventory refresh must reuse cached details');
assert.match(refresh, /SHEIN_OPENAPI_PRODUCT_RECONCILE_SKIP_STOCK=0/,
  'the frequent inventory refresh must fetch stock');
assert.match(refresh, /\.counts\.total == 19[\s\S]*\.counts\.succeeded == 19[\s\S]*\.counts\.stockMissing == 0/,
  'the inventory refresh must fail closed unless all 19 stores return stock');
assert.match(refresh, /api\/bi\/section\/inventoryStock\?refresh=1/,
  'a successful stock load must rebuild only the lightweight current-stock section');
assert.match(refresh, /pg_notify[\s\S]*shein_bi_live_update/,
  'a successful stock refresh must notify open BI pages');
assert.doesNotMatch(refresh, /:'payload'/,
  'the notifier must not rely on psql variable expansion inside -c');
assert.match(refresh, /inventory_refresh/,
  'the live event must have a dedicated inventory refresh kind');

assert.match(service, /User=sheinops/,
  'the inventory refresh must not run as root');
assert.match(service, /TimeoutStartSec=900/,
  'the oneshot must have a bounded runtime');
assert.match(timer, /OnCalendar=\*-\*-\* \*:12,42:00/,
  'current virtual stock must refresh twice per hour');
assert.match(timer, /Persistent=false/,
  'missed stock refreshes must not burst after downtime');

console.log('openapi_stock_refresh_contract: current-stock source, 19-store gate, scheduling, and live refresh passed');
