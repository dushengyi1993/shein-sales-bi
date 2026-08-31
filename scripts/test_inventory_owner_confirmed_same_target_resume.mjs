#!/usr/bin/env node
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildDailyInventoryPlanHashPayload, computeInventoryOverwriteQuantity, INVENTORY_OVERWRITE_COMPUTATION_VERSION, stableInventoryHash} from '../lib/inventory_replenishment_policy.mjs';
import {inventoryRecoveryScopeKey, readInventoryIntentJournals} from '../lib/durable_inventory_write.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLICY_FILE = path.join(ROOT, 'config', 'inventory_replenishment_policy.json');
const policy = JSON.parse(await fs.readFile(POLICY_FILE, 'utf8'));
const today = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());
const oldDate = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date(Date.now() - 15 * 86_400_000));
const authorizationId = 'owner-automatic-inventory-20260803-v1';

const rows = [
  {storeKey: 'JY', skc: 'JY-SAME-TARGET-SKC', skuCode: 'JY-SAME-TARGET-SKU', spu: 'JY-SAME-TARGET-SPU', canonical: 'SK-JY-SAME-TARGET', supplierCode: 'SK-JY-SAME-TARGET', matchKey: 'SK-JY-SAME-TARGET', targetUsableInventory: 10, ruleClass: 'recent_sale_scarcity', etSellableInventory: 11, shelfStatusCode: '1', shelfStatusName: '已上架', openApiShelfStatusCode: '1', sameStoreOnShelfSkcs: [], c7SaleCount: 2, c7Exposure: 100},
  {storeKey: 'NM', skc: 'NM-SAME-TARGET-SKC', skuCode: 'NM-SAME-TARGET-SKU', spu: 'NM-SAME-TARGET-SPU', canonical: 'SK-NM-SAME-TARGET', supplierCode: 'SK-NM-SAME-TARGET', matchKey: 'SK-NM-SAME-TARGET', targetUsableInventory: 10, ruleClass: 'recent_sale_scarcity', etSellableInventory: 11, shelfStatusCode: '1', shelfStatusName: '已上架', openApiShelfStatusCode: '1', sameStoreOnShelfSkcs: [], c7SaleCount: 2, c7Exposure: 100},
  {storeKey: 'QH', skc: 'QH-DRIFT-ABOVE-TARGET-SKC', skuCode: 'QH-DRIFT-ABOVE-TARGET-SKU', spu: 'QH-DRIFT-ABOVE-TARGET-SPU', canonical: 'SK-QH-DRIFT-ABOVE-TARGET', supplierCode: 'SK-QH-DRIFT-ABOVE-TARGET', matchKey: 'SK-QH-DRIFT-ABOVE-TARGET', targetUsableInventory: 10, ruleClass: 'recent_sale_scarcity', etSellableInventory: 11, shelfStatusCode: '1', shelfStatusName: '已上架', openApiShelfStatusCode: '1', sameStoreOnShelfSkcs: [], c7SaleCount: 2, c7Exposure: 100},
];
const rejectedRow = {storeKey: 'JSH', skc: 'JSH-SAME-TARGET-SKC', skuCode: 'JSH-SAME-TARGET-SKU', spu: 'JSH-SAME-TARGET-SPU', canonical: 'SK-JSH-SAME-TARGET', supplierCode: 'SK-JSH-SAME-TARGET', matchKey: 'SK-JSH-SAME-TARGET', targetUsableInventory: 10, ruleClass: 'recent_sale_scarcity', etSellableInventory: 11, shelfStatusCode: '1', shelfStatusName: '已上架', openApiShelfStatusCode: '1', sameStoreOnShelfSkcs: [], c7SaleCount: 2, c7Exposure: 100};

function actionKey(runDate, row) {
  return stableInventoryHash({runDate, store: row.storeKey, skc: row.skc, sku: row.skuCode, target: 10, actionType: 'VI_OVERWRITE_TO_EXACT_USABLE_TARGET', policyVersion: policy.policyVersion, authorizationId});
}

