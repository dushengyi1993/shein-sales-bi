# Storage Fee Profit Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 ET 物流仓服账单里的仓储费纳入 SHEIN 店铺、分组和货号真实利润计算，并让 BI 与营销定价使用含仓储费的新口径。

**Architecture:** ET 仓储费总额继续由 `fact.et_income_bill` 自动入仓，新增 SQL 视图把 `sort_name='仓储费'` 账单转换成实际扣费金额；店铺/分组按净销售额分摊；货号层优先使用网页端 `ExportStoreFee` 下载的 SKU/箱号日仓储费明细，只有缺明细日期才回退到 ET 体积与库存天数估算并校准到每日实际仓储费总额。保留 `profit_before_storage_sar`，新增 `profit_after_storage_sar` / `storage_fee_sar` / `storage_fee_method`，避免与商品成本、退货派送费和 RTV 二售测算重复扣减。

**Implementation Review Amendments (2026-05-30):**
- Do not join product-level storage allocation directly into `mart.profit_daily_store_product` by only `date + standard_goods_sn`; that view is store/product grained and a direct join would duplicate one product-day storage fee across every store that sold the product. Add a product-store bridge allocation or aggregate product storage separately before exposing product summaries.
- `mart.profit_month_group` remains the authoritative store/group lens and must use `mart.storage_fee_store_daily` (net-revenue allocation). Product summaries use `mart.storage_fee_product_daily`, which prefers downloaded ET storage-fee detail rows and falls back to `mart.storage_fee_product_daily_estimated` only where detail coverage is missing. These are two explainable lenses over the same daily ET total; do not silently mix one lens into the other without naming the method.
- Product true-profit summaries must subtract all product storage fees in the selected ET fee period, including days when the product had storage-fee detail but no sales. Do not rely only on rows from `mart.profit_daily_store_product`, because that sales-grained view cannot represent no-sale storage days.
- Cloud evidence on 2026-05 data: ET has 28 storage-fee days from `2026-05-01` to `2026-05-28`; same-day billable ET stock snapshots exist only from `2026-05-07`, and `2026-05-13` has no billable rows. Product allocation therefore needs a latest-prior/first-available snapshot fallback and must expose the `source_snapshot_date` / fallback method.
- Cloud evidence on storage-fee amount fields: `fact.et_income_bill.other_income` is the complete displayed storage-fee amount for all 194 rows (`2025-11-17` to `2026-05-28`, total `67062.35 RMB`). `out_money` is zero for 2025-11 through 2026-03 and only equals `other_income` from 2026-04 onward, so the official source field for `shown_fee_rmb` must be `other_income`, not `coalesce(out_money, other_income)`. `billing_period_date` is a later settlement date (for May rows it is `2026-06-16`) and must not replace `ship_time::date` / `create_time::date` as the fee date.
- Cloud evidence on bill status and details: storage-fee bills are split between `status_name='已支付'` for `2025-11-17` to `2026-03-31` (`135` rows, `35215.06 RMB`) and `status_name='等待支付'` for `2026-04-01` to `2026-05-28` (`59` rows, `31847.29 RMB`). Treat ET storage bills as accrued cost regardless of paid/waiting status, but expose `bill_status_name` diagnostically. `raw_summary->>'Discount'` is blank for all 194 rows, so the actual half charge must come from `dim.storage_fee_policy.billing_discount=0.5`, not from ET raw rows. `/Finance/IncomeBill/GetDetailGridJson` produces item rows for other fee types but storage fees have `0` item rows for all `194` bills; `fact.et_income_payment` also has no matching storage payment rows, so neither is the storage SKU-detail source.
- Verified web-detail source (2026-05-30): the income-bill page row action `lay-event="exportStoreFee"` calls `POST /Finance/IncomeBill/ExportStoreFee?t=...` with `{incomeBillId}` and returns `/Base/DownloadDataCsvByName?...`. Sample storage bill `AR2605296170401260` downloaded as `text/comma-separated-values` (`gb18030` CSV) with 136 detail rows plus a footer. Header: `日期, 仓库, 仓储方式, SKU(箱)号, 数量, 每件(箱)体积(m3), 体积小计(m3), 仓储费单价(元/m3*天), 仓储费小计, 会员折扣, 折后总价`. Detail `折后总价` sums to `527.5911705 RMB`, matching `fact.et_income_bill.other_income=527.59 RMB`; the BI actual charge still applies `billing_discount=0.5` on top of that total.
- BI static dependency evidence: `outputs/bi-portal/data.json` currently exposes `profit.products`, `profit.monthGroups`, and `profit.dailyStoreProducts` (plural). The profit page builds date/store-filtered product rows by re-aggregating `DATA.profit.dailyStoreProducts` in `aggregateProfitProductsFromDailyRows()`, so adding storage only to SQL `mart.profit_product_summary` is insufficient. The BI JSON must also expose product-day storage rows (for no-sale storage days) and, when needed, store/product bridge storage rows (for store-scoped drilldown) so the frontend can aggregate storage consistently with filters.
- Prior read-only product-allocation dry-run on cloud for `2026-05-01` to `2026-06-01` remains useful only as fallback validation: ET shown fee is `15859.46 RMB`, actual half-charge is `4405.41 SAR`, simulated product allocation covers all 28 fee days, 59 products, 2587 allocation rows, and allocates exactly `4405.41 SAR` with `0.00 SAR` delta. Use this path only when downloaded detail is missing or incomplete, and label it as estimated fallback.
- Reconciliation queries must aggregate fee totals and allocation totals independently before comparing. Do not sum fee totals after joining to allocation rows, because that multiplies daily total by allocation-row count.
- Read-only store/group allocation dry-run on cloud for `2026-05-01` to `2026-06-01`: all 28 fee days use `daily_net_revenue` allocation, covering 19 stores and 532 store-day rows. ET actual half-charge `4405.41 SAR` allocates exactly `4405.41 SAR` with `0.00 SAR` delta. Group allocation is DSY `3106.07 SAR` (`70.51%`) and LGM `1299.33 SAR` (`29.49%`) for the current cloud data.

**Tech Stack:** Node.js `.mjs` scripts, PostgreSQL SQL in `infra/warehouse/schema.sql`, BI static generation in `scripts/generate_bi_portal.mjs`, marketing helper scripts under `scripts/marketing/`, PowerShell/SSH verification against cloud PostgreSQL.

---

## Preconditions and Guardrails

- Current dirty worktree already contains unrelated 飞书日报修复 files:
  - `MEMORY.md`
  - `scripts/generate_daily_report_image.mjs`
  - `scripts/generate_today_detailed_report_image.mjs`
  - `scripts/send_daily_lark_report.mjs`
  - `skills/shein-sales-ops/SKILL.md`
