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

export function stripLeadingAnnotations(value) {
  let s = String(value || '').trim();
  while (true) {
    const next = s.replace(/^\s*(?:（[^）]{1,20}）|\([^)]{1,20}\))\s*/, '').trim();
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
  const alias = matchAlias(cleaned, context);
  const weak = isWeakOrSuspiciousSku(cleaned);
  if (alias) {
    const canonicalInCatalog = standardKeys.has(keyFor(alias.canonical));
    return {
      input,
      cleaned,
      canonical: alias.canonical,
      matched: true,
      matchedAlias: alias.matchedAlias,
      source: alias.source,
      canonicalInCatalog,
      needsReview: !canonicalInCatalog,
      reviewReason: canonicalInCatalog ? '' : 'canonical_not_in_standard_catalog',
    };
  }
  const cleanedInCatalog = standardKeys.has(keyFor(cleaned));
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
