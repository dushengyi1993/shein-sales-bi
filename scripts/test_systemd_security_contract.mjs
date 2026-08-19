#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
assert.equal(property(portal, 'Restart'), 'always');
assert.equal(property(portal, 'MemoryHigh'), '1200M');
assert.equal(property(portal, 'MemoryMax'), '2200M');
assert.doesNotMatch(portal, /SHEIN_BI_OPS_CLI_(?:MIN|RECOMMENDED)_VERSION=/,
  'Portal CLI version policy must follow the packaged BI_OPS_CLI_VERSION instead of a stale systemd override');
assert.match(portal, /^Environment=SHEIN_PARTNER_CLI_RELEASE_DIR=\/srv\/shein-bi\/partner-cli$/m,
  'Portal must remain the managed Partner CLI release writer');
const nodeOptions = [...portal.matchAll(/^Environment=NODE_OPTIONS=(.*)$/gm)];
assert.equal(nodeOptions.length, 1, 'Environment=NODE_OPTIONS must be declared exactly once');
assert.equal(nodeOptions[0][1], '--max-old-space-size=1536');
const v8HeapCapMb = Number(/--max-old-space-size=(\d+)/.exec(nodeOptions[0][1])[1]);
const memoryMaxMb = Number(property(portal, 'MemoryMax').replace(/M$/, ''));
assert.ok(Number.isInteger(v8HeapCapMb) && v8HeapCapMb > 0, 'V8 heap cap must be a positive integer of MiB');
assert.ok(memoryMaxMb > v8HeapCapMb, 'V8 heap cap must stay below the systemd MemoryMax cap so cgroup OOM recovery stays effective');
assertCommonHardening(portal, 'portal');
assert.doesNotMatch(portal, /^NoNewPrivileges=true$/m, 'portal uses audited sudo child commands and cannot enable this yet');
assert.doesNotMatch(portal, /^PrivateTmp=true$/m, 'portal browser maintenance must share the host temporary namespace');
assert.equal(property(portal, 'Requires'), 'shein-bi-session-secret.service');
assert.match(property(portal, 'After'), /(?:^|\s)shein-bi-session-secret\.service(?:\s|$)/);
assert.match(portal, /--session-secret-file \/data\/shein-bi\/state\/bi_portal_session_secret\.local/);
assert.equal(property(portal, 'KillMode'), 'control-group',
  'systemd must retain every OpenAPI executor descendant in the Portal cgroup during shutdown');
const portalTimeoutStopSec = Number(property(portal, 'TimeoutStopSec'));
const portalShutdownBudgetMatches = [...portal.matchAll(/^Environment=SHEIN_BI_PORTAL_SHUTDOWN_TIMEOUT_MS=(\d+)$/gm)];
const portalExecutorKillGraceMatches = [...portal.matchAll(/^Environment=SHEIN_LINK_OPS_OPENAPI_EXECUTOR_KILL_GRACE_MS=(\d+)$/gm)];
assert.equal(portalShutdownBudgetMatches.length, 1, 'Portal app shutdown budget must be declared exactly once');
assert.equal(portalExecutorKillGraceMatches.length, 1, 'executor kill grace must be declared exactly once');
const portalShutdownBudgetMs = Number(portalShutdownBudgetMatches[0][1]);
const portalExecutorKillGraceMs = Number(portalExecutorKillGraceMatches[0][1]);
assert.equal(portalTimeoutStopSec, 20);
assert.equal(portalShutdownBudgetMs, 12_000,
  'Portal must have an explicit bounded application shutdown budget');
assert.equal(portalExecutorKillGraceMs, 1_500,
  'OpenAPI executor cancellation must escalate from SIGTERM to SIGKILL within a bounded grace');
assert.ok(portalShutdownBudgetMs + 5_000 <= portalTimeoutStopSec * 1_000,
  'systemd TimeoutStopSec must retain at least five seconds of margin beyond the app shutdown budget');