- Do not stage or commit those files as part of this feature unless the user explicitly asks to bundle them.
- Do not write or commit `profiles/`, `state/*sessions*`, `.local.json`, cookies, tokens, passwords, database dumps, ET exported raw files/CSVs, `tmp/`, or `.codex/plans`.
- The user must approve the design direction before code changes begin. This plan assumes the recommended option A:
  - ET displayed storage fee amount is RMB.
  - Actual charged storage fee is displayed amount × `0.5`.
  - BI profit currency remains SAR with fixed conversion `1 SAR = 1.8 RMB`.
  - Downloaded storage detail `折后总价` sums to ET displayed storage fee (`other_income`). Actual charged storage fee is detail amount × `0.5`.
  - Warehouse rate such as 09 warehouse `8 RMB / m³ / day × 0.75` is used only for fallback product allocation weights when downloaded detail is missing; daily fallback allocations are calibrated to ET actual charged total, so the feature does not double-charge.

## Files and Responsibilities

- Modify `infra/warehouse/schema.sql`
  - Add storage fee policy/rate seed tables under `dim`.
  - Add storage fee daily, store allocation, and product allocation views under `mart`.
  - Add a storage-fee product-detail fact table fed by `ExportStoreFee` CSV downloads.
  - Add a product-store bridge only if a store/product-grained BI row needs storage fields; never duplicate product-day storage across stores.
  - Extend `mart.profit_order_item`, `mart.profit_daily_store_product`, `mart.profit_month_group`, and `mart.profit_product_summary`.
- Modify `scripts/generate_bi_portal.mjs`
  - Include new storage fields in the JSON payload.
  - Preserve exact BI JSON key names: `profit.dailyStoreProducts`, `profit.monthGroups`, `profit.products`; add explicit storage arrays such as `profit.storeStorageDaily`, `profit.productStorageDaily` and optionally `profit.productStoreStorageDaily`.
  - Change home KPI and profit page labels/tables from “未扣仓储” to “含仓储 / 未扣仓储拆分”.
  - Rank product profit using after-storage profit by default while preserving before-storage diagnostics.
- Modify `scripts/marketing/export_dsy_marketing_standards.mjs`
  - Show both 商品成本 and 仓储成本.
  - Calculate suggested activity price using true cost when storage allocation is available.
- Modify `scripts/marketing/dsy_marketing_deadline_fill.mjs`
  - Use true cost from the generated cost map when calculating margin-based activity price.
- Modify `scripts/marketing/build_marketing_cost_map.py`
  - Include storage-aware cost fields in `tmp/mbrs/marketing-cost-map.json`.
- Create `scripts/check_storage_fee_profit.mjs`
  - Run local/cloud SQL checks for storage fee totals, allocation totals, coverage, and no double charging.
- Modify `scripts/fetch_et_forwarder.mjs` and `scripts/load_et_forwarder_warehouse.mjs`
  - Fetch `/Finance/IncomeBill/ExportStoreFee` for storage-fee bills and parse the returned CSV into `fact.et_storage_fee_product_detail`.
- Modify docs:
  - `README.md`
  - `docs/bi-system-operations.md`
  - `docs/et-forwarder-bi-integration-plan.md`
  - `docs/bi-warehouse-model.md`
  - `skills/shein-sales-ops/SKILL.md`
  - `MEMORY.md`

---

## Task 1: SQL Regression Harness for Storage Fee Totals

**Files:**
- Create: `scripts/check_storage_fee_profit.mjs`
- Read: `infra/warehouse/schema.sql`

- [ ] **Step 1: Create the verification script skeleton**

Create `scripts/check_storage_fee_profit.mjs` with these responsibilities:

```js
#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    mode: 'local',
    start: '2026-05-01',
    end: '2026-06-01',
    container: 'shein-warehouse-db',
    database: 'shein_bi',
    user: 'shein',
    host: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--mode') args.mode = argv[++i];
    else if (a === '--start') args.start = argv[++i];
    else if (a === '--end') args.end = argv[++i];
    else if (a === '--host') args.host = argv[++i];
    else if (a === '--container') args.container = argv[++i];
    else if (a === '--database') args.database = argv[++i];
    else if (a === '--user') args.user = argv[++i];
  }
  return args;
}

function sqlQuote(v) {
  return `'${String(v).replaceAll("'", "''")}'`;
}

function run(cmd, input) {
  const res = spawnSync(cmd[0], cmd.slice(1), {input, encoding: 'utf8', cwd: ROOT});
  if (res.status !== 0) {
    throw new Error(`Command failed: ${cmd.join(' ')}\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`);
  }
  return res.stdout;
}

function psql(args, sql) {
  const inner = `sudo docker exec -i ${args.container} psql -U ${args.user} -d ${args.database} -v ON_ERROR_STOP=1 -A -F $'\\t'`;
  if (args.mode === 'cloud') {
    if (!args.host) throw new Error('--host is required when --mode cloud');
    return run(['ssh', args.host, inner], sql);
  }
  return run(['wsl', '-d', 'Ubuntu-24.04', '--', 'docker', 'exec', '-i', args.container, 'psql', '-U', args.user, '-d', args.database, '-v', 'ON_ERROR_STOP=1', '-A', '-F', '\t'], sql);
}

function parseTsv(stdout) {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  const header = lines[0].split('\t');
  return lines.slice(1).filter(line => !/^\(\d+ rows?\)$/.test(line)).map(line => {
    const cells = line.split('\t');
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
  });
}

const args = parseArgs(process.argv.slice(2));
const sql = `
SELECT
  'storage_total' AS check_name,
  count(*)::text AS rows,
  round(sum(coalesce(shown_fee_rmb,0))::numeric,2)::text AS shown_fee_rmb,
  round(sum(coalesce(actual_fee_rmb,0))::numeric,2)::text AS actual_fee_rmb,
  round(sum(coalesce(actual_fee_sar,0))::numeric,2)::text AS actual_fee_sar,
  round(sum(coalesce(store_allocated_fee_sar,0))::numeric,2)::text AS store_allocated_fee_sar,
  round(sum(coalesce(product_allocated_fee_sar,0))::numeric,2)::text AS product_allocated_fee_sar
FROM mart.storage_fee_daily_reconciliation
WHERE fee_date >= ${sqlQuote(args.start)}::date
  AND fee_date < ${sqlQuote(args.end)}::date;

SELECT
  'profit_after_storage' AS check_name,
  count(*)::text AS rows,
  round(sum(coalesce(storage_fee_sar,0))::numeric,2)::text AS storage_fee_sar,
  round(sum(coalesce(profit_before_storage_sar,0))::numeric,2)::text AS profit_before_storage_sar,
  round(sum(coalesce(profit_after_storage_sar,0))::numeric,2)::text AS profit_after_storage_sar
FROM mart.profit_daily_store_product
WHERE date >= ${sqlQuote(args.start)}::date
  AND date < ${sqlQuote(args.end)}::date;
`;

