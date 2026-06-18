#!/usr/bin/env node
import assert from 'node:assert/strict';
import {summarizeCouponBudgetStatus} from '../../lib/marketing_coupon_budget_guard.mjs';

const storesConfigDoc = {
  stores: [
    {storeKey: 'A', enabled: true},
    {storeKey: 'B', enabled: true},
    {storeKey: 'C', enabled: true},
    {storeKey: 'D', enabled: true},
  ],
};

const okSource = {exists: true, status: 'ok', path: 'fixture-execute.json'};
const staleSource = {exists: true, status: 'stale', path: 'fixture-execute-stale.json'};
const dryRunSource = {exists: true, status: 'ok', path: 'fixture-dry-run.json'};
const readbackSource = {exists: true, status: 'ok', path: 'fixture-readback.json'};

const executeDoc = {
  createdAt: '2026-06-06T00:00:00.000Z',
  activityId: 34810,
  site: 'shein-sa',
  currency: 'SAR',
  budget: 1000,
  targetBudget: 1000,
  mode: 'execute',
  execute: true,
  readOnly: false,
  writeAttempted: true,
  writeEndpointCalls: 6,
  stores: [
    {
      storeKey: 'A',
      activityId: 34810,
      site: 'shein-sa',
      currency: 'SAR',
      requestedBudget: 1000,
      ok: false,
      write: {
        activityLimit: {code: '0', msg: 'OK'},
        siteBudget: {code: '1017', msg: '规则不存在或者已经失效无法更新'},
      },
      before: {usageSite: {coupon_usage_upper_limit: 1000, coupon_used_amount: 0}},
      after: {usageSite: {coupon_usage_upper_limit: 1000, coupon_used_amount: 0}},
      reason: 'verification failed: writeOk=false budgetInfoOk=true usageOk=true',
    },
    {
      storeKey: 'B',
      activityId: 34810,
      site: 'shein-sa',
      currency: 'SAR',
      requestedBudget: 1000,
      ok: true,
      before: {usageSite: {coupon_usage_upper_limit: 1000}},
      after: {usageSite: {coupon_usage_upper_limit: 900}},
    },
    {
      storeKey: 'C',
      activityId: 34810,
      site: 'shein-sa',
      currency: 'SAR',
      requestedBudget: 1000,
      ok: true,
      before: {budgetInfoSite: {coupon_usage_upper_limit: 1000}},
      after: {},
    },
    {
      storeKey: 'D',
      activityId: 34810,
      site: 'shein-sa',
      currency: 'SAR',
      requestedBudget: 1000,
      ok: true,
      before: {},
      after: {},
    },
  ],
  failures: [{storeKey: 'A', reason: 'write failed but readback ok'}],
};

const dryRunDoc = {
  createdAt: '2026-06-06T00:01:00.000Z',
  activityId: 34810,
  site: 'shein-sa',
  currency: 'SAR',
  budget: 1000,
  execute: false,
  stores: [
    {storeKey: 'A', before: {usageSite: {coupon_usage_upper_limit: 1000}}},
    {storeKey: 'B', before: {usageSite: {coupon_usage_upper_limit: 1000}}},
    {storeKey: 'C', before: {usageSite: {coupon_usage_upper_limit: 1000}}},
    {storeKey: 'D', before: {usageSite: {coupon_usage_upper_limit: 1000}}},
  ],
};

const readbackDoc = {
  createdAt: '2026-06-06T00:02:00.000Z',
  activityId: 34810,
  site: 'shein-sa',
  currency: 'SAR',
  budget: 1000,
  targetBudget: 1000,
  mode: 'readback',
  execute: false,
  readOnly: true,
  writeAttempted: false,
  writeEndpointCalls: 0,
  stores: ['A', 'B', 'C', 'D'].map(storeKey => ({
    storeKey,
    activityId: 34810,
    site: 'shein-sa',
    currency: 'SAR',
    requestedBudget: 1000,
    execute: false,
    readOnly: true,
    writeAttempted: false,
    writeEndpointCalls: 0,
    ok: true,
    readback: {ok: true},
    before: {
      budgetInfoCode: '0',
      usageCode: '0',
      budgetInfoSite: {site: 'shein-sa', currency: 'SAR', coupon_usage_upper_limit: 1000, coupon_used_amount: 0},
      usageSite: {site: 'shein-sa', coupon_usage_upper_limit: 1000, coupon_used_amount: 0},
    },
  })),
};

const summary = summarizeCouponBudgetStatus({
  executeDoc,
  executeSource: okSource,
  dryRunDoc,
  dryRunSource,
  storesConfigDoc,
  targetBudget: 1000,
});

