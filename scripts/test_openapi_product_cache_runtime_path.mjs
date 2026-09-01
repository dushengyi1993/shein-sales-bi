#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  DEFAULT_OPENAPI_PRODUCT_CACHE_DIR,
  OPENAPI_PRODUCT_CACHE_ENV,
  OPENAPI_PRODUCT_CACHE_MAX_AGE_ENV,
  OPENAPI_PRODUCT_CACHE_RELATIVE_DIR,
  OPENAPI_PRODUCT_CACHE_SCHEMA_VERSION,
  OPENAPI_PRODUCT_CACHE_METADATA_SCHEMA_VERSION,
  readOpenApiProductCache,
  resolveOpenApiProductCacheDir,
  resolveOpenApiProductCacheFile,
  writeOpenApiProductCacheAtomically,
} from '../lib/shein_openapi_product_cache.mjs';
import {loadOpenApiProductDetail} from '../lib/link_ops_product_draft_mapper.mjs';
import {parseArgs as parseFetchArgs} from './fetch_shein_openapi_products.mjs';
import {parseArgs as parseReconciliationArgs} from './run_shein_openapi_products_reconciliation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_LOCAL_DIR = path.join(ROOT, OPENAPI_PRODUCT_CACHE_RELATIVE_DIR);
const EXPECTED_RUNTIME_DIR = '/srv/shein-bi/runtime/openapi-product-cache';
const configuredCacheDir = path.resolve(ROOT, '..', 'shein-openapi-runtime-cache');
const NOW = new Date('2026-08-21T12:00:00.000Z');
const FRESH_AT = '2026-08-21T11:00:00.000Z';
const SOURCE_SKC = 'sv260821123456789012345';
const OTHER_SKC = 'sv260821123456789012346';
const SOURCE_SPU = 'SPU-CACHE-PATH-EXACT';

function detailInfo({skcs = [SOURCE_SKC], spuName = SOURCE_SPU} = {}) {
  return {
    spuName,
    categoryId: 13127,
    productTypeId: 1165,
    productAttributeInfoList: [{attributeId: 1000546, attributeValueId: 1}],
    skcInfoList: skcs.map(skcName => ({
      skcName,
      skuInfoList: [{skuCode: `SKU-${skcName}`, length: 1, width: 2, height: 3, weight: 4}],
    })),
  };
}

function payload({storeKey = 'DL', normalizedSkc = SOURCE_SKC, detailSkcs = [SOURCE_SKC], spuName = SOURCE_SPU} = {}) {
  return {
    ok: true,
    storeKey,
    fetchedAt: FRESH_AT,
    normalizedRows: [{storeKey, skc: normalizedSkc, spu: spuName}],
    detailResults: [{ok: true, spuName, info: detailInfo({skcs: detailSkcs, spuName})}],
    detailFallbackResults: [],
  };
}

async function writeCache(file, value = payload(), {storeKey = 'DL', generatedAt = FRESH_AT} = {}) {
  return writeOpenApiProductCacheAtomically(file, value, {storeKey, generatedAt});
}

