#!/usr/bin/env node
import assert from 'node:assert/strict';
import {buildLimitedDiscountDriftRescuePlan} from './build_limited_discount_drift_rescue_plan.mjs';

const guard = {
  reportDate: '2026-07-05',
  limitedDiscountTargetPriceDrift: {
    source: 'live.json',
    planSourcePath: 'price.json',
    belowRows: [
      {
        storeKey: 'DL',
        skc: 'sv-target',
        canonical: 'KF-JN-02',
        limitedDiscountPrice: 92.79,
        finalTargetPrice: 101.76,
        deltaSar: -8.97,
        activityId: 46354,
        targetPriceSource: 'price_overrides_plan',
        limitedDiscountName: '新上架7天高曝光兜底限时折扣20260628',
        limitedDiscountEnd: '2026-07-05 23:59:59',
      },
      {
        storeKey: 'DL',
        skc: 'sv-ok',
        canonical: 'OK',
        limitedDiscountPrice: 101.76,
        finalTargetPrice: 101.76,
        deltaSar: 0,
        limitedDiscountName: 'ignored',
      },
    ],
  },
};

const plan = buildLimitedDiscountDriftRescuePlan(guard, {guardPath: 'guard.json'});
assert.equal(plan.totals.belowTarget, 1);
assert.equal(plan.totals.selected, 1);
assert.equal(plan.groups.length, 1);
assert.equal(plan.groups[0].storeKey, 'DL');
assert.equal(plan.groups[0].rows[0].limitedDiscountPrice, 101.76);
assert.equal(plan.groups[0].rows[0].finalTargetPrice, 101.76);
assert.equal(plan.groups[0].rows[0].previousLimitedPrice, 92.79);
assert.equal(plan.groups[0].rows[0].sourceRule, 'limited_discount_target_price_drift_current_window_target');
console.log(JSON.stringify({ok: true, test: 'limited_discount_drift_rescue_plan_uses_current_final_target'}));
