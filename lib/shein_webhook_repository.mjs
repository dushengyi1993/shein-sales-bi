import {
  checkWarehousePg,
  closeWarehousePg,
  createWarehousePgPool,
  withPgClient,
  withPgTransaction,
} from './warehouse_pg.mjs';

export const SHEIN_WEBHOOK_MIGRATION_VERSION = '20260719_001_shein_webhook_runtime';
export const SHEIN_WEBHOOK_STATUSES = Object.freeze(['queued', 'running', 'succeeded', 'failed', 'retry', 'dead_letter']);

const STATUS_SET = new Set(SHEIN_WEBHOOK_STATUSES);
const SEVERITY_SET = new Set(['P0', 'P1', 'P2', 'P3']);

export class SheinWebhookRepositoryError extends Error {
  constructor(message, {code = 'SHEIN_WEBHOOK_REPOSITORY', details} = {}) {
    super(message);
    this.name = 'SheinWebhookRepositoryError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function text(value) { return String(value ?? '').trim(); }
function required(value, label) {
  const result = text(value);
  if (!result) throw new SheinWebhookRepositoryError(`${label} is required`, {code: 'SHEIN_WEBHOOK_VALIDATION'});
  return result;
}
function json(value, label, fallback = {}) {
  const actual = value === undefined ? fallback : value;
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
    throw new SheinWebhookRepositoryError(`${label} must be a JSON object`, {code: 'SHEIN_WEBHOOK_VALIDATION'});
  }
  try { return JSON.stringify(actual); }
  catch { throw new SheinWebhookRepositoryError(`${label} must be JSON serializable`, {code: 'SHEIN_WEBHOOK_VALIDATION'}); }
}
function timestamp(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new SheinWebhookRepositoryError(`${label} must be a valid timestamp`, {code: 'SHEIN_WEBHOOK_VALIDATION'});
  return date.toISOString();
}
function positiveInteger(value, label, {min = 1, max = 86_400_000} = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new SheinWebhookRepositoryError(`${label} must be an integer between ${min} and ${max}`, {code: 'SHEIN_WEBHOOK_VALIDATION'});
  }
  return number;
}
function eventOrder(value, label = 'sourceEventOrder') {
  if (value === undefined || value === null || value === '') return null;
  const result = text(value);
  if (!/^\d{1,30}$/.test(result)) {
    throw new SheinWebhookRepositoryError(`${label} must be a positive decimal ordering key`, {code: 'SHEIN_WEBHOOK_VALIDATION'});
  }
  return result;
}
function status(value) {
  const result = required(value, 'status');
  if (!STATUS_SET.has(result)) throw new SheinWebhookRepositoryError(`Unsupported webhook status: ${result}`, {code: 'SHEIN_WEBHOOK_VALIDATION'});
  return result;
}
function severity(value, fallback = 'P3') {
  const result = text(value || fallback).toUpperCase();
  if (!SEVERITY_SET.has(result)) throw new SheinWebhookRepositoryError(`Unsupported webhook severity: ${result}`, {code: 'SHEIN_WEBHOOK_VALIDATION'});
  return result;
}
function parseJson(value, fallback = {}) {
  if (value === null || value === undefined || value === '') return fallback;
  return typeof value === 'string' ? JSON.parse(value) : value;
}
function iso(value) { return value ? new Date(value).toISOString() : null; }

function rowToReceipt(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    idempotencyKey: row.idempotency_key,
    eventCode: row.event_code,
    storeKey: row.store_key,
    platformTimestamp: iso(row.platform_timestamp),
    cipherHash: row.cipher_hash,
    normalized: parseJson(row.normalized),
    severity: row.severity,
    status: row.status,
    leaseOwner: row.lease_owner || null,
    leaseExpiresAt: iso(row.lease_expires_at),
    attempt: Number(row.attempt || 0),
    error: parseJson(row.error),
    nextAttemptAt: iso(row.next_attempt_at),
    receivedAt: iso(row.received_at),
    processedAt: iso(row.processed_at),
    alertedAt: iso(row.alerted_at),
    title: row.title || '',
    summary: row.summary || '',
    businessKey: row.business_key || '',
    actionState: row.action_state || '',
    duplicate: Boolean(row.duplicate ?? Number(row.duplicate_count || 0) > 0),
  };
}

