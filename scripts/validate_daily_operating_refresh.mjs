#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  discoverInventoryJournalFiles,
  findInventoryWriteFence,
  isForeignInventoryIntent,
  isInventoryPreSubmitExclusion,
  INVENTORY_OWNER_CONFIRMED_SAME_TARGET_SUPERSEDE_DISPOSITION,
  inventoryIntentScopeKey,
  inventoryScopeFromIntent,
  inventoryLogicalActionKey,
  inventoryRecoveryScopeKey,
  readInventoryIntentLifecycle,
  readInventoryIntentJournals,
} from '../lib/durable_inventory_write.mjs';
import {inventoryDetailRefreshWindow} from '../lib/inventory_detail_refresh_window.mjs';
import {buildDailyInventoryPlanHashPayload, normalizeInventoryOccupancy, stableInventoryHash} from '../lib/inventory_replenishment_policy.mjs';
import {
  resolveResultEvidenceArtifact,
  readDailyInventoryVersionIndex,
} from './inventory/daily_inventory_version_publisher.mjs';

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOMAINS = Object.freeze(['shein_business_domains', 'shein_links']);

function parseArgs(argv) {
  const args = {
    root: process.env.SHEIN_BI_ROOT || SCRIPT_ROOT,
    markerRoot: process.env.SHEIN_BI_PIPELINE_MARKER_ROOT || '',
    stateDir: process.env.SHEIN_BI_MORNING_CHAIN_STATE_DIR || '',
    inventoryRuntimeRoot: process.env.SHEIN_BI_INVENTORY_RUNTIME_ROOT || '/srv/shein-bi/runtime/daily-inventory-replenishment',
    runDate: '',
    businessDate: '',
    inventoryOnly: false,
    allowItemFencedWarning: false,
    preWarningAudit: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`missing value for ${token}`);
      return argv[index];
    };
    if (token === '--root') args.root = next();
    else if (token === '--marker-root') args.markerRoot = next();
    else if (token === '--state-dir') args.stateDir = next();
    else if (token === '--inventory-runtime-root') args.inventoryRuntimeRoot = next();
    else if (token === '--run-date') args.runDate = next();
    else if (token === '--business-date') args.businessDate = next();
    else if (token === '--inventory-only') args.inventoryOnly = true;
    else if (token === '--allow-item-fenced-warning' || token === '--allow-same-day-pending-warning') args.allowItemFencedWarning = true;
    else if (token === '--pre-warning-audit') args.preWarningAudit = true;
    else throw new Error(`unknown argument: ${token}`);
  }
  args.root = path.resolve(args.root);
  args.markerRoot = path.resolve(args.markerRoot || path.join(args.root, 'state', 'pipeline-markers'));
  args.stateDir = path.resolve(args.stateDir || path.join(args.root, 'state', 'cloud_morning_chain'));
  args.inventoryRuntimeRoot = path.resolve(args.inventoryRuntimeRoot);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.runDate) || !/^\d{4}-\d{2}-\d{2}$/.test(args.businessDate)) {
    throw new Error('runDate and businessDate must be YYYY-MM-DD');
  }
  const previous = new Date(`${args.runDate}T12:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  if (args.businessDate !== previous.toISOString().slice(0, 10)) throw new Error('businessDate must equal runDate minus one calendar day');
  return args;
}

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const fileHash = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
const rowKey = row => `${String(row?.storeKey || '').toUpperCase()}::${String(row?.skc || '')}::${String(row?.skuCode || '')}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function discoverInventoryJournalAuditFiles(currentJournal, environment = process.env) {
  const additionalDirectories = String(environment.SHEIN_BI_INVENTORY_JOURNAL_DIRS || '')
    .split(path.delimiter)
    .map(directory => directory.trim())
    .filter(Boolean);
  return discoverInventoryJournalFiles(currentJournal, {
    includeAll: true,
    additionalDirectories,
  });
}

async function readInventoryValidationLifecycle(journalFiles, {currentJournal, maxRunDate, journalSnapshots = new Map()}) {
  return await readInventoryIntentJournals(journalFiles, {
    maxRunDate,
    journalSnapshots,
    currentJournalFile: currentJournal,
    quarantineHistoricalDanglingSupersedes: true,
  });
}

function storedPath(root, value) {
  const candidate = String(value || '');
  return path.resolve(path.isAbsolute(candidate) ? candidate : path.join(root, candidate));
}

async function verifyEvidenceRecords(entries, expectedFiles, root, label) {
  assert(Array.isArray(entries), `${label} evidence is not an array`);
  const expected = expectedFiles.map(file => path.resolve(file)).sort();
  const actual = entries.map(entry => storedPath(root, entry?.path)).sort();
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} evidence path set mismatch`);
  for (const entry of entries) {
    const file = storedPath(root, entry.snapshotPath || entry.path);
    const stat = await fs.lstat(file);
    assert(stat.isFile() && !stat.isSymbolicLink(), `${label} evidence is not a regular file: ${file}`);
    const actualHash = await fileHash(file);
    assert(Number(entry.bytes) === stat.size, `${label} evidence size mismatch: ${file}`);
    assert(String(entry.sha256 || '') === actualHash, `${label} evidence hash mismatch: ${file}`);
  }
}

async function validateMorningEvidence({root, businessDate, file, enabledStores, evidenceRecord}) {
  const document = await readJson(evidenceRecord?.snapshotPath || file);
  assert(document?.schemaVersion === 'shein-morning-resume-evidence/v1', 'morning evidence schema mismatch');
  assert(document?.ok === true && document?.date === businessDate, 'morning evidence date/status mismatch');
  assert(document?.expectedStoreCount === 19, 'morning evidence expectedStoreCount must be 19');
  assert(document?.artifactCount === 38, 'morning evidence artifactCount must be 38');
  const stores = [...new Set((document?.stores || []).map(value => String(value).toUpperCase()))].sort();
  assert(JSON.stringify(stores) === JSON.stringify(enabledStores), 'morning evidence 19-store set mismatch');
  assert(JSON.stringify([...(document?.domains || [])].sort()) === JSON.stringify([...DOMAINS]), 'morning evidence domain set mismatch');
  const artifacts = Array.isArray(document?.artifacts) ? document.artifacts : [];
  assert(artifacts.length === 38, 'morning evidence must contain 38 store/domain artifacts');
  const seen = new Set();
  for (const artifact of artifacts) {
    const storeKey = String(artifact?.storeKey || '').toUpperCase();
    const domain = String(artifact?.domain || '');
    const key = `${storeKey}::${domain}`;
    assert(enabledStores.includes(storeKey) && DOMAINS.includes(domain) && !seen.has(key), `morning evidence duplicate/unknown artifact: ${key}`);
    seen.add(key);
    const expected = path.resolve(root, 'outputs', domain, storeKey, `${businessDate}.json`);
    const actual = storedPath(root, artifact?.path);
    assert(actual === expected, `morning evidence artifact path mismatch: ${key}`);
    const saved = evidenceRecord?.dependencies?.find(entry => storedPath(root, entry.path) === actual);
    if (evidenceRecord?.snapshotPath) assert(saved?.snapshotPath && saved.sha256 === artifact.sha256
      && saved.bytes === artifact.bytes, `morning evidence snapshot closure missing: ${key}`);
    const source = saved?.snapshotPath || actual;
    const stat = await fs.lstat(source);
    assert(stat.isFile() && !stat.isSymbolicLink(), `morning evidence artifact is not a regular file: ${key}`);
    assert(Number(artifact.bytes) === stat.size, `morning evidence artifact size mismatch: ${key}`);
    assert(String(artifact.sha256 || '') === await fileHash(source), `morning evidence artifact hash mismatch: ${key}`);
    const payload = await readJson(source);
    assert(payload?.ok === true && payload?.date === businessDate, `morning evidence payload date/status mismatch: ${key}`);
    assert(String(payload?.store?.storeKey || '').toUpperCase() === storeKey, `morning evidence payload store mismatch: ${key}`);
  }
  assert(seen.size === 38, 'morning evidence store/domain coverage is incomplete');
}

function expectedPlanHash(plan) {
  return stableInventoryHash(buildDailyInventoryPlanHashPayload(plan));
}

function expectedInventoryLogicalActionKey(planRow, plan, result) {
  return inventoryLogicalActionKey({
    commandId: plan.commandId || '',
    runDate: plan.date,
    storeKey: planRow.storeKey,
    skc: planRow.skc,
    skuCode: planRow.skuCode,
    targetUsableInventory: Number(planRow.targetUsableInventory),
    policyVersion: plan.policyVersion,
    authorizationId: result.authorizationId || '',
  });
}

function isWarningMarker(marker, stage, runDate, businessDate) {
  return marker?.ok === true
    && marker?.stage === stage
    && marker?.status === 'warning'
    && marker?.runDate === runDate
    && marker?.businessDate === businessDate;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sameDayPendingWarningAudit(row, planRow, plan, result, {
  allowItemFencedWarning = false,
  warningMarkersAreValid = false,
  lifecycle = null,
  currentJournal = '',
} = {}) {
  const fail = reason => ({ok: false, reason});
  if (!row || !planRow) return fail('result row identity is not bound to the current plan');
  if (!allowItemFencedWarning) return fail('strict mode does not allow same-day pending warning');
  if (!warningMarkersAreValid) return fail('requires same-day warning markers with verified evidence');
  // The executor uses null/false to describe an unfinished response.  Only an
  // explicit true is a completion claim; do not turn an unknown response into
  // a successful inventory result.
  if (result.ok === true) return fail('pending result claims successful completion');
  if (row.historicalPending === true || row.disposition !== undefined) {
    return fail('same-day pending row has historical or terminal disposition metadata');
  }
  for (const field of ['terminalIntentId', 'terminalDisposition', 'terminalRecordedAt', 'terminalOutcome']) {
    if (row[field] !== undefined && row[field] !== null && row[field] !== '') {
      return fail(`same-day pending row has terminal metadata: ${field}`);
    }
  }
  for (const field of ['retry', 'duplicate']) {
    if (row[field] === true) return fail(`same-day pending row records ${field}`);
  }
  for (const field of ['attempts', 'retryCount']) {
    if (row[field] !== undefined && Number(row[field]) > 1) return fail(`same-day pending row records ${field}`);
  }

  const target = Number(planRow.targetUsableInventory);
  const logicalActionKey = expectedInventoryLogicalActionKey(planRow, plan, result);
  if (row.logicalActionKey !== logicalActionKey) return fail('logicalActionKey drift');
  if (row.planHash !== undefined && row.planHash !== result.planHash) return fail('result planHash drift');
  if (row.runDate !== undefined && row.runDate !== plan.date) return fail('result runDate drift');
  if (row.after && Number(row.after.totalUsableInventory) === target) return fail('pending row claims target readback');

  const writes = Array.isArray(row.writes) ? row.writes : [];
  if (writes.length !== 1) return fail('requires exactly one write attempt');
  const write = writes[0];
  if (write?.attempt !== 1) return fail('write retry or duplicate attempt detected');
  if (String(write?.code ?? '').trim() !== '0') return fail('response code is not 0');
  if (write?.success !== null) return fail('response success is confirmed or missing');
  const expectedIdempotencyKey = `bi-inv-${logicalActionKey.slice(0, 42)}`;
  if (write?.idempotencyKey !== expectedIdempotencyKey) return fail('idempotencyKey drift');
  if (row.idempotencyKey !== undefined && row.idempotencyKey !== expectedIdempotencyKey) return fail('result idempotencyKey drift');
  if (!isObject(write?.request)) return fail('write request is missing');
  if (write.requestPayloadHash !== stableInventoryHash(write.request)) return fail('write request hash drift');
  if (row.requestPayloadHash !== undefined && row.requestPayloadHash !== write.requestPayloadHash) return fail('result request hash drift');
  const requestRow = write.request?.body?.updateSkuInventoryQuantityRequests?.[0];
  if (write.request.pathname !== '/open-api/stock/change-inventory/v2'
    || write.request.method !== 'POST'
    || !Array.isArray(write.request?.body?.updateSkuInventoryQuantityRequests)
    || write.request.body.updateSkuInventoryQuantityRequests.length !== 1
    || !isObject(requestRow)
    || requestRow.idempotencyKey !== expectedIdempotencyKey
    || requestRow.skuCode !== planRow.skuCode
    || requestRow.invType !== 'VI'
    || requestRow.changeType !== 'OVERWRITE'
    || write.request.headers?.language !== 'en'
    || Object.keys(write.request.headers || {}).length !== 1
    || Number(write.overwrite) !== Number(requestRow.changeQuantity)) {
    return fail('write request scope or payload drift');
  }
  if (!isObject(row.before)) return fail('result before snapshot is missing');

  if (!lifecycle || !currentJournal) return fail('durable journal audit is unavailable');
  const allLogicalMatches = [...lifecycle.intents.entries()].filter(([, intent]) => (
    intent?.runDate === plan.date && intent?.logicalActionKey === logicalActionKey
  ));
  const currentScopeMatches = allLogicalMatches.filter(([, intent]) => (
    intent?.journalFile === currentJournal
      && String(intent?.storeKey || '').toUpperCase() === String(planRow.storeKey || '').toUpperCase()
      && intent?.skc === planRow.skc
      && intent?.skuCode === planRow.skuCode
      && Number(intent?.targetUsableInventory) === target
  ));
  if (allLogicalMatches.length !== 1 || currentScopeMatches.length !== 1) {
    return fail(allLogicalMatches.length === 0
      ? 'durable journal intent is missing'
      : 'durable journal scope or current-journal binding drift');
  }
  const [intentKey, intent] = currentScopeMatches[0];
  const outcome = lifecycle.terminalOutcomes.get(intentKey);
  if (outcome || lifecycle.manualResolutions.has(intentKey)) return fail('durable journal has a terminal outcome');
  if (!lifecycle.pending.has(intentKey)) return fail('durable journal intent is not pending');
  const tombstone = lifecycle.tombstonedIdempotencyKeys?.get(intent.idempotencyKey);
  if (tombstone && tombstone.intent?.intentId !== intent.intentId) return fail('durable journal idempotency key is tombstoned');
  if (intent.planHash !== plan.payloadHash || intent.planHash !== result.planHash) return fail('durable journal planHash drift');
  if (intent.runDate !== plan.date) return fail('durable journal date drift');
  if (intent.storeKey !== planRow.storeKey || intent.skc !== planRow.skc || intent.skuCode !== planRow.skuCode) {
    return fail('durable journal scope drift');
  }
  if (Number(intent.targetUsableInventory) !== target) return fail('durable journal target drift');
  if (intent.policyVersion !== plan.policyVersion || intent.authorizationId !== result.authorizationId) {
    return fail('durable journal authorization or policy drift');
  }
  if (intent.idempotencyKey !== expectedIdempotencyKey || intent.idempotencyKey !== write.idempotencyKey) {
    return fail('durable journal idempotency binding drift');
  }
  if (intent.requestPayloadHash !== write.requestPayloadHash
    || !isObject(intent.request)
    || stableInventoryHash(intent.request) !== write.requestPayloadHash) {
    return fail('durable journal request hash binding drift');
  }
  if (stableInventoryHash(intent.request) !== stableInventoryHash(write.request)) return fail('durable journal request binding drift');
  if (stableInventoryHash(intent.before) !== stableInventoryHash(row.before)) return fail('durable journal before-scope binding drift');
  return {ok: true, intent, intentKey, write};
}

function updatedReadbackAudit(row, planRow, plan, result, {
  lifecycle = null,
  currentJournal = '',
} = {}) {
  const fail = reason => ({ok: false, reason});
  if (!row || !planRow) return fail('result row identity is not bound to the current plan');
  if (!lifecycle || !currentJournal) return fail('durable journal audit is unavailable');
  const logicalActionKey = expectedInventoryLogicalActionKey(planRow, plan, result);
  const target = Number(planRow.targetUsableInventory);
  const candidates = [...lifecycle.intents.entries()].filter(([, intent]) => (
    intent?.journalFile === currentJournal
      && intent?.runDate === plan.date
      && intent?.logicalActionKey === logicalActionKey
      && String(intent?.storeKey || '').toUpperCase() === String(planRow.storeKey || '').toUpperCase()
      && intent?.skc === planRow.skc
      && intent?.skuCode === planRow.skuCode
      && Number(intent?.targetUsableInventory) === target
  ));
  if (candidates.length !== 1) {
    return fail(candidates.length === 0
      ? 'updated readback durable journal intent is missing'
      : 'updated readback requires one unique current-journal intent');
  }
  const [intentKey, intent] = candidates[0];
  const outcome = lifecycle.terminalOutcomes.get(intentKey);
  if (!outcome || outcome.disposition !== 'readback_matched') {
    return fail('updated readback lacks a unique readback_matched terminal outcome');
  }
  const matchingOutcomes = [...lifecycle.terminalOutcomes.entries()].filter(([key, event]) => (
    key === intentKey
      && event?.intentId === intent.intentId
      && event?.logicalActionKey === logicalActionKey
      && event?.disposition === 'readback_matched'
  ));
  if (matchingOutcomes.length !== 1) return fail('updated readback terminal outcome is not unique');
  if (lifecycle.pending.has(intentKey) || lifecycle.manualResolutions.has(intentKey)) {
    return fail('updated readback intent is not terminal in the current journal');
  }
  const writes = Array.isArray(row.writes) ? row.writes : [];
  if (writes.length !== 1) return fail('updated readback requires exactly one write attempt');
  const write = writes[0];
  if (intent.planHash !== plan.payloadHash
    || intent.policyVersion !== plan.policyVersion
    || intent.authorizationId !== result.authorizationId
    || intent.storeKey !== planRow.storeKey
    || intent.skc !== planRow.skc
    || intent.skuCode !== planRow.skuCode
    || Number(intent.targetUsableInventory) !== target
    || intent.logicalActionKey !== logicalActionKey) {
    return fail('updated readback intent scope or plan binding drift');
  }
  if (intent.idempotencyKey !== write?.idempotencyKey
    || intent.requestPayloadHash !== write?.requestPayloadHash
    || !isObject(intent.request)
    || !isObject(write?.request)
    || stableInventoryHash(intent.request) !== stableInventoryHash(write.request)
    || stableInventoryHash(intent.request) !== intent.requestPayloadHash) {
    return fail('updated readback request binding drift');
  }
  if (stableInventoryHash(intent.before) !== stableInventoryHash(row.before)) {
    return fail('updated readback before-scope binding drift');
  }
  for (const field of ['intentId', 'terminalIntentId', 'readbackIntentId']) {
    if (row[field] !== undefined && row[field] !== null && String(row[field]) !== intent.intentId) {
      return fail(`updated readback ${field} binding drift`);
    }
  }
  if (row.terminalDisposition !== undefined && row.terminalDisposition !== 'readback_matched') {
    return fail('updated readback terminal disposition drift');
  }
  return {ok: true, intent, intentKey, outcome};
}

async function validatePlanSourceEvidence(plan, enabledStores, policy, referenceTime = Date.now(), evidenceRoot = process.cwd(), {validateExternalFiles = true, validateFreshness = true, sourceSnapshots = new Map()} = {}) {
  const originalPath = file => path.isAbsolute(String(file || ''))
    ? path.resolve(file)
    : path.resolve(evidenceRoot, String(file || ''));
  const evidencePath = file => sourceSnapshots.get(originalPath(file)) || originalPath(file);
  const evidence = Array.isArray(plan?.sourceEvidence) ? plan.sourceEvidence : [];
  const et = evidence.filter(row => row?.store === 'ET');
  const links = evidence.filter(row => row?.store === 'BI_LINKS');
  const openApi = evidence.filter(row => enabledStores.includes(String(row?.store || '').toUpperCase()));
  const detailClosure = evidence.filter(row => row?.store === 'DETAIL_MANIFEST');
  assert(et.length === 1 && links.length === 1 && openApi.length === 19, 'inventory plan sourceEvidence must contain ET, BI_LINKS and 19 unique OpenAPI stores');
  assert(new Set(openApi.map(row => String(row.store).toUpperCase())).size === 19, 'inventory plan OpenAPI sourceEvidence store set is duplicate/incomplete');
  assert(Number(et[0].totalEtRows) > 0 && Number(et[0].matchedCurrentDayEtRows) > 0, 'inventory plan ET sourceEvidence has no matched current-day rows');
  const now = Number(referenceTime);
  assert(Number.isFinite(now), 'inventory plan sourceEvidence reference time is invalid');
  for (const row of evidence) {
    const fetchedAt = Date.parse(String(row?.fetchedAt || ''));
    assert(Number.isFinite(fetchedAt) && fetchedAt <= now + 15 * 60_000, `inventory plan sourceEvidence timestamp invalid: ${row?.store || ''}`);
    const maxHours = row.store === 'ET'
      ? Number(policy.maxBiSnapshotAgeHours || 4)
      : row.store === 'BI_LINKS'
        ? Number(plan?.executionConstraints?.decreaseOnly ? policy?.lowEtFastGuard?.maxLinksSnapshotAgeHours || policy.maxLinksSnapshotAgeHours || 4 : policy.maxLinksSnapshotAgeHours || 4)
        : Number(policy.maxOpenApiSnapshotAgeHours || 2);
    if (validateFreshness) assert((now - fetchedAt) / 3_600_000 <= maxHours, `inventory plan sourceEvidence is stale: ${row?.store || ''}`);
    assert(typeof row.file === 'string' && row.file.length > 0, `inventory plan sourceEvidence file missing: ${row?.store || ''}`);
  }
  for (const row of openApi) {
    assert(Number(row.stockFailedChunkCount) === 0, `inventory plan OpenAPI source has failed stock chunks: ${row.store}`);
    assert(/^[a-f0-9]{64}$/i.test(String(row.sha256 || '')), `inventory plan OpenAPI source hash missing: ${row.store}`);
    if (validateExternalFiles) assert(String(row.sha256).toLowerCase() === await fileHash(evidencePath(row.file)), `inventory plan OpenAPI source hash drifted: ${row.store}`);
  }
  if (Array.isArray(plan.detailRefreshTargets) && plan.detailRefreshTargets.length > 0) {
    assert(detailClosure.length === 1, 'inventory plan must contain exactly one daily detail manifest closure evidence');
  }
  if (!validateExternalFiles) {
    assert(Number(plan?.counts?.enabledStores) === 19, 'inventory plan counts.enabledStores must be 19');
    return;
  }
  for (const closure of detailClosure) {
    assert(await fileHash(evidencePath(closure.file)) === closure.sha256, 'inventory detail bound manifest hash drifted');
    assert(await fileHash(evidencePath(closure.manifestOriginalFile)) === closure.manifestOriginalSha256, 'inventory detail original manifest hash drifted');
    assert(await fileHash(evidencePath(closure.terminalEvidenceFile)) === closure.terminalEvidenceSha256, 'inventory detail terminal evidence hash drifted');
    const start = Date.parse(closure.refreshStartedAt);
    const end = Date.parse(closure.refreshEndedAt);
    assert(Number.isFinite(start) && Number.isFinite(end) && start <= end, 'inventory detail refresh window invalid');
    for (const cache of (Array.isArray(closure.cacheBindings) ? closure.cacheBindings : [])) {
      assert(await fileHash(evidencePath(cache.cacheFile)) === cache.cacheSha256, `inventory detail cache hash drifted: ${cache.storeKey}`);
    }
    for (const binding of (Array.isArray(closure.targetBindings) ? closure.targetBindings : [])) {
      const detailFetchedAt = Date.parse(binding.detailFetchedAt);
      const cacheGeneratedAt = Date.parse(binding.cacheGeneratedAt);
      assert(Number.isFinite(detailFetchedAt) && Number.isFinite(cacheGeneratedAt)
        && inventoryDetailRefreshWindow({
          refreshStartedAt: closure.refreshStartedAt,
          detailFetchedAt: binding.detailFetchedAt,
          cacheGeneratedAt: binding.cacheGeneratedAt,
          refreshEndedAt: closure.refreshEndedAt,
        }).ok,
      `inventory detail target timestamp invalid: ${binding.storeKey}::${binding.spu}`);
    }
  }
  assert(Number(plan?.counts?.enabledStores) === 19, 'inventory plan counts.enabledStores must be 19');
}

function foreignInventoryWarningAudit(row, planRow, plan, result, context = {}) {
  const fail = reason => ({ok: false, reason});
  if (!context.allowItemFencedWarning || !context.warningMarkersAreValid) return fail('foreign-batch reconciliation requires verified warning evidence');
  if (!row || !planRow || rowKey(row) !== rowKey(planRow)) return fail('foreign-batch scope drift');
  const matches = [...(context.lifecycle?.intents || [])].filter(([, intent]) => intent.intentId === row.historicalIntentId);
  if (matches.length !== 1) return fail('foreign-batch durable intent missing or ambiguous');
  const [key, intent] = matches[0];
  const scope = inventoryScopeFromIntent(intent);
  try { normalizeInventoryOccupancy(row.before); } catch { return fail('foreign-batch raw inventory fields invalid'); }
  if (!isForeignInventoryIntent(intent, {runDate: plan.date, commandId: result.commandId || plan.commandId || '', journalFile: context.currentJournal})
    || intent.runDate !== row.historicalRunDate || intent.runDate > plan.date
    || intent.storeKey !== planRow.storeKey || intent.skc !== planRow.skc || intent.skuCode !== planRow.skuCode
    || intent.logicalActionKey !== row.logicalActionKey
    || intent.targetUsableInventory !== row.historicalTargetUsableInventory
    || row.historicalCommandId !== (intent.commandId || '')
    || !row.historicalJournalFile || path.resolve(row.historicalJournalFile) !== path.resolve(intent.journalFile)
    || !Number.isSafeInteger(row.before?.totalUsableInventory) || row.before.totalUsableInventory < 0
    || row.before.ok !== true || row.before.stockRowMissing !== false || row.before.skuCode !== planRow.skuCode
    || (scope.warehouseCode && (row.before.warehouseCodes?.length !== 1
      || String(row.before.warehouseCodes[0]).toUpperCase() !== scope.warehouseCode))
    || (row.writes !== undefined && (!Array.isArray(row.writes) || row.writes.length !== 0))) return fail('foreign-batch readback identity or no-write proof drift');
  if (!(context.resultEntries || []).some(entry => entry.kind === 'result' && entry.planHash === result.planHash
    && stableInventoryHash(entry.row) === stableInventoryHash(row))) return fail('foreign-batch exact result journal evidence missing');
  const outcome = context.lifecycle.terminalOutcomes.get(key);
  if (row.state === 'historical_readback_matched') {
    if (row.historicalIntentClosed !== true || row.deferred !== true || row.disposition !== 'readback_matched'
      || outcome?.disposition !== 'readback_matched'
      || outcome.resolutionJournalFile !== context.currentJournal
      || row.before.totalUsableInventory !== intent.targetUsableInventory
      || row.after?.totalUsableInventory !== intent.targetUsableInventory
      || intent.targetUsableInventory === Number(planRow.targetUsableInventory)) return fail('foreign-batch terminal resolution drift');
  } else if (row.state !== 'submitted_but_readback_pending' || row.historicalPending !== true || row.disposition !== 'skipped'
    || !context.lifecycle.pending.has(key) || outcome
    || row.before.totalUsableInventory === intent.targetUsableInventory
    || row.idempotencyKey !== intent.idempotencyKey || row.requestPayloadHash !== intent.requestPayloadHash) {
    return fail('foreign-batch pending evidence drift');
  }
  return {ok: true, intent, foreignBatch: true, pending: row.state === 'submitted_but_readback_pending'};
}

function resultRowIsSafe(row, planRow, plan, result, policy, currentTerminalAuditByIntentId, pendingWarningContext = {}) {
  if (!row || !planRow || rowKey(row) !== rowKey(planRow)) return false;
  const target = Number(planRow.targetUsableInventory);
  if (!Number.isInteger(target) || Number(row.targetUsableInventory) !== target || row.ruleClass !== planRow.ruleClass) return false;
  const before = Number(row?.before?.totalUsableInventory);
  if (row.state === 'pre_submit_blocked') return pendingWarningContext.allowItemFencedWarning
    && pendingWarningContext.warningMarkersAreValid
    && isInventoryPreSubmitExclusion({row, planRow, planHash: plan.payloadHash, commandId: plan.commandId || '',
      lifecycle: pendingWarningContext.lifecycle, entries: pendingWarningContext.resultEntries});
  if (row.state === 'updated_readback_matched') {
    const writes = Array.isArray(row.writes) ? row.writes : [];
    const logicalActionKey = expectedInventoryLogicalActionKey(planRow, plan, result);
    return Number(row?.after?.totalUsableInventory) === target
      && row.logicalActionKey === logicalActionKey
      && writes.length > 0
      && writes.every(write => write?.idempotencyKey === `bi-inv-${logicalActionKey.slice(0, 42)}`
        && write?.requestPayloadHash === stableInventoryHash(write?.request)
        && write?.request?.pathname === '/open-api/stock/change-inventory/v2'
        && write?.request?.method === 'POST'
        && write?.request?.body?.updateSkuInventoryQuantityRequests?.length === 1
        && write.request.body.updateSkuInventoryQuantityRequests[0]?.idempotencyKey === write.idempotencyKey
        && write.request.body.updateSkuInventoryQuantityRequests[0]?.skuCode === planRow.skuCode
        && write.request.body.updateSkuInventoryQuantityRequests[0]?.invType === 'VI'
        && write.request.body.updateSkuInventoryQuantityRequests[0]?.changeType === 'OVERWRITE'
        && Number(write.request.body.updateSkuInventoryQuantityRequests[0]?.changeQuantity) === Number(write.overwrite)
        && String(write?.code) === '0'
        && write?.success === true)
      && updatedReadbackAudit(row, planRow, plan, result, pendingWarningContext).ok;
  }
  if (row.state === 'skipped_target_already_matched') return before === target;
  if (row.state === 'skipped_owner_confirmed_same_target_above_target') {
    if (!Number.isFinite(before) || before <= target) return false;
    if (Array.isArray(row.writes) && row.writes.length > 0) return false;
    const lifecycle = pendingWarningContext?.lifecycle;
    if (!lifecycle?.terminalOutcomes || !lifecycle?.intents) return false;
    const recoveryScopeKey = inventoryRecoveryScopeKey({
      runDate: plan.date,
      storeKey: planRow.storeKey,
      skc: planRow.skc,
      skuCode: planRow.skuCode,
    });
    const matchingPredecessors = [...lifecycle.terminalOutcomes.entries()]
      .filter(([intentKey, outcome]) => {
        const predecessor = lifecycle.intents.get(intentKey);
        return outcome?.disposition === INVENTORY_OWNER_CONFIRMED_SAME_TARGET_SUPERSEDE_DISPOSITION
          && outcome.newRunDate === plan.date
          && Number(outcome.targetUsableInventory) === target
          && predecessor
          && predecessor.storeKey === planRow.storeKey
          && predecessor.skc === planRow.skc
          && predecessor.skuCode === planRow.skuCode
          && Number(predecessor.targetUsableInventory) === target
          && inventoryIntentScopeKey(predecessor) === recoveryScopeKey;
      });
    if (matchingPredecessors.length !== 1) return false;
    const [predecessorKey, outcome] = matchingPredecessors[0];
    const predecessor = lifecycle.intents.get(predecessorKey);
    if (!predecessor?.idempotencyKey) return false;
    if (!lifecycle.tombstonedIdempotencyKeys?.has(predecessor.idempotencyKey)) return false;
    const tombstone = lifecycle.tombstonedIdempotencyKeys.get(predecessor.idempotencyKey);
    if (tombstone?.intent?.intentId !== predecessor.intentId) return false;
    if (outcome.oldRunDate && predecessor.runDate && outcome.oldRunDate !== predecessor.runDate) return false;
    if (predecessor.runDate >= plan.date) return false;
    return true;
  }
  if (row.state === 'skipped_terminal_readback_recorded') {
    const audit = currentTerminalAuditByIntentId.get(String(row.terminalIntentId || ''));
    return result.reconcilePendingOnly === true
      && audit?.outcome?.disposition === 'readback_matched'
      && audit.outcome.recordedAt === row.terminalRecordedAt
      && audit.intent.runDate === plan.date
      && audit.intent.runDate === row.terminalRunDate
      && audit.intent.planHash === result.planHash
      && audit.intent.storeKey === planRow.storeKey
      && audit.intent.skc === planRow.skc
      && audit.intent.skuCode === planRow.skuCode
      && Number(audit.intent.targetUsableInventory) === target
      && row.logicalActionKey === audit.intent.logicalActionKey
      && row.terminalDisposition === 'readback_matched'
      && Number.isFinite(before)
      && Number(row.currentLiveUsableInventory) === before
      && (!Array.isArray(row.writes) || row.writes.length === 0);
  }
  if (row.state === 'skipped_safety_no_increase') return plan?.executionConstraints?.decreaseOnly === true && Number.isFinite(before) && before < target;
  if (row.state === 'skipped_within_scarcity_band') {
    return row.ruleClass === 'recent_sale_scarcity'
      && Number.isFinite(before)
      && before >= Number(policy?.recentSaleScarcity?.refillWhenBelow ?? 5)
      && before <= Number(policy?.recentSaleScarcity?.capWhenAbove ?? 10);
  }
  if (row.state === 'skipped_recovered') {
    return row.ruleClass === 'legacy_virtual_inventory_top_up'
      && Number.isFinite(before)
      && before > Number(policy?.triggerUsableInventoryAtOrBelow ?? 20);
  }
  if (row.state === 'submitted_but_readback_pending' && row.historicalPending === true) {
    if (row.historicalRunDate === plan.date) return foreignInventoryWarningAudit(row, planRow, plan, result, pendingWarningContext).ok;
    return row.disposition === 'skipped'
      && typeof row.historicalIntentId === 'string' && row.historicalIntentId.length > 0
      && /^\d{4}-\d{2}-\d{2}$/.test(String(row.historicalRunDate || ''))
      && row.historicalRunDate < plan.date
      && Number.isInteger(Number(row.historicalTargetUsableInventory))
      && Number.isFinite(before)
      && (!Array.isArray(row.writes) || row.writes.length === 0);
  }
  if (row.state === 'historical_readback_matched') return foreignInventoryWarningAudit(row, planRow, plan, result, pendingWarningContext).ok;
  if (row.state === 'submitted_but_readback_pending') {
    return sameDayPendingWarningAudit(row, planRow, plan, result, pendingWarningContext).ok;
  }
  if (row.state === 'blocked_by_manual_resolution_fence') {
    const fence = row.manualResolutionFence;
    return fence?.disposition === 'manual_baseline_adopted_effect_unknown'
      && fence?.reason === 'exact_scope_manual_resolution_fence'
      && typeof fence?.resolutionId === 'string' && fence.resolutionId.length > 0
      && typeof fence?.intentId === 'string' && fence.intentId.length > 0
      && fence?.scope?.storeKey === row.storeKey
      && fence?.scope?.skc === row.skc
      && fence?.scope?.skuCode === row.skuCode
      && typeof fence?.scope?.warehouseCode === 'string' && fence.scope.warehouseCode.length > 0
      && fence?.scope?.invType === 'VI'
      && /^[a-f0-9]{64}$/i.test(String(fence?.scope?.scopeKey || ''))
      && (!Array.isArray(row.writes) || row.writes.length === 0);
  }
  return false;
}

function isReconcileOnlyTerminalOrReadbackOnlyResultRow(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.state === 'updated_readback_matched') return true;
  if (row.state === 'skipped_terminal_readback_recorded') return true;
  if (row.state === 'skipped_target_already_matched') return true;
  if (row.state === 'submitted_but_readback_pending' && row.historicalPending === true) return true;
  if (row.state === 'historical_readback_matched') return true;
  if (row.state === 'blocked_by_manual_resolution_fence') return true;
  if (row.state === 'pre_submit_blocked') return true;
  return false;
}

export async function validateInventoryArtifacts({
  root,
  markerRoot,
  stateDir = '',
  inventoryRuntimeRoot,
  runDate,
  businessDate,
  enabledStores,
  requireMarker = true,
  allowItemFencedWarning = false,
  allowSameDayPendingWarning = false,
  allowPendingWarning = false,
  preWarningAudit = false,
  inventoryCommandId = '',
  staging = false,
}) {
  const preWarningMode = preWarningAudit === true;
  const itemFencedWarningMode = preWarningMode
    || allowItemFencedWarning === true
    || allowSameDayPendingWarning === true
    || allowPendingWarning === true;
  if (preWarningMode) {
    assert(requireMarker === true, 'pre-warning audit requires the inventory marker');
  }
  const previous = new Date(`${runDate}T12:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  assert(businessDate === previous.toISOString().slice(0, 10), 'businessDate must equal runDate minus one calendar day');
  const index = preWarningMode || staging ? null : await readDailyInventoryVersionIndex({inventoryRuntimeRoot, date: runDate});
  const version = index ? await resolveResultEvidenceArtifact({inventoryRuntimeRoot, date: runDate, commandId: inventoryCommandId, preferActive: !inventoryCommandId}) : null;
  assert(!index || version, 'inventory version index has no matching complete batch');
  const planFile = version?.planFile || path.join(inventoryRuntimeRoot, 'plans', `daily-inventory-replenishment-${runDate}.json`);
  const resultFile = version?.file || path.join(inventoryRuntimeRoot, 'results', `daily-inventory-replenishment-${runDate}.json`);
  const inventoryMarkerFile = version?.markerFile || path.join(markerRoot, runDate, 'daily-inventory-guard.json');
  const [plan, result, policy] = await Promise.all([
    readJson(planFile),
    readJson(resultFile),
    readJson(path.join(root, 'config', 'inventory_replenishment_policy.json')),
  ]);
  let sourceReferenceTime = Date.now();
  let inventoryMarkerStatus = '';
  let warningMarkersAreValid = false;
  const operatingMarkerFile = path.join(markerRoot, runDate, 'daily-operating-refresh.json');
  if (requireMarker) {
    const marker = await readJson(inventoryMarkerFile);
    inventoryMarkerStatus = String(marker?.status || '');
    assert(marker?.ok === true && marker?.stage === 'daily-inventory-guard' && (marker?.status === 'done' || marker?.status === 'warning'), 'inventory marker is not done or warning');
    assert(marker?.runDate === runDate && marker?.businessDate === businessDate, 'inventory marker date mismatch');
    await verifyEvidenceRecords(marker.evidence, [planFile, resultFile], root, 'inventory marker');
    if (preWarningMode) {
      assert(inventoryMarkerStatus === 'warning', 'pre-warning audit requires an inventory warning marker');
      try {
        const existingOperating = await readJson(operatingMarkerFile);
        const operatingValid = existingOperating?.ok === true
          && existingOperating?.stage === 'daily-operating-refresh'
          && (existingOperating?.status === 'done' || existingOperating?.status === 'warning')
          && existingOperating?.runDate === runDate
          && existingOperating?.businessDate === businessDate;
        if (!operatingValid) {
          throw new Error('pre-warning audit requires the operating marker to be absent or a verified existing daily completion marker');
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      // The inventory marker has already been checked for exact dates and
      // immutable plan/result evidence.  This is the only warning allowance
      // before the final operating marker exists.
      warningMarkersAreValid = true;
    }
    sourceReferenceTime = Date.parse(String(marker.completedAt || ''));
    assert(Number.isFinite(sourceReferenceTime), 'inventory marker completedAt is invalid');
  } else {
    try {
      const marker = await readJson(inventoryMarkerFile);
      if (
        marker?.ok === true
        && marker?.stage === 'daily-inventory-guard'
        && (marker?.status === 'done' || marker?.status === 'warning')
        && marker?.runDate === runDate
        && marker?.businessDate === businessDate
      ) {
        await verifyEvidenceRecords(marker.evidence, [planFile, resultFile], root, 'inventory marker');
        const parsed = Date.parse(String(marker.completedAt || ''));
        if (Number.isFinite(parsed)) {
          sourceReferenceTime = parsed;
        }
      }
    } catch {
      // Retain Date.now() when marker is missing, invalid, or drifted
    }
  }
  if (itemFencedWarningMode && !preWarningMode && requireMarker && inventoryMarkerStatus === 'warning') {
    try {
      const operatingMarker = await readJson(operatingMarkerFile);
      warningMarkersAreValid = isWarningMarker(operatingMarker, 'daily-operating-refresh', runDate, businessDate);
      if (warningMarkersAreValid) {
        const effectiveStateDir = path.resolve(stateDir || path.join(root, 'state', 'cloud_morning_chain'));
        await verifyEvidenceRecords(operatingMarker.evidence, [
          path.join(effectiveStateDir, `${runDate}-all.json`),
          inventoryMarkerFile,
          planFile,
          resultFile,
        ], root, 'daily operating marker');
      }
    } catch {
      warningMarkersAreValid = false;
    }
  }
  assert(plan?.date === runDate && plan?.policyVersion === policy?.policyVersion, 'inventory plan date/policy mismatch');
  assert(plan?.executable === true && Array.isArray(plan?.blockers) && plan.blockers.length === 0, 'inventory plan is not executable');
  assert(/^[a-f0-9]{64}$/.test(String(plan?.payloadHash || '')) && expectedPlanHash(plan) === plan.payloadHash, 'inventory plan payloadHash mismatch');
  assert(result?.planHash === plan.payloadHash && result?.policyVersion === plan.policyVersion, 'inventory result plan/policy hash mismatch');
  assert(result?.execute === true && result?.executionMode === 'automatic', 'inventory result is not an automatic execution');
  if (!itemFencedWarningMode) {
    assert(Array.isArray(result?.unresolvedIntents) && result.unresolvedIntents.length === 0, 'inventory result contains unresolved durable intents');
  } else if (result?.unresolvedIntents !== undefined) {
    assert(Array.isArray(result.unresolvedIntents), 'inventory result unresolvedIntents is not an array');
  }
  const automatic = policy?.execution?.automaticExecution || {};
  const allowed = new Set([...(automatic.allowedContexts || []), automatic.allowedContext].filter(Boolean).map(String));
  const expectedAuthorization = automatic?.authorizationByContext?.[result.authorizationContext]
    || (result.authorizationContext === automatic.allowedContext ? automatic.authorizationId : '');
  assert(automatic.enabled === true && allowed.has(result.authorizationContext), 'inventory authorization context mismatch');
  assert(expectedAuthorization && result.authorizationId === expectedAuthorization, 'inventory authorization id mismatch');
  const actionable = Array.isArray(plan.actionable) ? plan.actionable : [];
  const rows = Array.isArray(result.results) ? result.results : [];
  const externalSourceEvidenceRequired = !(result.reconcilePendingOnly === true
    && rows.length === actionable.length
    && rows.every(isReconcileOnlyTerminalOrReadbackOnlyResultRow));
  await validatePlanSourceEvidence(plan, enabledStores, policy, sourceReferenceTime, root, {
    validateExternalFiles: externalSourceEvidenceRequired,
    validateFreshness: externalSourceEvidenceRequired,
    sourceSnapshots: new Map((version?.sourceArtifacts || []).map(a => [a.file, path.resolve(inventoryRuntimeRoot, a.snapshot)])),
  });
  const currentTerminalAuditByIntentId = new Map();
  const currentJournal = path.resolve(`${resultFile}.journal.ndjson`);
  const journalFiles = version?.journalArtifacts?.length ? version.journalArtifacts.map(a => a.file) : await discoverInventoryJournalAuditFiles(currentJournal);
  const journalSnapshots = new Map((version?.journalArtifacts || []).map(a => [path.resolve(a.file), path.resolve(inventoryRuntimeRoot, a.snapshot)]));
  const lifecycle = await readInventoryValidationLifecycle(journalFiles, {currentJournal, maxRunDate: runDate, journalSnapshots});
  const resultEntries = (await fs.readFile(journalSnapshots.get(currentJournal) || currentJournal, 'utf8')
    .catch(error => { if (error.code === 'ENOENT' && !version) return ''; throw error; }))
    .split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const pendingWarningContext = {
    allowItemFencedWarning: itemFencedWarningMode,
    warningMarkersAreValid,
    lifecycle,
    currentJournal,
    resultEntries,
  };
  for (const [intentKey, intent] of lifecycle.intents.entries()) {
    if (intent.journalFile !== currentJournal) continue;
    const outcome = lifecycle.terminalOutcomes.get(intentKey);
    if (outcome) currentTerminalAuditByIntentId.set(intent.intentId, {intent, outcome});
  }
  const expectedManualResolutionReport = [...lifecycle.fences.values()]
    .map(candidate => ({
      resolutionId: candidate.event?.resolutionId || '',
      intentId: candidate.event?.intentId || '',
      disposition: candidate.event?.disposition || '',
      scope: candidate.event?.scope || null,
      idempotencyKey: candidate.event?.idempotencyKey || '',
      journalFile: candidate.intent?.journalFile || candidate.journalFile || '',
    }))
    .sort((left, right) => `${left.journalFile}\u0000${left.intentId}`.localeCompare(`${right.journalFile}\u0000${right.intentId}`));
  if (result.manualResolutionFences === undefined) {
    assert(expectedManualResolutionReport.length === 0, 'inventory result omits manual-resolution fence report');
  } else {
    assert(Array.isArray(result.manualResolutionFences), 'inventory result manualResolutionFences is not an array');
    const actualManualResolutionReport = result.manualResolutionFences.map(row => ({
      resolutionId: row?.resolutionId || '',
      intentId: row?.intentId || '',
      disposition: row?.disposition || '',
      scope: row?.scope || null,
      idempotencyKey: row?.idempotencyKey || '',
      journalFile: row?.journalFile || '',
    })).sort((left, right) => `${left.journalFile}\u0000${left.intentId}`.localeCompare(`${right.journalFile}\u0000${right.intentId}`));
    assert(stableInventoryHash(actualManualResolutionReport) === stableInventoryHash(expectedManualResolutionReport), 'inventory result manual-resolution fence report mismatch');
  }
  if (result.manualResolutionTombstoneCount === undefined) {
    assert(lifecycle.tombstonedIdempotencyKeys.size === 0, 'inventory result omits manual-resolution idempotency tombstone report');
  } else {
    assert(Number.isSafeInteger(result.manualResolutionTombstoneCount)
      && result.manualResolutionTombstoneCount === lifecycle.tombstonedIdempotencyKeys.size,
    'inventory result manual-resolution idempotency tombstone report mismatch');
  }
  const manualResolutionFences = [];
  const resultByKey = new Map(rows.map(row => [rowKey(row), row]));
  for (const planRow of actionable) {
    const logicalActionKey = expectedInventoryLogicalActionKey(planRow, plan, result);
    const idempotencyKey = `bi-inv-${logicalActionKey.slice(0, 42)}`;
    const adoption = lifecycle.baselineAdoptions?.get(idempotencyKey);
    const fence = findInventoryWriteFence(lifecycle, {
      idempotencyKey,
      scope: {
        storeKey: planRow.storeKey,
        skc: planRow.skc,
        skuCode: planRow.skuCode,
        warehouseCode: adoption?.scope?.warehouseCode || '',
        invType: 'VI',
      },
    });
    if (fence) {
      manualResolutionFences.push({
        intentId: fence.event?.intentId || '',
        resolutionId: fence.event?.resolutionId || '',
        disposition: fence.event?.disposition || '',
        scope: fence.event?.scope || null,
        reason: fence.reason,
      });
      const fencedRow = resultByKey.get(rowKey(planRow));
      assert(fencedRow?.state === 'blocked_by_manual_resolution_fence'
        && fencedRow?.manualResolutionFence?.resolutionId === fence.event?.resolutionId
        && fencedRow?.manualResolutionFence?.intentId === fence.event?.intentId
        && fencedRow?.manualResolutionFence?.scope?.scopeKey === fence.event?.scope?.scopeKey,
      `inventory manual-resolution fence is not represented by the exact terminal exclusion row: store=${planRow.storeKey} skc=${planRow.skc} sku=${planRow.skuCode}`);
    }
  }
  assert(rows.length === actionable.length, 'inventory result row count mismatch');
  const planByKey = new Map();
  for (const row of actionable) {
    const key = rowKey(row);
    assert(key !== '::::' && !planByKey.has(key), `inventory plan row identity duplicate: ${key}`);
    assert(enabledStores.includes(String(row.storeKey || '').toUpperCase()), `inventory plan contains unknown store: ${row.storeKey}`);
    planByKey.set(key, row);
  }
  const seen = new Set();
  const pendingWarningAudits = [];
  for (const row of rows) {
    const key = rowKey(row);
    assert(!seen.has(key), `inventory result row identity duplicate: ${key}`);
    seen.add(key);
    const planRow = planByKey.get(key);
    const pendingAudit = row?.state === 'historical_readback_matched'
      || (row?.state === 'submitted_but_readback_pending' && row.historicalPending === true && row.historicalRunDate === plan.date)
      ? foreignInventoryWarningAudit(row, planRow, plan, result, pendingWarningContext)
      : row?.state === 'submitted_but_readback_pending'
        ? sameDayPendingWarningAudit(row, planRow, plan, result, pendingWarningContext)
        : null;
    const updatedAudit = row?.state === 'updated_readback_matched'
      ? updatedReadbackAudit(row, planRow, plan, result, pendingWarningContext)
      : null;
    if (pendingAudit?.ok) pendingWarningAudits.push(pendingAudit);
    assert(resultRowIsSafe(row, planRow, plan, result, policy, currentTerminalAuditByIntentId, pendingWarningContext),
      `inventory result lacks exact terminal readback: ${key}${(pendingAudit?.reason || updatedAudit?.reason) ? `: ${pendingAudit?.reason || updatedAudit.reason}` : ''}`);
  }
  assert(seen.size === planByKey.size && [...planByKey.keys()].every(key => seen.has(key)), 'inventory plan/result identity set mismatch');
  if (preWarningMode) {
    assert(pendingWarningAudits.length > 0 || rows.some(row => ['blocked_by_manual_resolution_fence', 'pre_submit_blocked'].includes(row?.state)),
      'pre-warning audit requires a same-day pending, fenced, or proven pre-submit excluded result row');
  }
  if (itemFencedWarningMode && Array.isArray(result?.unresolvedIntents) && result.unresolvedIntents.length > 0) {
    const seenUnresolved = new Set();
    for (const unresolved of result.unresolvedIntents) {
      assert(unresolved && typeof unresolved === 'object' && !Array.isArray(unresolved), 'inventory result unresolved durable intent is malformed');
      if (unresolved.state !== undefined) {
        assert(['pending', 'submitted_but_readback_pending'].includes(String(unresolved.state)), 'inventory result unresolved durable intent has an unsafe state');
      }
      assert(unresolved.retry !== true && unresolved.duplicate !== true, 'inventory result unresolved durable intent records a retry or duplicate');
      const unresolvedIdentifiers = [unresolved.intentId, unresolved.logicalActionKey, unresolved.idempotencyKey]
        .filter(Boolean)
        .map(String);
      assert(unresolvedIdentifiers.length > 0, 'inventory result unresolved durable intent has no identity');
      const matches = pendingWarningAudits.filter(audit => audit.pending !== false && unresolvedIdentifiers.every(value => [
        audit.intent?.intentId,
        audit.intent?.logicalActionKey,
        audit.intent?.idempotencyKey,
      ].filter(Boolean).map(String).includes(value)));
      assert(matches.length === 1, 'inventory result unresolved durable intent is not bound to one exact pending warning journal intent');
      const identity = String(matches[0].intent.intentId);
      assert(!seenUnresolved.has(identity), 'inventory result unresolved durable intent is duplicated');
      seenUnresolved.add(identity);
    }
  }
  const pendingWarningCount = pendingWarningAudits.filter(audit => audit.pending !== false).length;
  return {
    ok: true,
    planFile,
    resultFile,
    inventoryMarkerFile,
    planHash: plan.payloadHash,
    resultCount: rows.length,
    manualResolutionFenceCount: manualResolutionFences.length,
    preSubmitBlockedCount: rows.filter(row => row.state === 'pre_submit_blocked').length,
    pendingWarningCount,
    pendingReadbackCount: pendingWarningCount,
    pendingCount: pendingWarningCount,
    warningCount: pendingWarningAudits.length,
  };
}

export async function validateDailyOperatingRefresh(options) {
  const args = {...options};
  const previous = new Date(`${args.runDate}T12:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  assert(args.businessDate === previous.toISOString().slice(0, 10), 'businessDate must equal runDate minus one calendar day');
  const storesConfig = await readJson(path.join(args.root, 'config', 'stores.json'));
  const enabledStores = (Array.isArray(storesConfig?.stores) ? storesConfig.stores : [])
    .filter(row => row?.enabled !== false)
    .map(row => String(row?.storeKey || '').toUpperCase())
    .filter(Boolean)
    .sort();
  assert(enabledStores.length === 19 && new Set(enabledStores).size === 19, 'configured enabled store set must contain exactly 19 unique stores');
  const morningFile = path.join(args.stateDir, `${args.runDate}-all.json`);
  const finalMarkerFile = path.join(args.markerRoot, args.runDate, 'daily-operating-refresh.json');
  const marker = args.preWarningAudit === true ? null : await readJson(finalMarkerFile);
  const inventory = await validateInventoryArtifacts({
    ...args,
    inventoryCommandId: args.preWarningAudit ? '' : `morning:${args.runDate}`,
    enabledStores,
    requireMarker: true,
    preWarningAudit: args.preWarningAudit === true,
  });
  await validateMorningEvidence({...args, file: morningFile, enabledStores,
    evidenceRecord: marker?.evidence?.find(entry => storedPath(args.root, entry.path) === morningFile)});
  if (args.preWarningAudit === true) {
    try {
      const existingOperating = await readJson(path.join(args.markerRoot, args.runDate, 'daily-operating-refresh.json'));
      const operatingValid = existingOperating?.ok === true
        && existingOperating?.stage === 'daily-operating-refresh'
        && (existingOperating?.status === 'done' || existingOperating?.status === 'warning')
        && existingOperating?.runDate === args.runDate
        && existingOperating?.businessDate === args.businessDate;
      if (!operatingValid) {
        throw new Error('pre-warning audit requires the operating marker to be absent or a verified existing daily completion marker');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
    return {
      ok: true,
      preWarningAudit: true,
      runDate: args.runDate,
      businessDate: args.businessDate,
      storeCount: enabledStores.length,
      artifactCount: enabledStores.length * DOMAINS.length,
      planHash: inventory.planHash,
      resultCount: inventory.resultCount,
      pendingWarningCount: inventory.pendingWarningCount,
      pendingReadbackCount: inventory.pendingReadbackCount,
      pendingCount: inventory.pendingCount,
      warningCount: inventory.warningCount,
    };
  }
  assert(marker?.ok === true && marker?.stage === 'daily-operating-refresh' && (marker?.status === 'done' || marker?.status === 'warning'), 'daily operating marker is not done or warning');
  assert(marker?.runDate === args.runDate && marker?.businessDate === args.businessDate, 'daily operating marker date mismatch');
  await verifyEvidenceRecords(marker.evidence, [
    morningFile,
    inventory.inventoryMarkerFile,
    inventory.planFile,
    inventory.resultFile,
  ], args.root, 'daily operating marker');
  return {
    ok: true,
    runDate: args.runDate,
    businessDate: args.businessDate,
    storeCount: enabledStores.length,
    artifactCount: enabledStores.length * DOMAINS.length,
    planHash: inventory.planHash,
    resultCount: inventory.resultCount,
    pendingWarningCount: inventory.pendingWarningCount,
    pendingReadbackCount: inventory.pendingReadbackCount,
    pendingCount: inventory.pendingCount,
    warningCount: inventory.warningCount,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.inventoryOnly) {
      const storesConfig = await readJson(path.join(args.root, 'config', 'stores.json'));
      const enabledStores = (Array.isArray(storesConfig?.stores) ? storesConfig.stores : [])
        .filter(row => row?.enabled !== false)
        .map(row => String(row?.storeKey || '').toUpperCase())
        .filter(Boolean)
        .sort();
      assert(enabledStores.length === 19 && new Set(enabledStores).size === 19, 'configured enabled store set must contain exactly 19 unique stores');
      console.log(JSON.stringify({ok: true, ...(await validateInventoryArtifacts({
        ...args,
        enabledStores,
        inventoryCommandId: args.preWarningAudit ? '' : `morning:${args.runDate}`,
        staging: !args.preWarningAudit && !args.allowItemFencedWarning,
        // Strict executor validation runs before marker publication. A warning
        // audit, however, must verify the marker pair before accepting exclusions.
        requireMarker: args.preWarningAudit === true || args.allowItemFencedWarning === true,
      }))}, null, 2));
    } else {
      console.log(JSON.stringify(await validateDailyOperatingRefresh(args), null, 2));
    }
  } catch (error) {
    console.error(JSON.stringify({ok: false, error: String(error?.message || error)}, null, 2));
    process.exitCode = 1;
  }
}
