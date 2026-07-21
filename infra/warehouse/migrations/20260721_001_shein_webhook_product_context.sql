BEGIN;

-- Safe, read-only business context for product lifecycle notifications.  The
-- receiver role never receives direct SELECT on the sales/link marts; this
-- SECURITY DEFINER function exposes only the fields needed for an operator to
-- understand one SKC notification.
CREATE OR REPLACE FUNCTION ops.get_shein_webhook_product_context(
  p_store_key text,
  p_skc text,
  p_event_at timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_store text := upper(btrim(COALESCE(p_store_key, '')));
  v_skc text := btrim(COALESCE(p_skc, ''));
  v_event_at timestamptz := COALESCE(p_event_at, now());
  v_event_date date := (COALESCE(p_event_at, now()) AT TIME ZONE 'Asia/Shanghai')::date;
  v_result jsonb;
BEGIN
  IF v_store='' OR v_skc='' OR length(v_store)>32 OR length(v_skc)>160 THEN
    RAISE EXCEPTION 'invalid webhook product context scope';
  END IF;

  WITH latest_link AS (
    SELECT l.*
    FROM fact.link_master_snapshot AS l
    WHERE l.store_key=v_store
      AND l.skc=v_skc
      AND l.snapshot_date<=v_event_date
    ORDER BY l.snapshot_date DESC, l.updated_at DESC
    LIMIT 1
  ), latest_performance AS (
    SELECT p.*
    FROM fact.link_performance_daily AS p
    WHERE p.store_key=v_store
      AND p.skc=v_skc
      AND p.date<=v_event_date
    ORDER BY p.date DESC, p.updated_at DESC
    LIMIT 1
  ), sales AS (
    SELECT
      COALESCE(sum(oi.quantity) FILTER (
        WHERE oi.gross_revenue_sar>0 AND oi.created_date BETWEEN v_event_date-6 AND v_event_date
      ),0) AS units_7d,
      COALESCE(sum(oi.gross_revenue_sar) FILTER (
        WHERE oi.gross_revenue_sar>0 AND oi.created_date BETWEEN v_event_date-6 AND v_event_date
      ),0) AS gross_sales_7d_sar,
      count(DISTINCT oi.order_no) FILTER (
        WHERE oi.gross_revenue_sar>0 AND oi.created_date BETWEEN v_event_date-6 AND v_event_date
      ) AS orders_7d,
      COALESCE(sum(oi.quantity) FILTER (
        WHERE oi.gross_revenue_sar>0 AND oi.created_date BETWEEN v_event_date-29 AND v_event_date
      ),0) AS units_30d,
      COALESCE(sum(oi.gross_revenue_sar) FILTER (
        WHERE oi.gross_revenue_sar>0 AND oi.created_date BETWEEN v_event_date-29 AND v_event_date
      ),0) AS gross_sales_30d_sar,
      count(DISTINCT oi.order_no) FILTER (
        WHERE oi.gross_revenue_sar>0 AND oi.created_date BETWEEN v_event_date-29 AND v_event_date
      ) AS orders_30d,
      COALESCE(sum(oi.quantity) FILTER (WHERE oi.gross_revenue_sar>0),0) AS units_lifetime,
      COALESCE(sum(oi.gross_revenue_sar) FILTER (WHERE oi.gross_revenue_sar>0),0) AS gross_sales_lifetime_sar,
      count(DISTINCT oi.order_no) FILTER (WHERE oi.gross_revenue_sar>0) AS orders_lifetime,
      min(oi.created_date) FILTER (WHERE oi.gross_revenue_sar>0) AS first_sale_date,
      max(oi.created_date) FILTER (WHERE oi.gross_revenue_sar>0) AS last_sale_date
    FROM mart.profit_order_item_cache AS oi
    WHERE oi.store_key=v_store
      AND oi.skc=v_skc
      AND oi.created_date<=v_event_date
  )
  SELECT CASE WHEN link.skc IS NULL THEN NULL ELSE jsonb_strip_nulls(jsonb_build_object(
    'storeKey', v_store,
    'skc', link.skc,
    'spu', nullif(link.spu,''),
    'supplierCode', nullif(link.standard_goods_sn,''),
    'rawSupplierCode', nullif(link.raw_goods_sn,''),
    'productName', COALESCE(nullif(link.product_name_cn,''), nullif(link.standard_goods_sn,'')),
    'variantName', nullif(link.sale_name,''),
    'firstShelfTime', link.first_shelf_time,
    'createdTime', link.created_time,
    'lastKnownShelfStatus', nullif(link.shelf_status_name,''),
    'linkSnapshotDate', link.snapshot_date,
    'performanceDate', perf.date,
    'sales', jsonb_build_object(
      'units7d', sales.units_7d,
      'grossSales7dSar', round(sales.gross_sales_7d_sar::numeric,2),
      'orders7d', sales.orders_7d,
      'units30d', sales.units_30d,
      'grossSales30dSar', round(sales.gross_sales_30d_sar::numeric,2),
      'orders30d', sales.orders_30d,
      'unitsLifetime', sales.units_lifetime,
      'grossSalesLifetimeSar', round(sales.gross_sales_lifetime_sar::numeric,2),
      'ordersLifetime', sales.orders_lifetime,
      'firstSaleDate', sales.first_sale_date,
      'lastSaleDate', sales.last_sale_date
    ),
    'traffic', CASE WHEN perf.skc IS NULL THEN NULL ELSE jsonb_build_object(
      'c7SaleCnt', perf.c7_sale_cnt,
      'c30SaleCnt', perf.c30_sale_cnt,
      'exposureUv', perf.eps_uv,
      'visitorUv', perf.goods_uv
    ) END,
    'contextAsOf', v_event_at
  )) END
  INTO v_result
  FROM (SELECT 1) AS seed
  LEFT JOIN latest_link AS link ON true
  LEFT JOIN latest_performance AS perf ON true
  CROSS JOIN sales;

  RETURN v_result;
END
$$;

REVOKE ALL ON FUNCTION ops.get_shein_webhook_product_context(text,text,timestamptz) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='shein_webhook_ops') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA ops TO shein_webhook_ops';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ops.get_shein_webhook_product_context(text,text,timestamptz) TO shein_webhook_ops';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='shein_link_ops') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA ops TO shein_link_ops';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ops.get_shein_webhook_product_context(text,text,timestamptz) TO shein_link_ops';
  END IF;
END
$$;

COMMENT ON FUNCTION ops.get_shein_webhook_product_context(text,text,timestamptz)
IS 'Safe read-only product/listing/sales context for one store SKC webhook; does not expose raw payloads or credentials.';

COMMIT;
