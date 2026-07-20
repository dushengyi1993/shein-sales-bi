#!/usr/bin/env node
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {
  SUPPORTED_WEBHOOK_EVENTS,
  classifyWebhookSeverity,
  computeWebhookIdempotencyKey,
  decryptWebhookEventData,
  extractWebhookEventData,
  normalizeWebhookBusinessEvent,
  normalizeWebhookHeaders,
  verifyWebhookSignature,
} from '../lib/shein_webhook_receiver.mjs';
import {
  DEFAULT_SHEIN_WEBHOOK_STORE_KEYS,
  loadSheinWebhookCredentialRegistry,
} from '../lib/shein_webhook_config.mjs';
import {createSheinWebhookRepository} from '../lib/shein_webhook_repository.mjs';
import {createSheinWebhookEventProcessor, humanizeSheinWebhookEvent} from '../lib/shein_webhook_handlers.mjs';
import {syncWebhookOrder, syncWebhookReturn} from '../lib/shein_webhook_order_return_sync.mjs';
import {createWarehousePgPool, withPgClient} from '../lib/warehouse_pg.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CALLBACK_PATH = '/api/shein/webhook/v1/events';
const EVENT_CODE_BY_HEADER = new Map(SUPPORTED_WEBHOOK_EVENTS.flatMap(row => [
  [String(row.eventCode), String(row.eventCode)],
  [String(row.eventPath).replace(/^\/+/, '').toLowerCase(), String(row.eventCode)],
]));

/**
 * SHEIN sends the route-style event name in `x-lt-eventCode` (for example
 * `product_document_receive_status_notice`).  Internally we keep the stable
 * numeric document id used by the catalog, handlers, and warehouse rows.
 * Numeric values remain accepted for existing deterministic probes.
 */
export function resolveIncomingWebhookEventCode(value) {
  const normalized = String(value || '').trim().replace(/^\/+/, '').toLowerCase();
  return EVENT_CODE_BY_HEADER.get(normalized) || '';
}

function positiveInt(value, fallback, {min = 1, max = Number.MAX_SAFE_INTEGER} = {}) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function flag(value, fallback = false) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function safeError(error) {
  return {code: String(error?.code || 'WEBHOOK_PROCESSING_FAILED').slice(0, 80), message: String(error?.message || error || 'Unknown error').slice(0, 800)};
}

export function webhookSeverityCode(receipt = {}) {
  const value = receipt?.severity;
  return String(value && typeof value === 'object' ? value.severity : value || '').trim().toUpperCase();
}

export function webhookAlertIdempotencyKey(receipt = {}) {
  const family = String(receipt?.normalized?.eventFamily || '').trim();
  if (family === 'authorization') {
    // The official authorization payload has no event id/time and the docs do
    // not promise that retries reuse the signature timestamp. Debounce new
    // signatures in a short time bucket while still recording every receipt and
    // re-closing the gate; a later genuine transition can alert again.
    const at = Date.parse(receipt.receivedAt || '');
    const bucket = Number.isFinite(at) ? Math.floor(at / (10 * 60_000)) : 0;
    const material = [receipt.storeKey, receipt.eventCode, receipt.normalized?.status, receipt.normalized?.businessId, bucket].join('|');
    return `sync-issue-${crypto.createHash('sha256').update(material).digest('hex').slice(0, 24)}`;
  }
  return `sync-issue-${String(receipt.idempotencyKey || '').slice(0, 24)}`;
}

function writeJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function beforeDeadline(promise, deadlineAt, label = 'Webhook ingress deadline exceeded') {
  const remaining = Math.floor(Number(deadlineAt) - Date.now());
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return Promise.reject(Object.assign(new Error(label), {statusCode: 503, code: 'WEBHOOK_INGRESS_DEADLINE'}));
  }
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(label), {statusCode: 503, code: 'WEBHOOK_INGRESS_DEADLINE'})), remaining);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

