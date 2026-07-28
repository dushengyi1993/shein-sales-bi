#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  buildOrdinaryPlatformTierEvidenceIndex,
  findActiveOrdinaryPlatformTier,
} from '../../lib/marketing_ordinary_platform_tier_evidence.mjs';

const registry = {
  sourcePath: 'fixture-registry.json',
  entries: [{
    storeKey: 'DL',
    skc: 'sv1',
    activityId: 48733,
    approvedTargetPrice: 60.32,
    platformTierPrice: 58.31,
    validFrom: '2026-07-24 16:00:00',
    validTo: '2026-07-31 16:00:00',
    status: 'active',
  }],
};
const ordinaryEvidenceByStore = new Map([
  ['YJ', {
    rows: [{
      storeKey: 'YJ',
      skc: 'sv2',
      activityId: 49283,
      approvedTargetPrice: 234.58,
      ordinaryMarketingPrice: 228.71,
      eventStart: '2026-07-31 16:00:00',
      eventEnd: '2026-08-07 16:00:00',
      evidenceTrust: 'submitted',
      belowApprovedTarget: true,
      platformAdjustmentStatus: 'below_target_due_to_platform_forced_discount',
      fillSource: 'submitted.json',
    }, {
      storeKey: 'YJ',
      skc: 'sv3',
      ordinaryMarketingPrice: 100,
      eventStart: '2026-07-31 16:00:00',
      eventEnd: '2026-08-07 16:00:00',
      evidenceTrust: 'unverified_price_candidate',
      belowApprovedTarget: true,
    }],
  }],
]);
const index = buildOrdinaryPlatformTierEvidenceIndex({registry, ordinaryEvidenceByStore});

assert.equal(findActiveOrdinaryPlatformTier(index, {
  storeKey: 'DL',
  skc: 'sv1',
  activityId: 48733,
  at: '2026-07-27 09:50:01',
})?.platformTierPrice, 58.31);

assert.equal(findActiveOrdinaryPlatformTier(index, {
  storeKey: 'DL',
  skc: 'sv1',
  activityId: 99999,
  at: '2026-07-27 09:50:01',
}), null);

assert.equal(findActiveOrdinaryPlatformTier(index, {
  storeKey: 'DL',
  skc: 'sv1',
  activityId: 48733,
  at: '2026-08-01 09:50:01',
}), null);

assert.equal(findActiveOrdinaryPlatformTier(index, {
  storeKey: 'YJ',
  skc: 'sv2',
  activityId: 49283,
  at: '2026-08-01 09:00:00',
})?.sourceType, 'submitted_deadline_fill_platform_tier');

assert.equal(findActiveOrdinaryPlatformTier(index, {
  storeKey: 'YJ',
  skc: 'sv3',
  at: '2026-08-01 09:00:00',
}), null);

console.log('smoke_ordinary_platform_tier_evidence: OK');
