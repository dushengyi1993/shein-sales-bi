import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {writeFileAtomic, writeJsonFileAtomic} from './atomic_file_publish.mjs';

export const MARKETING_PLAN_REGISTRY_ENV = 'SHEIN_BI_MARKETING_PLAN_REGISTRY_FILE';
export const DEFAULT_MARKETING_PLAN_REGISTRY_FILE = '/srv/shein-bi/runtime/marketing-plans/current.json';
export const MARKETING_PLAN_REGISTRY_SCHEMA_VERSION = 1;
export const MARKETING_PLAN_REGISTRY_TYPE = 'shein-marketing-plan-registry/v1';
export const MARKETING_PLAN_REGISTRY_CONFIRM_TOKEN = 'PUBLISH_MARKETING_PLAN_REGISTRY';
export const MARKETING_PLAN_REGISTRY_LOCK_SUFFIX = '.publish.lock';

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const BASELINE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REGISTRY_TEST_FAULT_ENV = 'SHEIN_MARKETING_PLAN_REGISTRY_TEST_FAULT';
const PRIVATE_PROMOTION_STAGE_PREFIX = 'shein-marketing-plan-registry-stage-';

function invalid(message, code = 'MARKETING_PLAN_REGISTRY_INVALID') {
  const error = new Error(`Marketing plan registry: ${message}`);
  error.code = code;
  return error;
}

function isSha256(value) {
  return SHA256_PATTERN.test(String(value || ''));
}

export function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
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

export function canonicalJson(value, {omitKeys = []} = {}) {
  const omitted = new Set(omitKeys);
  const strip = input => {
    if (Array.isArray(input)) return input.map(strip);
    if (!input || typeof input !== 'object') return input;
    return Object.fromEntries(
      Object.keys(input)
        .filter(key => !omitted.has(key))
        .sort()
        .map(key => [key, strip(input[key])]),
    );
  };
  return JSON.stringify(strip(value));
}

export function canonicalSha256(value, options = {}) {
  return sha256Bytes(canonicalJson(value, options));
}

function normalizeStoreKey(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeSkc(value) {
  return String(value || '').trim().toLowerCase();
}

export function marketingPlanRowKey(row) {
  const storeKey = normalizeStoreKey(row?.storeKey || row?.store || row?.store_key);
  const activityId = Number(row?.activityId || row?.activity_id || 0);
  const skc = normalizeSkc(row?.skc || row?.SKC || row?.skc_code);
  if (!storeKey || !Number.isInteger(activityId) || activityId <= 0 || !skc) return '';
  return `${storeKey}:${activityId}:${skc}`;
}

function planRows(doc) {
  if (Array.isArray(doc?.items)) return doc.items.filter(row => row?.selected !== false);
  if (Array.isArray(doc?.selection)) return doc.selection.filter(row => row?.selected !== false);
  if (Array.isArray(doc?.rows)) return doc.rows.filter(row => row?.selected !== false);
  return [];
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function sortedPlanPayload(rows) {
  return JSON.stringify(
    [...rows]
      .sort((a, b) => marketingPlanRowKey(a).localeCompare(marketingPlanRowKey(b)))
      .map(stableValue),
  );
}

function sha256Value(value) {
  return sha256Bytes(String(value));
}

function metadataStatus(doc, label) {
  if (doc?.baselineForNextOrdinaryActivity !== true) {
    throw invalid(`${label} baselineForNextOrdinaryActivity must be true`);
  }
  if (doc?.baselineForLimitedDiscountFallback !== true) {
    throw invalid(`${label} baselineForLimitedDiscountFallback must be true`);
  }
  if (doc?.executionStatus !== 'completed') {
    throw invalid(`${label} executionStatus must be completed; got=${String(doc?.executionStatus || 'missing')}`);
  }
  const planMetadata = doc?.planMetadata;
  if (!planMetadata || planMetadata.status !== 'current_baseline') {
    throw invalid(`${label} planMetadata.status must be current_baseline`);
  }
  if (planMetadata.supersededBy !== undefined && planMetadata.supersededBy !== null && String(planMetadata.supersededBy).trim() !== '') {
    throw invalid(`${label} planMetadata.supersededBy must be empty`);
  }
  return planMetadata;
}

function assertDate(value, label) {
  if (!String(value || '').trim() || !Number.isFinite(Date.parse(String(value)))) {
    throw invalid(`${label} must be a parseable promotedAt timestamp`);
  }
}

function assertRegularFileSync(file, label) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    throw invalid(`${label} is missing: ${file}`, error?.code === 'ENOENT' ? 'MARKETING_PLAN_REGISTRY_MISSING' : 'MARKETING_PLAN_REGISTRY_UNREADABLE');
  }
  if (stat.isSymbolicLink()) throw invalid(`${label} must not be a symlink: ${file}`);
  if (!stat.isFile() || stat.nlink !== 1) throw invalid(`${label} must be a regular single-link file: ${file}`);
  return stat;
}

function assertDirectorySync(dir, label) {
  let stat;
  try {
    stat = fs.lstatSync(dir);
  } catch (error) {
    throw invalid(`${label} is missing: ${dir}`, error?.code === 'ENOENT' ? 'MARKETING_PLAN_REGISTRY_MISSING' : 'MARKETING_PLAN_REGISTRY_UNREADABLE');
  }
  if (stat.isSymbolicLink()) throw invalid(`${label} must not be a symlink: ${dir}`);
  if (!stat.isDirectory()) throw invalid(`${label} must be a directory: ${dir}`);
  return stat;
}

function assertInside(root, target, label) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw invalid(`${label} escapes registry root: ${target}`);
  }
}

function realpathSyncOrInvalid(target, label) {
  try {
    return fs.realpathSync(target);
  } catch (error) {
    throw invalid(`${label} realpath failed: ${target}: ${error.message}`, 'MARKETING_PLAN_REGISTRY_UNREADABLE');
  }
}

function assertRealpathInside(rootRealpath, target, label) {
  const targetRealpath = realpathSyncOrInvalid(target, label);
  assertInside(rootRealpath, targetRealpath, label);
  return targetRealpath;
}