function rowToWorkItem(row) {
  if (!row) return null;
  return {
    ...rowToReceipt(row),
    appId: row.app_id || '',
    openKeyId: row.open_key_id || '',
    eventData: row.event_data || '',
  };
}

function rowToFrontendEvent(row) {
  return {
    id: String(row.id),
    receivedAt: iso(row.received_at),
    processedAt: iso(row.processed_at),
    storeKey: row.store_key,
    eventCode: row.event_code,
    eventType: row.event_type || '',
    severity: row.severity,
    status: row.status,
    title: row.title || '',
    summary: row.summary || '',
    businessKey: row.business_key || '',
    actionState: row.action_state || '',
    duplicate: Boolean(row.duplicate),
  };
}

function allowedStoreScope(allowedStores, values, column = 'store_key') {
  if (allowedStores === '*') return 'TRUE';
  const stores = Array.isArray(allowedStores) ? [...new Set(allowedStores.map(text).filter(Boolean))] : [];
  if (!stores.length) return 'FALSE';
  values.push(stores);
  return `${column} = ANY($${values.length}::text[])`;
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    const id = Number(decoded?.id);
    const receivedAt = timestamp(decoded?.receivedAt, 'cursor.receivedAt');
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('bad id');
    return {id, receivedAt};
  } catch {
    throw new SheinWebhookRepositoryError('cursor is invalid', {code: 'SHEIN_WEBHOOK_VALIDATION'});
  }
}
function encodeCursor(row) {
  return Buffer.from(JSON.stringify({receivedAt: iso(row.received_at), id: String(row.id)})).toString('base64url');
}

function mapGate(row) {
  if (!row) return null;
  const gate = {
    storeKey: row.store_key,
    gateType: row.gate_type,
    state: row.state,
    reason: row.reason || '',
    sourceReceiptId: row.source_receipt_id === null ? null : String(row.source_receipt_id),
    sourceEventOrder: row.source_event_order === null || row.source_event_order === undefined ? null : String(row.source_event_order),
    updatedAt: iso(row.updated_at),
  };
  // Only upsertStoreGate returns this field.  Reads keep their stable public
  // shape, while handlers can distinguish an applied transition from a stale
  // receipt that was deliberately ignored.
  if (row.applied !== undefined) gate.applied = Boolean(row.applied);
  return gate;
}

