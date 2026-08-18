import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {__testHooks} = await import('./serve_bi_portal.mjs');
const {emitJsonChunks, collectStreamJson, sendLargeJson} = __testHooks;
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-bi-query-surface-'));
const queryPort = await freePort();
const queryStreamPort = await freePort();
const portalPort = await freePort();
const authFile = path.join(temp, 'users.json');
const rolesFile = path.join(temp, 'roles.json');
const htpasswdFile = path.join(temp, 'missing.htpasswd');
const sessionSecretFile = path.join(temp, 'shared-session-secret');
const portalDir = path.join(temp, 'portal');
const generatedAt = '2026-08-17T14:00:00.000+08:00';
const cliConfig = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'partner_cli_package.json'), 'utf8'));
const cliPackageFile = path.join(temp, `shein-bi-ops-cli-${cliConfig.version}.zip`);
const cliPackageBytes = Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const cliPackageSha = crypto.createHash('sha256').update(cliPackageBytes).digest('hex');

await fs.mkdir(path.join(portalDir, 'sections'), {recursive: true});
await fs.writeFile(path.join(portalDir, 'index.html'), '<!doctype html><title>fixture</title>', 'utf8');
await fs.writeFile(path.join(portalDir, 'data.json'), JSON.stringify({
  generatedAt,
  dates: {
    salesDate: '2026-08-17',
    salesUpdatedAt: '2026-08-17T13:59:00.000+08:00',
  },
  stores: [{store_key: 'HL', label: 'HL 店'}],
  __sections: {mode: 'api', generatedAt, keys: ['homeRankings'], loaded: ['core']},
}), 'utf8');
await fs.writeFile(authFile, JSON.stringify({users: [{username: 'query-test', password: 'correct-password', role: 'admin'}]}), 'utf8');
await fs.writeFile(rolesFile, JSON.stringify({roles: {admin: {readStores: ['*'], writeStores: ['*']}}}), 'utf8');
await fs.writeFile(sessionSecretFile, 'shared-test-secret-that-is-longer-than-thirty-two-bytes\n', {encoding: 'utf8', mode: 0o600});
await fs.writeFile(cliPackageFile, cliPackageBytes);
await fs.writeFile(`${cliPackageFile}.sha256`, `${cliPackageSha}  ${path.basename(cliPackageFile)}\n`, 'ascii');

const commonArgs = [
  '--dir', portalDir,
  '--auth-file', authFile,
  '--access-roles-file', rolesFile,
  '--htpasswd-file', htpasswdFile,
  '--session-secret-file', sessionSecretFile,
];
const commonEnv = {
  ...process.env,
  SHEIN_LINK_OPS_STORE: 'json',
  SHEIN_WEBHOOK_REPOSITORY_ENABLED: '0',
  SHEIN_BI_CORE_WARMUP_DISABLED: '1',
  SHEIN_BI_INTENT_PLANNER_ENABLED: '0',
  SHEIN_BI_JOB_WORKER_ENABLED: '0',
  SHEIN_BI_EXTERNAL_SECTION_QUEUE_ENABLED: '0',
  SHEIN_BI_QUERY_MAX_CONCURRENT: '1',
  SHEIN_BI_QUERY_MAX_QUEUED: '3',
  SHEIN_BI_QUERY_REQUEST_TIMEOUT_MS: '2000',
  SHEIN_BI_QUERY_GRACE_MS: '30000',
  SHEIN_BI_QUERY_TEST_NEVER_FOR: 'nevertest',
  SHEIN_BI_QUERY_TEST_HANG_FOR: 'hangtest',
  SHEIN_BI_QUERY_TEST_HANG_MS: '60000',
  SHEIN_OWNER_KNOWLEDGE_GIT_REPO_DIR: '',
  SHEIN_PARTNER_CLI_PACKAGE_FILE: cliPackageFile,
  SHEIN_PARTNER_CLI_PACKAGE_SHA256_FILE: `${cliPackageFile}.sha256`,
};

let query = null;
let queryStream = null;
let queryNever = null;
let portal = null;
const allChildren = new Set();

