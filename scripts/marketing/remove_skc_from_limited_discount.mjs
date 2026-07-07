#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  requireStoreIdentitySnapshot,
  storeIdentityEvalBody,
} from '../../lib/shein_store_identity.mjs';
import {recoverSheinLoginIfNeeded} from '../../lib/shein_login_recovery.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_OUT_DIR = path.join(ROOT, 'tmp/marketing-signup/limited-discount-rescue');
const STORES_CONFIG = JSON.parse(await fs.readFile(path.join(ROOT, 'config/stores.json'), 'utf8'));
const STORES = STORES_CONFIG.stores || [];
const STORE_ACCOUNT_TRUTH = JSON.parse(await fs.readFile(path.join(ROOT, 'config/store_account_truth.json'), 'utf8'));

function parseArgs(argv) {
  const args = {
    stores: [],
    activityId: null,
    skcs: [],
    execute: false,
    outDir: DEFAULT_OUT_DIR,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--stores' || arg === '--store') args.stores = splitCsv(argv[++i]);
    else if (arg.startsWith('--stores=')) args.stores = splitCsv(arg.slice('--stores='.length));
    else if (arg.startsWith('--store=')) args.stores = splitCsv(arg.slice('--store='.length));
    else if (arg === '--activity-id') args.activityId = Number(argv[++i]);
    else if (arg.startsWith('--activity-id=')) args.activityId = Number(arg.slice('--activity-id='.length));
    else if (arg === '--skcs') args.skcs = splitCsv(argv[++i]);
    else if (arg.startsWith('--skcs=')) args.skcs = splitCsv(arg.slice('--skcs='.length));
    else if (arg === '--dry-run') args.execute = false;
    else if (arg === '--execute') args.execute = true;
    else if (arg === '--out-dir') args.outDir = path.resolve(argv[++i] || '');
    else if (arg.startsWith('--out-dir=')) args.outDir = path.resolve(arg.slice('--out-dir='.length));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  args.stores = [...new Set(args.stores.map(value => value.toUpperCase()))];
  args.skcs = [...new Set(args.skcs.map(value => value.trim()).filter(Boolean))];
  if (!args.stores.length) throw new Error('Missing --stores <storeKey[,storeKey...]>');
  if (!Number.isFinite(args.activityId) || args.activityId <= 0) throw new Error('Missing/invalid --activity-id');
  if (!args.skcs.length) throw new Error('Missing --skcs <skc[,skc...]>');
  return args;
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function rel(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, '/');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function httpJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return await res.json();
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.seq = 0;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const pending = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        msg.error ? pending.reject(new Error(JSON.stringify(msg.error))) : pending.resolve(msg.result);
      }
    });
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, {once: true});
      this.ws.addEventListener('error', reject, {once: true});
    });
    await this.call('Runtime.enable');
  }

  call(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({id, method, params}));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout ${method}`));
      }, 180000);
      this.pending.set(id, {resolve, reject, timer});
    });
  }

  async eval(body, arg) {
    const encoded = arg === undefined ? 'undefined' : JSON.stringify(arg).replace(/</g, '\\u003c');
    const res = await this.call('Runtime.evaluate', {
      expression: `(async()=>{ const __arg=${encoded}; ${body} })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails, null, 2));
    return res.result.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // ignore close races
    }
  }
}

async function connect(port) {
  const pages = await httpJson(`http://127.0.0.1:${port}/json/list`);
  const page =
    pages.find(item => item.type === 'page' && String(item.url || '').includes('sso.geiwohuo.com')) ||
    pages.find(item => item.type === 'page');
  if (!page) throw new Error(`No page target at CDP port ${port}`);
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  return cdp;
}

async function recoverLoginIfNeeded(cdp) {
  return await recoverSheinLoginIfNeeded({
    evaluate: (body, arg) => cdp.eval(body, arg),
    dispatchMouseEvent: params => cdp.call('Input.dispatchMouseEvent', params),
    reload: () => cdp.call('Page.reload', {ignoreCache: true}).catch(() => cdp.eval('location.reload(); return {href: location.href};')),
    sleep,
    maxAttempts: 3,
  });
}

async function assertCurrentStoreIdentity(cdp, store, context) {
  const snapshot = await cdp.eval(storeIdentityEvalBody());
  return requireStoreIdentitySnapshot({
    store,
    truth: STORE_ACCOUNT_TRUTH.stores?.[store.storeKey],
    snapshot,
    context,
  });
}

