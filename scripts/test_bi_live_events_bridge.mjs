#!/usr/bin/env node
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  createBiLiveUpdateBridge,
  liveSectionsForBiUpdate,
  normalizeBiLiveUpdatePayload,
} from './serve_bi_portal.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class FakePgClient extends EventEmitter {
  static latest = null;
  constructor(config) {
    super();
    this.config = config;
    this.queries = [];
    FakePgClient.latest = this;
  }
  async connect() {}
  async query(sql) { this.queries.push(sql); }
  async end() { this.ended = true; }
}

const fixedNow = new Date('2026-07-23T12:00:00.000Z');
const order = normalizeBiLiveUpdatePayload(JSON.stringify({
  eventFamily: 'order', storeKey: 'tz', orderId: 'GSH18A51T000BED', updatedAt: '2026-07-23T11:59:59.000Z',
}), fixedNow);
assert.deepEqual(order, {
  kind: 'order', receiptId: '', storeKey: 'TZ', entityId: 'GSH18A51T000BED', occurredAt: '2026-07-23T11:59:59.000Z',
});
assert.deepEqual(liveSectionsForBiUpdate('return'), ['liveSalesToday', 'orders', 'priceScatter', 'afterSales']);
assert.deepEqual(liveSectionsForBiUpdate('product'), ['linksData', 'actions']);
assert.deepEqual(liveSectionsForBiUpdate('platform'), []);
assert.equal(normalizeBiLiveUpdatePayload('{"event":"unknown"}', fixedNow), null);
assert.equal(normalizeBiLiveUpdatePayload('{"eventFamily":"inventory_warning"}', fixedNow)?.kind, 'platform');

const bridge = createBiLiveUpdateBridge({
  ClientClass: FakePgClient,
  env: {
    SHEIN_BI_LIVE_UPDATES_ENABLED: '1',
    SHEIN_WAREHOUSE_PG_HOST: '127.0.0.1',
    SHEIN_WAREHOUSE_PG_PORT: '54329',
    SHEIN_WAREHOUSE_PG_DATABASE: 'shein_bi',
    SHEIN_WAREHOUSE_PG_USER: 'test_listener',
  },
  now: () => fixedNow,
  heartbeatMs: 0,
  reconnectMs: 1,
});
const written = [];
const fakeResponse = {write: text => written.push(text), end() { this.ended = true; }};
const remove = bridge.addSseClient(fakeResponse);
await bridge.start();
assert.equal(FakePgClient.latest.queries[0], 'LISTEN shein_bi_live_update');
assert.match(FakePgClient.latest.queries[1], /max\(processed_at\).*last_order_at/s);
FakePgClient.latest.emit('notification', {
  channel: 'shein_bi_live_update',
  payload: JSON.stringify({eventFamily: 'return', store_key: 'qh', returnNo: 'R-123'}),
});
await new Promise(resolve => setTimeout(resolve, 0));
const updateWire = written.find(text => text.includes('event: live-update'));
assert.ok(updateWire, 'a PostgreSQL notification must become an SSE live-update event');
assert.match(updateWire, /"kind":"return"/);
assert.match(updateWire, /"afterSales"/);
const firstClient = FakePgClient.latest;
firstClient.emit('error', new Error('simulated listener disconnect'));
await new Promise(resolve => setTimeout(resolve, 20));
assert.notEqual(FakePgClient.latest, firstClient, 'the dedicated LISTEN connection must reconnect after a disconnect');
assert.equal(FakePgClient.latest.queries[0], 'LISTEN shein_bi_live_update');
assert.match(FakePgClient.latest.queries[1], /max\(processed_at\).*last_order_at/s);
remove();
await bridge.stop();

