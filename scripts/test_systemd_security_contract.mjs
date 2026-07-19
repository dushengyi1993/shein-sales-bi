#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

function readUnit(name) {
  return fs.readFileSync(new URL(`../infra/systemd/${name}`, import.meta.url), 'utf8');
}

function property(unit, key) {
  const matches = [...unit.matchAll(new RegExp(`^${key}=(.*)$`, 'gm'))];
  assert.equal(matches.length, 1, `${key} must be declared exactly once`);
  return matches[0][1].trim();
}

function assertCommonHardening(unit, name) {
  assert.equal(property(unit, 'UMask'), '0027', `${name} must not create world-readable runtime secrets`);
  assert.equal(property(unit, 'ProtectSystem'), 'full');
  assert.equal(property(unit, 'ProtectKernelTunables'), 'true');
  assert.equal(property(unit, 'ProtectKernelModules'), 'true');
  assert.equal(property(unit, 'ProtectKernelLogs'), 'true');
  assert.equal(property(unit, 'ProtectControlGroups'), 'true');
  assert.equal(property(unit, 'ProtectClock'), 'true');
  assert.equal(property(unit, 'ProtectHostname'), 'true');
  assert.equal(property(unit, 'LockPersonality'), 'true');
  assert.equal(property(unit, 'RestrictRealtime'), 'true');
  assert.equal(property(unit, 'RestrictSUIDSGID'), 'true');
}

const portal = readUnit('shein-bi-portal.service');
assert.equal(property(portal, 'User'), 'sheinops');
assert.equal(property(portal, 'Group'), 'sheinops');
assert.equal(property(portal, 'OOMPolicy'), 'stop');
assertCommonHardening(portal, 'portal');
assert.doesNotMatch(portal, /^NoNewPrivileges=true$/m, 'portal uses audited sudo child commands and cannot enable this yet');
assert.doesNotMatch(portal, /^PrivateTmp=true$/m, 'portal browser maintenance must share the host temporary namespace');

const lark = readUnit('shein-bi-lark-sales-qa.service');
assert.equal(property(lark, 'User'), 'sheinops');
assert.equal(property(lark, 'Group'), 'sheinops');
assert.match(lark, /^Environment=HOME=\/home\/sheinops$/m);
assert.equal(property(lark, 'NoNewPrivileges'), 'true');
assert.equal(property(lark, 'PrivateTmp'), 'true');
assert.equal(property(lark, 'OOMPolicy'), 'stop');
assertCommonHardening(lark, 'lark bot');
assert.doesNotMatch(lark, /(?:Wants|After)=.*docker\.service/m, 'read-only Lark bot has no Docker dependency');
assert.doesNotMatch(lark, /HOME=\/root|^User=root$|^Group=root$/m, 'Lark bot must never run from root HOME');

const browserCleanupTimer = readUnit('shein-bi-cloud-browser-cleanup.timer');
assert.equal(property(browserCleanupTimer, 'OnCalendar'), '*-*-* *:15:00', 'browser cleanup runs hourly, not every 30 minutes');
assert.equal(property(browserCleanupTimer, 'Persistent'), 'true');

const marketingGuardTimer = readUnit('shein-bi-cloud-marketing-live-guard.timer');
const marketingWindows = [...marketingGuardTimer.matchAll(/^OnCalendar=(.*)$/gm)].map(match => match[1].trim());
assert.deepEqual(marketingWindows, ['*-*-* 10:30:00', '*-*-* 13:30:00', '*-*-* 16:30:00']);
assert.equal(property(marketingGuardTimer, 'Persistent'), 'true');

const marketingGuard = readUnit('shein-bi-cloud-marketing-live-guard.service');
const marketingGuardScript = fs.readFileSync(new URL('./cloud_marketing_live_guard.sh', import.meta.url), 'utf8');
assert.doesNotMatch(marketingGuard, /^ExecStart(?:Pre|Post)=.*cleanup_shein_store_browsers/m,
  'browserless marketing inspection must not have unit-level cleanup');
assert.match(marketingGuard, /SHEIN_BI_MARKETING_LIVE_BUILD_REPAIR_QUEUE=1/);
assert.doesNotMatch(marketingGuard, /SHEIN_BI_MARKETING_AUTOMATION_AUTHORIZATION=/, 'read-only inspection service must not receive write authorization');
assert.match(marketingGuard, /SHEIN_BI_MARKETING_LIVE_SCAN_TIMEOUT_SEC=900/);
assert.match(marketingGuard, /SHEIN_BI_MARKETING_PRICE_SESSION_CONCURRENCY=3/);
assert.doesNotMatch(marketingGuard, /SHEIN_BI_MARKETING_LIVE_LEASE_TTL_SEC=/);
assert.doesNotMatch(marketingGuardScript, /manage_browser_task_leases\.mjs|cleanup_shein_store_browsers/);
assert.doesNotMatch(marketingGuardScript, /batch_(?:fix_limited_discount_drift|apply_new_listing_limited_discount)\.mjs[^\n]*--execute/);
assert.doesNotMatch(marketingGuardScript, /batch_restore_manual_limited_discounts\.mjs[^\n]*--execute/);
assert.equal(property(marketingGuard, 'TimeoutStartSec'), '1800');