const query = readUnit('shein-bi-query.service');
assert.equal(property(query, 'User'), 'sheinops');
assert.equal(property(query, 'Group'), 'sheinops');
assert.equal(property(query, 'OOMPolicy'), 'stop');
assert.equal(property(query, 'Restart'), 'always');
assert.equal(property(query, 'MemoryHigh'), '1024M');
assert.equal(property(query, 'MemoryMax'), '1400M');
assert.equal(property(query, 'NoNewPrivileges'), 'true');
assert.equal(property(query, 'PrivateTmp'), 'true');
assertCommonHardening(query, 'query runtime', {protectSystem: 'strict', umask: '0077'});
assert.equal(property(query, 'TasksMax'), '128');
assert.match(query, /^Environment=SHEIN_BI_SURFACE=query$/m);
assert.match(query, /^Environment=SHEIN_BI_QUERY_MAX_CONCURRENT=1$/m);
assert.match(query, /^Environment=SHEIN_BI_QUERY_MAX_QUEUED=3$/m);
assert.match(query, /^Environment=SHEIN_BI_QUERY_REQUEST_TIMEOUT_MS=120000$/m);
assert.match(query, /^Environment=SHEIN_BI_QUERY_GRACE_MS=30000$/m, 'the query unit must pin the bounded grace window for the fail-fast contract');
assert.match(query, /^Environment=SHEIN_PARTNER_CLI_RELEASE_DIR=\/srv\/shein-bi\/partner-cli$/m,
  'Query must read the same managed Partner CLI release store as Portal');

assert.match(query, /^Environment=NODE_OPTIONS=--max-old-space-size=1024$/m);
assert.match(query, /^ExecStart=.*--surface query --host 127\.0\.0\.1 --port 8791 /m);
assert.match(query, /--dir \/data\/shein-bi\/outputs\/bi-portal/);
assert.match(query, /--session-secret-file \/data\/shein-bi\/state\/bi_portal_session_secret\.local/);
assert.equal(property(query, 'Requires'), 'shein-bi-session-secret.service');
assert.match(property(query, 'After'), /(?:^|\s)shein-bi-session-secret\.service(?:\s|$)/);
assert.match(property(query, 'ReadOnlyPaths'), /(?:^|\s)\/data\/shein-bi\/state(?:\s|$)/,
  'query runtime must retain read-only access to the shared state namespace');
assert.match(property(query, 'ReadOnlyPaths'), /(?:^|\s)\/srv\/shein-bi\/partner-cli(?:\s|$)/,
  'Query must see the Partner CLI release store read-only');
assert.match(query, /^InaccessiblePaths=\/data\/shein-bi\/profiles \/opt\/shein-bi\/app\/profiles$/m);
assert.doesNotMatch(query, /SHEIN_BI_JOB_WORKER_ENABLED=1|SHEIN_WEBHOOK_REPOSITORY_ENABLED=1|SHEIN_BI_EXTERNAL_SECTION_QUEUE_ENABLED=1/);
assert.doesNotMatch(query, /^ExecCondition=/m, 'query is an always-available read surface, not a scheduled maintenance participant');
assert.ok(Number(property(query, 'MemoryMax').replace(/M$/, '')) > 1024,
  'query cgroup MemoryMax must retain non-heap headroom for large bounded JSON responses');

const sessionSecret = readUnit('shein-bi-session-secret.service');
assert.equal(property(sessionSecret, 'Type'), 'oneshot');
assert.equal(property(sessionSecret, 'User'), 'sheinops');
assert.equal(property(sessionSecret, 'Group'), 'sheinops');
assert.equal(property(sessionSecret, 'RemainAfterExit'), 'yes');
assert.equal(property(sessionSecret, 'NoNewPrivileges'), 'true');
assert.equal(property(sessionSecret, 'PrivateTmp'), 'true');
assertCommonHardening(sessionSecret, 'session secret provisioner', {protectSystem: 'strict', umask: '0077'});
assert.equal(
  property(sessionSecret, 'ExecStart'),
  '/usr/bin/node scripts/provision_bi_session_secret.mjs --file /data/shein-bi/state/bi_portal_session_secret.local',
);
assert.equal(property(sessionSecret, 'ReadWritePaths'), '/data/shein-bi/state');
assert.doesNotMatch(sessionSecret, /^ExecCondition=/m,
  'session secret provisioning is an always-available auth prerequisite');
assert.equal(property(sessionSecret, 'Before'), 'shein-bi-portal.service shein-bi-query.service');
assert.doesNotMatch(property(sessionSecret, 'After'), /shein-bi-(?:portal|query)\.service/,
  'the provisioning owner must not depend on either consumer');
