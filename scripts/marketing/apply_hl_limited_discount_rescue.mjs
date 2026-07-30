import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  requireStoreIdentitySnapshot,
  storeIdentityEvalBody,
} from '../../lib/shein_store_identity.mjs';
import {recoverSheinLoginIfNeeded} from '../../lib/shein_login_recovery.mjs';
import {
  applyManualLimitedDiscountOverride,
  buildManualLimitedDiscountIndex,
  findActiveManualLimitedDiscount,
  loadManualLimitedDiscountRegistry,
} from '../../lib/marketing_manual_limited_discount_overrides.mjs';
import {
  assertMarketingAutomationAuthorization,
  MARKETING_AUTOMATION_ACTIONS,
} from '../../lib/marketing_automation_authorization.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_OUT_DIR = path.join(ROOT, 'tmp/marketing-signup/limited-discount-rescue');
const DEFAULT_PORT = 9360;
const TARGET_REF_TOOL_ID = 175;
const CDP_CALL_TIMEOUT_MS = Number(process.env.SHEIN_MARKETING_CDP_CALL_TIMEOUT_MS || 600000);
const STORES_CONFIG = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'stores.json'), 'utf8'));
const STORES = STORES_CONFIG.stores || [];
const STORE_ACCOUNT_TRUTH = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'store_account_truth.json'), 'utf8'));

function parseArgs(argv) {
  const args = {
    port: DEFAULT_PORT,
    rescue: '',
    outDir: DEFAULT_OUT_DIR,
    execute: false,
    storeKey: 'HL',
    startDelayMinutes: 20,
    endTime: '',
    activityStock: 10,
    activityNamePrefix: 'HL漏报补救限时折扣',
    replaceActivityIds: [],
    expectedRescueHash: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--execute') args.execute = true;
    else if (arg === '--dry-run') args.execute = false;
    else if (arg === '--no-close') {
      // Compatibility with guard-suggested commands. Browser lifecycle is
      // controlled by the caller via close_store_browsers.ps1.
    }
    else if (arg === '--port') args.port = Number(argv[++i]);
    else if (arg.startsWith('--port=')) args.port = Number(arg.slice('--port='.length));
    else if (arg === '--rescue') args.rescue = path.resolve(argv[++i]);
    else if (arg.startsWith('--rescue=')) args.rescue = path.resolve(arg.slice('--rescue='.length));
    else if (arg === '--out-dir') args.outDir = path.resolve(argv[++i]);
    else if (arg.startsWith('--out-dir=')) args.outDir = path.resolve(arg.slice('--out-dir='.length));
    else if (arg === '--store' || arg === '--store-key') args.storeKey = String(argv[++i] || '').toUpperCase();
    else if (arg.startsWith('--store=')) args.storeKey = String(arg.slice('--store='.length) || '').toUpperCase();
    else if (arg.startsWith('--store-key=')) args.storeKey = String(arg.slice('--store-key='.length) || '').toUpperCase();
    else if (arg === '--start-delay-minutes') args.startDelayMinutes = Number(argv[++i]);
    else if (arg.startsWith('--start-delay-minutes=')) args.startDelayMinutes = Number(arg.slice('--start-delay-minutes='.length));
    else if (arg === '--end-time') args.endTime = argv[++i] || '';
    else if (arg.startsWith('--end-time=')) args.endTime = arg.slice('--end-time='.length);
    else if (arg === '--activity-stock') args.activityStock = Number(argv[++i]);
    else if (arg.startsWith('--activity-stock=')) args.activityStock = Number(arg.slice('--activity-stock='.length));
    else if (arg === '--activity-name-prefix') args.activityNamePrefix = argv[++i] || '';
    else if (arg.startsWith('--activity-name-prefix=')) args.activityNamePrefix = arg.slice('--activity-name-prefix='.length);
    else if (arg === '--replace-activity-id' || arg === '--replace-activity-ids') {
      args.replaceActivityIds.push(...String(argv[++i] || '').split(',').map(value => Number(value.trim())).filter(Number.isFinite));
    }
    else if (arg.startsWith('--replace-activity-id=')) {
      args.replaceActivityIds.push(...String(arg.slice('--replace-activity-id='.length) || '').split(',').map(value => Number(value.trim())).filter(Number.isFinite));
    }
    else if (arg.startsWith('--replace-activity-ids=')) {
      args.replaceActivityIds.push(...String(arg.slice('--replace-activity-ids='.length) || '').split(',').map(value => Number(value.trim())).filter(Number.isFinite));
    }
    else if (arg === '--expected-rescue-hash') args.expectedRescueHash = String(argv[++i] || '').trim().toLowerCase();
    else if (arg.startsWith('--expected-rescue-hash=')) args.expectedRescueHash = String(arg.slice('--expected-rescue-hash='.length) || '').trim().toLowerCase();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(args.port) || args.port <= 0) throw new Error(`Invalid --port: ${args.port}`);
  if (!args.storeKey) throw new Error('Missing --store-key for identity guard');
  if (!args.rescue) throw new Error('Missing --rescue <rescue-json>. Do not rely on a hard-coded one-off batch path.');
  if (!Number.isFinite(args.startDelayMinutes) || args.startDelayMinutes < 1) {
    throw new Error(`Invalid --start-delay-minutes: ${args.startDelayMinutes}`);
  }
  if (!Number.isInteger(args.activityStock) || args.activityStock <= 0) {
    throw new Error(`Invalid --activity-stock: ${args.activityStock}`);
  }
  args.replaceActivityIds = [...new Set(args.replaceActivityIds.map(Number).filter(Number.isFinite))];
  if (args.expectedRescueHash && !/^[a-f0-9]{64}$/.test(args.expectedRescueHash)) {
    throw new Error(`Invalid --expected-rescue-hash: ${args.expectedRescueHash}`);
  }
  return args;
}

