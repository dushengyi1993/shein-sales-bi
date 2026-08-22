#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  allocateLowEtInventory,
  canonicalInventoryKey,
  classifyEtInventoryAlert,
  decideDailyInventoryReplenishment,
  resolveInventoryIdentityKey,
  resolveInventoryShelfStatus,
  stableInventoryHash,
} from '../../lib/inventory_replenishment_policy.mjs';
import {normalizeGoodsSnDetailed} from '../../lib/product_sku_normalizer.mjs';
import {resolveOpenApiProductCacheDir, resolveOpenApiProductCacheFile} from '../../lib/shein_openapi_product_cache.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const args = {
    date: new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date()),
    policy: path.join(ROOT, 'config', 'inventory_replenishment_policy.json'),
    stores: path.join(ROOT, 'config', 'stores.json'),
    productsDir: resolveOpenApiProductCacheDir({rootDir: ROOT}),
    biData: path.join(ROOT, 'outputs', 'bi-portal', 'sections', 'inventoryTrend.json'),
    linksData: path.join(ROOT, 'outputs', 'bi-portal', 'sections', 'linksData.json'),
    operationMode: 'daily',
    requiredDetailTargets: '',
    etManifest: '',
    etBatchId: '',
    etManifestHash: '',
    etMaxAgeSeconds: null,
    out: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--date') args.date = String(argv[++i] || '');
    else if (a === '--policy') args.policy = path.resolve(argv[++i] || '');
    else if (a === '--stores') args.stores = path.resolve(argv[++i] || '');
    else if (a === '--products-dir') args.productsDir = path.resolve(argv[++i] || '');
    else if (a === '--bi-data') args.biData = path.resolve(argv[++i] || '');
    else if (a === '--links-data') args.linksData = path.resolve(argv[++i] || '');
    else if (a === '--operation-mode') args.operationMode = String(argv[++i] || '');
    else if (a === '--required-detail-targets') args.requiredDetailTargets = path.resolve(argv[++i] || '');
    else if (a === '--et-manifest') args.etManifest = path.resolve(argv[++i] || '');
    else if (a === '--et-batch-id') args.etBatchId = String(argv[++i] || '').trim();
    else if (a === '--et-manifest-hash') args.etManifestHash = String(argv[++i] || '').trim().toLowerCase();
    else if (a === '--et-max-age-seconds') args.etMaxAgeSeconds = String(argv[++i] ?? '').trim();
    else if (a === '--out') args.out = path.resolve(argv[++i] || '');
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error('Invalid --date');
  if (!['daily', 'et_low_inventory_safety'].includes(args.operationMode)) throw new Error('Invalid --operation-mode');
  if (!args.out) args.out = path.join(ROOT, 'outputs', 'reports', `daily-inventory-replenishment-plan-${args.date}.json`);
  return args;
}

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const readBiDocument = async file => {
  if (!args?.etManifest) return readJson(file);
  try {
    return await readJson(file);
  } catch (error) {
    // A same-run ET manifest is authoritative for low-ET facts. A queued or
    // unavailable Portal projection is diagnostic only and must not make the
    // direct ET fact path depend on an old/missing cache.
    return {__readError: error.message};
  }
};
const ageHours = value => (Date.now() - new Date(value || '').getTime()) / 3_600_000;
const ET_LOW_INVENTORY_MAX_AGE_HARD_LIMIT_SECONDS = 6 * 60 * 60;
const ET_LOW_INVENTORY_MAX_FUTURE_SKEW_SECONDS = 5 * 60;
const dateText = value => String(value || '').slice(0, 10);
const enabledStoreKeys = config => {
  const rows = Array.isArray(config?.stores)
    ? config.stores
    : Object.entries(config?.stores || {}).map(([storeKey, value]) => ({storeKey, ...value}));
  return rows.filter(row => row.enabled !== false).map(row => String(row.storeKey || row.key || '').trim().toUpperCase()).filter(Boolean);
};

const finiteNumber = value => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(n) ? n : null;
};

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const relativeEvidencePath = file => path.relative(ROOT, file).replace(/\\/g, '/');
const etText = value => String(value ?? '').trim();
const etBeijingDate = value => {
  const timestamp = new Date(value || '').getTime();
  if (!Number.isFinite(timestamp)) return '';
  return new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date(timestamp));
};
const etDateOnly = value => {
  const match = etText(value).match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/);
  if (!match) return '';
  return match[0].split(/[-/]/).map((part, index) => index === 0 ? part.padStart(4, '0') : part.padStart(2, '0')).join('-');
};
const isNonNegativeInteger = value => value !== null
  && value !== undefined
  && value !== ''
  && Number.isInteger(Number(value))
  && Number(value) >= 0;
const roundedSeconds = value => Number.isFinite(value) ? Number(value.toFixed(3)) : null;

function etInventoryEvidenceHash({manifestHash, batchId, targetDate, files = {}} = {}) {
  return stableInventoryHash({
    schemaVersion: 'et-low-inventory-evidence/v1',
    manifestHash: etText(manifestHash).toLowerCase(),
    batchId: etText(batchId),
    targetDate: etText(targetDate),
    endpoints: ['store_stock', 'box_stock'].map(endpoint => {
      const file = files?.[endpoint] || {};
      return {
        endpoint,
        path: etText(file.path),
        hash: etText(file.hash).toLowerCase(),
        rowCount: isNonNegativeInteger(file.rowCount) ? Number(file.rowCount) : null,
        count: isNonNegativeInteger(file.count) ? Number(file.count) : null,
        rawRowCount: isNonNegativeInteger(file.rawRowCount) ? Number(file.rawRowCount) : null,
        pageCount: isNonNegativeInteger(file.pageCount) ? Number(file.pageCount) : null,
        fetchedAt: etText(file.fetchedAt),
        complete: file.complete === true,
      };
    }),
  });
}

function assessEtTimestampFreshness(label, value, maxAgeSeconds, nowMs, blockers) {
  const timestampMs = new Date(value || '').getTime();
  if (!Number.isFinite(timestampMs)) return null;
  const ageSeconds = (nowMs - timestampMs) / 1_000;
  if (ageSeconds < -ET_LOW_INVENTORY_MAX_FUTURE_SKEW_SECONDS) {
    blockers.push(`${label} is too far in the future: ageSeconds=${roundedSeconds(ageSeconds)}`);
  } else if (ageSeconds > maxAgeSeconds) {
    blockers.push(`${label} exceeds max age: ageSeconds=${roundedSeconds(ageSeconds)} maxAgeSeconds=${maxAgeSeconds}`);
  }
  return roundedSeconds(ageSeconds);
}

// Match the ET loader's store-prefix handling locally so a same-run manifest
// can be consumed without waiting for the Portal projection. The warehouse
// loader remains the canonical implementation for persistence; this bounded
// read path mirrors only the two stock endpoints used by the low-ET guard.
const ET_STORE_PREFIX_RE = /^(DL|DX|FY|LQ|NM|HL|JY|ZL|TS|MZ|CX|YJ|XL|QY|QH)[-_]?0*/i;
const stripEtStorePrefix = value => {
  const raw = etText(value);
  const stripped = raw.replace(ET_STORE_PREFIX_RE, '');
  return stripped && stripped !== raw ? stripped : raw;
};

