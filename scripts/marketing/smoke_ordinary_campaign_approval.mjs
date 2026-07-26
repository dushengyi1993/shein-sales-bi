#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertOrdinaryCampaignApprovedSubset,
  loadOrdinaryCampaignApproval,
  sha256Text,
  validateOrdinaryCampaignDocuments,
} from '../../lib/marketing_ordinary_campaign_approval.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ordinary-campaign-approval-'));
const selectionPath = path.join(root, 'selection.json');
const pricesPath = path.join(root, 'prices.json');
const manifestPath = path.join(root, 'approval.json');
const approvalText = '按已展示的两行方案提交';
const approvalSource = 'Codex task test';
const approvedAt = '2026-07-26T08:00:00.000Z';
const selection = {
  items: [
    {storeKey: 'DL', activityId: 123, skc: 'sv1', selected: true},
    {storeKey: 'DX', activityId: 123, skc: 'sv2', selected: true},
  ],
  executionStatus: 'user_approved_pending_execution',
};
const prices = {
  items: [
    {storeKey: 'DL', activityId: 123, skc: 'sv1', targetPrice: 100, cost: 50, storageUnitCostSar: 2},
    {storeKey: 'DX', activityId: 123, skc: 'sv2', targetPrice: 120, cost: 60, storageUnitCostSar: 0},
  ],
  executionStatus: 'user_approved_pending_execution',
};
const validated = validateOrdinaryCampaignDocuments(selection, prices);
const metadata = {
  status: 'user_approved_pending_execution',
  approvedAt,
  approvalSource,
  approvalText,
  selectionPayloadHash: validated.selectionPayloadHash,
  pricePayloadHash: validated.pricePayloadHash,
  workFingerprint: validated.workFingerprint,
};
selection.planMetadata = metadata;
prices.planMetadata = metadata;
const selectionText = `${JSON.stringify(selection, null, 2)}\n`;
const pricesText = `${JSON.stringify(prices, null, 2)}\n`;
await fs.writeFile(selectionPath, selectionText, 'utf8');
await fs.writeFile(pricesPath, pricesText, 'utf8');
const manifest = {
  schemaVersion: 1,
  approvedAt,
  approvalText,
  approvalSource,
  outputSelection: 'selection.json',
  outputPrices: 'prices.json',
  hashes: {
    selectionPayloadHash: validated.selectionPayloadHash,
    pricePayloadHash: validated.pricePayloadHash,
    workFingerprint: validated.workFingerprint,
    outputSelectionSha256: sha256Text(selectionText),
    outputPricesSha256: sha256Text(pricesText),
  },
};
await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const loaded = await loadOrdinaryCampaignApproval({root, manifestPath});
assert.equal(loaded.workFingerprint, validated.workFingerprint);
assert.equal(loaded.selectionRows.length, 2);
await fs.writeFile(manifestPath, `${JSON.stringify({
  ...manifest,
  outputSelection: '.\\selection.json',
  outputPrices: '.\\prices.json',
}, null, 2)}\n`, 'utf8');
const portableLoaded = await loadOrdinaryCampaignApproval({root, manifestPath});
assert.equal(portableLoaded.workFingerprint, validated.workFingerprint);
const approvedSubset = assertOrdinaryCampaignApprovedSubset(
  portableLoaded,
  {...selection, items: [selection.items[0]]},
  {...prices, items: [prices.items[0]]},
);
assert.equal(approvedSubset.selectionRows.length, 1);
await assert.rejects(
  async () => assertOrdinaryCampaignApprovedSubset(
    portableLoaded,
    {...selection, items: [selection.items[0]]},
    {...prices, items: [{...prices.items[0], targetPrice: 99}]},
  ),
  /differs from approved plan/,
);

prices.items[0].targetPrice = 99;
await fs.writeFile(pricesPath, `${JSON.stringify(prices, null, 2)}\n`, 'utf8');
await assert.rejects(
  () => loadOrdinaryCampaignApproval({root, manifestPath}),
  /changed after authorization/,
);

await fs.rm(root, {recursive: true, force: true});
console.log(JSON.stringify({
  ok: true,
  immutableApprovedFiles: true,
  exactWorkFingerprint: true,
  exactApprovedSubset: true,
  portableManifestPaths: true,
}));
