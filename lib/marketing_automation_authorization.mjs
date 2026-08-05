import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertCloudMarketingWriteGate} from './cloud_marketing_write_gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_POLICY = path.join(ROOT, 'config', 'marketing_pricing_policy.json');

export const MARKETING_AUTOMATION_ACTIONS = Object.freeze({
  RESTORE_MANUAL_SPECIAL: 'restore_manual_special_limited_discount',
  REPAIR_TARGET_PRICE_DRIFT: 'repair_limited_discount_target_price_drift',
  APPLY_NEW_LISTING_FALLBACK: 'apply_new_listing_limited_discount_fallback',
  APPLY_HIGH_CLICK_SPECIAL: 'apply_high_click_low_conversion_special_discount',
  CREATE_OR_REPLACE_ACTIVITY: 'create_or_replace_limited_discount_activity',
  TOP_UP_VIRTUAL_INVENTORY: 'top_up_limited_discount_virtual_inventory',
  TEMPORARILY_RAISE_AND_RESTORE_ACTIVITY_INVENTORY: 'temporarily_raise_and_restore_activity_inventory',
});

export async function assertMarketingAutomationAuthorization({
  action,
  storeKey = '',
  policyPath = process.env.SHEIN_BI_MARKETING_POLICY_FILE || DEFAULT_POLICY,
  context = process.env.SHEIN_BI_MARKETING_AUTOMATION_CONTEXT || '',
  authorizationId = process.env.SHEIN_BI_MARKETING_AUTOMATION_AUTHORIZATION || '',
  payloadHash = process.env.SHEIN_BI_MARKETING_RUN_PAYLOAD_HASH || '',
} = {}) {
  if (!action) throw new Error('Marketing automation action is required');
  assertCloudMarketingWriteGate();
  const policy = JSON.parse(await fs.readFile(policyPath, 'utf8'));
  const authorization = policy?.automationExecution;
  if (!authorization || authorization.enabled !== true) {
    throw new Error('Standing marketing automation authorization is disabled');
  }
  if (!authorization.authorizationId || authorizationId !== authorization.authorizationId) {
    throw new Error('Standing marketing automation authorization id is missing or does not match policy');
  }
  const allowedContexts = new Set(authorization.allowedContexts || []);
  if (!allowedContexts.has(context)) {
    throw new Error(`Marketing automation context is not authorized: ${context || '(empty)'}`);
  }
  const allowedActions = new Set(authorization.allowedActions || []);
  if (!allowedActions.has(action)) {
    throw new Error(`Marketing automation action is outside standing authorization: ${action}`);
  }
  if (authorization.storeScope !== 'all_enabled_stores') {
    throw new Error(`Unsupported marketing automation store scope: ${authorization.storeScope || '(empty)'}`);
  }
  const normalizedPayloadHash = String(payloadHash || '').trim().toLowerCase();
  if (authorization.perRunPayloadHashRequired === true && !/^[a-f0-9]{64}$/.test(normalizedPayloadHash)) {
    throw new Error('Exact per-run marketing payload/plan hash is required by standing authorization');
  }
  return {
    authorizationId: authorization.authorizationId,
    authorizedAt: authorization.authorizedAt,
    context,
    action,
    storeKey: String(storeKey || '').trim().toUpperCase() || null,
    storeScope: authorization.storeScope,
    perRunPayloadHashRequired: authorization.perRunPayloadHashRequired === true,
    perRunUserConfirmationRequired: authorization.perRunUserConfirmationRequired === true,
    payloadHash: normalizedPayloadHash || null,
  };
}