const generator = await fs.readFile(path.join(ROOT, 'scripts', 'generate_bi_portal.mjs'), 'utf8');
const productionClient = await fs.readFile(path.join(ROOT, 'scripts', 'bi_app', 'client.js'), 'utf8');
const portalServer = await fs.readFile(path.join(ROOT, 'scripts', 'serve_bi_portal.mjs'), 'utf8');
assert.match(generator, /new EventSource\(BI_LIVE_EVENTS_API\)/, 'service mode must subscribe with EventSource');
assert.match(generator, /BI_LIVE_FALLBACK_REFRESH_MS = 5 \* 60 \* 1000/, 'the fallback must be five minutes, not sixty seconds');
assert.match(generator, /fetchBiSectionForLiveRefresh/, 'live updates must force-refresh sections without a document reload');
assert.match(generator, /BI_LIVE_GENERATED_AT_MISMATCH/, 'mixed core/section generations must be retried rather than merged');
assert.match(generator, /visibilitychange/, 'returning to a visible page must recheck data');
assert.match(productionClient, /new EventSource\('\/api\/bi\/live-events'\)/, 'the formal production shell must subscribe to the SSE endpoint');
assert.match(productionClient, /CORE_VISIBLE_POLL_MS=5\*60\*1000/, 'the formal production shell must use a five-minute fallback');
assert.match(productionClient, /LIVE_LAST_ORDER_AT=newestStamp/, 'the data-status timestamp must advance from real order events');
assert.match(productionClient, /function applyLiveOrderRankingOverlay\(\)/, 'live orders must update today rankings without rebuilding the full profit mart');
assert.match(productionClient, /if\(!date\|\|!D\.rankings\)return;/, 'a verified zero-order live day must clear stale cached rankings instead of preserving old sales');
assert.match(productionClient, /if\(n==='liveSalesToday'\|\|n==='homeRankings'\|\|n==='rankings'\)applyLiveOrderRankingOverlay\(\)/, 'initial section loading must reconcile cached rankings with live sales regardless of response order');
assert.match(productionClient, /const liveSalesState=sourceState\('liveSalesToday',A\(D\.liveSalesToday\?\.items\)\);const rankingsState=combineSourceState\(sourceState\('homeRankings',s\.rows\),liveSalesState\)/, 'the homepage must wait for the live overlay and distinguish unavailable data from a business zero');
assert.match(productionClient, /const LIVE_ORDER_SECTIONS=\['liveSalesToday','orders','priceScatter'\]/, 'live orders must always refresh the lightweight today-sales section');
assert.match(productionClient, /home:\['homeRankings','afterSales','homeProfit','homeTrafficDaily','liveSalesToday'\]/, 'the homepage must load the current-day profit overlay even before a new SSE event');
assert.match(productionClient, /n==='liveSalesToday'\?'\?refresh=1'/, 'the lightweight today-sales section must refresh synchronously');
assert.match(productionClient, /queueLiveRefresh\(\{kind:'order',receivedAt:at,sections:LIVE_ORDER_SECTIONS\}\)/, 'a newly opened page must catch up from the persisted last order receipt');
assert.match(productionClient, /profitStoreRows/, 'the current-day store profit rows must replace the stale cached day');
assert.match(productionClient, /新订单已计入销售；利润正自动补成本/,
  'the homepage must explain a live sale whose accounting cache is still rebuilding');
assert.match(productionClient, /if\(useLive&&d===liveDate\)return false/, 'cached current-day profit must be removed before the live rows are appended');
assert.match(productionClient, /loadWebhook\(true\)/, 'platform activity must refresh when a live event arrives');
assert.match(productionClient, /load\(n,true,true\)/, 'only relevant section APIs should be force-refreshed');
assert.match(generator, /liveSalesToday:[\s\S]*FROM fact\.order_item oi[\s\S]*WHERE oi\.created_date=current_date/, 'the live overlay must read the exact current-day order facts without rebuilding the full profit view');
assert.match(generator, /FROM mart\.profit_order_item_cache\s+WHERE created_date=current_date/,
  'the live profit overlay must use the last atomically published canonical accounting cache');
assert.match(generator, /accountingPending/,
  'a newer Webhook sale must be labelled pending instead of receiving an invented whole-line cost');
assert.doesNotMatch(generator.match(/liveSalesToday:[\s\S]*?`,\n  homeTrafficDaily:/)?.[0] || '', /live_unit_cost_sar/,
  'a partially assigned line must never be valued by multiplying the whole line by a fallback unit cost');
assert.match(generator, /'profitStoreRows'[\s\S]*FROM profit_store_rows_final/, 'the lightweight section must publish current-day profit by store');
assert.doesNotMatch(generator.match(/liveSalesToday:[\s\S]*?`,\n  homeTrafficDaily:/)?.[0] || '', /FROM mart\.profit_order_item oi/, 'the live endpoint must not expand the multi-minute full profit view');
assert.doesNotMatch(portalServer, /createBiLiveCoreRefreshScheduler|live core refresh failed/, 'one webhook must not launch a full 40+ second portal rebuild');
assert.match(portalServer, /SHEIN_BI_LIVE_ACCOUNTING_DEBOUNCE_MS \|\| 45_000/,
  'order and return events must coalesce into an event-driven accounting refresh');
