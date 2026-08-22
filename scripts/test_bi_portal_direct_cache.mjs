#!/usr/bin/env node
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import {Buffer} from 'node:buffer';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {publishDirectPortalSection, buildProfitQueryProjection, compactHomeRankingsSectionData} from './generate_bi_portal.mjs';
import {
  publishBiProfitBundleManifest,
  readBiSectionArtifactCache,
  readBiSectionCache,
  writeBiSectionArtifact,
  writeBiSectionCache,
} from '../lib/bi_section_cache.mjs';
import {loadBiOpsQueryData} from '../lib/bi_ops_query_context.mjs';
import {__testHooks as serveHooks} from './serve_bi_portal.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GENERATION = '2026-07-11T08:00:00.000+08:00';
const RUN = {code: 0, timedOut: false, stderr: ''};
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-bi-direct-cache-'));

function queryArtifactMeta() {
  return {
    kind: 'profit-query-compact-v1',
    logicalSection: 'profit',
    sourceArtifact: 'profit',
    sourceGeneratedAt: GENERATION,
    retainedPaths: [
      'profit.dailyStoreProducts',
      'profit.monthGroups',
      'profit.products',
      'profit.storeStorageDaily',
    ],
    omittedPaths: [
      'profit.productStorageDaily',
      'profit.productStoreStorageDaily',
    ],
  };
}

function coreData(corePad = '') {
  return {
    generatedAt: GENERATION,
    dates: {salesDate: '2026-07-11'},
    __sections: {mode: 'api', generatedAt: GENERATION, keys: ['profit']},
    ...(corePad ? {corePad} : {}),
  };
}

async function makeFixture(name, withCore = true, {corePad = ''} = {}) {
  const root = path.join(tempRoot, name);
  await fs.mkdir(path.join(root, 'sections'), {recursive: true});
  if (withCore) await fs.writeFile(path.join(root, 'data.json'), JSON.stringify(coreData(corePad)), 'utf8');
  return {root, sectionsDir: path.join(root, 'sections'), dataPath: path.join(root, 'data.json')};
}