assert.doesNotMatch(sessionSecret, /^Requires=.*shein-bi-(?:portal|query)\.service/m,
  'the provisioning owner must not introduce a dependency cycle');
const sessionProvisionOwners = fs.readdirSync(new URL('../infra/systemd/', import.meta.url))
  .filter(name => name.endsWith('.service'))
  .filter(name => readUnit(name).includes('scripts/provision_bi_session_secret.mjs'));
assert.deepEqual(sessionProvisionOwners, ['shein-bi-session-secret.service'],
  'the oneshot unit must be the only systemd writer for the BI session secret');

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
const sessionManagerTimer = readUnit('shein-bi-cloud-session-manager.timer');
const sessionManagerCoordinator = fs.readFileSync(new URL('./run_cloud_session_manager_job.sh', import.meta.url), 'utf8');
assert.equal(property(sessionManager, 'User'), 'sheinops');
assert.equal(property(sessionManager, 'Group'), 'sheinops');
assert.equal(property(sessionManager, 'UMask'), '0077', 'session manager persists browser credentials and must create private files');
assertCommonHardening(sessionManager, 'session manager', {allowAuditedSudo: true, umask: '0077'});
assert.match(sessionManager, /SHEIN_BI_NIGHTLY_MAINTENANCE_LOCK_FILE=\/opt\/shein-bi\/app\/state\/locks\/shein-bi-nightly-maintenance\.lock/);
assert.match(sessionManager, /SHEIN_BI_SESSION_MANAGER_RETRY_MAX=0/,
  'session-manager retry-max must default to unlimited (the 01:27 deadline is the only boundary)');
assert.match(sessionManager, /run_cloud_session_manager_job\.sh/,
  'session manager must own one bounded coordinator run');
assert.match(sessionManager, /--deadline-at 01:27/);
assert.doesNotMatch(sessionManager, /--deadline-epoch/,
  'the normal 00:45 unit must retain only its wall-clock deadline');
assert.match(sessionManager, /--stage nightly-session/);
assert.match(sessionManager, /flock -w 120/);
assert.doesNotMatch(sessionManager, /^SuccessExitStatus=75$/m,
  'terminal resource deferral must remain a real unit failure');
assert.equal(property(sessionManagerTimer, 'Persistent'), 'true');
assert.equal(property(sessionManagerTimer, 'OnCalendar'), '*-*-* 00:45:00');
assert.match(sessionManagerCoordinator, /LANE_DEADLINE_ARGS=\(--deadline-at "\$DEADLINE_AT"\)/);
assert.match(sessionManagerCoordinator, /LANE_DEADLINE_ARGS=\(--deadline-epoch "\$DEADLINE_EPOCH"\)/,
  'an explicit epoch must replace the stale 01:27 lane argument');
assert.match(sessionManagerCoordinator, /--check-only\)/,
  'the coordinator must expose a read-only strong-evidence check for the morning gate');
assert.match(sessionManagerCoordinator, /nightly_session_completed\(\)/,
  'only the coordinator owns the strong marker+report completion predicate');
assert.match(sessionManagerCoordinator, /completion_evidence_missing/,
  'inner exit 0 without strong evidence must fail closed');
assert.match(sessionManagerCoordinator, /RETRY_MAX="\$\{SHEIN_BI_SESSION_MANAGER_RETRY_MAX:-0\}"/,
  'the coordinator default retry-max must be unlimited');
assert.match(property(sessionManager, 'Before'), /shein-bi-db-backup\.service/);
assert.match(property(sessionManager, 'Before'), /shein-bi-cloud-yesterday\.service/);

