#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {stableInventoryHash} from '../../lib/inventory_replenishment_policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const args = {sourcePlan: '', out: '', batchId: ''};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--source-plan') args.sourcePlan = path.resolve(argv[++i] || '');
    else if (arg === '--out') args.out = path.resolve(argv[++i] || '');
    else if (arg === '--batch-id') args.batchId = String(argv[++i] || '').trim();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.sourcePlan) throw new Error('--source-plan is required');
  if (!args.out) throw new Error('--out is required');
  if (!args.batchId) throw new Error('--batch-id is required');
  return args;
}

export function buildEtLowInventorySafetyPlan(sourcePlan, {batchId}) {
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
  const executionConstraints = {
    mode: 'et_low_inventory_safety',
    decreaseOnly: true,
    maximumEtSellableInventory: Math.max(
      0,
      ...lowEtAllocations.map(row => Number(row.etSellableInventory)).filter(Number.isFinite),
    ),
    triggerBatchId: batchId,
  };
  const blockers = [...new Set(Array.isArray(sourcePlan.blockers) ? sourcePlan.blockers : [])];
  const plan = {
    schemaVersion: 'et-low-inventory-safety-plan/v1',
    date: sourcePlan.date,
    policyVersion: sourcePlan.policyVersion,
    generatedAt: new Date().toISOString(),
    sourcePlanHash: sourcePlan.payloadHash,
    sourceEvidence: sourcePlan.sourceEvidence || [],
    blockers,
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
    sourceEvidence: plan.sourceEvidence.map(({ageHours: _ageHours, ...evidence}) => evidence),
    executionConstraints: plan.executionConstraints,
  });
  plan.executable = blockers.length === 0;
  plan.watch = {
    active: positiveLowEtCanonicalCount > 0 || Number(sourcePlan?.counts?.lowEtBlockedCanonicalCount || 0) > 0,
    positiveLowEtCanonicalCount,
    zeroEtCanonicalCount,
    blockedLowEtCanonicalCount: Number(sourcePlan?.counts?.lowEtBlockedCanonicalCount || 0),
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
  const plan = buildEtLowInventorySafetyPlan(sourcePlan, {batchId: args.batchId});
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
