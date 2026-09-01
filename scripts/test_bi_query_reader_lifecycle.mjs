#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

import {
  __setFileHandleLifecycleHooks,
  loadBiOpsQueryData,
} from '../lib/bi_ops_query_context.mjs';
import {withBiSectionParseSlot} from '../lib/bi_section_cache.mjs';

const MiB = 1024 * 1024;
const GENERATED_AT = '2026-08-29T10:00:00.000+08:00';
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bi-query-reader-lifecycle-'));

async function writeLargeCore(file, payloadBytes = 20 * MiB) {
  const handle = await fs.open(file, 'w');
  try {
    await handle.write(Buffer.from(`{"generatedAt":${JSON.stringify(GENERATED_AT)},"payload":"`));
    const chunk = Buffer.alloc(256 * 1024, 0x78);
    let remaining = payloadBytes;
    while (remaining > 0) {
      const length = Math.min(remaining, chunk.length);
      await handle.write(chunk, 0, length);
      remaining -= length;
    }
    await handle.write(Buffer.from('"}'));
  } finally {
    await handle.close();
  }
}

function loadCore(file, options = {}) {
  return loadBiOpsQueryData({
    question: '只读取 core',
    dataPath: file,
    sections: [],
    maxCoreBytes: 24 * MiB,
    maxAggregateBytes: 24 * MiB,
    parseGateBytes: 16 * MiB,
    ...options,
  });
}

async function expectInvalidUtf8(file, bytes) {
  await fs.writeFile(file, bytes);
  await assert.rejects(
    loadCore(file, {maxCoreBytes: MiB, maxAggregateBytes: MiB, parseGateBytes: 1}),
    error => /\(invalid_utf8\)/u.test(String(error?.message || error)),
  );
}

async function within(promise, label) {
  return Promise.race([
    promise,
    delay(5000, undefined, {ref: false}).then(() => {
      throw new Error(`Timed out waiting for ${label}`);
    }),
  ]);
}

