#!/usr/bin/env node
/**
 * Build the next-generation SHEIN BI system dashboards in Metabase.
 *
 * Positioning:
 * - Metabase is the BI analysis layer.
 * - These dashboards are organized as business domains, not as one-off Feishu
 *   style charts.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const SESSION_PATH = path.join(ROOT, 'infra', 'metabase', '.session.local.json');

function readSessionInfo() {
  if (!fs.existsSync(SESSION_PATH)) throw new Error('Metabase session file not found. Run setup first.');
  return JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'));
}

const BASE_URL = (process.env.METABASE_URL || readSessionInfo().metabaseUrl || 'http://localhost:3000').replace(/\/$/, '');
let WAREHOUSE_DATABASE_ID = Number(process.env.METABASE_WAREHOUSE_DB_ID || 0);

function readSession() {
  return readSessionInfo().sessionId;
}

async function api(pathname, opts = {}) {
  const sessionId = readSession();
  const res = await fetch(BASE_URL + pathname, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-Metabase-Session': sessionId,
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${pathname} -> ${res.status}: ${text.slice(0, 1600)}`);
  return data;
}

async function resolveWarehouseDatabaseId() {
  if (WAREHOUSE_DATABASE_ID > 0) return WAREHOUSE_DATABASE_ID;
  const dbs = await api('/api/database');
  const list = dbs.data || dbs;
  const db = Array.isArray(list) ? list.find(x => x.name === 'SHEIN BI Warehouse') : null;
  if (!db?.id) throw new Error('Cannot find database SHEIN BI Warehouse');
  WAREHOUSE_DATABASE_ID = db.id;
  return db.id;
}

async function dataset(sql) {
  return api('/api/dataset', {
    method: 'POST',
    body: JSON.stringify({
      database: WAREHOUSE_DATABASE_ID,
      type: 'native',
      native: {query: sql, 'template-tags': {}},
    }),
  });
}

async function findByExactName(model, name) {
  const s = await api('/api/search?' + new URLSearchParams({q: name}).toString());
  return (s.data || []).find(x => x.model === model && x.name === name && !x.archived) || null;
}

async function ensureCollection(name, description) {
  const existing = await findByExactName('collection', name);
  if (existing) return existing;
  return api('/api/collection', {
    method: 'POST',
    body: JSON.stringify({name, description, color: '#8B5CF6'}),
  });
}

async function archiveExisting(model, name) {
  const existing = await findByExactName(model, name);
  if (!existing) return null;
  const endpoint = model === 'card' ? `/api/card/${existing.id}` : `/api/dashboard/${existing.id}`;
  await api(endpoint, {method: 'PUT', body: JSON.stringify({archived: true})}).catch(() => null);
  return existing.id;
}

function cardPayload(def, collectionId) {
  return {
    name: def.name,
    description: def.description || def.name,
    display: def.display || 'table',
    collection_id: collectionId,
    dataset_query: {
      database: WAREHOUSE_DATABASE_ID,
      type: 'native',
      native: {query: def.sql, 'template-tags': {}},
    },
    visualization_settings: def.settings || {},
  };
}

async function createCard(def, collectionId) {
  await dataset(def.sql);
  await archiveExisting('card', def.name);
  return api('/api/card', {method: 'POST', body: JSON.stringify(cardPayload(def, collectionId))});
}

async function createDashboard(def, collectionId) {
  const cards = [];
  for (const cardDef of def.cards) cards.push(await createCard(cardDef, collectionId));
  await archiveExisting('dashboard', def.name);
  const dash = await api('/api/dashboard', {
    method: 'POST',
    body: JSON.stringify({name: def.name, description: def.description, collection_id: collectionId}),
  });
  const dashcards = cards.map((card, index) => ({
    id: -(index + 1),
    card_id: card.id,
    row: def.layouts[index]?.row ?? index * 5,
    col: def.layouts[index]?.col ?? 0,
    size_x: def.layouts[index]?.size_x ?? 24,
    size_y: def.layouts[index]?.size_y ?? 6,
    parameter_mappings: [],
    inline_parameters: [],
    series: [],
    visualization_settings: {},
  }));
  const updated = await api(`/api/dashboard/${dash.id}`, {
    method: 'PUT',
    body: JSON.stringify({dashcards, tabs: [], width: 'full'}),
  });
  return {id: dash.id, name: dash.name, cardCount: updated.dashcards?.length || 0, cards: cards.map(c => ({id: c.id, name: c.name}))};
}

const dashboards = [
  {
    name: 'SHEIN BI · 经营系统首页',
    description: '面向每天经营决策的总入口：先看风险，再进店铺、货号、链接、退货、库存、履约和营销。',
    layouts: [
      {row:0,col:0,size_x:4,size_y:3},{row:0,col:4,size_x:4,size_y:3},{row:0,col:8,size_x:4,size_y:3},
      {row:0,col:12,size_x:4,size_y:3},{row:0,col:16,size_x:4,size_y:3},{row:0,col:20,size_x:4,size_y:3},
      {row:3,col:0,size_x:24,size_y:8},{row:11,col:0,size_x:12,size_y:7},{row:11,col:12,size_x:12,size_y:7},
      {row:18,col:0,size_x:24,size_y:8},{row:26,col:0,size_x:24,size_y:8},
    ],
    cards: [
      {
        name: '系统首页 · 最新销售额',
        display: 'scalar',
        sql: `select round(sum(sales_sar)::numeric,2) as "销售额 SAR" from fact.store_daily_sales where date = (select max(date) from fact.store_daily_sales);`,
      },
      {
        name: '系统首页 · 待结算收入',
        display: 'scalar',
        sql: `select round(sum(pending_settlement_income_sar)::numeric,2) as "待结算收入 SAR" from fact.home_finance_snapshot where snapshot_date = (select max(snapshot_date) from fact.home_finance_snapshot);`,
      },
      {
        name: '系统首页 · 售后单数',
        display: 'scalar',
        sql: `select count(distinct aftersales_order_no)::int as "售后单数" from fact.after_sales_item where snapshot_date = (select max(snapshot_date) from fact.after_sales_item);`,
      },
      {
        name: '系统首页 · 低展示库存',
        display: 'scalar',
        sql: `select count(*)::int as "低库存SPU" from fact.visible_inventory_snapshot where snapshot_date = (select max(snapshot_date) from fact.visible_inventory_snapshot) and display_stock_low;`,
      },
      {
        name: '系统首页 · 质量低星评价',
        display: 'scalar',
        sql: `select count(*)::int as "低星评价" from fact.product_comment where comment_date >= (select max(snapshot_date) from fact.home_finance_snapshot) - interval '90 days' and goods_comment_star <= 3;`,
      },
      {
        name: '系统首页 · 指导动作数',
        display: 'scalar',
        sql: `select count(*)::int as "动作数" from mart.bi_guided_action_current;`,
      },
      {
        name: '系统首页 · 全店经营健康矩阵',
        display: 'table',
        description: '总览表。每天先看风险分和异常项，再决定进哪个业务域。',
        sql: `select
  store_key as "店铺",
  group_key as "分组",
  round(sales_sar::numeric,2) as "销售额SAR",
  valid_order_count as "订单数",
  round(realtime_trade_amount_sar::numeric,2) as "实时成交SAR",
  round(pending_settlement_income_sar::numeric,2) as "待结算SAR",
  after_sales_case_count as "售后单",
  low_display_stock_count as "低展示库存",
  quality_after_sales_item_count as "质量售后件",
  low_star_comment_count as "低星评价",
  waybill_exception_count as "发货异常",
  link_action_count as "链接动作",
  retire_action_count as "下架候选",
  round(risk_score::numeric,1) as "经营风险分"
from mart.bi_business_store_current
order by risk_score desc, sales_sar desc;`,
      },
      {
        name: '系统首页 · 店铺风险排行',
        display: 'bar',
        sql: `select store_key as "店铺", round(risk_score::numeric,1) as "经营风险分" from mart.bi_business_store_current order by risk_score desc;`,
      },
      {
        name: '系统首页 · 业务动作结构',
        display: 'bar',
        sql: `select action_domain as "业务域", count(*)::int as "动作数" from mart.bi_guided_action_current group by action_domain order by "动作数" desc;`,
      },
      {
        name: '系统首页 · 今日指导动作池',
        display: 'table',
        sql: `select
  action_domain as "业务域",
  date as "日期",
  store_key as "店铺",
  priority as "优先级",
  round(score::numeric,1) as "评分",
  standard_goods_sn as "标准货号",
  skc as "SKC",
  category as "分类",
  title as "对象",
  reason as "原因",
  evidence as "证据",
  next_step as "下一步"
from mart.bi_guided_action_current
order by score desc, date desc, store_key
limit 500;`,
      },
      {
        name: '系统首页 · 货号360风险排行',
        display: 'table',
        sql: `select
  standard_goods_sn as "标准货号",
  round(sales_sar::numeric,2) as "销售额SAR",
  quantity as "销量",
  on_shelf_store_count as "上架店数",
  missing_store_count as "缺链接店数",
  usable_inventory as "可用展示库存",
  after_sales_case_count as "售后单",
  quality_return_volume as "质量退货量",
  low_star_comment_count as "低星评价",
  round(risk_score::numeric,1) as "风险分"
from mart.bi_product_360_current
where risk_score > 0 or sales_sar > 0
order by risk_score desc, sales_sar desc
limit 300;`,
      },
    ],
  },
  {
    name: 'SHEIN BI · 财务订单域',
    description: '把订单销售、我的收入、在途订单明细、待结算、已结算和账期放在一起，优先用于核对收入和发现结算异常。',
    layouts: [
      {row:0,col:0,size_x:4,size_y:3},{row:0,col:4,size_x:4,size_y:3},{row:0,col:8,size_x:4,size_y:3},
      {row:0,col:12,size_x:4,size_y:3},{row:0,col:16,size_x:4,size_y:3},{row:0,col:20,size_x:4,size_y:3},
      {row:3,col:0,size_x:24,size_y:8},{row:11,col:0,size_x:24,size_y:8},
      {row:19,col:0,size_x:12,size_y:8},{row:19,col:12,size_x:12,size_y:8},
    ],
    cards: [
      {
        name: '财务订单 · 总销售额',
        display: 'scalar',
        sql: `select round(sum(sales_sar)::numeric,2) as "销售额SAR" from mart.bi_business_store_current;`,
      },
      {
        name: '财务订单 · 在途订单金额',
        display: 'scalar',
        sql: `select round(sum(in_transit_order_amount_sar)::numeric,2) as "在途SAR" from mart.bi_business_store_current;`,
      },
      {
        name: '财务订单 · 待结算收入',
        display: 'scalar',
        sql: `select round(sum(pending_settlement_income_sar)::numeric,2) as "待结算SAR" from mart.bi_business_store_current;`,
      },
      {
        name: '财务订单 · 已完成结算收入',
        display: 'scalar',
        sql: `select round(sum(payed_income_sar)::numeric,2) as "已结算SAR" from mart.bi_business_store_current;`,
      },
      {
        name: '财务订单 · 在途收入明细单数',
        display: 'scalar',
        sql: `select coalesce(sum(finance_no_finish_order_count),0)::int as "在途明细单数" from mart.bi_business_store_current;`,
      },
      {
        name: '财务订单 · 结算异常金额',
        display: 'scalar',
        sql: `select round(sum(settlement_abnormal_sar)::numeric,2) as "异常SAR" from mart.bi_business_store_current;`,
      },
      {
        name: '财务订单 · 店铺订单财务表',
        display: 'table',
        sql: `select
  store_key as "店铺",
  sales_date as "销售日期",
  round(sales_sar::numeric,2) as "销售额SAR",
  valid_order_count as "订单数",
  quantity as "销量",
  round(realtime_trade_amount_sar::numeric,2) as "实时成交SAR",
  realtime_pay_user_count as "实时支付人数",
  realtime_goods_uv as "实时商详访客",
  round(in_transit_order_amount_sar::numeric,2) as "在途订单SAR",
  finance_no_finish_order_count as "在途明细单数",
  round(finance_no_finish_order_income_sar::numeric,2) as "在途明细SAR",
  round(pending_settlement_income_sar::numeric,2) as "待结算SAR",
  round(payed_income_sar::numeric,2) as "已结算SAR",
  account_period_days as "账期天数",
  round(settlement_abnormal_sar::numeric,2) as "结算异常SAR",
  round(withdrawable_amount_sar::numeric,2) as "可提现SAR"
from mart.bi_business_store_current
order by sales_sar desc, store_key;`,
      },
      {
        name: '财务订单 · 在途收入明细',
        display: 'table',
        sql: `select
  store_key as "店铺",
  order_delivery_time as "发货日",
  order_no as "订单号",
  finance_row_id as "财务ID",
  big_category_name as "大类",
  second_order_type_name as "类型",
  seller_currency_code as "币种",
  round(estimate_income_money_total::numeric,2) as "预估收入",
  goods_detail_count as "商品明细",
  finance_detail_count as "财务明细",
  check_status as "核对状态"
from fact.finance_no_finish_order
where snapshot_date = (select max(snapshot_date) from fact.finance_no_finish_order)
order by order_delivery_time desc nulls last, estimate_income_money_total desc nulls last, store_key
limit 500;`,
      },
      {
        name: '财务订单 · 销售排行',
        display: 'bar',
        sql: `select store_key as "店铺", round(sales_sar::numeric,2) as "销售额SAR" from mart.bi_business_store_current order by sales_sar desc;`,
      },
      {
        name: '财务订单 · 待结算排行',
        display: 'bar',
        sql: `select store_key as "店铺", round(pending_settlement_income_sar::numeric,2) as "待结算SAR" from mart.bi_business_store_current where pending_settlement_income_sar > 0 order by pending_settlement_income_sar desc;`,
      },
    ],
  },
  {
    name: 'SHEIN BI · 退货质量域',
    description: '把售后、质量诊断、低星评价和货号链接表现放在一起，定位“为什么退、该优化还是下架”。',
    layouts: [
      {row:0,col:0,size_x:6,size_y:3},{row:0,col:6,size_x:6,size_y:3},{row:0,col:12,size_x:6,size_y:3},{row:0,col:18,size_x:6,size_y:3},
      {row:3,col:0,size_x:24,size_y:8},{row:11,col:0,size_x:12,size_y:8},{row:11,col:12,size_x:12,size_y:8},{row:19,col:0,size_x:24,size_y:8},
    ],
    cards: [
      {
        name: '退货质量 · 售后单数',
        display: 'scalar',
        sql: `select count(distinct aftersales_order_no)::int as "售后单数" from fact.after_sales_item where snapshot_date = (select max(snapshot_date) from fact.after_sales_item);`,
      },
      {
        name: '退货质量 · 售后金额',
        display: 'scalar',
        sql: `select round(sum(price_amount)::numeric,2) as "售后商品金额SAR" from fact.after_sales_item where snapshot_date = (select max(snapshot_date) from fact.after_sales_item);`,
      },
      {
        name: '退货质量 · 质量退货SKC',
        display: 'scalar',
        sql: `select count(*)::int as "质量退货SKC" from fact.quality_skc_snapshot where snapshot_date = (select max(snapshot_date) from fact.quality_skc_snapshot) and coalesce(quality_return_volume,0) > 0;`,
      },
      {
        name: '退货质量 · 低星评价',
        display: 'scalar',
        sql: `select count(*)::int as "低星评价" from fact.product_comment where comment_date >= (select max(snapshot_date) from fact.home_finance_snapshot) - interval '90 days' and goods_comment_star <= 3;`,
      },
      {
        name: '退货质量 · 货号质量风险排行',
        display: 'table',
        sql: `select
  standard_goods_sn as "标准货号",
  round(sales_sar::numeric,2) as "销售额SAR",
  after_sales_case_count as "售后单",
  round(after_sales_amount_sar::numeric,2) as "售后金额SAR",
  quality_return_volume as "质量退货量",
  round(avg_quality_return_rate::numeric,4) as "质量退货率",
  round(avg_bad_eval_rate::numeric,4) as "差评率",
  comment_count as "评价数",
  low_star_comment_count as "低星评价",
  after_sales_reasons as "售后原因",
  round(risk_score::numeric,1) as "风险分"
from mart.bi_product_360_current
where after_sales_case_count > 0 or quality_return_volume > 0 or low_star_comment_count > 0
order by risk_score desc, after_sales_case_count desc, quality_return_volume desc
limit 300;`,
      },
      {
        name: '退货质量 · 售后原因分布',
        display: 'bar',
        sql: `select coalesce(reason_names,'未知') as "售后原因", count(distinct aftersales_order_no)::int as "售后单数"
from fact.after_sales_item
where snapshot_date = (select max(snapshot_date) from fact.after_sales_item)
group by reason_names
order by "售后单数" desc
limit 30;`,
      },
      {
        name: '退货质量 · 低星评价明细',
        display: 'table',
        sql: `select
  store_key as "店铺",
  comment_time as "评价时间",
  standard_goods_sn as "标准货号",
  skc as "SKC",
  goods_comment_star as "星级",
  goods_comment_content as "评价内容",
  bill_no as "订单号"
from fact.product_comment
where goods_comment_star <= 3
order by comment_time desc
limit 200;`,
      },
      {
        name: '退货质量 · 售后明细',
        display: 'table',
        sql: `select
  store_key as "店铺",
  request_time as "申请时间",
  aftersales_order_no as "售后单",
  order_no as "订单号",
  standard_goods_sn as "标准货号",
  raw_goods_sn as "原始货号",
  sku_sn as "SKU",
  quantity as "数量",
  price_amount as "金额SAR",
  reason_names as "原因",
  order_sub_status_name as "状态"
from fact.after_sales_item
where snapshot_date = (select max(snapshot_date) from fact.after_sales_item)
order by request_time desc
limit 300;`,
      },
    ],
  },
  {
    name: 'SHEIN BI · 库存履约营销域',
    description: '用正确商品列表库存接口看展示库存，同时联动发货履约和活动效果。',
    layouts: [
      {row:0,col:0,size_x:6,size_y:3},{row:0,col:6,size_x:6,size_y:3},{row:0,col:12,size_x:6,size_y:3},{row:0,col:18,size_x:6,size_y:3},
      {row:3,col:0,size_x:24,size_y:8},{row:11,col:0,size_x:12,size_y:8},{row:11,col:12,size_x:12,size_y:8},{row:19,col:0,size_x:24,size_y:8},
    ],
    cards: [
      {
        name: '库存履约营销 · 展示库存总数',
        display: 'scalar',
        sql: `select sum(inventory_quantity)::int as "展示库存" from fact.visible_inventory_snapshot where snapshot_date = (select max(snapshot_date) from fact.visible_inventory_snapshot);`,
      },
      {
        name: '库存履约营销 · 低展示库存SPU',
        display: 'scalar',
        sql: `select count(*)::int as "低库存SPU" from fact.visible_inventory_snapshot where snapshot_date = (select max(snapshot_date) from fact.visible_inventory_snapshot) and display_stock_low;`,
      },
      {
        name: '库存履约营销 · 面单包裹数',
        display: 'scalar',
        sql: `select count(*)::int as "面单包裹" from fact.waybill_package where snapshot_date = (select max(snapshot_date) from fact.waybill_package);`,
      },
      {
        name: '库存履约营销 · 活动数',
        display: 'scalar',
        sql: `select count(*)::int as "活动数" from fact.marketing_campaign_snapshot where snapshot_date = (select max(snapshot_date) from fact.marketing_campaign_snapshot);`,
      },
      {
        name: '库存履约营销 · 展示库存明细',
        display: 'table',
        sql: `select
  store_key as "店铺",
  standard_goods_sn as "标准货号",
  spu as "SPU",
  skc_list as "SKC列表",
  inventory_quantity as "总展示库存",
  usable_inventory as "可用展示库存",
  order_locked_quantity as "下单锁定",
  pay_locked_quantity as "支付锁定",
  case when display_stock_low then '是' else '否' end as "低库存",
  shelf_statuses as "链接状态"
from fact.visible_inventory_snapshot
where snapshot_date = (select max(snapshot_date) from fact.visible_inventory_snapshot)
order by display_stock_low desc, usable_inventory asc, store_key
limit 300;`,
      },
      {
        name: '库存履约营销 · 履约指标趋势',
        display: 'line',
        sql: `select
  date as "日期",
  store_key as "店铺",
  collect_ok_rate as "揽收达成率",
  seller_cancel_rate as "卖家取消率",
  delivery_timeout_rate as "发货超时率",
  valid_track_rate as "有效轨迹率"
from fact.fulfillment_performance_daily
where date >= (select max(date) from fact.fulfillment_performance_daily) - interval '30 days'
order by date, store_key;`,
      },
      {
        name: '库存履约营销 · 发货面单明细',
        display: 'table',
        sql: `select
  store_key as "店铺",
  collect_time as "揽收时间",
  print_time as "打印时间",
  express_code as "运单号",
  provider_name as "物流商",
  warehouse_name as "发货仓",
  show_status_desc as "状态",
  estimate_performance_price as "预估运费SAR",
  order_no_list as "订单",
  skc_list as "SKC"
from fact.waybill_package
where snapshot_date = (select max(snapshot_date) from fact.waybill_package)
order by collect_time desc nulls last, print_time desc nulls last
limit 300;`,
      },
      {
        name: '库存履约营销 · 营销活动明细',
        display: 'table',
        sql: `select
  store_key as "店铺",
  activity_name as "活动",
  active_status as "状态",
  start_date as "开始",
  end_date as "结束",
  active_product_cnt as "活动商品数",
  avg_product_sale as "平均销量",
  goods_uv as "商品访客",
  cart_uv as "加车访客",
  sale_amt as "活动销售额"
from fact.marketing_campaign_snapshot
where snapshot_date = (select max(snapshot_date) from fact.marketing_campaign_snapshot)
order by start_date desc, sale_amt desc nulls last
limit 200;`,
      },
    ],
  },
];

async function main() {
  await resolveWarehouseDatabaseId();
  const collection = await ensureCollection('SHEIN BI 经营系统', '系统化经营 BI：经营首页、财务订单、退货质量、库存履约营销。');
  const out = [];
  for (const def of dashboards) out.push(await createDashboard(def, collection.id));
  console.log(JSON.stringify({ok: true, baseUrl: BASE_URL, collection: {id: collection.id, name: collection.name}, dashboards: out}, null, 2));
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
