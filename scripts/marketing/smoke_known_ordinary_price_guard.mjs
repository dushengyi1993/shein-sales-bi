#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  classifyKnownOrdinaryCouponStack,
  groupOrdinaryEvidenceBySkc,
  loadKnownOrdinaryPriceEvidence,
} from '../../lib/marketing_ordinary_price_evidence.mjs';

const skc = 'sv25082997983132453';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const evidence = await loadKnownOrdinaryPriceEvidence({
  root,
  dir: path.join('tests', 'fixtures', 'marketing', 'known-ordinary-price'),
  storeKey: 'NM',
  nowLocal: '2026-06-06 15:00:00',
});
assert.equal(evidence.parseErrorCount, 0);
const rows = groupOrdinaryEvidenceBySkc(evidence.rows).get(skc) || [];
assert.ok(rows.some(row => row.activityId === 42336 && row.ordinaryMarketingPrice === 66.9), 'NM 7025 should have known 42336 ordinary price evidence');
const guard = classifyKnownOrdinaryCouponStack(rows, {
  storeKey: 'NM',
  skc,
  canonical: 'SK-7025A绞肉机',
  finalTargetPrice: 74.76,
  couponFactor: 0.85,
}, {fallbackDiscountPct: 15});
assert.equal(guard.decision, 'known_ordinary_final_below_target');
assert.equal(guard.allowSubmit, false);
assert.equal(guard.shouldCancelCoupon, true);
assert.equal(guard.lowestOrdinaryPrice, 66.9);
assert.equal(guard.finalWithCoupon, 56.87);

console.log(JSON.stringify({ok: true, test: 'known_ordinary_price_guard_nm_7025', decision: guard.decision, finalWithCoupon: guard.finalWithCoupon}));
