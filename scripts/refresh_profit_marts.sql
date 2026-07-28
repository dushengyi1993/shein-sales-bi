\pset pager off
\timing on

SET jit = off;
SET statement_timeout = '600s';
SET lock_timeout = '30s';

BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT pg_advisory_xact_lock(hashtextextended('shein-profit-mart-refresh', 0));

CREATE TABLE IF NOT EXISTS mart.profit_mart_cache_meta (
  cache_key text PRIMARY KEY,
  status text NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  source_max_order_date date,
  source_max_storage_fee_date date,
  row_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  note text
);

DROP TABLE IF EXISTS mart.profit_order_item_cache_new;
CREATE UNLOGGED TABLE mart.profit_order_item_cache_new AS
SELECT * FROM mart.profit_order_item;
CREATE UNIQUE INDEX ON mart.profit_order_item_cache_new(order_item_key);
CREATE INDEX ON mart.profit_order_item_cache_new(created_date,store_key);
CREATE INDEX ON mart.profit_order_item_cache_new(created_date,standard_goods_sn);
ANALYZE mart.profit_order_item_cache_new;

DROP TABLE IF EXISTS tmp_profit_mart_refresh_mode;
CREATE TEMP TABLE tmp_profit_mart_refresh_mode AS
WITH fee_bill AS (
  SELECT
    f.fee_date AS date,
    f.income_bill_id AS canonical_income_bill_id,
    f.shown_fee_rmb,
    ds.detail_source_income_bill_id
  FROM mart.et_storage_fee_daily f
  LEFT JOIN mart.et_storage_fee_canonical_detail_source ds
    ON ds.fee_date = f.fee_date
   AND ds.canonical_income_bill_id = f.income_bill_id
),
detail_bill AS (
  SELECT
    f.date,
    f.canonical_income_bill_id,
    count(d.unique_key) AS detail_rows,
    sum(coalesce(d.shown_fee_rmb,0)) AS detail_shown_fee_rmb
  FROM fee_bill f
  LEFT JOIN fact.et_storage_fee_product_detail d
    ON d.fee_date = f.date
   AND d.income_bill_id = f.detail_source_income_bill_id
  GROUP BY f.date, f.canonical_income_bill_id
)
SELECT count(DISTINCT date) FILTER (
  WHERE coalesce(d.detail_rows,0)=0 OR coalesce(d.detail_shown_fee_rmb,0)=0
)::bigint AS missing_fee_days,
count(DISTINCT date)::bigint AS fee_days
FROM detail_bill d;

DROP TABLE IF EXISTS tmp_product_display_by_match_key;
CREATE TEMP TABLE tmp_product_display_by_match_key AS
WITH sales_candidate AS (
  SELECT
    dim.product_match_key(standard_goods_sn) AS match_key,
    standard_goods_sn AS display_standard_goods_sn,
    'profit_order_item'::text AS display_source,
    0 AS source_priority,
    max(created_date)::date AS last_seen_date,
    count(*)::bigint AS row_count,
    sum(abs(coalesce(net_revenue_sar, gross_revenue_sar, 0)))::numeric AS amount_weight
  FROM mart.profit_order_item_cache_new
  WHERE coalesce(standard_goods_sn,'') <> ''
  GROUP BY dim.product_match_key(standard_goods_sn), standard_goods_sn
),
product_candidate AS (
  SELECT
    dim.product_match_key(standard_goods_sn) AS match_key,
    standard_goods_sn AS display_standard_goods_sn,
    'dim_product'::text AS display_source,
    1 AS source_priority,
    max(last_seen_date)::date AS last_seen_date,
    0::bigint AS row_count,
    0::numeric AS amount_weight
  FROM dim.product
  WHERE coalesce(standard_goods_sn,'') <> ''
  GROUP BY dim.product_match_key(standard_goods_sn), standard_goods_sn
),
candidates AS (
  SELECT * FROM sales_candidate
  UNION ALL
  SELECT * FROM product_candidate
)
SELECT DISTINCT ON (match_key)
  match_key,
  display_standard_goods_sn,
  display_source,
  last_seen_date
FROM candidates
WHERE coalesce(match_key,'') <> ''
  AND coalesce(display_standard_goods_sn,'') <> ''
ORDER BY
  match_key,
  source_priority,
  last_seen_date DESC NULLS LAST,
  row_count DESC,
  amount_weight DESC NULLS LAST,
  display_standard_goods_sn;