try {
  const largeFile = path.join(temp, 'large-core.json');
  await writeLargeCore(largeFile);

  // Hold the one large-reader slot. Eight queued 20 MiB readers are cancelled
  // while waiting; none may open/read a payload and aggregate RSS must remain
  // far below eight payload copies.
  let releaseHeld;
  let markHeldStarted;
  const heldGate = new Promise(resolve => { releaseHeld = resolve; });
  const heldStarted = new Promise(resolve => { markHeldStarted = resolve; });
  const held = withBiSectionParseSlot(async () => {
    markHeldStarted();
    await heldGate;
  });
  await heldStarted;

  // An initially small file does not wait for the occupied large-reader slot.
  // If that same file grows after fstat, payload I/O must still stop at the
  // opened size rather than following the new EOF into memory. The final
  // identity check then rejects the changed generation instead of returning
  // the old prefix as a complete result.
  const growthFile = path.join(temp, 'small-growth.json');
  const growthPayload = Buffer.from(JSON.stringify({generatedAt: GENERATED_AT, payload: 'small'}));
  await fs.writeFile(growthFile, growthPayload);
  const growthHandle = await fs.open(growthFile, 'r+');
  let growthReadBytes = -1;
  try {
    __setFileHandleLifecycleHooks({
      async onBeforePayloadRead({stat}) {
        assert.equal(Number(stat.size), growthPayload.length);
        await growthHandle.truncate(growthPayload.length + 20 * MiB);
      },
      onAfterPayloadRead({byteLength}) { growthReadBytes = byteLength; },
    });
    const growthOutcome = loadCore(growthFile).then(
      value => ({status: 'fulfilled', value}),
      error => ({status: 'rejected', error}),
    );
    const growthResult = await Promise.race([
      growthOutcome,
      delay(2_000).then(() => ({status: 'timeout'})),
    ]);
    assert.notEqual(growthResult.status, 'timeout',
      'an initially small reader must not wait for the occupied large-file slot');
    assert.equal(growthResult.status, 'rejected');
    assert.match(String(growthResult.error?.message || growthResult.error), /\(identity_changed\)/u);
    assert.equal(growthReadBytes, growthPayload.length,
      'payload I/O must stop at the opened fstat size instead of following a grown EOF');
    assert.equal(Number((await growthHandle.stat()).size), growthPayload.length + 20 * MiB);
  } finally {
    await growthHandle.close();
  }

  let queuedOpenHooks = 0;
  let queuedReadHooks = 0;
  __setFileHandleLifecycleHooks({
    onOpened() { queuedOpenHooks += 1; },
    onBeforePayloadRead() { queuedReadHooks += 1; },
  });
  const rssBefore = process.memoryUsage().rss;
  const controllers = Array.from({length: 8}, () => new AbortController());
  const queued = controllers.map(controller => loadCore(largeFile, {signal: controller.signal}));
  await delay(100);
  for (const controller of controllers) controller.abort();
  const queuedResults = await Promise.allSettled(queued);
  assert.equal(queuedResults.every(result => result.status === 'rejected' && result.reason?.name === 'AbortError'), true);
  assert.equal(queuedOpenHooks, 0, 'queued aborts must not enter the admitted open lifecycle');
  assert.equal(queuedReadHooks, 0, 'queued aborts must perform zero payload reads');
  const queuedRssDelta = Math.max(0, process.memoryUsage().rss - rssBefore);
  assert.ok(queuedRssDelta < 80 * MiB, `queued readers must keep RSS bounded, delta=${queuedRssDelta}`);
  releaseHeld();
  await held;

  // The large-reader slot remains owned after payload I/O, through strict
  // decode, JSON.parse, and the final pathname identity boundary. Hold the
  // first reader immediately before its final stat; a second large reader
  // must not even open until that boundary is released.
  let releaseFinalIdentity;
  let markFinalIdentityReached;
  const finalIdentityGate = new Promise(resolve => { releaseFinalIdentity = resolve; });
  const finalIdentityReached = new Promise(resolve => { markFinalIdentityReached = resolve; });
  let firstLifecycleHandle = null;
  let lifecycleOpens = 0;
  let lifecycleDecodes = 0;
  let lifecycleParses = 0;
  __setFileHandleLifecycleHooks({
    onOpened({handle, admitted}) {
      assert.equal(admitted, true);
      lifecycleOpens += 1;
      firstLifecycleHandle ||= handle;
    },
    onAfterDecode() { lifecycleDecodes += 1; },
    onAfterParse() { lifecycleParses += 1; },
    async onBeforeFinalPathStat({handle}) {
      if (handle !== firstLifecycleHandle) return;
      markFinalIdentityReached();
      await finalIdentityGate;
    },
  });
  const firstLifecycleRead = loadCore(largeFile);
  await within(finalIdentityReached, 'first reader final identity boundary');
  const secondLifecycleRead = loadCore(largeFile);
  await delay(100);
  assert.equal(lifecycleOpens, 1, 'second large reader must not open before the first final identity check');
  assert.equal(lifecycleDecodes, 1, 'first reader must complete strict UTF-8 decode while still admitted');
  assert.equal(lifecycleParses, 1, 'first reader must complete JSON.parse while still admitted');
  releaseFinalIdentity();
  const lifecycleResults = await Promise.all([firstLifecycleRead, secondLifecycleRead]);
  assert.equal(lifecycleResults.every(result => result.data.payload.length === 20 * MiB), true);
  assert.equal(lifecycleOpens, 2);
  assert.equal(lifecycleDecodes, 2);
  assert.equal(lifecycleParses, 2);

  // The path stat sees the small generation, then a normal atomic publication
  // replaces it immediately before open. The unadmitted handle must close with
  // zero payload reads and re-enter through the one large-reader slot.
  const publicationFile = path.join(temp, 'atomic-published-core.json');
  const publicationReady = path.join(temp, 'atomic-published-core.ready.json');
  await fs.writeFile(publicationFile, JSON.stringify({generatedAt: GENERATED_AT, payload: 'small'}));
  await writeLargeCore(publicationReady);

  let releasePublicationSlot;
  let markPublicationSlotStarted;
  const publicationSlotGate = new Promise(resolve => { releasePublicationSlot = resolve; });
  const publicationSlotStarted = new Promise(resolve => { markPublicationSlotStarted = resolve; });
  const publicationSlot = withBiSectionParseSlot(async () => {
    markPublicationSlotStarted();
    await publicationSlotGate;
  });
  await publicationSlotStarted;

  let publicationPromise = null;
  let publicationCompleted = false;
  let speculativeCloses = 0;
  let markSpeculativeClose;
  const speculativeClose = new Promise(resolve => { markSpeculativeClose = resolve; });
  let publicationPayloadReads = 0;
  let activeAdmittedHandles = 0;
  let maxActiveAdmittedHandles = 0;
  __setFileHandleLifecycleHooks({
    async onBeforeOpen({file, admitted}) {
      if (file !== publicationFile || admitted) return;
      publicationPromise ||= fs.rename(publicationReady, publicationFile).then(() => {
        publicationCompleted = true;
      });
      await publicationPromise;
    },
    onOpened({file, admitted}) {
      if (file !== publicationFile || !admitted) return;
      activeAdmittedHandles += 1;
      maxActiveAdmittedHandles = Math.max(maxActiveAdmittedHandles, activeAdmittedHandles);
    },
    onBeforePayloadRead({file, stat, admitted}) {
      if (file !== publicationFile) return;
      assert.equal(admitted, true, 'published large payload must only be read while admitted');
      assert.ok(Number(stat.size) >= 16 * MiB, 'published generation must cross the parse gate');
      publicationPayloadReads += 1;
    },
    onClosed({file, admitted}) {
      if (file !== publicationFile) return;
      if (admitted) activeAdmittedHandles -= 1;
      else {
        speculativeCloses += 1;
        markSpeculativeClose();
      }
    },
  });
  let publicationReadsSettled = 0;
  const publicationReads = Array.from({length: 2}, () => loadCore(publicationFile).finally(() => {
    publicationReadsSettled += 1;
  }));
  try {
    await within(speculativeClose, 'the unadmitted publication handle to close');
    assert.equal(publicationCompleted, true, 'the path-stat/open race must publish the large generation');
    assert.ok(speculativeCloses >= 1, 'at least one small-classified request must close and requeue');
    assert.equal(publicationPayloadReads, 0, 'requeued requests must read zero payload bytes while the slot is held');
    assert.equal(publicationReadsSettled, 0, 'requeued requests must remain pending behind the held slot');
  } finally {
    releasePublicationSlot();
    await publicationSlot;
  }
  const publicationResults = await Promise.all(publicationReads);
  assert.equal(publicationResults.every(result => result.data.payload.length === 20 * MiB), true);
  assert.equal(publicationPayloadReads, publicationReads.length);
  assert.equal(maxActiveAdmittedHandles, 1, 'atomic publication readers must not expand concurrent large handles');
  assert.equal(activeAdmittedHandles, 0, 'all admitted publication handles must close');

  // Active cancellation closes the exact opened handle. The test lands abort
  // immediately before payload I/O and observes EBADF after the lifecycle.
  const activeController = new AbortController();
  let activeHandle = null;
  let closedHooks = 0;
  __setFileHandleLifecycleHooks({
    onOpened({handle}) { activeHandle = handle; },
    onBeforePayloadRead() { activeController.abort(); },
    onClosed() { closedHooks += 1; },
  });
  await assert.rejects(loadCore(largeFile, {signal: activeController.signal}), error => error?.name === 'AbortError');
  assert.ok(activeHandle, 'active reader must have opened one handle');
  await assert.rejects(activeHandle.stat(), error => error?.code === 'EBADF');
  assert.equal(closedHooks, 1, 'active abort must complete exactly one handle close lifecycle');

  // A same-length atomic replacement after the opened handle has been parsed
  // must fail the final pathname identity check instead of returning old data.
  const swapFile = path.join(temp, 'swap.json');
  const oldGeneration = '2026-08-29T10:01:00.000+08:00';
  const newGeneration = '2026-08-29T10:02:00.000+08:00';
  const oldPayload = Buffer.from(JSON.stringify({generatedAt: oldGeneration, payload: 'a'.repeat(8192)}));
  const newPayload = Buffer.from(JSON.stringify({generatedAt: newGeneration, payload: 'b'.repeat(8192)}));
  assert.equal(newPayload.length, oldPayload.length);
  await fs.writeFile(swapFile, oldPayload);
  const replacementFile = path.join(temp, 'swap-replacement.json');
  const openedOldFile = path.join(temp, 'swap-opened-old.json');
  await fs.writeFile(replacementFile, newPayload);
  let swapped = false;
  __setFileHandleLifecycleHooks({
    async onAfterPayloadRead({file}) {
      if (file !== swapFile || swapped) return;
      swapped = true;
      await fs.rename(swapFile, openedOldFile);
      await fs.rename(replacementFile, swapFile);
    },
  });
  await assert.rejects(
    loadCore(swapFile, {maxCoreBytes: MiB, maxAggregateBytes: MiB, parseGateBytes: MiB}),
    error => /\(identity_changed\)/u.test(String(error?.message || error)),
  );
  assert.equal(swapped, true);

  // Even after the per-file lifecycle succeeds, a replacement during result
  // assembly is rejected by the query-terminal identity readback.
  const lateSwapFile = path.join(temp, 'late-swap.json');
  const lateSwapReplacement = path.join(temp, 'late-swap-replacement.json');
  const lateSwapOpenedOld = path.join(temp, 'late-swap-opened-old.json');
  await fs.writeFile(lateSwapFile, oldPayload);
  await fs.writeFile(lateSwapReplacement, newPayload);
  let lateSwapped = false;
  __setFileHandleLifecycleHooks({
    async onBeforeQueryFinalReadback() {
      if (lateSwapped) return;
      lateSwapped = true;
      await fs.rename(lateSwapFile, lateSwapOpenedOld);
      await fs.rename(lateSwapReplacement, lateSwapFile);
    },
  });
  await assert.rejects(
    loadCore(lateSwapFile, {maxCoreBytes: MiB, maxAggregateBytes: MiB, parseGateBytes: MiB}),
    error => error?.code === 'BI_QUERY_IDENTITY_CHANGED',
  );
  assert.equal(lateSwapped, true);

  // Fatal TextDecoder semantics reject each invalid UTF-8 class before
  // JSON.parse; a valid multi-byte payload remains accepted.
  const invalidFile = path.join(temp, 'invalid-utf8.json');
  const prefix = Buffer.from(`{"generatedAt":${JSON.stringify(GENERATED_AT)},"payload":"`);
  const suffix = Buffer.from('"}');
  await expectInvalidUtf8(invalidFile, Buffer.concat([prefix, Buffer.from([0xf0, 0x9f, 0x92])]));
  await expectInvalidUtf8(invalidFile, Buffer.concat([prefix, Buffer.from([0xc0, 0xaf]), suffix]));
  await expectInvalidUtf8(invalidFile, Buffer.concat([prefix, Buffer.from([0xed, 0xa0, 0x80]), suffix]));
  await expectInvalidUtf8(invalidFile, Buffer.concat([prefix, Buffer.from([0xe2, 0x28, 0xa1]), suffix]));
  const validSameLength = Buffer.concat([prefix, Buffer.from('€', 'utf8'), suffix]);
  const invalidSameLength = Buffer.concat([prefix, Buffer.from([0xe2, 0x28, 0xa1]), suffix]);
  assert.equal(invalidSameLength.length, validSameLength.length, 'UTF-8 adversary must preserve exact pathname byte size');
  await expectInvalidUtf8(invalidFile, invalidSameLength);
  await fs.writeFile(invalidFile, Buffer.concat([prefix, Buffer.from('中文😀', 'utf8'), suffix]));
  const valid = await loadCore(invalidFile, {maxCoreBytes: MiB, maxAggregateBytes: MiB, parseGateBytes: 1});
  assert.equal(valid.data.payload, '中文😀');

  console.log(JSON.stringify({
    ok: true,
    tests: 14,
    growthInitialBytes: growthPayload.length,
    growthReadBytes,
    queuedReaders: controllers.length,
    queuedOpenHooks,
    queuedReadHooks,
    queuedRssDelta,
    publicationReaders: publicationReads.length,
    speculativeCloses,
    maxActiveAdmittedHandles,
  }));
} finally {
  __setFileHandleLifecycleHooks(null);
  await fs.rm(temp, {recursive: true, force: true});
}
