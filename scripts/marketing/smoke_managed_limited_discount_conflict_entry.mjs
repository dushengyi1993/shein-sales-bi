#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  processStore,
  replacementParentDeadlinePlan,
  transactionPreflightPartition,
} from './batch_apply_new_listing_limited_discount.mjs';
import {partitionManagedLimitedDiscountPreflight} from './_managed_limited_discount_conflict.mjs';

const CODE_0004 = 'mrs-simple_platform_limit_discounts-0004';
const CODE_0006 = 'mrs-simple_platform_limit_discounts-0006';
const CODE_101018 = 'mrs-simple_platform_limit_discounts-101018';
const XL = 'sv260620170564657240918';
const CX = 'sv260208160131176970947';

const xlFull = conflictFull({
  activityId: 88941940,
  targetSkcs: [XL],
  extraSkcs: [],
  invalid: [queryError(XL, CODE_0004)],
});
assert.deepEqual(partitionManagedLimitedDiscountPreflight(xlFull).managedConflictSkcs, []);
assert.deepEqual(partitionManagedLimitedDiscountPreflight(xlFull).blockedSkcs, [XL]);

const cxExtras = Array.from({length: 16}, (_, index) => `CX-EXTRA-${index + 1}`);
const cxFull = conflictFull({
  activityId: 88312850,
  targetSkcs: [CX],
  extraSkcs: cxExtras,
  invalid: [queryError(CX, CODE_0004)],
});
const cxPartition = transactionPreflightPartition(cxFull, {ok: true, rows: []});
assert.deepEqual(cxPartition.managedConflictSkcs, []);
assert.deepEqual(cxPartition.blockedSkcs, [CX]);

const noConflict = conflictFull({activityId: null, targetSkcs: [], extraSkcs: [], invalid: [queryError(XL, CODE_0004)]});
assert.deepEqual(partitionManagedLimitedDiscountPreflight(noConflict).blockedSkcs, [XL]);

const sameSkcPermanentGate = conflictFull({
  activityId: 88941940,
  targetSkcs: [XL],
  extraSkcs: [],
  invalid: [queryError(XL, CODE_0004), queryError(XL, CODE_101018)],
});
assert.deepEqual(partitionManagedLimitedDiscountPreflight(sameSkcPermanentGate).blockedSkcs, [XL]);

const unscopedUnknown = conflictFull({
  activityId: 88941940,
  targetSkcs: [XL],
  extraSkcs: [],
  invalid: [{reason: 'unknown platform validation failure', error_code: 'UNMAPPED'}],
});
assert.deepEqual(partitionManagedLimitedDiscountPreflight(unscopedUnknown).blockedSkcs, [XL]);

