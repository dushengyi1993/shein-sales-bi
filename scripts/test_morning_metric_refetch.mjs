#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const date = '2026-08-21';
const stores = ['CX','DL','DX','FY','HL','JSH','JY','LQ','MZ','NM','QH','QY','TS','TZ','TZZ','XC','XL','YJ','ZL'];
const write = (file, value) => { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, value); };
const writeJson = (file, value) => write(file, `${JSON.stringify(value, null, 2)}\n`);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const nodeStub = body => `#!/usr/bin/env node\n${body}\n`;
const toWslPath = value => String(value)
  .replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`)
  .replaceAll('\\', '/');

async function setupRoot(mode) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'shein-metric-refetch-'));
  await fsp.mkdir(path.join(root, 'scripts', 'lib'), {recursive: true});
  await fsp.mkdir(path.join(root, 'scripts', 'marketing'), {recursive: true});
  await fsp.mkdir(path.join(root, 'state', 'locks'), {recursive: true});
  await fsp.mkdir(path.join(root, 'state', 'cloud_ops_alerts'), {recursive: true});
  await fsp.mkdir(path.join(root, 'outputs', 'bi-portal'), {recursive: true});
  await fsp.copyFile(path.join(repo, 'scripts', 'cloud_link_business_sync.sh'), path.join(root, 'scripts', 'cloud_link_business_sync.sh'));
  await fsp.copyFile(path.join(repo, 'scripts', 'cloud_daily_refresh.sh'), path.join(root, 'scripts', 'cloud_daily_refresh.sh'));
  write(path.join(root, 'scripts', 'lib', 'shared_lock.sh'), `#!/usr/bin/env bash
prepare_shared_lock_file() {
  mkdir -p "$(dirname -- "$1")"
  touch -- "$1"
  chmod 660 -- "$1" 2>/dev/null || true
}
`);
  await fsp.chmod(path.join(root, 'scripts', 'cloud_link_business_sync.sh'), 0o755);
  await fsp.chmod(path.join(root, 'scripts', 'cloud_daily_refresh.sh'), 0o755);
  writeJson(path.join(root, 'config', 'stores.json'), {stores: stores.map(storeKey => ({storeKey, enabled: true}))});
  write(path.join(root, 'outputs', 'bi-portal', 'index.html'), '<!doctype html>');
  write(path.join(root, 'outputs', 'bi-portal', 'data.json'), '{}\n');

  const modeFile = path.join(root, 'metric-mode.txt');
  const metricLog = path.join(root, 'metric-fetch.log');
  const businessLog = path.join(root, 'business-fetch.log');
  const publishLog = path.join(root, 'publish.log');
  write(modeFile, `${mode}\n`);
  write(path.join(root, 'scripts', 'manage_browser_task_leases.mjs'), nodeStub('process.exit(0);'));
  write(path.join(root, 'scripts', 'cleanup_shein_store_browsers.mjs'), nodeStub('process.exit(0);'));
  write(path.join(root, 'scripts', 'restore_shein_store_session.mjs'), nodeStub(`
import fs from 'node:fs';
const store = process.argv[process.argv.indexOf('--store') + 1];
fs.appendFileSync(process.env.METRIC_CALL_LOG, 'restore:' + store + '\\n');
`));
  write(path.join(root, 'scripts', 'fetch_shein_links.mjs'), nodeStub(`
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const storesArg = args[args.indexOf('--stores') + 1] || '';
const date = args[args.indexOf('--date') + 1];
const outDir = args[args.indexOf('--out-dir') + 1];
const mode = fs.readFileSync(process.env.METRIC_MODE_FILE, 'utf8').trim();
for (const store of storesArg.split(',').filter(Boolean)) {
  const sourceReady = ['ready', 'publish-fail', 'missing-field', 'strict-invalid'].includes(mode)
    || (mode === 'one-ready' && store === 'CX');
  const row = {epsUv: 0, goodsUv: 0, saleCnt: 0, payOrderCnt: 0};
  if (mode === 'missing-field' && store === 'CX') delete row.goodsUv;
  if (mode === 'missing-field' && store === 'DL') row.saleCnt = null;
  if (mode === 'missing-field' && store === 'DX') row.payOrderCnt = 'unavailable';
  if (mode === 'strict-invalid' && store === 'CX') row.epsUv = '   ';
  if (mode === 'strict-invalid' && store === 'DL') row.goodsUv = [];
  const performanceRows = sourceReady ? [row] : [];
  const file = path.join(outDir, store, date + '.json');
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify({
    ok: true, date, fetchTime: new Date().toISOString(), store: {storeKey: store},
    counts: {diagnoseDay: sourceReady ? 1 : 0, performanceRows: performanceRows.length},
    performanceRows,
  }, null, 2) + '\\n');
  fs.appendFileSync(process.env.METRIC_CALL_LOG, store + '\\n');
}
`));
  write(path.join(root, 'scripts', 'fetch_shein_business_domains.mjs'), nodeStub(`
import fs from 'node:fs';
fs.appendFileSync(process.env.BUSINESS_CALL_LOG, 'business-domain-fetch\\n');
process.exit(97);
`));
  write(path.join(root, 'scripts', 'run_host_browser_read_job.sh'), `#!/usr/bin/env bash
set -euo pipefail
while (($#)); do
  case "$1" in
    --) shift; break ;;
    --domain|--lock-wait-sec|--defer-state|--defer-reason|--deadline-epoch) shift 2 ;;
    *) echo "unexpected arg=$1" >&2; exit 64 ;;
  esac
done
exec "$@"
`);
  await fsp.chmod(path.join(root, 'scripts', 'run_host_browser_read_job.sh'), 0o755);
  for (const file of ['generate_link_ops_web_dashboard.mjs', 'load_bi_warehouse.mjs', 'load_bi_business_domains.mjs']) {
    write(path.join(root, 'scripts', file), nodeStub(`
import fs from 'node:fs';
fs.appendFileSync(process.env.PUBLISH_LOG, '${file}\\n');
if (process.env.FAIL_PUBLISH_STEP === '${file}') process.exit(86);
`));
  }
  write(path.join(root, 'scripts', 'marketing', 'export_marketing_price_leads_for_bi.mjs'), nodeStub(`