const dbBackup = readUnit('shein-bi-db-backup.service');
const remoteVerifierLauncherPath = 'scripts/verify_cos_backup_remote.sh';
const remoteVerifierLauncher = fs.readFileSync(new URL(`../${remoteVerifierLauncherPath}`, import.meta.url), 'utf8');
const systemdReadme = fs.readFileSync(new URL('../infra/systemd/README.md', import.meta.url), 'utf8');
assert.equal(property(dbBackup, 'User'), 'root');
assert.equal(property(dbBackup, 'Group'), 'sheinops');
assert.equal(property(dbBackup, 'UMask'), '0027');
assert.equal(property(dbBackup, 'NoNewPrivileges'), 'true');
assert.equal(property(dbBackup, 'PrivateTmp'), 'true');
assertCommonHardening(dbBackup, 'db backup');
assert.match(dbBackup, /SHEIN_BI_NIGHTLY_MAINTENANCE_LOCK_FILE=\/opt\/shein-bi\/app\/state\/locks\/shein-bi-nightly-maintenance\.lock/);
assert.match(dbBackup, /SHEIN_BI_BROWSER_STATE_BACKUP_ENABLED=0/);
assert.match(dbBackup, /SHEIN_BI_BROWSER_STATE_BACKUP_KEY_FILE=\/srv\/shein-bi\/secrets\/browser-state-backup\.key/);
assert.match(dbBackup, /SHEIN_BI_BROWSER_PROFILE_ROOT=\/data\/shein-bi\/profiles/);
assert.match(dbBackup, /SHEIN_BI_BROWSER_SESSION_ROOT=\/data\/shein-bi\/state\/shein_webapi_sessions/);
assert.match(dbBackup, /--deadline-at 02:37/,
  'the 01:45 database backup needs a real window while retaining an eight-minute handoff before 02:45 yesterday-final');
assert.match(dbBackup, /--stage nightly-backup --require nightly-session/);
assert.match(dbBackup, /flock -w 120/);
assert.equal(property(dbBackup, 'TimeoutStartSec'), '10800',
  'backup timeout must cover the longest lock wait plus the backup execution budget');
assert.match(dbBackup, /^Wants=.*network-online\.target/m, 'backup must order network-online before the COS verifier runs');
assert.match(property(dbBackup, 'After'), /network-online\.target/, 'network-online.target must be an After dependency');
assert.match(dbBackup, /Environment=SHEIN_BI_REMOTE_VERIFY_CMD=\/opt\/shein-bi\/app\/scripts\/verify_cos_backup_remote\.sh/,
  'the production unit must wire the repository verifier launcher');
assert.match(dbBackup, /^Environment=SHEIN_BI_COS_VERIFY_AUTH_MODE=anonymous-public$/m,
  'the public COS mount must use the explicit no-secret verifier mode');
assert.equal((dbBackup.match(/^LoadCredential=/gm) || []).length, 2,
  'anonymous verification needs exactly the locked target and its hash');
assert.doesNotMatch(dbBackup, /^LoadCredential=shein-bi-cos-verify-secret:.*$/m, 'anonymous mode must not require a nonexistent signing secret');
assert.match(dbBackup, /^LoadCredential=shein-bi-cos-verify-target:.*$/m, 'verifier target credential is injected by systemd');
assert.match(dbBackup, /^LoadCredential=shein-bi-cos-verify-target-sha:.*$/m, 'verifier target SHA lock credential is injected by systemd');
assert.doesNotMatch(dbBackup, /^Environment=.*SHEIN_BI_COS_VERIFY_(SECRET|TARGET)/m,
  'credential values and paths must never enter the unit environment');
assert.doesNotMatch(dbBackup, /^Environment=.*(SECRET|TOKEN|KEY)=.*/i,
  'no secret-looking Environment assignment may exist in the backup unit');
assert.match(dbBackup, /ExecStartPre=.*verify_cos_backup_remote\.sh --check-config/,
  'the unit must preflight the verifier credentials before starting the backup');
assert.match(remoteVerifierLauncher, /^#!\/usr\/bin\/env bash\r?$/m,
  'the directly executed COS verifier launcher must have a valid bash shebang');
assert.match(remoteVerifierLauncher, /^exec node "\$VERIFIER" "\$@"\r?$/m,
  'the COS verifier launcher must replace itself with the bounded Node verifier');
assert.match(systemdReadme, /^chmod \+x .*scripts\/verify_cos_backup_remote\.sh\r?$/m,
  'the production install checklist must preserve launcher executable permission');
assert.match(systemdReadme, /^systemd-analyze verify .*\/shein-bi-db-backup\.service\r?$/m,
  'the production parser check must cover the modified database backup service');