async function httpJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return await res.json();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
        const {resolve, reject} = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
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
      }, CDP_CALL_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: value => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: error => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  async eval(expression, arg) {
    const res = await this.call('Runtime.evaluate', {
      expression: `(async()=>{ const __arg=${JSON.stringify(arg)}; ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
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
    pages.find(p => p.type === 'page' && String(p.url || '').includes('sso.geiwohuo.com')) ||
    pages.find(p => p.type === 'page');
  if (!page) throw new Error(`No page target at CDP port ${port}`);
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  return cdp;
}

async function assertCurrentStoreIdentity(cdp, store, context) {
  const identitySnapshot = await cdp.eval(storeIdentityEvalBody());
  return requireStoreIdentitySnapshot({
    store,
    truth: STORE_ACCOUNT_TRUTH.stores?.[store.storeKey],
    snapshot: identitySnapshot,
    context,
  });
}

async function recoverLoginIfNeeded(cdp) {
  return await recoverSheinLoginIfNeeded({
    evaluate: (body, arg) => cdp.eval(body, arg),
    dispatchMouseEvent: params => cdp.call('Input.dispatchMouseEvent', params),
    reload: () => cdp.call('Page.reload', {ignoreCache: true}).catch(() => cdp.eval(`location.reload(); return {href: location.href};`)),
    sleep,
    maxAttempts: 3,
  });
}

function normalizeTargetRows(rescue, manualIndex, execute) {
  const rows = (rescue.rows || [])
    .filter(row => row && row.needsLimitedDiscount !== false)
    .map(row => {
      const limitedDiscountPrice = Number(row.limitedDiscountPrice);
      const finalTargetPrice = Number(
        row.finalTargetPrice
        ?? row.targetPrice
        ?? row.minimumAllowedLimitedDiscountPrice
        ?? row.originalPlannedFinalPrice
        ?? NaN,
      );
      const base = {
        storeKey: String(row.storeKey || rescue.storeKey || '').trim().toUpperCase(),
        skc: String(row.skc || '').trim(),
        canonical: row.canonical || '',
        supplierNo: row.supplierNo || row.currentSupplierNo || '',
        limitedDiscountPrice,
        finalTargetPrice: Number.isFinite(finalTargetPrice) ? finalTargetPrice : null,
        expectedFinalAfterLimitedAnd15Coupon: row.expectedFinalAfterLimitedAnd15Coupon ?? '',
        originalPlannedFinalPrice: row.originalPlannedFinalPrice ?? '',
        originalMarketingPrice: row.originalMarketingPrice ?? '',
        priceSourceActivityId: row.priceSourceActivityId ?? '',
        combo: row.combo || '',
        sourceRule: row.sourceRule || '',
        note: row.note || '',
        activityStock: Number.isInteger(Number(row.activityStock)) && Number(row.activityStock) > 0
          ? Number(row.activityStock)
          : null,
      };
      const manualEntry = findActiveManualLimitedDiscount(manualIndex, base.storeKey, base.skc);
      const declaresManualSpecial = /manual_special|user_(?:requested|approved).*special|high_click_special/i.test(String(base.sourceRule || ''))
        || row.manualSpecialLimitedDiscount === true;
      if (execute && declaresManualSpecial && !manualEntry) {
        throw new Error(`Manual special limited-discount execute requires an active registry entry before submit: ${base.storeKey}::${base.skc}`);
      }
      return manualEntry ? applyManualLimitedDiscountOverride(base, manualEntry) : base;
    });
  const missing = rows.filter(row => !row.skc || !Number.isFinite(row.limitedDiscountPrice) || row.limitedDiscountPrice <= 0);
  if (missing.length) throw new Error(`Rescue target rows have missing SKC/price: ${JSON.stringify(missing.slice(0, 5))}`);
  const missingTarget = rows.filter(row => row.finalTargetPrice === null);
  if (missingTarget.length) {
    throw new Error(`Rescue target rows have no finalTargetPrice/targetPrice; refusing unguarded limited-discount write: ${JSON.stringify(missingTarget.slice(0, 5))}`);
  }
  const belowTarget = rows.filter(row => row.finalTargetPrice !== null && row.limitedDiscountPrice < row.finalTargetPrice - 0.01);
  if (belowTarget.length) {
    throw new Error(`Rescue limited-discount price is below finalTargetPrice; refusing mechanical 15%/too-deep fallback: ${JSON.stringify(belowTarget.slice(0, 5))}`);
  }
  const seen = new Set();
  const duplicates = [];
  for (const row of rows) {
    if (seen.has(row.skc)) duplicates.push(row.skc);
    seen.add(row.skc);
  }
  if (duplicates.length) throw new Error(`Duplicate target SKC in rescue file: ${duplicates.join(', ')}`);
  if (!rows.length) throw new Error('No limited-discount target rows found');
  return rows;
}

function rel(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, '/');
}

const args = parseArgs(process.argv.slice(2));
let automationAuthorization = null;
await fs.mkdir(args.outDir, {recursive: true});
const rescueText = await fs.readFile(args.rescue, 'utf8');
const rescueHash = crypto.createHash('sha256').update(rescueText).digest('hex');
if (args.expectedRescueHash && rescueHash !== args.expectedRescueHash) {
  throw new Error(`Rescue payload hash mismatch: expected=${args.expectedRescueHash} actual=${rescueHash}`);
}
automationAuthorization = args.execute ? await assertMarketingAutomationAuthorization({
  action: MARKETING_AUTOMATION_ACTIONS.CREATE_OR_REPLACE_ACTIVITY,
  storeKey: args.storeKey,
  payloadHash: process.env.SHEIN_BI_MARKETING_RUN_PAYLOAD_HASH || rescueHash,
}) : null;
const rescue = JSON.parse(rescueText);
const manualRegistry = await loadManualLimitedDiscountRegistry();
const manualIndex = buildManualLimitedDiscountIndex(manualRegistry, new Date());
const targetRows = normalizeTargetRows(rescue, manualIndex, args.execute);
const manualRows = targetRows.filter(row => row.manualSpecialLimitedDiscount === true);
if (manualRows.length && manualRows.length !== targetRows.length) {
  throw new Error('A rescue file cannot mix active manual-special and ordinary limited-discount rows; split by protection window before execute.');
}
const manualEndTimes = [...new Set(manualRows.map(row => row.manualSpecialValidTo).filter(Boolean))];
const manualActivityStocks = [...new Set(manualRows.map(row => Number(row.activityStock)).filter(Number.isInteger))];
if (manualEndTimes.length > 1 || manualActivityStocks.length > 1) {
  throw new Error('Manual-special rescue rows have different validTo/activityStock values; split them before execute.');
}
const effectiveEndTime = manualEndTimes[0] || rescue.endTime || args.endTime;
const effectiveActivityStock = Number(manualActivityStocks[0] ?? rescue.activityStock ?? args.activityStock);
const effectiveActivityNamePrefix = manualRows.length
  ? `${args.storeKey}人工特殊限时折扣保护恢复`
  : (rescue.activityNamePrefix || args.activityNamePrefix);
if (!effectiveEndTime) throw new Error('Missing --end-time "YYYY-MM-DD HH:mm:ss" for the limited-discount rescue window.');
if (!String(effectiveActivityNamePrefix || '').trim()) throw new Error('Missing --activity-name-prefix for the limited-discount activity name.');
if (!Number.isInteger(effectiveActivityStock) || effectiveActivityStock <= 0) throw new Error(`Invalid activity stock: ${effectiveActivityStock}`);
const end = new Date(String(effectiveEndTime).replace(' ', 'T') + '+08:00');
if (!Number.isFinite(end.getTime())) throw new Error(`Invalid --end-time: ${effectiveEndTime}`);
const store = STORES.find(s => String(s.storeKey).toUpperCase() === args.storeKey);
if (!store) throw new Error(`Unknown store for identity guard: ${args.storeKey}`);

const cdp = await connect(args.port);
let outPath;
try {
  const loginRecovery = await recoverLoginIfNeeded(cdp);
  if (!loginRecovery.ok) {
    const err = new Error('营销子系统显示登录页，自动点登录后仍未恢复，需人工登录');
    err.loginRecovery = loginRecovery;
    throw err;
  }
  const identity = await assertCurrentStoreIdentity(cdp, store, 'apply_hl_limited_discount_rescue');
  const result = await cdp.eval(
    `
    const {
      targetRows,
      execute,
      targetRefToolId,
      targetEndTime,
      startDelayMinutes,
      activityStock,
      activityNamePrefix,
      replaceActivityIds,
    } = __arg;

    const headers = {'content-type': 'application/json;charset=UTF-8'};
    const targetSkcs = targetRows.map(row => row.skc);
    const targetSet = new Set(targetSkcs);
    const targetBySkc = new Map(targetRows.map(row => [row.skc, row]));
    const replaceActivityIdSet = new Set((replaceActivityIds || []).map(Number).filter(Number.isFinite));
    const windowEnd = new Date(targetEndTime.replace(' ', 'T') + '+08:00');

    function pad(value) {
      return String(value).padStart(2, '0');
    }

    function fmtDate(date) {
      return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
      ].join('-') + ' ' + [
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds()),
      ].join(':');
    }

    function parseChinaDate(value) {
      if (!value) return null;
      return new Date(String(value).replace(' ', 'T') + '+08:00');
    }

    function round2(value) {
      return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
    }

    async function post(path, body, options = {}) {
      const res = await fetch('/mrs-api-prefix' + path, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        credentials: 'include',
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      const okCode = json && String(json.code) === '0';
      const packet = {
        path,
        status: res.status,
        code: json?.code,
        msg: json?.msg,
        info: json?.info ?? json?.data ?? json,
        text: text.slice(0, 4000),
        body,
      };
      if (!options.allowNonZero && (!res.ok || !okCode)) {
        const err = new Error(path + ' ' + res.status + ' ' + (json?.code ?? '') + ' ' + (json?.msg ?? text.slice(0, 500)));
        err.packet = packet;
        throw err;
      }
      return packet;
    }

    async function getApolloMap(namespace, key) {
      const query = new URLSearchParams({namespace, key}).toString();
      const res = await fetch('/mrs-api-prefix/common/get_apollo_map?' + query, {
        method: 'GET',
        credentials: 'include',
      });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { json = null; }
      if (!res.ok || !json || String(json.code) !== '0') {
        throw new Error('/common/get_apollo_map ' + res.status + ' ' + text.slice(0, 500));
      }
      return json.info || json;
    }

    async function queryCurrentLimitedDiscounts() {
      const listPacket = await post('/promotion/obm/query_obm_activity_list', {
        page_num: 1,
        page_size: 200,
        system: 'mrs',
        ref_tools_id: targetRefToolId,
      });
      const activities = listPacket.info?.data || listPacket.info || [];
      const detailed = [];
      const overlaps = [];
      const activeOrFuture = [];
      const now = new Date();

      for (const activity of activities) {
        const goodsPacket = await post('/promotion/simple_platform/query_activity_goods', {
          activity_id: activity.activity_id,
          page_num: 1,
          page_size: 1000,
        });
        const goods = goodsPacket.info?.data || goodsPacket.info || [];
        const start = parseChinaDate(activity.start_time);
        const end = parseChinaDate(activity.end_time);
        const state = Number(activity.state);
        const inWindow = [2, 3].includes(state) && (!end || end >= now) && (!start || start <= windowEnd);
        if (inWindow) activeOrFuture.push(activity);
        const targetGoods = [];
        const extraGoods = [];
        for (const good of goods) {
          const skc = String(good.skc || '');
          const row = {
            activity_id: activity.activity_id,
            act_name: activity.act_name,
            state: activity.state,
            start_time: activity.start_time,
            end_time: activity.end_time,
            skc,
            sku_supplier_no: good.sku_supplier_no,
            product_act_price: good.product_act_price,
            max_product_act_price: good.max_product_act_price,
            attend_num_sum: good.attend_num_sum,
            stock_num: good.stock_num,
            id: good.id,
            is_sale_attribute: good.is_sale_attribute,
            goods_state: good.goods_state,
            error_code: good.error_code,
          };
          if (inWindow && targetSet.has(skc)) {
            overlaps.push(row);
            targetGoods.push(row);
          } else if (inWindow) {
            extraGoods.push(row);
          }
        }
        detailed.push({activity, goods, targetGoods, extraGoods});
      }
      const conflictActivities = detailed
        .filter(entry => [2, 3].includes(Number(entry.activity.state)) && entry.targetGoods.length > 0)
        .filter(entry => {
          const start = parseChinaDate(entry.activity.start_time);
          const end = parseChinaDate(entry.activity.end_time);
          const now = new Date();
          return (!end || end >= now) && (!start || start <= windowEnd);
        });
      return {listPacket, activities, detailed, overlaps, activeOrFuture, conflictActivities};
    }

    function verifyExactCreatedCoverage(after, expectedRows, expectedActivityId) {
      const rowsBySkc = new Map();
      for (const row of after.overlaps || []) {
        if (!rowsBySkc.has(row.skc)) rowsBySkc.set(row.skc, []);
        rowsBySkc.get(row.skc).push(row);
      }
      return expectedRows.map(target => {
        const candidates = rowsBySkc.get(target.skc) || [];
        const expectedPrice = Number(target.limitedDiscountPrice);
        const candidateChecks = candidates.map(row => {
          const end = parseChinaDate(row.end_time);
          const checks = {
            activityId: Number(row.activity_id) === Number(expectedActivityId),
            state: [2, 3].includes(Number(row.state)),
            price: Math.abs(Number(row.product_act_price) - expectedPrice) <= 0.01,
            stock: Number(row.attend_num_sum || 0) >= Number(target.activityStock || activityStock),
            endTime: Boolean(end && end >= windowEnd),
          };
          return {
            activityId: row.activity_id,
            state: row.state,
            productActPrice: row.product_act_price,
            attendNumSum: row.attend_num_sum,
            endTime: row.end_time,
            checks,
            ok: Object.values(checks).every(Boolean),
          };
        });
        return {
          skc: target.skc,
          expectedActivityId: expectedActivityId || null,
          expectedPrice,
          expectedActivityStock: Number(target.activityStock || activityStock),
          expectedEndTime: targetEndTime,
          candidates: candidateChecks,
          ok: candidateChecks.some(row => row.ok),
        };
      });
    }

    function summarizeConflicts(conflictActivities) {
      return conflictActivities.map(entry => ({
        activity_id: entry.activity.activity_id,
        act_name: entry.activity.act_name,
        state: entry.activity.state,
        start_time: entry.activity.start_time,
        end_time: entry.activity.end_time,
        goodsCount: entry.goods.length,
        targetCount: entry.targetGoods.length,
        extraCount: entry.extraGoods.length,
        targetSkcs: [...new Set(entry.targetGoods.map(g => g.skc))].sort(),
        extraSkcs: [...new Set(entry.extraGoods.map(g => g.skc))].sort(),
        targetGoods: entry.targetGoods.map(g => ({
          skc: g.skc,
          product_act_price: g.product_act_price,
          attend_num_sum: g.attend_num_sum,
          stock_num: g.stock_num,
        })),
      }));
    }

    function assertSafeToEnd(conflictActivities) {
      const unsafe = [];
      for (const entry of conflictActivities) {
        if (![2, 3].includes(Number(entry.activity.state))) {
          unsafe.push({
            activity_id: entry.activity.activity_id,
            reason: 'state is not wait/start',
            state: entry.activity.state,
          });
        }
        const extraSkcs = [...new Set(entry.extraGoods.map(g => g.skc))].sort();
        if (extraSkcs.length) {
          unsafe.push({
            activity_id: entry.activity.activity_id,
            reason: 'activity contains non-target goods',
            extraSkcs,
          });
        }
      }
      if (unsafe.length) {
        const err = new Error('Unsafe existing limited-discount activities; aborting before write');
        err.unsafe = unsafe;
        throw err;
      }
    }

    function buildActivityBaseInfo() {
      const zoneStartTime = fmtDate(new Date(Date.now() + startDelayMinutes * 60 * 1000));
      return {
        act_name: activityNamePrefix + fmtDate(new Date()).slice(0, 10).replaceAll('-', ''),
        zone_start_time: zoneStartTime,
        zone_end_time: targetEndTime,
        time_zone: 'Asia/Shanghai',
        ref_tool_id: targetRefToolId,
        activity_rule: {goods_limit: 0, goods_limit_num: null},
      };
    }

    function buildAddCostRows(goodsRows, checkInfo, sourceTargetRows = targetRows) {
      const goodsBySkc = new Map((goodsRows || []).map(good => [String(good.skc || ''), good]));
      const sourceTargetSkcs = sourceTargetRows.map(row => row.skc);
      const missing = sourceTargetSkcs.filter(skc => !goodsBySkc.has(skc));
      const invalid = [];
      const addRows = [];
      const detailRows = [];
      const toolsRule = checkInfo?.query_tools_rule_detail?.tools_rule || {};
      const defaultMinStock = Number(toolsRule.min_stock ?? 3);
      const defaultMaxStock = Number(toolsRule.max_stock ?? 10000);

      for (const target of sourceTargetRows) {
        const good = goodsBySkc.get(target.skc);
        if (!good) continue;
        const supplyInfo = good.supply_price_info || {};
        const price = round2(target.limitedDiscountPrice);
        const supplyPrice = Number(supplyInfo.supply_price);
        const maxSupplyPrice = Number(supplyInfo.max_supply_price);
        const interceptSupplyPrice = Number(
          supplyInfo.intercept_supply_price ??
          (Number.isFinite(supplyPrice) && Number.isFinite(Number(good.rate_intercept))
            ? supplyPrice * (1 - Number(good.rate_intercept) / 100)
            : NaN),
        );
        const inventory = Number(good.inventory_num ?? good.ivt_num ?? 0);
        const minStock = Number(good.check_stock?.min_stock ?? defaultMinStock);
        const maxStock = Number(good.check_stock?.max_stock ?? defaultMaxStock);
        const attendNum = Number.isInteger(Number(target.activityStock)) && Number(target.activityStock) > 0
          ? Number(target.activityStock)
          : activityStock;

        if (good.error_code) invalid.push({skc: target.skc, reason: 'query_goods error_code', error_code: good.error_code});
        if (!Number.isFinite(price) || price <= 0) invalid.push({skc: target.skc, reason: 'invalid target price', price});
        if (!Number.isFinite(maxSupplyPrice) || price > maxSupplyPrice + 0.0001) {
          invalid.push({skc: target.skc, reason: 'price exceeds max_supply_price', price, maxSupplyPrice});
        }
        if (Number.isFinite(interceptSupplyPrice) && price <= interceptSupplyPrice + 0.0001) {
          invalid.push({skc: target.skc, reason: 'price hits rate_intercept floor', price, interceptSupplyPrice});
        }
        if (!Number.isFinite(inventory) || inventory < minStock) {
          invalid.push({skc: target.skc, reason: 'inventory below min_stock', inventory, minStock});
        }
        if (attendNum < minStock || attendNum > maxStock) {
          invalid.push({skc: target.skc, reason: 'configured activity stock outside platform bounds', attendNum, minStock, maxStock});
        }
        if (!Number.isFinite(inventory) || inventory < attendNum) {
          invalid.push({skc: target.skc, reason: 'inventory below configured activity stock', inventory, attendNum});
        }

        const isSaleAttribute = Number(good.is_sale_attribute) === 1;
        const addSkuList = Array.isArray(good.sku_info_list)
          ? good.sku_info_list.map(sku => {
              const skuSupplyInfo = sku.supply_price_info || {};
              const skuSupplyPrice = Number.isFinite(Number(skuSupplyInfo.supply_price))
                ? Number(skuSupplyInfo.supply_price)
                : supplyPrice;
              const skuMaxSupplyPrice = Number.isFinite(Number(skuSupplyInfo.max_supply_price))
                ? Number(skuSupplyInfo.max_supply_price)
                : maxSupplyPrice;
              // create_activity is submitted with pricing_type=Sku. In that mode the
              // backend reads the real effective price from add_sku_list, even for
              // single-SKU / non-sale-attribute goods. Leaving SKU prices as 0 can
              // make the page readback show the parent SKC target price while the
              // actual SKU falls back to the platform's default discount.
              const skuRow = {
                id: sku.id,
                cost_price: skuSupplyPrice,
                sku: sku.sku,
                max_product_act_price: skuMaxSupplyPrice,
                product_act_price: price,
              };
              Object.keys(skuRow).forEach(key => skuRow[key] === undefined && delete skuRow[key]);
              return skuRow;
            })
          : [];
        if (!addSkuList.length) {
          invalid.push({skc: target.skc, reason: 'missing sku_info_list for Sku pricing payload'});
        }
        for (const skuRow of addSkuList) {
          if (!Number.isFinite(Number(skuRow.product_act_price)) || Math.abs(Number(skuRow.product_act_price) - price) > 0.0001) {
            invalid.push({
              skc: target.skc,
              reason: 'sku product_act_price mismatch',
              sku: skuRow.sku,
              skuProductActPrice: skuRow.product_act_price,
              targetPrice: price,
            });
          }
        }

        // Match the frontend hk(originData, tableData, pricing_type) create payload:
        // new goods are submitted through add_* SKU buckets, not the intermediate
        // sku_list used inside the React table state. Sending sku_list directly
        // makes create_activity reject the body as 200101 param error.
        const addRow = {
          attend_num: attendNum,
          center_list: good.effective_center_list || [],
          id: good.id,
          is_sale_attribute: good.is_sale_attribute,
          promotion_id_list: good.effective_promotion_id_list || null,
          skc: good.skc,
          stock_num: Number(good.ivt_num || good.inventory_num || 0),
          cost_price: isSaleAttribute ? 0 : supplyPrice,
          max_product_act_price: isSaleAttribute ? 0 : maxSupplyPrice,
          product_act_price: isSaleAttribute ? 0 : price,
          add_sku_list: addSkuList,
        };
        Object.keys(addRow).forEach(key => addRow[key] === undefined && delete addRow[key]);
        addRows.push(addRow);
        detailRows.push({
          skc: target.skc,
          supplierNo: good.sku_supplier_no || target.supplierNo,
          canonical: target.canonical,
          price,
          supplyPrice,
          maxSupplyPrice,
          interceptSupplyPrice,
          inventory,
          attendNum,
          skuCount: addSkuList.length,
          expectedFinalAfterLimitedAnd15Coupon: target.expectedFinalAfterLimitedAnd15Coupon,
          originalPlannedFinalPrice: target.originalPlannedFinalPrice,
          finalTargetPrice: target.finalTargetPrice,
          sourceRule: target.sourceRule,
          combo: target.combo,
        });
      }
      return {missing, invalid, addRows, detailRows};
    }

    function checkSkuPricePayload(addRows, sourceTargetRows = targetRows) {
      const sourceTargetBySkc = new Map(sourceTargetRows.map(row => [row.skc, row]));
      const mismatches = [];
      let skuRowsChecked = 0;
      for (const row of addRows || []) {
        const expected = Number(row.product_act_price || 0) > 0
          ? Number(row.product_act_price)
          : Number(sourceTargetBySkc.get(row.skc)?.limitedDiscountPrice);
        const skuRows = Array.isArray(row.add_sku_list) ? row.add_sku_list : [];
        skuRowsChecked += skuRows.length;
        if (!skuRows.length) {
          mismatches.push({skc: row.skc, reason: 'missing add_sku_list'});
          continue;
        }
        for (const sku of skuRows) {
          const skuPrice = Number(sku.product_act_price);
          if (!Number.isFinite(skuPrice) || Math.abs(skuPrice - expected) > 0.0001) {
            mismatches.push({
              skc: row.skc,
              sku: sku.sku,
              reason: 'sku price does not equal target limited discount price',
              expected,
              skuProductActPrice: sku.product_act_price,
            });
          }
        }
      }
      return {
        ok: mismatches.length === 0,
        goodsRowsChecked: (addRows || []).length,
        skuRowsChecked,
        mismatches,
      };
    }

    async function queryCreatedActivity(activityId) {
      const [detailPacket, goodsPacket] = await Promise.all([
        post('/promotion/obm/query_obm_activity_detail', {activity_id: activityId, system: 'mrs'}),
        post('/promotion/simple_platform/query_activity_goods', {activity_id: activityId, page_num: 1, page_size: 1000}),
      ]);
      return {
        detail: detailPacket.info,
        goods: goodsPacket.info?.data || goodsPacket.info || [],
      };
    }

    const href = location.href;
    const title = document.title;
    const apollo = await getApolloMap('front-config', 'create_tools_sku_config');
    const supplierId = (() => {
      try {
        return JSON.parse(localStorage.getItem('mrs_userinfo') || '{}').supplierId;
      } catch {
        return null;
      }
    })();
    const skuConfigSupplierIds = apollo?.data?.supplier_id_list || [];
    const pricingTypeDecision = {
      supplierId,
      skuConfigSupplierIds,
      // Frontend getApolloMap leaves the default at Sku when the whitelist is empty.
      // The create API accepts 0/2; live validation confirmed Sku is encoded as 2.
      pricing_type: 2,
      pricing_type_label: 'Sku',
      reason: 'create_tools_sku_config.supplier_id_list is empty or includes supplier, so frontend keeps o.lW.Sku',
    };

    const before = await queryCurrentLimitedDiscounts();

    const activityBase = buildActivityBaseInfo();
    const checkPacket = await post('/promotion/simple_platform/check_activity', activityBase);
    const effectiveCenterList = checkPacket.info?.effective_center_list || [];
    const queryGoodsPacket = await post('/promotion/simple_platform/query_goods', {
      page_size: 500,
      page_num: 1,
      activity_base_info_request: {...activityBase, sub_type_id: 2},
      effective_center_list: effectiveCenterList,
      skc_list: targetSkcs,
      is_shelf: 1,
    });
    const queryGoodsRows = queryGoodsPacket.info?.data || queryGoodsPacket.info || [];
    const goodsBuild = buildAddCostRows(queryGoodsRows, checkPacket.info);
    const validationFailed =
      goodsBuild.missing.length ||
      goodsBuild.invalid.length ||
      goodsBuild.addRows.length !== targetRows.length;

    let createPayload = {
      activity_base_info_request: {
        ...activityBase,
        notify_flag: 1,
        sub_type_id: 2,
      },
      pricing_type: pricingTypeDecision.pricing_type,
      add_cost_and_stock_info_list: goodsBuild.addRows,
      update_cost_and_stock_info_list: [],
      delete_cost_and_stock_info_list: [],
    };

    const result = {
      href,
      title,
      execute,
      targetRefToolId,
      targetEndTime,
      targetCount: targetRows.length,
      targetSkcs,
      pricingTypeDecision,
      before: {
        activeOrFuture: before.activeOrFuture.map(activity => ({
          activity_id: activity.activity_id,
          act_name: activity.act_name,
          state: activity.state,
          start_time: activity.start_time,
          end_time: activity.end_time,
        })),
        conflictActivities: summarizeConflicts(before.conflictActivities),
        overlapSkcCount: [...new Set(before.overlaps.map(row => row.skc))].length,
        overlapCount: before.overlaps.length,
      },
      checkActivity: {
        effective_center_list: effectiveCenterList,
        tools_rule: checkPacket.info?.query_tools_rule_detail?.tools_rule,
      },
      queryGoods: {
        count: queryGoodsRows.length,
        meta: queryGoodsPacket.info?.meta || null,
      },
      validation: {
        missing: goodsBuild.missing,
        invalid: goodsBuild.invalid,
        addRows: goodsBuild.addRows.length,
      },
      activityBase,
      plannedGoods: goodsBuild.detailRows,
      createPayload,
      endedActivities: [],
      createResponse: null,
      createdActivityId: null,
      createdActivity: null,
      replaceActivityIds: [...replaceActivityIdSet],
      targetCountForCreate: targetRows.length,
      skippedUnreportable: [],
      postEndValidation: null,
      after: null,
      ok: false,
    };
    const manualSpecialAlreadyCovered = targetRows.every(target => {
      if (!target.manualSpecialLimitedDiscount) return false;
      return before.overlaps.some(overlap => (
        overlap.skc === target.skc
        && Math.abs(Number(overlap.product_act_price) - Number(target.limitedDiscountPrice)) <= 0.01
        && Number(overlap.attend_num_sum || 0) >= Number(activityStock)
        && (!overlap.end_time || parseChinaDate(overlap.end_time) >= windowEnd)
      ));
    });
    result.manualSpecialProtection = {
      registrySource: manualRegistry.sourcePath,
      protectedTargetCount: targetRows.filter(row => row.manualSpecialLimitedDiscount).length,
      alreadyCoveredExact: manualSpecialAlreadyCovered,
    };
    if (manualSpecialAlreadyCovered) {
      const activityIds = [...new Set(before.overlaps.map(row => Number(row.activity_id)).filter(Number.isFinite))];
      result.ok = true;
      result.alreadyCovered = true;
      result.dryRunOnly = !execute;
      result.createdActivityId = activityIds.length === 1 ? activityIds[0] : null;
      result.reason = 'active manual-special limited discount already matches registry price, stock and validTo; no write performed';
      return result;
    }
    result.skuPricePayloadGuard = checkSkuPricePayload(goodsBuild.addRows);
    if (!result.skuPricePayloadGuard.ok) {
      result.validationFailed = true;
      result.ok = false;
      result.reason = 'sku-level limited-discount price payload guard failed; aborting before write';
      return result;
    }

    const unsafeExistingLimitedDiscounts = (() => {
      try {
        assertSafeToEnd(before.conflictActivities);
        return [];
      } catch (error) {
        return error.unsafe || [{reason: error.message}];
      }
    })();
    result.unsafeExistingLimitedDiscounts = unsafeExistingLimitedDiscounts;

    if (unsafeExistingLimitedDiscounts.length) {
      result.validationFailed = true;
      result.ok = false;
      result.reason = 'unsafe existing limited-discount activities; manual split/end required before creating replacement';
      return result;
    }

    const validationOnlyCurrentLimitedConflict =
      goodsBuild.missing.length === 0 &&
      goodsBuild.addRows.length === targetRows.length &&
      goodsBuild.invalid.length > 0 &&
      goodsBuild.invalid.every(row => row.reason === 'query_goods error_code' && row.error_code === 'mrs-simple_platform_limit_discounts-0006') &&
      before.conflictActivities.length > 0 &&
      before.conflictActivities.every(entry => Number(entry.extraCount || 0) === 0);
    result.validationOnlyCurrentLimitedConflict = validationOnlyCurrentLimitedConflict;

    if (validationFailed && !validationOnlyCurrentLimitedConflict) {
      result.validationFailed = true;
      result.ok = false;
      result.reason = 'platform pre-validation failed; aborting before every write';
      return result;
    }

    if (!execute) {
      result.ok = true;
      result.dryRunOnly = true;
      if (validationOnlyCurrentLimitedConflict) {
        result.reason = 'dry-run replacement candidate: only current limited-discount conflict 0006 remains; execute must use the durable transactional replacement wrapper';
      }
      return result;
    }

    // This primitive is intentionally create-only. Replacement is a multi-step
    // transaction owned by replace_limited_discount_transactionally.mjs, which
    // persists the old activity snapshot before deletion and compensates every
    // uncovered SKC if validation/create/readback fails. Ending an old activity
    // here would recreate the historic delete-before-create data-loss window.
    if (before.conflictActivities.length) {
      result.validationFailed = true;
      result.requiresTransactionalReplacement = true;
      result.ok = false;
      result.reason = 'existing limited-discount conflict requires the durable transactional replacement wrapper; no write performed';
      return result;
    }
    if (replaceActivityIdSet.size) {
      result.validationFailed = true;
      result.ok = false;
      result.reason = 'replace activity ids are only accepted by the durable transactional replacement wrapper; no write performed';
      return result;
    }

    const executableTargetRows = targetRows;
    result.targetCountForCreate = executableTargetRows.length;
    result.postEndValidation = {
      skipped: true,
      reason: 'no old activity was ended; initial preflight remains authoritative',
      missing: goodsBuild.missing,
      invalid: goodsBuild.invalid,
      addRows: goodsBuild.addRows.length,
      targetRows: targetRows.length,
      hardInvalid: [],
      blockedSkcs: [],
    };
    result.plannedGoods = goodsBuild.detailRows;
    result.createPayload = createPayload;
    result.finalSkuPricePayloadGuard = checkSkuPricePayload(goodsBuild.addRows, executableTargetRows);
    if (!result.finalSkuPricePayloadGuard.ok) {
      const err = new Error('Final sku-level limited-discount price payload guard failed; aborting create');
      err.finalSkuPricePayloadGuard = result.finalSkuPricePayloadGuard;
      throw err;
    }

    const createPacket = await post('/promotion/simple_platform/create_activity', result.createPayload);
    result.createResponse = {code: createPacket.code, msg: createPacket.msg, info: createPacket.info};
    const createdActivityId =
      createPacket.info?.activity_id ||
      createPacket.info?.id ||
      createPacket.info?.activityId ||
      createPacket.info?.data?.activity_id ||
      createPacket.info?.data?.id;
    result.createdActivityId = createdActivityId || null;

    if (createdActivityId) {
      result.createdActivity = await queryCreatedActivity(createdActivityId);
    }

    let after = null;
    let exactReadbackRows = [];
    let readbackAttempts = 0;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      readbackAttempts = attempt;
      after = await queryCurrentLimitedDiscounts();
      exactReadbackRows = verifyExactCreatedCoverage(after, executableTargetRows, createdActivityId);
      if (createdActivityId && exactReadbackRows.length === executableTargetRows.length && exactReadbackRows.every(row => row.ok)) break;
      if (attempt < 6) await new Promise(resolve => setTimeout(resolve, 1500));
    }
    const overlapBySkc = new Map();
    for (const row of after.overlaps) {
      if (!overlapBySkc.has(row.skc)) overlapBySkc.set(row.skc, []);
      overlapBySkc.get(row.skc).push(row);
    }
    const duplicateOverlapSkcs = [...overlapBySkc.entries()]
      .filter(([, rows]) => rows.length > 1)
      .map(([skc, rows]) => ({skc, rows}));
    const uncoveredAfter = targetSkcs.filter(skc => !overlapBySkc.has(skc));
    const skippedSet = new Set(result.skippedUnreportable.map(row => row.skc));
    const unexpectedUncoveredAfter = uncoveredAfter.filter(skc => !skippedSet.has(skc));
    result.after = {
      activeOrFuture: after.activeOrFuture.map(activity => ({
        activity_id: activity.activity_id,
        act_name: activity.act_name,
        state: activity.state,
        start_time: activity.start_time,
        end_time: activity.end_time,
      })),
      conflictActivities: summarizeConflicts(after.conflictActivities),
      overlapCount: after.overlaps.length,
      overlapSkcCount: [...overlapBySkc.keys()].length,
      duplicateOverlapSkcs,
      uncoveredAfter,
      unexpectedUncoveredAfter,
      exactReadbackRows,
      readbackAttempts,
    };
    result.ok =
      Boolean(result.createdActivityId) &&
      result.after.overlapSkcCount === result.targetCountForCreate &&
      result.after.unexpectedUncoveredAfter.length === 0 &&
      result.after.duplicateOverlapSkcs.length === 0 &&
      result.after.exactReadbackRows.length === result.targetCountForCreate &&
      result.after.exactReadbackRows.every(row => row.ok);
    return result;
    `,
    {
      targetRows,
      execute: args.execute,
      targetRefToolId: TARGET_REF_TOOL_ID,
      targetEndTime: effectiveEndTime,
      activityStock: effectiveActivityStock,
      startDelayMinutes: args.startDelayMinutes,
      activityNamePrefix: effectiveActivityNamePrefix,
      replaceActivityIds: args.replaceActivityIds,
    },
  );

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  outPath = path.join(args.outDir, `hl-limited-discount-rescue-apply-${args.execute ? 'execute' : 'dry-run'}-${stamp}.json`);
  await fs.writeFile(outPath, JSON.stringify({
    createdAt: new Date().toISOString(),
    storeKey: store.storeKey,
    port: args.port,
    rescuePath: rel(args.rescue),
    identity,
    loginRecovery,
    automationAuthorization,
    targetEndTime: effectiveEndTime,
    activityNamePrefix: effectiveActivityNamePrefix,
    ...result,
  }, null, 2), 'utf8');

  console.log(JSON.stringify({
    ok: result.ok,
    execute: args.execute,
    out: rel(outPath),
    targetCount: result.targetCount,
    beforeConflictActivities: result.before.conflictActivities.map(a => ({
      activity_id: a.activity_id,
      state: a.state,
      targetCount: a.targetCount,
      extraCount: a.extraCount,
      end_time: a.end_time,
    })),
    validation: result.validation,
    endedActivities: result.endedActivities?.map(a => ({
      activity_id: a.activity_id,
      previous_state: a.previous_state,
      promotion_action_state: a.promotion_action_state,
      code: a.response?.code,
      msg: a.response?.msg,
    })) || [],
    createdActivityId: result.createdActivityId,
    after: result.after ? {
      overlapSkcCount: result.after.overlapSkcCount,
      duplicateOverlapSkcs: result.after.duplicateOverlapSkcs.length,
      uncoveredAfter: result.after.uncoveredAfter.length,
      exactReadbackOk: result.after.exactReadbackRows.filter(row => row.ok).length,
      exactReadbackExpected: result.after.exactReadbackRows.length,
      readbackAttempts: result.after.readbackAttempts,
      activeOrFuture: result.after.activeOrFuture,
    } : null,
  }, null, 2));

  if (!result.ok) process.exitCode = 2;
} catch (error) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  outPath = path.join(args.outDir, `hl-limited-discount-rescue-apply-${args.execute ? 'execute' : 'dry-run'}-failed-${stamp}.json`);
  const doc = {
    createdAt: new Date().toISOString(),
    storeKey: store.storeKey,
    port: args.port,
    rescuePath: rel(args.rescue),
    execute: args.execute,
    automationAuthorization,
    ok: false,
    error: {
      message: error.message,
      stack: error.stack,
      packet: error.packet,
      unsafe: error.unsafe,
      validation: error.validation,
      endedCheck: error.endedCheck,
      loginRecovery: error.loginRecovery,
    },
  };
  await fs.writeFile(outPath, JSON.stringify(doc, null, 2), 'utf8');
  console.error(JSON.stringify({ok: false, execute: args.execute, out: rel(outPath), error: error.message}, null, 2));
  process.exitCode = 1;
} finally {
  cdp.close();
}
