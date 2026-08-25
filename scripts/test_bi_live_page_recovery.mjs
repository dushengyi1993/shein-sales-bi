#!/usr/bin/env node

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {overlayCurrentProductReconciliationAudit} from '../lib/bi_live_core_health.mjs';
import {publishBiProfitBundleManifest, writeBiSectionCache} from '../lib/bi_section_cache.mjs';
import {__testHooks as serveHooks, usableHomepageAccountingFallback} from './serve_bi_portal.mjs';

const sourceGeneratedAt = '2026-08-24T07:59:49+08:00';
const generatedAt = '2026-08-25T08:05:28+08:00';
const fractionalGeneratedAt6 = '2026-08-25T08:05:28.560965+08:00';
const fractionalGeneratedAt9 = '2026-08-25T08:05:28.560965123+08:00';
const precisionMinimumAt = '2026-08-25T08:05:28.560966+08:00';
const precisionSourceAt = '2026-08-25T08:05:28.560965+08:00';
const sourceCachedAt = '2026-08-24T22:37:51Z';

const timestampNs = serveHooks.homepageTimestampNs;
assert.equal(typeof timestampNs, 'function');
assert.equal(typeof timestampNs(fractionalGeneratedAt6), 'bigint', 'fractional timestamps use exact BigInt nanoseconds');
assert.equal(timestampNs('2026-08-25T00:05:28Z'), timestampNs('2026-08-25T08:05:28+08'), 'Z and hour-only offsets identify the same instant');
assert.equal(timestampNs('2026-08-25T00:05:28Z'), timestampNs('2026-08-25T08:05:28+08:00'), 'Z and hour-minute offsets identify the same instant');
assert.equal(timestampNs('2026-08-25T00:05:28Z'), timestampNs('2026-08-25T00:05:28+00:00'), 'Z and explicit positive zero offset identify the same instant');
assert.notEqual(timestampNs('2026-08-25T08:05:28+14:00'), null, 'the maximum positive numeric offset is valid');
assert.ok(timestampNs(precisionSourceAt) < timestampNs(precisionMinimumAt), 'one microsecond boundary remains ordered after nanosecond parsing');
for (const invalidTimestamp of [
  '2026-02-29T08:05:28Z',
  '2026-08-25T24:05:28Z',
  '2026-08-25T08:60:28Z',
  '2026-08-25T08:05:60Z',
  '2026-08-25T08:05:28+14:01',
  '2026-08-25T08:05:28-14:01',
  '2026-08-25T08:05:28+23:59',
  '2026-08-25T08:05:28-00:00',
  '2026-08-25T08:05:28+24:00',
  '2026-08-25T08:05:28+08:60',
  '2026-08-25T08:05:28.1234567890Z',
]) {
  assert.equal(timestampNs(invalidTimestamp), null, `invalid timestamp is rejected: ${invalidTimestamp}`);
}

const validRankings = {
  dailyStores: [{date: '2026-08-12', store_key: 'HL', shop_name: 'HL', sales_sar: 12, quantity: 1, orders: 1}],
  dailyProducts: [],
  dailyStoreProducts: [],
  dailyPaymentSummary: [],
  dailyStoreProductPaymentSummary: [],
};
const validProfitSummary = {
  sourceGeneratedAt: generatedAt,
  sourceCachedAt,
  staleSource: false,
  dailyScopes: [{date: '2026-08-12', scope_value: 'ALL', scope_order: 0, net_revenue_sar: 12, quantity: 1}],
};

