#!/usr/bin/env node
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

function parseArgs(argv) {
  const args = {base: '', overlays: [], out: '', date: '', storesConfig: path.resolve('config/stores.json')};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base') args.base = path.resolve(argv[++i] || '');
    else if (arg === '--overlay') args.overlays.push(path.resolve(argv[++i] || ''));
    else if (arg === '--out') args.out = path.resolve(argv[++i] || '');
    else if (arg === '--date') args.date = String(argv[++i] || '').trim();
    else if (arg === '--stores-config') args.storesConfig = path.resolve(argv[++i] || '');
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.base) throw new Error('Missing --base <complete-scan.json>');
  if (!args.overlays.length) throw new Error('Missing --overlay <affected-store-scan.json>');
  if (!args.out) throw new Error('Missing --out <merged-scan.json>');
  if (args.date && !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error(`Invalid --date ${args.date}; expected YYYY-MM-DD`);
  return args;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function sha256File(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, bytes);
  try {
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, {force: true}).catch(() => {});
  }
}

function storeKey(store) {
  return String(store?.store || store?.storeKey || '').trim().toUpperCase();
}

function rowStoreKey(row) {
  return String(row?.store_key || row?.storeKey || '').trim().toUpperCase();
}

function enabledStoreKeys(storesConfig) {
  if (!Array.isArray(storesConfig?.stores)) throw new Error('stores config has no stores[]');
  const keys = storesConfig.stores
    .filter(store => store?.enabled !== false)
    .map(storeKey);
  if (!keys.length || keys.some(key => !key) || new Set(keys).size !== keys.length) {
    throw new Error('stores config has no enabled stores or contains missing/duplicate store keys');
  }
  return keys;
}

function snapshotTimestamp(doc, label) {
  const values = [doc?.updatedAt, doc?.createdAt, doc?.generatedAt]
    .map(value => Date.parse(String(value || '')))
    .filter(Number.isFinite);
  if (!values.length) throw new Error(`${label} has no parseable createdAt/updatedAt/generatedAt timestamp`);
  return Math.max(...values);
}

function snapshotBusinessDate(doc, label) {
  const raw = [doc?.businessDate, doc?.reportDate, doc?.date, doc?.createdAt]
    .map(value => String(value || '').trim())
    .find(value => /^\d{4}-\d{2}-\d{2}/.test(value));
  if (!raw) throw new Error(`${label} has no same-day business date evidence`);
  return raw.slice(0, 10);
}

