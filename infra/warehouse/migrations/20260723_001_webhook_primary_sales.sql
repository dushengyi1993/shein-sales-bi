BEGIN;

CREATE TABLE IF NOT EXISTS ops.shein_webhook_runtime_setting (
  setting_key text PRIMARY KEY,
  setting_value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO ops.shein_webhook_runtime_setting(setting_key, setting_value)
VALUES
  ('primary_sales_enabled', 'false'),
  ('primary_sales_cutover_date', '2099-01-01')
ON CONFLICT (setting_key) DO NOTHING;

CREATE OR REPLACE FUNCTION ops.shein_webhook_primary_sales_enabled(p_date date)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, ops
AS $$
  SELECT
    COALESCE((
      SELECT lower(btrim(setting_value)) IN ('1','true','yes','on')
      FROM ops.shein_webhook_runtime_setting
      WHERE setting_key='primary_sales_enabled'
    ), false)
    AND p_date >= COALESCE((
      SELECT setting_value::date
      FROM ops.shein_webhook_runtime_setting
      WHERE setting_key='primary_sales_cutover_date'
    ), DATE '2099-01-01')
$$;

CREATE OR REPLACE FUNCTION ops.refresh_primary_store_daily_sales(
  p_store_key text,
  p_date date
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ops, fact, dim
AS $$
DECLARE
  v_store text := upper(btrim(COALESCE(p_store_key, '')));
BEGIN
  IF v_store='' OR p_date IS NULL OR NOT ops.shein_webhook_primary_sales_enabled(p_date) THEN
    RETURN;
  END IF;

  INSERT INTO fact.store_daily_sales(
    date, store_key, group_key, shop_name,
    valid_order_count, goods_line_count, quantity_all, quantity_positive_amount,
    sales_sar, sales_rmb, fetch_time, source_file, raw_summary, updated_at
  )
  SELECT
    p_date,
    store_row.store_key,
    store_row.group_key,
    store_row.shop_name,
    count(DISTINCT item.order_no) FILTER (WHERE COALESCE(item.sales_sar,0)>0)::integer,
    count(item.order_item_key)::integer,
    COALESCE(sum(item.quantity),0),
    COALESCE(sum(CASE WHEN COALESCE(item.sales_sar,0)>0 THEN COALESCE(item.quantity,0) ELSE 0 END),0),
    round(COALESCE(sum(item.sales_sar),0)::numeric,2),
    round(COALESCE(sum(item.sales_rmb),0)::numeric,2),
    clock_timestamp(),
    'shein-openapi-webhook',
    jsonb_build_object(
      'source','shein-openapi-webhook',
      'mode','targeted-order-upsert',
      'refreshedAt',clock_timestamp()
    ),
    clock_timestamp()
  FROM dim.store AS store_row
  LEFT JOIN fact.order_item AS item
    ON item.store_key=store_row.store_key
   AND item.created_date=p_date
  WHERE store_row.store_key=v_store
  GROUP BY store_row.store_key, store_row.group_key, store_row.shop_name
  ON CONFLICT (date,store_key) DO UPDATE SET
    group_key=EXCLUDED.group_key,
    shop_name=EXCLUDED.shop_name,
    valid_order_count=EXCLUDED.valid_order_count,
    goods_line_count=EXCLUDED.goods_line_count,
    quantity_all=EXCLUDED.quantity_all,
    quantity_positive_amount=EXCLUDED.quantity_positive_amount,
    sales_sar=EXCLUDED.sales_sar,
    sales_rmb=EXCLUDED.sales_rmb,
    fetch_time=EXCLUDED.fetch_time,
    source_file=EXCLUDED.source_file,
    raw_summary=EXCLUDED.raw_summary,
    updated_at=EXCLUDED.updated_at;
END
$$;

CREATE OR REPLACE FUNCTION ops.mirror_openapi_order_header_to_primary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ops, fact
AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF ops.shein_webhook_primary_sales_enabled(OLD.created_date) THEN
      DELETE FROM fact.order_header WHERE order_key=OLD.order_key;
    END IF;
    RETURN OLD;
  END IF;
  IF NOT ops.shein_webhook_primary_sales_enabled(NEW.created_date) THEN
    RETURN NEW;
  END IF;
  DELETE FROM fact.order_header WHERE order_key=NEW.order_key;
  INSERT INTO fact.order_header
  SELECT primary_row.*
  FROM jsonb_populate_record(NULL::fact.order_header, to_jsonb(NEW)) AS primary_row;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION ops.mirror_openapi_order_item_to_primary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ops, fact
AS $$
DECLARE
  v_store text;
  v_date date;
BEGIN
  IF TG_OP='DELETE' THEN
    v_store := OLD.store_key;
    v_date := OLD.created_date;
    IF ops.shein_webhook_primary_sales_enabled(v_date) THEN
      DELETE FROM fact.order_item WHERE order_item_key=OLD.order_item_key;
      PERFORM ops.refresh_primary_store_daily_sales(v_store,v_date);
    END IF;
    RETURN OLD;
  END IF;
  v_store := NEW.store_key;
  v_date := NEW.created_date;
  IF NOT ops.shein_webhook_primary_sales_enabled(v_date) THEN
    RETURN NEW;
  END IF;
  DELETE FROM fact.order_item WHERE order_item_key=NEW.order_item_key;
  INSERT INTO fact.order_item
  SELECT primary_row.*
  FROM jsonb_populate_record(NULL::fact.order_item, to_jsonb(NEW)) AS primary_row;
  PERFORM ops.refresh_primary_store_daily_sales(v_store,v_date);
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION ops.mirror_openapi_order_payment_to_primary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ops, fact
AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF ops.shein_webhook_primary_sales_enabled(OLD.created_date) THEN
      DELETE FROM fact.order_payment_flag WHERE order_key=OLD.order_key;
    END IF;
    RETURN OLD;
  END IF;
  IF NOT ops.shein_webhook_primary_sales_enabled(NEW.created_date) THEN
    RETURN NEW;
  END IF;
  DELETE FROM fact.order_payment_flag WHERE order_key=NEW.order_key;
  INSERT INTO fact.order_payment_flag
  SELECT primary_row.*
  FROM jsonb_populate_record(NULL::fact.order_payment_flag, to_jsonb(NEW)) AS primary_row;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_openapi_order_header_primary ON fact.openapi_order_header;
CREATE TRIGGER trg_openapi_order_header_primary
AFTER INSERT OR UPDATE OR DELETE ON fact.openapi_order_header
FOR EACH ROW EXECUTE FUNCTION ops.mirror_openapi_order_header_to_primary();

DROP TRIGGER IF EXISTS trg_openapi_order_item_primary ON fact.openapi_order_item;
CREATE TRIGGER trg_openapi_order_item_primary
AFTER INSERT OR UPDATE OR DELETE ON fact.openapi_order_item
FOR EACH ROW EXECUTE FUNCTION ops.mirror_openapi_order_item_to_primary();

DROP TRIGGER IF EXISTS trg_openapi_order_payment_primary ON fact.openapi_order_payment_flag;
CREATE TRIGGER trg_openapi_order_payment_primary
AFTER INSERT OR UPDATE OR DELETE ON fact.openapi_order_payment_flag
FOR EACH ROW EXECUTE FUNCTION ops.mirror_openapi_order_payment_to_primary();

CREATE OR REPLACE FUNCTION ops.configure_shein_webhook_primary_sales(
  p_enabled boolean,
  p_cutover_date date
) RETURNS TABLE(enabled boolean, cutover_date date)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ops
AS $$
BEGIN
  IF p_cutover_date IS NULL THEN
    RAISE EXCEPTION 'cutover date is required';
  END IF;
  INSERT INTO ops.shein_webhook_runtime_setting(setting_key,setting_value,updated_at)
  VALUES ('primary_sales_enabled',CASE WHEN p_enabled THEN 'true' ELSE 'false' END,clock_timestamp())
  ON CONFLICT (setting_key) DO UPDATE SET
    setting_value=EXCLUDED.setting_value,
    updated_at=EXCLUDED.updated_at;
  INSERT INTO ops.shein_webhook_runtime_setting(setting_key,setting_value,updated_at)
  VALUES ('primary_sales_cutover_date',p_cutover_date::text,clock_timestamp())
  ON CONFLICT (setting_key) DO UPDATE SET
    setting_value=EXCLUDED.setting_value,
    updated_at=EXCLUDED.updated_at;
  RETURN QUERY SELECT p_enabled,p_cutover_date;
END
$$;

CREATE OR REPLACE FUNCTION ops.promote_openapi_sales_slice(
  p_start_date date,
  p_end_date date
) RETURNS TABLE(headers_written bigint, items_written bigint, payment_flags_written bigint, daily_rows_refreshed bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ops, fact
AS $$
DECLARE
  v_headers bigint := 0;
  v_items bigint := 0;
  v_flags bigint := 0;
  v_daily bigint := 0;
  scope_row record;
BEGIN
  IF p_start_date IS NULL OR p_end_date IS NULL OR p_end_date<p_start_date OR p_end_date-p_start_date>31 THEN
    RAISE EXCEPTION 'invalid promotion date range';
  END IF;
  IF NOT ops.shein_webhook_primary_sales_enabled(p_start_date) THEN
    RAISE EXCEPTION 'primary sales promotion is not enabled for start date';
  END IF;

  DELETE FROM fact.order_payment_flag WHERE created_date BETWEEN p_start_date AND p_end_date;
  DELETE FROM fact.order_item WHERE created_date BETWEEN p_start_date AND p_end_date;
  DELETE FROM fact.order_header WHERE created_date BETWEEN p_start_date AND p_end_date;

  INSERT INTO fact.order_header
  SELECT primary_row.*
  FROM fact.openapi_order_header AS source_row
  CROSS JOIN LATERAL jsonb_populate_record(NULL::fact.order_header,to_jsonb(source_row)) AS primary_row
  WHERE source_row.created_date BETWEEN p_start_date AND p_end_date;
  GET DIAGNOSTICS v_headers = ROW_COUNT;

  INSERT INTO fact.order_item
  SELECT primary_row.*
  FROM fact.openapi_order_item AS source_row
  CROSS JOIN LATERAL jsonb_populate_record(NULL::fact.order_item,to_jsonb(source_row)) AS primary_row
  WHERE source_row.created_date BETWEEN p_start_date AND p_end_date;
  GET DIAGNOSTICS v_items = ROW_COUNT;

  INSERT INTO fact.order_payment_flag
  SELECT primary_row.*
  FROM fact.openapi_order_payment_flag AS source_row
  CROSS JOIN LATERAL jsonb_populate_record(NULL::fact.order_payment_flag,to_jsonb(source_row)) AS primary_row
  WHERE source_row.created_date BETWEEN p_start_date AND p_end_date;
  GET DIAGNOSTICS v_flags = ROW_COUNT;

  FOR scope_row IN
    SELECT store_key,date
    FROM dim.store
    CROSS JOIN generate_series(p_start_date,p_end_date,interval '1 day') AS dates(date)
  LOOP
    PERFORM ops.refresh_primary_store_daily_sales(scope_row.store_key,scope_row.date::date);
    v_daily := v_daily+1;
  END LOOP;
  RETURN QUERY SELECT v_headers,v_items,v_flags,v_daily;
END
$$;

REVOKE ALL ON TABLE ops.shein_webhook_runtime_setting FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.configure_shein_webhook_primary_sales(boolean,date) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.promote_openapi_sales_slice(date,date) FROM PUBLIC;

COMMIT;
