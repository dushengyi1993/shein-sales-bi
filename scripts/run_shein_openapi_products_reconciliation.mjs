#!/usr/bin/env node
/**
 * Orchestrate SHEIN OpenAPI product/link basics reconciliation for authorized stores.
 *
 * This is a read-only SHEIN workflow and writes only the OpenAPI parallel
 * warehouse layer (`fact.openapi_product_*`, `mart.openapi_product_reconciliation`).
 * It never writes production link/inventory facts and never changes SHEIN data.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {writeJsonFileAtomic} from '../lib/atomic_file_publish.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = path.join(ROOT, 'config', 'shein_openapi.local.json');
const DEFAULT_OUT = path.join(ROOT, 'state', 'openapi-probes', 'product-reconciliation.latest.json');
const DEFAULT_STORES = ['CX', 'DL', 'DX', 'FY', 'HL', 'JSH', 'JY', 'LQ', 'MZ', 'NM', 'QH', 'QY', 'TS', 'TZ', 'TZZ', 'XC', 'XL', 'YJ', 'ZL'];

function parseArgs(argv) {
  const args = {
    config: DEFAULT_CONFIG,
    stores: [],
    concurrency: Number(process.env.SHEIN_OPENAPI_PRODUCT_RECONCILE_CONCURRENCY || 2),
    fetchTimeoutMs: Number(process.env.SHEIN_OPENAPI_PRODUCT_RECONCILE_FETCH_TIMEOUT_MS || 20 * 60_000),
    loadTimeoutMs: Number(process.env.SHEIN_OPENAPI_PRODUCT_RECONCILE_LOAD_TIMEOUT_MS || 10 * 60_000),
    failFast: false,
    out: DEFAULT_OUT,
    maxDetails: 0,
    skipDetails: false,
    skipStock: false,
    latestOut: '',
    distro: 'Ubuntu-24.04',
    container: 'shein-warehouse-db',
    database: 'shein_bi',
    user: 'shein',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--config') args.config = path.resolve(argv[++i]);
    else if (a === '--stores') args.stores = String(argv[++i] || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
    else if (a === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (a === '--fetch-timeout-ms') args.fetchTimeoutMs = Number(argv[++i]);
    else if (a === '--load-timeout-ms') args.loadTimeoutMs = Number(argv[++i]);
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--no-out') args.out = '';
    else if (a === '--max-details') args.maxDetails = Number(argv[++i]);
    else if (a === '--skip-details') args.skipDetails = true;
    else if (a === '--skip-stock') args.skipStock = true;
    else if (a === '--latest-out') args.latestOut = path.resolve(argv[++i]);
    else if (a === '--distro') args.distro = String(argv[++i] || '').trim() || args.distro;
    else if (a === '--container') args.container = String(argv[++i] || '').trim() || args.container;
    else if (a === '--database') args.database = String(argv[++i] || '').trim() || args.database;
    else if (a === '--user') args.user = String(argv[++i] || '').trim() || args.user;
    else if (a === '--fail-fast') args.failFast = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  node scripts/run_shein_openapi_products_reconciliation.mjs
  node scripts/run_shein_openapi_products_reconciliation.mjs --stores DL,DX --max-details 30

Runs fetch_shein_openapi_products + load_shein_openapi_products_warehouse for
authorized stores. It writes only OpenAPI parallel warehouse tables and emits a
sanitized summary. Secrets are never printed.`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  args.concurrency = Math.max(1, Math.min(4, Number.isFinite(args.concurrency) ? Math.trunc(args.concurrency) : 2));
  args.fetchTimeoutMs = Math.max(60_000, Number.isFinite(args.fetchTimeoutMs) ? Math.trunc(args.fetchTimeoutMs) : 20 * 60_000);
  args.loadTimeoutMs = Math.max(60_000, Number.isFinite(args.loadTimeoutMs) ? Math.trunc(args.loadTimeoutMs) : 10 * 60_000);
  args.maxDetails = Math.max(0, Number.isFinite(args.maxDetails) ? Math.trunc(args.maxDetails) : 0);
  return args;
}

function sqlLiteral(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function artifactPath(value) {
  const text = String(value || '').trim();
  return text ? (path.isAbsolute(text) ? text : path.join(ROOT, text)) : '';
}

function compact(value, max = 400) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function productRowsFromSnapshot(snapshot) {
  return Array.isArray(snapshot?.normalizedRows) ? snapshot.normalizedRows : [];
}

function productSnapshotFromPayload(snapshot) {
  const rows = productRowsFromSnapshot(snapshot);
  const bySkc = new Map();
  for (const row of rows) {
    const skc = compact(row?.skc || row?.skcName, 160);
    if (!skc) continue;
    bySkc.set(skc, {
      skc,
      shelfStatusCode: compact(row?.shelfStatusCode, 32),
      hasDetail: row?.sourceCompleteness?.hasDetail === true,
      detailSource: compact(row?.sourceCompleteness?.detailSource, 32),
      detailFetchedAt: compact(row?.sourceCompleteness?.detailFetchedAt, 64),
      hasStock: row?.sourceCompleteness?.hasStock === true,
    });
  }
  return {
    fetchedAt: compact(snapshot?.fetchedAt || snapshot?.generatedAt, 64),
    bySkc,
    rowCount: bySkc.size,
  };
}

async function readProductSnapshot(file) {
  if (!file) return null;
  try {
    return productSnapshotFromPayload(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch {
    return null;
  }
}

function isOffShelfStatus(status) {
  const value = compact(status, 32);
  return Boolean(value) && value !== '1';
}

function webhookEventConfirmsOffShelf(event) {
  const action = compact(event?.action, 80).toLowerCase();
  const status = compact(event?.status, 32);
  return action === 'off_shelf' || status === '0';
}

/**
 * Product reconciliation has one authority for current shelf state: the
 * current OpenAPI snapshot. Browser snapshots are intentionally excluded from
 * pass/fail because they carry a different four-state vocabulary and can lag
 * the API. A transition from OpenAPI on-shelf to a non-on-shelf state is only
 * actionable when the matching product-shelves webhook is absent.
 */