CREATE UNIQUE INDEX ON tmp_product_display_by_match_key(match_key);
ANALYZE tmp_product_display_by_match_key;
DROP TABLE IF EXISTS mart.storage_fee_product_daily_cache_new;
CREATE UNLOGGED TABLE mart.storage_fee_product_daily_cache_new AS
WITH policy AS (
  SELECT * FROM dim.storage_fee_policy WHERE policy_key = 'et_default'
),
fee_daily AS (
  SELECT fee_date AS date, sum(shown_fee_rmb) AS shown_fee_rmb, sum(actual_fee_sar) AS actual_fee_sar
  FROM mart.et_storage_fee_daily
  GROUP BY fee_date
),
fee_bill AS (
  SELECT
    f.fee_date AS date,
    f.income_bill_id AS canonical_income_bill_id,
    f.shown_fee_rmb AS fee_shown_fee_rmb,
    f.actual_fee_sar AS fee_actual_fee_sar,
    ds.detail_source_income_bill_id,
    ds.detail_source_reason
  FROM mart.et_storage_fee_daily f
  LEFT JOIN mart.et_storage_fee_canonical_detail_source ds
    ON ds.fee_date = f.fee_date
   AND ds.canonical_income_bill_id = f.income_bill_id
),
detail_bill AS (
  SELECT
    f.date,
    f.canonical_income_bill_id,
    f.detail_source_income_bill_id,
    f.detail_source_reason,
    count(d.unique_key) AS detail_rows,
    sum(coalesce(d.shown_fee_rmb,0)) AS detail_shown_fee_rmb,
    f.fee_shown_fee_rmb,
    f.fee_actual_fee_sar,
    abs(sum(coalesce(d.shown_fee_rmb,0)) - f.fee_shown_fee_rmb) <= 0.05 AS detail_complete,
    f.fee_shown_fee_rmb / nullif(sum(coalesce(d.shown_fee_rmb,0)),0) AS detail_bill_scale
  FROM fee_bill f
  LEFT JOIN fact.et_storage_fee_product_detail d
    ON d.fee_date = f.date
   AND d.income_bill_id = f.detail_source_income_bill_id
  GROUP BY
    f.date,
    f.canonical_income_bill_id,
    f.detail_source_income_bill_id,
    f.detail_source_reason,
    f.fee_shown_fee_rmb,
    f.fee_actual_fee_sar
),
box_items AS (
  SELECT
    box_id,
    coalesce(nullif(standard_goods_sn,''), match_key) AS standard_goods_sn,
    coalesce(dim.product_match_key(standard_goods_sn), nullif(match_key,'')) AS match_key,
    sum(coalesce(real_quantity, case_quantity, 0)) AS item_quantity
  FROM fact.et_box_item
  WHERE coalesce(box_id,'') <> ''
    AND coalesce(standard_goods_sn, match_key, '') <> ''
  GROUP BY box_id, coalesce(nullif(standard_goods_sn,''), match_key), coalesce(dim.product_match_key(standard_goods_sn), nullif(match_key,''))
),
box_totals AS (
  SELECT
    box_id,
    sum(coalesce(item_quantity,0)) AS total_item_quantity,
    count(*) AS item_count
  FROM box_items
  GROUP BY box_id
),
detail_expanded AS (
  SELECT
    d.fee_date AS date,
    NULL::date AS source_snapshot_date,
    NULL::text AS stock_snapshot_method,
    CASE
      WHEN bi.box_id IS NOT NULL THEN bi.standard_goods_sn
      ELSE coalesce(nullif(d.standard_goods_sn,''), nullif(d.match_key,''), d.storage_code)
    END AS standard_goods_sn,
    CASE
      WHEN bi.box_id IS NOT NULL THEN bi.match_key
      ELSE coalesce(dim.product_match_key(d.standard_goods_sn), dim.product_match_key(d.storage_code), nullif(d.match_key,''))
    END AS match_key,
    d.warehouse_name,
    CASE WHEN db.detail_complete THEN 'download_detail' ELSE 'download_detail_scaled_to_bill' END AS storage_allocation_method,
    CASE WHEN bi.box_id IS NOT NULL THEN bi.item_quantity ELSE d.quantity END AS quantity,
    CASE WHEN bi.box_id IS NOT NULL THEN NULL::numeric ELSE d.volume_m3_per_unit END AS volume_m3_per_unit,
    CASE
      WHEN bi.box_id IS NOT NULL AND coalesce(bt.total_item_quantity,0) > 0 THEN d.volume_m3_total * bi.item_quantity / nullif(bt.total_item_quantity,0)
      WHEN bi.box_id IS NOT NULL AND coalesce(bt.item_count,0) > 0 THEN d.volume_m3_total / nullif(bt.item_count,0)
      ELSE d.volume_m3_total
    END AS volume_m3_total,
    d.rate_rmb_per_m3_day,
    CASE
      WHEN bi.box_id IS NOT NULL AND coalesce(bt.total_item_quantity,0) > 0 THEN d.shown_fee_rmb * coalesce(db.detail_bill_scale,1) * bi.item_quantity / nullif(bt.total_item_quantity,0)
      WHEN bi.box_id IS NOT NULL AND coalesce(bt.item_count,0) > 0 THEN d.shown_fee_rmb * coalesce(db.detail_bill_scale,1) / nullif(bt.item_count,0)
      ELSE d.shown_fee_rmb * coalesce(db.detail_bill_scale,1)
    END AS shown_fee_rmb
  FROM fact.et_storage_fee_product_detail d
  JOIN detail_bill db
    ON db.date = d.fee_date
   AND db.detail_source_income_bill_id = d.income_bill_id
   AND coalesce(db.detail_rows,0) > 0
   AND coalesce(db.detail_shown_fee_rmb,0) <> 0
  LEFT JOIN box_items bi
    ON d.storage_type ILIKE '%整箱%'
   AND bi.box_id = d.storage_code
  LEFT JOIN box_totals bt
    ON bt.box_id = d.storage_code
  WHERE coalesce(d.storage_code,'') <> ''
),
detail_rows AS (
  SELECT
    e.date,
    e.source_snapshot_date,
    e.stock_snapshot_method,
    coalesce(pd.display_standard_goods_sn, e.standard_goods_sn, e.match_key) AS standard_goods_sn,
    e.match_key,
    e.warehouse_name,
    sum(e.quantity) AS quantity,
    max(e.volume_m3_per_unit) AS volume_m3_per_unit,
    sum(e.volume_m3_total) AS volume_m3_total,
    sum(e.volume_m3_total) AS stock_m3_days,
    max(e.rate_rmb_per_m3_day) AS rate_rmb_per_m3_day,
    NULL::numeric AS warehouse_discount,
    sum(e.shown_fee_rmb) AS shown_fee_rmb,
    sum(e.shown_fee_rmb) * max(p.billing_discount) AS actual_fee_rmb,
    sum(e.shown_fee_rmb) * max(p.billing_discount) / nullif(max(p.sar_to_rmb),0) AS actual_allocated_fee_sar,
    e.storage_allocation_method::text AS storage_allocation_method
  FROM detail_expanded e
  CROSS JOIN policy p
  LEFT JOIN tmp_product_display_by_match_key pd
    ON pd.match_key = e.match_key
  WHERE coalesce(e.standard_goods_sn, e.match_key, '') <> ''
  GROUP BY e.date, e.source_snapshot_date, e.stock_snapshot_method, coalesce(pd.display_standard_goods_sn, e.standard_goods_sn, e.match_key), e.match_key, e.warehouse_name, e.storage_allocation_method
),
fallback_bill_daily AS (
  SELECT
    date,
    sum(fee_actual_fee_sar) AS fallback_actual_fee_sar
  FROM detail_bill
  WHERE coalesce(detail_rows,0) = 0
     OR coalesce(detail_shown_fee_rmb,0) = 0
  GROUP BY date
),
estimated_day AS (
  SELECT date, sum(coalesce(actual_allocated_fee_sar,0)) AS estimated_allocated_fee_sar
  FROM mart.storage_fee_product_daily_estimated
  GROUP BY date
),
fallback_rows AS (
  SELECT
    e.date,
    e.source_snapshot_date,
    e.stock_snapshot_method,
    coalesce(pd.display_standard_goods_sn, e.standard_goods_sn, e.match_key) AS standard_goods_sn,
    e.match_key,
    e.warehouse_name,
    e.quantity,
    e.volume_m3_per_unit,
    e.volume_m3_total,
    e.stock_m3_days,
    e.rate_rmb_per_m3_day,
    e.warehouse_discount,
    NULL::numeric AS shown_fee_rmb,
    NULL::numeric AS actual_fee_rmb,
    f.fallback_actual_fee_sar
      * e.actual_allocated_fee_sar / nullif(ed.estimated_allocated_fee_sar,0) AS actual_allocated_fee_sar,
    ('bill_missing_detail:' || e.storage_allocation_method)::text AS storage_allocation_method
  FROM mart.storage_fee_product_daily_estimated e
  JOIN fallback_bill_daily f
    ON f.date = e.date
  JOIN estimated_day ed
    ON ed.date = e.date
  LEFT JOIN tmp_product_display_by_match_key pd
    ON pd.match_key = e.match_key
  WHERE coalesce(ed.estimated_allocated_fee_sar,0) <> 0
),
combined_rows AS (
  SELECT * FROM detail_rows
  UNION ALL
  SELECT * FROM fallback_rows
),
allocated_day AS (
  SELECT date, sum(coalesce(actual_allocated_fee_sar,0)) AS allocated_fee_sar
  FROM combined_rows
  GROUP BY date
),
residual_rows AS (
  SELECT
    f.date,
    NULL::date AS source_snapshot_date,
    'missing_historical_product_evidence'::text AS stock_snapshot_method,
    'CENTRAL_POOL'::text AS standard_goods_sn,
    'CENTRAL_POOL'::text AS match_key,
    'CENTRAL_POOL'::text AS warehouse_name,
    NULL::numeric AS quantity,
    NULL::numeric AS volume_m3_per_unit,
    NULL::numeric AS volume_m3_total,
    NULL::numeric AS stock_m3_days,
    NULL::numeric AS rate_rmb_per_m3_day,
    NULL::numeric AS warehouse_discount,
    NULL::numeric AS shown_fee_rmb,
    NULL::numeric AS actual_fee_rmb,
    f.actual_fee_sar - coalesce(a.allocated_fee_sar,0) AS actual_allocated_fee_sar,
    'central_pool_unallocated'::text AS storage_allocation_method
  FROM fee_daily f
  LEFT JOIN allocated_day a USING (date)
  WHERE abs(f.actual_fee_sar - coalesce(a.allocated_fee_sar,0)) > 0.005
)
SELECT * FROM combined_rows
UNION ALL
SELECT * FROM residual_rows;
ANALYZE mart.storage_fee_product_daily_cache_new;
DO $$
DECLARE v_max_delta numeric;
BEGIN
  SELECT coalesce(max(abs(coalesce(f.actual_fee_sar,0)-coalesce(c.allocated_fee_sar,0))),0)
  INTO v_max_delta
  FROM (
    SELECT fee_date AS date,sum(actual_fee_sar) AS actual_fee_sar
    FROM mart.et_storage_fee_daily GROUP BY fee_date
  ) f
  LEFT JOIN (
    SELECT date,sum(actual_allocated_fee_sar) AS allocated_fee_sar
    FROM mart.storage_fee_product_daily_cache_new GROUP BY date
  ) c USING(date);
  IF v_max_delta > 0.01 THEN
    RAISE EXCEPTION 'storage_fee_product_daily_cache_new is not conserving: max delta % SAR',v_max_delta;
  END IF;
