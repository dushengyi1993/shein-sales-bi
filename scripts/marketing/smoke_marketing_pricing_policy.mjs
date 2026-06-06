#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  DEFAULT_MARKETING_PRICING_POLICY,
  buildExposureTopLinkIndex,
  exposureRankInfo,
  resolveExposureAdjustedMargin,
} from '../../lib/marketing_pricing_policy.mjs';

const policy = {
  ...DEFAULT_MARKETING_PRICING_POLICY,
  exposureTopLinks: {
    ...DEFAULT_MARKETING_PRICING_POLICY.exposureTopLinks,
    topN: 5,
    groupScope: 'global_standard_goods_sn',
  },
};

const bi = {
  storeLinks: [
    {storeKey: 'NM', skc: 'nm-rank1', standard_goods_sn: 'SK-TEST', c7_eps_uv: 100, is_on_shelf: true},
    {storeKey: 'DL', skc: 'dl-rank2', standard_goods_sn: 'SK-TEST', c7_eps_uv: 90, is_on_shelf: true},
    {storeKey: 'FY', skc: 'fy-rank3', standard_goods_sn: 'SK-TEST', c7_eps_uv: 80, is_on_shelf: true},
    {storeKey: 'LQ', skc: 'lq-rank4', standard_goods_sn: 'SK-TEST', c7_eps_uv: 70, is_on_shelf: true},
    {storeKey: 'TZ', skc: 'tz-rank5', standard_goods_sn: 'SK-TEST', c7_eps_uv: 60, is_on_shelf: true},
    {storeKey: 'QY', skc: 'qy-rank6', standard_goods_sn: 'SK-TEST', c7_eps_uv: 50, is_on_shelf: true},
    {storeKey: 'NM', skc: 'nm-other', standard_goods_sn: 'SK-OTHER', c7_eps_uv: 1000, is_on_shelf: true},
  ],
};

const index = buildExposureTopLinkIndex(bi, policy);
assert.equal(index.groupScope, 'global_standard_goods_sn');

assert.equal(exposureRankInfo(index, 'SK-TEST', 'nm-rank1', 'NM').isTopExposureLink, true);
assert.equal(exposureRankInfo(index, 'SK-TEST', 'tz-rank5', 'TZ').isTopExposureLink, true);
assert.equal(exposureRankInfo(index, 'SK-TEST', 'qy-rank6', 'QY').isTopExposureLink, false);
assert.equal(exposureRankInfo(index, 'SK-TEST', 'dl-rank2', 'DL').isTopExposureLink, true);
assert.equal(exposureRankInfo(index, 'SK-TEST', 'dl-rank2', 'NM').hasSkcExposureData, false);
assert.equal(exposureRankInfo(index, 'SK-TEST', 'nm-other', 'NM').hasSkcExposureData, false);

const topMargin = resolveExposureAdjustedMargin({
  baseMargin: 0.3,
  storeKey: 'NM',
  canonical: 'SK-TEST',
  skc: 'nm-rank1',
  policy,
  exposureIndex: index,
});
const otherMargin = resolveExposureAdjustedMargin({
  baseMargin: 0.3,
  storeKey: 'QY',
  canonical: 'SK-TEST',
  skc: 'qy-rank6',
  policy,
  exposureIndex: index,
});
const crossStore = resolveExposureAdjustedMargin({
  baseMargin: 0.3,
  storeKey: 'NM',
  canonical: 'SK-TEST',
  skc: 'dl-rank2',
  policy,
  exposureIndex: index,
});
assert.equal(topMargin.reason, 'top_exposure_link');
assert.equal(Math.round(topMargin.margin * 100), 25);
assert.equal(otherMargin.reason, 'non_top_exposure_link');
assert.equal(Math.round(otherMargin.margin * 100), 30);
assert.equal(crossStore.reason, 'skc_not_in_exposure_rank');

console.log(JSON.stringify({ok: true, test: 'marketing_pricing_policy_global_standard_exposure_top_links'}));
