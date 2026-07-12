import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {
  buildOwnerKnowledgeDistribution,
} from '../lib/owner_knowledge_distribution.mjs';
import {
  normalizeOwnerKnowledgeExperience,
  ownerKnowledgeBundleFingerprint,
} from '../lib/owner_knowledge_policy.mjs';
import {
  BI_OPS_CLI_VERSION,
  ensurePartnerKnowledgeCurrent,
} from '../lib/partner_knowledge_cache.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'partner-knowledge-cache-'));
let sourceCommit = 'a'.repeat(40);
let current = true;
let minimumVersion = BI_OPS_CLI_VERSION;
let distributionRevision = 1;
let manifestHits = 0;
let bundleHits = 0;
let responseDelayMs = 0;
let activeRequests = 0;
let maxActiveRequests = 0;

function makePublished(texts) {
  const rules = texts.map(text => normalizeOwnerKnowledgeExperience({text, explicitDurable: true, activation: 'active'}));
  const fingerprint = ownerKnowledgeBundleFingerprint(rules);
  return buildOwnerKnowledgeDistribution({authorityId: 'dushengyi', fingerprint, globalFingerprint: fingerprint, rules});
}

let published = makePublished(['以后所有真实提交必须先预检、确认和回读']);
const server = http.createServer(async (req, res) => {
  activeRequests += 1;
  maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
  try {
    if (responseDelayMs > 0) await new Promise(resolve => setTimeout(resolve, responseDelayMs));
  if (req.url === '/api/owner-knowledge/manifest') {
    manifestHits += 1;
    const etag = `\"${published.manifest.fingerprint}-${sourceCommit}-${current}\"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, {etag});
      res.end();
      return;
    }
    res.writeHead(200, {'content-type': 'application/json', etag});
    res.end(JSON.stringify({ok: true, data: {
      ...published.manifest,
      enabled: true,
      ready: true,
      current,
      source: 'github',
      sourceCommit,
      distributionRevision,
      activeFingerprint: published.manifest.fingerprint,
      cli: {minimumVersion, recommendedVersion: minimumVersion},
    }}));
    return;
  }
  if (req.url === '/api/owner-knowledge/bundle') {
    bundleHits += 1;
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({ok: true, data: {...published.bundle, manifest: {...published.manifest, sourceCommit}}}));
    return;
  }
  res.writeHead(404, {'content-type': 'application/json'});
  res.end(JSON.stringify({ok: false, error: 'not found'}));
  } finally {
    activeRequests -= 1;
  }
});

function runCacheChild({baseUrl, cacheDir}) {
  const moduleUrl = pathToFileURL(path.resolve('lib/partner_knowledge_cache.mjs')).href;
  const childSource = `
    import {ensurePartnerKnowledgeCurrent} from ${JSON.stringify(moduleUrl)};
    const result = await ensurePartnerKnowledgeCurrent({
      baseUrl: process.env.PARTNER_TEST_BASE_URL,
      cookie: 'bi_session=child',
      cacheDir: process.env.PARTNER_TEST_CACHE_DIR,
      strict: true,
      fetchTimeoutMs: 5000,
      lockOptions: {staleMs: 100, heartbeatMs: 25, timeoutMs: 5000},
    });
    process.stdout.write(JSON.stringify(result));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
      cwd: process.cwd(),
      env: {...process.env, PARTNER_TEST_BASE_URL: baseUrl, PARTNER_TEST_CACHE_DIR: cacheDir},
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`partner cache child failed (${code}): ${stderr || stdout}`));
      try { return resolve(JSON.parse(stdout)); } catch (error) { return reject(error); }
    });
  });
}

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
try {
  const first = await ensurePartnerKnowledgeCurrent({baseUrl, cookie: 'bi_session=test', cacheDir: temp, strict: true});
  if (!first.updated || !first.current) throw new Error('first partner knowledge update failed');
  const second = await ensurePartnerKnowledgeCurrent({baseUrl, cookie: 'bi_session=test', cacheDir: temp, strict: true});
  if (second.updated || second.source !== 'cache-304' || bundleHits !== 1) throw new Error('ETag no-op did not reuse the atomic cache');

  published = makePublished(['以后所有真实提交必须先预检、确认和回读', '同事不能覆盖负责人规则']);
  sourceCommit = 'b'.repeat(40);
  distributionRevision += 1;
  const third = await ensurePartnerKnowledgeCurrent({baseUrl, cookie: 'bi_session=test', cacheDir: temp, strict: true});
  if (!third.updated || third.manifest.sourceCommit !== sourceCommit || bundleHits !== 2) throw new Error('changed GitHub rule version was not downloaded');

  current = false;
  let pendingBlocked = false;
  try { await ensurePartnerKnowledgeCurrent({baseUrl, cookie: 'bi_session=test', cacheDir: temp, strict: true}); } catch (error) { pendingBlocked = /正在同步 GitHub/.test(String(error?.message || error)); }
  if (!pendingBlocked) throw new Error('strict task did not stop on a pending GitHub distribution');

  current = true;
  minimumVersion = '2099.01.01.1';
  let oldCliBlocked = false;
  try { await ensurePartnerKnowledgeCurrent({baseUrl, cookie: 'bi_session=test', cacheDir: temp, strict: true}); } catch (error) { oldCliBlocked = /低于最低版本/.test(String(error?.message || error)); }
  if (!oldCliBlocked) throw new Error('minimum CLI version was not enforced');

  const manifestCache = JSON.parse(await fs.readFile(path.join(temp, 'manifest.json'), 'utf8'));
  const bundleCache = JSON.parse(await fs.readFile(path.join(temp, 'generations', manifestCache.generation, 'bundle.json'), 'utf8'));
  if (manifestCache.data.sourceCommit !== sourceCommit || bundleCache.ruleCount !== 2) throw new Error('atomic partner cache contents are inconsistent');

  const concurrentCache = path.join(temp, 'concurrent');
  const oldPublished = makePublished(['旧规则：真实提交前做预检']);
  const newPublished = makePublished(['新规则：真实提交前做预检和回读', '同事不能覆盖负责人规则']);
  const oldCommit = 'c'.repeat(40);
  const newCommit = 'd'.repeat(40);
  const apiManifest = (release, commit, revision) => ({
    ...release.manifest,
    enabled: true,
    ready: true,
    current: true,
    source: 'github',
    sourceCommit: commit,
    distributionRevision: revision,
    activeFingerprint: release.manifest.fingerprint,
    cli: {minimumVersion: BI_OPS_CLI_VERSION, recommendedVersion: BI_OPS_CLI_VERSION},
  });
  const jsonResponse = (body, {etag = ''} = {}) => new Response(JSON.stringify(body), {
    status: 200,
    headers: {'content-type': 'application/json', ...(etag ? {etag} : {})},
  });
  let announceOldManifest;
  const oldManifestStarted = new Promise(resolve => { announceOldManifest = resolve; });
  let releaseOldManifest;
  const oldManifestGate = new Promise(resolve => { releaseOldManifest = resolve; });
  const oldFetch = async url => {
    if (String(url).endsWith('/manifest')) {
      announceOldManifest();
      await oldManifestGate;
      return jsonResponse({ok: true, data: apiManifest(oldPublished, oldCommit, 1)}, {etag: '"old"'});
    }
    return jsonResponse({ok: true, data: {...oldPublished.bundle, manifest: {...oldPublished.manifest, sourceCommit: oldCommit}}});
  };
  const newFetch = async url => {
    if (String(url).endsWith('/manifest')) return jsonResponse({ok: true, data: apiManifest(newPublished, newCommit, 2)}, {etag: '"new"'});
    return jsonResponse({ok: true, data: {...newPublished.bundle, manifest: {...newPublished.manifest, sourceCommit: newCommit}}});
  };
  const lockOptions = {staleMs: 80, heartbeatMs: 20, timeoutMs: 2_000};
  const oldRequest = ensurePartnerKnowledgeCurrent({baseUrl, cookie: 'bi_session=old', cacheDir: concurrentCache, strict: true, fetchImpl: oldFetch, lockOptions, fetchTimeoutMs: 1_000});
  await oldManifestStarted;
  const newRequest = ensurePartnerKnowledgeCurrent({baseUrl, cookie: 'bi_session=new', cacheDir: concurrentCache, strict: true, fetchImpl: newFetch, lockOptions, fetchTimeoutMs: 1_000});
  await new Promise(resolve => setTimeout(resolve, 250));
  releaseOldManifest();
  await Promise.all([oldRequest, newRequest]);
  const concurrentManifest = JSON.parse(await fs.readFile(path.join(concurrentCache, 'manifest.json'), 'utf8'));
  const concurrentBundle = JSON.parse(await fs.readFile(path.join(concurrentCache, 'generations', concurrentManifest.generation, 'bundle.json'), 'utf8'));
  assert.equal(concurrentManifest.data.sourceCommit, newCommit, 'a delayed old request must not roll the cache back over a newer request');
  assert.equal(concurrentManifest.data.distributionRevision, 2);
  assert.equal(concurrentBundle.fingerprint, newPublished.bundle.fingerprint);
  const generations = (await fs.readdir(path.join(concurrentCache, 'generations'))).sort();
  assert.deepEqual(generations, [oldPublished.manifest.bundleSha256, newPublished.manifest.bundleSha256].sort(), 'immutable generations are retained so an obsolete writer cannot delete the active bundle');

  const staleRecoveryCache = path.join(temp, 'stale-recovery');
  await fs.mkdir(staleRecoveryCache, {recursive: true});
  const staleTicketDir = path.join(staleRecoveryCache, '.sync.lock.tickets');
  await fs.mkdir(staleTicketDir, {recursive: true});
  const staleLockFile = path.join(staleTicketDir, '0000000000000-2147483647-dead-cache-lock.json');
  await fs.writeFile(staleLockFile, JSON.stringify({pid: 2147483647, nonce: 'dead-cache-lock', at: '2020-01-01T00:00:00.000Z'}), 'utf8');
  await fs.writeFile(path.join(staleRecoveryCache, '.sync.lock.recovery'), JSON.stringify({pid: 2147483647, nonce: 'orphaned-legacy-recovery'}), 'utf8');
  const staleAt = new Date(Date.now() - 5_000);
  await fs.utimes(staleLockFile, staleAt, staleAt);
  current = true;
  minimumVersion = BI_OPS_CLI_VERSION;
  responseDelayMs = 100;
  maxActiveRequests = 0;
  const childResults = await Promise.all([
    runCacheChild({baseUrl, cacheDir: staleRecoveryCache}),
    runCacheChild({baseUrl, cacheDir: staleRecoveryCache}),
  ]);
  responseDelayMs = 0;
  assert.ok(childResults.every(result => result.ok && result.current), 'both cross-process cache contenders must complete');
  assert.equal(maxActiveRequests, 1, 'stale-lock recovery must not allow concurrent cache fetch writers');
  const recoveredManifest = JSON.parse(await fs.readFile(path.join(staleRecoveryCache, 'manifest.json'), 'utf8'));
  assert.equal(recoveredManifest.data.sourceCommit, sourceCommit);
  await assert.rejects(fs.access(staleLockFile), {code: 'ENOENT'});

  console.log(JSON.stringify({ok: true, manifestHits, bundleHits, sourceCommit, concurrentSourceCommit: concurrentManifest.data.sourceCommit, staleRecoveryMaxActiveRequests: maxActiveRequests}));
} finally {
  await new Promise(resolve => server.close(resolve));
  await fs.rm(temp, {recursive: true, force: true});
}
