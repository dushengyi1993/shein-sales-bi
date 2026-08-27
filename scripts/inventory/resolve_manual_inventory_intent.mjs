#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  appendManualResolutionRecord,
  buildManualResolutionEntry,
  discoverInventoryJournalFiles,
  findInventoryWriteFence,
  INVENTORY_MANUAL_RESOLUTION_DISPOSITION,
  INVENTORY_MANUAL_RESOLUTION_INTENT_ID,
  INVENTORY_MANUAL_RESOLUTION_OWNER_CONFIRMATION,
  inventoryWriteScopeKey,
  manualResolutionPreflightHash,
  normalizeInventoryWriteScope,
  readInventoryIntentJournals,
  validateManualResolutionEntry,
} from '../../lib/durable_inventory_write.mjs';
import {stableInventoryHash} from '../../lib/inventory_replenishment_policy.mjs';
import {
  inventoryCutoverLockFile,
  requireCurrentInventoryCutoverActivation,
  requireInventoryCutoverMaintenanceAll,
  withInventoryCutoverLock,
} from '../../lib/inventory_write_cutover.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_INVENTORY_JOURNAL_DIRECTORIES = Object.freeze([
  '/srv/shein-bi/runtime/daily-inventory-replenishment/results',
  '/srv/shein-bi/runtime/et-low-inventory-guard/results',
]);
const EXACT_SCOPE = Object.freeze({
  storeKey: 'XL',
  skc: 'sb260606205087254179320',
  skuCode: 'I0mq2cw2khzt47',
  warehouseCode: 'PS0916742261',
  invType: 'VI',
});
const HISTORICAL_SCOPE = Object.freeze({
  totalInventoryQuantity: 74,
  maxUsableInventory: 50,
  noUsableInventory: 100,
});

// These are the two operator-supplied raw readback artifacts. The resolver
// never opens them unless the caller explicitly supplies them, and it never
// contains a default production read/write operation. Keeping the contract
// here makes a swapped cache, stale copy, or the revoked ops-snapshot path
// fail closed before a journal append.
export const MANUAL_READBACK_EVIDENCE_CONTRACT = Object.freeze([
  Object.freeze({
    path: '/srv/shein-bi/runtime/marketing-hotrun-20260805-1343/logs/openapi-catalog-executor/20260826043306-3001695-XL.json',
    sha256: 'd44b066ee35a622ede45ec4bd36bc633a853f2d6f869be88571da85579998c04',
    bytes: 2212,
    startedAt: '2026-08-26T04:33:05.549Z',
    endedAt: '2026-08-26T04:33:06.692Z',
    payloadHash: 'be1aa44787143fac4f287dff06b51eae7f16f4c132661b6d4265c341dbac3545',
    traceId: 'a79e7c6fe9e7127e',
  }),
  Object.freeze({
    path: '/srv/shein-bi/runtime/ops-snapshots/inventory-manual-completion-xl-20260827/xl-latest-readback.json',
    sha256: '944d4251b28d6bcec399cbf4111f1cd8573dd16ce1f29d67270ebd717b8603c0',
    bytes: 4685630,
    generatedAt: '2026-08-27T09:48:38.825Z',
    traceId: 'ddf78ae095f862ab',
  }),
]);

const nowBeijingDate = () => new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const text = value => String(value ?? '').trim();
const isHash = value => /^[a-f0-9]{64}$/i.test(text(value));
const isTimestamp = value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(text(value))
  && Number.isFinite(new Date(value).getTime());

function inventoryJournalDirectories(additionalDirectories = []) {
  const configured = String(process.env.SHEIN_BI_INVENTORY_JOURNAL_DIRS || '')
    .split(path.delimiter)
    .map(directory => directory.trim())
    .filter(Boolean);
  const runtimeRoots = [
    process.env.SHEIN_BI_INVENTORY_RUNTIME_ROOT,
    process.env.SHEIN_BI_ET_INVENTORY_RUNTIME_ROOT,
    process.env.SHEIN_BI_ET_LOW_INVENTORY_RUNTIME_ROOT,
  ].filter(Boolean).map(directory => path.join(directory, 'results'));
  return [...new Set([
    ...additionalDirectories,
    ...configured,
    ...runtimeRoots,
    ...DEFAULT_INVENTORY_JOURNAL_DIRECTORIES,
  ].map(directory => String(directory || '').trim()).filter(Boolean).map(directory => path.resolve(directory)))];
}

function fail(code, message) {
  const error = new Error(`${code}:${message}`);
  error.code = code;
  throw error;
}

export function parseArgs(argv) {
  const args = {
    mode: 'dry-run',
    modeExplicit: false,
    expectedPreflightHash: '',
    journalFile: '',
    planFile: '',
    readbackArtifacts: [],
    liveInventoryBaseline: '',
    warehouseCode: EXACT_SCOPE.warehouseCode,
    ownerActor: '',
    ownerConfirmation: '',
    originalTraceId: '',
    receiptFile: '',
    lockFile: '',
    activationFile: '',
    activationReceiptFile: '',
    maintenanceFile: '',
    additionalJournalDirectories: [],
    now: new Date().toISOString(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`missing value for ${option}`);
      return argv[index];
    };
    if (option === '--dry-run') {
      if (args.modeExplicit && args.mode !== 'dry-run') throw new Error('--dry-run and --execute are mutually exclusive');
      args.mode = 'dry-run';
      args.modeExplicit = true;
    } else if (option === '--execute') {
      if (args.modeExplicit && args.mode !== 'execute') throw new Error('--dry-run and --execute are mutually exclusive');
      args.mode = 'execute';
      args.modeExplicit = true;
    } else if (option === '--expected-preflight-hash') args.expectedPreflightHash = text(next()).toLowerCase();
    else if (option === '--journal') args.journalFile = path.resolve(next());
    else if (option === '--plan') args.planFile = path.resolve(next());
    else if (option === '--readback-artifact') args.readbackArtifacts.push(next());
    else if (option === '--live-inventory-baseline') args.liveInventoryBaseline = next();
    else if (option === '--warehouse-code') args.warehouseCode = text(next()).toUpperCase();
    else if (option === '--owner-actor') args.ownerActor = text(next());
    else if (option === '--owner-confirmation') args.ownerConfirmation = text(next());
    else if (option === '--original-trace-id') args.originalTraceId = text(next());
    else if (option === '--receipt') args.receiptFile = path.resolve(next());
    else if (option === '--lock') args.lockFile = path.resolve(next());
    else if (option === '--activation-registry') args.activationFile = path.resolve(next());
    else if (option === '--activation-receipt') args.activationReceiptFile = path.resolve(next());
    else if (option === '--maintenance-file') args.maintenanceFile = path.resolve(next());
    else if (option === '--journal-dir') args.additionalJournalDirectories.push(path.resolve(next()));
    else if (option === '--now') args.now = next();
    else throw new Error(`unknown argument: ${option}`);
  }
  if (!args.journalFile || !args.planFile || args.readbackArtifacts.length !== 2
    || !args.liveInventoryBaseline) {
    throw new Error('--journal, --plan, two --readback-artifact values and --live-inventory-baseline are required');
  }
  return args;
}

async function readRegularJson(file, label) {
  const resolved = path.resolve(String(file));
  const stat = await fs.lstat(resolved).catch(error => fail('INVENTORY_MANUAL_RESOLUTION_EVIDENCE_UNAVAILABLE', `${label}:${error.message}`));
  if (!stat.isFile() || stat.isSymbolicLink()) fail('INVENTORY_MANUAL_RESOLUTION_EVIDENCE_INVALID', `${label}:not-a-regular-file`);
  const bytes = await fs.readFile(resolved);
  let json;
  try {
    json = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    fail('INVENTORY_MANUAL_RESOLUTION_EVIDENCE_INVALID', `${label}:invalid-json:${error.message}`);
  }
  return {path: resolved, stat, bytes, sha256: sha256(bytes), json};
}