function assertExistingParentInside(rootRealpath, target, label) {
  let cursor = path.dirname(target);
  while (true) {
    let stat;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw invalid(`${label} parent cannot be inspected: ${cursor}: ${error.message}`, 'MARKETING_PLAN_REGISTRY_UNREADABLE');
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) throw invalid(`${label} parent is missing: ${cursor}`, 'MARKETING_PLAN_REGISTRY_MISSING');
      cursor = parent;
      continue;
    }
    if (stat.isSymbolicLink()) throw invalid(`${label} parent must not be a symlink: ${cursor}`);
    if (!stat.isDirectory()) throw invalid(`${label} parent must be a directory: ${cursor}`);
    const parentRealpath = realpathSyncOrInvalid(cursor, `${label} parent`);
    assertInside(rootRealpath, parentRealpath, `${label} parent`);
    return;
  }
}

function resolveRegistryTarget(root, value, label) {
  const raw = String(value || '').trim();
  if (!raw || path.isAbsolute(raw)) throw invalid(`${label} must be a non-empty relative path`);
  const target = path.resolve(root, raw);
  assertInside(root, target, label);
  return target;
}

function readJsonFileSync(file, label) {
  assertRegularFileSync(file, label);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw invalid(`${label} cannot be read: ${error.message}`, 'MARKETING_PLAN_REGISTRY_UNREADABLE');
  }
  try {
    const value = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected a JSON object');
    return {text, value};
  } catch (error) {
    throw invalid(`${label} JSON parse failed: ${error.message}`);
  }
}

function compareExact(left, right, label) {
  if (left !== right) throw invalid(`${label} mismatch: expected=${left} actual=${right}`);
}

function compareArray(left, right, label) {
  const a = [...(left || [])].map(String).sort();
  const b = [...(right || [])].map(String).sort();
  if (a.length !== b.length || a.some((value, index) => value !== b[index])) {
    throw invalid(`${label} mismatch: expected=${JSON.stringify(a)} actual=${JSON.stringify(b)}`);
  }
}

export function readEnabledMarketingStoreKeysSync(storesConfigPath) {
  const rawPath = String(storesConfigPath || '').trim();
  if (!rawPath || !path.isAbsolute(rawPath)) {
    throw invalid('enabled stores config must be an absolute path');
  }
  const storesConfig = readJsonFileSync(path.resolve(rawPath), 'enabled stores config').value;
  if (!Array.isArray(storesConfig?.stores)) throw invalid('enabled stores config must contain a stores array');
  const enabledStoreKeys = storesConfig.stores
    .filter(store => store?.enabled !== false)
    .map(store => normalizeStoreKey(store?.storeKey || store?.store_key || store?.key));
  if (enabledStoreKeys.some(storeKey => !storeKey)) {
    throw invalid('enabled stores config contains an enabled store without storeKey');
  }
  const duplicates = duplicateValues(enabledStoreKeys);
  if (duplicates.length) throw invalid(`enabled stores config contains duplicate store keys: ${duplicates.join(',')}`);
  if (enabledStoreKeys.length !== 19) {
    throw invalid(`enabled stores config must contain exactly 19 enabled stores; got=${enabledStoreKeys.length}`);
  }
  return [...enabledStoreKeys].sort();
}

function expectedStoreKeysFromConfig(root, storesConfigPath = '') {
  const file = storesConfigPath || path.join(root, 'config', 'stores.json');
  if (!fs.existsSync(file)) return [];
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return [...new Set((doc?.stores || [])
      .filter(store => store?.enabled !== false)
      .map(store => normalizeStoreKey(store?.storeKey || store?.store_key || store?.key))
      .filter(Boolean))].sort();
  } catch {
    return [];
  }
}