END $$;
DROP TABLE IF EXISTS mart.storage_fee_product_store_daily_cache_new;
CREATE UNLOGGED TABLE mart.storage_fee_product_store_daily_cache_new AS
WITH product_fee AS (
  SELECT
    date,
    coalesce(nullif(match_key,''), dim.product_match_key(standard_goods_sn)) AS match_key,
    max(standard_goods_sn) AS standard_goods_sn,
    sum(actual_allocated_fee_sar) AS product_storage_fee_sar,
    string_agg(DISTINCT storage_allocation_method, ' / ') AS storage_fee_method
  FROM mart.storage_fee_product_daily_cache_new
  WHERE coalesce(nullif(match_key,''), dim.product_match_key(standard_goods_sn)) <> ''
  GROUP BY date, coalesce(nullif(match_key,''), dim.product_match_key(standard_goods_sn))
),
daily_sales AS (
  SELECT
    created_date::date AS date,
    store_key,
    group_key,
    dim.product_match_key(standard_goods_sn) AS match_key,
    sum(greatest(coalesce(quantity,0),0)) AS sold_quantity
  FROM mart.profit_order_item_cache_new
  WHERE coalesce(standard_goods_sn,'') <> ''
    AND coalesce(gross_revenue_sar,0) > 0
    AND coalesce(quantity,0) > 0
  GROUP BY created_date::date, store_key, group_key, dim.product_match_key(standard_goods_sn)
),
mtd_weight AS (
  SELECT
    f.date,
    f.match_key,
    s.store_key,
    max(s.group_key) AS group_key,
    sum(s.sold_quantity) AS allocation_weight
  FROM product_fee f
  JOIN daily_sales s
    ON s.match_key = f.match_key
   AND s.date BETWEEN date_trunc('month', f.date)::date AND f.date
  GROUP BY f.date, f.match_key, s.store_key
),
mtd_total AS (
  SELECT date, match_key, sum(allocation_weight) AS allocation_total
  FROM mtd_weight
  GROUP BY date, match_key
),
rolling_weight AS (
  SELECT
    f.date,
    f.match_key,
    s.store_key,
    max(s.group_key) AS group_key,
    sum(s.sold_quantity) AS allocation_weight
  FROM product_fee f
  JOIN daily_sales s
    ON s.match_key = f.match_key
   AND s.date BETWEEN f.date - 89 AND f.date
  GROUP BY f.date, f.match_key, s.store_key
),
rolling_total AS (
  SELECT date, match_key, sum(allocation_weight) AS allocation_total
  FROM rolling_weight
  GROUP BY date, match_key
),
latest_active_link_snapshot AS (
  SELECT
    f.date,
    f.match_key,
    max(l.snapshot_date) AS link_snapshot_date
  FROM product_fee f
  JOIN fact.link_master_snapshot l
    ON dim.product_match_key(l.standard_goods_sn) = f.match_key
   AND l.snapshot_date <= f.date
   AND (coalesce(l.is_on_shelf,false) OR coalesce(l.is_wait_shelf,false))
   AND NOT coalesce(l.is_out_shelf,false)
   AND NOT coalesce(l.is_hard_dead,false)
  GROUP BY f.date, f.match_key
),
link_weight AS (
  SELECT
    x.date,
    x.match_key,
    l.store_key,
    max(l.group_key) AS group_key,
    count(DISTINCT coalesce(nullif(l.skc,''), l.unique_key))::numeric AS allocation_weight,
    x.link_snapshot_date
  FROM latest_active_link_snapshot x
  JOIN fact.link_master_snapshot l
    ON l.snapshot_date = x.link_snapshot_date
   AND dim.product_match_key(l.standard_goods_sn) = x.match_key
   AND (coalesce(l.is_on_shelf,false) OR coalesce(l.is_wait_shelf,false))
   AND NOT coalesce(l.is_out_shelf,false)
   AND NOT coalesce(l.is_hard_dead,false)
  GROUP BY x.date, x.match_key, l.store_key, x.link_snapshot_date
),
link_total AS (
  SELECT date, match_key, sum(allocation_weight) AS allocation_total
  FROM link_weight
  GROUP BY date, match_key
),
decision AS (
  SELECT
    f.*,
    CASE
      WHEN coalesce(mt.allocation_total,0) > 0 THEN 'month_to_date_sales'
      WHEN coalesce(rt.allocation_total,0) > 0 THEN 'rolling_90d_sales'
      WHEN coalesce(lt.allocation_total,0) > 0 THEN 'active_link'
      ELSE 'central_pool'
    END AS allocation_stage,
    coalesce(mt.allocation_total, rt.allocation_total, lt.allocation_total, 1) AS allocation_total
  FROM product_fee f
  LEFT JOIN mtd_total mt USING (date, match_key)
  LEFT JOIN rolling_total rt USING (date, match_key)
  LEFT JOIN link_total lt USING (date, match_key)
),
chosen_weight AS (
  SELECT d.date, d.match_key, w.store_key, w.group_key, w.allocation_weight, NULL::date AS link_snapshot_date
  FROM decision d
  JOIN mtd_weight w USING (date, match_key)
  WHERE d.allocation_stage = 'month_to_date_sales'

  UNION ALL

  SELECT d.date, d.match_key, w.store_key, w.group_key, w.allocation_weight, NULL::date
  FROM decision d
  JOIN rolling_weight w USING (date, match_key)
  WHERE d.allocation_stage = 'rolling_90d_sales'

  UNION ALL

  SELECT d.date, d.match_key, w.store_key, w.group_key, w.allocation_weight, w.link_snapshot_date
  FROM decision d
  JOIN link_weight w USING (date, match_key)
  WHERE d.allocation_stage = 'active_link'

  UNION ALL

  SELECT d.date, d.match_key, 'CENTRAL_POOL'::text, 'CENTRAL_POOL'::text, 1::numeric, NULL::date
  FROM decision d
  WHERE d.allocation_stage = 'central_pool'
)
SELECT
  d.date,
  w.store_key,
  w.group_key,
  d.standard_goods_sn,
  d.product_storage_fee_sar * w.allocation_weight / nullif(d.allocation_total,0) AS storage_fee_sar,
  d.storage_fee_method || ':' || d.allocation_stage AS storage_fee_method,
  d.match_key,
  d.allocation_stage,
  d.date AS as_of_date,
  CASE
    WHEN d.allocation_stage = 'month_to_date_sales' THEN date_trunc('month', d.date)::date
    WHEN d.allocation_stage = 'rolling_90d_sales' THEN d.date - 89
    ELSE NULL
  END AS sales_window_start,
  CASE WHEN d.allocation_stage IN ('month_to_date_sales','rolling_90d_sales') THEN d.date ELSE NULL END AS sales_window_end,
  w.link_snapshot_date,
  d.product_storage_fee_sar AS source_fee_amount_sar,
  w.allocation_weight / nullif(d.allocation_total,0) AS allocation_ratio
