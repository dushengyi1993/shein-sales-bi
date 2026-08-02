#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  assertMarketingAutomationAuthorization,
  MARKETING_AUTOMATION_ACTIONS,
} from '../../lib/marketing_automation_authorization.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const policyPath = path.join(ROOT, 'config', 'marketing_pricing_policy.json');
const policy = JSON.parse(await fs.readFile(policyPath, 'utf8'));
const authorization = policy.automationExecution;
assert.equal(policy.activityMinimumInventoryTransaction?.enabled, true);
assert.equal(policy.activityMinimumInventoryTransaction?.implementationStatus, 'implemented');
assert.equal(policy.lowEtFastSellerPricePullback?.enabled, true);
assert.equal(policy.lowEtFastSellerPricePullback?.implementationStatus, 'implemented');
assert.equal(authorization.allowedActions.includes(MARKETING_AUTOMATION_ACTIONS.TOP_UP_VIRTUAL_INVENTORY), false);
assert.equal(
  authorization.allowedActions.includes(MARKETING_AUTOMATION_ACTIONS.TEMPORARILY_RAISE_AND_RESTORE_ACTIVITY_INVENTORY),
  true,
);
await assert.rejects(() => assertMarketingAutomationAuthorization({
  action: MARKETING_AUTOMATION_ACTIONS.TOP_UP_VIRTUAL_INVENTORY,
  policyPath,
  context: authorization.allowedContexts[0],
  authorizationId: authorization.authorizationId,
  payloadHash: 'a'.repeat(64),
}), /outside standing authorization/);
const accepted = await assertMarketingAutomationAuthorization({
  action: MARKETING_AUTOMATION_ACTIONS.TEMPORARILY_RAISE_AND_RESTORE_ACTIVITY_INVENTORY,
  policyPath,
  context: authorization.allowedContexts[0],
  authorizationId: authorization.authorizationId,
  payloadHash: 'b'.repeat(64),
});
assert.equal(accepted.action, MARKETING_AUTOMATION_ACTIONS.TEMPORARILY_RAISE_AND_RESTORE_ACTIVITY_INVENTORY);
console.log(JSON.stringify({
  ok: true,
  checks: 8,
  oldPersistentTopUpAuthorized: false,
  transactionExecutorImplemented: true,
  lowEtFastSellerPricingImplemented: true,
}, null, 2));
