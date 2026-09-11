import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {priceVariationSeed,verifyTierPriceVariation} from './marketing_price_variation.mjs';

const reviewedWorkbookCapabilities = new WeakMap();
const shanghaiDate = date => new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(date);

export function validateReviewedWorkbookPriceRows(rows, {workbookSha256, businessDate} = {}) {
  const reviewed = rows.filter(row => row.reviewedWorkbookPrice !== undefined);
  if (!reviewed.length) return reviewed;
  assertSha256(workbookSha256, 'reviewed workbook SHA-256');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate || '') || !Number.isFinite(Date.parse(businessDate))
    || new Date(businessDate).toISOString().slice(0,10)!==businessDate) throw Error('Reviewed workbook business date is required');
  for (const row of reviewed) {
    const proof = row.reviewedWorkbookPrice;
    if (proof?.schemaVersion !== 'ordinary-reviewed-workbook-price/v2'
      || proof.workbookSha256?.toLowerCase() !== workbookSha256.toLowerCase()
      || proof.businessDate !== businessDate
      || ![0, 1, 2].includes(proof.tier)
      || typeof proof.targetPrice !== 'number' || !Number.isFinite(proof.targetPrice) || proof.targetPrice <= 0
      || Math.abs(Math.round(proof.targetPrice * 100) - proof.targetPrice * 100) > 1e-7
      || !String(row.canonical || '').trim()
      || row.cost === null || row.cost === '' || !(Number(row.cost) > 0) || !Number.isFinite(Number(row.cost))
      || row.storageUnitCostSar === null || row.storageUnitCostSar === ''
      || !Number.isFinite(Number(row.storageUnitCostSar)) || Number(row.storageUnitCostSar) < 0
      || !String(proof.reason || '').trim()
      || !Array.isArray(proof.sourceCells) || !proof.sourceCells.length
      || proof.sourceCells.some(cell => typeof cell !== 'string' || !cell.trim())
      || row.manualSpecialLimitedDiscount === true) {
      throw Error(`Invalid reviewed workbook price: ${ordinaryCampaignRowKey(row)}`);
    }
    if (!verifyTierPriceVariation(proof.resolution)
      || proof.resolution.seedKey !== priceVariationSeed(row,businessDate)
      || proof.resolution.tier !== proof.tier
      || proof.resolution.price !== proof.targetPrice
      || proof.resolution.fullUnitCostSar !== Number(row.cost)+Number(row.storageUnitCostSar)
      || JSON.stringify(stableValue(proof.basis)) !== JSON.stringify(stableValue(proof.resolution.basis))) {
      throw Error(`Reviewed workbook variation differs from locked resolution: ${ordinaryCampaignRowKey(row)}`);
    }
    for (const field of ['targetPrice', 'finalTargetPrice', 'limitedDiscountPrice', 'specialPrice']) {
      if ((field === 'targetPrice' || row[field] !== undefined) && row[field] !== proof.targetPrice) {
        throw Error(`Reviewed workbook price differs from locked ${field}: ${ordinaryCampaignRowKey(row)}`);
      }
    }
  }
  return reviewed;
}

// Only a successfully loaded immutable approval can issue this capability.
// Row flags and serialized/cloned objects cannot grant current price authority.
export function readReviewedWorkbookPrice(capability, row, reportDate) {
  const scope = reviewedWorkbookCapabilities.get(capability);
  let rowKey;
  try { rowKey = ordinaryCampaignRowKey(row); } catch {}
  const approved = scope?.rows.get(rowKey);
  if (!row?.reviewedWorkbookPrice && !approved) return {applies: false};
  const fail = reason => ({applies: true, ok: false, reason});
  if (!approved) return fail('reviewed_workbook_price_requires_current_approval');
  if (reportDate !== scope.businessDate) return fail('reviewed_workbook_price_date_changed');
  if (row.manualSpecialLimitedDiscount === true) return fail('active_manual_special_requires_user_review');
  if (JSON.stringify(stableValue(row.reviewedWorkbookPrice)) !== JSON.stringify(stableValue(approved.proof))
    || row.canonical !== approved.canonical || row.cost !== approved.cost
    || row.storageUnitCostSar !== approved.storageUnitCostSar) {
    return fail('reviewed_workbook_price_scope_changed');
  }
  return {applies: true, ok: true, price: approved.proof.targetPrice,
    lockedPrice: approved.proof.targetPrice, variation:structuredClone(approved.proof.resolution), tier: approved.proof.tier,
    productUnitCostSar: Number(approved.cost), storageUnitCostSar: Number(approved.storageUnitCostSar),
    binding: {...structuredClone(approved.proof), rowKey, canonical: approved.canonical,
      manifestHash: scope.manifestHash, workFingerprint: scope.workFingerprint}};
}

