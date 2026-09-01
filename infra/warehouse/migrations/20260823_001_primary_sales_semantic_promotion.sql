BEGIN;

-- The OpenAPI loader and targeted Webhook writer share these AFTER triggers.
-- Only the loader's transaction-local flag may bypass the primary mirror.  A
-- targeted transaction must retain the immediate Webhook mirror semantics.
CREATE OR REPLACE FUNCTION ops.mirror_openapi_order_header_to_primary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ops, fact
AS $$
BEGIN
  IF current_setting('shein_bi.bulk_openapi_sales_reconcile', true) = 'on' THEN
    IF TG_OP='DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
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
  IF current_setting('shein_bi.bulk_openapi_sales_reconcile', true) = 'on' THEN
    IF TG_OP='DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
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
  IF current_setting('shein_bi.bulk_openapi_sales_reconcile', true) = 'on' THEN
    IF TG_OP='DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
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

CREATE OR REPLACE FUNCTION ops.promote_openapi_sales_slice_v2(
  p_start_date date,
  p_end_date date
) RETURNS TABLE(
  changed boolean,
  headers_added bigint,
  headers_modified bigint,
  headers_deleted bigint,
  items_added bigint,
  items_modified bigint,
  items_deleted bigint,
  payment_flags_added bigint,
  payment_flags_modified bigint,
  payment_flags_deleted bigint,
  headers_written bigint,
  items_written bigint,
  payment_flags_written bigint,
  daily_rows_refreshed bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ops, fact, dim
AS $$
DECLARE
  v_changed boolean := false;
  v_headers_added bigint := 0;
  v_headers_modified bigint := 0;
  v_headers_deleted bigint := 0;
  v_items_added bigint := 0;
  v_items_modified bigint := 0;
  v_items_deleted bigint := 0;
  v_flags_added bigint := 0;
  v_flags_modified bigint := 0;
  v_flags_deleted bigint := 0;
  v_headers_written bigint := 0;
  v_items_written bigint := 0;
  v_flags_written bigint := 0;
  v_daily bigint := 0;
  scope_row record;
BEGIN
  IF p_start_date IS NULL OR p_end_date IS NULL OR p_end_date<p_start_date OR p_end_date-p_start_date>31 THEN
    RAISE EXCEPTION 'invalid promotion date range';
  END IF;
  IF NOT ops.shein_webhook_primary_sales_enabled(p_start_date) THEN
    RAISE EXCEPTION 'primary sales promotion is not enabled for start date';
  END IF;

  -- Match the loader's sorted lock identity before reading either side.  This
  -- makes the semantic decision and the eventual replacement one transaction
  -- under the same per-store ownership barrier as the bulk load.
  FOR scope_row IN
    SELECT store_key
    FROM dim.store
    ORDER BY store_key
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('shein-openapi-order:' || scope_row.store_key, 0));
  END LOOP;

  -- Project each staging row through the target composite type.  The source
  -- source_snapshot_at attribute therefore disappears automatically; only
  -- target updated_at is volatile for the semantic comparison.  No business,
  -- source_file, or raw JSON field is hand-listed here.
  WITH source_rows AS (
    SELECT projected_row.order_key AS row_key,
           to_jsonb(projected_row) - 'updated_at' AS canonical_json
    FROM fact.openapi_order_header AS source_row
    CROSS JOIN LATERAL jsonb_populate_record(NULL::fact.order_header, to_jsonb(source_row)) AS projected_row
    WHERE source_row.created_date BETWEEN p_start_date AND p_end_date
  ), target_rows AS (
    SELECT target_row.order_key AS row_key,
           to_jsonb(target_row) - 'updated_at' AS canonical_json
    FROM fact.order_header AS target_row
    WHERE target_row.created_date BETWEEN p_start_date AND p_end_date
  ), differences AS (
    SELECT source_rows.row_key AS source_key,
           target_rows.row_key AS target_key,
           source_rows.canonical_json AS source_json,
           target_rows.canonical_json AS target_json
    FROM source_rows
    FULL JOIN target_rows ON target_rows.row_key=source_rows.row_key
  )
  SELECT
    count(*) FILTER (WHERE source_key IS NOT NULL AND target_key IS NULL),
    count(*) FILTER (WHERE source_key IS NOT NULL AND target_key IS NOT NULL AND source_json IS DISTINCT FROM target_json),
    count(*) FILTER (WHERE source_key IS NULL AND target_key IS NOT NULL)
  INTO v_headers_added, v_headers_modified, v_headers_deleted
  FROM differences;

  WITH source_rows AS (
    SELECT projected_row.order_item_key AS row_key,
           to_jsonb(projected_row) - 'updated_at' AS canonical_json
    FROM fact.openapi_order_item AS source_row
    CROSS JOIN LATERAL jsonb_populate_record(NULL::fact.order_item, to_jsonb(source_row)) AS projected_row
    WHERE source_row.created_date BETWEEN p_start_date AND p_end_date
  ), target_rows AS (
    SELECT target_row.order_item_key AS row_key,
           to_jsonb(target_row) - 'updated_at' AS canonical_json
    FROM fact.order_item AS target_row
    WHERE target_row.created_date BETWEEN p_start_date AND p_end_date
  ), differences AS (
    SELECT source_rows.row_key AS source_key,
           target_rows.row_key AS target_key,
           source_rows.canonical_json AS source_json,
           target_rows.canonical_json AS target_json
    FROM source_rows
    FULL JOIN target_rows ON target_rows.row_key=source_rows.row_key
  )
  SELECT
    count(*) FILTER (WHERE source_key IS NOT NULL AND target_key IS NULL),
    count(*) FILTER (WHERE source_key IS NOT NULL AND target_key IS NOT NULL AND source_json IS DISTINCT FROM target_json),
    count(*) FILTER (WHERE source_key IS NULL AND target_key IS NOT NULL)
  INTO v_items_added, v_items_modified, v_items_deleted
  FROM differences;

  WITH source_rows AS (
    SELECT projected_row.order_key AS row_key,
           to_jsonb(projected_row) - 'updated_at' AS canonical_json
    FROM fact.openapi_order_payment_flag AS source_row
    CROSS JOIN LATERAL jsonb_populate_record(NULL::fact.order_payment_flag, to_jsonb(source_row)) AS projected_row
    WHERE source_row.created_date BETWEEN p_start_date AND p_end_date
  ), target_rows AS (
    SELECT target_row.order_key AS row_key,
           to_jsonb(target_row) - 'updated_at' AS canonical_json
    FROM fact.order_payment_flag AS target_row
    WHERE target_row.created_date BETWEEN p_start_date AND p_end_date
  ), differences AS (
    SELECT source_rows.row_key AS source_key,
           target_rows.row_key AS target_key,
           source_rows.canonical_json AS source_json,
           target_rows.canonical_json AS target_json
    FROM source_rows
    FULL JOIN target_rows ON target_rows.row_key=source_rows.row_key
  )
  SELECT
    count(*) FILTER (WHERE source_key IS NOT NULL AND target_key IS NULL),
    count(*) FILTER (WHERE source_key IS NOT NULL AND target_key IS NOT NULL AND source_json IS DISTINCT FROM target_json),
    count(*) FILTER (WHERE source_key IS NULL AND target_key IS NOT NULL)
  INTO v_flags_added, v_flags_modified, v_flags_deleted
  FROM differences;

  v_changed := (v_headers_added + v_headers_modified + v_headers_deleted
    + v_items_added + v_items_modified + v_items_deleted
    + v_flags_added + v_flags_modified + v_flags_deleted) > 0;

  IF NOT v_changed THEN
    RETURN QUERY SELECT false,
      v_headers_added, v_headers_modified, v_headers_deleted,
      v_items_added, v_items_modified, v_items_deleted,
      v_flags_added, v_flags_modified, v_flags_deleted,
      0::bigint, 0::bigint, 0::bigint, 0::bigint;
    RETURN;
  END IF;

  DELETE FROM fact.order_payment_flag WHERE created_date BETWEEN p_start_date AND p_end_date;
  DELETE FROM fact.order_item WHERE created_date BETWEEN p_start_date AND p_end_date;
  DELETE FROM fact.order_header WHERE created_date BETWEEN p_start_date AND p_end_date;

  INSERT INTO fact.order_header
  SELECT primary_row.*
  FROM fact.openapi_order_header AS source_row
  CROSS JOIN LATERAL jsonb_populate_record(NULL::fact.order_header, to_jsonb(source_row)) AS primary_row
  WHERE source_row.created_date BETWEEN p_start_date AND p_end_date;
  GET DIAGNOSTICS v_headers_written = ROW_COUNT;

  INSERT INTO fact.order_item
  SELECT primary_row.*
  FROM fact.openapi_order_item AS source_row
  CROSS JOIN LATERAL jsonb_populate_record(NULL::fact.order_item, to_jsonb(source_row)) AS primary_row
  WHERE source_row.created_date BETWEEN p_start_date AND p_end_date;
  GET DIAGNOSTICS v_items_written = ROW_COUNT;

  INSERT INTO fact.order_payment_flag
  SELECT primary_row.*
  FROM fact.openapi_order_payment_flag AS source_row
  CROSS JOIN LATERAL jsonb_populate_record(NULL::fact.order_payment_flag, to_jsonb(source_row)) AS primary_row
  WHERE source_row.created_date BETWEEN p_start_date AND p_end_date;
  GET DIAGNOSTICS v_flags_written = ROW_COUNT;

  FOR scope_row IN
    SELECT store_key, date
    FROM dim.store
    CROSS JOIN generate_series(p_start_date, p_end_date, interval '1 day') AS dates(date)
    ORDER BY store_key, date
  LOOP
    PERFORM ops.refresh_primary_store_daily_sales(scope_row.store_key, scope_row.date::date);
    v_daily := v_daily + 1;
  END LOOP;

  RETURN QUERY SELECT true,
    v_headers_added, v_headers_modified, v_headers_deleted,
    v_items_added, v_items_modified, v_items_deleted,
    v_flags_added, v_flags_modified, v_flags_deleted,
    v_headers_written, v_items_written, v_flags_written, v_daily;
END
$$;

-- Keep the old result shape for cloud_bi_refresh and older callers.  The
-- implementation is now always the locked semantic v2 path, never a blind
-- delete/insert rewrite.
CREATE OR REPLACE FUNCTION ops.promote_openapi_sales_slice(
  p_start_date date,
  p_end_date date
) RETURNS TABLE(headers_written bigint, items_written bigint, payment_flags_written bigint, daily_rows_refreshed bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ops, fact, dim
AS $$
DECLARE
  v_result record;
BEGIN
  SELECT promotion.headers_written, promotion.items_written,
         promotion.payment_flags_written, promotion.daily_rows_refreshed
  INTO v_result
  FROM ops.promote_openapi_sales_slice_v2(p_start_date, p_end_date) AS promotion;
  RETURN QUERY SELECT v_result.headers_written, v_result.items_written,
    v_result.payment_flags_written, v_result.daily_rows_refreshed;
END
$$;

REVOKE ALL ON FUNCTION ops.promote_openapi_sales_slice_v2(date,date) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.promote_openapi_sales_slice(date,date) FROM PUBLIC;

COMMIT;
