#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runNode(args, {env = {}} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, ...env},
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', code => resolve({code, stdout, stderr}));
  });
}

function sendJson(response, value, status = 200) {
  response.writeHead(status, {'content-type': 'application/json; charset=utf-8'});
  response.end(JSON.stringify(value));
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function pathExists(file) {
  return await fs.access(file).then(() => true).catch(() => false);
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-bi-p0-'));
let server;
try {
  const calls = [];
  server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    calls.push({path: url.pathname, search: url.search});
    if (url.pathname === '/api/bi/query-data') {
      const requested = String(url.searchParams.get('sections') || '').split(',').filter(Boolean);
      return sendJson(response, {
        ok: true,
        mode: 'direct-bi-data',
        readOnly: true,
        aiInvoked: false,
        question: url.searchParams.get('q') || '',
        generatedAt: '2026-08-22T12:00:00.000Z',
        sections: {requested, loaded: requested, issues: []},
        scope: {mode: 'all_stores', stores: []},
        rowCounts: {},
        data: {dates: {salesDate: '2026-08-22'}},
      });
    }
    if (url.pathname === '/api/owner-knowledge/manifest'
      || url.pathname === '/api/owner-knowledge/bundle'
      || url.pathname === '/api/partner-cli/manifest') {
      return sendJson(response, {ok: false, error: 'refresh endpoint must not be called by read-only query'}, 503);
    }
    return sendJson(response, {ok: false, error: 'unexpected endpoint'}, 404);
  });
  const baseUrl = await listen(server);
  const sessionFile = path.join(tempRoot, 'session.json');
  const outputFile = path.join(tempRoot, 'query.json');
  await fs.writeFile(sessionFile, JSON.stringify({cookie: 'sid=p0-fixture'}), 'utf8');

  const queryRun = await runNode([
    path.join(ROOT, 'scripts', 'bi_ops_cli.mjs'),
    '--base-url', baseUrl,
    '--session-file', sessionFile,
    '--knowledge-cache-dir', path.join(tempRoot, 'knowledge-cache'),
    'query',
    '--text', '读取 P0 回归 fixture',
    '--section', 'linksData',
    '--sections', 'productState,linksData',
    '--sections', 'productState',
    '--out', outputFile,
  ]);
  assert.equal(queryRun.code, 0, queryRun.stderr || queryRun.stdout);
  const compact = JSON.parse(queryRun.stdout);
  const queryEvidence = JSON.parse(await fs.readFile(outputFile, 'utf8'));
  assert.equal(compact.ok, true);
  assert.deepEqual(queryEvidence.sections.requested, ['linksData', 'productState']);
  assert.equal(compact.cli.diagnostics.refreshAttempted, false);
  assert.equal(compact.cli.diagnostics.refreshPolicy, 'read-only-verified-cache');
  assert.equal(calls.filter(call => call.path === '/api/bi/query-data').length, 1);
  assert.equal(calls.some(call => call.path === '/api/owner-knowledge/manifest'), false);
  assert.equal(calls.some(call => call.path === '/api/owner-knowledge/bundle'), false);
  assert.equal(calls.some(call => call.path === '/api/partner-cli/manifest'), false);

  const captureOut = path.join(tempRoot, 'capture-out');
  const captureRun = await runNode([
    path.join(ROOT, 'scripts', 'capture_ops_runtime_snapshot.mjs'),
    '--out-dir', captureOut,
    '--root', ROOT,
  ], {
    env: process.platform === 'linux' ? {PATH: ''} : {},
  });
  assert.equal(captureRun.code, 1, captureRun.stderr || captureRun.stdout);
  assert.match(captureRun.stderr, /Linux|systemctl|CLOUD_RUNTIME_SNAPSHOT/u);
  assert.equal(await pathExists(captureOut), false, 'unsupported runtime must not write an unknown-unit snapshot');

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'section_alias_composition_and_deduplication',
      'query_skips_network_refresh_and_reports_nonblocking_diagnostics',
      'runtime_snapshot_capture_fails_fast_without_linux_systemctl',
    ],
  }, null, 2));
} finally {
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  await fs.rm(tempRoot, {recursive: true, force: true});
}
