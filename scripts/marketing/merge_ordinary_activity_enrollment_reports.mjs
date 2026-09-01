#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ordinaryCampaignRowKey,
  validateOrdinaryCampaignDocuments,
} from '../../lib/marketing_ordinary_campaign_approval.mjs';

function parseArgs(argv) {
  const args = {base: '', patches: [], out: ''};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--base') args.base = path.resolve(argv[++i] || '');
    else if (key === '--patches') args.patches = String(argv[++i] || '').split(',').map(file => path.resolve(file.trim())).filter(Boolean);
    else if (key === '--out') args.out = path.resolve(argv[++i] || '');
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!args.base || !args.patches.length || !args.out) throw new Error('Required: --base --patches --out');
  return args;
}

function count(store, predicate) {
  return (store.rows || []).filter(predicate).length;
}

function resolveRecordedPlanPath(value) {
  const portable = String(value || '').trim().replace(/[\\/]+/g, path.sep);
  if (!portable) throw new Error('Merged readback is missing the approved plan path');
  return path.isAbsolute(portable) ? path.resolve(portable) : path.resolve(process.cwd(), portable);
}

function readbackRowKey(row) {
  return ordinaryCampaignRowKey({
    storeKey: row?.storeKey,
    activityId: row?.activityId,
    skc: row?.skc,
  });
}