assert.equal(usableHomepageAccountingFallback('homeRankings', {
  ok: true,
  generatedAt,
  data: {rankings: validRankings},
}, generatedAt), true);
assert.equal(usableHomepageAccountingFallback('homeRankings', {
  ok: true,
  generatedAt,
  data: {rankings: {dailyStores: [{sales_sar: 12}]}},
}, generatedAt), false, 'a ranking row without date and store identity is not a usable business array');
assert.equal(usableHomepageAccountingFallback('homeRankings', {
  ok: true,
  generatedAt,
  data: {rankings: {dailyStores: [], dailyProducts: [{date: '2026-08-12', standard_goods_sn: 'P-1', sales_sar: 12}]}},
}, generatedAt), true, 'dailyProducts accepts its stable product identity and date');
assert.equal(usableHomepageAccountingFallback('homeRankings', {
  ok: true,
  generatedAt,
  data: {rankings: {dailyStores: [], dailyStoreProducts: [{date: '2026-08-12', store_key: 'HL', standard_goods_sn: 'P-1', sales_sar: 12}]}},
}, generatedAt), true, 'dailyStoreProducts requires both store and product identity');
assert.equal(usableHomepageAccountingFallback('homeRankings', {
  ok: true,
  generatedAt,
  data: {rankings: {dailyStores: [], dailyPaymentSummary: [{date: '2026-08-12', store_key: 'HL', is_cod: false, sales_sar: 12}]}},
}, generatedAt), true, 'dailyPaymentSummary requires store and payment identity');
assert.equal(usableHomepageAccountingFallback('homeRankings', {
  ok: true,
  generatedAt,
  data: {rankings: {dailyStores: [], dailyStoreProductPaymentSummary: [{date: '2026-08-12', store_key: 'HL', standard_goods_sn: 'P-1', is_cod: false, sales_sar: 12}]}},
}, generatedAt), true, 'dailyStoreProductPaymentSummary requires store, product, and payment identity');
assert.equal(usableHomepageAccountingFallback('homeRankings', {
  ok: true,
  generatedAt,
  data: {rankings: {dailyStores: [{date: '2026-08-12', store_key: 'HL', sales_sar: 12}], dailyProducts: [{date: '2026-08-12', sales_sar: 0}]}},
}, generatedAt), false, 'an invalid row cannot be hidden by a good known ranking array');
assert.equal(usableHomepageAccountingFallback('homeProfit', {
  ok: true,
  generatedAt,
  data: {homeProfitSummary: validProfitSummary},
}, generatedAt), true);
assert.equal(usableHomepageAccountingFallback('homeRankings', {
  ok: true,
  generatedAt,
  data: {rankings: {...validRankings, dailyStores: []}},
}, generatedAt), false, 'empty rankings cannot become a stale KPI response');
assert.equal(usableHomepageAccountingFallback('homeRankings', {
  ok: true,
  generatedAt,
  data: {rankings: {...validRankings, dailyStores: [{sales_sar: 0, quantity: 0, orders: 0}]}},
}, generatedAt), false, 'pseudo-zero rankings cannot become a stale KPI response');
assert.equal(usableHomepageAccountingFallback('homeRankings', {
  ok: true,
  generatedAt,
  data: {rankings: {
    dailyStores: [],
    dailyProducts: [],
    dailyStoreProducts: [],
    dailyPaymentSummary: [],
    dailyStoreProductPaymentSummary: [],
    junk: [{sales_sar: 999}],
  }},
}, generatedAt), false, 'unknown ranking arrays cannot make a stale KPI response usable');
assert.equal(usableHomepageAccountingFallback('homeProfit', {
  ok: true,
  generatedAt,
  data: {homeProfitSummary: {...validProfitSummary, dailyScopes: []}},
}, generatedAt), false, 'empty profit cannot become a stale KPI response');
assert.equal(usableHomepageAccountingFallback('homeProfit', {
  ok: true,
  generatedAt,
  data: {homeProfitSummary: {...validProfitSummary, dailyScopes: [{date: '2026-08-12', net_revenue_sar: 0, quantity: 0, orders: 0}]}},
}, generatedAt), false, 'pseudo-zero profit cannot become a stale KPI response');
assert.equal(usableHomepageAccountingFallback('homeProfit', {
  ok: true,
  generatedAt,
  data: {homeProfitSummary: {...validProfitSummary, dailyScopes: [{date: '2026-08-12', missing_cost_quantity: 4, storage_fee_sar: 99}]}},
}, generatedAt), false, 'diagnostic-only profit rows cannot become a stale KPI response');
assert.equal(usableHomepageAccountingFallback('homeProfit', {
  ok: true,
  generatedAt,
  data: {homeProfitSummary: {...validProfitSummary, dailyScopes: [{date: '2026-08-12', scope_value: 'ALL', scope_order: 0, orders: 1}]}},
}, generatedAt), false, 'orders alone cannot make a profit cache usable');
assert.equal(usableHomepageAccountingFallback('homeProfit', {
  ok: true,
  generatedAt,
  data: {homeProfitSummary: {...validProfitSummary, dailyScopes: [
    {date: '2026-08-12', scope_value: 'ALL', scope_order: 0, net_revenue_sar: 12},
    {date: '', scope_value: 'ALL', scope_order: 0, net_revenue_sar: 0},
  ]}},
}, generatedAt), false, 'a malformed scope row cannot be hidden by a good scope row');
assert.equal(usableHomepageAccountingFallback('homeProfit', {
  ok: true,
  generatedAt,
  data: {homeProfitSummary: {...validProfitSummary, dailyScopes: [{date: '2026-08-12', net_revenue_sar: 12}]}},
}, generatedAt), false, 'profit rows require explicit scope identity fields');
assert.equal(usableHomepageAccountingFallback('homeProfit', {
  ok: true,
  generatedAt,
  data: {homeProfitSummary: {...validProfitSummary, sourceGeneratedAt: 'old'}},
}, generatedAt), false);
assert.equal(usableHomepageAccountingFallback('homeProfit', {
  ok: true,
  generatedAt,
  data: {homeProfitSummary: {...validProfitSummary, sourceCachedAt: '2026-02-31T00:00:00Z'}},
}, generatedAt), false, 'an invalid source timestamp cannot certify a profit cache');
assert.equal(usableHomepageAccountingFallback('homeProfit', {
  ok: true,
  generatedAt,
  data: {homeProfitSummary: {...validProfitSummary, sourceCachedAt: '2026-08-25T08:05:28.560965+08:00'}},
}, generatedAt), true, 'production-format timestamps with six fractional digits remain valid');
assert.equal(usableHomepageAccountingFallback('homeProfit', {
  ok: true,
  generatedAt,
  data: {homeProfitSummary: {...validProfitSummary, sourceCachedAt: '2026-08-25T08:05:28.560965123+08:00'}},
}, generatedAt), true, 'timestamps with nine fractional digits remain valid');
assert.equal(usableHomepageAccountingFallback('homeProfit', {
  ok: true,
  generatedAt,
  data: {homeProfitSummary: {...validProfitSummary, sourceCachedAt: '2026-08-25T08:05:28.1234567890+08:00'}},
}, generatedAt), false, 'timestamps with more than nine fractional digits remain invalid');
assert.equal(usableHomepageAccountingFallback('homeProfit', {
  ok: true,
  generatedAt,
  data: {homeProfitSummary: {...validProfitSummary, dailyScopes: [{date: '2026-08-12', scope_value: 'ALL', scope_order: -1, net_revenue_sar: 12}]}},
}, generatedAt), false, 'scope_order must be a non-negative integer');
assert.equal(usableHomepageAccountingFallback('homeProfit', {
  ok: true,
  generatedAt,
  data: {homeProfitSummary: {...validProfitSummary, dailyScopes: [{date: '2026-08-12', scope_value: 'ALL', scope_order: 1.5, net_revenue_sar: 12}]}},
}, generatedAt), false, 'fractional scope_order cannot certify a profit cache');
assert.equal(usableHomepageAccountingFallback('homeProfit', {
  ok: true,
  generatedAt,
  data: {homeProfitSummary: {...validProfitSummary, dailyScopes: [{date: '2026-08-12', scope_value: '', scope_order: 0, net_revenue_sar: 12}]}},
}, generatedAt), true, 'the overall profit row may use an empty scope_value only at scope_order zero');
assert.equal(usableHomepageAccountingFallback('homeProfit', {
  ok: true,
  generatedAt,
  data: {homeProfitSummary: {...validProfitSummary, dailyScopes: [{date: '2026-08-12', scope_value: '', scope_order: 1, net_revenue_sar: 12}]}},
}, generatedAt), false, 'non-overall profit rows still require a non-empty scope_value');
for (const invalidScopeValue of [null, false, 0]) {
  assert.equal(usableHomepageAccountingFallback('homeProfit', {
    ok: true,
    generatedAt,
    data: {homeProfitSummary: {...validProfitSummary, dailyScopes: [{date: '2026-08-12', scope_value: invalidScopeValue, scope_order: 0, net_revenue_sar: 12}]}},
  }, generatedAt), false, `non-string scope_value is rejected: ${String(invalidScopeValue)}`);
}
assert.equal(usableHomepageAccountingFallback('homeProfit', {
  ok: true,
  generatedAt,
  data: {homeProfitSummary: {...validProfitSummary, dailyScopes: [{date: '2026-08-12', scope_value: 'ALL', scope_order: '0', net_revenue_sar: 12}]}},
}, generatedAt), false, 'scope_order must be serialized as a numeric integer');
assert.equal(usableHomepageAccountingFallback('homeProfit', {
  ok: true,
  generatedAt,
  data: {homeProfitSummary: {...validProfitSummary, dailyScopes: [{date: '2026-02-29', scope_value: 'ALL', scope_order: 0, net_revenue_sar: 12}]}},
}, generatedAt), false, 'invalid calendar dates cannot certify a profit cache');

