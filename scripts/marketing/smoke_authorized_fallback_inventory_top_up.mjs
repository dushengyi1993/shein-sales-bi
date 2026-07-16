#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {resolveLimitedDiscountInventoryTopUpAction} from '../../lib/marketing_manual_limited_discount_overrides.mjs';
import {buildInventoryIdempotencyKey, resolveInventoryTarget} from './manage_manual_limited_discount_inventory.mjs';

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
    }],
  }), 'utf8');

  const target = await resolveInventoryTarget({store: 'LQ', skc: 'sv25100554440744444', rescue: rescuePath});
  assert.equal(target.mode, 'authorized_auto_fallback');
  assert.equal(target.canonical, 'SK-5110电磁炉');
  assert.equal(target.activityStock, 10);
  assert.equal(target.targetPrice, 61.34);

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
    authorizationId: 'owner-standing-cloud-marketing-v1',
    mode: target.mode,
    store: 'LQ',
    skc: 'sv25100554440744444',
    skuCode: 'SKU-1',
    activityStock: 10,
    validTo: target.validTo,
    sourceArtifact: target.sourceArtifact,
  };
  const firstIdempotencyKey = buildInventoryIdempotencyKey(idempotencyInput);
  assert.equal(firstIdempotencyKey, buildInventoryIdempotencyKey(idempotencyInput));
  assert.notEqual(firstIdempotencyKey, buildInventoryIdempotencyKey({...idempotencyInput, activityStock: 11}));
  assert.match(firstIdempotencyKey, /^bi-marketing-inventory-[a-f0-9]{64}$/);

  const protectedPath = path.join(tmp, 'protected.json');
  await fs.writeFile(protectedPath, JSON.stringify({
    storeKey: 'LQ',
    activityStock: 10,
    rows: [{
      storeKey: 'LQ',
      skc: 'sv25100554440744444',
      canonical: 'SK-5110电磁炉',
      limitedDiscountPrice: 61.34,
      manualSpecialLimitedDiscount: true,
    }],
  }), 'utf8');
  await assert.rejects(
    resolveInventoryTarget({store: 'LQ', skc: 'sv25100554440744444', rescue: protectedPath}),
    /Manual-special rows must use registry mode/,
  );

  const driftBatchSource = await fs.readFile(path.join(process.cwd(), 'scripts/marketing/batch_fix_limited_discount_drift.mjs'), 'utf8');
  assert.match(driftBatchSource, /topUpAuthorizedFallbackInventory/);
  assert.match(driftBatchSource, /AUTHORIZED_LIMITED_DISCOUNT_FALLBACK_STOCK_TOP_UP/);
  assert.match(driftBatchSource, /postInventoryTopUpDryRun/);

  console.log(JSON.stringify({
    ok: true,
    test: 'authorized_fallback_inventory_top_up_et_gated',
    enoughEt: 'top_up_platform_virtual_stock',
    insufficientEt: 'et_stock_below_activity_stock',
    exactTopUpTo: 10,
    deterministicIdempotencyKey: true,
    driftBatchIntegrated: true,
  }));
} finally {
  await fs.rm(tmp, {recursive: true, force: true});
}