assert.equal(summary.status, 'blocked');
assert.equal(summary.writeFailureButAtTargetCount, 1);
assert.deepEqual(summary.writeFailureButAtTargetStores.map(s => s.storeKey), ['A']);
assert.equal(summary.belowTargetCount, 1);
assert.deepEqual(summary.belowTargetStores.map(s => s.storeKey), ['B']);
assert.equal(summary.rows.find(r => r.storeKey === 'B').evidenceSource, 'after.usageSite.coupon_usage_upper_limit');
assert.equal(summary.missingEvidenceCount, 1);
assert.deepEqual(summary.missingEvidenceStores.map(s => s.storeKey), ['D']);
assert.equal(summary.rows.find(r => r.storeKey === 'C').status, 'at_target');
assert.equal(summary.rows.find(r => r.storeKey === 'C').evidenceSource, 'before.budgetInfoSite.coupon_usage_upper_limit');

const staleExecuteSummary = summarizeCouponBudgetStatus({
  executeDoc,
  executeSource: staleSource,
  dryRunDoc,
  dryRunSource,
  storesConfigDoc,
  targetBudget: 1000,
});
assert.equal(staleExecuteSummary.selectedSource, 'execute_stale_not_accepted');
assert.equal(staleExecuteSummary.verifiedAtTargetCount, 0);
assert.equal(staleExecuteSummary.missingEvidenceCount, 4);
assert.equal(staleExecuteSummary.missingEvidenceStores.every(s => s.hasDryRunObservation), true);

const dryRunOnlySummary = summarizeCouponBudgetStatus({
  executeDoc: null,
  executeSource: {exists: false, status: 'missing', path: ''},
  dryRunDoc,
  dryRunSource,
  storesConfigDoc,
  targetBudget: 1000,
});
assert.equal(dryRunOnlySummary.selectedSource, 'dry_run_only_not_completion_evidence');
assert.equal(dryRunOnlySummary.verifiedAtTargetCount, 0);
assert.equal(dryRunOnlySummary.missingEvidenceCount, 4);

const readbackSummary = summarizeCouponBudgetStatus({
  executeDoc: null,
  executeSource: {exists: false, status: 'missing', path: ''},
  readbackDoc,
  readbackSource,
  dryRunDoc,
  dryRunSource,
  storesConfigDoc,
  targetBudget: 1000,
});
assert.equal(readbackSummary.status, 'ok');
assert.equal(readbackSummary.selectedSource, 'readback_current');
assert.equal(readbackSummary.verifiedAtTargetCount, 4);
assert.equal(readbackSummary.missingEvidenceCount, 0);
assert.equal(readbackSummary.belowTargetCount, 0);
assert.equal(readbackSummary.rows.every(r => r.selectedSource === 'readback_current'), true);

const staleReadbackSummary = summarizeCouponBudgetStatus({
  executeDoc: null,
  executeSource: {exists: false, status: 'missing', path: ''},
  readbackDoc,
  readbackSource: staleSource,
  dryRunDoc,
  dryRunSource,
  storesConfigDoc,
  targetBudget: 1000,
});
assert.equal(staleReadbackSummary.selectedSource, 'readback_stale_not_accepted');
assert.equal(staleReadbackSummary.verifiedAtTargetCount, 0);
assert.equal(staleReadbackSummary.missingEvidenceCount, 4);

const partialReadbackDoc = structuredClone(readbackDoc);
partialReadbackDoc.stores[3] = {
  ...partialReadbackDoc.stores[3],
  ok: false,
  readback: {ok: false, failures: ['usage below target: 900<1000']},
  before: {
    budgetInfoCode: '0',
    usageCode: '0',
    budgetInfoSite: {site: 'shein-sa', currency: 'SAR', coupon_usage_upper_limit: 1000},
    usageSite: {site: 'shein-sa', coupon_usage_upper_limit: 900},
  },
  reason: 'read-only current site budget evidence failed: usage below target: 900<1000',
};
const partialReadbackSummary = summarizeCouponBudgetStatus({
  executeDoc: null,
  executeSource: {exists: false, status: 'missing', path: ''},
  readbackDoc: partialReadbackDoc,
  readbackSource,
  storesConfigDoc,
  targetBudget: 1000,
});
assert.equal(partialReadbackSummary.status, 'blocked');
assert.equal(partialReadbackSummary.verifiedAtTargetCount, 3);
assert.equal(partialReadbackSummary.missingEvidenceCount, 1);
assert.deepEqual(partialReadbackSummary.missingEvidenceStores.map(s => s.storeKey), ['D']);

