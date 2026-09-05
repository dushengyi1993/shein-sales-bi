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
if (process.env.FIXTURE_RESULT_KIND === 'symlink') {
  const target = path.join(root, 'result-target.json');
  fs.writeFileSync(target, resultBytes);
  fs.symlinkSync(target, value('--result'));
} else {
  fs.writeFileSync(value('--result'), resultBytes);
}
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
    const env = {PATH: path.join(temp, 'bin') + ':/usr/bin:/bin', HOME: temp, TZ: 'Asia/Shanghai',
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
    const run = (overrides = {}, entry = 'run_cloud_marketing_fallback_slot.sh') => {
      const result = spawnSync('/bin/bash', [path.join(temp, 'scripts', entry)], {
        cwd: temp, env: {...env, ...overrides}, encoding: 'utf8', timeout: 20_000, maxBuffer: 2 * 1024 * 1024,
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
      assert.deepEqual(calendar, ['*-*-* 20:45:00', '*-*-* 21:15:00']);
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
  const run = spawnSync('wsl.exe', ['--cd', '/', '--exec', 'node', '--input-type=module'], {
    input: `await (${runContracts.toString()})(${JSON.stringify(sources)});\n`, encoding: 'utf8', timeout: 180_000, maxBuffer: 3 * 1024 * 1024,
  });
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  if (run.error) throw run.error;
  process.exitCode = run.status ?? 1;
} else {
  await runContracts(sources);
}