export function ordinaryCampaignRowKey(row) {
  const storeKey = String(row?.storeKey || '').trim().toUpperCase();
  const activityId = Number(row?.activityId || 0);
  const skc = String(row?.skc || '').trim().toLowerCase();
  if (!storeKey || !Number.isInteger(activityId) || activityId <= 0 || !skc) {
    throw new Error(`Invalid ordinary campaign row key: ${JSON.stringify({storeKey, activityId, skc})}`);
  }
  return `${storeKey}:${activityId}:${skc}`;
}

export function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, stableValue(value[key])]),
  );
}

export function stableOrdinaryCampaignPayload(rows) {
  return JSON.stringify(
    [...rows]
      .sort((a, b) => ordinaryCampaignRowKey(a).localeCompare(ordinaryCampaignRowKey(b)))
      .map(stableValue),
  );
}

function duplicateKeys(keys) {
  const seen = new Set();
  const duplicates = new Set();
  for (const key of keys) {
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return [...duplicates].sort();
}

export function validateOrdinaryCampaignDocuments(selection, prices, {requireRows = true} = {}) {
  const selectionRows = (selection?.items || []).filter(row => row?.selected !== false);
  const priceRows = Array.isArray(prices?.items) ? prices.items : [];
  const selectionKeys = selectionRows.map(ordinaryCampaignRowKey);
  const priceKeys = priceRows.map(ordinaryCampaignRowKey);
  const duplicateSelectionKeys = duplicateKeys(selectionKeys);
  const duplicatePriceKeys = duplicateKeys(priceKeys);
  const selectionKeySet = new Set(selectionKeys);
  const priceKeySet = new Set(priceKeys);
  const missingPriceKeys = selectionKeys.filter(key => !priceKeySet.has(key));
  const extraPriceKeys = priceKeys.filter(key => !selectionKeySet.has(key));
  const invalidPrices = priceRows
    .filter(row => !Number.isFinite(Number(row?.targetPrice)) || Number(row.targetPrice) <= 0)
    .map(ordinaryCampaignRowKey);
  const missingCosts = priceRows
    .filter(row => !Number.isFinite(Number(row?.cost)) || Number(row.cost) <= 0)
    .map(ordinaryCampaignRowKey);
  const missingStorage = priceRows
    .filter(row => !Number.isFinite(Number(row?.storageUnitCostSar)) || Number(row.storageUnitCostSar) < 0)
    .map(ordinaryCampaignRowKey);
  const errors = [];
  if (requireRows && selectionRows.length === 0) errors.push('approved plan contains no selected rows');
  if (duplicateSelectionKeys.length) errors.push(`duplicate selection keys: ${duplicateSelectionKeys.length}`);
  if (duplicatePriceKeys.length) errors.push(`duplicate price keys: ${duplicatePriceKeys.length}`);
  if (missingPriceKeys.length) errors.push(`missing price keys: ${missingPriceKeys.length}`);
  if (extraPriceKeys.length) errors.push(`extra price keys: ${extraPriceKeys.length}`);
  if (invalidPrices.length) errors.push(`invalid target prices: ${invalidPrices.length}`);
  if (missingCosts.length) errors.push(`missing product costs: ${missingCosts.length}`);
  if (missingStorage.length) errors.push(`missing storage costs: ${missingStorage.length}`);
  if (errors.length) throw new Error(errors.join('; '));

  const selectionPayloadHash = sha256Text(stableOrdinaryCampaignPayload(selectionRows));
  const pricePayloadHash = sha256Text(stableOrdinaryCampaignPayload(priceRows));
  const workFingerprint = sha256Text(JSON.stringify({selectionPayloadHash, pricePayloadHash}));
  return {
    selectionRows,
    priceRows,
    selectionKeys,
    priceKeys,
    selectionPayloadHash,
    pricePayloadHash,
    workFingerprint,
    selectionByKey: new Map(selectionRows.map(row => [ordinaryCampaignRowKey(row), row])),
    priceByKey: new Map(priceRows.map(row => [ordinaryCampaignRowKey(row), row])),
    checks: {
      duplicateSelectionKeys,
      duplicatePriceKeys,
      missingPriceKeys,
      extraPriceKeys,
      invalidPrices,
      missingCosts,
      missingStorage,
    },
  };
}

export function assertOrdinaryCampaignApprovedSubset(approval, selection, prices) {
  const subset = validateOrdinaryCampaignDocuments(selection, prices);
  for (const row of subset.selectionRows) {
    const key = ordinaryCampaignRowKey(row);
    const approvedRow = approval?.selectionByKey?.get(key);
    if (!approvedRow || stableOrdinaryCampaignPayload([row]) !== stableOrdinaryCampaignPayload([approvedRow])) {
      throw new Error(`Selection row is outside or differs from approved plan: ${key}`);
    }
  }
  for (const row of subset.priceRows) {
    const key = ordinaryCampaignRowKey(row);
    const approvedRow = approval?.priceByKey?.get(key);
    if (!approvedRow || stableOrdinaryCampaignPayload([row]) !== stableOrdinaryCampaignPayload([approvedRow])) {
      throw new Error(`Price row is outside or differs from approved plan: ${key}`);
    }
  }
  return subset;
}

function assertInside(root, target, label) {
  const relative = path.relative(root, target);
  if (!relative || relative === '.') return;
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside repository root: ${target}`);
  }
}

function resolveRecordedPath(root, value, label) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error(`Approval manifest is missing ${label}`);
  const portableRelative = raw.replace(/[\\/]+/g, path.sep);
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, portableRelative);
  assertInside(root, resolved, label);
  return resolved;
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function assertSha256(value, label) {
  if (!/^[a-f0-9]{64}$/i.test(String(value || ''))) {
    throw new Error(`Approval manifest has invalid ${label}`);
  }
}

export async function loadOrdinaryCampaignApproval({
  root,
  manifestPath,
  selectionPath = '',
  pricesPath = '',
  now = new Date(),
} = {}) {
  const resolvedRoot = path.resolve(root || process.cwd());
  const resolvedManifestPath = path.resolve(manifestPath || '');
  assertInside(resolvedRoot, resolvedManifestPath, 'approval manifest');
  const manifestText = await fs.readFile(resolvedManifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  if (Number(manifest?.schemaVersion) !== 1) {
    throw new Error(`Unsupported ordinary campaign approval schema: ${manifest?.schemaVersion ?? 'missing'}`);
  }
  if (!String(manifest?.approvalText || '').trim()) throw new Error('Approval manifest is missing approvalText');
  if (!String(manifest?.approvalSource || '').trim()) throw new Error('Approval manifest is missing approvalSource');
  if (!Number.isFinite(Date.parse(String(manifest?.approvedAt || '')))) {
    throw new Error('Approval manifest has invalid approvedAt');
  }

  const recordedSelectionPath = resolveRecordedPath(resolvedRoot, manifest.outputSelection, 'outputSelection');
  const recordedPricesPath = resolveRecordedPath(resolvedRoot, manifest.outputPrices, 'outputPrices');
  const resolvedSelectionPath = selectionPath ? path.resolve(selectionPath) : recordedSelectionPath;
  const resolvedPricesPath = pricesPath ? path.resolve(pricesPath) : recordedPricesPath;
  assertInside(resolvedRoot, resolvedSelectionPath, 'selection plan');
  assertInside(resolvedRoot, resolvedPricesPath, 'price overrides');
  if (!samePath(recordedSelectionPath, resolvedSelectionPath)) {
    throw new Error(`Selection plan does not match approval manifest: expected=${recordedSelectionPath} actual=${resolvedSelectionPath}`);
  }
  if (!samePath(recordedPricesPath, resolvedPricesPath)) {
    throw new Error(`Price overrides do not match approval manifest: expected=${recordedPricesPath} actual=${resolvedPricesPath}`);
  }

  const [selectionText, pricesText] = await Promise.all([
    fs.readFile(resolvedSelectionPath, 'utf8'),
    fs.readFile(resolvedPricesPath, 'utf8'),
  ]);
  // Keep the immutable reviewed pricing source separate from the newly
  // locked execution document. New supplements must inherit its bases;
  // using the output document here makes its own fingerprint self-referential.
  const baselinePricesPath = manifest.baselineSourcePrices
    ? resolveRecordedPath(resolvedRoot, manifest.baselineSourcePrices, 'baselineSourcePrices') : '';
  if (manifest.baselineSourcePrices && !String(manifest.baselineManifest || '').trim()) {
    throw new Error('Approval manifest is missing baselineManifest');
  }
  const baselineManifestPath = manifest.baselineManifest
    ? resolveRecordedPath(resolvedRoot, manifest.baselineManifest, 'baselineManifest') : '';
  if (manifest.baselineSourcePrices && !/^[a-f0-9]{64}$/i.test(String(manifest.baselineSourcePricesSha256 || ''))) {
    throw new Error('Approval manifest is missing baselineSourcePricesSha256');
  }
  const baselinePrices = baselinePricesPath
    ? JSON.parse(await fs.readFile(baselinePricesPath, 'utf8')) : null;
  if (baselineManifestPath) {
    const stat = await fs.lstat(baselineManifestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Baseline manifest must be a regular file');
  }
  if (baselinePricesPath && sha256Text(await fs.readFile(baselinePricesPath, 'utf8')) !== manifest.baselineSourcePricesSha256.toLowerCase()) {
    throw new Error('Baseline source prices changed after authorization');
  }
  assertSha256(manifest?.hashes?.outputSelectionSha256, 'outputSelectionSha256');
  assertSha256(manifest?.hashes?.outputPricesSha256, 'outputPricesSha256');
  if (sha256Text(selectionText) !== String(manifest.hashes.outputSelectionSha256).toLowerCase()) {
    throw new Error('Approved selection plan changed after authorization');
  }
  if (sha256Text(pricesText) !== String(manifest.hashes.outputPricesSha256).toLowerCase()) {
    throw new Error('Approved price overrides changed after authorization');
  }

  const selection = JSON.parse(selectionText);
  const prices = JSON.parse(pricesText);
  const validated = validateOrdinaryCampaignDocuments(selection, prices);
  for (const [label, actual, expected] of [
    ['selectionPayloadHash', validated.selectionPayloadHash, manifest?.hashes?.selectionPayloadHash],
    ['pricePayloadHash', validated.pricePayloadHash, manifest?.hashes?.pricePayloadHash],
    ['workFingerprint', validated.workFingerprint, manifest?.hashes?.workFingerprint],
  ]) {
    assertSha256(expected, label);
    if (actual !== String(expected).toLowerCase()) {
      throw new Error(`Approved ${label} mismatch: expected=${expected} actual=${actual}`);
    }
  }
  for (const [label, doc] of [['selection', selection], ['prices', prices]]) {
    if (doc?.executionStatus !== 'user_approved_pending_execution') {
      throw new Error(`${label} document is not pending approved execution`);
    }
    if (doc?.planMetadata?.workFingerprint !== validated.workFingerprint) {
      throw new Error(`${label} document workFingerprint does not match approval manifest`);
    }
    if (doc?.planMetadata?.approvalText !== manifest.approvalText) {
      throw new Error(`${label} document approvalText does not match approval manifest`);
    }
    if (doc?.planMetadata?.approvalSource !== manifest.approvalSource) {
      throw new Error(`${label} document approvalSource does not match approval manifest`);
    }
  }

  let reviewedWorkbookPriceCapability = null;
  let reviewedWorkbookPriceStatus = 'absent';
  if (validated.priceRows.some(row => row.reviewedWorkbookPrice !== undefined)) {
    const workbook = manifest.reviewedWorkbook;
    const businessDate = workbook?.businessDate;
    if (!businessDate) throw Error('Reviewed workbook business date is required');
    assertSha256(manifest.workbookSha256, 'workbookSha256');
    const workbookPath = resolveRecordedPath(resolvedRoot, workbook.path, 'reviewed workbook');
    const workbookStat = await fs.lstat(workbookPath);
    if (!workbookStat.isFile() || workbookStat.isSymbolicLink()) throw Error('Reviewed workbook must be a regular file');
    const workbookBytes = await fs.readFile(workbookPath);
    const actualSha = crypto.createHash('sha256').update(workbookBytes).digest('hex');
    if (actualSha !== manifest.workbookSha256.toLowerCase()) throw Error('Reviewed workbook changed after authorization');
    const reviewed = validateReviewedWorkbookPriceRows(validated.priceRows, {workbookSha256: actualSha, businessDate});
    // Historical approvals remain readable for terminal reconciliation; they
    // cannot mint today's execution authority or regenerate an executed price.
    reviewedWorkbookPriceStatus = businessDate===shanghaiDate(now)?'current':'historical_readback_only';
    if (reviewedWorkbookPriceStatus==='current') {
      reviewedWorkbookPriceCapability = Object.freeze({});
      reviewedWorkbookCapabilities.set(reviewedWorkbookPriceCapability, {
        businessDate, manifestHash: sha256Text(manifestText), workFingerprint: validated.workFingerprint,
        rows: new Map(reviewed.map(row => [ordinaryCampaignRowKey(row), {
          canonical: row.canonical, cost: row.cost, storageUnitCostSar: row.storageUnitCostSar,
          proof: structuredClone(row.reviewedWorkbookPrice),
        }])),
      });
    }
  }
  return {
    reviewedWorkbookPriceCapability,
    reviewedWorkbookPriceStatus,
    manifest,
    manifestPath: resolvedManifestPath,
    manifestHash: sha256Text(manifestText),
    selection,
    prices,
    baselinePrices,
    selectionPath: resolvedSelectionPath,
    pricesPath: resolvedPricesPath,
    ...validated,
  };
}
