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

async function resolveWarehouseDatabaseId() {
  if (WAREHOUSE_DATABASE_ID > 0) return WAREHOUSE_DATABASE_ID;
  const dbs = await api('/api/database');
  const dbList = dbs.data || dbs;
  const warehouse = Array.isArray(dbList) ? dbList.find(d => d.name === 'SHEIN BI Warehouse') : null;
  if (!warehouse?.id) throw new Error('Cannot find Metabase database named SHEIN BI Warehouse. Run setup_metabase_instance.mjs first.');
  WAREHOUSE_DATABASE_ID = warehouse.id;
  return WAREHOUSE_DATABASE_ID;
}

async function dataset(sql) {
  return api('/api/dataset', {
    method: 'POST',
    body: JSON.stringify({ database: WAREHOUSE_DATABASE_ID, type: 'native', native: { query: sql, 'template-tags': {} } })
  });
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
      native: { query: def.sql, 'template-tags': {} }
    },
    visualization_settings: def.settings || {}
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

async function createCard(def, collectionId) {
  await dataset(def.sql);
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
    visualization_settings: item.layout.visualization_settings || {}
  }));
  return api(`/api/dashboard/${dashboardId}`, {
    method: 'PUT',
    body: JSON.stringify({ dashcards, tabs: [], width: 'full' })
  });
}

