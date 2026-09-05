#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import {buildDailyInventoryPlanHashPayload, computeInventoryOverwriteQuantity, INVENTORY_OVERWRITE_COMPUTATION_VERSION, stableInventoryHash} from '../lib/inventory_replenishment_policy.mjs';
import {appendDurableJournalRecord, inventoryLogicalActionKey, inventoryRecoveryScopeKey, readInventoryIntentJournals, INVENTORY_EXACT_WAREHOUSE_WRITE_PROFILE} from '../lib/durable_inventory_write.mjs';
import {acquireCrossProcessTicketLock} from '../lib/cross_process_ticket_lock.mjs';
import {publishDailyInventoryResultVersion, fileSha256AndBytes, resolveInventoryVersionIndexPath} from './inventory/daily_inventory_version_publisher.mjs';
import {validateInventoryArtifacts} from './validate_daily_operating_refresh.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'v6-sealed-reconciliation-final-'));
const policyFile = path.join(ROOT, 'config/inventory_replenishment_policy.json');
const policy = JSON.parse(await fs.readFile(policyFile, 'utf8'));
const date = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());
const businessDate = new Date(Date.parse(date + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
const authorizationId = 'owner-automatic-inventory-20260803-v1';
const enabledStores = ['ZX', ...Array.from({length: 18}, (_, i) => 'FIXTURE' + i)];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const write = async (file, value) => { await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n'); };
const row = {storeKey: 'ZX', skc: 'ZX-SEALED-SKC', skuCode: 'ZX-SEALED-SKU', spu: 'ZX-SEALED-SPU',
  canonical: 'SK-ZX-SEALED', matchKey: 'SK-ZX-SEALED', targetUsableInventory: 10, ruleClass: 'recent_sale_scarcity',
  etSellableInventory: 11, shelfStatusCode: '1', shelfStatusName: '已上架', openApiShelfStatusCode: '1',
  sameStoreOnShelfSkcs: [], c7SaleCount: 2, c7Exposure: 100};
const stock = (quantity, warehouse = 'WH-SEALED') => ({skuCode: row.skuCode, ok: true, stockRowMissing: false,
  totalInventoryQuantity: quantity, totalUsableInventory: quantity, totalLockedQuantity: 0, temporaryInventoryQuantity: 0,
  warehouseCodes: [warehouse]});
let quantity = 10, warehouse = 'WH-SEALED', postCount = 0, checks = 0;
const server = http.createServer(async (req, res) => {
  for await (const chunk of req) void chunk;
  const send = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
  if (req.url === '/open-api/openapi-business-backend/query-store-info') return send({code: '0', info: {}});
  if (req.url === '/open-api/goods/spu-info') return send({code: '0', info: {supplierCode: row.canonical,
    skcInfoList: [{skcName: row.skc, supplierCode: row.canonical, shelfStatusInfoList: [{siteAbbr: 'shein-sa', shelfStatus: '1'}], skuInfoList: [{skuCode: row.skuCode}]}]}});
  if (req.url === '/open-api/stock/stock-query') return send({code: '0', info: [{goodsInventory: [{skuList: [{
    ...stock(quantity, warehouse), warehouseInventoryList: [{...stock(quantity, warehouse), warehouseCode: warehouse}],
  }]}]}]});
  if (req.url === '/open-api/stock/change-inventory/v2') { postCount++; return send({code: '500', msg: 'POST forbidden by this test'}); }
  res.statusCode = 404; send({code: '404'});
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = 'http://127.0.0.1:' + server.address().port;

async function fixture(runtime, commandId, target = 10) {
  const dir = path.join(runtime, 'runs', date, sha(commandId).slice(0, 40));
  const now = new Date().toISOString();
  const biFile = path.join(dir, 'inventoryTrend.json'), linksFile = path.join(dir, 'linksData.json');
  await write(biFile, {cachedAt: now, data: {inventoryDepletion: {products: [{match_key: row.matchKey,
    current_sellable_quantity: 11, et_store_snapshot_date: date, inventory_match_status: 'matched', et_operational_stock_policy: ''}]}}});
  await write(linksFile, {cachedAt: now, storeLinks: [{store_key: row.storeKey, skc: row.skc, standard_goods_sn: row.canonical, is_on_shelf: true, c7_sale_cnt: 2, c7_eps_uv: 100}]});
  const plan = {schemaVersion: 'daily-inventory-replenishment-plan/v1', commandId, date, policyVersion: policy.policyVersion,
    executable: true, blockers: [], actionable: [{...row, targetUsableInventory: target}], lowEtAllocations: [], counts: {enabledStores: 19},
    sourceEvidence: await Promise.all([[biFile, 'ET'], [linksFile, 'BI_LINKS']].map(async ([file, store]) => ({file, store, fetchedAt: now, sha256: sha(await fs.readFile(file))})))};
  Object.assign(plan.sourceEvidence[0], {totalEtRows: 1, matchedCurrentDayEtRows: 1});
  for (const store of enabledStores) {
    const file = path.join(dir, 'sources', store + '.json');
    await write(file, {fixture: true, store, fetchedAt: now});
    plan.sourceEvidence.push({file, store, fetchedAt: now, stockFailedChunkCount: 0, sha256: sha(await fs.readFile(file))});
  }
  plan.payloadHash = stableInventoryHash(buildDailyInventoryPlanHashPayload(plan));
  const options = {inventoryRuntimeRoot: runtime, root: ROOT, date, batchId: 'batch-' + commandId, commandId,
    stagingPlanFile: path.join(dir, 'plan.json'), stagingResultFile: path.join(dir, 'results', 'daily-inventory-replenishment-' + date + '.json'),
    stagingMarkerFile: path.join(dir, 'markers', date, 'daily-inventory-guard.json')};
  options.stagingJournalFile = options.stagingResultFile + '.journal.ndjson';
  await write(options.stagingPlanFile, plan);
  const configFile = path.join(dir, 'openapi.json');
  await write(configFile, {apiBaseUrls: {prodSemiManaged: baseUrl}, stores: [{storeKey: row.storeKey, enabled: true, openKeyId: 'fixture-key', secretKey: 'fixture-secret'}]});
  await fs.mkdir(path.dirname(options.stagingJournalFile), {recursive: true});
  await fs.writeFile(options.stagingJournalFile, '');
  return {...options, plan, biFile, linksFile, configFile};
}

async function marker(f, result, status) {
  await write(f.stagingResultFile, result);
  await write(f.stagingMarkerFile, {stage: 'daily-inventory-guard', runDate: date, businessDate, completedAt: new Date().toISOString(), ok: true, status,
    evidence: await Promise.all([f.stagingPlanFile, f.stagingResultFile].map(async file => ({path: file, ...await fileSha256AndBytes(file)})))});
}
function intentFor(f) {
  const before = stock(2);
  const logicalActionKey = inventoryLogicalActionKey({commandId: f.commandId, runDate: date, ...row, policyVersion: policy.policyVersion, authorizationId});
  const idempotencyKey = 'bi-inv-' + logicalActionKey.slice(0, 42);
  const request = {pathname: '/open-api/stock/change-inventory/v2', method: 'POST', headers: {language: 'en'}, body: {updateSkuInventoryQuantityRequests: [{
    idempotencyKey, skuCode: row.skuCode, invType: 'VI', changeType: 'OVERWRITE', warehouseCode: 'WH-SEALED',
    changeQuantity: computeInventoryOverwriteQuantity(10, before), changeReason: 'Owner-authorized daily inventory target after current-day ET and sales/exposure guard',
  }]}};
  return {kind: 'intent', intentId: 'intent-' + f.commandId, commandId: f.commandId, logicalActionKey,
    recoveryScopeKey: inventoryRecoveryScopeKey({runDate: date, ...row}), planHash: f.plan.payloadHash, runDate: date,
    storeKey: row.storeKey, skc: row.skc, skuCode: row.skuCode, warehouseCode: 'WH-SEALED', targetUsableInventory: 10,
    policyVersion: policy.policyVersion, inventoryWriteProfile: INVENTORY_EXACT_WAREHOUSE_WRITE_PROFILE,
    overwriteComputationVersion: INVENTORY_OVERWRITE_COMPUTATION_VERSION, authorizationId,
    idempotencyKey, requestPayloadHash: stableInventoryHash(request), request, before, recordedAt: new Date().toISOString()};
}
async function run(f) {
  const args = ['scripts/inventory/execute_daily_inventory_replenishment_plan.mjs', '--plan', f.stagingPlanFile, '--policy', policyFile,
    '--config', f.configFile, '--bi-data', f.biFile, '--links-data', f.linksFile, '--out', f.stagingResultFile,
    '--command-id', f.commandId, '--execute', '--execution-mode', 'automatic', '--confirm-hash', f.plan.payloadHash, '--reconcile-pending-only'];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {cwd: ROOT, env: {...process.env,
      SHEIN_BI_INVENTORY_AUTOMATION_CONTEXT: 'cloud_daily_inventory_replenishment_guard', SHEIN_BI_INVENTORY_AUTOMATION_AUTHORIZATION: authorizationId,
      SHEIN_BI_INVENTORY_GLOBAL_LOCK_FILE: path.join(temp, 'global.lock'), SHEIN_BI_INVENTORY_SKU_LOCK_DIR: path.join(temp, 'sku-locks'),
      SHEIN_BI_INVENTORY_JOURNAL_DIRS: path.join(f.inventoryRuntimeRoot, 'runs')}, stdio: ['ignore', 'pipe', 'pipe']});
    let stderr = '', stdout = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    const timer = setTimeout(() => child.kill(), 20000);
    child.once('error', reject); child.once('close', code => { clearTimeout(timer); resolve({code, stderr, stdout}); });
  });
}
async function remember(entry, runtime) {
  const files = Object.values(entry.artifacts).flatMap(a => [a.file, path.resolve(runtime, a.snapshot)]);
  files.push(entry.artifacts.journal.file + '.sealed.json');
  for (const a of [...entry.sourceArtifacts, ...entry.journalArtifacts]) files.push(path.resolve(runtime, a.snapshot));
  return new Map(await Promise.all(files.map(async file => [file, await fs.readFile(file)])));
}
async function unchanged(saved) { for (const [file, bytes] of saved) assert.deepEqual(await fs.readFile(file), bytes, path.basename(file)); }
async function validateWarning(f, old, originalResult, name) {
  // Use the real pre-publication warning validator with exact evidence copies.
  // This root has no runs ancestor, so only the explicitly bound old journal
  // and this current journal can participate in the audit.
  const runtime = path.join(temp, 'validation-' + name);
  const v = {...f, inventoryRuntimeRoot: runtime,
    stagingPlanFile: path.join(runtime, 'plans', 'daily-inventory-replenishment-' + date + '.json'),
    stagingResultFile: path.join(runtime, 'results', 'daily-inventory-replenishment-' + date + '.json'),
    stagingMarkerFile: path.join(runtime, 'markers', date, 'daily-inventory-guard.json')};
  v.stagingJournalFile = v.stagingResultFile + '.journal.ndjson';
  await write(v.stagingPlanFile, f.plan);
  const originalEntries = (await fs.readFile(f.stagingJournalFile, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const prior = process.env.SHEIN_BI_INVENTORY_JOURNAL_DIRS;
  process.env.SHEIN_BI_INVENTORY_JOURNAL_DIRS = path.dirname(old.stagingJournalFile);
  const audit = () => validateInventoryArtifacts({root: ROOT, inventoryRuntimeRoot: runtime,
    markerRoot: path.join(runtime, 'markers'), runDate: date, businessDate, enabledStores, preWarningAudit: true});
  const prepare = async (mutate = () => {}, mutateEntries = () => {}) => {
    const result = structuredClone(originalResult), entries = structuredClone(originalEntries);
    mutate(result);
    for (const entry of entries) if (entry.kind === 'result') entry.row = structuredClone(result.results[0]);
    mutateEntries(entries);
    await marker(v, result, 'warning');
    await fs.writeFile(v.stagingJournalFile, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  };
  try {
    await prepare();
    const accepted = await audit();
    assert.equal(accepted.ok, true);
    assert.equal(accepted.warningCount, 1);
    assert.equal(accepted.pendingCount, name === 'pending' ? 1 : 0);
    checks++;
    for (const [label, mutate] of [
      ['wrong-command', r => { r.results[0].historicalCommandId = 'unrelated'; }],
      ['wrong-source', r => { r.results[0].historicalJournalFile = v.stagingJournalFile; }],
      ['wrong-old-target', r => { r.results[0].historicalTargetUsableInventory++; }],
      ['missing-raw-field', r => { delete r.results[0].before.totalLockedQuantity; }],
      ['wrong-warehouse', r => { r.results[0].before.warehouseCodes = ['OTHER']; }],
      ['unexpected-write', r => { r.results[0].writes = [{success: true}]; }],
    ]) {
      await prepare(mutate);
      await assert.rejects(audit(), /inventory result lacks exact terminal readback/, label);
      checks++;
    }
    await prepare(() => {}, entries => { entries.splice(entries.findIndex(e => e.kind === 'result'), 1); });
    await assert.rejects(audit(), /exact result journal evidence missing/); checks++;
    if (name === 'different-target') {
      await prepare(r => { r.unresolvedIntents = [{intentId: r.results[0].historicalIntentId, state: 'pending'}]; });
      await assert.rejects(audit(), /not bound to one exact pending warning journal intent/); checks++;
      await prepare(() => {}, entries => { entries.find(e => e.kind === 'cross_journal_resolution').sourceSha256 = '0'.repeat(64); });
      await assert.rejects(audit(), /cross.journal|source|sha256|hash/i); checks++;
    }
    await prepare();
    assert.equal((await audit()).ok, true);
  } finally {
    if (prior === undefined) delete process.env.SHEIN_BI_INVENTORY_JOURNAL_DIRS;
    else process.env.SHEIN_BI_INVENTORY_JOURNAL_DIRS = prior;
  }
}
let complete = false;
try {
  for (const [name, current, target, expected, status] of [
    ['same-target', 10, 10, 'skipped_target_already_matched', 'done'],
    ['different-target', 10, 20, 'historical_readback_matched', 'warning'],
    ['pending', 9, 10, 'submitted_but_readback_pending', 'warning'],
    ['warehouse-drift', 10, 10, 'needs_manual_resolve', null],
  ]) {
    const runtime = path.join(temp, name);
    const old = await fixture(runtime, 'old-' + name);
    const intent = intentFor(old);
    await appendDurableJournalRecord(old.stagingJournalFile, intent);
    await marker(old, {planHash: old.plan.payloadHash, execute: true, executionMode: 'automatic', generatedAt: new Date().toISOString(), results: [{...row, state: 'submitted_but_readback_pending'}]}, 'warning');
    const oldEntry = await publishDailyInventoryResultVersion(old);
    const saved = await remember(oldEntry, runtime);
    assert.equal((await publishDailyInventoryResultVersion(old)).version, 1);
    await assert.rejects(appendDurableJournalRecord(old.stagingJournalFile, {kind: 'result'}), /INVENTORY_JOURNAL_SEALED/);
    const f = await fixture(runtime, 'new-' + name, target);
    quantity = current; warehouse = name === 'warehouse-drift' ? 'OTHER-WAREHOUSE' : 'WH-SEALED';
    const attempt = await run(f);
    assert.equal(attempt.code, expected === 'skipped_target_already_matched' ? 0 : 1, attempt.stderr + attempt.stdout);
    const result = await json(f.stagingResultFile);
    assert.equal(result.results[0].state, expected, JSON.stringify(result.results));
    assert.equal(postCount, 0);
    if (status) {
      await marker(f, result, status);
      if (status === 'warning') await validateWarning(f, old, result, name);
      const entry = await publishDailyInventoryResultVersion(f);
      assert.equal(entry.version, 2); assert.equal(entry.status, status);
      const bundle = await readInventoryIntentJournals([old.stagingJournalFile, f.stagingJournalFile], {maxRunDate: date});
      assert.equal(bundle.pending.size, expected === 'submitted_but_readback_pending' ? 1 : 0);
      const lines = (await fs.readFile(f.stagingJournalFile, 'utf8')).trim().split('\n').map(JSON.parse);
      const resolution = lines.find(e => e.kind === 'cross_journal_resolution');
      if (current === 10) { assert.equal(resolution.sourceSha256, sha(saved.get(old.stagingJournalFile))); assert.equal(resolution.event.intentId, intent.intentId); }
      else assert.equal(resolution, undefined);
      assert.equal(lines.filter(e => e.kind === 'intent').length, 0);
      assert.equal((await publishDailyInventoryResultVersion(old)).version, 1);
    }
    await unchanged(saved);
    // Same command with a changed plan cannot borrow the foreign-batch path.
    const drift = await fixture(runtime, old.commandId + '-probe');
    drift.commandId = old.commandId; drift.plan.commandId = old.commandId;
    drift.plan.actionable[0].targetUsableInventory = 30;
    drift.plan.payloadHash = stableInventoryHash(buildDailyInventoryPlanHashPayload(drift.plan));
    await write(drift.stagingPlanFile, drift.plan);
    const rejected = await run(drift); assert.notEqual(rejected.code, 0); assert.equal(postCount, 0);
    await unchanged(saved); checks++;
  }
  const malformedRuntime = path.join(temp, 'malformed');
  const malformedOld = await fixture(malformedRuntime, 'malformed-old');
  const malformedIntent = intentFor(malformedOld);
  malformedIntent.requestPayloadHash = '0'.repeat(64);
  await fs.writeFile(malformedOld.stagingJournalFile, JSON.stringify(malformedIntent) + '\n');
  const malformedNew = await fixture(malformedRuntime, 'malformed-new');
  const malformedAttempt = await run(malformedNew);
  assert.notEqual(malformedAttempt.code, 0);
  assert.match(malformedAttempt.stderr + malformedAttempt.stdout, /requestPayloadHash|immutable|journal/i);
  assert.equal(postCount, 0); checks++;
  // A publisher must wait on a foreign journal's real append ticket. A
  // publication of the opposite current journal must use the same lock order.
  const runtime = path.join(temp, 'concurrency');
  const a = await fixture(runtime, 'a'), b = await fixture(runtime, 'b');
  for (const f of [a, b]) await marker(f, {planHash: f.plan.payloadHash, execute: true, executionMode: 'automatic', generatedAt: new Date().toISOString(), results: [{...row, state: 'skipped_target_already_matched', before: stock(10)}]}, 'done');
  const release = await acquireCrossProcessTicketLock(b.stagingJournalFile + '.publication.lock');
  let published = false;
  const publishing = publishDailyInventoryResultVersion(a).then(v => { published = true; return v; });
  await delay(100);
  assert.equal(published, false); assert.equal(await fs.access(resolveInventoryVersionIndexPath(runtime, date)).then(() => true, () => false), false);
  const append = appendDurableJournalRecord(b.stagingJournalFile, {kind: 'result', sequence: 1, planHash: b.plan.payloadHash, recordedAt: new Date().toISOString(), row: {...row, state: 'skipped_target_already_matched', before: stock(10)}});
  await release();
  const first = await publishing; await append;
  // Snapshot has a complete prefix, even when a later append is admitted.
  const foreign = first.journalArtifacts.find(x => x.file === b.stagingJournalFile);
  const bytes = await fs.readFile(path.join(runtime, foreign.snapshot));
  for (const line of bytes.toString().trim().split('\n').filter(Boolean)) JSON.parse(line);
  assert.equal(sha(bytes), foreign.sha256);
  await Promise.all([publishDailyInventoryResultVersion(a), publishDailyInventoryResultVersion(b)]);
  assert.equal((await json(resolveInventoryVersionIndexPath(runtime, date))).batches.length, 2);
  checks++;
  // Separate indexes cannot serialize these publishers for us. Both discover
  // the same journals with opposite current files and must finish without ABBA.
  const left = await fixture(path.join(temp, 'opposite-index-left'), 'left');
  const right = await fixture(path.join(temp, 'opposite-index-right'), 'right');
  for (const f of [left, right]) await marker(f, {planHash: f.plan.payloadHash, execute: true,
    executionMode: 'automatic', generatedAt: new Date().toISOString(),
    results: [{...row, state: 'skipped_target_already_matched', before: stock(10)}]}, 'done');
  const priorJournalDirs = process.env.SHEIN_BI_INVENTORY_JOURNAL_DIRS;
  process.env.SHEIN_BI_INVENTORY_JOURNAL_DIRS = [left, right].map(f => path.join(f.inventoryRuntimeRoot, 'runs')).join(path.delimiter);
  try {
    const entries = await Promise.all([publishDailyInventoryResultVersion(left), publishDailyInventoryResultVersion(right)]);
    for (const entry of entries) {
      assert.equal(entry.version, 1);
      assert.equal(entry.journalArtifacts.length, 2);
    }
    checks++;
  } finally {
    if (priorJournalDirs === undefined) delete process.env.SHEIN_BI_INVENTORY_JOURNAL_DIRS;
    else process.env.SHEIN_BI_INVENTORY_JOURNAL_DIRS = priorJournalDirs;
  }
  complete = true;
  console.log(JSON.stringify({ok: true, checks, inventoryPosts: postCount, sealedBytesPreserved: true, realExecutor: true, realPublicationTickets: true}));
} finally {
  await new Promise(resolve => server.close(resolve));
  if (complete) await fs.rm(temp, {recursive: true, force: true});
  else console.error('Retained failed fixture: ' + temp);
}
