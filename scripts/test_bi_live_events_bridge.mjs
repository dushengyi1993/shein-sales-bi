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
  isOrdinaryCurrentDayAccountingEvent,
  liveAccountingEnabled,
  liveAccountingQueuePlan,
  liveSectionsForBiUpdate,
  mergeBiLiveAccountingRefreshEvent,
  normalizeBiLiveUpdatePayload,
} from './serve_bi_portal.mjs';
import {provisionBiSessionSecret} from './provision_bi_session_secret.mjs';

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
assert.equal(liveAccountingEnabled({SHEIN_BI_LIVE_UPDATES_ENABLED: '0'}), false,
  'disabling live updates must also suppress startup accounting by default');
assert.equal(liveAccountingEnabled({SHEIN_BI_LIVE_UPDATES_ENABLED: '0', SHEIN_BI_LIVE_ACCOUNTING_ENABLED: '1'}), true,
  'operators may explicitly keep startup accounting enabled while LISTEN/SSE updates are disabled');
assert.equal(liveAccountingEnabled({SHEIN_BI_LIVE_UPDATES_ENABLED: '1', SHEIN_BI_LIVE_ACCOUNTING_ENABLED: '0'}), false,
  'tests and maintenance modes may explicitly suppress accounting without disabling LISTEN/SSE updates');
