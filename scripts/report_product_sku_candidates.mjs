#!/usr/bin/env node
/**
 * Scan fetched SHEIN detail JSON files and produce a review list for product
 * SKU aliases that may need user confirmation.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  normalizeGoodsSnDetailed,
} from '../lib/product_sku_normalizer.mjs';
import {isValidSalesGoodsRow, salesAmountSar, salesQuantity} from '../lib/shein_sales_validity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORES_PATH = path.join(ROOT, 'config', 'stores.json');
const FETCH_DIR = path.join(ROOT, 'outputs', 'shein_fetch');
const REPORT_DIR = path.join(ROOT, 'outputs', 'reports');

function parseArgs(argv) {
  const args = {group: 'DSY'};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--group') args.group = argv[++i].toUpperCase();
    else if (a === '--stores') args.stores = argv[++i].split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--month') args.month = argv[++i];
    else if (a === '--start') args.start = argv[++i];
    else if (a === '--end') args.end = argv[++i];
  }
  if (args.month) {
    if (!/^\d{4}-\d{2}$/.test(args.month)) throw new Error('Invalid --month, expected YYYY-MM');
    args.start = `${args.month}-01`;
    args.end = `${args.month}-${String(new Date(Number(args.month.slice(0, 4)), Number(args.month.slice(5, 7)), 0).getDate()).padStart(2, '0')}`;
  }
  if (!args.start || !args.end) throw new Error('Use --month YYYY-MM or --start/--end YYYY-MM-DD');
  return args;
}

function* eachDate(start, end) {
  const d = new Date(`${start}T00:00:00Z`);
  const stop = new Date(`${end}T00:00:00Z`);
  while (d <= stop) {
    yield `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

function selectedStores(storesConfig, args) {
  const enabled = storesConfig.stores.filter(s => s.enabled !== false && s.productStatsEnabled !== false);
  if (args.stores?.length) {
    return args.stores.map(key => {
      const store = enabled.find(s => s.storeKey.toUpperCase() === key);
      if (!store) throw new Error(`Unknown, disabled, or product-disabled store: ${key}`);
      return store;
    });
  }
  const keys = storesConfig.groups?.[args.group] || [];
  return keys.map(key => enabled.find(s => s.storeKey === key)).filter(Boolean);
}

function addExample(item, example) {
  if (item.examples.length >= 3) return;
  if (item.examples.some(e => e.rawGoodsSn === example.rawGoodsSn && e.goodsTitle === example.goodsTitle)) return;
  item.examples.push(example);
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const storesConfig = JSON.parse(await fs.readFile(STORES_PATH, 'utf8'));
  const stores = selectedStores(storesConfig, args);
  const map = new Map();
  const missing = [];
  for (const store of stores) {
    for (const date of eachDate(args.start, args.end)) {
      const file = path.join(FETCH_DIR, store.storeKey, `${date}.json`);
      const obj = await readJsonIfExists(file);
      if (!obj?.goodsRows) {
        missing.push({storeKey: store.storeKey, date});
        continue;
      }
      for (const g of obj.goodsRows || []) {
        if (!isValidSalesGoodsRow(g)) continue;
        const qty = salesQuantity(g);
        const salesSar = salesAmountSar(g);
        if (qty <= 0 || salesSar <= 0) continue;
        const rawGoodsSn = String(g.goodsSn || g.skuSn || g.skuCode || g.skcName || '').trim();
        const detail = normalizeGoodsSnDetailed(rawGoodsSn, {goodsTitle: g.goodsTitle});
        const key = `${detail.canonical}__${detail.cleaned}`;
        if (!map.has(key)) {
          map.set(key, {
            canonical: detail.canonical,
            cleaned: detail.cleaned,
            matched: detail.matched,
            matchedAlias: detail.matchedAlias,
            needsReview: detail.needsReview,
            reviewReason: detail.reviewReason,
            qty: 0,
            salesSar: 0,
            stores: new Set(),
            firstDate: date,
            lastDate: date,
            examples: [],
          });
        }
        const item = map.get(key);
        item.qty += qty;
        item.salesSar = round2(item.salesSar + salesSar);
        item.stores.add(store.storeKey);
        if (date < item.firstDate) item.firstDate = date;
        if (date > item.lastDate) item.lastDate = date;
        addExample(item, {
          date,
          storeKey: store.storeKey,
          rawGoodsSn,
          goodsTitle: String(g.goodsTitle || '').slice(0, 300),
        });
      }
    }
  }

  const rows = [...map.values()].map(item => ({
    canonical: item.canonical,
    cleaned: item.cleaned,
    matched: item.matched,
    matchedAlias: item.matchedAlias,
    needsReview: item.needsReview,
    reviewReason: item.reviewReason,
    qty: item.qty,
    salesSar: round2(item.salesSar),
    stores: [...item.stores].join('|'),
    firstDate: item.firstDate,
    lastDate: item.lastDate,
    examples: item.examples,
  })).sort((a, b) => Number(b.needsReview) - Number(a.needsReview) || b.salesSar - a.salesSar || a.canonical.localeCompare(b.canonical));

  const reviewRows = rows.filter(r => r.needsReview);
  const aliasMatchedRows = rows.filter(r => r.matched);
  await fs.mkdir(REPORT_DIR, {recursive: true});
  const label = args.month || `${args.start}_to_${args.end}`;
  const jsonFile = path.join(REPORT_DIR, `product-sku-candidates-${label}.json`);
  const csvFile = path.join(REPORT_DIR, `product-sku-candidates-${label}.csv`);
  await fs.writeFile(jsonFile, JSON.stringify({generatedAt: new Date().toISOString(), args, rows, reviewRows, aliasMatchedRows, missing}, null, 2), 'utf8');
  const csvHeader = ['needsReview', 'reviewReason', 'canonical', 'cleaned', 'matched', 'matchedAlias', 'qty', 'salesSar', 'stores', 'firstDate', 'lastDate', 'exampleRawGoodsSn', 'exampleTitle'];
  const csvLines = [csvHeader.join(',')];
  for (const r of reviewRows) {
    csvLines.push([
      r.needsReview,
      r.reviewReason,
      r.canonical,
      r.cleaned,
      r.matched,
      r.matchedAlias,
      r.qty,
      r.salesSar,
      r.stores,
      r.firstDate,
      r.lastDate,
      r.examples[0]?.rawGoodsSn || '',
      r.examples[0]?.goodsTitle || '',
    ].map(csvEscape).join(','));
  }
  await fs.writeFile(csvFile, csvLines.join('\n'), 'utf8');

  console.log(JSON.stringify({
    ok: true,
    label,
    totalProductKeys: rows.length,
    reviewCount: reviewRows.length,
    aliasMatchedCount: aliasMatchedRows.length,
    missingDetailFiles: missing.length,
    topReviewRows: reviewRows.slice(0, 20).map(r => ({
      canonical: r.canonical,
      cleaned: r.cleaned,
      needsReview: r.needsReview,
      reviewReason: r.reviewReason,
      qty: r.qty,
      salesSar: r.salesSar,
      example: r.examples[0],
    })),
    jsonFile: path.relative(ROOT, jsonFile),
    csvFile: path.relative(ROOT, csvFile),
  }, null, 2));
}

await main();
