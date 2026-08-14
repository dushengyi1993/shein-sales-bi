#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';

import {
  BoundedTopLevelJsonError,
  scanBoundedTopLevelJson,
  streamFileHandleWithReplacement,
} from '../lib/bounded_top_level_json.mjs';
import {overlayCurrentProductReconciliationAudit} from '../lib/bi_live_core_health.mjs';
import {__testHooks} from './serve_bi_portal.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bi-core-stream-'));

async function scanText(text, limits = {generatedAt: 1024, __sections: 4096, audit: 4096}) {
  async function* chunks() {
    const bytes = Buffer.from(text, 'utf8');
    for (let index = 0; index < bytes.length; index += 7) yield bytes.subarray(index, index + 7);
  }
  return scanBoundedTopLevelJson(chunks(), limits);
}

async function collect(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

try {
  const generatedAt = '2026-08-14T18:24:25.257518+08:00';
  const original = {
    payload: [{text: 'quoted \\" value'}, {nested: [1, 2, {ok: true}]}],
    generatedAt,
    __sections: {mode: 'api', generatedAt},
    audit: {
      ok: true,
      warnings: 2,
      warningMessages: ['DL 店商品对账需处理：旧提醒', '其他提醒必须保留'],
    },
    tail: '保留中文与 emoji ✅',
  };
  const pretty = `${JSON.stringify(original, null, 2)}\n`;
  const scan = await scanText(pretty);
  assert.equal(scan.byteLength, Buffer.byteLength(pretty));
  assert.equal(scan.fields.generatedAt.value, generatedAt);
  assert.deepEqual(scan.fields.__sections.value, original.__sections);
  assert.deepEqual(scan.fields.audit.value, original.audit);

  const evidence = {
    fresh: true,
    summary: {
      ok: true,
      generatedAt: '2026-08-14T11:30:00.000Z',
      reportScope: {complete: true, expectedStores: ['DL']},
      counts: {total: 1, succeeded: 1, failed: 0},
      results: [{
        storeKey: 'DL', ok: true, status: 'matched',
        semanticReconciliation: {status: 'matched', counts: {stockMissing: 0}, warnings: []},
      }],
    },
  };
  const expected = overlayCurrentProductReconciliationAudit(original, evidence, {
    expectedStores: ['DL'],
    nowMs: Date.parse('2026-08-14T12:00:00.000Z'),
  });
  const plan = __testHooks.buildBiPortalCoreStreamPlan({
    generatedAt,
    audit: original.audit,
    auditRange: {start: scan.fields.audit.start, end: scan.fields.audit.end},
  }, evidence, {
    expectedStores: ['DL'],
    nowMs: Date.parse('2026-08-14T12:00:00.000Z'),
  });
  assert.equal(plan.overlayApplied, true);
  assert.deepEqual(plan.audit, expected.audit, 'bounded overlay must preserve the full-core audit semantics');
  assert.throws(() => __testHooks.buildBiPortalCoreStreamPlan({
    generatedAt,
    audit: original.audit,
    auditRange: null,
  }, evidence, {
    expectedStores: ['DL'],
    nowMs: Date.parse('2026-08-14T12:00:00.000Z'),
  }), error => error?.code === 'BI_CORE_AUDIT_MISSING');

  const coreFile = path.join(temp, 'data.json');
  await fs.writeFile(coreFile, pretty);
  const handle = await fs.open(coreFile, 'r');
  try {
    const stat = await handle.stat();
    const replaced = await collect(streamFileHandleWithReplacement(handle, stat, {
      start: scan.fields.audit.start,
      end: scan.fields.audit.end,
      value: JSON.stringify(plan.audit),
    }));
    assert.deepEqual(JSON.parse(replaced.toString('utf8')), expected);
  } finally {
    await handle.close();
  }

  const gzipServer = http.createServer(async (req, res) => {
    const requestHandle = await fs.open(coreFile, 'r');
    try {
      await __testHooks.sendBoundedCoreJson(req, res, requestHandle, await requestHandle.stat(), {
        start: scan.fields.audit.start,
        end: scan.fields.audit.end,
        value: JSON.stringify(plan.audit),
      }, {'Cache-Control': 'private, no-cache, must-revalidate'});
    } finally {
      await requestHandle.close().catch(() => {});
    }
  });
  await new Promise(resolve => gzipServer.listen(0, '127.0.0.1', resolve));
  try {
    const address = gzipServer.address();
    const response = await new Promise((resolve, reject) => {
      const request = http.get({host: '127.0.0.1', port: address.port, path: '/', headers: {'Accept-Encoding': 'gzip'}}, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({headers: res.headers, body: Buffer.concat(chunks)}));
      });
      request.on('error', reject);
    });
    assert.equal(response.headers['content-encoding'], 'gzip');
    assert.deepEqual(JSON.parse(gunzipSync(response.body).toString('utf8')), expected);
  } finally {
    await new Promise(resolve => gzipServer.close(resolve));
  }

  await assert.rejects(
    scanText('{"audit":null,"audit":{}}', {audit: 1024}),
    error => error instanceof BoundedTopLevelJsonError && error.code === 'DUPLICATE_FIELD',
  );
  await assert.rejects(
    scanText('{"audit":{"message":"too large"}}', {audit: 8}),
    error => error instanceof BoundedTopLevelJsonError && error.code === 'FIELD_TOO_LARGE',
  );
  await assert.rejects(
    scanText('{"generatedAt":"2026-08-14', {generatedAt: 1024}),
    error => error instanceof BoundedTopLevelJsonError && error.code === 'TRUNCATED_JSON',
  );
  for (const invalid of [
    '{"generatedAt":"2026-08-14T00:00:00.000Z","corrupt":truX}',
    '{"generatedAt":"2026-08-14T00:00:00.000Z","nested":{"bad":[1,]}}',
    '{"generatedAt":"2026-08-14T00:00:00.000Z","bad":"\\q"}',
    '{"generatedAt":"2026-08-14T00:00:00.000Z","number":01}',
  ]) {
    await assert.rejects(
      scanText(invalid, {generatedAt: 1024}),
      error => error instanceof BoundedTopLevelJsonError && error.code === 'INVALID_JSON_SYNTAX',
    );
  }
  const scalarScan = await scanText(
    '{"generatedAt":"2026-08-14T00:00:00.000Z","values":[true,false,null,-12.5e+3]}',
    {generatedAt: 1024},
  );
  assert.equal(scalarScan.fields.generatedAt.value, '2026-08-14T00:00:00.000Z');

  __testHooks.resetBiPortalCoreEnvelopeCache();
  const cacheRoot = path.join(temp, 'cache');
  await fs.mkdir(cacheRoot);
  const cacheFile = path.join(cacheRoot, 'data.json');
  await fs.writeFile(cacheFile, JSON.stringify({generatedAt, __sections: {mode: 'api'}, audit: null, payload: 'a'}));
  const first = await __testHooks.readBiPortalCoreEnvelope(cacheRoot);
  assert.equal(first.generatedAt, generatedAt);
  assert.equal(first.mode, 'api');
  const nextGeneratedAt = '2026-08-14T18:25:25.257518+08:00';
  await fs.writeFile(cacheFile, JSON.stringify({generatedAt: nextGeneratedAt, audit: null, payload: 'longer replacement'}));
  const second = await __testHooks.readBiPortalCoreEnvelope(cacheRoot);
  assert.equal(second.generatedAt, nextGeneratedAt, 'file identity change must invalidate the envelope cache');
  assert.equal(second.mode, 'legacy');

  const portalSource = await fs.readFile(new URL('./serve_bi_portal.mjs', import.meta.url), 'utf8');
  const dataRoute = portalSource.slice(portalSource.indexOf("url.pathname === '/data.json'"), portalSource.indexOf("let file = safePath", portalSource.indexOf("url.pathname === '/data.json'")));
  assert.match(dataRoute, /buildBiPortalCoreStreamPlan[\s\S]*sendBoundedCoreJson/);
  assert.doesNotMatch(dataRoute, /JSON\.parse\s*\(\s*await fs\.readFile/);

  const largeFile = path.join(temp, 'large.json');
  await fs.writeFile(largeFile, `{"generatedAt":${JSON.stringify(generatedAt)},"payload":"`);
  const oneMiB = 'x'.repeat(1024 * 1024);
  for (let index = 0; index < 12; index += 1) await fs.appendFile(largeFile, oneMiB);
  await fs.appendFile(largeFile, '","audit":null}');
  const childCode = `
    import fs from 'node:fs';
    import {scanBoundedTopLevelJson} from ${JSON.stringify(new URL('../lib/bounded_top_level_json.mjs', import.meta.url).href)};
    const scan = await scanBoundedTopLevelJson(fs.createReadStream(process.env.TEST_CORE_FILE), {generatedAt: 4096, audit: 4096});
    if (!scan.fields.generatedAt?.value || scan.fields.audit?.value !== null) process.exit(2);
  `;
  const child = spawnSync(process.execPath, ['--max-old-space-size=16', '--input-type=module', '--eval', childCode], {
    env: {...process.env, TEST_CORE_FILE: largeFile},
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(child.status, 0, `bounded scanner must survive a 12MiB core under a 16MiB old-space cap: ${child.stderr}`);

  console.log(JSON.stringify({ok: true, tests: 27}));
} finally {
  await fs.rm(temp, {recursive: true, force: true});
}
