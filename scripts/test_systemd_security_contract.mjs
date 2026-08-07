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

function assertCommonHardening(unit, name, {allowAuditedSudo = false, protectSystem = 'full', umask = '0027'} = {}) {
  assert.equal(property(unit, 'UMask'), umask, `${name} must not create world-readable runtime secrets`);
  assert.equal(property(unit, 'ProtectSystem'), protectSystem);
  assert.equal(property(unit, 'ProtectKernelTunables'), 'true');
  assert.equal(property(unit, 'ProtectKernelModules'), 'true');
  assert.equal(property(unit, 'ProtectKernelLogs'), 'true');
  assert.equal(property(unit, 'ProtectControlGroups'), 'true');
  assert.equal(property(unit, 'ProtectClock'), 'true');
  assert.equal(property(unit, 'ProtectHostname'), 'true');
  assert.equal(property(unit, 'LockPersonality'), 'true');
  assert.equal(property(unit, 'RestrictRealtime'), 'true');
  if (allowAuditedSudo) {
    assert.doesNotMatch(unit, /^RestrictSUIDSGID=true$/m, `${name} uses audited sudo docker helpers`);
  } else {
    assert.equal(property(unit, 'RestrictSUIDSGID'), 'true');
  }
}

const portal = readUnit('shein-bi-portal.service');
assert.equal(property(portal, 'User'), 'sheinops');
assert.equal(property(portal, 'Group'), 'sheinops');
assert.equal(property(portal, 'OOMPolicy'), 'stop');
assertCommonHardening(portal, 'portal');
assert.doesNotMatch(portal, /^NoNewPrivileges=true$/m, 'portal uses audited sudo child commands and cannot enable this yet');
assert.doesNotMatch(portal, /^PrivateTmp=true$/m, 'portal browser maintenance must share the host temporary namespace');

const webhook = readUnit('shein-bi-webhook.service');
const webhookProvision = fs.readFileSync(new URL('./provision_shein_webhook_postgres_role.sh', import.meta.url), 'utf8');
assert.equal(property(webhook, 'User'), 'sheinops');
assert.equal(property(webhook, 'Group'), 'sheinops');
assert.equal(property(webhook, 'OOMPolicy'), 'stop');
assert.equal(property(webhook, 'Restart'), 'always');
assert.match(webhook, /^Environment=HOME=\/home\/sheinops$/m);
assert.match(webhook, /^Environment=SHEIN_WEBHOOK_HOST=127\.0\.0\.1$/m);
assert.match(webhook, /^Environment=SHEIN_WEBHOOK_PORT=8792$/m);
assert.match(webhook, /^Environment=SHEIN_WEBHOOK_WORKER_ENABLED=1$/m);
assert.match(webhook, /^Environment=SHEIN_OPENAPI_CONFIG_FILE=\/opt\/shein-bi\/app\/config\/shein_openapi\.local\.json$/m);
assert.match(webhook, /^Environment=SHEIN_WEBHOOK_CREDENTIAL_CONFIG_FILE=\/srv\/shein-bi\/secrets\/webhook-openapi-central\.json$/m);
assert.match(webhook, /^EnvironmentFile=\/srv\/shein-bi\/secrets\/webhook-warehouse\.env$/m);
assert.match(webhook, /^Environment=SHEIN_WAREHOUSE_PG_USER=shein_webhook_ops$/m);
assert.doesNotMatch(webhook, /portal-warehouse\.env|SHEIN_WAREHOUSE_PG_USER=shein_link_ops/, 'webhook must not inherit the portal database role');
assert.equal(property(webhook, 'NoNewPrivileges'), 'true');
assertCommonHardening(webhook, 'webhook', {protectSystem: 'strict'});
assert.equal(property(webhook, 'PrivateTmp'), 'true');
assert.doesNotMatch(webhook, /sudo|docker exec/, 'webhook worker uses restricted direct PostgreSQL, never sudo/docker');
assert.match(webhookProvision, /install -d -m 0750 -o root -g "\$\{ENV_DIR_GROUP\}"/, 'webhook provisioning must preserve Portal access to the shared secrets directory');
assert.match(webhookProvision, /chmod 0600 "\$\{temporary\}"/, 'the webhook database credential itself must remain root-only');
assert.doesNotMatch(webhookProvision, /install -d -m 0700[^\n]*dirname/, 'webhook provisioning must not make the shared secrets directory root-only');

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