function makeIntent(runDate, row, intentId) {
  const logicalActionKey = actionKey(runDate, row);
  const before = {skuCode: row.skuCode, totalInventoryQuantity: 2, totalUsableInventory: 2, totalLockedQuantity: 0, stockRowMissing: false, warehouseCodes: []};
  const request = {pathname: '/open-api/stock/change-inventory/v2', method: 'POST', body: {updateSkuInventoryQuantityRequests: [{idempotencyKey: 'bi-inv-' + logicalActionKey.slice(0, 42), skuCode: row.skuCode, invType: 'VI', changeType: 'OVERWRITE', changeQuantity: computeInventoryOverwriteQuantity(10, before), changeReason: 'Owner-authorized daily inventory target after current-day ET and sales/exposure guard'}]}, headers: {language: 'en'}};
  return {kind: 'intent', intentId, logicalActionKey, recoveryScopeKey: inventoryRecoveryScopeKey({runDate, storeKey: row.storeKey, skc: row.skc, skuCode: row.skuCode}), planHash: 'd'.repeat(64), runDate, storeKey: row.storeKey, skc: row.skc, skuCode: row.skuCode, targetUsableInventory: 10, policyVersion: policy.policyVersion, overwriteComputationVersion: INVENTORY_OVERWRITE_COMPUTATION_VERSION, authorizationId, idempotencyKey: request.body.updateSkuInventoryQuantityRequests[0].idempotencyKey, requestPayloadHash: stableInventoryHash(request), request, before, recordedAt: runDate + 'T01:00:00.000Z'};
}

function makePlan(sourceEvidence) {
  const body = {schemaVersion: 'daily-inventory-replenishment-plan/v1', date: today, policyVersion: policy.policyVersion, executable: true, blockers: [], actionable: rows, lowEtAllocations: [], sourceEvidence};
  return {...body, payloadHash: stableInventoryHash(buildDailyInventoryPlanHashPayload(body))};
}

function makeOwnerConfirmedOutcome(intent, {newRunDate = today, freshUsableInventory = 9} = {}) {
  return {
    kind: 'write_outcome',
    intentId: intent.intentId,
    logicalActionKey: intent.logicalActionKey,
    disposition: 'superseded_by_owner_confirmed_same_target',
    oldRunDate: intent.runDate,
    newRunDate,
    targetUsableInventory: 10,
    freshUsableInventory,
    originalEffectUnknown: true,
    ownerConfirmationText: '补到10',
    recordedAt: new Date().toISOString(),
  };
}

async function writeJson(file, value) { await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8'); }
function runNode(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {cwd: ROOT, env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject); child.once('close', code => resolve({code, stdout, stderr}));
  });
}