const marketingRepairTimer = readUnit('shein-bi-cloud-marketing-repair.timer');
assert.equal(property(marketingRepairTimer, 'OnCalendar'), '*-*-* 10,12,14,16,18:50:00');
assert.equal(property(marketingRepairTimer, 'Persistent'), 'true');
const marketingRepair = readUnit('shein-bi-cloud-marketing-repair.service');
const marketingRepairScript = fs.readFileSync(new URL('./cloud_marketing_repair_worker.sh', import.meta.url), 'utf8');
assert.doesNotMatch(marketingRepair, /^ExecStart(?:Pre|Post)=.*cleanup_shein_store_browsers/m,
  'marketing repair must not stack unit-level cleanup around its lease-owned script cleanup');
assert.match(marketingRepair, /SHEIN_BI_MARKETING_REPAIR_MAX_GROUPS=8/);
assert.match(marketingRepair, /SHEIN_BI_MARKETING_AUTOMATION_AUTHORIZATION=owner-standing-cloud-marketing-v1/);
assert.match(marketingRepairScript, /--max-groups "\$REMAINING_GROUPS"/);
assert.match(marketingRepairScript, /new_groups_in_result/);
assert.equal(property(marketingRepair, 'TimeoutStartSec'), '2400');

const storageFeeTimer = readUnit('shein-bi-cloud-et-storage-fee.timer');
assert.equal(property(storageFeeTimer, 'OnCalendar'), '*-*-* 14:10:00 Asia/Shanghai');
assert.equal(property(storageFeeTimer, 'Persistent'), 'true');

const storageFeeSync = readUnit('shein-bi-cloud-et-storage-fee.service');
assert.equal(property(storageFeeSync, 'User'), 'sheinops');
assert.equal(property(storageFeeSync, 'Group'), 'sheinops');
assert.equal(property(storageFeeSync, 'UMask'), '0027');
assert.equal(property(storageFeeSync, 'ProtectSystem'), 'full');
assert.equal(property(storageFeeSync, 'ProtectKernelTunables'), 'true');
assert.equal(property(storageFeeSync, 'ProtectKernelModules'), 'true');
assert.equal(property(storageFeeSync, 'ProtectKernelLogs'), 'true');
assert.equal(property(storageFeeSync, 'ProtectControlGroups'), 'true');
assert.equal(property(storageFeeSync, 'ProtectClock'), 'true');
assert.equal(property(storageFeeSync, 'ProtectHostname'), 'true');
assert.equal(property(storageFeeSync, 'LockPersonality'), 'true');
assert.equal(property(storageFeeSync, 'RestrictRealtime'), 'true');
assert.equal(property(storageFeeSync, 'OOMPolicy'), 'stop');
assert.equal(property(storageFeeSync, 'TimeoutStartSec'), '7200');
assert.match(storageFeeSync, /^Environment=HOME=\/home\/sheinops$/m);
assert.match(storageFeeSync, /shein-bi-cloud-et-forwarder\.lock/,
  'storage-fee sync must serialize the shared ET browser profile');
assert.match(storageFeeSync, /SHEIN_ET_STORAGE_FEE_OUTPUT_DIR=\/opt\/shein-bi\/app\/outputs\/et-storage-fee/,
  'storage-fee sync must not share the generic root-owned output tree');
assert.match(storageFeeSync, /^Environment=SHEIN_DOCKER_USE_SUDO=1$/m,
  'storage-fee sync must use the audited NOPASSWD Docker path');
assert.doesNotMatch(storageFeeSync, /^NoNewPrivileges=true$/m,
  'storage-fee sync uses the audited sheinops NOPASSWD Docker helpers');
assert.doesNotMatch(storageFeeSync, /^RestrictSUIDSGID=true$/m,
  'storage-fee sync must not block its audited sudo elevation');

for (const timerName of [
  'shein-bi-cloud-morning-chain.timer',
  'shein-bi-cloud-order-closure.timer',
  'shein-bi-cloud-session-manager.timer',
  'shein-bi-cloud-yesterday.timer',
  'shein-bi-db-backup.timer',
]) {
  assert.equal(property(readUnit(timerName), 'Persistent'), 'true', `${timerName} must catch up after downtime`);
}

console.log(JSON.stringify({
  ok: true,
  checked: [
    'shein-bi-portal.service',
    'shein-bi-lark-sales-qa.service',
    'hourly lease-aware browser cleanup',
    'three retry-capable marketing guard windows',
    'bounded resumable marketing repair worker',
    'daily canonical ET storage-fee sync',
    'persistent critical daily timers',
  ],
}, null, 2));