const fyRows = ['FY-ZERO-1', 'FY-ZERO-2', 'FY-ZERO-3', 'FY-SAFE'];
const fyInvalid = [
  ...fyRows.map(skc => queryError(skc, CODE_0006)),
  ...fyRows.slice(0, 3).flatMap(skc => [
    {skc, reason: 'inventory below min_stock', inventory: 0, minStock: 3},
    {skc, reason: 'inventory below configured activity stock', inventory: 0, attendNum: 10},
  ]),
];
const fyFull = conflictFull({
  activityId: 88921735,
  targetSkcs: fyRows,
  extraSkcs: Array.from({length: 13}, (_, index) => `FY-EXTRA-${index + 1}`),
  invalid: fyInvalid,
});
const fyPartition = transactionPreflightPartition(fyFull, {ok: true, rows: []});
assert.deepEqual(fyPartition.blockedSkcs, fyRows.slice(0, 3));
assert.deepEqual(fyPartition.managedConflictSkcs, ['FY-SAFE']);

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-limited-conflict-entry-'));
try {
  const singleRescuePath = path.join(temp, 'XL-rescue.json');
  await fs.writeFile(singleRescuePath, JSON.stringify(rescue('XL', [{skc: XL, limitedDiscountPrice: 97.58}])), 'utf8');
  const singleCalls = [];
  const single = await processStore({
    file: {storeKey: 'XL', path: singleRescuePath, count: 1},
    storeMap: new Map([['XL', {storeKey: 'XL', port: 9999}]]),
    args: processArgs(temp),
    manualIndex: {activeByKey: new Map()},
    browserSession: {ready: true, keepOpen: true, launchSummary: {ok: true}},
    operations: entryOperations({initialFull: xlFull, calls: singleCalls}),
  });
  assert.equal(single.ok, false);
  assert.equal(single.status, 'platform_or_inventory_blocked');
  assert.deepEqual(single.managedConflictReplacement.skcs, []);
  assert.deepEqual(singleCalls.filter(call => call.type === 'replace'), []);

  const fyRescuePath = path.join(temp, 'FY-rescue.json');
  await fs.writeFile(fyRescuePath, JSON.stringify(rescue('FY', fyRows.map((skc, index) => ({
    skc,
    limitedDiscountPrice: 90 + index,
  })))), 'utf8');
  const fyCalls = [];
  const fyResult = await processStore({
    file: {storeKey: 'FY', path: fyRescuePath, count: fyRows.length},
    storeMap: new Map([['FY', {storeKey: 'FY', port: 9998}]]),
    args: processArgs(temp),
    manualIndex: {activeByKey: new Map()},
    browserSession: {ready: true, keepOpen: true, launchSummary: {ok: true}},
    operations: entryOperations({initialFull: fyFull, calls: fyCalls}),
  });
  assert.equal(fyResult.status, 'executed_subset_with_platform_or_inventory_blockers');
  assert.equal(fyResult.ok, false);
  assert.deepEqual(fyResult.blocked.blockedSkcs, fyRows.slice(0, 3));
  const fyReplace = fyCalls.find(call => call.type === 'replace');
  assert.deepEqual(fyReplace.rows, ['FY-SAFE']);

  const nowEpoch = Math.floor(Date.now() / 1000);
  const longDeadline = {
    gracefulCutoffEpoch: nowEpoch + 3600,
    outerHardDeadlineEpoch: nowEpoch + 7200,
    minFinalizationBudgetSec: 900,
  };
  const parentPlan = replacementParentDeadlinePlan({deadline: longDeadline, execute: true, nowMs: nowEpoch * 1000});
  assert.equal(parentPlan.parentHardDeadlineEpoch, longDeadline.outerHardDeadlineEpoch + 900);
  assert.ok(parentPlan.timeoutMs > 1800000, 'a far child deadline must not retain the old independent 1800-second parent cap');

  const parentEvidencePath = path.join(temp, 'parent-deadline-argv.json');
  const parentResultPath = path.join(temp, 'parent-replacement-result.json');
  const fakeReplacement = path.join(temp, 'fake-parent-replacement.mjs');
  await fs.writeFile(fakeReplacement, `
import fs from 'node:fs/promises';
const argv=process.argv.slice(2);const value=k=>argv[argv.indexOf(k)+1];
await fs.writeFile(process.env.PARENT_DEADLINE_EVIDENCE,JSON.stringify({parent:Number(value('--parent-hard-deadline-epoch')),outer:Number(value('--outer-hard-deadline-epoch')),reserve:Number(value('--min-finalization-budget-sec'))}));
const full={ok:true,safe:true,status:'replaced_all',writeAttempted:true,mutationsStarted:true,targetSkcs:['PARENT-SKC'],desiredCoveredSkcs:['PARENT-SKC'],desiredCreate:{createdActivityId:99111}};
await fs.writeFile(process.env.PARENT_REPLACEMENT_RESULT,JSON.stringify(full));
console.log(JSON.stringify({ok:true,out:process.env.PARENT_REPLACEMENT_RESULT}));
`);
  const previousReplacementScript = process.env.SHEIN_MARKETING_REPLACE_SCRIPT;
  process.env.SHEIN_MARKETING_REPLACE_SCRIPT = fakeReplacement;
  process.env.PARENT_DEADLINE_EVIDENCE = parentEvidencePath;
  process.env.PARENT_REPLACEMENT_RESULT = parentResultPath;
  const parentSkc = 'PARENT-SKC';
  const parentRescuePath = path.join(temp, 'parent-rescue.json');
  await fs.writeFile(parentRescuePath, JSON.stringify(rescue('PX', [{skc: parentSkc, limitedDiscountPrice: 88}])), 'utf8');
  try {
    const parentCalls = [];
    const parentResult = await processStore({
      file: {storeKey: 'PX', path: parentRescuePath, count: 1},
      storeMap: new Map([['PX', {storeKey: 'PX', port: 9997}]]),
      args: {...processArgs(temp), deadline: longDeadline},
      manualIndex: {activeByKey: new Map()},
      browserSession: {ready: true, keepOpen: true, launchSummary: {ok: true}},
      operations: entryOperations({
        initialFull: conflictFull({activityId: 88929999, targetSkcs: [parentSkc], extraSkcs: [], invalid: [queryError(parentSkc, CODE_0006)]}),
        calls: parentCalls,
        realReplacement: true,
      }),
    });
    assert.equal(parentResult.status, 'executed');
    const propagated = JSON.parse(await fs.readFile(parentEvidencePath, 'utf8'));
    assert.deepEqual(propagated, {
      parent: longDeadline.outerHardDeadlineEpoch + longDeadline.minFinalizationBudgetSec,
      outer: longDeadline.outerHardDeadlineEpoch,
      reserve: longDeadline.minFinalizationBudgetSec,
    });
  } finally {
    if (previousReplacementScript === undefined) delete process.env.SHEIN_MARKETING_REPLACE_SCRIPT;
    else process.env.SHEIN_MARKETING_REPLACE_SCRIPT = previousReplacementScript;
    delete process.env.PARENT_DEADLINE_EVIDENCE;
    delete process.env.PARENT_REPLACEMENT_RESULT;
  }

  console.log(JSON.stringify({
    ok: true,
    test: 'real_processStore_blocks_0004_and_routes_only_explicit_0006_occupancy',
    evidenceShapes: ['XL-single-0004-blocked', 'CX-mixed-16-0004-blocked', 'FY-mixed-13-with-three-zero-stock'],
  }));
} finally {
  await fs.rm(temp, {recursive: true, force: true});
}