function sendJson(response, payload, status = 200) { response.writeHead(status, {'content-type': 'application/json'}); response.end(JSON.stringify(payload) + '\n'); }
const state = {postCount: 0, postBodies: [], stock: new Map([[rows[0].skuCode, 9], [rows[1].skuCode, 10], [rows[2].skuCode, 11], [rejectedRow.skuCode, 11]])};
const server = http.createServer((request, response) => {
  let raw = '';
  request.on('data', chunk => { raw += chunk; });
  request.on('end', () => {
    let body = null; try { body = raw ? JSON.parse(raw) : null; } catch {}
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (request.method === 'POST' && pathname === '/open-api/openapi-business-backend/query-store-info') {
      const storeKey = String(request.headers['x-lt-openkeyid'] || '').split('-')[0];
      const identity = {
        JY: {accountNo: 'GS3092013', merchantId: '12840307'},
        NM: {accountNo: 'GS5159206', merchantId: '6745755'},
        QH: {accountNo: 'GS8715910', merchantId: '12840338'},
      }[storeKey] || {};
      return sendJson(response, {code: '0', info: identity});
    }
    if (request.method === 'POST' && pathname === '/open-api/goods/spu-info') {
      const row = rows.find(candidate => candidate.spu === body?.spuName);
      if (!row) return sendJson(response, {code: '404', msg: 'unknown spu'});
      return sendJson(response, {code: '0', info: {supplierCode: row.canonical, skcInfoList: [{skcName: row.skc, supplierCode: row.canonical, shelfStatusInfoList: [{siteAbbr: 'shein-sa', shelfStatus: '1'}], skuInfoList: [{skuCode: row.skuCode}]}]}});
    }
    if (request.method === 'POST' && pathname === '/open-api/stock/stock-query') {
      const skuCode = body?.skuCodeList?.[0] || ''; const usable = Number(state.stock.get(skuCode) ?? 2);
      return sendJson(response, {code: '0', info: [{goodsInventory: [{skuList: [{skuCode, totalInventoryQuantity: usable, totalUsableInventory: usable, totalLockedQuantity: 0, warehouseInventoryList: []}]}]}]});
    }
    if (request.method === 'POST' && pathname === '/open-api/stock/change-inventory/v2') {
      state.postCount += 1; state.postBodies.push(body);
      const requestRow = body?.updateSkuInventoryQuantityRequests?.[0]; state.stock.set(requestRow?.skuCode, Number(requestRow?.changeQuantity));
      return sendJson(response, {code: '0', info: {success: true}});
    }
    return sendJson(response, {code: '404', msg: pathname}, 404);
  });
});