for (const unitName of [
  'shein-bi-cloud-today.service',
  'shein-bi-cloud-yesterday.service',
]) {
  const salesRefresh = readUnit(unitName);
  assert.equal(property(salesRefresh, 'User'), 'sheinops', `${unitName} must not create root-owned shared artifacts`);
  assert.equal(property(salesRefresh, 'Group'), 'sheinops');
  assert.match(salesRefresh, /^Environment=HOME=\/home\/sheinops$/m);
  assert.match(salesRefresh, /^Environment=SHEIN_DOCKER_USE_SUDO=1$/m);
  assert.match(salesRefresh, /^Environment=SHEIN_BI_OPENAPI_RECON_DIR=\/opt\/shein-bi\/app\/outputs\/reports\/openapi-sales-reconciliation$/m);
  assert.doesNotMatch(salesRefresh, /HOME=\/root|^User=root$|^Group=root$/m);
  assert.equal(property(salesRefresh, 'UMask'), '0077', `${unitName} can touch browser/session state and must create private files`);
  assertCommonHardening(salesRefresh, unitName, {allowAuditedSudo: true, umask: '0077'});
  assert.doesNotMatch(salesRefresh, /^NoNewPrivileges=true$/m, `${unitName} uses audited sheinops NOPASSWD Docker helpers`);
}

const sessionManager = readUnit('shein-bi-cloud-session-manager.service');
assert.equal(property(sessionManager, 'User'), 'sheinops');
assert.equal(property(sessionManager, 'Group'), 'sheinops');
assert.equal(property(sessionManager, 'UMask'), '0077', 'session manager persists browser credentials and must create private files');
assertCommonHardening(sessionManager, 'session manager', {allowAuditedSudo: true, umask: '0077'});
assert.match(sessionManager, /SHEIN_BI_NIGHTLY_MAINTENANCE_LOCK_FILE=\/opt\/shein-bi\/app\/state\/locks\/shein-bi-nightly-maintenance\.lock/);
assert.match(sessionManager, /--deadline-at 01:27/);
assert.match(sessionManager, /--stage nightly-session/);
assert.match(sessionManager, /flock -w 120/);
assert.match(property(sessionManager, 'Before'), /shein-bi-db-backup\.service/);
assert.match(property(sessionManager, 'Before'), /shein-bi-cloud-yesterday\.service/);

const dbBackup = readUnit('shein-bi-db-backup.service');
assert.equal(property(dbBackup, 'User'), 'root');
assert.equal(property(dbBackup, 'Group'), 'sheinops');
assert.equal(property(dbBackup, 'UMask'), '0027');
assert.equal(property(dbBackup, 'NoNewPrivileges'), 'true');
assert.equal(property(dbBackup, 'PrivateTmp'), 'true');
assertCommonHardening(dbBackup, 'db backup');
assert.match(dbBackup, /SHEIN_BI_NIGHTLY_MAINTENANCE_LOCK_FILE=\/opt\/shein-bi\/app\/state\/locks\/shein-bi-nightly-maintenance\.lock/);
assert.match(dbBackup, /--deadline-at 01:52/);
assert.match(dbBackup, /--stage nightly-backup --require nightly-session/);
assert.match(dbBackup, /flock -w 120/);
assert.equal(property(dbBackup, 'TimeoutStartSec'), '10800',
  'backup timeout must cover the longest lock wait plus the backup execution budget');
assert.match(property(dbBackup, 'After'), /shein-bi-cloud-session-manager\.service/);
assert.match(property(dbBackup, 'Before'), /shein-bi-cloud-yesterday\.service/);

const yesterday = readUnit('shein-bi-cloud-yesterday.service');
assert.match(yesterday, /flock -w 120/, 'yesterday final refresh waits briefly for the shared nightly maintenance lock');
assert.match(yesterday, /--deadline-at 03:27/);
assert.match(yesterday, /--stage yesterday-final --business-date yesterday --require nightly-session --require nightly-backup/);
assert.match(yesterday, /SHEIN_SALES_TRANSPORT=openapi/, 'final-day sales must not depend on expiring Seller Center sessions');
assert.match(property(yesterday, 'After'), /shein-bi-cloud-session-manager\.service/);
assert.match(property(yesterday, 'After'), /shein-bi-db-backup\.service/);
assert.match(yesterday, /cloud_bi_refresh\.sh yesterday yesterday-final; \/opt\/shein-bi\/app\/scripts\/cloud_bi_refresh\.sh 2daysago third-day-stable-recheck/,
  'both final-day phases must remain inside one lock holder');

