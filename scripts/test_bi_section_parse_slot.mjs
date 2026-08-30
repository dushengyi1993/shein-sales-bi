#!/usr/bin/env node

import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';

import {withBiSectionParseSlot} from '../lib/bi_section_cache.mjs';

const unhandled = [];
const onUnhandledRejection = reason => unhandled.push(reason);
process.on('unhandledRejection', onUnhandledRejection);

try {
  let active = 0;
  let maxActive = 0;
  let releaseFirst;
  let markFirstStarted;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const firstStarted = new Promise(resolve => { markFirstStarted = resolve; });

  const first = withBiSectionParseSlot(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    markFirstStarted();
    await firstGate;
    active -= 1;
    return 'first';
  });
  const second = withBiSectionParseSlot(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    active -= 1;
    return 'second';
  });
  await firstStarted;
  assert.equal(active, 1);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  assert.equal(maxActive, 1, 'heap-heavy parses must run serially');

  // A queued cancellation rejects promptly, never invokes work, and still
  // releases its reserved queue position after the predecessor settles.
  let releaseHeld;
  let markHeldStarted;
  const heldGate = new Promise(resolve => { releaseHeld = resolve; });
  const heldStarted = new Promise(resolve => { markHeldStarted = resolve; });
  const held = withBiSectionParseSlot(async () => {
    markHeldStarted();
    await heldGate;
  });
  await heldStarted;
  const queuedController = new AbortController();
  let queuedWorkStarted = false;
  const queuedAbort = withBiSectionParseSlot(async () => {
    queuedWorkStarted = true;
  }, {signal: queuedController.signal});
  queuedController.abort();
  await assert.rejects(queuedAbort, error => error?.name === 'AbortError' && error?.code === 'ABORT_ERR');
  releaseHeld();
  await held;
  assert.equal(queuedWorkStarted, false, 'aborted queued parse must never invoke work');
  assert.equal(await withBiSectionParseSlot(async () => 'after-queued-abort'), 'after-queued-abort');

  // Once work is active, the slot cannot be abandoned. Abort is observed at
  // the parse boundary, after work settles, so no second heap-heavy parse can
  // overlap it.
  const activeController = new AbortController();
  let releaseActive;
  let markActiveStarted;
  let activeWorkCompleted = false;
  const activeGate = new Promise(resolve => { releaseActive = resolve; });
  const activeStarted = new Promise(resolve => { markActiveStarted = resolve; });
  const activeAbort = withBiSectionParseSlot(async () => {
    markActiveStarted();
    await activeGate;
    activeWorkCompleted = true;
    return 'must-be-discarded';
  }, {signal: activeController.signal});
  await activeStarted;
  let activeSettled = false;
  activeAbort.then(
    () => { activeSettled = true; },
    () => { activeSettled = true; },
  );
  activeController.abort();
  await nextTurn();
  assert.equal(activeSettled, false, 'active abort must retain the slot until work reaches its boundary');
  releaseActive();
  await assert.rejects(activeAbort, error => error?.name === 'AbortError' && error?.code === 'ABORT_ERR');
  assert.equal(activeWorkCompleted, true);

  // Aborting after completion must be inert because the listener is removed.
  const completedController = new AbortController();
  assert.equal(await withBiSectionParseSlot(async () => 'completed', {
    signal: completedController.signal,
  }), 'completed');
  completedController.abort();
  await nextTurn();
  assert.equal(await withBiSectionParseSlot(async () => 'after-completed-abort'), 'after-completed-abort');

  const preAbortedController = new AbortController();
  preAbortedController.abort();
  let preAbortedWorkStarted = false;
  await assert.rejects(withBiSectionParseSlot(async () => {
    preAbortedWorkStarted = true;
  }, {signal: preAbortedController.signal}), error => error?.name === 'AbortError' && error?.code === 'ABORT_ERR');
  assert.equal(preAbortedWorkStarted, false);

  await assert.rejects(withBiSectionParseSlot(async () => {
    throw new SyntaxError('broken json');
  }), SyntaxError);
  assert.equal(await withBiSectionParseSlot(async () => 'released'), 'released', 'failed parse must release the global slot');

  // queuedRun finishes after the caller-facing queued abort. Give Node two
  // turns to emit any latent unhandledRejection before asserting the debt is
  // closed.
  await nextTurn();
  await nextTurn();
  assert.deepEqual(unhandled, [], 'all internal queue and abort rejections must be observed');
  console.log(JSON.stringify({ok: true, tests: 9}));
} finally {
  process.off('unhandledRejection', onUnhandledRejection);
}