export function assessProductReconciliationPolicy({current, previous = null, webhookEvents = [], browserDiagnostic = null} = {}) {
  const warnings = [];
  const notes = [];
  const currentRows = current?.bySkc instanceof Map ? current.bySkc : new Map();
  const previousRows = previous?.bySkc instanceof Map ? previous.bySkc : new Map();
  const eventsBySkc = new Map();
  for (const event of Array.isArray(webhookEvents) ? webhookEvents : []) {
    const skc = compact(event?.skc, 160);
    if (!skc) continue;
    const rows = eventsBySkc.get(skc) || [];
    rows.push(event);
    eventsBySkc.set(skc, rows);
  }

  const detailMissing = [];
  const cachedDetail = [];
  const staleCachedDetail = [];
  const stockMissing = [];
  const statusRollbackWithoutWebhook = [];
  const statusRollbackWithWebhook = [];
  for (const row of currentRows.values()) {
    if (!row.hasDetail) detailMissing.push(row.skc);
    if (row.hasDetail && row.detailSource === 'prior_cache') {
      cachedDetail.push(row.skc);
      const fetchedAt = Date.parse(row.detailFetchedAt || '');
      const currentAt = Date.parse(current?.fetchedAt || '');
      if (!Number.isFinite(fetchedAt) || !Number.isFinite(currentAt) || currentAt - fetchedAt > 21 * 86_400_000) {
        staleCachedDetail.push(row.skc);
      }
    }
    if (!row.hasStock) stockMissing.push(row.skc);
    const prior = previousRows.get(row.skc);
    if (row.detailSource !== 'prior_cache' && prior?.shelfStatusCode === '1' && isOffShelfStatus(row.shelfStatusCode)) {
      const confirmed = (eventsBySkc.get(row.skc) || []).some(webhookEventConfirmsOffShelf);
      (confirmed ? statusRollbackWithWebhook : statusRollbackWithoutWebhook).push(row.skc);
    }
  }

  if (!currentRows.size) warnings.push('OpenAPI 当前快照为空，无法确认商品详情、库存和可售状态。');
  if (detailMissing.length) warnings.push(`OpenAPI 商品详情缺失 ${detailMissing.length} 条：${detailMissing.slice(0, 5).join('、')}${detailMissing.length > 5 ? '…' : ''}`);
  if (staleCachedDetail.length) warnings.push(`OpenAPI 商品详情缓存超过 21 天 ${staleCachedDetail.length} 条：${staleCachedDetail.slice(0, 5).join('、')}${staleCachedDetail.length > 5 ? '…' : ''}`);
  if (stockMissing.length) warnings.push(`OpenAPI 库存缺失 ${stockMissing.length} 条：${stockMissing.slice(0, 5).join('、')}${stockMissing.length > 5 ? '…' : ''}`);
  if (statusRollbackWithoutWebhook.length) warnings.push(`商品状态从已上架回退且未收到对应 Webhook ${statusRollbackWithoutWebhook.length} 条：${statusRollbackWithoutWebhook.slice(0, 5).join('、')}${statusRollbackWithoutWebhook.length > 5 ? '…' : ''}`);
  if (!previousRows.size) notes.push('首次或历史基线不可用：本轮只校验当前 OpenAPI 详情/库存，不把浏览器差异当失败。');
  if (cachedDetail.length) notes.push(`共享 App 额度内轮转刷新；${cachedDetail.length} 条沿用 21 天内最近成功详情，上下架实时变化仍以 Webhook 和当前业务域为准。`);
  if (statusRollbackWithWebhook.length) notes.push(`已由 Webhook 证实的上下架变化 ${statusRollbackWithWebhook.length} 条，已记录，不作为数据对账失败。`);

  const diagnostic = browserDiagnostic && typeof browserDiagnostic === 'object' ? {
    apiOnlySkcCount: Number(browserDiagnostic.api_only_skc_count || 0),
    browserOnlySkcCount: Number(browserDiagnostic.browser_only_skc_count || 0),
    binaryOnShelfDifferenceCount: Number(browserDiagnostic.status_mismatch_count || 0),
    exactStatusDifferenceCount: Number(browserDiagnostic.exact_status_mismatch_count || 0),
  } : null;
  if (diagnostic && (diagnostic.apiOnlySkcCount || diagnostic.browserOnlySkcCount || diagnostic.binaryOnShelfDifferenceCount || diagnostic.exactStatusDifferenceCount)) {
    notes.push('浏览器快照仅作诊断证据：其四态状态和覆盖差异不会单独判定 OpenAPI 对账失败。');
  }

  return {
    policyVersion: 'openapi-current-webhook-previous/v1',
    status: warnings.length ? 'warning' : 'matched',
    warnings,
    notes,
    counts: {
      apiCurrentRows: currentRows.size,
      detailMissing: detailMissing.length,
      cachedDetail: cachedDetail.length,
      staleCachedDetail: staleCachedDetail.length,
      stockMissing: stockMissing.length,
      statusRollbackWithoutWebhook: statusRollbackWithoutWebhook.length,
      statusRollbackWithWebhook: statusRollbackWithWebhook.length,
    },
    samples: {
      detailMissing: detailMissing.slice(0, 20),
      stockMissing: stockMissing.slice(0, 20),
      statusRollbackWithoutWebhook: statusRollbackWithoutWebhook.slice(0, 20),
      statusRollbackWithWebhook: statusRollbackWithWebhook.slice(0, 20),
    },
    browserDiagnostic: diagnostic,
  };
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return fallback; }
}

