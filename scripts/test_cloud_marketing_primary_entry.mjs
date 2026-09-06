#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceFiles = [
  'scripts/run_cloud_marketing_fallback_slot.sh', 'scripts/cloud_marketing_repair_worker.sh',
  'scripts/run_host_heavy_job.sh', 'scripts/lib/shared_lock.sh',
  'scripts/resolve_cloud_runtime_artifact.mjs', 'scripts/manage_browser_task_leases.mjs',
  'scripts/manage_cloud_marketing_immediate_run.mjs', 'scripts/marketing/manage_marketing_repair_queue.mjs',
  'lib/marketing_plan_registry.mjs', 'lib/browser_task_lease.mjs',
  'scripts/marketing/batch_restore_manual_limited_discounts.mjs',
  'scripts/marketing/batch_apply_new_listing_limited_discount.mjs',
  'scripts/marketing/replace_limited_discount_transactionally.mjs',
  'scripts/marketing/manage_manual_limited_discount_override.mjs',
  'infra/systemd/shein-bi-cloud-marketing-live-guard.service',
  'infra/systemd/shein-bi-cloud-marketing-repair.service',
  'infra/systemd/shein-bi-cloud-marketing-repair.timer',
];
const marketingTimers = fs.readdirSync(path.join(ROOT, 'infra/systemd')).filter(name => /marketing.*\.timer$/.test(name)).sort();
assert.deepEqual(marketingTimers, ['shein-bi-cloud-marketing-live-guard.timer', 'shein-bi-cloud-marketing-repair.timer'],
  'primary entry must reuse the existing services without adding a marketing timer');
