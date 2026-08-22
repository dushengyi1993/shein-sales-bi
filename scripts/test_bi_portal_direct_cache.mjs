#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {Buffer} from 'node:buffer';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {publishDirectPortalSection, buildProfitQueryProjection, compactHomeRankingsSectionData} from './generate_bi_portal.mjs';
import {
  publishBiProfitBundleManifest,
  readBiSectionArtifactCache,
  readBiSectionCache,
  writeBiSectionArtifact,
  writeBiSectionCache,
} from '../lib/bi_section_cache.mjs';
import {loadBiOpsQueryData} from '../lib/bi_ops_query_context.mjs';
import {__testHooks as serveHooks} from './serve_bi_portal.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GENERATION = '2026-07-11T08:00:00.000+08:00';
const RUN = {code: 0, timedOut: false, stderr: ''};
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-bi-direct-cache-'));

function queryArtifactMeta() {
  return {
    kind: 'profit-query-compact-v1',
    logicalSection: 'profit',
    sourceArtifact: 'profit',
    sourceGeneratedAt: GENERATION,
    retainedPaths: [
      'profit.dailyStoreProducts',
      'profit.monthGroups',
      'profit.products',
      'profit.storeStorageDaily',
    ],
    omittedPaths: [
      'profit.productStorageDaily',
      'profit.productStoreStorageDaily',
    ],
  };
}

function coreData(corePad = '') {
  return {
    generatedAt: GENERATION,
    dates: {salesDate: '2026-07-11'},
    __sections: {mode: 'api', generatedAt: GENERATION, keys: ['profit']},
    ...(corePad ? {corePad} : {}),
  };
}

async function makeFixture(name, withCore = true, {corePad = ''} = {}) {
  const root = path.join(tempRoot, name);
  await fs.mkdir(path.join(root, 'sections'), {recursive: true});
  if (withCore) await fs.writeFile(path.join(root, 'data.json'), JSON.stringify(coreData(corePad)), 'utf8');
  return {root, sectionsDir: path.join(root, 'sections'), dataPath: path.join(root, 'data.json')};
}

