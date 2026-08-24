#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeFileAtomic} from '../../lib/atomic_file_publish.mjs';
import {
  loadOrdinaryCampaignApproval,
  ordinaryCampaignRowKey,
  stableOrdinaryCampaignPayload,
  validateOrdinaryCampaignDocuments,
} from '../../lib/marketing_ordinary_campaign_approval.mjs';
import {
  MARKETING_PLAN_REGISTRY_CONFIRM_TOKEN,
  publishMarketingPlanRegistryFromTexts,
  readEnabledMarketingStoreKeysSync,
  validateMarketingPlanPairDocuments,
} from '../../lib/marketing_plan_registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STORES_CONFIG = path.join(ROOT, 'config', 'stores.json');

const BASELINE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function nextValue(argv, index, option) {
  const value = String(argv[index + 1] || '').trim();
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function absoluteOption(value, option) {
  if (!path.isAbsolute(value)) throw new Error(`${option} must be an absolute path`);
  return path.resolve(value);
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function parseArgs(argv) {
  const args = {
    selection: '',
    prices: '',
    approvals: [],
    readback: '',
    batch: '',
    registryFile: '',
    registryRoot: '',
    baselineId: '',
    noRegistryPublish: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--selection') args.selection = path.resolve(nextValue(argv, i++, key));
    else if (key === '--prices') args.prices = path.resolve(nextValue(argv, i++, key));
    else if (key === '--approval-manifest') args.approvals.push(path.resolve(nextValue(argv, i++, key)));
    else if (key === '--readback') args.readback = path.resolve(nextValue(argv, i++, key));
    else if (key === '--batch') args.batch = nextValue(argv, i++, key);
    else if (key === '--registry-file') args.registryFile = absoluteOption(nextValue(argv, i++, key), key);
    else if (key === '--registry-root') args.registryRoot = absoluteOption(nextValue(argv, i++, key), key);
    else if (key === '--baseline-id') args.baselineId = nextValue(argv, i++, key);
    else if (key === '--no-registry-publish') args.noRegistryPublish = true;
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!args.selection || !args.prices || args.approvals.length < 2 || !args.readback || !args.batch) {
    throw new Error('Required: --selection --prices, at least two --approval-manifest values, --readback and --batch');
  }
  if (Boolean(args.registryFile) === args.noRegistryPublish) {
    throw new Error('Choose exactly one of --registry-file <absolute-file> or --no-registry-publish');
  }
  if (args.registryFile && !args.registryRoot) args.registryRoot = path.dirname(args.registryFile);
  if (args.baselineId && !BASELINE_ID_PATTERN.test(args.baselineId)) {
    throw new Error('--baseline-id is missing or unsafe');
  }
  if (samePath(args.selection, args.prices)) {
    throw new Error('--selection and --prices must be different files');
  }
  return args;
}

function rel(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, '/');
}

function deriveBaselineId(batch, workFingerprint) {
  const safeBatch = String(batch || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'batch';
  return `composite-${safeBatch}-${workFingerprint}`;
}

function serializedJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function resolveRecordedReadbackPath(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('Readback is missing an exact plan path');
  const portable = raw.replace(/[\\/]+/g, path.sep);
  return path.isAbsolute(portable) ? path.resolve(portable) : path.resolve(ROOT, portable);
}

function assertReadbackHashBinding(container, validated, label) {
  if (!container || typeof container !== 'object' || Array.isArray(container)) {
    throw new Error(`Readback ${label} exact hash binding is missing`);
  }
  for (const key of ['selectionPayloadHash', 'pricePayloadHash', 'workFingerprint']) {
    if (!Object.hasOwn(container, key)) {
      throw new Error(`Readback ${label}.${key} exact hash binding is missing`);
    }
    const actual = String(container[key] || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(actual) || actual !== validated[key]) {
      throw new Error(`Readback ${label}.${key} mismatch: expected=${validated[key]} actual=${container[key]}`);
    }
  }
}

function assertReadbackFingerprintBinding(container, validated, label) {
  if (!container || typeof container !== 'object' || !Object.hasOwn(container, 'executionWorkFingerprint')) return;
  const actual = String(container.executionWorkFingerprint || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(actual) || actual !== validated.workFingerprint) {
    throw new Error(`Readback ${label}.executionWorkFingerprint mismatch: expected=${validated.workFingerprint} actual=${container.executionWorkFingerprint}`);
  }
}

function optionalFieldEqual(expected, actual) {
  const expectedMissing = expected === undefined || expected === null || expected === '';
  const actualMissing = actual === undefined || actual === null || actual === '';
  if (expectedMissing || actualMissing) return expectedMissing && actualMissing;
  if (typeof expected === 'number' || typeof actual === 'number') {
    const expectedNumber = Number(expected);
    const actualNumber = Number(actual);
    return Number.isFinite(expectedNumber) && Number.isFinite(actualNumber) && expectedNumber === actualNumber;
  }
  return String(expected) === String(actual);
}

function assertReadbackBindsExactPair(readback, {selectionPath, pricesPath, validated, label}) {
  const summary = readback?.summary;
  if (!summary || typeof summary !== 'object') {
    throw new Error(`${label} readback is missing summary identity`);
  }
  const alignment = summary.planAlignment;
  if (!alignment || typeof alignment !== 'object' || Array.isArray(alignment)) {
    throw new Error(`${label} readback planAlignment exact identity is missing or invalid`);
  }
  if (alignment.ok !== true) throw new Error(`${label} readback planAlignment is not clean`);
  for (const [field, expected] of [
    ['selectionRows', validated.selectionRows.length],
    ['priceRows', validated.priceRows.length],
    ['readbackRows', validated.selectionRows.length],
  ]) {
    if (!Object.hasOwn(alignment, field) || !Number.isInteger(alignment[field]) || alignment[field] !== expected) {
      throw new Error(`${label} readback planAlignment.${field} mismatch: expected=${expected} actual=${alignment[field]}`);
    }
  }
  assertReadbackFingerprintBinding(alignment, validated, 'planAlignment');
  assertReadbackFingerprintBinding(summary, validated, 'summary');
  assertReadbackHashBinding(alignment, validated, 'planAlignment');
  for (const [field, expectedPath] of [['selectionPlan', selectionPath], ['priceOverrides', pricesPath]]) {
    const actualPath = resolveRecordedReadbackPath(summary[field]);
    if (!samePath(actualPath, expectedPath)) {
      throw new Error(`${label} readback ${field} mismatch: expected=${expectedPath} actual=${actualPath}`);
    }
  }

  const stores = Array.isArray(readback?.stores) ? readback.stores : [];
  if (!stores.length) throw new Error(`${label} readback is missing row-level stores`);
  const rows = [];
  for (const store of stores) {
    if (!Array.isArray(store?.rows)) throw new Error(`${label} readback store is missing rows: ${store?.storeKey || '(unknown)'}`);
    for (const row of store.rows) {
      if (store.storeKey && String(store.storeKey).toUpperCase() !== String(row?.storeKey || '').toUpperCase()) {
        throw new Error(`${label} readback store/key mismatch: ${store.storeKey}`);
      }
      rows.push(row);
    }
  }
  if (rows.length !== validated.selectionRows.length) {
    throw new Error(`${label} readback row count mismatch: expected=${validated.selectionRows.length} actual=${rows.length}`);
  }
  const expectedSelectionKeys = new Set(validated.selectionRows.map(ordinaryCampaignRowKey));
  const seen = new Set();
  for (const row of rows) {
    const key = ordinaryCampaignRowKey(row);
    if (seen.has(key)) throw new Error(`${label} readback contains duplicate row key: ${key}`);
    seen.add(key);
    if (!expectedSelectionKeys.has(key)) throw new Error(`${label} readback row is outside exact selection: ${key}`);
    const expectedSelection = validated.selectionByKey.get(key);
    const expectedPrice = validated.priceByKey.get(key);
    const actualPrice = Number(row?.expectedActivityPrice);
    if (!Number.isFinite(actualPrice) || actualPrice !== Number(expectedPrice?.targetPrice)) {
      throw new Error(`${label} readback target price mismatch: ${key} expected=${expectedPrice?.targetPrice} actual=${row?.expectedActivityPrice}`);
    }
    if ((Object.hasOwn(expectedPrice, 'canonical') || Object.hasOwn(expectedSelection, 'canonical'))
      && !optionalFieldEqual(expectedPrice?.canonical || expectedSelection?.canonical, row?.canonical)) {
      throw new Error(`${label} readback canonical mismatch: ${key}`);
    }
    for (const field of ['finalTargetPrice', 'couponFactor', 'combo']) {
      if (Object.hasOwn(expectedPrice, field) && !optionalFieldEqual(expectedPrice[field], row?.[field])) {
        throw new Error(`${label} readback ${field} mismatch: ${key}`);
      }
    }
  }
  const missing = [...expectedSelectionKeys].filter(key => !seen.has(key));
  if (missing.length) throw new Error(`${label} readback is missing exact selection rows: ${missing.slice(0, 20).join(',')}`);
}

function promotionTestBeforeRename(label) {
  if (process.env.NODE_ENV !== 'test') return undefined;
  const requested = String(process.env.SHEIN_MARKETING_PROMOTION_TEST_FAULT || '').trim();
  if (requested !== `before_${label}_output_rename`) return undefined;
  return async () => {
    throw new Error(`Injected promotion test fault before ${label} output rename`);
  };
}

async function snapshotPromotionFile(file) {
  const target = path.resolve(file);
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return {target, exists: false, bytes: null, mode: 0o644};
    throw error;
  }
  if (!stat.isFile() || stat.nlink !== 1) {
    throw new Error(`Promotion output must be a regular single-link file: ${target}`);
  }
  return {
    target,
    exists: true,
    bytes: await fs.readFile(target),
    mode: stat.mode & 0o777,
  };
}

async function restorePromotionFile(snapshot) {
  if (snapshot.exists) {
    await writeFileAtomic(snapshot.target, snapshot.bytes, {mode: snapshot.mode});
    const restored = await fs.readFile(snapshot.target);
    if (!restored.equals(snapshot.bytes)) throw new Error(`Promotion output rollback byte mismatch: ${snapshot.target}`);
    return;
  }
  await fs.rm(snapshot.target, {force: true});
  try {
    await fs.lstat(snapshot.target);
    throw new Error(`Promotion output rollback did not remove newly-created file: ${snapshot.target}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function writePromotionFile(file, text, label) {
  await writeFileAtomic(file, Buffer.from(text, 'utf8'), {
    mode: 0o644,
    beforeRename: promotionTestBeforeRename(label),
  });
}

async function publishPromotionPairFailureAtomic({selectionPath, pricesPath, selectionText, pricesText, afterPair}) {
  const snapshots = await Promise.all([
    snapshotPromotionFile(selectionPath),
    snapshotPromotionFile(pricesPath),
  ]);
  try {
    await writePromotionFile(selectionPath, selectionText, 'selection');
    await writePromotionFile(pricesPath, pricesText, 'prices');
    return await afterPair();
  } catch (error) {
    const rollbackErrors = [];
    for (const snapshot of [...snapshots].reverse()) {
      try {
        await restorePromotionFile(snapshot);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        `Promotion failed and output rollback failed: ${error?.message || String(error)}`,
      );
    }
    throw error;
  }
}

async function publishRegistry({args, selectionText, pricesText, workFingerprint, expectedStoreKeys}) {
  const baselineId = args.baselineId || deriveBaselineId(args.batch, workFingerprint);
  const published = await publishMarketingPlanRegistryFromTexts({
    selectionText,
    priceOverridesText: pricesText,
    registryRoot: args.registryRoot,
    registryFile: args.registryFile,
    baselineId,
    confirm: MARKETING_PLAN_REGISTRY_CONFIRM_TOKEN,
    expectedStoreKeys,
  });
  return {
    registryPublished: true,
    registryHash: published.registryHash,
    registryFile: published.registryFile,
    registryPath: published.registryFile,
    registryRoot: published.registryRoot,
    baselineId: published.baselineId,
    manifestPath: published.manifestPath,
    registrySelectionPlan: published.targetPlan,
    registryPriceOverrides: published.priceOverrides,
    stagingCleanup: published.stagingCleanup,
  };
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const expectedStoreKeys = args.noRegistryPublish
    ? []
    : readEnabledMarketingStoreKeysSync(STORES_CONFIG);
  const selection = JSON.parse(await fs.readFile(args.selection, 'utf8'));
  const prices = JSON.parse(await fs.readFile(args.prices, 'utf8'));
  const readback = JSON.parse(await fs.readFile(args.readback, 'utf8'));
  const approvals = [];
  for (const manifestPath of args.approvals) {
    approvals.push(await loadOrdinaryCampaignApproval({
      root: ROOT,
      manifestPath,
    }));
  }
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
  assertReadbackBindsExactPair(readback, {
    selectionPath: args.selection,
    pricesPath: args.prices,
    validated,
    label: 'composite ordinary baseline',
  });

  const promotedAt = new Date().toISOString();
  const approvalSources = approvals.map(item => ({
    manifest: rel(item.manifestPath),
    manifestHash: item.manifestHash,
    workFingerprint: item.workFingerprint,
    approvalText: item.manifest.approvalText,
    approvalSource: item.manifest.approvalSource,
    rowCount: item.selectionRows.length,
  }));
  const authoritative = !args.noRegistryPublish;
  for (const doc of [selection, prices]) {
    doc.baselineForNextOrdinaryActivity = authoritative;
    doc.baselineForLimitedDiscountFallback = authoritative;
    doc.executionStatus = 'completed';
    doc.executedAt = promotedAt;
    const planMetadata = {
      ...(doc.planMetadata || {}),
      status: authoritative ? 'current_baseline' : 'offline_candidate',
      supersededBy: null,
      approvalMode: 'exact_union_of_approved_manifests',
      compositeApprovalSources: approvalSources,
      activityBatch: args.batch,
      rowCount: selectedRows,
      readbackArtifact: rel(args.readback),
      workFingerprint: validated.workFingerprint,
      selectionPayloadHash: validated.selectionPayloadHash,
      pricePayloadHash: validated.pricePayloadHash,
    };
    if (authoritative) {
      planMetadata.promotedAt = promotedAt;
      delete planMetadata.offlineCandidateAt;
    } else {
      planMetadata.offlineCandidateAt = promotedAt;
      delete planMetadata.promotedAt;
    }
    doc.planMetadata = planMetadata;
  }
  if (authoritative) {
    validateMarketingPlanPairDocuments({
      selection,
      prices,
      requireCurrentBaseline: true,
      expectedStoreCount: 19,
      expectedStoreKeys,
    });
  }
  const selectionText = serializedJson(selection);
  const pricesText = serializedJson(prices);
  const registry = args.noRegistryPublish
    ? await publishPromotionPairFailureAtomic({
      selectionPath: args.selection,
      pricesPath: args.prices,
      selectionText,
      pricesText,
      afterPair: async () => ({registryPublished: false}),
    })
    : await publishRegistry({
      args,
      selectionText,
      pricesText,
      workFingerprint: validated.workFingerprint,
      expectedStoreKeys,
    });
  console.log(JSON.stringify({
    ok: true,
    selectedRows,
    promotedAt,
    batch: args.batch,
    readback: rel(args.readback),
    workFingerprint: validated.workFingerprint,
    approvals: approvalSources,
    authoritative,
    selection: rel(args.selection),
    prices: rel(args.prices),
    selectionOut: args.noRegistryPublish ? args.selection : registry.registrySelectionPlan,
    pricesOut: args.noRegistryPublish ? args.prices : registry.registryPriceOverrides,
    ...registry,
  }, null, 2));
}

await main().catch(error => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