const dashboards = [
  {
    name: 'SHEIN BI · 店铺视角',
    description: '按店铺进入，综合看销售、链接覆盖、重点动作和链接状态。',
    cards: [
      {
        name: 'SHEIN BI · 店铺视角 · 店铺总览表',
        display: 'table',
        description: '每个店铺一行，是店铺视角的主入口。',
        sql: `select
  store_key as "店铺",
  group_key as "分组",
  sales_date as "销售日期",
  link_date as "链接日期",
  round(sales_sar::numeric,2) as "销售额SAR",
  valid_order_count as "订单数",
  goods_line_count as "商品行数",
  on_shelf_links as "上架链接",
  wait_shelf_links as "待上架链接",
  sold_out_links as "售罄链接",
  wait_shelf_blocked_links as "待上架卡点",
  missing_product_count as "缺链接货号",
  duplicate_product_count as "重复上架货号",
  action_count as "待处理动作",
  focus_action_count as "今日重点",
  supplement_action_count as "补链接动作",
  optimize_action_count as "优化动作",
  retire_action_count as "下架/淘汰动作"
from mart.bi_store_overview_current
order by sales_sar desc, store_key;`
      },
      {
        name: 'SHEIN BI · 店铺视角 · 销售排行',
        display: 'bar',
        sql: `select store_key as "店铺", round(sales_sar::numeric,2) as "销售额SAR"
from mart.bi_store_overview_current
order by sales_sar desc;`
      },
      {
        name: 'SHEIN BI · 店铺视角 · 今日重点动作排行',
        display: 'bar',
        sql: `select store_key as "店铺", focus_action_count as "今日重点动作"
from mart.bi_store_overview_current
order by focus_action_count desc, action_count desc, store_key;`
      },
      {
        name: 'SHEIN BI · 店铺视角 · 待上架卡点',
        display: 'table',
        sql: `select
  store_key as "店铺",
  standard_goods_sn as "标准货号",
  skc as "SKC",
  shelf_status_name as "状态",
  wait_shelf_block_reason as "卡点原因",
  sale_name as "销售名"
from mart.bi_link_health_current
where wait_shelf_block_candidate
order by store_key, standard_goods_sn, skc
limit 300;`
      },
      {
        name: 'SHEIN BI · 店铺视角 · 店铺货号矩阵',
        display: 'table',
        sql: `select
  store_key as "店铺",
  standard_goods_sn as "标准货号",
  round(sales_sar::numeric,2) as "今日销售SAR",
  quantity as "销量",
  order_count as "订单数",
  coverage_status as "覆盖状态",
  has_on_shelf_link as "有上架链接",
  need_supplement_link as "需补链接",
  link_count as "链接数",
  on_shelf_count as "上架数",
  wait_shelf_count as "待上架数",
  sold_out_count as "售罄数",
  best_skc as "最佳SKC",
  skc_list as "SKC列表",
  action_count as "动作数",
  focus_action_count as "重点数"
from mart.bi_store_product_matrix_current
where sales_sar > 0 or need_supplement_link or action_count > 0
order by store_key, sales_sar desc, focus_action_count desc, action_count desc
limit 500;`
      }
    ],
    layouts: [
      {row:0,col:0,size_x:24,size_y:8},
      {row:8,col:0,size_x:12,size_y:7},
      {row:8,col:12,size_x:12,size_y:7},
      {row:15,col:0,size_x:24,size_y:7},
      {row:22,col:0,size_x:24,size_y:10}
    ]
  },
  {
    name: 'SHEIN BI · 货号视角',
    description: '按标准货号进入，综合看全店销售、覆盖、缺链接、动作和样本 SKC。',
    cards: [
      {
        name: 'SHEIN BI · 货号视角 · 货号总览表',
        display: 'table',
        sql: `select
  standard_goods_sn as "标准货号",
  round(sales_sar::numeric,2) as "今日销售SAR",
  quantity as "销量",
  order_count as "订单数",
  on_shelf_store_count as "已上架店数",
  missing_store_count as "缺链接店数",
  missing_stores as "缺链接店铺",
  on_shelf_stores as "已上架店铺",
  sample_skc as "样本SKC",
  on_shelf_link_count as "上架链接数",
  wait_shelf_link_count as "待上架链接数",
  sold_out_link_count as "售罄链接数",
  action_count as "动作数",
  focus_action_count as "重点数",
  round(coalesce(max_action_score,0)::numeric,1) as "最高动作分"
from mart.bi_product_overview_current
where sales_sar > 0 or missing_store_count > 0 or action_count > 0
order by sales_sar desc, focus_action_count desc, missing_store_count desc
limit 300;`
      },
      {
        name: 'SHEIN BI · 货号视角 · 销售Top货号',
        display: 'bar',
        sql: `select standard_goods_sn as "标准货号", round(sales_sar::numeric,2) as "销售额SAR"
from mart.bi_product_overview_current
where sales_sar > 0
order by sales_sar desc
limit 30;`
      },
      {
        name: 'SHEIN BI · 货号视角 · 缺链接但有销售',
        display: 'table',
        sql: `select
  standard_goods_sn as "标准货号",
  round(sales_sar::numeric,2) as "今日销售SAR",
  quantity as "销量",
  on_shelf_store_count as "已上架店数",
  missing_store_count as "缺链接店数",
  missing_stores as "缺链接店铺",
  sample_skc as "样本SKC"
from mart.bi_product_overview_current
where sales_sar > 0 and missing_store_count > 0
order by sales_sar desc, missing_store_count desc
limit 200;`
      },
      {
        name: 'SHEIN BI · 货号视角 · 全店暂不上候选',
        display: 'table',
        description: '没有任何店铺已上架的货号，仅作为观察，不进补链提醒。',
        sql: `select
  standard_goods_sn as "标准货号",
  on_shelf_store_count as "已上架店数",
  missing_store_count as "缺链接店数",
  wait_shelf_link_count as "待上架链接数",
  sold_out_link_count as "售罄链接数",
  action_count as "动作数",
  sample_skc as "样本SKC"
from mart.bi_product_overview_current
where on_shelf_store_count = 0
order by sold_out_link_count desc, wait_shelf_link_count desc, standard_goods_sn
limit 200;`
      },
      {
        name: 'SHEIN BI · 货号视角 · 货号-店铺明细',
        display: 'table',
        sql: `select
  standard_goods_sn as "标准货号",
  store_key as "店铺",
  coverage_status as "覆盖状态",
  round(sales_sar::numeric,2) as "今日销售SAR",
  quantity as "销量",
  has_on_shelf_link as "有上架链接",
  need_supplement_link as "需补链接",
  link_count as "链接数",
  on_shelf_count as "上架数",
  wait_shelf_count as "待上架数",
  sold_out_count as "售罄数",
  best_skc as "最佳SKC",
  skc_list as "SKC列表",
  action_count as "动作数",
  focus_action_count as "重点数"
from mart.bi_store_product_matrix_current
where sales_sar > 0 or need_supplement_link or action_count > 0
order by standard_goods_sn, sales_sar desc, store_key
limit 700;`
      }
    ],
    layouts: [
      {row:0,col:0,size_x:24,size_y:10},
      {row:10,col:0,size_x:12,size_y:7},
      {row:10,col:12,size_x:12,size_y:7},
      {row:17,col:0,size_x:24,size_y:7},
      {row:24,col:0,size_x:24,size_y:10}
    ]
  },
  {
    name: 'SHEIN BI · 链接/SKC视角',
    description: '按 SKC/链接进入，聚焦优化、下架、待上架卡点和商品分析漏斗。',
    cards: [
      {
        name: 'SHEIN BI · 链接视角 · 链接健康总表',
        display: 'table',
        sql: `select
  health_bucket as "健康分类",
  store_key as "店铺",
  standard_goods_sn as "标准货号",
  skc as "SKC",
  shelf_status_name as "状态",
  shelf_age_days as "上架天数",
  c30_sale_cnt as "30天销量",
  eps_uv as "曝光人数",
  goods_uv as "商详访客",
  round(click_rate::numeric,4) as "点击率",
  round(pay_rate::numeric,4) as "支付率",
  same_product_on_shelf_count as "同货号上架数",
  sale_name as "销售名"
from mart.bi_link_health_current
where is_on_shelf or wait_shelf_block_candidate or retire_candidate or high_exposure_low_click or high_visit_low_pay
order by
  case health_bucket when '下架候选' then 1 when '待上架卡点' then 2 when '优化：高曝光低点击' then 3 when '优化：高访客低支付' then 4 else 9 end,
  eps_uv desc, goods_uv desc
limit 700;`
      },
      {
        name: 'SHEIN BI · 链接视角 · 健康分类分布',
        display: 'bar',
        sql: `select health_bucket as "健康分类", count(*)::int as "链接数"
from mart.bi_link_health_current
group by health_bucket
order by "链接数" desc;`
      },
      {
        name: 'SHEIN BI · 链接视角 · 高曝光低点击',
        display: 'table',
        sql: `select
  store_key as "店铺",
  standard_goods_sn as "标准货号",
  skc as "SKC",
  eps_uv as "曝光人数",
  goods_uv as "商详访客",
  round(click_rate::numeric,4) as "点击率",
  c30_sale_cnt as "30天销量",
  sale_name as "销售名"
from mart.bi_link_health_current
where high_exposure_low_click
order by eps_uv desc
limit 300;`
      },
      {
        name: 'SHEIN BI · 链接视角 · 高访客低支付',
        display: 'table',
        sql: `select
  store_key as "店铺",
  standard_goods_sn as "标准货号",
  skc as "SKC",
  goods_uv as "商详访客",
  round(pay_rate::numeric,4) as "支付率",
  c30_sale_cnt as "30天销量",
  quality_grade as "质量等级",
  comment_count as "评论数",
  round(bad_comment_rate::numeric,4) as "差评率",
  sale_name as "销售名"
from mart.bi_link_health_current
where high_visit_low_pay
order by goods_uv desc
limit 300;`
      },
      {
        name: 'SHEIN BI · 链接视角 · 下架候选',
        display: 'table',
        sql: `select
  store_key as "店铺",
  standard_goods_sn as "标准货号",
  skc as "SKC",
  shelf_age_days as "上架天数",
  c30_sale_cnt as "30天销量",
  eps_uv as "曝光人数",
  goods_uv as "商详访客",
  same_product_on_shelf_count as "同货号上架数",
  sale_name as "销售名"
from mart.bi_link_health_current
where retire_candidate
order by eps_uv desc, goods_uv desc, shelf_age_days desc
limit 300;`
      },
      {
        name: 'SHEIN BI · 链接视角 · 今日实操队列',
        display: 'table',
        sql: `select
  case when focus then '是' else '否' end as "今日重点",
  store_key as "店铺",
  type as "动作类型",
  category as "分类",
  priority as "优先级",
  round(score::numeric,1) as "评分",
  standard_goods_sn as "标准货号",
  skc as "SKC",
  reason as "原因",
  evidence as "证据",
  next_step as "下一步"
from mart.bi_action_queue_current
order by focus desc, score desc, store_key, standard_goods_sn
limit 500;`
      }
    ],
    layouts: [
      {row:0,col:0,size_x:24,size_y:10},
      {row:10,col:0,size_x:12,size_y:7},
      {row:10,col:12,size_x:12,size_y:7},
      {row:17,col:0,size_x:12,size_y:7},
      {row:17,col:12,size_x:12,size_y:7},
      {row:24,col:0,size_x:24,size_y:10}
    ]
  }
];