try {
  const fullData = {
    profit: {
      dailyStoreProducts: [{date: '2026-07-11', store_key: 'HL', group_key: 'GROUP-1', standard_goods_sn: 'TEST-01', net_revenue_sar: 10, quantity: 1}],
      monthGroups: [{month: '2026-07'}],
      products: [{standard_goods_sn: 'TEST-01', net_revenue_sar: 10}],
      productStorageDaily: [{date: '2026-07-11', standard_goods_sn: 'TEST-01', storage_fee_sar: 1}],
      productStoreStorageDaily: [{date: '2026-07-11', store_key: 'HL', standard_goods_sn: 'TEST-01', storage_fee_sar: 1}],
      storeStorageDaily: [{date: '2026-07-11', store_key: 'HL', group_key: 'GROUP-1', storage_fee_sar: 1, storage_fee_status: 'settled'}],
    },
  };
  const fixture = await makeFixture('direct');
  const receipt = await publishDirectPortalSection({
    section: 'profit',
    generatedAt: GENERATION,
    outDir: fixture.root,
  }, fullData);
  const receiptText = JSON.stringify(receipt);
  assert.ok(Buffer.byteLength(receiptText, 'utf8') < serveHooks.BI_DIRECT_RECEIPT_MAX_BYTES, 'direct receipt must stay bounded');
  assert.equal(receiptText.includes('productStorageDaily'), false, 'receipt must not contain section data');
  assert.equal(receiptText.includes('"data"'), false, 'receipt must not contain a data field');
  assert.deepEqual(receipt.artifacts.map(item => item.artifact), ['profit', 'profit.query', 'homeProfit']);
  await serveHooks.verifyDirectCacheReceipt(fixture.root, receipt, 'profit', GENERATION);

  const fullCache = await readBiSectionCache(fixture.root, 'profit', GENERATION);
  assert.deepEqual(Object.keys(fullCache.data.profit).sort(), [
    'dailyStoreProducts',
    'monthGroups',
    'products',
    'productStorageDaily',
    'productStoreStorageDaily',
    'storeStorageDaily',
  ].sort(), 'full Portal profit cache must remain complete');
  const queryCache = await readBiSectionArtifactCache(fixture.root, 'profit.query', 'profit.query', GENERATION, {requireIntegrity: true});
  assert.deepEqual(Object.keys(queryCache.data.profit).sort(), [
    'dailyStoreProducts',
    'monthGroups',
    'products',
    'storeStorageDaily',
  ].sort(), 'compact query projection may omit only the two named arrays');
  assert.deepEqual(queryCache.data.profit.dailyStoreProducts, fullCache.data.profit.dailyStoreProducts);
  assert.deepEqual(queryCache.data.profit.monthGroups, fullCache.data.profit.monthGroups);
  assert.deepEqual(queryCache.data.profit.products, fullCache.data.profit.products);
  assert.deepEqual(queryCache.data.profit.storeStorageDaily, fullCache.data.profit.storeStorageDaily);
  const bundleFile = path.join(fixture.sectionsDir, 'profit.bundle.json');
  const bundleBytes = await fs.readFile(bundleFile);
  await fs.rm(bundleFile);
  assert.equal(await readBiSectionCache(fixture.root, 'profit', GENERATION), null, 'a crash before the final manifest must hide the full profit artifact');
  assert.equal(await readBiSectionArtifactCache(fixture.root, 'profit.query', 'profit.query', GENERATION, {requireIntegrity: true}), null, 'a crash before the final manifest must hide compact profit');
  await assert.rejects(
    () => serveHooks.verifyDirectCacheReceipt(fixture.root, receipt, 'profit', GENERATION),
    /profit bundle manifest readback mismatch/,
    'receipt verification must fail closed without the commit marker',
  );
  await fs.writeFile(bundleFile, bundleBytes);
  assert.ok(await readBiSectionCache(fixture.root, 'profit', GENERATION), 'restoring the exact marker must restore the exact bundle');
  assert.throws(
    () => serveHooks.parseDirectCacheReceipt(receiptText, 'profit', 'wrong-generation'),
    /identity mismatch|requires section and generatedAt/,
    'receipt generation identity is required',
  );
  const badReceipt = JSON.parse(receiptText);
  badReceipt.artifacts[0].raw.sha256 = '0'.repeat(64);
  await assert.rejects(
    () => serveHooks.verifyDirectCacheReceipt(fixture.root, badReceipt, 'profit', GENERATION),
    /integrity readback mismatch|source binding mismatch/,
    'raw integrity mismatch must fail closed',
  );

  const compactRanking = compactHomeRankingsSectionData({rankings: {
    dailyProducts: [{id: 1, goods_title: 'hidden', skc_list: ['hidden'], product_display_name: 'hidden', product_display_name_source: 'hidden', keep: true}],
    dailyStoreProducts: [{id: 2, goods_title: 'hidden', skc_list: ['hidden'], product_display_name: 'hidden', product_display_name_source: 'hidden', keep: true}],
  }});
  assert.deepEqual(compactRanking.rankings.dailyProducts, [{id: 1, goods_title: 'hidden', skc_list: ['hidden'], product_display_name: 'hidden', keep: true}]);
  assert.deepEqual(compactRanking.rankings.dailyStoreProducts, [{id: 2, goods_title: 'hidden', skc_list: ['hidden'], product_display_name: 'hidden', keep: true}]);
  const filterByRetainedFields = (rows, query) => rows.filter(row => [
    row.goods_title,
    ...(Array.isArray(row.skc_list) ? row.skc_list : [row.skc_list]),
    row.product_display_name,
  ].some(value => String(value || '').toLowerCase().includes(query.toLowerCase()))).map(row => row.id);
  const filterRows = [
    {id: 11, goods_title: 'Alpha goods', skc_list: ['A-11'], product_display_name: 'Alpha display', quantity: 4},
    {id: 12, goods_title: 'Beta goods', skc_list: ['B-12'], product_display_name: undefined, quantity: undefined},
  ];
  const compactRows = compactHomeRankingsSectionData({rankings: {dailyProducts: filterRows}}).rankings.dailyProducts;
  for (const query of ['alpha goods', 'B-12', 'alpha display']) {
    assert.deepEqual(filterByRetainedFields(compactRows, query), filterByRetainedFields(filterRows, query), `homeRankings filter must remain equivalent for ${query}`);
  }
  assert.equal(compactRows.find(row => row.id === 12).quantity, undefined, 'unavailable fields must not be coerced to zero');
  const projectionInput = JSON.parse(JSON.stringify(fullData));
  const projection = buildProfitQueryProjection(projectionInput);
  assert.equal(Object.hasOwn(projectionInput.profit, 'productStorageDaily'), true, 'projection must not mutate full profit data');
  assert.equal(Object.hasOwn(projection.profit, 'productStorageDaily'), false);
  assert.equal(Object.hasOwn(projection.profit, 'productStoreStorageDaily'), false);

  const overflow = await serveHooks.runChildProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(100000))"], {
    timeoutMs: 10_000,
    maxStdoutBytes: 1024,
    maxStderrBytes: 1024,
    failOnOutputOverflow: true,
    killGraceMs: 50,
    settleGraceMs: 100,
  });
  assert.equal(overflow.ok, false);
  assert.equal(overflow.outputOverflow, true, 'receipt stdout overflow must fail closed');
  assert.equal(overflow.overflowStream, 'stdout');
  assert.ok(Buffer.byteLength(overflow.stdout, 'utf8') <= 1024);
  const uncapped = await serveHooks.runChildProcess(process.execPath, ['-e', "process.stdout.write('y'.repeat(4096))"], {timeoutMs: 10_000});
  assert.equal(uncapped.ok, true);
  assert.equal(uncapped.stdout.length, 4096, 'existing callers remain uncapped by default');

  const traffic = await makeFixture('traffic', true, {corePad: 'c'.repeat(42 * 1024 * 1024)});
  const trafficPad = 'q'.repeat(36 * 1024 * 1024);
  const trafficSectionPad = 't'.repeat(42 * 1024 * 1024);
  await writeBiSectionCache(traffic.root, 'profit', GENERATION, {
    profit: {
      dailyStoreProducts: [{date: '2026-07-11', store_key: 'HL', standard_goods_sn: 'TRAFFIC-01', net_revenue_sar: 10}],
      monthGroups: [],
      products: [],
      storeStorageDaily: [],
    },
  }, RUN, {requireIntegrity: true});
  await writeBiSectionArtifact(traffic.root, 'profit.query', 'profit.query', GENERATION, {
    profit: {
      dailyStoreProducts: [{date: '2026-07-11', store_key: 'HL', standard_goods_sn: 'TRAFFIC-01', net_revenue_sar: 10}],
      monthGroups: [{month: '2026-07', trafficShard: trafficPad}],
      products: [{standard_goods_sn: 'TRAFFIC-01'}],
      storeStorageDaily: [],
    },
  }, RUN, {requireIntegrity: true, artifactMeta: queryArtifactMeta()});
  await writeBiSectionCache(traffic.root, 'homeProfit', GENERATION, {
    homeProfitSummary: {sourceGeneratedAt: GENERATION, sourceCachedAt: new Date().toISOString(), staleSource: false, dailyScopes: []},
  }, RUN, {requireIntegrity: true});
  await publishBiProfitBundleManifest(traffic.root, GENERATION);
  await writeBiSectionArtifact(traffic.root, 'productTrafficDaily', 'productTrafficDaily', GENERATION, {
    productTrafficDaily: {trafficPad: trafficSectionPad},
  }, RUN, {requireIntegrity: true});
  const loadedTraffic = await loadBiOpsQueryData({
    question: '查询商品利润明细',
    dataPath: traffic.dataPath,
    sectionsDir: traffic.sectionsDir,
    sections: ['productTrafficDaily', 'profit'],
  });
  const trafficArtifact = loadedTraffic.meta.loadedArtifacts.find(item => item.section === 'profit');
  assert.deepEqual(loadedTraffic.meta.loadedSections, ['productTrafficDaily', 'profit']);
  assert.equal(trafficArtifact?.artifact, 'profit.query');
  assert.ok(trafficArtifact.size > 32 * 1024 * 1024 && trafficArtifact.size < 64 * 1024 * 1024, '32-64MiB query traffic shard must load');
  assert.ok(loadedTraffic.meta.coreBytes > 40 * 1024 * 1024 && loadedTraffic.meta.coreBytes < 44 * 1024 * 1024, 'core budget fixture must be about 42MiB');
  assert.ok(loadedTraffic.meta.aggregateBytes < 128 * 1024 * 1024, 'core + traffic + compact profit must remain under the bounded aggregate budget');
  assert.equal(loadedTraffic.meta.sectionProvenance.profit.sourceArtifact, 'profit');
  assert.equal(loadedTraffic.data.profit.monthGroups[0].trafficShard.length, 36 * 1024 * 1024);
  assert.equal(loadedTraffic.data.productTrafficDaily.trafficPad.length, 42 * 1024 * 1024);

  const trafficAbort = new AbortController();
  const abortTimer = setTimeout(() => trafficAbort.abort(), 5);
  let trafficAborted = false;
  try {
    await loadBiOpsQueryData({
      question: '查询商品利润和流量',
      dataPath: traffic.dataPath,
      sectionsDir: traffic.sectionsDir,
      sections: ['productTrafficDaily', 'profit'],
      signal: trafficAbort.signal,
    });
  } catch (error) {
    trafficAborted = error?.name === 'AbortError';
  } finally {
    clearTimeout(abortTimer);
  }
  assert.equal(trafficAborted, true, 'combined budget fixture must reject a mid-read abort');

  const oversizedFull = JSON.stringify({
    ok: true,
    section: 'profit',
    generatedAt: GENERATION,
    cachedAt: '2026-07-11T00:01:00.000Z',
    data: {profit: {productStorageDaily: [], productStoreStorageDaily: [], pad: 'f'.repeat(65 * 1024 * 1024)}},
  });
  await fs.writeFile(path.join(traffic.sectionsDir, 'profit.json'), oversizedFull, 'utf8');
  const fallback = await makeFixture('full-too-large');
  await fs.copyFile(path.join(traffic.sectionsDir, 'profit.json'), path.join(fallback.sectionsDir, 'profit.json'));
  const rejected = await loadBiOpsQueryData({
    question: '查询商品利润明细',
    dataPath: fallback.dataPath,
    sectionsDir: fallback.sectionsDir,
    sections: ['profit'],
  });
  assert.deepEqual(rejected.meta.loadedSections, [], 'a broken profit bundle must not be mixed or invented as zero');
  assert.equal(rejected.data.profit, undefined);
  assert.equal(rejected.meta.attemptedSections.some(item => item.status === 'integrity_unverified'), true);

  console.log('bi_portal_direct_cache: bounded receipt, overflow fail-closed, exact integrity, full/compact profit, and bounded 36MiB query passed');
} finally {
  await fs.rm(tempRoot, {recursive: true, force: true});
}