function isAuthorized(entry) {
  return Boolean(entry?.enabled)
    && Boolean(String(entry?.openKeyId || '').trim())
    && Boolean(String(entry?.secretKey || '').trim());
}

function tail(text, max = 4000) {
  const s = String(text || '');
  return s.length <= max ? s : s.slice(-max);
}

function runNodeStep(name, script, args, {timeoutMs}) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref?.();
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      let parsed = null;
      const text = stdout.trim();
      try { parsed = text ? JSON.parse(text) : null; }
      catch {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start >= 0 && end > start) {
          try { parsed = JSON.parse(text.slice(start, end + 1)); } catch {}
        }
      }
      resolve({
        name,
        ok: code === 0 && !timedOut,
        code,
        signal: signal || null,
        timedOut,
        startedAt,
        endedAt: new Date().toISOString(),
        parsed,
        stdoutTail: parsed ? '' : tail(stdout),
        stderrTail: tail(stderr),
      });
    });
  });
}

async function runPsql(args, sql) {
  const useWsl = process.platform === 'win32';
  const shellQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
  const dockerPrefix = process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() !== 0) ? 'sudo ' : '';
  const linuxCommand = `${dockerPrefix}docker exec -i ${shellQuote(args.container)} psql -U ${shellQuote(args.user)} -d ${shellQuote(args.database)} -v ON_ERROR_STOP=1 -t -A`;
  const child = spawn(useWsl ? 'wsl' : 'bash', useWsl
    ? ['-d', args.distro, '--', 'bash', '-lc', linuxCommand]
    : ['-lc', linuxCommand], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d.toString('utf8'); });
  child.stderr.on('data', d => { stderr += d.toString('utf8'); });
  child.stdin.write(sql);
  child.stdin.end();
  const code = await new Promise(resolve => child.on('close', resolve));
  if (code !== 0) throw new Error(`psql failed (${code}): ${tail(stderr || stdout, 3000)}`);
  return stdout.trim();
}