export function validateMarketingPlanPairDocuments({
  selection,
  prices,
  requireCurrentBaseline = true,
  expectedStoreCount = 19,
  expectedStoreKeys = [],
} = {}) {
  if (!selection || !prices) throw invalid('selection and price override documents are required');
  const selectionRows = planRows(selection);
  const priceRows = planRows(prices);
  if (!selectionRows.length || !priceRows.length) throw invalid('promoted pair must contain rows');
  const selectionKeys = selectionRows.map(marketingPlanRowKey);
  const priceKeys = priceRows.map(marketingPlanRowKey);
  if (selectionKeys.some(key => !key)) throw invalid('selection contains an invalid storeKey/activityId/skc row key');
  if (priceKeys.some(key => !key)) throw invalid('price overrides contains an invalid storeKey/activityId/skc row key');
  const duplicateSelectionKeys = duplicateValues(selectionKeys);
  const duplicatePriceKeys = duplicateValues(priceKeys);
  if (duplicateSelectionKeys.length) throw invalid(`selection contains duplicate pair keys: ${duplicateSelectionKeys.join(',')}`);
  if (duplicatePriceKeys.length) throw invalid(`price overrides contains duplicate pair keys: ${duplicatePriceKeys.join(',')}`);
  const selectionSet = new Set(selectionKeys);
  const priceSet = new Set(priceKeys);
  const missingPrice = selectionKeys.filter(key => !priceSet.has(key));
  const missingSelection = priceKeys.filter(key => !selectionSet.has(key));
  if (missingPrice.length || missingSelection.length) {
    throw invalid(`pair key mismatch: missingPrice=${missingPrice.length} missingSelection=${missingSelection.length}`);
  }
  if (selectionRows.length !== priceRows.length) {
    throw invalid(`pair row count mismatch: selection=${selectionRows.length} prices=${priceRows.length}`);
  }
  const selectionStoreKeys = [...new Set(selectionRows.map(row => normalizeStoreKey(row?.storeKey || row?.store || row?.store_key)))].sort();
  const priceStoreKeys = [...new Set(priceRows.map(row => normalizeStoreKey(row?.storeKey || row?.store || row?.store_key)))].sort();
  compareArray(selectionStoreKeys, priceStoreKeys, 'pair store coverage');
  if (expectedStoreCount !== null && expectedStoreCount !== undefined && selectionStoreKeys.length !== Number(expectedStoreCount)) {
    throw invalid(`pair must cover ${expectedStoreCount} stores; got=${selectionStoreKeys.length}`);
  }
  if (expectedStoreKeys?.length) compareArray(selectionStoreKeys, expectedStoreKeys, 'pair enabled store coverage');

  const selectionPayloadHash = sha256Value(sortedPlanPayload(selectionRows));
  const pricePayloadHash = sha256Value(sortedPlanPayload(priceRows));
  const workFingerprint = sha256Value(JSON.stringify({selectionPayloadHash, pricePayloadHash}));
  const metadata = [
    ['selection', selection, requireCurrentBaseline],
    ['price overrides', prices, requireCurrentBaseline],
  ].map(([label, doc, required]) => {
    if (!required) return {label, planMetadata: doc?.planMetadata || {}};
    return {label, planMetadata: metadataStatus(doc, label)};
  });
  const selectionMetadata = metadata[0].planMetadata || {};
  const priceMetadata = metadata[1].planMetadata || {};
  const activityBatch = String(selectionMetadata.activityBatch || priceMetadata.activityBatch || '').trim();
  if (requireCurrentBaseline && !activityBatch) throw invalid('current baseline pair is missing activityBatch');
  if (String(selectionMetadata.activityBatch || '').trim() !== String(priceMetadata.activityBatch || '').trim()) {
    throw invalid('selection and price activityBatch mismatch');
  }
  const promotedAt = String(selectionMetadata.promotedAt || priceMetadata.promotedAt || selection?.promotedAt || prices?.promotedAt || '').trim();
  if (requireCurrentBaseline) assertDate(promotedAt, 'pair promotedAt');
  if (String(selectionMetadata.promotedAt || '').trim() !== String(priceMetadata.promotedAt || '').trim()) {
    throw invalid('selection and price promotedAt mismatch');
  }
  for (const [label, planMetadata] of [['selection', selectionMetadata], ['price overrides', priceMetadata]]) {
    if (requireCurrentBaseline) {
      for (const [key, expected] of [
        ['selectionPayloadHash', selectionPayloadHash],
        ['pricePayloadHash', pricePayloadHash],
        ['workFingerprint', workFingerprint],
      ]) {
        if (!isSha256(planMetadata?.[key])) throw invalid(`${label} planMetadata.${key} is missing or invalid`);
        compareExact(String(planMetadata[key]).toLowerCase(), expected, `${label} planMetadata.${key}`);
      }
    }
  }
  return {
    selectionRows,
    priceRows,
    rowCount: selectionRows.length,
    storeKeys: selectionStoreKeys,
    selectionPayloadHash,
    pricePayloadHash,
    workFingerprint,
    activityBatch,
    promotedAt,
    selectionMetadata,
    priceMetadata,
    executionStatus: requireCurrentBaseline ? 'completed' : String(selection?.executionStatus || ''),
    baselineForNextOrdinaryActivity: selection?.baselineForNextOrdinaryActivity === true && prices?.baselineForNextOrdinaryActivity === true,
    baselineForLimitedDiscountFallback: selection?.baselineForLimitedDiscountFallback === true && prices?.baselineForLimitedDiscountFallback === true,
  };
}

export function validateMarketingPlanPairFilesSync({
  selectionPath,
  priceOverridesPath,
  requireCurrentBaseline = true,
  expectedStoreCount = 19,
  expectedStoreKeys = [],
} = {}) {
  const selectionFile = path.resolve(String(selectionPath || ''));
  const priceFile = path.resolve(String(priceOverridesPath || ''));
  const selectionRead = readJsonFileSync(selectionFile, 'selection plan');
  const priceRead = readJsonFileSync(priceFile, 'price overrides');
  const validated = validateMarketingPlanPairDocuments({
    selection: selectionRead.value,
    prices: priceRead.value,
    requireCurrentBaseline,
    expectedStoreCount,
    expectedStoreKeys,
  });
  return {
    ...validated,
    selectionPath: selectionFile,
    priceOverridesPath: priceFile,
    selectionText: selectionRead.text,
    priceOverridesText: priceRead.text,
    selectionSha256: sha256Bytes(Buffer.from(selectionRead.text, 'utf8')),
    priceOverridesSha256: sha256Bytes(Buffer.from(priceRead.text, 'utf8')),
    selection: selectionRead.value,
    prices: priceRead.value,
  };
}

export function resolveMarketingPlanRegistryFile({env = process.env, registryFile = ''} = {}) {
  const value = String(registryFile || env?.[MARKETING_PLAN_REGISTRY_ENV] || '').trim();
  return value ? path.resolve(value) : '';
}

function descriptorFromValidated({root, selectionPath, priceOverridesPath, validated, selectionSha256, priceOverridesSha256}) {
  const relative = file => path.relative(root, file).replaceAll(path.sep, '/');
  return {
    selectionPlan: {
      path: relative(selectionPath),
      sha256: selectionSha256,
      rowCount: validated.rowCount,
      storeKeys: validated.storeKeys,
      payloadHash: validated.selectionPayloadHash,
    },
    priceOverrides: {
      path: relative(priceOverridesPath),
      sha256: priceOverridesSha256,
      rowCount: validated.rowCount,
      storeKeys: validated.storeKeys,
      payloadHash: validated.pricePayloadHash,
    },
    pair: {
      rowCount: validated.rowCount,
      storeKeys: validated.storeKeys,
      workFingerprint: validated.workFingerprint,
      selectionPayloadHash: validated.selectionPayloadHash,
      pricePayloadHash: validated.pricePayloadHash,
      activityBatch: validated.activityBatch,
      promotedAt: validated.promotedAt,
    },
  };
}

function assertRegistryHash(value, label) {
  if (!isSha256(value)) throw invalid(`${label} is missing or invalid`);
}

function compareDescriptor(left, right, label) {
  compareExact(left?.path, right?.path, `${label}.path`);
  compareExact(String(left?.sha256 || '').toLowerCase(), String(right?.sha256 || '').toLowerCase(), `${label}.sha256`);
  compareExact(Number(left?.rowCount), Number(right?.rowCount), `${label}.rowCount`);
  compareArray(left?.storeKeys, right?.storeKeys, `${label}.storeKeys`);
  compareExact(String(left?.payloadHash || '').toLowerCase(), String(right?.payloadHash || '').toLowerCase(), `${label}.payloadHash`);
}