async function writeRaw(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function rejectsCode(action, code, label) {
  await assert.rejects(action, error => error?.code === code, label);
}

assert.equal(DEFAULT_OPENAPI_PRODUCT_CACHE_DIR, EXPECTED_LOCAL_DIR,
  'local default must remain outputs/shein_openapi_products');
assert.equal(resolveOpenApiProductCacheDir({rootDir: ROOT, env: {}}), EXPECTED_LOCAL_DIR,
  'unset env must preserve the local test default');
assert.equal(resolveOpenApiProductCacheDir({rootDir: ROOT, env: {[OPENAPI_PRODUCT_CACHE_ENV]: configuredCacheDir}}), configuredCacheDir,
  'the canonical env must select the configured external runtime root');
assert.throws(
  () => resolveOpenApiProductCacheFile('../escape', {rootDir: ROOT, cacheDir: EXPECTED_RUNTIME_DIR}),
  /Invalid OpenAPI product cache store key/,
  'store path traversal must fail closed',
);

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-openapi-product-cache-'));
const externalCacheDir = path.join(tempRoot, 'runtime-cache');
const cacheFile = resolveOpenApiProductCacheFile('DL', {rootDir: ROOT, cacheDir: externalCacheDir});
const hlCacheFile = resolveOpenApiProductCacheFile('HL', {rootDir: ROOT, cacheDir: externalCacheDir});

try {
  const written = await writeCache(cacheFile);
  const loadedCache = await readOpenApiProductCache(cacheFile, {expectedStore: 'DL', now: NOW});
  assert.equal(loadedCache.metadata.schemaVersion, OPENAPI_PRODUCT_CACHE_METADATA_SCHEMA_VERSION, 'metadata schema must be present');
  assert.equal(loadedCache.metadata.storeKey, 'DL', 'metadata store must be exact');
  assert.equal(loadedCache.metadata.generatedAt, FRESH_AT, 'metadata generatedAt must be present');
  assert.equal(loadedCache.metadata.hash, written.hash, 'metadata hash must match the atomic write result');
  assert.equal(loadedCache.data.schemaVersion, OPENAPI_PRODUCT_CACHE_SCHEMA_VERSION, 'cache schema must be canonical');
  assert.equal(loadedCache.data.storeKey, 'DL', 'cache store must be exact');
  assert.equal((await fs.readdir(path.dirname(cacheFile))).some(name => name.endsWith('.tmp')), false,
    'atomic write must not leave a temp file after publication');

  const loaded = await loadOpenApiProductDetail('DL', SOURCE_SKC, {cacheDir: externalCacheDir, now: NOW});
  assert.equal(loaded?.file, cacheFile, 'mapper must read the exact external cache file');
  assert.equal(loaded?.info?.spuName, SOURCE_SPU, 'mapper must retain exact source detail identity');
  assert.equal(loaded?.skcInfo?.skcName, SOURCE_SKC, 'mapper must match the exact sourceSkc');
  assert.equal(loaded?.sourceDetailLock?.sourceSkc, SOURCE_SKC, 'source detail lock must carry exact sourceSkc');
  assert.match(loaded?.sourceDetailHash || '', /^[a-f0-9]{64}$/);

  await rejectsCode(
    () => readOpenApiProductCache(cacheFile, {expectedStore: 'HL', now: NOW}),
    'OPENAPI_PRODUCT_CACHE_STORE_MISMATCH',
    'wrong cache store must be rejected',
  );

  const badSchema = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
  badSchema.schemaVersion = 'wrong/v1';
  await writeRaw(cacheFile, badSchema);
  await rejectsCode(
    () => readOpenApiProductCache(cacheFile, {expectedStore: 'DL', now: NOW}),
    'OPENAPI_PRODUCT_CACHE_SCHEMA_INVALID',
    'wrong cache schema must be rejected',
  );

  await writeCache(cacheFile);
  const badHash = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
  badHash.normalizedRows[0].skc = OTHER_SKC;
  await writeRaw(cacheFile, badHash);
  await rejectsCode(
    () => readOpenApiProductCache(cacheFile, {expectedStore: 'DL', now: NOW}),
    'OPENAPI_PRODUCT_CACHE_HASH_MISMATCH',
    'cache content drift must be rejected by metadata hash',
  );

  await writeCache(cacheFile, payload(), {storeKey: 'DL', generatedAt: '2026-07-29T11:00:00.000Z'});
  await rejectsCode(
    () => readOpenApiProductCache(cacheFile, {expectedStore: 'DL', now: NOW}),
    'OPENAPI_PRODUCT_CACHE_STALE',
    'cache older than the 21-day business refresh window must be rejected',
  );
  const savedAgeEnv = process.env[OPENAPI_PRODUCT_CACHE_MAX_AGE_ENV];
  process.env[OPENAPI_PRODUCT_CACHE_MAX_AGE_ENV] = '0';
  await rejectsCode(
    () => readOpenApiProductCache(cacheFile, {expectedStore: 'DL', now: new Date('2026-07-29T11:00:01.000Z')}),
    'OPENAPI_PRODUCT_CACHE_STALE',
    'freshness threshold must be configurable for deterministic tests',
  );
  if (savedAgeEnv === undefined) delete process.env[OPENAPI_PRODUCT_CACHE_MAX_AGE_ENV];
  else process.env[OPENAPI_PRODUCT_CACHE_MAX_AGE_ENV] = savedAgeEnv;

  await writeCache(cacheFile, payload({normalizedSkc: OTHER_SKC, detailSkcs: [OTHER_SKC]}));
  assert.equal(await loadOpenApiProductDetail('DL', SOURCE_SKC, {cacheDir: externalCacheDir, now: NOW}), null,
    'missing exact sourceSkc must remain fail-closed');

  await writeCache(cacheFile, payload({normalizedSkc: SOURCE_SKC, detailSkcs: [OTHER_SKC]}));
  assert.equal(await loadOpenApiProductDetail('DL', SOURCE_SKC, {cacheDir: externalCacheDir, now: NOW}), null,
    'mapper must not fall back to the first unrelated SKC in source detail');

  await writeCache(cacheFile, payload({normalizedSkc: SOURCE_SKC, detailSkcs: [OTHER_SKC, SOURCE_SKC]}));
  const secondExact = await loadOpenApiProductDetail('DL', SOURCE_SKC, {cacheDir: externalCacheDir, now: NOW});
  assert.equal(secondExact?.skcInfo?.skcName, SOURCE_SKC, 'an exact non-first SKC must still be selected uniquely');

  await writeCache(hlCacheFile, payload({storeKey: 'DL'}), {storeKey: 'DL'});
  assert.equal(await loadOpenApiProductDetail('HL', SOURCE_SKC, {cacheDir: externalCacheDir, now: NOW}), null,
    'wrong-store cache must not be used for the source store');
} finally {
  await fs.rm(tempRoot, {recursive: true, force: true});
}

const savedEnv = process.env[OPENAPI_PRODUCT_CACHE_ENV];
process.env[OPENAPI_PRODUCT_CACHE_ENV] = externalCacheDir;
try {
  assert.equal(parseFetchArgs(['DL']).outDir, externalCacheDir,
    'fetch default must follow the canonical env');
  assert.equal(parseReconciliationArgs([]).productCacheDir, externalCacheDir,
    'reconciliation default must follow the canonical env');
} finally {
  if (savedEnv === undefined) delete process.env[OPENAPI_PRODUCT_CACHE_ENV];
  else process.env[OPENAPI_PRODUCT_CACHE_ENV] = savedEnv;
}

const read = relativePath => fssync.readFileSync(path.join(ROOT, relativePath), 'utf8');
const mapper = read('lib/link_ops_product_draft_mapper.mjs');
const fetcher = read('scripts/fetch_shein_openapi_products.mjs');
const loader = read('scripts/load_shein_openapi_products_warehouse.mjs');
const reconciliation = read('scripts/run_shein_openapi_products_reconciliation.mjs');
assert.match(mapper, /readOpenApiProductCache/);
assert.match(mapper, /sourceDetailHash/);
assert.match(fetcher, /writeOpenApiProductCacheAtomically/);
assert.match(loader, /resolveOpenApiProductCacheDir/);
assert.match(reconciliation, /resolveOpenApiProductCacheFile/);
assert.match(reconciliation, /['"]--out['"], args\.productCacheDir/,
  'reconciliation must send one cache root to fetch');
assert.match(reconciliation, /['"]--product-dir['"], args\.productCacheDir/,
  'reconciliation must send one cache root to warehouse load');
assert.match(reconciliation, /\[OPENAPI_PRODUCT_CACHE_ENV\]: args\.productCacheDir/,
  'reconciliation child processes must inherit the same cache env');
for (const relativePath of [
  'infra/systemd/shein-bi-portal.service',
  'infra/systemd/shein-bi-cloud-openapi-stock-refresh.service',
  'infra/systemd/shein-bi-cloud-morning-chain.service',
  'infra/systemd/shein-bi-cloud-daily-refresh.service',
  'infra/systemd/shein-bi-daily-inventory-replenishment-guard.service',
  'infra/systemd/shein-bi-et-low-inventory-guard.service',
  'infra/systemd/shein-bi-et-low-inventory-recheck.service',
]) {
  const unit = read(relativePath);
  assert.match(unit, new RegExp(`^Environment=${OPENAPI_PRODUCT_CACHE_ENV}=${EXPECTED_RUNTIME_DIR.replaceAll('/', '\\/')}$`, 'm'),
    `${relativePath} must pin the cache outside the checkout`);
  assert.match(unit, new RegExp(`^ExecStartPre=\\+/usr/bin/install -d -o sheinops -g sheinops -m 0750 ${EXPECTED_RUNTIME_DIR.replaceAll('/', '\\/')}$`, 'm'),
    `${relativePath} must provision the durable runtime directory`);
}

console.log('openapi_product_cache_runtime_path: atomic write, metadata/hash, wrong-store/schema, exact-SKC identity, freshness, drift rejection, child propagation, and systemd wiring passed');
