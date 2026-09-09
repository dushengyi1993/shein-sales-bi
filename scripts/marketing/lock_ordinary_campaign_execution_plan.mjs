#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {
  sha256Text,
  validateOrdinaryCampaignDocuments,
  validateReviewedWorkbookPriceRows,
} from '../../lib/marketing_ordinary_campaign_approval.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function rel(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, '/');
}

function parseArgs(argv) {
  const args = {
    selection: '',
    prices: '',
    outputDir: '',
    label: '',
    workbookSha256: '',
    reviewedWorkbook: '',
    approvalText: '',
    approvalSource: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--selection') args.selection = path.resolve(argv[++i] || '');
    else if (key === '--prices') args.prices = path.resolve(argv[++i] || '');
    else if (key === '--output-dir') args.outputDir = path.resolve(argv[++i] || '');
    else if (key === '--label') args.label = String(argv[++i] || '').trim();
    else if (key === '--workbook-sha256') args.workbookSha256 = String(argv[++i] || '').trim().toUpperCase();
    else if (key === '--reviewed-workbook') args.reviewedWorkbook = path.resolve(argv[++i] || '');
    else if (key === '--approval-text') args.approvalText = String(argv[++i] || '').trim();
    else if (key === '--approval-source') args.approvalSource = String(argv[++i] || '').trim();
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!args.selection || !args.prices || !args.outputDir || !args.label || !args.approvalText || !args.approvalSource) {
    throw new Error('Required: --selection <json> --prices <json> --output-dir <dir> --label <name> --approval-text <exact user words> --approval-source <task/message reference>');
  }
  if (args.workbookSha256 && !/^[A-F0-9]{64}$/.test(args.workbookSha256)) throw new Error('Invalid --workbook-sha256');
  const relativeOutput = path.relative(ROOT, args.outputDir);
  if (relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) throw new Error('--output-dir must stay inside repository root');
  return args;
}

const args = parseArgs(process.argv.slice(2));
const [selectionRaw, pricesRaw] = await Promise.all([
  fs.readFile(args.selection, 'utf8'),
  fs.readFile(args.prices, 'utf8'),
]);
const selection = JSON.parse(selectionRaw);
const prices = JSON.parse(pricesRaw);
const validated = validateOrdinaryCampaignDocuments(selection, prices);
const {selectionRows: selectedRows, priceRows} = validated;
let reviewedWorkbook;
if (priceRows.some(row => row.reviewedWorkbookPrice !== undefined)) {
  if (!args.reviewedWorkbook || !args.workbookSha256) throw Error('Reviewed price rows require --reviewed-workbook and --workbook-sha256');
  const relative = path.relative(ROOT, args.reviewedWorkbook);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('--reviewed-workbook must stay inside repository root');
  const stat = await fs.lstat(args.reviewedWorkbook);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('--reviewed-workbook must be a regular file');
  const sha = crypto.createHash('sha256').update(await fs.readFile(args.reviewedWorkbook)).digest('hex');
  if (sha !== args.workbookSha256.toLowerCase()) throw Error('Reviewed workbook SHA-256 mismatch');
  const businessDate = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai'}).format(new Date());
  validateReviewedWorkbookPriceRows(priceRows, {workbookSha256:sha,businessDate});
  reviewedWorkbook = {path:rel(args.reviewedWorkbook),businessDate};
}
const activityCounts = Object.fromEntries(Object.entries(selectedRows.reduce((acc, row) => {
  const key = String(Number(row.activityId || 0));
  acc[key] = (acc[key] || 0) + 1;
  return acc;
}, {})).sort(([a], [b]) => Number(a) - Number(b)));
const storeCounts = Object.fromEntries(Object.entries(selectedRows.reduce((acc, row) => {
  const key = String(row.storeKey || '').toUpperCase();
  acc[key] = (acc[key] || 0) + 1;
  return acc;
}, {})).sort(([a], [b]) => a.localeCompare(b)));

const approvedAt = new Date().toISOString();
const executionMetadata = {
  status: 'user_approved_pending_execution',
  approvedAt,
  approvalSource: args.approvalSource,
  approvalText: args.approvalText,
  activityBatch: args.label,
  rowCount: selectedRows.length,
};
for (const doc of [selection, prices]) {
  doc.baselineForNextOrdinaryActivity = false;
  doc.baselineForLimitedDiscountFallback = false;
  doc.executionStatus = 'user_approved_pending_execution';
  doc.approvedAt = approvedAt;
  doc.scope = {...(doc.scope || {}), phase: `${args.label}-user-approved`, submit: true};
  doc.planMetadata = executionMetadata;
}

const {selectionPayloadHash, pricePayloadHash, workFingerprint} = validated;
selection.planMetadata = {...selection.planMetadata, selectionPayloadHash, pricePayloadHash, workFingerprint};
prices.planMetadata = {...prices.planMetadata, selectionPayloadHash, pricePayloadHash, workFingerprint};

await fs.mkdir(args.outputDir, {recursive: true});
const selectionFile = path.join(args.outputDir, `selection-plan-${args.label}-user-approved.json`);
const priceFile = path.join(args.outputDir, `price-overrides-${args.label}-user-approved.json`);
const manifestFile = path.join(args.outputDir, `approval-manifest-${args.label}.json`);
const selectionOutputText = `${JSON.stringify(selection, null, 2)}\n`;
const priceOutputText = `${JSON.stringify(prices, null, 2)}\n`;
await fs.writeFile(selectionFile, selectionOutputText, 'utf8');
await fs.writeFile(priceFile, priceOutputText, 'utf8');
const manifest = {
  schemaVersion: 1,
  approvedAt,
  label: args.label,
  approvalText: args.approvalText,
  approvalSource: args.approvalSource,
  sourceSelection: rel(args.selection),
  sourcePrices: rel(args.prices),
  outputSelection: rel(selectionFile),
  outputPrices: rel(priceFile),
  workbookSha256: args.workbookSha256,
  ...(reviewedWorkbook ? {reviewedWorkbook} : {}),
  counts: {
    selectedRows: selectedRows.length,
    priceRows: priceRows.length,
    activities: activityCounts,
    stores: storeCounts,
    missingPriceKeys: 0,
    extraPriceKeys: 0,
    duplicateSelectionKeys: 0,
    duplicatePriceKeys: 0,
    invalidPrices: 0,
    missingProductCosts: 0,
    missingStorageCosts: 0,
  },
  hashes: {
    sourceSelectionSha256: sha256Text(selectionRaw),
    sourcePricesSha256: sha256Text(pricesRaw),
    selectionPayloadHash,
    pricePayloadHash,
    workFingerprint,
    outputSelectionSha256: sha256Text(selectionOutputText),
    outputPricesSha256: sha256Text(priceOutputText),
  },
};
await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ok: true, selectionFile, priceFile, manifestFile, manifest}, null, 2));