function objectNodes(document) {
  const nodes = [];
  const visit = (value, ancestors = []) => {
    if (!value || typeof value !== 'object') return;
    const node = {value, ancestors};
    nodes.push(node);
    if (Array.isArray(value)) {
      for (const child of value) visit(child, ancestors);
    } else {
      for (const child of Object.values(value)) visit(child, [value, ...ancestors]);
    }
  };
  visit(document);
  return nodes;
}

function firstScalar(nodes, keys) {
  for (const node of nodes) {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(node, key)
        && (typeof node[key] === 'string' || typeof node[key] === 'number')) return node[key];
    }
  }
  return '';
}

function firstInheritedScalar(record, keys) {
  for (const source of [record.value, ...(record.ancestors || [])]) {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(source, key)
        && (typeof source[key] === 'string' || typeof source[key] === 'number')) return source[key];
    }
  }
  return '';
}

function firstMetric(value, keys) {
  if (!value || typeof value !== 'object') return null;
  const queue = [value];
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
      const number = Number(current[key]);
      if (Number.isSafeInteger(number) && number >= 0) return number;
    }
    if (Array.isArray(current)) queue.push(...current);
    else queue.push(...Object.values(current));
  }
  return null;
}

function extractExactReadback(document, scope, fileMeta) {
  const normalizedScope = normalizeInventoryWriteScope(scope);
  const records = objectNodes(document);
  const candidates = [];
  const skuToSkcs = new Map();
  for (const product of Array.isArray(document?.productList) ? document.productList : []) {
    const skc = text(product?.skcName || product?.skc || product?.skcCode);
    if (!skc) continue;
    for (const sku of Array.isArray(product?.skuCodeList) ? product.skuCodeList : []) {
      const skuCode = text(typeof sku === 'object' ? sku.skuCode || sku.sku : sku);
      if (!skuCode) continue;
      if (!skuToSkcs.has(skuCode)) skuToSkcs.set(skuCode, new Set());
      skuToSkcs.get(skuCode).add(skc);
    }
    for (const sku of Array.isArray(product?.skuInfoList) ? product.skuInfoList : []) {
      const skuCode = text(sku?.skuCode || sku?.sku);
      if (!skuCode) continue;
      if (!skuToSkcs.has(skuCode)) skuToSkcs.set(skuCode, new Set());
      skuToSkcs.get(skuCode).add(skc);
    }
  }
  // Product-cache artifacts keep the SKC association in productList while
  // stockResponses keep the warehouse position under skuList. Bind those two
  // raw structures before the generic recursive reader, otherwise a cache
  // containing many SKCs could accidentally select another SKU's warehouse.
  for (const response of Array.isArray(document?.stockResponses) ? document.stockResponses : []) {
    for (const info of Array.isArray(response?.data?.info) ? response.data.info : []) {
      for (const goods of Array.isArray(info?.goodsInventory) ? info.goodsInventory : []) {
        for (const sku of Array.isArray(goods?.skuList) ? goods.skuList : []) {
          const skuCode = text(sku?.skuCode);
          if (skuCode !== normalizedScope.skuCode) continue;
          const directSkcs = new Set([text(goods?.skc), text(goods?.skcName), ...(skuToSkcs.get(skuCode) || [])].filter(Boolean));
          if (!directSkcs.has(normalizedScope.skc)) continue;
          const warehouseRows = Array.isArray(sku?.warehouseInventoryList) && sku.warehouseInventoryList.length
            ? sku.warehouseInventoryList
            : [{warehouseCode: sku?.warehouseCode || goods?.warehouseCode}];
          for (const warehouse of warehouseRows) {
            if (text(warehouse?.warehouseCode || warehouse?.warehouse_code).toUpperCase() !== normalizedScope.warehouseCode) continue;
            const counts = {
              totalInventoryQuantity: firstMetric(sku, ['totalInventoryQuantity', 'total_inventory_quantity', 'totalInventoryQty', 'total_inventory_qty']),
              totalUsableInventory: firstMetric(sku, ['totalUsableInventory', 'total_usable_inventory', 'usableInventory', 'usable_inventory', 'sellableInventory', 'sellable_inventory']),
              totalLockedQuantity: firstMetric(sku, ['totalLockedQuantity', 'total_locked_quantity', 'lockedInventory', 'locked_inventory']),
              temporaryInventoryQuantity: firstMetric(sku, ['totalTempLockQuantity', 'total_temp_lock_quantity', 'temporaryInventoryQuantity', 'temporary_inventory_quantity', 'tempInventoryQuantity', 'temp_inventory_quantity']),
            };
            if (Object.values(counts).every(value => Number.isSafeInteger(value))) candidates.push({
              candidateScope: normalizedScope,
              counts,
            });
          }
        }
      }
    }
  }
  for (const record of records) {
    const candidateScope = normalizeInventoryWriteScope({
      storeKey: firstInheritedScalar(record, ['storeKey', 'store_key', 'store', 'shopCode']),
      skc: firstInheritedScalar(record, ['skc', 'SKC', 'skcCode', 'skc_code']),
      skuCode: firstInheritedScalar(record, ['skuCode', 'sku_code', 'sku', 'SKU']),
      warehouseCode: firstInheritedScalar(record, ['warehouseCode', 'warehouse_code', 'warehouse', 'warehouseId']),
      invType: firstInheritedScalar(record, ['invType', 'inventoryType', 'inventory_type']) || 'VI',
    });
    if (!candidateScope.storeKey || !candidateScope.skc || !candidateScope.skuCode || !candidateScope.warehouseCode) continue;
    if (candidateScope.storeKey !== normalizedScope.storeKey
      || candidateScope.skc !== normalizedScope.skc
      || candidateScope.skuCode !== normalizedScope.skuCode
      || candidateScope.warehouseCode !== normalizedScope.warehouseCode
      || candidateScope.invType !== normalizedScope.invType) continue;
    const counts = {
      totalInventoryQuantity: firstMetric(record.value, ['totalInventoryQuantity', 'total_inventory_quantity', 'totalInventoryQty', 'total_inventory_qty', 'total']),
      totalUsableInventory: firstMetric(record.value, ['totalUsableInventory', 'total_usable_inventory', 'usableInventory', 'usable_inventory', 'usable', 'sellableInventory', 'sellable_inventory']),
      totalLockedQuantity: firstMetric(record.value, ['totalLockedQuantity', 'total_locked_quantity', 'lockedInventory', 'locked_inventory', 'locked']),
      temporaryInventoryQuantity: firstMetric(record.value, ['totalTempLockQuantity', 'total_temp_lock_quantity', 'temporaryInventoryQuantity', 'temporary_inventory_quantity', 'tempInventoryQuantity', 'temp_inventory_quantity', 'tempInventory', 'temp_inventory', 'temp']),
    };
    if (Object.values(counts).every(value => Number.isSafeInteger(value))) candidates.push({candidateScope, counts});
  }
  if (!candidates.length) fail('INVENTORY_MANUAL_RESOLUTION_EVIDENCE_SCOPE_MISSING', `${fileMeta.path}:exact scope counts not found`);
  const unique = new Map(candidates.map(candidate => [JSON.stringify(candidate.counts), candidate]));
  if (unique.size !== 1) fail('INVENTORY_MANUAL_RESOLUTION_EVIDENCE_SCOPE_AMBIGUOUS', `${fileMeta.path}:exact scope has conflicting count rows`);
  const candidate = candidates[0];
  const allNodes = records.map(record => record.value);
  const code = firstScalar(allNodes, ['code', 'statusCode']);
  const msg = firstScalar(allNodes, ['msg', 'message', 'statusMessage']);
  const traceId = firstScalar(allNodes, ['traceId', 'traceID', 'trace_id', 'requestId', 'request_id']);
  const capturedAt = firstScalar(allNodes, ['startedAt', 'generatedAt', 'capturedAt', 'fetchedAt', 'createdAt', 'endedAt']);
  if (String(code).trim() !== '0' || String(msg).trim().toUpperCase() !== 'OK' || !text(traceId)) {
    fail('INVENTORY_MANUAL_RESOLUTION_EVIDENCE_RESPONSE_INVALID', `${fileMeta.path}:code/msg/trace`);
  }
  if (!isTimestamp(capturedAt)) fail('INVENTORY_MANUAL_RESOLUTION_EVIDENCE_INVALID', `${fileMeta.path}:capturedAt`);
  const normalized = {
    scope: {
      ...candidate.candidateScope,
      scopeKey: inventoryWriteScopeKey(candidate.candidateScope),
    },
    ...candidate.counts,
    code: String(code).trim(),
    msg: String(msg).trim(),
    traceId: String(traceId).trim(),
  };
  const payloadHashCandidate = firstScalar(allNodes, ['payloadHash', 'payload_hash']);
  const payloadHash = isHash(payloadHashCandidate)
    ? String(payloadHashCandidate).toLowerCase()
    : stableInventoryHash(normalized);
  return {
    path: fileMeta.path,
    sha256: fileMeta.sha256,
    bytes: fileMeta.bytes.length,
    capturedAt: String(capturedAt),
    payloadHash,
    ...candidate.counts,
    code: String(code).trim(),
    msg: String(msg).trim(),
    traceId: String(traceId).trim(),
    scope: normalized.scope,
  };
}

