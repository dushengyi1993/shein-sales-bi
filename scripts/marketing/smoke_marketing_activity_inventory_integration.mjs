#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  executeLimitedDiscountWithInventoryTransaction,
  extractLimitedDiscountInventoryTargets,
} from '../../lib/marketing_activity_inventory_integration.mjs';
import {executeOrdinaryActivityWithInventoryTransaction} from '../../lib/marketing_ordinary_activity_transaction_runner.mjs';

const ROOT = process.cwd();
const transactionHash = crypto.createHash('sha256').update('integration-smoke').digest('hex');
const ordinaryDryResult = {
  store: 'LQ',
  activity: {activityId: 50001},
  selection: {
    activityInventoryTransactionPlan: {
      ok: true,
      source: 'ordinary_activity_query_supplier_goods_list_v2',
      blockers: [],
      rows: [{
        skc: 'sv-ordinary',
        canonical: 'SK-TEST',
        currentUsableInventory: 6,
        minimumUsableInventory: 10,
        minimumSourceField: 'min_stock',
        requiresTemporaryRaise: true,
      }],
    },
  },
};
const ordinaryState = fakeAdapterState();
let ordinarySubmitCalls = 0;
let ordinaryVerifyCalls = 0;
const ordinary = await executeOrdinaryActivityWithInventoryTransaction({
  root: ROOT,
  storeKey: 'LQ',
  dryResults: [ordinaryDryResult],
  transactionHash,
  adapterFactory: fakeAdapterFactory(ordinaryState),
  runSubmit: async () => {
    ordinarySubmitCalls += 1;
    return {ok: true, code: 0, execute: {ok: true, submit: {submitted: true}}};
  },
  runVerify: async () => {
    ordinaryVerifyCalls += 1;
    return {
      ok: true,
      missingRows: 0,
      priceMismatchRows: 0,
      extraAvailableRows: 0,
      activityListGapRows: 0,
      badPacketActivities: 0,
    };
  },
});
assert.equal(ordinary.ok, true);
assert.equal(ordinarySubmitCalls, 1);
assert.equal(ordinaryVerifyCalls, 2);
assert.equal(ordinaryState.stock.totalUsableInventory, 6);
assert.equal(ordinary.writeAttempted, true);

for (const purpose of [
  'manual_special_restore',
  'target_price_drift',
  'new_listing_relisted_missing_fallback',
  'high_click_special_via_manual_restore',
]) {
  const rescue = {
    purpose,
    activityStock: 10,
    endTime: '2026-08-09 23:59:59',
    rows: [{
      storeKey: 'LQ',
      skc: `sv-${purpose}`,
      canonical: 'SK-TEST',
      limitedDiscountPrice: 100,
      activityStock: 10,
    }],
  };
  const preflightFull = {
    validation: {
      invalid: [{
        skc: rescue.rows[0].skc,
        reason: 'inventory below configured activity stock',
        inventory: 6,
        attendNum: 10,
        minStock: 3,
      }],
    },
  };
  const extracted = extractLimitedDiscountInventoryTargets({storeKey: 'LQ', rescue, preflightFull});
  assert.equal(extracted.targets.length, 1);
  assert.equal(extracted.targets[0].minimumUsableInventory, 10);
  const state = fakeAdapterState();
  let enrollmentReads = 0;
  const result = await executeLimitedDiscountWithInventoryTransaction({
    root: ROOT,
    storeKey: 'LQ',
    rescue,
    preflightFull,
    transactionHash: crypto.createHash('sha256').update(purpose).digest('hex'),
    adapterFactory: fakeAdapterFactory(state),
    runSubmit: async () => ({ok: true, full: limitedReadback(rescue)}),
    runEnrollmentReadback: async () => {
      enrollmentReads += 1;
      return {ok: true, full: limitedReadback(rescue)};
    },
  });
  assert.equal(result.ok, true, purpose);
  assert.equal(enrollmentReads, 2, purpose);
  assert.equal(state.stock.totalUsableInventory, 6, purpose);
}

const sources = {
  manual: await read('scripts/marketing/batch_restore_manual_limited_discounts.mjs'),
  drift: await read('scripts/marketing/batch_fix_limited_discount_drift.mjs'),
  fallback: await read('scripts/marketing/batch_apply_new_listing_limited_discount.mjs'),
  highClick: await read('scripts/marketing/batch_apply_high_click_special_discounts.mjs'),
  store: await read('scripts/marketing/run_ordinary_store_submission_batch.mjs'),
  chunk: await read('scripts/marketing/run_ordinary_chunk_submission_batch.mjs'),
  singleton: await read('scripts/marketing/run_ordinary_singleton_recovery_batch.mjs'),
  legacy: await read('scripts/marketing/manage_manual_limited_discount_inventory.mjs'),
};
for (const key of ['manual', 'drift', 'fallback']) {
  assert.match(sources[key], /executeLimitedDiscountWithInventoryTransaction/, key);
  assert.doesNotMatch(sources[key], /manage_manual_limited_discount_inventory\.mjs/, key);
}
assert.match(sources.highClick, /batch_restore_manual_limited_discounts\.mjs/);
for (const key of ['store', 'chunk', 'singleton']) {
  assert.match(sources[key], /executeOrdinaryActivityWithInventoryTransaction/, key);
}
assert.match(sources.legacy, /Legacy persistent marketing inventory top-up is disabled/);

console.log(JSON.stringify({
  ok: true,
  checks: 34,
  ordinaryRunners: 3,
  limitedDiscountPaths: 4,
  legacyPersistentTopUpExecutable: false,
}, null, 2));

function fakeAdapterState() {
  return {
    stock: {
      skuCode: 'sku-test',
      totalInventoryQuantity: 8,
      totalUsableInventory: 6,
      totalLockedQuantity: 2,
    },
  };
}

function fakeAdapterFactory(state) {
  return async () => ({
    resolveTargets: async targets => targets.map(target => ({...target, skuCode: 'sku-test'})),
    acquireLock: async () => async () => {},
    readStock: async () => ({...state.stock}),
    writeStock: async ({overwriteQuantity}) => {
      const unavailable = Math.max(
        state.stock.totalLockedQuantity,
        state.stock.totalInventoryQuantity - state.stock.totalUsableInventory,
      );
      state.stock.totalInventoryQuantity = overwriteQuantity;
      state.stock.totalUsableInventory = overwriteQuantity - unavailable;
      return {ok: true};
    },
  });
}

function limitedReadback(rescue) {
  return {
    ok: true,
    before: {
      conflictActivities: [{
        state: 2,
        end_time: rescue.endTime,
        targetGoods: rescue.rows.map(row => ({
          skc: row.skc,
          product_act_price: row.limitedDiscountPrice,
          attend_num_sum: row.activityStock,
        })),
      }],
    },
  };
}

async function read(file) {
  return await fs.readFile(path.join(ROOT, file), 'utf8');
}