function normalizeEtManifestProduct(row = {}) {
  const candidates = [
    row.standard_goods_sn,
    row.standardGoodsSn,
    row.ModelNumber,
    row.model_number,
    row.Barcode,
    row.barcode,
    row.SkuCode,
    row.sku_code,
    row.match_key,
    row.matchKey,
  ].filter(value => etText(value));
  const expanded = [];
  for (const candidate of candidates) {
    const stripped = stripEtStorePrefix(candidate);
    if (stripped && stripped !== candidate) expanded.push(stripped);
    expanded.push(candidate);
  }
  let fallback = null;
  const context = {
    goodsTitle: row.TitleCn || row.title_cn || row.GoodsTitle || row.goods_title || row.TitleEn || row.title_en || '',
  };
  for (const candidate of expanded) {
    const detail = normalizeGoodsSnDetailed(candidate, context);
    if (!fallback) fallback = detail;
    if (!detail.needsReview) {
      const canonical = etText(detail.canonical);
      return {
        standardGoodsSn: canonical,
        matchKey: resolveInventoryIdentityKey(canonical) || canonicalInventoryKey(canonical),
        title: etText(context.goodsTitle),
      };
    }
  }
  const detail = fallback || normalizeGoodsSnDetailed('', context);
  const canonical = etText(detail?.canonical);
  return {
    standardGoodsSn: canonical,
    matchKey: resolveInventoryIdentityKey(canonical) || canonicalInventoryKey(canonical),
    title: etText(context.goodsTitle),
  };
}

const etRowQuantity = row => finiteNumber(
  row.Quantity
    ?? row.quantity
    ?? row.available_quantity
    ?? row.availableQuantity,
);
const etRowWarehouse = row => etText(
  row.StoreroomName
    ?? row.storeroom_name
    ?? row.WarehouseName
    ?? row.warehouse_name
    ?? row.storeroom
    ?? row.warehouse,
);
const isEtLooseWarehouse = name => /09|散件/i.test(String(name || ''));
const isEtFullCartonWarehouse = name => /01|整箱/i.test(String(name || ''));
const isSk03038 = value => canonicalInventoryKey(value) === 'SK03038';

async function readJsonBytes(file) {
  const bytes = await fs.readFile(file);
  return {
    bytes,
    text: bytes.toString('utf8').replace(/^\uFEFF/, ''),
    hash: sha256(bytes),
  };
}

