#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {stableInventoryHash} from '../../lib/inventory_replenishment_policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ET_LOW_INVENTORY_MAX_AGE_HARD_LIMIT_SECONDS = 6 * 60 * 60;
const ET_LOW_INVENTORY_MAX_FUTURE_SKEW_SECONDS = 5 * 60;
const text = value => String(value ?? '').trim();
const isNonNegativeInteger = value => value !== null
  && value !== undefined
  && value !== ''
  && Number.isInteger(Number(value))
  && Number(value) >= 0;
const beijingDate = value => {
  const timestampMs = new Date(value || '').getTime();
  if (!Number.isFinite(timestampMs)) return '';
  return new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date(timestampMs));
};

function etInventoryEvidenceHash({manifestHash, batchId, targetDate, files = {}} = {}) {
  return stableInventoryHash({
    schemaVersion: 'et-low-inventory-evidence/v1',
    manifestHash: text(manifestHash).toLowerCase(),
    batchId: text(batchId),
    targetDate: text(targetDate),
    endpoints: ['store_stock', 'box_stock'].map(endpoint => {
      const file = files?.[endpoint] || {};
      return {
        endpoint,
        path: text(file.path),
        hash: text(file.hash).toLowerCase(),
        rowCount: isNonNegativeInteger(file.rowCount) ? Number(file.rowCount) : null,
        count: isNonNegativeInteger(file.count) ? Number(file.count) : null,
        rawRowCount: isNonNegativeInteger(file.rawRowCount) ? Number(file.rawRowCount) : null,
        pageCount: isNonNegativeInteger(file.pageCount) ? Number(file.pageCount) : null,
        fetchedAt: text(file.fetchedAt),
        complete: file.complete === true,
      };
    }),
  });
}

function validateEtFactSource(etFactSource, sourcePlan, blockers) {
  if (!etFactSource || etFactSource.kind !== 'et_forwarder_manifest') return;
  const maxAgeSeconds = Number(etFactSource.maxAgeSeconds);
  if (!Number.isInteger(maxAgeSeconds)
    || maxAgeSeconds < 1
    || maxAgeSeconds > ET_LOW_INVENTORY_MAX_AGE_HARD_LIMIT_SECONDS) {
    blockers.push('ET safety source max-age binding is missing or invalid');
  }
  const validateFreshTimestamp = (label, value) => {
    const timestampMs = new Date(value || '').getTime();
    if (!Number.isFinite(timestampMs)) {
      blockers.push(`${label} is unreadable`);
      return;
    }
    if (beijingDate(value) !== text(etFactSource.targetDate)) {
      blockers.push(`${label} date does not match the bound ET target date`);
    }
    if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > ET_LOW_INVENTORY_MAX_AGE_HARD_LIMIT_SECONDS) return;
    const ageSeconds = (Date.now() - timestampMs) / 1_000;
    if (ageSeconds < -ET_LOW_INVENTORY_MAX_FUTURE_SKEW_SECONDS || ageSeconds > maxAgeSeconds) {
      blockers.push(`${label} is outside the bound freshness window`);
    }
  };
  validateFreshTimestamp('ET safety source manifest createdAt', etFactSource.createdAt);
  if (etFactSource.completeInventoryEvidence !== true || Number(etFactSource.invalidRows || 0) !== 0) {
    blockers.push('ET safety source complete inventory evidence is missing');
  }
  for (const endpoint of ['store_stock', 'box_stock']) {
    const file = etFactSource?.files?.[endpoint];
    if (!file
      || file.complete !== true
      || !text(file.path)
      || !/^[a-f0-9]{64}$/i.test(text(file.hash))
      || !isNonNegativeInteger(file.rowCount)
      || !isNonNegativeInteger(file.count)
      || !isNonNegativeInteger(file.rawRowCount)
      || !isNonNegativeInteger(file.pageCount)
      || Number(file.pageCount) < 1
      || Number(file.rowCount) !== Number(file.count)
      || Number(file.rowCount) !== Number(file.rawRowCount)
      || Number(etFactSource?.endpointRows?.[endpoint]) !== Number(file.rowCount)) {
      blockers.push(`ET safety source ${endpoint} completeness binding is invalid`);
      continue;
    }
    validateFreshTimestamp(`ET safety source ${endpoint} fetchedAt`, file.fetchedAt);
  }
  const expectedEvidenceHash = etInventoryEvidenceHash({
    manifestHash: etFactSource.manifestHash,
    batchId: etFactSource.batchId,
    targetDate: etFactSource.targetDate,
    files: etFactSource.files,
  });
  if (!/^[a-f0-9]{64}$/i.test(text(etFactSource.inventoryEvidenceHash))
    || text(etFactSource.inventoryEvidenceHash).toLowerCase() !== expectedEvidenceHash) {
    blockers.push('ET safety source inventory evidence hash mismatch');
  }
  if (text(etFactSource.targetDate) !== text(sourcePlan?.date)) {
    blockers.push(`ET safety source date binding mismatch: expected=${sourcePlan?.date || '(missing)'} actual=${etFactSource.targetDate || '(missing)'}`);
  }
}

