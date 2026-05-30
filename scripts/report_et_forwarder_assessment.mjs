#!/usr/bin/env node
/**
 * Build a human review report for ET forwarder data coverage, SKU matching,
 * and whether ET data can replace parts of the manually uploaded cost sheet.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    distro: 'Ubuntu-24.04',
    container: 'shein-warehouse-db',
    database: 'shein_bi',
    user: 'shein',
    outDir: path.join(ROOT, 'outputs', 'et-forwarder', 'reports'),
    date: new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--distro') args.distro = argv[++i];
    else if (a === '--container') args.container = argv[++i];
    else if (a === '--database') args.database = argv[++i];
    else if (a === '--user') args.user = argv[++i];
    else if (a === '--out-dir') args.outDir = path.resolve(argv[++i]);
    else if (a === '--date') args.date = argv[++i];
  }
  return args;
}

function runSql(args, sql) {
  const wrapped = `select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb)::text from (${sql}) q;`;
  const child = spawnSync('wsl.exe', [
    '-d', args.distro,
    '--',
    'bash',
    '-lc',
    `sudo docker exec -i ${args.container} psql -U ${args.user} -d ${args.database} -v ON_ERROR_STOP=1 -t -A`,
  ], {
    input: wrapped,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
  });
  if (child.status !== 0) {
    throw new Error((child.stderr || child.stdout || '').trim() || `psql failed with ${child.status}`);
  }
  const text = (child.stdout || '').trim();
  return text ? JSON.parse(text) : [];
}

function cell(v) {
  if (v == null || v === '') return '-';
  return String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function table(rows, cols) {
  if (!rows.length) return '_暂无需要展示的数据。_\n';
  const head = `| ${cols.map(c => c[0]).join(' | ')} |`;
  const sep = `| ${cols.map(() => '---').join(' | ')} |`;
  const body = rows.map(r => `| ${cols.map(c => cell(typeof c[1] === 'function' ? c[1](r) : r[c[1]])).join(' | ')} |`);
  return [head, sep, ...body].join('\n') + '\n';
}

function skuSuggestion(row) {
  const code = String(row.et_standard_goods_sn || '');
  const title = String(row.sample_title || '');
  const rules = [
    [/SK-1713-4-GREY/i, '建议并入 SK-1713-4手持搅拌器；需确认灰色是否只是颜色款。'],
    [/PL4-6L/i, '建议并入 PA4-6L便携式冰箱；需确认 ET 是否把 A 写成 L。'],
    [/SK-7025-BLACK/i, '建议并入 SK-7025A绞肉机或 7025；需确认黑色款是否单独核算。'],
    [/CM6810/i, '建议并入 SK-6810半自动意式咖啡机。'],
    [/C06/, '建议并入 SK-04031胶囊咖啡机。'],
    [/SK-794/i, '建议并入 SK-JFB-794卷发钳和卷发棒。'],
    [/FZ-666Beige/i, '建议并入 FZ-666颈部按摩器；需确认米色是否只是颜色款。'],
    [/PDLFZ666/i, '看起来是 FZ-666 包装箱/箱子，不应作为可售货号；建议作为包材或忽略。'],
    [/报废/, '报废占位，不应作为可售货号；建议忽略或并入报废类。'],
  ];
  for (const [re, s] of rules) {
    if (re.test(code) || re.test(row.et_match_key || '') || re.test(title)) return s;
  }
  if (/电热水壶/.test(title)) return '疑似电热水壶类；可能并入 S1810电热水壶，但 GL-BL02 编号无法自动确认。';
  if (/榨汁机/.test(title) && /175/.test(code)) return '疑似 175 榨汁机；可能并入 SK-JB-175 或 LQ榨汁机175，需你确认。';
  if (/电动缝纫机/.test(title)) return '疑似缝纫机类；可能与 SM-505A/TXSM-505A 相关，但 SM-520A 无法自动确认。';
  if (/手持搅拌器/.test(title)) return '疑似手持搅拌器；CX1788 与现有 SK-1713-4/1710 关系不确定，需确认。';
  return '无法自动确认，请人工指定标准货号或确认忽略。';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await fs.mkdir(args.outDir, {recursive: true});
  const counts = await runSql(args, `
    select *
    from (
      values
        ('SKU 主档', (select count(*) from fact.et_sku_master)),
        ('SKU 规格', (select count(*) from fact.et_sku_specification)),
        ('09 散件库存快照', (select count(*) from fact.et_store_stock_snapshot)),
        ('01/03/04/06 箱/库位库存快照', (select count(*) from fact.et_box_stock_snapshot)),
        ('发货申请单', (select count(*) from fact.et_ship_order)),
        ('发货申请单商品明细', (select count(*) from fact.et_ship_order_item)),
        ('箱明细', (select count(*) from fact.et_box_item)),
        ('出库单', (select count(*) from fact.et_outbound)),
        ('出库商品明细', (select count(*) from fact.et_outbound_item)),
        ('RTV/退回单', (select count(*) from fact.et_return_order)),
        ('RTV/退回商品明细', (select count(*) from fact.et_return_order_item)),
        ('库存流水', (select count(*) from fact.et_stock_running)),
        ('损溢/破损', (select count(*) from fact.et_box_damaged)),
        ('财务账单', (select count(*) from fact.et_income_bill)),
        ('财务账单商品明细', (select count(*) from fact.et_income_bill_item)),
        ('财务支付记录', (select count(*) from fact.et_income_payment))
    ) as t(name, rows)
    order by name
  `);

  const batchSummary = await runSql(args, `
    with cost_batch as (
      select batch_no, sum(coalesce(shipped_quantity,0)) as cost_qty
      from fact.product_cost_batch
      where batch_no is not null and batch_no <> ''
      group by batch_no
    ), et_batch as (
      select ship_order_id as batch_no, max(send_quantity) as et_send_qty
      from fact.et_ship_order
      group by 1
    ), j as (
      select c.batch_no, c.cost_qty, e.et_send_qty,
        case when e.batch_no is null then 'missing_et_batch'
             when abs(coalesce(e.et_send_qty,0)-c.cost_qty) > 2 then 'batch_total_diff'
             else 'ok' end as status
      from cost_batch c left join et_batch e using(batch_no)
    )
    select status, count(*) as batches, sum(cost_qty) as cost_qty, sum(coalesce(et_send_qty,0)) as et_qty
    from j
    group by status
    order by case status when 'ok' then 1 when 'batch_total_diff' then 2 else 3 end
  `);

  const discrepancies = await runSql(args, `
    with cost_batch as (
      select batch_no, sum(coalesce(shipped_quantity,0)) as cost_qty, count(*) as cost_rows,
             max(arrived_date) as cost_arrived_date, max(shipped_date) as cost_shipped_date
      from fact.product_cost_batch
      where batch_no is not null and batch_no <> ''
      group by batch_no
    ), et_batch as (
      select ship_order_id as batch_no, max(send_quantity) as et_send_qty, max(send_box_count) as send_box_count,
             max(store_box_count) as store_box_count, max(overseas_quantity) as overseas_quantity,
             max(platform_quantity) as platform_quantity, max(create_time)::date as et_create_date,
             max(ship_time)::date as et_ship_date, max(into_time)::date as et_into_date
      from fact.et_ship_order
      group by 1
    )
    select c.batch_no, c.cost_qty, e.et_send_qty, coalesce(e.et_send_qty,0)-c.cost_qty as qty_diff,
           c.cost_rows, c.cost_shipped_date, c.cost_arrived_date,
           e.et_create_date, e.et_ship_date, e.et_into_date, e.send_box_count, e.store_box_count,
           e.overseas_quantity, e.platform_quantity,
           case when e.batch_no is null then 'ET 无此发货申请单'
                when abs(coalesce(e.et_send_qty,0)-c.cost_qty) > 2 then '数量差异'
                else 'OK' end as status
    from cost_batch c left join et_batch e using(batch_no)
    where e.batch_no is null or abs(coalesce(e.et_send_qty,0)-c.cost_qty) > 2
    order by case when e.batch_no is null then 2 else 1 end, c.batch_no
  `);

  const skuUnknownsRaw = await runSql(args, `
    with dim_keys as (
      select standard_goods_sn, dim.product_match_key(standard_goods_sn) as match_key from dim.product
      union all
      select standard_goods_sn, dim.product_match_key(sample_raw_goods_sn) as match_key from dim.product
      where sample_raw_goods_sn is not null and sample_raw_goods_sn <> ''
    ), et_products as (
      select standard_goods_sn, match_key, max(coalesce(title_cn, title_en,'')) as sample_title, count(*) as sources
      from (
        select standard_goods_sn, match_key, title_cn, title_en from fact.et_sku_master
        union all select standard_goods_sn, match_key, null::text as title_cn, null::text as title_en from fact.et_sku_specification
        union all select standard_goods_sn, match_key, title_cn, title_en from fact.et_store_stock_snapshot
        union all select standard_goods_sn, match_key, title_cn, title_en from fact.et_box_stock_snapshot
        union all select standard_goods_sn, match_key, title_cn, title_en from fact.et_stock_running
        union all select standard_goods_sn, match_key, goods_title as title_cn, null::text as title_en from fact.et_ship_order_box
        union all select standard_goods_sn, match_key, goods_title as title_cn, null::text as title_en from fact.et_ship_order_item
        union all select standard_goods_sn, match_key, goods_title as title_cn, null::text as title_en from fact.et_box_item
        union all select standard_goods_sn, match_key, title_cn, title_en from fact.et_outbound_item
        union all select standard_goods_sn, match_key, goods_title as title_cn, null::text as title_en from fact.et_return_order_item
        union all select standard_goods_sn, match_key, goods_title as title_cn, null::text as title_en from fact.et_allocate_item
        union all select standard_goods_sn, match_key, title as title_cn, null::text as title_en from fact.et_box_damaged
        union all select standard_goods_sn, match_key, goods_title as title_cn, null::text as title_en from fact.et_income_bill_item
      ) s
      group by standard_goods_sn, match_key
    ), matched as (
      select e.*, count(d.standard_goods_sn) as dim_matches
      from et_products e left join dim_keys d on d.match_key=e.match_key
      group by e.standard_goods_sn, e.match_key, e.sample_title, e.sources
    )
    select coalesce(nullif(standard_goods_sn,''),'(empty)') as et_standard_goods_sn,
           coalesce(nullif(match_key,''),'(empty)') as et_match_key,
           left(sample_title,80) as sample_title,
           sources
    from matched
    where dim_matches = 0
    order by sources desc, et_standard_goods_sn
  `);
  const skuUnknowns = skuUnknownsRaw.map(r => ({...r, suggestion: skuSuggestion(r)}));

  const now = new Date().toISOString();
  const md = [
    `# ET 货代仓全量补数与替代评估`,
    ``,
    `- 生成时间：${now}`,
    `- 口径：ET 发货申请单/库存/出库/RTV/财务已进入本地仓库；手工成本表仍作为采购成本和已确认头程成本主口径。`,
    ``,
    `## 1. 当前已入仓数据量`,
    table(counts, [['数据域', 'name'], ['行数', 'rows']]),
    `## 2. 发货申请单 vs 手工成本表批次核对`,
    table(batchSummary, [['状态', 'status'], ['批次数', 'batches'], ['成本表数量', 'cost_qty'], ['ET 数量', 'et_qty']]),
    `### 需要人工核实的批次`,
    table(discrepancies, [
      ['批次/发货单', 'batch_no'],
      ['问题', 'status'],
      ['成本表数量', 'cost_qty'],
      ['ET 数量', 'et_send_qty'],
      ['差异', 'qty_diff'],
      ['成本表发货', 'cost_shipped_date'],
      ['成本表到仓', 'cost_arrived_date'],
      ['ET 建单', 'et_create_date'],
      ['ET 发货', 'et_ship_date'],
      ['ET 到仓', 'et_into_date'],
    ]),
    `## 3. 需要你确认的 ET 货号归并`,
    `以下是 ET 中无法通过现有标准货号/历史原始货号自动确认的编码。我的建议先不自动落库，等你确认后再写入别名表。`,
    table(skuUnknowns, [
      ['ET 编码', 'et_standard_goods_sn'],
      ['匹配键', 'et_match_key'],
      ['ET 名称', 'sample_title'],
      ['出现次数', 'sources'],
      ['建议', 'suggestion'],
    ]),
    `## 4. 替代手工成本表的判断`,
    `### 可以优先用 ET 替代或增强`,
    `- 到仓/在途状态：ET 发货申请单、箱明细、库存快照比手工表更适合做动态状态。`,
    `- 海外仓实盘库存：09 散件仓 + 01 整箱仓已接入 BI，可替代“成本表推算库存”的主展示口径。`,
    `- 出库与 RTV：ET 出库单、RTV 单可新增到 BI，用来核对 SHEIN 物流单号、退回仓、破损仓和去化误差。`,
    `- 损溢/破损：ET 损溢和 04/06 仓状态可新增为库存风险和真实损耗模块。`,
    `- 财务账单：ET 财务账单可作为物流/仓储/上下架费用复核来源。`,
    ``,
    `### 暂不直接替代`,
    `- 采购成本：ET 看不到国内采购价，仍必须以手工成本表为准。`,
    `- 头程/上架/下架费用：目前先用于复核，不直接覆盖；等差异批次和财务分类核准后再逐步替代。`,
    `- 仓储费：ET 物流仓服账单已能通过 ExportStoreFee 下载 SKU/箱号明细，作为货号真实利润主路径；只有缺明细日期才按体积库存天数估算并校准到 ET 每日总账。`,
    ``,
    `## 5. 建议新增/升级 BI 模块`,
    `- “ET 仓储实盘”：按货号展示 09/01/03/04/06 仓库存、箱数、可售/待处理/报废数量。`,
    `- “批次与在途”：按发货申请单展示发货、到仓、拆箱、上架、剩余库存与去化周期。`,
    `- “出库-订单互证”：用 ET 出库单物流号反查 SHEIN 订单/售后，发现漏发、退回、异常物流。`,
    `- “RTV/破损池”：按退货物流号、仓库和货号跟踪退回、破损、换包装和报废。`,
    `- “仓储物流费用复核”：按 ET 财务分类对比仓储费总账、ExportStoreFee 明细和旧手工月仓储费兜底表。`,
    ``,
  ].join('\n');

  const file = path.join(args.outDir, `et-forwarder-assessment-${args.date}.md`);
  await fs.writeFile(file, md, 'utf8');
  console.log(JSON.stringify({ok: true, file}, null, 2));
}

main().catch(err => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