async function removeForStore(store, args) {
  const cdp = await connect(store.port);
  try {
    const loginRecovery = await recoverLoginIfNeeded(cdp);
    if (!loginRecovery.ok) {
      return {
        storeKey: store.storeKey,
        port: store.port,
        ok: false,
        execute: args.execute,
        error: '营销子系统显示登录页，自动点登录后仍未恢复，需人工登录',
        loginRecovery,
      };
    }
    const identity = await assertCurrentStoreIdentity(cdp, store, 'remove_skc_from_limited_discount');
    const result = await cdp.eval(`
      const {activityId, skcsToRemove, execute} = __arg;
      const headers = {'content-type': 'application/json;charset=UTF-8'};

      async function post(api, body) {
        const res = await fetch('/mrs-api-prefix' + api, {
          method: 'POST',
          headers,
          credentials: 'include',
          body: JSON.stringify(body),
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        const packet = {
          api,
          status: res.status,
          code: json?.code,
          msg: json?.msg,
          info: json?.info ?? json?.data ?? json,
          text: text.slice(0, 4000),
          body,
        };
        if (!res.ok || !json || String(json.code) !== '0') {
          const error = new Error(api + ' ' + res.status + ' ' + (json?.code ?? '') + ' ' + (json?.msg ?? text.slice(0, 800)));
          error.packet = packet;
          throw error;
        }
        return packet;
      }

      function normalizeGoods(packet) {
        const rows = packet.info?.data || packet.info || [];
        return (Array.isArray(rows) ? rows : []).map(row => ({
          skc: String(row.skc || ''),
          sku_supplier_no: row.sku_supplier_no,
          product_act_price: row.product_act_price,
          max_product_act_price: row.max_product_act_price,
          attend_num_sum: row.attend_num_sum,
          stock_num: row.stock_num,
          goods_state: row.goods_state,
          id: row.id,
        }));
      }

      async function queryGoods() {
        const packet = await post('/promotion/simple_platform/query_activity_goods', {
          activity_id: Number(activityId),
          page_num: 1,
          page_size: 1000,
        });
        return {
          packet: {code: packet.code, msg: packet.msg, status: packet.status},
          goods: normalizeGoods(packet),
        };
      }

      const before = await queryGoods();
      const beforeSkcs = [...new Set(before.goods.map(row => row.skc).filter(Boolean))].sort();
      const removeSet = new Set(skcsToRemove);
      const presentToRemove = skcsToRemove.filter(skc => beforeSkcs.includes(skc));
      const missingToRemove = skcsToRemove.filter(skc => !beforeSkcs.includes(skc));
      const preserveBefore = beforeSkcs.filter(skc => !removeSet.has(skc));
      const result = {
        href: location.href,
        title: document.title,
        execute,
        activityId: Number(activityId),
        requestedRemoveSkcs: skcsToRemove,
        before: {
          totalSkcs: beforeSkcs.length,
          skcs: beforeSkcs,
          removeSkcsPresent: presentToRemove,
          missingToRemove,
          preserveSkcs: preserveBefore,
          goods: before.goods,
        },
        deleteResponse: null,
        after: null,
        ok: false,
      };
      if (missingToRemove.length) {
        result.reason = 'requested SKCs are not currently in old activity; aborting before write';
        return result;
      }
      if (!execute) {
        result.ok = true;
        result.dryRunOnly = true;
        result.wouldRemove = presentToRemove;
        return result;
      }

      const deletePacket = await post('/promotion/simple_platform/delete_activity_goods', {
        activity_id: Number(activityId),
        cost_and_stock_info_list: skcsToRemove.map(skc => ({skc})),
      });
      result.deleteResponse = {
        status: deletePacket.status,
        code: deletePacket.code,
        msg: deletePacket.msg,
        info: deletePacket.info,
      };
      await new Promise(resolve => setTimeout(resolve, 1200));
      const after = await queryGoods();
      const afterSkcs = [...new Set(after.goods.map(row => row.skc).filter(Boolean))].sort();
      const stillPresent = skcsToRemove.filter(skc => afterSkcs.includes(skc));
      const missingPreserved = preserveBefore.filter(skc => !afterSkcs.includes(skc));
      const unexpectedAdded = afterSkcs.filter(skc => !beforeSkcs.includes(skc));
      result.after = {
        totalSkcs: afterSkcs.length,
        skcs: afterSkcs,
        stillPresent,
        missingPreserved,
        unexpectedAdded,
        goods: after.goods,
      };
      result.ok =
        String(result.deleteResponse.code) === '0' &&
        stillPresent.length === 0 &&
        missingPreserved.length === 0 &&
        unexpectedAdded.length === 0;
      if (!result.ok) result.reason = 'post-delete readback verification failed';
      return result;
    `, {
      activityId: args.activityId,
      skcsToRemove: args.skcs,
      execute: args.execute,
    });
    return {storeKey: store.storeKey, port: store.port, identity, loginRecovery, ...result};
  } catch (error) {
    return {
      storeKey: store.storeKey,
      port: store.port,
      ok: false,
      execute: args.execute,
      error: {
        message: error.message,
        stack: error.stack,
        packet: error.packet,
      },
    };
  } finally {
    cdp.close();
  }
}

const args = parseArgs(process.argv.slice(2));
await fs.mkdir(args.outDir, {recursive: true});

const results = [];
for (const storeKey of args.stores) {
  const store = STORES.find(item => String(item.storeKey).toUpperCase() === storeKey);
  if (!store) {
    results.push({storeKey, ok: false, execute: args.execute, error: `Unknown store ${storeKey}`});
    continue;
  }
  results.push(await removeForStore(store, args));
}

const ok = results.every(result => result.ok);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = path.join(
  args.outDir,
  `remove-skc-limited-discount-${args.execute ? 'execute' : 'dry-run'}-${args.stores.join('-')}-${args.activityId}-${stamp}.json`,
);
await fs.writeFile(outPath, JSON.stringify({
  createdAt: new Date().toISOString(),
  execute: args.execute,
  activityId: args.activityId,
  stores: args.stores,
  requestedRemoveSkcs: args.skcs,
  ok,
  results,
}, null, 2), 'utf8');

console.log(JSON.stringify({
  ok,
  execute: args.execute,
  out: rel(outPath),
  activityId: args.activityId,
  stores: args.stores,
  results: results.map(result => ({
    storeKey: result.storeKey,
    ok: result.ok,
    beforeTotalSkcs: result.before?.totalSkcs,
    requestedRemoveCount: result.requestedRemoveSkcs?.length || args.skcs.length,
    missingToRemove: result.before?.missingToRemove,
    dryRunOnly: result.dryRunOnly || false,
    afterTotalSkcs: result.after?.totalSkcs,
    stillPresent: result.after?.stillPresent,
    missingPreserved: result.after?.missingPreserved,
    reason: result.reason || result.error?.message || result.error || '',
  })),
}, null, 2));
if (!ok) process.exitCode = 2;