function validateSnapshot(doc, label, {allowPartial = false} = {}) {
  if (!Array.isArray(doc?.stores) || !Array.isArray(doc?.rows)) {
    throw new Error(`${label} is not a marketing price scan snapshot`);
  }
  const keys = doc.stores.map(storeKey);
  if (keys.some(key => !key) || new Set(keys).size !== keys.length) {
    throw new Error(`${label} has missing or duplicate store keys`);
  }
  if (!allowPartial && doc.stores.some(store => store?.ok !== true)) {
    throw new Error(`${label} contains a failed store scan`);
  }
  if (!allowPartial && (doc.ok !== true || doc.partial === true)) {
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
const expectedStoreOrder = enabledStoreKeys(await readJson(args.storesConfig));
const expectedStoreSet = new Set(expectedStoreOrder);
const base = await readJson(args.base);
const baseTimestamp = validateSnapshot(base, 'base', {allowPartial: true});
const businessDate = args.date || snapshotBusinessDate(base, 'base');
const baseBusinessDate = snapshotBusinessDate(base, 'base');
if (baseBusinessDate !== businessDate) {
  throw new Error(`base business date mismatch: expected ${businessDate} actual ${baseBusinessDate}`);
}
const baseSha256 = await sha256File(args.base);
const baseStoreKeys = base.stores.map(storeKey);
const unknownBaseStores = baseStoreKeys.filter(key => !expectedStoreSet.has(key));
if (unknownBaseStores.length) {
  throw new Error(`base contains unknown store(s): ${unknownBaseStores.join(',')}`);
}

const storesByKey = new Map(base.stores.map(store => [storeKey(store), store]));
const rowsByStore = new Map(baseStoreKeys.map(key => [key, base.rows.filter(row => rowStoreKey(row) === key)]));
const overlayCandidatesByStore = new Map();

for (const overlayFile of args.overlays) {
  const overlay = await readJson(overlayFile);
  const overlayTimestamp = validateSnapshot(overlay, `overlay ${overlayFile}`);
  const overlayBusinessDate = snapshotBusinessDate(overlay, `overlay ${overlayFile}`);
  if (overlayBusinessDate !== businessDate) {
    throw new Error(`overlay ${overlayFile} business date mismatch: expected ${businessDate} actual ${overlayBusinessDate}`);
  }
  if (overlayTimestamp <= baseTimestamp) {
    throw new Error(`overlay ${overlayFile} is not newer than base (${new Date(overlayTimestamp).toISOString()} <= ${new Date(baseTimestamp).toISOString()})`);
  }
  const overlaySha256 = await sha256File(overlayFile);
  for (const store of overlay.stores) {
    const key = storeKey(store);
    const rows = overlay.rows.filter(row => rowStoreKey(row) === key);
    if (!expectedStoreSet.has(key)) throw new Error(`overlay ${overlayFile} contains unknown store ${key}`);
    const candidate = {
      storeKey: key,
      source: overlayFile,
      sha256: overlaySha256,
      businessDate,
      rowCount: rows.length,
      updatedAt: new Date(overlayTimestamp).toISOString(),
      timestamp: overlayTimestamp,
      store,
      rows,
    };
    const current = overlayCandidatesByStore.get(key);
    if (
      !current
      || candidate.timestamp > current.timestamp
      || (candidate.timestamp === current.timestamp && candidate.source.localeCompare(current.source) > 0)
    ) overlayCandidatesByStore.set(key, candidate);
  }
}

for (const candidate of overlayCandidatesByStore.values()) {
  storesByKey.set(candidate.storeKey, candidate.store);
  rowsByStore.set(candidate.storeKey, candidate.rows);
}
const actualStoreKeys = [...storesByKey.keys()].sort();
const expectedSorted = [...expectedStoreOrder].sort();
const missingStores = expectedSorted.filter(key => !storesByKey.has(key));
const unknownStores = actualStoreKeys.filter(key => !expectedStoreSet.has(key));
if (missingStores.length || unknownStores.length) {
  throw new Error(`merged store set mismatch: missing=${missingStores.join(',') || '(none)'} unknown=${unknownStores.join(',') || '(none)'}`);
}
const stores = expectedStoreOrder.map(key => storesByKey.get(key));
const rows = expectedStoreOrder.flatMap(key => rowsByStore.get(key) || []);
const failedStores = stores.filter(store => store?.ok !== true).map(storeKey);
if (failedStores.length) throw new Error(`merged scan still has failed store evidence: ${failedStores.join(',')}`);
const overlays = [...overlayCandidatesByStore.values()]
  .sort((a, b) => expectedStoreOrder.indexOf(a.storeKey) - expectedStoreOrder.indexOf(b.storeKey))
  .map(({storeKey: key, source, sha256, businessDate: date, rowCount, updatedAt}) => ({
    storeKey: key,
    source,
    sha256,
    businessDate: date,
    rowCount,
    updatedAt,
  }));
const merged = {
  ...base,
  ok: stores.length === expectedStoreOrder.length && stores.every(store => store?.ok === true),
  partial: false,
  updatedAt: new Date().toISOString(),
  mergeEvidence: {
    businessDate,
    storesConfig: args.storesConfig,
    storeKeys: expectedStoreOrder,
    base: {source: args.base, sha256: baseSha256, businessDate: baseBusinessDate, storeKeys: baseStoreKeys},
    overlays,
  },
  stores,
  rowCount: rows.length,
  currentRows: rows.filter(row => /^current_/.test(String(row.marketing_price_evidence_type))).length,
  futureRows: rows.filter(row => /^future_/.test(String(row.marketing_price_evidence_type))).length,
  rows,
};

await writeJsonAtomic(args.out, merged);
console.log(JSON.stringify({
  ok: merged.ok,
  out: args.out,
  storeCount: stores.length,
  rowCount: merged.rowCount,
  currentRows: merged.currentRows,
  futureRows: merged.futureRows,
  overlays,
}, null, 2));