function assertKnownEvidence(meta, extracted, expected, index) {
  if (!expected) return;
  if (meta.path !== expected.path) fail('INVENTORY_MANUAL_RESOLUTION_EVIDENCE_CONTRACT_MISMATCH', `artifact=${index + 1}:path`);
  if (meta.sha256 !== expected.sha256) fail('INVENTORY_MANUAL_RESOLUTION_EVIDENCE_CONTRACT_MISMATCH', `artifact=${index + 1}:sha256`);
  if (expected.bytes !== undefined && meta.bytes.length !== expected.bytes) fail('INVENTORY_MANUAL_RESOLUTION_EVIDENCE_CONTRACT_MISMATCH', `artifact=${index + 1}:bytes`);
  if (expected.startedAt && extracted.capturedAt !== expected.startedAt) fail('INVENTORY_MANUAL_RESOLUTION_EVIDENCE_CONTRACT_MISMATCH', `artifact=${index + 1}:startedAt`);
  if (expected.generatedAt && extracted.capturedAt !== expected.generatedAt) fail('INVENTORY_MANUAL_RESOLUTION_EVIDENCE_CONTRACT_MISMATCH', `artifact=${index + 1}:generatedAt`);
  if (expected.payloadHash && extracted.payloadHash !== expected.payloadHash) fail('INVENTORY_MANUAL_RESOLUTION_EVIDENCE_CONTRACT_MISMATCH', `artifact=${index + 1}:payloadHash`);
  if (expected.traceId && extracted.traceId !== expected.traceId) fail('INVENTORY_MANUAL_RESOLUTION_EVIDENCE_CONTRACT_MISMATCH', `artifact=${index + 1}:traceId`);
}

function assertExactReadback(extracted, scope, label) {
  const normalized = normalizeInventoryWriteScope(extracted.scope);
  if (normalized.storeKey !== scope.storeKey || normalized.skc !== scope.skc || normalized.skuCode !== scope.skuCode
    || normalized.warehouseCode !== scope.warehouseCode || normalized.invType !== scope.invType) {
    fail('INVENTORY_MANUAL_RESOLUTION_EVIDENCE_SCOPE_MISMATCH', `${label}:scope`);
  }
  if (extracted.totalInventoryQuantity !== 50 || extracted.totalUsableInventory !== 49
    || extracted.totalLockedQuantity !== 1 || extracted.temporaryInventoryQuantity !== 0) {
    fail('INVENTORY_MANUAL_RESOLUTION_EVIDENCE_BASELINE_MISMATCH', `${label}:expected=50/49/1/0`);
  }
}

const PRODUCTION_BASELINE_KEYS = 'activationHash,activationReceiptHash,bundleSha256,capturedAt,deployedCommit,maintenanceActive,maintenanceGeneration,maintenanceHash,maintenanceMode,releaseReceiptHash,releaseReceiptKind,source,sourceFingerprint,trackedSourceClean,writerServicesHash';

function canonicalLiveInventoryBaseline(input, scope) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVENTORY_MANUAL_RESOLUTION_BASELINE_INVALID', 'object-required');
  const normalizedScope = normalizeInventoryWriteScope(input.scope || {});
  if (normalizedScope.storeKey !== scope.storeKey || normalizedScope.skc !== scope.skc || normalizedScope.skuCode !== scope.skuCode
    || normalizedScope.warehouseCode !== scope.warehouseCode || normalizedScope.invType !== scope.invType) {
    fail('INVENTORY_MANUAL_RESOLUTION_BASELINE_INVALID', 'scope');
  }
  if (!isTimestamp(input.capturedAt) || !text(input.source)) fail('INVENTORY_MANUAL_RESOLUTION_BASELINE_INVALID', 'source/capturedAt');
  const baseline = {
    source: text(input.source),
    capturedAt: text(input.capturedAt),
    scope: {...normalizedScope, scopeKey: inventoryWriteScopeKey(normalizedScope)},
    totalInventoryQuantity: Number(input.totalInventoryQuantity),
    totalUsableInventory: Number(input.totalUsableInventory),
    totalLockedQuantity: Number(input.totalLockedQuantity),
    temporaryInventoryQuantity: Number(input.temporaryInventoryQuantity),
  };
  if (baseline.totalInventoryQuantity !== 50 || baseline.totalUsableInventory !== 49
    || baseline.totalLockedQuantity !== 1 || baseline.temporaryInventoryQuantity !== 0) {
    fail('INVENTORY_MANUAL_RESOLUTION_BASELINE_INVALID', 'expected=50/49/1/0');
  }
  return baseline;
}

async function readLiveInventoryBaseline(input, scope, label) {
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    return canonicalLiveInventoryBaseline(input, scope);
  }
  const meta = await readRegularJson(input, label);
  if (meta.json?.scope && meta.json?.source) return canonicalLiveInventoryBaseline(meta.json, scope);
  const extracted = extractExactReadback(meta.json, scope, meta);
  assertExactReadback(extracted, scope, label);
  return canonicalLiveInventoryBaseline({
    source: `authoritative_readback:${meta.path}#sha256=${meta.sha256}`,
    capturedAt: extracted.capturedAt,
    scope: extracted.scope,
    totalInventoryQuantity: extracted.totalInventoryQuantity,
    totalUsableInventory: extracted.totalUsableInventory,
    totalLockedQuantity: extracted.totalLockedQuantity,
    temporaryInventoryQuantity: extracted.temporaryInventoryQuantity,
  }, scope);
}