function comparePair(left, right, label) {
  compareExact(Number(left?.rowCount), Number(right?.rowCount), `${label}.rowCount`);
  compareArray(left?.storeKeys, right?.storeKeys, `${label}.storeKeys`);
  for (const key of ['workFingerprint', 'selectionPayloadHash', 'pricePayloadHash', 'activityBatch', 'promotedAt']) {
    compareExact(String(left?.[key] || ''), String(right?.[key] || ''), `${label}.${key}`);
  }
}

function registryRootForFile(registryFile, registryRoot = '') {
  const file = path.resolve(registryFile);
  const root = path.resolve(registryRoot || path.dirname(file));
  assertInside(root, file, 'registry file');
  if (file === root) throw invalid('registry file must be a file below registry root');
  return {file, root};
}

export function verifyMarketingPlanRegistrySync({registryFile = '', file = '', registryRoot = '', expectedStoreKeys = []} = {}) {
  const resolved = registryRootForFile(registryFile || file, registryRoot);
  assertDirectorySync(resolved.root, 'registry root');
  const rootRealpath = realpathSyncOrInvalid(resolved.root, 'registry root');
  assertRegularFileSync(resolved.file, 'registry current pointer');
  assertRealpathInside(rootRealpath, resolved.file, 'registry current pointer');
  const registryRead = readJsonFileSync(resolved.file, 'registry current pointer');
  const registry = registryRead.value;
  if (Number(registry.schemaVersion) !== MARKETING_PLAN_REGISTRY_SCHEMA_VERSION || registry.registryType !== MARKETING_PLAN_REGISTRY_TYPE) {
    throw invalid(`unsupported registry schema/type: ${registry.schemaVersion}/${registry.registryType || 'missing'}`);
  }
  const declaredRegistryHashes = [registry.canonicalRegistryHash, registry.registryHash].filter(value => value !== undefined);
  if (!declaredRegistryHashes.length) throw invalid('canonical registry hash is missing');
  for (const hash of declaredRegistryHashes) assertRegistryHash(hash, 'canonical registry hash');
  if (declaredRegistryHashes.length > 1 && String(declaredRegistryHashes[0]).toLowerCase() !== String(declaredRegistryHashes[1]).toLowerCase()) {
    throw invalid('canonical registry hash aliases differ');
  }
  const actualRegistryHash = canonicalSha256(registry, {omitKeys: ['canonicalRegistryHash', 'registryHash']});
  compareExact(String(declaredRegistryHashes[0]).toLowerCase(), actualRegistryHash, 'canonical registry hash');
  if (String(registry.registryRoot || '.') !== '.') {
    const recordedRoot = path.resolve(path.dirname(resolved.file), String(registry.registryRoot));
    compareExact(recordedRoot, resolved.root, 'registryRoot');
  }
  if (!BASELINE_ID_PATTERN.test(String(registry.baselineId || ''))) throw invalid('baselineId is missing or unsafe');
  if (registry.executionStatus !== 'completed') throw invalid('registry executionStatus must be completed');
  if (registry.baselineForNextOrdinaryActivity !== true || registry.baselineForLimitedDiscountFallback !== true) {
    throw invalid('registry baseline flags must both be true');
  }
  if (registry.planMetadata?.status !== 'current_baseline' || (registry.planMetadata?.supersededBy !== undefined && registry.planMetadata?.supersededBy !== null && String(registry.planMetadata.supersededBy).trim() !== '')) {
    throw invalid('registry planMetadata must be current_baseline and not superseded');
  }
  const manifestPathValue = registry.manifestPath || registry.currentBaseline?.manifestPath;
  const manifestPath = resolveRegistryTarget(resolved.root, manifestPathValue, 'manifest path');
  const immutableRoot = path.join(resolved.root, 'baselines');
  assertDirectorySync(immutableRoot, 'immutable baseline root');
  const immutableRootRealpath = assertRealpathInside(rootRealpath, immutableRoot, 'immutable baseline root');
  assertInside(immutableRoot, manifestPath, 'baseline manifest immutable path');
  const baselineDir = path.dirname(manifestPath);
  assertDirectorySync(baselineDir, 'immutable baseline directory');
  if (path.dirname(baselineDir) !== immutableRoot || path.basename(baselineDir) !== String(registry.baselineId)) {
    throw invalid('baseline manifest must be directly inside baselines/<baselineId>');
  }
  const baselineDirRealpath = assertRealpathInside(rootRealpath, baselineDir, 'immutable baseline directory');
  compareExact(path.dirname(baselineDirRealpath), immutableRootRealpath, 'immutable baseline parent containment');
  if (path.basename(manifestPath) !== 'manifest.json') {
    throw invalid('baseline manifest filename must be manifest.json');
  }
  const manifestSha256 = String(registry.manifestSha256 || registry.currentBaseline?.manifestSha256 || '').toLowerCase();
  assertRegistryHash(manifestSha256, 'manifest sha256');
  const manifestRead = readJsonFileSync(manifestPath, 'baseline manifest');
  assertRealpathInside(rootRealpath, manifestPath, 'baseline manifest');
  compareExact(sha256Bytes(Buffer.from(manifestRead.text, 'utf8')), manifestSha256, 'manifest sha256');
  const manifest = manifestRead.value;
  if (Number(manifest.schemaVersion) !== MARKETING_PLAN_REGISTRY_SCHEMA_VERSION || manifest.registryType !== MARKETING_PLAN_REGISTRY_TYPE) {
    throw invalid('baseline manifest schema/type mismatch');
  }
  compareExact(String(manifest.baselineId || ''), String(registry.baselineId), 'manifest baselineId');
  assertRegistryHash(manifest.canonicalManifestHash, 'canonical manifest hash');
  compareExact(String(manifest.canonicalManifestHash).toLowerCase(), canonicalSha256(manifest, {omitKeys: ['canonicalManifestHash']}), 'canonical manifest hash');
  const manifestRelative = path.relative(resolved.root, manifestPath).replaceAll(path.sep, '/');
  compareExact(String(registry.manifestPath || ''), manifestRelative, 'registry manifestPath');
  compareDescriptor(registry.selectionPlan, manifest.selectionPlan, 'selectionPlan registry/manifest');
  compareDescriptor(registry.priceOverrides, manifest.priceOverrides, 'priceOverrides registry/manifest');
  comparePair(registry.pair, manifest.pair, 'pair registry/manifest');
  const selectionPath = resolveRegistryTarget(resolved.root, registry.selectionPlan?.path, 'selection plan path');
  const priceOverridesPath = resolveRegistryTarget(resolved.root, registry.priceOverrides?.path, 'price overrides path');
  const manifestDir = path.dirname(manifestPath);
  if (path.dirname(selectionPath) !== manifestDir || path.dirname(priceOverridesPath) !== manifestDir) {
    throw invalid('selection and price overrides must be directly inside the baseline directory');
  }
  if (path.basename(selectionPath) !== 'selection-plan.json' || path.basename(priceOverridesPath) !== 'price-overrides.json') {
    throw invalid('immutable baseline filenames must be selection-plan.json and price-overrides.json');
  }
  assertRealpathInside(rootRealpath, selectionPath, 'selection plan immutable baseline path');
  assertRealpathInside(rootRealpath, priceOverridesPath, 'price overrides immutable baseline path');
  const validated = validateMarketingPlanPairFilesSync({
    selectionPath,
    priceOverridesPath,
    requireCurrentBaseline: true,
    expectedStoreCount: 19,
    expectedStoreKeys,
  });
  compareExact(validated.selectionSha256, String(registry.selectionPlan.sha256).toLowerCase(), 'selection plan file sha256');
  compareExact(validated.priceOverridesSha256, String(registry.priceOverrides.sha256).toLowerCase(), 'price overrides file sha256');
  compareDescriptor(registry.selectionPlan, {
    path: registry.selectionPlan.path,
    sha256: validated.selectionSha256,
    rowCount: validated.rowCount,
    storeKeys: validated.storeKeys,
    payloadHash: validated.selectionPayloadHash,
  }, 'selectionPlan file');
  compareDescriptor(registry.priceOverrides, {
    path: registry.priceOverrides.path,
    sha256: validated.priceOverridesSha256,
    rowCount: validated.rowCount,
    storeKeys: validated.storeKeys,
    payloadHash: validated.pricePayloadHash,
  }, 'priceOverrides file');
  comparePair(registry.pair, validated, 'pair file');
  compareExact(String(registry.activityBatch || ''), validated.activityBatch, 'registry activityBatch');
  compareExact(String(registry.promotedAt || ''), validated.promotedAt, 'registry promotedAt');
  compareExact(String(registry.planMetadata?.activityBatch || ''), validated.activityBatch, 'registry planMetadata.activityBatch');
  compareExact(String(registry.planMetadata?.promotedAt || ''), validated.promotedAt, 'registry planMetadata.promotedAt');
  for (const [key, expected] of [
    ['workFingerprint', validated.workFingerprint],
    ['selectionPayloadHash', validated.selectionPayloadHash],
    ['pricePayloadHash', validated.pricePayloadHash],
  ]) compareExact(String(registry.planMetadata?.[key] || ''), expected, `registry planMetadata.${key}`);
  return {
    registryFile: resolved.file,
    registryRoot: resolved.root,
    registry,
    registryHash: actualRegistryHash,
    manifest,
    manifestPath,
    manifestSha256,
    targetPlan: selectionPath,
    priceOverrides: priceOverridesPath,
    selectionPlanHash: validated.selectionSha256,
    priceOverridesHash: validated.priceOverridesSha256,
    rowCount: validated.rowCount,
    storeKeys: validated.storeKeys,
    selectionPayloadHash: validated.selectionPayloadHash,
    pricePayloadHash: validated.pricePayloadHash,
    workFingerprint: validated.workFingerprint,
    activityBatch: validated.activityBatch,
    promotedAt: validated.promotedAt,
    strategy: 'registry_current_baseline',
  };
}

