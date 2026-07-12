#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLinkOpsJsonRepository} from '../lib/link_ops_json_repository.mjs';
import {createLinkOpsStoreGateway} from '../lib/link_ops_store_gateway.mjs';
import {createLinkOpsJobWorker} from '../lib/link_ops_job_worker.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'link-ops-worker-'));
const store = createLinkOpsStoreGateway({repository: createLinkOpsJsonRepository({rootDir: temp})});
const events = [];

try {
  await store.enqueueJob({
    id: 'job-ok',
    kind: 'intent_plan',
    ownerUser: 'alice',
    actorUser: 'alice',
    payload: {message: '给 DL 补链接'},
  }, {idempotencyKey: 'intent-plan:job-ok', ownerUser: 'alice', actorUser: 'alice'});

  const worker = createLinkOpsJobWorker({
    store,
    workerId: 'test-worker',
    leaseMs: 60_000,
    handlers: {
      intent_plan: async job => ({summary: job.payload.message, applied: true}),
    },
    onEvent: event => { events.push(event); },
  });
  assert.deepEqual(await worker.runOnce(), {claimed: true, jobId: 'job-ok'});
  const succeeded = await store.getJob('job-ok');
  assert.equal(succeeded.status, 'succeeded');
  assert.equal(succeeded.writeBoundary, 'read_only');
  assert.deepEqual(succeeded.result, {summary: '给 DL 补链接', applied: true});
  assert.ok(events.some(event => event.event === 'started'));
  assert.ok(events.some(event => event.event === 'succeeded'));

  await store.enqueueJob({
    id: 'job-unsupported',
    kind: 'unknown',
    ownerUser: 'alice',
    actorUser: 'alice',
    payload: {},
  }, {idempotencyKey: 'unknown:job', ownerUser: 'alice', actorUser: 'alice'});
  await worker.runOnce();
  assert.equal((await store.getJob('job-unsupported')).status, 'failed');

  await store.enqueueJob({
    id: 'job-failed',
    kind: 'intent_plan',
    ownerUser: 'alice',
    actorUser: 'alice',
    payload: {},
  }, {idempotencyKey: 'intent-plan:job-failed', ownerUser: 'alice', actorUser: 'alice'});
  const failingWorker = createLinkOpsJobWorker({
    store,
    workerId: 'failing-worker',
    handlers: {intent_plan: async () => { throw Object.assign(new Error('safe failure'), {code: 'MODEL_FAILED'}); }},
  });
  await failingWorker.runOnce();
  const failed = await store.getJob('job-failed');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'MODEL_FAILED');
  assert.equal(failed.error.message, 'safe failure');

  console.log('link_ops_job_worker: durable claim, read-only boundary, success, unsupported, and failure paths passed');
} finally {
  await store.close();
  await fs.rm(temp, {recursive: true, force: true});
}
