import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {acquireFileLock, createLinkOpsJsonRepository} from '../lib/link_ops_json_repository.mjs';
import {LinkOpsIdempotencyConflictError, LinkOpsRevisionConflictError, linkOpsPayloadHash} from '../lib/link_ops_repository.mjs';
import {createLinkOpsStoreGateway} from '../lib/link_ops_store_gateway.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const EVENT_RETENTION_LIMIT = 10_000;
const IDEMPOTENCY_RETENTION_LIMIT = 5_000;

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeJson(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function seededEvent(id, createdAt, eventKey = null) {
  return {
    eventId: `seed-${id}`,
    eventKey,
    aggregateType: 'task',
    aggregateId: 'retention-task',
    eventType: 'seeded_audit',
    ownerUser: 'alice',
    actorUser: 'alice',
    status: 'open',
    chatSessionId: null,
    taskId: 'retention-task',
    jobId: null,
    payload: {id},
    payloadHash: `seed-hash-${id}`,
    createdAt,
  };
}

function seededIdempotency(id, createdAt) {
  return {
    requestHash: `seed-request-${id}`,
    response: {id},
    createdAt,
  };
}

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

const retentionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'link-ops-json-retention-'));
try {
  const taskFile = path.join(retentionRoot, 'state', 'bi_link_ops_tasks.json');
  const repositoryA = createLinkOpsJsonRepository({rootDir: retentionRoot});
  const repositoryB = createLinkOpsJsonRepository({rootDir: retentionRoot});
  const retentionTask = {id: 'retention-task', ownerUser: 'alice', status: 'open', title: 'retained'};
  const created = await repositoryA.createTask(retentionTask, {idempotencyKey: 'retained-create'});
  const freshAt = new Date().toISOString();
  const expiredAt = new Date(Date.now() - (365 * DAY_MS)).toISOString();
  const createIdempotencyKey = 'task:create:alice\u0000retained-create';

  const seededStore = await readJson(taskFile);
  const retainedCreateIdempotency = seededStore._repository.idempotency[createIdempotencyKey];
  assert.ok(retainedCreateIdempotency, 'create idempotency record exists before compaction');
  seededStore._repository.events = [
    seededEvent('expired', expiredAt, 'audit-expired'),
    ...Array.from(
      {length: EVENT_RETENTION_LIMIT + 2},
      (_, index) => seededEvent(`current-${index}`, freshAt)
    ),
    seededEvent('audit-current', freshAt, 'audit-current'),
  ];
  seededStore._repository.idempotency = Object.fromEntries([
    ['seed:expired\u0000key', seededIdempotency('expired', expiredAt)],
    ...Array.from(
      {length: IDEMPOTENCY_RETENTION_LIMIT + 2},
      (_, index) => [`seed:current:${index}\u0000key`, seededIdempotency(`current-${index}`, freshAt)]
    ),
    [createIdempotencyKey, retainedCreateIdempotency],
  ]);
  await writeJson(taskFile, seededStore);

  const updated = await repositoryA.updateTask(
    retentionTask.id,
    {...retentionTask, status: 'updated'},
    {expectedRevision: created.repositoryRevision, idempotencyKey: 'retained-update'}
  );
  assert.equal(updated.repositoryRevision, 2);

  let compactedStore = await readJson(taskFile);
  assert.equal(compactedStore.tasks.length, 1, 'history compaction does not remove active entities');
  assert.equal(compactedStore.tasks[0].status, 'updated');
  assert.equal(compactedStore._repository.events.length, EVENT_RETENTION_LIMIT, 'event history obeys count bound');
  assert.equal(
    Object.keys(compactedStore._repository.idempotency).length,
    IDEMPOTENCY_RETENTION_LIMIT,
    'idempotency history obeys count bound'
  );
  assert.ok(compactedStore._repository.events.some(row => row.eventKey === 'audit-current'), 'current audit event is retained');
  assert.ok(!compactedStore._repository.events.some(row => row.eventKey === 'audit-expired'), 'expired audit event is removed');
  assert.ok(compactedStore._repository.idempotency[createIdempotencyKey], 'unexpired create replay remains protected');
  assert.ok(!compactedStore._repository.idempotency['seed:expired\u0000key'], 'expired idempotency record is removed');

  const [concurrentA, concurrentB] = await Promise.all([
    repositoryA.createTask(
      {id: 'concurrent-a', ownerUser: 'alice', status: 'open'},
      {idempotencyKey: 'concurrent-a'}
    ),
    repositoryB.createTask(
      {id: 'concurrent-b', ownerUser: 'bob', status: 'open'},
      {idempotencyKey: 'concurrent-b'}
    ),
  ]);
  assert.equal(concurrentA.repositoryRevision, 1);
  assert.equal(concurrentB.repositoryRevision, 1);
  compactedStore = await readJson(taskFile);
  assert.deepEqual(
    new Set(compactedStore.tasks.map(row => row.id)),
    new Set(['retention-task', 'concurrent-a', 'concurrent-b']),
    'serial file lock prevents concurrent compaction from losing entities'
  );
  assert.equal(compactedStore._repository.events.length, EVENT_RETENTION_LIMIT);
  assert.equal(Object.keys(compactedStore._repository.idempotency).length, IDEMPOTENCY_RETENTION_LIMIT);
  assert.ok(compactedStore._repository.idempotency['task:create:alice\u0000concurrent-a']);
  assert.ok(compactedStore._repository.idempotency['task:create:bob\u0000concurrent-b']);

  const restarted = createLinkOpsJsonRepository({rootDir: retentionRoot});
  assert.equal((await restarted.getTask('retention-task')).repositoryRevision, 2, 'restart reads committed entity revision');
  assert.equal((await restarted.getTask('concurrent-a')).status, 'open');
  const replayedAfterRestart = await restarted.createTask(retentionTask, {idempotencyKey: 'retained-create'});
  assert.deepEqual(replayedAfterRestart, created, 'restart preserves retained idempotency replay response');
  assert.equal((await restarted.getTask('retention-task')).repositoryRevision, 2, 'idempotency replay does not rewrite active entity');

  compactedStore = await readJson(taskFile);
  compactedStore._repository.events.unshift(seededEvent('failed-write-expired', expiredAt, 'failed-write-expired'));
  compactedStore._repository.idempotency['failed-write-expired\u0000key'] = seededIdempotency('failed-write-expired', expiredAt);
  await writeJson(taskFile, compactedStore);
  const beforeCallbackFailure = await fs.readFile(taskFile, 'utf8');
  await assert.rejects(
    () => repositoryA.updateTask(
      retentionTask.id,
      {...retentionTask, status: 'must-not-commit'},
      {expectedRevision: 999, idempotencyKey: 'callback-failure'}
    ),
    LinkOpsRevisionConflictError
  );
  assert.equal(
    await fs.readFile(taskFile, 'utf8'),
    beforeCallbackFailure,
    'callback failure commits neither compaction nor entity mutation'
  );

  if (process.platform === 'win32') {
    await fs.chmod(taskFile, 0o444);
    try {
      await assert.rejects(
        () => repositoryA.updateTask(
          retentionTask.id,
          {...retentionTask, status: 'write-failure'},
          {expectedRevision: 2, idempotencyKey: 'write-failure'}
        ),
        error => ['EACCES', 'EBUSY', 'EPERM'].includes(String(error?.code || ''))
      );
      assert.equal(
        await fs.readFile(taskFile, 'utf8'),
        beforeCallbackFailure,
        'atomic replacement failure leaves the pre-compaction file byte-identical'
      );
      const leftovers = (await fs.readdir(path.dirname(taskFile)))
        .filter(name => name.endsWith('.tmp') || name.endsWith('.lock'));
      assert.deepEqual(leftovers, [], 'failed atomic replacement removes temporary and lock files');
    } finally {
      await fs.chmod(taskFile, 0o666);
    }
  }

  const recovered = await repositoryA.updateTask(
    retentionTask.id,
    {...retentionTask, status: 'recovered'},
    {expectedRevision: 2, idempotencyKey: 'write-failure'}
  );
  assert.equal(recovered.repositoryRevision, 3, 'retry after failed write commits exactly once');
  compactedStore = await readJson(taskFile);
  assert.equal(compactedStore.tasks.find(row => row.id === retentionTask.id).status, 'recovered');
  assert.equal(compactedStore._repository.events.length, EVENT_RETENTION_LIMIT);
  assert.equal(Object.keys(compactedStore._repository.idempotency).length, IDEMPOTENCY_RETENTION_LIMIT);
  assert.ok(!compactedStore._repository.events.some(row => row.eventKey === 'failed-write-expired'));
  assert.ok(!compactedStore._repository.idempotency['failed-write-expired\u0000key']);

  const finalRestart = createLinkOpsJsonRepository({rootDir: retentionRoot});
  assert.equal((await finalRestart.getTask(retentionTask.id)).repositoryRevision, 3);
  console.log('link_ops_json_repository: bounded retention and atomic compaction ok');
} finally {
  await fs.chmod(path.join(retentionRoot, 'state', 'bi_link_ops_tasks.json'), 0o666).catch(() => {});
  await fs.rm(retentionRoot, {recursive: true, force: true});
}

const mirrorFailureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'link-ops-json-action-mirror-'));
try {
  const runtimeFile = path.join(mirrorFailureRoot, 'state', 'bi_link_ops_runtime.json');
  const actionFile = path.join(mirrorFailureRoot, 'state', 'bi_action_state.json');
  let mirrorWriteAttempts = 0;
  let attemptedMirror = null;
  const failingMirrorWriter = async (_file, mirror) => {
    mirrorWriteAttempts += 1;
    attemptedMirror = structuredClone(mirror);
    const error = new Error('deterministic legacy action mirror failure');
    error.code = 'EIO';
    throw error;
  };
  const actionChanges = [{
    key: 'alice:post-commit',
    expectedRevision: null,
    record: {ownerUser: 'alice', status: 'ready', payload: {attempt: 1}},
  }];
  const actionOptions = {actorUser: 'alice', idempotencyKey: 'action-post-commit-mirror-failure'};
  const repository = createLinkOpsJsonRepository({
    rootDir: mirrorFailureRoot,
    legacyActionMirrorWriter: failingMirrorWriter,
  });

  const committed = await repository.applyActionChanges(actionChanges, actionOptions);
  assert.equal(committed.changes[0].record.repositoryRevision, 1);
  const runtimeAfterCommit = await readJson(runtimeFile);
  assert.equal(
    runtimeAfterCommit.records.action_state['alice:post-commit'].repositoryRevision,
    1,
    'authoritative action batch is durable before the legacy mirror attempt'
  );
  assert.ok(
    runtimeAfterCommit._repository.idempotency[
      'record:action_state:batch\u0000action-post-commit-mirror-failure'
    ],
    'authoritative commit stores its idempotency response in the same atomic runtime write'
  );

  const failedProjection = await repository.flushLegacyActionState();
  assert.equal(mirrorWriteAttempts, 1);
  assert.equal(attemptedMirror.actions['alice:post-commit'].status, 'ready');
  assert.deepEqual(failedProjection.legacyMirrorFlush, {
    ok: false,
    status: 'pending',
    authoritativeSource: 'runtime',
    actionBatchRetryRequired: false,
    projectionRetrySafe: true,
    error: {code: 'EIO', message: 'deterministic legacy action mirror failure'},
  });
  assert.equal(
    await fs.access(actionFile).then(() => true, () => false),
    false,
    'failed atomic mirror attempt does not create a misleading legacy snapshot'
  );
  const gatewayChanges = [{
    key: 'alice:gateway-post-commit',
    expectedRevision: null,
    record: {ownerUser: 'alice', status: 'queued', payload: {attempt: 1}},
  }];
  const gateway = createLinkOpsStoreGateway({repository});
  const gatewayCommittedState = await gateway.applyActionChanges(gatewayChanges, {actorUser: 'alice'});
  assert.equal(
    gatewayCommittedState.actions['alice:gateway-post-commit'].repositoryRevision,
    1,
    'gateway returns authoritative success when its post-commit legacy mirror flush fails'
  );
  assert.equal(mirrorWriteAttempts, 2);

  const restarted = createLinkOpsJsonRepository({
    rootDir: mirrorFailureRoot,
    legacyActionMirrorWriter: failingMirrorWriter,
  });
  const restartedState = await restarted.getActionState();
  assert.equal(restartedState.actions['alice:post-commit'].status, 'ready');
  assert.equal(restartedState.actions['alice:post-commit'].repositoryRevision, 1);
  const replayed = await restarted.applyActionChanges(actionChanges, actionOptions);
  assert.deepEqual(replayed, committed, 'same idempotency key replays the committed response after restart');
  assert.equal(
    (await restarted.getActionState()).actions['alice:post-commit'].repositoryRevision,
    1,
    'idempotent replay after mirror failure does not increment the authoritative revision'
  );
  await assert.rejects(
    () => restarted.applyActionChanges(
      [{...actionChanges[0], record: {...actionChanges[0].record, status: 'different'}}],
      actionOptions
    ),
    LinkOpsIdempotencyConflictError,
    'projection failure handling must not swallow authoritative idempotency conflicts'
  );
  const restartedGateway = createLinkOpsStoreGateway({repository: restarted});
  const gatewayReplayState = await restartedGateway.applyActionChanges(gatewayChanges, {actorUser: 'alice'});
  assert.equal(
    gatewayReplayState.actions['alice:gateway-post-commit'].repositoryRevision,
    1,
    'gateway replay after restart keeps the original authoritative revision'
  );
  assert.equal(mirrorWriteAttempts, 3);

  const failedProjectionAfterRestart = await restarted.flushLegacyActionState();
  assert.equal(failedProjectionAfterRestart.legacyMirrorFlush.status, 'pending');
  assert.equal(mirrorWriteAttempts, 4);

  const recovered = createLinkOpsJsonRepository({rootDir: mirrorFailureRoot});
  const rebuiltMirror = await recovered.flushLegacyActionState();
  assert.equal(rebuiltMirror.legacyMirrorFlush, undefined);
  assert.equal(rebuiltMirror.actions['alice:post-commit'].status, 'ready');
  assert.equal(rebuiltMirror.actions['alice:gateway-post-commit'].status, 'queued');
  const persistedMirror = await readJson(actionFile);
  assert.deepEqual(persistedMirror, rebuiltMirror, 'recovered projection is rebuilt from authoritative runtime state');
  assert.equal(
    (await recovered.getActionState()).actions['alice:post-commit'].repositoryRevision,
    1,
    'mirror recovery never rewrites the authoritative action entity'
  );
  console.log('link_ops_json_repository: action mirror post-commit ambiguity handled');
} finally {
  await fs.rm(mirrorFailureRoot, {recursive: true, force: true});
}