function canonicalProductionBaseline(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).sort().join(',') !== PRODUCTION_BASELINE_KEYS) {
    fail('INVENTORY_MANUAL_RESOLUTION_PRODUCTION_BASELINE_INVALID', 'authoritative baseline shape');
  }
  const baseline = {
    activationHash: text(input.activationHash).toLowerCase(),
    activationReceiptHash: text(input.activationReceiptHash).toLowerCase(),
    bundleSha256: text(input.bundleSha256).toLowerCase(),
    capturedAt: text(input.capturedAt),
    deployedCommit: text(input.deployedCommit).toLowerCase(),
    maintenanceActive: input.maintenanceActive,
    maintenanceGeneration: Number(input.maintenanceGeneration),
    maintenanceHash: text(input.maintenanceHash).toLowerCase(),
    maintenanceMode: text(input.maintenanceMode),
    releaseReceiptHash: text(input.releaseReceiptHash).toLowerCase(),
    releaseReceiptKind: text(input.releaseReceiptKind).toLowerCase(),
    source: text(input.source),
    sourceFingerprint: text(input.sourceFingerprint).toLowerCase(),
    trackedSourceClean: input.trackedSourceClean,
    writerServicesHash: text(input.writerServicesHash).toLowerCase(),
  };
  if (!isHash(baseline.activationHash)
    || !isHash(baseline.activationReceiptHash)
    || !isTimestamp(baseline.capturedAt)
    || !/^[a-f0-9]{40}$/.test(baseline.deployedCommit)
    || baseline.trackedSourceClean !== true
    || !isHash(baseline.sourceFingerprint)
    || !['formal', 'emergency'].includes(baseline.releaseReceiptKind)
    || !isHash(baseline.releaseReceiptHash)
    || !isHash(baseline.bundleSha256)
    || !baseline.source
    || !Number.isSafeInteger(baseline.maintenanceGeneration) || baseline.maintenanceGeneration < 1
    || !isHash(baseline.maintenanceHash)
    || baseline.maintenanceActive !== true
    || baseline.maintenanceMode !== 'all'
    || !isHash(baseline.writerServicesHash)) {
    fail('INVENTORY_MANUAL_RESOLUTION_PRODUCTION_BASELINE_INVALID', 'deployment-source-fields');
  }
  return baseline;
}

function productionBaselineFromAuthority(cutover, maintenance) {
  if (!cutover?.activated) {
    fail('INVENTORY_MANUAL_RESOLUTION_READER_FIRST_ACTIVATION_REQUIRED', 'authoritative reader-first activation is absent');
  }
  const authority = cutover.authority;
  return canonicalProductionBaseline({
    activationHash: cutover.activation.activationHash,
    activationReceiptHash: cutover.receipt.receiptHash,
    bundleSha256: authority.bundleSha256,
    capturedAt: cutover.activation.authority.capturedAt,
    deployedCommit: authority.deployedCommit,
    maintenanceActive: maintenance.active,
    maintenanceGeneration: maintenance.generation,
    maintenanceHash: maintenance.hash,
    maintenanceMode: maintenance.mode,
    releaseReceiptHash: authority.releaseReceiptHash,
    releaseReceiptKind: authority.releaseReceiptKind,
    source: 'authoritative_inventory_cutover_activation',
    sourceFingerprint: authority.sourceFingerprint,
    trackedSourceClean: authority.trackedSourceClean,
    writerServicesHash: stableInventoryHash(authority.writerServices),
  });
}

async function journalSnapshots(files) {
  const rows = [];
  for (const file of [...new Set(files.map(value => path.resolve(value)))].sort()) {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) fail('INVENTORY_MANUAL_RESOLUTION_JOURNAL_INVALID', `${file}:not-a-regular-file`);
      const bytes = await fs.readFile(file);
      rows.push({file, exists: true, bytes: bytes.length, sha256: sha256(bytes)});
    } catch (error) {
      if (error?.code === 'ENOENT') rows.push({file, exists: false, bytes: 0, sha256: ''});
      else throw error;
    }
  }
  return rows;
}

function journalSnapshotHash(rows) {
  return stableInventoryHash(rows.map(({file, ...row}) => ({file, ...row})));
}

function findExactIntent(bundle, intentId) {
  const matches = [...bundle.intents.entries()].filter(([, intent]) => intent.intentId === intentId);
  if (matches.length !== 1) fail('INVENTORY_MANUAL_RESOLUTION_INTENT_INVALID', `intentId=${intentId}:count=${matches.length}`);
  return matches[0];
}

function assertExactIntent(intent, requestedScope) {
  if (intent.intentId !== INVENTORY_MANUAL_RESOLUTION_INTENT_ID
    || String(intent.storeKey).toUpperCase() !== 'XL'
    || intent.skc !== EXACT_SCOPE.skc
    || intent.skuCode !== EXACT_SCOPE.skuCode
    || Number(intent.targetUsableInventory) !== 100
    || intent.runDate !== '2026-08-17') {
    fail('INVENTORY_MANUAL_RESOLUTION_INTENT_INVALID', 'exact XL historical intent binding failed');
  }
  if (requestedScope.storeKey !== EXACT_SCOPE.storeKey || requestedScope.skc !== EXACT_SCOPE.skc
    || requestedScope.skuCode !== EXACT_SCOPE.skuCode || requestedScope.warehouseCode !== EXACT_SCOPE.warehouseCode
    || requestedScope.invType !== 'VI') fail('INVENTORY_MANUAL_RESOLUTION_SCOPE_INVALID', 'requested exact scope mismatch');
}

async function readReceipt(file) {
  try {
    const source = await readRegularJson(file, 'receipt');
    return source.json;
  } catch (error) {
    if (error?.code === 'INVENTORY_MANUAL_RESOLUTION_EVIDENCE_UNAVAILABLE' && error.message.includes('ENOENT')) return null;
    throw error;
  }
}

const RECEIPT_KEYS = 'disposition,eventHash,globalJournalSha256After,globalJournalSha256Before,intentId,journalFile,journalFileSha256After,journalFileSha256Before,kind,liveInventoryBaseline,liveInventoryBaselineHash,preflightHash,productionBaseline,productionBaselineHash,receiptHash,recordedAt,resolutionId,schemaVersion,scopeKey,sideEffects';
const SIDE_EFFECT_KEYS = 'historicalLinesModified,sheinPostCount';
const RECEIPT_LIVE_BASELINE_KEYS = 'capturedAt,scope,source,temporaryInventoryQuantity,totalInventoryQuantity,totalLockedQuantity,totalUsableInventory';
const RECEIPT_PRODUCTION_BASELINE_KEYS = 'activationHash,activationReceiptHash,bundleSha256,capturedAt,deployedCommit,maintenanceActive,maintenanceGeneration,maintenanceHash,maintenanceMode,releaseReceiptHash,releaseReceiptKind,source,sourceFingerprint,trackedSourceClean,writerServicesHash';