export const verifyMarketingPlanRegistry = verifyMarketingPlanRegistrySync;

async function ensureDirectory(dir, label) {
  if (fs.existsSync(dir)) {
    assertDirectorySync(dir, label);
    return;
  }
  await fsp.mkdir(dir, {recursive: true});
  assertDirectorySync(dir, label);
}

async function acquirePublishLock(root) {
  const lockPath = path.join(root, MARKETING_PLAN_REGISTRY_LOCK_SUFFIX);
  try {
    // Deliberately do not inspect, age, or remove an existing lock. A stale
    // lock is an operator-recovery decision; silently reclaiming it could
    // fracture the single-writer boundary after a stalled process.
    await fsp.mkdir(lockPath, {mode: 0o700});
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw invalid(`publish lock is already held: ${lockPath}`, 'MARKETING_PLAN_REGISTRY_LOCKED');
    }
    throw invalid(`publish lock could not be acquired: ${lockPath}: ${error.message}`, 'MARKETING_PLAN_REGISTRY_LOCK_FAILED');
  }
  let released = false;
  return async () => {
    if (released) return;
    try {
      await fsp.rmdir(lockPath);
      released = true;
    } catch (error) {
      if (error?.code === 'ENOENT') {
        released = true;
        return;
      }
      throw invalid(`publish lock could not be released: ${lockPath}: ${error.message}`, 'MARKETING_PLAN_REGISTRY_LOCK_RELEASE_FAILED');
    }
  };
}

function registryTestFault(label) {
  if (process.env.NODE_ENV !== 'test') return;
  if (String(process.env[REGISTRY_TEST_FAULT_ENV] || '') !== label) return;
  throw invalid(`injected test fault: ${label}`, 'MARKETING_PLAN_REGISTRY_TEST_FAULT');
}

function combineFailures(message, ...errors) {
  const failures = errors.filter(Boolean);
  if (failures.length === 1) return failures[0];
  return new AggregateError(failures, message);
}