import fs from 'node:fs';
fs.appendFileSync(process.env.PUBLISH_LOG, 'marketing-export\\n');
if (process.env.FAIL_PUBLISH_STEP === 'marketing-export') process.exit(86);
`));
  write(path.join(root, 'scripts', 'refresh_inventory_cost_ledger.sh'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\${SHEIN_INVENTORY_COST_LOGICAL_RUN_KEY:-}" >> "$COST_LEDGER_LOG"
`);
  write(path.join(root, 'scripts', 'refresh_profit_marts.sh'), '#!/usr/bin/env bash\nexit 0\n');
  write(path.join(root, 'scripts', 'audit_bi_warehouse.mjs'), nodeStub('process.exit(0);'));
  write(path.join(root, 'scripts', 'generate_bi_portal.mjs'), nodeStub(`
import fs from 'node:fs'; import path from 'node:path';
const args = process.argv.slice(2);
const value = name => args.includes(name) ? args[args.indexOf(name) + 1] : '';
const runKey = value('--source-run-key'); const fingerprint = value('--input-fingerprint');
fs.appendFileSync(process.env.PORTAL_CORE_LOG, runKey + '|' + fingerprint + '\\n');
const generatedAt = '2026-08-22T07:31:22.123456+08:00';
const file = path.join(process.env.SHEIN_BI_ROOT, 'outputs', 'bi-portal', 'data.json');
fs.writeFileSync(file, JSON.stringify({generatedAt, __sections: {generatedAt}, sourceCommit: {
  status: 'terminal', sourceRunKey: runKey, inputFingerprint: fingerprint, generatedAt,
}}, null, 2) + '\\n');
`));
  write(path.join(root, 'scripts', 'generate_bi_portal_shell.mjs'), nodeStub('process.exit(0);'));
  write(path.join(root, 'scripts', 'prewarm_bi_portal_sections.sh'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s|%s\n' "\${SHEIN_BI_PORTAL_PREWARM_SECTIONS:-}" "\${SHEIN_BI_PORTAL_PREWARM_REFRESH_TOKEN:-}" >> "$PREWARM_LOG"
if [[ "\${SHEIN_BI_PORTAL_PREWARM_SECTIONS:-}" == "linksData" && -n "\${PREWARM_FAIL_ONCE_FILE:-}" && ! -e "$PREWARM_FAIL_ONCE_FILE" ]]; then
  touch "$PREWARM_FAIL_ONCE_FILE"
  exit 83
fi
`);
  write(path.join(root, 'scripts', 'enqueue_bi_portal_sections.sh'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$QUEUE_LOG"
`);
  for (const file of ['refresh_inventory_cost_ledger.sh', 'refresh_profit_marts.sh', 'prewarm_bi_portal_sections.sh', 'enqueue_bi_portal_sections.sh']) {
    await fsp.chmod(path.join(root, 'scripts', file), 0o755);
  }

  for (const store of stores) {
    writeJson(path.join(root, 'outputs', 'shein_links', store, `${date}.json`), {
      ok: true, date, store: {storeKey: store}, counts: {diagnoseDay: 0, performanceRows: 0},
      performanceRows: [],
    });
    writeJson(path.join(root, 'outputs', 'shein_business_domains', store, `${date}.json`), {ok: true, date, store: {storeKey: store}});
  }
  return {
    root, modeFile, metricLog, businessLog, publishLog,
    costLedgerLog: path.join(root, 'cost-ledger.log'), portalCoreLog: path.join(root, 'portal-core.log'),
    prewarmLog: path.join(root, 'prewarm.log'), queueLog: path.join(root, 'queue.log'),
    prewarmFailOnceFile: path.join(root, 'prewarm-failed-once'),
  };
}

function runSync(env) {
  const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  const vars = {
    SHEIN_BI_ROOT: toWslPath(env.root),
    SHEIN_BI_LOG_DIR: toWslPath(path.join(env.root, 'logs')),
    SHEIN_BI_SHARED_LOCK_GROUP: '__missing_test_group__',
    SHEIN_LINK_BUSINESS_FINALIZE_ONLY: '1',
    SHEIN_LINK_BUSINESS_REFRESH_PORTAL: '0',
    SHEIN_LINK_BUSINESS_METRIC_REFETCH_ON_NOT_READY: '1',
    SHEIN_LINK_BUSINESS_METRIC_REFETCH_RUN_KEY: 'test-run',
    SHEIN_LINK_BUSINESS_METRIC_REFETCH_RETRY_SLEEP_SEC: String(env.sleep ?? 0),
    SHEIN_LINK_BUSINESS_METRIC_REFETCH_MAX_ATTEMPTS: String(env.maxAttempts ?? 2),
    SHEIN_LINK_BUSINESS_PER_STORE_BROWSER_WRAPPER: '1',
    SHEIN_LINK_BUSINESS_RUN_ID: 'metric-refetch-test',
    SHEIN_LINK_BUSINESS_RUN_LOCK_WAIT_SEC: '2',
    SHEIN_LINK_BUSINESS_PARTIAL_LOCK_WAIT_SEC: '2',
    METRIC_MODE_FILE: toWslPath(env.modeFile),
    METRIC_CALL_LOG: toWslPath(env.metricLog),
    BUSINESS_CALL_LOG: toWslPath(env.businessLog),
    PUBLISH_LOG: toWslPath(env.publishLog),
    FAIL_PUBLISH_STEP: String(env.failPublishStep || ''),
    SHEIN_LINK_BUSINESS_TEST_CRASH_AFTER_PHASE: String(env.crashAfterPhase || ''),
    SHEIN_LINK_BUSINESS_TEST_COMMIT_FAIL_AFTER: env.commitFailAfter === undefined ? '' : String(env.commitFailAfter),
    SHEIN_LINK_BUSINESS_TEST_REMOVE_BACKUP_STORE: String(env.removeBackupStore || ''),
    SHEIN_LINK_BUSINESS_TEST_ROLLBACK_FAIL_STORE: String(env.rollbackFailStore || ''),
    SHEIN_LINK_BUSINESS_METRIC_REFETCH_DEADLINE_EPOCH: String(env.deadline),
  };
  const command = Object.entries(vars).map(([key, value]) => `export ${key}=${quote(value)}`).join('; ')
    + `; cd ${quote(toWslPath(env.root))}; bash scripts/cloud_link_business_sync.sh ${quote(date)}`;
  return spawnSync('bash', ['-s'], {
    cwd: repo, input: `${command}\n`, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    env: process.env,
  });
}