try {
  query = startRuntime('query', queryPort, [
    '--surface', 'query',
    '--state-file', path.join(temp, 'query-state.json'),
    '--link-ops-task-file', path.join(temp, 'query-tasks.json'),
    '--link-ops-chat-file', path.join(temp, 'query-chats.json'),
    '--link-ops-runtime-file', path.join(temp, 'query-runtime.json'),
    ...commonArgs,
  ]);
  await waitReady(query, queryPort, '/api/health');

  const queryBase = `http://127.0.0.1:${queryPort}`;
  const portalBase = `http://127.0.0.1:${portalPort}`;
  // The streaming JSON encoder must be byte-for-byte compatible with
  // JSON.stringify for every plain serializable value the BI runtime can
  // produce, including control characters, lone/paired surrogates, numeric
  // edge cases, key ordering, sparse arrays, boxed primitives, toJSON objects
  // and omitted object properties.
  {
    const controlChars = String.fromCharCode(0, 1, 31) + '\b\t\n\f\r';
    const loneHigh = String.fromCharCode(0xd800);
    const loneLow = String.fromCharCode(0xdfff);
    const paired = String.fromCodePoint(0x1f600);
    const lineSep = String.fromCharCode(0x2028);
    const paraSep = String.fromCharCode(0x2029);
    class ExtNumber extends Number {}
    class ExtString extends String {}
    class ExtBoolean extends Boolean {}
    const paritySamples = [
      null, true, false, 0, -0, 1.5, 1e21, 1e-7, 5e-324,
      1.7976931348623157e308, 0.1 + 0.2, NaN, Infinity, -Infinity,
      '', 'hello', controlChars, loneHigh, loneLow,
      'a' + loneHigh + 'b' + paired + 'c' + loneLow + 'd',
      '中文<>"\\', lineSep + paraSep,
      [], {}, [null, undefined, 1, function () {}, Symbol('x'), 'x'],
      {a: undefined, b: 1, c: function () {}, d: Symbol('x'), e: null, f: '🎉'},
      {2: 'b', 1: 'a', '-1': 'm', '01': 'z', b: 1},
      [{toJSON(key) { return 'key=' + key; }}, {toJSON() { return {y: 1}; }}],
      {d: new Date('2024-01-02T03:04:05.000Z')},
      {deep: {deep: {deep: {deep: {deep: [1, 2, 3]}}}}},
      {arr: Array.from({length: 120}, (_, i) => ({i, s: 'row-' + i, n: i * 1.5}))},
      {nested: [{a: 'émoji😀', b: null}, {a: '中文字符串', b: 42}]},
      {sparse: Array(5), mixed: [1, , 3]},
      {boxed: {s: new String('boxed'), n: new Number(9), b: new Boolean(false), nan: new Number(NaN), neg: new Number(-0)}},
      {boxedArr: [new String('x'), new Number(3), new Boolean(true), new String('')]},
      {forgedBoxed: [{ [Symbol.toStringTag]: 'Number', x: 1 }, { [Symbol.toStringTag]: 'String', x: 1 }, { [Symbol.toStringTag]: 'Boolean', x: 1 }, { [Symbol.toStringTag]: 'BigInt', x: 1 }]},
      {subclassBoxed: { n: new ExtNumber(5), s: new ExtString('abc'), b: new ExtBoolean(false) }},
      {protoAliased: { plain: Object.create(Number.prototype), direct: new Number(7) }},
      {longAscii: 'qwerty'.repeat(50000), longChinese: '\u4e2d\u6587'.repeat(50000)},
    ];
    for (const sample of paritySamples) {
      const expected = JSON.stringify(sample);
      const streamed = await collectStreamJson(sample);
      assert.equal(streamed, expected, 'streaming encoder must match JSON.stringify for ' + JSON.stringify(sample).slice(0, 60));
      assert.deepEqual(JSON.parse(streamed), JSON.parse(expected));
    }

    // A boxed BigInt must fail like a primitive BigInt.
    await assert.rejects(() => collectStreamJson({a: Object(1n)}), error => error.code === 'JSON_SERIALIZE_BIGINT');
    await assert.rejects(() => collectStreamJson({boxedBig: [Object(1n), {x: Object(2n)}]}), error => error.code === 'JSON_SERIALIZE_BIGINT');

    // Controlled failures carry explicit codes and can never fabricate a
    // successful response.
    const cyc = {a: 1};
    cyc.self = cyc;
    await assert.rejects(() => collectStreamJson(cyc), error => {
      assert.equal(error.code, 'JSON_CIRCULAR');
      assert.equal(error.name, 'TypeError');
      assert.match(String(error.message).toLowerCase(), /circular/);
      return true;
    });
    await assert.rejects(() => collectStreamJson({a: 1n}), error => error.code === 'JSON_SERIALIZE_BIGINT');
    await assert.rejects(() => collectStreamJson(undefined), error => error.code === 'JSON_SERIALIZE_UNSERIALIZABLE');
    await assert.rejects(() => collectStreamJson(() => {}), error => error.code === 'JSON_SERIALIZE_UNSERIALIZABLE');

    // A cycle deep inside a large object must still fail after many emitted
    // chunks instead of reporting success.
    const lateCycle = {rows: Array.from({length: 40000}, (_, i) => ({id: i, pad: 'x'.repeat(160)})), back: null};
    lateCycle.back = lateCycle;
    await assert.rejects(() => collectStreamJson(lateCycle), error => error.code === 'JSON_CIRCULAR');

    // An aborted signal must terminate the encoder between chunks and never
    // continue encoding.
    const abortController = new AbortController();
    const abortable = emitJsonChunks({rows: Array.from({length: 200000}, (_, i) => ({i, s: 'y'.repeat(300)}))}, {signal: abortController.signal});
    const firstAbortableChunk = await abortable.next();
    assert.equal(firstAbortableChunk.done, false);
    abortController.abort();
    await assert.rejects(async () => { await abortable.next(); }, error => error.name === 'AbortError');

    // Pre-header serialization failure on the real HTTP path returns a
    // structured error (socket preserved), while a cycle that surfaces only
    // after headers were sent must terminate the socket instead of faking a
    // successful body.
    const serializationServer = http.createServer(async (req, res) => {
      const cyclic = {ok: true};
      cyclic.self = cyclic;
      await sendLargeJson(req, res, 200, cyclic, {'Cache-Control': 'private, no-store'}).catch(() => {
        if (!res.headersSent && !res.destroyed) {
          res.writeHead(503, {'Content-Type': 'application/json; charset=utf-8'});
          res.end(JSON.stringify({ok: false, code: 'JSON_CIRCULAR', error: 'circular structure'}));
        } else if (!res.destroyed && !res.writableFinished) {
          res.destroy();
        }
      });
    });
    const serializationPort = await freePort();
    await new Promise(resolve => serializationServer.listen(serializationPort, '127.0.0.1', resolve));
    const preHeader = await fetch(`http://127.0.0.1:${serializationPort}/`, {headers: {accept: 'application/json'}});
    assert.equal(preHeader.status, 503);
    const preHeaderBody = await preHeader.json();
    assert.equal(preHeaderBody.code, 'JSON_CIRCULAR');
    await new Promise(resolve => serializationServer.close(resolve));

    const lateServer = http.createServer(async (req, res) => {
      const late = {rows: Array.from({length: 40000}, (_, i) => ({id: i, pad: 'x'.repeat(160)})), back: null};
      late.back = late;
      await sendLargeJson(req, res, 200, late, {'Cache-Control': 'private, no-store'}).catch(() => {
        if (!res.headersSent && !res.destroyed) {
          res.writeHead(500, {'Content-Type': 'application/json; charset=utf-8'});
          res.end(JSON.stringify({ok: false, code: 'JSON_CIRCULAR', error: 'late circular'}));
        } else if (!res.destroyed && !res.writableFinished) {
          res.destroy();
        }
      });
    });
    const latePort = await freePort();
    await new Promise(resolve => lateServer.listen(latePort, '127.0.0.1', resolve));
    const lateResponse = await fetch(`http://127.0.0.1:${latePort}/`, {headers: {accept: 'application/json'}});
    await assert.rejects(() => lateResponse.text(), /terminated|fetch failed|TypeError|Unexpected end/);
    await new Promise(resolve => lateServer.close(resolve));

    // A small valid object with no AbortSignal must stream successfully for
    // both gzip and identity responses (pipeline must not be given a null
    // signal).
    const plainServer = http.createServer(async (req, res) => {
      await sendLargeJson(req, res, 200, {ok: true, items: [1, 2, 3], label: 'plain'});
    });
    const plainPort = await freePort();
    await new Promise(resolve => plainServer.listen(plainPort, '127.0.0.1', resolve));
    const plainGzip = await rawGet(plainPort, '/', {'accept-encoding': 'gzip'});
    assert.equal(plainGzip.status, 200);
    assert.equal(plainGzip.headers['content-encoding'], 'gzip', 'no-signal gzip response must be wire-gzip with a content-encoding header');
    assert.deepEqual(JSON.parse(zlib.gunzipSync(plainGzip.body).toString('utf8')), {ok: true, items: [1, 2, 3], label: 'plain'});
    const plainIdentity = await rawGet(plainPort, '/', {'accept-encoding': 'identity'});
    assert.equal(plainIdentity.status, 200);
    assert.equal(plainIdentity.headers['content-encoding'], undefined);
    assert.deepEqual(JSON.parse(plainIdentity.body.toString('utf8')), {ok: true, items: [1, 2, 3], label: 'plain'});
    await new Promise(resolve => plainServer.close(resolve));

    // Deterministic cancellation race: the lane timeout handler answers with
    // a 503 (writeHead + end) inside the first-chunk await window. sendLargeJson
    // must NOT destroy that already-started/ended response even though its
    // finish event has not flushed yet; the client must receive the complete
    // structured 503.
    const raceServer = http.createServer(async (req, res) => {
      const controller = new AbortController();
      const interleave = Promise.resolve().then(() => {
        controller.abort();
        res.writeHead(503, {'Content-Type': 'application/json; charset=utf-8'});
        res.end(JSON.stringify({ok: false, code: 'BI_QUERY_TIMEOUT', error: 'deadline 503 already sent'}));
      });
      const sendPromise = sendLargeJson(req, res, 200, {ok: true, value: 1}, {'Cache-Control': 'private, no-store'}, {signal: controller.signal});
      await interleave;
      await sendPromise.catch(() => {});
    });
    const racePort = await freePort();
    await new Promise(resolve => raceServer.listen(racePort, '127.0.0.1', resolve));
    const raceResponse = await fetch(`http://127.0.0.1:${racePort}/`);
    assert.equal(raceResponse.status, 503, 'the outer 503 must be delivered intact during the first-chunk window');
    assert.deepEqual(await raceResponse.json(), {ok: false, code: 'BI_QUERY_TIMEOUT', error: 'deadline 503 already sent'});
    await new Promise(resolve => raceServer.close(resolve));

    // The same guard on the pre-header catch path: a signal aborted before
    // encoding starts must reject without touching an already-sent 503.
    const preAbortServer = http.createServer(async (req, res) => {
      const controller = new AbortController();
      controller.abort();
      res.writeHead(503, {'Content-Type': 'application/json; charset=utf-8'});
      res.end(JSON.stringify({ok: false, code: 'BI_QUERY_TIMEOUT', error: 'abort before start'}));
      await sendLargeJson(req, res, 200, {ok: true}, {}, {signal: controller.signal}).catch(() => {});
    });
    const preAbortPort = await freePort();
    await new Promise(resolve => preAbortServer.listen(preAbortPort, '127.0.0.1', resolve));
    const preAbortResponse = await fetch(`http://127.0.0.1:${preAbortPort}/`);
    assert.equal(preAbortResponse.status, 503);
    assert.deepEqual(await preAbortResponse.json(), {ok: false, code: 'BI_QUERY_TIMEOUT', error: 'abort before start'});
    await new Promise(resolve => preAbortServer.close(resolve));
  }
  console.error('MARK: unit block done');
  const health = await fetchJson(`${queryBase}/api/health`);
  console.error('MARK: health done');
  assert.equal(health.response.status, 200);
  assert.equal(health.body.surface, 'query');
  assert.equal(health.body.allowGenerate, false);
  assert.equal(health.body.allowGenerateSections, false);
  assert.deepEqual(health.body.sideEffectsStarted, []);
  assert.deepEqual(health.body.workers, []);
  assert.equal(health.body.worker, null);
  assert.equal(health.body.concurrency.max, 1);
  assert.equal(health.body.concurrency.maxQueued, 3);
  assert.equal(health.body.concurrency.deadlineMs, 2000);
  assert.equal(health.body.concurrency.graceMs, 30000, 'the grace window must be bounded and explicit');
  assert.equal(health.body.runtime?.admissionOpened, true, 'the query surface must open admission only after startup completes');
  assert.equal(health.body.runtime?.accepting, true);
  assert.ok(Number(health.body.mutationQueue?.capacity) >= 1, 'health must expose the bounded query queue capacity');

  // The BI JSON reader itself must observe AbortSignal: a pre-aborted signal
  // fails fast with AbortError instead of reading a heap-heavy core file.
  {
    const {loadBiOpsQueryData: loadBiOpsQueryDataWithSignal} = await import('../lib/bi_ops_query_context.mjs');
    const preAborted = new AbortController();
    preAborted.abort();
    let readAborted = false;
    try {
      await loadBiOpsQueryDataWithSignal({
        question: '今天销售多少',
        dataPath: path.join(portalDir, 'data.json'),
        sections: [],
        signal: preAborted.signal,
      });
    } catch (error) {
      readAborted = error?.name === 'AbortError';
    }
    assert.equal(readAborted, true, 'loadBiOpsQueryData must fail fast with AbortError when the signal is already aborted');
  }
  console.error('MARK: abortable reader done');

  // Deterministic FileHandle lifecycle regression for the Query cancellation
  // path. Before the fix, readJsonBounded ran an abort check between fs.open
  // success and the try/finally, so a cancellation landing in that window
  // leaked an unclosed FileHandle to the GC finalizer (DEP0137 warning).
  // These cases prove -- through the controlled __setFileHandleLifecycleHooks
  // seam that observes the exact opened handle -- that every exit after open
  // now awaits handle.close(): the abort-just-after-open flap, repeated
  // aborts, and the success path. No sleeps or GC timing are involved.
  {
    const {__setFileHandleLifecycleHooks: setLifecycleHooks, loadBiOpsQueryData: loadWithLifecycleHooks} = await import('../lib/bi_ops_query_context.mjs');
    const assertSettledClosed = async (handle, label) => {
      assert.ok(handle && typeof handle.close === 'function', `${label}: readJsonBounded must expose the opened FileHandle`);
      let timedOut = false;
      const timer = new Promise(resolve => setTimeout(() => { timedOut = true; resolve(); }, 5_000));
      await Promise.race([handle.closed, timer]);
      assert.equal(timedOut, false, `${label}: handle.closed did not settle within 5s (unclosed FileHandle leak)`);
      assert.equal(handle.fd, -1, `${label}: the FileHandle must be awaited-closed after the read settles (fd=${handle.fd})`);
    };
    try {
      // T1: abort fired synchronously inside the exact post-open pre-first-check
      // window that used to leak the handle between fs.open and the finally.
      {
        const controller = new AbortController();
        let flapHandle = null;
        let flapFdAtCapture = -1;
        setLifecycleHooks({onOpened: ({handle}) => {
          flapHandle = handle;
          flapFdAtCapture = handle.fd;
          controller.abort();
        }});
        let aborted = false;
        try {
          await loadWithLifecycleHooks({question: '今天销售多少', dataPath: path.join(portalDir, 'data.json'), sections: [], signal: controller.signal});
        } catch (error) {
          aborted = error?.name === 'AbortError';
        }
        assert.ok(flapFdAtCapture >= 0, `the captured handle must be freshly open at the exact post-open window (fd=${flapFdAtCapture})`);
        assert.equal(aborted, true, 'an abort landing right after fs.open must still reject with AbortError');
        await assertSettledClosed(flapHandle, 'post-open flap abort');
      }

      // T2: repeated aborts at the same window never accumulate open handles.
      {
        const iterations = 25;
        const capturedHandles = [];
        const capturedFds = [];
        let nonAbortSettlement = false;
        for (let i = 0; i < iterations; i++) {
          const controller = new AbortController();
          let captured = null;
          setLifecycleHooks({onOpened: ({handle}) => { captured = handle; capturedFds.push(handle.fd); controller.abort(); }});
          try {
            await loadWithLifecycleHooks({question: 'x', dataPath: path.join(portalDir, 'data.json'), sections: [], signal: controller.signal});
          } catch (error) {
            if (error?.name !== 'AbortError') nonAbortSettlement = true;
          }
          assert.ok(captured, `iteration ${i}: hook must have captured the opened handle`);
          capturedHandles.push(captured);
        }
        assert.equal(nonAbortSettlement, false, 'every repeated abort must settle as AbortError');
        for (let i = 0; i < iterations; i++) {
          assert.ok(capturedFds[i] >= 0, `iteration ${i}: handle must be open at capture (fd=${capturedFds[i]})`);
          await assertSettledClosed(capturedHandles[i], `repeated abort iteration ${i}`);
        }
      }

      // T3: the success path also awaits close on the handle it opened.
      {
        let successHandle = null;
        let successFdAtCapture = -1;
        setLifecycleHooks({onOpened: ({handle}) => { successHandle = handle; successFdAtCapture = handle.fd; }});
        const loaded = await loadWithLifecycleHooks({question: '今天销售多少', dataPath: path.join(portalDir, 'data.json'), sections: []});
        assert.equal(loaded?.meta?.version, 'bi-ops-query-context-v1', 'a normal read must still succeed and report the expected context version');
        assert.ok(successFdAtCapture >= 0, `the success-path handle must be open at capture (fd=${successFdAtCapture})`);
        await assertSettledClosed(successHandle, 'success path');
      }

      // T4: a forced-GC + --trace-warnings child probe proves the
      // readJsonBounded scope emits no DEP0137 FileHandle-on-GC warning even
      // after many abort-flap cycles whose handles are dropped unreferenced
      // afterwards (the leaky window used to leave one handle per cycle to the
      // GC finalizer). Nothing is retained after a cycle settles, so any leak
      // must surface as a DEP0137 during the forced collections below.
      {
        const probeFile = path.join(temp, 'bi-fh-gc-probe.mjs');
        const probeSource = `
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const mod = await import(pathToFileURL(${JSON.stringify(path.join(ROOT, 'lib', 'bi_ops_query_context.mjs'))}).href);
const {__setFileHandleLifecycleHooks: setHooks, loadBiOpsQueryData: load} = mod;
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bi-fh-gc-'));
const dataPath = path.join(dir, 'data.json');
await fs.writeFile(dataPath, JSON.stringify({generatedAt: 'x', dates: {}, stores: [], __sections: {mode: 'api', generatedAt: 'x', keys: [], loaded: ['core']}}));
let dep0137 = 0;
process.on('warning', warning => { if (warning?.code === 'DEP0137') dep0137++; });
const cycles = 120;
for (let i = 0; i < cycles; i++) {
  const controller = new AbortController();
  setHooks({onOpened: () => { controller.abort(); }});
  try { await load({question: 'q', dataPath, sections: [], signal: controller.signal}); } catch {}
}
setHooks(null);
const loaded = await load({question: 'q', dataPath, sections: []});
const ok = Boolean(loaded?.meta?.version);
for (let gc = 0; gc < 6; gc++) globalThis.gc();
await new Promise(resolve => setTimeout(resolve, 30));
for (let gc = 0; gc < 6; gc++) globalThis.gc();
console.log(JSON.stringify({dep0137, cycles, ok}));
await fs.rm(dir, {recursive: true, force: true});
process.exit(0);
`.trimStart();
        await fs.writeFile(probeFile, probeSource, 'utf8');
        const fhProbe = spawn(process.execPath, ['--expose-gc', '--trace-warnings', probeFile], {cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe']});
        const fhProbeKill = setTimeout(() => { if (fhProbe.exitCode === null && fhProbe.signalCode === null) fhProbe.kill('SIGKILL'); }, 60_000);
        const fhProbeResult = await new Promise((resolve, reject) => {
          let out = '';
          let err = '';
          fhProbe.stdout.on('data', chunk => { out += chunk.toString('utf8'); });
          fhProbe.stderr.on('data', chunk => { err += chunk.toString('utf8'); });
          fhProbe.on('exit', code => {
            clearTimeout(fhProbeKill);
            if (code !== 0) return reject(new Error(`FileHandle GC probe failed (exit ${code}): ${err}`));
            const last = out.trim().split('\n').pop();
            try { resolve(JSON.parse(last)); } catch { reject(new Error(`FileHandle GC probe output not JSON: ${out}`)); }
          });
          fhProbe.on('error', error => { clearTimeout(fhProbeKill); reject(error); });
        });
        console.error('MARK: fh GC probe ' + JSON.stringify(fhProbeResult));
        assert.equal(fhProbeResult.ok, true, 'the readJsonBounded success path must still work inside the GC probe');
        assert.equal(fhProbeResult.dep0137, 0, `no DEP0137 FileHandle-on-GC warning may originate from readJsonBounded after ${fhProbeResult.cycles} abort-flap cycles (got ${fhProbeResult.dep0137})`);
      }
    } finally {
      setLifecycleHooks(null);
    }
  }
  console.error('MARK: filehandle lifecycle done');

  const login = await fetch(`${queryBase}/api/login`, {
    method: 'POST',
    headers: {'content-type': 'application/json', origin: queryBase},
    body: JSON.stringify({username: 'query-test', password: 'correct-password', client: 'partner-cli'}),
  });
  assert.equal(login.status, 200, await login.text());
  console.error('MARK: login done');
  const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
  assert.match(cookie, /^bi_session=/);

  const meOnQuery = await fetchJson(`${queryBase}/api/auth/me`, {headers: {cookie}});
  assert.equal(meOnQuery.response.status, 200);
  assert.equal(meOnQuery.body.user.username, 'query-test');

  const manifest = await fetchJson(`${queryBase}/api/partner-cli/manifest`, {headers: {cookie}});
  assert.equal(manifest.response.status, 200, JSON.stringify(manifest.body));
  assert.equal(manifest.body.ok, true);
  assert.ok(manifest.body.data?.version);
  assert.ok(manifest.body.data?.bundleSha256);
  console.error('MARK: manifest done');

  const cacheMiss = await fetchJson(`${queryBase}/api/bi/query-data?q=${encodeURIComponent('售后')}&sections=afterSales`, {headers: {cookie}});
  assert.equal(cacheMiss.response.status, 503, 'a missing section must fail closed instead of starting generation');
  assert.equal(await pathExists(path.join(portalDir, 'sections', 'afterSales.json')), false);
  for (const file of ['query-state.json', 'query-tasks.json', 'query-chats.json', 'query-runtime.json']) {
    assert.equal(await pathExists(path.join(temp, file)), false, `${file} must not be created by query startup or reads`);
  }
  console.error('MARK: cacheMiss done');

  await fs.writeFile(path.join(portalDir, 'sections', 'homeRankings.json'), JSON.stringify({
    ok: true,
    section: 'homeRankings',
    generatedAt,
    cachedAt: '2026-08-17T06:00:00.000Z',
    data: {
      rankings: {
        dailyStores: [{
          date: '2026-08-17',
          store_key: 'HL',
          gross_sales_sar: 123,
          sales_sar: 123,
          gross_orders: 2,
          orders: 2,
          gross_quantity: 3,
          quantity: 3,
        }],
        dailyProducts: [],
        dailyStoreProducts: [],
      },
    },
  }), 'utf8');
  const directQuery = await fetchJson(
    `${queryBase}/api/bi/query-data?q=${encodeURIComponent('今天 HL 店销售额是多少')}&sections=homeRankings`,
    {headers: {cookie}},
  );
  assert.equal(directQuery.response.status, 200, JSON.stringify(directQuery.body));
  assert.equal(directQuery.body.ok, true);
  assert.equal(directQuery.body.mode, 'direct-bi-data');
  assert.equal(directQuery.body.aiInvoked, false);
  assert.equal(directQuery.body.sections?.loaded?.includes('homeRankings'), true);
 assert.equal(directQuery.body.data?.rankings?.dailyStores?.[0]?.gross_sales_sar, 123);
  console.error('MARK: directQuery done');
  // Cooperative timeout: delayAbortable observes AbortSignal, so the lane work
  // settles right after the deadline. The client gets a terminal 503 at the
  // deadline, the slot is released once the work settles, and the next
  // request must be servable at once.
  const hangUrl = `${queryBase}/api/bi/query-data?q=${encodeURIComponent('hangtest query')}&sections=homeRankings`;
  const deadlineStartedAt = Date.now();
  const timedOut = await fetchJson(hangUrl, {headers: {cookie}});
  const deadlineWallMs = Date.now() - deadlineStartedAt;
  assert.equal(timedOut.response.status, 503, `hang query must return a terminal 503 after the deadline: ${JSON.stringify(timedOut.body)}`);
  assert.equal(timedOut.body.code, 'BI_QUERY_TIMEOUT');
  assert.ok(deadlineWallMs >= 1_500 && deadlineWallMs < 10_000, `deadline must fire in bounded time (got ${deadlineWallMs}ms)`);
  const healthAfterTimeout = await waitForHealth(queryPort, c => c.active === 0 && c.queued === 0);
  assert.ok(healthAfterTimeout.timedOut >= 1, 'health must expose the timed-out counter');
  const afterTimeout = await fetchJson(`${queryBase}/api/bi/query-data?q=${encodeURIComponent('超时后正常问题')}&sections=homeRankings`, {headers: {cookie}});
  assert.equal(afterTimeout.response.status, 200, `the lane must serve a fresh request after the deadline: ${JSON.stringify(afterTimeout.body)}`);
  assert.equal(afterTimeout.body.ok, true);
  // Client disconnect with cooperative work: the abort reaches delayAbortable,
  // the work settles, the slot releases, and the next request is servable.
  const disconnectController = new AbortController();
  const disconnected = fetch(hangUrl, {headers: {cookie}, signal: disconnectController.signal}).catch(error => ({aborted: error?.name === 'AbortError'}));
  await new Promise(resolve => setTimeout(resolve, 400));
  disconnectController.abort();
  const disconnectResult = await disconnected;
  assert.equal(disconnectResult?.aborted, true, 'the client-side abort must propagate');
  const healthAfterDisconnect = await waitForHealth(queryPort, c => c.active === 0);
  assert.ok(healthAfterDisconnect.clientCancelled >= 1, 'health must expose the client-cancelled counter');
  const afterDisconnect = await fetchJson(`${queryBase}/api/bi/query-data?q=${encodeURIComponent('断线后正常问题')}&sections=homeRankings`, {headers: {cookie}});
  assert.equal(afterDisconnect.response.status, 200, `the lane must serve a fresh request after a client disconnect: ${JSON.stringify(afterDisconnect.body)}`);
  assert.equal(afterDisconnect.body.ok, true);

  // Large-section streaming: a ~18MB priceScatter shard is serialized through
  // the same bounded pipeline and must remain a valid, fully compressed gzip
  // JSON response on the wire, without a precomputed content-length. Run this
  // on a separate query-only process with the production 120s request budget:
  // the primary process intentionally uses a 2s budget to test deadline and
  // disconnect behavior, which must not race the large-response acceptance.
  queryStream = startRuntime('query-stream', queryStreamPort, [
    '--surface', 'query',
    '--state-file', path.join(temp, 'query-stream-state.json'),
    '--link-ops-task-file', path.join(temp, 'query-stream-tasks.json'),
    '--link-ops-chat-file', path.join(temp, 'query-stream-chats.json'),
    '--link-ops-runtime-file', path.join(temp, 'query-stream-runtime.json'),
    ...commonArgs,
  ], {SHEIN_BI_QUERY_REQUEST_TIMEOUT_MS: '120000'});
  await waitReady(queryStream, queryStreamPort, '/api/health');
  const queryStreamBase = `http://127.0.0.1:${queryStreamPort}`;
  const priceScatterRows = [];
  for (let i = 0; i < 240000; i += 1) {
    priceScatterRows.push({id: i, store_key: 'HL', product_id: 'P' + (i % 900), price_sar: (i % 500) + i / 100, orders: i % 13, quantity: 1 + (i % 7), text: 'row-' + i + '-' + 'x'.repeat(72)});
  }
  await fs.writeFile(path.join(portalDir, 'sections', 'priceScatter.json'), JSON.stringify({
    ok: true,
    section: 'priceScatter',
    generatedAt,
    cachedAt: '2026-08-17T06:00:00.000Z',
    data: {priceScatter: priceScatterRows},
  }), 'utf8');
  const bigQueryPath = '/api/bi/query-data?q=' + encodeURIComponent('成交价大分区流式测试') + '&sections=priceScatter';
  const gzipRaw = await rawGet(queryStreamPort, bigQueryPath, {cookie, 'accept-encoding': 'gzip'});
  assert.equal(gzipRaw.status, 200, 'large gzip query must stream with HTTP 200');
  assert.equal(gzipRaw.headers['content-encoding'], 'gzip', 'gzip responses must be compressed from the first byte');
  assert.equal(gzipRaw.headers['content-length'], undefined, 'streaming responses must not carry a precomputed content-length');
  console.error('MARK: gzipRaw done');
  const gzipParsed = JSON.parse(zlib.gunzipSync(gzipRaw.body).toString('utf8'));
  assert.equal(gzipParsed.ok, true);
  assert.equal(gzipParsed.data.priceScatter.length, priceScatterRows.length, 'gzip stream must decode to the full section array');
  assert.deepEqual(gzipParsed.data.priceScatter[0], priceScatterRows[0], 'large payload content must survive streaming and gzip exactly');
  assert.equal(gzipParsed.data.priceScatter[priceScatterRows.length - 1].id, priceScatterRows.length - 1, 'the last row must survive streaming and gzip exactly');

  const identityRaw = await rawGet(queryStreamPort, bigQueryPath, {cookie, 'accept-encoding': 'identity'});
  assert.equal(identityRaw.status, 200);
  assert.equal(identityRaw.headers['content-encoding'], undefined, 'identity responses must not be gzip-encoded');
  assert.equal(identityRaw.headers['content-length'], undefined);
  console.error('MARK: identityRaw done');
  const identityParsed = JSON.parse(identityRaw.body.toString('utf8'));
  assert.equal(identityParsed.ok, true);
  assert.equal(identityParsed.data.priceScatter.length, priceScatterRows.length);
  const gzipDecoded = zlib.gunzipSync(gzipRaw.body);
  assert.deepEqual(JSON.parse(gzipDecoded.toString('utf8')), gzipParsed, 'the captured gzip wire body must decode without transformation');
  const stableQueryResponse = value => ({
    ...value,
    sections: {
      ...value.sections,
      preparation: Array.isArray(value.sections?.preparation)
        ? value.sections.preparation.map(({durationMs: _durationMs, ...item}) => item)
        : value.sections?.preparation,
    },
  });
  const gzipStable = Buffer.from(JSON.stringify(stableQueryResponse(gzipParsed)), 'utf8');
  const identityStable = Buffer.from(JSON.stringify(stableQueryResponse(identityParsed)), 'utf8');
  const gzipSha = crypto.createHash('sha256').update(gzipStable).digest('hex');
  const identitySha = crypto.createHash('sha256').update(identityStable).digest('hex');
  assert.equal(gzipSha, identitySha, 'gzip and identity responses must carry identical business data after removing per-request durationMs');

  // Mid-stream client disconnect: the socket closes while the large pipeline
  // is still writing; the lane slot must only be released after the pipeline
  // terminates, and a fresh query must be served afterwards.
  const bigAbortController = new AbortController();
  const bigResponsePromise = fetch(queryStreamBase + bigQueryPath, {headers: {cookie}, signal: bigAbortController.signal});
  const bigResponse = await bigResponsePromise;
  assert.equal(bigResponse.status, 200);
  const bigReader = bigResponse.body.getReader();
  const firstBigChunk = await bigReader.read();
  assert.ok(firstBigChunk.value && firstBigChunk.value.byteLength > 0, 'the first streaming chunk must arrive before the abort');
  bigAbortController.abort();
  await bigResponsePromise.catch(() => {});
  const healthAfterBigAbort = await waitForHealth(queryStreamPort, c => c.active === 0);
  assert.ok(healthAfterBigAbort.clientCancelled >= 1, 'a mid-stream disconnect must be counted as a client cancellation');
  const afterBigAbort = await fetchJson(`${queryStreamBase}/api/bi/query-data?q=${encodeURIComponent('流式断线后正常')}&sections=homeRankings`, {headers: {cookie}});
  assert.equal(afterBigAbort.response.status, 200, 'the lane must serve a fresh query after a mid-stream disconnect');
  assert.equal(afterBigAbort.body.ok, true);
  console.error('MARK: big abort done');

  // The streaming response path must not contain a whole-object JSON.stringify
  // or a synchronous gzipSync copy. The slice stops at the next top-level
  // function so later routes' JSON.stringify calls cannot cause a false
  // positive.
  const portalSource = await fs.readFile(path.join(ROOT, 'scripts', 'serve_bi_portal.mjs'), 'utf8');
  const sendLargeJsonStart = portalSource.indexOf('async function sendLargeJson');
  assert.ok(sendLargeJsonStart >= 0, 'sendLargeJson must exist in serve_bi_portal.mjs');
  const nextTopLevelFunction = portalSource.slice(sendLargeJsonStart + 1).search(/\n(?:async )?function /);
  const sendLargeJsonSection = nextTopLevelFunction >= 0
    ? portalSource.slice(sendLargeJsonStart, sendLargeJsonStart + 1 + nextTopLevelFunction)
    : portalSource.slice(sendLargeJsonStart);
  assert.doesNotMatch(sendLargeJsonSection, /JSON\.stringify/, 'sendLargeJson must never whole-stringify the response value');
  assert.doesNotMatch(portalSource, /gzipSync/, 'serve_bi_portal.mjs must not import or call gzipSync');

  // Memory boundedness and wire integrity run in a child process with a 128MB
  // old-space ceiling: serializing a ~30MB object through the real
  // sendLargeJson + gzip pipeline into a deliberately slow client must not
  // retain a full JSON Buffer/gzip copy, and the streamed bytes must gunzip to
  // the exact expected JSON. The expected hash is generated only AFTER peak
  // sampling stops so verification cannot pre-warm the heap/RSS baseline.
  // process.resourceUsage().maxRSS is KiB on every platform; any stream error
  // fails the probe fast.
  const heapProbeFile = path.join(temp, 'stream-heap-probe.mjs');
  const heapProbeSource = `
import http from 'node:http';
import zlib from 'node:zlib';
import {createHash} from 'node:crypto';
const {__testHooks} = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'scripts', 'serve_bi_portal.mjs')).href)});
const {sendLargeJson, emitJsonChunks} = __testHooks;
const rows = [];
for (let i = 0; i < 120000; i += 1) {
  rows.push({id: i, store: 'HL', productId: 'P' + (i % 500), price: i * 0.37, orders: i % 11, note: 'row-' + i + '-' + 'x'.repeat(128)});
}
const big = {priceScatter: rows, headline: 'everyday'.repeat(200000), sheet: 'y'.repeat(2 * 1024 * 1024)};
const gc = () => { if (global.gc) global.gc(); };
const toBuffer = chunk => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
gc();
const baseline = process.memoryUsage();
const baselineMaxRSS = process.resourceUsage().maxRSS;
const totalOf = m => m.heapUsed + m.external;
const peak = {rss: 0, heapUsed: 0, external: 0, arrayBuffers: 0, total: 0, maxRSS: 0};
const sample = () => {
  const m = process.memoryUsage();
  peak.rss = Math.max(peak.rss, m.rss - baseline.rss);
  peak.heapUsed = Math.max(peak.heapUsed, m.heapUsed - baseline.heapUsed);
  peak.external = Math.max(peak.external, m.external - baseline.external);
  peak.arrayBuffers = Math.max(peak.arrayBuffers, m.arrayBuffers - baseline.arrayBuffers);
  peak.total = Math.max(peak.total, totalOf(m) - totalOf(baseline));
};
let gzipSyncUsed = false;
const realGzipSync = zlib.gzipSync;
zlib.gzipSync = (...args) => { gzipSyncUsed = true; return realGzipSync(...args); };
let settled = false;
const peakTimer = setInterval(sample, 5);
const fail = error => {
  if (settled) return;
  settled = true;
  clearInterval(peakTimer);
  clearTimeout(overallTimer);
  process.stdout.write(JSON.stringify({ok: false, error: String(error && error.stack || error)}) + '\\n');
  process.exit(2);
};
const overallTimer = setTimeout(() => fail(new Error('overall probe timeout')), 45000);
overallTimer.unref();
const server = http.createServer((req, res) => {
  sendLargeJson(req, res, 200, big).catch(error => {
    if (!res.destroyed) res.destroy();
    fail(error);
  });
});
server.on('error', fail);
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const req = http.request({host: '127.0.0.1', port, path: '/', method: 'GET', headers: {'accept-encoding': 'gzip'}}, res => {
    const gunzip = zlib.createGunzip({highWaterMark: 32 * 1024});
    const bodyHash = createHash('sha256');
    let bodyBytes = 0;
    const plainHash = createHash('sha256');
    let plainBytes = 0;
    gunzip.on('data', d => { plainHash.update(d); plainBytes += d.length; });
    gunzip.on('error', fail);
    res.pause();
    const pull = () => {
      const chunk = res.read();
      if (chunk) {
        bodyHash.update(chunk);
        bodyBytes += chunk.length;
        gunzip.write(chunk);
        setTimeout(pull, 5);
      } else if (res.readableEnded) {
        gunzip.end();
      } else if (res.destroyed) {
        fail(new Error('response socket destroyed before completion'));
      } else {
        setTimeout(pull, 5);
      }
    };
    pull();
    res.on('error', fail);
    gunzip.on('end', async () => {
      if (settled) return;
      sample();
      clearInterval(peakTimer);
      const compressedOk = bodyBytes > 0 && !gzipSyncUsed;
      const plainDigest = plainHash.digest('hex');
      const maxRSSBytes = (process.resourceUsage().maxRSS - baselineMaxRSS) * 1024;
      peak.maxRSS = maxRSSBytes;
      try {
        const expectedHash = createHash('sha256');
        let expectedBytes = 0;
        for await (const chunk of emitJsonChunks(big, {})) {
          const buf = toBuffer(chunk);
          expectedHash.update(buf);
          expectedBytes += buf.length;
        }
        const plainOk = plainBytes === expectedBytes && plainDigest === expectedHash.digest('hex');
        settled = true;
        clearTimeout(overallTimer);
        zlib.gzipSync = realGzipSync;
        server.close(() => {
          process.stdout.write(JSON.stringify({
            ok: compressedOk && plainOk,
            gzipSyncUsed,
            compressedBytes: bodyBytes,
            plainBytes,
            expectedPlainBytes: expectedBytes,
            baselineRssMB: Math.round(baseline.rss / 1048576 * 100) / 100,
            baselineHeapMB: Math.round(baseline.heapUsed / 1048576 * 100) / 100,
            peakRssMB: Math.round(peak.rss / 1048576 * 100) / 100,
            peakMaxRSSMB: Math.round(maxRSSBytes / 1048576 * 100) / 100,
            peakTotalMB: Math.round(peak.total / 1048576 * 100) / 100,
            peakHeapMB: Math.round(peak.heapUsed / 1048576 * 100) / 100,
            peakExternalMB: Math.round(peak.external / 1048576 * 100) / 100,
            peakArrayBuffersMB: Math.round(peak.arrayBuffers / 1048576 * 100) / 100,
          }) + '\\n');
          process.exit(0);
        });
      } catch (error) {
        fail(error);
      }
    });
  });
  req.on('error', fail);
  req.setTimeout(45000, () => fail(new Error('probe client timeout')));
  req.end();
});
  `.trimStart();
  await fs.writeFile(heapProbeFile, heapProbeSource, 'utf8');
  const heapProbe = spawn(process.execPath, ['--expose-gc', '--max-old-space-size=128', heapProbeFile], {cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe']});
  const probeKillTimer = setTimeout(() => {
    if (heapProbe.exitCode === null && heapProbe.signalCode === null) heapProbe.kill('SIGKILL');
  }, 75_000);
  const heapProbeResult = await new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    heapProbe.stdout.on('data', c => { out += c.toString('utf8'); });
    heapProbe.stderr.on('data', c => { err += c.toString('utf8'); });
    heapProbe.on('exit', code => {
      clearTimeout(probeKillTimer);
      if (code !== 0) return reject(new Error('heap probe failed: ' + err));
      const last = out.trim().split('\n').pop();
      try { resolve(JSON.parse(last)); } catch { reject(new Error('heap probe output not JSON: ' + out)); }
    });
    heapProbe.on('error', error => { clearTimeout(probeKillTimer); reject(error); });
  });
  console.error('MARK: heap probe result ' + JSON.stringify(heapProbeResult));
  assert.equal(heapProbeResult.ok, true, 'streamed gzip bytes must gunzip to the exact expected JSON and must not use gzipSync');
  assert.equal(heapProbeResult.plainBytes, heapProbeResult.expectedPlainBytes, 'gunzip output byte count must match the exact expected JSON length');
  assert.equal(heapProbeResult.gzipSyncUsed, false, 'the streaming path must never call gzipSync');
  assert.ok(heapProbeResult.peakExternalMB < 16, 'streaming must not allocate a full ~30MB JSON Buffer (external peak got ' + heapProbeResult.peakExternalMB + 'MB)');
  assert.ok(heapProbeResult.peakMaxRSSMB < 160, 'streaming must stay inside the constrained-heap RSS envelope (maxRSS got ' + heapProbeResult.peakMaxRSSMB + 'MB)');
  console.error('MARK: heap probe done');

  // Non-cooperative never-work: the work ignores AbortSignal, so the slot must
  // NOT be released after the deadline. The 503 terminates the client
  // response, but the lane stays held; a second request must never execute
  // concurrently (it may only queue). The bounded grace window then fail-fasts
  // the whole query process (exit code 70) so systemd Restart=always recovers
  // it, and a fresh runtime serves again.
  const neverPort = await freePort();
  const neverEnv = {...commonEnv, SHEIN_BI_QUERY_GRACE_MS: '2500'};
  const neverArgs = [
    '--surface', 'query',
    '--state-file', path.join(temp, 'query-never-state.json'),
    '--link-ops-task-file', path.join(temp, 'query-never-tasks.json'),
    '--link-ops-chat-file', path.join(temp, 'query-never-chats.json'),
    '--link-ops-runtime-file', path.join(temp, 'query-never-runtime.json'),
    ...commonArgs,
  ];
  queryNever = startRuntime('query-never', neverPort, neverArgs, neverEnv);
  await waitReady(queryNever, neverPort, '/api/health');
  const neverBase = `http://127.0.0.1:${neverPort}`;
  const neverUrl = `${neverBase}/api/bi/query-data?q=${encodeURIComponent('nevertest query')}&sections=homeRankings`;
  const neverStartedAt = Date.now();
  const neverTimedOut = await fetchJson(neverUrl, {headers: {cookie}});
  const neverDeadlineWallMs = Date.now() - neverStartedAt;
  assert.equal(neverTimedOut.response.status, 503, `never query must return a terminal 503 after the deadline: ${JSON.stringify(neverTimedOut.body)}`);
  assert.equal(neverTimedOut.body.code, 'BI_QUERY_TIMEOUT');
  assert.ok(neverDeadlineWallMs >= 1_500 && neverDeadlineWallMs < 10_000, `deadline must fire in bounded time (got ${neverDeadlineWallMs}ms)`);
  const heldDuringGrace = await waitForHealth(neverPort, c => c.active === 1);
  assert.equal(heldDuringGrace.active, 1, 'the slot must stay held after the deadline while non-cooperative work is still running');
  // A second re-query must never start executing while the first work runs;
  // it may only queue and then time out without ever touching the lane.
  const secondDuringGrace = fetch(neverUrl, {headers: {cookie}}).then(async response => ({
    status: response.status,
    body: await response.json().catch(() => null),
  })).catch(() => null);
  const queuedDuringGrace = await waitForHealth(neverPort, c => c.active === 1 && c.queued >= 1);
  assert.equal(queuedDuringGrace.active, 1, 'the second query must never run concurrently with the first work');
  assert.ok(queuedDuringGrace.queued >= 1, 'the second query must be queued, not executed');
  const secondResult = await secondDuringGrace;
  if (secondResult) {
    assert.equal(secondResult.status, 503, 'the queued second query must never execute; it may only time out');
    assert.equal(secondResult.body?.code, 'BI_QUERY_TIMEOUT');
  }
  const neverExited = await Promise.race([
    new Promise(resolve => queryNever.child.once('exit', (code, signal) => resolve({code, signal}))),
    new Promise(resolve => setTimeout(() => resolve(null), 10_000)),
  ]);
  assert.ok(neverExited, 'the query process must fail-fast exit within the bounded grace window');
  assert.equal(neverExited.code, 70, `the fail-fast exit code must be 70 (got ${JSON.stringify(neverExited)})`);
  assert.ok(Date.now() - neverStartedAt < 10_000, 'timeout(2000ms)+grace(2500ms) must bound the fail-fast exit');
  allChildren.delete(queryNever);
  queryNever = null;
  // systemd Restart=always simulation: a fresh runtime on the same port must
  // serve again.
  const neverRestarted = startRuntime('query-never-restarted', neverPort, neverArgs, neverEnv);
  await waitReady(neverRestarted, neverPort, '/api/health');
  const afterNeverRestart = await fetchJson(`${neverBase}/api/bi/query-data?q=${encodeURIComponent('重启后正常问题')}&sections=homeRankings`, {headers: {cookie}});
  assert.equal(afterNeverRestart.response.status, 200, `the restarted runtime must serve a fresh query: ${JSON.stringify(afterNeverRestart.body)}`);
  assert.equal(afterNeverRestart.body.ok, true);
  await stopRuntime(neverRestarted);

 const methodDenied = await fetchJson(`${queryBase}/api/partner-cli/manifest`, {method: 'POST', headers: {cookie, origin: queryBase}});
  assert.equal(methodDenied.response.status, 405);
  assert.equal(methodDenied.body.code, 'QUERY_SURFACE_METHOD_DENIED');

  for (const route of ['/api/link-ops/tasks', '/api/owner-knowledge/events', '/api/partner-cli/release/deploy']) {
    const denied = await fetchJson(`${queryBase}${route}`, {
      method: 'POST',
      headers: {cookie, origin: queryBase, 'content-type': 'application/json'},
      body: '{}',
    });
    assert.equal(denied.response.status, 404, `${route} must fail closed`);
    assert.equal(denied.body.code, 'QUERY_SURFACE_ROUTE_DENIED');
  }

  portal = startRuntime('portal', portalPort, [
    '--state-file', path.join(temp, 'portal-state.json'),
    '--link-ops-task-file', path.join(temp, 'portal-tasks.json'),
    '--link-ops-chat-file', path.join(temp, 'portal-chats.json'),
    '--link-ops-runtime-file', path.join(temp, 'portal-runtime.json'),
    '--manual-login-state-file', path.join(temp, 'portal-manual-login.json'),
    '--audit-file', path.join(temp, 'portal-audit.jsonl'),
    ...commonArgs,
  ]);
  await waitReady(portal, portalPort, '/api/health');

  const meOnPortal = await fetchJson(`${portalBase}/api/auth/me`, {headers: {cookie}});
  assert.equal(meOnPortal.response.status, 200, JSON.stringify(meOnPortal.body));
  assert.equal(meOnPortal.body.user.username, 'query-test', 'query cookie must be accepted by full Portal');

  const originalQueryPid = query.child.pid;
  await stopRuntime(portal);
  portal = null;
  for (let i = 0; i < 8; i += 1) {
    const duringPortalStop = await fetchJson(`${queryBase}/api/partner-cli/manifest`, {headers: {cookie}});
    assert.equal(duringPortalStop.response.status, 200, `query failed while Portal was stopped at probe ${i}`);
    assert.equal(duringPortalStop.body.ok, true);
  }
  assert.equal(query.child.pid, originalQueryPid);
  assert.equal(query.child.exitCode, null, 'query process must remain running while Portal is stopped');

  portal = startRuntime('portal-restarted', portalPort, [
    '--state-file', path.join(temp, 'portal-state.json'),
    '--link-ops-task-file', path.join(temp, 'portal-tasks.json'),
    '--link-ops-chat-file', path.join(temp, 'portal-chats.json'),
    '--link-ops-runtime-file', path.join(temp, 'portal-runtime.json'),
    '--manual-login-state-file', path.join(temp, 'portal-manual-login.json'),
    '--audit-file', path.join(temp, 'portal-audit.jsonl'),
    ...commonArgs,
  ]);
  await waitReady(portal, portalPort, '/api/health');
  const afterRestart = await fetchJson(`${queryBase}/api/auth/me`, {headers: {cookie}});
  assert.equal(afterRestart.response.status, 200);
  assert.equal(query.child.pid, originalQueryPid, 'query runtime must not restart with full Portal');

  // The full Portal serves the same large streaming response through its own
  // client-disconnect aborter.
  const portalBigPath = '/api/bi/query-data?q=' + encodeURIComponent('门户大分区流式测试') + '&sections=priceScatter';
  const portalGzipRaw = await rawGet(portalPort, portalBigPath, {cookie, 'accept-encoding': 'gzip'});
  assert.equal(portalGzipRaw.status, 200, 'portal large gzip query must stream with HTTP 200');
  assert.equal(portalGzipRaw.headers['content-encoding'], 'gzip');
  const portalGzipParsed = JSON.parse(zlib.gunzipSync(portalGzipRaw.body).toString('utf8'));
  assert.equal(portalGzipParsed.ok, true);
  assert.equal(portalGzipParsed.data.priceScatter.length, priceScatterRows.length);
  console.error('MARK: portal gzip done');

  const portalAbortController = new AbortController();
  const portalBigPromise = fetch(portalBase + portalBigPath, {headers: {cookie}, signal: portalAbortController.signal});
  const portalBigResponse = await portalBigPromise;
  const portalReader = portalBigResponse.body.getReader();
  const firstPortalChunk = await portalReader.read();
  assert.ok(firstPortalChunk.value && firstPortalChunk.value.byteLength > 0, 'portal stream must start before the abort');
  portalAbortController.abort();
  await portalBigPromise.catch(() => {});
  const portalFollowUp = await fetchJson(`${portalBase}/api/bi/query-data?q=${encodeURIComponent('门户流式中断后正常')}&sections=homeRankings`, {headers: {cookie}});
  assert.equal(portalFollowUp.response.status, 200, 'portal must serve a fresh query after a mid-stream disconnect');
  assert.equal(portalFollowUp.body.ok, true);
  console.error('MARK: portal abort done');

  const unit = await fs.readFile(path.join(ROOT, 'infra', 'systemd', 'shein-bi-query.service'), 'utf8');
  assert.match(unit, /--surface query --host 127\.0\.0\.1 --port 8788/);
  assert.match(unit, /^MemoryMax=1400M$/m);
  assert.match(unit, /^MemoryHigh=1024M$/m);
  assert.match(unit, /^TasksMax=128$/m);
  assert.match(unit, /^Environment=SHEIN_BI_QUERY_MAX_CONCURRENT=1$/m);
  assert.match(unit, /^Environment=SHEIN_BI_QUERY_MAX_QUEUED=3$/m);
  assert.match(unit, /^Environment=SHEIN_BI_QUERY_REQUEST_TIMEOUT_MS=120000$/m);
  assert.match(unit, /^Environment=SHEIN_BI_QUERY_GRACE_MS=30000$/m, 'the systemd unit must pin the bounded grace window');
  assert.match(unit, /^Environment=NODE_OPTIONS=--max-old-space-size=1024$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^KillMode=control-group$/m);
  assert.match(unit, /\/data\/shein-bi\/outputs\/bi-portal/);
  assert.match(unit, /\/data\/shein-bi\/state\/bi_portal_session_secret\.local/);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.doesNotMatch(unit, /ExecCondition=/);

  const nginx = await fs.readFile(path.join(ROOT, 'infra', 'nginx', 'shein-bi.conf'), 'utf8');
  const exactRoutes = [
    ['/api/login', 'POST'], ['/api/logout', 'POST'], ['/api/auth/me', 'GET'],
    ['/api/bi/query-data', 'GET'], ['/api/partner-cli/package', 'GET'],
    ['/api/partner-cli/manifest', 'GET'], ['/api/partner-cli/bundle', 'GET'],
    ['/api/owner-knowledge/manifest', 'GET'], ['/api/owner-knowledge/bundle', 'GET'],
  ];
  const authRouteSet = new Set(['/api/login', '/api/logout', '/api/auth/me']);
  assert.equal((nginx.match(/(^|\n)upstream shein_bi_auth \{/g) || []).length, 1,
    'auth failover must have one unambiguous upstream owner');
  const authUpstream = /(?:^|\n)upstream shein_bi_auth \{([\s\S]*?)\n\}/.exec(nginx)?.[1] || '';
  assert.ok(authUpstream, 'missing auth failover upstream');
  assert.deepEqual(authUpstream.split('\n').map(line => line.trim()).filter(Boolean), [
    'server 127.0.0.1:8788;',
    'server 127.0.0.1:8787 backup;',
  ], 'Query must be the sole auth primary and Portal the sole backup');
  for (const [route, method] of exactRoutes) {
    const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const block = new RegExp(`location = ${escaped} \\{([\\s\\S]*?)\\n    \\}`).exec(nginx)?.[1] || '';
    assert.ok(block, `missing exact nginx route ${route}`);
    assert.match(block, new RegExp(`limit_except ${method} \\{ deny all; \\}`));
    if (authRouteSet.has(route)) {
      assert.match(block, /proxy_pass http:\/\/shein_bi_auth;/);
      assert.doesNotMatch(block, /proxy_pass http:\/\/127\.0\.0\.1:878[78];/);
      const retryWords = /proxy_next_upstream\s+([^;]+);/.exec(block)?.[1]?.trim().split(/\s+/) || [];
      assert.deepEqual(retryWords, ['error', 'timeout', 'http_502', 'http_503', 'http_504', 'non_idempotent'],
        `${route} may fail over only for transport errors/timeouts and 502/503/504`);
      assert.doesNotMatch(retryWords.join(' '), /http_4\d\d/, `${route} must never replay a 4xx response`);
      assert.match(block, /proxy_next_upstream_tries 2;/, `${route} must perform at most one backup attempt`);
      assert.doesNotMatch(block, /proxy_request_buffering off;/, `${route} must retain a replayable buffered request body`);
    } else {
      assert.match(block, /proxy_pass http:\/\/127\.0\.0\.1:8788;/);
      assert.match(block, /proxy_next_upstream off;/, `${route} must fail closed when Query is unavailable`);
      assert.doesNotMatch(block, /shein_bi_auth|127\.0\.0\.1:8787/, `${route} must never fall back to Portal`);
    }
    assert.match(block, /proxy_set_header Host \$host;/);
    assert.match(block, /proxy_set_header X-Real-IP \$remote_addr;/);
    assert.match(block, /proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/);
    assert.match(block, /proxy_set_header X-Forwarded-Proto \$http_x_forwarded_proto;/);
  }
  assert.doesNotMatch(nginx, /location = \/api\/health\s*\{[\s\S]*?8788/);

  console.log(JSON.stringify({
    ok: true,
    processIsolation: {
      queryPid: originalQueryPid,
      portalStoppedAndRestarted: true,
      continuityProbes: 8,
      sharedCookieAcceptedByPortal: true,
      deterministicQuerySucceeded: true,
      cooperativeDeadlineSettledAndReleasedLane: true,
      cooperativeDisconnectSettledAndReleasedLane: true,
      neverWorkHeldSlotDuringGrace: true,
      neverWorkFailFastExitCode: 70,
      neverWorkRestartServedAgain: true,
    },
    querySurface: {
      manifestVersion: manifest.body.data.version,
      sideEffectsStarted: health.body.sideEffectsStarted,
      allowGenerate: health.body.allowGenerate,
      rejectedWriteRoutes: ['/api/link-ops/tasks', '/api/owner-knowledge/events', '/api/partner-cli/release/deploy'],
      laneConcurrency: {
        max: 1,
        maxQueued: 3,
        deadlineMs: 2000,
        graceMs: 30000,
        timedOut: healthAfterTimeout.timedOut,
        clientCancelled: healthAfterDisconnect.clientCancelled,
        heldDuringNeverGrace: heldDuringGrace.active,
        queuedDuringNeverGrace: queuedDuringGrace.queued,
      },
    },
  }, null, 2));
} finally {
  if (portal) await stopRuntime(portal).catch(() => {});
  if (query) await stopRuntime(query).catch(() => {});
  if (queryStream) await stopRuntime(queryStream).catch(() => {});
  if (queryNever) await stopRuntime(queryNever).catch(() => {});
  for (const runtime of allChildren) {
    if (runtime.child.exitCode === null && runtime.child.signalCode === null) runtime.child.kill('SIGKILL');
  }
  await fs.rm(temp, {recursive: true, force: true});
}

function startRuntime(label, port, args, extraEnv = {}) {
  const child = spawn(process.execPath, [
    path.join(ROOT, 'scripts', 'serve_bi_portal.mjs'),
    '--host', '127.0.0.1', '--port', String(port),
    ...args,
  ], {cwd: ROOT, env: {...commonEnv, ...extraEnv}, stdio: ['ignore', 'pipe', 'pipe']});
  const runtime = {label, child, stdout: '', stderr: ''};
  child.stdout.on('data', chunk => { runtime.stdout += chunk.toString('utf8'); });
  child.stderr.on('data', chunk => { runtime.stderr += chunk.toString('utf8'); });
  child.stdout.on('data', chunk => { process.stderr.write('[child:' + label + ':out] ' + chunk.toString('utf8')); });
  child.stderr.on('data', chunk => { process.stderr.write('[child:' + label + ':err] ' + chunk.toString('utf8')); });
  allChildren.add(runtime);
  return runtime;
}

async function waitForHealth(port, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const probe = await fetchJson(`http://127.0.0.1:${port}/api/health`).catch(() => null);
    last = probe?.body?.concurrency || null;
    if (last && predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`health condition not met within ${timeoutMs}ms: ${JSON.stringify(last)}`);
}

async function waitReady(runtime, port, pathname) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) {
      throw new Error(`${runtime.label} exited before ready\nstdout=${runtime.stdout}\nstderr=${runtime.stderr}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
      if (response.status === 200) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${runtime.label} not ready\nstdout=${runtime.stdout}\nstderr=${runtime.stderr}`);
}

async function stopRuntime(runtime) {
  if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) return;
  runtime.child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise(resolve => runtime.child.once('exit', () => resolve(true))),
    new Promise(resolve => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!exited && runtime.child.exitCode === null && runtime.child.signalCode === null) {
    runtime.child.kill('SIGKILL');
    await new Promise(resolve => runtime.child.once('exit', resolve));
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = {raw: text}; }
  return {response, body};
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function pathExists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function rawGet(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, path: pathname, method: 'GET', headers}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)}));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}
