#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import {promisify} from 'node:util';
import {Readable} from 'node:stream';

import {__testHooks} from './serve_bi_portal.mjs';
import {writeBiSectionCache} from '../lib/bi_section_cache.mjs';

const gunzipAsync = promisify(zlib.gunzip);
const {
  sendBoundedCoreJson,
  readBiPortalCoreEnvelope,
  resetBiPortalCoreEnvelopeCache,
  biPortalCoreEnvelopeScanCount,
  loadDirectBiQuery,
  biPortalCoreRouteLifecycleStatus,
  resetBiPortalCoreRouteLifecycleState,
  evaluateBiPortalCoreRouteLifecycleHealth,
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

function failingCoreHandle(body) {
  return {
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

  let activeHandles = 0;
  const failureBody = Buffer.from(JSON.stringify({ok: true, generatedAt: gen, payload: 'x'.repeat(64 * 1024)}));
  const server = http.createServer(async (req, res) => {
    let handle;
    try {
      if (req.url === '/fault') {
        await sendBoundedCoreJson(req, res, failingCoreHandle(failureBody), {size: failureBody.length});
        return;
      }
      handle = await fs.open(dataFile, 'r');
      activeHandles += 1;
      const stat = await handle.stat();
      await readBiPortalCoreEnvelope(tmpDir, {handle, stat});
      await sendBoundedCoreJson(req, res, handle, stat, null, {
        'Cache-Control': 'no-cache',
      });
    } catch (err) {
      if (!res.headersSent && !res.writableEnded) {
        res.writeHead(500, {'Content-Type': 'text/plain'});
        res.end(err.message);
      }
    } finally {
      if (handle) {
        await handle.close().catch(() => {});
        activeHandles -= 1;
      }
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

    // Verify handle was closed and no leak
    assert.equal(activeHandles, 0, 'all file handles cleanly closed after abort');

    resetBiPortalCoreRouteLifecycleState();
    await assert.rejects(httpGetBuffer(`http://127.0.0.1:${port}/fault`));
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
    console.log('test_bi_response_completeness: passed (HTTP raw Content-Length, gzip decompression, client destroy cleanup, >64MB api core lightweight metadata, legacy small core compatibility)');
  } finally {
    await fs.rm(tmpDir, {recursive: true, force: true}).catch(() => {});
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
