#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const args = {base: '', overlays: [], out: ''};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base') args.base = path.resolve(argv[++i] || '');
    else if (arg === '--overlay') args.overlays.push(path.resolve(argv[++i] || ''));
    else if (arg === '--out') args.out = path.resolve(argv[++i] || '');
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.base) throw new Error('Missing --base <complete-scan.json>');
  if (!args.overlays.length) throw new Error('Missing --overlay <affected-store-scan.json>');
  if (!args.out) throw new Error('Missing --out <merged-scan.json>');
  return args;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function storeKey(store) {
  return String(store?.store || store?.storeKey || '').trim().toUpperCase();
}

function rowStoreKey(row) {
  return String(row?.store_key || row?.storeKey || '').trim().toUpperCase();
}

function snapshotTimestamp(doc, label) {
  const values = [doc?.updatedAt, doc?.createdAt, doc?.generatedAt]
    .map(value => Date.parse(String(value || '')))
    .filter(Number.isFinite);
  if (!values.length) throw new Error(`${label} has no parseable createdAt/updatedAt/generatedAt timestamp`);
  return Math.max(...values);
}

function validateSnapshot(doc, label) {
  if (!Array.isArray(doc?.stores) || !Array.isArray(doc?.rows)) {
    throw new Error(`${label} is not a marketing price scan snapshot`);
  }
  const keys = doc.stores.map(storeKey);
  if (keys.some(key => !key) || new Set(keys).size !== keys.length) {
    throw new Error(`${label} has missing or duplicate store keys`);
  }
  if (doc.stores.some(store => store?.ok !== true)) {
    throw new Error(`${label} contains a failed store scan`);
  }
  if (doc.ok !== true || doc.partial === true) {
    throw new Error(`${label} must be a completed successful scan`);
  }
  const keySet = new Set(keys);
  const foreignRows = doc.rows.filter(row => !keySet.has(rowStoreKey(row)));
  if (foreignRows.length) throw new Error(`${label} has ${foreignRows.length} top-level row(s) for stores absent from stores[]`);
  for (const store of doc.stores) {
    const key = storeKey(store);
    if (!Array.isArray(store?.rows)) throw new Error(`${label} store ${key} has no embedded rows[]`);
    const topRows = doc.rows.filter(row => rowStoreKey(row) === key);
    if (JSON.stringify(store.rows) !== JSON.stringify(topRows)) {
      throw new Error(`${label} store ${key} embedded rows do not match top-level rows`);
    }
  }
  if (doc.rowCount !== undefined && Number(doc.rowCount) !== doc.rows.length) {
    throw new Error(`${label} rowCount=${doc.rowCount} does not match rows.length=${doc.rows.length}`);
  }
  return snapshotTimestamp(doc, label);
}

const args = parseArgs(process.argv.slice(2));
const base = await readJson(args.base);
const baseTimestamp = validateSnapshot(base, 'base');

const baseOrder = base.stores.map(storeKey);
const storesByKey = new Map(base.stores.map(store => [storeKey(store), store]));
const rowsByStore = new Map(baseOrder.map(key => [key, base.rows.filter(row => rowStoreKey(row) === key)]));
const overlays = [];

for (const overlayFile of args.overlays) {
  const overlay = await readJson(overlayFile);
  const overlayTimestamp = validateSnapshot(overlay, `overlay ${overlayFile}`);
  if (overlayTimestamp <= baseTimestamp) {
    throw new Error(`overlay ${overlayFile} is not newer than base (${new Date(overlayTimestamp).toISOString()} <= ${new Date(baseTimestamp).toISOString()})`);
  }
  for (const store of overlay.stores) {
    const key = storeKey(store);
    if (!storesByKey.has(key)) throw new Error(`overlay store ${key} is absent from base`);
    const rows = overlay.rows.filter(row => rowStoreKey(row) === key);
    storesByKey.set(key, store);
    rowsByStore.set(key, rows);
    overlays.push({storeKey: key, source: overlayFile, rowCount: rows.length, updatedAt: new Date(overlayTimestamp).toISOString()});
  }
}

const stores = baseOrder.map(key => storesByKey.get(key));
const rows = baseOrder.flatMap(key => rowsByStore.get(key) || []);
const merged = {
  ...base,
  ok: stores.length === baseOrder.length && stores.every(store => store?.ok === true),
  partial: false,
  updatedAt: new Date().toISOString(),
  mergeEvidence: {
    base: args.base,
    overlays,
  },
  stores,
  rowCount: rows.length,
  currentRows: rows.filter(row => /^current_/.test(String(row.marketing_price_evidence_type))).length,
  futureRows: rows.filter(row => /^future_/.test(String(row.marketing_price_evidence_type))).length,
  rows,
};

await fs.mkdir(path.dirname(args.out), {recursive: true});
await fs.writeFile(args.out, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  ok: merged.ok,
  out: args.out,
  storeCount: stores.length,
  rowCount: merged.rowCount,
  currentRows: merged.currentRows,
  futureRows: merged.futureRows,
  overlays,
}, null, 2));
