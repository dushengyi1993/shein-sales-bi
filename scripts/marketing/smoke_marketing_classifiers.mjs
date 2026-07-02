#!/usr/bin/env node
/**
 * Smoke tests for marketing coupon policy and pricing policy classifiers.
 * P3-#10: adds coverage for core functions that previously had no tests.
 */
import {
  classifyCouponEligibilityRow,
  classifyLimitedDiscountCouponStack,
  plannedCouponFactor,
  plannedFinalTargetPrice,
  isOptionalTrafficCouponPlanRow,
} from '../../lib/marketing_coupon_policy.mjs';
import {
  marginTargetsForExposurePolicy,
  resolveExposureAdjustedMargin,
  pctConfigToRatio,
} from '../../lib/marketing_pricing_policy.mjs';

let pass = 0, fail = 0;
function assert(condition, label) {
  if (condition) { pass++; console.log(`  PASS: ${label}`); }
  else { fail++; console.error(`  FAIL: ${label}`); }
}

console.log('classifyCouponEligibilityRow:');
// couponFactor=0.85 + combo with traffic keywords => allowed
assert(
  classifyCouponEligibilityRow({couponFactor: 0.85, combo: '可选流量15%券'}).allowed15 === true,
  'traffic coupon combo should be allowed15'
);
// couponFactor=0.85 + plain combo => blocked (price guarantee)
assert(
  classifyCouponEligibilityRow({couponFactor: 0.85, combo: '普通活动 + 仅15%券'}).allowed15 === false,
  'price guarantee coupon should be blocked'
);
// couponFactor=1 => forbidden
assert(
  classifyCouponEligibilityRow({couponFactor: 1, combo: '普通活动'}).allowed15 === false,
  'couponFactor=1 should be forbidden'
);
// no couponFactor, combo forbids 15% => forbidden
assert(
  classifyCouponEligibilityRow({couponFactor: null, combo: '不叠券'}).allowed15 === false,
  'forbid combo should be forbidden'
);
// no couponFactor, no combo => unknown
assert(
  classifyCouponEligibilityRow({couponFactor: null, combo: ''}).allowed15 === false,
  'empty combo should be unknown/blocked'
);

console.log('classifyLimitedDiscountCouponStack:');
const stackResult = classifyLimitedDiscountCouponStack(
  {limitedDiscountPrice: 100},
  {couponFactor: 0.85, finalTargetPrice: 85, combo: '普通活动'},
  {priceToleranceSar: 1}
);
assert(stackResult.decision === 'coupon_final_matches_target', '100*0.85=85 matches target 85');
assert(stackResult.allowSubmit === true, 'matching target should allow submit');

const stackBelow = classifyLimitedDiscountCouponStack(
  {limitedDiscountPrice: 90},
  {couponFactor: 0.85, finalTargetPrice: 85, combo: '普通活动'},
  {priceToleranceSar: 1}
);
assert(stackBelow.decision === 'coupon_final_below_target', '90*0.85=76.5 below target 85');
assert(stackBelow.shouldCancelCoupon === true, 'below target should cancel coupon');

console.log('plannedCouponFactor / plannedFinalTargetPrice:');
assert(plannedCouponFactor({couponFactor: 0.85}) === 0.85, 'explicit couponFactor');
assert(plannedCouponFactor({couponFactor: null}, 15) === 0.85, 'fallback 15% => 0.85');
assert(plannedFinalTargetPrice({finalTargetPrice: 100}) === 100, 'explicit finalTargetPrice');
assert(plannedFinalTargetPrice({finalTargetPrice: null}) === null, 'missing finalTargetPrice => null');

console.log('isOptionalTrafficCouponPlanRow:');
assert(isOptionalTrafficCouponPlanRow({combo: '可选流量15%券'}) === true, 'traffic combo');
assert(isOptionalTrafficCouponPlanRow({combo: '普通活动'}) === false, 'plain combo');

console.log('marginTargetsForExposurePolicy:');
const atFloor = marginTargetsForExposurePolicy(0.15);
assert(atFloor.applies === true, 'base at floor applies');
assert(atFloor.topMargin === 0.15, 'top stays at floor');
assert(atFloor.otherMargin === 0.20, 'others raised by delta');

const aboveFloor = marginTargetsForExposurePolicy(0.30);
assert(aboveFloor.applies === true, 'base above floor applies');
assert(aboveFloor.topMargin === 0.25, 'top lowered by delta');
assert(aboveFloor.otherMargin === 0.30, 'others stay at base');

console.log('pctConfigToRatio:');
assert(pctConfigToRatio(15) === 0.15, '15 => 0.15');
assert(pctConfigToRatio(0.15) === 0.15, '0.15 => 0.15');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
