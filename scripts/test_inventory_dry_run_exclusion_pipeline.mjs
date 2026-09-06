import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {buildDailyInventoryPlanHashPayload, stableInventoryHash, resolveInventoryIdentityKey} from '../lib/inventory_replenishment_policy.mjs';
import {verifyInventoryDryRun} from '../lib/inventory_dry_run_integrity.mjs';
import {runInventoryMaintenanceJob} from '../lib/cloud_inventory_replenishment_job.mjs';
import {inventoryLogicalActionKey, readInventoryIntentJournals} from '../lib/durable_inventory_write.mjs';
import {fileSha256AndBytes, publishDailyInventoryResultVersion, resolveResultEvidenceArtifact} from './inventory/daily_inventory_version_publisher.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform === 'win32') {
  const mounted = fileURLToPath(import.meta.url).replace(/^([A-Za-z]):/, (_, drive) => '/mnt/' + drive.toLowerCase()).replaceAll('\\', '/');
  const run = spawnSync('wsl.exe', ['--exec', 'node', mounted], {encoding: 'utf8', timeout: 120_000});
  process.stdout.write(run.stdout || ''); process.stderr.write(run.stderr || '');
  if (run.error) throw run.error;
  process.exit(run.status ?? 1);
}
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'inventory-dryrun-pipeline-'));
const today = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());
const businessDate = new Date(Date.parse(today + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
const write = async (file, value) => { await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, JSON.stringify(value)); };
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const guard = await fs.readFile(path.join(repo, 'scripts/cloud_daily_inventory_replenishment_guard.sh'), 'utf8');
const functionBody = name => {
  const start = guard.indexOf(name + '() {');
  assert(start >= 0);
  const endToken = name === 'result_fingerprint' ? '\nNODE\n}\n' : '\n}\n';
  return guard.slice(start, guard.indexOf(endToken, start) + endToken.length);
};
try {
  const root = path.join(temp, 'app');
  await fs.cp(path.join(repo, 'lib'), path.join(root, 'lib'), {recursive: true});
  for (const file of ['config/inventory_replenishment_policy.json', 'config/store_account_truth.json', 'config/product_aliases.json',
    'scripts/check_release_source_state.mjs', 'scripts/validate_daily_operating_refresh.mjs', 'scripts/pipeline_marker.mjs', 'scripts/inventory/execute_daily_inventory_replenishment_plan.mjs', 'scripts/inventory/daily_inventory_version_publisher.mjs']) {
    await fs.mkdir(path.dirname(path.join(root, file)), {recursive: true});
    await fs.copyFile(path.join(repo, file), path.join(root, file));
  }
  const policy = JSON.parse(await fs.readFile(path.join(root, 'config/inventory_replenishment_policy.json')));
  // No listener, socket, HTTP client, or production credentials in this suite.
  const denyNetwork = path.join(temp, 'deny-network.mjs');
  await fs.writeFile(denyNetwork, `import net from 'node:net'; net.Socket.prototype.connect = function(){throw Error('NETWORK_FORBIDDEN')}; global.fetch = () => {throw Error('NETWORK_FORBIDDEN')};`);
  const env = {...process.env, NODE_OPTIONS: '--import=' + denyNetwork, SHEIN_BI_INVENTORY_JOURNAL_DIRS: '',
    SHEIN_BI_INVENTORY_GLOBAL_LOCK_FILE: path.join(temp, 'locks/global.lock'), SHEIN_BI_INVENTORY_SKU_LOCK_DIR: path.join(temp, 'locks/sku'),
    SHEIN_BI_INVENTORY_AUTOMATION_CONTEXT: 'cloud_daily_inventory_replenishment_guard',
    SHEIN_BI_INVENTORY_AUTOMATION_AUTHORIZATION: policy.execution.automaticExecution.authorizationByContext?.cloud_daily_inventory_replenishment_guard || policy.execution.automaticExecution.authorizationId};
  async function fixture(name, exclusions = 1, total = 24, blocked = false, soldOut = false) {
    const dir = path.join(temp, name);
    const commandId = 'fixture-' + name;
    const now = new Date().toISOString();
    const rows = Array.from({length: total}, (_, i) => ({storeKey: 'DL', spu: 'TEST-SPU-' + i, skc: 'TEST-SKC-' + i, skuCode: 'TEST-SKU-' + i,
      canonical: 'TEST-' + (1000 + i), matchKey: resolveInventoryIdentityKey('TEST-' + (1000 + i)),
      ruleClass: 'legacy_virtual_inventory_top_up', targetUsableInventory: 15, etSellableInventory: 15,
      shelfStatusCode: soldOut && i < exclusions ? '3' : '1', sameStoreOnShelfSkcs: [], c7SaleCount: 0, c7Exposure: 0}));
    const plan = {schemaVersion: 'daily-inventory-replenishment-plan/v1', date: today, generatedAt: now,
      commandId, policyVersion: policy.policyVersion, executable: true, blockers: [], actionable: rows,
      lowEtAllocations: [], sourceEvidence: []};
    plan.payloadHash = stableInventoryHash(buildDailyInventoryPlanHashPayload(plan));
    const links = rows.map(row => ({store_key: row.storeKey, skc: row.skc, standard_goods_sn: row.canonical,
      is_on_shelf: row.shelfStatusCode === '1', is_sold_out: row.shelfStatusCode === '3', c7_sale_cnt: 0, c7_eps_uv: 0}));
    for (let i = 0; i < exclusions; i++) links.push({...links[i], skc: 'EXTRA-' + i, is_on_shelf: true, is_sold_out: false});
    const products = rows.map(row => ({standard_goods_sn: row.canonical, current_sellable_quantity: blocked ? 14 : 15,
      et_store_snapshot_date: today, inventory_match_status: 'matched'}));
    await write(path.join(root, 'outputs/bi-portal/sections/inventoryTrend.json'), {generatedAt: now, data: {inventoryDepletion: {products}}});
    await write(path.join(root, 'outputs/bi-portal/sections/linksData.json'), {generatedAt: now, data: {storeLinks: links}});
    await write(path.join(root, 'config/shein_openapi.local.json'), {stores: []});
    const options = {root, inventoryRuntimeRoot: path.join(dir, 'runtime'), date: today, commandId, batchId: commandId,
      stagingPlanFile: path.join(dir, 'command/plans', 'daily-inventory-replenishment-' + today + '.json'),
      stagingResultFile: path.join(dir, 'command/results', 'daily-inventory-replenishment-' + today + '.json'),
      stagingMarkerFile: path.join(dir, 'markers', today, 'daily-inventory-guard.json')};
    await write(options.stagingPlanFile, plan);
    return {options, plan, dir, commandId};
  }
  function runGuardTail(fixture, {execute = false, gateOnly = false} = {}) {
    const {options: o, plan, dir, commandId} = fixture;
    const vars = {ROOT: root, DATE: today, BUSINESS_DATE: businessDate, COMMAND_ID: commandId, BATCH_ID: commandId,
      PLAN: o.stagingPlanFile, RESULT: o.stagingResultFile, MARKER_ROOT: path.join(dir, 'markers'),
      SOURCE_MARKER_ROOT: path.join(dir, 'no-legacy-markers'), BASE_RUNTIME_ROOT: o.inventoryRuntimeRoot,
      RUNTIME_ROOT: path.join(dir, 'command'),
      HASH: plan.payloadHash, TOTAL: String(plan.actionable.length), MAX_ROWS: '1000', RECONCILE_PENDING_ONLY: '0'};
    const start = guard.indexOf('set +e\nEXECUTOR_RECOVERY_ARGS=');
    const end = execute ? guard.length : guard.indexOf('# Exit 75 is the guard', start);
    assert(start > 0 && end > start);
    return spawnSync('bash', ['--noprofile', '--norc'], {cwd: root, env: {...env,
      SHEIN_BI_INVENTORY_COMMAND_ID: commandId, SHEIN_BI_INVENTORY_DRY_RUN: execute ? '0' : '1'}, encoding: 'utf8', timeout: 30_000,
      input: ['set -euo pipefail', ...Object.entries(vars).map(([key, value]) => key + '=' + quote(value)),
        ...['result_fingerprint', 'write_inventory_marker', 'publish_complete_inventory_version', 'pre_warning_audit',
          'publish_audited_inventory_warning', 'result_has_item_warning', 'result_is_readback_pending_only', 'result_is_complete_and_safe'].map(functionBody),
        'trap publish_complete_inventory_version EXIT',
        gateOnly ? 'RESULT_BEFORE_FINGERPRINT=absent\nEXECUTOR_STATUS=0' : 'RESULT_BEFORE_FINGERPRINT="$(result_fingerprint)"',
        guard.slice(gateOnly ? guard.indexOf('if [[ "${SHEIN_BI_INVENTORY_DRY_RUN:-0}" == "1" ]]; then', guard.indexOf('EXECUTOR_STATUS=$?', start)) : start, end)].join('\n')});
  }
  async function project(f, dryRun = true) {
    return runInventoryMaintenanceJob({id: f.commandId, payload: {commandId: f.commandId, date: today, dryRun, maxRows: 1000}},
      {signal: new AbortController().signal, checkLeaseAsync: async () => {}, advanceWriteBoundary: async () => {}},
      {root, inventoryRuntimeRoot: f.options.inventoryRuntimeRoot, platform: 'linux', loadPolicy: async () => policy,
        resolveEvidence: args => resolveResultEvidenceArtifact({...args, batchId: f.commandId}),
        runGuard: async () => { throw Error('published command must not replay'); }});
  }
  for (const [name, excluded, total, soldOut] of [['mixed', 1, 24], ['sold-out', 1, 24, true], ['all-excluded', 24, 24], ['empty', 0, 0]]) {
    const f = await fixture(name, excluded, total, false, soldOut);
    const run = runGuardTail(f);
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const result = JSON.parse(await fs.readFile(f.options.stagingResultFile));
    assert.equal(result.execute, false);
    assert.equal(result.dryRunSummary.ready, total - excluded);
    assert.equal(result.dryRunSummary.excluded, excluded);
    const entry = await resolveResultEvidenceArtifact({inventoryRuntimeRoot: f.options.inventoryRuntimeRoot, date: today, commandId: f.commandId});
    assert.equal(entry.status, 'dry_run_ready');
    assert.equal(entry.counts.ready, total - excluded);
    assert.equal(entry.counts.excluded, excluded);
    assert.equal(entry.counts.updated, 0);
    assert.equal(entry.journalArtifacts.length, 1);
    const projected = await project(f);
    assert.equal(projected.state, 'dry_run_completed');
    assert.equal(projected.ok, true);
    await assert.rejects(project(f, false), /Immutable command mode/);
    const before = await fileSha256AndBytes(f.options.stagingResultFile);
    await publishDailyInventoryResultVersion(f.options);
    assert.deepEqual(await fileSha256AndBytes(f.options.stagingResultFile), before);
    console.log('PASS executor -> guard EXIT -> immutable publisher -> job:', name);
  }
  const blocked = await fixture('all-blocked', 0, 24, true);
  const rejected = runGuardTail(blocked);
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.equal(await resolveResultEvidenceArtifact({inventoryRuntimeRoot: blocked.options.inventoryRuntimeRoot, date: today, commandId: blocked.commandId}), null);
  assert.equal((await fs.readFile(blocked.options.stagingResultFile + '.journal.ndjson', 'utf8')).includes('"kind":"intent"'), false);
  await assert.rejects(project(blocked), error => error.code === 'INVENTORY_GUARD_UNCERTAIN' && error.uncertainWrite === false);
  console.log('PASS unproven all-blocked: failed, zero POST, no completed version');

  // Exercise the real --execute row loop, durable writer, guard warning audit,
  // immutable publication and job projection. Only the transport adapter is
  // replaced; it is in-process fixture data, with every socket forbidden.
  const formal = await fixture('formal-execute', 1, 24);
  const stores = ['CX', 'DL', 'DX', 'FY', 'HL', 'JSH', 'JY', 'LQ', 'MZ', 'NM', 'QH', 'QY', 'TS', 'TZ', 'TZZ', 'XC', 'XL', 'YJ', 'ZL'];
  await write(path.join(root, 'config/stores.json'), {stores: stores.map(storeKey => ({storeKey, enabled: true}))});
  const fetchedAt = formal.plan.generatedAt;
  formal.plan.counts = {enabledStores: 19};
  formal.plan.sourceEvidence = [
    {store: 'ET', file: 'outputs/bi-portal/sections/inventoryTrend.json', fetchedAt, totalEtRows: 24, matchedCurrentDayEtRows: 24},
    {store: 'BI_LINKS', file: 'outputs/bi-portal/sections/linksData.json', fetchedAt},
  ];
  for (const store of stores) {
    const file = path.join(formal.dir, store + '.json');
    await write(file, {storeKey: store, fetchedAt, summary: {stockFailedChunkCount: 0}});
    formal.plan.sourceEvidence.push({store, file, fetchedAt, stockFailedChunkCount: 0, ...(await fileSha256AndBytes(file))});
  }
  formal.plan.payloadHash = stableInventoryHash(buildDailyInventoryPlanHashPayload(formal.plan));
  await write(formal.options.stagingPlanFile, formal.plan);
  await write(path.join(root, 'config/shein_openapi.local.json'), {stores: [{storeKey: 'DL', enabled: true,
    openKeyId: 'fixture-key', secretKey: 'fixture-secret', shopName: 'TEST', profileKey: 'dl', port: 0}]});
  const transportLog = path.join(temp, 'transport.ndjson');
  await fs.writeFile(path.join(root, 'lib/shein_openapi_client.mjs'), `
import fs from 'node:fs/promises';
export const SHEIN_OPENAPI_BASE_URLS = {prodSemiManaged: 'fixture:no-network'};
const rows = ${JSON.stringify(formal.plan.actionable)};
const stock = new Map(rows.map(row => [row.skuCode, 10]));
export class SheinOpenApiClient {
  async assertInventoryFence() {}
  async request(route, options) {
    await fs.appendFile(${JSON.stringify(transportLog)}, JSON.stringify({route, body: options.body}) + '\\n');
    let data;
    if (route.endsWith('/query-store-info')) data = {code: '0', data: {accountNo: 'GS5337922', supplierId: '6720288'}};
    else if (route.endsWith('/spu-info')) {
      const row = rows.find(row => row.spu === options.body.spuName);
      data = {code: '0', info: {skcInfoList: [{skcName: row.skc, supplierCode: row.canonical,
        shelfStatusInfoList: [{siteAbbr: 'shein-sa', shelfStatus: '1'}], skuInfoList: [{skuCode: row.skuCode}]}]}};
    } else if (route.endsWith('/stock-query')) data = {code: '0', info: [{goodsInventory: [{skuList: options.body.skuCodeList.map(skuCode => ({skuCode,
      totalInventoryQuantity: stock.get(skuCode), totalUsableInventory: stock.get(skuCode), totalLockedQuantity: 0,
      temporaryInventoryQuantity: 0, warehouseInventoryList: []}))}]}]};
    else if (route.endsWith('/change-inventory/v2')) {
      const row = options.body.updateSkuInventoryQuantityRequests[0];
      stock.set(row.skuCode, row.changeQuantity); data = {code: '0', info: {success: true}};
    } else throw Error('unexpected fixture route ' + route);
    return {status: 200, ok: true, data};
  }
}
`);
  const formalRun = runGuardTail(formal, {execute: true});
  assert.equal(formalRun.status, 2, formalRun.stderr + formalRun.stdout);
  const formalResult = JSON.parse(await fs.readFile(formal.options.stagingResultFile));
  assert.equal(formalResult.execute, true);
  assert.equal(formalResult.executionMode, 'automatic');
  assert.equal(formalResult.results[0].state, 'pre_submit_blocked');
  assert.equal(formalResult.results.filter(row => row.state === 'updated_readback_matched').length, 23);
  const posts = (await fs.readFile(transportLog, 'utf8')).trim().split('\n').map(JSON.parse).filter(row => row.route.endsWith('/change-inventory/v2'));
  assert.equal(posts.length, 23);
  assert.equal(new Set(posts.map(row => row.body.updateSkuInventoryQuantityRequests[0].skuCode)).size, 23);
  assert(!posts.some(row => row.body.updateSkuInventoryQuantityRequests[0].skuCode === formal.plan.actionable[0].skuCode));
  const formalJournal = formal.options.stagingResultFile + '.journal.ndjson';
  const formalLifecycle = await readInventoryIntentJournals([formalJournal]);
  assert.equal(formalLifecycle.intents.size, 23);
  assert.equal(formalLifecycle.pending.size, 0);
  const formalProjection = await project(formal, false);
  assert.equal(formalProjection.state, 'completed_with_warning');
  assert.equal(formalProjection.counts.updated, 23);
  console.log('PASS actual --execute: excluded first row; 23 distinct fixture POSTs with terminal readback; guard formal validator -> immutable warning -> job');

  const base = await fixture('negative-base', 1, 2);
  assert.equal(runGuardTail(base).status, 0);
  const result = JSON.parse(await fs.readFile(base.options.stagingResultFile));
  const entries = (await fs.readFile(base.options.stagingResultFile + '.journal.ndjson', 'utf8')).trim().split('\n').map(JSON.parse);
  const negatives = [
    ['missing', r => r.results.pop()],
    ['duplicate', r => { r.results[1] = structuredClone(r.results[0]); }],
    ['target', r => { r.results[0].targetUsableInventory++; }],
    ['command', r => { r.commandId = 'other'; }],
    ['hash', r => { r.planHash = 'f'.repeat(64); }],
    ['generic-blocked', r => { r.results[0].state = 'blocked'; }],
    ['forged-reason', r => { r.results[0].preSubmitExclusion.reasonCode = 'allowlisted-string'; }, true],
    ['no-change', r => { r.results[0].preSubmitExclusion.observedOnShelfSkcs = []; }, true],
    ['post-flag', r => { r.results[0].preSubmitExclusion.inventoryPostAttempted = true; }, true],
    ['proof-command', r => { r.results[0].preSubmitExclusion.commandId = 'other'; }, true],
    ['writes', r => { r.results[0].writes = [{}]; }, true],
    ['intent-id', r => { r.results[0].intentId = 'forged'; }, true],
    ['journal-mismatch', r => { r.results[0].error += 'tampered'; }],
    ['no-journal-result', () => {}, false, e => e.pop()],
    ['forged-intent', () => {}, false, e => e.push({kind: 'intent', planHash: base.plan.payloadHash})],
    ['uncertain-post', () => {}, false, e => e.push({kind: 'result', planHash: base.plan.payloadHash, row: {...result.results[1], state: 'suspicious_write_attempted'}})],
  ];
  for (const [name, mutate, matchJournal, mutateEntries] of negatives) {
    const r = structuredClone(result); mutate(r);
    const e = structuredClone(entries);
    if (matchJournal) e[0].row = structuredClone(r.results[0]);
    mutateEntries?.(e);
    const f = await fixture('negative-' + name, 0, 0);
    const journalFile = f.options.stagingResultFile + '.journal.ndjson';
    await fs.mkdir(path.dirname(journalFile), {recursive: true});
    await fs.writeFile(journalFile, e.map(v => JSON.stringify(v)).join('\n') + '\n');
    await assert.rejects(verifyInventoryDryRun({plan: base.plan, result: r, commandId: base.commandId, journalFile}), undefined, name);
    if (['missing', 'duplicate', 'journal-mismatch', 'forged-intent', 'uncertain-post'].includes(name)) {
      f.plan = base.plan; f.commandId = base.commandId; f.options.commandId = base.commandId;
      await write(f.options.stagingPlanFile, base.plan);
      await write(f.options.stagingResultFile, r);
      assert.equal(runGuardTail(f, {gateOnly: true}).status, 1, name + ': guard must reject');
      await write(f.options.stagingMarkerFile, {stage: 'daily-inventory-guard', runDate: today, businessDate,
        status: 'done', ok: true, evidence: await Promise.all([f.options.stagingPlanFile, f.options.stagingResultFile].map(async file => ({
          path: file, ...(await fileSha256AndBytes(file)),
        })))});
      await assert.rejects(publishDailyInventoryResultVersion(f.options), undefined, name + ': publisher must independently reject');
      assert.equal(await resolveResultEvidenceArtifact({inventoryRuntimeRoot: f.options.inventoryRuntimeRoot, date: today, commandId: base.commandId}), null);
    }
  }
  const missingFile = path.join(temp, 'missing-journal', 'result.json.journal.ndjson');
  await assert.rejects(verifyInventoryDryRun({plan: base.plan, result, commandId: base.commandId, journalFile: missingFile}), /ENOENT/);
  for (const scenario of ['pending-other-command', 'terminal-same-plan', 'terminal-same-command']) {
    const f = await fixture('intent-' + scenario, 0, 0);
    const journalFile = f.options.stagingResultFile + '.journal.ndjson';
    await fs.mkdir(path.dirname(journalFile), {recursive: true});
    await fs.writeFile(journalFile, entries.map(v => JSON.stringify(v)).join('\n') + '\n');
    const intent = structuredClone([...formalLifecycle.intents.values()][0]);
    delete intent.journalFile;
    Object.assign(intent, {skc: base.plan.actionable[0].skc, skuCode: base.plan.actionable[0].skuCode});
    intent.before.skuCode = intent.skuCode;
    if (scenario === 'terminal-same-plan') intent.planHash = base.plan.payloadHash;
    if (scenario === 'terminal-same-command') intent.commandId = base.commandId;
    intent.logicalActionKey = inventoryLogicalActionKey(intent);
    intent.idempotencyKey = 'bi-inv-' + intent.logicalActionKey.slice(0, 42);
    Object.assign(intent.request.body.updateSkuInventoryQuantityRequests[0], {skuCode: intent.skuCode, idempotencyKey: intent.idempotencyKey});
    intent.requestPayloadHash = stableInventoryHash(intent.request);
    delete intent.recoveryScopeKey;
    const crossJournal = path.join(path.dirname(journalFile), 'cross-command.journal.ndjson');
    const records = [intent];
    if (scenario.startsWith('terminal')) records.push({kind: 'write_outcome', intentId: intent.intentId,
      logicalActionKey: intent.logicalActionKey, disposition: 'readback_matched', recordedAt: new Date().toISOString()});
    await fs.writeFile(crossJournal, records.map(v => JSON.stringify(v)).join('\n') + '\n');
    const lifecycle = await readInventoryIntentJournals([journalFile, crossJournal]);
    assert.equal(lifecycle.intents.size, 1, 'fixture must contain a valid strict intent');
    assert.equal(lifecycle.pending.size, scenario.startsWith('terminal') ? 0 : 1);
    await assert.rejects(verifyInventoryDryRun({plan: base.plan, result, commandId: base.commandId, journalFile}),
      /related intent|pending scope/, scenario);
  }
  console.log('PASS integrity rejects missing/duplicate/mismatch, forged intent and uncertain POST');
} finally {
  assert(path.dirname(temp) === os.tmpdir() && path.basename(temp).startsWith('inventory-dryrun-pipeline-'));
  await fs.rm(temp, {recursive: true, force: true});
}