assert.equal(liveAccountingEnabled({}), true, 'production live accounting remains enabled by default');
const order = normalizeBiLiveUpdatePayload(JSON.stringify({
  eventFamily: 'order', storeKey: 'tz', orderId: 'GSH18A51T000BED', updatedAt: '2026-07-23T11:59:59.000Z',
}), fixedNow);
assert.deepEqual(order, {
  kind: 'order', receiptId: '', storeKey: 'TZ', entityId: 'GSH18A51T000BED',
    businessDate: '', orderStatus: '', orderStatusDesc: '', cancelledBeforePickup: false,
    salesQuantity: 0, salesSar: 0, occurredAt: '2026-07-23T11:59:59.000Z', receivedAt: fixedNow.toISOString(),
});
assert.deepEqual(liveSectionsForBiUpdate('return'), ['liveSalesToday', 'orders', 'afterSales']);
assert.deepEqual(
  liveSectionsForBiUpdate('order', {
    businessDate: '2026-07-27',
    occurredAt: '2026-07-28T06:50:00.000Z',
    accountingRefreshed: true,
  }),
  ['liveSalesToday', 'orders', 'productSalesDaily', 'inventoryTrend', 'homeRankings', 'rankings', 'profit', 'homeProfit'],
  'a prior-day cancellation must refresh the selected historical sales and profit sections after accounting catches up',
);
assert.deepEqual(
  liveSectionsForBiUpdate('return', {accountingRefreshed: true}),
  ['liveSalesToday', 'orders', 'afterSales', 'productSalesDaily', 'inventoryTrend', 'homeRankings', 'rankings', 'profit', 'homeProfit'],
  'a return can change an older order and must invalidate every dependent business section',
);
assert.deepEqual(
  liveSectionsForBiUpdate('order', {
    accountingRefreshed: true,
    accountingKinds: ['order', 'return'],
    refreshHistoricalSections: true,
  }),
  ['liveSalesToday', 'orders', 'afterSales', 'productSalesDaily', 'inventoryTrend', 'homeRankings', 'rankings', 'profit', 'homeProfit'],
  'coalescing a later sale must not discard an earlier return or historical-cancellation refresh scope',
);
assert.deepEqual(liveSectionsForBiUpdate('product'), ['productState']);
assert.deepEqual(liveSectionsForBiUpdate('inventory'), ['inventoryStock']);
assert.deepEqual(liveSectionsForBiUpdate('platform'), []);
assert.deepEqual(
  liveAccountingQueuePlan({
    kind: 'order',
    businessDate: '2026-08-18',
    occurredAt: '2026-08-18T12:00:00.000Z',
    receivedAt: '2026-08-18T12:00:01.000Z',
  }),
  [],
  'a current-day order must stay on the live overlay instead of advancing a multi-minute durable queue revision',
);
assert.deepEqual(
  liveAccountingQueuePlan({kind: 'order'}),
  liveAccountingQueuePlan({kind: 'return', refreshHistoricalSections: true}),
  'an order with missing date evidence must fail closed into the full historical invalidation plan',
);
assert.deepEqual(
  liveAccountingQueuePlan({kind: 'return', refreshHistoricalSections: true}),
  [
    {section: 'profit', priority: 5},
    {section: 'homeRankings', priority: 5},
    {section: 'homeProfit', priority: 5},
    {section: 'orders', priority: 10},
    {section: 'afterSales', priority: 10},
    {section: 'productSalesDaily', priority: 50},
    {section: 'inventoryTrend', priority: 50},
    {section: 'rankings', priority: 50},
  ],
  'returns must preserve the full historical invalidation set behind canonical accounting',
);
assert.deepEqual(liveAccountingQueuePlan({kind: 'product'}), [], 'non-accounting events must not enqueue profit work');
assert.equal(normalizeBiLiveUpdatePayload('{"event":"unknown"}', fixedNow), null);
assert.equal(normalizeBiLiveUpdatePayload('{"eventFamily":"inventory_warning"}', fixedNow)?.kind, 'platform');
assert.equal(normalizeBiLiveUpdatePayload('{"kind":"inventory_refresh"}', fixedNow)?.kind, 'inventory');
assert.equal(normalizeBiLiveUpdatePayload('{"eventFamily":"rrp_review","skc":"SKC-1"}', fixedNow)?.kind, 'product');
const cancelled = normalizeBiLiveUpdatePayload(JSON.stringify({
  eventFamily: 'order',
  storeKey: 'hl',
  businessKey: 'GSH18V0390000KF',
  businessDate: '2026-07-27',
  orderStatus: '6',
  orderStatusDesc: '揽收前已取消',
  cancelledBeforePickup: true,
  salesQuantity: 0,
  salesSar: 0,
}), fixedNow);
assert.equal(cancelled.entityId, 'GSH18V0390000KF');
assert.equal(cancelled.businessDate, '2026-07-27');
const invalidDate = normalizeBiLiveUpdatePayload(JSON.stringify({
  kind: 'order', businessDate: '2026-07-27garbage', occurredAt: '2026-07-27T10:00:00.000Z',
}), fixedNow);
assert.equal(invalidDate.businessDate, '', 'a valid-looking date prefix with trailing garbage must fail closed');
const ordinaryAfterUncertain = normalizeBiLiveUpdatePayload(JSON.stringify({
  kind: 'order', businessDate: '2026-07-23', occurredAt: '2026-07-23T12:00:01.000Z',
}), fixedNow);
const mergedUncertain = mergeBiLiveAccountingRefreshEvent(invalidDate, ordinaryAfterUncertain, fixedNow);
assert.equal(mergedUncertain.refreshHistoricalSections, true,
  'an uncertain date followed by an ordinary order in one debounce window must retain full historical scope');
assert.deepEqual(liveAccountingQueuePlan(mergedUncertain), liveAccountingQueuePlan({kind: 'return'}));
const delayedAcrossMidnight = {
  kind: 'order',
  businessDate: '2026-08-21',
  occurredAt: '2026-08-21T23:59:59+08:00',
  receivedAt: '2026-08-22T00:00:05+08:00',
};
assert.equal(isOrdinaryCurrentDayAccountingEvent(delayedAcrossMidnight), false,
  'classification must use the processing date rather than the delayed event timestamp');
