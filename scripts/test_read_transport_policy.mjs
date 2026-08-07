#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = relative => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

for (const [unit, transportMarker] of [
  ['shein-bi-cloud-et-forwarder.service', 'SHEIN_ET_TRANSPORT=http'],
  ['shein-bi-cloud-et-storage-fee.service', 'SHEIN_ET_TRANSPORT=http'],
  ['shein-bi-et-low-inventory-recheck.service', 'SHEIN_ET_TRANSPORT=http'],
  ['shein-bi-cloud-rtv-verify.service', 'SHEIN_RTV_TRANSPORT=webapi'],
]) {
  const source = read(`infra/systemd/${unit}`);
  assert.match(source, new RegExp(transportMarker));
  assert.doesNotMatch(source, /run_host_browser_read_job\.sh|--class browser/,
    `${unit} must stay on HTTP/WebAPI and must not reserve or launch a browser`);
}

const et = read('scripts/fetch_et_forwarder.mjs');
assert.match(et, /transport:\s*'http'/);
assert.match(et, /class EtHttpClient/);
assert.match(et, /ET direct HTTP login failed/);
assert.match(et, /et_forwarder_http_session\.local\.json/);

const rtv = read('scripts/cloud_rtv_verify.sh');
assert.match(rtv, /--transport webapi/);
assert.doesNotMatch(rtv, /launch_store_browser|--headless|manage_browser_task_leases/);

const morning = read('scripts/cloud_morning_chain.sh');
const linkSync = read('scripts/cloud_link_business_sync.sh');
assert.match(morning, /resume from exact-date store evidence instead of blocking the whole pipeline/);
assert.match(linkSync, /incremental progress saved after store/,
  'a hard deadline must not erase stores already completed in the morning chain');

const orderRecheck = read('scripts/recheck_order_statuses.mjs');
assert.match(orderRecheck, /pairAttempts:\s*3/);
assert.match(orderRecheck, /qualityStatus = 'partial'/,
  'one transient store/date failure must be a partial quality state, not a false whole-job failure');

const watchdog = read('scripts/cloud_ops_watchdog.mjs');
assert.match(watchdog, /assessBusinessRecovery/);
assert.match(watchdog, /旧退出状态已被后续业务完成标记覆盖/,
  'watchdog must not repeat an obsolete systemd failure after business recovery');

console.log(JSON.stringify({ok: true, policy: 'webapi-first-browser-fallback-only'}, null, 2));
