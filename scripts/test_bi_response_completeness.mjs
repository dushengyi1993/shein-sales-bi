#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import {promisify} from 'node:util';
import {Readable} from 'node:stream';
import crypto from 'node:crypto';

import {__testHooks} from './serve_bi_portal.mjs';
import {writeBiSectionCache} from '../lib/bi_section_cache.mjs';

const gunzipAsync = promisify(zlib.gunzip);
const {
  sendBiPortalCoreSnapshot,
  createBiPortalCoreSnapshotCache,
  readBiPortalCoreEnvelope,
  resetBiPortalCoreEnvelopeCache,
  biPortalCoreEnvelopeScanCount,
  loadDirectBiQuery,
  biPortalCoreRouteLifecycleStatus,
  resetBiPortalCoreRouteLifecycleState,
  evaluateBiPortalCoreRouteLifecycleHealth,
  evaluateBiPortalCoreSnapshotLifecycleHealth,
  evaluateBiPortalTopLevelHealth,
} = __testHooks;

function httpGetBuffer(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, {headers}, res => {
      const chunks = [];
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        error.statusCode = res.statusCode;
        error.headers = res.headers;
        error.receivedBytes = chunks.reduce((total, chunk) => total + chunk.length, 0);
        reject(error);
      };
      res.on('data', chunk => chunks.push(chunk));
      res.on('aborted', () => fail(new Error('response aborted before completion')));
      res.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
      res.on('error', fail);
    }).on('error', reject);
  });
}

function failingSnapshotLease(body) {
  let released = false;
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  return {
    kind: 'raw',
    byteLength: body.length,
    rawByteLength: body.length,
    sha256,
    rawSha256: sha256,
    createReadStream() {
      let emitted = false;
      return new Readable({
        read() {
          if (emitted) return;
          emitted = true;
          this.push(body.subarray(0, Math.max(1, Math.floor(body.length / 2))));
          const error = new Error('injected EIO after response headers');
          error.code = 'EIO';
          queueMicrotask(() => this.destroy(error));
        },
      });
    },
    release() { released = true; },
    wasReleased() { return released; },
  };
}

