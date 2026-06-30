#!/usr/bin/env node
/**
 * Regression smoke for copy_product_draft source-link candidate policy.
 *
 * Rules:
 * - If the user explicitly provides sourceStores/readStores, only those stores
 *   may be considered as source links. A high-performing target-store link must
 *   not steal a cross-store copy.
 * - If no source store is explicit, the target store's existing links are valid
 *   source candidates. This supports "same store, add another link from the
 *   best existing link" without requiring redundant source-store wording.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {inferSourceProductFromTask} from '../lib/link_ops_product_draft_mapper.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(ROOT, 'scripts', 'link_ops_hl_openapi_executor.mjs');
const source = await fs.readFile(file, 'utf8');
const match = source.match(/function sourceCandidateScore[\s\S]*?\r?\n}\r?\n\r?\nasync function inferSourceCandidatesFromBi/);
if (!match) {
  console.error(JSON.stringify({ok: false, error: 'sourceCandidateScore function not found'}, null, 2));
  process.exit(1);
}

const functionSource = match[0].replace(/\r?\n\r?\nasync function inferSourceCandidatesFromBi$/, '');
const context = {
  normalizeStoreKey(value) {
    return String(value || '').trim().toUpperCase();
  },
  safeString(value, max = 1000) {
    return String(value ?? '').slice(0, max);
  },
  compactRef(value) {
    return String(value || '').toLowerCase().replace(/[\s_\-—–·/\\（）()]+/g, '');
  },
};
vm.createContext(context);
vm.runInContext(`${functionSource}\nthis.sourceCandidateScore = sourceCandidateScore;`, context);

const score = context.sourceCandidateScore;
const baseRow = {
  skc: 'sv12345678',
  standard_goods_sn: '505缝纫机',
  product_name_cn: '505缝纫机',
  shelf_status_name: '已上架',
  c30_sale_cnt: 10,
  c7_sale_cnt: 4,
};
const dlRow = {...baseRow, store_key: 'DL', c30_sale_cnt: 9999};
const cxRow = {...baseRow, store_key: 'CX', c30_sale_cnt: 1};

const checks = [];
function check(label, actual, predicate) {
  const pass = predicate(actual);
  checks.push({label, actual, pass});
}

check(
  'explicit CX source excludes DL target candidate',
  score(dlRow, {storeHints: ['CX'], sourceStoreAllowList: ['CX'], productHints: ['505'], explicitSkcs: []}),
  v => v === -Infinity,
);
check(
  'explicit CX source allows CX candidate',
  score(cxRow, {storeHints: ['CX'], sourceStoreAllowList: ['CX'], productHints: ['505'], explicitSkcs: []}),
  v => Number.isFinite(v) && v > 0,
);
check(
  'no explicit source allows same-store DL candidate',
  score(dlRow, {storeHints: ['DL'], sourceStoreAllowList: [], productHints: ['505'], explicitSkcs: []}),
  v => Number.isFinite(v) && v > 0,
);

const explicitSameStore = inferSourceProductFromTask({
  targets: {sourceStores: ['DL'], stores: ['DL'], productRefs: ['505']},
  sourceSkc: 'sv260206143706406150869',
}, {targetStore: 'DL'});
check(
  'explicit same-store sourceStore/sourceSkc is preserved',
  explicitSameStore,
  v => v.sourceStore === 'DL' && v.sourceSkc === 'sv260206143706406150869',
);

const explicitThreeLetterStore = inferSourceProductFromTask({
  targets: {sourceStores: ['JSH'], stores: ['DL']},
  sourceSkc: 'sv260206143706406150869',
}, {targetStore: 'DL'});
check(
  'explicit three-letter source store is valid',
  explicitThreeLetterStore,
  v => v.sourceStore === 'JSH' && v.sourceSkc === 'sv260206143706406150869',
);

const ok = checks.every(x => x.pass)
  && !/store\s*===\s*normalizeStoreKey\(targetStore\)/.test(source)
  && /sourceStoreAllowList\.length\s*&&\s*!sourceStoreAllowList\.includes\(store\)/.test(source)
  && /sections['"`]\s*,\s*['"`]linksData\.json/.test(source)
  && /function biPortalLinkRows/.test(source);

console.log(JSON.stringify({
  ok,
  checks,
  staticChecks: {
    noTargetStoreBlanketExclusion: !/store\s*===\s*normalizeStoreKey\(targetStore\)/.test(source),
    explicitSourceAllowListPresent: /sourceStoreAllowList\.length\s*&&\s*!sourceStoreAllowList\.includes\(store\)/.test(source),
    readsSectionLinksData: /sections['"`]\s*,\s*['"`]linksData\.json/.test(source),
    biPortalLinkRowsHelperPresent: /function biPortalLinkRows/.test(source),
  },
}, null, 2));
if (!ok) process.exit(1);
