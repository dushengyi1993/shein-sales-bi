import fs from 'node:fs/promises';
import path from 'node:path';
import {
  computeInventoryOverwriteQuantity,
  computeLegacyInventoryOverwriteQuantity,
  INVENTORY_LEGACY_UNVERSIONED_CUTOFF_DATE,
  INVENTORY_OVERWRITE_COMPUTATION_VERSION,
  stableInventoryHash,
} from './inventory_replenishment_policy.mjs';
import {inventoryCutoverLockFile, withInventoryCutoverLock} from './inventory_write_cutover.mjs';

const INVENTORY_JOURNAL_FILE_RE = /^daily-inventory-replenishment-(\d{4}-\d{2}-\d{2})\.json\.journal\.ndjson$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP_WITH_ZONE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const INVENTORY_JOURNAL_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const INVENTORY_MANUAL_RESOLUTION_SCHEMA_VERSION = 'inventory-manual-resolution/v1';
export const INVENTORY_MANUAL_RESOLUTION_KIND = 'manual_resolution';
export const INVENTORY_MANUAL_RESOLUTION_DISPOSITION = 'manual_baseline_adopted_effect_unknown';
export const INVENTORY_MANUAL_RESOLUTION_OWNER_CONFIRMATION = 'MANUAL_BASELINE_ADOPTED_EFFECT_UNKNOWN';
export const INVENTORY_MANUAL_RESOLUTION_INTENT_ID = 'e07f999c-96b2-460c-bfa9-fa924f410ec3';
// Reader-first compatibility contract: producers from the pre-resolution
// phase may continue to append intent/write_outcome/result lines, but the
// generic append path can never emit this schema. Readers that do not know
// this version must reject the line rather than silently treating it as an
// ordinary result.
export const INVENTORY_MANUAL_RESOLUTION_SCHEMA_COMPATIBILITY = Object.freeze({
  schemaVersion: INVENTORY_MANUAL_RESOLUTION_SCHEMA_VERSION,
  producerGate: 'controlled-resolver-only',
  readerGate: 'unknown-schema-fail-closed',
});
export const INVENTORY_MAINTENANCE_WRITE_PROFILE = 'link_ops_maintenance_inventory/v1';
const INVENTORY_CHANGE_REASONS = new Set([
  'Owner-authorized daily inventory target after current-day ET and sales/exposure guard',
  'Owner-authorized ET low-inventory safety reduction after current-day ET guard',
]);
const LEGACY_INVENTORY_AUDIT_KEYS = 'planHash,recordedAt,row,sequence';
const LEGACY_INVENTORY_UPDATED_ROW_KEYS = 'after,before,canonical,skc,skuCode,state,storeKey,writes';
const LEGACY_INVENTORY_BLOCKED_ROW_KEYS = 'canonical,error,skc,skuCode,state,storeKey';
const INVENTORY_READBACK_OUTCOME_KEYS = 'disposition,intentId,kind,logicalActionKey,recordedAt';
const INVENTORY_REJECTED_OUTCOME_KEYS = 'code,disposition,httpOk,httpStatus,intentId,kind,logicalActionKey,recordedAt,success';
const INVENTORY_SUPERSEDE_OUTCOME_KEYS = 'disposition,intentId,kind,logicalActionKey,recordedAt,supersededByIntentId,supersededByRecordedAt,supersededByRunDate';
const INVENTORY_OWNER_CONFIRMED_SAME_TARGET_SUPERSEDE_OUTCOME_KEYS = 'disposition,freshUsableInventory,intentId,kind,logicalActionKey,newRunDate,oldRunDate,originalEffectUnknown,ownerConfirmationText,recordedAt,targetUsableInventory';
export const INVENTORY_OWNER_CONFIRMED_SAME_TARGET_SUPERSEDE_DISPOSITION = 'superseded_by_owner_confirmed_same_target';
const INVENTORY_TERMINAL_DISPOSITIONS = new Set([
  'rejected',
  'readback_matched',
  'superseded_by_later_readback',
  INVENTORY_OWNER_CONFIRMED_SAME_TARGET_SUPERSEDE_DISPOSITION,
]);
const MANUAL_RESOLUTION_SCOPE_KEYS = 'invType,scopeKey,skc,skuCode,storeKey,warehouseCode';
const MANUAL_RESOLUTION_ARTIFACT_KEYS = 'bytes,capturedAt,code,msg,path,payloadHash,scope,sha256,temporaryInventoryQuantity,totalInventoryQuantity,totalLockedQuantity,totalUsableInventory,traceId';
const MANUAL_RESOLUTION_LIVE_BASELINE_KEYS = 'capturedAt,scope,source,temporaryInventoryQuantity,totalInventoryQuantity,totalLockedQuantity,totalUsableInventory';
const MANUAL_RESOLUTION_PRODUCTION_BASELINE_KEYS = 'activationHash,activationReceiptHash,bundleSha256,capturedAt,deployedCommit,maintenanceActive,maintenanceGeneration,maintenanceHash,maintenanceMode,releaseReceiptHash,releaseReceiptKind,source,sourceFingerprint,trackedSourceClean,writerServicesHash';
const MANUAL_RESOLUTION_OWNER_KEYS = 'actor,confirmed,statement';
const MANUAL_RESOLUTION_HISTORICAL_KEYS = 'maxUsableInventory,noUsableInventory,totalInventoryQuantity';
const MANUAL_RESOLUTION_KEYS = 'ageSeconds,disposition,globalJournalSha256,historicalScope,idempotencyKey,intentHash,intentId,journalFile,journalFileSha256,kind,liveInventoryBaseline,logicalActionKey,originalRequestPayloadHash,originalResponse,ownerConfirmation,planFile,planFileSha256,planHash,preflightHash,productionBaseline,readbackArtifacts,recordedAt,resolutionId,runDate,schemaVersion,scope,skc,skuCode,storeKey,targetUsableInventory,warehouseCode';

function normalizedScopeValue(value, {upper = false} = {}) {
  const text = String(value ?? '').trim();
  return upper ? text.toUpperCase() : text;
}

export function normalizeInventoryWriteScope(scope = {}) {
  return {
    storeKey: normalizedScopeValue(scope.storeKey ?? scope.store, {upper: true}),
    skc: normalizedScopeValue(scope.skc),
    skuCode: normalizedScopeValue(scope.skuCode ?? scope.sku),
    warehouseCode: normalizedScopeValue(scope.warehouseCode ?? scope.warehouse, {upper: true}),
    invType: normalizedScopeValue(scope.invType || 'VI', {upper: true}),
  };
}

export function inventoryWriteScopeKey(scope = {}) {
  const normalized = normalizeInventoryWriteScope(scope);
  return stableInventoryHash({
    store: normalized.storeKey,
    skc: normalized.skc,
    sku: normalized.skuCode,
    warehouse: normalized.warehouseCode,
    actionType: 'VI_OVERWRITE_TO_EXACT_USABLE_TARGET',
    invType: normalized.invType,
  });
}

function legacyInventoryIntentScopeKey({storeKey, skc, skuCode} = {}) {
  return stableInventoryHash({
    store: normalizedScopeValue(storeKey, {upper: true}),
    skc: normalizedScopeValue(skc),
    sku: normalizedScopeValue(skuCode),
    actionType: 'VI_OVERWRITE_TO_EXACT_USABLE_TARGET',
    invType: 'VI',
  });
}

export function inventoryScopeFromIntent(intent = {}) {
  const requestRow = intent?.request?.body?.updateSkuInventoryQuantityRequests?.[0] || {};
  return normalizeInventoryWriteScope({
    storeKey: intent.storeKey,
    skc: intent.skc,
    skuCode: intent.skuCode,
    warehouseCode: intent.warehouseCode ?? requestRow.warehouseCode,
    invType: intent.invType ?? requestRow.invType ?? 'VI',
  });
}

// readInventoryIntentJournals decorates raw intent objects with the source
// journal path/date. Those reader-derived fields are not part of the durable
// producer line and must not make a manual-resolution hash differ between the
// pre-append aggregate and the post-append lifecycle reread.
export function inventoryIntentHash(intent = {}) {
  const {journalFile: _journalFile, journalDate: _journalDate, ...rawIntent} = intent || {};
  return stableInventoryHash(rawIntent);
}

