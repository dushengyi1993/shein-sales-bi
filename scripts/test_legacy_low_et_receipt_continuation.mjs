import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {issueImmediateAuthorization, consumeImmediateAuthorization, IMMEDIATE_CONFIRMATION_TOKEN,
  readImmediateAdmissionQueueFd, persistImmediateAdmissionQueueSnapshot,
  verifyImmediateAuthorizationContinuation, findImmediateAuthorizationContinuation} from '../lib/cloud_marketing_immediate_authorization.mjs';
import {loadExactManualRepairPlan, loadExactFallbackRepairPlan} from '../lib/marketing_repair_manifest.mjs';
import {verifyLegacyLowEtReceiptContinuation, revalidateLowEtFastSellerRescueArtifact} from '../lib/marketing_low_et_fast_seller_pricing.mjs';
import {createDeadlineContract} from '../lib/cloud_marketing_deadline_contract.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform === 'win32') {
  const file = fileURLToPath(import.meta.url).replaceAll('\\', '/');
  const linuxFile = `/mnt/${file[0].toLowerCase()}${file.slice(2)}`;
  const run = spawnSync('wsl.exe', ['-e', 'sudo', '-n', 'node', linuxFile], {stdio: 'inherit'});
  process.exit(run.status ?? 1);
}
if (process.platform !== 'win32' && process.getuid() !== 0) {
  const run = spawnSync('sudo', ['-n', process.execPath, fileURLToPath(import.meta.url)], {stdio: 'inherit'});
  process.exit(run.status ?? 1);
}
const root = await fs.mkdtemp(path.join(process.platform === 'win32' ? path.join(repo, 'tmp') : '/run', 'legacy-receipt-'));
const previousEnv = {...process.env};
const realNow = Date.now;
const now = Math.floor(Date.parse('2026-09-06T04:00:00Z') / 1000);
Date.now = () => now * 1000;
const date = '2026-09-06';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
let fd;
async function write(relative, value) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, JSON.stringify(value));
  return file;
}
try {
  process.env.SHEIN_BI_ROOT = root;
  delete process.env.SHEIN_BI_STATE_ROOT;
  delete process.env.SHEIN_BI_OUTPUTS_ROOT;
  process.env.SHEIN_BI_INVENTORY_RUNTIME_ROOT = path.join(root, 'inventory-runtime');
  const policy = {automationExecution: {enabled: true, authorizationId: 'fixture-standing',
    allowedContexts: ['fixture'], allowedActions: ['restore_manual_special_limited_discount', 'apply_new_listing_limited_discount_fallback'],
    storeScope: 'all_enabled_stores', perRunPayloadHashRequired: true}};
  process.env.SHEIN_BI_MARKETING_POLICY_FILE = await write('config/policy.json', policy);
  process.env.SHEIN_BI_MARKETING_AUTOMATION_AUTHORIZATION = 'fixture-standing';
  process.env.SHEIN_BI_MARKETING_AUTOMATION_CONTEXT = 'fixture';
  process.env.SHEIN_BI_MANUAL_LIMITED_DISCOUNT_REGISTRY = await write('config/manual.json', {entries: []});
  await write('config/stores.json', {stores: [{storeKey: 'DL', enabled: true}]});
  const baseline = 'tmp/prices.json';
  const baselineFile = await write(baseline, {items: [{canonical: 'SK-TEST', storeKey: 'DL', skc: 'f-0-0', targetPrice: 100, ordinaryTargetMargin: .3}]});
  const baselineHash = hash(await fs.readFile(baselineFile));
  const sourceGuard = `outputs/reports/guard-${date}.json`;
  const guardPath = await write(sourceGuard, {reportDate: date,
    limitedDiscountTargetPriceDrift: {source: 'tmp/live.json'},
    targetPlanSelection: {priceOverrides: baseline, priceOverridesHash: baselineHash}});
  const inventory = {products: ['SK-TEST', 'SK-MISSING'].map(canonical => ({canonical, inventory_match_status: 'matched', operational_sellable_qty: 20, operational_snapshot_date: date}))};
  const inventoryFile = await write('tmp/inventory.json', inventory);
  const linksFile = await write('tmp/links.json', {storeLinks: ['SK-TEST', 'SK-MISSING'].map((canonical, i) => ({standard_goods_sn: canonical, store_key: 'DL', skc: `f-0-${i ? 4 : 0}`, c30_valid_sale_cnt: 31, c7_eps_uv: 100}))});
  await write('tmp/cost.json', {costMap: {'SK-TEST': 70}});
  const manualEntries = [];
  const manualDir = 'tmp/manual';
  for (let i = 0; i < 3; i++) {
    const relative = `${manualDir}/manual-limited-restore-DL-m${i}.json`;
    await write(relative, {storeKey: 'DL', sourceGuard, purpose: 'manual_special_limited_discount_registry_restore',
      rows: [{storeKey: 'DL', skc: `m${i}`, limitedDiscountPrice: 100}]});
    manualEntries.push({storeKey: 'DL', skc: `m${i}`, path: relative});
  }
  const manualPlanPath = await write(`${manualDir}/manual-limited-discount-restore-plan.json`, {reportDate: date, sourceGuard, restoreCount: 3, rescueFiles: manualEntries});
  const fallbackEntries = [];
  for (let i = 0; i < 18; i++) {
    const relative = `tmp/fallback-${i}.json`;
    await write(relative, {createdAt: `${date}T00:00:00Z`, storeKey: 'DL', sourceGuard,
      purpose: `new_listing_or_relisted_top_treatment_limited_discount_fallback_${date}`,
      sourcePriceOverrides: baseline, sourcePriceOverridesSha256: baselineHash,
      sourceInventoryTrend: 'tmp/inventory.json', sourceLinksData: 'tmp/links.json', sourceCostMap: 'tmp/cost.json', pricingPolicy: 'config/policy.json',
      activityStock: 10, endTime: '2026-09-13 23:59:59',
      rows: Array.from({length: 5}, (_, j) => ({storeKey: 'DL', skc: `f-${i}-${j}`, canonical: i === 0 && j === 4 ? 'SK-MISSING' : 'SK-TEST',
        action: 'create_limited_discount', finalTargetPrice: 100, targetPrice: 100, limitedDiscountPrice: 100, activityStock: 10,
        lowEtFastSellerPricePullback: {applied: false, contextEvidenceHash: 'a'.repeat(64)}}))});
    fallbackEntries.push({storeKey: 'DL', path: relative, count: 5});
  }
  const planPath = await write(`outputs/reports/new-listing-7d-limited-discount-plan-${date}.json`, {
    reportDate: date, sourceGuard, sourceCurrentMarketingLiveScan: 'tmp/live.json', sourcePriceOverrides: baseline,
    sourcePriceOverridesSha256: baselineHash, rescueFiles: fallbackEntries});
  const manual = await loadExactManualRepairPlan({root, date, planPath: manualPlanPath, guardPath});
  const fallback = await loadExactFallbackRepairPlan({root, date, planPath, guardPath});
  const queue = {schemaVersion: 1, date, status: 'deferred_to_local', sourceGuard, sourceGuardHash: hash(await fs.readFile(guardPath)), queueFingerprint: 'b'.repeat(64),
    stages: {highClickSpecial: {status: 'not_required'}, manualSpecialRestore: {status: 'pending', resultPath: null, planPath: manualPlanPath, workFingerprint: manual.workFingerprint},
      driftRepair: {status: 'not_required'}, fallbackRepair: {status: 'pending', resultPath: null, planPath, workFingerprint: fallback.workFingerprint}}};
  const queueFile = await write(`state/cloud_marketing_live_guard/repair-queues/marketing-repair-${date}.json`, queue);
  const originalBytes = await fs.readFile(queueFile);
  const authFile = path.join(root, 'authority/authorization.json');
  await fs.mkdir(path.dirname(authFile), {mode: 0o700});
  const issued = await issueImmediateAuthorization({root, date, queueFile, sourceGuardFile: guardPath, authorizationFile: authFile,
    maxGroups: 32, ttlSec: 3600, nowEpoch: now, reason: 'offline legacy receipt test', confirmationToken: IMMEDIATE_CONFIRMATION_TOKEN});
  const consumed = await consumeImmediateAuthorization({root, date, queueFile, authorizationFile: authFile, nowEpoch: now});
  const receiptFile = consumed.receiptFile || consumed.consumedReceiptFile;
  const receiptBytes = await fs.readFile(receiptFile);
  const receiptHash = hash(receiptBytes);
  fd = fss.openSync(queueFile, 'r');
  const proof = {root, date, queueFile, receiptFile, expectedReceiptSha256: receiptHash, expectedWorkFingerprint: fallback.workFingerprint, planPath, guardPath,
    queueSnapshotBytes: readImmediateAdmissionQueueFd(fd), nowEpoch: now};
  const cap = await verifyLegacyLowEtReceiptContinuation(proof);
  const rescue = fallback.entries[0].rescue;
  assert.equal((await revalidateLowEtFastSellerRescueArtifact({root, rescue, reportDate: date})).ok, false);
  assert.equal((await revalidateLowEtFastSellerRescueArtifact({root, rescue, reportDate: date, legacyReceiptCapability: {...cap}})).ok, false);
  assert.equal((await revalidateLowEtFastSellerRescueArtifact({root, rescue, reportDate: date, legacyReceiptCapability: cap})).ok, true);
  for (const field of ['finalTargetPrice', 'action', 'activityStock']) {
    const changed = structuredClone(rescue); changed.rows[0][field] = field === 'action' ? 'replace' : 101;
    assert.equal((await revalidateLowEtFastSellerRescueArtifact({root, rescue: changed, reportDate: date, legacyReceiptCapability: cap})).ok, false);
  }
  const changedWindow = {...rescue, endTime: '2026-09-14 23:59:59'};
  assert.equal((await revalidateLowEtFastSellerRescueArtifact({root, rescue: changedWindow, reportDate: date, legacyReceiptCapability: cap})).ok, false);
  const appliedLegacy = structuredClone(rescue); appliedLegacy.rows[0].lowEtFastSellerPricePullback.applied = true;
  assert.equal((await revalidateLowEtFastSellerRescueArtifact({root, rescue: appliedLegacy, reportDate: date, legacyReceiptCapability: cap})).ok, false);
  const switched = structuredClone(inventory); switched.products[0].operational_sellable_qty = 10;
  await fs.writeFile(inventoryFile, JSON.stringify(switched));
  assert.equal((await revalidateLowEtFastSellerRescueArtifact({root, rescue, reportDate: date, legacyReceiptCapability: cap})).ok, false);
  await fs.writeFile(inventoryFile, JSON.stringify(inventory));
  await fs.writeFile(inventoryFile, JSON.stringify({products: []}));
  assert.equal((await revalidateLowEtFastSellerRescueArtifact({root, rescue, reportDate: date, legacyReceiptCapability: cap})).ok, false);
  await fs.writeFile(inventoryFile, JSON.stringify(inventory));
  await assert.rejects(verifyLegacyLowEtReceiptContinuation({...proof, expectedReceiptSha256: 'c'.repeat(64)}));
  assert.equal((await verifyLegacyLowEtReceiptContinuation({...proof, nowEpoch: issued.gracefulCutoffEpoch - 899})).admission.gracefulRemainingSec, 899);
  await fs.mkdir(path.join(root, 'state/marketing-replacement-transactions'), {recursive: true});
  const unknownJournal = await write('state/marketing-replacement-transactions/unknown.json', {runPayloadHash: fallback.workFingerprint, createAttempt: {status: 'unknown'}});
  await assert.rejects(verifyLegacyLowEtReceiptContinuation(proof));
  await fs.unlink(unknownJournal);

  await fs.symlink(path.join(repo, 'lib'), path.join(root, 'lib'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.mkdir(path.join(root, 'scripts/marketing'), {recursive: true});
  for (const name of ['batch_restore_manual_limited_discounts.mjs', 'batch_apply_new_listing_limited_discount.mjs']) {
    await fs.copyFile(path.join(repo, 'scripts/marketing', name), path.join(root, 'scripts/marketing', name));
  }
  process.env.SHEIN_BI_MARKETING_IMMEDIATE_CONTINUATION = '1';
  process.env.SHEIN_BI_MARKETING_IMMEDIATE_RECEIPT_STATUS = 'consumed';
  process.env.SHEIN_BI_MARKETING_IMMEDIATE_QUEUE_FILE = queueFile;
  process.env.SHEIN_BI_MARKETING_IMMEDIATE_RECEIPT_FILE = receiptFile;
  process.env.SHEIN_BI_MARKETING_IMMEDIATE_RECEIPT_SHA256 = receiptHash;
  process.env.SHEIN_BI_MARKETING_IMMEDIATE_ORIGINAL_QUEUE_FD = String(fd);
  process.env.SHEIN_BI_MARKETING_IMMEDIATE_GRACEFUL_CUTOFF_EPOCH = String(issued.gracefulCutoffEpoch);
  const deadline = createDeadlineContract({gracefulCutoffEpoch: issued.gracefulCutoffEpoch, outerHardDeadlineEpoch: issued.outerHardDeadlineEpoch, nowEpoch: now});
  const manualResult = path.join(root, `${manualDir}/result.json`);
  const {runManualRestoreBatch} = await import(pathToFileURL(path.join(root, 'scripts/marketing/batch_restore_manual_limited_discounts.mjs')));
  const manualArgs = {guard: guardPath, outDir: path.join(root, manualDir), skipBuild: true, dryRunOnly: false, continuation: true,
    stores: [], maxItems: 32, result: manualResult, expectedWorkFingerprint: manual.workFingerprint, deadline};
  let manualStarted = 0;
  await runManualRestoreBatch(manualArgs, {launchStore: async () => ({ok: true}), closeStore: async () => ({ok: true}),
    processOne: async (file, stores, args) => { assert.equal(args.continuation, false); manualStarted++;
      return {ok: true, storeKey: 'DL', rescuePath: file.path, status: 'restored'}; }});
  assert.equal(manualStarted, 3);
  const savedQueue = await persistImmediateAdmissionQueueSnapshot(proof);
  assert.deepEqual(await fs.readFile(savedQueue), originalBytes);
  const progressed = structuredClone(queue);
  progressed.status = 'pending';
  progressed.stages.manualSpecialRestore = {...queue.stages.manualSpecialRestore, status: 'completed', resultPath: `${manualDir}/result.json`};
  const nextQueue = await write('state/next.json', progressed);
  await fs.rename(nextQueue, queueFile);
  const restarted = await verifyImmediateAuthorizationContinuation({...proof, queueSnapshotBytes: undefined});
  assert.equal(restarted.ok, true);
  assert.equal(restarted.remainingUnstartedGroups, 29, 'restart cannot reset the original group budget');
  assert.equal(await persistImmediateAdmissionQueueSnapshot(proof), savedQueue);
  assert.equal((await findImmediateAuthorizationContinuation({root, date, queueFile, authorizationFile: authFile, nowEpoch: now})).ok, true);
  assert.notEqual(hash(await fs.readFile(queueFile)), hash(originalBytes));
  assert.deepEqual(readImmediateAdmissionQueueFd(fd), originalBytes);
  const wrongStage = structuredClone(progressed); wrongStage.stages.fallbackRepair.status = 'running';
  await fs.writeFile(queueFile, JSON.stringify(wrongStage));
  await assert.rejects(verifyLegacyLowEtReceiptContinuation(proof));
  await fs.writeFile(queueFile, JSON.stringify(progressed));
  const manualResultBytes = await fs.readFile(manualResult);
  await fs.writeFile(manualResult, JSON.stringify({workFingerprint: 'f'.repeat(64), results: [{}]}));
  await assert.rejects(verifyLegacyLowEtReceiptContinuation(proof));
  await fs.writeFile(manualResult, manualResultBytes);
  const paused = structuredClone(progressed);
  paused.stages.manualSpecialRestore.status = 'pending';
  const pausedResult = JSON.parse(manualResultBytes);
  pausedResult.totals.remainingItems = 1;
  pausedResult.results[2] = {...pausedResult.results[2], ok:false, status:'failed', terminalBlocked:false, recoverableDeferred:false, deferred:false, error:'ordinary prewrite failure'};
  await fs.writeFile(manualResult, JSON.stringify(pausedResult));
  await fs.writeFile(queueFile, JSON.stringify(paused));
  assert.equal((await verifyLegacyLowEtReceiptContinuation(proof)).mode, cap.mode);
  const remainingBefore = (await verifyImmediateAuthorizationContinuation({...proof, queueSnapshotBytes:undefined})).remainingUnstartedGroups;
  const shortened = structuredClone(pausedResult); shortened.results.pop(); shortened.totals.processed = 2;
  await fs.writeFile(manualResult, JSON.stringify(shortened));
  assert.equal((await verifyImmediateAuthorizationContinuation({...proof, queueSnapshotBytes:undefined})).remainingUnstartedGroups, remainingBefore,
    'dropping the failed display row cannot refund its claimed group identity');
  await fs.writeFile(manualResult, JSON.stringify(pausedResult));
  process.env.SHEIN_BI_MARKETING_IMMEDIATE_CONTINUATION = '0';
  const emptyManualResume = await runManualRestoreBatch({...manualArgs, maxItems:1}, {
    launchStore:async()=>{throw new Error('empty transaction continuation must not launch');},
    closeStore:async()=>({ok:true}),processOne:async()=>{throw new Error('empty transaction continuation must not execute');},
  });
  assert.equal(emptyManualResume.output.results.length,3,'empty continuation preserves the prior failed group row');
  assert.equal((await verifyImmediateAuthorizationContinuation({...proof,queueSnapshotBytes:undefined})).remainingUnstartedGroups,remainingBefore);
  process.env.SHEIN_BI_MARKETING_IMMEDIATE_CONTINUATION = '1';
  process.exitCode = 0;
  const failedQueue = structuredClone(queue);
  failedQueue.status = 'failed';
  failedQueue.stages.manualSpecialRestore = {...failedQueue.stages.manualSpecialRestore, status: 'pending', resultPath: manualResult};
  const failedFallbackFile = path.join(root, `outputs/reports/new-listing-7d-limited-discount-execution-summary-${date}.json`);
  failedQueue.stages.fallbackRepair = {...failedQueue.stages.fallbackRepair, status: 'failed', resultPath: failedFallbackFile};
  const failedFallback = {workFingerprint:fallback.workFingerprint,dryRunOnly:false,complete:false,totals:{storesProcessed:1},
    results:[{storeKey:'DL',sourceRescuePath:fallback.entries[0].relativePath,ok:false,status:'low_et_price_pullback_evidence_drift',execute:null}]};
  await fs.writeFile(failedFallbackFile, JSON.stringify(failedFallback));
  await fs.writeFile(manualResult, JSON.stringify({workFingerprint:manual.workFingerprint,dryRunOnly:false,
    totals:{processed:2,remainingItems:2,terminalBlocked:0},results:[
      {storeKey:'DL',rescuePath:manualEntries[0].path,ok:false,terminalBlocked:true,status:'platform_blocked'},
      {storeKey:'DL',rescuePath:manualEntries[1].path,ok:false,status:'failed',transaction:null,inventoryTransaction:null,execute:null,readback:null}]}));
  await fs.writeFile(queueFile, JSON.stringify(failedQueue));
  assert.equal((await verifyImmediateAuthorizationContinuation({...proof,queueSnapshotBytes:undefined})).ok,true);
  const unknownResult = structuredClone(failedFallback); unknownResult.results[0].execute = {submitAttempted:true};
  await fs.writeFile(failedFallbackFile,JSON.stringify(unknownResult));
  await assert.rejects(verifyImmediateAuthorizationContinuation({...proof,queueSnapshotBytes:undefined}), /unresolved submitted/);
  await fs.writeFile(failedFallbackFile,JSON.stringify(failedFallback));
  const unknownOperation = await write('state/marketing-replacement-transactions/unbound.json', {runPayloadHash:fallback.workFingerprint,rescuePath:fallback.entries[0].path,phase:'create_submit_unknown'});
  await assert.rejects(verifyImmediateAuthorizationContinuation({...proof,queueSnapshotBytes:undefined}), /unbound subset/);
  await fs.unlink(unknownOperation);
  const unknownInventory = await write(`inventory-runtime/runs/marketing/unknown/daily-inventory-replenishment-${date}.json.journal.ndjson`,
    {kind:'intent',storeKey:'DL',skc:'f-0-0',status:'unknown'});
  await assert.rejects(verifyImmediateAuthorizationContinuation({...proof,queueSnapshotBytes:undefined}), /INVENTORY_JOURNAL/);
  await fs.unlink(unknownInventory);
  let continuationPosts = 0;
  let isolatedAttempts = 0;
  process.env.SHEIN_BI_BROWSER_LEASE_RUN_ID = 'manual-service-first';
  const resumedManualOps = {launchStore:async()=>({ok:true}),closeStore:async()=>({ok:true}),processOne:async file=>{
    assert.notEqual(file.path,manualEntries[0].path);
    if (file.path === manualEntries[1].path && process.env.SHEIN_BI_BROWSER_LEASE_RUN_ID === 'manual-service-first') {
      isolatedAttempts++;
      return {ok:false,status:'failed',storeKey:'DL',rescuePath:file.path,error:'prewrite fixture'};
    }
    continuationPosts++;
    return {ok:true,status:'restored',storeKey:'DL',rescuePath:file.path};}};
  const continuedOne = await runManualRestoreBatch({...manualArgs,maxItems:1},resumedManualOps);
  assert.equal(continuedOne.output.totals.terminalBlocked,1);
  assert.equal(continuedOne.output.totals.processedThisRunTerminalBlocked,0);
  await runManualRestoreBatch({...manualArgs,maxItems:1},resumedManualOps);
  await runManualRestoreBatch({...manualArgs,maxItems:1},resumedManualOps);
  assert.equal(isolatedAttempts,1,'same-run isolated failure cannot starve the next manual item');
  assert.equal(continuationPosts,1,'next independent manual item must execute despite the prior failed item');
  process.env.SHEIN_BI_BROWSER_LEASE_RUN_ID = 'manual-service-second';
  await runManualRestoreBatch({...manualArgs,maxItems:1},resumedManualOps);
  await runManualRestoreBatch({...manualArgs,maxItems:1},resumedManualOps);
  assert.equal(continuationPosts,2,'two original pending items execute once; repeated continuation skips settled TS and successes');
  assert.deepEqual(await fs.readFile(receiptFile),receiptBytes);
  await fs.unlink(failedFallbackFile);
  process.exitCode = 0;
  await fs.writeFile(manualResult, manualResultBytes);
  await fs.writeFile(queueFile, JSON.stringify(progressed));
  await fs.writeFile(savedQueue, '{}');
  await assert.rejects(verifyImmediateAuthorizationContinuation({...proof, queueSnapshotBytes: undefined}));
  await fs.writeFile(savedQueue, originalBytes);
  const fdBefore = await write('fd-before.json', queue);
  const fdAfter = await write('fd-after.json', progressed);
  const inherited = spawnSync('bash', ['-c', `
exec {queuefd}< "$QUEUE_BEFORE"
export QUEUE_FD="$queuefd"
mv "$QUEUE_AFTER" "$QUEUE_BEFORE"
node --input-type=module -e 'const {readImmediateAdmissionQueueFd}=await import(process.env.AUTH_MODULE); const c=await import("node:crypto"); console.log(c.createHash("sha256").update(readImmediateAdmissionQueueFd(process.env.QUEUE_FD)).digest("hex"));'
`], {encoding: 'utf8', env: {...process.env, QUEUE_BEFORE: fdBefore, QUEUE_AFTER: fdAfter,
    AUTH_MODULE: pathToFileURL(path.join(repo, 'lib/cloud_marketing_immediate_authorization.mjs')).href}});
  assert.equal(inherited.status, 0, inherited.stderr);
  assert.equal(inherited.stdout.trim(), hash(originalBytes), 'Bash must retain and inherit the admitted inode across CAS');
  const {runNewListingFallbackBatch, processStore: realProcessStore, writeInventoryExecutableSubset} = await import(pathToFileURL(path.join(root, 'scripts/marketing/batch_apply_new_listing_limited_discount.mjs')));
  const partialLinksBytes = await fs.readFile(linksFile);
  const missingLinks = JSON.parse(partialLinksBytes); missingLinks.storeLinks[1].c30_valid_sale_cnt = null;
  await fs.writeFile(linksFile,JSON.stringify(missingLinks));
  const failedDxQueue = structuredClone(progressed); failedDxQueue.status = 'failed';
  failedDxQueue.stages.fallbackRepair = {...failedDxQueue.stages.fallbackRepair,status:'failed',resultPath:failedFallbackFile};
  const partialFailure = structuredClone(failedFallback);
  partialFailure.results.push(...fallback.entries.slice(1).map(entry=>({ok:true,status:'executed',storeKey:'DL',sourceRescuePath:entry.relativePath})));
  partialFailure.totals.storesProcessed = partialFailure.results.length;
  await fs.writeFile(failedFallbackFile,JSON.stringify(partialFailure));
  await fs.writeFile(queueFile,JSON.stringify(failedDxQueue));
  let partialPosts = 0;
  const partialArgs = {guard:guardPath,date,outDir:path.join(root,'tmp/batch'),skipBuild:true,dryRunOnly:false,
    continuation:true,stores:[],maxGroups:1,expectedWorkFingerprint:fallback.workFingerprint,deadline,
    gracefulCutoffEpoch:issued.gracefulCutoffEpoch,minStartBudgetSec:900,resume:true};
  const partialOps = {launchStore:async()=>({ok:true}),closeStore:async()=>({ok:true}),processStore:async context=>{
    assert.equal(context.args.continuation,false,'consumed failed queue selects unstarted mode before processStore');
    const record = await realProcessStore({...context,operations:{
      applyRescue:async request=>{
        const executable = JSON.parse(await fs.readFile(request.rescuePath,'utf8'));
        assert.deepEqual(executable.rows,fallback.entries[0].rescue.rows.slice(0,4),'retain exact original row bytes/prices');
        return {ok:true,full:{ok:true,validation:{},after:{exactReadbackRows:executable.rows.map(row=>({skc:row.skc,ok:true}))}}};
      },
      replaceTransactionally:async request=>{assert.equal(request.continuation,false);partialPosts++;
        return {ok:true,full:{ok:true,terminal:true,status:'offline_subset',desiredCreate:{createdActivityId:123},desiredCoveredSkcs:fallback.entries[0].rescue.rows.slice(0,4).map(row=>row.skc)}};},
    }});
    assert.deepEqual(record.factBlockedSkcs,['f-0-4']);
    assert.equal(record.lowEtFastSellerPricePullbackRevalidation.rows.at(-1).current.evidence.validSales30d,null);
    assert.equal(record.status,'executed_subset_with_platform_or_inventory_blockers',record.error);
    return record;
  }};
  await runNewListingFallbackBatch({...partialArgs},partialOps);
  await runNewListingFallbackBatch({...partialArgs},partialOps);
  assert.equal(partialPosts,1,'failed queue continuation creates the 4 available items once and never repeats the group');
  const partialReadback = JSON.parse(await fs.readFile(failedFallbackFile,'utf8'));
  assert.equal(partialReadback.totals.blockedTargetCount,1);
  assert.equal(partialReadback.totals.executedTargetCount,4);
  await fs.writeFile(linksFile,partialLinksBytes);
  await fs.unlink(failedFallbackFile);
  await fs.writeFile(queueFile,JSON.stringify(progressed));
  process.exitCode = 0;
  let fallbackStarted = 0;
  await runNewListingFallbackBatch({guard: guardPath, date, outDir: path.join(root, 'tmp/batch'), skipBuild: true, dryRunOnly: false,
    continuation: true, stores: [], maxGroups: 29, expectedWorkFingerprint: fallback.workFingerprint, deadline,
    gracefulCutoffEpoch: issued.gracefulCutoffEpoch, minStartBudgetSec: 900, resume: false}, {
    launchStore: async () => ({ok: true}), closeStore: async () => ({ok: true}), processStore: async ({file, args}) => {
      assert.equal(args.continuation, false);
      assert.equal((await revalidateLowEtFastSellerRescueArtifact({root, rescue: file.rescue, reportDate: date, legacyReceiptCapability: args.legacyReceiptCapability})).ok, true);
      fallbackStarted++;
      return {ok: true, storeKey: 'DL', rescuePath: file.relativePath, status: 'executed', targetCount: file.count};
    }});
  assert.equal(fallbackStarted, 18);
  // Fixture follows findPersistedMarketingTransactionContinuation's exact
  // source-hash identity; the real helper must select it before our executor.
  const txEntry = fallback.entries[0];
  const txHash = hash(await fs.readFile(txEntry.path));
  const txId = hash(Buffer.from(`DL\n${txHash}`)).slice(0, 24);
  const txFile = await write(`state/marketing-replacement-transactions/limited-discount-tx-DL-${txId}.json`, {
    schemaVersion:1, snapshots:[], removals:[], transactionId: txId, storeKey: 'DL', rescueHash: txHash, rescuePath: txEntry.path,
    runPayloadHash: fallback.workFingerprint, mutationsStarted: true, phase: 'deleting',
  });
  const baseTx = JSON.parse(await fs.readFile(txFile, 'utf8'));
  const subset = await writeInventoryExecutableSubset({storeKey:'DL', rescue:txEntry.rescue, rescuePath:txEntry.path,
    blockedSkcs:[txEntry.rescue.rows.at(-1).skc], outDir:path.join(root,'tmp/batch')});
  const subsetBytes = await fs.readFile(subset.path);
  assert.notEqual(subset.rescue.createdAt, txEntry.rescue.createdAt);
  assert.notEqual(subset.rescue.purpose, txEntry.rescue.purpose);
  assert.equal(subset.rescue.rows.length, 4);
  const bindSubset = async () => {
    const exactScope = {storeKey:'DL',transactionId:txId,rescuePath:subset.path,
      rescueHash:hash(await fs.readFile(subset.path)),targetSkcs:subset.rescue.rows.map(row=>row.skc).sort()};
    const operation = {role:'create_only',workFingerprint:fallback.workFingerprint,exactScope};
    await fs.writeFile(txFile, JSON.stringify({...baseTx,phase:'create_submit_unknown',operationRescuePath:subset.path,
      createAttempt:{schemaVersion:1,operation:'limited_discount_create',...operation,operationId:hash(Buffer.from(JSON.stringify(operation)))}}));
  };
  await bindSubset();
  const subsetCap = await verifyLegacyLowEtReceiptContinuation(proof);
  assert.equal((await revalidateLowEtFastSellerRescueArtifact({root,rescue:subset.rescue,reportDate:date,legacyReceiptCapability:subsetCap})).ok,true);
  const earlySubsetTx = {...baseTx,operationRescuePath:subset.path,operationRescueHash:hash(subsetBytes)};
  await fs.writeFile(txFile,JSON.stringify(earlySubsetTx));
  assert.equal((await verifyLegacyLowEtReceiptContinuation(proof)).groups[0].mode,'transaction');
  await fs.writeFile(txFile,JSON.stringify({...earlySubsetTx,operationRescueHash:'0'.repeat(64)}));
  await assert.rejects(verifyLegacyLowEtReceiptContinuation(proof));
  await fs.writeFile(txFile,JSON.stringify({...baseTx,operationRescuePath:subset.path}));
  await assert.rejects(verifyLegacyLowEtReceiptContinuation(proof));
  await bindSubset();
  const mutations = [
    value=>{value.rows[0].finalTargetPrice=101;},
    value=>{value.rows[0].activityStock=11;},
    value=>{value.activityStock=11;},
    value=>{value.endTime='2026-09-14 23:59:59';},
    value=>{value.purpose='unrelated_purpose';},
    value=>{value.parentRescue='tmp/unrelated.json';},
    value=>{value.createdAt='invalid';},
    value=>{value.executableRowCount=5;},
    value=>{value.rows.push(txEntry.rescue.rows.at(-1));},
  ];
  for (const mutate of mutations) {
    const changed=structuredClone(subset.rescue); mutate(changed);
    await fs.writeFile(subset.path,JSON.stringify(changed));
    await bindSubset(); // Even a matching fence hash cannot loosen business locks.
    await assert.rejects(verifyLegacyLowEtReceiptContinuation(proof));
  }
  await fs.writeFile(subset.path,subsetBytes);
  await bindSubset();
  await fs.appendFile(subset.path,' ');
  await assert.rejects(verifyLegacyLowEtReceiptContinuation(proof), /exactly bind/);
  await fs.writeFile(subset.path,subsetBytes);
  await bindSubset();
  let persistedResumed = 0;
  await runNewListingFallbackBatch({guard: guardPath, date, outDir: path.join(root, 'tmp/batch'), skipBuild: true, dryRunOnly: false,
    continuation: true, stores: [], maxGroups: 29, expectedWorkFingerprint: fallback.workFingerprint, deadline,
    gracefulCutoffEpoch: issued.gracefulCutoffEpoch, minStartBudgetSec: 900, resume: false}, {
    launchStore: async () => ({ok:true}), closeStore: async () => ({ok:true}), processStore: async context => {
      assert.equal(context.args.continuation, true);
      const record = await realProcessStore({...context, operations: {
        applyRescue: async request => { assert.equal(request.execute, false); return {ok:true, full:{ok:true,validation:{},after:{exactReadbackRows:context.file.rescue.rows.map(row=>({skc:row.skc,ok:true}))}}}; },
        replaceTransactionally: async request => { assert.equal(request.continuation, true); assert.equal(request.rescuePath,subset.path); assert.equal(request.sourceRescuePath,txEntry.path); persistedResumed++;
          return {ok:true,full:{ok:true,terminal:true,status:'resumed_existing_transaction',writeAttempted:false}}; },
      }});
      assert.equal(record.lowEtFastSellerPricePullbackRevalidation.ok, true);
      assert.equal(record.ok, true, record.error);
      return record;
    },
  });
  assert.equal(persistedResumed, 1, 'real persisted transaction must reach continuation selection');
  console.log(JSON.stringify({actualSubsetGenerator:true,retainedRows:subset.rescue.rows.length,metadataAccepted:['createdAt','purpose'],persistedSubsetResumed:persistedResumed,earlyOperationHashVerified:true,driftRejections:mutations.length+3}));
  const summaryFile = path.join(root, `outputs/reports/new-listing-7d-limited-discount-execution-summary-${date}.json`);
  const summaryBytes = await fs.readFile(summaryFile);
  const completedJournal = {schemaVersion:1,snapshots:[],removals:[], transactionId:txId,storeKey:'DL',rescueHash:txHash,rescuePath:txEntry.path,
    runPayloadHash:fallback.workFingerprint,mutationsStarted:true,phase:'completed',result:{ok:true,terminal:true}};
  await fs.writeFile(txFile, JSON.stringify(completedJournal));
  await fs.unlink(summaryFile); // Crash after transaction commit, before result and parent CAS.
  const beforeCas = await verifyLegacyLowEtReceiptContinuation(proof);
  assert.equal(beforeCas.groups[0].mode, 'settled');
  assert.equal(beforeCas.groups.filter(group => group.mode === 'unstarted').length, 17);
  const partialResult = {workFingerprint:fallback.workFingerprint,dryRunOnly:false,complete:false,totals:{storesProcessed:1},
    results:[{ok:true,storeKey:'DL',sourceRescuePath:txEntry.relativePath,status:'executed'}]};
  await fs.writeFile(summaryFile, JSON.stringify(partialResult));
  const partialQueue = structuredClone(progressed);
  partialQueue.stages.fallbackRepair = {...partialQueue.stages.fallbackRepair,status:'pending',resultPath:summaryFile};
  await fs.writeFile(queueFile, JSON.stringify(partialQueue));
  const afterCas = await verifyLegacyLowEtReceiptContinuation(proof);
  assert.equal(afterCas.groups[0].mode, 'settled');
  assert.equal(afterCas.groups.filter(group => group.mode === 'unstarted').length, 17);
  const later = fallback.entries[1]; const laterHash = hash(await fs.readFile(later.path)); const laterId = hash(Buffer.from(`DL\n${laterHash}`)).slice(0,24);
  const laterJournal = await write(`state/marketing-replacement-transactions/limited-discount-tx-DL-${laterId}.json`, {
    schemaVersion:1,snapshots:[],removals:[],transactionId:laterId,storeKey:'DL',rescueHash:laterHash,rescuePath:later.path,
    runPayloadHash:fallback.workFingerprint,mutationsStarted:true,phase:'create_submit_unknown',
  });
  const mixed = await verifyLegacyLowEtReceiptContinuation(proof);
  assert.deepEqual(mixed.groups.slice(0,3).map(group => group.mode), ['settled','transaction','unstarted']);
  let mixedCalls = 0;
  await runNewListingFallbackBatch({guard:guardPath,date,outDir:path.join(root,'tmp/batch'),skipBuild:true,dryRunOnly:false,
    continuation:true,stores:[],maxGroups:1,expectedWorkFingerprint:fallback.workFingerprint,deadline,
    gracefulCutoffEpoch:issued.gracefulCutoffEpoch,minStartBudgetSec:900,resume:true}, {
    launchStore:async()=>({ok:true}),closeStore:async()=>({ok:true}),processStore:async context=>{
      assert.equal(context.file.path,later.path); assert.equal(context.args.continuation,true); mixedCalls++;
      return realProcessStore({...context,operations:{
        applyRescue:async request=>{assert.equal(request.execute,false);return {ok:true,full:{ok:true,validation:{},after:{exactReadbackRows:context.file.rescue.rows.map(row=>({skc:row.skc,ok:true}))}}};},
        replaceTransactionally:async request=>{assert.equal(request.continuation,true);return {ok:true,full:{ok:true,terminal:true,status:'existing_transaction_readback',writeAttempted:false}};},
      }});
    },
  });
  assert.equal(mixedCalls,1,'settled first group must not hide a later unknown transaction');
  await fs.unlink(laterJournal);
  let nextGroupCalls = 0;
  const nextOriginalGroup = fallback.entries.filter(entry => ![txEntry.path,later.path].includes(entry.path))
    .sort((a,b)=>a.relativePath.localeCompare(b.relativePath))[0];
  await runNewListingFallbackBatch({guard:guardPath,date,outDir:path.join(root,'tmp/batch'),skipBuild:true,dryRunOnly:false,
    continuation:true,stores:[],maxGroups:1,expectedWorkFingerprint:fallback.workFingerprint,deadline,
    gracefulCutoffEpoch:issued.gracefulCutoffEpoch,minStartBudgetSec:900,resume:true}, {
    launchStore:async()=>({ok:true}),closeStore:async()=>({ok:true}),processStore:async context=>{
      assert.equal(context.file.path,nextOriginalGroup.path);
      assert.equal(context.args.continuation,false);
      nextGroupCalls++;
      const record = await realProcessStore({...context,operations:{
        applyRescue:async request=>{assert.equal(request.execute,false);return {ok:true,full:{ok:true,validation:{},after:{exactReadbackRows:context.file.rescue.rows.map(row=>({skc:row.skc,ok:true}))}}};},
        replaceTransactionally:async request=>{assert.equal(request.continuation,false);return {ok:true,full:{ok:true,terminal:true,status:'offline_new_group'}};},
      }});
      assert.equal(record.lowEtFastSellerPricePullbackRevalidation.ok,true);
      assert.equal(record.ok,true,record.error);
      return record;
    },
  });
  assert.equal(nextGroupCalls,1,'re-entered single-group batch reaches only the next unstarted identity');
  console.log(JSON.stringify({receiptGroupFlow:['settled_first_skipped','unknown_second_resumed','unstarted_third_started'],newGroupCalls:nextGroupCalls,transactionResumeCalls:mixedCalls}));
  await fs.writeFile(queueFile,JSON.stringify(progressed));
  await fs.writeFile(summaryFile,summaryBytes);
  await fs.unlink(txFile);
  process.exitCode = 0; // Remaining untouched groups are intentionally deferred.
  // Execute the actual worker loops, with only external commands/state I/O
  // replaced. This catches shell budget/return handling that batch tests miss.
  const worker = (await fs.readFile(path.join(repo, 'scripts/cloud_marketing_repair_worker.sh'), 'utf8')).replaceAll('\r\n', '\n');
  const manualLoop = worker.slice(worker.indexOf('MANUAL_STATUS="$(queue_value'), worker.indexOf('DRIFT_STATUS="$(queue_value'));
  const fallbackStart = worker.indexOf('FALLBACK_STATUS="$(queue_value');
  const fallbackLoop = worker.slice(fallbackStart, worker.indexOf('\ndone', fallbackStart) + 5);
  const resultReader = worker.slice(worker.indexOf('processed_result_value() {'), worker.indexOf('\nresult_top_level_value()'));
  for (const scenario of ['success', 'recoverable', 'prewrite-failed', 'later-blocker', 'earlier-blocker']) {
    const shellResult = {...JSON.parse(manualResultBytes), processedThisRunResults: [{ok:true}, {ok:true}, {ok:true}]};
    if (scenario === 'recoverable') shellResult.processedThisRunResults[2] = {recoverableDeferred:true};
    if (scenario === 'later-blocker') shellResult.processedThisRunResults[2] = {terminalBlocked:true};
    await fs.writeFile(manualResult, JSON.stringify(shellResult));
    const control = spawnSync('bash', ['-c', `set -euo pipefail
REMAINING_GROUPS=32
IMMEDIATE_CONTINUATION_MODE=1
DATE=test
MANUAL_STATE=pending
FALLBACK_STATE=pending
MANUAL_COUNT=0
FALLBACK_COUNT=0
FALLBACK_GRACEFUL_CUTOFF_EPOCH=1
FALLBACK_OUTER_HARD_DEADLINE_EPOCH=2
FALLBACK_MIN_START_BUDGET_SEC=900
QUEUE_FILE=queue
IMMEDIATE_RECEIPT_FILE=receipt
IMMEDIATE_RECEIPT_SHA256=hash
EXECUTOR_CONTINUATION_ARGS=()
EXECUTOR_DEADLINE_ARGS=()
assert_browser_lease_healthy() { :; }
refresh_executor_continuation_args() { :; }
begin_stage_critical_section() { :; }
write_state() { :; }
runtime_location() { echo "$1"; }
runtime_read() { echo "$MANUAL_RESULT"; }
queue_value() { case "$1" in *manualSpecialRestore*status*) echo "$MANUAL_STATE";; *fallbackRepair*status*) echo "$FALLBACK_STATE";; *) echo fixture;; esac; }
update_stage() { if [[ "$1" == manualSpecialRestore ]]; then MANUAL_STATE="$2"; else FALLBACK_STATE="$2"; fi; }
consume_group_budget() { REMAINING_GROUPS=$((REMAINING_GROUPS-$1)); }
defer_remaining_work() { exit 99; }
processed_items_this_run() { echo 1; }
new_groups_in_result() { echo 1; }
result_top_level_value() { echo 0; }
result_total() { if [[ "$2" == remainingItems && ( "$MANUAL_COUNT" -lt 3 || "$SCENARIO" == prewrite-failed ) ]]; then echo 1; elif [[ "$2" == terminalBlocked && ( "$SCENARIO" == later-blocker || "$SCENARIO" == earlier-blocker ) ]]; then echo 1; else echo 0; fi; }
node() {
 case "$*" in
 scripts/resolve_cloud_runtime_artifact.mjs*) echo fixture;;
 scripts/marketing/batch_restore_manual_limited_discounts.mjs*) [[ "$*" == *"--max-items 1"* ]] || return 88; MANUAL_COUNT=$((MANUAL_COUNT+1)); if [[ "$SCENARIO" == recoverable && "$MANUAL_COUNT" == 3 ]]; then return 4; elif [[ "$SCENARIO" == prewrite-failed || ( "$SCENARIO" == later-blocker && "$MANUAL_COUNT" == 3 ) ]]; then return 2; fi;;
 scripts/marketing/batch_apply_new_listing_limited_discount.mjs*) [[ "$*" == *"--max-groups 1"* ]] || return 89; FALLBACK_COUNT=$((FALLBACK_COUNT+1)); if (( FALLBACK_COUNT < 18 )); then return 3; fi;;
 *) command node "$@";;
 esac
}
${resultReader}
trap 'echo "counts:$MANUAL_COUNT:$FALLBACK_COUNT:$MANUAL_STATE"' EXIT
${manualLoop}
${fallbackLoop}
[[ "$REMAINING_GROUPS" == 11 && "$FALLBACK_STATE" == completed ]]
echo "worker-control:$SCENARIO:$MANUAL_STATE:$FALLBACK_STATE:$REMAINING_GROUPS"
`], {encoding:'utf8', env:{...process.env, MANUAL_RESULT:manualResult, SCENARIO:scenario}});
    if (['recoverable', 'prewrite-failed'].includes(scenario)) {
      assert.equal(control.status, 75, control.stderr);
      assert.match(control.stdout, /counts:[13]:0:pending/, 'pending manual must never start fallback');
    } else {
      assert.equal(control.status, 0, `${scenario}: ${control.stdout}\n${control.stderr}`);
      assert.match(control.stdout, scenario.endsWith('blocker') ? /worker-control:.*:blocked:completed/ : /worker-control:/);
    }
  }
  await fs.writeFile(manualResult, manualResultBytes);
  assert.deepEqual(await fs.readFile(receiptFile), receiptBytes);
  assert.equal(await fs.lstat(authFile).then(() => true, () => false), false);
  assert.deepEqual(await fs.readFile(planPath), Buffer.from(JSON.stringify(fallback.plan)));
  console.log(JSON.stringify({ok: true, manualStarted, fallbackStarted, legacyRows: 90, sameConsumedReceipt: true, offlineExecutors: true, workerControlScenarios: 5, persistentSnapshotRestart: true,
    failedQueueContinuation:true,isolatedManualAttempts:isolatedAttempts,independentManualPosts:continuationPosts,partialGroupPosts:partialPosts}));
} finally {
  if (fd !== undefined) fss.closeSync(fd);
  Date.now = realNow;
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
  await fs.unlink(path.join(root, 'lib')).catch(() => {});
  await fs.rm(root, {recursive: true, force: true});
}