assert.doesNotMatch(dbBackup, /^Environment=\TrueSHEIN_BI_COS_VERIFY_(SECRET|TARGET)/i,
  'the launcher resolves credential paths, never Environment values');
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
assert.equal(
  property(dataDiskGuard, 'RequiresMountsFor'),
  '/data/shein-bi/profiles /data/shein-bi/state /data/shein-bi/outputs /srv/shein-bi/runtime /srv/shein-bi/backups',
);
assert.equal(property(dataDiskGuard, 'After'), 'local-fs.target');

const marketingGuardTimer = readUnit('shein-bi-cloud-marketing-live-guard.timer');
const marketingWindows = [...marketingGuardTimer.matchAll(/^OnCalendar=(.*)$/gm)].map(match => match[1].trim());
assert.deepEqual(marketingWindows, ['*-*-* 11:00:00']);
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
assert.match(marketingGuard, /SHEIN_BI_MARKETING_STAGE_ATTEMPTS=3/);
assert.match(marketingGuard, /SHEIN_BI_MARKETING_STAGE_RETRY_DELAY_SEC=30/);
assert.doesNotMatch(marketingGuard, /SHEIN_BI_MARKETING_LIVE_LEASE_TTL_SEC=/);
assert.doesNotMatch(marketingGuardScript, /manage_browser_task_leases\.mjs|cleanup_shein_store_browsers/);
assert.doesNotMatch(marketingGuardScript, /batch_(?:fix_limited_discount_drift|apply_new_listing_limited_discount)\.mjs[^\n]*--execute/);
assert.doesNotMatch(marketingGuardScript, /batch_restore_manual_limited_discounts\.mjs[^\n]*--execute/);
assert.match(marketingGuardScript, /run_stage_with_retry/);
assert.match(marketingGuardScript, /final group report waits for the same-day repair queue terminal state/);
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
assert.match(marketingRepairScript, /the final report waits for local execution and terminal readback/);
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

const morningTimer = readUnit('shein-bi-cloud-morning-chain.timer');
const morningService = readUnit('shein-bi-cloud-morning-chain.service');
const morningScript = fs.readFileSync(new URL('./cloud_morning_chain.sh', import.meta.url), 'utf8');
const morningWrapper = fs.readFileSync(new URL('./run_cloud_morning_chain_job.sh', import.meta.url), 'utf8');
assert.equal(property(morningTimer, 'Persistent'), 'true');
assert.equal(property(morningTimer, 'OnCalendar'), '*-*-* 07:10:00',
  'the morning chain keeps exactly one daily window');
assert.match(morningService, /SHEIN_BI_MORNING_CATCHUP_MIN_UPTIME_SEC=600/);
assert.match(morningService, /run_cloud_morning_chain_job\.sh/,
  'ExecStart must point at the resume-aware wrapper');
assert.equal(property(morningService, 'Restart'), 'on-failure',
  'a failed/interrupted morning run must auto-restart the same service');
assert.equal(property(morningService, 'RestartSec'), '60',
  'the restart backoff keeps a rolling failure far from the StartLimit window');
assert.equal(property(morningService, 'RestartPreventExitStatus'), '64 76 78',
  'terminal/data/config failures stay visible without an infinite restart loop');
assert.equal(property(morningService, 'StartLimitIntervalSec'), '900');
assert.equal(property(morningService, 'StartLimitBurst'), '200',
  'one-minute retries must remain possible across the full three-hour window');
assert.match(morningService, /SHEIN_BI_MORNING_INVENTORY_RESERVE_SEC=2700/,
  'the production unit reserves the bounded stock-refresh plus inventory window');
assert.doesNotMatch(morningService, /^SuccessExitStatus=.*75$/m,
  'the morning chain must surface real failures, never mask them');
assert.match(morningScript, /daily_operating_refresh_done/);
assert.match(morningScript, /wait_for_catchup_startup_window/);
assert.match(morningScript, /catch-up is yielding to the full-managed priority run/);
assert.ok(
  morningScript.indexOf("NODE\n}\n\nactive_full_managed_priority_services()") >= 0,
  'catch-up shell functions must be declared after the pipeline-marker Node heredoc closes',
);
assert.match(morningScript, /SHEIN_BI_MORNING_RUN_DATE/,
  'the chain must honor the wrapper-injected immutable run date');
assert.match(morningScript, /SHEIN_BI_MORNING_BUSINESS_DATE/,
  'the chain must honor the wrapper-injected immutable business date');
