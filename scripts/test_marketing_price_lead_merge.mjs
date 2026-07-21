#!/usr/bin/env node
import assert from 'node:assert/strict';
import {mergeRankedMarketingPriceLead} from '../lib/marketing_price_lead_merge.mjs';

const currentLive = {
  store_key: 'DX',
  skc: 'sv1',
  marketing_limited_discount_price_sar: 293.34,
  marketing_limited_discount_is_current: true,
  marketing_price_evidence_type: 'current_limited_discount_live_scan',
  marketing_price_source_rank: 82,
  marketing_price_source_at: '2026-07-21T03:19:55.146Z',
  marketing_price_source_file: 'current-live.json',
  marketing_price_evidence_count: 13,
};
const stalePlan = {
  store_key: 'DX',
  skc: 'sv1',
  marketing_limited_discount_price_sar: 314.29,
  marketing_limited_discount_is_current: false,
  marketing_price_evidence_type: 'price_overrides_plan',
  marketing_price_source_rank: 25,
  marketing_price_source_at: '2026-07-20T03:46:44.361Z',
  marketing_price_source_file: 'plan.json',
};

const merged = mergeRankedMarketingPriceLead(currentLive, stalePlan);
assert.equal(merged.marketing_limited_discount_price_sar, 293.34);
assert.equal(merged.marketing_limited_discount_is_current, true);
assert.equal(merged.marketing_price_evidence_type, 'current_limited_discount_live_scan');
assert.equal(merged.marketing_price_source_rank, 82);
assert.equal(merged.marketing_price_source_file, 'current-live.json');
assert.equal(merged.marketing_price_evidence_count, 14);
assert.equal(merged.marketing_price_sources.length, 2);

const newerCurrent = mergeRankedMarketingPriceLead(merged, {
  ...currentLive,
  marketing_limited_discount_price_sar: 290,
  marketing_price_source_at: '2026-07-21T04:00:00.000Z',
  marketing_price_source_file: 'current-live-new.json',
  marketing_price_evidence_count: 1,
});
assert.equal(newerCurrent.marketing_limited_discount_price_sar, 290);
assert.equal(newerCurrent.marketing_price_source_file, 'current-live-new.json');

console.log('marketing price lead merge preserves current live evidence over lower-ranked plans');
