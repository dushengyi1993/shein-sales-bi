\pset pager off
\timing on

SET jit = off;
SET statement_timeout = '600s';
SET lock_timeout = '30s';

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
ANALYZE mart.profit_order_item_cache_new;

DROP TABLE IF EXISTS tmp_profit_mart_refresh_mode;
CREATE TEMP TABLE tmp_profit_mart_refresh_mode AS
WITH fee_daily AS (
  SELECT fee_date AS date, sum(shown_fee_rmb) AS shown_fee_rmb
  FROM mart.et_storage_fee_daily
  GROUP BY fee_date
),
detail_day AS (
  SELECT
    d.fee_date AS date,
    count(*) AS detail_rows,
    sum(coalesce(d.shown_fee_rmb,0)) AS detail_shown_fee_rmb
  FROM fact.et_storage_fee_product_detail d
  JOIN fee_daily f ON f.date = d.fee_date
  GROUP BY d.fee_date
)
SELECT
  count(*) FILTER (
    WHERE d.date IS NULL
       OR coalesce(d.detail_rows,0) = 0
       OR coalesce(d.detail_shown_fee_rmb,0) = 0
  )::bigint AS missing_fee_days,
  count(*)::bigint AS fee_days
FROM fee_daily f
LEFT JOIN detail_day d USING (date);

DROP TABLE IF EXISTS mart.storage_fee_product_daily_cache_new;
DO $$
DECLARE
  v_missing_fee_days bigint := 0;
BEGIN
  SELECT coalesce(max(missing_fee_days), 0)
  INTO v_missing_fee_days
  FROM tmp_profit_mart_refresh_mode;

  IF v_missing_fee_days = 0 THEN
    EXECUTE $sql$
      CREATE UNLOGGED TABLE mart.storage_fee_product_daily_cache_new AS
      WITH policy AS (
        SELECT * FROM dim.storage_fee_policy WHERE policy_key = 'et_default'
      ),
      fee_daily AS (
        SELECT fee_date AS date, sum(shown_fee_rmb) AS shown_fee_rmb, sum(actual_fee_sar) AS actual_fee_sar
        FROM mart.et_storage_fee_daily
        GROUP BY fee_date
      ),
      detail_day AS (
        SELECT
          d.fee_date AS date,
          count(*) AS detail_rows,
          sum(coalesce(d.shown_fee_rmb,0)) AS detail_shown_fee_rmb,
          max(f.shown_fee_rmb) AS fee_shown_fee_rmb,
          abs(sum(coalesce(d.shown_fee_rmb,0)) - max(f.shown_fee_rmb)) <= 0.05 AS detail_complete,
          max(f.shown_fee_rmb) / nullif(sum(coalesce(d.shown_fee_rmb,0)),0) AS detail_bill_scale
        FROM fact.et_storage_fee_product_detail d
        JOIN fee_daily f ON f.date = d.fee_date
        GROUP BY d.fee_date
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
          CASE WHEN dd.detail_complete THEN 'download_detail' ELSE 'download_detail_scaled_to_bill' END AS storage_allocation_method,
          CASE WHEN bi.box_id IS NOT NULL THEN bi.item_quantity ELSE d.quantity END AS quantity,
          CASE WHEN bi.box_id IS NOT NULL THEN NULL::numeric ELSE d.volume_m3_per_unit END AS volume_m3_per_unit,
          CASE
            WHEN bi.box_id IS NOT NULL AND coalesce(bt.total_item_quantity,0) > 0 THEN d.volume_m3_total * bi.item_quantity / nullif(bt.total_item_quantity,0)
            WHEN bi.box_id IS NOT NULL AND coalesce(bt.item_count,0) > 0 THEN d.volume_m3_total / nullif(bt.item_count,0)
            ELSE d.volume_m3_total
          END AS volume_m3_total,
          d.rate_rmb_per_m3_day,
          CASE
            WHEN bi.box_id IS NOT NULL AND coalesce(bt.total_item_quantity,0) > 0 THEN d.shown_fee_rmb * coalesce(dd.detail_bill_scale,1) * bi.item_quantity / nullif(bt.total_item_quantity,0)
            WHEN bi.box_id IS NOT NULL AND coalesce(bt.item_count,0) > 0 THEN d.shown_fee_rmb * coalesce(dd.detail_bill_scale,1) / nullif(bt.item_count,0)
            ELSE d.shown_fee_rmb * coalesce(dd.detail_bill_scale,1)
          END AS shown_fee_rmb
        FROM fact.et_storage_fee_product_detail d
        JOIN detail_day dd
          ON dd.date = d.fee_date
         AND coalesce(dd.detail_rows,0) > 0
         AND coalesce(dd.detail_shown_fee_rmb,0) <> 0
        LEFT JOIN box_items bi
          ON d.storage_type ILIKE '%整箱%'
         AND bi.box_id = d.storage_code
        LEFT JOIN box_totals bt
          ON bt.box_id = d.storage_code
        WHERE coalesce(d.storage_code,'') <> ''
      )
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
      LEFT JOIN mart.product_display_by_match_key pd
        ON pd.match_key = e.match_key
      WHERE coalesce(e.standard_goods_sn, e.match_key, '') <> ''
      GROUP BY e.date, e.source_snapshot_date, e.stock_snapshot_method, coalesce(pd.display_standard_goods_sn, e.standard_goods_sn, e.match_key), e.match_key, e.warehouse_name, e.storage_allocation_method
    $sql$;
  ELSE
    EXECUTE $sql$
      CREATE UNLOGGED TABLE mart.storage_fee_product_daily_cache_new AS
      SELECT * FROM mart.storage_fee_product_daily
    $sql$;
  END IF;
