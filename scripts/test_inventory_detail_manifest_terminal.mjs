import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildDailyInventoryPlanHashPayload,
  canonicalInventoryKey,
  resolveInventoryIdentityKey,
  stableInventoryHash,
} from '../lib/inventory_replenishment_policy.mjs';
import {inventoryDetailRefreshWindow} from '../lib/inventory_detail_refresh_window.mjs';
import {writeOpenApiProductCacheAtomically} from '../lib/shein_openapi_product_cache.mjs';
import {verifyDailyInventoryDetailManifest} from './inventory/verify_daily_inventory_detail_manifest.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-detail-terminal-evidence-'));
const cacheDir = path.join(temp, 'cache');
const manifestFile = path.join(temp, 'daily-detail-targets.json');
const date = '2026-08-26';
const refreshStartedAt = '2026-08-26T12:00:00.000Z';
const refreshEndedAt = '2026-08-26T13:00:00.000Z';
const cacheGeneratedAt = '2026-08-26T12:30:00.000Z';
const supplierCode = 'SK-3065蒸汽熨烫机';
const matchKey = resolveInventoryIdentityKey(supplierCode) || canonicalInventoryKey(supplierCode);
assert.equal(inventoryDetailRefreshWindow({
  refreshStartedAt,
  detailFetchedAt: refreshEndedAt,
  cacheGeneratedAt: '2026-08-26T13:04:00.000Z',
  refreshEndedAt,
}).ok, false, '13:04 cache generation against a 13:00 refresh end has no skew allowance');

const baseManifest = ({stores = {A: ['spu-a']}, targetBindings = [{
  storeKey: 'A', spu: 'spu-a', skc: 'skc-a', matchKey,
}], budgetPerStore = 1} = {}) => ({
  schemaVersion: 'daily-inventory-detail-targets/v1',
  date,
  generatedAt: refreshEndedAt,
  budgetPerStore,
  stores,
  counts: {
    total: Object.values(stores).reduce((sum, rows) => sum + rows.length, 0),
    perStore: Object.fromEntries(Object.entries(stores).map(([store, rows]) => [store, rows.length])),
    maxPerStore: Math.max(...Object.values(stores).map(rows => rows.length)),
  },
  producer: 'cloud_daily_inventory_replenishment_guard',
  terminalEvidence: null,
  targetBindings,
});

