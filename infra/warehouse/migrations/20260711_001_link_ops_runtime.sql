BEGIN;

SELECT pg_advisory_xact_lock(hashtextextended('shein-link-ops-schema-migration', 0));

CREATE SCHEMA IF NOT EXISTS ops;

CREATE TABLE IF NOT EXISTS ops.link_ops_migration (
  version text PRIMARY KEY CHECK (btrim(version) <> ''),
  migration_hash text NOT NULL DEFAULT '',
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_by text NOT NULL DEFAULT current_user,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object')
);

CREATE TABLE IF NOT EXISTS ops.link_ops_meta (
  meta_key text PRIMARY KEY CHECK (btrim(meta_key) <> ''),
  owner_user text NOT NULL DEFAULT '',
  actor_user text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  record jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(record) = 'object'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS link_ops_meta_status_updated_idx
  ON ops.link_ops_meta (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS ops.link_ops_import_batch (
  batch_id text PRIMARY KEY CHECK (btrim(batch_id) <> ''),
  idempotency_key text NOT NULL UNIQUE CHECK (btrim(idempotency_key) <> ''),
  migration_version text NOT NULL REFERENCES ops.link_ops_migration(version),
  source_kind text NOT NULL DEFAULT 'json',
  status text NOT NULL CHECK (status IN ('prepared', 'running', 'succeeded', 'failed')),
  actor_user text NOT NULL DEFAULT '',
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  counts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counts) = 'object'),
  error jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(error) = 'object'),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS link_ops_import_batch_status_created_idx
  ON ops.link_ops_import_batch (status, created_at DESC);