const readbackWithTopLevelWriteDoc = structuredClone(readbackDoc);
readbackWithTopLevelWriteDoc.writeEndpointCalls = 1;
const readbackWithTopLevelWriteSummary = summarizeCouponBudgetStatus({
  executeDoc: null,
  executeSource: {exists: false, status: 'missing', path: ''},
  readbackDoc: readbackWithTopLevelWriteDoc,
  readbackSource,
  storesConfigDoc,
  targetBudget: 1000,
});
assert.equal(readbackWithTopLevelWriteSummary.selectedSource, 'readback_invalid_scope_not_accepted');
assert.equal(readbackWithTopLevelWriteSummary.verifiedAtTargetCount, 0);
assert.equal(readbackWithTopLevelWriteSummary.missingEvidenceCount, 4);

const readbackWithRowWriteDoc = structuredClone(readbackDoc);
readbackWithRowWriteDoc.stores[0].write = {siteBudget: {code: '0'}};
const readbackWithRowWriteSummary = summarizeCouponBudgetStatus({
  executeDoc: null,
  executeSource: {exists: false, status: 'missing', path: ''},
  readbackDoc: readbackWithRowWriteDoc,
  readbackSource,
  storesConfigDoc,
  targetBudget: 1000,
});
assert.equal(readbackWithRowWriteSummary.selectedSource, 'readback_invalid_scope_not_accepted');
assert.equal(readbackWithRowWriteSummary.verifiedAtTargetCount, 0);
assert.equal(readbackWithRowWriteSummary.missingEvidenceCount, 4);

const wrongScopeReadbackDoc = structuredClone(readbackDoc);
wrongScopeReadbackDoc.activityId = 99999;
wrongScopeReadbackDoc.site = 'shein-ae';
wrongScopeReadbackDoc.currency = 'AED';
const wrongScopeReadbackSummary = summarizeCouponBudgetStatus({
  executeDoc: null,
  executeSource: {exists: false, status: 'missing', path: ''},
  readbackDoc: wrongScopeReadbackDoc,
  readbackSource,
  storesConfigDoc,
  targetBudget: 1000,
});
assert.equal(wrongScopeReadbackSummary.selectedSource, 'readback_invalid_scope_not_accepted');
assert.equal(wrongScopeReadbackSummary.verifiedAtTargetCount, 0);
assert.equal(wrongScopeReadbackSummary.missingEvidenceCount, 4);

const missingStoreReadbackDoc = structuredClone(readbackDoc);
missingStoreReadbackDoc.stores = missingStoreReadbackDoc.stores.filter(r => r.storeKey !== 'D');
const missingStoreReadbackSummary = summarizeCouponBudgetStatus({
  executeDoc: null,
  executeSource: {exists: false, status: 'missing', path: ''},
  readbackDoc: missingStoreReadbackDoc,
  readbackSource,
  storesConfigDoc,
  targetBudget: 1000,
});
assert.equal(missingStoreReadbackSummary.selectedSource, 'readback_current');
assert.equal(missingStoreReadbackSummary.verifiedAtTargetCount, 3);
assert.equal(missingStoreReadbackSummary.missingEvidenceCount, 1);
assert.deepEqual(missingStoreReadbackSummary.missingEvidenceStores.map(s => s.storeKey), ['D']);

const wrongScopeExecuteDoc = structuredClone(executeDoc);
wrongScopeExecuteDoc.site = 'shein-ae';
const wrongScopeExecuteSummary = summarizeCouponBudgetStatus({
  executeDoc: wrongScopeExecuteDoc,
  executeSource: okSource,
  dryRunDoc,
  dryRunSource,
  storesConfigDoc,
  targetBudget: 1000,
});
assert.equal(wrongScopeExecuteSummary.selectedSource, 'execute_invalid_scope_not_accepted');
assert.equal(wrongScopeExecuteSummary.verifiedAtTargetCount, 0);
assert.equal(wrongScopeExecuteSummary.missingEvidenceCount, 4);

console.log(JSON.stringify({
  ok: true,
  cases: [
    'write_failed_but_at_target',
    'after_overrides_before',
    'before_fallback',
    'missing_evidence',
    'stale_execute_not_accepted',
    'dry_run_only_not_completion_evidence',
    'readback_current_ok',
    'readback_stale_not_accepted',
    'partial_readback_blocked',
    'readback_top_level_write_blocked',
    'readback_row_write_blocked',
    'readback_wrong_scope_blocked',
    'readback_missing_store_blocked',
    'execute_wrong_scope_blocked',
  ],
}, null, 2));
