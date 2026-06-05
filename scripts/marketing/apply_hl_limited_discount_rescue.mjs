import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  requireStoreIdentitySnapshot,
  storeIdentityEvalBody,
} from '../../lib/shein_store_identity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_OUT_DIR = path.join(ROOT, 'tmp/marketing-signup/limited-discount-rescue');
const DEFAULT_PORT = 9360;
const TARGET_REF_TOOL_ID = 175;
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
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--execute') args.execute = true;
    else if (arg === '--dry-run') args.execute = false;
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
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(args.port) || args.port <= 0) throw new Error(`Invalid --port: ${args.port}`);
  if (!args.storeKey) throw new Error('Missing --store-key for identity guard');
  if (!args.rescue) throw new Error('Missing --rescue <rescue-json>. Do not rely on a hard-coded one-off batch path.');
  if (!args.endTime) throw new Error('Missing --end-time "YYYY-MM-DD HH:mm:ss" for the limited-discount rescue window.');
  const end = new Date(String(args.endTime).replace(' ', 'T') + '+08:00');
  if (!Number.isFinite(end.getTime())) throw new Error(`Invalid --end-time: ${args.endTime}`);
  if (!Number.isFinite(args.startDelayMinutes) || args.startDelayMinutes < 1) {
    throw new Error(`Invalid --start-delay-minutes: ${args.startDelayMinutes}`);
  }
  return args;
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
      }, 180000);
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