const port = await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'inventory-owner-same-target-'));
try {
  const resultsDir = path.join(temp, 'runtime', 'results'); const plansDir = path.join(temp, 'runtime', 'plans');
  await fs.mkdir(resultsDir, {recursive: true}); await fs.mkdir(plansDir, {recursive: true});
  const fetchedAt = new Date().toISOString();
  const evidence = [{store: 'ET', fetchedAt, file: path.join(temp, 'inventoryTrend.json')}, {store: 'BI_LINKS', fetchedAt, file: path.join(temp, 'linksData.json')}];
  const plan = makePlan(evidence);
  const planFile = path.join(plansDir, 'daily-inventory-replenishment-' + today + '.json');
  const resultFile = path.join(resultsDir, 'daily-inventory-replenishment-' + today + '.json');
  const oldJournal = path.join(resultsDir, 'daily-inventory-replenishment-' + oldDate + '.json.journal.ndjson');
  const currentJournal = resultFile + '.journal.ndjson';
  const biFile = path.join(temp, 'inventoryTrend.json'); const linksFile = path.join(temp, 'linksData.json'); const configFile = path.join(temp, 'openapi.json');
  await writeJson(planFile, plan);
  await writeJson(biFile, {cachedAt: fetchedAt, data: {inventoryDepletion: {products: rows.map(row => ({match_key: row.matchKey, current_sellable_quantity: row.etSellableInventory, et_store_snapshot_date: today, inventory_match_status: 'matched', et_operational_stock_policy: ''}))}}});
  await writeJson(linksFile, {cachedAt: fetchedAt, storeLinks: rows.map(row => ({store_key: row.storeKey, skc: row.skc, standard_goods_sn: row.canonical, is_on_shelf: true, c7_sale_cnt: row.c7SaleCount, c7_eps_uv: row.c7Exposure}))});
  await writeJson(configFile, {apiBaseUrls: {prodSemiManaged: 'http://127.0.0.1:' + port}, stores: rows.map(row => ({storeKey: row.storeKey, enabled: true, openKeyId: row.storeKey + '-key', secretKey: row.storeKey + '-secret'}))});
  const oldJY = makeIntent(oldDate, rows[0], 'old-jy-owner-confirmed-same-target');
  const oldNM = makeIntent(oldDate, rows[1], 'old-nm-owner-confirmed-same-target');
  const oldQH = makeIntent(oldDate, rows[2], 'old-qh-owner-confirmed-same-target');
  const oldRejected = makeIntent(oldDate, rejectedRow, 'old-jsh-owner-confirmed-same-target');
  await fs.writeFile(oldJournal, JSON.stringify(oldJY) + '\n' + JSON.stringify(oldNM) + '\n' + JSON.stringify(oldQH) + '\n' + JSON.stringify(oldRejected) + '\n', 'utf8');
  const resolverArgs = (row, intent, fresh) => [
    'scripts/inventory/resolve_inventory_intent_for_owner_confirmed_same_target.mjs',
    '--journal', currentJournal,
    '--journal-dir', resultsDir,
    '--store', row.storeKey,
    '--skc', row.skc,
    '--sku', row.skuCode,
    '--intent-id', intent.intentId,
    '--old-run-date', intent.runDate,
    '--new-run-date', today,
    '--fresh-usable', String(fresh),
    '--fresh-store', row.storeKey,
    '--fresh-skc', row.skc,
    '--fresh-sku', row.skuCode,
    '--fresh-inv-type', 'VI',
    '--owner-confirmation-text', '补到10',
  ];
  const journalBeforeBindingChecks = await fs.readFile(oldJournal, 'utf8');
  const wrongIntent = resolverArgs(rows[0], oldJY, 9);
  wrongIntent[wrongIntent.indexOf('--intent-id') + 1] = 'wrong-intent-id';
  const rejectWrongIntent = await runNode([...wrongIntent, '--execute']);
  assert.notEqual(rejectWrongIntent.code, 0);
  assert.match(rejectWrongIntent.stderr, /INVENTORY_OWNER_CONFIRMED_SAME_TARGET_INTENT_INVALID/);
  const wrongOldDate = resolverArgs(rows[0], oldJY, 9);
  wrongOldDate[wrongOldDate.indexOf('--old-run-date') + 1] = new Date(Date.parse(oldDate + 'T00:00:00Z') - 86_400_000).toISOString().slice(0, 10);
  const rejectWrongOldDate = await runNode([...wrongOldDate, '--execute']);
  assert.notEqual(rejectWrongOldDate.code, 0);
  assert.match(rejectWrongOldDate.stderr, /INVENTORY_OWNER_CONFIRMED_SAME_TARGET_RUN_DATE_INVALID/);
  assert.equal(await fs.readFile(oldJournal, 'utf8'), journalBeforeBindingChecks, 'intent/date binding failures must append nothing');
  const resolveNine = await runNode([...resolverArgs(rows[0], oldJY, 9), '--execute']);
  assert.equal(resolveNine.code, 0, resolveNine.stderr);
  const resolvedNine = JSON.parse(resolveNine.stdout);
  assert.equal(resolvedNine.disposition, 'superseded_by_owner_confirmed_same_target');
  assert.equal(resolvedNine.originalEffectUnknown, true);
  const resolveQHNine = await runNode([...resolverArgs(rows[2], oldQH, 9), '--execute']);
  assert.equal(resolveQHNine.code, 0, resolveQHNine.stderr);
  const journalBeforeEleven = await fs.readFile(oldJournal, 'utf8');
  const rejectEleven = await runNode([...resolverArgs(rejectedRow, oldRejected, 11), '--execute']);
  assert.notEqual(rejectEleven.code, 0, 'fresh usable 11 must be rejected before journal mutation');
  assert.match(rejectEleven.stderr, /--fresh-usable must be an integer below 10/);
  assert.equal(await fs.readFile(oldJournal, 'utf8'), journalBeforeEleven, 'fresh 11 rejection must append no outcome');
  assert.equal(state.postCount, 0, 'resolver 11 rejection must make zero inventory POSTs');
  const afterResolve = await readInventoryIntentJournals([oldJournal, currentJournal], {maxRunDate: today, allowMultiplePendingByScope: true});
  assert.equal(afterResolve.pending.size, 2, 'fresh=10 and unrelated fresh=11 intents remain pending before executor');
  assert.equal(afterResolve.tombstonedIdempotencyKeys.size, 2);
  assert.equal(afterResolve.tombstonedIdempotencyKeys.has(oldJY.idempotencyKey), true);
  const oldJYKey = path.resolve(oldJournal) + '\u0000' + oldJY.intentId;
  assert.equal(afterResolve.terminalOutcomes.get(oldJYKey)?.originalEffectUnknown, true);
  assert.equal(afterResolve.fences.size, 0, 'same-target supersede must not create an XL-style permanent scope fence');
  const executorRun = await runNode(['scripts/inventory/execute_daily_inventory_replenishment_plan.mjs', '--plan', planFile, '--policy', POLICY_FILE, '--config', configFile, '--bi-data', biFile, '--links-data', linksFile, '--out', resultFile, '--execute', '--execution-mode', 'automatic', '--confirm-hash', plan.payloadHash, '--max-rows', '10'], {SHEIN_BI_INVENTORY_AUTOMATION_CONTEXT: 'cloud_daily_inventory_replenishment_guard', SHEIN_BI_INVENTORY_AUTOMATION_AUTHORIZATION: authorizationId, SHEIN_BI_INVENTORY_JOURNAL_DIRS: resultsDir, SHEIN_BI_INVENTORY_SKU_LOCK_DIR: path.join(temp, 'locks')});
  if (executorRun.code !== 0) {
    const failedResult = await fs.readFile(resultFile, 'utf8').catch(error => 'missing result: ' + error.message);
    assert.equal(executorRun.code, 0, 'executor stdout=' + executorRun.stdout + '\nstderr=' + executorRun.stderr + '\nresult=' + failedResult);
  }
  assert.equal(state.postCount, 1, 'fresh=9 JY issues one POST; fresh=10 NM, drifted=11 QH, and rejected fresh=11 JSH issue zero POSTs');
  const postRow = state.postBodies[0].updateSkuInventoryQuantityRequests[0];
  assert.equal(postRow.skuCode, rows[0].skuCode);
  assert.notEqual(postRow.idempotencyKey, oldJY.idempotencyKey);
  assert.notEqual(postRow.idempotencyKey, oldNM.idempotencyKey);
  const result = JSON.parse(await fs.readFile(resultFile, 'utf8'));
  assert.equal(result.results.find(row => row.storeKey === 'JY').state, 'updated_readback_matched');
  assert.equal(result.results.find(row => row.storeKey === 'NM').state, 'skipped_target_already_matched');
  assert.equal(result.results.find(row => row.storeKey === 'QH').state, 'skipped_owner_confirmed_same_target_above_target');
  const currentEntries = (await fs.readFile(currentJournal, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const newIntent = currentEntries.find(entry => entry.kind === 'intent' && entry.storeKey === 'JY');
  assert.ok(newIntent, 'JY must create a new current-run intent');
  assert.equal(newIntent.runDate, today);
  assert.notEqual(newIntent.intentId, oldJY.intentId);
  assert.notEqual(newIntent.idempotencyKey, oldJY.idempotencyKey);
  assert.equal(currentEntries.some(entry => entry.kind === 'intent' && entry.storeKey === 'NM'), false, 'NM fresh=10 must not create a new POST intent');
  assert.equal(currentEntries.some(entry => entry.kind === 'intent' && entry.storeKey === 'QH'), false, 'QH drifted to 11 must not create a lowering POST intent');
  const finalBundle = await readInventoryIntentJournals([oldJournal, currentJournal], {maxRunDate: today, allowMultiplePendingByScope: true});
  assert.equal(finalBundle.pending.size, 1, 'unrelated fresh=11 pending intent must remain untouched');
  assert.equal([...finalBundle.pending.values()][0].intentId, oldRejected.intentId);
  assert.equal(finalBundle.terminalOutcomes.get(path.resolve(oldJournal) + '\u0000' + oldNM.intentId)?.disposition, 'readback_matched');
  assert.equal(finalBundle.tombstonedIdempotencyKeys.has(oldJY.idempotencyKey), true);
  assert.equal(finalBundle.tombstonedIdempotencyKeys.has(oldQH.idempotencyKey), true);

  const strictRoot = path.join(temp, 'strict-reader-invalid');
  await fs.mkdir(strictRoot, {recursive: true});
  const invalidFreshFile = path.join(strictRoot, 'daily-inventory-replenishment-' + oldDate + '.json.journal.ndjson');
  await fs.writeFile(invalidFreshFile, JSON.stringify(oldJY) + '\n' + JSON.stringify(makeOwnerConfirmedOutcome(oldJY, {freshUsableInventory: 10})) + '\n', 'utf8');
  await assert.rejects(
    () => readInventoryIntentJournals([invalidFreshFile], {maxRunDate: today, allowMultiplePendingByScope: true}),
    /INVENTORY_JOURNAL_OUTCOME_INVALID:.*:freshUsableInventory/,
  );
  const thirteenDaysAfterOld = new Date(Date.parse(oldDate + 'T00:00:00Z') + 13 * 86_400_000).toISOString().slice(0, 10);
  const invalidAgeFile = path.join(strictRoot, 'age', 'daily-inventory-replenishment-' + oldDate + '.json.journal.ndjson');
  await fs.mkdir(path.dirname(invalidAgeFile), {recursive: true});
  await fs.writeFile(invalidAgeFile, JSON.stringify(oldJY) + '\n' + JSON.stringify(makeOwnerConfirmedOutcome(oldJY, {newRunDate: thirteenDaysAfterOld, freshUsableInventory: 9})) + '\n', 'utf8');
  await assert.rejects(
    () => readInventoryIntentJournals([invalidAgeFile], {maxRunDate: today, allowMultiplePendingByScope: true}),
    /INVENTORY_JOURNAL_OUTCOME_INVALID:.*:runDateAge/,
  );
  const invalidOldDateFile = path.join(strictRoot, 'old-date', 'daily-inventory-replenishment-' + oldDate + '.json.journal.ndjson');
  await fs.mkdir(path.dirname(invalidOldDateFile), {recursive: true});
  const invalidOldDateOutcome = makeOwnerConfirmedOutcome(oldJY);
  invalidOldDateOutcome.oldRunDate = new Date(Date.parse(oldDate + 'T00:00:00Z') - 86_400_000).toISOString().slice(0, 10);
  await fs.writeFile(invalidOldDateFile, JSON.stringify(oldJY) + '\n' + JSON.stringify(invalidOldDateOutcome) + '\n', 'utf8');
  await assert.rejects(
    () => readInventoryIntentJournals([invalidOldDateFile], {maxRunDate: today, allowMultiplePendingByScope: true}),
    /INVENTORY_JOURNAL_OUTCOME_INVALID:.*:oldRunDate/,
  );
  console.log(JSON.stringify({ok: true, checks: ['resolver_requires_exact_intent_id_and_old_run_date', 'fresh_9_owner_confirmed_resume_posts_once_with_new_key_and_matches_10', 'fresh_10_cross_day_readback_closes_without_post', 'drifted_11_owner_confirmed_scope_skips_without_lowering_post', 'fresh_11_resolver_rejects_without_post_or_journal_mutation', 'strict_reader_rejects_fresh_10_age_under_14_and_old_date_mismatch', 'old_effect_unknown_and_old_key_tombstone_preserved', 'unrelated_pending_intent_remains_untouched']}, null, 2));
} finally {
  await new Promise(resolve => server.close(() => resolve()));
  await fs.rm(temp, {recursive: true, force: true});
}