function isValidIsoDate(value) {
  if (!ISO_DATE_RE.test(String(value || ''))) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isValidTimestamp(value) {
  const text = String(value || '');
  if (!ISO_TIMESTAMP_WITH_ZONE_RE.test(text)) return false;
  // Validate the original local calendar date before parsing the offset; a
  // UTC-normalized date can legitimately cross a day boundary.
  if (!isValidIsoDate(text.slice(0, 10))) return false;
  const timestamp = new Date(text).getTime();
  return Number.isFinite(timestamp) && timestamp <= Date.now() + INVENTORY_JOURNAL_MAX_FUTURE_SKEW_MS;
}

export function inventoryIntentScopeKey({storeKey, skc, skuCode} = {}) {
  return legacyInventoryIntentScopeKey({storeKey, skc, skuCode});
}

// Kept for validating journals written before the cross-day repair. Those
// records included runDate in the recovery key, while the durable identity
// scope itself is date-independent.
export function legacyInventoryRecoveryScopeKey({runDate, storeKey, skc, skuCode} = {}) {
  return stableInventoryHash({
    runDate: String(runDate || ''),
    store: String(storeKey || ''),
    skc: String(skc || ''),
    sku: String(skuCode || ''),
    actionType: 'VI_OVERWRITE_TO_EXACT_USABLE_TARGET',
    invType: 'VI',
  });
}

// The public recovery-scope helper now represents the durable item identity,
// not the wall-clock run. Keep accepting runDate in the argument for callers
// and old fixtures, but deliberately do not hash it.
export function inventoryRecoveryScopeKey({runDate: _runDate, storeKey, skc, skuCode} = {}) {
  return inventoryIntentScopeKey({storeKey, skc, skuCode});
}

function inventoryScopeFieldMismatch(left, right) {
  const a = normalizeInventoryWriteScope(left);
  const b = normalizeInventoryWriteScope(right);
  return ['storeKey', 'skc', 'skuCode', 'warehouseCode', 'invType']
    .find(field => a[field] !== b[field]) || '';
}

export function inventoryWriteScopesOverlap(left, right) {
  const a = normalizeInventoryWriteScope(left);
  const b = normalizeInventoryWriteScope(right);
  if ((a.storeKey && b.storeKey && a.storeKey !== b.storeKey)
    || (a.skc && b.skc && a.skc !== b.skc)
    || a.skuCode !== b.skuCode
    || a.invType !== b.invType) return false;
  // An absent warehouse in an incoming lower-layer request is not proof that
  // it is a different warehouse.  Conservatively treat it as overlapping so
  // the permanent fence cannot be bypassed through a less-specific entry.
  return !a.warehouseCode || !b.warehouseCode || a.warehouseCode === b.warehouseCode;
}

export function inventoryJournalDateFromFile(journalFile) {
  const match = INVENTORY_JOURNAL_FILE_RE.exec(path.basename(String(journalFile || '')));
  return match?.[1] || '';
}

export async function discoverInventoryJournalFiles(currentJournalFile, {
  includeAll = false,
  additionalDirectories = [],
} = {}) {
  const current = path.resolve(String(currentJournalFile || ''));
  if (!Array.isArray(additionalDirectories)) throw new Error('additionalDirectories must be an array');
  const directories = [...new Set([
    path.dirname(current),
    ...additionalDirectories
      .map(directory => String(directory || '').trim())
      .filter(Boolean)
      .map(directory => path.resolve(directory)),
  ])];
  const candidates = [];
  for (const directory of directories) {
    let names = [];
    try {
      names = await fs.readdir(directory);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    candidates.push(...names
      .filter(name => name.endsWith('.journal.ndjson'))
      .filter(name => includeAll || INVENTORY_JOURNAL_FILE_RE.test(name))
      .map(name => path.join(directory, name)));
  }
  const files = [];
  const seenPaths = new Set();
  const seenFileIdentities = new Set();
  // ET execution hard-links its stable journal to a timestamped attempt
  // journal. Prefer the current executor path and de-duplicate the same inode;
  // otherwise strict aggregation would mistake one physical intent history
  // for two conflicting journals.
  for (const candidate of [current, ...candidates]) {
    const resolved = path.resolve(candidate);
    if (seenPaths.has(resolved)) continue;
    seenPaths.add(resolved);
    let identity = '';
    try {
      const stat = await fs.stat(resolved, {bigint: true});
      if (stat.ino > 0n) identity = `${stat.dev}:${stat.ino}`;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (identity && seenFileIdentities.has(identity)) continue;
    if (identity) seenFileIdentities.add(identity);
    files.push(resolved);
  }
  return files;
}

export function compareInventoryIntentChronology(left, right) {
  const leftRunDate = String(left?.runDate || '');
  const rightRunDate = String(right?.runDate || '');
  if (leftRunDate !== rightRunDate) return leftRunDate.localeCompare(rightRunDate);
  const leftRecordedAt = new Date(left?.recordedAt || '').getTime();
  const rightRecordedAt = new Date(right?.recordedAt || '').getTime();
  if (Number.isFinite(leftRecordedAt) && Number.isFinite(rightRecordedAt)) {
    return Math.sign(leftRecordedAt - rightRecordedAt);
  }
  return String(left?.recordedAt || '').localeCompare(String(right?.recordedAt || ''));
}

function inventoryIntentScopeMissingFields(intent) {
  return ['runDate', 'storeKey', 'skc', 'skuCode', 'logicalActionKey']
    .filter(field => String(intent?.[field] ?? '').trim() === '');
}

function hasOwnProperty(object, property) {
  return Boolean(object)
    && typeof object === 'object'
    && Object.prototype.hasOwnProperty.call(object, property);
}

function inventoryOverwriteComputationProfile(intent, {requireCurrent = false} = {}) {
  const hasVersion = hasOwnProperty(intent, 'overwriteComputationVersion');
  const version = hasVersion ? String(intent?.overwriteComputationVersion ?? '').trim() : '';
  if (hasVersion && version !== INVENTORY_OVERWRITE_COMPUTATION_VERSION) {
    return {valid: false, quantities: []};
  }
  if (!hasVersion && (requireCurrent || String(intent?.runDate || '') > INVENTORY_LEGACY_UNVERSIONED_CUTOFF_DATE)) {
    return {valid: false, quantities: []};
  }
  return {
    valid: true,
    quantities: hasVersion
      ? [computeInventoryOverwriteQuantity(Number(intent?.targetUsableInventory), intent?.before || {})]
      : [
          computeInventoryOverwriteQuantity(Number(intent?.targetUsableInventory), intent?.before || {}),
          computeLegacyInventoryOverwriteQuantity(Number(intent?.targetUsableInventory), intent?.before || {}),
        ],
  };
}

function validateInventoryIntentEntry(intent, {journalFile, journalDate, maxRunDate, lineNumber} = {}) {
  const missing = inventoryIntentScopeMissingFields(intent);
  if (missing.length) {
    throw new Error(`INVENTORY_JOURNAL_SCOPE_INVALID:${journalFile}:${lineNumber}:missing=${missing.join(',')}`);
  }
  const runDate = String(intent.runDate).trim();
  if (!isValidIsoDate(runDate)) {
    throw new Error(`INVENTORY_JOURNAL_SCOPE_INVALID:${journalFile}:${lineNumber}:invalid_runDate=${runDate}`);
  }
  if (journalDate && runDate !== journalDate) {
    throw new Error(`INVENTORY_JOURNAL_SCOPE_CONFLICT:${journalFile}:${lineNumber}:journalDate=${journalDate}:runDate=${runDate}`);
  }
  if (maxRunDate && runDate > maxRunDate) {
    throw new Error(`INVENTORY_JOURNAL_FUTURE_DATE:${journalFile}:${lineNumber}:runDate=${runDate}:max=${maxRunDate}`);
  }
  const target = Number(intent.targetUsableInventory);
  if (!Number.isInteger(target) || target < 0) {
    throw new Error(`INVENTORY_JOURNAL_SCOPE_INVALID:${journalFile}:${lineNumber}:invalid_targetUsableInventory=${intent.targetUsableInventory}`);
  }
  const expectedScopeKey = inventoryIntentScopeKey(intent);
  const legacyIntentScopeKey = legacyInventoryIntentScopeKey(intent);
  const legacyScopeKey = legacyInventoryRecoveryScopeKey(intent);
  if (intent.recoveryScopeKey && ![expectedScopeKey, legacyIntentScopeKey, legacyScopeKey].includes(intent.recoveryScopeKey)) {
    throw new Error(`INVENTORY_JOURNAL_SCOPE_CONFLICT:${journalFile}:${lineNumber}:recoveryScopeKey`);
  }
  const immutableMismatch = inventoryIntentImmutableMismatch(intent);
  if (immutableMismatch) {
    throw new Error(`INVENTORY_JOURNAL_IMMUTABLE_INVALID:${journalFile}:${lineNumber}:${immutableMismatch}`);
  }
}

function inventoryIntentImmutableMismatch(intent) {
  const target = Number(intent?.targetUsableInventory);
  const before = intent?.before;
  const request = intent?.request;
  const requestRow = request?.body?.updateSkuInventoryQuantityRequests?.[0];
  const authorizationId = String(intent?.authorizationId ?? '').trim();
  const expectedLogicalActionKey = stableInventoryHash({
    runDate: String(intent?.runDate || ''),
    store: String(intent?.storeKey || ''),
    skc: String(intent?.skc || ''),
    sku: String(intent?.skuCode || ''),
    target,
    actionType: 'VI_OVERWRITE_TO_EXACT_USABLE_TARGET',
    policyVersion: String(intent?.policyVersion || ''),
    authorizationId,
  });
  const beforeIsObject = before && typeof before === 'object' && !Array.isArray(before);
  const beforeFieldsAreFinite = beforeIsObject
    && ['totalInventoryQuantity', 'totalUsableInventory', 'totalLockedQuantity']
      .every(field => Number.isFinite(Number(before[field])));
  const overwriteComputation = inventoryOverwriteComputationProfile(intent);
  const expectedOverwrites = beforeFieldsAreFinite && overwriteComputation.valid
    ? overwriteComputation.quantities
    : [];
  const expectedIdempotencyKey = `bi-inv-${expectedLogicalActionKey.slice(0, 42)}`;
  const requestKeys = request && typeof request === 'object' && !Array.isArray(request)
    ? Object.keys(request).sort().join(',')
    : '';
  const requestBodyKeys = request?.body && typeof request.body === 'object' && !Array.isArray(request.body)
    ? Object.keys(request.body).sort().join(',')
    : '';
  const requestRowKeys = requestRow && typeof requestRow === 'object' && !Array.isArray(requestRow)
    ? Object.keys(requestRow).filter(key => key !== 'warehouseCode').sort().join(',')
    : '';
  const hasWarehouseCode = Boolean(requestRow)
    && Object.prototype.hasOwnProperty.call(requestRow, 'warehouseCode');
  const maintenanceInventoryProfile = String(intent?.inventoryWriteProfile || '') === INVENTORY_MAINTENANCE_WRITE_PROFILE;
  const intentWarehouseCode = normalizedScopeValue(intent?.warehouseCode, {upper: true});
  const requestWarehouseCode = normalizedScopeValue(requestRow?.warehouseCode, {upper: true});
  const warehouseCodeIsValid = maintenanceInventoryProfile
    ? hasWarehouseCode && Boolean(requestWarehouseCode) && requestWarehouseCode === intentWarehouseCode
    : (before?.stockRowMissing === true
      ? hasWarehouseCode && Boolean(requestWarehouseCode)
      : !hasWarehouseCode);
  const checks = [
    [/^[a-f0-9]{64}$/i.test(String(intent?.logicalActionKey || '')) && intent.logicalActionKey === expectedLogicalActionKey, 'logicalActionKey'],
    [/^[a-f0-9]{64}$/i.test(String(intent?.planHash || '')), 'planHash'],
    [Boolean(String(intent?.policyVersion || '').trim()), 'policyVersion'],
    [isValidTimestamp(intent?.recordedAt), 'recordedAt'],
    [overwriteComputation.valid, 'overwriteComputationVersion'],
    [Boolean(authorizationId), 'authorizationId'],
    [request && requestKeys === 'body,headers,method,pathname', 'requestShape'],
    [request?.pathname === '/open-api/stock/change-inventory/v2' && request?.method === 'POST', 'requestRoute'],
    [requestBodyKeys === 'updateSkuInventoryQuantityRequests', 'requestBodyShape'],
    [Array.isArray(request?.body?.updateSkuInventoryQuantityRequests) && request.body.updateSkuInventoryQuantityRequests.length === 1, 'requestRows'],
    [requestRowKeys === 'changeQuantity,changeReason,changeType,idempotencyKey,invType,skuCode', 'requestRowShape'],
    [String(intent?.requestPayloadHash || '') === stableInventoryHash(request), 'requestPayloadHash'],
    [String(intent?.idempotencyKey || '') === expectedIdempotencyKey && requestRow?.idempotencyKey === intent?.idempotencyKey, 'idempotencyKey'],
    [requestRow?.skuCode === intent?.skuCode, 'request.skuCode'],
    [requestRow?.invType === 'VI' && requestRow?.changeType === 'OVERWRITE', 'request.inventoryType'],
    [beforeFieldsAreFinite && expectedOverwrites.includes(Number(requestRow?.changeQuantity)), 'request.changeQuantity'],
    [INVENTORY_CHANGE_REASONS.has(requestRow?.changeReason), 'request.changeReason'],
    [request?.headers?.language === 'en' && Object.keys(request.headers).length === 1, 'request.headers'],
    [beforeIsObject && typeof before.stockRowMissing === 'boolean', 'before.stockRowMissing'],
    [warehouseCodeIsValid, 'request.warehouseCode'],
  ];
  return checks.find(([ok]) => !ok)?.[1] || '';
}

function requireManualResolutionHash(value, field, fail) {
  if (!/^[a-f0-9]{64}$/i.test(String(value || ''))) fail(field);
}

function requireManualResolutionObject(value, keys, field, fail) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== keys) fail(field);
}

function validateManualResolutionLiveBaseline(value, {journalFile, lineNumber, intentScope} = {}) {
  const fail = reason => {
    throw new Error(`INVENTORY_JOURNAL_MANUAL_RESOLUTION_INVALID:${journalFile}:${lineNumber}:liveInventoryBaseline.${reason}`);
  };
  requireManualResolutionObject(value, MANUAL_RESOLUTION_LIVE_BASELINE_KEYS, 'liveInventoryBaseline', fail);
  if (typeof value.source !== 'string' || !value.source.trim() || !isValidTimestamp(value.capturedAt)) fail('identity');
  if (inventoryScopeFieldMismatch(value.scope, intentScope)) fail('scope');
  if (value.scope?.scopeKey !== inventoryWriteScopeKey(value.scope)) fail('scopeKey');
  for (const field of ['totalInventoryQuantity', 'totalUsableInventory', 'totalLockedQuantity', 'temporaryInventoryQuantity']) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) fail(field);
  }
  if (value.totalInventoryQuantity !== 50
    || value.totalUsableInventory !== 49
    || value.totalLockedQuantity !== 1
    || value.temporaryInventoryQuantity !== 0) fail('value');
  return value;
}