function parseArgs(argv) {
  const args = {sourcePlan: '', out: '', batchId: '', manifestHash: ''};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--source-plan') args.sourcePlan = path.resolve(argv[++i] || '');
    else if (arg === '--out') args.out = path.resolve(argv[++i] || '');
    else if (arg === '--batch-id') args.batchId = String(argv[++i] || '').trim();
    else if (arg === '--manifest-hash') args.manifestHash = String(argv[++i] || '').trim().toLowerCase();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.sourcePlan) throw new Error('--source-plan is required');
  if (!args.out) throw new Error('--out is required');
  if (!args.batchId) throw new Error('--batch-id is required');
  return args;
}

export function buildEtLowInventorySafetyPlan(sourcePlan, {batchId, manifestHash = ''} = {}) {
  if (sourcePlan?.schemaVersion !== 'daily-inventory-replenishment-plan/v1') {
    throw new Error(`Unsupported source plan schema: ${sourcePlan?.schemaVersion || '(missing)'}`);
  }
  const lowEtAllocations = Array.isArray(sourcePlan.lowEtAllocations) ? sourcePlan.lowEtAllocations : [];
  const actionable = (Array.isArray(sourcePlan.actionable) ? sourcePlan.actionable : [])
    .filter(row => row.ruleClass === 'low_et_top_exposure_allocation')
    .filter(row => Number(row.targetUsableInventory) < Number(row.platformUsableInventory))
    .map(row => ({...row, inventoryAction: 'decrease', replenishmentQuantity: 0}))
    .sort((a, b) => String(a.storeKey).localeCompare(String(b.storeKey)) || String(a.skc).localeCompare(String(b.skc)));
  const positiveLowEtCanonicalCount = new Set(lowEtAllocations
    .filter(row => Number(row.etSellableInventory) > 0)
    .map(row => row.matchKey)
    .filter(Boolean)).size;
  const zeroEtCanonicalCount = new Set(lowEtAllocations
    .filter(row => Number(row.etSellableInventory) === 0)
    .map(row => row.matchKey)
    .filter(Boolean)).size;
  const etFactSource = sourcePlan?.etFactSource && typeof sourcePlan.etFactSource === 'object'
    ? sourcePlan.etFactSource
    : null;
  const blockers = [...new Set(Array.isArray(sourcePlan.blockers) ? sourcePlan.blockers : [])];
  validateEtFactSource(etFactSource, sourcePlan, blockers);
  if (manifestHash) {
    if (!/^[a-f0-9]{64}$/i.test(manifestHash)) {
      blockers.push('ET safety trigger manifest hash is invalid');
    }
    if (!etFactSource || etFactSource.kind !== 'et_forwarder_manifest') {
      blockers.push('ET safety source fact binding is missing');
    } else {
      if (String(etFactSource.batchId || '') !== String(batchId || '')) {
        blockers.push(`ET safety source batch binding mismatch: expected=${batchId || '(missing)'} actual=${etFactSource.batchId || '(missing)'}`);
      }
      if (String(etFactSource.manifestHash || '').toLowerCase() !== manifestHash) {
        blockers.push(`ET safety source manifest hash mismatch: expected=${manifestHash} actual=${etFactSource.manifestHash || '(missing)'}`);
      }
    }
  } else if (etFactSource) {
    blockers.push('ET safety trigger manifest hash is missing');
    if (String(etFactSource.batchId || '') !== String(batchId || '')) {
      blockers.push(`ET safety source batch binding mismatch: expected=${batchId || '(missing)'} actual=${etFactSource.batchId || '(missing)'}`);
    }
  }
  const uniqueBlockers = [...new Set(blockers)];
  const executionConstraints = {
    mode: 'et_low_inventory_safety',
    decreaseOnly: true,
    maximumEtSellableInventory: 10,
    triggerBatchId: batchId,
    triggerTargetDate: sourcePlan.date,
    triggerManifestHash: manifestHash || etFactSource?.manifestHash || '',
  };
  const plan = {
    schemaVersion: 'et-low-inventory-safety-plan/v1',
    date: sourcePlan.date,
    policyVersion: sourcePlan.policyVersion,
    generatedAt: new Date().toISOString(),
    sourcePlanHash: sourcePlan.payloadHash,
    etFactSource,
    sourceEvidence: sourcePlan.sourceEvidence || [],
    blockers: uniqueBlockers,
    executionConstraints,
    actionable,
    lowEtAllocations,
    linkAlerts: sourcePlan.linkAlerts || [],
    ignored: sourcePlan.ignored || [],
    crossStoreSoldOutFindings: sourcePlan.crossStoreSoldOutFindings || [],
    etAlerts: sourcePlan.etAlerts || [],
  };
  plan.payloadHash = stableInventoryHash({
    schemaVersion: plan.schemaVersion,
    date: plan.date,
    policyVersion: plan.policyVersion,
    actionable: plan.actionable,
    lowEtAllocations: plan.lowEtAllocations,
    etFactSource: plan.etFactSource,
    sourceEvidence: plan.sourceEvidence.map(({
      ageHours: _ageHours,
      manifestAgeSeconds: _manifestAgeSeconds,
      endpointAgeSeconds: _endpointAgeSeconds,
      ...evidence
    }) => evidence),
    executionConstraints: plan.executionConstraints,
  });
  plan.executable = uniqueBlockers.length === 0;
  plan.watch = {
    active: positiveLowEtCanonicalCount > 0 || Number(sourcePlan?.counts?.lowEtBlockedCanonicalCount || 0) > 0
      || Number(sourcePlan?.counts?.unknownEtCanonicalCount || 0) > 0,
    positiveLowEtCanonicalCount,
    zeroEtCanonicalCount,
    blockedLowEtCanonicalCount: Number(sourcePlan?.counts?.lowEtBlockedCanonicalCount || 0),
    unknownEtCanonicalCount: Number(sourcePlan?.counts?.unknownEtCanonicalCount || 0),
  };
  plan.counts = {
    enabledStores: Number(sourcePlan?.counts?.enabledStores || 0),
    scannedLinks: Number(sourcePlan?.counts?.scannedLinks || 0),
    inventoryRelevantLinks: Number(sourcePlan?.counts?.inventoryRelevantLinks || 0),
    lowEtAllocationRows: lowEtAllocations.length,
    lowEtCanonicalCount: new Set(lowEtAllocations.map(row => row.matchKey).filter(Boolean)).size,
    positiveLowEtCanonicalCount,
    zeroEtCanonicalCount,
    blockedLowEtCanonicalCount: Number(sourcePlan?.counts?.lowEtBlockedCanonicalCount || 0),
    unknownEtCanonicalCount: Number(sourcePlan?.counts?.unknownEtCanonicalCount || 0),
    actionable: actionable.length,
    inventoryDecreases: actionable.length,
    inventoryIncreases: 0,
    filteredOutIncreaseActions: (sourcePlan.actionable || []).filter(row => row.ruleClass === 'low_et_top_exposure_allocation')
      .filter(row => Number(row.targetUsableInventory) > Number(row.platformUsableInventory)).length,
  };
  return plan;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourcePlan = JSON.parse(await fs.readFile(args.sourcePlan, 'utf8'));
  const plan = buildEtLowInventorySafetyPlan(sourcePlan, {batchId: args.batchId, manifestHash: args.manifestHash});
  await fs.mkdir(path.dirname(args.out), {recursive: true});
  await fs.writeFile(`${args.out}.tmp`, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  await fs.rename(`${args.out}.tmp`, args.out);
  console.log(JSON.stringify({
    ok: plan.executable,
    out: path.relative(ROOT, args.out).replaceAll(path.sep, '/'),
    payloadHash: plan.payloadHash,
    watch: plan.watch,
    counts: plan.counts,
    blockers: plan.blockers,
  }, null, 2));
  if (!plan.executable) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error?.stack || String(error));
    process.exit(1);
  });
}
