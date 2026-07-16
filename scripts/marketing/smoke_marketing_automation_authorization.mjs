#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertMarketingAutomationAuthorization,
  MARKETING_AUTOMATION_ACTIONS,
} from '../../lib/marketing_automation_authorization.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'marketing-automation-authorization-'));
try {
  const policyPath = path.join(tmp, 'policy.json');
  await fs.writeFile(policyPath, JSON.stringify({
    automationExecution: {
      enabled: true,
      authorizationId: 'owner-standing-v1',
      authorizedAt: '2026-07-16',
      perRunPayloadHashRequired: false,
      allowedContexts: ['cloud_timer'],
      storeScope: 'all_enabled_stores',
      allowedActions: [MARKETING_AUTOMATION_ACTIONS.APPLY_NEW_LISTING_FALLBACK],
    },
  }), 'utf8');

  const authorization = await assertMarketingAutomationAuthorization({
    action: MARKETING_AUTOMATION_ACTIONS.APPLY_NEW_LISTING_FALLBACK,
    storeKey: 'tz',
    policyPath,
    context: 'cloud_timer',
    authorizationId: 'owner-standing-v1',
  });
  assert.equal(authorization.storeKey, 'TZ');
  assert.equal(authorization.perRunPayloadHashRequired, false);

  await assert.rejects(() => assertMarketingAutomationAuthorization({
    action: MARKETING_AUTOMATION_ACTIONS.REPAIR_TARGET_PRICE_DRIFT,
    policyPath,
    context: 'cloud_timer',
    authorizationId: 'owner-standing-v1',
  }), /outside standing authorization/);
  await assert.rejects(() => assertMarketingAutomationAuthorization({
    action: MARKETING_AUTOMATION_ACTIONS.APPLY_NEW_LISTING_FALLBACK,
    policyPath,
    context: 'owner_codex_cli',
    authorizationId: 'owner-standing-v1',
  }), /context is not authorized/);
  await assert.rejects(() => assertMarketingAutomationAuthorization({
    action: MARKETING_AUTOMATION_ACTIONS.APPLY_NEW_LISTING_FALLBACK,
    policyPath,
    context: 'cloud_timer',
    authorizationId: 'wrong-id',
  }), /id is missing or does not match/);

  console.log(JSON.stringify({
    ok: true,
    test: 'standing_marketing_automation_authorization_is_scoped_and_hashless',
  }));
} finally {
  await fs.rm(tmp, {recursive: true, force: true});
}
