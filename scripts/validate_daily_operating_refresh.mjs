#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  discoverInventoryJournalFiles,
  findInventoryWriteFence,
  readInventoryIntentLifecycle,
  readInventoryIntentJournals,
} from '../lib/durable_inventory_write.mjs';
import {inventoryDetailRefreshWindow} from '../lib/inventory_detail_refresh_window.mjs';
import {buildDailyInventoryPlanHashPayload, stableInventoryHash} from '../lib/inventory_replenishment_policy.mjs';

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

async function readInventoryValidationLifecycle(journalFiles, {currentJournal, maxRunDate}) {
  try {
    return await readInventoryIntentJournals(journalFiles, {maxRunDate});
  } catch (error) {
    const match = /^INVENTORY_JOURNAL_SUPERSEDE_INVALID:(.+):([^:]+):referencedIntentMissing$/.exec(String(error?.message || ''));
    if (!match || path.resolve(match[1]) === path.resolve(currentJournal)) throw error;

    // A legacy cross-day supersede with a missing referenced intent is invalid
    // audit history, but it must not hide independently valid manual fences or
    // invalidate a later day's fully read-back result.  Keep every original
    // journal immutable and rebuild only the validator's read model from each
    // file's strict local lifecycle.
    const records = [];
    const intents = new Map();
    const pending = new Map();
    const terminalOutcomes = new Map();
    const manualResolutions = new Map();
    const fences = new Map();
    const tombstonedIdempotencyKeys = new Map();
    for (const journalFile of journalFiles) {
      const lifecycle = await readInventoryIntentLifecycle(journalFile, {strict: true, maxRunDate});
      records.push({journalFile, ...lifecycle});
      for (const [intentId, rawIntent] of lifecycle.intents) {
        const key = `${path.resolve(journalFile)}\u0000${intentId}`;
        const intent = {...rawIntent, journalFile: path.resolve(journalFile)};
        if ([...intents.values()].some(candidate => candidate.intentId === intentId)) {
          throw new Error(`INVENTORY_JOURNAL_CONFLICT:${journalFile}:duplicate_global_intentId=${intentId}`);
        }
        intents.set(key, intent);
        if (lifecycle.pending.has(intentId)) pending.set(key, intent);
        const outcome = lifecycle.terminalOutcomes.get(intentId);
        if (outcome) terminalOutcomes.set(key, {...outcome, journalFile: path.resolve(journalFile)});
        const resolution = lifecycle.manualResolutions.get(intentId);
        if (!resolution) continue;
        manualResolutions.set(key, resolution);
        const scopeKey = String(resolution?.scope?.scopeKey || '');
        if (!scopeKey || fences.has(scopeKey)) throw new Error(`INVENTORY_JOURNAL_FENCE_CONFLICT:${journalFile}:duplicate_global_scope=${scopeKey}`);
        fences.set(scopeKey, {key, intent, event: resolution, journalFile: path.resolve(journalFile)});
        const idempotencyKey = String(resolution.idempotencyKey || '');
        if (idempotencyKey) {
          if (tombstonedIdempotencyKeys.has(idempotencyKey)) throw new Error(`INVENTORY_JOURNAL_TOMBSTONE_CONFLICT:${journalFile}:duplicate_global_idempotencyKey=${idempotencyKey}`);
          tombstonedIdempotencyKeys.set(idempotencyKey, {key, intent, event: resolution});
        }
      }
    }
    return {files: journalFiles, records, intents, pending, terminalOutcomes, manualResolutions, fences, tombstonedIdempotencyKeys};
  }
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
    const file = storedPath(root, entry.path);
    const stat = await fs.lstat(file);
    assert(stat.isFile() && !stat.isSymbolicLink(), `${label} evidence is not a regular file: ${file}`);
    assert(Number(entry.bytes) === stat.size, `${label} evidence size mismatch: ${file}`);
    assert(String(entry.sha256 || '') === await fileHash(file), `${label} evidence hash mismatch: ${file}`);
  }
}

async function validateMorningEvidence({root, businessDate, file, enabledStores}) {
  const document = await readJson(file);
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
    const stat = await fs.lstat(actual);
    assert(stat.isFile() && !stat.isSymbolicLink(), `morning evidence artifact is not a regular file: ${key}`);
    assert(Number(artifact.bytes) === stat.size, `morning evidence artifact size mismatch: ${key}`);
    assert(String(artifact.sha256 || '') === await fileHash(actual), `morning evidence artifact hash mismatch: ${key}`);
    const payload = await readJson(actual);
    assert(payload?.ok === true && payload?.date === businessDate, `morning evidence payload date/status mismatch: ${key}`);
    assert(String(payload?.store?.storeKey || '').toUpperCase() === storeKey, `morning evidence payload store mismatch: ${key}`);
  }
  assert(seen.size === 38, 'morning evidence store/domain coverage is incomplete');
}

function expectedPlanHash(plan) {
  return stableInventoryHash(buildDailyInventoryPlanHashPayload(plan));
}