/** PostgreSQL-only receiver/worker repository. It deliberately has no file fallback. */
export function createSheinWebhookRepository({pool, env = process.env, PoolClass} = {}) {
  const source = pool || createWarehousePgPool({env, ...(PoolClass ? {PoolClass} : {})});
  // Receipt writes and claims need independent concurrent transactions. In
  // particular, a repository-wide advisory lock would defeat SKIP LOCKED.
  const transaction = (_operation, callback) => withPgTransaction(source, callback);

  async function storeReceipt(input = {}) {
    const normalized = json(input.normalized, 'normalized');
    const eventData = required(input.eventData ?? input.event_data, 'eventData');
    const platformTimestamp = timestamp(input.platformTimestamp ?? input.platform_timestamp, 'platformTimestamp');
    const statementTimeoutMs = input.statementTimeoutMs === undefined
      ? null
      : positiveInteger(input.statementTimeoutMs, 'statementTimeoutMs', {min: 50, max: 5_000});
    const result = await transaction('store-receipt', async client => {
      if (statementTimeoutMs !== null) {
        await client.query({
          name: 'shein-webhook-receipt-statement-timeout',
          text: "SELECT set_config('statement_timeout', $1::text, true)",
          values: [`${statementTimeoutMs}ms`],
        });
      }
      return client.query({
        name: 'shein-webhook-store-receipt',
        text: `/* shein_webhook:store_receipt:receipt_and_queue */
          INSERT INTO ops.shein_webhook_receipt(
            idempotency_key, app_id, open_key_id, event_code, store_key, platform_timestamp,
            cipher_hash, event_data, normalized, severity, status, title, summary, business_key, action_state
          ) VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7,$8,$9::jsonb,$10,'queued',$11,$12,$13,$14)
          ON CONFLICT (idempotency_key) DO UPDATE SET
            duplicate_count=ops.shein_webhook_receipt.duplicate_count+1,
            last_duplicate_at=clock_timestamp()
          RETURNING *, (duplicate_count > 0) AS duplicate`,
        values: [
          required(input.idempotencyKey ?? input.idempotency_key, 'idempotencyKey'), text(input.appId ?? input.app_id),
          text(input.openKeyId ?? input.open_key_id), required(input.eventCode ?? input.event_code, 'eventCode'),
          text(input.storeKey ?? input.store_key), platformTimestamp, required(input.cipherHash ?? input.cipher_hash, 'cipherHash'),
          eventData, normalized, severity(input.severity), text(input.title), text(input.summary), text(input.businessKey ?? input.business_key), text(input.actionState ?? input.action_state),
        ],
      });
    });
    const receipt = rowToReceipt(result.rows?.[0]);
    if (!receipt) throw new SheinWebhookRepositoryError('Receipt insert returned no row');
    return {receipt, duplicate: receipt.duplicate};
  }

  async function claimNext({workerId, leaseMs = 60_000} = {}) {
    const worker = required(workerId, 'workerId');
    const lease = positiveInteger(leaseMs, 'leaseMs');
    const result = await transaction('claim-next', client => client.query({
      name: 'shein-webhook-claim-next',
      text: `/* shein_webhook:claim_next */
        WITH candidate AS (
          SELECT id FROM ops.shein_webhook_receipt
          WHERE (status IN ('queued','retry') AND (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp()))
             OR (status='running' AND lease_expires_at <= clock_timestamp())
          ORDER BY CASE severity WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END, received_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE ops.shein_webhook_receipt receipt SET
          status='running', lease_owner=$1, lease_expires_at=clock_timestamp() + ($2::bigint * interval '1 millisecond'),
          attempt=receipt.attempt+1, next_attempt_at=NULL
        FROM candidate WHERE receipt.id=candidate.id
        RETURNING receipt.*`,
      values: [worker, lease],
    }));
    return rowToWorkItem(result.rows?.[0]);
  }

  async function markProcessed(id, options = {}) {
    const receiptId = positiveInteger(id, 'id', {max: Number.MAX_SAFE_INTEGER});
    const workerId = required(options.workerId, 'workerId');
    const nextStatus = status(options.status || 'succeeded');
    if (nextStatus === 'running') {
      throw new SheinWebhookRepositoryError('markProcessed cannot set running status; use renew for an active lease', {code: 'SHEIN_WEBHOOK_VALIDATION'});
    }
    const result = await withPgClient(source, client => client.query({
      name: 'shein-webhook-mark-processed',
      text: `/* shein_webhook:mark_processed */
        UPDATE ops.shein_webhook_receipt SET
          status=$2, normalized=COALESCE($3::jsonb, normalized), severity=COALESCE($4, severity),
          title=COALESCE($5, title), summary=COALESCE($6, summary), business_key=COALESCE($7, business_key),
          action_state=COALESCE($8, action_state), error=$9::jsonb, next_attempt_at=$10::timestamptz,
          processed_at=clock_timestamp(), lease_owner='', lease_expires_at=NULL
        WHERE id=$1 AND status='running' AND lease_owner=$11 RETURNING *`,
      values: [receiptId, nextStatus, options.normalized === undefined ? null : json(options.normalized, 'normalized'), options.severity === undefined ? null : severity(options.severity),
        options.title === undefined ? null : text(options.title), options.summary === undefined ? null : text(options.summary),
        options.businessKey === undefined ? null : text(options.businessKey), options.actionState === undefined ? null : text(options.actionState),
        json(options.error, 'error'), timestamp(options.nextAttemptAt, 'nextAttemptAt'), workerId],
    }));
    const receipt = rowToReceipt(result.rows?.[0]);
    if (!receipt) throw new SheinWebhookRepositoryError('Receipt lease was lost before processing completed', {code: 'SHEIN_WEBHOOK_LEASE_LOST'});
    return receipt;
  }

  async function markAlerted(id, {workerId, actionState, error} = {}) {
    const result = await withPgClient(source, client => client.query({
      name: 'shein-webhook-mark-alerted',
      text: `/* shein_webhook:mark_alerted */
        UPDATE ops.shein_webhook_receipt SET alerted_at=clock_timestamp(), action_state=COALESCE($2, action_state),
          error=COALESCE($3::jsonb, error)
        WHERE id=$1 AND status='running' AND lease_owner=$4 RETURNING *`,
      values: [positiveInteger(id, 'id', {max: Number.MAX_SAFE_INTEGER}), actionState === undefined ? null : text(actionState), error === undefined ? null : json(error, 'error'), required(workerId, 'workerId')],
    }));
    const receipt = rowToReceipt(result.rows?.[0]);
    if (!receipt) throw new SheinWebhookRepositoryError('Receipt lease was lost before alert state was stored', {code: 'SHEIN_WEBHOOK_LEASE_LOST'});
    return receipt;
  }

  async function release(id, {workerId, status: nextStatus = 'retry', error = {}, nextAttemptAt = null} = {}) {
    if (status(nextStatus) === 'running') {
      throw new SheinWebhookRepositoryError('release cannot set running status; use renew for an active lease', {code: 'SHEIN_WEBHOOK_VALIDATION'});
    }
    const result = await withPgClient(source, client => client.query({
      name: 'shein-webhook-release',
      text: `/* shein_webhook:release */
        UPDATE ops.shein_webhook_receipt SET status=$3, lease_owner='', lease_expires_at=NULL,
          error=$4::jsonb, next_attempt_at=$5::timestamptz
        WHERE id=$1 AND status='running' AND lease_owner=$2 RETURNING *`,
      values: [positiveInteger(id, 'id', {max: Number.MAX_SAFE_INTEGER}), required(workerId, 'workerId'), nextStatus, json(error, 'error'), timestamp(nextAttemptAt, 'nextAttemptAt')],
    }));
    return rowToReceipt(result.rows?.[0]);
  }

  async function renew(id, {workerId, leaseMs = 60_000} = {}) {
    const result = await withPgClient(source, client => client.query({
      name: 'shein-webhook-renew',
      text: `/* shein_webhook:renew */
        UPDATE ops.shein_webhook_receipt SET lease_expires_at=clock_timestamp() + ($3::bigint * interval '1 millisecond')
        WHERE id=$1 AND status='running' AND lease_owner=$2 RETURNING *`,
      values: [positiveInteger(id, 'id', {max: Number.MAX_SAFE_INTEGER}), required(workerId, 'workerId'), positiveInteger(leaseMs, 'leaseMs')],
    }));
    const receipt = rowToReceipt(result.rows?.[0]);
    if (!receipt) throw new SheinWebhookRepositoryError('Receipt lease was lost before renewal', {code: 'SHEIN_WEBHOOK_LEASE_LOST'});
    return receipt;
  }

  async function listEvents({allowedStores = [], filters = {}, cursor, limit = 100} = {}) {
    const max = positiveInteger(limit, 'limit', {min: 1, max: 500});
    const values = [];
    const clauses = [allowedStoreScope(allowedStores, values)];
    const add = (sql, value) => { if (text(value)) { values.push(text(value)); clauses.push(sql.replace('?', `$${values.length}`)); } };
    add('status=?', filters.status);
    add('severity=?', filters.severity);
    add(`normalized->>'eventFamily'=?`, filters.eventType ?? filters.eventFamily);
    add('event_code=?', filters.eventCode);
    add('store_key=?', filters.storeKey);
    const decodedCursor = decodeCursor(cursor ?? filters.cursor);
    if (decodedCursor) {
      values.push(decodedCursor.receivedAt, decodedCursor.id);
      clauses.push(`(received_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::bigint)`);
    }
    values.push(max + 1);
    const result = await withPgClient(source, client => client.query({
      name: 'shein-webhook-list-events',
      text: `/* shein_webhook:list_events:safe_projection */
        SELECT id, received_at, processed_at, store_key, event_code, normalized->>'eventFamily' AS event_type,
          severity, status, title, summary, business_key, action_state, (duplicate_count > 0) AS duplicate
        FROM ops.shein_webhook_receipt WHERE ${clauses.join(' AND ')}
        ORDER BY received_at DESC, id DESC LIMIT $${values.length}`,
      values,
    }));
    const rows = result.rows || [];
    const page = rows.slice(0, max);
    return {rows: page.map(rowToFrontendEvent), nextCursor: rows.length > max ? encodeCursor(page.at(-1)) : null};
  }

  async function summary({allowedStores = [], now = new Date()} = {}) {
    const requestedNow = timestamp(now, 'now') || new Date().toISOString();
    const run = async client => {
      const values = [requestedNow];
      const scope = allowedStoreScope(allowedStores, values);
      const common = `FROM ops.shein_webhook_receipt WHERE ${scope}`;
      const [totals, byType, byStore] = await Promise.all([
        client.query({name: 'shein-webhook-summary-totals', text: `/* shein_webhook:summary_totals */ SELECT
          count(*) FILTER (WHERE received_at >= $1::timestamptz - interval '24 hours')::bigint AS last_24h,
          count(*) FILTER (WHERE status IN ('queued','running','retry'))::bigint AS pending,
          count(*) FILTER (WHERE status IN ('failed','dead_letter'))::bigint AS failed,
          count(*) FILTER (WHERE severity='P0' AND received_at >= $1::timestamptz - interval '24 hours')::bigint AS p0,
          max(received_at) AS last_received_at ${common}`, values}),
        client.query({name: 'shein-webhook-summary-by-type', text: `/* shein_webhook:summary_by_type */ SELECT COALESCE(normalized->>'eventFamily','unknown') AS event_type, count(*)::bigint AS total ${common} GROUP BY 1 ORDER BY total DESC, event_type`, values}),
        client.query({name: 'shein-webhook-summary-by-store', text: `/* shein_webhook:summary_by_store */ SELECT store_key, count(*)::bigint AS total ${common} GROUP BY 1 ORDER BY total DESC, store_key`, values}),
      ]);
      const total = totals.rows?.[0] || {};
      return {
        totals: {last24h: Number(total.last_24h || 0), pending: Number(total.pending || 0), failed: Number(total.failed || 0), p0: Number(total.p0 || 0)},
        byType: (byType.rows || []).map(row => ({eventType: row.event_type, total: Number(row.total || 0)})),
        byStore: (byStore.rows || []).map(row => ({storeKey: row.store_key, total: Number(row.total || 0)})),
        lastReceivedAt: iso(total.last_received_at),
      };
    };
    return withPgClient(source, run);
  }

  async function upsertStoreGate({storeKey, gateType, state, reason = '', sourceReceiptId = null, sourceEventOrder = null} = {}) {
    const sourceId = sourceReceiptId === null || sourceReceiptId === undefined || sourceReceiptId === '' ? null : positiveInteger(sourceReceiptId, 'sourceReceiptId', {max: Number.MAX_SAFE_INTEGER});
    const sourceOrder = eventOrder(sourceEventOrder);
    const result = await withPgClient(source, client => client.query({
      name: 'shein-webhook-upsert-store-gate',
      text: `/* shein_webhook:upsert_store_gate */
        WITH applied_gate AS (
          INSERT INTO ops.shein_webhook_store_gate(store_key,gate_type,state,reason,source_receipt_id,source_event_order)
          VALUES ($1,$2,$3,$4,$5,$6::numeric)
          ON CONFLICT (store_key,gate_type) DO UPDATE SET state=EXCLUDED.state, reason=EXCLUDED.reason,
            source_receipt_id=EXCLUDED.source_receipt_id, source_event_order=EXCLUDED.source_event_order,
            updated_at=clock_timestamp()
          WHERE (
              -- An unverifiable risk-closing event must still fail closed.
              -- Its NULL ordering key intentionally prevents a later positive
              -- quota event from automatically reopening until ordering is
              -- re-established by another authoritative event.
              EXCLUDED.state='blocked' AND EXCLUDED.source_event_order IS NULL
            ) OR (
              EXCLUDED.source_event_order IS NOT NULL
              AND (
                (
                  ops.shein_webhook_store_gate.source_event_order IS NULL
                  AND (
                    EXCLUDED.gate_type <> 'quota'
                    OR EXCLUDED.state='blocked'
                    OR ops.shein_webhook_store_gate.state <> 'blocked'
                  )
                )
                OR EXCLUDED.source_event_order > ops.shein_webhook_store_gate.source_event_order
                OR (
                  EXCLUDED.source_event_order = ops.shein_webhook_store_gate.source_event_order
                  AND (ops.shein_webhook_store_gate.source_receipt_id IS NULL OR EXCLUDED.source_receipt_id >= ops.shein_webhook_store_gate.source_receipt_id)
                )
              )
            ) OR (
              EXCLUDED.source_event_order IS NULL
              AND ops.shein_webhook_store_gate.source_event_order IS NULL
              AND (
                EXCLUDED.gate_type <> 'quota'
                OR EXCLUDED.state='blocked'
                OR ops.shein_webhook_store_gate.state <> 'blocked'
              )
              AND (
                ops.shein_webhook_store_gate.source_receipt_id IS NULL
                OR EXCLUDED.source_receipt_id IS NULL
                OR EXCLUDED.source_receipt_id >= ops.shein_webhook_store_gate.source_receipt_id
              )
            )
          RETURNING *, true AS applied
        )
        SELECT * FROM applied_gate
        UNION ALL
        SELECT gate.*, false AS applied
        FROM ops.shein_webhook_store_gate gate
        WHERE gate.store_key=$1 AND gate.gate_type=$2
          AND NOT EXISTS (SELECT 1 FROM applied_gate)
        LIMIT 1`,
        values: [required(storeKey, 'storeKey'), required(gateType, 'gateType'), required(state, 'state'), text(reason), sourceId, sourceOrder],
      }));
    return mapGate(result.rows?.[0]);
  }

  async function reopenAuthorizationGate({storeKey, reason = '', sourceReceiptId = null} = {}) {
    const sourceId = sourceReceiptId === null || sourceReceiptId === undefined || sourceReceiptId === '' ? null : positiveInteger(sourceReceiptId, 'sourceReceiptId', {max: Number.MAX_SAFE_INTEGER});
    const result = await withPgClient(source, client => client.query({
      name: 'shein-webhook-reopen-authorization-gate',
      text: '/* shein_webhook:reopen_authorization_gate */ SELECT * FROM ops.reopen_shein_webhook_authorization_gate($1,$2,$3)',
      values: [required(storeKey, 'storeKey'), sourceId, text(reason)],
    }));
    return mapGate(result.rows?.[0]);
  }

  async function getStoreGate({storeKey, gateType} = {}) {
    const result = await withPgClient(source, client => client.query({
      name: 'shein-webhook-get-store-gate',
      text: '/* shein_webhook:get_store_gate */ SELECT * FROM ops.shein_webhook_store_gate WHERE store_key=$1 AND gate_type=$2',
      values: [required(storeKey, 'storeKey'), required(gateType, 'gateType')],
    }));
    return mapGate(result.rows?.[0]);
  }

  /** Safe blocker read model for portal write preflight. '*' is the only all-store scope. */
  async function listStoreGates({storeKeys = [], blockingOnly = true} = {}) {
    const values = [];
    const scope = allowedStoreScope(storeKeys, values);
    const clauses = [scope];
    if (blockingOnly) {
      // Gate producers use blocked as the stable closed state. Keep unknown and
      // open visible only when a caller explicitly requests the full gate view.
      clauses.push("state='blocked'");
    }
    const result = await withPgClient(source, client => client.query({
      name: 'shein-webhook-list-store-gates',
      text: `/* shein_webhook:list_store_gates:safe_projection */
        SELECT store_key, gate_type, state, reason, source_receipt_id, source_event_order, updated_at
        FROM ops.shein_webhook_store_gate WHERE ${clauses.join(' AND ')}
        ORDER BY store_key, gate_type`,
      values,
    }));
    return (result.rows || []).map(mapGate);
  }

  return Object.freeze({
    mode: 'postgres', close: () => closeWarehousePg(source), health: () => checkWarehousePg(source),
    storeReceipt, claimNext, markProcessed, markAlerted, release, renew, summary, listEvents,
    upsertStoreGate, reopenAuthorizationGate, getStoreGate, listStoreGates,
  });
}