FROM decision d
JOIN chosen_weight w USING (date, match_key);
ANALYZE mart.storage_fee_product_store_daily_cache_new;
DROP TABLE IF EXISTS mart.storage_fee_store_daily_cache_new;
CREATE UNLOGGED TABLE mart.storage_fee_store_daily_cache_new AS
WITH store_day AS (
  SELECT
    created_date::date AS date,
    store_key,
    max(group_key) AS group_key,
    sum(net_revenue_sar) AS net_revenue_sar
  FROM mart.profit_order_item_cache_new
  GROUP BY created_date::date, store_key
),
allocated AS (
  SELECT
    date,
    store_key,
    max(group_key) AS group_key,
    sum(storage_fee_sar) AS allocated_storage_fee_sar,
    string_agg(DISTINCT allocation_stage, ' / ') AS allocation_method
  FROM mart.storage_fee_product_store_daily_cache_new
  GROUP BY date, store_key
),
day_total AS (
  SELECT date, sum(allocated_storage_fee_sar) AS allocated_storage_fee_sar
  FROM allocated
  GROUP BY date
)
SELECT
  a.date,
  a.store_key,
  a.group_key,
  coalesce(s.net_revenue_sar,0) AS net_revenue_sar,
  a.allocated_storage_fee_sar / nullif(t.allocated_storage_fee_sar,0) AS revenue_share,
  a.allocated_storage_fee_sar,
  a.allocation_method
FROM allocated a
JOIN day_total t USING (date)
LEFT JOIN store_day s
  ON s.date = a.date
 AND s.store_key = a.store_key;
