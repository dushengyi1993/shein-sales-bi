#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const helper = read('scripts/lib/shared_lock.sh');
const lockScripts = [
  'scripts/cloud_bi_refresh.sh',
  'scripts/cloud_daily_refresh.sh',
  'scripts/cloud_daily_lark_report.sh',
  'scripts/cloud_et_forwarder_sync.sh',
  'scripts/cloud_marketing_live_guard.sh',
  'scripts/cloud_morning_chain.sh',
  'scripts/prewarm_bi_portal_sections.sh',
];

assert.match(helper, /SHEIN_BI_SHARED_LOCK_GROUP:-sheinops/);
assert.match(helper, /chmod 2770/);
assert.match(helper, /chmod 0660/);
assert.match(helper, /Refusing unsafe shared lock (directory|file)/);
assert.doesNotMatch(helper, /chmod 0?666|chmod 0?777|umask 000/);

for (const relativePath of lockScripts) {
  const source = read(relativePath);
  assert.match(source, /source "\$ROOT\/scripts\/lib\/shared_lock\.sh"/, `${relativePath} must use the shared lock helper`);
  assert.match(source, /prepare_shared_lock_file/, `${relativePath} must prepare its lock before flock`);
  assert.doesNotMatch(source, /\/tmp\/[^"'\s]*\.lock/, `${relativePath} must not use a predictable /tmp lock`);
  assert.doesNotMatch(source, /chmod 0?666|chmod 0?777|umask 000/, `${relativePath} must not recreate world-writable locks`);
}

const daily = read('scripts/cloud_daily_refresh.sh');
assert.match(daily, /prepare_shared_lock_file "\$LARK_REPORT_LOCK_FILE"/);
assert.match(daily, /prepare_shared_lock_file "\$PORTAL_REFRESH_LOCK_FILE"/);

const unitLocks = new Map([
  ['infra/systemd/shein-bi-cloud-daily-refresh.service', ['SHEIN_BI_DAILY_LOCK_FILE', 'SHEIN_LARK_REPORT_LOCK_FILE']],
  ['infra/systemd/shein-bi-cloud-daily-lark-report.service', ['SHEIN_LARK_REPORT_LOCK_FILE']],
  ['infra/systemd/shein-bi-cloud-et-forwarder.service', ['SHEIN_ET_LOCK_FILE']],
  ['infra/systemd/shein-bi-cloud-marketing-live-guard.service', ['SHEIN_BI_MARKETING_LIVE_LOCK_FILE']],
  ['infra/systemd/shein-bi-cloud-morning-chain.service', ['SHEIN_BI_MORNING_CHAIN_LOCK_FILE']],
]);
for (const [relativePath, variables] of unitLocks) {
  const source = read(relativePath);
  for (const variable of variables) {
    assert.match(source, new RegExp(`Environment=${variable}=\\/opt\\/shein-bi\\/app\\/state\\/locks\\/`), `${relativePath} must pin ${variable} inside state/locks`);
  }
  assert.doesNotMatch(source, /\/tmp\/[^\s]*\.lock/);
}

console.log('shared_lock_security: production locks are centralized, group-scoped, and non-world-writable');