assert.deepEqual(liveAccountingQueuePlan(delayedAcrossMidnight), liveAccountingQueuePlan({kind: 'return'}));
assert.equal(cancelled.cancelledBeforePickup, true);

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
assert.match(productionClient, /function applyLiveOrderRowsOverlay\(\)/, 'live orders must update the order center without waiting for the heavy enriched-order cache');
assert.match(productionClient, /orders:\['orders','liveSalesToday'\]/, 'opening the order center must load the same current-day live source as the homepage');
assert.match(productionClient, /if\(n==='liveSalesToday'\|\|n==='orders'\)applyLiveOrderRowsOverlay\(\)/, 'the order overlay must be independent of section response order');
assert.match(productionClient, /实时订单 ·/, 'live order rows must be labelled plainly while slower logistics enrichment catches up');
assert.match(productionClient, /if\(!date\|\|!Array\.isArray\(items\)\|\|!D\.rankings\)return;/, 'an explicit zero-order live day may clear stale cached rankings while a missing items field must fail closed');
assert.match(productionClient, /if\(n==='liveSalesToday'\|\|n==='homeRankings'\|\|n==='rankings'\)applyLiveOrderRankingOverlay\(\)/, 'initial section loading must reconcile cached rankings with live sales regardless of response order');
assert.match(productionClient, /const liveSalesState=sourceState\('liveSalesToday',A\(D\.liveSalesToday\?\.items\)\);const rankingsState=combineSourceState\(sourceState\('homeRankings',s\.rows\),liveSalesState\)/, 'the homepage must wait for the live overlay and distinguish unavailable data from a business zero');
assert.match(productionClient, /const LIVE_ORDER_SECTIONS=\['liveSalesToday'\]/, 'live orders refresh one lightweight source instead of rebuilding large order and scatter caches per browser');
assert.match(productionClient, /function applyLivePriceScatterOverlay\(\)/, 'the current-day scatter is overlaid from the same authoritative live order facts');
assert.match(productionClient, /if\(n==='liveSalesToday'\|\|n==='priceScatter'\)applyLivePriceScatterOverlay\(\)/, 'the scatter overlay works regardless of section load order');
assert.match(productionClient, /home:\['homeRankings','afterSales','homeProfit','homeTrafficDaily','liveSalesToday'\]/, 'the homepage must load the current-day profit overlay even before a new SSE event');
assert.match(productionClient, /if\(!\['liveSalesToday','productState'\]\.includes\(n\)\)params\.set\('async','1'\)/,
  'the lightweight today-sales and product-state sections must refresh synchronously');
assert.match(productionClient, /LIVE_REFRESH_RUNNING&&LIVE_REFRESH_TOKEN\?LIVE_REFRESH_TOKEN:manualSectionRefreshToken\(n\)/,
  'all open pages must identify the same live event while manual retries receive a distinct intent token');
assert.match(productionClient, /params\.set\('refreshToken',refreshToken\)/,
  'every forced section request must carry its selected live-event or manual intent token');
assert.match(productionClient, /queueLiveRefresh\(\{kind:'order',receivedAt:at,sections:LIVE_ORDER_SECTIONS\}\)/, 'a newly opened page must catch up from the persisted last order receipt');
assert.match(productionClient, /profitStoreRows/, 'the current-day store profit rows must replace the stale cached day');
assert.match(productionClient, /订单变动已计入销售；利润正在同步/,
  'the homepage must explain additions, cancellations, and returns while accounting catches up');
assert.match(productionClient, /if\(useLive&&d===liveDate\)return false/, 'cached current-day profit must be removed before the live rows are appended');
assert.match(productionClient, /loadWebhook\(true\)/, 'platform activity must refresh when a live event arrives');
assert.match(productionClient, /load\(n,true,true\)/, 'only relevant section APIs should be force-refreshed');
assert.match(productionClient, /productStateOverlayMap/, 'the product list must overlay newer webhook state immediately');
assert.match(productionClient, /平台实时更新/, 'operators must be able to distinguish live webhook state from the daily snapshot');
assert.match(generator, /'productStateOverlay', \(SELECT data FROM product_state_overlay\)/,
  'the links section must include the latest trustworthy product-state overlay');
assert.match(generator, /productState:[\s\S]*FROM ops\.shein_webhook_product_state/,
  'live product updates must use a lightweight standalone state section');
assert.match(productionClient, /products:\['linksData','productState','productSalesDaily'\]/,
  'opening the product list must always load the latest event overlay');
