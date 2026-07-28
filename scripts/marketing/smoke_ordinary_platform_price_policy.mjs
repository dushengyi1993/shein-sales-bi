#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  buildOrdinaryPlatformPriceAdjustmentAudit,
  isOrdinaryPlatformTierRewriteAccepted,
} from '../../lib/marketing_ordinary_platform_price_policy.mjs';

const dlBackToSchool = buildOrdinaryPlatformPriceAdjustmentAudit({
  rule: {
    storeKey: 'DL',
    activityId: 48802,
    skc: 'sv260103161242703915999',
    targetPrice: 60.32,
    finalTargetPrice: 60.32,
  },
  adjustedTarget: 58.31,
  platformAdjusted: true,
});
assert.equal(dlBackToSchool?.platformAdjustmentStatus, 'below_target_due_to_platform_forced_discount');
assert.equal(dlBackToSchool?.platformPricePolicy, 'submit_platform_minimum_tier_and_audit');
assert.equal(dlBackToSchool?.approvedTargetPrice, 60.32);
assert.equal(dlBackToSchool?.activityTargetAfterPlatformAdjust, 58.31);
assert.equal(dlBackToSchool?.deltaSar, -2.01);
assert.equal(dlBackToSchool?.requiresReapproval, false);

assert.equal(isOrdinaryPlatformTierRewriteAccepted({
  actualPrice: 58.31,
  platformExpectedPrice: 58.31,
  discountMatches: true,
}), true);

assert.equal(isOrdinaryPlatformTierRewriteAccepted({
  actualPrice: 57.99,
  platformExpectedPrice: 58.31,
  discountMatches: true,
}), false);

assert.equal(isOrdinaryPlatformTierRewriteAccepted({
  actualPrice: 58.31,
  platformExpectedPrice: 58.31,
  discountMatches: false,
}), false);

assert.equal(buildOrdinaryPlatformPriceAdjustmentAudit({
  rule: {targetPrice: 60.32},
  adjustedTarget: 60.32,
  platformAdjusted: false,
}), null);

console.log('smoke_ordinary_platform_price_policy: OK');
