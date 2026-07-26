#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadOrdinaryCampaignApproval} from '../../lib/marketing_ordinary_campaign_approval.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function rel(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, '/');
}

function parseArgs(argv) {
  const args = {selection: '', prices: '', approvalManifest: '', selectionOut: '', pricesOut: '', readback: '', batch: ''};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--selection') args.selection = path.resolve(argv[++i] || '');
    else if (key === '--prices') args.prices = path.resolve(argv[++i] || '');
    else if (key === '--approval-manifest') args.approvalManifest = path.resolve(argv[++i] || '');
    else if (key === '--selection-out') args.selectionOut = path.resolve(argv[++i] || '');
    else if (key === '--prices-out') args.pricesOut = path.resolve(argv[++i] || '');
    else if (key === '--readback') args.readback = path.resolve(argv[++i] || '');
    else if (key === '--batch') args.batch = String(argv[++i] || '').trim();
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!args.selection || !args.prices || !args.approvalManifest || !args.readback || !args.batch) {
    throw new Error('Required: --selection --prices --approval-manifest --readback --batch');
  }
  args.selectionOut ||= args.selection;
  args.pricesOut ||= args.prices;
  return args;
}

const args = parseArgs(process.argv.slice(2));
const [approval, readback] = await Promise.all([
  loadOrdinaryCampaignApproval({
    root: ROOT,
    manifestPath: args.approvalManifest,
    selectionPath: args.selection,
    pricesPath: args.prices,
  }),
  fs.readFile(args.readback, 'utf8').then(JSON.parse),
]);
const selection = approval.selection;
const prices = approval.prices;
const selectedRows = (selection.items || []).filter(row => row.selected !== false).length;
const priceRows = (prices.items || []).length;
const summary = readback.summary || {};
if (
  summary.ok !== true
  || Number(summary.plannedRows) !== selectedRows
  || Number(summary.checkedRows) !== selectedRows
  || selectedRows !== priceRows
  || Number(summary.missingRows || 0) !== 0
  || Number(summary.priceMismatchRows || 0) !== 0
  || Number(summary.extraAvailableRows || 0) !== 0
  || Number(summary.activityListGapRows || 0) !== 0
  || Number(summary.badPacketActivities || 0) !== 0
) {
  throw new Error(`Readback is not clean enough for baseline promotion: ${JSON.stringify(summary)}`);
}
const executedAt = new Date().toISOString();
for (const doc of [selection, prices]) {
  doc.baselineForNextOrdinaryActivity = true;
  doc.baselineForLimitedDiscountFallback = true;
  doc.executionStatus = 'completed';
  doc.executedAt = executedAt;
  doc.planMetadata = {
    ...(doc.planMetadata || {}),
    status: 'current_baseline',
    activityBatch: args.batch,
    rowCount: selectedRows,
    readbackArtifact: args.readback,
    approvalManifest: rel(approval.manifestPath),
    approvalManifestHash: approval.manifestHash,
    workFingerprint: approval.workFingerprint,
    promotedAt: executedAt,
  };
}
await Promise.all([
  fs.writeFile(args.selectionOut, `${JSON.stringify(selection, null, 2)}\n`, 'utf8'),
  fs.writeFile(args.pricesOut, `${JSON.stringify(prices, null, 2)}\n`, 'utf8'),
]);
console.log(JSON.stringify({
  ok: true,
  selectedRows,
  priceRows,
  executedAt,
  batch: args.batch,
  readback: args.readback,
  approvalManifest: rel(approval.manifestPath),
  workFingerprint: approval.workFingerprint,
  selectionOut: args.selectionOut,
  pricesOut: args.pricesOut,
}, null, 2));