function validateManualResolutionProductionBaseline(value, {journalFile, lineNumber} = {}) {
  const fail = reason => {
    throw new Error(`INVENTORY_JOURNAL_MANUAL_RESOLUTION_INVALID:${journalFile}:${lineNumber}:productionBaseline.${reason}`);
  };
  requireManualResolutionObject(value, MANUAL_RESOLUTION_PRODUCTION_BASELINE_KEYS, 'productionBaseline', fail);
  requireManualResolutionHash(value.activationHash, 'activationHash', fail);
  requireManualResolutionHash(value.activationReceiptHash, 'activationReceiptHash', fail);
  if (!isValidTimestamp(value.capturedAt)) fail('capturedAt');
  if (!/^[a-f0-9]{40}$/i.test(String(value.deployedCommit || ''))) fail('deployedCommit');
  if (value.trackedSourceClean !== true) fail('trackedSourceClean');
  requireManualResolutionHash(value.sourceFingerprint, 'sourceFingerprint', fail);
  if (value.releaseReceiptKind !== 'formal' && value.releaseReceiptKind !== 'emergency') fail('releaseReceiptKind');
  requireManualResolutionHash(value.releaseReceiptHash, 'releaseReceiptHash', fail);
  requireManualResolutionHash(value.bundleSha256, 'bundleSha256', fail);
  if (typeof value.source !== 'string' || !value.source.trim()) fail('source');
  if (!Number.isSafeInteger(value.maintenanceGeneration) || value.maintenanceGeneration < 1) fail('maintenanceGeneration');
  requireManualResolutionHash(value.maintenanceHash, 'maintenanceHash', fail);
  if (value.maintenanceActive !== true || value.maintenanceMode !== 'all') fail('maintenanceState');
  requireManualResolutionHash(value.writerServicesHash, 'writerServicesHash', fail);
  return value;
}

// The approval hash deliberately excludes only execution-time identity fields
// (resolutionId and recordedAt) plus its own field. All evidence, age,
// journal/plan hashes, scope, owner confirmation and the original response
// remain inside the immutable preflight material.
export function manualResolutionPreflightHash(entry = {}) {
  const {
    preflightHash: _preflightHash,
    resolutionId: _resolutionId,
    recordedAt: _recordedAt,
    ...preflightMaterial
  } = entry || {};
  return stableInventoryHash(preflightMaterial);
}

function validateManualResolutionArtifact(artifact, {journalFile, lineNumber, intentScope} = {}) {
  const fail = reason => {
    throw new Error(`INVENTORY_JOURNAL_MANUAL_RESOLUTION_INVALID:${journalFile}:${lineNumber}:${reason}`);
  };
  requireManualResolutionObject(artifact, MANUAL_RESOLUTION_ARTIFACT_KEYS, 'artifactShape', fail);
  if (typeof artifact.path !== 'string' || !artifact.path.trim()) fail('artifact.path');
  requireManualResolutionHash(artifact.sha256, 'artifact.sha256', fail);
  if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1) fail('artifact.bytes');
  if (!isValidTimestamp(artifact.capturedAt)) fail('artifact.capturedAt');
  requireManualResolutionHash(artifact.payloadHash, 'artifact.payloadHash', fail);
  const codeIsScalar = typeof artifact.code === 'string'
    || (typeof artifact.code === 'number' && Number.isFinite(artifact.code));
  if (!codeIsScalar || String(artifact.code).trim() !== '0') fail('artifact.code');
  if (typeof artifact.msg !== 'string' || artifact.msg.trim() === '') fail('artifact.msg');
  if (typeof artifact.traceId !== 'string' || artifact.traceId.trim() === '') fail('artifact.traceId');
  requireManualResolutionObject(artifact.scope, MANUAL_RESOLUTION_SCOPE_KEYS, 'artifact.scope', fail);
  if (inventoryScopeFieldMismatch(artifact.scope, intentScope)) {
    const mismatch = inventoryScopeFieldMismatch(artifact.scope, intentScope);
    if (mismatch !== 'warehouseCode' || intentScope.warehouseCode) fail(`artifact.scope.${mismatch}`);
  }
  if (artifact.scope.scopeKey !== inventoryWriteScopeKey(artifact.scope)) fail('artifact.scope.scopeKey');
  for (const field of ['totalInventoryQuantity', 'totalUsableInventory', 'totalLockedQuantity', 'temporaryInventoryQuantity']) {
    if (!Number.isSafeInteger(artifact[field]) || artifact[field] < 0) fail(`artifact.${field}`);
  }
  return artifact;
}