async function queryProductShelfWebhookEvidence(storeKey, fromAt, toAt, args) {
  const from = Date.parse(fromAt || '');
  const to = Date.parse(toAt || '');
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  const sql = `
SELECT coalesce(json_agg(row_to_json(e) ORDER BY e.received_at), '[]'::json)::text
FROM (
  SELECT
    coalesce(nullif(business_key,''), nullif(normalized->>'skc','')) AS skc,
    normalized->>'action' AS action,
    normalized->>'status' AS status,
    received_at
  FROM ops.shein_webhook_receipt
  WHERE store_key = ${sqlLiteral(storeKey)}
    AND status = 'succeeded'
    AND normalized->>'eventFamily' = 'product_shelves'
    AND received_at > ${sqlLiteral(new Date(from).toISOString())}::timestamptz
    AND received_at <= ${sqlLiteral(new Date(to).toISOString())}::timestamptz
) e;`;
  const raw = await runPsql(args, sql);
  const parsed = JSON.parse(raw || '[]');
  return Array.isArray(parsed) ? parsed : [];
}

async function persistPolicyReconciliation(storeKey, policy, args) {
  const policyJson = JSON.stringify(policy);
  const warnings = policy.warnings.join('; ');
  const sql = `
UPDATE mart.openapi_product_reconciliation
SET status = ${sqlLiteral(policy.status)},
    warnings = ${sqlLiteral(warnings)},
    raw_summary = coalesce(raw_summary, '{}'::jsonb) || jsonb_build_object(
      'reconciliationPolicy', ${sqlLiteral(policyJson)}::jsonb,
      'statusGranularity', 'OpenAPI current snapshot + prior OpenAPI snapshot + product-shelves Webhook are pass/fail authority; browser four-state snapshot is diagnostic only.'
    )
WHERE store_key = ${sqlLiteral(storeKey)};
`;
  await runPsql(args, sql);
}