export function validateManualResolutionReceipt(receipt, {
  eventHash = '',
  intentId = '',
  journalFile = '',
  event = null,
} = {}) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) fail('INVENTORY_MANUAL_RESOLUTION_RECEIPT_INVALID', 'shape');
  if (Object.keys(receipt).sort().join(',') !== RECEIPT_KEYS) fail('INVENTORY_MANUAL_RESOLUTION_RECEIPT_INVALID', 'topLevelKeys');
  if (receipt.schemaVersion !== 'inventory-manual-resolution-receipt/v1' || receipt.kind !== 'manual_resolution_receipt') fail('INVENTORY_MANUAL_RESOLUTION_RECEIPT_INVALID', 'schema');
  if (receipt.disposition !== INVENTORY_MANUAL_RESOLUTION_DISPOSITION || receipt.intentId !== intentId
    || path.resolve(receipt.journalFile) !== path.resolve(journalFile)) fail('INVENTORY_MANUAL_RESOLUTION_RECEIPT_INVALID', 'binding');
  if (eventHash && receipt.eventHash !== eventHash) fail('INVENTORY_MANUAL_RESOLUTION_RECEIPT_INVALID', 'eventHash');
  for (const field of [
    'eventHash',
    'journalFileSha256Before',
    'journalFileSha256After',
    'globalJournalSha256Before',
    'globalJournalSha256After',
    'preflightHash',
    'productionBaselineHash',
    'liveInventoryBaselineHash',
  ]) {
    if (!isHash(receipt[field])) fail('INVENTORY_MANUAL_RESOLUTION_RECEIPT_INVALID', field);
  }
  if (!receipt.productionBaseline || typeof receipt.productionBaseline !== 'object'
    || Array.isArray(receipt.productionBaseline)
    || Object.keys(receipt.productionBaseline).sort().join(',') !== RECEIPT_PRODUCTION_BASELINE_KEYS
    || !receipt.liveInventoryBaseline || typeof receipt.liveInventoryBaseline !== 'object'
    || Array.isArray(receipt.liveInventoryBaseline)
    || Object.keys(receipt.liveInventoryBaseline).sort().join(',') !== RECEIPT_LIVE_BASELINE_KEYS) {
    fail('INVENTORY_MANUAL_RESOLUTION_RECEIPT_INVALID', 'baselineShape');
  }
  if (!isHash(receipt.productionBaseline.activationHash)
    || !isHash(receipt.productionBaseline.activationReceiptHash)
    || !isTimestamp(receipt.productionBaseline.capturedAt)
    || !/^[a-f0-9]{40}$/i.test(text(receipt.productionBaseline.deployedCommit))
    || receipt.productionBaseline.trackedSourceClean !== true
    || !isHash(receipt.productionBaseline.sourceFingerprint)
    || !['formal', 'emergency'].includes(receipt.productionBaseline.releaseReceiptKind)
    || !isHash(receipt.productionBaseline.releaseReceiptHash)
    || !isHash(receipt.productionBaseline.bundleSha256)
    || !text(receipt.productionBaseline.source)
    || !Number.isSafeInteger(receipt.productionBaseline.maintenanceGeneration)
    || receipt.productionBaseline.maintenanceGeneration < 1
    || !isHash(receipt.productionBaseline.maintenanceHash)
    || receipt.productionBaseline.maintenanceActive !== true
    || receipt.productionBaseline.maintenanceMode !== 'all'
    || !isHash(receipt.productionBaseline.writerServicesHash)) {
    fail('INVENTORY_MANUAL_RESOLUTION_RECEIPT_INVALID', 'productionBaseline');
  }
  if (!isTimestamp(receipt.liveInventoryBaseline.capturedAt)
    || !text(receipt.liveInventoryBaseline.source)
    || !Number.isSafeInteger(receipt.liveInventoryBaseline.totalInventoryQuantity)
    || !Number.isSafeInteger(receipt.liveInventoryBaseline.totalUsableInventory)
    || !Number.isSafeInteger(receipt.liveInventoryBaseline.totalLockedQuantity)
    || !Number.isSafeInteger(receipt.liveInventoryBaseline.temporaryInventoryQuantity)
    || receipt.liveInventoryBaseline.totalInventoryQuantity !== 50
    || receipt.liveInventoryBaseline.totalUsableInventory !== 49
    || receipt.liveInventoryBaseline.totalLockedQuantity !== 1
    || receipt.liveInventoryBaseline.temporaryInventoryQuantity !== 0
    || !receipt.liveInventoryBaseline.scope
    || receipt.liveInventoryBaseline.scope.scopeKey !== inventoryWriteScopeKey(receipt.liveInventoryBaseline.scope)) {
    fail('INVENTORY_MANUAL_RESOLUTION_RECEIPT_INVALID', 'liveInventoryBaseline');
  }
  if (receipt.productionBaselineHash !== stableInventoryHash(receipt.productionBaseline)
    || receipt.liveInventoryBaselineHash !== stableInventoryHash(receipt.liveInventoryBaseline)) {
    fail('INVENTORY_MANUAL_RESOLUTION_RECEIPT_INVALID', 'baselineHash');
  }
  if (event) {
    if (receipt.preflightHash !== event.preflightHash
      || receipt.productionBaselineHash !== stableInventoryHash(event.productionBaseline)
      || receipt.liveInventoryBaselineHash !== stableInventoryHash(event.liveInventoryBaseline)
      || stableInventoryHash(receipt.productionBaseline) !== stableInventoryHash(event.productionBaseline)
      || stableInventoryHash(receipt.liveInventoryBaseline) !== stableInventoryHash(event.liveInventoryBaseline)) {
      fail('INVENTORY_MANUAL_RESOLUTION_RECEIPT_INVALID', 'baselineBinding');
    }
  }
  if (!isTimestamp(receipt.recordedAt) || !text(receipt.resolutionId) || !text(receipt.scopeKey)) fail('INVENTORY_MANUAL_RESOLUTION_RECEIPT_INVALID', 'identity');
  if (!receipt.sideEffects || Object.keys(receipt.sideEffects).sort().join(',') !== SIDE_EFFECT_KEYS
    || receipt.sideEffects.sheinPostCount !== 0 || receipt.sideEffects.historicalLinesModified !== 0) {
    fail('INVENTORY_MANUAL_RESOLUTION_RECEIPT_INVALID', 'sideEffects');
  }
  const {receiptHash, ...withoutHash} = receipt;
  if (!isHash(receiptHash) || receiptHash !== stableInventoryHash(withoutHash)) fail('INVENTORY_MANUAL_RESOLUTION_RECEIPT_INVALID', 'receiptHash');
  return true;
}