const browserCleanupTimer = readUnit('shein-bi-cloud-browser-cleanup.timer');
const browserCleanupWindows = [...browserCleanupTimer.matchAll(/^OnCalendar=(.*)$/gm)].map(match => match[1].trim());
assert.deepEqual(browserCleanupWindows, ['*-*-* 03:20:00', '*-*-* 09:25:00', '*-*-* 21:20:00']);
assert.equal(property(browserCleanupTimer, 'Persistent'), 'false');

const diskMaintenance = readUnit('shein-bi-cloud-disk-maintenance.service');
assert.equal(property(diskMaintenance, 'User'), 'root');
assert.equal(property(diskMaintenance, 'Group'), 'sheinops');
assert.equal(property(diskMaintenance, 'OOMPolicy'), 'stop');
assert.equal(property(diskMaintenance, 'NoNewPrivileges'), 'true');
assert.equal(property(diskMaintenance, 'PrivateTmp'), 'true');
assertCommonHardening(diskMaintenance, 'disk maintenance');
assert.match(diskMaintenance, /SHEIN_BI_PROFILE_CACHE_THRESHOLD_PERCENT=75/);
assert.match(diskMaintenance, /SHEIN_BI_OUTPUT_RETENTION_DAYS=30/);
assert.doesNotMatch(diskMaintenance, /restore_shein_store_session|bootstrap_shein_browser_session/,
  'root-run disk maintenance must never launch a SHEIN browser');
const diskMaintenanceTimer = readUnit('shein-bi-cloud-disk-maintenance.timer');
assert.equal(property(diskMaintenanceTimer, 'OnCalendar'), '*-*-* 00:10:00 Asia/Shanghai');
assert.equal(property(diskMaintenanceTimer, 'Persistent'), 'false');

const dataDiskGuard = readUnit('shein-bi-data-disk-requires-mounts.conf');
assert.match(dataDiskGuard, /^RequiresMountsFor=\/data .*\/opt\/shein-bi\/app\/profiles .*\/opt\/shein-bi\/app\/outputs .*\/srv\/shein-bi\/runtime .*\/srv\/shein-bi\/backups$/m);
assert.equal(property(dataDiskGuard, 'After'), 'local-fs.target');

const marketingGuardTimer = readUnit('shein-bi-cloud-marketing-live-guard.timer');
const marketingWindows = [...marketingGuardTimer.matchAll(/^OnCalendar=(.*)$/gm)].map(match => match[1].trim());
assert.deepEqual(marketingWindows, ['*-*-* 11:00:00', '*-*-* 13:00:00', '*-*-* 16:00:00']);
assert.equal(property(marketingGuardTimer, 'Persistent'), 'false');

const marketingGuard = readUnit('shein-bi-cloud-marketing-live-guard.service');
const marketingGuardScript = fs.readFileSync(new URL('./cloud_marketing_live_guard.sh', import.meta.url), 'utf8');
assert.doesNotMatch(marketingGuard, /^ExecStart(?:Pre|Post)=.*cleanup_shein_store_browsers/m,
  'browserless marketing inspection must not have unit-level cleanup');
assert.match(marketingGuard, /SHEIN_BI_MARKETING_LIVE_BUILD_REPAIR_QUEUE=1/);
assert.match(marketingGuard, /SHEIN_BI_MANUAL_LIMITED_DISCOUNT_REGISTRY=\/srv\/shein-bi\/runtime\/marketing_manual_limited_discount_overrides\.json/);
assert.doesNotMatch(marketingGuard, /SHEIN_BI_MARKETING_AUTOMATION_AUTHORIZATION=/, 'read-only inspection service must not receive write authorization');
assert.match(marketingGuard, /SHEIN_BI_MARKETING_LIVE_SCAN_TIMEOUT_SEC=900/);
assert.match(marketingGuard, /SHEIN_BI_MARKETING_PRICE_SESSION_CONCURRENCY=3/);
assert.doesNotMatch(marketingGuard, /SHEIN_BI_MARKETING_LIVE_LEASE_TTL_SEC=/);
assert.doesNotMatch(marketingGuardScript, /manage_browser_task_leases\.mjs|cleanup_shein_store_browsers/);
assert.doesNotMatch(marketingGuardScript, /batch_(?:fix_limited_discount_drift|apply_new_listing_limited_discount)\.mjs[^\n]*--execute/);
assert.doesNotMatch(marketingGuardScript, /batch_restore_manual_limited_discounts\.mjs[^\n]*--execute/);
assert.equal(property(marketingGuard, 'TimeoutStartSec'), '1800');

