#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  canonicalInventoryKey,
  resolveInventoryIdentityKey,
} from '../../lib/inventory_replenishment_policy.mjs';
import {inventoryDetailRefreshWindow} from '../../lib/inventory_detail_refresh_window.mjs';
import {validateOpenApiProductCacheData} from '../../lib/shein_openapi_product_cache.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMA_VERSION = 'daily-inventory-detail-targets/v1';
const TERMINAL_EVIDENCE_SCHEMA_VERSION = 'daily-inventory-detail-terminal-evidence/v1';
const SHA256_RE = /^[a-f0-9]{64}$/i;

const text = value => String(value ?? '').trim();
const upper = value => text(value).toUpperCase();
const targetKey = (storeKey, spu) => `${upper(storeKey)}::${text(spu)}`;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fail(code, message) {
  const error = new Error(`${code}:${message}`);
  error.code = code;
  throw error;
}

function instant(value, label) {
  const timestamp = Date.parse(text(value));
  if (!Number.isFinite(timestamp)) fail('DAILY_DETAIL_TERMINAL_EVIDENCE_INVALID', `${label}:timestamp`);
  return timestamp;
}

function beijingDate(timestamp) {
  return new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date(timestamp));
}

async function readRegularJson(file, label) {
  const resolved = path.resolve(file);
  let stat;
  try {
    stat = await fs.lstat(resolved);
  } catch (error) {
    fail('DAILY_DETAIL_TERMINAL_EVIDENCE_UNAVAILABLE', `${label}:${error.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail('DAILY_DETAIL_TERMINAL_EVIDENCE_INVALID', `${label}:not-a-regular-file`);
  const bytes = await fs.readFile(resolved);
  let json;
  try {
    json = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    fail('DAILY_DETAIL_TERMINAL_EVIDENCE_INVALID', `${label}:invalid-json:${error.message}`);
  }
  return {file: resolved, stat, bytes, json, sha256: sha256(bytes)};
}

function normalizeManifestTargets(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('DAILY_DETAIL_TERMINAL_EVIDENCE_INVALID', 'manifest:object-required');
  }
  if (manifest.schemaVersion !== SCHEMA_VERSION) fail('DAILY_DETAIL_TERMINAL_EVIDENCE_INVALID', 'manifest:schemaVersion');
  const date = text(manifest.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('DAILY_DETAIL_TERMINAL_EVIDENCE_INVALID', 'manifest:date');
  if (manifest.producer !== 'cloud_daily_inventory_replenishment_guard') {
    fail('DAILY_DETAIL_TERMINAL_EVIDENCE_INVALID', 'manifest:producer');
  }
  if (!manifest.stores || typeof manifest.stores !== 'object' || Array.isArray(manifest.stores)) {
    fail('DAILY_DETAIL_TERMINAL_EVIDENCE_INVALID', 'manifest:stores');
  }
  const targets = [];
  const seen = new Set();
  for (const [rawStore, rawSpus] of Object.entries(manifest.stores)) {
    const storeKey = upper(rawStore);
    if (!storeKey || !Array.isArray(rawSpus) || !rawSpus.length) {
      fail('DAILY_DETAIL_TERMINAL_EVIDENCE_INVALID', `manifest:store=${rawStore}:empty-or-invalid`);
    }
    for (const rawSpu of rawSpus) {
      const spu = text(rawSpu);
      const key = targetKey(storeKey, spu);
      if (!spu || seen.has(key)) fail('DAILY_DETAIL_TERMINAL_EVIDENCE_INVALID', `manifest:duplicate-target=${key}`);
      seen.add(key);
      targets.push({storeKey, spu, key});
    }
  }
  if (!targets.length) fail('DAILY_DETAIL_TERMINAL_EVIDENCE_INVALID', 'manifest:no-targets');
  const budget = Number(manifest.budgetPerStore);
  if (!Number.isInteger(budget) || budget < 1) fail('DAILY_DETAIL_TERMINAL_EVIDENCE_INVALID', 'manifest:budget');
  const perStore = Object.fromEntries(Object.entries(manifest.stores).map(([rawStore, rawSpus]) => [upper(rawStore), rawSpus.length]));
  const maxPerStore = Math.max(...Object.values(perStore));
  if (maxPerStore > budget) fail('DAILY_DETAIL_TERMINAL_EVIDENCE_BUDGET', `maxPerStore=${maxPerStore}:budget=${budget}`);
  if (Number(manifest.counts?.total) !== targets.length
    || JSON.stringify(manifest.counts?.perStore || {}) !== JSON.stringify(perStore)
    || Number(manifest.counts?.maxPerStore) !== maxPerStore) {
    fail('DAILY_DETAIL_TERMINAL_EVIDENCE_INVALID', 'manifest:counts');
  }
  const bindings = Array.isArray(manifest.targetBindings) ? manifest.targetBindings : [];
  const byKey = new Map();
  for (const rawBinding of bindings) {
    const storeKey = upper(rawBinding?.storeKey);
    const spu = text(rawBinding?.spu);
    const key = targetKey(storeKey, spu);
    const skc = text(rawBinding?.skc);
    const matchKey = text(rawBinding?.matchKey);
    if (!storeKey || !spu || !skc || !matchKey || byKey.has(key) || !seen.has(key)) {
      fail('DAILY_DETAIL_TERMINAL_EVIDENCE_INVALID', `manifest:binding=${key}`);
    }
    byKey.set(key, {storeKey, spu, skc, matchKey});
  }
  if (byKey.size !== seen.size || [...seen].some(key => !byKey.has(key))) {
    fail('DAILY_DETAIL_TERMINAL_EVIDENCE_INVALID', 'manifest:bindings-incomplete');
  }
  return {date, budget, targets, bindings: byKey};
}

function findProductListRow(data, binding) {
  return (Array.isArray(data.productList) ? data.productList : []).find(row => (
    text(row?.spuName) === binding.spu && text(row?.skcName) === binding.skc
  ));
}

function findCurrentDetailResult(data, binding) {
  const candidates = (Array.isArray(data.detailResults) ? data.detailResults : [])
    .filter(row => text(row?.spuName || row?.info?.spuName) === binding.spu);
  if (candidates.length !== 1 || candidates[0]?.ok !== true || !candidates[0]?.info) return null;
  return candidates[0];
}

function findTargetRow(data, binding) {
  return (Array.isArray(data.normalizedRows) ? data.normalizedRows : []).filter(row => (
    upper(row?.storeKey) === binding.storeKey
      && text(row?.spu) === binding.spu
      && text(row?.skc) === binding.skc
  ));
}

function verifyTargetRow(rows, detailResult, binding, refreshStartedMs, refreshEndedMs, cacheGeneratedMs, date) {
  if (rows.length !== 1) fail('DAILY_DETAIL_TERMINAL_EVIDENCE_TARGET_MISSING', `${binding.storeKey}::${binding.spu}:skc=${binding.skc}:rows=${rows.length}`);
  const row = rows[0];
  const completeness = row?.sourceCompleteness;
  if (completeness?.hasCurrentDetail !== true || completeness?.detailSource !== 'current') {
    fail('DAILY_DETAIL_TERMINAL_EVIDENCE_TARGET_NOT_CURRENT', `${binding.storeKey}::${binding.spu}`);
  }
  const detailFetchedAt = instant(completeness?.detailFetchedAt, `${binding.storeKey}::${binding.spu}:detailFetchedAt`);
  if (beijingDate(detailFetchedAt) !== date
    || !inventoryDetailRefreshWindow({
      refreshStartedAt: new Date(refreshStartedMs).toISOString(),
      detailFetchedAt: completeness?.detailFetchedAt,
      cacheGeneratedAt: new Date(cacheGeneratedMs).toISOString(),
      refreshEndedAt: new Date(refreshEndedMs).toISOString(),
    }).ok) {
    fail('DAILY_DETAIL_TERMINAL_EVIDENCE_TARGET_STALE', `${binding.storeKey}::${binding.spu}:detailFetchedAt=${completeness?.detailFetchedAt}`);
  }
  const supplierCode = text(row?.supplierCode);
  if (!supplierCode) fail('DAILY_DETAIL_TERMINAL_EVIDENCE_CANONICAL_MISSING', `${binding.storeKey}::${binding.spu}`);
  const resolved = resolveInventoryIdentityKey(supplierCode) || canonicalInventoryKey(supplierCode);
  if (!resolved || resolved !== binding.matchKey) {
    fail('DAILY_DETAIL_TERMINAL_EVIDENCE_CANONICAL_DRIFT', `${binding.storeKey}::${binding.spu}:expected=${binding.matchKey}:actual=${resolved}`);
  }
  const detailSkcs = Array.isArray(detailResult?.info?.skcInfoList) ? detailResult.info.skcInfoList : [];
  if (!detailSkcs.length || !detailSkcs.some(item => text(item?.skcName) === binding.skc)) {
    fail('DAILY_DETAIL_TERMINAL_EVIDENCE_SKC_DRIFT', `${binding.storeKey}::${binding.spu}:skc=${binding.skc}`);
  }
  return {
    storeKey: binding.storeKey,
    spu: binding.spu,
    skc: binding.skc,
    matchKey: binding.matchKey,
    canonicalMatchKey: resolved,
    cacheGeneratedAt: '',
    detailFetchedAt: completeness.detailFetchedAt,
    hasCurrentDetail: true,
  };
}

export async function verifyDailyInventoryDetailManifest({
  manifestFile,
  cacheDir,
  date,
  refreshStartedAt,
  refreshEndedAt,
} = {}) {
  if (!manifestFile || !cacheDir) fail('DAILY_DETAIL_TERMINAL_EVIDENCE_INPUT_INVALID', 'manifestFile/cacheDir required');
  const manifestMeta = await readRegularJson(manifestFile, 'manifest');
  const manifest = normalizeManifestTargets(manifestMeta.json);
  if (date && manifest.date !== text(date)) fail('DAILY_DETAIL_TERMINAL_EVIDENCE_INVALID', 'date-mismatch');
  const refreshStartedMs = instant(refreshStartedAt, 'refreshStartedAt');
  const refreshEndedMs = instant(refreshEndedAt, 'refreshEndedAt');
  if (refreshEndedMs < refreshStartedMs) fail('DAILY_DETAIL_TERMINAL_EVIDENCE_INVALID', 'refresh-time-order');
  if (beijingDate(refreshStartedMs) !== manifest.date || beijingDate(refreshEndedMs) !== manifest.date) {
    fail('DAILY_DETAIL_TERMINAL_EVIDENCE_INVALID', 'refresh-time-date');
  }
  const cacheByStore = new Map();
  for (const storeKey of [...new Set(manifest.targets.map(target => target.storeKey))].sort()) {
    const file = path.join(path.resolve(cacheDir), storeKey, 'latest.json');
    const meta = await readRegularJson(file, `cache:${storeKey}`);
    if (!SHA256_RE.test(meta.sha256)) fail('DAILY_DETAIL_TERMINAL_EVIDENCE_CACHE_INVALID', `${storeKey}:file-sha256`);
    let loaded;
    try {
      loaded = validateOpenApiProductCacheData(meta.json, {
        file,
        expectedStore: storeKey,
        maxAgeMs: 24 * 60 * 60 * 1000,
        now: new Date(refreshEndedMs),
      });
    } catch (error) {
      fail('DAILY_DETAIL_TERMINAL_EVIDENCE_CACHE_INVALID', `${storeKey}:${error.message}`);
    }
    const generatedMs = instant(loaded.generatedAt, `cache:${storeKey}:generatedAt`);
    if (beijingDate(generatedMs) !== manifest.date
      || generatedMs < refreshStartedMs
      || generatedMs > refreshEndedMs) {
      fail('DAILY_DETAIL_TERMINAL_EVIDENCE_CACHE_STALE', `${storeKey}:generatedAt=${loaded.generatedAt}`);
    }
    cacheByStore.set(storeKey, {
      data: loaded.data,
      file,
      sha256: meta.sha256,
      generatedAt: loaded.generatedAt,
      generatedMs,
    });
  }
  const evidenceTargets = [];
  for (const target of manifest.targets) {
    const binding = manifest.bindings.get(target.key);
    const cache = cacheByStore.get(target.storeKey);
    const product = findProductListRow(cache.data, binding);
    if (!product) fail('DAILY_DETAIL_TERMINAL_EVIDENCE_TARGET_MISSING', `${target.key}:productList skc=${binding.skc}`);
    const detail = findCurrentDetailResult(cache.data, binding);
    if (!detail) fail('DAILY_DETAIL_TERMINAL_EVIDENCE_TARGET_NOT_CURRENT', `${target.key}:detailResult`);
    const verified = verifyTargetRow(
      findTargetRow(cache.data, binding),
      detail,
      binding,
      refreshStartedMs,
      refreshEndedMs,
      cache.generatedMs,
      manifest.date,
    );
    evidenceTargets.push({
      ...verified,
      cacheFile: cache.file,
      cacheSha256: cache.sha256,
      cacheGeneratedAt: cache.generatedAt,
    });
  }
  return {
    schemaVersion: TERMINAL_EVIDENCE_SCHEMA_VERSION,
    status: 'terminal',
    coverage: 'exact_manifest_target_bindings',
    date: manifest.date,
    recordedAt: new Date(refreshEndedMs).toISOString(),
    refreshStartedAt: new Date(refreshStartedMs).toISOString(),
    refreshEndedAt: new Date(refreshEndedMs).toISOString(),
    manifestFile: manifestMeta.file,
    manifestSha256: manifestMeta.sha256,
    cacheBindings: [...cacheByStore.entries()].map(([storeKey, cache]) => ({
      storeKey,
      cacheFile: cache.file,
      cacheSha256: cache.sha256,
      cacheGeneratedAt: cache.generatedAt,
    })),
    targetBindings: evidenceTargets,
    targetCount: evidenceTargets.length,
  };
}

function parseArgs(argv) {
  const args = {manifestFile: '', cacheDir: '', date: '', refreshStartedAt: '', refreshEndedAt: ''};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`missing value for ${option}`);
      return argv[index];
    };
    if (option === '--manifest') args.manifestFile = path.resolve(next());
    else if (option === '--cache-dir') args.cacheDir = path.resolve(next());
    else if (option === '--date') args.date = text(next());
    else if (option === '--refresh-started-at') args.refreshStartedAt = text(next());
    else if (option === '--refresh-ended-at') args.refreshEndedAt = text(next());
    else throw new Error(`unknown argument: ${option}`);
  }
  if (!args.manifestFile || !args.cacheDir || !args.date || !args.refreshStartedAt || !args.refreshEndedAt) {
    throw new Error('--manifest, --cache-dir, --date, --refresh-started-at and --refresh-ended-at are required');
  }
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    console.log(JSON.stringify(await verifyDailyInventoryDetailManifest(args), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ok: false, code: error.code || 'DAILY_DETAIL_TERMINAL_EVIDENCE_FAILED', error: error.message}, null, 2));
    process.exitCode = 1;
  }
}
