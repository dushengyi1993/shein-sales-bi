#!/usr/bin/env node
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildPartnerCliRelease} from '../lib/partner_cli_release.mjs';
import {checkAndInstallPartnerCliUpdate} from '../lib/partner_cli_updater.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = await buildPartnerCliRelease({sourceRoot: ROOT});
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'partner-cli-updater-'));
const installRoot = path.join(temp, 'cli');
const codexHome = path.join(temp, 'codex');
const oldVersion = '2026.07.12.1';
const oldEntrypoint = path.join(installRoot, 'versions', oldVersion, 'scripts', 'bi_ops_cli.mjs');
await fs.mkdir(path.dirname(oldEntrypoint), {recursive: true});
await fs.writeFile(oldEntrypoint, 'console.log("old")\n', 'utf8');
await fs.writeFile(path.join(installRoot, 'current.json'), `${JSON.stringify({version: oldVersion, entrypoint: oldEntrypoint})}\n`, 'utf8');

const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const value = probe.address().port;
    probe.close(() => resolve(value));
  });
});
let manifestCalls = 0;
let bundleCalls = 0;
const server = http.createServer((req, res) => {
  if (!String(req.headers.cookie || '').includes('bi_session=test')) {
    res.writeHead(401, {'content-type': 'text/plain; charset=utf-8'});
    res.end('Unauthorized');
    return;
  }
  if (req.url === '/api/partner-cli/manifest') {
    manifestCalls += 1;
    res.writeHead(200, {'content-type': 'application/json', etag: `"pcli-${release.manifest.bundleSha256}"`});
    res.end(JSON.stringify({ok: true, data: release.manifest}));
    return;
  }
  if (req.url === '/api/partner-cli/bundle') {
    bundleCalls += 1;
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({ok: true, data: release.bundle}));
    return;
  }
  res.writeHead(404, {'content-type': 'application/json'});
  res.end(JSON.stringify({ok: false, error: 'not found'}));
});

const checks = [];
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : actual === expected;
  checks.push({label, actual, expected: typeof expected === 'function' ? 'predicate' : expected, pass});
}

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  let expiredError = null;
  try {
    await checkAndInstallPartnerCliUpdate({
      baseUrl: `http://127.0.0.1:${port}`,
      cookie: 'bi_session=expired',
      currentVersion: oldVersion,
      installRoot,
      codexHome,
    });
  } catch (error) {
    expiredError = error;
  }
  check('plain-text 401 has stable error code', expiredError?.code, 'BI_SESSION_EXPIRED');
  check('plain-text 401 keeps HTTP status', expiredError?.status, 401);
  check('plain-text 401 asks for BI login', expiredError?.message, text => text.includes('BI 登录已失效') && text.includes('login --username'));
  check('plain-text 401 is not mislabeled invalid JSON', expiredError?.message, text => !text.includes('invalid JSON'));

  const updated = await checkAndInstallPartnerCliUpdate({
    baseUrl: `http://127.0.0.1:${port}`,
    cookie: 'bi_session=test',
    currentVersion: oldVersion,
    installRoot,
    codexHome,
  });
  check('update installed', updated.updated, true);
  check('latest version selected', updated.latestVersion, release.manifest.version);
  check('manifest requested once', manifestCalls, 1);
  check('bundle requested once', bundleCalls, 1);
  const current = JSON.parse(await fs.readFile(path.join(installRoot, 'current.json'), 'utf8'));
  check('current pointer switched', current.version, release.manifest.version);
  check('current pointer has bundle hash', current.bundleSha256, release.manifest.bundleSha256);
  check('new entrypoint exists', Boolean(await fs.stat(current.entrypoint)), true);
  check('stable bootstrap installed', Boolean(await fs.stat(path.join(installRoot, 'bootstrap.mjs'))), true);
  const skill = await fs.readFile(path.join(codexHome, 'skills', 'shein-bi-ops', 'SKILL.md'), 'utf8');
  check('Codex skill installed', skill, text => text.includes('已审可用') && text.includes('prepare-publish'));

  const freshCachedCheck = await checkAndInstallPartnerCliUpdate({
    baseUrl: `http://127.0.0.1:${port}`,
    cookie: 'bi_session=test',
    currentVersion: release.manifest.version,
    installRoot,
    codexHome,
    maxAgeMs: 5 * 60_000,
  });
  check('fresh update check uses local TTL cache', freshCachedCheck.source, 'fresh-check-cache');
  check('fresh update check makes no manifest request', manifestCalls, 1);

  const currentCheck = await checkAndInstallPartnerCliUpdate({
    baseUrl: `http://127.0.0.1:${port}`,
    cookie: 'bi_session=test',
    currentVersion: release.manifest.version,
    installRoot,
    codexHome,
    force: true,
  });
  check('current release is not reinstalled', currentCheck.updated, false);
  check('bundle not downloaded twice', bundleCalls, 1);

  await fs.writeFile(path.join(installRoot, 'current.json'), `${JSON.stringify({version: oldVersion, entrypoint: oldEntrypoint})}\n`, 'utf8');
  const peerFetch = async (url, options) => {
    const response = await fetch(url, options);
    if (String(url).endsWith('/api/partner-cli/manifest')) {
      await fs.writeFile(path.join(installRoot, 'current.json'), `${JSON.stringify(current)}\n`, 'utf8');
    }
    return response;
  };
  const peerAdvanced = await checkAndInstallPartnerCliUpdate({
    baseUrl: `http://127.0.0.1:${port}`,
    cookie: 'bi_session=test',
    currentVersion: oldVersion,
    installRoot,
    codexHome,
    force: true,
    fetchImpl: peerFetch,
  });
  check('peer-installed release relaunches old process', peerAdvanced.updated, true);
  check('peer-installed release reports peer source', peerAdvanced.source, 'updated-by-peer');
  check('peer-installed release returns current entrypoint', peerAdvanced.entrypoint, current.entrypoint);
  check('peer-installed release does not redownload bundle', bundleCalls, 1);
} finally {
  await new Promise(resolve => server.close(resolve));
  const ok = checks.every(row => row.pass);
  console.log(JSON.stringify({ok, checks}, null, 2));
  if (ok) await fs.rm(temp, {recursive: true, force: true});
  else process.exitCode = 1;
}