CREATE UNIQUE INDEX ON mart.storage_fee_store_daily_cache_new(date,store_key);
ANALYZE mart.storage_fee_store_daily_cache_new;
DROP TABLE IF EXISTS mart.profit_daily_store_product_cache_new;
CREATE UNLOGGED TABLE mart.profit_daily_store_product_cache_new AS
WITH base AS (
  SELECT
    created_date AS date,
    store_key,
    group_key,
    standard_goods_sn,
    count(*) FILTER (
      WHERE coalesce(gross_revenue_sar,0) > 0 AND coalesce(quantity,0) > 0
    ) AS order_lines,
    count(DISTINCT order_key) FILTER (
      WHERE coalesce(gross_revenue_sar,0) > 0 AND coalesce(quantity,0) > 0
    ) AS orders,
    sum(quantity) AS quantity,
    sum(gross_revenue_sar) AS gross_revenue_sar,
    sum(net_revenue_sar) AS net_revenue_sar,
    sum(product_cost_sar) FILTER (WHERE NOT cost_missing) AS product_cost_sar,
    sum(return_delivery_fee_sar) AS return_delivery_fee_sar,
    sum(rtv_recoverable_cost_sar) FILTER (WHERE NOT cost_missing) AS rtv_recoverable_cost_sar,
    sum(rtv_09_recoverable_cost_sar) FILTER (WHERE NOT cost_missing) AS rtv_09_recoverable_cost_sar,
    sum(rtv_received_quantity) AS rtv_received_quantity,
    sum(rtv_received_to_09_quantity) AS rtv_received_to_09_quantity,
    sum(profit_before_storage_sar) FILTER (WHERE NOT cost_missing) AS profit_before_storage_sar,
    sum(profit_if_rtv_received_resellable_sar) FILTER (WHERE NOT cost_missing) AS profit_if_rtv_received_resellable_sar,
    sum(profit_if_rtv_09_resellable_sar) FILTER (WHERE NOT cost_missing) AS profit_if_rtv_09_resellable_sar,
    sum(net_revenue_sar) FILTER (WHERE NOT cost_missing) AS known_net_revenue_sar,
    sum(gross_revenue_sar) FILTER (WHERE NOT cost_missing) AS known_gross_revenue_sar,
    sum(gross_revenue_sar) FILTER (WHERE cost_missing) AS missing_cost_revenue_sar,
    sum(quantity) FILTER (WHERE cost_missing) AS missing_cost_quantity,
    count(*) FILTER (WHERE cost_missing) AS missing_cost_lines,
    sum(
      net_revenue_sar
        * least(coalesce(cost_estimated_quantity,0),quantity)
        / nullif(quantity,0)
    ) FILTER (WHERE cost_valuation_status LIKE 'estimated_%') AS estimated_cost_revenue_sar,
    sum(cost_estimated_quantity) FILTER (WHERE cost_valuation_status LIKE 'estimated_%') AS estimated_cost_quantity,
    count(*) FILTER (
      WHERE cost_valuation_status LIKE 'estimated_%'
        AND coalesce(cost_estimated_quantity,0) > 0
    ) AS estimated_cost_lines,
    sum(net_revenue_sar) FILTER (
      WHERE cost_valuation_status = 'legacy_pre_cutover_estimate'
    ) AS legacy_estimated_cost_revenue_sar,
    sum(cost_estimated_quantity) FILTER (
      WHERE cost_valuation_status = 'legacy_pre_cutover_estimate'
    ) AS legacy_estimated_cost_quantity,
    count(*) FILTER (
      WHERE cost_valuation_status = 'legacy_pre_cutover_estimate'
        AND coalesce(cost_estimated_quantity,0) > 0
    ) AS legacy_estimated_cost_lines,
    count(*) FILTER (WHERE revenue_reversal) AS reversal_lines,
    sum(return_delivery_fee_sar) FILTER (WHERE revenue_reversal) AS reversal_fee_sar,
    CASE
      WHEN sum(net_revenue_sar) FILTER (WHERE NOT cost_missing) > 0
      THEN sum(profit_before_storage_sar) FILTER (WHERE NOT cost_missing)
        / nullif(sum(net_revenue_sar) FILTER (WHERE NOT cost_missing), 0)
      ELSE NULL
    END AS profit_margin_before_storage,
    CASE
      WHEN sum(gross_revenue_sar) > 0
      THEN sum(gross_revenue_sar) FILTER (WHERE NOT cost_missing) / nullif(sum(gross_revenue_sar), 0)
      ELSE NULL
    END AS cost_coverage_revenue_rate,
    sum(risk_adjusted_net_revenue_sar) AS risk_adjusted_net_revenue_sar,
    sum(risk_adjusted_net_revenue_sar) FILTER (WHERE NOT cost_missing) AS known_risk_adjusted_net_revenue_sar,
    sum(pending_revenue_risk_sar) AS pending_revenue_risk_sar,
    sum(risk_adjusted_profit_before_storage_sar) FILTER (WHERE NOT cost_missing) AS risk_adjusted_profit_before_storage_sar,
    count(*) FILTER (WHERE pending_revenue_risk) AS pending_revenue_risk_lines,
    sum(pending_impact_quantity) AS pending_impact_quantity,
    sum(pending_impact_amount_sar) AS pending_impact_amount_sar,
    sum(actual_return_cost_sar) AS actual_return_cost_sar,
    sum(estimated_return_delivery_fee_sar) AS estimated_return_delivery_fee_sar
  FROM mart.profit_order_item_cache_new
  GROUP BY created_date, store_key, group_key, standard_goods_sn
),
storage AS (
  SELECT
    date,
    store_key,
    group_key,
    match_key,
    max(standard_goods_sn) AS standard_goods_sn,
    sum(storage_fee_sar) AS storage_fee_sar,
    string_agg(DISTINCT storage_fee_method, ' / ') AS storage_fee_method,
    string_agg(DISTINCT allocation_stage, ' / ') AS storage_allocation_stage
  FROM mart.storage_fee_product_store_daily_cache_new
  GROUP BY date, store_key, group_key, match_key
)
SELECT
  coalesce(b.date,s.date) AS date,
  coalesce(b.store_key,s.store_key) AS store_key,
  coalesce(b.group_key,s.group_key) AS group_key,
  coalesce(b.standard_goods_sn,s.standard_goods_sn,s.match_key) AS standard_goods_sn,
  coalesce(b.order_lines,0)::bigint AS order_lines,
  coalesce(b.orders,0)::bigint AS orders,
  coalesce(b.quantity,0) AS quantity,
  coalesce(b.gross_revenue_sar,0) AS gross_revenue_sar,
  coalesce(b.net_revenue_sar,0) AS net_revenue_sar,
  CASE WHEN b.date IS NULL THEN 0 ELSE b.product_cost_sar END AS product_cost_sar,
  coalesce(b.return_delivery_fee_sar,0) AS return_delivery_fee_sar,
  CASE WHEN b.date IS NULL THEN 0 ELSE b.rtv_recoverable_cost_sar END AS rtv_recoverable_cost_sar,
  CASE WHEN b.date IS NULL THEN 0 ELSE b.rtv_09_recoverable_cost_sar END AS rtv_09_recoverable_cost_sar,
  coalesce(b.rtv_received_quantity,0) AS rtv_received_quantity,
  coalesce(b.rtv_received_to_09_quantity,0) AS rtv_received_to_09_quantity,
  CASE WHEN b.date IS NULL THEN 0 ELSE b.profit_before_storage_sar END AS profit_before_storage_sar,
  CASE WHEN b.date IS NULL THEN 0 ELSE b.profit_if_rtv_received_resellable_sar END AS profit_if_rtv_received_resellable_sar,
  CASE WHEN b.date IS NULL THEN 0 ELSE b.profit_if_rtv_09_resellable_sar END AS profit_if_rtv_09_resellable_sar,
  coalesce(b.known_net_revenue_sar,0) AS known_net_revenue_sar,
  coalesce(b.known_gross_revenue_sar,0) AS known_gross_revenue_sar,
  coalesce(b.missing_cost_revenue_sar,0) AS missing_cost_revenue_sar,
  coalesce(b.missing_cost_quantity,0) AS missing_cost_quantity,
  coalesce(b.missing_cost_lines,0)::bigint AS missing_cost_lines,
  coalesce(b.estimated_cost_revenue_sar,0) AS estimated_cost_revenue_sar,
  coalesce(b.estimated_cost_quantity,0) AS estimated_cost_quantity,
  coalesce(b.estimated_cost_lines,0)::bigint AS estimated_cost_lines,
  coalesce(b.legacy_estimated_cost_revenue_sar,0) AS legacy_estimated_cost_revenue_sar,
  coalesce(b.legacy_estimated_cost_quantity,0) AS legacy_estimated_cost_quantity,
  coalesce(b.legacy_estimated_cost_lines,0)::bigint AS legacy_estimated_cost_lines,
  coalesce(b.reversal_lines,0)::bigint AS reversal_lines,
  coalesce(b.reversal_fee_sar,0) AS reversal_fee_sar,
  b.profit_margin_before_storage,
  b.cost_coverage_revenue_rate,
  coalesce(s.storage_fee_sar,0) AS storage_fee_sar,
  CASE
    WHEN b.date IS NULL THEN -coalesce(s.storage_fee_sar,0)
    WHEN b.profit_before_storage_sar IS NULL THEN NULL
    ELSE b.profit_before_storage_sar - coalesce(s.storage_fee_sar,0)
  END AS profit_after_storage_sar,
  CASE
    WHEN coalesce(b.known_net_revenue_sar,0) > 0
    THEN (coalesce(b.profit_before_storage_sar,0) - coalesce(s.storage_fee_sar,0)) / nullif(b.known_net_revenue_sar,0)
    ELSE NULL
  END AS profit_margin_after_storage,
  CASE
    WHEN b.date IS NULL THEN -coalesce(s.storage_fee_sar,0)
    WHEN b.profit_if_rtv_received_resellable_sar IS NULL THEN NULL
    ELSE b.profit_if_rtv_received_resellable_sar - coalesce(s.storage_fee_sar,0)
  END AS profit_if_rtv_received_resellable_after_storage_sar,
  CASE
    WHEN b.date IS NULL THEN -coalesce(s.storage_fee_sar,0)
    WHEN b.profit_if_rtv_09_resellable_sar IS NULL THEN NULL
    ELSE b.profit_if_rtv_09_resellable_sar - coalesce(s.storage_fee_sar,0)
  END AS profit_if_rtv_09_resellable_after_storage_sar,
  coalesce(s.storage_fee_method,'none') AS storage_fee_method,
  coalesce(b.risk_adjusted_net_revenue_sar,0) AS risk_adjusted_net_revenue_sar,
  coalesce(b.known_risk_adjusted_net_revenue_sar,0) AS known_risk_adjusted_net_revenue_sar,
  coalesce(b.pending_revenue_risk_sar,0) AS pending_revenue_risk_sar,
  CASE WHEN b.date IS NULL THEN 0 ELSE b.risk_adjusted_profit_before_storage_sar END AS risk_adjusted_profit_before_storage_sar,
  CASE
    WHEN b.date IS NULL THEN -coalesce(s.storage_fee_sar,0)
    WHEN b.risk_adjusted_profit_before_storage_sar IS NULL THEN NULL
    ELSE b.risk_adjusted_profit_before_storage_sar - coalesce(s.storage_fee_sar,0)
  END AS risk_adjusted_profit_after_storage_sar,
  CASE
    WHEN coalesce(b.known_risk_adjusted_net_revenue_sar,0) > 0
      AND b.risk_adjusted_profit_before_storage_sar IS NOT NULL
    THEN (b.risk_adjusted_profit_before_storage_sar - coalesce(s.storage_fee_sar,0))
      / nullif(b.known_risk_adjusted_net_revenue_sar,0)
    ELSE NULL
  END AS risk_adjusted_profit_margin_after_storage,
  coalesce(b.pending_revenue_risk_lines,0)::bigint AS pending_revenue_risk_lines,
  coalesce(b.pending_impact_quantity,0) AS pending_impact_quantity,
  coalesce(b.pending_impact_amount_sar,0) AS pending_impact_amount_sar,
  coalesce(b.actual_return_cost_sar,0) AS actual_return_cost_sar,
  coalesce(b.estimated_return_delivery_fee_sar,0) AS estimated_return_delivery_fee_sar,
  coalesce(s.storage_allocation_stage,'none') AS storage_allocation_stage
FROM base b
FULL JOIN storage s
  ON s.date = b.date
 AND s.store_key = b.store_key
 AND s.group_key IS NOT DISTINCT FROM b.group_key
 AND s.match_key = dim.product_match_key(b.standard_goods_sn);
