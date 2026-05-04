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
      ...(opts.headers || {})
    }
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = new Error(`${opts.method || 'GET'} ${pathname} -> ${res.status}: ${text.slice(0, 1600)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function dataset(sql) {
  return api('/api/dataset', {
    method: 'POST',
    body: JSON.stringify({ database: WAREHOUSE_DATABASE_ID, type: 'native', native: { query: sql, 'template-tags': {} } })
  });
}

function cardPayload({ name, description, sql, display = 'table', settings = {} }, collectionId) {
  return {
    name,
    description,
    display,
    collection_id: collectionId,
    dataset_query: {
      database: WAREHOUSE_DATABASE_ID,
      type: 'native',
      native: { query: sql, 'template-tags': {} }
    },
    visualization_settings: settings
  };
}

async function findByExactName(model, name) {
  const s = await api('/api/search?' + new URLSearchParams({ q: name }).toString());
  const rows = s.data || [];
  return rows.find(x => x.model === model && x.name === name && !x.archived) || null;
}

async function ensureCollection(name, description) {
  const existing = await findByExactName('collection', name);
  if (existing) return existing;
  return api('/api/collection', { method: 'POST', body: JSON.stringify({ name, description, color: '#509EE3' }) });
}

async function archiveExisting(model, name) {
  const existing = await findByExactName(model, name);
  if (!existing) return null;
  const endpoint = model === 'card' ? `/api/card/${existing.id}` : `/api/dashboard/${existing.id}`;
  try { await api(endpoint, { method: 'PUT', body: JSON.stringify({ archived: true }) }); } catch {}
  return existing.id;
}

async function resolveWarehouseDatabaseId() {
  if (WAREHOUSE_DATABASE_ID > 0) return WAREHOUSE_DATABASE_ID;
  const dbs = await api('/api/database');
  const dbList = dbs.data || dbs;
  const warehouse = Array.isArray(dbList) ? dbList.find(d => d.name === 'SHEIN BI Warehouse') : null;
  if (!warehouse?.id) throw new Error('Cannot find Metabase database named SHEIN BI Warehouse. Run setup_metabase_instance.mjs first.');
  WAREHOUSE_DATABASE_ID = warehouse.id;
  return WAREHOUSE_DATABASE_ID;
}

async function createCard(def, collectionId) {
  await archiveExisting('card', def.name);
  return api('/api/card', { method: 'POST', body: JSON.stringify(cardPayload(def, collectionId)) });
}

async function setDashboardCards(dashboardId, cardLayouts) {
  const dashcards = cardLayouts.map((item, index) => ({
    id: -(index + 1),
    card_id: item.cardId,
    row: item.layout.row,
    col: item.layout.col,
    size_x: item.layout.size_x,
    size_y: item.layout.size_y,
    parameter_mappings: [],
    inline_parameters: [],
    series: [],
    visualization_settings: {}
  }));
  return api(`/api/dashboard/${dashboardId}`, {
    method: 'PUT',
    body: JSON.stringify({ dashcards, tabs: [], width: 'full' })
  });
}

const cards = [
  {
    name: 'SHEIN BI · 今日销售额',
    description: '最新销售日的 15 店总销售额，来自数据仓库 fact.store_daily_sales。',
    display: 'scalar',
    sql: `select round(sum(sales_sar)::numeric, 2) as "销售额 SAR"
from fact.store_daily_sales
where date = (select max(date) from fact.store_daily_sales);`
  },
  {
    name: 'SHEIN BI · 今日订单数',
    description: '最新销售日的有效订单数。',
    display: 'scalar',
    sql: `select sum(valid_order_count)::int as "订单数"
from fact.store_daily_sales
where date = (select max(date) from fact.store_daily_sales);`
  },
  {
    name: 'SHEIN BI · 今日重点动作数',
    description: '最新链接日的重点实操动作数。',
    display: 'scalar',
    sql: `select count(*)::int as "重点动作数"
from mart.link_action_candidate
where date = (select max(date) from mart.link_action_candidate)
  and focus = true;`
  },
  {
    name: 'SHEIN BI · 潜在下架候选数',
    description: '已上架、上架满 30 天、近 30 天 0 销量的链接数量。不是自动下架，只是候选池。',
    display: 'scalar',
    sql: `select count(*)::int as "下架候选数"
from fact.link_master_snapshot l
left join fact.link_performance_daily p
  on p.date = l.snapshot_date and p.store_key = l.store_key and p.skc = l.skc
where l.snapshot_date = (select max(snapshot_date) from fact.link_master_snapshot)
  and l.is_on_shelf = true
  and coalesce(l.is_hard_dead,false) = false
  and l.first_shelf_time is not null
  and l.first_shelf_time::date <= l.snapshot_date - interval '30 days'
  and coalesce(p.c30_sale_cnt,0) = 0;`
  },
  {
    name: 'SHEIN BI · 店铺经营矩阵',
    description: '从店铺维度同时看销售、链接状态和待处理动作。',
    display: 'table',
    sql: `select
  s.store_key as "店铺",
  s.group_key as "分组",
  round(coalesce(sd.sales_sar,0)::numeric,2) as "今日销售SAR",
  coalesce(sd.valid_order_count,0)::int as "订单数",
  coalesce(c.on_shelf,0)::int as "上架链接",
  coalesce(c.wait_shelf,0)::int as "待上架",
  coalesce(c.sold_out,0)::int as "已售罄",
  coalesce(a.all_actions,0)::int as "待处理",
  coalesce(a.focus_actions,0)::int as "今日重点"
from dim.store s
left join fact.store_daily_sales sd
  on sd.store_key = s.store_key
 and sd.date = (select max(date) from fact.store_daily_sales)
left join (
  select store_key,
    count(*) filter (where is_on_shelf) as on_shelf,
    count(*) filter (where is_wait_shelf) as wait_shelf,
    count(*) filter (where is_sold_out) as sold_out
  from fact.link_master_snapshot
  where snapshot_date = (select max(snapshot_date) from fact.link_master_snapshot)
  group by store_key
) c on c.store_key = s.store_key
left join (
  select store_key, count(*) as all_actions, count(*) filter (where focus) as focus_actions
  from mart.link_action_candidate
  where date = (select max(date) from mart.link_action_candidate)
  group by store_key
) a on a.store_key = s.store_key
where s.enabled = true
order by "今日销售SAR" desc, s.store_key;`
  },
  {
    name: 'SHEIN BI · 货号销售与链接覆盖',
    description: '从标准货号维度看销售、已覆盖店铺、缺链接店铺和关联 SKC。',
    display: 'table',
    sql: `with latest_sales as (select max(created_date) d from fact.order_item),
latest_link as (select max(date) d from fact.product_store_coverage),
sales as (
  select standard_goods_sn,
    round(sum(sales_sar)::numeric,2) as sales_sar,
    sum(quantity)::int as qty,
    count(distinct order_key)::int as orders
  from fact.order_item
  where created_date = (select d from latest_sales)
  group by standard_goods_sn
),
coverage as (
  select standard_goods_sn,
    count(*) filter (where has_on_shelf_link)::int as on_shelf_stores,
    count(*) filter (where need_supplement_link)::int as missing_stores,
    string_agg(store_key, ',' order by store_key) filter (where need_supplement_link) as missing_store_list
  from fact.product_store_coverage
  where date = (select d from latest_link)
  group by standard_goods_sn
)
select
  coalesce(s.standard_goods_sn,c.standard_goods_sn) as "标准货号",
  coalesce(s.sales_sar,0) as "今日销售SAR",
  coalesce(s.qty,0) as "销量",
  coalesce(s.orders,0) as "订单数",
  coalesce(c.on_shelf_stores,0) as "已上架店数",
  coalesce(c.missing_stores,0) as "缺链接店数",
  c.missing_store_list as "缺链接店铺"
from sales s
full join coverage c on c.standard_goods_sn = s.standard_goods_sn
where coalesce(s.standard_goods_sn,c.standard_goods_sn) is not null
order by "今日销售SAR" desc, "缺链接店数" desc
limit 200;`
  },
  {
    name: 'SHEIN BI · 今日链接实操池',
    description: '目前网页实操台同源的待处理动作池，可按店铺、货号、SKC 二次筛选。',
    display: 'table',
    sql: `select
  case when focus then '是' else '否' end as "今日重点",
  store_key as "店铺",
  type as "动作类型",
  category as "分类",
  priority as "优先级",
  round(coalesce(score,0)::numeric,1) as "评分",
  standard_goods_sn as "标准货号",
  skc as "SKC",
  title as "标题",
  reason as "原因",
  evidence as "证据",
  next_step as "下一步"
from mart.link_action_candidate
where date = (select max(date) from mart.link_action_candidate)
order by focus desc, score desc, store_key, standard_goods_sn
limit 300;`
  },
  {
    name: 'SHEIN BI · 潜在下架候选明细',
    description: '已上架满 30 天且近 30 天 0 销量的链接。需要结合是否唯一链接、是否有替代链接再决策。',
    display: 'table',
    sql: `select
  l.store_key as "店铺",
  l.standard_goods_sn as "标准货号",
  l.skc as "SKC",
  l.shelf_status_name as "状态",
  l.first_shelf_time::date as "首次上架",
  coalesce(p.c30_sale_cnt,0)::int as "30天销量",
  coalesce(p.eps_uv,0)::int as "曝光人数",
  coalesce(p.goods_uv,0)::int as "商详访客",
  round(coalesce(p.click_rate,0)::numeric,4) as "点击率",
  round(coalesce(p.pay_rate,0)::numeric,4) as "支付率",
  l.sale_name as "销售名"
from fact.link_master_snapshot l
left join fact.link_performance_daily p
  on p.date = l.snapshot_date and p.store_key = l.store_key and p.skc = l.skc
where l.snapshot_date = (select max(snapshot_date) from fact.link_master_snapshot)
  and l.is_on_shelf = true
  and coalesce(l.is_hard_dead,false) = false
  and l.first_shelf_time is not null
  and l.first_shelf_time::date <= l.snapshot_date - interval '30 days'
  and coalesce(p.c30_sale_cnt,0) = 0
order by coalesce(p.eps_uv,0) desc, coalesce(p.goods_uv,0) desc, l.store_key
limit 300;`
  },
  {
    name: 'SHEIN BI · 链接状态分布',
    description: '按店铺看待上架、已上架、售罄、下架等链接状态。',
    display: 'bar',
    sql: `select
  store_key as "店铺",
  shelf_status_name as "状态",
  count(*)::int as "链接数"
from fact.link_master_snapshot
where snapshot_date = (select max(snapshot_date) from fact.link_master_snapshot)
  and coalesce(is_hard_dead,false) = false
group by store_key, shelf_status_name
order by store_key, shelf_status_name;`
  },
  {
    name: 'SHEIN BI · 商品分析漏斗 Top',
    description: '按 SKC 看曝光、商详、点击率、支付率、销量，适合找高曝光低转化。',
    display: 'table',
    sql: `select
  store_key as "店铺",
  standard_goods_sn as "标准货号",
  skc as "SKC",
  goods_name as "商品名",
  coalesce(eps_uv,0)::int as "曝光人数",
  coalesce(goods_uv,0)::int as "商详访客",
  round(coalesce(click_rate,0)::numeric,4) as "点击率",
  round(coalesce(pay_rate,0)::numeric,4) as "支付率",
  coalesce(sale_cnt,0)::int as "当日销量",
  coalesce(c30_sale_cnt,0)::int as "30天销量"
from fact.link_performance_daily
where date = (select max(date) from fact.link_performance_daily)
order by coalesce(eps_uv,0) desc, coalesce(goods_uv,0) desc
limit 300;`
  }
];

(async function main(){
  await resolveWarehouseDatabaseId();
  const collection = await ensureCollection('SHEIN BI 原型', 'SHEIN 销售、链接、货号、SKC 和实操建议的一体化 BI 原型集合。');
  const collectionId = collection.id;
  const createdCards = [];
  for (const def of cards) {
    // quick validate SQL before saving
    await dataset(def.sql);
    const card = await createCard(def, collectionId);
    createdCards.push(card);
  }
  await archiveExisting('dashboard', 'SHEIN 经营驾驶舱 · 原型');
  const dashboard = await api('/api/dashboard', {
    method: 'POST',
    body: JSON.stringify({ name: 'SHEIN 经营驾驶舱 · 原型', description: '第一版 Metabase BI 原型：店铺、货号、SKC/链接、实操动作多维入口。', collection_id: collectionId })
  });
  const layouts = [
    { row:0, col:0, size_x:6, size_y:3 },
    { row:0, col:6, size_x:6, size_y:3 },
    { row:0, col:12, size_x:6, size_y:3 },
    { row:0, col:18, size_x:6, size_y:3 },
    { row:3, col:0, size_x:24, size_y:7 },
    { row:10, col:0, size_x:24, size_y:7 },
    { row:17, col:0, size_x:24, size_y:8 },
    { row:25, col:0, size_x:24, size_y:8 },
    { row:33, col:0, size_x:12, size_y:7 },
    { row:33, col:12, size_x:12, size_y:7 }
  ];
  const dashboardWithCards = await setDashboardCards(
    dashboard.id,
    createdCards.map((card, index) => ({ cardId: card.id, layout: layouts[index] || { row: index * 4, col: 0, size_x: 12, size_y: 4 } }))
  );
  console.log(JSON.stringify({
    ok: true,
    collection: { id: collectionId, name: collection.name },
    dashboard: { id: dashboard.id, name: dashboard.name, cardCount: dashboardWithCards.dashcards?.length || 0 },
    cards: createdCards.map(c => ({ id: c.id, name: c.name }))
  }, null, 2));
})().catch(err => { console.error(err.stack || err.message); process.exit(1); });