const marketingRepairTimer = readUnit('shein-bi-cloud-marketing-repair.timer');
const marketingRepairWindows = [...marketingRepairTimer.matchAll(/^OnCalendar=(.*)$/gm)].map(match => match[1].trim());
assert.deepEqual(marketingRepairWindows, ['*-*-* 20:45:00', '*-*-* 21:15:00']);
assert.equal(property(marketingRepairTimer, 'Persistent'), 'false');
const marketingRepair = readUnit('shein-bi-cloud-marketing-repair.service');
const marketingRepairScript = fs.readFileSync(new URL('./cloud_marketing_repair_worker.sh', import.meta.url), 'utf8');
assert.doesNotMatch(marketingRepair, /^ExecStart(?:Pre|Post)=.*cleanup_shein_store_browsers/m,
  'marketing repair must not stack unit-level cleanup around its lease-owned script cleanup');
assert.match(marketingRepair, /SHEIN_BI_MARKETING_REPAIR_MAX_GROUPS=1/);
assert.match(marketingRepair, /SHEIN_BI_MARKETING_REPAIR_EXECUTION_LOCATION=cloud/);
assert.match(marketingRepair, /SHEIN_BI_MARKETING_CLOUD_FALLBACK_ENABLED=true/);
assert.match(marketingRepair, /run_cloud_marketing_fallback_slot\.sh/);
assert.match(marketingRepair, /SHEIN_BI_MANUAL_LIMITED_DISCOUNT_REGISTRY=\/srv\/shein-bi\/runtime\/marketing_manual_limited_discount_overrides\.json/);
assert.match(marketingRepair, /SHEIN_BI_MARKETING_AUTOMATION_AUTHORIZATION=owner-standing-cloud-marketing-v1/);
assert.match(marketingRepairScript, /--max-groups "\$REMAINING_GROUPS"/);
assert.match(marketingRepairScript, /new_groups_in_result/);
assert.match(marketingRepairScript, /cap cloud repair batch groups=.* -> 1/);
assert.match(marketingRepairScript, /CURRENT_MINUTE >= 23 && CURRENT_MINUTE <= 42/);
assert.match(marketingRepairScript, /defer_remaining_work/);
assert.match(marketingRepairScript, /IS_CLOUD_EXECUTION=1/);
assert.match(marketingRepairScript, /EXECUTION_LOCATION.*== "local".*ROOT.*!= "\/opt\/shein-bi\/app"/);
assert.doesNotMatch(marketingRepairScript, /AUTOMATION_CONTEXT.*== "cloud_timer"/);
assert.match(marketingRepairScript, /SHEIN_BI_MARKETING_CLOUD_WRITE_GATE=bounded-repair-v1/);
assert.match(marketingRepairScript, /local execution already covered all authorized repairs/);
assert.equal(property(marketingRepair, 'TimeoutStartSec'), '2400');

const storageFeeTimer = readUnit('shein-bi-cloud-et-storage-fee.timer');
assert.equal(property(storageFeeTimer, 'OnCalendar'), '*-*-* 14:20:00 Asia/Shanghai');
assert.equal(property(storageFeeTimer, 'Persistent'), 'false');

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
  'shein-bi-cloud-morning-link-chunk-2.timer',
  'shein-bi-cloud-morning-link-recovery.timer',
  'shein-bi-cloud-morning-supplements.timer',
  'shein-bi-cloud-order-closure.timer',
  'shein-bi-cloud-session-manager.timer',
  'shein-bi-cloud-yesterday.timer',
  'shein-bi-db-backup.timer',
  'shein-bi-cloud-rtv-verify.timer',
  'shein-bi-daily-inventory-replenishment-guard-retry.timer',
]) {
  assert.equal(property(readUnit(timerName), 'Persistent'), 'false',
    `${timerName} must not replay at an arbitrary minute and collide with the reserved home lane`);
}

console.log(JSON.stringify({
  ok: true,
  checked: [
    'shein-bi-portal.service',
    'shein-bi-webhook.service',
    'shein-bi-lark-sales-qa.service',
    'three off-window lease-aware browser cleanup windows',
    'three retry-capable marketing guard windows',
    'bounded resumable marketing repair worker',
    'automation result delivery follows the existing Codex schedules',
    'daily canonical ET storage-fee sync',
    'persistent critical daily timers',
  ],
}, null, 2));
