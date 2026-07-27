BEGIN;

-- Expand the event overlay from direct on/off callbacks to the exact four-state
-- lifecycle returned by the read-only SHEIN product-detail API. Audit/price
-- results are never treated as a shelf state without that store + SKC readback.
ALTER TABLE ops.shein_webhook_product_state
  DROP CONSTRAINT IF EXISTS shein_webhook_product_state_event_family_check,
  DROP CONSTRAINT IF EXISTS shein_webhook_product_state_action_check,
  DROP CONSTRAINT IF EXISTS shein_webhook_product_state_shelf_status_code_check,
  DROP CONSTRAINT IF EXISTS shein_webhook_product_state_shelf_status_name_check;

ALTER TABLE ops.shein_webhook_product_state
  ADD CONSTRAINT shein_webhook_product_state_event_family_check CHECK (
    event_family IN (
      'product_shelves','product_delete_audit','product_audit',
      'product_audit_all_channels','price_audit','rrp_review'
    )
  ),
  ADD CONSTRAINT shein_webhook_product_state_action_check CHECK (
    action IN ('on_shelf','wait_shelf','sold_out','off_shelf')
  ),
  ADD CONSTRAINT shein_webhook_product_state_shelf_status_code_check CHECK (
    shelf_status_code IN ('1','2','3','4')
  ),
  ADD CONSTRAINT shein_webhook_product_state_shelf_status_name_check CHECK (
    shelf_status_name IN ('已上架','待上架','已售罄','已下架')
  );

CREATE OR REPLACE FUNCTION ops.apply_shein_webhook_product_state(
  p_receipt_id bigint,
  p_store_key text,
  p_skc text,
  p_event_family text,
  p_action text,
  p_status text,
  p_source_event_order numeric,
  p_event_at timestamptz,
  p_product_context jsonb DEFAULT '{}'::jsonb
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_store text := upper(btrim(COALESCE(p_store_key,'')));
  v_skc text := btrim(COALESCE(p_skc,''));
  v_family text := btrim(COALESCE(p_event_family,''));
  v_action text := btrim(COALESCE(p_action,''));
  v_status text := btrim(COALESCE(p_status,''));
  v_context jsonb := COALESCE(p_product_context,'{}'::jsonb);
  v_shelf_action text;
  v_shelf_code text;
  v_shelf_name text;
  v_rows bigint := 0;
BEGIN
  IF p_receipt_id IS NULL OR p_receipt_id <= 0
     OR v_store='' OR length(v_store)>32
     OR v_skc='' OR length(v_skc)>160
     OR p_source_event_order IS NULL
     OR p_source_event_order < 0
     OR p_event_at IS NULL
     OR jsonb_typeof(v_context) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid webhook product-state scope';
  END IF;

  IF v_action='on_shelf' THEN
    v_shelf_action := 'on_shelf';
    v_shelf_code := '1';
    v_shelf_name := '已上架';
  ELSIF v_action='wait_shelf' THEN
    v_shelf_action := 'wait_shelf';
    v_shelf_code := '2';
    v_shelf_name := '待上架';
  ELSIF v_action='sold_out' THEN
    v_shelf_action := 'sold_out';
    v_shelf_code := '3';
    v_shelf_name := '已售罄';
  ELSIF v_action='off_shelf' THEN
    v_shelf_action := 'off_shelf';
    v_shelf_code := '4';
    v_shelf_name := '已下架';
  ELSIF v_family='product_delete_audit' AND v_status='2' THEN
    v_shelf_action := 'off_shelf';
    v_shelf_code := '4';
    v_shelf_name := '已下架';
  ELSE
    RETURN false;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM ops.shein_webhook_receipt AS receipt
    WHERE receipt.id=p_receipt_id
      AND receipt.store_key=v_store
      AND COALESCE(receipt.normalized->>'skc','')=v_skc
      AND COALESCE(receipt.normalized->>'eventFamily','')=v_family
  ) THEN
    RAISE EXCEPTION 'webhook product-state receipt identity mismatch';
  END IF;

  INSERT INTO ops.shein_webhook_product_state(
    store_key, skc, event_family, action, shelf_status_code, shelf_status_name,
    is_on_shelf, is_wait_shelf, is_sold_out, is_out_shelf,
    source_event_order, source_receipt_id, event_at, product_context
  ) VALUES (
    v_store, v_skc, v_family, v_shelf_action, v_shelf_code, v_shelf_name,
    v_shelf_code='1', v_shelf_code='2', v_shelf_code='3', v_shelf_code='4',
    p_source_event_order, p_receipt_id, p_event_at, v_context
  )
  ON CONFLICT (store_key, skc) DO UPDATE SET
    event_family=EXCLUDED.event_family,
    action=EXCLUDED.action,
    shelf_status_code=EXCLUDED.shelf_status_code,
    shelf_status_name=EXCLUDED.shelf_status_name,
    is_on_shelf=EXCLUDED.is_on_shelf,
    is_wait_shelf=EXCLUDED.is_wait_shelf,
    is_sold_out=EXCLUDED.is_sold_out,
    is_out_shelf=EXCLUDED.is_out_shelf,
    source_event_order=EXCLUDED.source_event_order,
    source_receipt_id=EXCLUDED.source_receipt_id,
    event_at=EXCLUDED.event_at,
    product_context=EXCLUDED.product_context,
    updated_at=clock_timestamp()
  WHERE EXCLUDED.source_event_order > ops.shein_webhook_product_state.source_event_order
     OR (
       EXCLUDED.source_event_order = ops.shein_webhook_product_state.source_event_order
       AND EXCLUDED.source_receipt_id >= ops.shein_webhook_product_state.source_receipt_id
     );
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END
$$;

REVOKE ALL ON FUNCTION ops.apply_shein_webhook_product_state(
  bigint,text,text,text,text,text,numeric,timestamptz,jsonb
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='shein_webhook_ops') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION ops.apply_shein_webhook_product_state(bigint,text,text,text,text,text,numeric,timestamptz,jsonb) TO shein_webhook_ops';
  END IF;
END
$$;

COMMENT ON TABLE ops.shein_webhook_product_state
IS 'Latest monotonic SHEIN four-state product lifecycle per store/SKC, from direct shelf events or exact OpenAPI readback after audit/price events; BI overlays it only while newer than the daily link snapshot.';

COMMIT;