function queryError(skc, error_code) {
  return {skc, reason: 'query_goods error_code', error_code};
}

function conflictFull({activityId, targetSkcs, extraSkcs, invalid}) {
  return {
    ok: false,
    reason: 'live preflight conflict',
    before: {
      conflictActivities: activityId ? [{
        activity_id: activityId,
        act_name: 'existing managed limited discount',
        state: 3,
        start_time: '2026-09-01 00:00:00',
        end_time: '2026-09-28 23:59:59',
        targetSkcs,
        extraSkcs,
        targetGoods: targetSkcs.map((skc, index) => ({
          skc,
          product_act_price: 80 + index,
          attend_num_sum: 10,
          stock_num: 90,
        })),
      }] : [],
    },
    validation: {missing: [], invalid, addRows: targetSkcs.length},
    skippedUnreportable: [],
    unsafeExistingLimitedDiscounts: activityId && extraSkcs.length ? [{
      activity_id: activityId,
      reason: 'activity contains non-target goods',
      extraSkcs,
    }] : [],
  };
}

function rescue(storeKey, rows) {
  return {
    storeKey,
    purpose: 'offline_managed_conflict_entry_smoke',
    endTime: '2026-10-11 23:59:59',
    activityStock: 10,
    rows: rows.map(row => ({
      storeKey,
      canonical: row.skc,
      finalTargetPrice: row.limitedDiscountPrice,
      activityStock: 10,
      needsLimitedDiscount: true,
      ...row,
    })),
  };
}

function processArgs(outDir) {
  return {
    continuation: false,
    date: '2026-09-11',
    outDir,
    dryRunOnly: false,
    expectedWorkFingerprint: '',
    legacyReceiptCapability: null,
    deadline: null,
  };
}

function entryOperations({initialFull, calls, realReplacement = false}) {
  let applyCalls = 0;
  return {
    revalidateLowEtFastSellerRescueArtifact: async () => ({ok: true, reason: 'offline-current'}),
    planLimitedDiscountInventoryTransaction: async () => ({ok: true, ready: true, rows: [], blockers: []}),
    applyRescue: async ({rescuePath, execute}) => {
      assert.equal(execute, false);
      const current = JSON.parse(await fs.readFile(rescuePath, 'utf8'));
      applyCalls += 1;
      calls.push({type: 'apply', rows: current.rows.map(row => row.skc)});
      if (applyCalls === 1) return commandResult(initialFull);
      const subsetSkcs = current.rows.map(row => row.skc);
      return commandResult(conflictFull({
        activityId: 88921735,
        targetSkcs: subsetSkcs,
        extraSkcs: Array.from({length: 13}, (_, index) => `FY-EXTRA-${index + 1}`),
        invalid: subsetSkcs.map(skc => queryError(skc, CODE_0006)),
      }));
    },
    ...(!realReplacement ? {replaceTransactionally: async ({rescuePath, execute}) => {
      const current = JSON.parse(await fs.readFile(rescuePath, 'utf8'));
      calls.push({type: 'replace', execute, rows: current.rows.map(row => row.skc)});
      return commandResult({
        ok: true,
        safe: true,
        terminal: false,
        status: 'replaced_all',
        writeAttempted: true,
        mutationsStarted: true,
        targetSkcs: current.rows.map(row => row.skc),
        desiredCoveredSkcs: current.rows.map(row => row.skc),
        desiredCreate: {createdActivityId: 99001},
      }, 0);
    }} : {}),
    executeLimitedDiscountWithInventoryTransaction: async options => {
      const command = await options.runSubmit();
      return {
        ok: true,
        safe: true,
        writeAttempted: true,
        blockers: [],
        extractedTargets: [],
        commandResult: command,
      };
    },
  };
}

function commandResult(full, exitCode = 2) {
  return {
    ok: exitCode === 0,
    exitCode,
    timedOut: false,
    stdout: '',
    stderr: '',
    error: '',
    parsed: null,
    outPath: '',
    full,
  };
}
