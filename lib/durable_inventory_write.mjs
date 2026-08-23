import fs from 'node:fs/promises';
import path from 'node:path';
import {
  computeInventoryOverwriteQuantity,
  computeLegacyInventoryOverwriteQuantity,
  INVENTORY_LEGACY_UNVERSIONED_CUTOFF_DATE,
  INVENTORY_OVERWRITE_COMPUTATION_VERSION,
  stableInventoryHash,
} from './inventory_replenishment_policy.mjs';

const INVENTORY_JOURNAL_FILE_RE = /^daily-inventory-replenishment-(\d{4}-\d{2}-\d{2})\.json\.journal\.ndjson$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP_WITH_ZONE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const INVENTORY_JOURNAL_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
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
const INVENTORY_TERMINAL_DISPOSITIONS = new Set([
  'rejected',
  'readback_matched',
  'superseded_by_later_readback',
]);

function normalizedScopeValue(value, {upper = false} = {}) {
  const text = String(value ?? '').trim();
  return upper ? text.toUpperCase() : text;
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
  return stableInventoryHash({
    store: normalizedScopeValue(storeKey, {upper: true}),
    skc: normalizedScopeValue(skc),
    sku: normalizedScopeValue(skuCode),
    actionType: 'VI_OVERWRITE_TO_EXACT_USABLE_TARGET',
    invType: 'VI',
  });
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

export function inventoryJournalDateFromFile(journalFile) {
  const match = INVENTORY_JOURNAL_FILE_RE.exec(path.basename(String(journalFile || '')));
  return match?.[1] || '';
}

export async function discoverInventoryJournalFiles(currentJournalFile, {includeAll = false} = {}) {
  const current = path.resolve(String(currentJournalFile || ''));
  const directory = path.dirname(current);
  let names = [];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const candidates = names
    .filter(name => name.endsWith('.journal.ndjson'))
    .filter(name => includeAll || INVENTORY_JOURNAL_FILE_RE.test(name))
    .map(name => path.join(directory, name));
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
  const legacyScopeKey = legacyInventoryRecoveryScopeKey(intent);
  if (intent.recoveryScopeKey && ![expectedScopeKey, legacyScopeKey].includes(intent.recoveryScopeKey)) {
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
  const warehouseCodeIsValid = before?.stockRowMissing === true
    ? hasWarehouseCode && typeof requestRow?.warehouseCode === 'string' && requestRow.warehouseCode.trim() !== ''
    : !hasWarehouseCode;
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
    if (!isValidIsoDate(entry.supersededByRunDate) || entry.supersededByRunDate <= intent.runDate) supersedeFail('supersededByRunDate');
    if (!isValidTimestamp(entry.supersededByRecordedAt)) supersedeFail('supersededByRecordedAt');
    if (new Date(entry.recordedAt).getTime() < new Date(entry.supersededByRecordedAt).getTime()) supersedeFail('recordedAtOrder');
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

export async function appendDurableJournalRecord(journalFile, entry) {
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

export async function readInventoryIntentLifecycle(journalFile, {strict = false, maxRunDate = ''} = {}) {
  const intents = new Map();
  const pending = new Map();
  const terminalOutcomes = new Map();
  const journalDate = inventoryJournalDateFromFile(journalFile);
  let text = '';
  try {
    text = await fs.readFile(journalFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return {intents, pending, terminalOutcomes};
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
          validateInventoryTerminalOutcome(entry, intent, {journalFile, lineNumber: index + 1});
        }
        if (entry?.intentId && INVENTORY_TERMINAL_DISPOSITIONS.has(entry?.disposition)) {
          pending.delete(entry.intentId);
          terminalOutcomes.set(entry.intentId, entry);
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
  return {intents, pending, terminalOutcomes};
}

export async function readInventoryIntentJournals(journalFiles, {maxRunDate = ''} = {}) {
  const files = [...new Set((journalFiles || [])
    .map(file => String(file || '').trim())
    .filter(Boolean)
    .map(file => path.resolve(file)))];
  const records = [];
  const intents = new Map();
  const pending = new Map();
  const terminalOutcomes = new Map();
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
    if (laterIntent.runDate !== outcome.supersededByRunDate || laterIntent.runDate <= olderIntent.runDate) fail('runDate');
    const laterOutcome = terminalOutcomes.get(laterKey);
    if (laterOutcome?.disposition !== 'readback_matched') fail('laterDisposition');
    if (laterOutcome.recordedAt !== outcome.supersededByRecordedAt) fail('laterRecordedAt');
    const strictlyLaterIntents = [...intents.values()].filter(intent => (
      inventoryIntentScopeKey(intent) === inventoryIntentScopeKey(olderIntent)
      && intent.runDate > olderIntent.runDate
    ));
    if (strictlyLaterIntents.length !== 1 || strictlyLaterIntents[0].intentId !== laterIntent.intentId) fail('laterIntentAmbiguous');
  }
  for (const [scopeKey, scopeIntents] of pendingByScope.entries()) {
    if (scopeIntents.length > 1) {
      throw new Error(`INVENTORY_JOURNAL_PENDING_SCOPE_CONFLICT:${scopeKey}:${scopeIntents.map(intent => `${intent.journalFile}:${intent.intentId}`).join(',')}`);
    }
  }
  return {files, records, intents, pending, terminalOutcomes, pendingByScope};
}

export async function readPendingInventoryIntents(journalFile) {
  return (await readInventoryIntentLifecycle(journalFile)).pending;
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
  submit,
  readback,
  wait = async () => {},
  maxReadbackAttempts = 10,
} = {}) {
  if (!journalFile || !intent?.intentId || !intent?.logicalActionKey || typeof submit !== 'function' || typeof readback !== 'function') {
    throw new Error('invalid durable inventory submission arguments');
  }
  if (!Number.isInteger(maxReadbackAttempts) || maxReadbackAttempts < 1) throw new Error('invalid maxReadbackAttempts');
  await appendDurableJournalRecord(journalFile, intent);
  let response;
  try {
    response = await submit();
  } catch (error) {
    error.inventoryIntentDurable = true;
    throw error;
  }
  const responseCode = response?.data?.code;
  const responseCodeIsScalar = typeof responseCode === 'string'
    || (typeof responseCode === 'number' && Number.isFinite(responseCode));
  const normalizedResponseCode = responseCodeIsScalar ? String(responseCode).trim() : '';
  const hasExplicitCode = normalizedResponseCode !== '';
  const httpStatus = Number(response?.status);
  const httpOk = response?.ok === true
    && Number.isInteger(httpStatus)
    && httpStatus >= 200
    && httpStatus < 300;
  const businessSuccess = response?.data?.info?.success;
  if (httpOk && hasExplicitCode && normalizedResponseCode !== '0' && businessSuccess === false) {
    await appendDurableJournalRecord(journalFile, {
      kind: 'write_outcome',
      intentId: intent.intentId,
      logicalActionKey: intent.logicalActionKey,
      disposition: 'rejected',
      recordedAt: new Date().toISOString(),
      code: response?.data?.code,
      httpOk: true,
      httpStatus,
      success: false,
    });
    return {state: 'rejected', response, after: null, readbackAttempts: 0};
  }
  if (!httpOk || !hasExplicitCode || normalizedResponseCode !== '0' || businessSuccess !== true) {
    return {state: 'ambiguous_response', response, after: null, readbackAttempts: 0};
  }
  let after = null;
  for (let attempt = 1; attempt <= maxReadbackAttempts; attempt += 1) {
    if (attempt > 1) await wait(attempt);
    try {
      after = await readback(attempt);
    } catch (error) {
      error.inventoryIntentDurable = true;
      throw error;
    }
    if (Number(after?.totalUsableInventory) === Number(intent.targetUsableInventory)) {
      await appendDurableJournalRecord(journalFile, {
        kind: 'write_outcome',
        intentId: intent.intentId,
        logicalActionKey: intent.logicalActionKey,
        disposition: 'readback_matched',
        recordedAt: new Date().toISOString(),
      });
      return {state: 'readback_matched', response, after, readbackAttempts: attempt};
    }
  }
  return {state: 'submitted_but_readback_pending', response, after, readbackAttempts: maxReadbackAttempts};
}
