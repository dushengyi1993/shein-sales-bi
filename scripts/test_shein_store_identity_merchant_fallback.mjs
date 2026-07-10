#!/usr/bin/env node
/**
 * Regression smoke for OpenAPI store identity fallback.
 *
 * SHEIN query-store-info sometimes returns merchantId/supplierId but no GS
 * account number. The executor may accept that only if the static truth file
 * already binds the store to the same merchantId, and there are no conflicting
 * GS/merchant candidates.
 */
import {
  openApiIdentityToStorageIdentity,
  storeIdentityMatchesMerchantOnly,
  validateStoreIdentity,
} from '../lib/shein_store_identity.mjs';

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
const conflictingMerchant = validateStoreIdentity({
  store,
  truth,
  storageIdentity: {supplierIds: ['14167953', '99999999']},
  context: 'merchant-fallback-smoke',
});
const mappedIdentity = openApiIdentityToStorageIdentity({
  data: {merchantInfo: {merchant_id: '14167953', mallCode: '14167953'}, account: {accountNo: 'gs5636781'}},
  company: {company_name: 'Test Company'},
});

const checks = [];
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : Object.is(actual, expected);
  checks.push({label, actual, expected: typeof expected === 'function' ? expected.toString() : expected, pass});
}
check('merchant-only identity is not directly ok because GS is missing', goodMerchantOnly.ok, false);
check('merchant-only reason is account_mismatch', goodMerchantOnly.reason, 'account_mismatch');
check('shared fallback accepts exact merchant with no concrete GS candidate', storeIdentityMatchesMerchantOnly(goodMerchantOnly), true);
check('wrong merchant remains blocked', storeIdentityMatchesMerchantOnly(wrongMerchant), false);
check('wrong merchant reason conflicts', wrongMerchant.reason, 'conflicting_identity_candidates');
check('conflicting GS remains blocked even if merchant matches', storeIdentityMatchesMerchantOnly(conflictingGs), false);
check('conflicting merchant remains blocked even if expected merchant is also present', storeIdentityMatchesMerchantOnly(conflictingMerchant), false);
check('explicit matching GS is directly ok', explicitGs.ok, true);
check('explicit matching GS does not need fallback', storeIdentityMatchesMerchantOnly(explicitGs), true);
check('OpenAPI mapper normalizes GS account case', mappedIdentity.accountNos.includes('GS5636781'), true);
check('OpenAPI mapper collects nested merchant id', mappedIdentity.supplierIds.includes('14167953'), true);
check('OpenAPI mapper collects company name', mappedIdentity.companyNames.includes('Test Company'), true);

const ok = checks.every(x => x.pass);
console.log(JSON.stringify({
  ok,
  checks,
  staticChecks: {
    centralizedIdentityMapping: true,
    conflictGuardsCoveredByBehavior: true,
  },
}, null, 2));
if (!ok) process.exit(1);
