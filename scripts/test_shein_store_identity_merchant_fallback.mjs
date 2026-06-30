#!/usr/bin/env node
/**
 * Regression smoke for OpenAPI store identity fallback.
 *
 * SHEIN query-store-info sometimes returns merchantId/supplierId but no GS
 * account number. The executor may accept that only if the static truth file
 * already binds the store to the same merchantId, and there are no conflicting
 * GS/merchant candidates.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {validateStoreIdentity} from '../lib/shein_store_identity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executorFile = path.join(ROOT, 'scripts', 'link_ops_hl_openapi_executor.mjs');
const source = await fs.readFile(executorFile, 'utf8');
const match = source.match(/function openApiStoreIdentityMatchesMerchant[\s\S]*?\r?\n}\r?\n\r?\nfunction configuredStoreForIdentity/);
if (!match) {
  console.error(JSON.stringify({ok: false, error: 'openApiStoreIdentityMatchesMerchant function not found'}, null, 2));
  process.exit(1);
}
const functionSource = match[0].replace(/\r?\n\r?\nfunction configuredStoreForIdentity$/, '');
const context = {};
vm.createContext(context);
vm.runInContext(`${functionSource}\nthis.openApiStoreIdentityMatchesMerchant = openApiStoreIdentityMatchesMerchant;`, context);
const acceptsMerchant = context.openApiStoreIdentityMatchesMerchant;

const store = {
  storeKey: 'TZ',
  profileKey: 'tz',
  shopName: 'GS5636781',
  accountNo: 'GS5636781',
  merchantId: '14167953',
};
const truth = {accountNo: 'GS5636781', merchantId: '14167953'};
const goodMerchantOnly = validateStoreIdentity({
  store,
  truth,
  storageIdentity: {supplierIds: ['14167953']},
  context: 'merchant-fallback-smoke',
});
const wrongMerchant = validateStoreIdentity({
  store,
  truth,
  storageIdentity: {supplierIds: ['99999999']},
  context: 'merchant-fallback-smoke',
});
const conflictingGs = validateStoreIdentity({
  store,
  truth,
  storageIdentity: {supplierIds: ['14167953'], accountNos: ['GS0000000']},
  context: 'merchant-fallback-smoke',
});
const explicitGs = validateStoreIdentity({
  store,
  truth,
  storageIdentity: {supplierIds: ['14167953'], accountNos: ['GS5636781']},
  context: 'merchant-fallback-smoke',
});

const checks = [];
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : Object.is(actual, expected);
  checks.push({label, actual, expected: typeof expected === 'function' ? expected.toString() : expected, pass});
}
check('merchant-only identity is not directly ok because GS is missing', goodMerchantOnly.ok, false);
check('merchant-only reason is account_mismatch', goodMerchantOnly.reason, 'account_mismatch');
check('executor fallback accepts exact merchant with no concrete GS candidate', acceptsMerchant(goodMerchantOnly), true);
check('wrong merchant remains blocked', acceptsMerchant(wrongMerchant), false);
check('wrong merchant reason conflicts', wrongMerchant.reason, 'conflicting_identity_candidates');
check('conflicting GS remains blocked even if merchant matches', acceptsMerchant(conflictingGs), false);
check('explicit matching GS is directly ok', explicitGs.ok, true);
check('explicit matching GS does not need fallback', acceptsMerchant(explicitGs), true);

const ok = checks.every(x => x.pass)
  && /merchantOk\s*&&\s*!accountConflicts\.length\s*&&\s*!merchantConflicts\.length\s*&&\s*!hasConcreteAccountCandidate/.test(source);
console.log(JSON.stringify({
  ok,
  checks,
  staticChecks: {
    noConcreteGsCandidateRequiredForFallback: /!hasConcreteAccountCandidate/.test(source),
    conflictGuardsPresent: /!accountConflicts\.length\s*&&\s*!merchantConflicts\.length/.test(source),
  },
}, null, 2));
if (!ok) process.exit(1);
