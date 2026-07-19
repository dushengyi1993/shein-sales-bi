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
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (store_key, gate_type)
);

CREATE INDEX IF NOT EXISTS shein_webhook_store_gate_state_idx
  ON ops.shein_webhook_store_gate (state, updated_at DESC);

-- Portal and webhook worker deliberately use separate roles.  The portal may
-- read only the safe projection columns and maintain the small write-gate
-- table; it cannot read ciphertext or replace order/return facts.  Provision
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
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE ops.shein_webhook_store_gate TO shein_link_ops';

    IF to_regclass('fact.openapi_order_header') IS NOT NULL THEN
      EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE fact.openapi_order_header FROM shein_link_ops';
    END IF;
    IF to_regclass('fact.openapi_order_item') IS NOT NULL THEN
      EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE fact.openapi_order_item FROM shein_link_ops';
    END IF;
    IF to_regclass('fact.openapi_order_payment_flag') IS NOT NULL THEN
      EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE fact.openapi_order_payment_flag FROM shein_link_ops';
    END IF;
    IF to_regclass('fact.openapi_return_order') IS NOT NULL THEN
      EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE fact.openapi_return_order FROM shein_link_ops';
    END IF;
    IF to_regclass('fact.openapi_return_item') IS NOT NULL THEN
      EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE fact.openapi_return_item FROM shein_link_ops';
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shein_webhook_ops') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA ops TO shein_webhook_ops';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE ops.shein_webhook_receipt TO shein_webhook_ops';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE ops.shein_webhook_store_gate TO shein_webhook_ops';
    SELECT pg_get_serial_sequence('ops.shein_webhook_receipt', 'id')
      INTO receipt_sequence;
    IF receipt_sequence IS NOT NULL THEN
      EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE %s TO shein_webhook_ops',
        receipt_sequence
      );
    END IF;

    IF to_regclass('fact.openapi_order_header') IS NOT NULL THEN
      EXECUTE 'GRANT USAGE ON SCHEMA fact TO shein_webhook_ops';
      EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE fact.openapi_order_header TO shein_webhook_ops';
    END IF;
    IF to_regclass('fact.openapi_order_item') IS NOT NULL THEN
      EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE fact.openapi_order_item TO shein_webhook_ops';
    END IF;
    IF to_regclass('fact.openapi_order_payment_flag') IS NOT NULL THEN
      EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE fact.openapi_order_payment_flag TO shein_webhook_ops';
    END IF;
    IF to_regclass('fact.openapi_return_order') IS NOT NULL THEN
      EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE fact.openapi_return_order TO shein_webhook_ops';
    END IF;
    IF to_regclass('fact.openapi_return_item') IS NOT NULL THEN
      EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE fact.openapi_return_item TO shein_webhook_ops';
    END IF;
  END IF;
END
$$;

COMMIT;