CREATE TABLE IF NOT EXISTS ops.link_ops_session (
  session_id text PRIMARY KEY CHECK (btrim(session_id) <> ''),
  owner_user text NOT NULL CHECK (btrim(owner_user) <> ''),
  actor_user text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  idempotency_key text,
  sort_order bigint NOT NULL DEFAULT 0,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  import_batch_id text REFERENCES ops.link_ops_import_batch(batch_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS link_ops_session_idempotency_uidx
  ON ops.link_ops_session (owner_user, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS link_ops_session_owner_updated_idx
  ON ops.link_ops_session (owner_user, sort_order, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS link_ops_session_status_updated_idx
  ON ops.link_ops_session (status, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS ops.link_ops_message (
  message_id text PRIMARY KEY CHECK (btrim(message_id) <> ''),
  chat_session_id text NOT NULL REFERENCES ops.link_ops_session(session_id) ON DELETE CASCADE,
  owner_user text NOT NULL CHECK (btrim(owner_user) <> ''),
  actor_user text NOT NULL DEFAULT '',
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  status text NOT NULL DEFAULT 'created',
  sequence_no bigint NOT NULL CHECK (sequence_no >= 0),
  idempotency_key text,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  import_batch_id text REFERENCES ops.link_ops_import_batch(batch_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (chat_session_id, sequence_no)
);

CREATE UNIQUE INDEX IF NOT EXISTS link_ops_message_idempotency_uidx
  ON ops.link_ops_message (chat_session_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS link_ops_message_session_sequence_idx
  ON ops.link_ops_message (chat_session_id, sequence_no, created_at);
CREATE INDEX IF NOT EXISTS link_ops_message_owner_created_idx
  ON ops.link_ops_message (owner_user, created_at DESC);

CREATE TABLE IF NOT EXISTS ops.link_ops_task (
  task_id text PRIMARY KEY CHECK (btrim(task_id) <> ''),
  owner_user text NOT NULL CHECK (btrim(owner_user) <> ''),
  actor_user text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT '',
  chat_session_id text REFERENCES ops.link_ops_session(session_id) ON DELETE SET NULL,
  intents text[] NOT NULL DEFAULT ARRAY[]::text[],
  source_stores text[] NOT NULL DEFAULT ARRAY[]::text[],
  write_stores text[] NOT NULL DEFAULT ARRAY[]::text[],
  product_refs text[] NOT NULL DEFAULT ARRAY[]::text[],
  idempotency_key text,
  sort_order bigint NOT NULL DEFAULT 0,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  import_batch_id text REFERENCES ops.link_ops_import_batch(batch_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS link_ops_task_idempotency_uidx
  ON ops.link_ops_task (owner_user, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS link_ops_task_owner_updated_idx
  ON ops.link_ops_task (owner_user, sort_order, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS link_ops_task_actor_updated_idx
  ON ops.link_ops_task (actor_user, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS link_ops_task_status_updated_idx
  ON ops.link_ops_task (status, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS link_ops_task_chat_session_idx
  ON ops.link_ops_task (chat_session_id, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS link_ops_task_intents_idx
  ON ops.link_ops_task USING gin (intents);
CREATE INDEX IF NOT EXISTS link_ops_task_write_stores_idx
  ON ops.link_ops_task USING gin (write_stores);

CREATE TABLE IF NOT EXISTS ops.link_ops_record (
  record_type text NOT NULL CHECK (btrim(record_type) <> ''),
  record_id text NOT NULL CHECK (btrim(record_id) <> ''),
  owner_user text NOT NULL CHECK (btrim(owner_user) <> ''),
  actor_user text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT '',
  chat_session_id text REFERENCES ops.link_ops_session(session_id) ON DELETE SET NULL,
  idempotency_key text,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  import_batch_id text REFERENCES ops.link_ops_import_batch(batch_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  PRIMARY KEY (record_type, record_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS link_ops_record_idempotency_uidx
  ON ops.link_ops_record (record_type, owner_user, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS link_ops_record_owner_type_updated_idx
  ON ops.link_ops_record (owner_user, record_type, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS link_ops_record_chat_session_idx
  ON ops.link_ops_record (chat_session_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS ops.link_ops_job (
  job_id text PRIMARY KEY CHECK (btrim(job_id) <> ''),
  task_id text REFERENCES ops.link_ops_task(task_id) ON DELETE SET NULL,
  chat_session_id text REFERENCES ops.link_ops_session(session_id) ON DELETE SET NULL,
  owner_user text NOT NULL CHECK (btrim(owner_user) <> ''),
  actor_user text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'uncertain_write')),
  idempotency_key text NOT NULL CHECK (btrim(idempotency_key) <> ''),
  lease_owner text NOT NULL DEFAULT '',
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  write_boundary text NOT NULL DEFAULT 'none' CHECK (btrim(write_boundary) <> ''),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  result jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result) = 'object'),
  error jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(error) = 'object'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  queued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (status <> 'running' OR (btrim(lease_owner) <> '' AND lease_expires_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS link_ops_job_idempotency_uidx
  ON ops.link_ops_job (owner_user, idempotency_key);
CREATE INDEX IF NOT EXISTS link_ops_job_queue_idx
  ON ops.link_ops_job (status, queued_at, job_id)
  WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS link_ops_job_lease_idx
  ON ops.link_ops_job (lease_expires_at, heartbeat_at)
  WHERE status = 'running';
CREATE INDEX IF NOT EXISTS link_ops_job_task_idx
  ON ops.link_ops_job (task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS link_ops_job_chat_session_idx
  ON ops.link_ops_job (chat_session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ops.link_ops_event (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_key text,
  aggregate_type text NOT NULL CHECK (btrim(aggregate_type) <> ''),
  aggregate_id text NOT NULL CHECK (btrim(aggregate_id) <> ''),
  event_type text NOT NULL CHECK (btrim(event_type) <> ''),
  owner_user text NOT NULL DEFAULT '',
  actor_user text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT '',
  chat_session_id text,
  task_id text,
  job_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX IF NOT EXISTS link_ops_event_key_uidx
  ON ops.link_ops_event (event_key)
  WHERE event_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS link_ops_event_aggregate_idx
  ON ops.link_ops_event (aggregate_type, aggregate_id, event_id);
CREATE INDEX IF NOT EXISTS link_ops_event_task_idx
  ON ops.link_ops_event (task_id, event_id)
  WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS link_ops_event_job_idx
  ON ops.link_ops_event (job_id, event_id)
  WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS link_ops_event_chat_session_idx
  ON ops.link_ops_event (chat_session_id, event_id)
  WHERE chat_session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ops.link_ops_idempotency (
  scope text NOT NULL CHECK (btrim(scope) <> ''),
  idempotency_key text NOT NULL CHECK (btrim(idempotency_key) <> ''),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  entity_type text NOT NULL CHECK (btrim(entity_type) <> ''),
  entity_id text NOT NULL CHECK (btrim(entity_id) <> ''),
  response jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(response) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (scope, idempotency_key)
);

CREATE INDEX IF NOT EXISTS link_ops_idempotency_entity_idx
  ON ops.link_ops_idempotency (entity_type, entity_id);

CREATE OR REPLACE FUNCTION ops.reject_link_ops_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ops.link_ops_event is append-only';
END;
$$;

DROP TRIGGER IF EXISTS link_ops_event_append_only ON ops.link_ops_event;
CREATE TRIGGER link_ops_event_append_only
BEFORE UPDATE OR DELETE ON ops.link_ops_event
FOR EACH ROW EXECUTE FUNCTION ops.reject_link_ops_event_mutation();

INSERT INTO ops.link_ops_migration(version, details)
VALUES (
  '20260711_001_link_ops_runtime',
  '{"rowLevel":true,"documentJsonb":false,"source":"infra/warehouse/migrations/20260711_001_link_ops_runtime.sql"}'::jsonb
)
ON CONFLICT (version) DO NOTHING;

COMMIT;