/** Execute the existing targeted SQL builders through the restricted PG role. */
export function createWebhookPgScriptExecutor({pool} = {}) {
  if (!pool?.query && !pool?.connect) throw new TypeError('PostgreSQL pool is required');
  return async function executePgScript(_args, script) {
    const result = await withPgClient(pool, async client => {
      try {
        return await client.query(String(script || ''));
      } catch (error) {
        // Targeted builders send an explicit BEGIN/COMMIT batch. If any
        // statement fails, PostgreSQL leaves the session in an aborted
        // transaction; roll it back before the pooled client can be reused.
        try { await client.query('ROLLBACK'); }
        catch (rollbackError) { if (error && typeof error === 'object') error.rollbackError = rollbackError; }
        throw error;
      }
    });
    const results = Array.isArray(result) ? result : [result];
    const rows = results.flatMap(item => Array.isArray(item?.rows) ? item.rows : []);
    const stdout = rows.map(row => Object.values(row || {}).map(value => {
      if (value === null || value === undefined) return '';
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
    }).join('|')).join('\n');
    return {ok: true, stdout: stdout ? `${stdout}\n` : '', stderr: ''};
  };
}

function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        fail(Object.assign(new Error('Webhook body is too large'), {statusCode: 413}));
        req.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('aborted', () => fail(new Error('Webhook request was aborted')));
    req.on('error', fail);
  });
}

function runChild(command, args, {cwd = ROOT, timeoutMs = 30_000} = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, {cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 20_000) stdout = stdout.slice(-20_000); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 20_000) stderr = stderr.slice(-20_000); });
    child.once('error', error => { clearTimeout(timer); resolve({ok: false, code: -1, timedOut, stdout, stderr: String(error?.message || error)}); });
    child.once('close', code => { clearTimeout(timer); resolve({ok: code === 0 && !timedOut, code, timedOut, stdout, stderr}); });
  });
}

export function createWebhookFeishuNotifier({root = ROOT} = {}) {
  return Object.freeze({
    async notify({receipt, outcome}) {
      if (webhookSeverityCode(receipt) !== 'P0') return {ok: true, skipped: true, reason: 'not_p0'};
      // Match the established notifier key shape and keep it stable across
      // worker retries. The notifier deliberately refuses an unkeyed fallback
      // for webhook alerts, so a crash cannot turn a retry into a duplicate DM.
      const key = webhookAlertIdempotencyKey(receipt);
      const result = await runChild(process.execPath, [
        path.join(root, 'scripts', 'notify_sync_issue.mjs'),
        '--kind', 'webhook',
        '--mode', String(receipt.normalized?.eventLabel || receipt.normalized?.eventFamily || receipt.eventCode),
        '--title', String(outcome.title || 'SHEIN 平台高优先级动态'),
        '--message', String(outcome.summary || '平台推送了需要立即关注的异常。'),
        '--idempotency-key', key,
      ], {cwd: root, timeoutMs: positiveInt(process.env.SHEIN_WEBHOOK_LARK_TIMEOUT_MS, 30_000, {max: 120_000})});
      if (!result.ok) throw Object.assign(new Error(`Feishu alert failed: code=${result.code}${result.timedOut ? ' timeout' : ''}`), {code: 'WEBHOOK_FEISHU_ALERT_FAILED'});
      return {ok: true, idempotencyKey: key};
    },
  });
}

function retryAt(attempt) {
  const delay = Math.min(60 * 60_000, 5_000 * (2 ** Math.min(8, Math.max(0, attempt - 1))));
  return new Date(Date.now() + delay).toISOString();
}

