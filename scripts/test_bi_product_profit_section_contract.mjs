#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = fs.readFileSync(path.join(root, 'scripts', 'serve_bi_portal.mjs'), 'utf8');
const client = fs.readFileSync(path.join(root, 'scripts', 'bi_app', 'client.js'), 'utf8');

// ---- Server: productProfit is a request-state branch, never a cache section.
assert.doesNotMatch(server, /BI_PORTAL_SECTION_KEYS = new Set\([^)]*productProfit/,
  'productProfit must stay outside BI_PORTAL_SECTION_KEYS so warmup/prewarm/queue can never select it');
assert.match(server, /if \(section === 'productProfit'\) \{\r?\n\s*\/\/ Request-state productProfit[\s\S]*return loadBiProductProfitSection\(args, root, options\);/,
  'loadBiSection must route productProfit to its request-state branch before the generic cache/queue flow');

const productSectionStart = server.indexOf('async function loadBiProductProfitSection');
const productSectionEnd = server.indexOf('\nasync function refreshProfitMarts', productSectionStart);
assert.ok(productSectionStart > 0 && productSectionEnd > productSectionStart, 'loadBiProductProfitSection must exist');
const productSection = server.slice(productSectionStart, productSectionEnd);

assert.match(productSection, /const q = String\(options\.q \|\| ''\)\.trim\(\);/,
  'productProfit q must be trimmed before validation');
assert.match(productSection, /if \(!q\) \{[\s\S]*status: 400/,
  'productProfit without q must fail closed with 400');
assert.match(productSection, /if \(q\.length > 64\) \{[\s\S]*status: 400/,
  'productProfit q longer than 64 characters must fail closed instead of being silently truncated');
assert.doesNotMatch(productSection, /writeBiSectionCache/,
  'productProfit must never persist a runtime cache file');
assert.doesNotMatch(productSection, /readBiSectionCacheAnyGeneratedAt/,
  'productProfit must never read an older-generation profit cache');
assert.doesNotMatch(productSection, /enqueueHostLockedBiSection\(args, root, 'productProfit'|scheduleBiSectionBackgroundGeneration\(args, root, 'productProfit'/,
  'productProfit must never enqueue itself into the external section queue');
assert.match(productSection, /scheduleBiSectionBackgroundGeneration\(args, root, 'profit', generatedAt, \{\s*priority: '5',/,
  'a missing current profit cache must enqueue the profit dependency ahead of ordinary owner-visible sections');
assert.match(productSection, /pendingSection: true[\s\S]*refreshScheduled: Boolean\(refreshScheduled\)/,
  'without a current profit cache productProfit must return a pending, non-success state');
assert.match(productSection, /if \(options\.allowGenerate === false\) \{[\s\S]*status: 503[\s\S]*generation is disabled/,
  'read-only mode must not enqueue a missing productProfit dependency');
assert.match(server, /function buildBiProductProfitIndex\(profitCache, cacheKey = '', productDisplayNames = \{\}\) \{[\s\S]*dailyStoreProducts[\s\S]*byProduct\.set\(code,[\s\S]*cacheKey,[\s\S]*generatedAt: String\(profitCache\.generatedAt \|\| ''\),/,
  'the in-memory index is keyed by the exact profit cache generation and replaced on change');
assert.match(server, /async function readBiSectionArtifactIdentity\(root, section\)[\s\S]*generatedAt[\s\S]*cachedAt[\s\S]*mtimeMs[\s\S]*cacheKey/,
  'the in-memory index key must isolate the root, generation, and exact published artifact revision');
assert.match(server, /biProductProfitIndexPromise\?\.cacheKey !== cacheKey[\s\S]*if \(previous\) await previous;[\s\S]*if \(index\?\.cacheKey === cacheKey\) return index;[\s\S]*retry < 1 \? loadCurrentBiProductProfitIndex/,
  'generation changes must serialize large parses without reusing older rows');
assert.doesNotMatch(server, /function buildBiProductProfitIndex[\s\S]{0,1400}monthGroups|function buildBiProductProfitIndex[\s\S]{0,1400}storeStorageDaily/,
  'the index must not retain monthGroups/products/storage profit payloads');
assert.match(productSection, /const hasActor = Boolean\(options\.actor[\s\S]*normalizeStoreList\(hasActor \? options\.actor\.readStores \|\| \[\] : \[\]\)[\s\S]*!hasActor \|\| allowedStores\.includes\('\*'\)[\s\S]*row\.store_key/,
  'productProfit must distinguish no-auth mode from an authenticated actor with an empty readStores scope');
assert.match(productSection, /productProfit: \{\s*rows,\s*sourceGeneratedAt: index\.generatedAt,\s*staleSource: false,\s*\}/,
  'the response carries only matching dailyStoreProducts plus sourceGeneratedAt/staleSource=false');
assert.doesNotMatch(productSection, /data: \{[\s\S]*monthGroups|data: \{[\s\S]*'products'|data: \{[\s\S]*storage/,
  'the productProfit response must never include the large monthGroups/products/storage arrays');

// ---- Server: homeProfit is fail-closed against stale sources.
assert.match(server, /const currentProfitCache = await readBiSectionCache\(root, 'profit', generatedAt\);[\s\S]*if \(!isCurrentProfitSectionCache\(currentProfitCache, generatedAt\)\) return null;/,
  'deriveHomeProfitSectionFromProfitCache must read only the current-generation profit cache');
assert.doesNotMatch(server, /deriveHomeProfitSectionFromProfitCache[\s\S]{0,400}readBiSectionCacheAnyGeneratedAt/,
  'deriveHomeProfitSectionFromProfitCache must not fall back to anyGeneratedAt');
assert.match(server, /const sourceFresh = Boolean\([\s\S]*cachedSourceGeneratedAt === String\(meta\.generatedAt \|\| ''\)[\s\S]*cachedSummary\?\.staleSource === false[\s\S]*Array\.isArray\(cachedSummary\?\.dailyScopes\)/,
  'homeProfit serves 200 only when the cached summary is structurally complete and backed by the exact current generation');
assert.match(server, /const existingIsTerminal = section === 'profit'[\s\S]*isCurrentProfitSectionCache\(existingCache, generatedAt\)[\s\S]*existingHomeProfit\?\.staleSource === false[\s\S]*Array\.isArray\(existingHomeProfit\?\.dailyScopes\)/,
  'core warmup must not mark malformed profit or homeProfit caches as already warm');
assert.match(server, /const ok = result\?\.status === 200;/,
  'core warmup must not mark a queued 202 or another non-terminal 2xx response as warm');
assert.doesNotMatch(server, /cachedSourceGeneratedAt !== String\(meta\.generatedAt \|\| ''\)\) \{[\s\S]*status: 200/,
  'an old-source homeProfit cache must never be served as a current 200');
assert.match(server, /scheduleBiSectionBackgroundGeneration\(args, root, 'profit', meta\.generatedAt, \{\s*priority: '5',\s*reason: `homeProfit-needs-profit-/,
  'homeProfit without a current profit cache must enqueue its dependency ahead of homeProfit');
assert.match(server, /if \(force \|\| options\.hostLockedWorker === true\) \{[\s\S]*status: 503[\s\S]*error: 'homeProfit requires a current profit section cache/,
  'host-locked/force homeProfit without current profit must fail with 503');
assert.match(server, /status: 202,[\s\S]*error: 'homeProfit requires a current profit section cache/,
  'a normal homeProfit request without current profit must return 202 pending instead of stale data');

// ---- Server: the HTTP route passes q and actor into the section loader.
assert.match(server, /const q = String\(url\.searchParams\.get\('q'\) \|\| ''\)\.trim\(\);/,
  'the section route must pass the full trimmed q so the loader can reject overlong input');
assert.match(server, /gzip: acceptsGzip\(req\.headers\['accept-encoding'\]\),[\s\S]*q,[\s\S]*actor,/,
  'the section route must forward q and the authenticated actor for readStores filtering');

// ---- Client: q drives productProfit; home never downloads the full profit section.
assert.match(client, /homeNeeds\(\)\{const ns=new Set\(BASE_NEED\.home\);ns\.add\('priceScatter'\);if\(S\.q\|\|S\.trendMetric==='profit'\)ns\.add\(S\.q\?'productProfit':'homeProfit'\)/,
  'home needs must map q to productProfit and no-q profit trends to homeProfit');
assert.doesNotMatch(client, /homeNeeds\(\)\{[\s\S]{0,220}ns\.add\('profit'\)/,
  'home must never request the full profit section');
assert.match(client, /productProfit:\['productProfit'\]/, 'SECTION_DATA_KEYS must sync productProfit');
assert.match(client, /productProfit:'货号利润'/, 'the section label map must include productProfit');
assert.match(client, /function profits\(\)\{return F\(D\.productProfit\?\.rows\|\|\[\]\)\}/,
  'product-scoped profit rows must come only from the productProfit response');
assert.match(client, /profitState=sourceState\(String\(S\.q\|\|''\)\.trim\(\)\?'productProfit':'homeProfit'\,p\.rows\)/,
  'the home profit KPI state must key off productProfit when q is set');
assert.match(client, /src:String\(S\.q\|\|''\)\.trim\(\)\?'productProfit':'homeProfit'/,
  'profit summaries must report productProfit as their source when q is set');
assert.match(client, /needed=metric==='profit'\?\(String\(S\.q\|\|''\)\.trim\(\)\?'productProfit':'homeProfit'\)/,
  'profit trend panels must load productProfit when q is set');
assert.match(client, /n==='productProfit'\?path\+'\?q='\+encodeURIComponent\(currentQ\(\)\):path/,
  'file-mode productProfit URLs must carry q');
assert.match(client, /if\(n==='productProfit'&&currentQ\(\)\)params\.set\('q',currentQ\(\)\)/,
  'API-mode productProfit requests must carry q in the URL');

// ---- Client: P/SS are isolated by q; late responses for an old q never land.
assert.match(client, /function currentQ\(\)\{return String\(S\.q\|\|''\)\.trim\(\)\.slice\(0,64\)\}/,
  'client q must be trimmed and capped at 64 characters');
assert.match(client, /function sectionPromiseKey\(n\)\{return n==='productProfit'\?productProfitScopeKey\(\):n\}/,
  'in-flight promises must be keyed per q for productProfit');
assert.match(client, /function sectionStateKey\(n\)\{return n==='productProfit'\?'productProfit':n\}/,
  'the visible section state stays under the productProfit name');
assert.match(client, /if\(n==='productProfit'&&!force&&productProfitScopeChanged\(prev\?\.q\)\)\{clearSectionRecheck\(n\);clearSectionPayload\(n\);prev=\{\}\}/,
  'a q change must drop the previous state and payload before a new request');
assert.match(client, /if\(n==='productProfit'&&productProfitScopeChanged\(requestQ\)\)return true;/,
  'a late response for an old q must not merge or overwrite the current q');
assert.match(client, /if\(n==='productProfit'&&productProfitScopeChanged\(requestQ\)\)return false;/,
  'a late failure for an old q must not mark the current q as failed');

// ---- Client: functional checks of the q-scope helpers and homeNeeds mapping.
const sourceLines = client.split(/\r?\n/);
const functionLine = name => sourceLines.find(line => line.startsWith(`function ${name}(`)) || '';
const helperSource = [
  functionLine('currentQ'),
  functionLine('productProfitScopeKey'),
  functionLine('sectionPromiseKey'),
  functionLine('sectionStateKey'),
  functionLine('productProfitScopeChanged'),
  functionLine('homeNeeds'),
].join('\n');
assert.ok(helperSource.includes('function currentQ(') && helperSource.includes('function homeNeeds('), 'q-scope helpers must be extractable');
const runtime = Function('S', `
  const BASE_NEED={home:['homeRankings','afterSales','homeProfit','homeTrafficDaily','liveSalesToday']};
  ${helperSource}
  return {homeNeeds, currentQ, productProfitScopeKey, sectionPromiseKey, sectionStateKey, productProfitScopeChanged};
`);
{
  const state = {q:'abc', trendMetric:'sales'};
  const r = runtime(state);
  const needs = r.homeNeeds();
  assert.ok(needs.includes('productProfit'), 'q must request productProfit');
  assert.ok(!needs.includes('profit'), 'q must never request the full profit section');
  assert.ok(needs.includes('homeProfit'), 'the small homeProfit baseline stays on the homepage');
}
{
  const state = {q:'', trendMetric:'profit'};
  const needs = runtime(state).homeNeeds();
  assert.ok(needs.includes('homeProfit'), 'no-q profit trend must use homeProfit');
  assert.ok(!needs.includes('productProfit') && !needs.includes('profit'), 'no-q home must not request productProfit or profit');
}
{
  const state = {q:'  货号-001  ', trendMetric:'sales'};
  const r = runtime(state);
  assert.equal(r.currentQ(), '货号-001', 'currentQ must trim q');
  assert.equal(r.sectionPromiseKey('productProfit'), 'productProfit|货号-001', 'promises must be keyed by trimmed q');
  assert.equal(r.sectionStateKey('productProfit'), 'productProfit', 'state stays under the plain section name');
  assert.equal(r.productProfitScopeChanged('old-q'), true, 'a different q is a scope change');
  assert.equal(r.productProfitScopeChanged('货号-001'), false, 'the same q is not a scope change');
  state.q = 'x'.repeat(80);
  assert.equal(r.currentQ().length, 64, 'currentQ must cap at 64 characters');
}

// ---- Runtime HTTP contract: scoped rows, bounded payload, no request cache.
const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'shein-bi-product-profit-'));
const portalDir = path.join(temp, 'portal');
const sectionsDir = path.join(portalDir, 'sections');
const generatedAt = '2026-08-11T08:36:30.27274+08:00';
const authFile = path.join(temp, 'users.json');
const port = await freePort();
await fs.promises.mkdir(sectionsDir, {recursive: true});
await fs.promises.writeFile(path.join(portalDir, 'index.html'), '<!doctype html><title>test</title>');
await fs.promises.writeFile(path.join(portalDir, 'data.json'), JSON.stringify({
  generatedAt,
  __sections: {mode: 'api', generatedAt},
}));
await fs.promises.writeFile(path.join(sectionsDir, 'profit.json'), JSON.stringify({
  ok: true,
  section: 'profit',
  generatedAt,
  cachedAt: '2026-08-11T02:56:46.613Z',
  data: {profit: {
    dailyStoreProducts: [
      {date: '2026-08-10', store_key: 'JSH', standard_goods_sn: 'ABC-100', net_revenue_sar: 100, known_net_revenue_sar: 100, profit_after_storage_sar: 25},
      {date: '2026-08-10', store_key: 'DL', standard_goods_sn: 'ABC-100', net_revenue_sar: 200, known_net_revenue_sar: 200, profit_after_storage_sar: 50},
      {date: '2026-08-10', store_key: 'JSH', standard_goods_sn: 'XYZ-200', net_revenue_sar: 300, known_net_revenue_sar: 300, profit_after_storage_sar: 75},
      ...Array.from({length: 9}, (_, index) => ({date: '2026-08-10', store_key: 'JSH', standard_goods_sn: `BROAD-${index + 1}`, net_revenue_sar: 1})),
    ],
    monthGroups: [{sentinel: 'must-not-leak'}],
    products: [{sentinel: 'must-not-leak'}],
    productStorageDaily: [{sentinel: 'must-not-leak'}],
    productStoreStorageDaily: [{sentinel: 'must-not-leak'}],
    storeStorageDaily: [],
  }},
}));
await fs.promises.writeFile(path.join(sectionsDir, 'homeProfit.json'), JSON.stringify({
  ok: true,
  section: 'homeProfit',
  generatedAt,
  cachedAt: '2026-08-11T02:14:03.722Z',
  data: {homeProfitSummary: {dailyScopes: [], sourceGeneratedAt: '2026-08-10T19:09:04.52205+08:00', staleSource: true}},
}));
await fs.promises.writeFile(authFile, JSON.stringify({users: [
  {username: 'scoped-test', password: 'correct-password', role: 'admin', readStores: ['JSH']},
  {username: 'empty-test', password: 'correct-password', role: 'admin', readStores: []},
]}));

const isolatedPortalEnv = {
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

const child = spawn(process.execPath, [
  path.join(root, 'scripts', 'serve_bi_portal.mjs'),
  '--host', '127.0.0.1', '--port', String(port), '--dir', portalDir,
  '--auth-file', authFile, '--htpasswd-file', path.join(temp, 'missing.htpasswd'),
  '--session-secret-file', path.join(temp, 'session-secret'), '--state-file', path.join(temp, 'state.json'),
  '--link-ops-task-file', path.join(temp, 'tasks.json'), '--link-ops-chat-file', path.join(temp, 'chats.json'),
  '--manual-login-state-file', path.join(temp, 'manual-login.json'), '--audit-file', path.join(temp, 'audit.jsonl'),
], {
  cwd: root,
  env: isolatedPortalEnv,
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
try {
  const base = `http://127.0.0.1:${port}`;
  await waitForServer(base, child, () => stderr);
  const scopedCookie = await login(base, 'scoped-test');
  const scopedResponse = await fetch(`${base}/api/bi/section/productProfit?q=ABC-100`, {headers: {cookie: scopedCookie}});
  assert.equal(scopedResponse.status, 200);
  const scopedPayload = await scopedResponse.json();
  assert.equal(scopedPayload.generatedAt, generatedAt);
  assert.equal(scopedPayload.data.productProfit.sourceGeneratedAt, generatedAt);
  assert.equal(scopedPayload.data.productProfit.staleSource, false);
  assert.deepEqual(scopedPayload.data.productProfit.rows.map(row => row.store_key), ['JSH']);
  assert.deepEqual(Object.keys(scopedPayload.data.productProfit).sort(), ['rows', 'sourceGeneratedAt', 'staleSource']);
  assert.equal(fs.existsSync(path.join(sectionsDir, 'productProfit.json')), false, 'request-state productProfit must not write a section cache');

  const rewrittenProfit = JSON.parse(await fs.promises.readFile(path.join(sectionsDir, 'profit.json'), 'utf8'));
  rewrittenProfit.cachedAt = '2026-08-11T03:20:00.000Z';
  rewrittenProfit.data.profit.dailyStoreProducts[0].net_revenue_sar = 999;
  await fs.promises.writeFile(path.join(sectionsDir, 'profit.json'), JSON.stringify(rewrittenProfit));
  const rewrittenResponse = await fetch(`${base}/api/bi/section/productProfit?q=ABC-100`, {headers: {cookie: scopedCookie}});
  assert.equal(rewrittenResponse.status, 200);
  const rewrittenRows = (await rewrittenResponse.json()).data.productProfit.rows;
  assert.equal(rewrittenRows[0].net_revenue_sar, 999, 'same-generation profit rewrites must invalidate the in-memory index');

  const emptyCookie = await login(base, 'empty-test');
  const emptyResponse = await fetch(`${base}/api/bi/section/productProfit?q=ABC-100`, {headers: {cookie: emptyCookie}});
  assert.equal(emptyResponse.status, 200);
  assert.deepEqual((await emptyResponse.json()).data.productProfit.rows, [], 'an authenticated empty readStores scope must not become all stores');

  const tooLong = await fetch(`${base}/api/bi/section/productProfit?q=${'x'.repeat(65)}`, {headers: {cookie: scopedCookie}});
  assert.equal(tooLong.status, 400, 'overlong q must be rejected');
  const tooBroad = await fetch(`${base}/api/bi/section/productProfit?q=BROAD-`, {headers: {cookie: scopedCookie}});
  assert.equal(tooBroad.status, 422, 'a broad query must fail instead of returning an unbounded profit payload');

  const homeProfitResponse = await fetch(`${base}/api/bi/section/homeProfit`, {headers: {cookie: scopedCookie}});
  assert.equal(homeProfitResponse.status, 200);
  const homeProfitPayload = await homeProfitResponse.json();
  assert.equal(homeProfitPayload.data.homeProfitSummary.sourceGeneratedAt, generatedAt);
  assert.equal(homeProfitPayload.data.homeProfitSummary.staleSource, false);

  await fs.promises.writeFile(path.join(portalDir, 'data.json'), JSON.stringify({generatedAt: '', __sections: {mode: 'api', generatedAt: ''}}));
  assert.equal((await fetch(`${base}/api/bi/section/productProfit?q=ABC-100`, {headers: {cookie: scopedCookie}})).status, 503);
  assert.equal((await fetch(`${base}/api/bi/section/homeProfit`, {headers: {cookie: scopedCookie}})).status, 503);
} finally {
  await cleanup([
    ['stop isolated product-profit portal', () => stopChild(child, 'isolated product-profit portal')],
    ['remove isolated product-profit files', () => fs.promises.rm(temp, {recursive: true, force: true})],
  ]);
}

const readOnlyTemp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'shein-bi-home-profit-read-only-'));
const readOnlyPortal = path.join(readOnlyTemp, 'portal');
const readOnlySections = path.join(readOnlyPortal, 'sections');
const readOnlyPort = await freePort();
await fs.promises.mkdir(readOnlySections, {recursive: true});
await fs.promises.writeFile(path.join(readOnlyPortal, 'index.html'), '<!doctype html><title>test</title>');
await fs.promises.writeFile(path.join(readOnlyPortal, 'data.json'), JSON.stringify({generatedAt, __sections: {mode: 'api', generatedAt}}));
await fs.promises.writeFile(path.join(readOnlySections, 'homeProfit.json'), JSON.stringify({
  ok: true,
  section: 'homeProfit',
  generatedAt,
  cachedAt: '2026-08-11T02:14:03.722Z',
  data: {homeProfitSummary: {dailyScopes: [], sourceGeneratedAt: '2026-08-10T19:09:04.52205+08:00', staleSource: true}},
}));
const readOnlyChild = spawn(process.execPath, [
  path.join(root, 'scripts', 'serve_bi_portal.mjs'),
  '--host', '127.0.0.1', '--port', String(readOnlyPort), '--dir', readOnlyPortal,
  '--read-only', '--no-auth',
  '--state-file', path.join(readOnlyTemp, 'state.json'),
  '--link-ops-task-file', path.join(readOnlyTemp, 'tasks.json'), '--link-ops-chat-file', path.join(readOnlyTemp, 'chats.json'),
  '--manual-login-state-file', path.join(readOnlyTemp, 'manual-login.json'), '--audit-file', path.join(readOnlyTemp, 'audit.jsonl'),
], {
  cwd: root,
  env: isolatedPortalEnv,
  stdio: ['ignore', 'ignore', 'pipe'],
});
let readOnlyStderr = '';
readOnlyChild.stderr.on('data', chunk => { readOnlyStderr += chunk.toString('utf8'); });
try {
  const base = `http://127.0.0.1:${readOnlyPort}`;
  await waitForServer(base, readOnlyChild, () => readOnlyStderr);
  const response = await fetch(`${base}/api/bi/section/homeProfit`);
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.refreshScheduled, false, 'read-only mode must not schedule the missing profit dependency');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(path.join(readOnlySections, 'profit.json')), false, 'read-only homeProfit must not generate a profit cache');
} finally {
  await cleanup([
    ['stop isolated read-only profit portal', () => stopChild(readOnlyChild, 'isolated read-only profit portal')],
    ['remove isolated read-only profit files', () => fs.promises.rm(readOnlyTemp, {recursive: true, force: true})],
  ]);
}

console.log('bi_product_profit_section_contract: request-state productProfit, q isolation, and fail-closed homeProfit passed');

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  const result = typeof address === 'object' && address ? address.port : 0;
  await new Promise(resolve => probe.close(resolve));
  return result;
}

async function waitForServer(base, serverProcess, stderrText) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) throw new Error(`portal exited before startup: ${stderrText()}`);
    try {
      const response = await fetch(`${base}/login`);
      if (response.status === 200) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`portal startup timed out: ${stderrText()}`);
}

async function login(base, username) {
  const response = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: {'content-type': 'application/json', origin: base, 'x-forwarded-for': '203.0.113.9'},
    body: JSON.stringify({username, password: 'correct-password'}),
  });
  assert.equal(response.status, 200, `login failed for ${username}`);
  return String(response.headers.get('set-cookie') || '').split(';')[0];
}

async function stopChild(child, label, {graceMs = 5_000, killMs = 2_000} = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (await waitForChildExit(child, graceMs)) return;
  child.kill('SIGKILL');
  if (!await waitForChildExit(child, killMs)) {
    throw new Error(`${label} did not exit after SIGKILL`);
  }
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });
}

async function cleanup(steps) {
  const errors = [];
  for (const [label, operation] of steps) {
    try {
      await operation();
    } catch (error) {
      errors.push(new Error(`${label}: ${error?.message || error}`, {cause: error}));
    }
  }
  if (errors.length) throw new AggregateError(errors, 'isolated portal cleanup failed');
}
