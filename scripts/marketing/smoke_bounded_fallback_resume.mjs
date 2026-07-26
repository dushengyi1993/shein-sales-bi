#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  countBlockedFallbackTargets,
  fallbackBatchExitCode,
  isResumableFallbackResult,
} from '../../lib/marketing_bounded_batch_resume.mjs';

assert.equal(isResumableFallbackResult({ok: true, status: 'executed'}), true);
assert.equal(isResumableFallbackResult({
  ok: false,
  status: 'executed_subset_with_platform_or_inventory_blockers',
  createdActivityId: 81930765,
  execute: {result: {desiredCoveredSkcs: ['safe-skc']}},
  blocked: {type: 'platform_or_inventory_blocked'},
}), true);
assert.equal(isResumableFallbackResult({
  ok: false,
  status: 'executed_subset_with_platform_or_inventory_blockers',
  createdActivityId: null,
  execute: {result: {desiredCoveredSkcs: []}},
}), false);
assert.equal(isResumableFallbackResult({
  ok: false,
  status: 'platform_or_inventory_blocked',
  blocked: {
    type: 'platform_or_inventory_blocked',
    blockedSkcs: ['inventory-blocked-skc'],
  },
}), true);
assert.equal(isResumableFallbackResult({
  ok: false,
  status: 'browser_launch_failed',
  blocked: {
    type: 'browser_launch_failed',
    blockedSkcs: ['not-a-terminal-business-blocker'],
  },
}), false);
assert.equal(isResumableFallbackResult({ok: false, status: 'failed'}), false);

assert.equal(fallbackBatchExitCode({failedCount: 0, deferredCount: 12}), 3);
assert.equal(fallbackBatchExitCode({failedCount: 1, deferredCount: 12}), 2);
assert.equal(fallbackBatchExitCode({failedCount: 0, deferredCount: 0}), 0);

assert.equal(countBlockedFallbackTargets([
  {
    storeKey: 'DX',
    targetSkcs: ['safe-1', 'blocked-1'],
    blocked: {blockedSkcs: ['blocked-1']},
    inventoryBlockedSkcs: ['blocked-1'],
  },
  {
    storeKey: 'DX',
    targetSkcs: ['blocked-1'],
    blocked: {blockedSkcs: ['blocked-1']},
  },
  {
    storeKey: 'HL',
    targetSkcs: ['blocked-2'],
    blocked: {type: 'platform_or_inventory_blocked'},
  },
]), 2);

console.log(JSON.stringify({ok: true, checks: 10}, null, 2));