async function validatePlanSourceEvidence(plan, enabledStores, policy, referenceTime = Date.now(), evidenceRoot = process.cwd(), {validateExternalFiles = true, validateFreshness = true} = {}) {
  const evidencePath = file => path.isAbsolute(String(file || ''))
    ? path.resolve(file)
    : path.resolve(evidenceRoot, String(file || ''));
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

function resultRowIsSafe(row, planRow, plan, result, policy, currentTerminalAuditByIntentId) {
  if (!row || !planRow || rowKey(row) !== rowKey(planRow)) return false;
  const target = Number(planRow.targetUsableInventory);
  if (!Number.isInteger(target) || Number(row.targetUsableInventory) !== target || row.ruleClass !== planRow.ruleClass) return false;
  const before = Number(row?.before?.totalUsableInventory);
  if (row.state === 'updated_readback_matched') {
    const writes = Array.isArray(row.writes) ? row.writes : [];
    const logicalActionKey = stableInventoryHash({
      runDate: plan.date,
      store: planRow.storeKey,
      skc: planRow.skc,
      sku: planRow.skuCode,
      target,
      actionType: 'VI_OVERWRITE_TO_EXACT_USABLE_TARGET',
      policyVersion: plan.policyVersion,
      authorizationId: result.authorizationId || '',
    });
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
        && write?.success === true);
  }
  if (row.state === 'skipped_target_already_matched') return before === target;
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
    return row.disposition === 'skipped'
      && typeof row.historicalIntentId === 'string' && row.historicalIntentId.length > 0
      && /^\d{4}-\d{2}-\d{2}$/.test(String(row.historicalRunDate || ''))
      && row.historicalRunDate < plan.date
      && Number.isInteger(Number(row.historicalTargetUsableInventory))
      && Number.isFinite(before)
      && (!Array.isArray(row.writes) || row.writes.length === 0);
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
  if (row.state === 'blocked_by_manual_resolution_fence') return true;
  return false;
}

export async function validateInventoryArtifacts({root, markerRoot, inventoryRuntimeRoot, runDate, businessDate, enabledStores, requireMarker = true}) {
  const previous = new Date(`${runDate}T12:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  assert(businessDate === previous.toISOString().slice(0, 10), 'businessDate must equal runDate minus one calendar day');
  const planFile = path.join(inventoryRuntimeRoot, 'plans', `daily-inventory-replenishment-${runDate}.json`);
  const resultFile = path.join(inventoryRuntimeRoot, 'results', `daily-inventory-replenishment-${runDate}.json`);
  const inventoryMarkerFile = path.join(markerRoot, runDate, 'daily-inventory-guard.json');
  const [plan, result, policy] = await Promise.all([
    readJson(planFile),
    readJson(resultFile),
    readJson(path.join(root, 'config', 'inventory_replenishment_policy.json')),
  ]);
  let sourceReferenceTime = Date.now();
  if (requireMarker) {
    const marker = await readJson(inventoryMarkerFile);
    assert(marker?.ok === true && marker?.stage === 'daily-inventory-guard' && marker?.status === 'done', 'inventory marker is not done');
    assert(marker?.runDate === runDate && marker?.businessDate === businessDate, 'inventory marker date mismatch');
    await verifyEvidenceRecords(marker.evidence, [planFile, resultFile], root, 'inventory marker');
    sourceReferenceTime = Date.parse(String(marker.completedAt || ''));
    assert(Number.isFinite(sourceReferenceTime), 'inventory marker completedAt is invalid');
  }
  assert(plan?.date === runDate && plan?.policyVersion === policy?.policyVersion, 'inventory plan date/policy mismatch');
  assert(plan?.executable === true && Array.isArray(plan?.blockers) && plan.blockers.length === 0, 'inventory plan is not executable');
  assert(/^[a-f0-9]{64}$/.test(String(plan?.payloadHash || '')) && expectedPlanHash(plan) === plan.payloadHash, 'inventory plan payloadHash mismatch');
  assert(result?.planHash === plan.payloadHash && result?.policyVersion === plan.policyVersion, 'inventory result plan/policy hash mismatch');
  assert(result?.execute === true && result?.executionMode === 'automatic', 'inventory result is not an automatic execution');
  assert(Array.isArray(result?.unresolvedIntents) && result.unresolvedIntents.length === 0, 'inventory result contains unresolved durable intents');
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
  });
  const currentTerminalAuditByIntentId = new Map();
  const currentJournal = path.resolve(`${resultFile}.journal.ndjson`);
  const journalFiles = await discoverInventoryJournalAuditFiles(currentJournal);
  const lifecycle = await readInventoryValidationLifecycle(journalFiles, {currentJournal, maxRunDate: runDate});
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
    const fence = findInventoryWriteFence(lifecycle, {
      scope: {
        storeKey: planRow.storeKey,
        skc: planRow.skc,
        skuCode: planRow.skuCode,
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
  for (const row of rows) {
    const key = rowKey(row);
    assert(!seen.has(key), `inventory result row identity duplicate: ${key}`);
    seen.add(key);
    assert(resultRowIsSafe(row, planByKey.get(key), plan, result, policy, currentTerminalAuditByIntentId), `inventory result lacks exact terminal readback: ${key}`);
  }
  assert(seen.size === planByKey.size && [...planByKey.keys()].every(key => seen.has(key)), 'inventory plan/result identity set mismatch');
  return {
    planFile,
    resultFile,
    inventoryMarkerFile,
    planHash: plan.payloadHash,
    resultCount: rows.length,
    manualResolutionFenceCount: manualResolutionFences.length,
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
  const inventory = await validateInventoryArtifacts({...args, enabledStores, requireMarker: true});
  await validateMorningEvidence({...args, file: morningFile, enabledStores});
  const finalMarkerFile = path.join(args.markerRoot, args.runDate, 'daily-operating-refresh.json');
  const marker = await readJson(finalMarkerFile);
  assert(marker?.ok === true && marker?.stage === 'daily-operating-refresh' && marker?.status === 'done', 'daily operating marker is not done');
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
      console.log(JSON.stringify({ok: true, ...(await validateInventoryArtifacts({...args, enabledStores, requireMarker: false}))}, null, 2));
    } else {
      console.log(JSON.stringify(await validateDailyOperatingRefresh(args), null, 2));
    }
  } catch (error) {
    console.error(JSON.stringify({ok: false, error: String(error?.message || error)}, null, 2));
    process.exitCode = 1;
  }
}
