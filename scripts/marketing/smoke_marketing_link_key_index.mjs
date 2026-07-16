import assert from 'node:assert/strict';
import {
  buildLinkRowIndexFromBi,
  isNewListingOrdinaryMarketingActivity,
  isRecentNewListingLink,
  marketingLinkKey,
} from '../../lib/marketing_pricing_policy.mjs';

const link = {
  store_key: 'DX',
  skc: 'sv-new-link',
  shelf_age_days: 4,
  is_on_shelf: true,
  shelf_status_name: '已上架',
  skc_label: '新款',
  marketing_ordinary_price_is_current: false,
};
const index = buildLinkRowIndexFromBi({data: {storeLinks: [link]}});
assert.equal(index.byLinkKey.get(marketingLinkKey('dx', 'sv-new-link')), link);

const policy = {
  newListingWithin7Days: {
    enabled: true,
    windowDays: 7,
    onShelfOnly: true,
    requireNoOrdinaryMarketing: true,
    platformNewLabelPatterns: ['新款'],
    ordinaryMarketing: {
      applyTopTreatmentForFirstNewListingSignup: true,
      activityNamePatterns: ['New Arrivals'],
    },
  },
};
assert.equal(isRecentNewListingLink(link, policy, '2026-07-14').applies, true);
assert.equal(isNewListingOrdinaryMarketingActivity({'活动名称': 'SA New Arrivals Promo'}, policy), true);

console.log(JSON.stringify({ok: true, key: marketingLinkKey('dx', 'sv-new-link')}));
