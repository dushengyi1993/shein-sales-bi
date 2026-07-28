#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateOrdinaryCampaignDocuments} from '../../lib/marketing_ordinary_campaign_approval.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const args = {selections: [], prices: [], outputDir: '', label: ''};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--selection') args.selections.push(path.resolve(argv[++i] || ''));
    else if (key === '--prices') args.prices.push(path.resolve(argv[++i] || ''));
    else if (key === '--output-dir') args.outputDir = path.resolve(argv[++i] || '');
    else if (key === '--label') args.label = String(argv[++i] || '').trim();
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (args.selections.length < 2 || args.selections.length !== args.prices.length || !args.outputDir || !args.label) {
    throw new Error('Required: two or more matching --selection/--prices pairs, --output-dir and --label');
  }
  const relativeOutput = path.relative(ROOT, args.outputDir);
  if (relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) {
    throw new Error('--output-dir must stay inside repository root');
  }
  return args;
}

function rel(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, '/');
}

const args = parseArgs(process.argv.slice(2));
const selectionDocs = await Promise.all(args.selections.map(file => fs.readFile(file, 'utf8').then(JSON.parse)));
const priceDocs = await Promise.all(args.prices.map(file => fs.readFile(file, 'utf8').then(JSON.parse)));
const selectionItems = selectionDocs.flatMap(doc => (doc.items || []).filter(row => row.selected !== false));
const priceItems = priceDocs.flatMap(doc => doc.items || []);
const activityIds = [...new Set(selectionItems.map(row => Number(row.activityId)))].sort((a, b) => a - b);
const stores = [...new Set(selectionItems.map(row => String(row.storeKey).toUpperCase()))].sort();
const createdAt = new Date().toISOString();

const selection = {
  createdAt,
  sourceSelections: args.selections.map(rel),
  sourcePrices: args.prices.map(rel),
  activityIds,
  stores,
  selectionPolicy: {
    rule: 'merged_executed_ordinary_campaign_baseline',
    note: 'Exact union of the previously executed main plan and the user-approved excluded-row supplement.',
  },
  totals: {
    selectedRows: selectionItems.length,
    excludedRows: 0,
    selectionItems: selectionItems.length,
  },
  scope: {
    storeKeys: stores,
    phase: `${args.label}-merged-readback`,
    submit: false,
  },
  mode: 'allowlist',
  items: selectionItems,
  excluded: [],
};
const prices = {
  createdAt,
  sourceSelections: args.selections.map(rel),
  sourcePrices: args.prices.map(rel),
  activityIds,
  stores,
  selectionPolicy: {
    rule: 'merged_executed_ordinary_campaign_baseline',
    note: 'Exact union of row-level prices from the main plan and supplement.',
  },
  totals: {
    selectedRows: priceItems.length,
    excludedRows: 0,
    priceOverrideItems: priceItems.length,
  },
  scope: {
    storeKeys: stores,
    phase: `${args.label}-merged-readback`,
  },
  items: priceItems,
  excluded: [],
};
const validated = validateOrdinaryCampaignDocuments(selection, prices);

await fs.mkdir(args.outputDir, {recursive: true});
const selectionFile = path.join(args.outputDir, `selection-plan-${args.label}.json`);
const pricesFile = path.join(args.outputDir, `price-overrides-${args.label}.json`);
const auditFile = path.join(args.outputDir, `audit-${args.label}.json`);
await fs.writeFile(selectionFile, `${JSON.stringify(selection, null, 2)}\n`, 'utf8');
await fs.writeFile(pricesFile, `${JSON.stringify(prices, null, 2)}\n`, 'utf8');
const audit = {
  ok: true,
  createdAt,
  selectedRows: selectionItems.length,
  priceRows: priceItems.length,
  stores,
  activityIds,
  byActivity: Object.fromEntries(activityIds.map(activityId => [
    String(activityId),
    selectionItems.filter(row => Number(row.activityId) === activityId).length,
  ])),
  selectionPayloadHash: validated.selectionPayloadHash,
  pricePayloadHash: validated.pricePayloadHash,
  workFingerprint: validated.workFingerprint,
  selectionFile: rel(selectionFile),
  pricesFile: rel(pricesFile),
};
await fs.writeFile(auditFile, `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({...audit, auditFile: rel(auditFile)}, null, 2));
