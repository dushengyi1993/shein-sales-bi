#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {resolveLimitedDiscountInventoryTopUpAction} from '../../lib/marketing_manual_limited_discount_overrides.mjs';
import {
  buildActivityInventoryIdempotencyKey,
  planActivityInventoryTransaction,
} from '../../lib/marketing_activity_inventory_transaction.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'authorized-fallback-inventory-'));
try {
  const rescuePath = path.join(tmp, 'rescue.json');
  await fs.writeFile(rescuePath, JSON.stringify({
    storeKey: 'LQ',
    endTime: '2026-07-23 23:59:59',
    activityStock: 10,
    rows: [{
      storeKey: 'LQ',
      skc: 'sv25100554440744444',
      canonical: 'SK-5110电磁炉',
      limitedDiscountPrice: 61.34,
      activityStock: 10,
      manualSpecialLimitedDiscount: false,
    }, {
      storeKey: 'LQ',
      skc: 'another-low-stock-skc',
      canonical: 'SK-11004蒸汽熨烫机',
      limitedDiscountPrice: 56.53,
      activityStock: 10,
      manualSpecialLimitedDiscount: false,
    }],
  }), 'utf8');

  // This pure helper is retained only to parse historical artifacts. Its
  // `top_up_platform_virtual_stock` decision is not an executable permission.
  assert.deepEqual(resolveLimitedDiscountInventoryTopUpAction({platformStock: 5, etStock: 234, activityStock: 10}), {
    ok: true,
    action: 'top_up_platform_virtual_stock',
    required: 10,
    platformStock: 5,
    etStock: 234,
    topUpTo: 10,
  });
  assert.equal(resolveLimitedDiscountInventoryTopUpAction({platformStock: 5, etStock: 9, activityStock: 10}).reason, 'et_stock_below_activity_stock');
  assert.equal(resolveLimitedDiscountInventoryTopUpAction({platformStock: 10, etStock: 0, activityStock: 10}).action, 'no_top_up_needed');

  const idempotencyInput = {
    transactionHash: 'a'.repeat(64),
    target: {
      storeKey: 'LQ',
      skc: 'sv25100554440744444',
      skuCode: 'SKU-1',
    },
    phase: 'temporary_raise',
    overwriteQuantity: 12,
    attempt: 1,
  };
  const firstIdempotencyKey = buildActivityInventoryIdempotencyKey(idempotencyInput);
  assert.equal(firstIdempotencyKey, buildActivityInventoryIdempotencyKey(idempotencyInput));
  assert.notEqual(firstIdempotencyKey, buildActivityInventoryIdempotencyKey({...idempotencyInput, overwriteQuantity: 13}));
  assert.notEqual(firstIdempotencyKey, buildActivityInventoryIdempotencyKey({...idempotencyInput, attempt: 2}));
  assert.match(firstIdempotencyKey, /^bi-marketing-activity-inventory-[a-f0-9]{64}$/);
  const transactionPlan = await planActivityInventoryTransaction({
    transactionHash: idempotencyInput.transactionHash,
    readStock: async () => ({
      totalUsableInventory: 5,
      totalInventoryQuantity: 7,
      totalLockedQuantity: 2,
      temporaryInventoryQuantity: 0,
    }),
    targets: [{
      storeKey: 'LQ',
      skc: idempotencyInput.target.skc,
      skuCode: idempotencyInput.target.skuCode,
      minimumUsableInventory: 10,
      minimumSource: 'dry_run',
    }],
  });
  assert.equal(transactionPlan.ok, true);
  assert.equal(transactionPlan.rows[0].requiresTemporaryRaise, true);
  assert.equal(transactionPlan.rows[0].temporaryOverwriteQuantity, 12);

  const driftBatchSource = await fs.readFile(path.join(process.cwd(), 'scripts/marketing/batch_fix_limited_discount_drift.mjs'), 'utf8');
  assert.match(driftBatchSource, /replace_limited_discount_transactionally\.mjs/);
  assert.doesNotMatch(driftBatchSource, /remove_skc_from_limited_discount\.mjs/);
  assert.match(driftBatchSource, /executeLimitedDiscountWithInventoryTransaction/);
  assert.doesNotMatch(driftBatchSource, /manage_manual_limited_discount_inventory\.mjs/);

  const fallbackBatchSource = await fs.readFile(path.join(process.cwd(), 'scripts/marketing/batch_apply_new_listing_limited_discount.mjs'), 'utf8');
  assert.match(fallbackBatchSource, /executeLimitedDiscountWithInventoryTransaction/);
  assert.doesNotMatch(fallbackBatchSource, /manage_manual_limited_discount_inventory\.mjs/);

  const inventoryManagerSource = await fs.readFile(path.join(process.cwd(), 'scripts/marketing/manage_manual_limited_discount_inventory.mjs'), 'utf8');
  assert.match(inventoryManagerSource, /Legacy persistent marketing inventory top-up is disabled/);
  assert.match(inventoryManagerSource, /if \(args\.execute\)/);

  console.log(JSON.stringify({
    ok: true,
    test: 'legacy_persistent_top_up_disabled_transaction_replacement',
    legacyDecisionCompatibilityOnly: 'top_up_platform_virtual_stock',
    exactTemporaryUsable: 10,
    exactTemporaryOverwriteQuantity: 12,
    deterministicIdempotencyKey: true,
    driftBatchUsesSafeTransaction: true,
    driftBatchUsesPersistentTopUp: false,
    multiSkcFallbackBatchUsesTransaction: true,
    legacyExecuteDisabled: true,
  }));
} finally {
  await fs.rm(tmp, {recursive: true, force: true});
}