try {
  const fullData = {
    profit: {
      dailyStoreProducts: [{date: '2026-07-11', store_key: 'HL', group_key: 'GROUP-1', standard_goods_sn: 'TEST-01', net_revenue_sar: 10, quantity: 1}],
      monthGroups: [{month: '2026-07'}],
      products: [{standard_goods_sn: 'TEST-01', net_revenue_sar: 10}],
      productStorageDaily: [{date: '2026-07-11', standard_goods_sn: 'TEST-01', storage_fee_sar: 1}],
      productStoreStorageDaily: [{date: '2026-07-11', store_key: 'HL', standard_goods_sn: 'TEST-01', storage_fee_sar: 1}],
      storeStorageDaily: [{date: '2026-07-11', store_key: 'HL', group_key: 'GROUP-1', storage_fee_sar: 1, storage_fee_status: 'settled'}],
    },
  };
  const fixture = await makeFixture('direct');
  const receipt = await publishDirectPortalSection({
    section: 'profit',
    generatedAt: GENERATION,
    outDir: fixture.root,
  }, fullData);
  const receiptText = JSON.stringify(receipt);
  assert.ok(Buffer.byteLength(receiptText, 'utf8') < serveHooks.BI_DIRECT_RECEIPT_MAX_BYTES, 'direct receipt must stay bounded');
  assert.equal(receiptText.includes('productStorageDaily'), false, 'receipt must not contain section data');
  assert.equal(receiptText.includes('"data"'), false, 'receipt must not contain a data field');
  assert.deepEqual(receipt.artifacts.map(item => item.artifact), ['profit', 'profit.query', 'homeProfit']);
  await serveHooks.verifyDirectCacheReceipt(fixture.root, receipt, 'profit', GENERATION);

  const fullCache = await readBiSectionCache(fixture.root, 'profit', GENERATION);
  assert.deepEqual(Object.keys(fullCache.data.profit).sort(), [
    'dailyStoreProducts',
    'monthGroups',
    'products',
    'productStorageDaily',
    'productStoreStorageDaily',
    'storeStorageDaily',
  ].sort(), 'full Portal profit cache must remain complete');
  const queryCache = await readBiSectionArtifactCache(fixture.root, 'profit.query', 'profit.query', GENERATION, {requireIntegrity: true});
  assert.deepEqual(Object.keys(queryCache.data.profit).sort(), [
    'dailyStoreProducts',
    'monthGroups',
    'products',
    'storeStorageDaily',
  ].sort(), 'compact query projection may omit only the two named arrays');
  assert.deepEqual(queryCache.data.profit.dailyStoreProducts, fullCache.data.profit.dailyStoreProducts);
  assert.deepEqual(queryCache.data.profit.monthGroups, fullCache.data.profit.monthGroups);
  assert.deepEqual(queryCache.data.profit.products, fullCache.data.profit.products);
  assert.deepEqual(queryCache.data.profit.storeStorageDaily, fullCache.data.profit.storeStorageDaily);
  const bundleFile = path.join(fixture.sectionsDir, 'profit.bundle.json');
  const bundleBytes = await fs.readFile(bundleFile);
  await fs.rm(bundleFile);
  assert.equal(await readBiSectionCache(fixture.root, 'profit', GENERATION), null, 'a crash before the final manifest must hide the full profit artifact');
  assert.equal(await readBiSectionArtifactCache(fixture.root, 'profit.query', 'profit.query', GENERATION, {requireIntegrity: true}), null, 'a crash before the final manifest must hide compact profit');
  await assert.rejects(
    () => serveHooks.verifyDirectCacheReceipt(fixture.root, receipt, 'profit', GENERATION),
    /profit bundle manifest readback mismatch/,
    'receipt verification must fail closed without the commit marker',
  );
  await fs.writeFile(bundleFile, bundleBytes);
  assert.ok(await readBiSectionCache(fixture.root, 'profit', GENERATION), 'restoring the exact marker must restore the exact bundle');
  assert.throws(
    () => serveHooks.parseDirectCacheReceipt(receiptText, 'profit', 'wrong-generation'),
    /identity mismatch|requires section and generatedAt/,
    'receipt generation identity is required',
  );
  const badReceipt = JSON.parse(receiptText);
  badReceipt.artifacts[0].raw.sha256 = '0'.repeat(64);
  await assert.rejects(
    () => serveHooks.verifyDirectCacheReceipt(fixture.root, badReceipt, 'profit', GENERATION),
    /integrity readback mismatch|source binding mismatch/,
    'raw integrity mismatch must fail closed',
  );

  const compactRanking = compactHomeRankingsSectionData({rankings: {
    dailyProducts: [{id: 1, goods_title: 'hidden', skc_list: ['hidden'], product_display_name: 'hidden', product_display_name_source: 'hidden', keep: true}],
    dailyStoreProducts: [{id: 2, goods_title: 'hidden', skc_list: ['hidden'], product_display_name: 'hidden', product_display_name_source: 'hidden', keep: true}],
  }});
  assert.deepEqual(compactRanking.rankings.dailyProducts, [{id: 1, goods_title: 'hidden', skc_list: ['hidden'], product_display_name: 'hidden', keep: true}]);
  assert.deepEqual(compactRanking.rankings.dailyStoreProducts, [{id: 2, goods_title: 'hidden', skc_list: ['hidden'], product_display_name: 'hidden', keep: true}]);
  const filterByRetainedFields = (rows, query) => rows.filter(row => [
    row.goods_title,
    ...(Array.isArray(row.skc_list) ? row.skc_list : [row.skc_list]),
    row.product_display_name,
  ].some(value => String(value || '').toLowerCase().includes(query.toLowerCase()))).map(row => row.id);
  const filterRows = [
    {id: 11, goods_title: 'Alpha goods', skc_list: ['A-11'], product_display_name: 'Alpha display', quantity: 4},
    {id: 12, goods_title: 'Beta goods', skc_list: ['B-12'], product_display_name: undefined, quantity: undefined},
  ];
  const compactRows = compactHomeRankingsSectionData({rankings: {dailyProducts: filterRows}}).rankings.dailyProducts;
  for (const query of ['alpha goods', 'B-12', 'alpha display']) {
    assert.deepEqual(filterByRetainedFields(compactRows, query), filterByRetainedFields(filterRows, query), `homeRankings filter must remain equivalent for ${query}`);
  }
  assert.equal(compactRows.find(row => row.id === 12).quantity, undefined, 'unavailable fields must not be coerced to zero');
  const projectionInput = JSON.parse(JSON.stringify(fullData));
  const projection = buildProfitQueryProjection(projectionInput);
  assert.equal(Object.hasOwn(projectionInput.profit, 'productStorageDaily'), true, 'projection must not mutate full profit data');
  assert.equal(Object.hasOwn(projection.profit, 'productStorageDaily'), false);
  assert.equal(Object.hasOwn(projection.profit, 'productStoreStorageDaily'), false);

  const overflowTerminationCauses = [];
  const overflow = await serveHooks.runChildProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(100000))"], {
    timeoutMs: 10_000,
    maxStdoutBytes: 1024,
    maxStderrBytes: 1024,
    failOnOutputOverflow: true,
    killGraceMs: 50,
    settleGraceMs: 100,
    onTerminationRequested: cause => overflowTerminationCauses.push(cause),
  });
  assert.equal(overflow.ok, false);
  assert.equal(overflow.outputOverflow, true, 'receipt stdout overflow must fail closed');
  assert.equal(overflow.overflowStream, 'stdout');
  assert.ok(Buffer.byteLength(overflow.stdout, 'utf8') <= 1024);
  assert.deepEqual(overflowTerminationCauses, ['output-overflow'], 'output overflow must invoke the termination hook exactly once');
  let successfulTerminationHooks = 0;
  const uncapped = await serveHooks.runChildProcess(process.execPath, ['-e', "process.stdout.write('y'.repeat(4096))"], {
    timeoutMs: 10_000,
    onTerminationRequested: () => { successfulTerminationHooks += 1; },
  });
  assert.equal(uncapped.ok, true);
  assert.equal(uncapped.stdout.length, 4096, 'existing callers remain uncapped by default');
  assert.equal(successfulTerminationHooks, 0, 'normal success must not invoke the termination hook');

  // BI refresh/generator trees opt into an owned Unix process group. The
  // injected group killer makes both escalation signals observable without
  // requiring a real database or relying on a platform-specific process list.
  const fakeChild = pid => {
    const child = new EventEmitter();
    child.pid = pid;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killSignals = [];
    child.kill = signal => child.killSignals.push(signal);
    child.unref = () => {};
    return child;
  };
  let unixSpawnOptions = null;
  const unixGroupSignals = [];
  const unixTerminationOrder = [];
  const unixChild = fakeChild(43210);
  const unixGroupRun = await serveHooks.runChildProcess('fake-bi-tree', [], {
    timeoutMs: 20,
    killGraceMs: 20,
    settleGraceMs: 20,
    processGroup: true,
    platform: 'linux',
    spawnImpl: (_command, _args, options) => {
      unixSpawnOptions = options;
      return unixChild;
    },
    onTerminationRequested: cause => unixTerminationOrder.push(`hook:${cause}`),
    killProcessGroupImpl: (pid, signal) => {
      unixGroupSignals.push([pid, signal]);
      unixTerminationOrder.push(`group:${signal}`);
    },
  });
  assert.equal(unixSpawnOptions.detached, true, 'Unix BI tree must be spawned as its own process group');
  assert.deepEqual(unixGroupSignals, [[43210, 'SIGTERM'], [43210, 'SIGKILL']], 'Unix escalation must target the owned process group');
  assert.deepEqual(unixChild.killSignals, [], 'Unix group termination must not fall back when group kill succeeds');
  assert.equal(unixGroupRun.timedOut, true);
  assert.deepEqual(unixTerminationOrder, ['hook:timeout', 'group:SIGTERM', 'group:SIGKILL'], 'timeout hook must run immediately and exactly once before process cleanup');

  // The group leader can close on SIGTERM while descendants remain alive.
  // Its close event must not clear the scheduled process-group SIGKILL.
  const leaderCloseSignals = [];
  const leaderCloseChild = fakeChild(65432);
  const leaderCloseRun = await serveHooks.runChildProcess('fake-bi-tree', [], {
    timeoutMs: 20,
    killGraceMs: 20,
    settleGraceMs: 20,
    processGroup: true,
    platform: 'linux',
    spawnImpl: () => leaderCloseChild,
    killProcessGroupImpl: (pid, signal) => {
      leaderCloseSignals.push([pid, signal]);
      if (signal === 'SIGTERM') queueMicrotask(() => leaderCloseChild.emit('close', 0, ''));
    },
  });
  assert.deepEqual(leaderCloseSignals, [[65432, 'SIGTERM'], [65432, 'SIGKILL']], 'leader close must not suppress group SIGKILL');
  assert.equal(leaderCloseRun.ok, false, 'a timed-out process group must remain non-success');
  assert.equal(leaderCloseRun.timedOut, true);

  let windowsSpawnOptions = null;
  const windowsGroupSignals = [];
  const windowsChild = fakeChild(54321);
  const windowsGroupRun = await serveHooks.runChildProcess('fake-bi-tree', [], {
    timeoutMs: 20,
    killGraceMs: 20,
    settleGraceMs: 20,
    processGroup: true,
    platform: 'win32',
    spawnImpl: (_command, _args, options) => {
      windowsSpawnOptions = options;
      return windowsChild;
    },
    killProcessGroupImpl: (pid, signal) => windowsGroupSignals.push([pid, signal]),
  });
  assert.equal(windowsSpawnOptions.detached, undefined, 'Windows must retain direct-child spawn fallback');
  assert.deepEqual(windowsGroupSignals, [], 'Windows must not call Unix process-group kill');
  assert.deepEqual(windowsChild.killSignals, ['SIGTERM', 'SIGKILL'], 'Windows fallback must terminate the direct child');
  assert.equal(windowsGroupRun.timedOut, true);

  // An owned disconnect must stop the child tree before its delayed atomic
  // publication callback can run. This is the regression for the observed
  // curl-timeout -> late section artifact split.
  const lateArtifact = path.join(tempRoot, 'aborted-owned-generation.json');
  const lateArtifactTemp = `${lateArtifact}.tmp`;
  const ownedAbort = new AbortController();
  const abortTerminationCauses = [];
  const delayedPublicationCode = [
    "const fs=require('node:fs');",
    `setTimeout(()=>{fs.writeFileSync(${JSON.stringify(lateArtifactTemp)},'late');fs.renameSync(${JSON.stringify(lateArtifactTemp)},${JSON.stringify(lateArtifact)});},250);`,
  ].join('');
  const delayedGeneration = serveHooks.runChildProcess(process.execPath, ['-e', delayedPublicationCode], {
    timeoutMs: 5_000,
    killGraceMs: 50,
    settleGraceMs: 50,
    signal: ownedAbort.signal,
    processGroup: true,
    onTerminationRequested: cause => abortTerminationCauses.push(cause),
  });
  setTimeout(() => ownedAbort.abort(new Error('test request disconnected')), 25);
  const delayedResult = await delayedGeneration;
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(delayedResult.aborted, true, 'owned request cancellation must reach the generator child');
  assert.deepEqual(abortTerminationCauses, ['abort'], 'AbortSignal must invoke the termination hook exactly once');
  await assert.rejects(fs.access(lateArtifact), error => error?.code === 'ENOENT', 'aborted generation must not publish a late artifact');
  await assert.rejects(fs.access(lateArtifactTemp), error => error?.code === 'ENOENT', 'aborted generation must clean up its unpublished temporary artifact');

  const dbApplicationNames = new Set();
  for (let index = 0; index < 32; index += 1) {
    const name = serveHooks.createBiDbApplicationName('productSalesDaily');
    assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,62}$/);
    assert.ok(Buffer.byteLength(name, 'utf8') <= 63);
    dbApplicationNames.add(name);
  }
  assert.equal(dbApplicationNames.size, 32, 'owned producer database application names must be unique');
  assert.throws(() => serveHooks.validateBiDbApplicationName("unsafe'name", {required: true}), /application_name/);
  assert.throws(() => serveHooks.validateBiDbApplicationName(`x${'a'.repeat(63)}`, {required: true}), /application_name/);
  const cancelRunBase = {ok: true, code: 0, timedOut: false, stdout: '', stderr: ''};
  assert.equal(serveHooks.evaluateBiDbCancellationRun({
    ...cancelRunBase,
    stdout: 'SHEIN_BI_DB_CANCEL_REMAINING=0\n',
  }).ok, true, 'exact zero remaining marker must prove backend cancellation');
  const remainingCancelRun = serveHooks.evaluateBiDbCancellationRun({
    ...cancelRunBase,
    stdout: 'SHEIN_BI_DB_CANCEL_REMAINING=1\n',
  });
  assert.equal(remainingCancelRun.ok, false, 'a nonzero remaining backend count must fail cancellation');
  assert.equal(remainingCancelRun.remainingBackendCount, 1);
  assert.equal(serveHooks.evaluateBiDbCancellationRun(cancelRunBase).ok, false, 'a missing remaining marker must fail cancellation');
  assert.equal(serveHooks.evaluateBiDbCancellationRun({
    ...cancelRunBase,
    ok: false,
    timedOut: true,
    stdout: 'SHEIN_BI_DB_CANCEL_REMAINING=0\n',
  }).ok, false, 'a timed-out cancellation command must fail even if stdout contains a zero marker');

  // A DB-bound child may close before PostgreSQL acknowledges cancellation.
  // The wrapper must await immediate cancellation, then run and await one
  // final reconciliation after host-child settlement.
  const wrapperApplicationName = serveHooks.createBiDbApplicationName('profit');
  const wrapperOrder = [];
  const wrapperChild = fakeChild(76543);
  let releaseImmediateCancellation = null;
  let releaseFinalCancellation = null;
  let wrapperSettled = false;
  let leaderClosedResolve = null;
  const leaderClosed = new Promise(resolve => { leaderClosedResolve = resolve; });
  let finalCancellationStartedResolve = null;
  const finalCancellationStarted = new Promise(resolve => { finalCancellationStartedResolve = resolve; });
  wrapperChild.once('close', () => wrapperOrder.push('host:close'));
  wrapperChild.kill = signal => {
    wrapperOrder.push(`child:${signal}`);
    leaderClosedResolve();
    queueMicrotask(() => wrapperChild.emit('close', null, signal));
  };
  const wrapperRunPromise = serveHooks.runBiDbChildProcess({
    distro: 'test', container: 'db', database: 'warehouse', user: 'tester',
  }, 'fake-db-tree', [], {
    timeoutMs: 20,
    dbApplicationName: wrapperApplicationName,
    spawnImpl: () => wrapperChild,
    cancelBackendsImpl: (_args, applicationName, details) => {
      wrapperOrder.push(`cancel:${details.phase}:${details.cause}`);
      assert.equal(applicationName, wrapperApplicationName);
      if (details.phase === 'immediate') {
        return new Promise(resolve => { releaseImmediateCancellation = resolve; });
      }
      finalCancellationStartedResolve();
      return new Promise(resolve => { releaseFinalCancellation = resolve; });
    },
  }).then(result => {
    wrapperSettled = true;
    return result;
  });
  await leaderClosed;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(wrapperOrder.slice(0, 2), ['cancel:immediate:timeout', 'child:SIGTERM'], 'immediate backend cancellation must start before host child termination');
  assert.equal(wrapperSettled, false, 'DB wrapper must wait for immediate backend cancellation');
  releaseImmediateCancellation({ok: true, remainingBackendCount: 0});
  await finalCancellationStarted;
  assert.equal(wrapperOrder.at(-1), 'cancel:final:timeout', 'final reconciliation must start only after immediate cancellation and host settlement');
  assert.ok(wrapperOrder.indexOf('host:close') < wrapperOrder.indexOf('cancel:final:timeout'), 'final reconciliation must occur after host child close');
  assert.equal(wrapperSettled, false, 'DB wrapper must wait for final backend reconciliation');
  releaseFinalCancellation({ok: true, remainingBackendCount: 0});
  const wrapperRun = await wrapperRunPromise;
  assert.equal(wrapperRun.ok, false);
  assert.equal(wrapperRun.timedOut, true);
  assert.equal(wrapperOrder.filter(value => value.startsWith('cancel:')).length, 2, 'terminated DB runs must perform exactly immediate and final cancellation');

  const finalFailurePhases = [];
  const finalFailureChild = fakeChild(76544);
  finalFailureChild.kill = signal => queueMicrotask(() => finalFailureChild.emit('close', null, signal));
  const originalConsoleError = console.error;
  const cancellationErrors = [];
  console.error = value => { cancellationErrors.push(String(value)); };
  let finalFailureRun;
  try {
    finalFailureRun = await serveHooks.runBiDbChildProcess({
      distro: 'test', container: 'db', database: 'warehouse', user: 'tester',
    }, 'fake-db-tree', [], {
      timeoutMs: 20,
      dbApplicationName: serveHooks.createBiDbApplicationName('profit'),
      spawnImpl: () => finalFailureChild,
      cancelBackendsImpl: (_args, _applicationName, details) => {
        finalFailurePhases.push(details.phase);
        return Promise.resolve(serveHooks.evaluateBiDbCancellationRun({
          ...cancelRunBase,
          stdout: `SHEIN_BI_DB_CANCEL_REMAINING=${details.phase === 'final' ? 1 : 0}\n`,
        }));
      },
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert.deepEqual(finalFailurePhases, ['immediate', 'final']);
  assert.equal(finalFailureRun.ok, false, 'a nonzero final reconciliation must keep the terminated DB run failed');
  assert.match(finalFailureRun.stderr, /final: PostgreSQL cancellation left exact application_name backends remaining=1/);
  assert.ok(cancellationErrors.some(value => value.includes('bi-db-backend-cancel-failed')), 'final reconciliation failure must be logged');

  let normalDbCancellationCalls = 0;
  const normalDbChild = fakeChild(87654);
  const normalDbRun = await serveHooks.runBiDbChildProcess({
    distro: 'test', container: 'db', database: 'warehouse', user: 'tester',
  }, 'fake-db-tree', [], {
    timeoutMs: 1_000,
    dbApplicationName: serveHooks.createBiDbApplicationName('rankings'),
    spawnImpl: () => {
      queueMicrotask(() => normalDbChild.emit('close', 0, ''));
      return normalDbChild;
    },
    cancelBackendsImpl: () => {
      normalDbCancellationCalls += 1;
      return Promise.resolve({ok: true});
    },
  });
  assert.equal(normalDbRun.ok, true);
  assert.equal(normalDbCancellationCalls, 0, 'normal DB child success must not start backend cancellation');

  // The first caller owns the signal passed to a shared producer. A later
  // ordinary reader may join the same Promise, but its disconnect cannot
  // abort that producer or create a second generation.
  const sharedKey = `direct-cache-test-${Date.now()}-${Math.random()}`;
  const ownerController = new AbortController();
  const ordinaryController = new AbortController();
  let sharedCalls = 0;
  let sharedOwnerSignal = null;
  let releaseShared = null;
  const sharedFirst = serveHooks.getOrCreateBiSectionInFlight(sharedKey, signal => {
    sharedCalls += 1;
    sharedOwnerSignal = signal;
    return new Promise(resolve => { releaseShared = resolve; });
  }, {signal: ownerController.signal});
  await Promise.resolve();
  const sharedSecond = serveHooks.getOrCreateBiSectionInFlight(sharedKey, () => {
    sharedCalls += 1;
    throw new Error('ordinary reader must not create a second producer');
  }, {signal: ordinaryController.signal});
  ordinaryController.abort(new Error('ordinary reader disconnected'));
  assert.strictEqual(sharedSecond, sharedFirst, 'same section generation must remain de-duplicated');
  assert.equal(sharedCalls, 1, 'only the first producer may own shared generation');
  assert.strictEqual(sharedOwnerSignal, ownerController.signal, 'the producer must receive its own cancellation signal');
  assert.equal(ownerController.signal.aborted, false, 'ordinary reader cancellation must not abort the producer');
  releaseShared({ok: true});
  assert.deepEqual(await sharedFirst, {ok: true});

  const hugePayload = 'z'.repeat(1024 * 1024);
  const workerAck = serveHooks.biHostLockedSectionAcknowledgement('profit', {
    status: 200,
    payload: {ok: true, section: 'profit', generatedAt: GENERATION, data: {hugePayload}},
    headers: {
      'Content-Length': String(hugePayload.length),
      'Content-Encoding': 'gzip',
      'X-BI-Section-Stale': 'true',
      'X-BI-Section-Refresh-Failed': 'true',
      'Cache-Control': 'no-store',
    },
  }, GENERATION);
  assert.deepEqual(workerAck, {
    ok: true,
    section: 'profit',
    generatedAt: GENERATION,
    terminal: true,
  }, 'trusted worker acknowledgement must remain compact and data-free');
  assert.equal(JSON.stringify(workerAck).includes(hugePayload), false);
  const workerHeaders = serveHooks.biHostLockedSectionAcknowledgementHeaders({
    'Content-Length': '104857600',
    'Content-Encoding': 'gzip',
    'X-BI-Section-Stale': 'true',
    'X-BI-Section-Refresh-Failed': 'true',
    'X-BI-Section-Refresh-Error': 'encoded',
    'Cache-Control': 'no-store',
  });
  assert.equal(workerHeaders['Content-Length'], undefined, 'worker ack must not inherit the section body length');
  assert.equal(workerHeaders['Content-Encoding'], undefined, 'worker ack must not inherit body compression');
  assert.equal(workerHeaders['X-BI-Section-Stale'], 'true');
  assert.equal(workerHeaders['X-BI-Section-Refresh-Failed'], 'true');
  assert.equal(workerHeaders['X-BI-Section-Refresh-Error'], 'encoded');

  const requestSource = await fs.readFile(path.join(ROOT, 'scripts', 'serve_bi_portal.mjs'), 'utf8');
  assert.match(
    requestSource,
    /if \(hostLockedWorker\)[\s\S]*await disposeBiSectionRawBody\(result\.rawBody\)[\s\S]*biHostLockedSectionAcknowledgement\(/u,
    'trusted host-locked route must dispose raw bodies and send only the compact acknowledgement',
  );
  const request = new EventEmitter();
  request.aborted = false;
  request.destroyed = false;
  request.complete = true;
  const response = new EventEmitter();
  response.writableEnded = false;
  response.writableFinished = false;
  response.destroyed = false;
  const requestCancellation = serveHooks.createBiHostLockedRequestCancellation(request, response);
  request.aborted = true;
  request.emit('close');
  assert.equal(requestCancellation.signal.aborted, true, 'request close must abort the owned host-worker generation');
  requestCancellation.dispose();

  const traffic = await makeFixture('traffic', true, {corePad: 'c'.repeat(42 * 1024 * 1024)});
  const trafficPad = 'q'.repeat(36 * 1024 * 1024);
  const trafficSectionPad = 't'.repeat(42 * 1024 * 1024);
  await writeBiSectionCache(traffic.root, 'profit', GENERATION, {
    profit: {
      dailyStoreProducts: [{date: '2026-07-11', store_key: 'HL', standard_goods_sn: 'TRAFFIC-01', net_revenue_sar: 10}],
      monthGroups: [],
      products: [],
      storeStorageDaily: [],
    },
  }, RUN, {requireIntegrity: true});
  await writeBiSectionArtifact(traffic.root, 'profit.query', 'profit.query', GENERATION, {
    profit: {
      dailyStoreProducts: [{date: '2026-07-11', store_key: 'HL', standard_goods_sn: 'TRAFFIC-01', net_revenue_sar: 10}],
      monthGroups: [{month: '2026-07', trafficShard: trafficPad}],
      products: [{standard_goods_sn: 'TRAFFIC-01'}],
      storeStorageDaily: [],
    },
  }, RUN, {requireIntegrity: true, artifactMeta: queryArtifactMeta()});
  await writeBiSectionCache(traffic.root, 'homeProfit', GENERATION, {
    homeProfitSummary: {sourceGeneratedAt: GENERATION, sourceCachedAt: new Date().toISOString(), staleSource: false, dailyScopes: []},
  }, RUN, {requireIntegrity: true});
  await publishBiProfitBundleManifest(traffic.root, GENERATION);
  await writeBiSectionArtifact(traffic.root, 'productTrafficDaily', 'productTrafficDaily', GENERATION, {
    productTrafficDaily: {trafficPad: trafficSectionPad},
  }, RUN, {requireIntegrity: true});
  const loadedTraffic = await loadBiOpsQueryData({
    question: '查询商品利润明细',
    dataPath: traffic.dataPath,
    sectionsDir: traffic.sectionsDir,
    sections: ['productTrafficDaily', 'profit'],
  });
  const trafficArtifact = loadedTraffic.meta.loadedArtifacts.find(item => item.section === 'profit');
  assert.deepEqual(loadedTraffic.meta.loadedSections, ['productTrafficDaily', 'profit']);
  assert.equal(trafficArtifact?.artifact, 'profit.query');
  assert.ok(trafficArtifact.size > 32 * 1024 * 1024 && trafficArtifact.size < 64 * 1024 * 1024, '32-64MiB query traffic shard must load');
  assert.ok(loadedTraffic.meta.coreBytes > 40 * 1024 * 1024 && loadedTraffic.meta.coreBytes < 44 * 1024 * 1024, 'core budget fixture must be about 42MiB');
  assert.ok(loadedTraffic.meta.aggregateBytes < 128 * 1024 * 1024, 'core + traffic + compact profit must remain under the bounded aggregate budget');
  assert.equal(loadedTraffic.meta.sectionProvenance.profit.sourceArtifact, 'profit');
  assert.equal(loadedTraffic.data.profit.monthGroups[0].trafficShard.length, 36 * 1024 * 1024);
  assert.equal(loadedTraffic.data.productTrafficDaily.trafficPad.length, 42 * 1024 * 1024);

  const trafficAbort = new AbortController();
  const abortTimer = setTimeout(() => trafficAbort.abort(), 5);
  let trafficAborted = false;
  try {
    await loadBiOpsQueryData({
      question: '查询商品利润和流量',
      dataPath: traffic.dataPath,
      sectionsDir: traffic.sectionsDir,
      sections: ['productTrafficDaily', 'profit'],
      signal: trafficAbort.signal,
    });
  } catch (error) {
    trafficAborted = error?.name === 'AbortError';
  } finally {
    clearTimeout(abortTimer);
  }
  assert.equal(trafficAborted, true, 'combined budget fixture must reject a mid-read abort');

  const oversizedFull = JSON.stringify({
    ok: true,
    section: 'profit',
    generatedAt: GENERATION,
    cachedAt: '2026-07-11T00:01:00.000Z',
    data: {profit: {productStorageDaily: [], productStoreStorageDaily: [], pad: 'f'.repeat(65 * 1024 * 1024)}},
  });
  await fs.writeFile(path.join(traffic.sectionsDir, 'profit.json'), oversizedFull, 'utf8');
  const fallback = await makeFixture('full-too-large');
  await fs.copyFile(path.join(traffic.sectionsDir, 'profit.json'), path.join(fallback.sectionsDir, 'profit.json'));
  const rejected = await loadBiOpsQueryData({
    question: '查询商品利润明细',
    dataPath: fallback.dataPath,
    sectionsDir: fallback.sectionsDir,
    sections: ['profit'],
  });
  assert.deepEqual(rejected.meta.loadedSections, [], 'a broken profit bundle must not be mixed or invented as zero');
  assert.equal(rejected.data.profit, undefined);
  assert.equal(rejected.meta.attemptedSections.some(item => item.status === 'integrity_unverified'), true);

  console.log('bi_portal_direct_cache: bounded receipt, overflow fail-closed, exact integrity, full/compact profit, and bounded 36MiB query passed');
} finally {
  await fs.rm(tempRoot, {recursive: true, force: true});
}