export function validateManualResolutionEntry(entry, intent, {journalFile = '', lineNumber = 0} = {}) {
  const fail = reason => {
    throw new Error(`INVENTORY_JOURNAL_MANUAL_RESOLUTION_INVALID:${journalFile}:${lineNumber}:${reason}`);
  };
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('entryShape');
  if (Object.keys(entry).sort().join(',') !== MANUAL_RESOLUTION_KEYS) fail('topLevelKeys');
  if (entry.schemaVersion !== INVENTORY_MANUAL_RESOLUTION_SCHEMA_VERSION) fail('schemaVersion');
  if (entry.kind !== INVENTORY_MANUAL_RESOLUTION_KIND) fail('kind');
  if (entry.disposition !== INVENTORY_MANUAL_RESOLUTION_DISPOSITION) fail('disposition');
  if (!String(entry.resolutionId || '').match(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)) fail('resolutionId');
  if (!intent || typeof intent !== 'object' || entry.intentId !== intent.intentId) fail('intentId');
  if (entry.logicalActionKey !== intent.logicalActionKey) fail('logicalActionKey');
  if (entry.runDate !== intent.runDate || !isValidIsoDate(entry.runDate)) fail('runDate');
  if (entry.storeKey !== intent.storeKey || entry.skc !== intent.skc || entry.skuCode !== intent.skuCode) fail('identity');
  if (entry.targetUsableInventory !== Number(intent.targetUsableInventory)) fail('targetUsableInventory');
  if (entry.warehouseCode !== normalizeInventoryWriteScope(entry.scope).warehouseCode) fail('warehouseCode');
  const scope = normalizeInventoryWriteScope(entry.scope);
  if (Object.keys(entry.scope).sort().join(',') !== MANUAL_RESOLUTION_SCOPE_KEYS
    || !scope.storeKey || !scope.skc || !scope.skuCode || !scope.warehouseCode || scope.invType !== 'VI') fail('scope');
  const intentScope = inventoryScopeFromIntent(intent);
  if (scope.storeKey !== intentScope.storeKey || scope.skc !== intentScope.skc || scope.skuCode !== intentScope.skuCode || scope.invType !== intentScope.invType) fail('scope.identity');
  if (intentScope.warehouseCode && scope.warehouseCode !== intentScope.warehouseCode) fail('scope.warehouseCode');
  if (entry.scope.scopeKey !== inventoryWriteScopeKey(scope)) fail('scope.scopeKey');
  if (entry.idempotencyKey !== intent.idempotencyKey) fail('idempotencyKey');
  if (entry.originalRequestPayloadHash !== intent.requestPayloadHash) fail('originalRequestPayloadHash');
  if (entry.planHash !== intent.planHash) fail('planHash');
  requireManualResolutionHash(entry.intentHash, 'intentHash', fail);
  if (entry.intentHash !== inventoryIntentHash(intent)) fail('intentHashValue');
  requireManualResolutionHash(entry.preflightHash, 'preflightHash', fail);
  if (entry.preflightHash !== manualResolutionPreflightHash(entry)) fail('preflightHashValue');
  requireManualResolutionHash(entry.globalJournalSha256, 'globalJournalSha256', fail);
  if (typeof entry.journalFile !== 'string' || !entry.journalFile.trim() || path.resolve(entry.journalFile) !== path.resolve(journalFile)) fail('journalFile');
  requireManualResolutionHash(entry.journalFileSha256, 'journalFileSha256', fail);
  if (typeof entry.planFile !== 'string' || !entry.planFile.trim()) fail('planFile');
  requireManualResolutionHash(entry.planFileSha256, 'planFileSha256', fail);
  if (!isValidTimestamp(entry.recordedAt) || new Date(entry.recordedAt).getTime() < new Date(intent.recordedAt).getTime()) fail('recordedAt');
  if (!Number.isSafeInteger(entry.ageSeconds) || entry.ageSeconds < 0) fail('ageSeconds');
  requireManualResolutionObject(entry.ownerConfirmation, MANUAL_RESOLUTION_OWNER_KEYS, 'ownerConfirmation', fail);
  if (entry.ownerConfirmation.confirmed !== true
    || entry.ownerConfirmation.statement !== INVENTORY_MANUAL_RESOLUTION_OWNER_CONFIRMATION
    || typeof entry.ownerConfirmation.actor !== 'string' || !entry.ownerConfirmation.actor.trim()) fail('ownerConfirmation');
  validateManualResolutionProductionBaseline(entry.productionBaseline, {journalFile, lineNumber});
  validateManualResolutionLiveBaseline(entry.liveInventoryBaseline, {journalFile, lineNumber, intentScope: scope});
  if (entry.liveInventoryBaseline.scope.scopeKey !== inventoryWriteScopeKey(scope)) fail('liveInventoryBaseline.scopeKey');
  requireManualResolutionObject(entry.historicalScope, MANUAL_RESOLUTION_HISTORICAL_KEYS, 'historicalScope', fail);
  if (entry.historicalScope.totalInventoryQuantity !== 74
    || entry.historicalScope.maxUsableInventory !== 50
    || entry.historicalScope.noUsableInventory !== 100) fail('historicalScope.value');
  requireManualResolutionObject(entry.originalResponse, 'code,traceId', 'originalResponse', fail);
  const originalCodeIsScalar = typeof entry.originalResponse.code === 'string'
    || (typeof entry.originalResponse.code === 'number' && Number.isFinite(entry.originalResponse.code));
  if (!originalCodeIsScalar || String(entry.originalResponse.code).trim() !== '0'
    || typeof entry.originalResponse.traceId !== 'string' || !entry.originalResponse.traceId.trim()) fail('originalResponse');
  if (!Array.isArray(entry.readbackArtifacts) || entry.readbackArtifacts.length !== 2) fail('readbackArtifacts.count');
  const seenArtifactPaths = new Set();
  const seenArtifactHashes = new Set();
  for (const artifact of entry.readbackArtifacts) {
    validateManualResolutionArtifact(artifact, {journalFile, lineNumber, intentScope: scope});
    if (seenArtifactPaths.has(artifact.path)) fail('readbackArtifacts.duplicatePath');
    if (seenArtifactHashes.has(artifact.sha256)) fail('readbackArtifacts.notIndependent');
    seenArtifactPaths.add(artifact.path);
    seenArtifactHashes.add(artifact.sha256);
    if (artifact.scope.scopeKey !== inventoryWriteScopeKey(scope)) fail('readbackArtifacts.scope');
  }
  return true;
}

export function buildManualResolutionEntry({
  resolutionId: suppliedResolutionId = '',
  intent,
  journalFile,
  journalFileSha256,
  globalJournalSha256,
  planFile,
  planFileSha256,
  scope,
  ageSeconds,
  productionBaseline,
  liveInventoryBaseline,
  ownerConfirmation,
  readbackArtifacts,
  originalResponse,
  historicalScope = {
    totalInventoryQuantity: 74,
    maxUsableInventory: 50,
    noUsableInventory: 100,
  },
  recordedAt = new Date().toISOString(),
} = {}) {
  if (!intent?.intentId || !journalFile || !planFile) throw new Error('manual resolution intent, journalFile and planFile are required');
  const normalizedScope = normalizeInventoryWriteScope(scope);
  const entry = {
    schemaVersion: INVENTORY_MANUAL_RESOLUTION_SCHEMA_VERSION,
    kind: INVENTORY_MANUAL_RESOLUTION_KIND,
    disposition: INVENTORY_MANUAL_RESOLUTION_DISPOSITION,
    resolutionId: String(suppliedResolutionId || ''),
    intentId: String(intent.intentId),
    logicalActionKey: String(intent.logicalActionKey || ''),
    runDate: String(intent.runDate || ''),
    storeKey: String(intent.storeKey || ''),
    skc: String(intent.skc || ''),
    skuCode: String(intent.skuCode || ''),
    targetUsableInventory: Number(intent.targetUsableInventory),
    warehouseCode: normalizedScope.warehouseCode,
    scope: {
      storeKey: normalizedScope.storeKey,
      skc: normalizedScope.skc,
      skuCode: normalizedScope.skuCode,
      warehouseCode: normalizedScope.warehouseCode,
      invType: normalizedScope.invType,
      scopeKey: inventoryWriteScopeKey(normalizedScope),
    },
    idempotencyKey: String(intent.idempotencyKey || ''),
    originalRequestPayloadHash: String(intent.requestPayloadHash || ''),
    intentHash: inventoryIntentHash(intent),
    planHash: String(intent.planHash || ''),
    planFile: String(planFile),
    planFileSha256: String(planFileSha256 || '').toLowerCase(),
    journalFile: path.resolve(String(journalFile)),
    journalFileSha256: String(journalFileSha256 || '').toLowerCase(),
    globalJournalSha256: String(globalJournalSha256 || '').toLowerCase(),
    ageSeconds: Number(ageSeconds),
    productionBaseline,
    ownerConfirmation,
    readbackArtifacts,
    originalResponse,
    historicalScope,
    recordedAt,
    liveInventoryBaseline,
  };
  entry.preflightHash = manualResolutionPreflightHash(entry);
  return entry;
}