export function createSheinWebhookService({
  repository,
  credentialRegistry,
  eventProcessor,
  notifier = null,
  callbackPath = CALLBACK_PATH,
  maxBodyBytes = 1024 * 1024,
  maxSkewMs = 5 * 60_000,
  workerEnabled = true,
  workerId = `${os.hostname()}:${process.pid}`,
  workerPollMs = 1_000,
  workerLeaseMs = 10 * 60_000,
  workerMaxAttempts = 8,
  ingressBudgetMs = 1_200,
  receiptStatementTimeoutMs = 800,
  now = () => Date.now(),
  logger = console,
} = {}) {
  if (!repository?.storeReceipt) throw new TypeError('repository is required');
  if (!credentialRegistry?.resolve) throw new TypeError('credentialRegistry is required');
  if (workerEnabled && !eventProcessor?.process) throw new TypeError('eventProcessor is required when worker is enabled');
  let timer = null;
  let working = false;
  let stopping = false;
  const counters = {accepted: 0, duplicates: 0, rejected: 0, processed: 0, failed: 0};

  async function ingress(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/healthz') {
      if (req.method !== 'GET') return writeJson(res, 405, {ok: false, error: 'Method not allowed'});
      return writeJson(res, 200, {ok: true, service: 'shein-webhook', workerEnabled, working, counters});
    }
    if (url.pathname !== callbackPath || url.search) return writeJson(res, 404, {ok: false, error: 'Not found'});
    if (req.method !== 'POST') return writeJson(res, 405, {ok: false, error: 'Method not allowed'});
    const deadlineAt = Date.now() + positiveInt(ingressBudgetMs, 1_200, {min: 250, max: 1_400});
    try {
      const headers = normalizeWebhookHeaders(req.headers);
      const identity = credentialRegistry.resolve(headers);
      const rawBody = await beforeDeadline(readRawBody(req, maxBodyBytes), deadlineAt);
      const eventData = extractWebhookEventData({contentType: headers['content-type'], rawBody, maxBodyBytes});
      const verification = verifyWebhookSignature({headers, eventData, appSecretKey: identity.appSecretKey, requestPath: callbackPath, nowMs: now(), maxSkewMs});
      if (!verification.ok) throw Object.assign(new Error(`Webhook signature rejected: ${verification.reason}`), {statusCode: 401, code: 'WEBHOOK_SIGNATURE_REJECTED'});
      const payload = decryptWebhookEventData(eventData, identity.appSecretKey);
      if (!payload || (typeof payload !== 'object' && typeof payload !== 'string') || Array.isArray(payload)) {
        throw Object.assign(new Error('Webhook payload must be a JSON object or an official JSON-string wrapper'), {statusCode: 400});
      }
      const eventCode = resolveIncomingWebhookEventCode(headers['x-lt-eventcode']);
      if (!eventCode) throw Object.assign(new Error('Unsupported SHEIN webhook event code'), {statusCode: 400, code: 'WEBHOOK_EVENT_UNSUPPORTED'});
      const receivedAt = new Date(now()).toISOString();
      const appScopedOnly = identity.identityScope === 'app_only';
      const normalizedBase = {
        ...normalizeWebhookBusinessEvent({eventCode, payload, storeKey: identity.storeKey, receivedAt}),
        ...(appScopedOnly ? {appScopedOnly: true, deliveryScope: 'app_only'} : {}),
      };
      // Subscription validation and the official debug tool use an app-signed
      // synthetic openKeyId.  Record those deliveries for end-to-end audit,
      // but never let an app-only identity close a store gate, sync an order,
      // mutate an Ops task, or send a P0 alert.
      const severity = appScopedOnly
        ? {severity: 'P3', reason: 'app_scoped_delivery', notifyFeishu: false}
        : classifyWebhookSeverity({normalizedEvent: normalizedBase});
      const normalized = {...normalizedBase, severityReason: severity.reason, notifyFeishu: severity.notifyFeishu};
      const idempotencyKey = computeWebhookIdempotencyKey({headers, eventCode, payload, eventData, businessId: normalized.businessId, platformTimestamp: headers['x-lt-timestamp']});
      const cipherHash = crypto.createHash('sha256').update(eventData, 'utf8').digest('hex');
      const remainingForDatabase = Math.floor(deadlineAt - Date.now() - 100);
      if (remainingForDatabase < 50) {
        throw Object.assign(new Error('Webhook ingress budget exhausted before durable storage'), {statusCode: 503, code: 'WEBHOOK_INGRESS_DEADLINE'});
      }
      let stored;
      try {
        stored = await beforeDeadline(repository.storeReceipt({
          idempotencyKey,
          appId: identity.appId,
          openKeyId: identity.openKeyId || headers['x-lt-openkeyid'] || '',
          eventCode,
          storeKey: identity.storeKey,
          platformTimestamp: new Date(verification.timestampMs).toISOString(),
          cipherHash,
          eventData,
          normalized,
          severity: severity.severity,
          title: appScopedOnly ? `${identity.storeKey} Webhook 应用级验证` : `${identity.storeKey} ${normalized.eventLabel}`,
          summary: appScopedOnly
            ? '签名与接收链路验证通过；未携带已授权店铺 OpenKey，不执行任何业务动作。'
            : normalized.businessId ? `业务单号 ${normalized.businessId}` : '平台事件已可靠接收，等待异步处理。',
          businessKey: normalized.businessId,
          actionState: 'queued',
          statementTimeoutMs: Math.min(
            positiveInt(receiptStatementTimeoutMs, 800, {min: 50, max: 1_200}),
            remainingForDatabase,
          ),
        }), deadlineAt);
      } catch (error) {
        throw Object.assign(new Error('Webhook durable storage is unavailable'), {
          statusCode: 503,
          code: error?.code === 'WEBHOOK_INGRESS_DEADLINE' ? error.code : 'WEBHOOK_STORAGE_UNAVAILABLE',
          cause: error,
        });
      }
      counters.accepted += 1;
      if (stored.duplicate) counters.duplicates += 1;
      return writeJson(res, 200, {ok: true, duplicate: Boolean(stored.duplicate)});
    } catch (error) {
      counters.rejected += 1;
      const status = Number(error?.statusCode || (/Unknown webhook|identity mismatch/.test(String(error?.message || '')) ? 401 : 400));
      logger.warn?.(JSON.stringify({event: 'webhook-rejected', status, code: String(error?.code || 'WEBHOOK_INVALID'), message: String(error?.message || error).slice(0, 300)}));
      if (!res.headersSent && !res.destroyed) return writeJson(res, status, {
        ok: false,
        error: status === 401 ? 'Webhook authentication failed' : status === 503 ? 'Webhook receiver temporarily unavailable' : 'Invalid webhook request',
      });
    }
  }

  async function processOne() {
    if (working || stopping) return;
    working = true;
    let receipt = null;
    let renewTimer = null;
    let renewing = false;
    let leaseFailure = null;
    const abortController = new AbortController();
    const assertLease = () => {
      if (leaseFailure) throw leaseFailure;
    };
    try {
      receipt = await repository.claimNext({workerId, leaseMs: workerLeaseMs});
      if (!receipt) return;
      const renewLease = async () => {
        if (renewing || leaseFailure) return;
        renewing = true;
        try {
          await repository.renew(receipt.id, {workerId, leaseMs: workerLeaseMs});
        } catch (error) {
          leaseFailure = Object.assign(new Error('Webhook worker lost its receipt lease'), {code: 'SHEIN_WEBHOOK_LEASE_LOST', cause: error});
          abortController.abort(leaseFailure);
        } finally {
          renewing = false;
        }
      };
      renewTimer = setInterval(() => { void renewLease(); }, Math.max(5_000, Math.floor(workerLeaseMs / 3)));
      renewTimer.unref?.();

      const identity = credentialRegistry.resolve({
        'x-lt-appid': receipt.appId,
        'x-lt-openkeyid': receipt.openKeyId,
      });
      if (identity.storeKey !== receipt.storeKey) throw Object.assign(new Error('Stored webhook identity no longer maps to the same store'), {code: 'WEBHOOK_IDENTITY_DRIFT'});
      const actualCipherHash = crypto.createHash('sha256').update(String(receipt.eventData || ''), 'utf8').digest('hex');
      if (actualCipherHash !== receipt.cipherHash) throw Object.assign(new Error('Stored webhook ciphertext hash mismatch'), {code: 'WEBHOOK_CIPHERTEXT_CORRUPT'});
      const payload = decryptWebhookEventData(receipt.eventData, identity.appSecretKey);
      const persistedAppScope = receipt.normalized?.appScopedOnly === true;
      const normalizedBase = {
        ...normalizeWebhookBusinessEvent({
          eventCode: receipt.eventCode,
          payload,
          storeKey: receipt.storeKey,
          receivedAt: receipt.receivedAt,
        }),
        ...(persistedAppScope ? {
          appScopedOnly: true,
          deliveryScope: String(receipt.normalized?.deliveryScope || 'app_only'),
        } : {}),
      };
      // Ingress/maintenance classification is an operational security label,
      // not a derived payload field. Preserve it across worker-side decrypt and
      // normalization so validation fixtures can never become store writes or
      // P0 alerts merely because the worker rebuilt the normalized projection.
      const severity = persistedAppScope
        ? {severity: 'P3', reason: 'app_scoped_delivery', notifyFeishu: false}
        : classifyWebhookSeverity({normalizedEvent: normalizedBase});
      const normalized = {...normalizedBase, severityReason: severity.reason, notifyFeishu: severity.notifyFeishu};
      const workItem = {
        ...receipt,
        payload,
        normalized,
        severity,
        signal: abortController.signal,
      };

      // Apply business safety state first.  In particular, authorization and
      // quota gates must be closed before a potentially slow Feishu process is
      // allowed to run; otherwise an executor could write during the alert.
      assertLease();
      let outcome;
      let processingError = null;
      try {
        outcome = await eventProcessor.process(workItem);
      } catch (error) {
        processingError = error;
      }
      assertLease();

      // P0 notification remains independent of enrichment/warehouse success:
      // a failed downstream sync must never suppress the urgent warning.
      let alertError = null;
      if (severity.severity === 'P0' && !receipt.alertedAt && notifier?.notify) {
        assertLease();
        const alertCopy = humanizeSheinWebhookEvent(normalized, severity);
        const alertOutcome = {
          title: alertCopy.title,
          summary: alertCopy.summary,
          actionState: 'p0_alert',
        };
        try {
          await notifier.notify({receipt: workItem, outcome: alertOutcome});
          assertLease();
          await repository.markAlerted(receipt.id, {workerId, actionState: 'p0_feishu_alerted'});
        } catch (error) {
          // A broken notification channel must not prevent an authorization or
          // quota gate from closing. Keep the receipt retryable, but still run
          // the idempotent business handler while this lease is valid.
          if (error?.code === 'SHEIN_WEBHOOK_LEASE_LOST') throw error;
          assertLease();
          alertError = error;
        }
      }
      if (processingError && alertError) {
        throw new AggregateError([alertError, processingError], 'Webhook P0 notification and business processing both failed');
      }
      if (processingError) throw processingError;
      if (alertError) throw alertError;
      assertLease();
      await repository.markProcessed(receipt.id, {
        status: 'succeeded',
        workerId,
        normalized,
        severity: severity.severity,
        title: outcome.title,
        summary: outcome.summary,
        businessKey: outcome.businessKey,
        actionState: outcome.actionState,
        error: {},
      });
      counters.processed += 1;
    } catch (error) {
      counters.failed += 1;
      if (receipt) {
        const terminal = Number(receipt.attempt || 0) >= workerMaxAttempts;
        await repository.release(receipt.id, {
          workerId,
          status: terminal ? 'dead_letter' : 'retry',
          error: safeError(error),
          nextAttemptAt: terminal ? null : retryAt(receipt.attempt || 1),
        }).catch(releaseError => logger.error?.(JSON.stringify({event: 'webhook-release-failed', receiptId: receipt.id, error: safeError(releaseError)})));
        logger.error?.(JSON.stringify({event: 'webhook-processing-failed', receiptId: receipt.id, attempt: receipt.attempt, terminal, error: safeError(error)}));
      } else {
        logger.error?.(JSON.stringify({event: 'webhook-worker-failed-before-claim', error: safeError(error)}));
      }
    } finally {
      if (renewTimer) clearInterval(renewTimer);
      working = false;
    }
  }

  const server = http.createServer((req, res) => { void ingress(req, res); });
  server.requestTimeout = Math.min(1_400, positiveInt(ingressBudgetMs, 1_200, {min: 250, max: 1_400}) + 100);
  server.headersTimeout = server.requestTimeout;
  server.keepAliveTimeout = 2_000;

  return Object.freeze({
    server,
    counters,
    processOne,
    async start({host = '127.0.0.1', port = 8792} = {}) {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      if (workerEnabled) {
        timer = setInterval(() => { void processOne(); }, workerPollMs);
        timer.unref?.();
        void processOne();
      }
      return server.address();
    },
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      await new Promise(resolve => server.close(resolve));
      while (working) await new Promise(resolve => setTimeout(resolve, 25));
    },
  });
}