async function createDashboard(def, collectionId) {
  const cards = [];
  for (const c of def.cards) cards.push(await createCard(c, collectionId));
  await archiveExisting('dashboard', def.name);
  const dashboard = await api('/api/dashboard', {
    method: 'POST',
    body: JSON.stringify({name: def.name, description: def.description, collection_id: collectionId})
  });
  const dashboardWithCards = await setDashboardCards(
    dashboard.id,
    cards.map((card, index) => ({cardId: card.id, layout: def.layouts[index] || {row:index*6,col:0,size_x:24,size_y:6}}))
  );
  return {id: dashboard.id, name: dashboard.name, cardCount: dashboardWithCards.dashcards?.length || 0, cards: cards.map(c => ({id:c.id, name:c.name}))};
}

(async function main() {
  await resolveWarehouseDatabaseId();
  const collection = await ensureCollection('SHEIN BI 原型', 'SHEIN 销售、链接、货号、SKC 和实操建议的一体化 BI 原型集合。');
  const out = [];
  for (const d of dashboards) out.push(await createDashboard(d, collection.id));
  console.log(JSON.stringify({ok:true, collection:{id:collection.id, name:collection.name}, dashboards: out}, null, 2));
})().catch(err => { console.error(err.stack || err.message); process.exit(1); });

