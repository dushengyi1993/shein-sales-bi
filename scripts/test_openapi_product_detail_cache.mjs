#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  collectOpenapiProductDetailFallbacks,
  selectOpenapiProductDetailSpus,
} from '../lib/openapi_product_detail_cache.mjs';

const names = ['A', 'B', 'C', 'D', 'E'];
const selected = selectOpenapiProductDetailSpus({
  spuNames: names,
  budget: 2,
  priorPayload: {detailResults: [{spuName: 'D', ok: false}]},
  dateKey: '2026-07-30T00:00:00.000Z',
});
assert.equal(selected.length, 2);
assert.equal(selected[0], 'D', 'the prior failed detail must be retried before the rotating sample');
assert.equal(new Set(selected).size, selected.length);

const fallbacks = collectOpenapiProductDetailFallbacks({
  allowedSpus: names,
  currentDetailResults: [{spuName: 'A', ok: true, info: {spuName: 'A'}}],
  priorPayloads: [
    {
      fetchedAt: '2026-07-29T00:00:00.000Z',
      detailResults: [
        {spuName: 'A', ok: true, info: {spuName: 'A', version: 'old'}},
        {spuName: 'B', ok: true, info: {spuName: 'B', version: 'newer'}},
      ],
    },
    {
      fetchedAt: '2026-07-28T00:00:00.000Z',
      detailResults: [{spuName: 'B', ok: true, info: {spuName: 'B', version: 'older'}}],
      detailFallbackResults: [{spuName: 'C', ok: true, info: {spuName: 'C'}}],
    },
  ],
});
assert.deepEqual(fallbacks.map(row => row.spuName).sort(), ['B', 'C']);
assert.equal(fallbacks.find(row => row.spuName === 'B').info.version, 'newer');
assert.equal(fallbacks.find(row => row.spuName === 'B').detailFetchedAt, '2026-07-29T00:00:00.000Z');

console.log('openapi_product_detail_cache: checks passed');