assert.match(generator, /liveSalesToday:[\s\S]*FROM fact\.order_item oi[\s\S]*WHERE oi\.created_date=current_date/, 'the live overlay must read the exact current-day order facts without rebuilding the full profit view');
assert.match(generator, /liveSalesToday:[\s\S]*oi\.order_create_time[\s\S]*oi\.goods_performance_status_desc[\s\S]*p\.payment_label/,
  'the lightweight live section must carry enough order detail for an immediate order-center row');
assert.match(generator, /FROM mart\.profit_order_item_cache\s+WHERE created_date=current_date/,
  'the live profit overlay must use the last atomically published canonical accounting cache');
assert.match(generator, /accountingPending/,
  'a newer Webhook sale must be labelled pending instead of receiving an invented whole-line cost');
assert.doesNotMatch(generator.match(/liveSalesToday:[\s\S]*?`,\n  homeTrafficDaily:/)?.[0] || '', /live_unit_cost_sar/,
  'a partially assigned line must never be valued by multiplying the whole line by a fallback unit cost');
assert.match(generator, /'profitStoreRows'[\s\S]*FROM profit_store_rows_final/, 'the lightweight section must publish current-day profit by store');
assert.match(generator, /today_storage_billing_state[\s\S]*'storage_fee_status',CASE[\s\S]*b\.storage_fee_status[\s\S]*'storage_fee_estimated_sar'/,
  'current-day profit must label and deduct the provisional ET storage bill instead of omitting it');
assert.doesNotMatch(generator.match(/liveSalesToday:[\s\S]*?`,\n  homeTrafficDaily:/)?.[0] || '', /FROM mart\.profit_order_item oi/, 'the live endpoint must not expand the multi-minute full profit view');
assert.doesNotMatch(portalServer, /createBiLiveCoreRefreshScheduler|live core refresh failed/, 'one webhook must not launch a full 40+ second portal rebuild');
assert.match(portalServer, /SHEIN_BI_LIVE_ACCOUNTING_DEBOUNCE_MS \|\| 45_000/,
  'order and return events must coalesce into an event-driven accounting refresh');
assert.match(portalServer, /liveAccountingRefreshStopped[\s\S]*!liveAccountingEnabled\(process\.env\)[\s\S]*!allowGenerateSections/,
  'disabled live updates must not leave a startup accounting timer or generator behind');