async function runOneStore(storeKey, args) {
  const priorSnapshot = await readProductSnapshot(path.join(ROOT, 'outputs', 'shein_openapi_products', storeKey, 'latest.json'));
  const fetchArgs = [storeKey, '--config', args.config];
  if (args.maxDetails > 0) fetchArgs.push('--max-details', String(args.maxDetails));
  if (args.skipDetails) fetchArgs.push('--skip-details');
  if (args.skipStock) fetchArgs.push('--skip-stock');
  const fetchStep = await runNodeStep('fetch', 'fetch_shein_openapi_products.mjs', fetchArgs, {timeoutMs: args.fetchTimeoutMs});
  if (!fetchStep.ok) return {storeKey, status: 'fetch_failed', ok: false, fetchStep, loadStep: null};
  const loadStep = await runNodeStep('load', 'load_shein_openapi_products_warehouse.mjs', [
    '--store', storeKey,
    '--skip-ensure',
    '--distro', args.distro,
    '--container', args.container,
    '--database', args.database,
    '--user', args.user,
  ], {timeoutMs: args.loadTimeoutMs});
  if (!loadStep.ok) return {storeKey, status: 'load_failed', ok: false, fetchStep, loadStep};
  const row = Array.isArray(loadStep.parsed?.reconciliation) ? loadStep.parsed.reconciliation[0] : null;
  const currentSnapshot = await readProductSnapshot(artifactPath(fetchStep.parsed?.latest));
  if (!currentSnapshot) {
    return {storeKey, status: 'policy_failed', ok: false, fetchStep, loadStep, policyError: 'OpenAPI fetch completed but latest product snapshot cannot be read'};
  }
  let webhookEvents = [];
  let webhookEvidenceError = '';
  try {
    webhookEvents = await queryProductShelfWebhookEvidence(storeKey, priorSnapshot?.fetchedAt, currentSnapshot.fetchedAt, args);
  } catch (err) {
    webhookEvidenceError = compact(err?.message || err, 800);
  }
  const reconciliation = assessProductReconciliationPolicy({
    current: currentSnapshot,
    previous: priorSnapshot,
    webhookEvents,
    browserDiagnostic: row,
  });
  if (webhookEvidenceError && reconciliation.counts.statusRollbackWithoutWebhook > 0) {
    reconciliation.warnings.push(`商品状态回退无法读取 Webhook 证据：${webhookEvidenceError}`);
    reconciliation.status = 'warning';
  }
  reconciliation.webhookEvidence = {
    status: webhookEvidenceError ? 'unavailable' : (priorSnapshot ? 'checked' : 'not_needed_without_prior_snapshot'),
    eventCount: webhookEvents.length,
    error: webhookEvidenceError,
    comparedFrom: priorSnapshot?.fetchedAt || '',
    comparedTo: currentSnapshot.fetchedAt || '',
  };
  try {
    await persistPolicyReconciliation(storeKey, reconciliation, args);
  } catch (err) {
    return {storeKey, status: 'policy_failed', ok: false, fetchStep, loadStep, reconciliation, policyError: compact(err?.message || err, 1200)};
  }
  return {
    storeKey,
    status: reconciliation.status,
    ok: true,
    fetchStep: {
      ...fetchStep,
      parsed: fetchStep.parsed ? {
        ok: fetchStep.parsed.ok,
        storeKey: fetchStep.parsed.storeKey,
        savedTo: fetchStep.parsed.savedTo,
        latest: fetchStep.parsed.latest,
        summary: fetchStep.parsed.summary,
        warnings: fetchStep.parsed.warnings || [],
      } : null,
    },
    loadStep: {
      ...loadStep,
      parsed: loadStep.parsed ? {
        ok: loadStep.parsed.ok,
        storeKey: loadStep.parsed.storeKey,
        loadedFile: loadStep.parsed.loadedFile,
        rowCounts: loadStep.parsed.rowCounts,
        reconciliation: loadStep.parsed.reconciliation,
      } : null,
    },
    reconciliation: row,
    semanticReconciliation: reconciliation,
  };
}

async function runQueue(stores, args) {
  const results = [];
  let cursor = 0;
  let stopped = false;
  async function worker() {
    while (!stopped) {
      const idx = cursor;
      cursor += 1;
      if (idx >= stores.length) return;
      const storeKey = stores[idx];
      console.log(`[openapi-products] start store=${storeKey}`);
      const result = await runOneStore(storeKey, args);
      results[idx] = result;
      console.log(`[openapi-products] done store=${storeKey} status=${result.status}`);
      if (!result.ok && args.failFast) stopped = true;
    }
  }
  await Promise.all(Array.from({length: Math.min(args.concurrency, stores.length)}, () => worker()));
  return results.filter(Boolean);
}