const args = parseArgs(process.argv.slice(2));
const base = JSON.parse(await fs.readFile(args.base, 'utf8'));
const patches = await Promise.all(args.patches.map(file => fs.readFile(file, 'utf8').then(JSON.parse)));
const byStore = new Map((base.stores || []).map(store => [store.storeKey, store]));
if (byStore.size !== (base.stores || []).length) throw new Error('Base readback contains duplicate store keys');
const orderedStoreKeys = base.summary?.stores || [...byStore.keys()];
const allowedStoreKeys = new Set(orderedStoreKeys);
const patchedStoreKeys = new Set();
for (const patch of patches) {
  for (const store of patch.stores || []) {
    if (!allowedStoreKeys.has(store.storeKey)) throw new Error(`Patch contains a store outside base scope: ${store.storeKey}`);
    if (patchedStoreKeys.has(store.storeKey)) throw new Error(`Store is replaced by more than one patch: ${store.storeKey}`);
    patchedStoreKeys.add(store.storeKey);
    byStore.set(store.storeKey, store);
  }
}
const stores = orderedStoreKeys.map(storeKey => byStore.get(storeKey)).filter(Boolean).map(store => ({
  ...store,
  rows: (store.rows || []).map(row => row.priceUnavailableNoFillEvidence
    ? {...row, priceUnavailableButFillVerified: false}
    : row),
}));
const rows = stores.flatMap(store => store.rows || []);
const activities = stores.flatMap(store => store.activities || []);
const patchSelectionPlans = [...new Set(patches.map(patch => patch.summary?.selectionPlan).filter(Boolean))];
const patchPriceOverrides = [...new Set(patches.map(patch => patch.summary?.priceOverrides).filter(Boolean))];
if (patchSelectionPlans.length !== 1 || patchPriceOverrides.length !== 1) {
  throw new Error(`All replacement patches must reference one exact merged plan: selection=${patchSelectionPlans.length} prices=${patchPriceOverrides.length}`);
}
const [selectionPlan, priceOverrides] = await Promise.all([
  fs.readFile(resolveRecordedPlanPath(patchSelectionPlans[0]), 'utf8').then(JSON.parse),
  fs.readFile(resolveRecordedPlanPath(patchPriceOverrides[0]), 'utf8').then(JSON.parse),
]);
const validatedPlan = validateOrdinaryCampaignDocuments(selectionPlan, priceOverrides);
const readbackKeys = rows.map(readbackRowKey);
const duplicateReadbackKeys = readbackKeys.filter((key, index) => readbackKeys.indexOf(key) !== index);
if (duplicateReadbackKeys.length) {
  throw new Error(`Merged readback contains duplicate rows: ${[...new Set(duplicateReadbackKeys)].join(',')}`);
}
const readbackKeySet = new Set(readbackKeys);
const missingPlanKeys = validatedPlan.selectionKeys.filter(key => !readbackKeySet.has(key));
const extraReadbackKeys = readbackKeys.filter(key => !validatedPlan.selectionByKey.has(key));
const priceMismatches = rows.flatMap(row => {
  const key = readbackRowKey(row);
  const planned = validatedPlan.priceByKey.get(key);
  const expected = Number(row?.expectedActivityPrice ?? row?.finalTargetPrice);
  const target = Number(planned?.targetPrice);
  return Number.isFinite(expected) && Number.isFinite(target) && Math.abs(expected - target) <= 0.01
    ? []
    : [{key, expected, target}];
});
if (missingPlanKeys.length || extraReadbackKeys.length || priceMismatches.length) {
  throw new Error(`Merged readback does not exactly match the approved plan: ${JSON.stringify({
    missingPlanKeys: missingPlanKeys.slice(0, 20),
    extraReadbackKeys: extraReadbackKeys.slice(0, 20),
    priceMismatches: priceMismatches.slice(0, 20),
  })}`);
}
const planAlignment = {
  ok: true,
  selectionRows: validatedPlan.selectionRows.length,
  priceRows: validatedPlan.priceRows.length,
  readbackRows: rows.length,
  selectionPayloadHash: validatedPlan.selectionPayloadHash,
  pricePayloadHash: validatedPlan.pricePayloadHash,
  workFingerprint: validatedPlan.workFingerprint,
};
const summary = {
  ...base.summary,
  ok: stores.length === orderedStoreKeys.length && stores.every(store => store.ok) && planAlignment.ok,
  createdAt: new Date().toISOString(),
  mode: 'read-only-merged-supplemental-store-readback',
  plannedRows: validatedPlan.selectionRows.length,
  checkedRows: rows.length,
  selectionPlan: patchSelectionPlans[0],
  priceOverrides: patchPriceOverrides[0],
  planAlignment,
  missingRows: rows.filter(row => !row.enrolledOrUnderReview).length,
  priceMismatchRows: rows.filter(row => row.enrolledOrUnderReview && !row.priceOk).length,
  priceUnavailableButFillVerifiedRows: rows.filter(row => row.priceUnavailableButFillVerified).length,
  priceUnavailableNoFillEvidenceRows: rows.filter(row => row.priceUnavailableNoFillEvidence).length,
  extraAvailableRows: activities.reduce((sum, activity) => sum + Number(activity.extraAvailableCount || 0), 0),
  activityListGapRows: activities.reduce((sum, activity) => sum + Number(activity.activityListGapCount || 0), 0),
  badPacketActivities: activities.filter(activity => Number(activity.badPacketCount || 0) > 0).length,
  byStore: Object.fromEntries(stores.map(store => [store.storeKey, {
    ok: store.ok,
    plannedRows: (store.rows || []).length,
    missingRows: count(store, row => !row.enrolledOrUnderReview),
    priceMismatchRows: count(store, row => row.enrolledOrUnderReview && !row.priceOk),
    priceUnavailableButFillVerifiedRows: count(store, row => row.priceUnavailableButFillVerified),
    priceUnavailableNoFillEvidenceRows: count(store, row => row.priceUnavailableNoFillEvidence),
    extraAvailableRows: (store.activities || []).reduce((sum, activity) => sum + Number(activity.extraAvailableCount || 0), 0),
    activityListGapRows: (store.activities || []).reduce((sum, activity) => sum + Number(activity.activityListGapCount || 0), 0),
    reason: store.reason || '',
  }])),
};
const merged = {
  schemaVersion: 1,
  summary,
  stores,
  mergeProvenance: {
    base: args.base,
    patches: args.patches,
    replacedStores: patches.flatMap(patch => (patch.stores || []).map(store => store.storeKey)),
  },
};
await fs.mkdir(path.dirname(args.out), {recursive: true});
await fs.writeFile(args.out, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ok: summary.ok, out: args.out, summary}, null, 2));
process.exitCode = summary.ok ? 0 : 2;