assert.match(portalServer, /enqueueHostLockedBiSection\(section, generatedAt,[\s\S]*live-accounting-/,
  'returns and historical mutations must queue canonical accounting behind the shared host lock');
assert.match(portalServer, /persistHomepageAccountingCatchupOnce[\s\S]*persistHostLockedBiSectionPlan\(\[[\s\S]*section: 'profit'[\s\S]*section: 'homeProfit'[\s\S]*homepage-accounting-stale-/,
  'the stale-homepage discriminator must retain a bounded canonical profit catch-up after ordinary orders leave the heavy queue');
assert.match(portalServer, /SHEIN_BI_CANONICAL_ACCOUNTING_CATCHUP_MS \|\| 15 \* 60_000/,
  'ordinary orders must receive a browser-independent bounded canonical accounting catch-up');
assert.match(portalServer, /liveCanonicalAccountingCatchupNeeded = true;[\s\S]*liveCanonicalAccountingCatchupRevision \+= 1/,
  'every ordinary order must preserve eventual accounting intent without directly advancing the heavy queue');
assert.match(portalServer, /runCanonicalAccountingCatchup[\s\S]*readProfitAccountingState\(args, generatedAt, \{forceFresh: true\}\)[\s\S]*persistHomepageAccountingCatchupOnce/,
  'the bounded catch-up must check authoritative accounting freshness and persist the existing durable plan');
assert.match(portalServer, /await persistHostLockedBiSectionPlan\(accountingQueue, generatedAt,[\s\S]*live-accounting-/,
  'live accounting must wait for durable queue persistence before reporting that work is queued');
assert.match(portalServer, /live accounting queue persistence failed/,
  'a lock timeout or enqueue failure must remain observable and enter the accounting retry path');
assert.match(portalServer, /homepage accounting is catching up to newer order facts/,
  'a historical homepage cache older than canonical accounting must fail closed instead of serving stale sales');
assert.match(portalServer, /sourceCachedAt: String\(sourceMeta\.sourceCachedAt \|\| ''\)/,
  'homeProfit must retain the exact profit artifact revision used for derivation');
assert.match(portalServer, /accountingFreshnessRequiredSections = new Set\(\['profit', 'homeRankings', 'rankings'/,
  'a regenerated historical homepage baseline must verify profit freshness before publication');
assert.match(portalServer, /'orderFactUpdatedAt', \(SELECT max\(updated_at\) FROM fact\.order_item\)/,
  'a zeroed cancellation row must still invalidate the moving-average ledger and profit cache');
assert.match(portalServer, /'accountingInputUpdatedAt', greatest\([\s\S]*fact\.after_sales_item[\s\S]*fact\.openapi_return_item/,
  'return and after-sales mutations must invalidate profit without masquerading as new sales');
assert.match(portalServer, /refreshHistoricalSections:[\s\S]*eventNeedsHistoricalRefresh/,
  'a webhook burst must preserve prior-day cancellation and return invalidation scope');
assert.match(portalServer, /section === 'homeProfit'[\s\S]*deriveHomeProfitSectionFromProfitCache\(root, generatedAt\)[\s\S]*return derived/,
  'forced historical profit refreshes must derive homeProfit instead of calling a nonexistent SQL section');
assert.match(portalServer, /accountingQueued: true/,
  'historical and return clients must be told that canonical accounting was queued without delaying live sales');
assert.match(portalServer, /BI_INLINE_FAST_SECTIONS = new Set\(\['liveSalesToday', 'productState', 'inventoryStock'\]\)/,
  'only genuinely lightweight live sections may generate inside the Portal process');
assert.match(portalServer, /x-shein-bi-host-locked-worker/,
  'heavy section generation must require the trusted local host-locked worker');
assert.match(portalServer, /SHEIN_BI_LIVE_ACCOUNTING_RETRY_MS \|\| 5 \* 60_000/,
  'a failed accounting refresh must retry without waiting for another order');
assert.match(portalServer, /portal-startup-accounting-catchup/,
  'a portal restart must reconcile events that arrived while it was offline');
assert.match(portalServer, /liveUpdates:\s*biLiveUpdateBridge\.status\(\)/, 'portal health must expose LISTEN connection status');
assert.match(portalServer, /scheduleBiSectionBackgroundGeneration\(args, root, section, meta\.generatedAt, \{\s*force: true,\s*refreshToken: options\.refreshToken,/s, 'an SSE force refresh must not skip an existing section cache');
assert.match(portalServer, /biSectionForceRerun[\s\S]*scheduleBiSectionBackgroundGeneration\(args, root, section, generatedAt, \{\s*force: true,\s*refreshToken: pendingRefreshToken,/s, 'a newer order arriving during a section rebuild must queue one coalesced rerun');
assert.match(portalServer, /refreshToken !== activeToken[\s\S]*biSectionPendingRefreshTokens\.set/,
  'duplicate refreshes for the same live event must not queue another expensive rebuild');

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-bi-live-events-'));
await provisionBiSessionSecret(path.join(temp, 'session-secret'));
const port = await freePort();
const authFile = path.join(temp, 'users.json');
const portalDir = path.join(temp, 'portal');
await fs.mkdir(portalDir, {recursive: true});
await fs.writeFile(path.join(portalDir, 'index.html'), '<!doctype html><title>live events fixture</title>');
await fs.writeFile(authFile, JSON.stringify({users: [{username: 'live-test', password: 'correct-password', role: 'admin'}]}));
const server = spawn(process.execPath, [
  path.join(ROOT, 'scripts', 'serve_bi_portal.mjs'),
  '--host', '127.0.0.1', '--port', String(port), '--dir', portalDir,
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
  if (server.exitCode === null && server.signalCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve));
    server.kill('SIGTERM');
    await exited;
  }
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