assert.match(morningWrapper, /state\/cloud_morning_chain\/active\.json/,
  'the wrapper persists the active run context under state/cloud_morning_chain');
assert.match(morningWrapper, /validate_daily_operating_refresh\.mjs/,
  'the wrapper verifies the exact semantic completion bundle');
assert.match(morningWrapper, /mode: 0o660/,
  'the persisted context must be mode 0660');
assert.match(morningWrapper, /exit 0/,
  'a completed idempotent skip must exit 0 so Restart can never loop');

// The modified auth units, backup service, and the two unit/timer pairs must
// pass systemd-analyze verify when the tool is available. Production keeps the
// fixed /usr/bin/node path; a clean CI runner whose setup-node runtime lives in
// the toolcache verifies an otherwise byte-identical temporary unit fixture.
// The static contracts above remain authoritative for the production path.
const spawnSync = (await import('node:child_process')).spawnSync;
const launcherStage = spawnSync('git', ['ls-files', '--stage', '--', remoteVerifierLauncherPath], {
  cwd: new URL('..', import.meta.url),
  encoding: 'utf8',
  timeout: 10_000,
});
assert.equal(launcherStage.status, 0,
  `git must report the COS verifier launcher mode: ${launcherStage.stderr || launcherStage.error?.message || ''}`);
assert.match(launcherStage.stdout.trim(), /^100755 [0-9a-f]{40} 0\tscripts\/verify_cos_backup_remote\.sh$/,
  'the systemd-executed COS verifier launcher must be committed with Git mode 100755');
const systemdAnalyze = process.platform === 'win32'
  ? null
  : spawnSync('bash', ['-lc', 'command -v systemd-analyze && systemd-analyze --version'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
if (systemdAnalyze?.status === 0) {
  const unitNames = [
    'shein-bi-session-secret.service',
    'shein-bi-portal.service',
    'shein-bi-query.service',
    'shein-bi-cloud-morning-chain.service',
    'shein-bi-cloud-morning-chain.timer',
    'shein-bi-cloud-session-manager.service',
    'shein-bi-cloud-session-manager.timer',
    'shein-bi-db-backup.service',
  ];
  let fixtureRoot = null;
  try {
    let units = unitNames.map(name => `infra/systemd/${name}`);
    if (!fs.existsSync('/usr/bin/node')) {
      assert.ok(fs.existsSync(process.execPath), 'the setup-node runtime used by the systemd fixture must exist');
      fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shein-systemd-verify-'));
      units = unitNames.map((name) => {
        const target = path.join(fixtureRoot, name);
        fs.writeFileSync(target, readUnit(name).replaceAll('/usr/bin/node', process.execPath), 'utf8');
        return target;
      });
    }
    const verify = spawnSync('systemd-analyze', ['verify', '--man=no', ...units], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(verify.status, 0,
      `systemd-analyze verify must pass for modified units\nstdout:\n${verify.stdout}\nstderr:\n${verify.stderr}`);
    console.log('PASS systemd-analyze verify modified auth units, backup service, and service/timer pairs');
  } finally {
    if (fixtureRoot) fs.rmSync(fixtureRoot, {recursive: true, force: true});
  }
} else {
  console.log('SKIP systemd-analyze verify (not available on this host)');
}

for (const timerName of [
  'shein-bi-cloud-order-closure.timer',
  'shein-bi-cloud-yesterday.timer',
  'shein-bi-db-backup.timer',
  'shein-bi-cloud-rtv-verify.timer',
]) {
  assert.equal(property(readUnit(timerName), 'Persistent'), 'false',
    `${timerName} must not replay at an arbitrary minute and collide with the reserved home lane`);
}

console.log(JSON.stringify({
  ok: true,
  checked: [
    'shein-bi-portal.service',
    'shein-bi-query.service',
    'shein-bi-session-secret.service',
    'shein-bi-webhook.service',
    'shein-bi-lark-sales-qa.service',
    'three off-window lease-aware browser cleanup windows',
    'one retry-capable daily marketing guard coordinator',
    'bounded resumable marketing repair worker',
    'automation result delivery follows the existing Codex schedules',
    'daily canonical ET storage-fee sync',
    'persistent critical daily timers',
  ],
}, null, 2));