function snapshotCurrentPointer(file, rootRealpath) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw invalid(`registry current pointer cannot be inspected: ${file}: ${error.message}`, 'MARKETING_PLAN_REGISTRY_UNREADABLE');
    }
    assertExistingParentInside(rootRealpath, file, 'registry current pointer');
    return {exists: false, bytes: null, mode: null};
  }
  if (stat.isSymbolicLink()) throw invalid(`registry current pointer must not be a symlink: ${file}`);
  if (!stat.isFile() || stat.nlink !== 1) {
    throw invalid(`registry current pointer must be a regular single-link file: ${file}`);
  }
  assertRealpathInside(rootRealpath, file, 'registry current pointer');
  return {
    exists: true,
    bytes: fs.readFileSync(file),
    mode: stat.mode & 0o777,
  };
}

async function syncDirectory(dir) {
  if (process.platform === 'win32') return;
  const handle = await fsp.open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function restoreCurrentPointer(file, rootRealpath, snapshot) {
  if (snapshot.exists) {
    await writeFileAtomic(file, snapshot.bytes, {mode: snapshot.mode});
    assertRegularFileSync(file, 'restored registry current pointer');
    const restored = fs.readFileSync(file);
    if (!restored.equals(snapshot.bytes)) {
      throw invalid('registry current pointer rollback byte readback mismatch', 'MARKETING_PLAN_REGISTRY_ROLLBACK_FAILED');
    }
    return;
  }
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw invalid(`new registry current pointer cannot be safely removed during rollback: ${file}`, 'MARKETING_PLAN_REGISTRY_ROLLBACK_FAILED');
  }
  assertRealpathInside(rootRealpath, file, 'new registry current pointer');
  await fsp.unlink(file);
  await syncDirectory(path.dirname(file));
  if (fs.existsSync(file)) {
    throw invalid('new registry current pointer still exists after rollback', 'MARKETING_PLAN_REGISTRY_ROLLBACK_FAILED');
  }
}

