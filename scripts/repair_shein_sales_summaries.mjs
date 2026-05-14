#!/usr/bin/env node
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isValidSalesGoodsRow, salesExclusionReason, summarizeSalesGoodsRows} from '../lib/shein_sales_validity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FETCH_DIR = path.join(ROOT, 'outputs', 'shein_fetch');
const REPORT_DIR = path.join(ROOT, 'outputs', 'reports');
const STORES_PATH = path.join(ROOT, 'config', 'stores.json');
const FX = 1.8;

function parseArgs(argv) {
  const args = {write: false, start: '', end: '', stores: [], group: ''};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--write') args.write = true;
    else if (a === '--start') args.start = argv[++i];
    else if (a === '--end') args.end = argv[++i];
    else if (a === '--date') args.start = args.end = argv[++i];
    else if (a === '--stores') args.stores = argv[++i].split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--group') args.group = argv[++i].trim().toUpperCase();
  }
  return args;
}

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function listFiles(args) {
  const cfg = await readJson(STORES_PATH);
  let stores = (cfg.stores || []).filter(s => s.enabled !== false);
  if (args.group) stores = stores.filter(s => String(s.groupKey || '').toUpperCase() === args.group);
  if (args.stores.length) stores = stores.filter(s => args.stores.includes(String(s.storeKey || '').toUpperCase()));

  const files = [];
  for (const store of stores) {
    const dir = path.join(FETCH_DIR, store.storeKey);
    if (!fssync.existsSync(dir)) continue;
    for (const name of await fs.readdir(dir)) {
      if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) continue;
      const date = name.slice(0, 10);
      if (args.start && date < args.start) continue;
      if (args.end && date > args.end) continue;
      files.push({storeKey: store.storeKey, date, file: path.join(dir, name)});
    }
  }
  return files.sort((a, b) => a.date.localeCompare(b.date) || a.storeKey.localeCompare(b.storeKey));
}

function numDiff(a, b, eps = 0.0001) {
  return Math.abs(Number(a || 0) - Number(b || 0)) > eps;
}

function buildSummary(obj) {
  const summary = obj.summary || {};
  const goodsRows = Array.isArray(obj.goodsRows) ? obj.goodsRows : [];
  const goodsSales = summarizeSalesGoodsRows(goodsRows);
  const salesSar = round2(goodsSales.salesSar);
  return {
    ...summary,
    positiveAmountOrderCount: goodsSales.positiveAmountOrderCount,
    goodsLineCount: goodsRows.length,
    quantityAll: goodsSales.quantityAll,
    quantityPositiveAmount: goodsSales.quantityPositiveAmount,
    salesSar,
    salesRmb: round2(salesSar * FX),
    salesGoodsLineCount: goodsSales.salesGoodsLineCount,
    excludedGoodsLineCount: goodsSales.excludedGoodsLineCount,
    excludedSalesSar: round2(goodsSales.excludedSalesSar),
    excludedQuantity: goodsSales.excludedQuantity,
  };
}

function changedSummary(oldSummary = {}, newSummary = {}) {
  return [
    'positiveAmountOrderCount',
    'goodsLineCount',
    'quantityAll',
    'quantityPositiveAmount',
    'salesSar',
    'salesRmb',
    'salesGoodsLineCount',
    'excludedGoodsLineCount',
    'excludedSalesSar',
    'excludedQuantity',
  ].some(k => numDiff(oldSummary[k], newSummary[k]));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = await listFiles(args);
  const changes = [];
  let rewritten = 0;
  let totalOldSar = 0;
  let totalNewSar = 0;
  let totalExcludedSar = 0;

  for (const item of files) {
    let obj;
    try { obj = await readJson(item.file); } catch { continue; }
    if (!obj || !Array.isArray(obj.goodsRows)) continue;

    const oldSummary = obj.summary || {};
    const newSummary = buildSummary(obj);
    let rowAnnotationChanged = false;
    for (const row of obj.goodsRows) {
      const valid = isValidSalesGoodsRow(row);
      const reason = salesExclusionReason(row);
      if (row.isValidSale !== valid) {
        row.isValidSale = valid;
        rowAnnotationChanged = true;
      }
      if ((row.salesExclusionReason || '') !== reason) {
        row.salesExclusionReason = reason;
        rowAnnotationChanged = true;
      }
    }

    const summaryChanged = changedSummary(oldSummary, newSummary);
    totalOldSar += Number(oldSummary.salesSar || 0);
    totalNewSar += Number(newSummary.salesSar || 0);
    totalExcludedSar += Number(newSummary.excludedSalesSar || 0);

    if (summaryChanged || rowAnnotationChanged) {
      const change = {
        storeKey: item.storeKey,
        date: item.date,
        oldSalesSar: round2(oldSummary.salesSar || 0),
        newSalesSar: round2(newSummary.salesSar || 0),
        deltaSalesSar: round2(newSummary.salesSar - Number(oldSummary.salesSar || 0)),
        oldOrders: Number(oldSummary.positiveAmountOrderCount || 0),
        newOrders: newSummary.positiveAmountOrderCount,
        oldQty: Number(oldSummary.quantityPositiveAmount || 0),
        newQty: newSummary.quantityPositiveAmount,
        excludedGoodsLineCount: newSummary.excludedGoodsLineCount,
        excludedSalesSar: newSummary.excludedSalesSar,
        summaryChanged,
        rowAnnotationChanged,
        file: path.relative(ROOT, item.file).replace(/\\/g, '/'),
      };
      changes.push(change);
      if (args.write) {
        obj.summary = newSummary;
        await fs.writeFile(item.file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
        rewritten += 1;
      }
    }
  }

  await fs.mkdir(REPORT_DIR, {recursive: true});
  const report = {
    generatedAt: new Date().toISOString(),
    mode: args.write ? 'write' : 'dry-run',
    fileCount: files.length,
    changedCount: changes.length,
    rewritten,
    totalOldSar: round2(totalOldSar),
    totalNewSar: round2(totalNewSar),
    totalDeltaSar: round2(totalNewSar - totalOldSar),
    totalExcludedSar: round2(totalExcludedSar),
    changes,
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.join(REPORT_DIR, `sales-summary-repair-${stamp}.json`);
  await fs.writeFile(out, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({...report, reportFile: path.relative(ROOT, out).replace(/\\/g, '/')}, null, 2));
}

main().catch(err => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