const routeTemp = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-bi-home-accounting-fallback-'));
const queueTemp = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-bi-home-accounting-queue-'));
const queueFile = path.join(queueTemp, 'queue.json');
const previousQueueFile = process.env.SHEIN_BI_PORTAL_SECTION_QUEUE_FILE;
process.env.SHEIN_BI_PORTAL_SECTION_QUEUE_FILE = queueFile;
await fs.writeFile(queueFile, JSON.stringify({version: 1, entries: [], completedIdempotency: []}));
const run = {code: 0, timedOut: false, stderr: ''};
const pendingAccounting = {
  decision: {fresh: false},
  minimumPublishedAt: generatedAt,
  freshness: {accountingInputUpdatedAt: '2026-08-25T08:06:00+08:00'},
};
const currentAccounting = {
  decision: {fresh: true},
  minimumPublishedAt: '2000-01-01T00:00:00.000Z',
  freshness: {accountingInputUpdatedAt: '2026-08-25T08:06:00+08:00'},
};
async function makePortalFixture(name, coreAt = generatedAt) {
  const root = path.join(routeTemp, name);
  await fs.mkdir(path.join(root, 'sections'), {recursive: true});
  await fs.writeFile(path.join(root, 'data.json'), JSON.stringify({
    generatedAt: coreAt,
    __sections: {mode: 'api', generatedAt: coreAt, keys: ['homeRankings', 'homeProfit']},
  }));
  return root;
}
async function writeValidRankings(root, at = sourceGeneratedAt) {
  await writeBiSectionCache(root, 'homeRankings', at, {rankings: validRankings}, run, {requireIntegrity: true});
}
async function loadHomepage(root, section, accountingState, extra = {}) {
  const result = await serveHooks.loadBiSection({}, root, section, {
    allowGenerate: true,
    externalSectionQueueEnabled: true,
    readAccountingState: async () => accountingState,
    ...extra,
  });
  return {result};
}
async function readResultPayload(result) {
  if (result.rawBody) {
    const chunks = [];
    for await (const chunk of result.rawBody) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const decoded = result.headers?.['Content-Encoding'] === 'gzip' ? gunzipSync(body) : body;
    return JSON.parse(decoded.toString('utf8'));
  }
  return result.payload;
}

