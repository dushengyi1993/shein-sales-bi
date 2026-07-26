#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  ordinaryCampaignRowKey,
  validateOrdinaryCampaignDocuments,
} from '../../lib/marketing_ordinary_campaign_approval.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function split(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function parseArgs(argv) {
  const args = {selection: '', prices: '', outputDir: '', label: '', stores: [], activities: [], includeSkcs: [], excludeSkcs: [], excludeTargetFiles: [], excludeKeys: new Set()};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--selection') args.selection = path.resolve(argv[++i] || '');
    else if (key === '--prices') args.prices = path.resolve(argv[++i] || '');
    else if (key === '--output-dir') args.outputDir = path.resolve(argv[++i] || '');
    else if (key === '--label') args.label = String(argv[++i] || '').trim();
    else if (key === '--stores') args.stores = split(argv[++i]).map(item => item.toUpperCase());
    else if (key === '--activities') args.activities = split(argv[++i]).map(Number).filter(Boolean);
    else if (key === '--include-skcs') args.includeSkcs = split(argv[++i]).map(item => item.toLowerCase());
    else if (key === '--exclude-skcs') args.excludeSkcs = split(argv[++i]).map(item => item.toLowerCase());
    else if (key === '--exclude-targets') args.excludeTargetFiles = split(argv[++i]).map(file => path.resolve(file));
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!args.selection || !args.prices || !args.outputDir || !args.label) {
    throw new Error('Required: --selection --prices --output-dir --label');
  }
  const relativeOutput = path.relative(ROOT, args.outputDir);
  if (relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) throw new Error('--output-dir must stay inside repository root');
  return args;
}

function included(row, args) {
  const store = String(row.storeKey || '').toUpperCase();
  const activity = Number(row.activityId || 0);
  const skc = String(row.skc || '').toLowerCase();
  const exactKey = `${store}:${activity}:${skc}`;
  return (!args.stores.length || args.stores.includes(store))
    && (!args.activities.length || args.activities.includes(activity))
    && (!args.includeSkcs.length || args.includeSkcs.includes(skc))
    && !args.excludeSkcs.includes(skc)
    && !args.excludeKeys.has(exactKey);
}

const args = parseArgs(process.argv.slice(2));
for (const file of args.excludeTargetFiles) {
  const rows = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!Array.isArray(rows)) throw new Error(`--exclude-targets must contain a JSON array: ${file}`);
  for (const row of rows) {
    args.excludeKeys.add(`${String(row.storeKey || '').toUpperCase()}:${Number(row.activityId || 0)}:${String(row.skc || '').toLowerCase()}`);
  }
}
const [selection, prices] = await Promise.all([
  fs.readFile(args.selection, 'utf8').then(JSON.parse),
  fs.readFile(args.prices, 'utf8').then(JSON.parse),
]);
selection.items = (selection.items || []).filter(row => row.selected !== false && included(row, args));
prices.items = (prices.items || []).filter(row => included(row, args));
const selectedKeys = new Set(selection.items.map(ordinaryCampaignRowKey));
prices.items = prices.items.filter(row => selectedKeys.has(ordinaryCampaignRowKey(row)));
validateOrdinaryCampaignDocuments(selection, prices);
const stores = [...new Set(selection.items.map(row => row.storeKey))].sort();
const activities = [...new Set(selection.items.map(row => Number(row.activityId)))].sort((a, b) => a - b);
for (const doc of [selection, prices]) {
  doc.stores = stores;
  doc.activityIds = activities;
  doc.totals = {...(doc.totals || {}), selectedRows: selection.items.length};
  doc.scope = {...(doc.scope || {}), storeKeys: stores, phase: `${args.label}-candidate-subset`, submit: false};
  doc.baselineForNextOrdinaryActivity = false;
  doc.baselineForLimitedDiscountFallback = false;
  doc.executionStatus = 'candidate_subset_pending_approval';
  delete doc.approvedAt;
  delete doc.executedAt;
  delete doc.planMetadata;
}
await fs.mkdir(args.outputDir, {recursive: true});
const selectionFile = path.join(args.outputDir, `selection-plan-${args.label}.json`);
const priceFile = path.join(args.outputDir, `price-overrides-${args.label}.json`);
await fs.writeFile(selectionFile, `${JSON.stringify(selection, null, 2)}\n`, 'utf8');
await fs.writeFile(priceFile, `${JSON.stringify(prices, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ok: true, selectionFile, priceFile, rows: selection.items.length, stores, activities, excludedSkcs: args.excludeSkcs}, null, 2));