function publicResult(result) {
  return {
    storeKey: result.storeKey,
    ok: result.ok,
    status: result.status,
    fetch: result.fetchStep ? {
      ok: result.fetchStep.ok,
      code: result.fetchStep.code,
      timedOut: result.fetchStep.timedOut,
      startedAt: result.fetchStep.startedAt,
      endedAt: result.fetchStep.endedAt,
      savedTo: result.fetchStep.parsed?.savedTo || '',
      latest: result.fetchStep.parsed?.latest || '',
      summary: result.fetchStep.parsed?.summary || null,
      warnings: result.fetchStep.parsed?.warnings || [],
      stderrTail: result.fetchStep.stderrTail,
      stdoutTail: result.fetchStep.stdoutTail,
    } : null,
    load: result.loadStep ? {
      ok: result.loadStep.ok,
      code: result.loadStep.code,
      timedOut: result.loadStep.timedOut,
      startedAt: result.loadStep.startedAt,
      endedAt: result.loadStep.endedAt,
      rowCounts: result.loadStep.parsed?.rowCounts || null,
      reconciliation: result.loadStep.parsed?.reconciliation || [],
      stderrTail: result.loadStep.stderrTail,
      stdoutTail: result.loadStep.stdoutTail,
    } : null,
    semanticReconciliation: result.semanticReconciliation || result.reconciliation || null,
    policyError: result.policyError || '',
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const config = await readJson(args.config, {});
  const configured = new Map((Array.isArray(config?.stores) ? config.stores : [])
    .map(entry => [String(entry?.storeKey || '').trim().toUpperCase(), entry])
    .filter(([key]) => key));
  const requested = (args.stores.length ? args.stores : DEFAULT_STORES).filter((x, i, arr) => arr.indexOf(x) === i);
  const authorized = requested.filter(storeKey => isAuthorized(configured.get(storeKey)));
  const skipped = requested
    .filter(storeKey => !isAuthorized(configured.get(storeKey)))
    .map(storeKey => ({storeKey, status: configured.has(storeKey) ? 'configured_disabled_or_incomplete' : 'missing_config'}));
  if (!authorized.length) throw new Error(`No authorized stores found for requested set: ${requested.join(',')}`);

  const startedAt = new Date().toISOString();
  const ensureStep = await runNodeStep(
    'ensure',
    'load_shein_openapi_products_warehouse.mjs',
    ['--ensure-only', '--distro', args.distro, '--container', args.container, '--database', args.database, '--user', args.user],
    {timeoutMs: args.loadTimeoutMs},
  );
  const results = ensureStep.ok ? await runQueue(authorized, args) : [];
  const publicResults = results.map(publicResult);
  const counts = publicResults.reduce((acc, r) => {
    acc.total += 1;
    if (r.ok) acc.succeeded += 1;
    else acc.failed += 1;
    if (r.status === 'matched') acc.matched += 1;
    if (r.status === 'warning') acc.warning += 1;
    acc.detailMissing += Number(r.semanticReconciliation?.counts?.detailMissing || 0);
    acc.stockMissing += Number(r.semanticReconciliation?.counts?.stockMissing || 0);
    acc.statusRollbackWithoutWebhook += Number(r.semanticReconciliation?.counts?.statusRollbackWithoutWebhook || 0);
    if (r.status === 'missing_browser') acc.missingBrowser += 1;
    return acc;
  }, {total: 0, succeeded: 0, failed: 0, matched: 0, warning: 0, detailMissing: 0, stockMissing: 0, statusRollbackWithoutWebhook: 0, missingBrowser: 0, skipped: skipped.length});

  const output = {
    schemaVersion: 'shein-openapi-product-reconciliation-run/v2',
    ok: ensureStep.ok && counts.failed === 0,
    generatedAt: new Date().toISOString(),
    startedAt,
    endedAt: new Date().toISOString(),
    concurrency: args.concurrency,
    maxDetails: args.maxDetails,
    requestedStores: requested,
    authorizedStores: authorized,
    ensure: {
      ok: ensureStep.ok,
      code: ensureStep.code,
      timedOut: ensureStep.timedOut,
      startedAt: ensureStep.startedAt,
      endedAt: ensureStep.endedAt,
      stderrTail: ensureStep.stderrTail,
      stdoutTail: ensureStep.parsed ? '' : ensureStep.stdoutTail,
    },
    counts,
    skipped,
    results: publicResults,
  };

  if (args.out) {
    await writeJsonFileAtomic(args.out, output);
  }
  if (args.latestOut) {
    await writeJsonFileAtomic(args.latestOut, output);
  }
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(output => {
    console.log(JSON.stringify(output, null, 2));
    process.exitCode = output.ok ? 0 : 1;
  }).catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}
