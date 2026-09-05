import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  stageAndDeliverBusinessResult,
  retryPendingBusinessDeliveries,
  OPS_BUSINESS_STAGING_ROOT,
} from '../lib/ops_business_result_pipeline.mjs';

console.log('Testing ops_business_result_pipeline & retry...');

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-pipeline-test-'));
const testLandingRoot = path.join(tempDir, 'staging');
await fs.mkdir(testLandingRoot, {recursive: true});

const fakeLarkConfig = {
  recipientChatId: 'oc_group123',
  defaultIdentity: 'bot',
};

// Fake spawn for testing deliverCloudTeamReport
function makeFakeSpawn(outcomes) {
  let callIndex = 0;
  return function fakeSpawn(bin, args, options) {
    const outcome = outcomes[callIndex++] || {ok: true, message_id: 'om_test_default'};
    return {
      stdout: {
        setEncoding() {},
        on(event, cb) {
          if (event === 'data') cb(JSON.stringify(outcome));
        },
      },
      stderr: {
        setEncoding() {},
        on() {},
      },
      on(event, cb) {
        if (event === 'close') {
          setTimeout(() => cb(outcome.exitCode !== undefined ? outcome.exitCode : (outcome.ok ? 0 : 1)), 5);
        }
      },
    };
  };
}

// 1. Stage and deliver successful business stage
{
  const spawnImpl = makeFakeSpawn([
    {ok: true, message_id: 'om_msg_summary_1'},
    {ok: true, data: {message_id: 'om_msg_attach_1', file_key: 'fk_attach_1'}},
  ]);

  const outcome = await stageAndDeliverBusinessResult({
    automationId: 'inventory-replenishment',
    businessDate: '2026-09-05',
    result: {
      action: '库存维护',
      succeededCount: 15,
      failedItems: [],
    },
    landingRoot: testLandingRoot,
    config: fakeLarkConfig,
    spawnImpl,
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.delivery.items.summary.accepted, true);
  assert.equal(outcome.delivery.items.attachment.accepted, true);
  assert.match(outcome.formatted.copy, /库存维护已全部完成/);
}

// 2. Stage and deliver partial failure (summary ok, attachment fails)
{
  const spawnImpl = makeFakeSpawn([
    {ok: true, message_id: 'om_msg_summary_2'},
    {ok: false, error: {code: 'LARK_TIMEOUT', message: 'timeout'}},
  ]);

  const outcome = await stageAndDeliverBusinessResult({
    automationId: 'pending-discuss-daily',
    businessDate: '2026-09-05',
    result: {
      action: '待议价扫描',
      succeededCount: 19,
      failedItems: [],
    },
    landingRoot: testLandingRoot,
    config: fakeLarkConfig,
    spawnImpl,
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 'partial');
  assert.equal(outcome.delivery.items.summary.accepted, true);
  assert.equal(outcome.delivery.items.attachment.accepted, false);
}

// 3. Retry pending/partial delivery: summary is NOT resent, attachment IS retried
{
  const retrySpawnImpl = makeFakeSpawn([
    {ok: true, data: {message_id: 'om_msg_attach_2_resend', file_key: 'fk_attach_2'}},
  ]);

  const retried = await retryPendingBusinessDeliveries({
    landingRoot: testLandingRoot,
    config: fakeLarkConfig,
    spawnImpl: retrySpawnImpl,
  });

  assert.equal(retried.length, 1);
  assert.equal(retried[0].automationId, 'pending-discuss-daily');
  assert.equal(retried[0].previousStatus, 'partial');
  assert.equal(retried[0].newStatus, 'ok');
  assert.equal(retried[0].ok, true);
}

// Cleanup
await fs.rm(tempDir, {recursive: true, force: true});

console.log('✓ All ops_business_result_pipeline tests passed successfully');
