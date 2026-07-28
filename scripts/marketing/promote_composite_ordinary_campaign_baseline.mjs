#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  loadOrdinaryCampaignApproval,
  ordinaryCampaignRowKey,
  stableOrdinaryCampaignPayload,
  validateOrdinaryCampaignDocuments,
} from '../../lib/marketing_ordinary_campaign_approval.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const args = {selection: '', prices: '', approvals: [], readback: '', batch: ''};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--selection') args.selection = path.resolve(argv[++i] || '');
    else if (key === '--prices') args.prices = path.resolve(argv[++i] || '');
    else if (key === '--approval-manifest') args.approvals.push(path.resolve(argv[++i] || ''));
    else if (key === '--readback') args.readback = path.resolve(argv[++i] || '');
    else if (key === '--batch') args.batch = String(argv[++i] || '').trim();
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!args.selection || !args.prices || args.approvals.length < 2 || !args.readback || !args.batch) {
    throw new Error('Required: --selection --prices, at least two --approval-manifest values, --readback and --batch');
  }
  return args;
}

function rel(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, '/');
}

function assertExactApprovedUnion(rows, approvalMaps, label) {
  const approvedUnion = new Map();
  for (const approvalMap of approvalMaps) {
    for (const [key, row] of approvalMap) {
      if (approvedUnion.has(key)) throw new Error(`Duplicate ${label} row across approval manifests: ${key}`);
      approvedUnion.set(key, row);
    }
  }
  if (rows.length !== approvedUnion.size) {
    throw new Error(`${label} row count differs from approved union: merged=${rows.length} approved=${approvedUnion.size}`);
  }
  for (const row of rows) {
    const key = ordinaryCampaignRowKey(row);
    const approved = approvedUnion.get(key);
    if (!approved || stableOrdinaryCampaignPayload([row]) !== stableOrdinaryCampaignPayload([approved])) {
      throw new Error(`${label} row differs from approved union: ${key}`);
    }
  }
}

const args = parseArgs(process.argv.slice(2));
const [selection, prices, readback, approvals] = await Promise.all([
  fs.readFile(args.selection, 'utf8').then(JSON.parse),
  fs.readFile(args.prices, 'utf8').then(JSON.parse),
  fs.readFile(args.readback, 'utf8').then(JSON.parse),
  Promise.all(args.approvals.map(manifestPath => loadOrdinaryCampaignApproval({
    root: ROOT,
    manifestPath,
  }))),
]);
const validated = validateOrdinaryCampaignDocuments(selection, prices);
assertExactApprovedUnion(validated.selectionRows, approvals.map(item => item.selectionByKey), 'selection');
assertExactApprovedUnion(validated.priceRows, approvals.map(item => item.priceByKey), 'price');

const summary = readback.summary || {};
const selectedRows = validated.selectionRows.length;
if (
  summary.ok !== true
  || Number(summary.plannedRows) !== selectedRows
  || Number(summary.checkedRows) !== selectedRows
  || Number(summary.missingRows || 0) !== 0
  || Number(summary.priceMismatchRows || 0) !== 0
  || Number(summary.extraAvailableRows || 0) !== 0
  || Number(summary.activityListGapRows || 0) !== 0
  || Number(summary.badPacketActivities || 0) !== 0
) {
  throw new Error(`Readback is not clean enough for composite baseline promotion: ${JSON.stringify(summary)}`);
}

const promotedAt = new Date().toISOString();
const approvalSources = approvals.map(item => ({
  manifest: rel(item.manifestPath),
  manifestHash: item.manifestHash,
  workFingerprint: item.workFingerprint,
  approvalText: item.manifest.approvalText,
  approvalSource: item.manifest.approvalSource,
  rowCount: item.selectionRows.length,
}));
for (const doc of [selection, prices]) {
  doc.baselineForNextOrdinaryActivity = true;
  doc.baselineForLimitedDiscountFallback = true;
  doc.executionStatus = 'completed';
  doc.executedAt = promotedAt;
  doc.planMetadata = {
    ...(doc.planMetadata || {}),
    status: 'current_baseline',
    approvalMode: 'exact_union_of_approved_manifests',
    compositeApprovalSources: approvalSources,
    activityBatch: args.batch,
    rowCount: selectedRows,
    readbackArtifact: rel(args.readback),
    workFingerprint: validated.workFingerprint,
    selectionPayloadHash: validated.selectionPayloadHash,
    pricePayloadHash: validated.pricePayloadHash,
    promotedAt,
  };
}
await Promise.all([
  fs.writeFile(args.selection, `${JSON.stringify(selection, null, 2)}\n`, 'utf8'),
  fs.writeFile(args.prices, `${JSON.stringify(prices, null, 2)}\n`, 'utf8'),
]);
console.log(JSON.stringify({
  ok: true,
  selectedRows,
  promotedAt,
  batch: args.batch,
  readback: rel(args.readback),
  workFingerprint: validated.workFingerprint,
  approvals: approvalSources,
  selection: rel(args.selection),
  prices: rel(args.prices),
}, null, 2));