function runDailySync(env) {
  const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  const root = toWslPath(env.root);
  const vars = {
    SHEIN_BI_ROOT: root,
    SHEIN_BI_DAILY_LOG_DIR: toWslPath(path.join(env.root, 'daily-logs')),
    SHEIN_BI_LOG_DIR: toWslPath(path.join(env.root, 'link-logs')),
    SHEIN_BI_SHARED_LOCK_GROUP: '__missing_test_group__',
    SHEIN_BI_DAILY_LOCK_FILE: toWslPath(path.join(env.root, 'state', 'locks', 'daily.lock')),
    SHEIN_LARK_REPORT_LOCK_FILE: toWslPath(path.join(env.root, 'state', 'locks', 'lark.lock')),
    SHEIN_BI_PORTAL_REFRESH_LOCK_FILE: toWslPath(path.join(env.root, 'state', 'locks', 'portal.lock')),
    SHEIN_BI_DAILY_WAIT_SERVICES: '',
    SHEIN_BI_DAILY_MIN_AVAILABLE_MEM_MIB: '1',
    SHEIN_BI_DAILY_LINK_BUSINESS_MODE: 'finalize',
    SHEIN_BI_DAILY_REQUIRE_COMPLETE_LINK_BUSINESS: '1',
    SHEIN_BI_DAILY_REQUIRE_CRITICAL_PORTAL_SECTIONS: '0',
    SHEIN_BI_DAILY_CRITICAL_PORTAL_PREWARM: 'queue',
    SHEIN_BI_DAILY_METRIC_REFETCH_ON_NOT_READY: '1',
    SHEIN_BI_DAILY_REFRESH_DEADLINE_EPOCH: String(Math.floor(Date.now() / 1000) + 90),
    SHEIN_BI_DAILY_REFRESH_RUN_KEY: 'test-run',
    SHEIN_BI_DAILY_METRIC_REFETCH_BROWSER_WRAPPER: '1',
    SHEIN_BI_DAILY_RTV_VERIFY: '0',
    SHEIN_BI_DAILY_OPENAPI_RECONCILIATION: '0',
    SHEIN_BI_DAILY_OPENAPI_RETURN_RECONCILIATION: '0',
    SHEIN_BI_DAILY_OPENAPI_FINANCE_SYNC: '0',
    SHEIN_BI_DAILY_OPENAPI_PRODUCT_RECONCILIATION: '0',
    SHEIN_BI_PROFIT_MART_REFRESH_DISABLED: '1',
    SHEIN_BI_PORTAL_PREWARM_DISABLED: '0',
    SHEIN_BI_PORTAL_DATA_MODE: 'api',
    SHEIN_LINK_BUSINESS_METRIC_REFETCH_RETRY_SLEEP_SEC: '0',
    SHEIN_LINK_BUSINESS_METRIC_REFETCH_MAX_ATTEMPTS: '1',
    SHEIN_LINK_BUSINESS_RUN_LOCK_WAIT_SEC: '2',
    SHEIN_LINK_BUSINESS_PARTIAL_LOCK_WAIT_SEC: '2',
    METRIC_MODE_FILE: toWslPath(env.modeFile),
    METRIC_CALL_LOG: toWslPath(env.metricLog),
    BUSINESS_CALL_LOG: toWslPath(env.businessLog),
    PUBLISH_LOG: toWslPath(env.publishLog),
    FAIL_PUBLISH_STEP: '',
    COST_LEDGER_LOG: toWslPath(env.costLedgerLog),
    PORTAL_CORE_LOG: toWslPath(env.portalCoreLog),
    PREWARM_LOG: toWslPath(env.prewarmLog),
    PREWARM_FAIL_ONCE_FILE: toWslPath(env.prewarmFailOnceFile),
    QUEUE_LOG: toWslPath(env.queueLog),
  };
  const command = Object.entries(vars).map(([key, value]) => `export ${key}=${quote(value)}`).join('; ')
    + `; cd ${quote(root)}; bash scripts/cloud_daily_refresh.sh ${quote(date)}`;
  return spawnSync('bash', ['-s'], {
    cwd: repo, input: `${command}\n`, encoding: 'utf8', timeout: 90_000, maxBuffer: 32 * 1024 * 1024,
    env: process.env,
  });
}

const combined = result => `${result.stdout || ''}\n${result.stderr || ''}`;
assert.equal(spawnSync('bash', ['-n', 'scripts/cloud_link_business_sync.sh'], {cwd: repo}).status, 0);
assert.match(fs.readFileSync(path.join(repo, 'scripts', 'cloud_morning_chain.sh'), 'utf8'), /SHEIN_BI_DAILY_REFRESH_DEADLINE_EPOCH/);
assert.match(fs.readFileSync(path.join(repo, 'scripts', 'cloud_daily_refresh.sh'), 'utf8'), /SHEIN_LINK_BUSINESS_METRIC_REFETCH_ON_NOT_READY/);