CREATE INDEX ON mart.profit_daily_store_product_cache_new(date,store_key);
CREATE INDEX ON mart.profit_daily_store_product_cache_new(date,standard_goods_sn);
ANALYZE mart.profit_daily_store_product_cache_new;
DROP TABLE IF EXISTS mart.profit_month_group_cache_new;
CREATE UNLOGGED TABLE mart.profit_month_group_cache_new AS
WITH group_month AS (
  SELECT
    month_start,
    group_key,
    sum(gross_revenue_sar) AS gross_revenue_sar,
    sum(net_revenue_sar) AS net_revenue_sar,
    sum(product_cost_sar) FILTER (WHERE NOT cost_missing) AS product_cost_sar,
    sum(return_delivery_fee_sar) AS return_delivery_fee_sar,
    sum(rtv_recoverable_cost_sar) FILTER (WHERE NOT cost_missing) AS rtv_recoverable_cost_sar,
    sum(rtv_09_recoverable_cost_sar) FILTER (WHERE NOT cost_missing) AS rtv_09_recoverable_cost_sar,
    sum(rtv_received_quantity) AS rtv_received_quantity,
    sum(rtv_received_to_09_quantity) AS rtv_received_to_09_quantity,
    sum(profit_before_storage_sar) FILTER (WHERE NOT cost_missing) AS profit_before_storage_sar,
    sum(profit_if_rtv_received_resellable_sar) FILTER (WHERE NOT cost_missing) AS profit_if_rtv_received_resellable_sar,
    sum(profit_if_rtv_09_resellable_sar) FILTER (WHERE NOT cost_missing) AS profit_if_rtv_09_resellable_sar,
    sum(net_revenue_sar) FILTER (WHERE NOT cost_missing) AS known_net_revenue_sar,
    sum(gross_revenue_sar) FILTER (WHERE NOT cost_missing) AS known_gross_revenue_sar,
    sum(gross_revenue_sar) FILTER (WHERE cost_missing) AS missing_cost_revenue_sar,
    count(*) FILTER (WHERE cost_missing) AS missing_cost_lines,
    sum(
      net_revenue_sar
        * least(coalesce(cost_estimated_quantity,0),quantity)
        / nullif(quantity,0)
    ) FILTER (WHERE cost_valuation_status LIKE 'estimated_%') AS estimated_cost_revenue_sar,
    sum(cost_estimated_quantity) FILTER (WHERE cost_valuation_status LIKE 'estimated_%') AS estimated_cost_quantity,
    count(*) FILTER (
      WHERE cost_valuation_status LIKE 'estimated_%'
        AND coalesce(cost_estimated_quantity,0) > 0
    ) AS estimated_cost_lines,
    sum(net_revenue_sar) FILTER (
      WHERE cost_valuation_status = 'legacy_pre_cutover_estimate'
    ) AS legacy_estimated_cost_revenue_sar,
    sum(cost_estimated_quantity) FILTER (
      WHERE cost_valuation_status = 'legacy_pre_cutover_estimate'
    ) AS legacy_estimated_cost_quantity,
    count(*) FILTER (
      WHERE cost_valuation_status = 'legacy_pre_cutover_estimate'
        AND coalesce(cost_estimated_quantity,0) > 0
    ) AS legacy_estimated_cost_lines,
    count(*) FILTER (WHERE revenue_reversal) AS reversal_lines,
    sum(risk_adjusted_net_revenue_sar) AS risk_adjusted_net_revenue_sar,
    sum(risk_adjusted_net_revenue_sar) FILTER (WHERE NOT cost_missing) AS known_risk_adjusted_net_revenue_sar,
    sum(pending_revenue_risk_sar) AS pending_revenue_risk_sar,
    sum(risk_adjusted_profit_before_storage_sar) FILTER (WHERE NOT cost_missing) AS risk_adjusted_profit_before_storage_sar,
    count(*) FILTER (WHERE pending_revenue_risk) AS pending_revenue_risk_lines,
    sum(actual_return_cost_sar) AS actual_return_cost_sar,
    sum(estimated_return_delivery_fee_sar) AS estimated_return_delivery_fee_sar
  FROM mart.profit_order_item_cache_new
  GROUP BY month_start, group_key
),
storage_group_month AS (
  SELECT
    date_trunc('month', date)::date AS month_start,
    group_key,
    sum(allocated_storage_fee_sar) AS allocated_storage_fee_sar,
    string_agg(DISTINCT allocation_method, ' / ') AS storage_fee_method
  FROM mart.storage_fee_store_daily_cache_new
  GROUP BY date_trunc('month', date)::date, group_key
),
storage_month_total AS (
  SELECT
    date_trunc('month', fee_date)::date AS month_start,
    sum(actual_fee_sar) AS total_storage_fee_sar
  FROM mart.et_storage_fee_daily
  GROUP BY date_trunc('month', fee_date)::date
)
SELECT
  coalesce(g.month_start,sgm.month_start) AS month_start,
  coalesce(g.group_key,sgm.group_key) AS group_key,
  coalesce(g.gross_revenue_sar,0) AS gross_revenue_sar,
  coalesce(g.net_revenue_sar,0) AS net_revenue_sar,
  CASE WHEN g.month_start IS NULL THEN 0 ELSE g.product_cost_sar END AS product_cost_sar,
  coalesce(g.return_delivery_fee_sar,0) AS return_delivery_fee_sar,
  CASE WHEN g.month_start IS NULL THEN 0 ELSE g.rtv_recoverable_cost_sar END AS rtv_recoverable_cost_sar,
  CASE WHEN g.month_start IS NULL THEN 0 ELSE g.rtv_09_recoverable_cost_sar END AS rtv_09_recoverable_cost_sar,
  coalesce(g.rtv_received_quantity,0) AS rtv_received_quantity,
  coalesce(g.rtv_received_to_09_quantity,0) AS rtv_received_to_09_quantity,
  CASE WHEN g.month_start IS NULL THEN 0 ELSE g.profit_before_storage_sar END AS profit_before_storage_sar,
  CASE WHEN g.month_start IS NULL THEN 0 ELSE g.profit_if_rtv_received_resellable_sar END AS profit_if_rtv_received_resellable_sar,
  CASE WHEN g.month_start IS NULL THEN 0 ELSE g.profit_if_rtv_09_resellable_sar END AS profit_if_rtv_09_resellable_sar,
  coalesce(g.known_net_revenue_sar,0) AS known_net_revenue_sar,
  coalesce(g.known_gross_revenue_sar,0) AS known_gross_revenue_sar,
  coalesce(g.missing_cost_revenue_sar,0) AS missing_cost_revenue_sar,
  coalesce(g.missing_cost_lines,0)::bigint AS missing_cost_lines,
  coalesce(g.estimated_cost_revenue_sar,0) AS estimated_cost_revenue_sar,
  coalesce(g.estimated_cost_quantity,0) AS estimated_cost_quantity,
  coalesce(g.estimated_cost_lines,0)::bigint AS estimated_cost_lines,
  coalesce(g.legacy_estimated_cost_revenue_sar,0) AS legacy_estimated_cost_revenue_sar,
  coalesce(g.legacy_estimated_cost_quantity,0) AS legacy_estimated_cost_quantity,
  coalesce(g.legacy_estimated_cost_lines,0)::bigint AS legacy_estimated_cost_lines,
  coalesce(g.reversal_lines,0)::bigint AS reversal_lines,
  coalesce(smt.total_storage_fee_sar,0) AS month_storage_fee_sar,
  coalesce(sgm.allocated_storage_fee_sar,0) AS allocated_storage_fee_sar,
  CASE
    WHEN g.month_start IS NULL THEN -coalesce(sgm.allocated_storage_fee_sar,0)
    WHEN g.profit_before_storage_sar IS NULL THEN NULL
    ELSE g.profit_before_storage_sar - coalesce(sgm.allocated_storage_fee_sar,0)
  END AS profit_after_storage_sar,
  CASE
    WHEN g.month_start IS NULL THEN -coalesce(sgm.allocated_storage_fee_sar,0)
    WHEN g.profit_if_rtv_received_resellable_sar IS NULL THEN NULL
    ELSE g.profit_if_rtv_received_resellable_sar - coalesce(sgm.allocated_storage_fee_sar,0)
  END AS profit_if_rtv_received_resellable_after_storage_sar,
  CASE
    WHEN g.month_start IS NULL THEN -coalesce(sgm.allocated_storage_fee_sar,0)
    WHEN g.profit_if_rtv_09_resellable_sar IS NULL THEN NULL
    ELSE g.profit_if_rtv_09_resellable_sar - coalesce(sgm.allocated_storage_fee_sar,0)
  END AS profit_if_rtv_09_resellable_after_storage_sar,
  CASE
    WHEN coalesce(g.known_net_revenue_sar,0) > 0 AND g.profit_before_storage_sar IS NOT NULL
    THEN (g.profit_before_storage_sar - coalesce(sgm.allocated_storage_fee_sar,0)) / nullif(g.known_net_revenue_sar,0)
    ELSE NULL
  END AS profit_margin_after_storage,
  CASE
    WHEN coalesce(g.gross_revenue_sar,0) > 0 THEN coalesce(g.known_gross_revenue_sar,0) / nullif(g.gross_revenue_sar,0)
    ELSE NULL
  END AS cost_coverage_revenue_rate,
  coalesce(g.risk_adjusted_net_revenue_sar,0) AS risk_adjusted_net_revenue_sar,
  coalesce(g.known_risk_adjusted_net_revenue_sar,0) AS known_risk_adjusted_net_revenue_sar,
  coalesce(g.pending_revenue_risk_sar,0) AS pending_revenue_risk_sar,
  CASE WHEN g.month_start IS NULL THEN 0 ELSE g.risk_adjusted_profit_before_storage_sar END AS risk_adjusted_profit_before_storage_sar,
  CASE
    WHEN g.month_start IS NULL THEN -coalesce(sgm.allocated_storage_fee_sar,0)
    WHEN g.risk_adjusted_profit_before_storage_sar IS NULL THEN NULL
    ELSE g.risk_adjusted_profit_before_storage_sar - coalesce(sgm.allocated_storage_fee_sar,0)
  END AS risk_adjusted_profit_after_storage_sar,
  CASE
    WHEN coalesce(g.known_risk_adjusted_net_revenue_sar,0) > 0 AND g.risk_adjusted_profit_before_storage_sar IS NOT NULL
    THEN (g.risk_adjusted_profit_before_storage_sar - coalesce(sgm.allocated_storage_fee_sar,0)) / nullif(g.known_risk_adjusted_net_revenue_sar,0)
    ELSE NULL
  END AS risk_adjusted_profit_margin_after_storage,
  coalesce(g.pending_revenue_risk_lines,0)::bigint AS pending_revenue_risk_lines,
  coalesce(g.actual_return_cost_sar,0) AS actual_return_cost_sar,
  coalesce(g.estimated_return_delivery_fee_sar,0) AS estimated_return_delivery_fee_sar,
  coalesce(sgm.storage_fee_method,'none') AS storage_fee_method