async function publishVerifiedCurrentPointer({file, root, registry, expectedStores, onBeforeReplace}) {
  const candidateBytes = Buffer.from(`${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  await writeFileAtomic(file, candidateBytes, {
    mode: 0o644,
    beforeRename: async candidatePath => {
      assertRegularFileSync(candidatePath, 'registry current pointer candidate');
      const candidateReadback = verifyMarketingPlanRegistrySync({
        registryFile: candidatePath,
        registryRoot: root,
        expectedStoreKeys: expectedStores,
      });
      compareExact(candidateReadback.registryHash, String(registry.canonicalRegistryHash).toLowerCase(), 'registry candidate canonical readback');
      registryTestFault('after_candidate_verify');
      registryTestFault('before_current_pointer_rename');
      onBeforeReplace();
    },
  });
  return candidateBytes;
}

async function ensureImmutableCopy({target, bytes, expectedSha256, label}) {
  if (fs.existsSync(target)) {
    assertRegularFileSync(target, label);
    const existing = fs.readFileSync(target);
    compareExact(sha256Bytes(existing), expectedSha256, `${label} immutable collision/hash`);
    if (!existing.equals(Buffer.from(bytes))) throw invalid(`${label} immutable collision: same baselineId has different bytes`);
  } else {
    await writeFileAtomic(target, Buffer.from(bytes), {mode: 0o444});
  }
  assertRegularFileSync(target, label);
  const actual = sha256Bytes(fs.readFileSync(target));
  compareExact(actual, expectedSha256, `${label} publish readback hash`);
}

function descriptorWithImmutablePaths({root, baselineId, validated, selectionSha256, priceOverridesSha256}) {
  const baselineRelative = `baselines/${baselineId}`;
  return {
    selectionPlan: {
      path: `${baselineRelative}/selection-plan.json`,
      sha256: selectionSha256,
      rowCount: validated.rowCount,
      storeKeys: validated.storeKeys,
      payloadHash: validated.selectionPayloadHash,
    },
    priceOverrides: {
      path: `${baselineRelative}/price-overrides.json`,
      sha256: priceOverridesSha256,
      rowCount: validated.rowCount,
      storeKeys: validated.storeKeys,
      payloadHash: validated.pricePayloadHash,
    },
    pair: {
      rowCount: validated.rowCount,
      storeKeys: validated.storeKeys,
      workFingerprint: validated.workFingerprint,
      selectionPayloadHash: validated.selectionPayloadHash,
      pricePayloadHash: validated.pricePayloadHash,
      activityBatch: validated.activityBatch,
      promotedAt: validated.promotedAt,
    },
  };
}

async function writeOrVerifyManifest(manifestPath, manifest) {
  if (fs.existsSync(manifestPath)) {
    assertRegularFileSync(manifestPath, 'baseline manifest');
    const existingText = fs.readFileSync(manifestPath, 'utf8');
    let existing;
    try { existing = JSON.parse(existingText); } catch (error) { throw invalid(`existing baseline manifest parse failed: ${error.message}`); }
    compareExact(canonicalSha256(existing, {omitKeys: ['canonicalManifestHash']}), manifest.canonicalManifestHash, 'baseline manifest immutable collision');
    return {text: existingText, value: existing};
  }
  await writeJsonFileAtomic(manifestPath, manifest, {mode: 0o444});
  assertRegularFileSync(manifestPath, 'baseline manifest');
  return {text: fs.readFileSync(manifestPath, 'utf8'), value: JSON.parse(fs.readFileSync(manifestPath, 'utf8'))};
}

async function createPrivatePromotionStage() {
  const tempRoot = path.resolve(os.tmpdir());
  const stage = path.resolve(await fsp.mkdtemp(path.join(tempRoot, PRIVATE_PROMOTION_STAGE_PREFIX)));
  if (path.dirname(stage) !== tempRoot || !path.basename(stage).startsWith(PRIVATE_PROMOTION_STAGE_PREFIX)) {
    throw invalid(`private promotion staging path is unsafe: ${stage}`, 'MARKETING_PLAN_REGISTRY_STAGING_FAILED');
  }
  const stat = await fsp.lstat(stage);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw invalid(`private promotion staging path is not a real directory: ${stage}`, 'MARKETING_PLAN_REGISTRY_STAGING_FAILED');
  }
  if (process.platform !== 'win32') {
    await fsp.chmod(stage, 0o700);
    const mode = (await fsp.lstat(stage)).mode & 0o777;
    if (mode !== 0o700) {
      throw invalid(`private promotion staging mode mismatch: got=${mode.toString(8)} want=700`, 'MARKETING_PLAN_REGISTRY_STAGING_FAILED');
    }
  }
  return stage;
}

async function removePrivatePromotionStage(stage) {
  const target = path.resolve(String(stage || ''));
  const tempRoot = path.resolve(os.tmpdir());
  if (path.dirname(target) !== tempRoot || !path.basename(target).startsWith(PRIVATE_PROMOTION_STAGE_PREFIX)) {
    throw invalid(`refusing to remove unsafe promotion staging path: ${target}`, 'MARKETING_PLAN_REGISTRY_STAGING_CLEANUP_FAILED');
  }
  let stat;
  try {
    stat = await fsp.lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw invalid(`promotion staging cleanup target is not a real directory: ${target}`, 'MARKETING_PLAN_REGISTRY_STAGING_CLEANUP_FAILED');
  }
  await fsp.rm(target, {recursive: true, force: false});
}

export async function publishMarketingPlanRegistryFromTexts({
  selectionText,
  priceOverridesText,
  registryRoot,
  registryFile,
  baselineId,
  confirm,
  expectedStoreKeys = [],
} = {}) {
  if (typeof selectionText !== 'string' || typeof priceOverridesText !== 'string') {
    throw invalid('private staging publish requires exact selection and price override text');
  }
  let stage = '';
  let published;
  let operationError = null;
  try {
    stage = await createPrivatePromotionStage();
    const selectionPath = path.join(stage, 'selection-plan.json');
    const priceOverridesPath = path.join(stage, 'price-overrides.json');
    await writeFileAtomic(selectionPath, Buffer.from(selectionText, 'utf8'), {mode: 0o600});
    await writeFileAtomic(priceOverridesPath, Buffer.from(priceOverridesText, 'utf8'), {mode: 0o600});
    published = await publishMarketingPlanRegistry({
      selectionPath,
      priceOverridesPath,
      expectedSelectionSha256: sha256Bytes(Buffer.from(selectionText, 'utf8')),
      expectedPriceOverridesSha256: sha256Bytes(Buffer.from(priceOverridesText, 'utf8')),
      registryRoot,
      registryFile,
      baselineId,
      confirm,
      expectedStoreKeys,
    });
  } catch (error) {
    operationError = error;
  }
  let cleanupError = null;
  if (stage) {
    try {
      await removePrivatePromotionStage(stage);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (operationError) {
    if (cleanupError) {
      throw new AggregateError([operationError, cleanupError], 'Registry staging publish and cleanup both failed');
    }
    throw operationError;
  }
  return {
    ...published,
    stagingCleanup: cleanupError
      ? {ok: false, error: cleanupError?.message || String(cleanupError)}
      : {ok: true},
  };
}

export async function publishMarketingPlanRegistry({
  selectionPath,
  priceOverridesPath,
  expectedSelectionSha256,
  expectedPriceOverridesSha256,
  registryRoot,
  registryFile,
  baselineId,
  confirm,
  expectedStoreKeys = [],
} = {}) {
  if (confirm !== MARKETING_PLAN_REGISTRY_CONFIRM_TOKEN) {
    throw invalid(`publish requires exact --confirm token ${MARKETING_PLAN_REGISTRY_CONFIRM_TOKEN}`);
  }
  if (!BASELINE_ID_PATTERN.test(String(baselineId || ''))) throw invalid('baselineId is missing or unsafe');
  if (!isSha256(expectedSelectionSha256) || !isSha256(expectedPriceOverridesSha256)) {
    throw invalid('publish requires valid expected selection/prices SHA-256 values');
  }
  const root = path.resolve(String(registryRoot || ''));
  const file = path.resolve(String(registryFile || ''));
  if (!path.isAbsolute(String(registryRoot || '')) || !path.isAbsolute(String(registryFile || ''))) {
    throw invalid('publish requires absolute registry root and registry file');
  }
  const resolved = registryRootForFile(file, root);
  await ensureDirectory(resolved.root, 'registry root');
  const publishRootRealpath = realpathSyncOrInvalid(resolved.root, 'registry root');
  const releaseLock = await acquirePublishLock(resolved.root);
  let pointerSnapshot = null;
  let replacementAttempted = false;
  let pointerRestored = false;
  let operationResult;
  let operationError = null;
  try {
    pointerSnapshot = snapshotCurrentPointer(resolved.file, publishRootRealpath);
    const expectedStores = expectedStoreKeys.length ? expectedStoreKeys : expectedStoreKeysFromConfig(path.resolve(process.cwd()));
    const validated = validateMarketingPlanPairFilesSync({
      selectionPath,
      priceOverridesPath,
      requireCurrentBaseline: true,
      expectedStoreCount: 19,
      expectedStoreKeys: expectedStores,
    });
    compareExact(validated.selectionSha256, String(expectedSelectionSha256).toLowerCase(), 'expected selection SHA-256');
    compareExact(validated.priceOverridesSha256, String(expectedPriceOverridesSha256).toLowerCase(), 'expected price overrides SHA-256');
    const immutableRoot = path.join(resolved.root, 'baselines');
    await ensureDirectory(immutableRoot, 'immutable baseline root');
    assertRealpathInside(realpathSyncOrInvalid(resolved.root, 'registry root'), immutableRoot, 'immutable baseline root');
    const baselineDir = path.join(immutableRoot, String(baselineId));
    await ensureDirectory(baselineDir, 'immutable baseline directory');
    if (path.basename(baselineDir) !== String(baselineId) || path.dirname(baselineDir) !== immutableRoot) {
      throw invalid('publish baseline directory must be directly baselines/<baselineId>');
    }
    const rootRealpath = realpathSyncOrInvalid(resolved.root, 'registry root');
    const immutableRootRealpath = assertRealpathInside(rootRealpath, immutableRoot, 'immutable baseline root');
    const baselineDirRealpath = assertRealpathInside(rootRealpath, baselineDir, 'immutable baseline directory');
    compareExact(path.dirname(baselineDirRealpath), immutableRootRealpath, 'immutable baseline parent containment');
    const selectionTarget = path.join(baselineDir, 'selection-plan.json');
    const priceTarget = path.join(baselineDir, 'price-overrides.json');
    const manifestPath = path.join(baselineDir, 'manifest.json');
    await ensureImmutableCopy({
      target: selectionTarget,
      bytes: Buffer.from(validated.selectionText, 'utf8'),
      expectedSha256: validated.selectionSha256,
      label: 'immutable selection plan',
    });
    await ensureImmutableCopy({
      target: priceTarget,
      bytes: Buffer.from(validated.priceOverridesText, 'utf8'),
      expectedSha256: validated.priceOverridesSha256,
      label: 'immutable price overrides',
    });
    const descriptor = descriptorWithImmutablePaths({
      root: resolved.root,
      baselineId,
      validated,
      selectionSha256: validated.selectionSha256,
      priceOverridesSha256: validated.priceOverridesSha256,
    });
    const manifestBase = {
      schemaVersion: MARKETING_PLAN_REGISTRY_SCHEMA_VERSION,
      registryType: MARKETING_PLAN_REGISTRY_TYPE,
      baselineId: String(baselineId),
      executionStatus: 'completed',
      baselineForNextOrdinaryActivity: true,
      baselineForLimitedDiscountFallback: true,
      planMetadata: {
        status: 'current_baseline',
        supersededBy: null,
        activityBatch: validated.activityBatch,
        promotedAt: validated.promotedAt,
        workFingerprint: validated.workFingerprint,
        selectionPayloadHash: validated.selectionPayloadHash,
        pricePayloadHash: validated.pricePayloadHash,
      },
      activityBatch: validated.activityBatch,
      promotedAt: validated.promotedAt,
      ...descriptor,
    };
    const manifest = {
      ...manifestBase,
      canonicalManifestHash: canonicalSha256(manifestBase),
    };
    const manifestRead = await writeOrVerifyManifest(manifestPath, manifest);
    // Published baseline material is immutable on the production POSIX volume.
    // Windows fixtures may not support chmod, so byte/hash collision checks
    // remain the portable enforcement boundary.
    try {
      await fsp.chmod(baselineDir, 0o555);
    } catch {
      // Best effort only for platforms/filesystems without POSIX mode bits.
    }
    const manifestSha256 = sha256Bytes(Buffer.from(manifestRead.text, 'utf8'));
    const relative = target => path.relative(resolved.root, target).replaceAll(path.sep, '/');
    const registryBase = {
      schemaVersion: MARKETING_PLAN_REGISTRY_SCHEMA_VERSION,
      registryType: MARKETING_PLAN_REGISTRY_TYPE,
      registryRoot: '.',
      baselineId: String(baselineId),
      manifestPath: relative(manifestPath),
      manifestSha256,
      executionStatus: 'completed',
      baselineForNextOrdinaryActivity: true,
      baselineForLimitedDiscountFallback: true,
      planMetadata: manifest.planMetadata,
      activityBatch: validated.activityBatch,
      promotedAt: validated.promotedAt,
      ...descriptor,
    };
    const registry = {
      ...registryBase,
      canonicalRegistryHash: canonicalSha256(registryBase),
      registryHash: canonicalSha256(registryBase),
    };
    const candidateBytes = await publishVerifiedCurrentPointer({
      file: resolved.file,
      root: resolved.root,
      registry,
      expectedStores,
      onBeforeReplace: () => {
        replacementAttempted = true;
      },
    });
    registryTestFault('after_current_pointer_replace');
    assertRegularFileSync(resolved.file, 'registry current pointer');
    if (!fs.readFileSync(resolved.file).equals(candidateBytes)) {
      throw invalid('registry current pointer byte readback mismatch', 'MARKETING_PLAN_REGISTRY_READBACK_FAILED');
    }
    const readback = verifyMarketingPlanRegistrySync({registryFile: resolved.file, registryRoot: resolved.root, expectedStoreKeys: expectedStores});
    compareExact(readback.registryHash, String(registry.canonicalRegistryHash).toLowerCase(), 'registry canonical readback');
    operationResult = {
      ok: true,
      baselineId: String(baselineId),
      registryFile: resolved.file,
      registryRoot: resolved.root,
      manifestPath,
      manifestSha256,
      registryHash: readback.registryHash,
      targetPlan: readback.targetPlan,
      priceOverrides: readback.priceOverrides,
      selectionPlanHash: readback.selectionPlanHash,
      priceOverridesHash: readback.priceOverridesHash,
      rowCount: readback.rowCount,
      storeKeys: readback.storeKeys,
      activityBatch: readback.activityBatch,
      promotedAt: readback.promotedAt,
      workFingerprint: readback.workFingerprint,
    };
  } catch (error) {
    operationError = error;
    if (replacementAttempted && pointerSnapshot) {
      try {
        await restoreCurrentPointer(resolved.file, publishRootRealpath, pointerSnapshot);
        pointerRestored = true;
      } catch (rollbackError) {
        operationError = combineFailures('registry publish failed and current pointer rollback failed', operationError, rollbackError);
      }
    }
  }
  try {
    await releaseLock();
  } catch (releaseError) {
    if (!operationError && replacementAttempted && pointerSnapshot && !pointerRestored) {
      try {
        await restoreCurrentPointer(resolved.file, publishRootRealpath, pointerSnapshot);
        pointerRestored = true;
      } catch (rollbackError) {
        releaseError = combineFailures('publish lock release failed and current pointer rollback failed', releaseError, rollbackError);
      }
    }
    operationError = combineFailures('registry publish or lock release failed', operationError, releaseError);
  }
  if (operationError) throw operationError;
  return operationResult;
}
