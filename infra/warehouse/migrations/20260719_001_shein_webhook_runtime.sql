BEGIN;

SELECT pg_advisory_xact_lock(hashtextextended('shein-webhook-runtime-schema-migration', 0));

CREATE SCHEMA IF NOT EXISTS ops;

CREATE TABLE IF NOT EXISTS ops.shein_webhook_receipt (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE CHECK (btrim(idempotency_key) <> ''),
  app_id text NOT NULL DEFAULT '',
  open_key_id text NOT NULL DEFAULT '',
  event_code text NOT NULL CHECK (btrim(event_code) <> ''),
  store_key text NOT NULL DEFAULT '',
  platform_timestamp timestamptz,
  cipher_hash text NOT NULL CHECK (cipher_hash ~ '^[0-9a-f]{64}$'),
  -- Keep only SHEIN's AES ciphertext at rest. Decryption happens inside the
  -- leased worker; the browser/API projection never receives this column.
  event_data text NOT NULL CHECK (btrim(event_data) <> ''),
  normalized jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(normalized) = 'object'),
  severity text NOT NULL DEFAULT 'P3' CHECK (severity IN ('P0','P1','P2','P3')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','retry','dead_letter')),
  lease_owner text NOT NULL DEFAULT '',
  lease_expires_at timestamptz,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  error jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(error) = 'object'),
  next_attempt_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at timestamptz,
  alerted_at timestamptz,
  title text NOT NULL DEFAULT '',
  summary text NOT NULL DEFAULT '',
  business_key text NOT NULL DEFAULT '',
  action_state text NOT NULL DEFAULT '',
  duplicate_count integer NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
  last_duplicate_at timestamptz,
  CHECK (status <> 'running' OR (btrim(lease_owner) <> '' AND lease_expires_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS shein_webhook_receipt_queue_idx
  ON ops.shein_webhook_receipt (severity, received_at, id)
  WHERE status IN ('queued','retry');
CREATE INDEX IF NOT EXISTS shein_webhook_receipt_lease_idx
  ON ops.shein_webhook_receipt (lease_expires_at, id) WHERE status='running';
CREATE INDEX IF NOT EXISTS shein_webhook_receipt_store_received_idx
  ON ops.shein_webhook_receipt (store_key, received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS shein_webhook_receipt_status_received_idx
  ON ops.shein_webhook_receipt (status, received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS shein_webhook_receipt_business_key_idx
  ON ops.shein_webhook_receipt (business_key, received_at DESC) WHERE business_key <> '';

CREATE TABLE IF NOT EXISTS ops.shein_webhook_store_gate (
  store_key text NOT NULL CHECK (btrim(store_key) <> ''),
  gate_type text NOT NULL CHECK (btrim(gate_type) <> ''),
  state text NOT NULL CHECK (btrim(state) <> ''),
  reason text NOT NULL DEFAULT '',
  source_receipt_id bigint REFERENCES ops.shein_webhook_receipt(id) ON DELETE SET NULL,
  source_event_order numeric(30,0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (store_key, gate_type)
);

ALTER TABLE ops.shein_webhook_store_gate
  ADD COLUMN IF NOT EXISTS source_event_order numeric(30,0);

-- Upgrade safety for deployments that already received quota events before
-- source_event_order existed. Official quota payloads carry sendTimeStamp as
-- a numeric value and the normalized receipt retains it as eventTime.
WITH quota_source AS (
  SELECT gate.store_key,
    COALESCE(NULLIF(ltrim(btrim(receipt.normalized->>'eventTime'), '0'), ''), '0') AS digits
  FROM ops.shein_webhook_store_gate AS gate
  JOIN ops.shein_webhook_receipt AS receipt ON receipt.id=gate.source_receipt_id
  WHERE gate.gate_type='quota'
    AND gate.source_event_order IS NULL
    AND btrim(receipt.normalized->>'eventTime') ~ '^\d{1,30}$'
), normalized_quota_source AS (
  SELECT store_key,
    CASE
      WHEN length(digits) <= 10 THEN digits::numeric * 1000000
      WHEN length(digits) <= 13 THEN digits::numeric * 1000
      WHEN length(digits) <= 16 THEN digits::numeric
      ELSE trunc(digits::numeric / 1000)
    END AS source_event_order
  FROM quota_source
)
UPDATE ops.shein_webhook_store_gate AS gate
SET source_event_order=source.source_event_order
FROM normalized_quota_source AS source
WHERE gate.store_key=source.store_key AND gate.gate_type='quota';

CREATE INDEX IF NOT EXISTS shein_webhook_store_gate_state_idx
  ON ops.shein_webhook_store_gate (state, updated_at DESC);

-- Both the daily snapshot loaders and the targeted webhook loader compare this
-- source timestamp. A delayed older artifact may never overwrite newer facts.
DO $$
BEGIN
  IF to_regclass('fact.openapi_order_header') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE fact.openapi_order_header ADD COLUMN IF NOT EXISTS source_snapshot_at timestamptz';
  END IF;
  IF to_regclass('fact.openapi_order_item') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE fact.openapi_order_item ADD COLUMN IF NOT EXISTS source_snapshot_at timestamptz';
  END IF;
  IF to_regclass('fact.openapi_order_payment_flag') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE fact.openapi_order_payment_flag ADD COLUMN IF NOT EXISTS source_snapshot_at timestamptz';
  END IF;
  IF to_regclass('fact.openapi_return_order') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE fact.openapi_return_order ADD COLUMN IF NOT EXISTS source_snapshot_at timestamptz';
  END IF;
  IF to_regclass('fact.openapi_return_item') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE fact.openapi_return_item ADD COLUMN IF NOT EXISTS source_snapshot_at timestamptz';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION ops.reopen_shein_webhook_authorization_gate(
  p_store_key text,
  p_source_receipt_id bigint,
  p_reason text
) RETURNS TABLE(
  store_key text,
  gate_type text,
  state text,
  reason text,
  source_receipt_id bigint,
  source_event_order numeric,
  updated_at timestamptz,
  applied boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ops
AS $$
BEGIN
  IF btrim(COALESCE(p_store_key, '')) = '' THEN
    RAISE EXCEPTION 'store key is required';
  END IF;
  RETURN QUERY
  UPDATE ops.shein_webhook_store_gate AS gate SET
    state='open',
    reason=COALESCE(p_reason, ''),
    updated_at=clock_timestamp()
  WHERE gate.store_key=upper(btrim(p_store_key))
    AND gate.gate_type='authorization'
    AND gate.state='blocked'
    AND gate.source_receipt_id IS NOT DISTINCT FROM p_source_receipt_id
  RETURNING gate.store_key, gate.gate_type, gate.state, gate.reason,
    gate.source_receipt_id, gate.source_event_order, gate.updated_at, true;
  IF FOUND THEN RETURN; END IF;
  RETURN QUERY
  SELECT gate.store_key, gate.gate_type, gate.state, gate.reason,
    gate.source_receipt_id, gate.source_event_order, gate.updated_at, false
  FROM ops.shein_webhook_store_gate AS gate
  WHERE gate.store_key=upper(btrim(p_store_key)) AND gate.gate_type='authorization'
  LIMIT 1;
END
$$;

DROP FUNCTION IF EXISTS ops.delete_shein_webhook_order_children(text,text);
DROP FUNCTION IF EXISTS ops.delete_shein_webhook_return_children(text,text);

CREATE OR REPLACE FUNCTION ops.prepare_shein_webhook_order_replace(
  p_store_key text,
  p_order_no text,
  p_source_snapshot_at timestamptz
) RETURNS TABLE(applied boolean, items_deleted bigint, payment_flags_deleted bigint, existing_snapshot_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ops, fact
AS $$
DECLARE
  deleted_items bigint := 0;
  deleted_flags bigint := 0;
  current_snapshot timestamptz := NULL;
BEGIN
  IF btrim(COALESCE(p_store_key, '')) = '' OR btrim(COALESCE(p_order_no, '')) = ''
     OR length(p_store_key) > 32 OR length(p_order_no) > 128
     OR p_source_snapshot_at IS NULL THEN
    RAISE EXCEPTION 'invalid targeted order scope';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('shein-openapi-order:' || upper(btrim(p_store_key)), 0));
  SELECT max(source_snapshot_at) INTO current_snapshot
  FROM fact.openapi_order_header
  WHERE store_key=upper(btrim(p_store_key)) AND order_no=btrim(p_order_no);
  IF current_snapshot IS NOT NULL AND current_snapshot > p_source_snapshot_at THEN
    RETURN QUERY SELECT false, 0::bigint, 0::bigint, current_snapshot;
    RETURN;
  END IF;
  DELETE FROM fact.openapi_order_item
    WHERE store_key=upper(btrim(p_store_key)) AND order_no=btrim(p_order_no);
  GET DIAGNOSTICS deleted_items = ROW_COUNT;
  DELETE FROM fact.openapi_order_payment_flag
    WHERE store_key=upper(btrim(p_store_key)) AND order_no=btrim(p_order_no);
  GET DIAGNOSTICS deleted_flags = ROW_COUNT;
  RETURN QUERY SELECT true, deleted_items, deleted_flags, current_snapshot;
END
$$;

CREATE OR REPLACE FUNCTION ops.prepare_shein_webhook_return_replace(
  p_store_key text,
  p_return_order_no text,
  p_source_snapshot_at timestamptz
) RETURNS TABLE(applied boolean, items_deleted bigint, existing_snapshot_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ops, fact
AS $$
DECLARE
  deleted_items bigint := 0;
  current_snapshot timestamptz := NULL;
BEGIN
  IF btrim(COALESCE(p_store_key, '')) = '' OR btrim(COALESCE(p_return_order_no, '')) = ''
     OR length(p_store_key) > 32 OR length(p_return_order_no) > 128
     OR p_source_snapshot_at IS NULL THEN
    RAISE EXCEPTION 'invalid targeted return scope';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('shein-openapi-return:' || upper(btrim(p_store_key)), 0));
  SELECT max(source_snapshot_at) INTO current_snapshot
  FROM fact.openapi_return_order
  WHERE store_key=upper(btrim(p_store_key)) AND return_order_no=btrim(p_return_order_no);
  IF current_snapshot IS NOT NULL AND current_snapshot > p_source_snapshot_at THEN
    RETURN QUERY SELECT false, 0::bigint, current_snapshot;
    RETURN;
  END IF;
  DELETE FROM fact.openapi_return_item
    WHERE store_key=upper(btrim(p_store_key)) AND return_order_no=btrim(p_return_order_no);
  GET DIAGNOSTICS deleted_items = ROW_COUNT;
  RETURN QUERY SELECT true, deleted_items, current_snapshot;
END
$$;

-- The worker never receives raw fact-table DML. These two SECURITY DEFINER
-- entry points validate one exact store/order scope, enforce monotonic source
-- versions and atomically replace only that scope.
CREATE OR REPLACE FUNCTION ops.apply_shein_webhook_order_snapshot(
  p_store_key text,
  p_order_no text,
  p_source_snapshot_at timestamptz,
  p_headers jsonb,
  p_items jsonb,
  p_payment_flags jsonb
) RETURNS TABLE(
  applied boolean,
  headers_written bigint,
  items_written bigint,
  payment_flags_written bigint,
  existing_snapshot_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ops, fact
AS $$
DECLARE
  v_store text := upper(btrim(COALESCE(p_store_key, '')));
  v_order text := btrim(COALESCE(p_order_no, ''));
  v_headers jsonb;
  v_items jsonb;
  v_flags jsonb;
  v_header_key text;
  v_applied boolean;
  v_existing timestamptz;
  v_headers_written bigint := 0;
  v_items_written bigint := 0;
  v_flags_written bigint := 0;
BEGIN
  IF v_store='' OR v_order='' OR length(v_store)>32 OR length(v_order)>128 OR p_source_snapshot_at IS NULL THEN
    RAISE EXCEPTION 'invalid targeted order scope';
  END IF;
  IF jsonb_typeof(p_headers) IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_items) IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_payment_flags) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'targeted order rows must be JSON arrays';
  END IF;
  IF jsonb_array_length(p_headers)<>1 OR jsonb_array_length(p_items)<1 OR jsonb_array_length(p_payment_flags)>1 THEN
    RAISE EXCEPTION 'targeted order requires one header, at least one item and at most one payment flag';
  END IF;

  SELECT COALESCE(jsonb_agg(value || jsonb_build_object('updated_at', clock_timestamp())), '[]'::jsonb)
    INTO v_headers FROM jsonb_array_elements(p_headers);
  SELECT COALESCE(jsonb_agg(value || jsonb_build_object('updated_at', clock_timestamp())), '[]'::jsonb)
    INTO v_items FROM jsonb_array_elements(p_items);
  SELECT COALESCE(jsonb_agg(value || jsonb_build_object('updated_at', clock_timestamp())), '[]'::jsonb)
    INTO v_flags FROM jsonb_array_elements(p_payment_flags);

  SELECT incoming.order_key INTO v_header_key
  FROM jsonb_populate_recordset(NULL::fact.openapi_order_header, v_headers) AS incoming;
  IF btrim(COALESCE(v_header_key, ''))='' THEN RAISE EXCEPTION 'targeted order header key is required'; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_populate_recordset(NULL::fact.openapi_order_header, v_headers) AS incoming
    WHERE incoming.store_key IS DISTINCT FROM v_store
       OR incoming.order_no IS DISTINCT FROM v_order
       OR incoming.source_snapshot_at IS DISTINCT FROM p_source_snapshot_at
  ) THEN RAISE EXCEPTION 'targeted order header escaped requested scope'; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_populate_recordset(NULL::fact.openapi_order_item, v_items) AS incoming
    WHERE incoming.store_key IS DISTINCT FROM v_store
       OR incoming.order_no IS DISTINCT FROM v_order
       OR incoming.order_key IS DISTINCT FROM v_header_key
       OR incoming.source_snapshot_at IS DISTINCT FROM p_source_snapshot_at
       OR btrim(COALESCE(incoming.order_item_key, ''))=''
  ) THEN RAISE EXCEPTION 'targeted order item escaped requested scope'; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_populate_recordset(NULL::fact.openapi_order_payment_flag, v_flags) AS incoming
    WHERE incoming.store_key IS DISTINCT FROM v_store
       OR incoming.order_no IS DISTINCT FROM v_order
       OR incoming.order_key IS DISTINCT FROM v_header_key
       OR incoming.source_snapshot_at IS DISTINCT FROM p_source_snapshot_at
  ) THEN RAISE EXCEPTION 'targeted order payment flag escaped requested scope'; END IF;

  IF EXISTS (
    SELECT 1 FROM fact.openapi_order_header AS existing
    WHERE existing.order_key=v_header_key
      AND (existing.store_key IS DISTINCT FROM v_store OR existing.order_no IS DISTINCT FROM v_order)
  ) OR EXISTS (
    SELECT 1
    FROM fact.openapi_order_item AS existing
    JOIN jsonb_populate_recordset(NULL::fact.openapi_order_item, v_items) AS incoming
      ON incoming.order_item_key=existing.order_item_key
    WHERE existing.store_key IS DISTINCT FROM v_store OR existing.order_no IS DISTINCT FROM v_order
  ) OR EXISTS (
    SELECT 1
    FROM fact.openapi_order_payment_flag AS existing
    JOIN jsonb_populate_recordset(NULL::fact.openapi_order_payment_flag, v_flags) AS incoming
      ON incoming.order_key=existing.order_key
    WHERE existing.store_key IS DISTINCT FROM v_store OR existing.order_no IS DISTINCT FROM v_order
  ) THEN RAISE EXCEPTION 'targeted order key conflicts with another scope'; END IF;

  SELECT prep.applied, prep.existing_snapshot_at
    INTO v_applied, v_existing
  FROM ops.prepare_shein_webhook_order_replace(v_store, v_order, p_source_snapshot_at) AS prep;
  IF NOT COALESCE(v_applied, false) THEN
    RETURN QUERY SELECT false, 0::bigint, 0::bigint, 0::bigint, v_existing;
    RETURN;
  END IF;

  DELETE FROM fact.openapi_order_header WHERE store_key=v_store AND order_no=v_order;
  INSERT INTO fact.openapi_order_header
    SELECT incoming.* FROM jsonb_populate_recordset(NULL::fact.openapi_order_header, v_headers) AS incoming;
  GET DIAGNOSTICS v_headers_written = ROW_COUNT;
  INSERT INTO fact.openapi_order_item
    SELECT incoming.* FROM jsonb_populate_recordset(NULL::fact.openapi_order_item, v_items) AS incoming;
  GET DIAGNOSTICS v_items_written = ROW_COUNT;
  INSERT INTO fact.openapi_order_payment_flag
    SELECT incoming.* FROM jsonb_populate_recordset(NULL::fact.openapi_order_payment_flag, v_flags) AS incoming;
  GET DIAGNOSTICS v_flags_written = ROW_COUNT;
  RETURN QUERY SELECT true, v_headers_written, v_items_written, v_flags_written, v_existing;
END
$$;

CREATE OR REPLACE FUNCTION ops.apply_shein_webhook_return_snapshot(
  p_store_key text,
  p_return_order_no text,
  p_source_snapshot_at timestamptz,
  p_headers jsonb,
  p_items jsonb
) RETURNS TABLE(
  applied boolean,
  headers_written bigint,
  items_written bigint,
  existing_snapshot_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ops, fact
AS $$
DECLARE
  v_store text := upper(btrim(COALESCE(p_store_key, '')));
  v_return text := btrim(COALESCE(p_return_order_no, ''));
  v_headers jsonb;
  v_items jsonb;
  v_header_key text;
  v_applied boolean;
  v_existing timestamptz;
  v_headers_written bigint := 0;
  v_items_written bigint := 0;
BEGIN
  IF v_store='' OR v_return='' OR length(v_store)>32 OR length(v_return)>128 OR p_source_snapshot_at IS NULL THEN
    RAISE EXCEPTION 'invalid targeted return scope';
  END IF;
  IF jsonb_typeof(p_headers) IS DISTINCT FROM 'array' OR jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'targeted return rows must be JSON arrays';
  END IF;
  IF jsonb_array_length(p_headers)<>1 OR jsonb_array_length(p_items)<1 THEN
    RAISE EXCEPTION 'targeted return requires one header and at least one item';
  END IF;

  SELECT COALESCE(jsonb_agg(value || jsonb_build_object('updated_at', clock_timestamp())), '[]'::jsonb)
    INTO v_headers FROM jsonb_array_elements(p_headers);
  SELECT COALESCE(jsonb_agg(value || jsonb_build_object('updated_at', clock_timestamp())), '[]'::jsonb)
    INTO v_items FROM jsonb_array_elements(p_items);

  SELECT incoming.return_order_key INTO v_header_key
  FROM jsonb_populate_recordset(NULL::fact.openapi_return_order, v_headers) AS incoming;
  IF btrim(COALESCE(v_header_key, ''))='' THEN RAISE EXCEPTION 'targeted return header key is required'; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_populate_recordset(NULL::fact.openapi_return_order, v_headers) AS incoming
    WHERE incoming.store_key IS DISTINCT FROM v_store
       OR incoming.return_order_no IS DISTINCT FROM v_return
       OR incoming.source_snapshot_at IS DISTINCT FROM p_source_snapshot_at
  ) THEN RAISE EXCEPTION 'targeted return header escaped requested scope'; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_populate_recordset(NULL::fact.openapi_return_item, v_items) AS incoming
    WHERE incoming.store_key IS DISTINCT FROM v_store
       OR incoming.return_order_no IS DISTINCT FROM v_return
       OR incoming.return_order_key IS DISTINCT FROM v_header_key
       OR incoming.source_snapshot_at IS DISTINCT FROM p_source_snapshot_at
       OR btrim(COALESCE(incoming.return_item_key, ''))=''
  ) THEN RAISE EXCEPTION 'targeted return item escaped requested scope'; END IF;

  IF EXISTS (
    SELECT 1 FROM fact.openapi_return_order AS existing
    WHERE existing.return_order_key=v_header_key
      AND (existing.store_key IS DISTINCT FROM v_store OR existing.return_order_no IS DISTINCT FROM v_return)
  ) OR EXISTS (
    SELECT 1
    FROM fact.openapi_return_item AS existing
    JOIN jsonb_populate_recordset(NULL::fact.openapi_return_item, v_items) AS incoming
      ON incoming.return_item_key=existing.return_item_key
    WHERE existing.store_key IS DISTINCT FROM v_store OR existing.return_order_no IS DISTINCT FROM v_return
  ) THEN RAISE EXCEPTION 'targeted return key conflicts with another scope'; END IF;

  SELECT prep.applied, prep.existing_snapshot_at
    INTO v_applied, v_existing
  FROM ops.prepare_shein_webhook_return_replace(v_store, v_return, p_source_snapshot_at) AS prep;
  IF NOT COALESCE(v_applied, false) THEN
    RETURN QUERY SELECT false, 0::bigint, 0::bigint, v_existing;
    RETURN;
  END IF;

  DELETE FROM fact.openapi_return_order WHERE store_key=v_store AND return_order_no=v_return;
  INSERT INTO fact.openapi_return_order
    SELECT incoming.* FROM jsonb_populate_recordset(NULL::fact.openapi_return_order, v_headers) AS incoming;
  GET DIAGNOSTICS v_headers_written = ROW_COUNT;
  INSERT INTO fact.openapi_return_item
    SELECT incoming.* FROM jsonb_populate_recordset(NULL::fact.openapi_return_item, v_items) AS incoming;
  GET DIAGNOSTICS v_items_written = ROW_COUNT;
  RETURN QUERY SELECT true, v_headers_written, v_items_written, v_existing;