assert.match(portalServer, /await ensureProfitMartCacheFresh\(args, generatedAt\)/,
  'the debounced refresh must rebuild the moving-average ledger before publishing profit');
assert.match(portalServer, /accountingRefreshed: true/,
  'clients must receive a second live signal after canonical accounting catches up');
assert.match(portalServer, /SHEIN_BI_LIVE_ACCOUNTING_RETRY_MS \|\| 5 \* 60_000/,
  'a failed accounting refresh must retry without waiting for another order');
assert.match(portalServer, /portal-startup-accounting-catchup/,
  'a portal restart must reconcile events that arrived while it was offline');
assert.match(portalServer, /liveUpdates:\s*biLiveUpdateBridge\.status\(\)/, 'portal health must expose LISTEN connection status');
assert.match(portalServer, /scheduleBiSectionBackgroundGeneration\(args, root, section, meta\.generatedAt, \{force: true\}\)/, 'an SSE force refresh must not skip an existing section cache');
assert.match(portalServer, /biSectionForceRerun[\s\S]*scheduleBiSectionBackgroundGeneration\(args, root, section, generatedAt, \{force: true\}\)/, 'an order arriving during a section rebuild must queue one coalesced rerun');

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-bi-live-events-'));
const port = await freePort();
const authFile = path.join(temp, 'users.json');
await fs.writeFile(authFile, JSON.stringify({users: [{username: 'live-test', password: 'correct-password', role: 'admin'}]}));
const server = spawn(process.execPath, [
  path.join(ROOT, 'scripts', 'serve_bi_portal.mjs'),
  '--host', '127.0.0.1', '--port', String(port), '--dir', path.join(ROOT, 'outputs', 'bi-portal'),
  '--auth-file', authFile, '--htpasswd-file', path.join(temp, 'missing.htpasswd'),
  '--session-secret-file', path.join(temp, 'session-secret'), '--state-file', path.join(temp, 'state.json'),
  '--link-ops-task-file', path.join(temp, 'tasks.json'), '--link-ops-chat-file', path.join(temp, 'chats.json'),
  '--manual-login-state-file', path.join(temp, 'manual-login.json'), '--audit-file', path.join(temp, 'audit.jsonl'),
], {cwd: ROOT, env: {...process.env, SHEIN_BI_LIVE_UPDATES_ENABLED: '0'}, stdio: ['ignore', 'ignore', 'pipe']});
let stderr = '';
server.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
try {
  const base = `http://127.0.0.1:${port}`;
  await waitForServer(base, server, () => stderr);
  const publicHeaders = {'x-forwarded-for': '203.0.113.9'};
  const anonymous = await fetch(`${base}/api/bi/live-events`, {headers: publicHeaders, redirect: 'manual'});
  assert.equal(anonymous.status, 401, 'the SSE endpoint must require the normal BI login');
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: {...publicHeaders, 'content-type': 'application/json', origin: base},
    body: JSON.stringify({username: 'live-test', password: 'correct-password'}),
  });
  assert.equal(login.status, 200);
  const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
  const stream = await openSse(base, cookie, publicHeaders);
  assert.equal(stream.statusCode, 200);
  assert.match(String(stream.headers['content-type'] || ''), /text\/event-stream/);
  const initial = await readStreamChunk(stream);
  assert.match(initial, /event: ready/);
  stream.destroy();
} finally {
  server.kill('SIGTERM');
  await new Promise(resolve => server.once('exit', resolve));
  await fs.rm(temp, {recursive: true, force: true});
}

console.log('bi_live_events_bridge: LISTEN payload normalization, SSE fanout, and client refresh contract passed');

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function waitForServer(base, child, stderrText) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`portal exited before startup: ${stderrText()}`);
    try {
      const response = await fetch(`${base}/login`);
      if (response.status === 200) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`portal startup timed out: ${stderrText()}`);
}

function openSse(base, cookie, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${base}/api/bi/live-events`, {headers: {...headers, cookie}}, response => resolve(response));
    request.once('error', reject);
  });
}

function readStreamChunk(response) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SSE ready event timed out')), 5_000);
    response.once('data', chunk => {
      clearTimeout(timer);
      resolve(chunk.toString('utf8'));
    });
    response.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