const roots = [];
try {
  const onlyDaily = process.env.SHEIN_MORNING_REFETCH_TEST_ONLY === 'daily';
  if (!onlyDaily) {
  const ready = await setupRoot('ready');
  roots.push(ready.root);
  const before = new Map(stores.map(store => [store, hash(path.join(ready.root, 'outputs', 'shein_links', store, `${date}.json`))]));
  const readyResult = runSync({...ready, deadline: Math.floor(Date.now() / 1000) + 60});
  assert.equal(readyResult.status, 0, `ready refetch failed\n${combined(readyResult)}`);
  assert.equal(fs.readFileSync(ready.metricLog, 'utf8').trim().split(/\s+/).length, stores.length * 2, 'one restore + one metrics fetch per store');
  assert.equal(fs.existsSync(ready.businessLog), false, 'completed business-domain fetch was repeated');
  assert.deepEqual(fs.readFileSync(ready.publishLog, 'utf8').trim().split(/\s+/).sort(), [
    'generate_link_ops_web_dashboard.mjs', 'load_bi_business_domains.mjs', 'load_bi_warehouse.mjs', 'marketing-export',
  ].sort(), 'ready path published exactly once');
  for (const store of stores) assert.notEqual(hash(path.join(ready.root, 'outputs', 'shein_links', store, `${date}.json`)), before.get(store));
  assert.equal(fs.existsSync(path.join(ready.root, 'state', 'cloud_ops_alerts', 'link-business-last-metric-not-ready.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ready.root, 'state', 'cloud_ops_alerts', 'link-business-metric-refetch.json'))).status, 'downstream_link_completed');
  const readyMetricCalls = fs.readFileSync(ready.metricLog, 'utf8');
  const readyPublishCalls = fs.readFileSync(ready.publishLog, 'utf8');
  const readyRestart = runSync({...ready, deadline: Math.floor(Date.now() / 1000) + 120});
  assert.equal(readyRestart.status, 0, `same-run ready restart failed\n${combined(readyRestart)}`);
  assert.equal(fs.readFileSync(ready.metricLog, 'utf8'), readyMetricCalls, 'same-run ready restart repeated metric refetch');
  assert.equal(fs.readFileSync(ready.publishLog, 'utf8'), readyPublishCalls, 'same-run ready restart repeated publish steps');

  const expiredTerminal = await setupRoot('ready');
  roots.push(expiredTerminal.root);
  writeJson(path.join(expiredTerminal.root, 'state', 'cloud_ops_alerts', 'link-business-metric-refetch.json'), {
    schemaVersion: 'cloud-link-business-metric-refetch/v2', date, runKey: 'test-run', status: 'deadline',
    attempts: 4, maxAttempts: 12, deadlineEpoch: Math.floor(Date.now() / 1000) - 30,
    transactionRoot: '', source: {status: 'rolled_back'}, phases: {},
  });
  const expiredTerminalResult = runSync({...expiredTerminal, deadline: Math.floor(Date.now() / 1000) + 60, maxAttempts: 12});
  assert.equal(expiredTerminalResult.status, 0, `a terminal deadline must allow a fresh bounded retry\n${combined(expiredTerminalResult)}`);
  assert.equal(fs.readFileSync(expiredTerminal.metricLog, 'utf8').trim().split(/\s+/).length, stores.length * 2);

  const oneReady = await setupRoot('one-ready');
  roots.push(oneReady.root);
  const oneReadyBefore = new Map(stores.map(store => [store, hash(path.join(oneReady.root, 'outputs', 'shein_links', store, `${date}.json`))]));
  const oneReadyResult = runSync({...oneReady, deadline: Math.floor(Date.now() / 1000) + 60, maxAttempts: 1});
  assert.equal(oneReadyResult.status, 75, `1/19 source availability must fail closed\n${combined(oneReadyResult)}`);
  assert.equal(fs.existsSync(oneReady.publishLog), false, '1/19 source availability must run zero publish steps');
  for (const store of stores) {
    assert.equal(hash(path.join(oneReady.root, 'outputs', 'shein_links', store, `${date}.json`)), oneReadyBefore.get(store), `${store} formal artifact changed before full-batch validation`);
  }

  const missingField = await setupRoot('missing-field');
  roots.push(missingField.root);
  const missingFieldBefore = new Map(stores.map(store => [store, hash(path.join(missingField.root, 'outputs', 'shein_links', store, `${date}.json`))]));
  const missingFieldResult = runSync({...missingField, deadline: Math.floor(Date.now() / 1000) + 60, maxAttempts: 1});
  assert.equal(missingFieldResult.status, 75, `partial metric field absence must fail closed\n${combined(missingFieldResult)}`);
  assert.equal(fs.existsSync(missingField.publishLog), false, 'partial-field candidate must run zero publish steps');
  for (const store of stores) {
    assert.equal(hash(path.join(missingField.root, 'outputs', 'shein_links', store, `${date}.json`)), missingFieldBefore.get(store), `${store} formal artifact changed for partial-field candidate`);
  }

  const strictInvalid = await setupRoot('strict-invalid');
  roots.push(strictInvalid.root);
  const strictInvalidBefore = new Map(stores.map(store => [store, hash(path.join(strictInvalid.root, 'outputs', 'shein_links', store, `${date}.json`))]));
  const strictInvalidResult = runSync({...strictInvalid, deadline: Math.floor(Date.now() / 1000) + 60, maxAttempts: 1});
  assert.equal(strictInvalidResult.status, 75, `whitespace string/array metrics must be unavailable\n${combined(strictInvalidResult)}`);
  assert.equal(fs.existsSync(strictInvalid.publishLog), false);
  for (const store of stores) assert.equal(hash(path.join(strictInvalid.root, 'outputs', 'shein_links', store, `${date}.json`)), strictInvalidBefore.get(store));

  const configDrift = await setupRoot('ready');
  roots.push(configDrift.root);
  writeJson(path.join(configDrift.root, 'config', 'stores.json'), {stores: stores.slice(0, 18).map(storeKey => ({storeKey, enabled: true}))});
  const configDriftBefore = new Map(stores.map(store => [store, hash(path.join(configDrift.root, 'outputs', 'shein_links', store, `${date}.json`))]));
  const configDriftResult = runSync({...configDrift, deadline: Math.floor(Date.now() / 1000) + 60});
  assert.notEqual(configDriftResult.status, 0, `18-store config must fail closed\n${combined(configDriftResult)}`);
  assert.equal(fs.existsSync(configDrift.metricLog), false);
  assert.equal(fs.existsSync(configDrift.publishLog), false);
  for (const store of stores) assert.equal(hash(path.join(configDrift.root, 'outputs', 'shein_links', store, `${date}.json`)), configDriftBefore.get(store));

  const symlinkRoot = await setupRoot('ready');
  roots.push(symlinkRoot.root);
  const realTransaction = path.join(symlinkRoot.root, 'state', '.link-business-metric-refetch.real');
  const linkedTransaction = path.join(symlinkRoot.root, 'state', '.link-business-metric-refetch.symlink');
  await fsp.mkdir(realTransaction, {recursive: true});
  const linkResult = spawnSync('bash', ['-lc', `ln -s '${toWslPath(realTransaction)}' '${toWslPath(linkedTransaction)}'`], {encoding: 'utf8'});
  assert.equal(linkResult.status, 0, `test symlink setup failed: ${combined(linkResult)}`);
  writeJson(path.join(symlinkRoot.root, 'state', 'cloud_ops_alerts', 'link-business-metric-refetch.json'), {
    schemaVersion: 'cloud-link-business-metric-refetch/v2', date, runKey: 'test-run', status: 'running', attempts: 0,
    deadlineEpoch: Math.floor(Date.now() / 1000) + 60, transactionRoot: toWslPath(linkedTransaction),
    source: {status: 'committing', transactionRoot: toWslPath(linkedTransaction)}, phases: {},
  });
  const symlinkResult = runSync({...symlinkRoot, deadline: Math.floor(Date.now() / 1000) + 60});
  assert.notEqual(symlinkResult.status, 0, `symlink transaction root must fail closed\n${combined(symlinkResult)}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(symlinkRoot.root, 'state', 'cloud_ops_alerts', 'link-business-metric-refetch.json'))).status, 'rollback_failed');
  assert.equal(fs.existsSync(symlinkRoot.publishLog), false);

  for (const rollbackCase of [
    {name: 'missing-backup', removeBackupStore: 'CX'},
    {name: 'rollback-write', rollbackFailStore: 'CX'},
  ]) {
    const brokenRollback = await setupRoot('ready');
    roots.push(brokenRollback.root);
    const result = runSync({
      ...brokenRollback, deadline: Math.floor(Date.now() / 1000) + 60, maxAttempts: 1,
      commitFailAfter: 1, ...rollbackCase,
    });
    assert.notEqual(result.status, 0, `${rollbackCase.name} must hard-fail\n${combined(result)}`);
    const state = JSON.parse(fs.readFileSync(path.join(brokenRollback.root, 'state', 'cloud_ops_alerts', 'link-business-metric-refetch.json')));
    assert.equal(state.status, 'rollback_failed');
    assert.equal(state.source.status, 'rollback_failed');
    assert.notEqual(state.status, 'ready');
    assert.equal(fs.existsSync(brokenRollback.publishLog), false);
  }

  const publishFailure = await setupRoot('publish-fail');
  roots.push(publishFailure.root);
  const publishFailureBefore = new Map(stores.map(store => [store, hash(path.join(publishFailure.root, 'outputs', 'shein_links', store, `${date}.json`))]));
  const publishFailureResult = runSync({
    ...publishFailure,
    deadline: Math.floor(Date.now() / 1000) + 60,
    failPublishStep: 'load_bi_warehouse.mjs',
  });
  assert.equal(publishFailureResult.status, 75, `publish failure must preserve source_committed and remain resumable\n${combined(publishFailureResult)}`);
  for (const store of stores) {
    assert.notEqual(hash(path.join(publishFailure.root, 'outputs', 'shein_links', store, `${date}.json`)), publishFailureBefore.get(store), `${store} authoritative source was rolled back after downstream failure`);
  }
  const publishFailureState = JSON.parse(fs.readFileSync(path.join(publishFailure.root, 'state', 'cloud_ops_alerts', 'link-business-metric-refetch.json')));
  assert.equal(publishFailureState.status, 'downstream_incomplete');
  assert.equal(publishFailureState.source.status, 'source_committed');
  const failedMetricCalls = fs.readFileSync(publishFailure.metricLog, 'utf8');
  const resumeResult = runSync({...publishFailure, deadline: Math.floor(Date.now() / 1000) + 120});
  assert.equal(resumeResult.status, 0, `source_committed downstream resume failed\n${combined(resumeResult)}`);
  assert.equal(fs.readFileSync(publishFailure.metricLog, 'utf8'), failedMetricCalls, 'downstream resume refetched source');
  const publishLines = fs.readFileSync(publishFailure.publishLog, 'utf8').trim().split(/\r?\n/);
  assert.equal(publishLines.filter(line => line === 'generate_link_ops_web_dashboard.mjs').length, 1);
  assert.equal(publishLines.filter(line => line === 'load_bi_warehouse.mjs').length, 2, 'failed phase must reconcile by same-date rerun');
  assert.equal(publishLines.filter(line => line === 'load_bi_business_domains.mjs').length, 1);
  assert.equal(publishLines.filter(line => line === 'marketing-export').length, 1);

  for (const phase of ['dashboard', 'warehouse', 'business-domain-load', 'marketing-export']) {
    const crashWindow = await setupRoot('ready');
    roots.push(crashWindow.root);
    const first = runSync({...crashWindow, deadline: Math.floor(Date.now() / 1000) + 60, crashAfterPhase: phase});
    assert.equal(first.status, 75, `phase=${phase} crash window must remain incomplete\n${combined(first)}`);
    const firstState = JSON.parse(fs.readFileSync(path.join(crashWindow.root, 'state', 'cloud_ops_alerts', 'link-business-metric-refetch.json')));
    assert.equal(firstState.source.status, 'source_committed');
    assert.equal(firstState.phases[phase].status, 'running');
    const sourceCalls = fs.readFileSync(crashWindow.metricLog, 'utf8');
    const second = runSync({...crashWindow, deadline: Math.floor(Date.now() / 1000) + 120});
    assert.equal(second.status, 0, `phase=${phase} same-run resume failed\n${combined(second)}`);
    assert.equal(fs.readFileSync(crashWindow.metricLog, 'utf8'), sourceCalls, `phase=${phase} resume refetched source`);
    const terminal = JSON.parse(fs.readFileSync(path.join(crashWindow.root, 'state', 'cloud_ops_alerts', 'link-business-metric-refetch.json')));
    assert.equal(terminal.status, 'downstream_link_completed');
    assert.equal(terminal.phases[phase].attempts, 2, `phase=${phase} ambiguous invocation was not reconciled under same phase identity`);
    for (const required of ['dashboard', 'warehouse', 'business-domain-load', 'marketing-export']) {
      assert.equal(terminal.phases[required].status, 'completed');
    }
  }

  const sourceDrift = await setupRoot('ready');
  roots.push(sourceDrift.root);
  const sourceDriftFirst = runSync({...sourceDrift, deadline: Math.floor(Date.now() / 1000) + 60, crashAfterPhase: 'dashboard'});
  assert.equal(sourceDriftFirst.status, 75, `source drift setup crash failed\n${combined(sourceDriftFirst)}`);
  const sourceDriftMetricCalls = fs.readFileSync(sourceDrift.metricLog, 'utf8');
  const sourceDriftPublishCalls = fs.readFileSync(sourceDrift.publishLog, 'utf8');
  const driftFile = path.join(sourceDrift.root, 'outputs', 'shein_links', 'CX', `${date}.json`);
  fs.appendFileSync(driftFile, ' ');
  const sourceDriftResult = runSync({...sourceDrift, deadline: Math.floor(Date.now() / 1000) + 120});
  assert.notEqual(sourceDriftResult.status, 0, `formal source drift must block downstream\n${combined(sourceDriftResult)}`);
  assert.equal(fs.readFileSync(sourceDrift.metricLog, 'utf8'), sourceDriftMetricCalls, 'source drift path must not refetch automatically');
  assert.equal(fs.readFileSync(sourceDrift.publishLog, 'utf8'), sourceDriftPublishCalls, 'source drift path repeated a downstream phase');
  const sourceDriftState = JSON.parse(fs.readFileSync(path.join(sourceDrift.root, 'state', 'cloud_ops_alerts', 'link-business-metric-refetch.json')));
  assert.equal(sourceDriftState.status, 'source_revalidation_required');
  assert.equal(sourceDriftState.source.status, 'source_revalidation_required');
  assert.deepEqual(sourceDriftState.phases, {});

  }

  const dailyResume = await setupRoot('ready');
  roots.push(dailyResume.root);
  const dailyFirst = runDailySync(dailyResume);
  assert.equal(dailyFirst.status, 75, `linksData failure must keep daily publication incomplete\n${combined(dailyFirst)}`);
  assert.equal(fs.existsSync(path.join(dailyResume.root, 'state', 'cloud_ops_alerts', 'link-business-metric-refetch.json')), true,
    `daily run exited before source journal creation\n${combined(dailyFirst)}`);
  const dailyFirstState = JSON.parse(fs.readFileSync(path.join(dailyResume.root, 'state', 'cloud_ops_alerts', 'link-business-metric-refetch.json')));
  assert.equal(dailyFirstState.source.status, 'source_committed');
  assert.equal(dailyFirstState.phases['cost-ledger'].status, 'completed');
  assert.equal(dailyFirstState.phases['portal-core'].status, 'completed');
  assert.equal(dailyFirstState.phases.linksData.status, 'failed');
  assert.notEqual(dailyFirstState.status, 'publish_completed');
  const dailySourceHashes = new Map(stores.map(store => [store, hash(path.join(dailyResume.root, 'outputs', 'shein_links', store, `${date}.json`))]));
  const dailyMetricCalls = fs.readFileSync(dailyResume.metricLog, 'utf8');
  const dailySecond = runDailySync(dailyResume);
  assert.equal(dailySecond.status, 0, `same-run daily downstream resume failed\n${combined(dailySecond)}`);
  assert.equal(fs.readFileSync(dailyResume.metricLog, 'utf8'), dailyMetricCalls, 'daily downstream resume refetched source');
  for (const store of stores) assert.equal(hash(path.join(dailyResume.root, 'outputs', 'shein_links', store, `${date}.json`)), dailySourceHashes.get(store));
  const dailyTerminal = JSON.parse(fs.readFileSync(path.join(dailyResume.root, 'state', 'cloud_ops_alerts', 'link-business-metric-refetch.json')));
  assert.equal(dailyTerminal.status, 'publish_completed');
  assert.equal(dailyTerminal.ready, true);
  assert.equal(dailyTerminal.phases.linksData.attempts, 2);
  assert.deepEqual(fs.readFileSync(dailyResume.costLedgerLog, 'utf8').trim().split(/\r?\n/), ['test-run:inventory-cost']);
  const portalCalls = fs.readFileSync(dailyResume.portalCoreLog, 'utf8').trim().split(/\r?\n/);
  assert.equal(portalCalls.length, 1);
  assert.match(portalCalls[0], /^test-run:portal-core\|[a-f0-9]{64}$/);
  assert.deepEqual(fs.readFileSync(dailyResume.prewarmLog, 'utf8').trim().split(/\r?\n/), [
    'linksData|test-run:linksData', 'linksData|test-run:linksData',
  ]);
  const queueCalls = fs.readFileSync(dailyResume.queueLog, 'utf8').trim().split(/\r?\n/);
  assert.equal(queueCalls.length, 4);
  assert.equal(queueCalls.filter(line => line.includes('--idempotency-key test-run:critical-sections')).length, 2);
  assert.equal(queueCalls.filter(line => line.includes('--idempotency-key test-run:noncritical-sections')).length, 2);
  const terminalLogs = new Map([
    dailyResume.metricLog, dailyResume.publishLog, dailyResume.costLedgerLog,
    dailyResume.portalCoreLog, dailyResume.prewarmLog, dailyResume.queueLog,
  ].map(file => [file, fs.readFileSync(file, 'utf8')]));
  const dailyThird = runDailySync(dailyResume);
  assert.equal(dailyThird.status, 0, `publish_completed replay failed\n${combined(dailyThird)}`);
  for (const [file, content] of terminalLogs) assert.equal(fs.readFileSync(file, 'utf8'), content, `publish_completed replay repeated ${path.basename(file)}`);
  const portalDataFile = path.join(dailyResume.root, 'outputs', 'bi-portal', 'data.json');
  const stalePortal = JSON.parse(fs.readFileSync(portalDataFile, 'utf8'));
  stalePortal.sourceCommit.sourceRunKey = 'stale-run:portal-core';
  writeJson(portalDataFile, stalePortal);
  const portalDriftMetricCalls = fs.readFileSync(dailyResume.metricLog, 'utf8');
  const portalDriftCostCalls = fs.readFileSync(dailyResume.costLedgerLog, 'utf8');
  const portalDriftResult = runDailySync(dailyResume);
  assert.equal(portalDriftResult.status, 0, `stale completed Portal core identity must rerun safely\n${combined(portalDriftResult)}`);
  assert.equal(fs.readFileSync(dailyResume.metricLog, 'utf8'), portalDriftMetricCalls, 'Portal core repair refetched source');
  assert.equal(fs.readFileSync(dailyResume.costLedgerLog, 'utf8'), portalDriftCostCalls, 'Portal core repair repeated completed ledger phase');
  assert.equal(fs.readFileSync(dailyResume.portalCoreLog, 'utf8').trim().split(/\r?\n/).length, 2, 'Portal core mismatch did not invalidate/rerun generation');
  assert.equal(fs.readFileSync(dailyResume.prewarmLog, 'utf8').trim().split(/\r?\n/).length, 3, 'Portal core rerun did not invalidate linksData receipt');
  const repairedPortalState = JSON.parse(fs.readFileSync(path.join(dailyResume.root, 'state', 'cloud_ops_alerts', 'link-business-metric-refetch.json')));
  assert.equal(repairedPortalState.status, 'publish_completed');
  assert.equal(repairedPortalState.phases['portal-core'].status, 'completed');
  assert.equal(repairedPortalState.phases.linksData.status, 'completed');

  if (!onlyDaily) {

  const interrupted = await setupRoot('ready');
  roots.push(interrupted.root);
  const interruptedBefore = new Map(stores.map(store => [store, hash(path.join(interrupted.root, 'outputs', 'shein_links', store, `${date}.json`))]));
  const interruptedTransaction = path.join(interrupted.root, 'state', '.link-business-metric-refetch.interrupted');
  for (const store of stores) {
    const formal = path.join(interrupted.root, 'outputs', 'shein_links', store, `${date}.json`);
    const backup = path.join(interruptedTransaction, 'backups', store, `${date}.json`);
    write(backup, fs.readFileSync(formal));
  }
  writeJson(path.join(interrupted.root, 'outputs', 'shein_links', 'CX', `${date}.json`), {
    ok: true, date, store: {storeKey: 'CX'}, counts: {diagnoseDay: 1, performanceRows: 1},
    performanceRows: [{epsUv: 0, goodsUv: 0, saleCnt: 0, payOrderCnt: 0}],
  });
  write(path.join(interruptedTransaction, 'journal.ndjson'), `${JSON.stringify({event: 'committed', store: 'CX'})}\n`);
  const interruptedRecords = stores.map(store => {
    const target = path.join(interrupted.root, 'outputs', 'shein_links', store, `${date}.json`);
    const backup = path.join(interruptedTransaction, 'backups', store, `${date}.json`);
    return {
      store,
      candidate: toWslPath(path.join(interruptedTransaction, 'candidates', store, `${date}.json`)),
      target: toWslPath(target),
      backup: toWslPath(backup),
      prehash: hash(backup),
      posthash: hash(target),
    };
  });
  writeJson(path.join(interruptedTransaction, 'manifest.json'), {
    schemaVersion: 'metric-source-transaction/v2', date, status: 'committing',
    records: interruptedRecords, committed: ['CX'], fingerprint: crypto.createHash('sha256')
      .update(interruptedRecords.map(row => `${row.store}:${row.posthash}`).sort().join('\n')).digest('hex'),
  });
  writeJson(path.join(interrupted.root, 'state', 'cloud_ops_alerts', 'link-business-metric-refetch.json'), {
    date,
    runKey: 'test-run',
    status: 'running',
    attempts: 1,
    deadlineEpoch: Math.floor(Date.now() / 1000) + 60,
    transactionRoot: toWslPath(interruptedTransaction),
  });
  const interruptedResult = runSync({...interrupted, deadline: Math.floor(Date.now() / 1000) + 120, maxAttempts: 1});
  assert.equal(interruptedResult.status, 75, `interrupted commit recovery must restore before retry bound\n${combined(interruptedResult)}`);
  assert.equal(fs.existsSync(interrupted.metricLog), false, 'interrupted recovery at retry bound must not fetch');
  for (const store of stores) {
    assert.equal(hash(path.join(interrupted.root, 'outputs', 'shein_links', store, `${date}.json`)), interruptedBefore.get(store), `${store} interrupted transaction was not restored byte-identically`);
  }

  const wrongManifest = await setupRoot('ready');
  roots.push(wrongManifest.root);
  const wrongManifestBefore = new Map(stores.map(store => [store, hash(path.join(wrongManifest.root, 'outputs', 'shein_links', store, `${date}.json`))]));
  const wrongTransaction = path.join(wrongManifest.root, 'state', '.link-business-metric-refetch.wrong-path');
  for (const store of stores) {
    const formal = path.join(wrongManifest.root, 'outputs', 'shein_links', store, `${date}.json`);
    write(path.join(wrongTransaction, 'backups', store, `${date}.json`), fs.readFileSync(formal));
  }
  writeJson(path.join(wrongManifest.root, 'outputs', 'shein_links', 'CX', `${date}.json`), {
    ok: true, date, store: {storeKey: 'CX'}, counts: {diagnoseDay: 1, performanceRows: 1},
    performanceRows: [{epsUv: 2, goodsUv: 2, saleCnt: 0, payOrderCnt: 0}],
  });
  const wrongRecords = stores.map(store => {
    const target = path.join(wrongManifest.root, 'outputs', 'shein_links', store, `${date}.json`);
    const backup = path.join(wrongTransaction, 'backups', store, `${date}.json`);
    return {
      store,
      candidate: toWslPath(path.join(wrongTransaction, 'candidates', store, `${date}.json`)),
      target: toWslPath(target), backup: toWslPath(backup), prehash: hash(backup), posthash: hash(target),
    };
  });
  wrongRecords[0].backup = wrongRecords[1].backup;
  write(path.join(wrongTransaction, 'journal.ndjson'), '');
  writeJson(path.join(wrongTransaction, 'manifest.json'), {
    schemaVersion: 'metric-source-transaction/v2', date, status: 'committing', records: wrongRecords,
    committed: ['CX'], fingerprint: crypto.createHash('sha256')
      .update(wrongRecords.map(row => `${row.store}:${row.posthash}`).sort().join('\n')).digest('hex'),
  });
  writeJson(path.join(wrongManifest.root, 'state', 'cloud_ops_alerts', 'link-business-metric-refetch.json'), {
    schemaVersion: 'cloud-link-business-metric-refetch/v2', date, runKey: 'test-run', status: 'running', attempts: 1,
    deadlineEpoch: Math.floor(Date.now() / 1000) + 60, transactionRoot: toWslPath(wrongTransaction),
    source: {status: 'committing', transactionRoot: toWslPath(wrongTransaction)}, phases: {},
  });
  const wrongManifestResult = runSync({...wrongManifest, deadline: Math.floor(Date.now() / 1000) + 120, maxAttempts: 1});
  assert.notEqual(wrongManifestResult.status, 0, `wrong contained manifest path must fail before rollback write\n${combined(wrongManifestResult)}`);
  assert.notEqual(hash(path.join(wrongManifest.root, 'outputs', 'shein_links', 'CX', `${date}.json`)), wrongManifestBefore.get('CX'), 'wrong manifest path unexpectedly performed rollback write');
  for (const store of stores.slice(1)) assert.equal(hash(path.join(wrongManifest.root, 'outputs', 'shein_links', store, `${date}.json`)), wrongManifestBefore.get(store));
  assert.equal(JSON.parse(fs.readFileSync(path.join(wrongManifest.root, 'state', 'cloud_ops_alerts', 'link-business-metric-refetch.json'))).status, 'rollback_failed');
  assert.doesNotMatch(fs.readFileSync(path.join(wrongTransaction, 'journal.ndjson'), 'utf8'), /rolled_back/);

  const zero = await setupRoot('zero');
  roots.push(zero.root);
  write(zero.metricLog, '');
  const zeroBefore = new Map(stores.map(store => [store, hash(path.join(zero.root, 'outputs', 'shein_links', store, `${date}.json`))]));
  const zeroResult = runSync({...zero, deadline: Math.floor(Date.now() / 1000) + 1, maxAttempts: 24, sleep: 2});
  assert.equal(zeroResult.status, 75, `zero refetch must fail closed\n${combined(zeroResult)}`);
  for (const store of stores) assert.equal(hash(path.join(zero.root, 'outputs', 'shein_links', store, `${date}.json`)), zeroBefore.get(store));
  const zeroAlert = JSON.parse(fs.readFileSync(path.join(zero.root, 'state', 'cloud_ops_alerts', 'link-business-last-metric-not-ready.json')));
  assert.equal(zeroAlert.refetch.status, 'deadline');
  assert.equal(zeroAlert.refetch.targetStores.length > 0, true);
  assert.equal(fs.existsSync(zero.businessLog), false);
  assert.equal(fs.existsSync(zero.publishLog), false, 'zero path must not publish');
  const zeroCallCount = fs.readFileSync(zero.metricLog, 'utf8').trim()
    ? fs.readFileSync(zero.metricLog, 'utf8').trim().split(/\s+/).length : 0;
  const zeroRestart = runSync({...zero, deadline: Math.floor(Date.now() / 1000) + 60, maxAttempts: 1, sleep: 0});
  assert.equal(zeroRestart.status, 75, `fresh bounded retry must still fail closed when source remains unavailable\n${combined(zeroRestart)}`);
  const zeroRestartCallCount = fs.readFileSync(zero.metricLog, 'utf8').trim()
    ? fs.readFileSync(zero.metricLog, 'utf8').trim().split(/\s+/).length : 0;
  assert.equal(zeroRestartCallCount, zeroCallCount + stores.length * 2,
    'a terminal deadline may open one fresh bounded retry window');
  const zeroRestartState = JSON.parse(fs.readFileSync(path.join(zero.root, 'state', 'cloud_ops_alerts', 'link-business-metric-refetch.json')));
  assert.ok(zeroRestartState.deadlineEpoch > zeroAlert.refetch.deadlineEpoch, 'terminal deadline must not poison a fresh retry window');

  const blocked = await setupRoot('ready');
  roots.push(blocked.root);
  await fsp.rm(path.join(blocked.root, 'outputs', 'shein_business_domains', 'CX', `${date}.json`));
  const blockedResult = runSync({...blocked, deadline: Math.floor(Date.now() / 1000) + 60});
  assert.equal(blockedResult.status, 0, `non-metric blocker should remain recoverable\n${combined(blockedResult)}`);
  assert.equal(fs.existsSync(blocked.metricLog), false, 'non-metric blocker must not refetch metrics');
  assert.equal(fs.existsSync(blocked.publishLog), false, 'non-metric blocker must not publish');
  const partial = JSON.parse(fs.readFileSync(path.join(blocked.root, 'state', 'cloud_ops_alerts', 'link-business-last-partial.json')));
  assert.equal(partial.failedStores, 'CX');
  }

  console.log(JSON.stringify({ok: true, checks: [
    'zero_to_full_batch_metrics_refetch_to_source_committed_once',
    'exact_canonical_nineteen_store_config_required',
    'strict_finite_json_number_semantics_and_proven_zero',
    'transaction_paths_reject_symlink_redirection',
    'missing_backup_and_rollback_write_failure_are_rollback_failed',
    'same_run_source_and_completed_phases_are_reused',
    'one_of_nineteen_ready_preserves_all_formal_artifacts',
    'missing_null_string_whitespace_array_fields_preserve_all_formal_artifacts',
    'downstream_failure_preserves_source_committed_and_resumes',
    'each_link_phase_crash_window_reconciles_same_identity',
    'source_fingerprint_revalidated_before_each_phase_and_drift_invalidates_receipts',
    'interrupted_source_commit_recovers_from_complete_hash_journal',
    'recovery_manifest_wrong_exact_path_rejected_before_rollback_write',
    'daily_linksdata_failure_resumes_without_refetch_or_core_ledger_repeat',
    'completed_portal_core_identity_revalidated_and_repaired_before_ready',
    'stable_queue_and_linksdata_idempotency_keys',
    'zero_until_absolute_deadline_preserves_artifacts',
    'non_metric_blocker_does_not_refetch',
    'completed_business_domains_not_repeated',
  ]}, null, 2));
} finally {
  for (const root of roots) {
    const symlink = path.join(root, 'state', '.link-business-metric-refetch.symlink');
    try { await fsp.unlink(symlink); } catch {
      const wslPath = toWslPath(symlink).replaceAll("'", "'\\''");
      spawnSync('bash', ['-lc', `rm -f -- '${wslPath}'`], {encoding: 'utf8'});
    }
    await fsp.rm(root, {recursive: true, force: true});
  }
}
