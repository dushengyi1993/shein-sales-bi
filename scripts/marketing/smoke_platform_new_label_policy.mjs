#!/usr/bin/env node
import assert from 'node:assert/strict';
import {isRecentNewListingLink} from '../../lib/marketing_pricing_policy.mjs';

const policy = {
  newListingWithin7Days: {
    enabled: true,
    windowDays: 7,
    onShelfOnly: true,
    requireNoOrdinaryMarketing: true,
    platformNewLabelPatterns: ['新款', '新品'],
  },
};

const expiredPlatformNew = isRecentNewListingLink({
  skc: 'same-skc',
  is_on_shelf: true,
  shelf_status_name: '已上架',
  shelf_age_days: 25,
  skc_label: '新款',
}, policy, '2026-07-04');

assert.equal(expiredPlatformNew.applies, false);
assert.equal(expiredPlatformNew.reason, 'outside_window');

const recentPlatformNew = isRecentNewListingLink({
  skc: 'same-skc',
  is_on_shelf: true,
  shelf_status_name: '已上架',
  shelf_age_days: 6,
  skc_label: '新款',
}, policy, '2026-07-04');

assert.equal(recentPlatformNew.applies, true);
assert.equal(recentPlatformNew.reason, 'platform_new_label_no_ordinary_marketing');

const oldNormal = isRecentNewListingLink({
  skc: 'same-skc',
  is_on_shelf: true,
  shelf_status_name: '已上架',
  shelf_age_days: 25,
  skc_label: '备货款B',
}, policy, '2026-07-04');

assert.equal(oldNormal.applies, false);
assert.equal(oldNormal.reason, 'outside_window');

console.log(JSON.stringify({ok: true, test: 'platform_new_label_respects_seven_day_window'}));
