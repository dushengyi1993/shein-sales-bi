import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLinkOpsJsonRepository} from '../lib/link_ops_json_repository.mjs';
import {LinkOpsIdempotencyConflictError, LinkOpsRevisionConflictError, linkOpsPayloadHash} from '../lib/link_ops_repository.mjs';

const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'link-ops-json-'));
try {
  const repository = createLinkOpsJsonRepository({rootDir});
  const task = {id: 'task-1', ownerUser: 'alice', status: 'open', title: 'first'};
  const created = await repository.createTask(task, {idempotencyKey: 'task-create'});
  assert.equal(created.repositoryRevision, 1);
  assert.deepEqual(await repository.createTask(task, {idempotencyKey: 'task-create'}), created, 'same idempotency request replays');
  await assert.rejects(() => repository.createTask({...task, title: 'different'}, {idempotencyKey: 'task-create'}), LinkOpsIdempotencyConflictError);
  await assert.rejects(() => repository.updateTask('task-1', {...task, title: 'stale'}, {expectedRevision: 2}), LinkOpsRevisionConflictError);
  const updated = await repository.updateTask('task-1', {...task, title: 'updated'}, {expectedRevision: 1});
  assert.equal(updated.repositoryRevision, 2);

  const aliceAction = await repository.putActionRecord('alice:run', {ownerUser: 'alice', status: 'ready'});
  const bobAction = await repository.putActionRecord('bob:run', {ownerUser: 'bob', status: 'ready'});
  const actions = await repository.getActionState();
  assert.equal(actions.actions['alice:run'].ownerUser, 'alice');
  assert.equal(actions.actions['bob:run'].ownerUser, 'bob');
  assert.equal(aliceAction.repositoryRevision, 1);

  const payloadHash = linkOpsPayloadHash({work: 'write'});
  const queued = await repository.enqueueJob({id: 'job-1', ownerUser: 'alice', payload: {work: 'write'}}, {idempotencyKey: 'job-key'});
  const claimed = await repository.claimJob({workerId: 'worker-1', leaseMs: 10_000});
  assert.equal(claimed.jobId, queued.jobId);
  const boundary = await repository.advanceJobWriteBoundary('job-1', 'remote_write_started', {leaseOwner: 'worker-1', expectedRevision: claimed.repositoryRevision, payloadHash});
  const finished = await repository.finishJob('job-1', {status: 'uncertain_write', leaseOwner: 'worker-1', expectedRevision: boundary.repositoryRevision, error: {reason: 'timeout'}});
  assert.equal(finished.status, 'uncertain_write');
  assert.equal(finished.leaseOwner, '');

  const event = await repository.appendEvent({eventKey: 'manual-event', aggregateType: 'task', aggregateId: 'task-1', eventType: 'audited', payload: {ok: true}});
  const replayedEvent = await repository.appendEvent({eventKey: 'manual-event', aggregateType: 'task', aggregateId: 'task-1', eventType: 'audited', payload: {ok: true}});
  assert.equal(replayedEvent.eventId, event.eventId, 'event key does not overwrite or append a duplicate');
  const events = await repository.listEvents({aggregateType: 'task'});
  assert.equal(events.filter(row => row.eventKey === 'manual-event').length, 1);

  const snapshot = await repository.exportSnapshot();
  assert.equal(snapshot.taskStore.tasks[0].title, 'updated');
  assert.equal(snapshot.runtime.jobs[0].status, 'uncertain_write');
  assert.equal(snapshot.runtime.events.filter(row => row.eventKey === 'manual-event').length, 1);
  console.log('link_ops_json_repository: ok');
} finally {
  await fs.rm(rootDir, {recursive: true, force: true});
}