async function testHttpStreaming(tmpDir) {
  resetBiPortalCoreRouteLifecycleState();
  const gen = '2026-08-30T10:00:00.000000+08:00';
  const dataFile = path.join(tmpDir, 'data.json');
  const payloadObj = {
    generatedAt: gen,
    __sections: {mode: 'api', generatedAt: gen, keys: ['homeRankings']},
    audit: {ok: true, message: 'testing streamed core json'},
    extraData: 'x'.repeat(10000),
  };
  await fs.writeFile(dataFile, JSON.stringify(payloadObj, null, 2), 'utf8');

  resetBiPortalCoreEnvelopeCache();
  const manager = createBiPortalCoreSnapshotCache({
    root: tmpDir,
    snapshotDir: path.join(tmpDir, 'response-snapshots'),
  });
  const failureBody = Buffer.from(JSON.stringify({ok: true, generatedAt: gen, payload: 'x'.repeat(64 * 1024)}));
  let faultLease = null;
  const server = http.createServer(async (req, res) => {
    let lease;
    try {
      if (req.url === '/fault') {
        faultLease = failingSnapshotLease(failureBody);
        await sendBiPortalCoreSnapshot(req, res, faultLease);
        return;
      }
      lease = await manager.acquire({
        gzip: /(?:^|,)\s*gzip\b/iu.test(String(req.headers['accept-encoding'] || '')),
        evidence: null,
      });
      await sendBiPortalCoreSnapshot(req, res, lease, {
        'Cache-Control': 'no-cache',
      });
      lease = null;
    } catch (err) {
      if (!res.headersSent && !res.writableEnded) {
        res.writeHead(500, {'Content-Type': 'text/plain'});
        res.end(err.message);
      }
    } finally {
      await lease?.release?.();
    }
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    // 1. Raw complete response
    const rawRes = await httpGetBuffer(`http://127.0.0.1:${port}/data.json`, {
      'Accept-Encoding': 'identity',
    });
    assert.equal(rawRes.statusCode, 200);
    const rawLen = rawRes.headers['content-length'];
    assert.ok(rawLen, 'Content-Length present for uncompressed body');
    assert.equal(rawRes.body.length, Number(rawLen));
    const rawJson = JSON.parse(rawRes.body.toString('utf8'));
    assert.equal(rawJson.generatedAt, gen);
    assert.equal(rawJson.audit.message, 'testing streamed core json');

    // 2. Gzip complete response
    const gzipRes = await httpGetBuffer(`http://127.0.0.1:${port}/data.json`, {
      'Accept-Encoding': 'gzip',
    });
    assert.equal(gzipRes.statusCode, 200);
    assert.equal(gzipRes.headers['content-encoding'], 'gzip');
    assert.equal(gzipRes.body.length, Number(gzipRes.headers['content-length']),
      'prebuilt gzip response must also carry an exact Content-Length');
    const uncompressed = await gunzipAsync(gzipRes.body);
    const gzipJson = JSON.parse(uncompressed.toString('utf8'));
    assert.equal(gzipJson.generatedAt, gen);
    assert.equal(gzipJson.audit.message, 'testing streamed core json');
    assert.equal(evaluateBiPortalCoreRouteLifecycleHealth().ok, true,
      'ordinary consecutive successful responses stay healthy');

    // 3. Client early disconnect / destroy
    await new Promise((resolve) => {
      const clientReq = http.get(`http://127.0.0.1:${port}/data.json`, {
        headers: {'Accept-Encoding': 'identity'},
      }, clientRes => {
        clientRes.once('data', () => {
          clientReq.destroy();
          setTimeout(resolve, 50);
        });
      });
      clientReq.on('error', () => {
        resolve();
      });
    });

    // The disconnected request releases only its request lease. The current
    // owner intentionally retains two cache handles for unchanged-generation
    // reuse instead of closing/rebuilding after every response.
    for (let attempt = 0; attempt < 100 && manager.status().requestLeases !== 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(manager.status().requestLeases, 0, 'client disconnect must release its request lease');
    assert.deepEqual(
      (({active, retired, openHandles, builds}) => ({active, retired, openHandles, builds}))(manager.status()),
      {active: 1, retired: 0, openHandles: 2, builds: 1},
    );
    assert.equal(evaluateBiPortalCoreSnapshotLifecycleHealth(manager.status()).ok, true);

    resetBiPortalCoreRouteLifecycleState();
    let truncated = null;
    try {
      await httpGetBuffer(`http://127.0.0.1:${port}/fault`);
    } catch (error) {
      truncated = error;
    }
    assert.ok(truncated, 'background EIO after headers must reject the client response');
    assert.equal(truncated.statusCode, 200, 'the fixture must prove a status 200 alone is not complete');
    assert.ok(Number(truncated.headers?.['content-length']) > Number(truncated.receivedBytes || 0),
      'Content-Length must expose the truncated 200 response');
    assert.equal(faultLease.wasReleased(), true, 'failed response must release its request lease');
    const routeStatus = biPortalCoreRouteLifecycleStatus();
    assert.equal(routeStatus.totalResponseFailures, 1);
    assert.equal(routeStatus.consecutiveResponseFailures, 1);
    assert.equal(routeStatus.lastResponseError, 'EIO');
    const routeHealth = evaluateBiPortalCoreRouteLifecycleHealth(routeStatus);
    assert.equal(routeHealth.ok, true);
    assert.equal(routeHealth.degraded, true);
    assert.equal(routeHealth.warning, 'routeResponse');
    assert.deepEqual(routeHealth.issues, []);
    assert.equal(routeHealth.routeResponseFailures, 1);
    assert.equal(evaluateBiPortalTopLevelHealth({warmupHealth: {ok: true}, routeHealth}).ok, true);

    await assert.rejects(httpGetBuffer(`http://127.0.0.1:${port}/fault`));
    const twiceFailedHealth = evaluateBiPortalCoreRouteLifecycleHealth();
    assert.equal(twiceFailedHealth.ok, true, 'two consecutive failures remain green');
    assert.equal(twiceFailedHealth.routeResponseFailures, 2);
    await assert.rejects(httpGetBuffer(`http://127.0.0.1:${port}/fault`));
    const failedStatus = biPortalCoreRouteLifecycleStatus();
    const failedHealth = evaluateBiPortalCoreRouteLifecycleHealth(failedStatus);
    assert.equal(failedHealth.ok, false);
    assert.ok(failedHealth.issues.includes('routeResponse'));
    assert.equal(evaluateBiPortalTopLevelHealth({warmupHealth: {ok: true}, routeHealth: failedHealth}).ok, false);
    const historicalFailureAt = failedStatus.lastResponseFailureAt;

    const healthyAfterFailure = await httpGetBuffer(`http://127.0.0.1:${port}/data.json`, {
      'Accept-Encoding': 'identity',
    });
    assert.equal(JSON.parse(healthyAfterFailure.body.toString('utf8')).generatedAt, gen);
    const recoveredStatus = biPortalCoreRouteLifecycleStatus();
    const recoveredHealth = evaluateBiPortalCoreRouteLifecycleHealth(recoveredStatus);
    assert.equal(recoveredHealth.ok, true);
    assert.equal(recoveredHealth.degraded, false);
    assert.equal(recoveredHealth.warning, '');
    assert.equal(recoveredStatus.totalResponseFailures, 3, 'historical failure count remains visible');
    assert.equal(recoveredStatus.lastResponseFailureAt, historicalFailureAt, 'historical failure time remains visible');
    assert.equal(recoveredStatus.consecutiveResponseFailures, 0);
    assert.equal(recoveredStatus.lastResponseError, '');
  } finally {
    resetBiPortalCoreRouteLifecycleState();
    await new Promise(resolve => server.close(resolve));
    await manager.shutdown({timeoutMs: 2_000});
  }
}

async function testLargeApiCoreAndLegacy(tmpDir) {
  // Test >64MB data.json with mode='api'
  const gen = '2026-08-30T10:00:00.000000+08:00';
  const dataFile = path.join(tmpDir, 'data.json');

  // Write valid section artifact with proper writeBiSectionCache
  await writeBiSectionCache(
    tmpDir,
    'homeRankings',
    gen,
    {
      rankings: {
        salesSummary: [{store: 'DL', sales_sar: 1000}],
        dailyStores: [],
      },
    },
    {ok: true, at: gen}
  );

  // Build >65MB data.json: top-level headers + 65MB padding
  const header = `{\n  "generatedAt": "${gen}",\n  "dates": {"linkDate": "2026-08-30"},\n  "__sections": {"mode": "api", "generatedAt": "${gen}", "keys": ["homeRankings"]},\n  "audit": {"ok": true},\n  "largePadding": "`;
  const footer = `"\n}\n`;
  const paddingChunk = 'a'.repeat(1024 * 1024);

  const fh = await fs.open(dataFile, 'w');
  await fh.write(header);
  for (let i = 0; i < 66; i++) {
    await fh.write(paddingChunk);
  }
  await fh.write(footer);
  await fh.close();

  const stat = await fs.stat(dataFile);
  assert.ok(stat.size > 65 * 1024 * 1024, 'data.json is >65MB');

  resetBiPortalCoreEnvelopeCache();

  // Test loadDirectBiQuery on >65MB api core
  const queryResult = await loadDirectBiQuery(
    {},
    tmpDir,
    {username: 'test', role: 'admin', readStores: ['*']},
    '今日销量排行',
    {sections: ['homeRankings'], allowGenerate: false}
  );

  assert.equal(queryResult.ok, true, 'query on >65MB api core succeeded');
  assert.equal(biPortalCoreEnvelopeScanCount(), 1, 'envelope scanned exactly once via lightweight singleflight');
  assert.ok(queryResult.data.rankings, 'homeRankings section loaded into data');
  assert.equal(queryResult.data.dates?.linkDate, '2026-08-30', 'dates loaded properly');

  const sameLengthReplacement = path.join(tmpDir, 'data.same-length-replacement.json');
  const openedOldCore = path.join(tmpDir, 'data.opened-old.json');
  await fs.copyFile(dataFile, sameLengthReplacement);
  let corePathSwapped = false;
  await assert.rejects(
    loadDirectBiQuery(
      {},
      tmpDir,
      {username: 'test', role: 'admin', readStores: ['*']},
      '今日销量排行',
      {
        sections: ['homeRankings'],
        allowGenerate: false,
        async onBeforeFinalCoreIdentityReadback() {
          corePathSwapped = true;
          await fs.rename(dataFile, openedOldCore);
          await fs.rename(sameLengthReplacement, dataFile);
        },
      },
    ),
    error => error?.code === 'BI_QUERY_IDENTITY_CHANGED',
  );
  assert.equal(corePathSwapped, true,
    'API-mode lightweight core query must perform a terminal pathname identity readback');
  assert.equal((await fs.stat(dataFile)).size, (await fs.stat(openedOldCore)).size,
    'the path-swap fixture must preserve exact core byte length');
  await fs.rm(openedOldCore, {force: true});

  const unavailable = await loadDirectBiQuery(
    {},
    tmpDir,
    {username: 'test', role: 'admin', readStores: ['*']},
    '查询售后',
    {sections: ['afterSales'], allowGenerate: false},
  );
  assert.equal(unavailable.ok, false, 'an unavailable requested section must fail the data-completeness contract');
  assert.equal(unavailable.sections.issues.some(issue => (
    issue.section === 'afterSales' && issue.status !== 'loaded'
  )), true, 'an unavailable section must return an explicit issue instead of a business zero');
  assert.equal(Object.hasOwn(unavailable.data, 'afterSales'), false,
    'missing section data must not be synthesized as an empty/zero result');

  // Test legacy small core backward compatibility
  const legacyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bi-legacy-core-'));
  try {
    const legacyFile = path.join(legacyDir, 'data.json');

    await fs.writeFile(legacyFile, JSON.stringify({
      generatedAt: gen,
      dates: {linkDate: '2026-08-30'},
      __sections: {mode: 'legacy', generatedAt: gen, keys: ['homeRankings']},
      audit: {ok: true},
    }, null, 2), 'utf8');

    await writeBiSectionCache(
      legacyDir,
      'homeRankings',
      gen,
      {
        rankings: {
          salesSummary: [{store: 'DL', sales_sar: 500}],
        },
      },
      {ok: true, at: gen}
    );

    const legacyQueryResult = await loadDirectBiQuery(
      {},
      legacyDir,
      {username: 'test', role: 'admin', readStores: ['*']},
      '今日销量排行',
      {sections: ['homeRankings'], allowGenerate: false}
    );
    assert.equal(legacyQueryResult.ok, true, 'query on legacy small core succeeded');
    assert.ok(legacyQueryResult.data.rankings, 'legacy homeRankings section loaded');
  } finally {
    await fs.rm(legacyDir, {recursive: true, force: true}).catch(() => {});
  }
}

async function main() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bi-resp-completeness-'));
  try {
    await testHttpStreaming(tmpDir);
    await testLargeApiCoreAndLegacy(tmpDir);
    const portalSource = await fs.readFile(new URL('./serve_bi_portal.mjs', import.meta.url), 'utf8');
    assert.match(portalSource, /biPortalCoreSnapshots:\s*\{[\s\S]*?active:\s*snapshotStatus\.active[\s\S]*?retired:\s*snapshotStatus\.retired[\s\S]*?openHandles:\s*snapshotStatus\.openHandles[\s\S]*?closeFailures:\s*snapshotStatus\.closeFailures/u,
      'Portal health must expose active/retired/openHandles/closeFailures snapshot lifecycle gauges');
    console.log('test_bi_response_completeness: passed (HTTP raw Content-Length, gzip decompression, client destroy cleanup, >64MB api core lightweight metadata, legacy small core compatibility)');
  } finally {
    await fs.rm(tmpDir, {recursive: true, force: true}).catch(() => {});
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