function validateLegacyInventoryAuditEntry(entry, {
  journalFile,
  lineNumber,
  expectedSequence,
  expectedPlanHash,
} = {}) {
  const fail = reason => {
    throw new Error(`INVENTORY_JOURNAL_LEGACY_AUDIT_INVALID:${journalFile}:${lineNumber}:${reason}`);
  };
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('entryShape');
  if (Object.keys(entry).sort().join(',') !== LEGACY_INVENTORY_AUDIT_KEYS) fail('topLevelKeys');
  if (!/^[a-f0-9]{64}$/i.test(String(entry.planHash || ''))) fail('planHash');
  if (expectedPlanHash && entry.planHash !== expectedPlanHash) fail('planHashConflict');
  if (!isValidTimestamp(entry.recordedAt)) fail('recordedAt');
  if (!Number.isSafeInteger(entry.sequence) || entry.sequence < 1 || entry.sequence !== expectedSequence) fail('sequence');
  const row = entry.row;
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail('rowShape');
  for (const field of ['storeKey', 'skc', 'skuCode', 'canonical']) {
    if (typeof row[field] !== 'string' || row[field].trim() === '') fail(`row.${field}`);
  }
  const rowKeys = Object.keys(row).sort().join(',');
  if (row.state === 'updated_readback_matched') {
    if (rowKeys !== LEGACY_INVENTORY_UPDATED_ROW_KEYS) fail('updatedRowKeys');
    if (!row.before || typeof row.before !== 'object' || Array.isArray(row.before)) fail('row.before');
    if (!row.after || typeof row.after !== 'object' || Array.isArray(row.after)) fail('row.after');
    if (!Array.isArray(row.writes)) fail('row.writes');
  } else if (row.state === 'blocked') {
    if (rowKeys !== LEGACY_INVENTORY_BLOCKED_ROW_KEYS) fail('blockedRowKeys');
    if (typeof row.error !== 'string' || row.error.trim() === '') fail('row.error');
  } else {
    fail('row.state');
  }
  return {planHash: entry.planHash, nextSequence: expectedSequence + 1};
}

function validateInventoryOutcomeLogicalAndTimestamp(entry, intent, fail) {
  if (entry.logicalActionKey !== intent.logicalActionKey) fail('logicalActionKey');
  if (!isValidTimestamp(entry.recordedAt)) fail('recordedAt');
  if (new Date(entry.recordedAt).getTime() < new Date(intent.recordedAt).getTime()) fail('recordedAtOrder');
}

function validateInventoryTerminalOutcome(entry, intent, {journalFile, lineNumber} = {}) {
  const disposition = entry?.disposition;
  const fail = reason => {
    throw new Error(`INVENTORY_JOURNAL_OUTCOME_INVALID:${journalFile}:${lineNumber}:${reason}`);
  };
  const supersedeFail = reason => {
    throw new Error(`INVENTORY_JOURNAL_SUPERSEDE_INVALID:${journalFile}:${lineNumber}:${reason}`);
  };
  const commonFail = disposition === 'superseded_by_later_readback' ? supersedeFail : fail;
  validateInventoryOutcomeLogicalAndTimestamp(entry, intent, commonFail);
  if (disposition === 'readback_matched') {
    if (Object.keys(entry).sort().join(',') !== INVENTORY_READBACK_OUTCOME_KEYS) fail('readbackOutcomeShape');
    return;
  }
  if (disposition === 'rejected') {
    const codeIsScalar = typeof entry.code === 'string'
      || (typeof entry.code === 'number' && Number.isFinite(entry.code));
    if (!codeIsScalar || String(entry.code).trim() === '') fail('code');
    if (String(entry.code).trim() === '0') fail('code');
    if (entry.httpOk !== true) fail('httpOk');
    if (!Number.isInteger(entry.httpStatus) || entry.httpStatus < 200 || entry.httpStatus >= 300) fail('httpStatus');
    if (entry.success !== false) fail('success');
    if (Object.keys(entry).sort().join(',') !== INVENTORY_REJECTED_OUTCOME_KEYS) fail('rejectedOutcomeShape');
    return;
  }
  if (disposition === 'superseded_by_later_readback') {
    if (Object.keys(entry).sort().join(',') !== INVENTORY_SUPERSEDE_OUTCOME_KEYS) supersedeFail('outcomeShape');
    if (!String(entry.supersededByIntentId || '').trim() || entry.supersededByIntentId === intent.intentId) supersedeFail('supersededByIntentId');
    if (!isValidIsoDate(entry.supersededByRunDate) || entry.supersededByRunDate < intent.runDate) supersedeFail('supersededByRunDate');
    if (!isValidTimestamp(entry.supersededByRecordedAt)) supersedeFail('supersededByRecordedAt');
    if (entry.supersededByRunDate === intent.runDate
      && new Date(entry.supersededByRecordedAt).getTime() <= new Date(intent.recordedAt).getTime()) {
      supersedeFail('supersededByRecordedAtOrder');
    }
    if (new Date(entry.recordedAt).getTime() < new Date(entry.supersededByRecordedAt).getTime()) supersedeFail('recordedAtOrder');
    return;
  }
  if (disposition === INVENTORY_OWNER_CONFIRMED_SAME_TARGET_SUPERSEDE_DISPOSITION) {
    if (Object.keys(entry).sort().join(',') !== INVENTORY_OWNER_CONFIRMED_SAME_TARGET_SUPERSEDE_OUTCOME_KEYS) fail('ownerConfirmedSameTargetShape');
    if (entry.originalEffectUnknown !== true) fail('originalEffectUnknown');
    if (Number(entry.targetUsableInventory) !== 10 || Number(intent.targetUsableInventory) !== 10) fail('targetUsableInventory');
    if (!isValidIsoDate(entry.oldRunDate) || entry.oldRunDate !== intent.runDate) fail('oldRunDate');
    if (!isValidIsoDate(entry.newRunDate)) fail('newRunDate');
    const oldRunDateMs = Date.parse(`${entry.oldRunDate}T00:00:00Z`);
    const newRunDateMs = Date.parse(`${entry.newRunDate}T00:00:00Z`);
    if (!Number.isFinite(oldRunDateMs) || !Number.isFinite(newRunDateMs)
      || Math.floor((newRunDateMs - oldRunDateMs) / 86_400_000) < 14) fail('runDateAge');
    const freshUsable = Number(entry.freshUsableInventory);
    if (!Number.isSafeInteger(freshUsable) || freshUsable < 0 || freshUsable >= 10) fail('freshUsableInventory');
    if (entry.ownerConfirmationText !== '补到10') fail('ownerConfirmationText');
  }
}

export function recoveredInventoryIntentMismatch(intent, {
  logicalActionKey,
  plan,
  row,
  approvedTarget,
  authorizationId,
  requireCurrentOverwriteComputationVersion = true,
} = {}) {
  const requestRow = intent?.request?.body?.updateSkuInventoryQuantityRequests?.[0];
  const overwriteComputation = inventoryOverwriteComputationProfile({
    ...intent,
    targetUsableInventory: approvedTarget,
  }, {requireCurrent: requireCurrentOverwriteComputationVersion});
  const expectedOverwrites = overwriteComputation.valid
    ? overwriteComputation.quantities
    : [];
  const expectedRecoveryScopeKey = inventoryRecoveryScopeKey({runDate: plan.date, storeKey: row.storeKey, skc: row.skc, skuCode: row.skuCode});
  const legacyRecoveryScopeKey = legacyInventoryRecoveryScopeKey({runDate: intent?.runDate, storeKey: row.storeKey, skc: row.skc, skuCode: row.skuCode});
  const expectedChangeReason = plan?.executionConstraints?.decreaseOnly
    ? 'Owner-authorized ET low-inventory safety reduction after current-day ET guard'
    : 'Owner-authorized daily inventory target after current-day ET and sales/exposure guard';
  const checks = [
    [intent?.recoveryScopeKey === expectedRecoveryScopeKey || intent?.recoveryScopeKey === legacyRecoveryScopeKey, 'recoveryScopeKey'],
    [intent?.logicalActionKey === logicalActionKey, 'logicalActionKey'],
    [intent?.planHash === plan.payloadHash, 'planHash'],
    [intent?.runDate === plan.date, 'runDate'],
    [intent?.storeKey === row.storeKey, 'storeKey'],
    [intent?.skc === row.skc, 'skc'],
    [intent?.skuCode === row.skuCode, 'skuCode'],
    [Number(intent?.targetUsableInventory) === approvedTarget, 'targetUsableInventory'],
    [intent?.policyVersion === plan.policyVersion, 'policyVersion'],
    [overwriteComputation.valid, 'overwriteComputationVersion'],
    [intent?.authorizationId === authorizationId, 'authorizationId'],
    [intent?.idempotencyKey === `bi-inv-${logicalActionKey.slice(0, 42)}`, 'idempotencyKey'],
    [intent?.requestPayloadHash === stableInventoryHash(intent?.request), 'requestPayloadHash'],
    [intent?.request?.pathname === '/open-api/stock/change-inventory/v2' && intent?.request?.method === 'POST', 'requestRoute'],
    [requestRow?.idempotencyKey === intent?.idempotencyKey, 'request.idempotencyKey'],
    [requestRow?.skuCode === row.skuCode && requestRow?.invType === 'VI' && requestRow?.changeType === 'OVERWRITE', 'request.identity'],
    [expectedOverwrites.includes(Number(requestRow?.changeQuantity)), 'request.changeQuantity'],
    [requestRow?.changeReason === expectedChangeReason, 'request.changeReason'],
    [intent?.request?.headers?.language === 'en' && Object.keys(intent.request.headers).length === 1, 'request.headers'],
    [intent?.before?.stockRowMissing === true ? Boolean(requestRow?.warehouseCode) : !requestRow?.warehouseCode, 'request.warehouseCode'],
  ];
  return checks.find(([ok]) => !ok)?.[1] || '';
}

