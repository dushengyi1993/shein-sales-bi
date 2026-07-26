#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

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
const stores = orderedStoreKeys.map(storeKey => byStore.get(storeKey)).filter(Boolean);
const rows = stores.flatMap(store => store.rows || []);
const activities = stores.flatMap(store => store.activities || []);
const summary = {
  ...base.summary,
  ok: stores.length === orderedStoreKeys.length && stores.every(store => store.ok),
  createdAt: new Date().toISOString(),
  mode: 'read-only-merged-supplemental-store-readback',
  checkedRows: rows.length,
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
if (summary.checkedRows !== summary.plannedRows) summary.ok = false;
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