FROM group_month g
FULL JOIN storage_group_month sgm
  ON sgm.month_start = g.month_start
 AND sgm.group_key IS NOT DISTINCT FROM g.group_key
LEFT JOIN storage_month_total smt
  ON smt.month_start = coalesce(g.month_start,sgm.month_start);
ANALYZE mart.profit_month_group_cache_new;
DROP TABLE IF EXISTS mart.profit_product_summary_cache_new;
CREATE UNLOGGED TABLE mart.profit_product_summary_cache_new AS
SELECT
  p.standard_goods_sn,
  sum(p.gross_revenue_sar) AS gross_revenue_sar,
  sum(p.net_revenue_sar) AS net_revenue_sar,
  sum(p.quantity) AS quantity,
  sum(p.product_cost_sar) AS product_cost_sar,
  sum(p.return_delivery_fee_sar) AS return_delivery_fee_sar,
  sum(p.rtv_recoverable_cost_sar) AS rtv_recoverable_cost_sar,
  sum(p.rtv_09_recoverable_cost_sar) AS rtv_09_recoverable_cost_sar,
  sum(p.rtv_received_quantity) AS rtv_received_quantity,
  sum(p.rtv_received_to_09_quantity) AS rtv_received_to_09_quantity,
  sum(p.profit_before_storage_sar) AS profit_before_storage_sar,
  sum(p.profit_if_rtv_received_resellable_sar) AS profit_if_rtv_received_resellable_sar,
  sum(p.profit_if_rtv_09_resellable_sar) AS profit_if_rtv_09_resellable_sar,
  CASE
    WHEN sum(coalesce(p.known_net_revenue_sar,0)) > 0
    THEN sum(p.profit_before_storage_sar) / nullif(sum(p.known_net_revenue_sar),0)
    ELSE NULL
  END AS profit_margin_before_storage,
  sum(p.missing_cost_revenue_sar) AS missing_cost_revenue_sar,
  sum(p.missing_cost_quantity) AS missing_cost_quantity,
  sum(p.missing_cost_lines) AS missing_cost_lines,
  sum(p.estimated_cost_revenue_sar) AS estimated_cost_revenue_sar,
  sum(p.estimated_cost_quantity) AS estimated_cost_quantity,
  sum(p.estimated_cost_lines) AS estimated_cost_lines,
  sum(p.legacy_estimated_cost_revenue_sar) AS legacy_estimated_cost_revenue_sar,
  sum(p.legacy_estimated_cost_quantity) AS legacy_estimated_cost_quantity,
  sum(p.legacy_estimated_cost_lines) AS legacy_estimated_cost_lines,
  sum(p.reversal_lines) AS reversal_lines,
  max(c.unit_cost_sar) AS unit_cost_sar,
  max(c.complete_batch_count)::bigint AS complete_batch_count,
  max(c.ignored_batch_count)::bigint AS ignored_batch_count,
  max(c.costed_quantity) AS costed_quantity,
  max(c.avg_purchase_unit_price) AS avg_purchase_unit_price,
  max(c.avg_volume_l) AS avg_volume_l,
  max(c.avg_weight_kg) AS avg_weight_kg,
  max(c.last_imported_at) AS last_cost_imported_at,
  CASE
    WHEN sum(p.gross_revenue_sar) > 0
    THEN sum(p.known_gross_revenue_sar) / nullif(sum(p.gross_revenue_sar),0)
    ELSE NULL
  END AS cost_coverage_revenue_rate,
  coalesce(max(ps.storage_fee_sar),0) AS storage_fee_sar,
  sum(p.profit_before_storage_sar) - coalesce(max(ps.storage_fee_sar),0) AS profit_after_storage_sar,
  CASE
    WHEN sum(coalesce(p.known_net_revenue_sar,0)) > 0
    THEN (sum(p.profit_before_storage_sar) - coalesce(max(ps.storage_fee_sar),0)) / nullif(sum(p.known_net_revenue_sar),0)
    ELSE NULL
  END AS profit_margin_after_storage,
  sum(p.profit_if_rtv_received_resellable_sar) - coalesce(max(ps.storage_fee_sar),0) AS profit_if_rtv_received_resellable_after_storage_sar,
  sum(p.profit_if_rtv_09_resellable_sar) - coalesce(max(ps.storage_fee_sar),0) AS profit_if_rtv_09_resellable_after_storage_sar,
  coalesce(max(ps.storage_fee_method),'none') AS storage_fee_method,
  coalesce(max(ps.storage_fee_days),0) AS storage_fee_days,
  max(ps.storage_source_snapshot_min) AS storage_source_snapshot_min,
  max(ps.storage_source_snapshot_max) AS storage_source_snapshot_max,
  sum(p.risk_adjusted_net_revenue_sar) AS risk_adjusted_net_revenue_sar,
  sum(p.known_risk_adjusted_net_revenue_sar) AS known_risk_adjusted_net_revenue_sar,
  sum(p.pending_revenue_risk_sar) AS pending_revenue_risk_sar,
  sum(p.risk_adjusted_profit_before_storage_sar) AS risk_adjusted_profit_before_storage_sar,
  sum(p.risk_adjusted_profit_after_storage_sar) AS risk_adjusted_profit_after_storage_sar,
  CASE
    WHEN sum(p.known_risk_adjusted_net_revenue_sar) > 0
    THEN sum(p.risk_adjusted_profit_after_storage_sar) / nullif(sum(p.known_risk_adjusted_net_revenue_sar),0)
    ELSE NULL
  END AS risk_adjusted_profit_margin_after_storage,
  sum(p.pending_revenue_risk_lines) AS pending_revenue_risk_lines,
  sum(p.pending_impact_quantity) AS pending_impact_quantity,
  sum(p.pending_impact_amount_sar) AS pending_impact_amount_sar,
  sum(p.actual_return_cost_sar) AS actual_return_cost_sar,
  sum(p.estimated_return_delivery_fee_sar) AS estimated_return_delivery_fee_sar,
  string_agg(DISTINCT p.storage_allocation_stage, ' / ') AS storage_allocation_stage