END
$$;

REVOKE ALL ON FUNCTION ops.reopen_shein_webhook_authorization_gate(text,bigint,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.prepare_shein_webhook_order_replace(text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.prepare_shein_webhook_return_replace(text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.apply_shein_webhook_order_snapshot(text,text,timestamptz,jsonb,jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.apply_shein_webhook_return_snapshot(text,text,timestamptz,jsonb,jsonb) FROM PUBLIC;

-- Portal and webhook worker deliberately use separate roles.  The portal may
-- read only the safe projection columns and call the exact-source
-- authorization recovery function; it cannot read ciphertext, mutate gates
-- arbitrarily, or replace order/return facts.  Provision
-- the shein_webhook_ops LOGIN/password out of band, then rerun this migration
-- if the role did not exist during an initial schema bootstrap.
DO $$
DECLARE
  receipt_sequence text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shein_link_ops') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA ops TO shein_link_ops';
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE ops.shein_webhook_receipt FROM shein_link_ops';
    EXECUTE 'GRANT SELECT (id, received_at, processed_at, store_key, event_code, normalized, severity, status, title, summary, business_key, action_state, duplicate_count) ON TABLE ops.shein_webhook_receipt TO shein_link_ops';
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE ops.shein_webhook_store_gate FROM shein_link_ops';
    EXECUTE 'GRANT SELECT ON TABLE ops.shein_webhook_store_gate TO shein_link_ops';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ops.reopen_shein_webhook_authorization_gate(text,bigint,text) TO shein_link_ops';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shein_webhook_ops') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA ops TO shein_webhook_ops';
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE ops.shein_webhook_receipt FROM shein_webhook_ops';
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE ops.shein_webhook_store_gate FROM shein_webhook_ops';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE ops.shein_webhook_receipt TO shein_webhook_ops';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE ops.shein_webhook_store_gate TO shein_webhook_ops';
    SELECT pg_get_serial_sequence('ops.shein_webhook_receipt', 'id')
      INTO receipt_sequence;
    IF receipt_sequence IS NOT NULL THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON SEQUENCE %s FROM shein_webhook_ops',
        receipt_sequence
      );
      EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE %s TO shein_webhook_ops',
        receipt_sequence
      );
    END IF;

    IF to_regclass('fact.openapi_order_header') IS NOT NULL THEN
      EXECUTE 'GRANT USAGE ON SCHEMA fact TO shein_webhook_ops';
      EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE fact.openapi_order_header FROM shein_webhook_ops';
      EXECUTE 'GRANT SELECT ON TABLE fact.openapi_order_header TO shein_webhook_ops';
    END IF;
    IF to_regclass('fact.openapi_order_item') IS NOT NULL THEN
      EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE fact.openapi_order_item FROM shein_webhook_ops';
      EXECUTE 'GRANT SELECT ON TABLE fact.openapi_order_item TO shein_webhook_ops';
    END IF;
    IF to_regclass('fact.openapi_order_payment_flag') IS NOT NULL THEN
      EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE fact.openapi_order_payment_flag FROM shein_webhook_ops';
      EXECUTE 'GRANT SELECT ON TABLE fact.openapi_order_payment_flag TO shein_webhook_ops';
    END IF;
    IF to_regclass('fact.openapi_return_order') IS NOT NULL THEN
      EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE fact.openapi_return_order FROM shein_webhook_ops';
      EXECUTE 'GRANT SELECT ON TABLE fact.openapi_return_order TO shein_webhook_ops';
    END IF;
    IF to_regclass('fact.openapi_return_item') IS NOT NULL THEN
      EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE fact.openapi_return_item FROM shein_webhook_ops';
      EXECUTE 'GRANT SELECT ON TABLE fact.openapi_return_item TO shein_webhook_ops';
    END IF;
    EXECUTE 'REVOKE ALL ON FUNCTION ops.prepare_shein_webhook_order_replace(text,text,timestamptz) FROM shein_webhook_ops';
    EXECUTE 'REVOKE ALL ON FUNCTION ops.prepare_shein_webhook_return_replace(text,text,timestamptz) FROM shein_webhook_ops';
    EXECUTE 'REVOKE ALL ON FUNCTION ops.apply_shein_webhook_order_snapshot(text,text,timestamptz,jsonb,jsonb,jsonb) FROM shein_webhook_ops';
    EXECUTE 'REVOKE ALL ON FUNCTION ops.apply_shein_webhook_return_snapshot(text,text,timestamptz,jsonb,jsonb) FROM shein_webhook_ops';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ops.apply_shein_webhook_order_snapshot(text,text,timestamptz,jsonb,jsonb,jsonb) TO shein_webhook_ops';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ops.apply_shein_webhook_return_snapshot(text,text,timestamptz,jsonb,jsonb) TO shein_webhook_ops';
  END IF;
END
$$;

COMMIT;
