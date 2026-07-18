#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildLimitedDiscountDriftRescuePlan} from './build_limited_discount_drift_rescue_plan.mjs';
import {
  buildInventoryIdempotencyKey,
  computePlatformOverwriteQuantity,
  resolveInventoryTarget,
} from './manage_manual_limited_discount_inventory.mjs';

const guard = {
  reportDate: '2026-07-18',
  limitedDiscountTargetPriceDrift: {
    source: 'tmp/live.json',
    planSourcePath: 'tmp/price.json',
    belowRows: [{
      storeKey: 'LQ',
      skc: 'sv-test',
      canonical: 'KF-JN-02便携咖啡机',
      limitedDiscountPrice: 96.13,
      finalTargetPrice: 102.44,
      limitedDiscountName: '旧限时折扣',
      limitedDiscountEnd: '2026-07-21 23:59:59',
    }],
  },
};

const plan = buildLimitedDiscountDriftRescuePlan(guard, {
  manualRegistry: {entries: []},
  activityStock: 10,
});
assert.equal(plan.groups[0].rows[0].activityStock, 10);

const lockedSnapshot = {rows: [{totalInventoryQuantity: 10, totalUsableInventory: 9, totalLockedQuantity: 1}]};
assert.equal(computePlatformOverwriteQuantity(10, lockedSnapshot), 11);
assert.equal(computePlatformOverwriteQuantity(8, lockedSnapshot), 10, 'inventory recovery must not reduce current total inventory');
assert.notEqual(
  buildInventoryIdempotencyKey({store: 'LQ', skc: 'sv-test', activityStock: 10, overwriteQuantity: 10}),
  buildInventoryIdempotencyKey({store: 'LQ', skc: 'sv-test', activityStock: 10, overwriteQuantity: 11}),
  'locked-stock compensation must produce a fresh idempotency key',
);

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'limited-drift-stock-'));
try {
  const rescuePath = path.join(tempDir, 'legacy-rescue.json');
  await fs.writeFile(rescuePath, JSON.stringify({
    storeKey: 'LQ',
    endTime: '2026-07-25 23:59:59',
    rows: [{
      skc: 'sv-test',
      canonical: 'KF-JN-02便携咖啡机',
      limitedDiscountPrice: 102.44,
    }],
  }));
  const target = await resolveInventoryTarget({store: 'LQ', skc: 'sv-test', rescue: rescuePath});
  assert.equal(target.activityStock, 10);
  assert.equal(target.mode, 'authorized_auto_fallback');
} finally {
  await fs.rm(tempDir, {recursive: true, force: true});
}

console.log('limited discount drift activity stock smoke: ok');