const output = psql(args, sql);
console.log(output);
```

- [ ] **Step 2: Run the script before schema changes and confirm it fails for the right reason**

Run:

```powershell
node scripts/check_storage_fee_profit.mjs --mode cloud --host shein-bi-tencent --start 2026-05-01 --end 2026-06-01
```

Expected now: fails because `mart.storage_fee_daily_reconciliation` or `storage_fee_sar` does not exist.

- [ ] **Step 3: Keep the failure output as evidence**

Record the failure message in `.codex/plans/2026-05-30T01-09-28-storage-fee-profit-integration.md` under M4 when implementation starts.

---

## Task 2: Warehouse Schema for Storage Fee Policy and Allocation

**Files:**
- Modify: `infra/warehouse/schema.sql`
- Test: `scripts/check_storage_fee_profit.mjs`

- [ ] **Step 1: Add policy and warehouse-rate seed tables**

Add near the existing cost/profit tables in `infra/warehouse/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS dim.storage_fee_policy (
  policy_key text PRIMARY KEY,
  currency_code text NOT NULL DEFAULT 'CNY',
  sar_to_rmb numeric NOT NULL DEFAULT 1.8,
  billing_discount numeric NOT NULL DEFAULT 0.5,
  effective_from date NOT NULL DEFAULT '2025-01-01',
  note text,
  updated_at timestamptz DEFAULT now()
);

INSERT INTO dim.storage_fee_policy(policy_key, currency_code, sar_to_rmb, billing_discount, effective_from, note)
VALUES ('et_default', 'CNY', 1.8, 0.5, '2025-01-01', 'ET仓储费显示金额按RMB；实际减半收取；利润按SAR展示。')
ON CONFLICT (policy_key) DO UPDATE SET
  currency_code = EXCLUDED.currency_code,
  sar_to_rmb = EXCLUDED.sar_to_rmb,
  billing_discount = EXCLUDED.billing_discount,
  effective_from = EXCLUDED.effective_from,
  note = EXCLUDED.note,
  updated_at = now();

CREATE TABLE IF NOT EXISTS dim.storage_warehouse_rate (
  warehouse_match text PRIMARY KEY,
  warehouse_label text NOT NULL,
  rate_rmb_per_m3_day numeric NOT NULL,
  warehouse_discount numeric NOT NULL DEFAULT 1,
  billable boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 100,
  note text,
  updated_at timestamptz DEFAULT now()
);

INSERT INTO dim.storage_warehouse_rate(warehouse_match, warehouse_label, rate_rmb_per_m3_day, warehouse_discount, billable, priority, note)
VALUES
  ('%09%', 'ETRUH09散件仓', 8, 0.75, true, 10, '用户确认：09仓8元一方，实际0.75折；最终按ET每日总账校准。'),
  ('%03%', 'ETRUH03_RTV', 8, 0.75, true, 20, 'RTV仓先按同费率估算，后续可用ET明细修正。'),
  ('%04%', 'ETRUH04Damaged', 8, 0.75, true, 30, '破损仓先按同费率估算，页面标注估算。'),
  ('%06%', 'ETRUH06报废', 8, 0.75, true, 40, '报废仓先按同费率估算，页面标注估算。')
ON CONFLICT (warehouse_match) DO UPDATE SET
  warehouse_label = EXCLUDED.warehouse_label,
  rate_rmb_per_m3_day = EXCLUDED.rate_rmb_per_m3_day,
  warehouse_discount = EXCLUDED.warehouse_discount,
  billable = EXCLUDED.billable,
  priority = EXCLUDED.priority,
  note = EXCLUDED.note,
  updated_at = now();
```

- [ ] **Step 2: Add daily storage fee view**

Add after ET finance fact tables or before profit views:

```sql
CREATE OR REPLACE VIEW mart.et_storage_fee_daily AS
WITH policy AS (
  SELECT * FROM dim.storage_fee_policy WHERE policy_key = 'et_default'
),
base AS (
  SELECT
    coalesce(ship_time::date, create_time::date, push_time::date) AS fee_date,
    income_bill_id,
    status AS bill_status,
    status_name AS bill_status_name,
    coalesce(other_income,0) AS shown_fee_rmb,
    out_money AS diagnostic_out_money_rmb,
    billing_period_date::date AS billing_period_date,
    raw_summary
  FROM fact.et_income_bill
  WHERE sort_name = '仓储费'
)
SELECT
  b.fee_date,
  b.income_bill_id,
  b.bill_status,
  b.bill_status_name,
  b.shown_fee_rmb,
  b.diagnostic_out_money_rmb,
  b.billing_period_date,
  p.billing_discount,
  round((b.shown_fee_rmb * p.billing_discount)::numeric, 6) AS actual_fee_rmb,
  round((b.shown_fee_rmb * p.billing_discount / nullif(p.sar_to_rmb,0))::numeric, 6) AS actual_fee_sar,
  p.currency_code,
  p.sar_to_rmb,
  'et_income_bill'::text AS source,
  b.raw_summary
FROM base b
CROSS JOIN policy p
WHERE b.fee_date IS NOT NULL;
```

- [ ] **Step 3: Add store allocation view**

Use daily net revenue and month fallback:

```sql
CREATE OR REPLACE VIEW mart.storage_fee_store_daily AS
WITH store_day AS (
  SELECT
    created_date::date AS date,
    store_key,
    group_key,
    sum(net_revenue_sar) AS net_revenue_sar
  FROM mart.profit_order_item
  GROUP BY created_date::date, store_key, group_key
),
day_total AS (
  SELECT date, sum(net_revenue_sar) AS day_net_revenue_sar
  FROM store_day
  GROUP BY date
),
store_month AS (
  SELECT
    date_trunc('month', date)::date AS month_start,
    store_key,
    group_key,
    sum(net_revenue_sar) AS month_net_revenue_sar
  FROM store_day
  GROUP BY date_trunc('month', date)::date, store_key, group_key
),
month_total AS (
  SELECT month_start, sum(month_net_revenue_sar) AS month_net_revenue_sar
  FROM store_month
  GROUP BY month_start
)
SELECT
  sf.fee_date AS date,
  sm.store_key,
  sm.group_key,
  coalesce(sd.net_revenue_sar,0) AS net_revenue_sar,
  CASE
    WHEN coalesce(dt.day_net_revenue_sar,0) > 0 THEN coalesce(sd.net_revenue_sar,0) / nullif(dt.day_net_revenue_sar,0)
    WHEN coalesce(mt.month_net_revenue_sar,0) > 0 THEN coalesce(sm.month_net_revenue_sar,0) / nullif(mt.month_net_revenue_sar,0)
    ELSE 0
  END AS revenue_share,
  sf.actual_fee_sar * CASE
    WHEN coalesce(dt.day_net_revenue_sar,0) > 0 THEN coalesce(sd.net_revenue_sar,0) / nullif(dt.day_net_revenue_sar,0)
    WHEN coalesce(mt.month_net_revenue_sar,0) > 0 THEN coalesce(sm.month_net_revenue_sar,0) / nullif(mt.month_net_revenue_sar,0)
    ELSE 0
  END AS allocated_storage_fee_sar,
  CASE
    WHEN coalesce(dt.day_net_revenue_sar,0) > 0 THEN 'daily_net_revenue'
    WHEN coalesce(mt.month_net_revenue_sar,0) > 0 THEN 'monthly_net_revenue_fallback'
    ELSE 'unallocated_no_revenue'
  END AS allocation_method