async function fsyncReceiptParentDirectory(file) {
  if (process.platform === 'win32') return;
  const directory = await fs.open(path.dirname(file), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function writeManualResolutionReceiptAtomic(file, receipt, {
  afterRenameHook,
  parentDirectorySync = fsyncReceiptParentDirectory,
} = {}) {
  const resolved = path.resolve(file);
  const existing = await fs.lstat(resolved).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing) fail('INVENTORY_MANUAL_RESOLUTION_RECEIPT_CONFLICT', `${resolved}:already-exists`);
  await fs.mkdir(path.dirname(resolved), {recursive: true});
  const temporary = `${resolved}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, resolved);
  if (afterRenameHook) await afterRenameHook({file: resolved, temporary});
  await parentDirectorySync(resolved);
  return resolved;
}

function buildReceipt({event, eventHash, beforeRows, afterRows}) {
  const core = {
    schemaVersion: 'inventory-manual-resolution-receipt/v1',
    kind: 'manual_resolution_receipt',
    disposition: INVENTORY_MANUAL_RESOLUTION_DISPOSITION,
    resolutionId: event.resolutionId,
    intentId: event.intentId,
    scopeKey: event.scope.scopeKey,
    eventHash,
    productionBaseline: event.productionBaseline,
    preflightHash: event.preflightHash,
    productionBaselineHash: stableInventoryHash(event.productionBaseline),
    liveInventoryBaseline: event.liveInventoryBaseline,
    liveInventoryBaselineHash: stableInventoryHash(event.liveInventoryBaseline),
    journalFile: event.journalFile,
    journalFileSha256Before: event.journalFileSha256,
    journalFileSha256After: afterRows.find(row => row.file === event.journalFile)?.sha256 || '',
    globalJournalSha256Before: event.globalJournalSha256,
    globalJournalSha256After: journalSnapshotHash(afterRows),
    sideEffects: {sheinPostCount: 0, historicalLinesModified: 0},
    recordedAt: event.recordedAt,
  };
  if (!core.journalFileSha256After || !beforeRows.length) fail('INVENTORY_MANUAL_RESOLUTION_RECEIPT_INVALID', 'journal readback hash');
  return {...core, receiptHash: stableInventoryHash(core)};
}

export async function resolveManualInventoryIntent({
  mode = 'dry-run',
  expectedPreflightHash = '',
  journalFile,
  planFile,
  readbackArtifacts = [],
  liveInventoryBaseline,
  warehouseCode = EXACT_SCOPE.warehouseCode,
  ownerActor,
  ownerConfirmation,
  originalResponse = {},
  receiptFile,
  lockFile,
  activationFile = '',
  activationReceiptFile = '',
  maintenanceFile = '',
  cutoverReader = requireCurrentInventoryCutoverActivation,
  maintenanceReader,
  additionalJournalDirectories = [],
  now = new Date().toISOString(),
  intentId = INVENTORY_MANUAL_RESOLUTION_INTENT_ID,
  requireKnownEvidence = true,
  evidenceContract = MANUAL_READBACK_EVIDENCE_CONTRACT,
  beforeAppendHook,
  receiptWriteOptions,
} = {}) {
  const selectedMode = text(mode).toLowerCase() || 'dry-run';
  if (selectedMode !== 'dry-run' && selectedMode !== 'execute') {
    fail('INVENTORY_MANUAL_RESOLUTION_MODE_INVALID', `mode=${selectedMode}`);
  }
  const expectedHash = text(expectedPreflightHash).toLowerCase();
  if (selectedMode === 'execute') {
    if (!isHash(expectedHash)) fail('INVENTORY_MANUAL_RESOLUTION_EXPECTED_PREFLIGHT_HASH_REQUIRED', 'exact 64-hex expected hash required');
  }
  const targetJournal = path.resolve(String(journalFile || ''));
  const targetPlan = path.resolve(String(planFile || ''));
  if (!journalFile || !planFile || readbackArtifacts.length !== 2 || !liveInventoryBaseline) {
    fail('INVENTORY_MANUAL_RESOLUTION_INPUT_INVALID', 'journal/plan/two-artifacts/live-inventory-baseline required');
  }
  if (!isTimestamp(now)) fail('INVENTORY_MANUAL_RESOLUTION_INPUT_INVALID', 'now');
  const scope = normalizeInventoryWriteScope({...EXACT_SCOPE, warehouseCode});
  if (scope.warehouseCode !== EXACT_SCOPE.warehouseCode) fail('INVENTORY_MANUAL_RESOLUTION_SCOPE_INVALID', 'warehouseCode');
  if (text(ownerConfirmation) !== INVENTORY_MANUAL_RESOLUTION_OWNER_CONFIRMATION) fail('INVENTORY_MANUAL_RESOLUTION_OWNER_CONFIRMATION_REQUIRED', 'exact confirmation required');
  if (!text(ownerActor)) fail('INVENTORY_MANUAL_RESOLUTION_OWNER_CONFIRMATION_REQUIRED', 'owner actor required');
  const canonicalOwnerConfirmation = {actor: text(ownerActor), confirmed: true, statement: INVENTORY_MANUAL_RESOLUTION_OWNER_CONFIRMATION};
  const response = {
    code: originalResponse.code === undefined ? '' : String(originalResponse.code).trim(),
    traceId: text(originalResponse.traceId),
  };
  if (response.code !== '0' || !response.traceId) fail('INVENTORY_MANUAL_RESOLUTION_ORIGINAL_RESPONSE_INVALID', 'top-level code=0 and traceId required');
  let planMeta = await readRegularJson(targetPlan, 'plan');
  const planHash = text(planMeta.json?.payloadHash).toLowerCase();
  if (!isHash(planHash)) fail('INVENTORY_MANUAL_RESOLUTION_PLAN_INVALID', 'payloadHash');
  const cutoverOptions = {
    ...(activationFile ? {activationFile} : {}),
    ...(activationReceiptFile ? {activationReceiptFile} : {}),
  };
  const readAuthoritativeBaseline = async phase => {
    const cutover = await cutoverReader({...cutoverOptions, phase});
    if (!cutover?.activated) {
      fail('INVENTORY_MANUAL_RESOLUTION_READER_FIRST_ACTIVATION_REQUIRED', `activation absent:${phase}`);
    }
    const required = cutover.activation?.requiredManualResolution;
    const expectedReceiptFile = path.resolve(receiptFile || `${targetJournal}.manual-resolution-${intentId}.receipt.json`);
    if (required?.intentId !== intentId
      || required?.scopeKey !== inventoryWriteScopeKey(scope)
      || path.resolve(required?.journalFile || '') !== targetJournal
      || path.resolve(required?.receiptFile || '') !== expectedReceiptFile) {
      fail('INVENTORY_MANUAL_RESOLUTION_READER_FIRST_ACTIVATION_INVALID', `target binding drift:${phase}`);
    }
    const maintenance = await requireInventoryCutoverMaintenanceAll({
      ...(maintenanceFile ? {maintenanceFile} : {}),
      ...(maintenanceReader ? {maintenanceReader} : {}),
    });
    return {cutover, maintenance, baseline: productionBaselineFromAuthority(cutover, maintenance)};
  };
  let authorityState = await readAuthoritativeBaseline('initial');
  let baseline = authorityState.baseline;
  let liveBaseline = await readLiveInventoryBaseline(liveInventoryBaseline, scope, 'live inventory baseline');
  let extractedArtifacts = [];
  for (let index = 0; index < readbackArtifacts.length; index += 1) {
    const meta = await readRegularJson(readbackArtifacts[index], `readback artifact ${index + 1}`);
    const extracted = extractExactReadback(meta.json, scope, meta);
    assertExactReadback(extracted, scope, `readback artifact ${index + 1}`);
    if (requireKnownEvidence) assertKnownEvidence(meta, extracted, evidenceContract[index], index);
    extractedArtifacts.push(extracted);
  }
  if (new Set(extractedArtifacts.map(row => row.path)).size !== 2
    || new Set(extractedArtifacts.map(row => row.sha256)).size !== 2) {
    fail('INVENTORY_MANUAL_RESOLUTION_EVIDENCE_INVALID', 'two independent artifact paths and hashes required');
  }
  const rereadBoundInputs = async phase => {
    const freshPlan = await readRegularJson(targetPlan, `plan:${phase}`);
    const freshPlanHash = text(freshPlan.json?.payloadHash).toLowerCase();
    if (freshPlan.sha256 !== planMeta.sha256 || freshPlanHash !== planHash) {
      fail('INVENTORY_MANUAL_RESOLUTION_CAS_CONFLICT', `plan hash drift:${phase}`);
    }
    const freshArtifacts = [];
    for (let index = 0; index < readbackArtifacts.length; index += 1) {
      const meta = await readRegularJson(readbackArtifacts[index], `readback artifact ${index + 1}:${phase}`);
      if (meta.sha256 !== extractedArtifacts[index].sha256 || meta.bytes.length !== extractedArtifacts[index].bytes) {
        fail('INVENTORY_MANUAL_RESOLUTION_CAS_CONFLICT', `readback artifact hash drift:${index + 1}:${phase}`);
      }
      const extracted = extractExactReadback(meta.json, scope, meta);
      assertExactReadback(extracted, scope, `readback artifact ${index + 1}:${phase}`);
      if (requireKnownEvidence) assertKnownEvidence(meta, extracted, evidenceContract[index], index);
      freshArtifacts.push(extracted);
    }
    if (stableInventoryHash(freshArtifacts) !== stableInventoryHash(extractedArtifacts)) {
      fail('INVENTORY_MANUAL_RESOLUTION_CAS_CONFLICT', `readback artifact content drift:${phase}`);
    }
    const freshAuthorityState = await readAuthoritativeBaseline(`bound-input:${phase}`);
    const freshBaseline = freshAuthorityState.baseline;
    if (stableInventoryHash(freshBaseline) !== stableInventoryHash(baseline)) {
      fail('INVENTORY_MANUAL_RESOLUTION_CAS_CONFLICT', `production baseline drift:${phase}`);
    }
    const freshLiveBaseline = await readLiveInventoryBaseline(
      liveInventoryBaseline, scope, `live inventory baseline:${phase}`,
    );
    if (stableInventoryHash(freshLiveBaseline) !== stableInventoryHash(liveBaseline)) {
      fail('INVENTORY_MANUAL_RESOLUTION_CAS_CONFLICT', `live inventory baseline drift:${phase}`);
    }
    return {
      planMeta: freshPlan,
      artifacts: freshArtifacts,
      productionBaseline: freshBaseline,
      liveInventoryBaseline: freshLiveBaseline,
      authorityState: freshAuthorityState,
    };
  };
  const readFreshJournalState = async phase => {
    const journalFiles = await discoverInventoryJournalFiles(targetJournal, {
      includeAll: true,
      additionalDirectories: inventoryJournalDirectories(additionalJournalDirectories),
    });
    if (!journalFiles.length || !journalFiles.includes(targetJournal)) {
      fail('INVENTORY_MANUAL_RESOLUTION_DOMAIN_INVALID', `full journal domain is empty or omits target:${phase}`);
    }
    const beforeRows = await journalSnapshots(journalFiles);
    const beforeGlobalHash = journalSnapshotHash(beforeRows);
    const beforeBundle = await readInventoryIntentJournals(journalFiles, {allowMultiplePendingByScope: true});
    const afterReadRows = await journalSnapshots(journalFiles);
    if (journalSnapshotHash(afterReadRows) !== beforeGlobalHash) {
      fail('INVENTORY_MANUAL_RESOLUTION_CAS_CONFLICT', `journal changed during fresh reread:${phase}`);
    }
    return {journalFiles, beforeRows, beforeGlobalHash, beforeBundle};
  };
  const buildEvent = ({journalFiles, beforeRows, beforeGlobalHash, beforeBundle}) => {
    const [intentKey, intent] = findExactIntent(beforeBundle, intentId);
    assertExactIntent(intent, scope);
    if (intent.planHash !== planHash) fail('INVENTORY_MANUAL_RESOLUTION_PLAN_INVALID', `planHash=${planHash}:intent=${intent.planHash}`);
    if (beforeBundle.terminalOutcomes.has(intentKey)) {
      fail('INVENTORY_MANUAL_RESOLUTION_INTENT_INVALID', 'intent already has write_outcome; manual resolution cannot masquerade as terminal outcome');
    }
    if (!beforeBundle.pending.has(intentKey)) {
      fail('INVENTORY_MANUAL_RESOLUTION_INTENT_INVALID', 'intent is not pending');
    }
    const intentRecordedAt = new Date(intent.recordedAt).getTime();
    const resolutionAt = new Date(now).getTime();
    if (!Number.isFinite(intentRecordedAt) || resolutionAt < intentRecordedAt) fail('INVENTORY_MANUAL_RESOLUTION_INPUT_INVALID', 'age');
    const event = buildManualResolutionEntry({
      resolutionId: crypto.randomUUID(),
      intent,
      journalFile: targetJournal,
      journalFileSha256: beforeRows.find(row => row.file === targetJournal)?.sha256 || '',
      globalJournalSha256: beforeGlobalHash,
      planFile: targetPlan,
      planFileSha256: planMeta.sha256,
      scope,
      ageSeconds: Math.floor((resolutionAt - intentRecordedAt) / 1000),
      productionBaseline: baseline,
      liveInventoryBaseline: liveBaseline,
      ownerConfirmation: canonicalOwnerConfirmation,
      readbackArtifacts: extractedArtifacts,
      originalResponse: response,
      historicalScope: HISTORICAL_SCOPE,
      recordedAt: now,
    });
    validateManualResolutionEntry(event, intent, {journalFile: targetJournal, lineNumber: 0});
    return {event, intentKey, intent, journalFiles};
  };

  if (selectedMode === 'dry-run') {
    const dryRunState = await readFreshJournalState('dry-run');
    const freshBoundInputs = await rereadBoundInputs('dry-run');
    planMeta = freshBoundInputs.planMeta;
    extractedArtifacts = freshBoundInputs.artifacts;
    baseline = freshBoundInputs.productionBaseline;
    liveBaseline = freshBoundInputs.liveInventoryBaseline;
    const [intentKey, intent] = findExactIntent(dryRunState.beforeBundle, intentId);
    assertExactIntent(intent, scope);
    if (intent.planHash !== planHash) fail('INVENTORY_MANUAL_RESOLUTION_PLAN_INVALID', `planHash=${planHash}:intent=${intent.planHash}`);
    const dryRunReceiptFile = path.resolve(receiptFile || `${targetJournal}.manual-resolution-${intentId}.receipt.json`);
    const existingManual = dryRunState.beforeBundle.manualResolutions.get(intentKey);
    if (existingManual) {
      validateManualResolutionEntry(existingManual, intent, {journalFile: targetJournal, lineNumber: 0});
      const currentReceipt = await readReceipt(dryRunReceiptFile);
      if (currentReceipt) {
        validateManualResolutionReceipt(currentReceipt, {
          eventHash: stableInventoryHash(existingManual),
          intentId,
          journalFile: targetJournal,
          event: existingManual,
        });
      }
      if (expectedHash && expectedHash !== existingManual.preflightHash) {
        fail('INVENTORY_MANUAL_RESOLUTION_PREFLIGHT_HASH_MISMATCH', 'existing manual resolution hash mismatch');
      }
      return {
        state: 'dry_run_existing',
        mode: 'dry-run',
        event: existingManual,
        preflightHash: existingManual.preflightHash,
        receipt: currentReceipt,
        journalFile: targetJournal,
        receiptFile: dryRunReceiptFile,
        sheinPostCount: 0,
      };
    }
    if (dryRunState.beforeBundle.terminalOutcomes.has(intentKey)) {
      fail('INVENTORY_MANUAL_RESOLUTION_INTENT_INVALID', 'intent already has write_outcome; manual resolution cannot masquerade as terminal outcome');
    }
    if (!dryRunState.beforeBundle.pending.has(intentKey)) fail('INVENTORY_MANUAL_RESOLUTION_INTENT_INVALID', 'intent is not pending');
    const event = buildManualResolutionEntry({
      resolutionId: crypto.randomUUID(),
      intent,
      journalFile: targetJournal,
      journalFileSha256: dryRunState.beforeRows.find(row => row.file === targetJournal)?.sha256 || '',
      globalJournalSha256: dryRunState.beforeGlobalHash,
      planFile: targetPlan,
      planFileSha256: planMeta.sha256,
      scope,
      ageSeconds: Math.floor((new Date(now).getTime() - new Date(intent.recordedAt).getTime()) / 1000),
      productionBaseline: baseline,
      liveInventoryBaseline: liveBaseline,
      ownerConfirmation: canonicalOwnerConfirmation,
      readbackArtifacts: extractedArtifacts,
      originalResponse: response,
      historicalScope: HISTORICAL_SCOPE,
      recordedAt: now,
    });
    validateManualResolutionEntry(event, intent, {journalFile: targetJournal, lineNumber: 0});
    return {
      state: 'dry_run',
      mode: 'dry-run',
      event,
      preflightHash: event.preflightHash,
      receipt: null,
      journalFile: targetJournal,
      receiptFile: dryRunReceiptFile,
      sheinPostCount: 0,
    };
  }

  const globalLockFile = lockFile || inventoryCutoverLockFile();
  return withInventoryCutoverLock(async () => {
    const freshJournalState = await readFreshJournalState('under-lock');
    const {journalFiles, beforeRows, beforeGlobalHash, beforeBundle} = freshJournalState;
    const freshBoundInputs = await rereadBoundInputs('under-lock');
    planMeta = freshBoundInputs.planMeta;
    extractedArtifacts = freshBoundInputs.artifacts;
    baseline = freshBoundInputs.productionBaseline;
    liveBaseline = freshBoundInputs.liveInventoryBaseline;
    const [intentKey, intent] = findExactIntent(beforeBundle, intentId);
    assertExactIntent(intent, scope);
    if (intent.planHash !== planHash) fail('INVENTORY_MANUAL_RESOLUTION_PLAN_INVALID', `planHash=${planHash}:intent=${intent.planHash}`);
    const existingManual = beforeBundle.manualResolutions.get(intentKey);
    const existingReceiptFile = path.resolve(receiptFile || `${targetJournal}.manual-resolution-${intentId}.receipt.json`);
    if (existingManual) {
      validateManualResolutionEntry(existingManual, intent, {journalFile: targetJournal, lineNumber: 0});
      if (stableInventoryHash(existingManual.productionBaseline) !== stableInventoryHash(baseline)
        || stableInventoryHash(existingManual.liveInventoryBaseline) !== stableInventoryHash(liveBaseline)) {
        fail('INVENTORY_MANUAL_RESOLUTION_PREFLIGHT_HASH_MISMATCH', 'current deployment or live baseline differs from resolved event');
      }
      if (existingManual.preflightHash !== expectedHash) {
        fail('INVENTORY_MANUAL_RESOLUTION_PREFLIGHT_HASH_MISMATCH', 'expected hash differs from resolved event');
      }
      const currentReceipt = await readReceipt(existingReceiptFile);
      if (currentReceipt) {
        validateManualResolutionReceipt(currentReceipt, {
          eventHash: stableInventoryHash(existingManual),
          intentId,
          journalFile: targetJournal,
          event: existingManual,
        });
        return {
          state: 'already_resolved',
          mode: 'execute',
          event: existingManual,
          preflightHash: existingManual.preflightHash,
          receipt: currentReceipt,
          journalFile: targetJournal,
          receiptFile: existingReceiptFile,
          sheinPostCount: 0,
        };
      }
      const currentRows = await journalSnapshots(journalFiles);
      const receipt = buildReceipt({event: existingManual, eventHash: stableInventoryHash(existingManual), beforeRows, afterRows: currentRows});
      validateManualResolutionReceipt(receipt, {
        eventHash: stableInventoryHash(existingManual),
        intentId,
        journalFile: targetJournal,
        event: existingManual,
      });
      await writeManualResolutionReceiptAtomic(existingReceiptFile, receipt, receiptWriteOptions);
      return {
        state: 'receipt_recovered',
        mode: 'execute',
        event: existingManual,
        preflightHash: existingManual.preflightHash,
        receipt,
        journalFile: targetJournal,
        receiptFile: existingReceiptFile,
        sheinPostCount: 0,
      };
    }
    const {event} = buildEvent(freshJournalState);
    if (event.preflightHash !== expectedHash) {
      fail('INVENTORY_MANUAL_RESOLUTION_PREFLIGHT_HASH_MISMATCH', 'fresh preflight differs from expected hash');
    }
    validateManualResolutionEntry(event, intent, {journalFile: targetJournal, lineNumber: 0});
    await beforeAppendHook?.({event, journalFiles, bundle: beforeBundle});
    const preAppendBoundInputs = await rereadBoundInputs('before-append');
    if (manualResolutionPreflightHash({
      ...event,
      productionBaseline: preAppendBoundInputs.productionBaseline,
      liveInventoryBaseline: preAppendBoundInputs.liveInventoryBaseline,
    }) !== expectedHash) {
      fail('INVENTORY_MANUAL_RESOLUTION_PREFLIGHT_HASH_MISMATCH', 'bound baseline drifted before append');
    }
    const preAppendState = await readFreshJournalState('before-append-cas');
    if (stableInventoryHash(preAppendState.journalFiles) !== stableInventoryHash(journalFiles)
      || preAppendState.beforeGlobalHash !== beforeGlobalHash) {
      fail('INVENTORY_MANUAL_RESOLUTION_CAS_CONFLICT', 'journal domain membership or hash changed before append');
    }
    const preAppendBundle = preAppendState.beforeBundle;
    if (!preAppendBundle.pending.has(intentKey) || preAppendBundle.manualResolutions.has(intentKey)) fail('INVENTORY_MANUAL_RESOLUTION_CAS_CONFLICT', 'intent lifecycle changed before append');
    await appendManualResolutionRecord(targetJournal, event);
    const postJournalFiles = await discoverInventoryJournalFiles(targetJournal, {
      includeAll: true,
      additionalDirectories: inventoryJournalDirectories(additionalJournalDirectories),
    });
    if (stableInventoryHash(postJournalFiles) !== stableInventoryHash(journalFiles)) {
      fail('INVENTORY_MANUAL_RESOLUTION_CAS_CONFLICT', 'journal domain membership changed during append');
    }
    const postRows = await journalSnapshots(postJournalFiles);
    const postBundle = await readInventoryIntentJournals(postJournalFiles, {allowMultiplePendingByScope: true});
    const postManual = postBundle.manualResolutions.get(intentKey);
    if (!postManual) fail('INVENTORY_MANUAL_RESOLUTION_READBACK_FAILED', 'manual resolution is absent after append');
    if (postBundle.pending.has(intentKey) || postBundle.terminalOutcomes.has(intentKey)) fail('INVENTORY_MANUAL_RESOLUTION_READBACK_FAILED', 'pending/terminal lifecycle was not fenced exactly');
    const fence = findInventoryWriteFence(postBundle, {scope, idempotencyKey: intent.idempotencyKey});
    if (!fence || fence.reason !== 'idempotency_key_tombstoned') fail('INVENTORY_MANUAL_RESOLUTION_READBACK_FAILED', 'old idempotency key was not tombstoned');
    const eventHash = stableInventoryHash(postManual);
    const receipt = buildReceipt({event: postManual, eventHash, beforeRows, afterRows: postRows});
    validateManualResolutionReceipt(receipt, {eventHash, intentId, journalFile: targetJournal, event: postManual});
    const writtenReceiptFile = receiptFile ? path.resolve(receiptFile) : `${targetJournal}.manual-resolution-${intentId}.receipt.json`;
    await writeManualResolutionReceiptAtomic(writtenReceiptFile, receipt, receiptWriteOptions);
    return {
      state: 'resolved',
      mode: 'execute',
      event: postManual,
      preflightHash: postManual.preflightHash,
      receipt,
      journalFile: targetJournal,
      receiptFile: writtenReceiptFile,
      sheinPostCount: 0,
    };
  }, {
    lockFile: globalLockFile,
    timeoutMs: 60_000,
    staleMs: 20 * 60_000,
    timeoutCode: 'INVENTORY_MANUAL_RESOLUTION_LOCK_TIMEOUT',
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await resolveManualInventoryIntent({
      mode: args.mode,
      expectedPreflightHash: args.expectedPreflightHash,
      journalFile: args.journalFile,
      planFile: args.planFile,
      readbackArtifacts: args.readbackArtifacts,
      liveInventoryBaseline: args.liveInventoryBaseline,
      warehouseCode: args.warehouseCode,
      ownerActor: args.ownerActor,
      ownerConfirmation: args.ownerConfirmation,
      originalResponse: {code: '0', traceId: args.originalTraceId},
      receiptFile: args.receiptFile,
      lockFile: args.lockFile,
      activationFile: args.activationFile,
      activationReceiptFile: args.activationReceiptFile,
      maintenanceFile: args.maintenanceFile,
      additionalJournalDirectories: args.additionalJournalDirectories,
      now: args.now,
    });
    console.log(JSON.stringify({
      ok: true,
      mode: result.mode,
      state: result.state,
      preflightHash: result.preflightHash,
      event: result.event,
      intentId: result.event.intentId,
      disposition: result.event.disposition,
      scopeKey: result.event.scope.scopeKey,
      journalFile: result.journalFile,
      receiptFile: result.receiptFile,
      sheinPostCount: 0,
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ok: false, code: error.code || 'INVENTORY_MANUAL_RESOLUTION_FAILED', error: error.message}, null, 2));
    process.exitCode = 1;
  }
}
