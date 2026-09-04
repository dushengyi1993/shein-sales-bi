import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALIAS_PATH = path.join(ROOT, 'config', 'product_aliases.json');
const CATALOG_PATH = path.join(ROOT, 'config', 'product_catalog.json');

function readAliasConfig() {
  try {
    return JSON.parse(fs.readFileSync(ALIAS_PATH, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    if (err?.code === 'ENOENT') return {aliases: []};
    throw err;
  }
}

const aliasConfig = readAliasConfig();
function readCatalogConfig() {
  try {
    return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    if (err?.code === 'ENOENT') return {standards: [], extraConfirmedStandards: []};
    throw err;
  }
}

const catalogConfig = readCatalogConfig();
const standardKeys = new Set([
  ...(catalogConfig.standards || []),
  ...(catalogConfig.extraConfirmedStandards || []),
].map(keyFor));

// Store exports may prefix a source code. Only known store keys are removed;
// arbitrary prefixes remain visible for review.
const KNOWN_STORE_PREFIXES = new Set([
  'CX', 'DL', 'DX', 'FY', 'HL', 'JSH', 'JY', 'LQ', 'MZ', 'NM',
  'QH', 'QY', 'TS', 'TZ', 'TZZ', 'XC', 'XL', 'YJ', 'ZL',
]);

function splitLeadingModelCode(value) {
  const raw = String(value || '').normalize('NFKC').trim();
  const match = raw.match(/^([A-Za-z]+[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*)(.*)$/u);
  if (!match) return {code: '', descriptor: ''};
  return {
    code: keyFor(match[1]).replace(/[^A-Z0-9]/g, ''),
    descriptor: keyFor(match[2]).replace(/[^\p{Script=Han}]/gu, ''),
  };
}

function descriptorOverlaps(inputDescriptor, catalogDescriptor) {
  if (!inputDescriptor || !catalogDescriptor) return false;
  if (inputDescriptor.length < 2 || catalogDescriptor.length < 2) return false;
  return catalogDescriptor.includes(inputDescriptor) || inputDescriptor.includes(catalogDescriptor);
}

function buildCatalogPrefixIndex() {
  const byCode = new Map();
  for (const canonical of [
    ...(catalogConfig.standards || []),
    ...(catalogConfig.extraConfirmedStandards || []),
  ]) {
    const split = splitLeadingModelCode(canonical);
    if (!split.code || !split.descriptor) continue;
    if (!byCode.has(split.code)) byCode.set(split.code, []);
    byCode.get(split.code).push({
      canonical,
      descriptor: split.descriptor,
    });
  }
  return byCode;
}

const catalogPrefixIndex = buildCatalogPrefixIndex();

export function stripLeadingAnnotations(value) {
  let s = String(value || '').trim();
  while (true) {
    const next = s
      .replace(/^\s*(?:（[^）]{1,20}）|\([^)]{1,20}\))\s*/, '')
      .replace(/^\s*(?:全|全部)(?=[A-Za-z0-9])/u, '')
      .trim();
    if (next === s) return s;
    s = next;
  }
}

function keyFor(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

function textContainsAny(text, keywords = []) {
  const haystack = keyFor(text);
  return keywords.some(keyword => haystack.includes(keyFor(keyword)));
}

function aliasList(entry) {
  return (entry.aliases || []).map(alias => typeof alias === 'string' ? {value: alias} : alias);
}

function matchIgnoredAlias(cleaned, context = {}) {
  const rawKey = keyFor(cleaned);
  const title = context.goodsTitle || context.title || '';
  const combined = `${cleaned} ${title}`;
  for (const entry of aliasConfig.ignoredAliases || []) {
    for (const alias of aliasList(entry)) {
      if (!alias?.value) continue;
      if (keyFor(alias.value) !== rawKey) continue;
      if (alias.requiresAnyTitleKeyword?.length && !textContainsAny(combined, alias.requiresAnyTitleKeyword)) {
        continue;
      }
      return {
        matchedAlias: alias.value,
        source: entry.source || 'config/product_aliases.json',
        reason: entry.reason || 'ignored_non_product_alias',
      };
    }
  }
  return null;
}

function matchAlias(cleaned, context = {}) {
  const rawKey = keyFor(cleaned);
  const title = context.goodsTitle || context.title || '';
  const combined = `${cleaned} ${title}`;
  for (const entry of aliasConfig.aliases || []) {
    if (entry.status && entry.status !== 'active') continue;
    for (const alias of aliasList(entry)) {
      if (!alias?.value) continue;
      if (keyFor(alias.value) !== rawKey) continue;
      if (alias.requiresAnyTitleKeyword?.length && !textContainsAny(combined, alias.requiresAnyTitleKeyword)) {
        continue;
      }
      return {
        canonical: entry.canonical,
        matchedAlias: alias.value,
        source: entry.source || 'config/product_aliases.json',
      };
    }
  }
  return null;
}

function matchCatalogPrefix(cleaned) {
  const split = splitLeadingModelCode(cleaned);
  if (!split.code || !split.descriptor) return null;
  const candidates = catalogPrefixIndex.get(split.code) || [];
  const matched = candidates.filter(candidate => descriptorOverlaps(split.descriptor, candidate.descriptor));
  if (matched.length !== 1) return null;
  return {
    canonical: matched[0].canonical,
    matchedAlias: cleaned,
    source: 'config/product_catalog.json:prefix_model_descriptor',
  };
}

function stripKnownStorePrefix(value) {
  const raw = String(value || '').normalize('NFKC').trim();
  const match = raw.match(/^([A-Za-z]{2,3})[-_](.+)$/u);
  if (!match || !KNOWN_STORE_PREFIXES.has(match[1].toUpperCase())) return raw;
  return match[2].trim();
}

function modelIdentity(value) {
  const split = splitLeadingModelCode(value);
  if (!split.code) return null;
  const digits = (split.code.match(/\d/g) || []).join('');
  if (!digits) return null;
  const firstDigit = split.code.search(/\d/u);
  const lastDigit = split.code.search(/\d(?!.*\d)/u);
  const prefix = firstDigit >= 0 ? split.code.slice(0, firstDigit).replace(/[^A-Z]/g, '') : '';
  const suffix = lastDigit >= 0 ? split.code.slice(lastDigit + 1).replace(/[^A-Z]/g, '') : '';
  return {digits, prefix, suffix};
}

function buildCatalogModelIdentityIndex() {
  const byIdentity = new Map();
  for (const canonical of [
    ...(catalogConfig.standards || []),
    ...(catalogConfig.extraConfirmedStandards || []),
  ]) {
    const identity = modelIdentity(canonical);
    if (!identity) continue;
    const key = `${identity.digits}|${identity.suffix}`;
    if (!byIdentity.has(key)) byIdentity.set(key, []);
    byIdentity.get(key).push({canonical, prefix: identity.prefix});
  }
  return byIdentity;
}

const catalogModelIdentityIndex = buildCatalogModelIdentityIndex();

function compatibleModelPrefix(inputPrefix, catalogPrefix) {
  if (!inputPrefix || !catalogPrefix) return false;
  return inputPrefix === catalogPrefix
    || inputPrefix.startsWith(catalogPrefix)
    || catalogPrefix.startsWith(inputPrefix);
}

function matchCatalogModelIdentity(cleaned, context = {}) {
  const identity = modelIdentity(cleaned);
  if (!identity) return null;
  const descriptor = `${cleaned} ${context.goodsTitle || context.title || ''}`;
  if (/(?:配件|零件|替换|包装|包材|耗材)/u.test(descriptor)) return null;
  const candidates = (catalogModelIdentityIndex.get(`${identity.digits}|${identity.suffix}`) || [])
    .filter(candidate => compatibleModelPrefix(identity.prefix, candidate.prefix));
  const canonicalSet = new Set(candidates.map(candidate => candidate.canonical));
  if (canonicalSet.size !== 1) return null;
  return {
    canonical: [...canonicalSet][0],
    matchedAlias: cleaned,
    source: 'config/product_catalog.json:numeric_model_identity',
  };
}

export function isWeakOrSuspiciousSku(value) {
  const cleaned = stripLeadingAnnotations(value);
  const k = keyFor(cleaned);
  if (!k) return {suspicious: true, reason: 'empty'};
  if (/^\d{1,5}$/.test(k)) return {suspicious: true, reason: 'short_numeric_alias'};
  if (/^[A-Z]{0,3}\d{1,5}[A-Z]{0,3}$/.test(k) && k.length <= 6) {
    return {suspicious: true, reason: 'short_code_alias'};
  }
  if (!/[A-Z0-9]/.test(k) && /\p{Script=Han}/u.test(cleaned)) {
    return {suspicious: true, reason: 'name_without_model_code'};
  }
  if (cleaned.length >= 12 && !/[A-Z]{2,}[-_]?\d|\d{3,}/i.test(cleaned) && /\p{Script=Han}/u.test(cleaned)) {
    return {suspicious: true, reason: 'long_chinese_name_as_sku'};
  }
  return {suspicious: false, reason: ''};
}

export function normalizeGoodsSnDetailed(value, context = {}) {
  const input = String(value || '').trim();
  const cleaned = stripLeadingAnnotations(input);
  const storeStripped = stripKnownStorePrefix(cleaned);
  const candidates = storeStripped === cleaned ? [cleaned] : [cleaned, storeStripped];
  const ignored = matchIgnoredAlias(cleaned, context);
  if (ignored) {
    return {
      input,
      cleaned,
      canonical: '',
      matched: true,
      ignored: true,
      matchedAlias: ignored.matchedAlias,
      source: ignored.source,
      canonicalInCatalog: false,
      needsReview: false,
      reviewReason: ignored.reason,
    };
  }
  let alias = null;
  let catalogPrefix = null;
  let catalogModel = null;
  for (const candidate of candidates) {
    alias = matchAlias(candidate, context);
    if (alias) break;
    catalogPrefix = matchCatalogPrefix(candidate);
    if (catalogPrefix) break;
    catalogModel = matchCatalogModelIdentity(candidate, context);
    if (catalogModel) break;
  }
  const weak = isWeakOrSuspiciousSku(cleaned);
  if (alias || catalogPrefix || catalogModel) {
    const matched = alias || catalogPrefix || catalogModel;
    const canonicalInCatalog = standardKeys.has(keyFor(matched.canonical));
    return {
      input,
      cleaned,
      canonical: matched.canonical,
      matched: true,
      matchedAlias: matched.matchedAlias,
      source: matched.source,
      canonicalInCatalog,
      needsReview: !canonicalInCatalog,
      reviewReason: canonicalInCatalog ? '' : 'canonical_not_in_standard_catalog',
    };
  }
  const cleanedInCatalog = standardKeys.has(keyFor(cleaned)) || standardKeys.has(keyFor(storeStripped));
  return {
    input,
    cleaned,
    canonical: cleaned,
    matched: false,
    matchedAlias: '',
    source: 'raw_cleaned',
    canonicalInCatalog: cleanedInCatalog,
    needsReview: weak.suspicious || !cleanedInCatalog,
    reviewReason: weak.suspicious ? weak.reason : (cleanedInCatalog ? '' : 'not_in_standard_catalog'),
  };
}

export function normalizeGoodsSn(value, context = {}) {
  return normalizeGoodsSnDetailed(value, context).canonical;
}

export function getAliasConfig() {
  return aliasConfig;
}

export function getCatalogConfig() {
  return catalogConfig;
}