FROM mart.profit_daily_store_product_cache_new p
LEFT JOIN mart.product_unit_cost_by_match_key c
  ON c.match_key <> ''
 AND c.match_key = dim.product_match_key(p.standard_goods_sn)
LEFT JOIN (
  SELECT
    coalesce(nullif(match_key,''), dim.product_match_key(standard_goods_sn)) AS match_key,
    sum(actual_allocated_fee_sar) AS storage_fee_sar,
    string_agg(DISTINCT storage_allocation_method, ' / ') AS storage_fee_method,
    count(DISTINCT date) AS storage_fee_days,
    min(source_snapshot_date) AS storage_source_snapshot_min,
    max(source_snapshot_date) AS storage_source_snapshot_max
  FROM mart.storage_fee_product_daily_cache_new
  GROUP BY coalesce(nullif(match_key,''), dim.product_match_key(standard_goods_sn))
) ps
  ON ps.match_key <> ''
 AND ps.match_key = dim.product_match_key(p.standard_goods_sn)
GROUP BY p.standard_goods_sn;
ANALYZE mart.profit_product_summary_cache_new;
DROP TABLE IF EXISTS mart.profit_order_item_cache_old;
DROP TABLE IF EXISTS mart.storage_fee_product_daily_cache_old;
DROP TABLE IF EXISTS mart.storage_fee_store_daily_cache_old;
DROP TABLE IF EXISTS mart.storage_fee_product_store_daily_cache_old;
DROP TABLE IF EXISTS mart.profit_daily_store_product_cache_old;
DROP TABLE IF EXISTS mart.profit_month_group_cache_old;
DROP TABLE IF EXISTS mart.profit_product_summary_cache_old;

ALTER TABLE IF EXISTS mart.profit_order_item_cache RENAME TO profit_order_item_cache_old;
ALTER TABLE IF EXISTS mart.storage_fee_product_daily_cache RENAME TO storage_fee_product_daily_cache_old;
ALTER TABLE IF EXISTS mart.storage_fee_store_daily_cache RENAME TO storage_fee_store_daily_cache_old;
ALTER TABLE IF EXISTS mart.storage_fee_product_store_daily_cache RENAME TO storage_fee_product_store_daily_cache_old;
ALTER TABLE IF EXISTS mart.profit_daily_store_product_cache RENAME TO profit_daily_store_product_cache_old;
ALTER TABLE IF EXISTS mart.profit_month_group_cache RENAME TO profit_month_group_cache_old;
ALTER TABLE IF EXISTS mart.profit_product_summary_cache RENAME TO profit_product_summary_cache_old;

ALTER TABLE mart.profit_order_item_cache_new RENAME TO profit_order_item_cache;
ALTER TABLE mart.storage_fee_product_daily_cache_new RENAME TO storage_fee_product_daily_cache;
ALTER TABLE mart.storage_fee_store_daily_cache_new RENAME TO storage_fee_store_daily_cache;
ALTER TABLE mart.storage_fee_product_store_daily_cache_new RENAME TO storage_fee_product_store_daily_cache;
ALTER TABLE mart.profit_daily_store_product_cache_new RENAME TO profit_daily_store_product_cache;
ALTER TABLE mart.profit_month_group_cache_new RENAME TO profit_month_group_cache;
ALTER TABLE mart.profit_product_summary_cache_new RENAME TO profit_product_summary_cache;

INSERT INTO mart.profit_mart_cache_meta(
  cache_key,status,refreshed_at,source_max_order_date,source_max_storage_fee_date,row_counts,note
)
SELECT 'profit_marts','ok',now(),
  (SELECT max(created_date)::date FROM mart.profit_order_item_cache),
  (SELECT max(date)::date FROM mart.storage_fee_product_daily_cache),
  jsonb_build_object(
    'profit_order_item',(SELECT count(*) FROM mart.profit_order_item_cache),
    'storage_fee_product_daily',(SELECT count(*) FROM mart.storage_fee_product_daily_cache),
    'storage_fee_store_daily',(SELECT count(*) FROM mart.storage_fee_store_daily_cache),
    'storage_fee_product_store_daily',(SELECT count(*) FROM mart.storage_fee_product_store_daily_cache),
    'profit_daily_store_product',(SELECT count(*) FROM mart.profit_daily_store_product_cache),
    'profit_month_group',(SELECT count(*) FROM mart.profit_month_group_cache),
    'profit_product_summary',(SELECT count(*) FROM mart.profit_product_summary_cache),
    'fee_days',(SELECT fee_days FROM tmp_profit_mart_refresh_mode),
    'missing_fee_days',(SELECT missing_fee_days FROM tmp_profit_mart_refresh_mode),
    'canonical_storage_bills',(SELECT count(*) FROM mart.et_storage_fee_bill_canonical),
    'storage_status_replacement_chains',(
      SELECT count(*) FROM mart.et_storage_fee_bill_canonical
      WHERE canonical_reason = 'status_replacement_paid_supersedes_pending'
    ),
    'storage_detail_scaled_days',(
      SELECT count(DISTINCT date) FROM mart.storage_fee_product_daily_cache
      WHERE storage_allocation_method = 'download_detail_scaled_to_bill'
    )
  ),
  'dependency-ordered cache refresh; canonical conserving storage allocation computed once'
ON CONFLICT(cache_key) DO UPDATE SET
  status=EXCLUDED.status,refreshed_at=EXCLUDED.refreshed_at,
  source_max_order_date=EXCLUDED.source_max_order_date,
  source_max_storage_fee_date=EXCLUDED.source_max_storage_fee_date,
  row_counts=EXCLUDED.row_counts,note=EXCLUDED.note;

DROP TABLE IF EXISTS mart.profit_order_item_cache_old;
DROP TABLE IF EXISTS mart.storage_fee_product_daily_cache_old;
DROP TABLE IF EXISTS mart.storage_fee_store_daily_cache_old;
DROP TABLE IF EXISTS mart.storage_fee_product_store_daily_cache_old;
DROP TABLE IF EXISTS mart.profit_daily_store_product_cache_old;
DROP TABLE IF EXISTS mart.profit_month_group_cache_old;
DROP TABLE IF EXISTS mart.profit_product_summary_cache_old;
COMMIT;

SELECT cache_key,status,refreshed_at,source_max_order_date,source_max_storage_fee_date,row_counts,note
FROM mart.profit_mart_cache_meta WHERE cache_key='profit_marts';