function profitBundleManifestIdentity(manifest) {
  const body = {
    schema: manifest.schema,
    version: manifest.version,
    generatedAt: manifest.generatedAt,
    artifacts: manifest.artifacts,
  };
  const canonical = value => value === null || typeof value !== 'object'
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? `[${value.map(canonical).join(',')}]`
      : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return createHash('sha256').update(canonical(body)).digest('hex');
}

try {
  const validRoot = await makePortalFixture('valid');
  await writeBiSectionCache(validRoot, 'homeRankings', sourceGeneratedAt, {
    rankings: {
      dailyStores: [{date: '2026-08-12', store_key: 'HL', sales_sar: 12, quantity: 1, orders: 1}],
      dailyProducts: [],
      dailyStoreProducts: [],
      dailyPaymentSummary: [],
      dailyStoreProductPaymentSummary: [],
    },
  }, run, {requireIntegrity: true});
  const degraded = await loadHomepage(validRoot, 'homeRankings', pendingAccounting);
  assert.equal(degraded.result.status, 200, 'a complete old homepage cache remains displayable while accounting is pending');
  assert.ok(degraded.result.rawBody, 'an old-generation fallback streams the verified source body');
  assert.equal(degraded.result.headers['X-Shein-BI-Degraded'], 'true');
  assert.equal(degraded.result.headers['X-Shein-BI-Has-Data'], 'true');
  assert.equal(degraded.result.headers['X-Shein-BI-Core-Generated-At'], generatedAt);
  assert.equal(degraded.result.headers['X-Shein-BI-Source-Generated-At'], sourceGeneratedAt);
  assert.equal(degraded.result.headers['X-Shein-BI-Accounting-Pending'], 'true');
  assert.equal(degraded.result.headers['X-Shein-BI-Refresh-Scheduled'], 'false', 'no producer means a degraded GET must not claim a scheduled refresh');
  const degradedPayload = await readResultPayload(degraded.result);
  assert.equal(degradedPayload.ok, true);
  assert.equal(degradedPayload.generatedAt, sourceGeneratedAt, 'degraded raw body retains its source generation');
  assert.notEqual(degradedPayload.generatedAt, generatedAt, 'current core identity never overwrites source body identity');
  assert.equal(degradedPayload.data.rankings.dailyStores[0].sales_sar, 12);

  for (const [label, fractionalAt] of [['six', fractionalGeneratedAt6], ['nine', fractionalGeneratedAt9]]) {
    const fractionalRoot = await makePortalFixture(`fractional-${label}`);
    await writeValidRankings(fractionalRoot, fractionalAt);
    const fractional = await loadHomepage(fractionalRoot, 'homeRankings', pendingAccounting);
    assert.equal(fractional.result.status, 200, `a ${label}-digit fractional generatedAt remains eligible for homepage fallback`);
    assert.equal(fractional.result.headers['X-Shein-BI-Source-Generated-At'], fractionalAt);
    const fractionalPayload = await readResultPayload(fractional.result);
    assert.equal(fractionalPayload.generatedAt, fractionalAt, `the ${label}-digit source generation is retained in the streamed body`);
  }

  const precisionRoot = await makePortalFixture('precision-nanosecond-ordering', precisionMinimumAt);
  const precisionRows = [{date: '2026-08-12', scope_value: '', scope_order: 0, net_revenue_sar: 12, quantity: 1, orders: 1, profit_after_storage_sar: 4}];
  await writeBiSectionCache(precisionRoot, 'profit', precisionMinimumAt, {rows: precisionRows}, run, {requireIntegrity: true});
  await writeBiSectionCache(precisionRoot, 'profit.query', precisionMinimumAt, {rows: precisionRows}, run, {requireIntegrity: true});
  await writeBiSectionCache(precisionRoot, 'homeProfit', precisionMinimumAt, {
    homeProfitSummary: {
      sourceGeneratedAt: precisionMinimumAt,
      sourceCachedAt: precisionSourceAt,
      staleSource: false,
      dailyScopes: precisionRows,
    },
  }, run, {requireIntegrity: true});
  await publishBiProfitBundleManifest(precisionRoot, precisionMinimumAt);
  const precision = await loadHomepage(precisionRoot, 'homeProfit', {
    decision: {fresh: true},
    minimumPublishedAt: precisionMinimumAt,
    freshness: {accountingInputUpdatedAt: '2026-08-25T08:06:00+08:00'},
  });
  assert.equal(precision.result.status, 200, 'source just below the exact minimum remains displayable as degraded data');
  assert.equal(precision.result.headers['X-Shein-BI-Degraded'], 'true', 'source .560965 is older than minimum .560966');
  assert.equal(precision.result.headers['X-Shein-BI-Source-Cached-At'], precisionSourceAt);
  const precisionPayload = await readResultPayload(precision.result);
  assert.equal(precisionPayload.generatedAt, precisionMinimumAt, 'the degraded body retains its exact source generation');

  const profitRoot = await makePortalFixture('profit-valid');
  const profitRows = [{date: '2026-08-12', scope_value: 'ALL', scope_order: 0, net_revenue_sar: 12, quantity: 1, orders: 1, profit_after_storage_sar: 4}];
  await writeBiSectionCache(profitRoot, 'profit', sourceGeneratedAt, {rows: profitRows}, run, {requireIntegrity: true});
  await writeBiSectionCache(profitRoot, 'profit.query', sourceGeneratedAt, {rows: profitRows}, run, {requireIntegrity: true});
  await writeBiSectionCache(profitRoot, 'homeProfit', sourceGeneratedAt, {
    homeProfitSummary: {
      sourceGeneratedAt,
      sourceCachedAt,
      staleSource: false,
      dailyScopes: profitRows,
    },
  }, run, {requireIntegrity: true});
  await publishBiProfitBundleManifest(profitRoot, sourceGeneratedAt);
  const degradedProfit = await loadHomepage(profitRoot, 'homeProfit', pendingAccounting);
  assert.equal(degradedProfit.result.status, 200, 'a complete old profit cache remains displayable while accounting is pending');
  assert.ok(degradedProfit.result.rawBody, 'an old-generation profit fallback streams the verified source body');
  assert.equal(degradedProfit.result.headers['X-Shein-BI-Degraded'], 'true');
  assert.equal(degradedProfit.result.headers['X-Shein-BI-Has-Data'], 'true');
  assert.equal(degradedProfit.result.headers['X-Shein-BI-Core-Generated-At'], generatedAt);
  assert.equal(degradedProfit.result.headers['X-Shein-BI-Source-Generated-At'], sourceGeneratedAt);
  assert.equal(degradedProfit.result.headers['X-Shein-BI-Source-Cached-At'], sourceCachedAt);
  assert.equal(degradedProfit.result.headers['X-Shein-BI-Accounting-Pending'], 'true');
  assert.equal(degradedProfit.result.headers['X-Shein-BI-Refresh-Scheduled'], 'false');
  const degradedProfitPayload = await readResultPayload(degradedProfit.result);
  assert.equal(degradedProfitPayload.ok, true);
  assert.equal(degradedProfitPayload.generatedAt, sourceGeneratedAt, 'degraded profit raw body retains its source generation');
  assert.notEqual(degradedProfitPayload.generatedAt, generatedAt, 'degraded profit never claims current source identity');
  assert.equal(degradedProfitPayload.data.homeProfitSummary.dailyScopes[0].profit_after_storage_sar, 4);

  const freshAccountingOldProfit = await loadHomepage(profitRoot, 'homeProfit', currentAccounting);
  assert.equal(freshAccountingOldProfit.result.status, 200, 'fresh accounting still shows the old complete cache until current cache lands');
  assert.equal(freshAccountingOldProfit.result.headers['X-Shein-BI-Accounting-Pending'], 'false');
  assert.equal(freshAccountingOldProfit.result.headers['X-Shein-BI-Degraded'], 'true');
  assert.equal(freshAccountingOldProfit.result.headers['X-Shein-BI-Refresh-Scheduled'], 'false', 'fresh accounting with no producer still displays the old complete cache without claiming a queue');
  assert.equal(freshAccountingOldProfit.result.headers['X-Shein-BI-Core-Generated-At'], generatedAt);
  const freshAccountingOldProfitPayload = await readResultPayload(freshAccountingOldProfit.result);
  assert.equal(freshAccountingOldProfitPayload.generatedAt, sourceGeneratedAt);
  const confirmedCurrentProducer = await loadHomepage(profitRoot, 'homeProfit', currentAccounting);
  assert.equal(confirmedCurrentProducer.result.status, 200);
  assert.equal(confirmedCurrentProducer.result.headers['X-Shein-BI-Refresh-Scheduled'], 'false');
  await readResultPayload(confirmedCurrentProducer.result);

  await writeBiSectionCache(profitRoot, 'profit', generatedAt, {rows: profitRows}, run, {requireIntegrity: true});
  await writeBiSectionCache(profitRoot, 'profit.query', generatedAt, {rows: profitRows}, run, {requireIntegrity: true});
  await writeBiSectionCache(profitRoot, 'homeProfit', generatedAt, {
    homeProfitSummary: {
      sourceGeneratedAt: generatedAt,
      sourceCachedAt: '2026-08-25T08:06:00+08:00',
      staleSource: false,
      dailyScopes: profitRows,
    },
  }, run, {requireIntegrity: true});
  await publishBiProfitBundleManifest(profitRoot, generatedAt);
  const recoveredProfit = await loadHomepage(profitRoot, 'homeProfit', currentAccounting);
  assert.equal(recoveredProfit.result.status, 200);
  const recoveredProfitPayload = await readResultPayload(recoveredProfit.result);
  assert.equal(recoveredProfitPayload.accountingPending, undefined, 'current profit accounting removes the stale warning');
  assert.equal(recoveredProfitPayload.degraded, undefined, 'current profit accounting removes degraded mode');
  assert.equal(recoveredProfitPayload.data.homeProfitSummary.dailyScopes[0].profit_after_storage_sar, 4);

  const freshAccountingOldRankings = await loadHomepage(validRoot, 'homeRankings', currentAccounting);
  assert.equal(freshAccountingOldRankings.result.status, 200, 'fresh accounting keeps the old rankings visible until the current cache lands');
  assert.equal(freshAccountingOldRankings.result.headers['X-Shein-BI-Accounting-Pending'], 'false');
  assert.equal(freshAccountingOldRankings.result.headers['X-Shein-BI-Degraded'], 'true');
  assert.equal(freshAccountingOldRankings.result.headers['X-Shein-BI-Refresh-Scheduled'], 'false');
  const freshAccountingOldRankingsPayload = await readResultPayload(freshAccountingOldRankings.result);
  assert.equal(freshAccountingOldRankingsPayload.generatedAt, sourceGeneratedAt);
  await fs.writeFile(queueFile, JSON.stringify({version: 1, entries: [{
    section: 'homeRankings',
    status: 'pending',
    coreGeneratedAt: generatedAt,
    reasons: [],
  }], completedIdempotency: []}));
  const exactPending = await loadHomepage(validRoot, 'homeRankings', currentAccounting);
  assert.equal(exactPending.result.status, 200, 'an existing exact-generation producer does not block verified fallback display');
  assert.equal(exactPending.result.headers['X-Shein-BI-Refresh-Scheduled'], 'true', 'only the exact current-generation durable entry sets the scheduled flag');
  await readResultPayload(exactPending.result);
  await fs.writeFile(queueFile, JSON.stringify({version: 1, entries: [], completedIdempotency: []}));

  await writeBiSectionCache(validRoot, 'homeRankings', generatedAt, {
    rankings: {
      dailyStores: [{date: '2026-08-25', store_key: 'HL', sales_sar: 13, quantity: 1, orders: 1}],
      dailyProducts: [],
      dailyStoreProducts: [],
      dailyPaymentSummary: [],
      dailyStoreProductPaymentSummary: [],
    },
  }, run, {requireIntegrity: true});
  const recovered = await loadHomepage(validRoot, 'homeRankings', currentAccounting);
  assert.equal(recovered.result.status, 200);
  const recoveredPayload = await readResultPayload(recovered.result);
  assert.equal(recoveredPayload.accountingPending, undefined, 'current accounting removes the stale warning');
  assert.equal(recoveredPayload.degraded, undefined, 'current accounting removes degraded mode');
  assert.equal(recoveredPayload.data.rankings.dailyStores[0].sales_sar, 13);

  const emptyRoot = await makePortalFixture('empty');
  await writeBiSectionCache(emptyRoot, 'homeRankings', sourceGeneratedAt, {
    rankings: {
      dailyStores: [],
      dailyProducts: [],
      dailyStoreProducts: [],
      dailyPaymentSummary: [],
      dailyStoreProductPaymentSummary: [],
    },
  }, run, {requireIntegrity: true});
  const empty = await loadHomepage(emptyRoot, 'homeRankings', pendingAccounting);
  assert.equal(empty.result.status, 503, 'an empty cache remains pending instead of becoming zero');
  assert.equal(empty.result.payload.ok, false, 'an unqueued pending response is not reported as successful');
  assert.equal(empty.result.payload.hasData, undefined);
  assert.equal(empty.result.payload.pendingSection, true);

  const emptyProfitRoot = await makePortalFixture('empty-profit');
  await writeBiSectionCache(emptyProfitRoot, 'profit', sourceGeneratedAt, {rows: [{date: '2026-08-24', net_revenue_sar: 12}]}, run, {requireIntegrity: true});
  await writeBiSectionCache(emptyProfitRoot, 'profit.query', sourceGeneratedAt, {rows: [{date: '2026-08-24', net_revenue_sar: 12}]}, run, {requireIntegrity: true});
  await writeBiSectionCache(emptyProfitRoot, 'homeProfit', sourceGeneratedAt, {
    homeProfitSummary: {sourceGeneratedAt, sourceCachedAt, staleSource: false, dailyScopes: []},
  }, run, {requireIntegrity: true});
  await publishBiProfitBundleManifest(emptyProfitRoot, sourceGeneratedAt);
  const emptyProfit = await loadHomepage(emptyProfitRoot, 'homeProfit', pendingAccounting);
  assert.equal(emptyProfit.result.status, 503, 'an empty old profit cache remains pending instead of becoming zero');
  assert.equal(emptyProfit.result.payload.hasData, undefined);

  const corruptRoot = await makePortalFixture('corrupt');
  await fs.writeFile(path.join(corruptRoot, 'sections', 'homeRankings.json'), '{not-json', 'utf8');
  const corrupt = await loadHomepage(corruptRoot, 'homeRankings', pendingAccounting);
  assert.equal(corrupt.result.status, 503, 'a corrupt cache remains pending instead of becoming zero');
  assert.equal(corrupt.result.payload.hasData, undefined);

  const unboundRoot = await makePortalFixture('unbound-old-cache');
  await writeBiSectionCache(unboundRoot, 'homeRankings', sourceGeneratedAt, {
    rankings: validRankings,
  }, run, {requireIntegrity: true});
  await fs.appendFile(path.join(unboundRoot, 'sections', 'homeRankings.json'), ' ', 'utf8');
  const unbound = await loadHomepage(unboundRoot, 'homeRankings', pendingAccounting);
  assert.equal(unbound.result.status, 503, 'an old cache whose raw binding changed remains pending');
  assert.equal(unbound.result.payload.hasData, undefined);

  const noReceiptRoot = await makePortalFixture('no-integrity-receipt');
  await writeValidRankings(noReceiptRoot);
  await fs.rm(path.join(noReceiptRoot, 'sections', 'homeRankings.json.integrity.json'), {force: true});
  const noReceipt = await loadHomepage(noReceiptRoot, 'homeRankings', pendingAccounting);
  assert.equal(noReceipt.result.status, 503, 'a cache without the durable integrity sidecar remains pending');
  assert.equal(noReceipt.result.payload.hasData, undefined);

  const sidecarTamperRoot = await makePortalFixture('sidecar-tamper');
  await writeValidRankings(sidecarTamperRoot);
  const sidecarFile = path.join(sidecarTamperRoot, 'sections', 'homeRankings.json.integrity.json');
  const sidecar = JSON.parse(await fs.readFile(sidecarFile, 'utf8'));
  sidecar.raw.sha256 = '0'.repeat(64);
  await fs.writeFile(sidecarFile, JSON.stringify(sidecar), 'utf8');
  const sidecarTamper = await loadHomepage(sidecarTamperRoot, 'homeRankings', pendingAccounting);
  assert.equal(sidecarTamper.result.status, 503, 'a tampered integrity sidecar remains pending');

  const gzipTamperRoot = await makePortalFixture('gzip-tamper');
  await writeValidRankings(gzipTamperRoot);
  await fs.appendFile(path.join(gzipTamperRoot, 'sections', 'homeRankings.json.gz'), Buffer.from('tamper'));
  const gzipTamper = await loadHomepage(gzipTamperRoot, 'homeRankings', pendingAccounting);
  assert.equal(gzipTamper.result.status, 503, 'a tampered gzip artifact remains pending');

  const noBundleRoot = await makePortalFixture('profit-no-bundle');
  await writeBiSectionCache(noBundleRoot, 'profit', sourceGeneratedAt, {rows: profitRows}, run, {requireIntegrity: true});
  await writeBiSectionCache(noBundleRoot, 'profit.query', sourceGeneratedAt, {rows: profitRows}, run, {requireIntegrity: true});
  await writeBiSectionCache(noBundleRoot, 'homeProfit', sourceGeneratedAt, {
    homeProfitSummary: {sourceGeneratedAt, sourceCachedAt, staleSource: false, dailyScopes: profitRows},
  }, run, {requireIntegrity: true});
  const noBundle = await loadHomepage(noBundleRoot, 'homeProfit', pendingAccounting);
  assert.equal(noBundle.result.status, 503, 'homeProfit without the exact profit bundle manifest remains pending');

  const writeProfitBundleFixture = async root => {
    await writeBiSectionCache(root, 'profit', sourceGeneratedAt, {rows: profitRows}, run, {requireIntegrity: true});
    await writeBiSectionCache(root, 'profit.query', sourceGeneratedAt, {rows: profitRows}, run, {requireIntegrity: true});
    await writeBiSectionCache(root, 'homeProfit', sourceGeneratedAt, {
      homeProfitSummary: {sourceGeneratedAt, sourceCachedAt, staleSource: false, dailyScopes: profitRows},
    }, run, {requireIntegrity: true});
    await publishBiProfitBundleManifest(root, sourceGeneratedAt);
  };
  const tamperCases = [
    ['manifest-identity-tamper', manifest => {manifest.manifestIdentity = '0'.repeat(64);}],
    ['manifest-artifact-hash-tamper', manifest => {
      manifest.artifacts.homeProfit.rawSha256 = '1'.repeat(64);
      manifest.manifestIdentity = profitBundleManifestIdentity(manifest);
    }],
    ['manifest-artifact-size-tamper', manifest => {
      manifest.artifacts.homeProfit.rawByteSize += 1;
      manifest.manifestIdentity = profitBundleManifestIdentity(manifest);
    }],
  ];
  for (const [name, mutate] of tamperCases) {
    const root = await makePortalFixture(name);
    await writeProfitBundleFixture(root);
    const manifestFile = path.join(root, 'sections', 'profit.bundle.json');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    mutate(manifest);
    await fs.writeFile(manifestFile, JSON.stringify(manifest), 'utf8');
    const tampered = await loadHomepage(root, 'homeProfit', pendingAccounting);
    assert.equal(tampered.result.status, 503, `${name} must fail closed as pending`);
    assert.equal(tampered.result.payload.hasData, undefined, `${name} must not expose stale data`);
  }

  const concurrentRoot = await makePortalFixture('concurrent-singleflight');
  await writeValidRankings(concurrentRoot);
  serveHooks.resetHomepageAccountingUsabilityCache();
  const concurrent = await Promise.all(Array.from({length: 4}, (_item, index) => loadHomepage(
    concurrentRoot,
    'homeRankings',
    pendingAccounting,
    {gzip: index % 2 === 0},
  )));
  const concurrentPayloads = await Promise.all(concurrent.map(item => readResultPayload(item.result)));
  assert.equal(serveHooks.homepageAccountingUsabilityParseCount(), 1, 'same cache binding parses for usability only once across concurrent requests');
  assert.equal(concurrent.filter(item => item.result.headers?.['Content-Encoding'] === 'gzip').length, 2, 'degraded fallback serves verified gzip streams when requested');
  assert.equal(concurrent.filter(item => !item.result.headers?.['Content-Encoding']).length, 2, 'degraded fallback serves verified raw streams when gzip is not requested');
  for (const payload of concurrentPayloads) {
    assert.equal(payload.generatedAt, sourceGeneratedAt);
    assert.equal(payload.data.rankings.dailyStores[0].sales_sar, 12);
  }

  const noQueueRoot = await makePortalFixture('no-queue-acceptance');
  const noQueue = await loadHomepage(noQueueRoot, 'homeRankings', pendingAccounting);
  assert.equal(noQueue.result.status, 503, 'a cache miss without actual queue acceptance is not reported as queued');
  assert.equal(noQueue.result.payload.refreshScheduled, false);
  assert.equal(noQueue.result.payload.queuedForHostLockedWorker, false);

  const serverSource = await fs.readFile(new URL('./serve_bi_portal.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(serverSource, /enqueueHomepageAccountingForceIntent|persistAccountingForce|allowPartial|runChildProcess: async/,
    'homepage fallback no longer owns custom force child, partial, or token enqueue state');
  assert.match(serverSource, /if \(force && options\.asyncRefresh\)[\s\S]*?scheduleBiSectionBackgroundGeneration\(/,
    'force requests use the existing async section refresh path');

  const missingRoot = await makePortalFixture('missing');
  const missing = await loadHomepage(missingRoot, 'homeRankings', pendingAccounting);
  assert.equal(missing.result.status, 503, 'no cache remains pending without an exact-generation producer');
  assert.equal(missing.result.payload.ok, false);
  assert.equal(missing.result.payload.hasData, undefined);
} finally {
  if (previousQueueFile === undefined) delete process.env.SHEIN_BI_PORTAL_SECTION_QUEUE_FILE;
  else process.env.SHEIN_BI_PORTAL_SECTION_QUEUE_FILE = previousQueueFile;
  await fs.rm(routeTemp, {recursive: true, force: true});
  await fs.rm(queueTemp, {recursive: true, force: true});
}

const core = {
  audit: {
    ok: true,
    warnings: 4,
    warningMessages: [
      'DL 店商品对账需处理：OpenAPI 库存缺失 50 条',
      'TS 店商品对账需处理：OpenAPI 库存缺失 50 条',
      '其他提醒必须保留',
      'YJ 店商品对账需处理：OpenAPI 库存缺失 30 条',
    ],
  },
};
const completeEvidence = {
  fresh: true,
  summary: {
    ok: true,
    generatedAt: '2026-08-12T05:12:32.000Z',
    reportScope: {complete: true},
    counts: {total: 3, succeeded: 3, failed: 0},
    results: ['DL', 'TS', 'YJ'].map(storeKey => ({
      storeKey,
      ok: true,
      status: 'matched',
      semanticReconciliation: {status: 'matched', counts: {stockMissing: 0}, warnings: []},
    })),
  },
};
completeEvidence.summary.reportScope.expectedStores = ['DL', 'TS', 'YJ'];
const nowMs = Date.parse('2026-08-12T06:00:00.000Z');
const overlaid = overlayCurrentProductReconciliationAudit(core, completeEvidence, {nowMs});
assert.deepEqual(overlaid.audit.warningMessages, ['其他提醒必须保留']);
assert.equal(overlaid.audit.warnings, 1);
assert.equal(overlaid.audit.liveProductReconciliationApplied, true);
assert.equal(core.audit.warnings, 4, 'overlay must not mutate the generated core');

const counted = overlayCurrentProductReconciliationAudit({
  audit: {...core.audit, warnings: 5},
}, completeEvidence, {nowMs});
assert.equal(counted.audit.warnings, 2, 'anonymous audit warning counts must survive the live overlay');

const incomplete = overlayCurrentProductReconciliationAudit(core, {
  ...completeEvidence,
  summary: {...completeEvidence.summary, reportScope: {complete: false}},
}, {nowMs});
assert.equal(incomplete, core, 'incomplete evidence must leave old warnings fail-closed');

const currentWarning = structuredClone(completeEvidence);
currentWarning.summary.results[1] = {
  storeKey: 'TS',
  ok: true,
  status: 'warning',
  semanticReconciliation: {status: 'warning', counts: {stockMissing: 2}, warnings: ['OpenAPI 库存缺失 2 条']},
};
const warned = overlayCurrentProductReconciliationAudit(core, currentWarning, {nowMs});
assert.deepEqual(warned.audit.warningMessages, ['TS 店商品对账需处理：OpenAPI 库存缺失 2 条', '其他提醒必须保留']);

const stale = overlayCurrentProductReconciliationAudit(core, completeEvidence, {
  nowMs: Date.parse('2026-08-13T06:00:00.000Z'),
});
assert.equal(stale, core, 'old reconciliation evidence must never clear newer portal warnings');

const duplicateStore = structuredClone(completeEvidence);
duplicateStore.summary.results[2] = structuredClone(duplicateStore.summary.results[0]);
const duplicateResult = overlayCurrentProductReconciliationAudit(core, duplicateStore, {nowMs});
assert.equal(duplicateResult, core, 'duplicate stores must not satisfy complete report coverage');

console.log('bi_live_page_recovery: homepage accounting fallback and live audit contracts passed');