END $$;
ANALYZE mart.storage_fee_product_daily_cache_new;

DROP TABLE IF EXISTS mart.storage_fee_store_daily_cache_new;
CREATE UNLOGGED TABLE mart.storage_fee_store_daily_cache_new AS
WITH fee_daily AS (
  SELECT fee_date AS date, sum(actual_fee_sar) AS actual_fee_sar
  FROM mart.et_storage_fee_daily
  GROUP BY fee_date
),
store_day AS (
  SELECT
    created_date::date AS date,
    store_key,
    group_key,
    sum(net_revenue_sar) AS net_revenue_sar
  FROM mart.profit_order_item_cache_new
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
  sf.date,
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
FROM fee_daily sf
JOIN store_month sm
  ON sm.month_start = date_trunc('month', sf.date)::date
LEFT JOIN store_day sd
  ON sd.date = sf.date AND sd.store_key = sm.store_key
LEFT JOIN day_total dt
  ON dt.date = sf.date
LEFT JOIN month_total mt
  ON mt.month_start = sm.month_start;
ANALYZE mart.storage_fee_store_daily_cache_new;

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
  GROUP BY date, coalesce(nullif(match_key,''), dim.product_match_key(standard_goods_sn))
),
store_product_sales AS (
  SELECT
    created_date::date AS date,
    store_key,
    group_key,
    standard_goods_sn,
    dim.product_match_key(standard_goods_sn) AS match_key,
    sum(net_revenue_sar) FILTER (WHERE NOT cost_missing) AS known_net_revenue_sar,
    sum(quantity) AS quantity
  FROM mart.profit_order_item_cache_new
  WHERE coalesce(standard_goods_sn,'') <> ''
  GROUP BY created_date::date, store_key, group_key, standard_goods_sn, dim.product_match_key(standard_goods_sn)
),
product_day_sales AS (
  SELECT
    date,
    match_key,
    sum(coalesce(known_net_revenue_sar,0)) AS product_known_net_revenue_sar,
    sum(coalesce(quantity,0)) AS product_quantity
  FROM store_product_sales
  GROUP BY date, match_key
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
 AND f.match_key = s.match_key
JOIN product_day_sales t
  ON t.date = s.date
 AND t.match_key = s.match_key;
ANALYZE mart.storage_fee_product_store_daily_cache_new;

DROP TABLE IF EXISTS mart.profit_daily_store_product_cache_new;
CREATE UNLOGGED TABLE mart.profit_daily_store_product_cache_new AS
WITH base AS (
  SELECT
    created_date AS date,
    store_key,
    group_key,
    standard_goods_sn,
    count(*) AS order_lines,
    count(DISTINCT order_key) AS orders,
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
    END AS cost_coverage_revenue_rate
  FROM mart.profit_order_item_cache_new
  GROUP BY created_date, store_key, group_key, standard_goods_sn
),
storage AS (
  SELECT
    date,
    store_key,
    group_key,
    dim.product_match_key(standard_goods_sn) AS match_key,
    sum(storage_fee_sar) AS storage_fee_sar,
    string_agg(DISTINCT storage_fee_method, ' / ') AS storage_fee_method
  FROM mart.storage_fee_product_store_daily_cache_new
  GROUP BY date, store_key, group_key, dim.product_match_key(standard_goods_sn)
)
SELECT
  b.*,
  coalesce(s.storage_fee_sar,0) AS storage_fee_sar,
  b.profit_before_storage_sar - coalesce(s.storage_fee_sar,0) AS profit_after_storage_sar,
  CASE
    WHEN b.known_net_revenue_sar > 0
    THEN (b.profit_before_storage_sar - coalesce(s.storage_fee_sar,0)) / nullif(b.known_net_revenue_sar,0)
    ELSE NULL
  END AS profit_margin_after_storage,
  b.profit_if_rtv_received_resellable_sar - coalesce(s.storage_fee_sar,0) AS profit_if_rtv_received_resellable_after_storage_sar,
  b.profit_if_rtv_09_resellable_sar - coalesce(s.storage_fee_sar,0) AS profit_if_rtv_09_resellable_after_storage_sar,
  coalesce(s.storage_fee_method,'none') AS storage_fee_method
FROM base b
LEFT JOIN storage s
  ON s.date = b.date
 AND s.store_key = b.store_key
 AND s.group_key = b.group_key
 AND s.match_key = dim.product_match_key(b.standard_goods_sn);
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
    sum(gross_revenue_sar) FILTER (WHERE NOT cost_missing) AS known_gross_revenue_sar,
    sum(gross_revenue_sar) FILTER (WHERE cost_missing) AS missing_cost_revenue_sar,
    count(*) FILTER (WHERE cost_missing) AS missing_cost_lines,
    count(*) FILTER (WHERE revenue_reversal) AS reversal_lines
  FROM mart.profit_order_item_cache_new
  GROUP BY month_start, group_key
),
month_total AS (
  SELECT month_start, sum(net_revenue_sar) AS month_net_revenue_sar
  FROM group_month
  GROUP BY month_start
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
  g.month_start,
  g.group_key,
  g.gross_revenue_sar,
  g.net_revenue_sar,
  g.product_cost_sar,
  g.return_delivery_fee_sar,
  g.rtv_recoverable_cost_sar,
  g.rtv_09_recoverable_cost_sar,
  g.rtv_received_quantity,
  g.rtv_received_to_09_quantity,
  g.profit_before_storage_sar,
  g.profit_if_rtv_received_resellable_sar,
  g.profit_if_rtv_09_resellable_sar,
  g.known_gross_revenue_sar,
  g.missing_cost_revenue_sar,
  g.missing_cost_lines,
  g.reversal_lines,
  coalesce(smt.total_storage_fee_sar,0) AS month_storage_fee_sar,
  coalesce(sgm.allocated_storage_fee_sar,0) AS allocated_storage_fee_sar,
  g.profit_before_storage_sar
    - coalesce(sgm.allocated_storage_fee_sar,0) AS profit_after_storage_sar,
  g.profit_if_rtv_received_resellable_sar
    - coalesce(sgm.allocated_storage_fee_sar,0) AS profit_if_rtv_received_resellable_after_storage_sar,
  g.profit_if_rtv_09_resellable_sar
    - coalesce(sgm.allocated_storage_fee_sar,0) AS profit_if_rtv_09_resellable_after_storage_sar,
  CASE
    WHEN g.net_revenue_sar > 0
    THEN (
      g.profit_before_storage_sar
      - coalesce(sgm.allocated_storage_fee_sar,0)
    ) / nullif(g.net_revenue_sar,0)
    ELSE NULL
  END AS profit_margin_after_storage,
  CASE
    WHEN g.gross_revenue_sar > 0 THEN g.known_gross_revenue_sar / nullif(g.gross_revenue_sar,0)
    ELSE NULL
  END AS cost_coverage_revenue_rate
FROM group_month g
JOIN month_total mt ON mt.month_start = g.month_start
LEFT JOIN storage_group_month sgm
  ON sgm.month_start = g.month_start
 AND sgm.group_key = g.group_key
LEFT JOIN storage_month_total smt ON smt.month_start = g.month_start;
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
    WHEN sum(p.net_revenue_sar) FILTER (WHERE p.missing_cost_lines = 0) > 0
    THEN sum(p.profit_before_storage_sar) / nullif(sum(p.known_net_revenue_sar),0)
    ELSE NULL
  END AS profit_margin_before_storage,
  sum(p.missing_cost_revenue_sar) AS missing_cost_revenue_sar,
  sum(p.missing_cost_quantity) AS missing_cost_quantity,
  sum(p.missing_cost_lines) AS missing_cost_lines,
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
    WHEN sum(p.net_revenue_sar) FILTER (WHERE p.missing_cost_lines = 0) > 0
    THEN (sum(p.profit_before_storage_sar) - coalesce(max(ps.storage_fee_sar),0)) / nullif(sum(p.known_net_revenue_sar),0)
    ELSE NULL
  END AS profit_margin_after_storage,
  sum(p.profit_if_rtv_received_resellable_sar) - coalesce(max(ps.storage_fee_sar),0) AS profit_if_rtv_received_resellable_after_storage_sar,
  sum(p.profit_if_rtv_09_resellable_sar) - coalesce(max(ps.storage_fee_sar),0) AS profit_if_rtv_09_resellable_after_storage_sar,
  coalesce(max(ps.storage_fee_method),'none') AS storage_fee_method,
  coalesce(max(ps.storage_fee_days),0) AS storage_fee_days,
  max(ps.storage_source_snapshot_min) AS storage_source_snapshot_min,
  max(ps.storage_source_snapshot_max) AS storage_source_snapshot_max
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

BEGIN;
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

INSERT INTO mart.profit_mart_cache_meta (
  cache_key,
  status,
  refreshed_at,
  source_max_order_date,
  source_max_storage_fee_date,
  row_counts,
  note
)
SELECT
  'profit_marts',
  'ok',
  now(),
  (SELECT max(created_date)::date FROM mart.profit_order_item_cache),
  (SELECT max(date)::date FROM mart.storage_fee_product_daily_cache),
  jsonb_build_object(
    'profit_order_item', (SELECT count(*) FROM mart.profit_order_item_cache),
    'storage_fee_product_daily', (SELECT count(*) FROM mart.storage_fee_product_daily_cache),
    'storage_fee_store_daily', (SELECT count(*) FROM mart.storage_fee_store_daily_cache),
    'storage_fee_product_store_daily', (SELECT count(*) FROM mart.storage_fee_product_store_daily_cache),
    'profit_daily_store_product', (SELECT count(*) FROM mart.profit_daily_store_product_cache),
    'profit_month_group', (SELECT count(*) FROM mart.profit_month_group_cache),
    'profit_product_summary', (SELECT count(*) FROM mart.profit_product_summary_cache),
    'fee_days', (SELECT fee_days FROM tmp_profit_mart_refresh_mode),
    'missing_fee_days', (SELECT missing_fee_days FROM tmp_profit_mart_refresh_mode)
  ),
  CASE
    WHEN (SELECT missing_fee_days FROM tmp_profit_mart_refresh_mode) = 0 THEN 'storage_fee_product_daily detail-only fast path'
    ELSE 'storage_fee_product_daily fallback view path'
  END
ON CONFLICT (cache_key) DO UPDATE SET
  status = EXCLUDED.status,
  refreshed_at = EXCLUDED.refreshed_at,
  source_max_order_date = EXCLUDED.source_max_order_date,
  source_max_storage_fee_date = EXCLUDED.source_max_storage_fee_date,
  row_counts = EXCLUDED.row_counts,
  note = EXCLUDED.note;

DROP TABLE IF EXISTS mart.profit_order_item_cache_old;
DROP TABLE IF EXISTS mart.storage_fee_product_daily_cache_old;
DROP TABLE IF EXISTS mart.storage_fee_store_daily_cache_old;
DROP TABLE IF EXISTS mart.storage_fee_product_store_daily_cache_old;
DROP TABLE IF EXISTS mart.profit_daily_store_product_cache_old;
DROP TABLE IF EXISTS mart.profit_month_group_cache_old;
DROP TABLE IF EXISTS mart.profit_product_summary_cache_old;
COMMIT;

SELECT
  cache_key,
  status,
  refreshed_at,
  source_max_order_date,
  source_max_storage_fee_date,
  row_counts,
  note
FROM mart.profit_mart_cache_meta
WHERE cache_key = 'profit_marts';