FROM mart.et_storage_fee_daily sf
JOIN store_month sm
  ON sm.month_start = date_trunc('month', sf.fee_date)::date
LEFT JOIN store_day sd
  ON sd.date = sf.fee_date AND sd.store_key = sm.store_key
LEFT JOIN day_total dt
  ON dt.date = sf.fee_date
LEFT JOIN month_total mt
  ON mt.month_start = sm.month_start;
```

- [ ] **Step 4: Add product detail table, detail-first product view, and estimated fallback view**

First add a fact table for the downloaded `ExportStoreFee` CSV rows. The raw CSV is not committed; only normalized rows are loaded. Filter the footer row where `会员折扣='合计'`. For `仓储方式='散件'`, normalize `SKU(箱)号` directly as a SKU/product code. For `仓储方式='整箱'`, treat `SKU(箱)号` as a box id and expand to products through `fact.et_box_item` where possible; if a box cannot be expanded, keep an unmatched detail row so coverage gaps are visible instead of silently dropping cost.

```sql
CREATE TABLE IF NOT EXISTS fact.et_storage_fee_product_detail (
  unique_key text PRIMARY KEY,
  batch_id text,
  income_bill_id text NOT NULL,
  fee_date date NOT NULL,
  warehouse_name text,
  storage_type text,
  storage_code text NOT NULL,
  sku_code text,
  standard_goods_sn text,
  match_key text,
  quantity numeric,
  volume_m3_per_unit numeric,
  volume_m3_total numeric,
  rate_rmb_per_m3_day numeric,
  storage_fee_rmb_before_discount numeric,
  member_discount numeric,
  shown_fee_rmb numeric,
  actual_fee_rmb numeric,
  actual_fee_sar numeric,
  allocation_method text NOT NULL DEFAULT 'download_detail',
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_et_storage_fee_product_detail_date ON fact.et_storage_fee_product_detail(fee_date);
CREATE INDEX IF NOT EXISTS idx_et_storage_fee_product_detail_bill ON fact.et_storage_fee_product_detail(income_bill_id);
CREATE INDEX IF NOT EXISTS idx_et_storage_fee_product_detail_match ON fact.et_storage_fee_product_detail(match_key);
```

Then create the detail-first product view. Its daily total should match `mart.et_storage_fee_daily.actual_fee_sar` for dates where all rows are downloaded. Keep a separate estimated fallback view using ET inventory and plausible ET SKU volume. Convert cubic centimeters to cubic meters. Because current cloud ET stock snapshots begin later than the storage-fee history (`2026-05-07` vs fee dates from `2026-05-01`), the fallback view must pick the latest billable stock snapshot on or before each fee date, falling forward only when there is no prior snapshot. Expose the snapshot fallback so BI can label early estimates.

```sql
CREATE OR REPLACE VIEW mart.storage_fee_product_daily_estimated AS
WITH fee_dates AS (
  SELECT DISTINCT fee_date FROM mart.et_storage_fee_daily
),
latest_sku AS (
  SELECT DISTINCT ON (match_key)
    match_key,
    standard_goods_sn,
    CASE
      WHEN sku_volume > 0 AND sku_volume < 500000 THEN sku_volume / 1000000.0
      WHEN goods_volume > 0 AND goods_volume < 500000 THEN goods_volume / 1000000.0
      ELSE NULL
    END AS volume_m3_per_unit
  FROM fact.et_sku_specification
  WHERE coalesce(match_key,'') <> ''
  ORDER BY match_key, source_batch_id DESC
),
stock AS (
  SELECT snapshot_date AS date, storeroom_name, match_key, standard_goods_sn, sum(coalesce(real_quantity, quantity, 0)) AS on_hand_qty
  FROM fact.et_store_stock_snapshot
  WHERE coalesce(match_key,'') <> ''
  GROUP BY snapshot_date, storeroom_name, match_key, standard_goods_sn
  UNION ALL
  SELECT snapshot_date AS date, storeroom_name, match_key, standard_goods_sn, sum(coalesce(real_quantity, quantity, 0)) AS on_hand_qty
  FROM fact.et_box_stock_snapshot
  WHERE coalesce(match_key,'') <> ''
  GROUP BY snapshot_date, storeroom_name, match_key, standard_goods_sn
),
stock_rated_observed AS (
  SELECT
    s.date,
    s.storeroom_name,
    s.match_key,
    max(s.standard_goods_sn) AS standard_goods_sn,
    sum(s.on_hand_qty) AS on_hand_qty,
    max(ls.volume_m3_per_unit) AS volume_m3_per_unit,
    max(r.rate_rmb_per_m3_day) AS rate_rmb_per_m3_day,
    max(r.warehouse_discount) AS warehouse_discount
  FROM stock s
  LEFT JOIN latest_sku ls ON ls.match_key = s.match_key
  LEFT JOIN LATERAL (
    SELECT *
    FROM dim.storage_warehouse_rate wr
    WHERE s.storeroom_name ILIKE wr.warehouse_match
      AND wr.billable
    ORDER BY wr.priority
    LIMIT 1
  ) r ON true
  WHERE r.warehouse_match IS NOT NULL
  GROUP BY s.date, s.storeroom_name, s.match_key
),
stock_for_fee AS (
  SELECT
    f.fee_date AS date,
    pick.source_snapshot_date,
    CASE
      WHEN pick.source_snapshot_date = f.fee_date THEN 'same_day_snapshot'
      WHEN pick.source_snapshot_date < f.fee_date THEN 'latest_prior_snapshot'
      WHEN pick.source_snapshot_date > f.fee_date THEN 'first_available_forward_snapshot'
      ELSE 'missing_stock_snapshot'
    END AS stock_snapshot_method,
    s.storeroom_name,
    s.match_key,
    s.standard_goods_sn,
    s.on_hand_qty,
    s.volume_m3_per_unit,
    s.rate_rmb_per_m3_day,
    s.warehouse_discount
  FROM fee_dates f
  LEFT JOIN LATERAL (
    SELECT coalesce(
      (SELECT max(x.date) FROM stock_rated_observed x WHERE x.date <= f.fee_date),
      (SELECT min(x.date) FROM stock_rated_observed x WHERE x.date > f.fee_date)
    ) AS source_snapshot_date
  ) pick ON true
  JOIN stock_rated_observed s ON s.date = pick.source_snapshot_date
),
weighted AS (
  SELECT
    date,
    source_snapshot_date,
    stock_snapshot_method,
    coalesce(nullif(standard_goods_sn,''), match_key) AS standard_goods_sn,
    match_key,
    storeroom_name AS warehouse_name,
    on_hand_qty,
    volume_m3_per_unit,
    rate_rmb_per_m3_day,
    warehouse_discount,
    on_hand_qty * volume_m3_per_unit AS stock_m3_days,
    on_hand_qty * volume_m3_per_unit * rate_rmb_per_m3_day * warehouse_discount AS estimated_fee_rmb_before_calibration
  FROM stock_for_fee
  WHERE coalesce(on_hand_qty,0) > 0
    AND coalesce(volume_m3_per_unit,0) > 0
    AND coalesce(rate_rmb_per_m3_day,0) > 0
),
daily_weight AS (
  SELECT date, sum(estimated_fee_rmb_before_calibration) AS total_estimated_fee_rmb
  FROM weighted
  GROUP BY date
)
SELECT
  w.date,
  w.source_snapshot_date,
  w.stock_snapshot_method,
  w.standard_goods_sn,
  w.match_key,
  w.warehouse_name,
  w.on_hand_qty,
  w.volume_m3_per_unit,
  w.stock_m3_days,
  w.rate_rmb_per_m3_day,
  w.warehouse_discount,
  w.estimated_fee_rmb_before_calibration,
  sf.actual_fee_sar * w.estimated_fee_rmb_before_calibration / nullif(dw.total_estimated_fee_rmb,0) AS actual_allocated_fee_sar,
  ('volume_stock_days_estimated:' || w.stock_snapshot_method)::text AS storage_allocation_method
FROM weighted w
JOIN daily_weight dw ON dw.date = w.date
JOIN mart.et_storage_fee_daily sf ON sf.fee_date = w.date;
```

Create the authoritative product-daily view by using downloaded detail where present, and estimated fallback only for fee dates without downloaded detail coverage:

```sql
CREATE OR REPLACE VIEW mart.storage_fee_product_daily AS
WITH detail_day AS (
  SELECT fee_date AS date, sum(actual_fee_sar) AS detail_fee_sar
  FROM fact.et_storage_fee_product_detail
  GROUP BY fee_date
),
detail_rows AS (
  SELECT
    fee_date AS date,
    standard_goods_sn,
    match_key,
    warehouse_name,
    sum(quantity) AS quantity,
    sum(volume_m3_total) AS volume_m3_total,
    sum(shown_fee_rmb) AS shown_fee_rmb,
    sum(actual_fee_rmb) AS actual_fee_rmb,
    sum(actual_fee_sar) AS actual_allocated_fee_sar,
    'download_detail'::text AS storage_allocation_method
  FROM fact.et_storage_fee_product_detail
  WHERE coalesce(standard_goods_sn, match_key, '') <> ''
  GROUP BY fee_date, standard_goods_sn, match_key, warehouse_name
),
fallback_rows AS (
  SELECT
    e.date,
    e.standard_goods_sn,
    e.match_key,
    e.warehouse_name,
    e.on_hand_qty AS quantity,
    e.stock_m3_days AS volume_m3_total,
    NULL::numeric AS shown_fee_rmb,
    NULL::numeric AS actual_fee_rmb,
    e.actual_allocated_fee_sar,
    e.storage_allocation_method
  FROM mart.storage_fee_product_daily_estimated e
  LEFT JOIN detail_day d ON d.date = e.date
  WHERE d.date IS NULL
)
SELECT * FROM detail_rows
UNION ALL
SELECT * FROM fallback_rows;
```

- [ ] **Step 5: Add reconciliation view**

```sql
CREATE OR REPLACE VIEW mart.storage_fee_daily_reconciliation AS
SELECT
  sf.fee_date,
  sf.shown_fee_rmb,
  sf.actual_fee_rmb,
  sf.actual_fee_sar,
  coalesce(sa.store_allocated_fee_sar,0) AS store_allocated_fee_sar,
  coalesce(pa.product_allocated_fee_sar,0) AS product_allocated_fee_sar,
  sf.actual_fee_sar - coalesce(sa.store_allocated_fee_sar,0) AS store_allocation_delta_sar,
  sf.actual_fee_sar - coalesce(pa.product_allocated_fee_sar,0) AS product_allocation_delta_sar
FROM (
  SELECT fee_date, sum(shown_fee_rmb) AS shown_fee_rmb, sum(actual_fee_rmb) AS actual_fee_rmb, sum(actual_fee_sar) AS actual_fee_sar
  FROM mart.et_storage_fee_daily
  GROUP BY fee_date
) sf
LEFT JOIN (
  SELECT date, sum(allocated_storage_fee_sar) AS store_allocated_fee_sar
  FROM mart.storage_fee_store_daily
  GROUP BY date
) sa ON sa.date = sf.fee_date
LEFT JOIN (
  SELECT date, sum(actual_allocated_fee_sar) AS product_allocated_fee_sar
  FROM mart.storage_fee_product_daily
  GROUP BY date
) pa ON pa.date = sf.fee_date;
```

- [ ] **Step 6: Run schema update locally or on cloud staging path**

For cloud production after approval:

```powershell
Get-Content -LiteralPath infra\warehouse\schema.sql | ssh shein-bi-tencent "sudo docker exec -i shein-warehouse-db psql -U shein -d shein_bi -v ON_ERROR_STOP=1"
```

Expected: no SQL errors.

---

## Task 3: Extend Profit Views Without Double Charging

**Files:**
- Modify: `infra/warehouse/schema.sql`
- Test: `scripts/check_storage_fee_profit.mjs`

- [ ] **Step 1: Add a store/product bridge before extending `mart.profit_daily_store_product`**

Do not join `mart.storage_fee_product_daily` directly to `mart.profit_daily_store_product` on product/date only. First create a non-duplicating bridge that spreads a product-day storage fee across store/product sales rows only for BI drilldown display:

```sql
CREATE OR REPLACE VIEW mart.storage_fee_product_store_daily AS
WITH product_fee AS (
  SELECT
    date,
    standard_goods_sn,
    sum(actual_allocated_fee_sar) AS product_storage_fee_sar,
    string_agg(DISTINCT storage_allocation_method, ' / ') AS storage_fee_method
  FROM mart.storage_fee_product_daily
  GROUP BY date, standard_goods_sn
),
store_product_sales AS (
  SELECT
    created_date::date AS date,
    store_key,
    group_key,
    standard_goods_sn,
    sum(net_revenue_sar) FILTER (WHERE NOT cost_missing) AS known_net_revenue_sar,
    sum(quantity) AS quantity
  FROM mart.profit_order_item
  WHERE coalesce(standard_goods_sn,'') <> ''
  GROUP BY created_date::date, store_key, group_key, standard_goods_sn
),
product_day_sales AS (
  SELECT
    date,
    standard_goods_sn,
    sum(coalesce(known_net_revenue_sar,0)) AS product_known_net_revenue_sar,
    sum(coalesce(quantity,0)) AS product_quantity
  FROM store_product_sales
  GROUP BY date, standard_goods_sn
)
SELECT
  s.date,
  s.store_key,
  s.group_key,
  s.standard_goods_sn,
  f.product_storage_fee_sar * CASE
    WHEN coalesce(t.product_known_net_revenue_sar,0) > 0 THEN coalesce(s.known_net_revenue_sar,0) / nullif(t.product_known_net_revenue_sar,0)
    WHEN coalesce(t.product_quantity,0) > 0 THEN coalesce(s.quantity,0) / nullif(t.product_quantity,0)
    ELSE 0
  END AS storage_fee_sar,
  f.storage_fee_method || ':store_product_sales_bridge' AS storage_fee_method
FROM store_product_sales s
JOIN product_fee f
  ON f.date = s.date
 AND dim.product_match_key(f.standard_goods_sn) = dim.product_match_key(s.standard_goods_sn)
JOIN product_day_sales t
  ON t.date = s.date
 AND t.standard_goods_sn = s.standard_goods_sn;
```

This bridge is for the existing store/product-grained BI row shape only. The authoritative product summary in Step 3 must still subtract all rows from `mart.storage_fee_product_daily`, including no-sale days.

- [ ] **Step 2: Extend `mart.profit_daily_store_product`**

In `mart.profit_daily_store_product`, alias `mart.profit_order_item` as `p` and join the non-duplicating bridge:

```sql
LEFT JOIN (
  SELECT
    date,
    store_key,
    group_key,
    standard_goods_sn,
    sum(storage_fee_sar) AS storage_fee_sar,
    string_agg(DISTINCT storage_fee_method, ' / ') AS storage_fee_method
  FROM mart.storage_fee_product_store_daily
  GROUP BY date, store_key, group_key, standard_goods_sn
) ps
  ON ps.date = p.created_date
 AND ps.store_key = p.store_key
 AND ps.group_key = p.group_key
 AND dim.product_match_key(ps.standard_goods_sn) = dim.product_match_key(p.standard_goods_sn)
```

Add fields:

```sql
coalesce(max(ps.storage_fee_sar),0) AS storage_fee_sar,
sum(p.profit_before_storage_sar) FILTER (WHERE NOT p.cost_missing) - coalesce(max(ps.storage_fee_sar),0) AS profit_after_storage_sar,
CASE
  WHEN sum(p.net_revenue_sar) FILTER (WHERE NOT p.cost_missing) > 0
  THEN (sum(p.profit_before_storage_sar) FILTER (WHERE NOT p.cost_missing) - coalesce(max(ps.storage_fee_sar),0))
    / nullif(sum(p.net_revenue_sar) FILTER (WHERE NOT p.cost_missing), 0)
  ELSE NULL
END AS profit_margin_after_storage,
coalesce(max(ps.storage_fee_method),'none') AS storage_fee_method
```

Keep existing `profit_before_storage_sar` and `profit_margin_before_storage`.

- [ ] **Step 3: Extend `mart.profit_month_group`**

Replace `fact.monthly_storage_fee` allocation with ET-derived `mart.storage_fee_store_daily`:

```sql
storage_group_month AS (
  SELECT
    date_trunc('month', date)::date AS month_start,
    group_key,
    sum(allocated_storage_fee_sar) AS allocated_storage_fee_sar
  FROM mart.storage_fee_store_daily
  GROUP BY date_trunc('month', date)::date, group_key
)
```

Then join `storage_group_month` and compute:

```sql
coalesce(sgm.allocated_storage_fee_sar,0) AS allocated_storage_fee_sar,
coalesce(sgm.allocated_storage_fee_sar,0) AS month_storage_fee_sar,
g.profit_before_storage_sar - coalesce(sgm.allocated_storage_fee_sar,0) AS profit_after_storage_sar
```

Remove dependency on `fact.monthly_storage_fee` from active ET path. Keep the table for historical manual imports, but document it as legacy/manual fallback.

- [ ] **Step 4: Extend `mart.profit_product_summary`**

Aggregate new storage fields from the authoritative product allocation, not just from sales-grained `mart.profit_daily_store_product`:

```sql
LEFT JOIN (
  SELECT
    standard_goods_sn,
    sum(actual_allocated_fee_sar) AS storage_fee_sar,
    string_agg(DISTINCT storage_allocation_method, ' / ') AS storage_fee_method,
    count(DISTINCT date) AS storage_fee_days,
    min(source_snapshot_date) AS storage_source_snapshot_min,
    max(source_snapshot_date) AS storage_source_snapshot_max
  FROM mart.storage_fee_product_daily
  GROUP BY standard_goods_sn
) ps
  ON dim.product_match_key(ps.standard_goods_sn) = dim.product_match_key(p.standard_goods_sn)

coalesce(max(ps.storage_fee_sar),0) AS storage_fee_sar,
sum(p.profit_before_storage_sar) - coalesce(max(ps.storage_fee_sar),0) AS profit_after_storage_sar,
CASE
  WHEN sum(p.net_revenue_sar) FILTER (WHERE p.missing_cost_lines = 0) > 0
  THEN (sum(p.profit_before_storage_sar) - coalesce(max(ps.storage_fee_sar),0)) / nullif(sum(p.known_net_revenue_sar),0)
  ELSE NULL
END AS profit_margin_after_storage,
coalesce(max(ps.storage_fee_method),'none') AS storage_fee_method
```

- [ ] **Step 5: Run SQL verification**

Run:

```powershell
node scripts/check_storage_fee_profit.mjs --mode cloud --host shein-bi-tencent --start 2026-05-01 --end 2026-06-01
```

Expected after schema changes:
- `storage_total.actual_fee_sar` equals about `4405.41` for `2026-05-01` to `2026-06-01` using current cloud data.
- `store_allocated_fee_sar` matches `actual_fee_sar` within rounding. Current read-only dry-run for May 2026 allocated `4405.41 / 4405.41 SAR` across 28 fee days, 19 stores, and 532 store-day rows; DSY/LGM split is `3106.07 / 1299.33 SAR` for current cloud data.
- `product_allocated_fee_sar` matches `actual_fee_sar` within rounding. Current read-only dry-run for May 2026 allocated `4405.41 / 4405.41 SAR` across 28 fee days and 59 products; if future data changes create a delta, explain it by missing volume/stock rows and show `source_snapshot_date` coverage.
- Verification SQL must not compare totals after directly joining fee rows to product allocation rows. Aggregate fee totals by day and allocation totals by day first, then compare, or the fee side will be multiplied by allocation row count.

---

## Task 4: BI Portal Data and UI

**Files:**
- Modify: `scripts/generate_bi_portal.mjs`
- Test: generated `outputs/bi-portal/data.json` and static HTML.

- [ ] **Step 1: Add storage fields to data SQL**

In the `profit_daily_store_product` JSON query, add:

```sql
round(sum(coalesce(storage_fee_sar,0))::numeric, 2) AS storage_fee_sar,
round(sum(coalesce(profit_after_storage_sar,0))::numeric, 2) AS profit_after_storage_sar,
CASE WHEN sum(coalesce(net_revenue_sar,0)) FILTER (WHERE missing_cost_lines = 0) > 0
  THEN round((sum(coalesce(profit_after_storage_sar,0)) / nullif(sum(coalesce(known_net_revenue_sar,0)),0))::numeric, 4)
  ELSE NULL END AS profit_margin_after_storage,
string_agg(DISTINCT storage_fee_method, ' / ') FILTER (WHERE coalesce(storage_fee_method,'') <> '') AS storage_fee_method
```

In `profit_month_group` and `profit_product_summary`, expose:

```sql
round(storage_fee_sar::numeric, 2) AS storage_fee_sar
round(profit_after_storage_sar::numeric, 2) AS profit_after_storage_sar
round(profit_margin_after_storage::numeric, 4) AS profit_margin_after_storage
storage_fee_method
```

Add separate JSON arrays, because the current frontend re-aggregates filtered product rows from `profit.dailyStoreProducts`:

```sql
product_storage_daily AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY date, standard_goods_sn), '[]'::jsonb) AS data
  FROM (
    SELECT
      date,
      standard_goods_sn,
      round(sum(actual_allocated_fee_sar)::numeric, 2) AS storage_fee_sar,
      string_agg(DISTINCT storage_allocation_method, ' / ') AS storage_fee_method,
      min(source_snapshot_date) AS source_snapshot_date_min,
      max(source_snapshot_date) AS source_snapshot_date_max
    FROM mart.storage_fee_product_daily
    GROUP BY date, standard_goods_sn
  ) t
),
product_store_storage_daily AS (
  SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY date, store_key, standard_goods_sn), '[]'::jsonb) AS data
  FROM (
    SELECT
      date,
      store_key,
      group_key,
      standard_goods_sn,
      round(sum(storage_fee_sar)::numeric, 2) AS storage_fee_sar,
      string_agg(DISTINCT storage_fee_method, ' / ') AS storage_fee_method
    FROM mart.storage_fee_product_store_daily
    GROUP BY date, store_key, group_key, standard_goods_sn
  ) t
)
```

Then add them to the `profit` object:

```sql
'productStorageDaily', (SELECT data FROM product_storage_daily),
'productStoreStorageDaily', (SELECT data FROM product_store_storage_daily),
'storeStorageDaily', (SELECT data FROM store_storage_daily)
```

- [ ] **Step 2: Change home KPI profit default to after-storage**

Update frontend helper functions:

```js
function profitRowValueKey(){
  return state.profitMode === 'rtv'
    ? 'profit_if_rtv_received_resellable_after_storage_sar'
    : 'profit_after_storage_sar';
}
```

Update summary accumulation:

```js
out.storageFeeSar += Number(r.storage_fee_sar || 0);
out.profitSar += Number(r.profit_after_storage_sar ?? r.profit_before_storage_sar ?? 0);
out.profitBeforeStorageSar += Number(r.profit_before_storage_sar || 0);
```

For product/date filtered pages, update `aggregateProfitProductsFromDailyRows()` so product after-storage profit does not depend only on sales rows:

- If there is no store/group filter, subtract matching rows from `DATA.profit.productStorageDaily` for the selected date range and product query.
- If there is a store/group filter, use `DATA.profit.productStoreStorageDaily` to avoid duplicating one product-day fee across stores; label the method as a store/product sales bridge.
- Keep `profit_before_storage_sar` and `profit_margin_before_storage` for diagnostics.
- Add `storage_fee_sar`, `profit_after_storage_sar`, `profit_margin_after_storage`, and `storage_fee_method` to the aggregated product rows.

- [ ] **Step 3: Update labels and explanatory text**

Replace user-facing text:
- From: `未扣月仓储`
- To: `已扣仓储；商品利润拆分可看未扣仓储`

Replace:
- `月仓储费只用于月度总利润，不拆到单货号。`
- With: `仓储费已进入真实利润；货号层优先使用ET当日仓储费下载明细，缺明细日期才按ET体积库存天数估算分摊并标注兜底口径。`

- [ ] **Step 4: Update product profit tables**

In `profitCols`, add columns:

```js
['仓储费', r => money(r.storage_fee_sar)+'<br><span class="muted">'+escapeHtml(r.storage_fee_method || '无')+'</span>', 'num'],
['含仓储利润/率', r => money(r.profit_after_storage_sar)+'<br><span class="muted">'+pct(r.profit_margin_after_storage)+'</span>', 'num']
```

Sort high/low profit products by `profit_margin_after_storage` first, falling back to `profit_margin_before_storage`.

- [ ] **Step 5: Generate and assert BI output**

Run:

```powershell
$env:SHEIN_BI_PORTAL_TIMEOUT_MS='900000'
node scripts/generate_bi_portal.mjs
node -e "const d=require('./outputs/bi-portal/data.json'); const p=d.profit?.products||[]; console.log({products:p.length, withStorage:p.filter(x=>Number(x.storage_fee_sar||0)>0).length, monthGroups:(d.profit?.monthGroups||[]).length}); if(!p.some(x=>Number(x.storage_fee_sar||0)>0)) process.exit(1)"
```

Expected: generated data has product rows with positive `storage_fee_sar`, `profit.productStorageDaily` rows with positive `storage_fee_sar`, and month group rows with positive `allocated_storage_fee_sar`.

---

## Task 5: Marketing Pricing Uses True Cost Including Storage

**Files:**
- Modify: `scripts/marketing/build_marketing_cost_map.py`
- Modify: `scripts/marketing/export_dsy_marketing_standards.mjs`
- Modify: `scripts/marketing/dsy_marketing_deadline_fill.mjs`
- Test: marketing standards export in dry-run/review mode.

- [ ] **Step 1: Extend marketing cost map format**

Update `scripts/marketing/build_marketing_cost_map.py` output to include:

```json
{
  "costMap": {
    "SK-03038": 123.45
  },
  "trueCostMap": {
    "SK-03038": {
      "unitCostSar": 123.45,
      "storageUnitCostSar30d": 2.34,
      "trueUnitCostSar": 125.79,
      "storageMethod": "download_detail"
    }
  }
}
```

The script may still read Excel first. Add optional enrichment from `outputs/bi-portal/data.json`:

```python
bi_path = ROOT / "outputs" / "bi-portal" / "data.json"
```

For each product in BI data, prefer the explicit product storage fields generated by Task 4. If `profit.products[*].storage_fee_sar` is present, calculate:

```python
storage_unit = storage_fee_sar / max(quantity, 1)
true_unit = unit_cost_sar + storage_unit
```

If a product has no sales quantity in `profit.products` but exists in `profit.productStorageDaily`, record the storage method and mark `storageUnitCostSar30d` as unavailable instead of silently using zero. Use the current BI generated snapshot/range metadata and record it in JSON so standards/fill output can say whether storage cost is estimated or missing.

- [ ] **Step 2: Update standards export**

In `scripts/marketing/export_dsy_marketing_standards.mjs`, change cost lookup:

```js
const trueCostInfo = lookupTrueCost(keysRaw);
const baseCost = lookupCost(keysRaw) ?? (Number.isFinite(Number(depletion?.unit_cost_sar)) ? Number(depletion.unit_cost_sar) : null);
const cost = trueCostInfo?.trueUnitCostSar ?? baseCost;
const storageUnitCostSar = trueCostInfo?.storageUnitCostSar30d ?? null;
```

Add columns:
- `商品成本SAR`
- `仓储成本SAR/件`
- `含仓储成本SAR`
- `仓储口径`

Use `cost` for margin-based suggested price.

- [ ] **Step 3: Update fill script**

In `scripts/marketing/dsy_marketing_deadline_fill.mjs`, load `trueCostMap` if present:

```js
const COST_DOC = JSON.parse(await fs.readFile(path.join(ROOT, 'tmp', 'mbrs', 'marketing-cost-map.json'), 'utf8'));
const COSTS = COST_DOC.costMap || {};
const TRUE_COSTS = COST_DOC.trueCostMap || {};
```

When calculating margin price, prefer `TRUE_COSTS[key].trueUnitCostSar`, falling back to `COSTS[key]`.

- [ ] **Step 4: Verify marketing export**

Run:

```powershell
python scripts/marketing/build_marketing_cost_map.py
node scripts/marketing/export_dsy_marketing_standards.mjs --stores DL,DX,FY,LQ,NM,HL,JY,ZL,TS,MZ --all-open
```

Expected:
- Output review workbook/JSON contains `含仓储成本SAR`.
- Existing fixed-price overrides still outrank margin-based computed prices.
- Missing storage cost is shown as blank or `估算缺失`, not silently treated as zero.

---

## Task 6: Documentation and Durable Rules

**Files:**
- Modify: `README.md`
- Modify: `docs/bi-system-operations.md`
- Modify: `docs/et-forwarder-bi-integration-plan.md`
- Modify: `docs/bi-warehouse-model.md`
- Modify: `skills/shein-sales-ops/SKILL.md`
- Modify: `MEMORY.md`

- [ ] **Step 1: Replace old “不拆货号” rule**

In `docs/bi-system-operations.md`, replace the old rule:

```md
仓储费不能拆到单独货号，因此单货号、单 SKC 和单店页面展示“未扣仓储费”的商品经营利润。
```

With:

```md
仓储费已纳入真实利润。店铺和 DSY/LGM 按净销售额分摊；货号层优先使用 ET 仓储费导出明细，只有缺明细日期才使用 ET 体积 × 库存天数估算并校准到每日实际仓储费总额，页面必须标注兜底口径。
```

- [ ] **Step 2: Document amount formula**

Add:

```md
ET 仓储费金额口径：物流仓服账单中 `仓储费` 显示金额按 RMB 读取；实际收取按 `显示金额 × 0.5`；BI 利润按固定汇率 `1 SAR = 1.8 RMB` 折算。09 仓费率配置为 `8 RMB / m³ / day × 0.75`，用于货号分摊权重，最终以 ET 每日总账校准。
```

- [ ] **Step 3: Update skill and memory**

Add to `skills/shein-sales-ops/SKILL.md` and `MEMORY.md`:

```md
仓储费利润口径：ET 物流仓服账单 `仓储费` 是正式来源；实际扣费按显示金额减半后折 SAR。DSY/LGM/店铺按净销售额分摊，货号层优先 ET 导出明细，未取得稳定明细时按 ET 体积库存天数估算并在 BI/营销中标注估算。
```

- [ ] **Step 4: Run markdown/diff sanity checks**

Run:

```powershell
git diff --check
git diff --name-only
```

Expected: no whitespace errors; no sensitive paths in diff.

---

## Task 7: Cloud Verification and Deployment Gate

**Files:**
- Read: all modified files.
- No secrets committed.

- [ ] **Step 1: Run syntax checks**

Run:

```powershell
node --check scripts/generate_bi_portal.mjs
node --check scripts/marketing/export_dsy_marketing_standards.mjs
node --check scripts/marketing/dsy_marketing_deadline_fill.mjs
node --check scripts/check_storage_fee_profit.mjs
python -m py_compile scripts/marketing/build_marketing_cost_map.py
```

Expected: all pass.

- [ ] **Step 2: Run local generation checks**

Run:

```powershell
$env:SHEIN_BI_PORTAL_TIMEOUT_MS='900000'
node scripts/generate_bi_portal.mjs
node scripts/check_storage_fee_profit.mjs --mode cloud --host shein-bi-tencent --start 2026-05-01 --end 2026-06-01
```

Expected:
- BI generation succeeds.
- Storage total and allocation checks succeed.
- May 2026 actual storage fee remains about `4405.41 SAR` until ET data changes.

- [ ] **Step 3: Run cloud refresh after deployment**

After commit/push/deploy approval:

```powershell
ssh shein-bi-tencent "cd /opt/shein-bi/app && sudo git -C /opt/shein-bi/app pull --ff-only && sudo docker exec -i shein-warehouse-db psql -U shein -d shein_bi -v ON_ERROR_STOP=1 < infra/warehouse/schema.sql && bash scripts/cloud_bi_refresh.sh today intraday"
```

Expected:
- Schema applies.
- `cloud_bi_refresh.sh today intraday` succeeds.
- `outputs/bi-portal/data.json` on cloud contains `storage_fee_sar` and `profit_after_storage_sar`.

- [ ] **Step 4: Sensitive path check**

Run:

```powershell
git diff --name-only | Select-String -Pattern 'profiles|state|\\.local\\.json|cookie|token|password|dump|\\.codex/plans'
```

Expected: no output except intentional `.codex/plans` local execution record, which must not be staged.

---

## Self-Review Checklist

- Spec coverage:
  - ET displayed amount, actual half charge, RMB/SAR conversion: Task 2.
  - DSY/LGM/store net revenue allocation: Task 2 and Task 3.
  - Product storage fee dimension with detail-first/estimate fallback: Task 2 and Task 3; export-detail integration remains compatible via `storage_fee_method`.
  - BI and marketing decision impact: Task 4 and Task 5.
  - Docs/skill/memory sync: Task 6.
  - Cloud verification: Task 7.
- Placeholder scan:
  - No `TBD`, `TODO`, or open-ended implementation placeholders are used.
  - The only remaining decision is explicit user approval of option A before changing code.
- Type consistency:
  - Storage amount fields use `_sar` for BI/profit and `_rmb` for ET native amount.
  - Method fields use `storage_fee_method` / `storage_allocation_method`.
  - Existing before-storage fields remain unchanged for backwards diagnostics.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-30-storage-fee-profit-integration.md`.

Recommended execution after user approval: inline execution in the current session with review checkpoints, because this feature touches core SQL views and the BI generator in the same repository and must avoid mixing with the existing uncommitted 飞书日报 fix.