function normalizeTargetRows(rescue) {
  const rows = (rescue.rows || [])
    .filter(row => row && row.needsLimitedDiscount !== false)
    .map(row => ({
      skc: String(row.skc || '').trim(),
      canonical: row.canonical || '',
      supplierNo: row.supplierNo || row.currentSupplierNo || '',
      limitedDiscountPrice: Number(row.limitedDiscountPrice),
      expectedFinalAfterLimitedAnd15Coupon: row.expectedFinalAfterLimitedAnd15Coupon ?? '',
      originalPlannedFinalPrice: row.originalPlannedFinalPrice ?? '',
      originalMarketingPrice: row.originalMarketingPrice ?? '',
      priceSourceActivityId: row.priceSourceActivityId ?? '',
      combo: row.combo || '',
      sourceRule: row.sourceRule || '',
      note: row.note || '',
    }));
  const missing = rows.filter(row => !row.skc || !Number.isFinite(row.limitedDiscountPrice) || row.limitedDiscountPrice <= 0);
  if (missing.length) throw new Error(`Rescue target rows have missing SKC/price: ${JSON.stringify(missing.slice(0, 5))}`);
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
await fs.mkdir(args.outDir, {recursive: true});
const rescue = JSON.parse(await fs.readFile(args.rescue, 'utf8'));
const targetRows = normalizeTargetRows(rescue);
const store = STORES.find(s => String(s.storeKey).toUpperCase() === args.storeKey);
if (!store) throw new Error(`Unknown store for identity guard: ${args.storeKey}`);

const cdp = await connect(args.port);
let outPath;
try {
  const identity = await assertCurrentStoreIdentity(cdp, store, 'apply_hl_limited_discount_rescue');
  const result = await cdp.eval(
    `
    const {
      targetRows,
      execute,
      targetRefToolId,
      targetEndTime,
      startDelayMinutes,
    } = __arg;

    const headers = {'content-type': 'application/json;charset=UTF-8'};
    const targetSkcs = targetRows.map(row => row.skc);
    const targetSet = new Set(targetSkcs);
    const targetBySkc = new Map(targetRows.map(row => [row.skc, row]));
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
        act_name: 'HL漏报补救限时折扣' + fmtDate(new Date()).slice(0, 10).replaceAll('-', ''),
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
        const attendNum = Math.max(minStock, Math.min(maxStock, inventory));

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

        const isSaleAttribute = Number(good.is_sale_attribute) === 1;
        const addSkuList = Array.isArray(good.sku_info_list)
          ? good.sku_info_list.map(sku => {
              const skuSupplyInfo = sku.supply_price_info || {};
              const skuRow = isSaleAttribute
                ? {
                    id: sku.id,
                    cost_price: Number(skuSupplyInfo.supply_price),
                    sku: sku.sku,
                    max_product_act_price: Number(skuSupplyInfo.max_supply_price),
                    product_act_price: price,
                  }
                : {
                    id: sku.id,
                    cost_price: 0,
                    sku: sku.sku,
                    max_product_act_price: 0,
                    product_act_price: 0,
                  };
              Object.keys(skuRow).forEach(key => skuRow[key] === undefined && delete skuRow[key]);
              return skuRow;
            })
          : [];

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
          sourceRule: target.sourceRule,
          combo: target.combo,
        });
      }
      return {missing, invalid, addRows, detailRows};
    }

    function groupInvalidBySkc(invalidRows) {
      const grouped = new Map();
      for (const invalid of invalidRows || []) {
        if (!grouped.has(invalid.skc)) grouped.set(invalid.skc, []);
        grouped.get(invalid.skc).push(invalid);
      }
      return grouped;
    }

    function classifyPostEndInvalid(invalidRows) {
      const grouped = groupInvalidBySkc(invalidRows);
      const hardReasons = new Set([
        'invalid target price',
        'price exceeds max_supply_price',
        'price hits rate_intercept floor',
      ]);
      const hardInvalid = [];
      const blockedSkcs = [];
      for (const [skc, rows] of grouped.entries()) {
        if (rows.some(row => hardReasons.has(row.reason))) {
          hardInvalid.push(...rows);
        } else {
          blockedSkcs.push(skc);
        }
      }
      return {hardInvalid, blockedSkcs};
    }

    async function waitForEnded(activityIds) {
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, attempt === 1 ? 1200 : 2500));
        const current = await queryCurrentLimitedDiscounts();
        const stillActive = current.conflictActivities
          .filter(entry => activityIds.includes(Number(entry.activity.activity_id)))
          .map(entry => ({
            activity_id: entry.activity.activity_id,
            state: entry.activity.state,
            targetCount: entry.targetGoods.length,
            extraCount: entry.extraGoods.length,
          }));
        if (!stillActive.length) return {ok: true, attempts: attempt, current};
      }
      const current = await queryCurrentLimitedDiscounts();
      return {
        ok: false,
        attempts: 8,
        current,
        stillActive: summarizeConflicts(current.conflictActivities.filter(entry => activityIds.includes(Number(entry.activity.activity_id)))),
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
    assertSafeToEnd(before.conflictActivities);

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
      targetCountForCreate: targetRows.length,
      skippedUnreportable: [],
      postEndValidation: null,
      after: null,
      ok: false,
    };

    if (validationFailed) {
      result.validationFailed = true;
      if (!execute) return result;
    }

    if (!execute) {
      result.ok = true;
      result.dryRunOnly = true;
      return result;
    }

    const conflictActivityIds = before.conflictActivities.map(entry => Number(entry.activity.activity_id));
    for (const entry of before.conflictActivities) {
      const state = Number(entry.activity.state);
      const actionState = state === 3 ? 6 : 5;
      const packet = await post('/promotion/obm/undo_or_end_obm_activity', {
        activity_id: Number(entry.activity.activity_id),
        promotion_action_state: actionState,
      });
      result.endedActivities.push({
        activity_id: Number(entry.activity.activity_id),
        previous_state: state,
        promotion_action_state: actionState,
        response: {code: packet.code, msg: packet.msg, info: packet.info},
      });
    }

    const endedCheck = await waitForEnded(conflictActivityIds);
    result.endedCheck = {
      ok: endedCheck.ok,
      attempts: endedCheck.attempts,
      stillActive: endedCheck.stillActive || [],
    };
    if (!endedCheck.ok) {
      const err = new Error('Existing limited-discount activities did not end after undo/end calls; aborting create');
      err.endedCheck = result.endedCheck;
      throw err;
    }

    const postEndCheckPacket = await post('/promotion/simple_platform/check_activity', activityBase);
    const postEndEffectiveCenterList = postEndCheckPacket.info?.effective_center_list || [];
    const postEndQueryGoodsPacket = await post('/promotion/simple_platform/query_goods', {
      page_size: 500,
      page_num: 1,
      activity_base_info_request: {...activityBase, sub_type_id: 2},
      effective_center_list: postEndEffectiveCenterList,
      skc_list: targetSkcs,
      is_shelf: 1,
    });
    const postEndQueryGoodsRows = postEndQueryGoodsPacket.info?.data || postEndQueryGoodsPacket.info || [];
    const postEndGoodsBuild = buildAddCostRows(postEndQueryGoodsRows, postEndCheckPacket.info);
    const postEndInvalid = classifyPostEndInvalid(postEndGoodsBuild.invalid);
    result.postEndValidation = {
      missing: postEndGoodsBuild.missing,
      invalid: postEndGoodsBuild.invalid,
      addRows: postEndGoodsBuild.addRows.length,
      targetRows: targetRows.length,
      hardInvalid: postEndInvalid.hardInvalid,
      blockedSkcs: postEndInvalid.blockedSkcs,
    };
    if (postEndGoodsBuild.missing.length || postEndInvalid.hardInvalid.length) {
      const err = new Error('Post-end validation failed; aborting create');
      err.validation = result.postEndValidation;
      throw err;
    }

    const blockedSet = new Set(postEndInvalid.blockedSkcs);
    const executableTargetRows = targetRows.filter(row => !blockedSet.has(row.skc));
    const executableGoodsBuild = buildAddCostRows(postEndQueryGoodsRows, postEndCheckPacket.info, executableTargetRows);
    if (executableGoodsBuild.missing.length || executableGoodsBuild.invalid.length || executableGoodsBuild.addRows.length !== executableTargetRows.length) {
      const err = new Error('Executable subset validation failed; aborting create');
      err.validation = {
        missing: executableGoodsBuild.missing,
        invalid: executableGoodsBuild.invalid,
        addRows: executableGoodsBuild.addRows.length,
        executableTargetRows: executableTargetRows.length,
      };
      throw err;
    }
    result.targetCountForCreate = executableTargetRows.length;
    result.skippedUnreportable = targetRows
      .filter(row => blockedSet.has(row.skc))
      .map(row => ({
        skc: row.skc,
        canonical: row.canonical,
        supplierNo: row.supplierNo,
        reasons: (groupInvalidBySkc(postEndGoodsBuild.invalid).get(row.skc) || []).map(item => ({
          reason: item.reason,
          error_code: item.error_code,
          inventory: item.inventory,
          minStock: item.minStock,
        })),
      }));
    result.plannedGoods = executableGoodsBuild.detailRows;
    createPayload = {
      ...createPayload,
      add_cost_and_stock_info_list: executableGoodsBuild.addRows,
    };
    result.createPayload = createPayload;

    if (result.targetCountForCreate <= 0) {
      const err = new Error('No executable limited-discount target rows remain after post-end validation');
      err.validation = result.postEndValidation;
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

    const after = await queryCurrentLimitedDiscounts();
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
    };
    result.ok =
      result.after.overlapSkcCount === result.targetCountForCreate &&
      result.after.unexpectedUncoveredAfter.length === 0 &&
      result.after.duplicateOverlapSkcs.length === 0;
    return result;
    `,
    {
      targetRows,
      execute: args.execute,
      targetRefToolId: TARGET_REF_TOOL_ID,
      targetEndTime: rescue.endTime || args.endTime,
      startDelayMinutes: args.startDelayMinutes,
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
    ok: false,
    error: {
      message: error.message,
      stack: error.stack,
      packet: error.packet,
      unsafe: error.unsafe,
      validation: error.validation,
      endedCheck: error.endedCheck,
    },
  };
  await fs.writeFile(outPath, JSON.stringify(doc, null, 2), 'utf8');
  console.error(JSON.stringify({ok: false, execute: args.execute, out: rel(outPath), error: error.message}, null, 2));
  process.exitCode = 1;
} finally {
  cdp.close();
}