const sources = {};
function collect(relative) {
  if (Object.hasOwn(sources, relative)) return;
  const file = path.resolve(ROOT, relative);
  assert.ok(file.startsWith(ROOT + path.sep));
  const source = fs.readFileSync(file, 'utf8');
  sources[relative] = source;
  if (!relative.endsWith('.mjs')) return;
  for (const match of source.matchAll(/(?:from\s*|import\s*\()['"]([^'"]+)['"]/g)) {
    if (!match[1].startsWith('.')) continue;
    collect(path.relative(ROOT, path.resolve(path.dirname(file), match[1])).replaceAll(path.sep, '/'));
  }
}
sourceFiles.forEach(collect);

// The whole isolated runner is sent through stdin. Windows drive mounts are
// not used for execution or chmod/fsync, and no business endpoint is reached.
async function runContracts(sources) {
  const {default: assert} = await import('node:assert/strict');
  const {default: fs} = await import('node:fs');
  const {default: fsp} = await import('node:fs/promises');
  const {default: path} = await import('node:path');
  const {default: os} = await import('node:os');
  const {default: crypto} = await import('node:crypto');
  const {pathToFileURL} = await import('node:url');
  const {spawn, spawnSync} = await import('node:child_process');
  const {once} = await import('node:events');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-marketing-primary-entry-'));
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const write = (relative, value, mode = 0o600) => {
    const file = path.join(temp, relative);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, value, {mode});
    fs.chmodSync(file, mode);
    return file;
  };
  const json = (relative, value) => write(relative, JSON.stringify(value, null, 2) + '\n');
  const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  const shaFile = file => hash(fs.readFileSync(file));
  let checks = 0;
  const check = async (name, action) => {
    try { await action(); checks += 1; }
    catch (error) { console.error('FAIL ' + name); throw error; }
  };
  const holders = [];
  try {
    for (const [relative, source] of Object.entries(sources)) write(relative, source);
    const registry = await import(pathToFileURL(path.join(temp, 'lib/marketing_plan_registry.mjs')));
    const leases = await import(pathToFileURL(path.join(temp, 'lib/browser_task_lease.mjs')));
    const date = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());
    const oldDate = new Date(Date.parse(date + 'T12:00:00Z') - 86400_000).toISOString().slice(0, 10);
    const epoch = Math.floor(Date.parse(date + 'T14:30:00+08:00') / 1000);
    const stores = Array.from({length: 19}, (_, i) => 'S' + String(i + 1).padStart(2, '0'));
    json('config/stores.json', {stores: stores.map(storeKey => ({storeKey, enabled: true}))});
    const rows = stores.map((storeKey, i) => ({storeKey, activityId: 79000, skc: 'fixture-' + i,
      targetPrice: 25 + i / 100, finalTargetPrice: 25 + i / 100, cost: 10, storageUnitCostSar: 0.5, selected: true}));
    const pair = registry.validateMarketingPlanPairDocuments({selection: {items: rows}, prices: {items: rows},
      requireCurrentBaseline: false, expectedStoreCount: 19, expectedStoreKeys: stores});
    const document = {items: rows, baselineForNextOrdinaryActivity: true, baselineForLimitedDiscountFallback: true,
      executionStatus: 'completed', planMetadata: {status: 'current_baseline', supersededBy: null,
        activityBatch: 'primary-entry-fixture', promotedAt: date + 'T01:00:00.000Z',
        selectionPayloadHash: pair.selectionPayloadHash, pricePayloadHash: pair.pricePayloadHash, workFingerprint: pair.workFingerprint}};
    const selection = json('source/selection.json', document);
    const prices = json('source/prices.json', document);
    const registryRoot = path.join(temp, 'registry');
    const registryFile = path.join(registryRoot, 'current.json');
    const published = await registry.publishMarketingPlanRegistry({selectionPath: selection, priceOverridesPath: prices,
      expectedSelectionSha256: shaFile(selection), expectedPriceOverridesSha256: shaFile(prices),
      registryRoot, registryFile, baselineId: 'primary-entry-fixture',
      confirm: registry.MARKETING_PLAN_REGISTRY_CONFIRM_TOKEN, expectedStoreKeys: stores});
    const cost = json('cost.json', {fixture: true});
    const guard = json('outputs/reports/guard.json', {
      mode: 'read-only', reportDate: date,
      targetPlanSelection: {strategy: 'registry_current_baseline', selectionSource: 'durable_current_baseline_registry',
        registryHash: published.registryHash, priceOverrides: published.priceOverrides, priceOverridesHash: published.priceOverridesHash},
      marketingCostMapSource: {path: cost, sha256: shaFile(cost), expectedSha256: shaFile(cost), verified: true},
    });
    const plan = json('outputs/reports/high-plan.json', {date, items: [rows[0]], fixture: true});
    const resultRelative = 'outputs/reports/high-click-low-conversion-special-execution-' + date + '.json';
    const canonicalOutputs = path.join(temp, 'canonical/outputs');
    const canonicalResult = path.join(canonicalOutputs, 'reports', path.basename(resultRelative));
    write('canonical/outputs/reports/guard.json', fs.readFileSync(guard));
    write('canonical/outputs/reports/high-plan.json', fs.readFileSync(plan));
    const queueRelative = 'state/cloud_marketing_live_guard/repair-queues/marketing-repair-' + date + '.json';
    const queueFile = path.join(temp, queueRelative);
    const workHash = hash('one-exact-fixture-item');
    const queue = {schemaVersion: 1, date, status: 'pending', sourceGuard: 'outputs/reports/guard.json',
      sourceGuardHash: shaFile(guard), queueFingerprint: hash('primary-entry-queue'), counts: {totalRows: 1, totalGroups: 1},
      stages: {highClickSpecial: {status: 'pending', workFingerprint: workHash, planPath: 'outputs/reports/high-plan.json'},
        manualSpecialRestore: {status: 'not_required'}, driftRepair: {status: 'not_required'}, fallbackRepair: {status: 'not_required'}}};
    json(queueRelative, queue);
    const oldQueue = json('state/cloud_marketing_live_guard/repair-queues/marketing-repair-' + oldDate + '.json', {...queue, date: oldDate});
    const originalOldBytes = fs.readFileSync(oldQueue);
    const workerSource = sources['scripts/cloud_marketing_repair_worker.sh'];
    const anchor = 'STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"';
    assert.equal(workerSource.split(anchor).length, 2);
    // Only platform-facing work is stubbed. Admission, queue mutation locks,
    // registry/hash binding, profile leases, deadlines and update-stage are real.
    const businessStubs = [
      'run_final_readback() { printf "snapshot-fixture\\n" >> "$ROOT/events.log"; return 0; }',
      'send_daily_group_report() { printf "report-fixture\\n" >> "$ROOT/events.log"; return 0; }',
      '',
    ].join('\n');
    write('scripts/cloud_marketing_repair_worker.sh', workerSource.replace(anchor, businessStubs + anchor));
    write('scripts/cleanup_shein_store_browsers.mjs', 'process.exit(0);\n');
    write('scripts/check_host_resource_pressure.mjs', 'process.exit(Number(process.env.FIXTURE_PRESSURE_STATUS || 0));\n');
    write('scripts/marketing/batch_apply_high_click_special_discounts.mjs', `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const root = process.env.SHEIN_BI_ROOT;
const outputs = process.env.SHEIN_BI_OUTPUTS_ROOT || path.join(root, 'outputs');
const queue = JSON.parse(fs.readFileSync(${JSON.stringify(queueFile)}, 'utf8'));
assert.equal(value('--guard'), path.join(outputs, 'reports/guard.json'));
assert.equal(value('--plan'), path.join(outputs, 'reports/high-plan.json'));
assert.equal(value('--result'), path.join(outputs, 'reports', ${JSON.stringify(path.basename(resultRelative))}));
assert.equal(value('--expected-work-fingerprint'), queue.stages.highClickSpecial.workFingerprint);
assert.ok(fs.statSync(value('--guard')).isFile() && fs.statSync(value('--plan')).isFile());
assert.ok(fs.existsSync(${JSON.stringify(queueFile + '.mutation.lock/owner')}));
assert.ok(fs.existsSync(${JSON.stringify(path.join(registryRoot, '.publish.lock'))}));
const profileLeases = fs.readdirSync(path.join(root, 'state/browser_task_leases')).filter(name => name.endsWith('.json'));
assert.equal(profileLeases.length, 19);
fs.appendFileSync(path.join(root, 'events.log'), JSON.stringify({executor: true, args, profileLeases: profileLeases.length}) + '\\n');
const row = {ok: true, store: 'S01', state: 'completed'};
fs.mkdirSync(path.dirname(value('--result')), {recursive: true});
const resultBytes = JSON.stringify({workFingerprint: value('--expected-work-fingerprint'),
  results: [row], processedThisRunResults: [row], totals: {processed: 1, processedThisRun: 1, blocked: 0, failed: 0, remainingItems: 0}}) + '\\n';
    if (process.env.FIXTURE_RESULT_KIND === 'missing') {
      // Simulate a child that exits without publishing its promised result.
    } else if (process.env.FIXTURE_RESULT_KIND === 'symlink') {
  const target = path.join(root, 'result-target.json');
  fs.writeFileSync(target, resultBytes);
  fs.symlinkSync(target, value('--result'));
} else {
  fs.writeFileSync(value('--result'), resultBytes);
}
`);
    write('scripts/marketing/batch_restore_manual_limited_discounts.mjs', `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const root = process.env.SHEIN_BI_ROOT;
const queue = JSON.parse(fs.readFileSync(${JSON.stringify(queueFile)}, 'utf8'));
const result = value('--result');
if (value('--expected-work-fingerprint') !== queue.stages.manualSpecialRestore.workFingerprint) process.exit(64);
fs.appendFileSync(path.join(root, 'events.log'), JSON.stringify({executor: 'manual', args}) + '\\n');
const status = Number(process.env.FIXTURE_MANUAL_EXECUTOR_STATUS || 0);
if (status !== 0) process.exit(status);
fs.mkdirSync(path.dirname(result), {recursive: true});
const row = {ok: true, storeKey: 'S01'};
fs.writeFileSync(result, JSON.stringify({workFingerprint: value('--expected-work-fingerprint'), dryRunOnly: false,
  results: [row], processedThisRunResults: [row], totals: {processed: 1, processedThisRun: 1, resumedItems: 0, remainingItems: 0}}) + '\\n');
`);
    write('bin/date', '#!/bin/bash\ncase "${1:-}" in\n +%F) echo "$FIXTURE_DATE" ;;\n +%H) echo "$FIXTURE_HOUR" ;;\n +%M) echo "$FIXTURE_MINUTE" ;;\n +%s) echo "$FIXTURE_EPOCH" ;;\n *) exec /bin/date "$@" ;;\nesac\n', 0o755);
    write('bin/systemctl', '#!/bin/bash\nprintf "unexpected-systemctl\\n" >> "$SHEIN_BI_ROOT/events.log"\necho active\nexit 0\n', 0o755);
    for (const executable of ['ssh', 'curl', 'wget']) {
      write('bin/' + executable, '#!/bin/bash\necho forbidden-platform-command >&2\nexit 99\n', 0o755);
    }
    write('scripts/real_run_host_heavy_job.sh', sources['scripts/run_host_heavy_job.sh']);
    // Keep real host admission; remap only its production defer report into tmp.
    write('scripts/run_host_heavy_job.sh', `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$SHEIN_BI_MARKETING_REPAIR_GRACEFUL_CUTOFF_EPOCH" "$SHEIN_BI_MARKETING_REPAIR_SLOT_HARD_DEADLINE_EPOCH" "$@" > "$SHEIN_BI_ROOT/host-args.log"
args=("$@")
for ((i=0; i<\${#args[@]}; i++)); do
  if [[ "\${args[i]}" == --defer-state ]]; then args[i+1]="$SHEIN_BI_ROOT/defer.json"; fi
done
exec bash "$SHEIN_BI_ROOT/scripts/real_run_host_heavy_job.sh" "\${args[@]}"
`);
    const lockFiles = ['host.lock', 'slot0.lock', 'slot1.lock'];
    lockFiles.forEach(file => write(file, ''));
    const env = {PATH: path.join(temp, 'bin') + ':' + path.dirname(process.execPath) + ':/usr/bin:/bin', HOME: temp, TZ: 'Asia/Shanghai',
      FIXTURE_DATE: date, FIXTURE_HOUR: '14', FIXTURE_MINUTE: '30', FIXTURE_EPOCH: String(epoch),
      SHEIN_BI_ROOT: temp, SHEIN_BI_TZ: 'Asia/Shanghai',
      SHEIN_HOST_HEAVY_LOCK_FILE: path.join(temp, 'host.lock'),
      SHEIN_BROWSER_READ_SLOT_0: path.join(temp, 'slot0.lock'), SHEIN_BROWSER_READ_SLOT_1: path.join(temp, 'slot1.lock'),
      SHEIN_BI_MARKETING_CLOUD_PRIMARY_ENABLED: 'true', SHEIN_BI_MARKETING_CLOUD_FALLBACK_ENABLED: 'true',
      SHEIN_BI_MARKETING_REPAIR_EXECUTION_LOCATION: 'cloud', SHEIN_BI_MARKETING_REPAIR_MAX_GROUPS: '2',
      SHEIN_BI_MARKETING_REPAIR_DATE: date, SHEIN_BI_MARKETING_REPAIR_ACTIVATION_DATE: date,
      SHEIN_BI_MARKETING_IMMEDIATE_AUTHORIZATION_FILE: path.join(temp, 'absent-auth/authorization.json'),
      SHEIN_BI_MARKETING_PLAN_REGISTRY_FILE: registryFile, SHEIN_BI_MARKETING_PLAN_REGISTRY_ROOT: registryRoot,
      SHEIN_BI_MARKETING_COST_MAP_PATH: cost, SHEIN_BI_MARKETING_ARTIFACT_PUBLICATION_LOCK_WAIT_SEC: '0',
      SHEIN_BI_MARKETING_REPAIR_LOG_DIR: path.join(temp, 'logs'),
      SHEIN_BI_MARKETING_REPAIR_RESUME_RECEIPT: path.join(temp, 'no-resume.json'),
      SHEIN_BI_MARKETING_REPAIR_BUSY_SERVICES: 'unrelated.service',
      SHEIN_BI_MARKETING_REPAIR_LEASE_TTL_SEC: '300', SHEIN_BI_MARKETING_REPAIR_LEASE_HEARTBEAT_INTERVAL_SEC: '60',
      SHEIN_OPS_BUSINESS_DELIVERY_ENABLED: '0'};
    const reset = () => {
      json(queueRelative, queue);
      for (const relative of ['host-args.log', 'events.log', 'defer.json', 'state/cloud_ops_alerts/marketing-repair-last.json',
        resultRelative, path.relative(temp, canonicalResult), 'result-target.json']) {
        fs.rmSync(path.join(temp, relative), {force: true});
      }
    };
    const run = (overrides = {}, entry = 'run_cloud_marketing_fallback_slot.sh', timeout = 20_000) => {
      const result = spawnSync('/bin/bash', [path.join(temp, 'scripts', entry)], {
        cwd: temp, env: {...env, ...overrides}, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024,
      });
      assert.equal(result.error, undefined, result.error?.message + '\n' + result.stderr);
      return result;
    };
    const events = () => fs.existsSync(path.join(temp, 'events.log')) ? fs.readFileSync(path.join(temp, 'events.log'), 'utf8') : '';
    const executors = () => events().split('\n').filter(line => line.startsWith('{')).map(JSON.parse).filter(row => row.executor);
    const expectStatus = (result, status) => assert.equal(result.status, status, result.stdout + '\n' + result.stderr);
    const noExecution = bytes => {
      assert.equal(executors().length, 0);
      assert.deepEqual(fs.readFileSync(queueFile), bytes);
      assert.deepEqual(fs.readFileSync(oldQueue), originalOldBytes);
    };
    await check('14:30 primary uses 3600+900 absolute deadlines and actual admission', async () => {
      reset();
      expectStatus(run(), 0);
      assert.equal(executors().length, 1);
      assert.doesNotMatch(events(), /unexpected-systemctl/);
      const args = fs.readFileSync(path.join(temp, 'host-args.log'), 'utf8').trim().split('\n');
      assert.deepEqual(args.slice(0, 2), [String(epoch + 3600), String(epoch + 4500)]);
      assert.equal(args[args.indexOf('--deadline-epoch') + 1], String(epoch + 9000));
      const call = executors()[0].args;
      assert.equal(call[call.indexOf('--graceful-cutoff-epoch') + 1], String(epoch + 3600));
      assert.equal(call[call.indexOf('--outer-hard-deadline-epoch') + 1], String(epoch + 4500));
      assert.equal(readJson(queueFile).stages.highClickSpecial.status, 'completed');
      assert.deepEqual(fs.readFileSync(oldQueue), originalOldBytes);
    });
    await check('real resolver writes and reads canonical result while queue identities stay logical', async () => {
      reset();
      expectStatus(run({SHEIN_BI_OUTPUTS_ROOT: canonicalOutputs}), 0);
      assert.equal(executors().length, 1);
      assert.equal(fs.existsSync(path.join(temp, resultRelative)), false);
      assert.equal(readJson(canonicalResult).totals.processedThisRun, 1);
      const updated = readJson(queueFile);
      assert.equal(updated.stages.highClickSpecial.status, 'completed');
      assert.equal(updated.stages.highClickSpecial.resultPath, resultRelative);
      assert.equal(updated.sourceGuard, queue.sourceGuard);
      assert.equal(updated.sourceGuardHash, queue.sourceGuardHash);
      assert.equal(updated.queueFingerprint, queue.queueFingerprint);
      assert.equal(updated.stages.highClickSpecial.planPath, queue.stages.highClickSpecial.planPath);
      assert.equal(updated.stages.highClickSpecial.workFingerprint, workHash);
      assert.deepEqual(fs.readFileSync(oldQueue), originalOldBytes);
    });
    await check('real resolver rejects symlink result despite valid success bytes', async () => {
      reset();
      const queueBytes = fs.readFileSync(queueFile);
      const result = run({FIXTURE_RESULT_KIND: 'symlink'});
      expectStatus(result, 1);
      assert.match(result.stdout + result.stderr, /Artifact must be a regular file/);
      assert.equal(executors().length, 1);
      assert.equal(readJson(path.join(temp, 'result-target.json')).totals.processedThisRun, 1);
      assert.deepEqual(fs.readFileSync(queueFile), queueBytes);
      assert.deepEqual(fs.readFileSync(oldQueue), originalOldBytes);
    });
    await check('missing result cannot settle or advance the queue', async () => {
      reset(); const before=fs.readFileSync(queueFile);
      const result=run({FIXTURE_RESULT_KIND:'missing'});
      assert.notEqual(result.status,0,result.stdout+result.stderr);
      assert.equal(executors().length,1);
      assert.deepEqual(fs.readFileSync(queueFile),before);
    });
    const manualResultRelative = 'tmp/marketing-signup/manual-limited-discount-restore/' + date + '/manual-limited-discount-restore-result.json';
    const manualResult = path.join(temp, manualResultRelative);
    const manualQueue = {...queue, stages: {highClickSpecial: {status: 'not_required'},
      manualSpecialRestore: {status: 'pending', workFingerprint: workHash, planPath: 'outputs/reports/high-plan.json'},
      driftRepair: {status: 'not_required'}, fallbackRepair: {status: 'not_required'}}};
    const resetManual = () => {
      reset();
      json(queueRelative, manualQueue);
      fs.rmSync(manualResult, {force: true});
    };
    await check('manual executor admission defer without result preserves queue and exits 75', async () => {
      resetManual(); const before = fs.readFileSync(queueFile);
      const result = run({FIXTURE_MANUAL_EXECUTOR_STATUS: '75'});
      expectStatus(result, 75);
      assert.equal(fs.existsSync(manualResult), false);
      assert.deepEqual(fs.readFileSync(queueFile), before);
      assert.doesNotMatch(result.stdout + result.stderr, /ENOENT|Artifact does not exist/);
      const state = readJson(path.join(temp, 'state/cloud_ops_alerts/marketing-repair-last.json'));
      assert.equal(state.status, 'pending');
      assert.match(state.message, /executor deferred with status=75; queue and prior receipts preserved for next service run/);
    });
    await check('manual executor admission defer does not reuse stale result', async () => {
      resetManual();
      const stale = Buffer.from(JSON.stringify({workFingerprint: workHash, dryRunOnly: false,
        results: [{ok: true, storeKey: 'stale'}], processedThisRunResults: [],
        totals: {processed: 1, processedThisRun: 0, resumedItems: 1, remainingItems: 0}}) + '\n');
      write(manualResultRelative, stale);
      const before = fs.readFileSync(queueFile);
      const result = run({FIXTURE_MANUAL_EXECUTOR_STATUS: '75'});
      expectStatus(result, 75);
      assert.deepEqual(fs.readFileSync(queueFile), before);
      assert.deepEqual(fs.readFileSync(manualResult), stale);
      assert.equal(readJson(queueFile).stages.manualSpecialRestore.status, 'pending');
    });
    await check('manual executor ordinary failure remains a failure', async () => {
      resetManual(); const before = fs.readFileSync(queueFile);
      const result = run({FIXTURE_MANUAL_EXECUTOR_STATUS: '1'});
      expectStatus(result, 1);
      assert.equal(fs.existsSync(manualResult), false);
      assert.deepEqual(fs.readFileSync(queueFile), before);
    });
    assert.equal((workerSource.match(/defer_stage_after_executor_status (?:highClickSpecial|manualSpecialRestore|driftRepair|fallbackRepair)/g) || []).length, 4,
      'every stage consumer must handle executor admission defer before reading a result');
    for (const [name,file] of [['guard',guard],['plan',plan]]) {
      await check('missing '+name+' stops before executor', async () => {
        reset(); const before=fs.readFileSync(queueFile), bytes=fs.readFileSync(file);
        try {
          fs.unlinkSync(file); const result=run();
          assert.notEqual(result.status,0,result.stdout+result.stderr); noExecution(before);
        } finally { fs.writeFileSync(file,bytes); }
      });
    }
    await check('real resolver rejects conflicting result namespaces instead of accepting either success', async () => {
      reset();
      const queueBytes = fs.readFileSync(queueFile);
      const row = {ok: true, store: 'S01', state: 'completed'};
      const legacyBytes = Buffer.from(JSON.stringify({workFingerprint: workHash, results: [row], processedThisRunResults: [row],
        totals: {processed: 1, processedThisRun: 1, blocked: 0, failed: 0, remainingItems: 0}, fixture: 'different source view'}) + '\n');
      write(resultRelative, legacyBytes);
      const result = run({SHEIN_BI_OUTPUTS_ROOT: canonicalOutputs});
      expectStatus(result, 1);
      assert.match(result.stdout + result.stderr, /Artifact namespace conflict/);
      assert.equal(executors().length, 1);
      assert.equal(readJson(canonicalResult).totals.processedThisRun, 1);
      assert.deepEqual(fs.readFileSync(path.join(temp, resultRelative)), legacyBytes);
      assert.deepEqual(fs.readFileSync(queueFile), queueBytes);
      assert.deepEqual(fs.readFileSync(oldQueue), originalOldBytes);
    });
    for (const budget of ['900', '14400']) {
      await check('valid explicit primary budget ' + budget, async () => {
        reset(); expectStatus(run({SHEIN_BI_MARKETING_REPAIR_RUN_BUDGET_SEC: budget}), 0);
        assert.equal(executors().length, 1);
        const args = fs.readFileSync(path.join(temp, 'host-args.log'), 'utf8').split('\n');
        assert.deepEqual(args.slice(0, 2), [String(epoch + Number(budget)), String(epoch + Number(budget) + 900)]);
      });
    }
    for (const budget of ['bad', '0', '899', '14401']) {
      await check('invalid primary budget ' + budget, async () => {
        reset(); const before = fs.readFileSync(queueFile);
        const result = run({SHEIN_BI_MARKETING_REPAIR_RUN_BUDGET_SEC: budget});
        expectStatus(result, 64); assert.match(result.stderr, /cloud run budget/);
        assert.equal(fs.existsSync(path.join(temp, 'host-args.log')), false); noExecution(before);
      });
    }
    for (const [hour, minute, expected] of [['14', '30', 75], ['20', '44', 75], ['20', '45', 0], ['21', '00', 75], ['21', '15', 0], ['22', '41', 75]]) {
      await check('no-primary fallback clock gate ' + hour + ':' + minute, async () => {
        reset(); const before = fs.readFileSync(queueFile);
        const now = Math.floor(Date.parse(date + 'T' + hour + ':' + minute + ':00+08:00') / 1000);
        const result = run({SHEIN_BI_MARKETING_CLOUD_PRIMARY_ENABLED: 'false', FIXTURE_HOUR: hour, FIXTURE_MINUTE: minute, FIXTURE_EPOCH: String(now)});
        expectStatus(result, expected);
        if (expected === 0) assert.equal(executors().length, 1);
        else { noExecution(before); assert.equal(fs.existsSync(path.join(temp, 'host-args.log')), false); }
      });
    }
    const directDeadline = {SHEIN_BI_MARKETING_REPAIR_GRACEFUL_CUTOFF_EPOCH: String(epoch + 3600),
      SHEIN_BI_MARKETING_REPAIR_SLOT_HARD_DEADLINE_EPOCH: String(epoch + 4500)};
    for (const [name, overrides] of [
      ['missing pair', {SHEIN_BI_MARKETING_REPAIR_SLOT_HARD_DEADLINE_EPOCH: ''}],
      ['invalid epoch', {SHEIN_BI_MARKETING_REPAIR_GRACEFUL_CUTOFF_EPOCH: 'bad'}],
      ['short finalization', {SHEIN_BI_MARKETING_REPAIR_SLOT_HARD_DEADLINE_EPOCH: String(epoch + 3601)}],
    ]) {
      await check('worker rejects ' + name, async () => {
        reset(); const before = fs.readFileSync(queueFile);
        expectStatus(run({...directDeadline, ...overrides}, 'cloud_marketing_repair_worker.sh'), 64); noExecution(before);
      });
    }
    await check('expired worker deadline forbids executor', async () => {
      reset(); const before = fs.readFileSync(queueFile);
      expectStatus(run({SHEIN_BI_MARKETING_REPAIR_GRACEFUL_CUTOFF_EPOCH: String(epoch - 1000),
        SHEIN_BI_MARKETING_REPAIR_SLOT_HARD_DEADLINE_EPOCH: String(epoch - 100)}, 'cloud_marketing_repair_worker.sh'), 75);
      noExecution(before);
    });
    await check('direct worker preserves no-primary daytime gate', async () => {
      reset(); const before = fs.readFileSync(queueFile);
      const result = run({...directDeadline, SHEIN_BI_MARKETING_CLOUD_PRIMARY_ENABLED: 'false'}, 'cloud_marketing_repair_worker.sh');
      expectStatus(result, 75);
      assert.match(readJson(path.join(temp, 'state/cloud_ops_alerts/marketing-repair-last.json')).message, /outside 20:45-22:55/);
      noExecution(before);
    });
    await check('actual host pressure admission defers before worker', async () => {
      reset(); const before = fs.readFileSync(queueFile);
      const result = run({FIXTURE_PRESSURE_STATUS: '75'});
      expectStatus(result, 75); assert.match(result.stdout + result.stderr, /resource_pressure/); noExecution(before);
    });
    for (const [name, overrides] of [
      ['activation excludes old queue', {SHEIN_BI_MARKETING_REPAIR_DATE: oldDate}],
      ['old date cannot target today', {SHEIN_BI_MARKETING_REPAIR_DATE: oldDate, SHEIN_BI_MARKETING_REPAIR_ACTIVATION_DATE: ''}],
    ]) {
      await check(name, async () => {
        reset(); const before = fs.readFileSync(queueFile);
        const result = run({...directDeadline, ...overrides}, 'cloud_marketing_repair_worker.sh');
        expectStatus(result, 75); assert.match(result.stdout + result.stderr, /predates activation|refusing non-current repair queue/);
        noExecution(before); assert.equal(events(), '');
      });
    }
    await check('actual queue mutation conflict preserves exact pending bytes', async () => {
      reset(); const before = fs.readFileSync(queueFile);
      const lock = queueFile + '.mutation.lock';
      fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'owner'), 'other-owner\n');
      try { const result = run(); expectStatus(result, 75); assert.match(result.stdout + result.stderr, /QUEUE_MUTATION_LOCK_BUSY/); noExecution(before); }
      finally { fs.unlinkSync(path.join(lock, 'owner')); fs.rmdirSync(lock); }
    });
    await check('actual same-task/store lease conflict prevents executor', async () => {
      reset(); const before = fs.readFileSync(queueFile);
      const held = leases.acquireBrowserTaskLease({root: temp, task: 'cloud-marketing-repair', storeKey: stores[0], runId: 'held', ownerPid: process.pid, ttlSec: 300});
      const heldBytes = fs.readFileSync(held.file);
      try {
        const result = run(); assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, /LEASE_ACTIVE/);
        noExecution(before); assert.deepEqual(fs.readFileSync(held.file), heldBytes);
      } finally { leases.releaseBrowserTaskLease({root: temp, task: 'cloud-marketing-repair', storeKey: stores[0], runId: 'held'}); }
    });
    const hold = async file => {
      fs.mkdirSync(path.dirname(file), {recursive: true});
      const child = spawn('flock', ['-x', file, '/bin/bash', '-c', 'printf ready; read -r release'], {stdio: ['pipe', 'pipe', 'pipe']});
      const closed = once(child, 'close');
      holders.push(child);
      const [bytes] = await once(child.stdout, 'data');
      assert.equal(bytes.toString(), 'ready');
      return async () => { child.stdin.end('release\n'); await closed; holders.splice(holders.indexOf(child), 1); };
    };
    for (const [name, files] of [
      ['browser capacity', ['slot0.lock', 'slot1.lock']],
      ['marketing domain', ['state/locks/shein-bi-host-marketing-repair.lock']],
    ]) {
      await check(name + ' contention defers without queue execution', async () => {
        reset(); const before = fs.readFileSync(queueFile); const releases = [];
        try {
          for (const file of files) releases.push(await hold(path.join(temp, file)));
          const result = run(); expectStatus(result, 75); noExecution(before);
          assert.match(result.stdout + result.stderr, /browser_slots_busy|domain_lock_busy/);
        } finally { for (const release of releases.reverse()) await release(); }
      });
    }
    await check('guard hash drift fails before any executor', async () => {
      reset(); const before = fs.readFileSync(queueFile); const bytes = fs.readFileSync(guard);
      try { fs.appendFileSync(guard, ' '); const result = run(); expectStatus(result, 73); noExecution(before); }
      finally { fs.writeFileSync(guard, bytes); }
    });
    await check('existing unit handoff and unchanged fallback timer', async () => {
      assert.match(sources['infra/systemd/shein-bi-cloud-marketing-live-guard.service'], /^OnSuccess=shein-bi-cloud-marketing-repair\.service$/m);
      const repairUnit = sources['infra/systemd/shein-bi-cloud-marketing-repair.service'];
      assert.match(repairUnit, /^Environment=SHEIN_BI_MARKETING_CLOUD_PRIMARY_ENABLED=true$/m);
      assert.match(repairUnit, /^Environment=SHEIN_BI_MARKETING_REPAIR_RUN_BUDGET_SEC=3600$/m);
      assert.match(repairUnit, /^ExecStart=.*run_cloud_marketing_fallback_slot\.sh$/m);
      const calendar = [...sources['infra/systemd/shein-bi-cloud-marketing-repair.timer'].matchAll(/^OnCalendar=(.+)$/gm)].map(row => row[1].trim());
      assert.deepEqual(calendar, ['*-*-* 11..20:45:00', '*-*-* 21:15:00']);
    });
    await check('bound runtime: unexpired consumed scope drift and expired issued to real manual/fallback transactions', async () => {
      const startedAt=Date.now();
      const bound = fs.mkdtempSync('/run/marketing-bound-entry-');
      const mounted = [];
      const command = (name, args) => {
        const result = spawnSync(name, args, {encoding: 'utf8'});
        assert.equal(result.status, 0, result.stderr); return result;
      };
      try {
        for (const domain of ['outputs', 'state']) {
          const physical = path.join(bound, domain);
          fs.cpSync(path.join(temp, domain), physical, {recursive: true});
          command('mount', ['--bind', physical, path.join(temp, domain)]);
          mounted.push(path.join(temp, domain));
          assert.equal(fs.statSync(physical).ino, fs.statSync(path.join(temp, domain)).ino);
        }
        const now = epoch;
        write('fixture-clock.mjs','Date.now=()=>Number(process.env.FIXTURE_EPOCH)*1000;\n');
        json('config/stores.json',{stores:stores.map((storeKey,i)=>({storeKey,enabled:true,port:9200+i}))});
        const guardRel = 'outputs/reports/marketing-daily-guard-'+date+'.json';
        const manualDir = 'tmp/marketing-signup/manual-limited-discount-restore/'+date;
        const priceRel = path.relative(temp, published.priceOverrides);
        const policy = {automationExecution: {enabled:true, authorizationId:'fixture-standing', allowedContexts:['fixture'],
          allowedActions:['restore_manual_special_limited_discount','apply_new_listing_limited_discount_fallback','create_or_replace_limited_discount_activity'],
          storeScope:'all_enabled_stores', perRunPayloadHashRequired:true}};
        json('config/marketing_pricing_policy.json', policy);
        const manualRegistry = json('manual.json', {entries:[{storeKey:'S01',skc:'manual',canonical:'SK-M',specialPrice:25,activityStock:10,
          validFrom:date+' 00:00:00',validTo:date+' 23:59:59',reason:'fixture',sourceThreadId:'fixture',sourceArtifact:'fixture',status:'active'}]});
        const newGuard = {...readJson(guard), manualSpecialLimitedDiscount:{actionCount:1},
          highClickLowConversionSpecial:{actionCount:0}, limitedDiscountTargetPriceDrift:{source:'tmp/live.json',belowRows:[]},
          targetPlanSelection:{...readJson(guard).targetPlanSelection,priceOverrides:priceRel}};
        json(guardRel,newGuard);
        json('outputs/reports/high-click-low-conversion-special-plan-'+date+'.json',
          {reportDate:date,sourceGuard:guardRel,sourceGuardHash:shaFile(path.join(temp,guardRel)),actionCount:0,rows:[]});
        const manualRescue = manualDir+'/manual-limited-restore-S01-manual.json';
        json(manualRescue,{storeKey:'S01',sourceGuard:guardRel,purpose:'manual_special_limited_discount_registry_restore',
          activityStock:10,rows:[{storeKey:'S01',skc:'manual',canonical:'SK-M',limitedDiscountPrice:25,manualSpecialLimitedDiscount:true}]});
        json(manualDir+'/manual-limited-discount-restore-plan.json', {reportDate:date,sourceGuard:guardRel,restoreCount:1,
          rescueFiles:[{storeKey:'S01',skc:'manual',path:manualRescue}]});
        const links = {storeLinks:[{store_key:'S02',skc:'fixture-1',standard_goods_sn:'SK-F',c30_valid_sale_cnt:1,c7_eps_uv:100},
          {store_key:'S03',skc:'fixture-2',standard_goods_sn:'SK-U',c30_valid_sale_cnt:1,c7_eps_uv:100}]};
        const inventory = {products:['SK-F','SK-U'].map(canonical=>({canonical,inventory_match_status:'matched',operational_sellable_qty:1000,operational_snapshot_date:date}))};
        json('outputs/bi-portal/sections/linksData.json',links);
        json('outputs/bi-portal/sections/inventoryTrend.json',inventory);
        const costDoc = {costMap:{'SK-F':10,'SK-U':10}};
        json('tmp/mbrs/marketing-cost-map.json',costDoc);
        const pricing = await import(pathToFileURL(path.join(temp,'lib/marketing_low_et_fast_seller_pricing.mjs')));
        const context = pricing.buildLowEtFastSellerPricingContext({linksDataDoc:links,inventoryTrendDoc:inventory,
          baselineDoc:readJson(published.priceOverrides),costDoc,marketingPolicy:policy,reportDate:date});
        const rescues = [];
        for (const [storeKey,skc,canonical,price] of [['S02','fixture-1','SK-F',25.01],['S03','fixture-2','SK-U',25.02]]) {
          const row = pricing.applyLowEtFastSellerPricePullback({row:{storeKey,skc,canonical,limitedDiscountPrice:price,finalTargetPrice:price,targetPrice:price},context,costDoc}).row;
          const file = 'tmp/fallback-'+storeKey+'.json';
          json(file,{storeKey,createdAt:date+'T00:00:00Z',sourceGuard:guardRel,sourcePriceOverrides:priceRel,
            sourcePriceOverridesSha256:published.priceOverridesHash,purpose:'new_listing_or_relisted_top_treatment_limited_discount_fallback_'+date,
            activityStock:10,rows:[row]});
          rescues.push({storeKey,path:file,count:1});
        }
        json('outputs/reports/new-listing-7d-limited-discount-plan-'+date+'.json',{reportDate:date,sourceGuard:guardRel,
          sourceCurrentMarketingLiveScan:'tmp/live.json',sourcePriceOverrides:priceRel,sourcePriceOverridesSha256:published.priceOverridesHash,rescueFiles:rescues});
        // Keep the actual batch and durable replacement code. Only browser
        // launch/close and the platform's create/readback leaf are substituted.
        for (const [file,entry] of [['batch_restore_manual_limited_discounts.mjs','runManualRestoreBatch'],
          ['batch_apply_new_listing_limited_discount.mjs','runNewListingFallbackBatch']]) {
          const relative='scripts/marketing/'+file;
          write(relative,sources[relative].replace(entry+'().catch',entry+'(undefined, {launchStore:async()=>({ok:true}),closeStore:async()=>({ok:true})}).catch'));
        }
        write('scripts/marketing/apply_hl_limited_discount_rescue.mjs', `
import fs from 'node:fs'; import path from 'node:path';
const args=process.argv.slice(2), val=k=>args[args.indexOf(k)+1], root=process.env.SHEIN_BI_ROOT;
const rescue=JSON.parse(fs.readFileSync(val('--rescue'),'utf8'));
const skc=rescue.rows[0].skc, state=path.join(root,'platform-'+skc+'.json');
if(args.includes('--execute')) {
 fs.appendFileSync(path.join(root,'posts.log'),skc+'\\n');
 if(skc==='fixture-2') process.exit(2);
 fs.writeFileSync(state,'{}');
}
const covered=fs.existsSync(state);
const full={ok:true,alreadyCovered:covered,createdActivityId:covered?12345:null,validation:{invalid:[],missing:[]},
 before:{conflictActivities:[]}, after:{exactReadbackRows:covered?rescue.rows.map(row=>({skc:row.skc,ok:true})):[]},
 createdActivity:covered?{state:2,goods:rescue.rows.map(row=>({skc:row.skc,product_act_price:row.limitedDiscountPrice,attend_num_sum:10}))}:null};
const out=path.join(root,'platform-read-'+skc+'.json'); fs.writeFileSync(out,JSON.stringify(full)); console.log(JSON.stringify({out}));
`);
        const envBound = {...env,FIXTURE_EPOCH:String(now),NODE_OPTIONS:'--import '+path.join(temp,'fixture-clock.mjs'),SHEIN_BI_OUTPUTS_ROOT:path.join(bound,'outputs'),SHEIN_BI_STATE_ROOT:path.join(bound,'state'),
          SHEIN_BI_MARKETING_REPAIR_MAX_GROUPS:'4',SHEIN_BI_MARKETING_POLICY_FILE:path.join(temp,'config/marketing_pricing_policy.json'),
          SHEIN_BI_MARKETING_AUTOMATION_CONTEXT:'fixture',SHEIN_BI_MARKETING_AUTOMATION_AUTHORIZATION:'fixture-standing',
          SHEIN_BI_MANUAL_LIMITED_DISCOUNT_REGISTRY:manualRegistry,SHEIN_BI_MARKETING_CLOUD_WRITE_GATE:'bounded-repair-v1'};
        const runLeaf=(file,args=[],more={})=>spawnSync(process.execPath,[path.join(temp,file),...args],
          {cwd:temp,env:{...envBound,...more},encoding:'utf8',timeout:20000,maxBuffer:2*1024*1024});
        const seed=runLeaf('scripts/marketing/replace_limited_discount_transactionally.mjs',
          ['--store','S03','--port','9222','--rescue',path.join(temp,'tmp/fallback-S03.json'),'--execute'],
          {SHEIN_BI_MARKETING_RUN_PAYLOAD_HASH:hash('old-work-fingerprint')});
        assert.equal(seed.status,2,seed.stderr||seed.stdout);
        const journals=fs.readdirSync(path.join(temp,'state/marketing-replacement-transactions'));
        assert.equal(journals.filter(name=>name.endsWith('.json')).length,1);
        const unknownName=journals.find(name=>name.endsWith('.json'));
        const unknown=readJson(path.join(temp,'state/marketing-replacement-transactions',unknownName));
        assert.equal(unknown.result.status,'submitted_without_exact_readback');
        assert.ok(unknown.createAttempt,'real submit attempt must remain durably recorded');
        write('posts.log','');
        const authDir=path.join(bound,'authority');fs.mkdirSync(authDir,{mode:0o700});
        envBound.SHEIN_BI_MARKETING_IMMEDIATE_AUTHORIZATION_FILE=path.join(authDir,'authorization.json');
        const authorization = await import(pathToFileURL(path.join(temp,'lib/cloud_marketing_immediate_authorization.mjs')));
        const physicalGuard=path.join(bound,'outputs/reports',path.basename(guardRel));
        json(queueRelative,{...queue,sourceGuard:path.relative(temp,physicalGuard),sourceGuardHash:shaFile(physicalGuard)});
        const authOptions={root:temp,date,queueFile,authorizationFile:envBound.SHEIN_BI_MARKETING_IMMEDIATE_AUTHORIZATION_FILE,
          nowEpoch:now-60,timeZone:'Asia/Shanghai'};
        const savedEnv={...process.env};Object.assign(process.env,envBound);
        let consumed;
        try {
          await authorization.issueImmediateAuthorization({...authOptions,sourceGuardFile:physicalGuard,maxGroups:4,ttlSec:3600,
            reason:'bound stale fixture',confirmationToken:authorization.IMMEDIATE_CONFIRMATION_TOKEN});
          consumed=await authorization.consumeImmediateAuthorization({...authOptions,nowEpoch:now-59});
          await authorization.persistImmediateAdmissionQueueSnapshot({...authOptions,nowEpoch:now-58,
            receiptFile:consumed.consumedReceiptFile});
        } finally { for(const key of Object.keys(process.env)) if(!(key in savedEnv)) delete process.env[key]; Object.assign(process.env,savedEnv); }
        const receiptBytes=fs.readFileSync(consumed.consumedReceiptFile);
        assert.ok(JSON.parse(receiptBytes).outerHardDeadlineEpoch>now,'scope drift must not wait for receipt expiry');
        const snapshotFile=consumed.consumedReceiptFile+'.queue-snapshot.json';
        const snapshotBytes=fs.readFileSync(snapshotFile);
        const oldGuardHash=shaFile(physicalGuard);
        json(guardRel,{...newGuard,fixtureScanGeneration:2});
        const freshGuardHash=shaFile(physicalGuard);
        assert.notEqual(freshGuardHash,oldGuardHash);
        const highPlan='outputs/reports/high-click-low-conversion-special-plan-'+date+'.json';
        json(highPlan,{...readJson(path.join(temp,highPlan)),sourceGuardHash:freshGuardHash});
        json(queueRelative,{...queue,queueFingerprint:hash('fresh runtime scan queue'),
          sourceGuard:path.relative(temp,physicalGuard),sourceGuardHash:freshGuardHash});
        assert.notEqual(readJson(queueFile).queueFingerprint,JSON.parse(snapshotBytes).queueFingerprint);
        assert.equal(JSON.parse(snapshotBytes).sourceGuardHash,oldGuardHash);
        // The scan fixture supplies immutable facts/plans. Queue construction,
        // manifest loading, CAS, stage loops and transaction fences are real.
        const scanFixture='run_final_readback() { acquire_repair_artifact_registry_locks || return $?; rebuild_repair_queue_locked; local status=$?; if (( status == 0 )); then refresh_queue_pair_locked; fi; release_repair_artifact_registry_locks; return "$status"; }\nsend_daily_group_report() { :; }\n';
        write('scripts/cloud_marketing_repair_worker.sh',workerSource.replace(anchor,scanFixture+anchor)
          .replace('GUARD_OUT="$ROOT/outputs/reports/marketing-daily-guard-${DATE}.json"','GUARD_OUT="$SHEIN_BI_OUTPUTS_ROOT/reports/marketing-daily-guard-${DATE}.json"'));
        const explicit=run({...envBound,SHEIN_BI_MARKETING_IMMEDIATE_RUN:'true'},'run_cloud_marketing_fallback_slot.sh',60000);
        assert.equal(explicit.status,64,explicit.stderr);
        assert.equal(fs.readFileSync(path.join(temp,'posts.log'),'utf8'),'');
        const first=run(envBound, 'run_cloud_marketing_fallback_slot.sh', 60000);
        assert.ok([0,2,75].includes(first.status),first.stdout+'\n'+first.stderr);
        assert.match(first.stderr,/stale continuation ignored/);
        const finalQueue=readJson(queueFile);
        assert.notEqual(finalQueue.queueFingerprint,queue.queueFingerprint,'fresh real builder must replace old fingerprint');
        assert.equal(finalQueue.stages.manualSpecialRestore.status,'completed',first.stdout+'\n'+first.stderr);
        assert.equal(readJson(path.join(temp,manualDir,'manual-limited-discount-restore-result.json')).totals.remainingItems,0);
        assert.deepEqual(fs.readFileSync(path.join(temp,'posts.log'),'utf8').trim().split('\n'),['manual','fixture-1']);
        const again=run(envBound, 'run_cloud_marketing_fallback_slot.sh', 60000);
        assert.ok([0,2,75].includes(again.status),again.stdout+'\n'+again.stderr);
        assert.deepEqual(fs.readFileSync(path.join(temp,'posts.log'),'utf8').trim().split('\n'),['manual','fixture-1'],'restart must not replay known or unknown submits');
        assert.deepEqual(fs.readFileSync(consumed.consumedReceiptFile),receiptBytes);
        assert.deepEqual(fs.readFileSync(snapshotFile),snapshotBytes);
        // Repeat the same non-empty manual/fallback chain with an expired
        // unconsumed source. It must not switch the worker back to immediate.
        for(const file of [manualDir+'/manual-limited-discount-restore-result.json',
          'outputs/reports/new-listing-7d-limited-discount-execution-summary-'+date+'.json',
          'platform-manual.json','platform-fixture-1.json']) fs.rmSync(path.join(temp,file),{force:true});
        for(const name of fs.readdirSync(path.join(temp,'state/marketing-replacement-transactions'))) {
          if(name.endsWith('.json') && name!==unknownName) fs.unlinkSync(path.join(temp,'state/marketing-replacement-transactions',name));
        }
        write('posts.log','');
        json(queueRelative,{...queue,sourceGuard:path.relative(temp,physicalGuard),sourceGuardHash:shaFile(physicalGuard)});
        Object.assign(process.env,envBound);
        try {
          await authorization.issueImmediateAuthorization({...authOptions,nowEpoch:now-7200,sourceGuardFile:physicalGuard,maxGroups:4,ttlSec:3600,
            reason:'bound stale issued fixture',confirmationToken:authorization.IMMEDIATE_CONFIRMATION_TOKEN});
        } finally { for(const key of Object.keys(process.env)) if(!(key in savedEnv)) delete process.env[key]; Object.assign(process.env,savedEnv); }
        const issuedBytes=fs.readFileSync(authOptions.authorizationFile);
        const issuedRun=run(envBound,'run_cloud_marketing_fallback_slot.sh',60000);
        assert.ok([0,2,75].includes(issuedRun.status),issuedRun.stdout+'\n'+issuedRun.stderr);
        assert.equal(readJson(queueFile).stages.manualSpecialRestore.status,'completed',issuedRun.stdout+'\n'+issuedRun.stderr);
        assert.deepEqual(fs.readFileSync(path.join(temp,'posts.log'),'utf8').trim().split('\n'),['manual','fixture-1']);
        const issuedRestart=run(envBound,'run_cloud_marketing_fallback_slot.sh',60000);
        assert.ok([0,2,75].includes(issuedRestart.status),issuedRestart.stderr);
        assert.deepEqual(fs.readFileSync(path.join(temp,'posts.log'),'utf8').trim().split('\n'),['manual','fixture-1']);
        assert.deepEqual(fs.readFileSync(authOptions.authorizationFile),issuedBytes);
        assert.deepEqual(fs.readFileSync(consumed.consumedReceiptFile),receiptBytes);
        console.log(JSON.stringify({boundChain:true,elapsedMs:Date.now()-startedAt,consumed:true,consumedExpired:false,issued:true,
          realQueueBuilder:true,realBatchAndTransactions:true,unknownReplayed:0,postsPerScenario:2,restartPosts:0}));
      } catch (error) {
        console.error('bound chain failure:', error.stack); throw error;
      } finally {
        for(const directory of mounted.reverse()) command('umount',['--lazy',directory]);
        fs.rmSync(bound,{recursive:true,force:true});
      }
    });
  } finally {
    for (const child of holders) { child.stdin.end('release\n'); child.kill(); }
    assert.ok(path.basename(temp).startsWith('cloud-marketing-primary-entry-') && path.dirname(temp) === os.tmpdir());
    // Registry snapshots deliberately make their directories read-only.
    // Restore owner traversal/removal only inside this verified fixture root.
    const restore = directory => {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      fs.chmodSync(directory, (stat.mode & 0o777) | 0o700);
      for (const name of fs.readdirSync(directory)) restore(path.join(directory, name));
    };
    restore(temp);
    await fsp.rm(temp, {recursive: true, force: true});
    assert.equal(fs.existsSync(temp), false);
  }
  console.log(JSON.stringify({ok: true, checks, isolated: true, cleaned: true}));
}

if (process.platform === 'win32') {
  const run = spawnSync('wsl.exe', ['--cd', '/', '--exec', 'sudo', '-n', 'unshare', '--mount', 'node', '--input-type=module'], {
    input: `await (${runContracts.toString()})(${JSON.stringify(sources)});\n`, encoding: 'utf8', timeout: 180_000, maxBuffer: 3 * 1024 * 1024,
  });
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  if (run.error) throw run.error;
  process.exitCode = run.status ?? 1;
} else {
  const args = ['--mount', process.execPath, '--input-type=module'];
  const run = spawnSync(process.getuid?.() === 0 ? 'unshare' : 'sudo',
    process.getuid?.() === 0 ? args : ['-n', 'unshare', ...args], {
      input: `await (${runContracts.toString()})(${JSON.stringify(sources)});\n`, encoding: 'utf8', timeout: 180_000, maxBuffer: 3 * 1024 * 1024,
    });
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  if (run.error) throw run.error;
  process.exitCode = run.status ?? 1;
}