function lockError(code) {
  const error = new Error('mock fs error ' + code);
  error.code = code;
  return error;
}

function recordingLockHandle(world) {
  return {
    writtenText: null,
    async writeFile(text) {
      this.writtenText = String(text);
      if (world) {
        world.content = String(text);
        world.size = Buffer.byteLength(String(text), 'utf8');
      }
    },
    async sync() {},
    async close() {},
  };
}

function lockContent(record) {
  return JSON.stringify({
    token: record.token === undefined ? undefined : record.token,
    pid: record.pid || 424242,
    createdAt: record.createdAt,
    target: 'lock-probe-target',
  });
}

function makeLockFs(hooks) {
  const calls = {open: [], stat: [], readFile: [], unlink: [], mkdir: []};
  const fsImpl = {
    calls,
    async mkdir() {
      calls.mkdir.push(1);
      if (hooks.onMkdir) return hooks.onMkdir();
    },
    async open(filePath, flags) {
      calls.open.push(filePath);
      if (hooks.onOpen) return hooks.onOpen(filePath, flags);
      throw lockError('EEXIST');
    },
    async stat(filePath) {
      calls.stat.push(filePath);
      if (hooks.onStat) return hooks.onStat(filePath);
      throw lockError('ENOENT');
    },
    async readFile(filePath) {
      calls.readFile.push(filePath);
      if (hooks.onReadFile) return hooks.onReadFile(filePath);
      throw lockError('ENOENT');
    },
    async unlink(filePath) {
      calls.unlink.push(filePath);
      if (hooks.onUnlink) return hooks.onUnlink(filePath);
    },
  };
  return fsImpl;
}

const lockTestRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'link-ops-json-locks-'));
try {
  const lockTarget = path.join(lockTestRoot, 'state', 'bi_lock_probe.json');
  const lockPath = lockTarget + '.lock';

  // EPERM against a visible lock file is provable contention: it is retried
  // until the holder releases, and the acquired lock carries a non-forgeable
  // 128-bit owner token.
  {
    const other = lockContent({token: 'a'.repeat(32), createdAt: new Date().toISOString()});
    const world = {content: other, mtimeMs: Date.now(), size: Buffer.byteLength(other, 'utf8')};
    let lockTries = 0;
    let held = null;
    const fsImpl = makeLockFs({
      onOpen: (filePath, flags) => {
        if (flags !== 'wx') throw lockError('EINVAL');
        lockTries += 1;
        if (lockTries < 3) throw lockError('EPERM');
        held = recordingLockHandle(world);
        return held;
      },
      onStat: () => ({mtimeMs: world.mtimeMs, size: world.size, isDirectory: () => false}),
      onReadFile: () => world.content,
    });
    const release = await acquireFileLock(lockTarget, {timeoutMs: 2000, staleMs: 120000, fsImpl});
    try {
      assert.ok(lockTries >= 3, 'EPERM against a visible lock is retried as contention');
      const written = JSON.parse(held.writtenText);
      assert.match(written.token, /^[0-9a-f]{32}$/, 'acquired lock carries a non-forgeable owner token');
    } finally {
      await release();
    }
    assert.equal(
      fsImpl.calls.unlink.filter(p => p === lockPath).length,
      1,
      'release unlinks the owned lock path'
    );
  }

  // EBUSY and EACCES against a visible lock file follow the same retry path.
  for (const contendCode of ['EBUSY', 'EACCES']) {
    const other = lockContent({token: 'b'.repeat(32), createdAt: new Date().toISOString()});
    const world = {content: other, mtimeMs: Date.now(), size: Buffer.byteLength(other, 'utf8')};
    let tries = 0;
    let held = null;
    const fsImpl = makeLockFs({
      onOpen: (filePath, flags) => {
        tries += 1;
        if (tries < 3) throw lockError(contendCode);
        held = recordingLockHandle(world);
        return held;
      },
      onStat: () => ({mtimeMs: world.mtimeMs, size: world.size, isDirectory: () => false}),
      onReadFile: () => world.content,
    });
    const release = await acquireFileLock(lockTarget, {timeoutMs: 2000, staleMs: 120000, fsImpl});
    await release();
    assert.ok(tries >= 3, contendCode + ' against a visible lock is retried as contention');
    assert.match(JSON.parse(held.writtenText).token, /^[0-9a-f]{32}$/, contendCode + ' claim writes an owner token');
    assert.equal(
      fsImpl.calls.unlink.filter(p => p === lockPath).length,
      1,
      contendCode + ' release unlinks the owned lock'
    );
  }

  // A real directory/ACL permission error (no lock file, directory writes
  // denied) fails closed quickly instead of spinning until the timeout.
  {
    const startedAt = Date.now();
    const fsImpl = makeLockFs({
      onOpen: (filePath) => { throw lockError('EACCES'); },
      onStat: () => { throw lockError('ENOENT'); },
    });
    await assert.rejects(
      () => acquireFileLock(lockTarget, {timeoutMs: 5000, staleMs: 10000, fsImpl}),
      error => String(error && error.code) === 'EACCES',
      'real directory/ACL create errors fail closed instead of timing out'
    );
    assert.ok(Date.now() - startedAt < 1500, 'permission errors fail fast, before the lock timeout');
    assert.equal(
      fsImpl.calls.open.filter(p => p === lockPath).length,
      1,
      'permission errors are not spun as retries'
    );
  }

  // A transient create failure with no visible lock file is retried only when
  // the directory is provably writable (write probe succeeds).
  {
    let tries = 0;
    const fsImpl = makeLockFs({
      onOpen: (filePath, flags) => {
        if (filePath.indexOf('.bi-lock-probe-') >= 0) return recordingLockHandle(null);
        tries += 1;
        if (tries < 3) throw lockError('EPERM');
        return recordingLockHandle(null);
      },
      onStat: () => { throw lockError('ENOENT'); },
      onReadFile: () => { throw lockError('ENOENT'); },
    });
    const release = await acquireFileLock(lockTarget, {timeoutMs: 2000, staleMs: 120000, fsImpl});
    await release();
    assert.ok(tries >= 3, 'transient create failures are retried when the directory is provably writable');
    assert.ok(
      fsImpl.calls.unlink.some(p => p.indexOf('.bi-lock-probe-') >= 0),
      'write probes are cleaned up after use'
    );
  }

  // Normal release: the owned lock path is removed exactly once.
  {
    const world = {content: null, mtimeMs: Date.now(), size: 0};
    let acquired = null;
    const fsImpl = makeLockFs({
      onOpen: (filePath, flags) => {
        acquired = recordingLockHandle(world);
        return acquired;
      },
      onStat: () => ({mtimeMs: world.mtimeMs, size: world.size, isDirectory: () => false}),
      onReadFile: () => world.content,
      onUnlink: (filePath) => { world.content = null; },
    });
    const release = await acquireFileLock(lockTarget, {timeoutMs: 2000, staleMs: 120000, fsImpl});
    assert.ok(world.content !== null, 'acquisition writes the owner token');
    assert.match(JSON.parse(world.content).token, /^[0-9a-f]{32}$/, 'owner token is a 128-bit random hex string');
    await release();
    assert.equal(world.content, null, 'release removes the owned lock');
    assert.equal(fsImpl.calls.unlink.filter(p => p === lockPath).length, 1, 'one owned unlink');
  }

  // Release ownership race: when the path was replaced by a successor lock,
  // release must not delete the successor's file.
  {
    const world = {content: null, mtimeMs: Date.now(), size: 0};
    let acquired = null;
    const fsImpl = makeLockFs({
      onOpen: (filePath, flags) => {
        acquired = recordingLockHandle(world);
        return acquired;
      },
      onStat: () => ({mtimeMs: world.mtimeMs, size: world.size, isDirectory: () => false}),
      onReadFile: () => world.content,
      onUnlink: (filePath) => { world.content = null; },
    });
    const release = await acquireFileLock(lockTarget, {timeoutMs: 2000, staleMs: 120000, fsImpl});
    const successor = lockContent({token: 'f'.repeat(32), createdAt: new Date().toISOString()});
    world.content = successor;
    world.size = Buffer.byteLength(successor, 'utf8');
    await release();
    assert.equal(world.content, successor, 'release must not delete a successor lock');
    assert.equal(
      fsImpl.calls.unlink.filter(p => p === lockPath).length,
      0,
      'release unlinks only while the path carries our owner token'
    );
  }

  // Release with an unreadable/foreign lock file: no unlink, no error.
  {
    const world = {content: 'foreign-garbage', mtimeMs: Date.now(), size: 15};
    let acquired = null;
    const fsImpl = makeLockFs({
      onOpen: (filePath, flags) => {
        acquired = recordingLockHandle(world);
        return acquired;
      },
      onStat: () => ({mtimeMs: world.mtimeMs, size: world.size, isDirectory: () => false}),
      onReadFile: () => world.content,
      onUnlink: (filePath) => { world.content = null; },
    });
    const release = await acquireFileLock(lockTarget, {timeoutMs: 2000, staleMs: 120000, fsImpl});
    world.content = 'replaced-by-foreign-content';
    await release();
    assert.ok(world.content !== null, 'release does not unlink an unrecognised lock file');
    assert.equal(
      fsImpl.calls.unlink.filter(p => p === lockPath).length,
      0,
      'release skips unlink when the lock cannot be proven as ours'
    );
  }

  // Release retry race: the first unlink hits a transient Windows sharing/AV
  // failure and, while we wait, a stale recovery replaces our lock with a
  // successor's file. The retry must not unlink the successor by path.
  {
    const world = {content: null, mtimeMs: Date.now(), size: 0};
    let unlinkCalls = 0;
    const fsImpl = makeLockFs({
      onOpen: (filePath, flags) => recordingLockHandle(world),
      onStat: () => ({mtimeMs: world.mtimeMs, size: world.size, isDirectory: () => false}),
      onReadFile: () => world.content,
      onUnlink: (filePath) => {
        if (filePath !== lockPath) return;
        unlinkCalls += 1;
        if (unlinkCalls === 1) {
          // First attempt fails transiently; while we sleep the path is
          // replaced with a fresh successor owner's lock.
          world.content = lockContent({token: 'e'.repeat(32), createdAt: new Date().toISOString()});
          world.size = Buffer.byteLength(world.content, 'utf8');
          throw lockError('EBUSY');
        }
        world.content = null;
      },
    });
    const release = await acquireFileLock(lockTarget, {timeoutMs: 2000, staleMs: 120000, fsImpl});
    await release();
    assert.equal(
      unlinkCalls,
      1,
      'release never retries unlink once the path no longer carries our owner token'
    );
    assert.ok(world.content !== null, 'successor lock survives the release retry loop');
    assert.ok(world.content.indexOf('e'.repeat(32)) >= 0, 'successor owner token is intact after release retry loop');
    assert.equal(
      fsImpl.calls.unlink.filter(p => p === lockPath).length,
      1,
      'exactly one unlink attempt happens before ownership is re-verified as lost'
    );
  }

  // Stale recovery race: a stale lock that is replaced by a fresh owner
  // between the two recovery observations is never unlinked.
  {
    const staleContent = lockContent({token: 'c'.repeat(32), createdAt: new Date(Date.now() - 600000).toISOString()});
    const freshContent = lockContent({token: 'd'.repeat(32), createdAt: new Date().toISOString()});
    let alternateReads = 0;
    const fsImpl = makeLockFs({
      onOpen: (filePath, flags) => { throw lockError('EEXIST'); },
      onStat: () => ({mtimeMs: Date.now() - 600000, size: Buffer.byteLength(staleContent, 'utf8'), isDirectory: () => false}),
      onReadFile: () => {
        alternateReads += 1;
        return alternateReads % 2 === 1 ? staleContent : freshContent;
      },
      onUnlink: () => {},
    });
    await assert.rejects(
      () => acquireFileLock(lockTarget, {timeoutMs: 400, staleMs: 10000, fsImpl}),
      error => error && error.code === 'LINK_OPS_JSON_LOCK_TIMEOUT',
      'stale recovery never deletes a lock that was replaced by a fresh owner'
    );
    assert.equal(
      fsImpl.calls.unlink.filter(p => p === lockPath).length,
      0,
      'no unlink runs against the replaced (new owner) lock'
    );
  }

  // An empty crash-left lock (crash between create and write) is reclaimed
  // after the stale window via mtime, then acquisition proceeds.
  {
    const world = {content: '', mtimeMs: Date.now() - 600000, size: 0};
    let tries = 0;
    const fsImpl = makeLockFs({
      onOpen: (filePath, flags) => {
        tries += 1;
        if (tries === 1) throw lockError('EEXIST');
        return recordingLockHandle(world);
      },
      onStat: () => ({mtimeMs: world.mtimeMs, size: world.size, isDirectory: () => false}),
      onReadFile: () => world.content,
      onUnlink: (filePath) => { world.content = null; },
    });
    const release = await acquireFileLock(lockTarget, {timeoutMs: 2000, staleMs: 10000, fsImpl});
    await release();
    assert.ok(tries >= 2, 'empty crash-left lock is reclaimed after staleness');
    assert.equal(world.content, null, 'stale recovery removed the empty lock and release removed the owned lock');
  }

  // Legacy lock records without an owner token are recovered when stale, so
  // pre-upgrade leftover locks do not block the repository forever.
  {
    const legacy = lockContent({createdAt: new Date(Date.now() - 600000).toISOString()});
    const world = {content: legacy, mtimeMs: Date.now() - 600000, size: Buffer.byteLength(legacy, 'utf8')};
    let tries = 0;
    const fsImpl = makeLockFs({
      onOpen: (filePath, flags) => {
        tries += 1;
        if (tries === 1) throw lockError('EEXIST');
        return recordingLockHandle(world);
      },
      onStat: () => ({mtimeMs: world.mtimeMs, size: world.size, isDirectory: () => false}),
      onReadFile: () => world.content,
      onUnlink: (filePath) => { world.content = null; },
    });
    const release = await acquireFileLock(lockTarget, {timeoutMs: 2000, staleMs: 10000, fsImpl});
    await release();
    assert.ok(tries >= 2, 'legacy stale locks are recovered');
    assert.equal(world.content, null, 'legacy lock is removed by recovery, owned lock by release');
  }

  // Foreign non-empty lock content (neither ours nor an empty crash artifact)
  // is never deleted even when the mtime is old: it fails closed with a
  // timeout instead of destroying an unknown file.
  {
    const fsImpl = makeLockFs({
      onOpen: (filePath, flags) => { throw lockError('EEXIST'); },
      onStat: () => ({mtimeMs: Date.now() - 600000, size: 22, isDirectory: () => false}),
      onReadFile: () => 'this is not a lock record',
      onUnlink: () => {},
    });
    await assert.rejects(
      () => acquireFileLock(lockTarget, {timeoutMs: 400, staleMs: 10000, fsImpl}),
      error => error && error.code === 'LINK_OPS_JSON_LOCK_TIMEOUT',
      'foreign non-empty lock content is never deleted by stale recovery'
    );
    assert.equal(fsImpl.calls.unlink.length, 0, 'unknown lock files are never unlinked');
  }

  // High-intensity real-fs regression: many repositories competing for the
  // same lock path under Promise.all must all commit and leave no debris.
  {
    const repositories = Array.from({length: 4}, () => createLinkOpsJsonRepository({rootDir: lockTestRoot}));
    const expected = new Set();
    for (let round = 0; round < 3; round += 1) {
      const batch = [];
      for (let i = 0; i < 4; i += 1) {
        const id = 'lock-race-r' + round + '-t' + i;
        expected.add(id);
        batch.push(repositories[i].createTask(
          {id, ownerUser: 'alice', status: 'open'},
          {idempotencyKey: id}
        ));
      }
      const created = await Promise.all(batch);
      assert.equal(new Set(created.map(row => row.id)).size, 4, 'every concurrent create commits');
    }
    const store = await repositories[0].getTaskStore({limit: 10000});
    const ids = new Set(store.tasks.map(row => row.id));
    for (const id of expected) assert.ok(ids.has(id), 'high-intensity concurrent create persists ' + id);
    const leftovers = (await fs.readdir(path.join(lockTestRoot, 'state')))
      .filter(name => name.endsWith('.lock') || name.indexOf('.bi-lock-probe-') >= 0);
    assert.deepEqual(leftovers, [], 'no lock or probe files leak after concurrent traffic');
  }

  console.log('link_ops_json_repository: Windows lock contention classification ok');
} finally {
  await fs.rm(lockTestRoot, {recursive: true, force: true});
}