async function main() {
  const configFile = process.env.SHEIN_OPENAPI_CONFIG_FILE || path.join(ROOT, 'config', 'shein_openapi.local.json');
  const credentialRegistry = await loadSheinWebhookCredentialRegistry({
    configFile,
    expectedStoreKeys: DEFAULT_SHEIN_WEBHOOK_STORE_KEYS,
  });
  const warehousePool = createWarehousePgPool({env: process.env});
  const repository = createSheinWebhookRepository({pool: warehousePool});
  const health = await repository.health();
  const pgExecutor = createWebhookPgScriptExecutor({pool: warehousePool});
  const warehouseArgs = {dryRun: false};
  const eventProcessor = createSheinWebhookEventProcessor({
    webhookRepository: repository,
    // The public receiver role deliberately has no access to ops.link_ops_*.
    // Product lifecycle events remain visible in Platform Activity; attaching
    // them to mutable tasks is deferred to a separately privileged reconciler.
    linkOpsRepository: null,
    orderReturnSync: {
      syncOrder: input => syncWebhookOrder({...input, warehouseArgs, executor: pgExecutor}),
      syncReturn: input => syncWebhookReturn({...input, warehouseArgs, executor: pgExecutor}),
    },
  });
  const service = createSheinWebhookService({
    repository,
    credentialRegistry,
    eventProcessor,
    notifier: createWebhookFeishuNotifier(),
    maxBodyBytes: positiveInt(process.env.SHEIN_WEBHOOK_MAX_BODY_BYTES, 1024 * 1024, {max: 8 * 1024 * 1024}),
    maxSkewMs: positiveInt(process.env.SHEIN_WEBHOOK_MAX_SKEW_MS, 5 * 60_000, {max: 30 * 60_000}),
    workerEnabled: flag(process.env.SHEIN_WEBHOOK_WORKER_ENABLED, true),
    workerPollMs: positiveInt(process.env.SHEIN_WEBHOOK_WORKER_POLL_MS, 1_000, {max: 60_000}),
    workerLeaseMs: positiveInt(process.env.SHEIN_WEBHOOK_WORKER_LEASE_MS, 10 * 60_000, {max: 60 * 60_000}),
    workerMaxAttempts: positiveInt(process.env.SHEIN_WEBHOOK_WORKER_MAX_ATTEMPTS, 8, {max: 30}),
    ingressBudgetMs: positiveInt(process.env.SHEIN_WEBHOOK_INGRESS_BUDGET_MS, 1_200, {min: 250, max: 1_400}),
    receiptStatementTimeoutMs: positiveInt(process.env.SHEIN_WEBHOOK_RECEIPT_STATEMENT_TIMEOUT_MS, 800, {min: 50, max: 1_200}),
  });
  const host = process.env.SHEIN_WEBHOOK_HOST || '127.0.0.1';
  const port = positiveInt(process.env.SHEIN_WEBHOOK_PORT, 8792, {max: 65535});
  const address = await service.start({host, port});
  console.log(JSON.stringify({ok: true, service: 'shein-webhook', host, port: address.port, callbackPath: CALLBACK_PATH, credentials: credentialRegistry.summary, database: {ok: health.ok}, workerEnabled: flag(process.env.SHEIN_WEBHOOK_WORKER_ENABLED, true)}));
  let shutdown = false;
  const stop = async signal => {
    if (shutdown) return;
    shutdown = true;
    console.log(JSON.stringify({event: 'webhook-shutdown', signal}));
    await service.stop();
    await Promise.allSettled([repository.close()]);
  };
  process.once('SIGTERM', () => { void stop('SIGTERM'); });
  process.once('SIGINT', () => { void stop('SIGINT'); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error?.stack || String(error)); process.exit(1); });
}