async function readEtManifestDocument(inputPath) {
  const input = path.resolve(inputPath);
  const pointer = await readJsonBytes(input);
  const pointerDoc = JSON.parse(pointer.text);
  const pointerRef = etText(pointerDoc?.manifestPath);
  if (!pointerRef) return {manifest: pointerDoc, manifestPath: input, manifestHash: pointer.hash, pointerPath: input};

  const candidates = path.isAbsolute(pointerRef)
    ? [pointerRef]
    : [path.resolve(ROOT, pointerRef), path.resolve(path.dirname(input), pointerRef)];
  let lastError = null;
  for (const candidate of [...new Set(candidates)]) {
    try {
      const actual = await readJsonBytes(candidate);
      return {manifest: JSON.parse(actual.text), manifestPath: candidate, manifestHash: actual.hash, pointerPath: input};
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`ET manifest pointer target is unavailable: ${pointerRef}; ${lastError?.message || 'read failed'}`);
}

function aggregateEtStockRows(rows, endpoint, aggregates, diagnostics) {
  for (const row of Array.isArray(rows) ? rows : []) {
    const product = normalizeEtManifestProduct(row);
    const warehouse = etRowWarehouse(row);
    const quantity = etRowQuantity(row);
    if (!product.matchKey || !product.standardGoodsSn || !warehouse || quantity === null) {
      diagnostics.invalidRows += 1;
      continue;
    }
    const isRelevantWarehouse = endpoint === 'store_stock'
      ? isEtLooseWarehouse(warehouse)
      : isEtFullCartonWarehouse(warehouse);
    if (!isRelevantWarehouse) continue;
    const target = aggregates.get(product.matchKey) || {
      matchKey: product.matchKey,
      standardGoodsSn: product.standardGoodsSn,
      title: product.title,
      looseSellableQty: 0,
      fullCartonQty: 0,
      storeRowCount: 0,
      boxRowCount: 0,
    };
    if (product.standardGoodsSn.localeCompare(target.standardGoodsSn) < 0) target.standardGoodsSn = product.standardGoodsSn;
    if (!target.title && product.title) target.title = product.title;
    if (endpoint === 'store_stock') {
      target.looseSellableQty += quantity;
      target.storeRowCount += 1;
    } else {
      target.fullCartonQty += quantity;
      target.boxRowCount += 1;
    }
    aggregates.set(product.matchKey, target);
  }
}

function buildEtRowsFromAggregates(aggregates, targetDate) {
  return [...aggregates.values()]
    .map(item => {
      const cartonException = isSk03038(item.standardGoodsSn) || isSk03038(item.matchKey);
      const operationalDate = item.storeRowCount > 0 ? targetDate : '';
      const boxDate = item.boxRowCount > 0 ? targetDate : '';
      const inventoryMatchStatus = cartonException
        ? (boxDate ? 'matched' : 'not_matched')
        : (operationalDate ? 'matched' : 'not_matched');
      const operationalQuantity = cartonException
        ? item.looseSellableQty + item.fullCartonQty
        : item.looseSellableQty;
      const knownQuantity = inventoryMatchStatus === 'matched' ? operationalQuantity : null;
      return {
        standard_goods_sn: item.standardGoodsSn,
        match_key: item.matchKey,
        goods_title: item.title,
        inventory_match_status: inventoryMatchStatus,
        current_sellable_quantity: knownQuantity,
        et_estimated_available_qty: knownQuantity,
        et_loose_sellable_qty: item.looseSellableQty,
        et_full_carton_qty: item.fullCartonQty,
        et_store_snapshot_date: operationalDate,
        et_box_snapshot_date: boxDate,
        et_operational_stock_policy: cartonException
          ? '09_loose_plus_01_full_carton_exception'
          : '09_loose_only',
      };
    })
    .sort((a, b) => String(a.match_key).localeCompare(String(b.match_key)));
}

async function loadEtManifestSource(inputPath, {
  expectedDate,
  expectedBatchId,
  expectedManifestHash,
  expectedMaxAgeSeconds,
} = {}) {
  const blockers = [];
  const nowMs = Date.now();
  const maxAgeSeconds = Number(expectedMaxAgeSeconds);
  const maxAgeValid = expectedMaxAgeSeconds !== null
    && expectedMaxAgeSeconds !== undefined
    && String(expectedMaxAgeSeconds).trim() !== ''
    && Number.isInteger(maxAgeSeconds)
    && maxAgeSeconds > 0
    && maxAgeSeconds <= ET_LOW_INVENTORY_MAX_AGE_HARD_LIMIT_SECONDS;
  if (!maxAgeValid) {
    blockers.push(`ET manifest max-age threshold is missing or invalid: value=${String(expectedMaxAgeSeconds ?? '') || '(missing)'}`);
  }
  let loaded;
  try {
    loaded = await readEtManifestDocument(inputPath);
  } catch (error) {
    return {ok: false, blockers: [`ET manifest cannot be read: ${error.message}`], rows: [], factSource: null, evidence: null};
  }
  const {manifest, manifestPath, manifestHash, pointerPath} = loaded;
  const batchId = etText(manifest?.batchId);
  const targetDate = etText(manifest?.targetDate);
  if (!/^[a-f0-9]{64}$/i.test(manifestHash)) blockers.push('ET manifest hash is unreadable');
  if (expectedManifestHash && (!/^[a-f0-9]{64}$/i.test(expectedManifestHash) || expectedManifestHash !== manifestHash)) {
    blockers.push(`ET manifest hash mismatch: expected=${expectedManifestHash || '(missing)'} actual=${manifestHash || '(unreadable)'}`);
  }
  if (manifest?.ok !== true) blockers.push(`ET manifest is not completed: batch=${batchId || '(missing)'}`);
  if (String(manifest?.mode || '') !== 'daily') blockers.push(`ET manifest mode is not daily: mode=${String(manifest?.mode || '')}`);
  if (!batchId || (expectedBatchId && batchId !== expectedBatchId)) {
    blockers.push(`ET manifest batch mismatch: expected=${expectedBatchId || '(missing)'} actual=${batchId || '(missing)'}`);
  }
  if (!targetDate || targetDate !== expectedDate) {
    blockers.push(`ET manifest date mismatch: expected=${expectedDate || '(missing)'} actual=${targetDate || '(missing)'}`);
  }
  const createdAt = etText(manifest?.createdAt);
  let manifestAgeSeconds = null;
  if (!createdAt || !Number.isFinite(new Date(createdAt).getTime())) {
    blockers.push('ET manifest createdAt is unreadable');
  } else if (expectedDate && etBeijingDate(createdAt) !== expectedDate) {
    blockers.push(`ET manifest createdAt date is stale: expected=${expectedDate} actual=${etBeijingDate(createdAt)}`);
  } else if (maxAgeValid) {
    manifestAgeSeconds = assessEtTimestampFreshness('ET manifest createdAt', createdAt, maxAgeSeconds, nowMs, blockers);
  }

  const sourceFiles = {};
  const aggregates = new Map();
  const diagnostics = {
    invalidRows: 0,
    endpointRows: {store_stock: 0, box_stock: 0},
    endpointAgeSeconds: {store_stock: null, box_stock: null},
  };
  // Embedded inventory projections are never authoritative here. They can omit
  // products without carrying any proof of snapshot completeness. The direct
  // low-ET fact path therefore always binds both raw stock endpoint files and
  // requires their API count/page contract to prove a complete snapshot.
  const files = manifest?.files && typeof manifest.files === 'object' ? manifest.files : {};
  for (const endpoint of ['store_stock', 'box_stock']) {
    const endpointBlockerOffset = blockers.length;
    const relativeFile = etText(files[endpoint]);
    const endpointMeta = manifest?.endpoints?.[endpoint];
    if (!relativeFile) {
      blockers.push(`ET manifest is missing ${endpoint} file`);
      continue;
    }
    if (path.isAbsolute(relativeFile)) {
      blockers.push(`ET manifest ${endpoint} file path must be relative`);
      continue;
    }
    const manifestDir = path.resolve(path.dirname(manifestPath));
    const fullFile = path.resolve(manifestDir, relativeFile);
    if (fullFile !== manifestDir && !fullFile.startsWith(`${manifestDir}${path.sep}`)) {
      blockers.push(`ET manifest ${endpoint} file escapes the batch directory`);
      continue;
    }
    if (!endpointMeta || etText(endpointMeta.kind) !== 'snapshot') {
      blockers.push(`ET manifest ${endpoint} completeness kind is invalid`);
    }
    for (const field of ['count', 'rawRowCount', 'rowCount', 'pages']) {
      if (!isNonNegativeInteger(endpointMeta?.[field])) {
        blockers.push(`ET manifest ${endpoint} completeness ${field} is missing or invalid`);
      }
    }
    if (endpointMeta?.stoppedByOverlap !== false || endpointMeta?.stoppedByDailyInitialCap !== false) {
      blockers.push(`ET manifest ${endpoint} snapshot stopped before completeness was proven`);
    }
    try {
      const content = await readJsonBytes(fullFile);
      const document = JSON.parse(content.text);
      const rows = Array.isArray(document?.rows) ? document.rows : null;
      if (!rows) {
        blockers.push(`ET manifest ${endpoint} file rows are unavailable`);
        continue;
      }
      if (etText(document?.endpoint) !== endpoint) {
        blockers.push(`ET manifest ${endpoint} file endpoint identity mismatch: actual=${etText(document?.endpoint) || '(missing)'}`);
      }
      const endpointFetchedAt = etText(document?.fetchedAt);
      let endpointAgeSeconds = null;
      if (!endpointFetchedAt || !Number.isFinite(new Date(endpointFetchedAt).getTime())) {
        blockers.push(`ET manifest ${endpoint} file fetchedAt is unreadable`);
      } else if (expectedDate && etBeijingDate(endpointFetchedAt) !== expectedDate) {
        blockers.push(`ET manifest ${endpoint} file fetchedAt is stale: expected=${expectedDate} actual=${etBeijingDate(endpointFetchedAt)}`);
      } else if (maxAgeValid) {
        endpointAgeSeconds = assessEtTimestampFreshness(`ET manifest ${endpoint} file fetchedAt`, endpointFetchedAt, maxAgeSeconds, nowMs, blockers);
      }
      diagnostics.endpointAgeSeconds[endpoint] = endpointAgeSeconds;
      const pageRows = Array.isArray(document?.pages) ? document.pages : null;
      if (!isNonNegativeInteger(document?.count)
        || !isNonNegativeInteger(document?.rawRowCount)
        || !pageRows
        || pageRows.length < 1) {
        blockers.push(`ET manifest ${endpoint} file completeness metadata is missing or invalid`);
      }
      const pageContractValid = pageRows && pageRows.every(page => isNonNegativeInteger(page?.count)
        && Number(page.count) === Number(endpointMeta?.count)
        && isNonNegativeInteger(page?.rows));
      if (!pageContractValid) {
        blockers.push(`ET manifest ${endpoint} API page-count contract is incomplete`);
      }
      const pageRowTotal = pageRows
        ? pageRows.reduce((sum, page) => sum + (isNonNegativeInteger(page?.rows) ? Number(page.rows) : 0), 0)
        : -1;
      diagnostics.endpointRows[endpoint] = rows.length;
      const countValues = [
        endpointMeta?.count,
        endpointMeta?.rawRowCount,
        endpointMeta?.rowCount,
        endpointMeta?.pages,
        document?.count,
        document?.rawRowCount,
        rows.length,
        pageRows?.length,
        pageRowTotal,
      ].map(Number);
      const expectedValues = [
        rows.length,
        rows.length,
        rows.length,
        pageRows?.length,
        rows.length,
        rows.length,
        rows.length,
        pageRows?.length,
        rows.length,
      ];
      if (countValues.some((value, index) => !Number.isFinite(value) || value !== expectedValues[index])) {
        blockers.push(`ET manifest ${endpoint} completeness counts do not bind the full endpoint snapshot`);
      }
      const complete = blockers.length === endpointBlockerOffset;
      sourceFiles[endpoint] = {
        path: relativeEvidencePath(fullFile),
        hash: content.hash,
        rowCount: rows.length,
        count: isNonNegativeInteger(endpointMeta?.count) ? Number(endpointMeta.count) : null,
        rawRowCount: isNonNegativeInteger(endpointMeta?.rawRowCount) ? Number(endpointMeta.rawRowCount) : null,
        pageCount: pageRows?.length ?? null,
        fetchedAt: endpointFetchedAt,
        complete,
      };
      aggregateEtStockRows(rows, endpoint, aggregates, diagnostics);
    } catch (error) {
      blockers.push(`ET manifest ${endpoint} file is unreadable: ${error.message}`);
    }
  }

  const rows = buildEtRowsFromAggregates(aggregates, targetDate);
  if (diagnostics.invalidRows > 0) blockers.push(`ET manifest contains invalid stock rows: count=${diagnostics.invalidRows}`);
  const completeInventoryEvidence = ['store_stock', 'box_stock'].every(endpoint => sourceFiles[endpoint]?.complete === true)
    && diagnostics.invalidRows === 0;
  const inventoryEvidenceHash = etInventoryEvidenceHash({manifestHash, batchId, targetDate, files: sourceFiles});
  const factSource = {
    schemaVersion: 'et-low-inventory-fact-source/v1',
    kind: 'et_forwarder_manifest',
    manifestPath: relativeEvidencePath(manifestPath),
    pointerPath: relativeEvidencePath(pointerPath),
    manifestHash,
    batchId,
    targetDate,
    createdAt,
    maxAgeSeconds: maxAgeValid ? maxAgeSeconds : null,
    files: sourceFiles,
    endpointRows: diagnostics.endpointRows,
    invalidRows: diagnostics.invalidRows,
    completeInventoryEvidence,
    inventoryEvidenceHash,
  };
  const evidence = {
    store: 'ET',
    source: 'et_forwarder_manifest',
    authoritative: true,
    file: relativeEvidencePath(manifestPath),
    fetchedAt: createdAt,
    ageHours: Number.isFinite(ageHours(createdAt)) ? Number(ageHours(createdAt).toFixed(4)) : null,
    batchId,
    targetDate,
    manifestHash,
    maxAgeSeconds: maxAgeValid ? maxAgeSeconds : null,
    manifestAgeSeconds,
    endpointAgeSeconds: diagnostics.endpointAgeSeconds,
    completeInventoryEvidence,
    inventoryEvidenceHash,
    sourceFiles,
    endpointRows: diagnostics.endpointRows,
  };
  return {ok: blockers.length === 0, blockers, rows, factSource, evidence};
}

const args = parseArgs(process.argv.slice(2));
const [policy, storeConfig, biDocument, linksDocument] = await Promise.all([
  readJson(args.policy),
  readJson(args.stores),
  readBiDocument(args.biData),
  readJson(args.linksData),
]);
const requiredDetailTargets = args.requiredDetailTargets
  ? await readJson(args.requiredDetailTargets)
  : null;
const etSource = args.etManifest
  ? await loadEtManifestSource(args.etManifest, {
    expectedDate: args.date,
    expectedBatchId: args.etBatchId,
    expectedManifestHash: args.etManifestHash,
    expectedMaxAgeSeconds: args.etMaxAgeSeconds,
  })
  : null;
const bi = biDocument?.data && typeof biDocument.data === 'object' ? biDocument.data : biDocument;
const links = linksDocument?.data && typeof linksDocument.data === 'object' ? linksDocument.data : linksDocument;
const stores = enabledStoreKeys(storeConfig);
const biGeneratedAt = biDocument.cachedAt || biDocument.generatedAt || bi.generatedAt || bi.createdAt;
const biAge = ageHours(biGeneratedAt);
const linksGeneratedAt = linksDocument.cachedAt || linksDocument.generatedAt || links.generatedAt || links.createdAt;
const linksAge = ageHours(linksGeneratedAt);
const maximumLinksAgeHours = args.operationMode === 'et_low_inventory_safety'
  ? Number(policy?.lowEtFastGuard?.maxLinksSnapshotAgeHours || policy.maxLinksSnapshotAgeHours || 4)
  : Number(policy.maxLinksSnapshotAgeHours || 4);
const blockers = [];
const sourceEvidence = [];
if (etSource) {
  if (etSource.evidence) sourceEvidence.push(etSource.evidence);
  blockers.push(...etSource.blockers);
  // Keep the Portal timestamp for diagnostics only. It is deliberately not
  // marked authoritative and can never make a stale Portal cache look like
  // the current ET batch.
  sourceEvidence.push({
    store: 'ET_PORTAL_PROJECTION_DIAGNOSTIC',
    source: 'portal_projection_diagnostic_only',
    authoritative: false,
    file: 'outputs/bi-portal/sections/inventoryTrend.json',
    fetchedAt: biGeneratedAt || '',
    ageHours: Number.isFinite(biAge) ? Number(biAge.toFixed(4)) : null,
    readError: etSource ? String(biDocument?.__readError || '') : '',
  });
} else {
  sourceEvidence.push({
    store: 'ET',
    file: 'outputs/bi-portal/sections/inventoryTrend.json',
    fetchedAt: biGeneratedAt || '',
    ageHours: Number.isFinite(biAge) ? Number(biAge.toFixed(4)) : null,
  });
  if (!Number.isFinite(biAge) || biAge < -0.25 || biAge > Number(policy.maxBiSnapshotAgeHours || 4)) {
    blockers.push(`BI/ET projection is stale: generatedAt=${biGeneratedAt || ''} ageHours=${biAge}`);
  }
}
sourceEvidence.push({
  store: 'BI_LINKS',
  file: 'outputs/bi-portal/sections/linksData.json',
  fetchedAt: linksGeneratedAt || '',
  ageHours: Number.isFinite(linksAge) ? Number(linksAge.toFixed(4)) : null,
});
if (!Number.isFinite(linksAge) || linksAge < -0.25 || linksAge > maximumLinksAgeHours) {
  blockers.push(`BI links data is stale: generatedAt=${linksGeneratedAt || ''} ageHours=${linksAge}`);
}

const etRows = etSource?.rows
  || (Array.isArray(bi?.inventoryDepletion?.products) ? bi.inventoryDepletion.products : []);
// ET rows are indexed by the alias-aware identity key (resolveInventoryIdentityKey
// honors config/product_aliases.json, so explicitly separate products such as
// KJ-102S三明治机和早餐机 vs KJ-102三明治机和早餐机 NEVER collapse into one
// canonicalInventoryKey like KJ102).  A separate canonical-form index exists
// only to detect the fail-closed case below: an alias miss with a canonical
// hit must block the row instead of sharing another product's ET evidence.
const etIdentityKey = row => String(
  resolveInventoryIdentityKey(row.standard_goods_sn || row.match_key || '')
  || canonicalInventoryKey(row.standard_goods_sn || row.match_key || ''),
).toUpperCase();
const etByIdentityKey = new Map(etRows.map(row => [etIdentityKey(row), row]));
const etByCanonicalKey = new Map(etRows.map(row => [
  String(canonicalInventoryKey(row.standard_goods_sn || row.match_key || '')).toUpperCase(),
  row,
]));
const etMatchedCurrentDayRows = etRows.filter(row => {
  if (String(row?.inventory_match_status || '') !== 'matched') return false;
  const rowOperationalDate = dateText(
    String(row?.et_operational_stock_policy || '').includes('01_full_carton_exception')
      ? row?.et_box_snapshot_date
      : row?.et_store_snapshot_date,
  );
  return rowOperationalDate === args.date;
}).length;
// Global current-day ET source gate: a freshly published cache can still
// carry an old ET business day. When the policy requires a current-day ET
// snapshot, zero matched current-day operational rows (or an empty ET
// projection) must block the whole plan instead of silently producing an
// empty executable plan. Mixed old/new stays per-row: safe current-day rows
// execute and old rows keep their per-row blockers.
if (policy.requireCurrentDayEtSnapshot === true && etMatchedCurrentDayRows === 0) {
  blockers.push(`${etSource ? 'ET manifest' : 'BI/ET projection'} has no matched current-day operational rows: matched=${etMatchedCurrentDayRows} total=${etRows.length}`);
}
const etEvidence = sourceEvidence.find(item => item.store === 'ET');
if (etEvidence) Object.assign(etEvidence, {totalEtRows: etRows.length, matchedCurrentDayEtRows: etMatchedCurrentDayRows});
const linkMetricRows = Array.isArray(links?.storeLinks)
  ? links.storeLinks
  : Array.isArray(links?.links) ? links.links : [];
const linkMetricsByKey = new Map(linkMetricRows.map(row => [
  `${String(row.store_key || row.storeKey || '').toUpperCase()}::${String(row.skc || '').trim()}`,
  row,
]));
const linkRows = [];
for (const store of stores) {
  const file = resolveOpenApiProductCacheFile(store, {rootDir: ROOT, cacheDir: args.productsDir});
  try {
    const doc = await readJson(file);
    const sourceAge = ageHours(doc.fetchedAt);
    const stockFailedChunkCount = doc?.summary?.stockFailedChunkCount;
    const hasValidStockFailureEvidence = Number.isInteger(stockFailedChunkCount) && stockFailedChunkCount >= 0;
    sourceEvidence.push({
      store,
      file,
      fetchedAt: doc.fetchedAt || '',
      ageHours: Number(sourceAge.toFixed(4)),
      stockFailedChunkCount: hasValidStockFailureEvidence ? stockFailedChunkCount : null,
      detailMissingAfterFallbackCount: Number(doc?.summary?.detailMissingAfterFallbackCount || 0),
    });
    if (!Number.isFinite(sourceAge) || sourceAge < -0.25 || sourceAge > Number(policy.maxOpenApiSnapshotAgeHours || 2)) {
      blockers.push(`${store} OpenAPI product snapshot is stale`);
    }
    if (!hasValidStockFailureEvidence) blockers.push(`${store} OpenAPI stock snapshot evidence is incomplete`);
    else if (stockFailedChunkCount > 0) blockers.push(`${store} OpenAPI stock snapshot has failed chunks`);
    // Daily inventory decisions use list + stock to determine relevance, then
    // require current detail and canonical identity only for that recomputed
    // inventory-relevant store+SPU set. The snapshot-wide missing-detail count
    // remains provenance, but non-relevant catalog rows must not block the
    // targeted refresh contract.
    for (const row of doc.normalizedRows || []) {
      linkRows.push(row);
    }
  } catch (error) {
    blockers.push(`${store} OpenAPI product snapshot unavailable: ${error.message}`);
  }
}
const dailyRequiredTargetsByStore = new Map();
if (requiredDetailTargets) {
  if (args.operationMode === 'et_low_inventory_safety') {
    if (requiredDetailTargets.schemaVersion !== 'et-low-inventory-detail-targets/v1'
      || !requiredDetailTargets.stores
      || typeof requiredDetailTargets.stores !== 'object') {
      blockers.push('low-ET current-detail target manifest is invalid');
    } else {
      const rowsByStoreSpu = new Map(linkRows.map(row => [
        `${String(row.storeKey || '').toUpperCase()}::${String(row.spu || '')}`,
        row,
      ]));
      for (const [storeKey, spus] of Object.entries(requiredDetailTargets.stores)) {
        if (!Array.isArray(spus)) {
          blockers.push(`low-ET current-detail target manifest is invalid for store=${storeKey}`);
          continue;
        }
        for (const spu of spus) {
          const identity = `store=${String(storeKey).toUpperCase()} spu=${String(spu || '')}`;
          const row = rowsByStoreSpu.get(`${String(storeKey).toUpperCase()}::${String(spu || '')}`);
          if (!row || row?.sourceCompleteness?.hasCurrentDetail !== true) {
            blockers.push(`low-ET current-detail target is unavailable after refresh: ${identity}`);
          }
        }
      }
    }
  } else if (args.operationMode === 'daily') {
    if (requiredDetailTargets.schemaVersion !== 'daily-inventory-detail-targets/v1'
      || !requiredDetailTargets.stores
      || typeof requiredDetailTargets.stores !== 'object'
      || !Object.keys(requiredDetailTargets.stores).length) {
      blockers.push('daily current-detail target manifest is invalid');
    } else if (String(requiredDetailTargets.date || '') !== args.date) {
      blockers.push(`daily current-detail target manifest date does not match plan date: ${String(requiredDetailTargets.date || '')}`);
    } else {
      const budgetPerStore = Number(requiredDetailTargets.budgetPerStore);
      if (!Number.isInteger(budgetPerStore) || budgetPerStore < 1) {
        blockers.push('daily current-detail target manifest has no valid per-store budget');
      } else {
        const rowsByStoreSpu = new Map();
        for (const row of linkRows) {
          const key = `${String(row.storeKey || '').toUpperCase()}::${String(row.spu || '').trim()}`;
          if (!rowsByStoreSpu.has(key)) rowsByStoreSpu.set(key, []);
          rowsByStoreSpu.get(key).push(row);
        }
        const seenNormalizedStores = new Set();
        for (const [storeKey, spus] of Object.entries(requiredDetailTargets.stores)) {
          const normalizedStore = String(storeKey || '').toUpperCase();
          if (!Array.isArray(spus)) {
            blockers.push(`daily current-detail target manifest is invalid for store=${storeKey}`);
            continue;
          }
          if (!normalizedStore) {
            blockers.push('daily current-detail target manifest has an empty store key');
            continue;
          }
          if (seenNormalizedStores.has(normalizedStore)) {
            blockers.push(`daily current-detail target manifest has duplicate normalized store key: store=${normalizedStore}`);
          }
          seenNormalizedStores.add(normalizedStore);
          if (!dailyRequiredTargetsByStore.has(normalizedStore)) dailyRequiredTargetsByStore.set(normalizedStore, []);
          dailyRequiredTargetsByStore.get(normalizedStore).push(...spus.map(value => String(value || '').trim()));
        }
        for (const [storeKey, normalizedSpus] of dailyRequiredTargetsByStore) {
          const uniqueSpus = [...new Set(normalizedSpus.filter(Boolean))];
          if (!uniqueSpus.length || uniqueSpus.length !== normalizedSpus.length) {
            blockers.push(`daily current-detail target manifest has empty or duplicate SPUs for store=${storeKey}`);
            continue;
          }
          if (uniqueSpus.length > budgetPerStore) {
            blockers.push(`daily current-detail target manifest exceeds per-store budget: store=${storeKey} count=${uniqueSpus.length} budget=${budgetPerStore}`);
            continue;
          }
          for (const spu of uniqueSpus) {
            const identity = `store=${storeKey} spu=${spu}`;
            const rows = rowsByStoreSpu.get(`${storeKey}::${spu}`) || [];
            if (!rows.length) {
              blockers.push(`daily current-detail target is missing from refreshed snapshot: ${identity}`);
              continue;
            }
            if (!rows.every(row => row?.sourceCompleteness?.hasCurrentDetail === true)) {
              blockers.push(`daily current-detail target is not from current detail after refresh: ${identity}`);
            }
            if (!rows.every(row => String(row?.supplierCode || '').trim())) {
              blockers.push(`daily current-detail target has incomplete canonical evidence after refresh: ${identity}`);
            }
          }
        }
      }
    }
  }
}

const actionable = [];
const linkAlerts = [];
const ignored = [];
const lowEtAllocations = [];
const rowContexts = linkRows.map(row => {
  const metrics = linkMetricsByKey.get(`${String(row.storeKey || '').toUpperCase()}::${String(row.skc || '').trim()}`);
  const rawMetricsKey = metrics?.standard_goods_sn
    ?? metrics?.standardGoodsSn
    ?? metrics?.raw_goods_sn
    ?? metrics?.rawGoodsSn;
  const resolvedProductKey = resolveInventoryIdentityKey(row.supplierCode);
  const resolvedMetricsKey = metrics ? resolveInventoryIdentityKey(rawMetricsKey) : '';
  const productMatchKey = resolvedProductKey || canonicalInventoryKey(row.supplierCode);
  const metricsMatchKey = resolvedMetricsKey || canonicalInventoryKey(rawMetricsKey);
  const matchKey = args.operationMode === 'et_low_inventory_safety'
    ? (metricsMatchKey || productMatchKey)
    : productMatchKey;
  return {
    row,
    metrics,
    matchKey,
    productMatchKey,
    resolvedProductKey,
    resolvedMetricsKey,
    shelfStatus: resolveInventoryShelfStatus(metrics, row.shelfStatusCode),
  };
});
const onShelfSkcsByStoreMatchKey = new Map();
for (const metrics of linkMetricRows) {
  if (resolveInventoryShelfStatus(metrics).code !== '1') continue;
  const matchKey = resolveInventoryIdentityKey(
    metrics.standard_goods_sn
    ?? metrics.standardGoodsSn
    ?? metrics.raw_goods_sn
    ?? metrics.rawGoodsSn,
  ) || canonicalInventoryKey(
    metrics.standard_goods_sn
    ?? metrics.standardGoodsSn
    ?? metrics.raw_goods_sn
    ?? metrics.rawGoodsSn,
  );
  if (!matchKey) continue;
  const key = `${String(metrics.store_key || metrics.storeKey || '').toUpperCase()}::${matchKey}`;
  if (!onShelfSkcsByStoreMatchKey.has(key)) onShelfSkcsByStoreMatchKey.set(key, new Set());
  onShelfSkcsByStoreMatchKey.get(key).add(String(metrics.skc || ''));
}
for (const context of rowContexts) {
  if (context.shelfStatus.code !== '1' || !context.matchKey) continue;
  const key = `${String(context.row.storeKey || '').toUpperCase()}::${context.matchKey}`;
  if (!onShelfSkcsByStoreMatchKey.has(key)) onShelfSkcsByStoreMatchKey.set(key, new Set());
  onShelfSkcsByStoreMatchKey.get(key).add(String(context.row.skc || ''));
}
const sellingStoresByMatchKey = new Map();
for (const context of rowContexts) {
  if (context.shelfStatus.code !== '1' || Number(context.row.sheinUsableInventory) <= 0 || !context.matchKey) continue;
  if (!sellingStoresByMatchKey.has(context.matchKey)) sellingStoresByMatchKey.set(context.matchKey, new Set());
  sellingStoresByMatchKey.get(context.matchKey).add(String(context.row.storeKey || ''));
}
const evaluatedRows = [];
for (const context of rowContexts) {
  const {row, metrics, matchKey, productMatchKey, resolvedProductKey, resolvedMetricsKey, shelfStatus} = context;
  const canonicalEvidenceConflict = Boolean(metrics)
    && (!resolvedProductKey || !resolvedMetricsKey || resolvedProductKey !== resolvedMetricsKey);
  // ET evidence is bound by the alias-aware identity of the product itself,
  // never by the collapsed canonicalInventoryKey: two products that the alias
  // catalog keeps separate must not share an ET row.  When the alias-aware key
  // misses but a canonical-form key would hit, the row fails closed (block)
  // instead of generating an action from another product's ET evidence.
  const et = etByIdentityKey.get(String(resolvedProductKey || resolvedMetricsKey || '').toUpperCase()) || null;
  const etCanonicalAmbiguity = !et && Boolean(etByCanonicalKey.get(String(canonicalInventoryKey(matchKey) || '').toUpperCase()));
  const otherSellingStores = [...(sellingStoresByMatchKey.get(matchKey) || [])]
    .filter(storeKey => storeKey && storeKey !== row.storeKey)
    .sort();
  const sameStoreOnShelfSkcs = [...(onShelfSkcsByStoreMatchKey.get(
    `${String(row.storeKey || '').toUpperCase()}::${matchKey}`,
  ) || [])]
    .filter(skc => skc && skc !== String(row.skc || ''))
    .sort();
  const inventoryRelevant = shelfStatus.code === '1'
    || (shelfStatus.code === '3' && sameStoreOnShelfSkcs.length === 0);
  const operationalDate = dateText(
    String(et?.et_operational_stock_policy || '').includes('01_full_carton_exception')
      ? et?.et_box_snapshot_date
      : et?.et_store_snapshot_date,
  );
  const policyDecision = decideDailyInventoryReplenishment({
    shelfStatusCode: shelfStatus.code,
    sameStoreOnShelfLinkExists: sameStoreOnShelfSkcs.length > 0,
    skuCount: Array.isArray(row.skuCodes) ? row.skuCodes.length : 0,
    platformUsableInventory: row.sheinUsableInventory,
    etSellableInventory: et?.current_sellable_quantity ?? et?.et_estimated_available_qty,
    etSnapshotCurrentDay: operationalDate === args.date && String(et?.inventory_match_status || '') === 'matched',
    c7SaleCount: metrics?.c7_sale_cnt,
    policy,
  });
  const decision = etCanonicalAmbiguity
    ? {action: 'block', reason: 'et_canonical_identity_ambiguous'}
    : canonicalEvidenceConflict
      ? {action: 'block', reason: 'openapi_linksdata_canonical_evidence_conflict'}
      : policyDecision;
  const base = {
    storeKey: row.storeKey,
    spu: row.spu,
    skc: row.skc,
    skuCode: row.skuCodes?.[0] || '',
    supplierCode: row.supplierCode || '',
    canonical: et?.standard_goods_sn || row.supplierCode || '',
    matchKey,
    platformUsableInventory: Number(row.sheinUsableInventory),
    platformTotalInventory: Number(row.sheinInventoryQuantity),
    platformLockedInventory: Number(row.sheinLockedQuantity),
    openApiShelfStatusCode: String(row.shelfStatusCode || ''),
    shelfStatusCode: shelfStatus.code,
    shelfStatusName: shelfStatus.name,
    shelfStatusSource: shelfStatus.source,
    sameStoreOnShelfSkcs,
    otherSellingStores,
    crossStoreSoldOutFinding: Number(row.sheinUsableInventory) <= 0
      && otherSellingStores.length > 0
      && inventoryRelevant
      && sameStoreOnShelfSkcs.length === 0,
    etSellableInventory: et?.current_sellable_quantity ?? et?.et_estimated_available_qty ?? null,
    etSnapshotDate: operationalDate,
    c7SaleCount: metrics?.c7_sale_cnt ?? null,
    c30SaleCount: metrics?.c30_sale_cnt ?? null,
    c7Exposure: metrics?.c7_eps_uv ?? null,
    c7GoodsVisitors: metrics?.c7_goods_uv ?? null,
    productName: metrics?.product_display_name || metrics?.product_name_cn || '',
    decision: decision.reason,
  };
  evaluatedRows.push({row, et, metrics, decision, base, inventoryRelevant, productMatchKey, resolvedProductKey, resolvedMetricsKey});
}

// First daily build evidence gate: every inventory-relevant SPU (on-shelf, or
// sold out with no other on-shelf same-store link for the canonical) must
// carry current-run detail before the plan may execute, because cached detail
// cannot prove the canonical mapping is still current. Cached rows outside
// the inventory-relevant set stay out of this gate; the guard refreshes
// exactly the emitted detailRefreshTargets and rebuilds with
// --required-detail-targets. Current-detail fail-closed is never deleted.
if (args.operationMode === 'daily' && !requiredDetailTargets) {
  for (const item of evaluatedRows) {
    if (!item.inventoryRelevant) continue;
    if (!String(item.row?.supplierCode || '').trim()) {
      blockers.push(`${item.base.storeKey} OpenAPI product canonical evidence is incomplete: store=${item.base.storeKey} spu=${item.base.spu} skc=${item.base.skc}`);
    }
    if (item.row?.sourceCompleteness?.hasCurrentDetail !== true) {
      blockers.push(`${item.base.storeKey} OpenAPI product canonical evidence is not from current detail: store=${item.base.storeKey} spu=${item.base.spu} skc=${item.base.skc}`);
    }
  }
}

const lowEtGroups = new Map();
for (const item of evaluatedRows) {
  const threshold = Number(policy.lowEtAllocationAtOrBelow ?? 10);
  const etQty = Number(item.base.etSellableInventory);
  if (!item.inventoryRelevant || !Number.isFinite(etQty) || etQty > threshold) continue;
  if (!lowEtGroups.has(item.base.matchKey)) lowEtGroups.set(item.base.matchKey, []);
  lowEtGroups.get(item.base.matchKey).push(item);
}

const handledLowEtKeys = new Set();
const blockedLowEtKeys = new Set();
const lowEtDetailRefreshTargets = [...lowEtGroups.values()]
  .flatMap(group => group.map(item => ({
    storeKey: String(item.base.storeKey || '').toUpperCase(),
    spu: String(item.base.spu || ''),
    skc: String(item.base.skc || ''),
    matchKey: String(item.base.matchKey || ''),
  })))
  .filter(row => row.storeKey && row.spu)
  .sort((a, b) => a.storeKey.localeCompare(b.storeKey) || a.spu.localeCompare(b.spu) || a.skc.localeCompare(b.skc));
// Daily mode targets every inventory-relevant SPU, deduplicated per
// store+SPU, so stale canonical mapping changes cannot silently drop actions;
// et mode keeps the conservative low-ET candidate set.
const dailyDetailRefreshTargets = [];
if (args.operationMode === 'daily') {
  const targetByStoreSpu = new Map();
  for (const item of evaluatedRows) {
    if (!item.inventoryRelevant) continue;
    const storeKey = String(item.base.storeKey || '').toUpperCase();
    const spu = String(item.base.spu || '').trim();
    if (!storeKey || !spu) continue;
    const key = `${storeKey}::${spu}`;
    const candidate = {
      storeKey,
      spu,
      skc: String(item.base.skc || ''),
      matchKey: String(item.base.matchKey || ''),
    };
    const existing = targetByStoreSpu.get(key);
    if (!existing || candidate.skc.localeCompare(existing.skc) < 0) targetByStoreSpu.set(key, candidate);
  }
  dailyDetailRefreshTargets.push(...targetByStoreSpu.values());
  dailyDetailRefreshTargets.sort((a, b) => a.storeKey.localeCompare(b.storeKey) || a.spu.localeCompare(b.spu));
}
const detailRefreshTargets = args.operationMode === 'daily'
  ? dailyDetailRefreshTargets
  : lowEtDetailRefreshTargets;
// Second daily build coverage gate: validating the manifest's own targets is
// not enough. The refreshed snapshot may surface new inventory-relevant
// store+SPU rows after the first build emitted targets (or drop old ones), so
// every re-computed dailyDetailRefreshTargets entry must also be covered by
// the manifest. An uncovered target fails closed with an explicit blocker;
// the guard treats this as terminal (not a recoverable refresh condition).
if (args.operationMode === 'daily'
  && requiredDetailTargets
  && dailyRequiredTargetsByStore.size) {
  const coveredTargets = new Set();
  for (const [storeKey, spus] of dailyRequiredTargetsByStore) {
    for (const spu of spus) {
      const value = String(spu || '').trim();
      if (storeKey && value) coveredTargets.add(`${storeKey}::${value}`);
    }
  }
  for (const target of dailyDetailRefreshTargets) {
    if (!coveredTargets.has(`${target.storeKey}::${target.spu}`)) {
      blockers.push(`daily current-detail target set is not fully covered by manifest: store=${target.storeKey} spu=${target.spu}`);
    }
  }
}
if (args.operationMode === 'et_low_inventory_safety') {
  for (const group of lowEtGroups.values()) {
    for (const item of group) {
      const identity = `store=${item.base.storeKey} spu=${item.base.spu} skc=${item.base.skc}`;
      if (!String(item.row?.supplierCode || '').trim()) {
        blockers.push(`low-ET OpenAPI product canonical evidence is incomplete: ${identity}`);
      }
      if (item.row?.sourceCompleteness?.hasCurrentDetail !== true) {
        blockers.push(`low-ET OpenAPI product canonical evidence is not from current detail: ${identity}`);
      }
      if (item.metrics && item.resolvedMetricsKey && item.resolvedProductKey !== item.resolvedMetricsKey) {
        blockers.push(`low-ET OpenAPI product canonical evidence does not match current BI link: ${identity}`);
      }
    }
  }
}
for (const [matchKey, group] of lowEtGroups) {
  handledLowEtKeys.add(matchKey);
  const blockingRows = group.filter(item => item.decision.action !== 'allocate');
  if (blockingRows.length) {
    blockedLowEtKeys.add(matchKey);
    for (const item of group) {
      linkAlerts.push({
        ...item.base,
        action: 'block',
        decision: blockingRows.some(row => row.base.storeKey === item.base.storeKey && row.base.skc === item.base.skc)
          ? item.decision.reason
          : 'low_et_allocation_group_has_blocked_link',
      });
    }
    continue;
  }
  try {
    const ranked = allocateLowEtInventory(group.map(item => item.base), Math.floor(Number(group[0].base.etSellableInventory)), policy);
    const plannedAllocationTotal = ranked.reduce((sum, row) => sum + Number(row.targetUsableInventory || 0), 0);
    for (const allocation of ranked) {
      const allocationRow = {
        ...allocation,
        plannedAllocationTotal,
        allocationLinkCount: ranked.length,
        topExposureLinkCount: Math.min(Number(policy?.lowEtAllocation?.topExposureLinkCount ?? 5), ranked.length),
        decision: allocation.isTopExposureLink
          ? 'low_et_allocate_to_top_exposure_link'
          : 'low_et_zero_non_top_exposure_link',
      };
      lowEtAllocations.push(allocationRow);
      if (Number(allocation.platformUsableInventory) !== Number(allocation.targetUsableInventory)) {
        actionable.push({
          ...allocationRow,
          ruleClass: 'low_et_top_exposure_allocation',
          inventoryAction: Number(allocation.platformUsableInventory) < Number(allocation.targetUsableInventory) ? 'increase' : 'decrease',
          replenishmentQuantity: Math.max(0, Number(allocation.targetUsableInventory) - Number(allocation.platformUsableInventory)),
          reductionQuantity: Math.max(0, Number(allocation.platformUsableInventory) - Number(allocation.targetUsableInventory)),
        });
      }
    }
  } catch (error) {
    blockedLowEtKeys.add(matchKey);
    for (const item of group) linkAlerts.push({...item.base, action: 'block', decision: `low_et_allocation_blocked: ${error.message}`});
  }
}

for (const item of evaluatedRows) {
  if (handledLowEtKeys.has(item.base.matchKey)) continue;
  const {decision, base} = item;
  if (decision.action === 'set_exact') {
    if (Number(base.platformUsableInventory) === Number(decision.targetUsableInventory)) {
      ignored.push({
        ...base,
        action: 'skip',
        decision: 'target_inventory_already_satisfied',
        originalDecision: decision.reason,
        targetUsableInventory: decision.targetUsableInventory,
      });
      continue;
    }
    actionable.push({
      ...base,
      ruleClass: String(decision.reason || '').startsWith('recent_sale_scarcity')
        ? 'recent_sale_scarcity'
        : 'legacy_virtual_inventory_top_up',
      targetUsableInventory: decision.targetUsableInventory,
      inventoryAction: Number(base.platformUsableInventory) < Number(decision.targetUsableInventory) ? 'increase' : 'decrease',
      replenishmentQuantity: Math.max(0, decision.targetUsableInventory - Number(base.platformUsableInventory)),
      reductionQuantity: Math.max(0, Number(base.platformUsableInventory) - decision.targetUsableInventory),
    });
  } else if (decision.action === 'alert' || decision.action === 'block') linkAlerts.push({...base, action: decision.action});
  else ignored.push({...base, action: decision.action});
}

const inventoryRelevantMatchKeys = new Set(
  evaluatedRows.filter(item => item.inventoryRelevant).map(item => item.base.matchKey).filter(Boolean),
);
const etAlertsExcludedNoRelevantLinks = etRows.filter(row => !inventoryRelevantMatchKeys.has(
  etIdentityKey(row),
)).length;
const etAlerts = etRows
  .filter(row => inventoryRelevantMatchKeys.has(
    etIdentityKey(row),
  ))
  .map(row => {
    const daysOfSupplyOnHand = row.days_of_supply_on_hand ?? null;
    const etSellableInventory = row.current_sellable_quantity ?? row.et_estimated_available_qty ?? null;
    const hasNumericDays = daysOfSupplyOnHand !== null
      && daysOfSupplyOnHand !== ''
      && Number.isFinite(Number(daysOfSupplyOnHand));
    const hasNumericEt = etSellableInventory !== null
      && etSellableInventory !== ''
      && Number.isFinite(Number(etSellableInventory));
    return {
      ...row,
      alert: classifyEtInventoryAlert(row, policy),
      manualAllocationNeeded: hasNumericEt
        && Number(etSellableInventory) <= Number(policy?.etAlerts?.lowQuantity ?? 10),
      replenishmentNeeded: hasNumericEt
        && Number(etSellableInventory) > Number(policy?.etAlerts?.lowQuantity ?? 10)
        && hasNumericDays
        && Number(daysOfSupplyOnHand) < Number(policy?.etAlerts?.replenishmentDaysOfSupply ?? 120),
    };
  })
  .filter(row => row.alert.severity !== 'ok')
  .map(row => ({
    severity: row.alert.severity,
    reason: row.alert.reason,
    canonical: row.standard_goods_sn,
    matchKey: row.match_key,
    etSellableInventory: row.current_sellable_quantity ?? row.et_estimated_available_qty ?? null,
    daysOfSupplyOnHand: row.days_of_supply_on_hand ?? null,
    daysOfSupplyWithIncoming: row.days_of_supply_with_incoming ?? null,
    grossSold7d: row.gross_sold_7d ?? null,
    grossSold30d: row.gross_sold_30d ?? null,
    incomingQuantity: row.incoming_quantity ?? null,
    inventoryMatchStatus: row.inventory_match_status || '',
    manualAllocationNeeded: row.manualAllocationNeeded,
    replenishmentNeeded: row.replenishmentNeeded,
  }));

actionable.sort((a, b) => a.storeKey.localeCompare(b.storeKey) || a.skc.localeCompare(b.skc));
linkAlerts.sort((a, b) => a.canonical.localeCompare(b.canonical) || a.storeKey.localeCompare(b.storeKey));
lowEtAllocations.sort((a, b) => a.canonical.localeCompare(b.canonical) || a.exposureRank - b.exposureRank);
const outcomeByLink = new Map([...ignored, ...linkAlerts, ...lowEtAllocations, ...actionable].map(row => [
  `${row.storeKey}::${row.skc}`,
  row,
]));
const crossStoreSoldOutFindings = evaluatedRows
  .map(item => outcomeByLink.get(`${item.base.storeKey}::${item.base.skc}`) || item.base)
  .filter(row => row.crossStoreSoldOutFinding)
  .sort((a, b) => a.canonical.localeCompare(b.canonical) || a.storeKey.localeCompare(b.storeKey));
const payload = {
  schemaVersion: 'daily-inventory-replenishment-plan/v1',
  date: args.date,
  policyVersion: policy.policyVersion,
  generatedAt: new Date().toISOString(),
  etFactSource: etSource?.factSource || null,
  sourceEvidence,
  blockers: [...new Set(blockers)],
  actionable,
  linkAlerts,
  ignored,
  lowEtAllocations,
  detailRefreshTargets,
  crossStoreSoldOutFindings,
  etAlerts,
};
const payloadHash = stableInventoryHash({
  schemaVersion: payload.schemaVersion,
  date: payload.date,
  policyVersion: payload.policyVersion,
  actionable,
  lowEtAllocations,
  detailRefreshTargets,
  etFactSource: payload.etFactSource,
  sourceEvidence: sourceEvidence.map(({
    ageHours: _ageHours,
    manifestAgeSeconds: _manifestAgeSeconds,
    endpointAgeSeconds: _endpointAgeSeconds,
    ...evidence
  }) => evidence),
});
const report = {
  ...payload,
  payloadHash,
  executable: payload.blockers.length === 0,
  counts: {
    enabledStores: stores.length,
    scannedLinks: linkRows.length,
    inventoryRelevantLinks: evaluatedRows.filter(item => item.inventoryRelevant).length,
    actionable: actionable.length,
    inventoryIncreases: actionable.filter(row => row.inventoryAction === 'increase').length,
    inventoryDecreases: actionable.filter(row => row.inventoryAction === 'decrease').length,
    recentSaleScarcityActions: actionable.filter(row => row.ruleClass === 'recent_sale_scarcity').length,
    legacyVirtualTopUps: actionable.filter(row => row.ruleClass === 'legacy_virtual_inventory_top_up').length,
    lowEtAllocationActions: actionable.filter(row => row.ruleClass === 'low_et_top_exposure_allocation').length,
    lowEtAllocationRows: lowEtAllocations.length,
    lowEtZeroTargets: lowEtAllocations.filter(row => Number(row.targetUsableInventory) === 0).length,
    lowEtNonTopZeroTargets: lowEtAllocations.filter(row => row.isTopExposureLink === false && Number(row.targetUsableInventory) === 0).length,
    lowEtCandidateCanonicalCount: lowEtGroups.size,
    lowEtAllocatedCanonicalCount: new Set(lowEtAllocations.map(row => row.matchKey)).size,
    lowEtBlockedCanonicalCount: blockedLowEtKeys.size,
    detailRefreshTargetCount: detailRefreshTargets.length,
    detailRefreshTargetStores: new Set(detailRefreshTargets.map(row => row.storeKey)).size,
    crossStoreSoldOutFindings: crossStoreSoldOutFindings.length,
    crossStoreSoldOutActionable: crossStoreSoldOutFindings.filter(row => actionable.some(action => action.storeKey === row.storeKey && action.skc === row.skc)).length,
    crossStoreSoldOutAlerts: crossStoreSoldOutFindings.filter(row => linkAlerts.some(alert => alert.storeKey === row.storeKey && alert.skc === row.skc)).length,
    outShelfLinksExcluded: ignored.filter(row => row.shelfStatusCode === '4').length,
    waitShelfLinksExcluded: ignored.filter(row => row.shelfStatusCode === '2').length,
    soldOutLinksIgnoredSameStoreOnShelf: ignored.filter(row => row.decision === 'sold_out_has_same_store_on_shelf_link').length,
    linkAlerts: linkAlerts.length,
    etCritical: etAlerts.filter(row => row.severity === 'critical').length,
    etWarning: etAlerts.filter(row => row.severity === 'warning').length,
    etReplenishment: etAlerts.filter(row => row.severity === 'replenishment').length,
    etBelow120Days: etAlerts.filter(row => row.replenishmentNeeded).length,
    etManualAllocation: etAlerts.filter(row => row.manualAllocationNeeded).length,
    etUnknown: etAlerts.filter(row => row.severity === 'unknown').length,
    etAlertsExcludedNoRelevantLinks,
    etTotalRows: etRows.length,
    etMatchedCurrentDayRows,
    etFactSource: etSource?.factSource ? 'et_forwarder_manifest' : 'portal_projection',
  },
};
await fs.mkdir(path.dirname(args.out), {recursive: true});
await fs.writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ok: report.executable, out: path.relative(ROOT, args.out).replaceAll(path.sep, '/'), payloadHash, counts: report.counts, blockers: report.blockers}, null, 2));
if (!report.executable) process.exitCode = 2;