async function writeManifest(value) {
  await fs.writeFile(manifestFile, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeCache({store = 'A', spu = 'spu-a', skc = 'skc-a', sku = 'sku-a', current = true, canonical = supplierCode, detailSkcs = [{skcName: skc}], generatedAt = cacheGeneratedAt, detailFetchedAt = generatedAt, nonce = ''} = {}) {
  await writeOpenApiProductCacheAtomically(path.join(cacheDir, store, 'latest.json'), {
    schemaVersion: 'shein-openapi-product-basics/v1',
    ok: true,
    storeKey: store,
    fetchedAt: generatedAt,
    productList: [{spuName: spu, skcName: skc, skuCodeList: [sku]}],
    detailResults: [{
      spuName: spu,
      ok: true,
      info: {spuName: spu, skcInfoList: detailSkcs},
    }],
    detailFallbackResults: [],
    normalizedRows: [{
      storeKey: store,
      spu,
      skc,
      skuCodes: [sku],
      supplierCode: canonical,
      sourceCompleteness: {
        hasCurrentDetail: current,
        detailSource: current ? 'current' : 'prior_cache',
        detailFetchedAt: current ? detailFetchedAt : '2026-08-25T12:30:00.000Z',
      },
    }],
    summary: {stockFailedChunkCount: 0, nonce},
  }, {storeKey: store, generatedAt});
}

async function terminalEvidence(manifest = baseManifest()) {
  await writeManifest(manifest);
  return verifyDailyInventoryDetailManifest({
    manifestFile,
    cacheDir,
    date,
    refreshStartedAt,
    refreshEndedAt,
  });
}

await writeCache();
const evidence = await terminalEvidence();
assert.equal(evidence.status, 'terminal');
assert.equal(evidence.coverage, 'exact_manifest_target_bindings');
assert.equal(evidence.targetCount, 1);
assert.equal(evidence.targetBindings[0].canonicalMatchKey, matchKey);
assert.match(evidence.targetBindings[0].cacheSha256, /^[a-f0-9]{64}$/);
assert.equal(evidence.targetBindings[0].hasCurrentDetail, true);
assert.equal(evidence.manifestSha256.length, 64);
assert.equal(evidence.cacheBindings[0].cacheSha256, evidence.targetBindings[0].cacheSha256);
const verifierSource = await fs.readFile(path.join(process.cwd(), 'scripts', 'inventory', 'verify_daily_inventory_detail_manifest.mjs'), 'utf8');
assert.doesNotMatch(verifierSource, /readOpenApiProductCache\s*\(/u, 'terminal verifier must not re-read a cache after hashing different bytes');
assert.match(verifierSource, /validateOpenApiProductCacheData\(meta\.json/u, 'the hashed single-read JSON must be the validated cache content');

const planHashFromEvidence = terminal => stableInventoryHash(buildDailyInventoryPlanHashPayload({
  schemaVersion: 'daily-inventory-replenishment-plan/v1',
  date,
  policyVersion: 'test',
  actionable: [],
  lowEtAllocations: [],
  detailRefreshTargets: [{storeKey: 'A', spu: 'spu-a'}],
  etFactSource: null,
  sourceEvidence: [{
    store: 'DETAIL_MANIFEST',
    manifestOriginalSha256: terminal.manifestSha256,
    cacheBindings: terminal.cacheBindings,
    targetBindings: terminal.targetBindings,
    refreshStartedAt,
    refreshEndedAt,
  }],
}));
const firstPlanHash = planHashFromEvidence(evidence);
await writeCache({nonce: 'replacement-generation'});
const replacementEvidence = await terminalEvidence();
assert.notEqual(replacementEvidence.cacheBindings[0].cacheSha256, evidence.cacheBindings[0].cacheSha256);
assert.notEqual(planHashFromEvidence(replacementEvidence), firstPlanHash, 'cache replacement must change the plan payload hash');
await writeCache();

await writeCache({detailSkcs: []});
await assert.rejects(
  terminalEvidence(baseManifest()),
  /DAILY_DETAIL_TERMINAL_EVIDENCE_SKC_DRIFT/,
  'current detail without an exact non-empty SKC list cannot cover the target',
);
await writeCache();

await writeCache({detailFetchedAt: '2026-08-26T12:45:00.000Z', generatedAt: '2026-08-26T12:30:00.000Z'});
await assert.rejects(terminalEvidence(), /DAILY_DETAIL_TERMINAL_EVIDENCE_TARGET_STALE/, 'detail fetched in the future of its cache generation fails closed');
await writeCache({generatedAt: '2026-08-26T13:04:00.000Z', detailFetchedAt: '2026-08-26T13:00:00.000Z'});
await assert.rejects(terminalEvidence(), /DAILY_DETAIL_TERMINAL_EVIDENCE_CACHE_(?:STALE|INVALID)/, 'cache four minutes beyond refresh end fails closed with no skew allowance');
await writeCache();

const cxSpu = 'v2602032245578742';
const cxSkc = 'cx-skc-v2602032245578742';
const cxSupplierCode = 'SK-3065蒸汽熨烫机';
const cxMatchKey = resolveInventoryIdentityKey(cxSupplierCode) || canonicalInventoryKey(cxSupplierCode);
await writeCache({store: 'CX', spu: cxSpu, skc: cxSkc, sku: 'cx-sku-v2602032245578742', canonical: cxSupplierCode});
const cxEvidence = await terminalEvidence(baseManifest({
  stores: {CX: [cxSpu]},
  targetBindings: [{storeKey: 'CX', spu: cxSpu, skc: cxSkc, matchKey: cxMatchKey}],
}));
assert.equal(cxEvidence.targetCount, 1, 'a newly surfaced CX/SPU target receives exact terminal coverage');
assert.equal(cxEvidence.targetBindings[0].spu, cxSpu);

const generated = {...baseManifest()};
generated.terminalEvidence = evidence;
await writeManifest(generated);
assert.equal((await verifyDailyInventoryDetailManifest({
  manifestFile,
  cacheDir,
  date,
  refreshStartedAt,
  refreshEndedAt,
})).targetCount, 1, 'a complete same-day target has terminal evidence');

await assert.rejects(
  terminalEvidence(baseManifest({stores: {A: ['spu-a', 'spu-b']}, targetBindings: [
    {storeKey: 'A', spu: 'spu-a', skc: 'skc-a', matchKey},
    {storeKey: 'A', spu: 'spu-b', skc: 'skc-b', matchKey},
  ], budgetPerStore: 1})),
  /DAILY_DETAIL_TERMINAL_EVIDENCE_BUDGET/,
  'per-store budget exhaustion fails before cache coverage can be claimed',
);

await assert.rejects(
  terminalEvidence(baseManifest({stores: {A: ['spu-a', 'spu-a']}, targetBindings: [
    {storeKey: 'A', spu: 'spu-a', skc: 'skc-a', matchKey},
  ], budgetPerStore: 2})),
  /DAILY_DETAIL_TERMINAL_EVIDENCE_INVALID:manifest:duplicate-target/,
  'duplicate store+SPU targets fail closed',
);

await writeCache({current: false});
await assert.rejects(
  terminalEvidence(),
  /DAILY_DETAIL_TERMINAL_EVIDENCE_TARGET_NOT_CURRENT/,
  'cached detail cannot be promoted to terminal current-detail evidence',
);

await writeCache({current: true, canonical: 'SK11004蒸汽熨烫机'});
await assert.rejects(
  terminalEvidence(),
  /DAILY_DETAIL_TERMINAL_EVIDENCE_CANONICAL_DRIFT/,
  'alias/canonical drift is an exact blocker',
);

await writeCache();
await assert.rejects(
  terminalEvidence(baseManifest({stores: {A: ['spu-missing']}, targetBindings: [
    {storeKey: 'A', spu: 'spu-missing', skc: 'skc-missing', matchKey},
  ]})),
  /DAILY_DETAIL_TERMINAL_EVIDENCE_TARGET_MISSING/,
  'a newly surfaced or omitted target cannot receive a hand-written marker',
);

console.log(JSON.stringify({
  ok: true,
  checks: [
    'full_target_coverage_and_cache_hash',
    'cache_replacement_changes_plan_hash',
    'cache_sha_and_validated_content_share_one_file_read',
    'future_detail_and_cache_generation_rejected',
    'current_detail_requires_exact_nonempty_skc_binding',
    'targeted_refresh_new_cx_spu_is_terminally_covered',
    'budget_boundary_fail_closed',
    'dedupe_fail_closed',
    'cached_detail_fail_closed',
    'alias_canonical_drift_fail_closed',
    'missing_target_fail_closed',
  ],
}, null, 2));
