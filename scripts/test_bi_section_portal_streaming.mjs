#!/usr/bin/env node
// Portal E2E: the /api/bi/section/<name> route streams raw/gzip section bytes
// (bounded reads, no whole-file JSON.stringify) through the real runtime, keeps
// generation/stale semantics, survives a mid-stream client abort, and releases
// resources so a follow-up request stays healthy.
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatedAt = '2026-08-11T08:36:30.27274+08:00';

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  const result = typeof address === 'object' && address ? address.port : 0;
  await new Promise(resolve => probe.close(resolve));
  return result;
}

async function waitForServer(base, serverProcess, stderrText) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) throw new Error('portal exited before startup: ' + stderrText());
    try {
      const response = await fetch(base + '/login');
      if (response.status === 200) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('portal startup timed out: ' + stderrText());
}

async function waitForChildExit(child, label, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise(resolve => {
    const timer = setTimeout(() => { child.removeListener('exit', onExit); resolve(false); }, ms);
    function onExit() { clearTimeout(timer); resolve(true); }
    child.once('exit', onExit);
  });
}

async function stopChild(child, label) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (await waitForChildExit(child, label, 5_000)) return;
  child.kill('SIGKILL');
  if (!await waitForChildExit(child, label, 3_000)) throw new Error(label + ' did not exit');
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bi-section-portal-stream-'));
const portalDir = path.join(temp, 'portal');
const sectionsDir = path.join(portalDir, 'sections');
const authFile = path.join(temp, 'users.json');
const secretFile = path.join(temp, 'session-secret');
const port = await freePort();
let child = null;
try {
  await fs.mkdir(sectionsDir, {recursive: true});
  await fs.writeFile(path.join(portalDir, 'index.html'), '<!doctype html><title>test</title>');
  await fs.writeFile(path.join(portalDir, 'data.json'), JSON.stringify({
    generatedAt,
    __sections: {mode: 'api', generatedAt},
  }));
  await fs.writeFile(path.join(sectionsDir, 'orders.json'), JSON.stringify({
    ok: true,
    section: 'orders',
    generatedAt,
    cachedAt: '2026-08-11T02:56:46.613Z',
    data: {rows: Array.from({length: 5}, (_, index) => ({id: index, store: 'JSH', amount: index * 100}))},
    run: {code: 0, timedOut: false, stderrTail: ''},
  }));
  await fs.writeFile(authFile, JSON.stringify({users: [
    {username: 'e2e-user', password: 'correct-password', role: 'admin', readStores: ['*']},
  ]}));
  const provision = spawnSync(process.execPath, [
    path.join(root, 'scripts', 'provision_bi_session_secret.mjs'), '--file', secretFile,
  ], {cwd: root, encoding: 'utf8'});
  assert.equal(provision.status, 0, 'session secret must be provisioned:\n' + provision.stderr);
  assert.ok(fs.access(secretFile).then(() => true, () => false), 'secret file must exist');

  const env = {
    ...process.env,
    NODE_ENV: 'test',
    SHEIN_LINK_OPS_STORE: 'json',
    SHEIN_WEBHOOK_REPOSITORY_ENABLED: '0',
    SHEIN_BI_LIVE_UPDATES_ENABLED: '0',
    SHEIN_BI_LIVE_ACCOUNTING_ENABLED: '0',
    SHEIN_BI_EXTERNAL_SECTION_QUEUE_ENABLED: '0',
    SHEIN_BI_CORE_WARMUP_DISABLED: '1',
    SHEIN_BI_INTENT_PLANNER_ENABLED: '0',
    SHEIN_BI_JOB_WORKER_ENABLED: '0',
    SHEIN_OWNER_KNOWLEDGE_GIT_REPO_DIR: '',
  };
  child = spawn(process.execPath, [
    path.join(root, 'scripts', 'serve_bi_portal.mjs'),
    '--host', '127.0.0.1', '--port', String(port), '--dir', portalDir,
    '--auth-file', authFile, '--htpasswd-file', path.join(temp, 'missing.htpasswd'),
    '--session-secret-file', secretFile, '--state-file', path.join(temp, 'state.json'),
    '--link-ops-task-file', path.join(temp, 'tasks.json'), '--link-ops-chat-file', path.join(temp, 'chats.json'),
    '--manual-login-state-file', path.join(temp, 'manual-login.json'), '--audit-file', path.join(temp, 'audit.jsonl'),
  ], {cwd: root, env, stdio: ['ignore', 'ignore', 'pipe']});
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });

  const base = 'http://127.0.0.1:' + port;
  await waitForServer(base, child, () => stderr);
  const loginResponse = await fetch(base + '/api/login', {
    method: 'POST',
    headers: {'content-type': 'application/json', origin: base, 'x-forwarded-for': '203.0.113.9'},
    body: JSON.stringify({username: 'e2e-user', password: 'correct-password'}),
  });
  assert.equal(loginResponse.status, 200, 'login failed: ' + stderr);
  const cookie = String(loginResponse.headers.get('set-cookie') || '').split(';')[0];

  const sectionUrl = base + '/api/bi/section/orders';
  const rawGet = (accept) => new Promise((resolve, reject) => {
    const target = new URL(sectionUrl);
    const req = http.request({
      host: target.hostname, port: target.port, path: target.pathname, method: 'GET',
      headers: {cookie, 'accept-encoding': accept},
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)}));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
  const collect = async response => Buffer.from(await response.arrayBuffer());

  const identityRaw = await rawGet('identity');
  assert.equal(identityRaw.status, 200, 'identity section must stream 200: ' + stderr);
  assert.equal(identityRaw.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(identityRaw.headers['content-length'], undefined, 'streamed identity must not carry content-length');
  assert.equal(identityRaw.headers['x-bi-section-cache-hit'], 'true');
  const identityBytes = identityRaw.body;
  const identityPayload = JSON.parse(identityBytes.toString('utf8'));
  assert.equal(identityPayload.cacheHit, true);
  assert.equal(identityPayload.data.rows.length, 5);

  const gzipRaw = await rawGet('gzip');
  assert.equal(gzipRaw.status, 200, 'gzip section must stream 200: ' + stderr);
  assert.equal(gzipRaw.headers['content-encoding'], 'gzip');
  const gzipParsed = JSON.parse(zlib.gunzipSync(gzipRaw.body).toString('utf8'));
  assert.equal(gzipParsed.ok, true);
  assert.equal(gzipParsed.section, 'orders');
  assert.equal(gzipParsed.generatedAt, generatedAt);
  assert.deepEqual(gzipParsed.data, identityPayload.data,
    'portal gzip and identity responses must carry identical business data (identity appends the cacheHit field on the wire)');
  assert.equal(gzipRaw.headers['x-bi-section-cache-hit'], 'true', 'the cache hint travels in the header for both encodings');

  // A mid-stream client abort must not wedge the server: the lane stays usable.
  const abortController = new AbortController();
  const abortPromise = fetch(sectionUrl, {headers: {cookie}, signal: abortController.signal});
  const abortResponse = await abortPromise;
  assert.equal(abortResponse.status, 200);
  const reader = abortResponse.body.getReader();
  const first = await reader.read();
  assert.ok(first.value && first.value.byteLength > 0, 'first streaming chunk must arrive before the abort');
  abortController.abort();
  await abortPromise.catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 200));
  const followResponse = await fetch(sectionUrl, {headers: {cookie, 'accept-encoding': 'identity'}});
  assert.equal(followResponse.status, 200, 'a fresh section request must stay healthy after a mid-stream abort');
  const followParsed = JSON.parse((await collect(followResponse)).toString('utf8'));
  assert.equal(followParsed.cacheHit, true);
  assert.deepEqual(followParsed.data, identityPayload.data,
    'the follow-up identity response must carry identical business data');

  // Generation mismatch must fail closed instead of serving a stale 200 body.
  const staleResponse = await fetch(base + '/api/bi/section/orders?refresh=1&refreshToken=x', {headers: {cookie}});
  assert.ok([202, 503, 200].includes(staleResponse.status), 'forced refresh on unknown token must not crash');
  // ---- Deterministic rawBody disposal regressions ----------------------
  // These mirror the production discard pattern (loadDirectBiQuery
  // preparation and core warmup hand a readBiSectionRawStream descriptor to
  // disposeBiSectionRawBody and never pipe it), so a sink regressing the
  // helper is caught here as a tracked gate rather than only in ignored
  // audit probes.
  {
    const {__testHooks: portalHooks} = await import('./serve_bi_portal.mjs');
    const cacheMod = await import('../lib/bi_section_cache.mjs');
    const dispose = portalHooks.disposeBiSectionRawBody;
    const disposeTemp = path.join(temp, 'dispose');
    const disposeSections = path.join(disposeTemp, 'sections');
    await fs.mkdir(disposeSections, {recursive: true});
    const disposeGeneratedAt = '2026-08-18T00:00:00.000Z';
    await fs.writeFile(path.join(disposeSections, 'orders.json'), JSON.stringify({
      ok: true,
      section: 'orders',
      generatedAt: disposeGeneratedAt,
      cachedAt: disposeGeneratedAt,
      data: {rows: [{id: 1}]},
    }) + '\n');
    const pendingUnhandled = [];
    const onUnhandledRejection = reason => pendingUnhandled.push(String(reason));
    const onUncaughtException = error => pendingUnhandled.push(String((error && error.message) || error));
    process.on('unhandledRejection', onUnhandledRejection);
    process.on('uncaughtException', onUncaughtException);
    try {
      // D1: destroyed-but-close-pending must NOT resolve before the real
      // close. `destroyed` flips synchronously while the cache layer still
      // owns the fd until the async 'close'; the dispose promise must wait.
      {
        const desc = await cacheMod.readBiSectionRawStream(disposeTemp, 'orders', disposeGeneratedAt, true);
        assert.ok(desc, 'D1 descriptor required');
        const order = [];
        let settledClosed = false;
        desc.stream.once('close', () => order.push('close-event'));
        desc.stream.destroy();
        assert.equal(desc.stream.destroyed, true, 'D1 destroy must take effect synchronously');
        const disposePromise = dispose(desc.stream).then(() => {
          settledClosed = desc.stream.closed === true;
          order.push('dispose-settled');
          return desc.stream.closed === true;
        });
        assert.equal(await disposePromise, true, 'D1 dispose must resolve only once closed');
        assert.equal(settledClosed, true, 'D1 dispose settled while closed=false');
        assert.ok(
          order.indexOf('dispose-settled') > order.indexOf('close-event'),
          'D1 dispose must settle strictly after the close event',
        );
        assert.equal(cacheMod.getBiSectionOpenStreamCount(), 0, 'D1 the destroyed stream handle must be released');
      }
      // D2: a pristine (unconsumed, not destroyed) descriptor dispose must
      // close the stream and release the handle (open stream count 0).
      {
        const desc = await cacheMod.readBiSectionRawStream(disposeTemp, 'orders', disposeGeneratedAt, true);
        assert.ok(desc, 'D2 descriptor required');
        assert.equal(cacheMod.getBiSectionOpenStreamCount(), 1, 'D2 a live stream owns exactly one handle');
        await dispose(desc.stream);
        assert.equal(desc.stream.closed, true, 'D2 stream must be closed after dispose');
        assert.equal(cacheMod.getBiSectionOpenStreamCount(), 0, 'D2 dispose must leave open stream count 0');
      }
      // D3: error/close race must settle only after the real close and must
      // never surface an unhandled rejection.
      {
        const desc = await cacheMod.readBiSectionRawStream(disposeTemp, 'orders', disposeGeneratedAt, true);
        assert.ok(desc, 'D3 descriptor required');
        const disposePromise = dispose(desc.stream);
        desc.stream.destroy(new Error('D3 simulated upstream stream error'));
        assert.equal(await disposePromise, undefined, 'D3 dispose must settle exactly once');
        assert.equal(desc.stream.closed, true, 'D3 dispose must settle only after closed');
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(pendingUnhandled.length, 0, 'D3 error/close race must leave no unhandled rejection');
        assert.equal(cacheMod.getBiSectionOpenStreamCount(), 0, 'D3 the errored stream handle must be released');
        pendingUnhandled.length = 0;
      }
      // D4: a tight loop of discarded live descriptors (the production
      // warmup pattern) leaves zero open streams and emits no DEP0137.
      {
        let dep0137 = 0;
        const onWarning = warning => { if (warning && warning.code === 'DEP0137') dep0137 += 1; };
        process.on('warning', onWarning);
        try {
          for (let i = 0; i < 40; i += 1) {
            const desc = await cacheMod.readBiSectionRawStream(disposeTemp, 'orders', disposeGeneratedAt, true);
            assert.ok(desc, 'D4 descriptor required');
            await dispose(desc.stream);
          }
          assert.equal(cacheMod.getBiSectionOpenStreamCount(), 0, 'D4 loop must leave zero open streams');
        } finally {
          process.removeListener('warning', onWarning);
        }
        assert.equal(dep0137, 0, 'D4 discarded-stream loop must not leak FileHandles to the GC finalizer');
      }
    } finally {
      process.removeListener('unhandledRejection', onUnhandledRejection);
      process.removeListener('uncaughtException', onUncaughtException);
    }
    console.log('bi_section_portal_streaming: deterministic rawBody disposal regressions passed');
  }

  console.log('bi_section_portal_streaming: identity/gzip streaming, abort recovery, and close-with-cookie checks passed');
} finally {
  await stopChild(child, 'portal');
  await fs.rm(temp, {recursive: true, force: true});
}
