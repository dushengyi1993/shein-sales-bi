#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  classifyUnifiedLoginRecovery,
  hasConcreteStoreIdentityConflict,
  isMarketingLoginRedirect,
  TERMINAL_LOGIN_BLOCKERS,
} from '../lib/marketing_unified_login_recovery_contract.mjs';

assert.equal(isMarketingLoginRedirect({endpoint: '/common/get_apollo_map', status: 302, code: 20302}), true);
assert.equal(isMarketingLoginRedirect({endpoint: '/other', code: 20302}), false);
for (const blocker of TERMINAL_LOGIN_BLOCKERS) {
  const result = classifyUnifiedLoginRecovery({relogin: {ok: false, blocker}});
  assert.equal(result.terminal, true, blocker);
  assert.equal(result.classification, 'login_terminal_blocker', blocker);
}
for (const blocker of ['session_expired', 'bootstrap_failed']) {
  const result = classifyUnifiedLoginRecovery({relogin: {ok: false, blocker}});
  assert.equal(result.terminal, false, blocker);
  assert.equal(result.classification, 'recoverable_pending', blocker);
}
assert.equal(classifyUnifiedLoginRecovery({
  relogin: {ok: true},
  identity: {ok: false, mismatch: true},
}).blocker, 'store_profile_identity_mismatch');
assert.equal(classifyUnifiedLoginRecovery({
  relogin: {ok: true},
  identity: {ok: false, mismatch: false},
}).classification, 'recoverable_pending');
assert.equal(classifyUnifiedLoginRecovery({
  relogin: {ok: true},
  identity: {ok: true},
  retry: {full: {ok: true}},
}).classification, 'recovered');
assert.equal(hasConcreteStoreIdentityConflict({
  identity: {
    reason: 'account_and_merchant_mismatch',
    accountCandidates: [],
    merchantCandidates: [],
    accountConflicts: [],
    merchantConflicts: [],
  },
}), false, 'missing identity evidence stays recoverable');
assert.equal(hasConcreteStoreIdentityConflict({
  identity: {accountConflicts: ['GS-WRONG'], merchantConflicts: []},
}), true, 'a concrete conflicting account is terminal');

const root = process.cwd();
const source = await fs.readFile(path.join(root, 'scripts/marketing/batch_restore_manual_limited_discounts.mjs'), 'utf8');
assert.match(source, /isMarketingLoginRedirect\(dry\)/);
assert.match(source, /scripts\/auto_relogin_shein_store\.mjs/);
assert.match(source, /scripts\/marketing\/check_store_profile_identity\.mjs/);
assert.match(source, /--no-launch[\s\S]*--no-close/);
assert.match(source, /--no-login-recovery/);
assert.match(source, /dry = await applyRescue\(storeKey, store\.port, rescuePath, false\);[\s\S]*retryAssessment/);
assert.match(source, /record\.status = 'recoverable_login_pending'/);

const identitySource = await fs.readFile(path.join(root, 'scripts/marketing/check_store_profile_identity.mjs'), 'utf8');
assert.match(identitySource, /page\.isLogin && !args\.noLoginRecovery/);

console.log(JSON.stringify({ok: true, checks: 24}, null, 2));