export async function appendDurableJournalRecord(journalFile, entry, {allowManualResolution = false} = {}) {
  if ((entry?.kind === INVENTORY_MANUAL_RESOLUTION_KIND
      || entry?.schemaVersion === INVENTORY_MANUAL_RESOLUTION_SCHEMA_VERSION)
    && !allowManualResolution) {
    throw new Error('INVENTORY_MANUAL_RESOLUTION_REQUIRES_CONTROLLED_RESOLVER');
  }
  try {
    const existing = await fs.readFile(journalFile, 'utf8');
    if (existing && !existing.endsWith('\n')) throw new Error('INVENTORY_JOURNAL_TORN_TAIL');
    for (const line of existing.split(/\r?\n/).filter(Boolean)) {
      try { JSON.parse(line); } catch { throw new Error('INVENTORY_JOURNAL_INVALID_LINE'); }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const handle = await fs.open(journalFile, 'a', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(entry)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function appendManualResolutionRecord(journalFile, entry) {
  if (entry?.kind !== INVENTORY_MANUAL_RESOLUTION_KIND) {
    throw new Error('INVENTORY_MANUAL_RESOLUTION_KIND_REQUIRED');
  }
  if (entry?.schemaVersion !== INVENTORY_MANUAL_RESOLUTION_SCHEMA_VERSION
    || entry?.disposition !== INVENTORY_MANUAL_RESOLUTION_DISPOSITION) {
    throw new Error('INVENTORY_MANUAL_RESOLUTION_SCHEMA_INVALID');
  }
  await appendDurableJournalRecord(journalFile, entry, {allowManualResolution: true});
}

export async function readInventoryIntentLifecycle(journalFile, {strict = false, maxRunDate = ''} = {}) {
  const intents = new Map();
  const pending = new Map();
  const terminalOutcomes = new Map();
  const manualResolutions = new Map();
  const fences = new Map();
  const tombstonedIdempotencyKeys = new Map();
  const journalDate = inventoryJournalDateFromFile(journalFile);
  let text = '';
  try {
    text = await fs.readFile(journalFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return {intents, pending, terminalOutcomes, manualResolutions, fences, tombstonedIdempotencyKeys};
    throw error;
  }
  if (text && !text.endsWith('\n')) throw new Error('INVENTORY_JOURNAL_TORN_TAIL');
  const lines = text.split(/\r?\n/).filter(Boolean);
  let legacyAuditPlanHash = '';
  let nextLegacyAuditSequence = 1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    try {
      const entry = JSON.parse(line);
      if (entry?.kind === 'intent') {
        if (strict) validateInventoryIntentEntry(entry, {
          journalFile,
          journalDate,
          maxRunDate,
          lineNumber: index + 1,
        });
        if (!entry?.logicalActionKey) continue;
        const intentId = entry.intentId || `legacy-${index}-${entry.logicalActionKey}`;
        if (intents.has(intentId)) {
          throw new Error(`INVENTORY_JOURNAL_CONFLICT:${journalFile}:${index + 1}:duplicate_intentId=${intentId}`);
        }
        const intent = {...entry, intentId};
        intents.set(intentId, intent);
        pending.set(intentId, intent);
      } else if (entry?.kind === INVENTORY_MANUAL_RESOLUTION_KIND) {
        if (entry.schemaVersion !== INVENTORY_MANUAL_RESOLUTION_SCHEMA_VERSION) {
          throw new Error(`INVENTORY_JOURNAL_SCHEMA_UNSUPPORTED:${journalFile}:${index + 1}:kind=${INVENTORY_MANUAL_RESOLUTION_KIND}:schema=${entry.schemaVersion || ''}`);
        }
        if (entry.disposition !== INVENTORY_MANUAL_RESOLUTION_DISPOSITION) {
          // A known kind with an unknown disposition is just as unsafe as an
          // unknown schema: silently ignoring it could reopen an old key or
          // make a future resolver disposition look terminal.
          throw new Error(`INVENTORY_JOURNAL_MANUAL_RESOLUTION_INVALID:${journalFile}:${index + 1}:disposition=${entry.disposition || ''}`);
        }
        const intent = intents.get(entry.intentId);
        // A reader that predates the new schema must not silently skip a
        // malformed/orphan manual event.  This event is the permanent fence
        // boundary, so even the compatibility lifecycle reader validates it
        // and fails closed; only ordinary legacy write lines remain gated by
        // the caller's strict option.
        if (!intent) throw new Error(`INVENTORY_JOURNAL_CONFLICT:${journalFile}:${index + 1}:orphan_manual_resolution=${entry.intentId || ''}`);
        if (manualResolutions.has(entry.intentId)) {
          throw new Error(`INVENTORY_JOURNAL_CONFLICT:${journalFile}:${index + 1}:duplicate_manual_resolution=${entry.intentId}`);
        }
        if (terminalOutcomes.has(entry.intentId)) {
          throw new Error(`INVENTORY_JOURNAL_CONFLICT:${journalFile}:${index + 1}:manual_resolution_after_terminal=${entry.intentId}`);
        }
        validateManualResolutionEntry(entry, intent, {journalFile, lineNumber: index + 1});
        if (intent && entry?.intentId && entry?.disposition === INVENTORY_MANUAL_RESOLUTION_DISPOSITION) {
          if (manualResolutions.has(entry.intentId) || terminalOutcomes.has(entry.intentId)) {
            throw new Error(`INVENTORY_JOURNAL_CONFLICT:${journalFile}:${index + 1}:duplicate_manual_resolution=${entry.intentId}`);
          }
          pending.delete(entry.intentId);
          manualResolutions.set(entry.intentId, entry);
          const scopeKey = entry.scope?.scopeKey || inventoryWriteScopeKey(entry.scope);
          if (fences.has(scopeKey)) {
            throw new Error(`INVENTORY_JOURNAL_FENCE_CONFLICT:${journalFile}:${index + 1}:scope=${scopeKey}`);
          }
          fences.set(scopeKey, entry);
          if (entry.idempotencyKey) {
            if (tombstonedIdempotencyKeys.has(entry.idempotencyKey)) {
              throw new Error(`INVENTORY_JOURNAL_TOMBSTONE_CONFLICT:${journalFile}:${index + 1}:idempotencyKey=${entry.idempotencyKey}`);
            }
            tombstonedIdempotencyKeys.set(entry.idempotencyKey, entry);
          }
        }
      } else if (entry?.kind === 'write_outcome') {
        if (strict) {
          if (typeof entry.intentId !== 'string' || entry.intentId.trim() === '') throw new Error(`INVENTORY_JOURNAL_CONFLICT:${journalFile}:${index + 1}:outcome_missing_intentId`);
          if (!INVENTORY_TERMINAL_DISPOSITIONS.has(entry.disposition)) {
            throw new Error(`INVENTORY_JOURNAL_CONFLICT:${journalFile}:${index + 1}:unknown_disposition=${entry.disposition || ''}`);
          }
          const intent = intents.get(entry.intentId);
          if (!intent) throw new Error(`INVENTORY_JOURNAL_CONFLICT:${journalFile}:${index + 1}:orphan_outcome=${entry.intentId}`);
          if (terminalOutcomes.has(entry.intentId)) {
            throw new Error(`INVENTORY_JOURNAL_CONFLICT:${journalFile}:${index + 1}:duplicate_terminal_outcome=${entry.intentId}`);
          }
          if (manualResolutions.has(entry.intentId)) {
            throw new Error(`INVENTORY_JOURNAL_CONFLICT:${journalFile}:${index + 1}:outcome_after_manual_resolution=${entry.intentId}`);
          }
          validateInventoryTerminalOutcome(entry, intent, {journalFile, lineNumber: index + 1});
        }
        if (entry?.intentId && INVENTORY_TERMINAL_DISPOSITIONS.has(entry?.disposition)) {
          pending.delete(entry.intentId);
          terminalOutcomes.set(entry.intentId, entry);
          if (entry.disposition === INVENTORY_OWNER_CONFIRMED_SAME_TARGET_SUPERSEDE_DISPOSITION) {
            const intent = intents.get(entry.intentId);
            if (intent?.idempotencyKey) {
              if (tombstonedIdempotencyKeys.has(intent.idempotencyKey)) {
                throw new Error(`INVENTORY_JOURNAL_TOMBSTONE_CONFLICT:${journalFile}:${index + 1}:idempotencyKey=${intent.idempotencyKey}`);
              }
              tombstonedIdempotencyKeys.set(intent.idempotencyKey, {event: entry, intent});
            }
          }
        }
      } else if (entry?.kind === 'executor_run_intent') {
        // ET low-inventory uses one append-only inode for both its outer run
        // phases and the executor's inventory intents/outcomes. The outer
        // guard validates these orchestration records and their bindings;
        // they are not inventory write lifecycle records and must not make
        // strict durable-intent recovery reject an otherwise valid journal.
        continue;
      } else if (strict && entry?.kind !== 'result') {
        if (entry && typeof entry === 'object' && !Array.isArray(entry) && !Object.prototype.hasOwnProperty.call(entry, 'kind')) {
          const legacyAudit = validateLegacyInventoryAuditEntry(entry, {
            journalFile,
            lineNumber: index + 1,
            expectedSequence: nextLegacyAuditSequence,
            expectedPlanHash: legacyAuditPlanHash,
          });
          legacyAuditPlanHash ||= legacyAudit.planHash;
          nextLegacyAuditSequence = legacyAudit.nextSequence;
        } else {
          throw new Error(`INVENTORY_JOURNAL_INVALID_KIND:${journalFile}:${index + 1}:${entry?.kind || ''}`);
        }
      }
    } catch (error) {
      if (error?.message?.startsWith('INVENTORY_JOURNAL_')) throw error;
      throw new Error(`INVENTORY_JOURNAL_INVALID_LINE:${index + 1}`);
    }
  }
  return {intents, pending, terminalOutcomes, manualResolutions, fences, tombstonedIdempotencyKeys};
}

export async function readInventoryIntentJournals(journalFiles, {
  maxRunDate = '',
  allowMultiplePendingByScope = false,
} = {}) {
  const files = [...new Set((journalFiles || [])
    .map(file => String(file || '').trim())
    .filter(Boolean)
    .map(file => path.resolve(file)))];
  const records = [];
  const intents = new Map();
  const pending = new Map();
  const terminalOutcomes = new Map();
  const manualResolutions = new Map();
  const fences = new Map();
  const tombstonedIdempotencyKeys = new Map();
  const pendingByScope = new Map();
  const seenIntentIds = new Map();
  const intentById = new Map();
  for (const journalFile of files) {
    const journalDate = inventoryJournalDateFromFile(journalFile);
    if (journalDate && maxRunDate && journalDate > maxRunDate) {
      throw new Error(`INVENTORY_JOURNAL_FUTURE_DATE:${journalFile}:fileDate=${journalDate}:max=${maxRunDate}`);
    }
    const lifecycle = await readInventoryIntentLifecycle(journalFile, {strict: true, maxRunDate});
    const record = {journalFile, journalDate, ...lifecycle};
    records.push(record);
    for (const [intentId, rawIntent] of lifecycle.intents.entries()) {
      if (seenIntentIds.has(intentId)) {
        throw new Error(`INVENTORY_JOURNAL_CONFLICT:${journalFile}:duplicate_global_intentId=${intentId}:first=${seenIntentIds.get(intentId)}`);
      }
      seenIntentIds.set(intentId, journalFile);
      const intent = {...rawIntent, journalFile, journalDate: journalDate || rawIntent.runDate};
      const key = `${journalFile}\u0000${intentId}`;
      intents.set(key, intent);
      intentById.set(intentId, {key, intent});
      if (lifecycle.pending.has(intentId)) {
        pending.set(key, intent);
        const scopeKey = inventoryIntentScopeKey(intent);
        if (!pendingByScope.has(scopeKey)) pendingByScope.set(scopeKey, []);
        pendingByScope.get(scopeKey).push(intent);
      }
      const outcome = lifecycle.terminalOutcomes.get(intentId);
      if (outcome) terminalOutcomes.set(key, {...outcome, journalFile, journalDate: journalDate || rawIntent.runDate});
      if (outcome?.disposition === INVENTORY_OWNER_CONFIRMED_SAME_TARGET_SUPERSEDE_DISPOSITION && rawIntent.idempotencyKey) {
        if (tombstonedIdempotencyKeys.has(rawIntent.idempotencyKey)) {
          throw new Error(`INVENTORY_JOURNAL_TOMBSTONE_CONFLICT:${journalFile}:duplicate_global_idempotencyKey=${rawIntent.idempotencyKey}`);
        }
        tombstonedIdempotencyKeys.set(rawIntent.idempotencyKey, {key, intent, event: {...outcome, journalFile, journalDate: journalDate || rawIntent.runDate}});
      }
      const manualResolution = lifecycle.manualResolutions.get(intentId);
      if (manualResolution) {
        const recorded = manualResolution;
        manualResolutions.set(key, recorded);
        const scopeKey = recorded.scope?.scopeKey || inventoryWriteScopeKey(recorded.scope);
        if (fences.has(scopeKey)) {
          throw new Error(`INVENTORY_JOURNAL_FENCE_CONFLICT:${journalFile}:duplicate_global_scope=${scopeKey}`);
        }
        fences.set(scopeKey, {key, intent, event: recorded, journalFile, journalDate: journalDate || rawIntent.runDate});
        if (recorded.idempotencyKey) {
          if (tombstonedIdempotencyKeys.has(recorded.idempotencyKey)) {
            throw new Error(`INVENTORY_JOURNAL_TOMBSTONE_CONFLICT:${journalFile}:duplicate_global_idempotencyKey=${recorded.idempotencyKey}`);
          }
          tombstonedIdempotencyKeys.set(recorded.idempotencyKey, {key, intent, event: recorded});
        }
      }
    }
  }
  for (const [key, outcome] of terminalOutcomes.entries()) {
    if (outcome.disposition !== 'superseded_by_later_readback') continue;
    const olderIntent = intents.get(key);
    const referenced = intentById.get(outcome.supersededByIntentId);
    const fail = reason => {
      throw new Error(`INVENTORY_JOURNAL_SUPERSEDE_INVALID:${outcome.journalFile}:${outcome.intentId}:${reason}`);
    };
    if (!olderIntent || !referenced) fail('referencedIntentMissing');
    const {key: laterKey, intent: laterIntent} = referenced;
    if (inventoryIntentScopeKey(laterIntent) !== inventoryIntentScopeKey(olderIntent)) fail('scope');
    if (laterIntent.runDate !== outcome.supersededByRunDate || compareInventoryIntentChronology(laterIntent, olderIntent) <= 0) fail('runDate');
    const laterOutcome = terminalOutcomes.get(laterKey);
    if (laterOutcome?.disposition !== 'readback_matched') fail('laterDisposition');
    if (laterOutcome.recordedAt !== outcome.supersededByRecordedAt) fail('laterRecordedAt');
    const supersedeRecordedAtMs = new Date(outcome.recordedAt).getTime();
    const laterIntentsAtClosure = [...intentById.values()]
      .filter(({intent}) => (
        inventoryIntentScopeKey(intent) === inventoryIntentScopeKey(olderIntent)
        && compareInventoryIntentChronology(intent, olderIntent) > 0
        && new Date(intent.recordedAt).getTime() <= supersedeRecordedAtMs
      ))
      .map(({intent}) => intent);
    if (!laterIntentsAtClosure.length) fail('laterIntentMissingAtClosure');
    const latest = laterIntentsAtClosure.reduce((candidate, intent) => (
      compareInventoryIntentChronology(intent, candidate) > 0 ? intent : candidate
    ));
    const latestTies = laterIntentsAtClosure.filter(intent => compareInventoryIntentChronology(intent, latest) === 0);
    if (latestTies.length !== 1) fail('laterIntentAmbiguousAtClosure');
    if (latest.intentId !== laterIntent.intentId) fail('referencedIntentNotLatestAtClosure');
  }
  for (const [scopeKey, scopeIntents] of pendingByScope.entries()) {
    scopeIntents.sort((left, right) => (
      compareInventoryIntentChronology(left, right)
      || String(left.intentId || '').localeCompare(String(right.intentId || ''))
    ));
    if (!allowMultiplePendingByScope && scopeIntents.length > 1) {
      throw new Error(`INVENTORY_JOURNAL_PENDING_SCOPE_CONFLICT:${scopeKey}:${scopeIntents.map(intent => `${intent.journalFile}:${intent.intentId}`).join(',')}`);
    }
  }
  return {
    files,
    records,
    intents,
    pending,
    terminalOutcomes,
    manualResolutions,
    fences,
    tombstonedIdempotencyKeys,
    pendingByScope,
  };
}

export async function readPendingInventoryIntents(journalFile) {
  return (await readInventoryIntentLifecycle(journalFile)).pending;
}

export function findInventoryWriteFence(bundle, {scope = {}, idempotencyKey = ''} = {}) {
  const normalized = normalizeInventoryWriteScope(scope);
  const key = String(idempotencyKey || '').trim();
  const tombstone = bundle?.tombstonedIdempotencyKeys?.get(key);
  if (key && tombstone) {
    return {
      reason: 'idempotency_key_tombstoned',
      key,
      event: tombstone.event || tombstone,
      intent: tombstone.intent || null,
      scope: tombstone.event?.scope || null,
    };
  }
  for (const candidate of bundle?.fences?.values?.() || []) {
    const event = candidate?.event || candidate;
    if (inventoryWriteScopesOverlap(normalized, event?.scope || {})) {
      return {
        reason: 'exact_scope_manual_resolution_fence',
        key: event?.scope?.scopeKey || inventoryWriteScopeKey(event?.scope || {}),
        event,
        intent: candidate?.intent || null,
        scope: event?.scope || null,
      };
    }
  }
  return null;
}

function findPendingInventoryWriteConflict(bundle, {
  scope = {},
  idempotencyKey = '',
  requestPayloadHash = '',
  intentId = '',
  logicalActionKey = '',
} = {}) {
  const normalizedScope = normalizeInventoryWriteScope(scope);
  const incoming = {
    intentId: String(intentId || '').trim(),
    logicalActionKey: String(logicalActionKey || '').trim(),
    idempotencyKey: String(idempotencyKey || '').trim(),
    requestPayloadHash: String(requestPayloadHash || '').trim(),
  };
  for (const pending of bundle?.pending?.values?.() || []) {
    const existing = {
      intentId: String(pending?.intentId || '').trim(),
      logicalActionKey: String(pending?.logicalActionKey || '').trim(),
      idempotencyKey: String(pending?.idempotencyKey || '').trim(),
      requestPayloadHash: String(pending?.requestPayloadHash || '').trim(),
    };
    const sameCurrentIntent = incoming.intentId
      && incoming.intentId === existing.intentId
      && incoming.logicalActionKey === existing.logicalActionKey
      && incoming.idempotencyKey === existing.idempotencyKey
      && incoming.requestPayloadHash === existing.requestPayloadHash
      && !inventoryScopeFieldMismatch(normalizedScope, inventoryScopeFromIntent(pending));
    if (sameCurrentIntent) continue;
    if ((incoming.intentId && incoming.intentId === existing.intentId)
      || (incoming.logicalActionKey && incoming.logicalActionKey === existing.logicalActionKey)
      || (incoming.idempotencyKey && incoming.idempotencyKey === existing.idempotencyKey)
      || inventoryWriteScopesOverlap(normalizedScope, inventoryScopeFromIntent(pending))) {
      return pending;
    }
  }
  return null;
}

export function assertInventoryWriteAllowed(bundle, {
  scope = {},
  idempotencyKey = '',
  requestPayloadHash = '',
  intentId = '',
  logicalActionKey = '',
} = {}) {
  const fence = findInventoryWriteFence(bundle, {scope, idempotencyKey});
  if (fence) {
    const event = fence.event || {};
    const error = new Error(
      `INVENTORY_WRITE_FENCED:${fence.reason}:scope=${event.scope?.scopeKey || ''}:intentId=${event.intentId || ''}`,
    );
    error.code = 'INVENTORY_WRITE_FENCED';
    error.fenceReason = fence.reason;
    error.fence = fence;
    error.requestPayloadHash = String(requestPayloadHash || '');
    throw error;
  }
  const pending = findPendingInventoryWriteConflict(bundle, {
    scope, idempotencyKey, requestPayloadHash, intentId, logicalActionKey,
  });
  if (pending) {
    const error = new Error(
      `INVENTORY_WRITE_PENDING_CONFLICT:intentId=${pending.intentId || ''}:logicalActionKey=${pending.logicalActionKey || ''}`,
    );
    error.code = 'INVENTORY_WRITE_PENDING_CONFLICT';
    error.pendingIntent = pending;
    throw error;
  }
  return {allowed: true, fence: null};
}

export function classifyRecoveredInventoryIntent(intent, currentUsableInventory) {
  if (!intent?.logicalActionKey) throw new Error('durable inventory intent is missing logicalActionKey');
  const target = Number(intent.targetUsableInventory);
  const current = Number(currentUsableInventory);
  if (!Number.isFinite(current) || !Number.isInteger(target)) throw new Error('durable inventory recovery inventory is invalid');
  return current === target ? 'readback_matched' : 'submitted_but_readback_pending';
}

export async function submitDurableInventoryWriteOnce({
  journalFile,
  intent,
  prepareUnderLock = null,
  submit,
  readback,
  wait = async () => {},
  maxReadbackAttempts = 10,
  fenceBundle = null,
  readFenceBundle = null,
  inventoryScope = null,
  assertInventoryAdmission = null,
  inventoryCutoverLock = inventoryCutoverLockFile(),
} = {}) {
  if (!journalFile || typeof submit !== 'function' || typeof readback !== 'function') {
    throw new Error('invalid durable inventory submission arguments');
  }
  if (!Number.isInteger(maxReadbackAttempts) || maxReadbackAttempts < 1) throw new Error('invalid maxReadbackAttempts');
  let prepared = {intent, fenceBundle, inventoryScope, assertInventoryAdmission};
  const assertFence = async current => {
    const bundle = typeof readFenceBundle === 'function'
      ? await readFenceBundle()
      : current.fenceBundle;
    if (!bundle) return;
    assertInventoryWriteAllowed(bundle, {
      scope: current.inventoryScope || inventoryScopeFromIntent(current.intent),
      idempotencyKey: current.intent.idempotencyKey,
      requestPayloadHash: current.intent.requestPayloadHash,
      intentId: current.intent.intentId,
      logicalActionKey: current.intent.logicalActionKey,
    });
  };
  // The writer itself is a second fence behind the public OpenAPI client. It
  // prevents an alternate submit callback from appending/submitting when a
  // caller has already supplied a fresh aggregate containing a manual fence.
  const dispatchOnce = async () => {
    if (typeof prepareUnderLock === 'function') {
      prepared = {...prepared, ...(await prepareUnderLock({journalFile, intent: prepared.intent, inventoryScope: prepared.inventoryScope}) || {})};
    }
    if (!prepared.intent?.intentId || !prepared.intent?.logicalActionKey) throw new Error('invalid durable inventory submission arguments');
    const currentIsInventoryV2 = String(prepared.intent?.request?.method || 'POST').toUpperCase() === 'POST'
      && String(prepared.intent?.request?.pathname || '') === '/open-api/stock/change-inventory/v2';
    if (currentIsInventoryV2 && typeof prepared.assertInventoryAdmission !== 'function') {
      const error = new Error('INVENTORY_WRITE_ADMISSION_REQUIRED:durable v2 submission requires fresh cutover/domain admission before intent append');
      error.code = 'INVENTORY_WRITE_ADMISSION_REQUIRED';
      throw error;
    }
    if (currentIsInventoryV2) await prepared.assertInventoryAdmission();
    await assertFence(prepared);
    await appendDurableJournalRecord(journalFile, prepared.intent);
    try {
      await assertFence(prepared);
      return await submit(prepared);
    } catch (error) {
      error.inventoryIntentDurable = true;
      throw error;
    }
  };
  // The global cutover lock protects only admission -> durable intent fsync ->
  // the single transport response. Authoritative readbacks happen after the
  // lock is released so a slow stock query cannot block resolver/cutover work.
  const initialIsInventoryV2 = String(intent?.request?.method || 'POST').toUpperCase() === 'POST'
    && String(intent?.request?.pathname || '') === '/open-api/stock/change-inventory/v2';
  const response = initialIsInventoryV2 || typeof prepareUnderLock === 'function'
    ? await withInventoryCutoverLock(dispatchOnce, {
      lockFile: inventoryCutoverLock,
      timeoutCode: 'INVENTORY_WRITE_CUTOVER_LOCK_TIMEOUT',
    })
    : await dispatchOnce();
  const responseCode = response?.data?.code;
  const responseCodeIsScalar = typeof responseCode === 'string'
    || (typeof responseCode === 'number' && Number.isFinite(responseCode));
  const normalizedResponseCode = responseCodeIsScalar ? String(responseCode).trim() : '';
  const hasExplicitCode = normalizedResponseCode !== '';
  const httpStatus = Number(response?.status);
  const httpOk = response?.ok !== false
    && Number.isInteger(httpStatus)
    && httpStatus >= 200
    && httpStatus < 300;
  const businessSuccess = response?.data?.info?.success;
  const currentIntent = prepared.intent;
  if (httpOk && hasExplicitCode && normalizedResponseCode !== '0') {
    await appendDurableJournalRecord(journalFile, {
      kind: 'write_outcome',
      intentId: currentIntent.intentId,
      logicalActionKey: currentIntent.logicalActionKey,
      disposition: 'rejected',
      recordedAt: new Date().toISOString(),
      code: response?.data?.code,
      httpOk: true,
      httpStatus,
      success: false,
    });
    return {state: 'rejected', response, after: null, readbackAttempts: 0};
  }
  if (!httpOk || !hasExplicitCode || normalizedResponseCode !== '0' || businessSuccess === false) {
    return {state: 'ambiguous_response', response, after: null, readbackAttempts: 0};
  }
  let after = null;
  for (let attempt = 1; attempt <= maxReadbackAttempts; attempt += 1) {
    if (attempt > 1) await wait(attempt);
    try {
      after = await readback(attempt, prepared);
    } catch (error) {
      error.inventoryIntentDurable = true;
      throw error;
    }
    if (after?.ok === true
      && Number(after?.totalUsableInventory) === Number(currentIntent.targetUsableInventory)) {
      await appendDurableJournalRecord(journalFile, {
        kind: 'write_outcome',
        intentId: currentIntent.intentId,
        logicalActionKey: currentIntent.logicalActionKey,
        disposition: 'readback_matched',
        recordedAt: new Date().toISOString(),
      });
      return {state: 'readback_matched', response, after, readbackAttempts: attempt};
    }
  }
  return {state: 'submitted_but_readback_pending', response, after, readbackAttempts: maxReadbackAttempts};
}
