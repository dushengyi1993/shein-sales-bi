#!/usr/bin/env node
/**
 * Rebuild the open-period perpetual moving-average inventory cost ledger.
 * Frozen accounting months are never rewritten.
 */
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildInventoryCostLedger} from '../lib/inventory_cost_ledger.mjs';

// Keep this list aligned with every mutable base table read by loadSources()
// either directly or through mart.product_cost_batch_timeline /
// mart.et_rtv_destination_allocation.
const SOURCE_TABLES = Object.freeze([
  'fact.order_item',
  'fact.product_cost_batch',
  'fact.inventory_cost_opening',
  'fact.after_sales_item',
  'fact.et_ship_order',
  'fact.et_ship_order_track',
  'fact.et_stock_running',
  'ops.rtv_tracking_verification',
  'ops.accounting_period_close',
]);

const BI_DB_APPLICATION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,62}$/;

function validateBiDbApplicationName(value) {
  const name = String(value ?? '');
  if (!name) return '';
  if (name !== name.trim() || Buffer.byteLength(name, 'utf8') > 63 || !BI_DB_APPLICATION_NAME_RE.test(name)) {
    throw new Error('SHEIN_BI_DB_APPLICATION_NAME must be 1-63 safe ASCII characters');
  }
  return name;
}

export function normalizeInventoryCostLogicalRunKey(value) {
  const key = String(value || '').trim();
  if (!key) return '';
  if (key.length > 200 || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new Error('Inventory cost logical run key must be 1-200 printable characters');
  }
  return key;
}

export function inventoryCostRunIdentity(logicalRunKey, sourceHash) {
  const key = normalizeInventoryCostLogicalRunKey(logicalRunKey);
  const fingerprint = String(sourceHash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Inventory cost source fingerprint must be sha256');
  if (!key) return null;
  const keyHash = sha(`inventory-cost-logical-run\0${key}`);
  return {
    logicalRunKey: key,
    logicalRunKeyHash: keyHash,
    sourceFingerprint: fingerprint,
    revision: fingerprint,
    runId: `inventory-cost-${keyHash.slice(0, 24)}-${fingerprint.slice(0, 24)}`,
  };
}

export function inventoryCostExistingRunDecision(existing, identity) {
  if (!existing) return {action: 'start'};
  if (!identity || String(existing.runId || '') !== identity.runId
    || String(existing.sourceHash || '').toLowerCase() !== identity.sourceFingerprint) {
    return {action: 'conflict', reason: 'run_identity_or_source_fingerprint_mismatch'};
  }
  if (String(existing.status || '') === 'completed') return {action: 'verify_completed'};
  return {action: 'resume_same_identity', status: String(existing.status || 'unknown')};
}

function parseArgs(argv) {
  const args = {
    container: 'shein-warehouse-db',
    database: 'shein_bi',
    user: 'shein',
    dryRun: false,
    applicationName: validateBiDbApplicationName(process.env.SHEIN_BI_DB_APPLICATION_NAME || ''),
    logicalRunKey: normalizeInventoryCostLogicalRunKey(process.env.SHEIN_INVENTORY_COST_LOGICAL_RUN_KEY || ''),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--container') args.container = argv[++i];
    else if (arg === '--database') args.database = argv[++i];
    else if (arg === '--user') args.user = argv[++i];
    else if (arg === '--from') args.from = argv[++i];
    else if (arg === '--logical-run-key') args.logicalRunKey = normalizeInventoryCostLogicalRunKey(argv[++i]);
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/rebuild_inventory_cost_ledger.mjs [--from YYYY-MM-DD] [--logical-run-key KEY] [--dry-run]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function sha(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function sqlLiteral(value) {
  if (value === null || value === undefined || value === '') return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function csv(value) {
  if (value === null || value === undefined || value === '') return '';
  const string = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(string) ? `"${string.replace(/"/g, '""')}"` : string;
}

function copyBlock(table, columns, rows) {
  if (!rows.length) return '';
  let output = `COPY ${table} (${columns.join(',')}) FROM STDIN WITH (FORMAT csv, NULL '');\n`;
  for (const row of rows) output += `${columns.map(column => csv(row[column])).join(',')}\n`;
  return `${output}\\.\n`;
}

async function psql(args, sql, {readOnly = false} = {}) {
  const useWsl = process.platform === 'win32';
  const command = useWsl ? 'wsl' : (process.env.SHEIN_BI_DOCKER_COMMAND || 'sudo');
  const applicationEnv = args.applicationName ? ` -e PGAPPNAME=${args.applicationName}` : '';
  const base = `sudo docker exec -i${applicationEnv} ${args.container} psql -U ${args.user} -d ${args.database} -v ON_ERROR_STOP=1`;
  const dockerApplicationEnv = args.applicationName ? ['-e', `PGAPPNAME=${args.applicationName}`] : [];
  const commandArgs = useWsl
    ? ['-d', process.env.SHEIN_BI_WSL_DISTRO || 'Ubuntu-24.04', '--', 'bash', '-lc', base]
    : command === 'sudo'
      ? ['-n','docker','exec','-i',...dockerApplicationEnv,args.container,'psql','-U',args.user,'-d',args.database,'-v','ON_ERROR_STOP=1']
      : ['exec','-i',...dockerApplicationEnv,args.container,'psql','-U',args.user,'-d',args.database,'-v','ON_ERROR_STOP=1'];
  if (args.dryRun && !readOnly) return {stdout: '', dryRun: true, sqlBytes: Buffer.byteLength(sql)};
  const child = spawn(command, commandArgs, {stdio: ['pipe','pipe','pipe'], windowsHide: true});
  const stdout = [];
  const stderr = [];
  let stdinError = null;
  let spawnError = null;
  child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
  // PostgreSQL can intentionally reject a stale source snapshot before Node
  // has finished flushing a large COPY payload.  Capture that EPIPE so the
  // caller sees the real psql error instead of an unhandled stream crash.
  child.stdin.on('error', error => { stdinError = error; });
  const completion = new Promise(resolve => {
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, signal) => resolve({code, signal}));
  });
  try {
    child.stdin.end(sql);
  } catch (error) {
    stdinError = error;
  }
  const {code, signal} = await completion;
  const out = Buffer.concat(stdout).toString('utf8');
  const err = Buffer.concat(stderr).toString('utf8');
  if (spawnError) throw new Error(`psql spawn failed: ${spawnError.message || spawnError}`);
  if (code !== 0 || stdinError) {
    const status = code ?? `signal=${signal || 'unknown'}`;
    const stdinDetail = stdinError
      ? `\nstdin write failed (${stdinError.code || 'unknown'}): ${stdinError.message || stdinError}`
      : '';
    throw new Error(`psql failed (${status})${stdinDetail}\n${err.slice(-5000)}`);
  }
  return {stdout: out, stderr: err};
}

async function queryJson(args, query) {
  const result = await psql(args, `\\pset tuples_only on\n\\pset format unaligned\n${query}\n`, {readOnly: true});
  const line = result.stdout.split(/\r?\n/).map(value => value.trim()).find(value => value.startsWith('{') || value.startsWith('['));
  return line ? JSON.parse(line) : null;
}

async function resolveRebuildBoundary(args) {
  const meta = await queryJson(args, `
SELECT jsonb_build_object(
  'latestFrozenMonth', max(month_start) FILTER (WHERE status='frozen'),
  'latestApprovedOpeningDate', (SELECT max(effective_date) FROM fact.inventory_cost_opening WHERE status='approved'),
  'rebuildFrom', coalesce(
    (max(month_start) FILTER (WHERE status='frozen') + interval '1 month')::date,
    (SELECT max(effective_date) FROM fact.inventory_cost_opening WHERE status='approved')
  )
)::text FROM ops.accounting_period_close;`);
  if (args.from) {
    const latestFrozenMonth = meta?.latestFrozenMonth || null;
    const protectedBefore = meta?.rebuildFrom || null;
    if (protectedBefore && String(args.from) < String(protectedBefore)) {
      throw new Error(`Refusing to rewrite frozen accounting periods: from=${args.from} protectedBefore=${protectedBefore} latestFrozenMonth=${latestFrozenMonth}`);
    }
    return {rebuildFrom: args.from, latestFrozenMonth, source: 'explicit'};
  }
  return {
    rebuildFrom: meta?.rebuildFrom || null,
    latestFrozenMonth: meta?.latestFrozenMonth || null,
    latestApprovedOpeningDate: meta?.latestApprovedOpeningDate || null,
    source: meta?.latestFrozenMonth ? 'period-close' : (meta?.latestApprovedOpeningDate ? 'approved-opening' : 'full-history'),
  };
}

async function loadSources(args, rebuildFrom) {
  const cutoff = rebuildFrom ? `${sqlLiteral(rebuildFrom)}::date` : "'-infinity'::date";
  const sourceCountsSql = SOURCE_TABLES.flatMap(table => [
    sqlLiteral(table),
    `(SELECT count(*) FROM ${table})`,
  ]).join(',\n    ');
  return await queryJson(args, `
SELECT jsonb_build_object(
  'sourceSnapshotAt', statement_timestamp(),
  'sourceSnapshot', txid_current_snapshot()::text,
  'sourceCounts', jsonb_build_object(
    ${sourceCountsSql}
  ),
  'openingStates', coalesce((
    SELECT jsonb_agg(to_jsonb(x)) FROM (
      SELECT DISTINCT ON (match_key) match_key, quantity_after AS quantity, value_after_sar AS value,
        avg_unit_cost_after_sar AS avg_unit_cost
      FROM fact.inventory_cost_ledger
      WHERE effective_at::date < ${cutoff}
      ORDER BY match_key, effective_at DESC,
        CASE event_type
          WHEN 'adjustment' THEN 40
          WHEN 'rtv_09_return' THEN 30
          WHEN 'sale' THEN 20
          WHEN 'receipt' THEN 10
          WHEN 'inventory_count_reset' THEN 1
          WHEN 'opening' THEN 0
          ELSE 99
        END DESC,
        event_key DESC
    ) x
  ), '[]'::jsonb),
  'openings', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'openingKey', opening_key, 'effectiveAt', effective_date::timestamp,
      'matchKey', match_key, 'quantity', opening_quantity,
      'costAmountSar', opening_quantity * opening_unit_cost_sar,
      'eventType', CASE WHEN source='et_inventory_count_reset' THEN 'inventory_count_reset' ELSE 'opening' END
    ) ORDER BY effective_date, opening_key)
    FROM fact.inventory_cost_opening
    WHERE status='approved' AND effective_date >= ${cutoff}
  ), '[]'::jsonb),
  'receipts', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'batchKey', batch_key, 'effectiveAt', arrived_date::timestamp,
      'matchKey', dim.product_match_key(standard_goods_sn),
      'quantity', shipped_quantity, 'costAmountSar', cost_sar
    ) ORDER BY arrived_date, batch_key)
    FROM mart.product_cost_batch_timeline
    WHERE complete_batch AND arrived_date IS NOT NULL AND arrived_date >= ${cutoff}
      AND coalesce(shipped_quantity,0) > 0 AND cost_sar IS NOT NULL
  ), '[]'::jsonb),
  'sales', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'orderItemKey', sale.order_item_key,
      'effectiveAt', sale.effective_at,
      'matchKey', sale.match_key,
      'quantity', sale.quantity,
      'estimatedUnitCostSar', coalesce(transit.unit_cost_sar,past.unit_cost_sar),
      'estimatedCostBasis', CASE
        WHEN transit.unit_cost_sar IS NOT NULL THEN 'in_transit_weighted_as_of_sale'
        WHEN past.unit_cost_sar IS NOT NULL THEN 'past_arrived_weighted_as_of_sale'
        ELSE NULL
      END
    ) ORDER BY sale.effective_at, sale.order_item_key)
    FROM (
      SELECT
        oi.order_item_key,
        coalesce(oi.order_create_time,oi.created_date::timestamp) AS effective_at,
        coalesce(oi.order_create_time,oi.created_date::timestamp)::date AS effective_date,
        dim.product_match_key(oi.standard_goods_sn) AS match_key,
        oi.quantity
      FROM fact.order_item oi
      WHERE oi.created_date >= ${cutoff}
        AND coalesce(oi.quantity,0) > 0
        AND coalesce(oi.sales_sar,0) > 0
    ) sale
    LEFT JOIN LATERAL (
      SELECT
        sum(b.cost_sar) / nullif(sum(b.shipped_quantity),0) AS unit_cost_sar
      FROM mart.product_cost_batch_timeline b
      WHERE b.complete_batch
        AND dim.product_match_key(b.standard_goods_sn) = sale.match_key
        AND coalesce(b.shipped_quantity,0) > 0
        AND b.cost_sar IS NOT NULL
        AND b.shipped_date <= sale.effective_date
        AND (b.arrived_date IS NULL OR b.arrived_date > sale.effective_date)
    ) transit ON true
    LEFT JOIN LATERAL (
      SELECT
        sum(b.cost_sar) / nullif(sum(b.shipped_quantity),0) AS unit_cost_sar
      FROM mart.product_cost_batch_timeline b
      WHERE b.complete_batch
        AND dim.product_match_key(b.standard_goods_sn) = sale.match_key
        AND coalesce(b.shipped_quantity,0) > 0
        AND b.cost_sar IS NOT NULL
        AND b.arrived_date IS NOT NULL
        AND b.arrived_date <= sale.effective_date
    ) past ON true
  ), '[]'::jsonb),
  'rtv', coalesce((
    SELECT jsonb_agg(to_jsonb(x) ORDER BY x.effective_at, x.event_key) FROM (
      WITH rtv_match_candidate AS (
        SELECT
          ai.store_key,
          ai.order_no,
          coalesce(nullif(ai.aftersales_order_no,''),nullif(ai.return_order_no,''),ai.order_no) AS economic_return_key,
          d.return_order_id AS et_return_order_id,
          d.match_key,
          d.latest_destination_time,
          d.rtv_received_time,
          d.final_09_quantity,
          'mart.et_rtv_destination_allocation'::text AS source_table,
          0 AS source_priority
        FROM mart.et_rtv_destination_allocation d
        JOIN fact.after_sales_item ai
          ON ai.return_order_no = d.return_order_id
         AND dim.product_match_key(ai.standard_goods_sn) = d.match_key
        WHERE coalesce(d.final_09_quantity,0) > 0

        UNION ALL

        SELECT
          ai.store_key,
          ai.order_no,
          coalesce(nullif(ai.aftersales_order_no,''),nullif(ai.return_order_no,''),ai.order_no) AS economic_return_key,
          d.return_order_id AS et_return_order_id,
          d.match_key,
          d.latest_destination_time,
          d.rtv_received_time,
          d.final_09_quantity,
          'ops.rtv_tracking_verification'::text AS source_table,
          1 AS source_priority
        FROM ops.rtv_tracking_verification v
        JOIN fact.after_sales_item ai
          ON ai.store_key = v.store_key
         AND ai.aftersales_order_no = v.shein_aftersales_order_no
        JOIN mart.et_rtv_destination_allocation d
          ON d.return_order_id = v.et_return_order_id
         AND d.match_key = dim.product_match_key(ai.standard_goods_sn)
        WHERE v.match_status = 'matched'
          AND coalesce(d.final_09_quantity,0) > 0
      ),
      rtv_candidate_dedup AS (
        -- A direct SHEIN=ET id and a manually verified replacement ET id may
        -- describe the same after-sales case.  Deduplicate repeated fact rows
        -- first, then choose exactly one evidence path for the economic return.
        SELECT DISTINCT ON (
          store_key, order_no, economic_return_key, et_return_order_id, match_key, source_priority
        )
          store_key,
          order_no,
          economic_return_key,
          et_return_order_id,
          match_key,
          latest_destination_time,
          rtv_received_time,
          final_09_quantity,
          source_table,
          source_priority
        FROM rtv_match_candidate
        ORDER BY
          store_key, order_no, economic_return_key, et_return_order_id, match_key, source_priority,
          coalesce(latest_destination_time,rtv_received_time) DESC
      ),
      rtv_match AS (
        SELECT *
        FROM (
          SELECT
            d.*,
            min(source_priority) OVER (
              PARTITION BY store_key, order_no, economic_return_key, match_key
            ) AS selected_source_priority
          FROM rtv_candidate_dedup d
        ) selected
        WHERE source_priority = selected_source_priority
      ),
      rtv_final AS (
        SELECT
          store_key,
          order_no,
          economic_return_key,
          match_key,
          max(coalesce(latest_destination_time, rtv_received_time)) AS effective_at,
          sum(final_09_quantity) AS final_09_quantity,
          min(source_table) AS source_table
        FROM rtv_match
        GROUP BY store_key, order_no, economic_return_key, match_key
      )
      SELECT
        'rtv09:' || rr.store_key || ':' || rr.economic_return_key || ':' || oi.order_item_key AS event_key,
        rr.effective_at,
        dim.product_match_key(oi.standard_goods_sn) AS match_key,
        least(
          coalesce(oi.quantity,0),
          coalesce(rr.final_09_quantity,0) * coalesce(oi.quantity,0)
            / nullif(sum(coalesce(oi.quantity,0)) OVER (
                PARTITION BY rr.store_key, rr.order_no, rr.economic_return_key,
                  dim.product_match_key(oi.standard_goods_sn)
              ),0)
        ) AS quantity,
        oi.order_item_key AS source_order_item_key,
        rr.source_table,
        CASE
          WHEN oi.created_date < ${cutoff}
           AND EXISTS (
             SELECT 1
             FROM ops.accounting_period_close pc
             WHERE pc.month_start = date_trunc('month',oi.created_date)::date
               AND pc.status='frozen'
           )
          THEN ca.unit_cost_sar
          ELSE NULL
        END AS unit_cost_sar
      FROM rtv_final rr
      JOIN fact.order_item oi
        ON oi.store_key = rr.store_key
       AND oi.order_no = rr.order_no
       AND dim.product_match_key(oi.standard_goods_sn) = rr.match_key
      LEFT JOIN mart.inventory_cost_sale_assignment ca
        ON ca.order_item_key = oi.order_item_key
      WHERE rr.effective_at::date >= ${cutoff}
    ) x WHERE x.quantity > 0
  ), '[]'::jsonb)
)::text;`);
}

function eventsFromSources(source) {
  const events = [];
  for (const row of source.openings || []) events.push({
    eventKey: `opening:${row.openingKey}`, matchKey: row.matchKey, effectiveAt: row.effectiveAt,
    eventType: row.eventType || 'opening', quantity: row.quantity, costAmountSar: row.costAmountSar,
    sourceTable: 'fact.inventory_cost_opening', sourceKey: row.openingKey,
  });
  for (const row of source.receipts || []) events.push({
    eventKey: `receipt:${row.batchKey}`, matchKey: row.matchKey, effectiveAt: row.effectiveAt,
    eventType: 'receipt', quantity: row.quantity, costAmountSar: row.costAmountSar,
    sourceTable: 'mart.product_cost_batch_timeline', sourceKey: row.batchKey,
  });
  for (const row of source.sales || []) events.push({
    eventKey: `sale:${row.orderItemKey}`, matchKey: row.matchKey, effectiveAt: row.effectiveAt,
    eventType: 'sale', quantity: row.quantity, sourceTable: 'fact.order_item',
    sourceKey: row.orderItemKey, sourceOrderItemKey: row.orderItemKey,
    estimatedUnitCostSar: row.estimatedUnitCostSar, estimatedCostBasis: row.estimatedCostBasis,
  });
  for (const row of source.rtv || []) events.push({
    eventKey: row.event_key, matchKey: row.match_key, effectiveAt: row.effective_at,
    eventType: 'rtv_09_return', quantity: row.quantity,
    sourceTable: row.source_table || 'mart.et_rtv_destination_allocation',
    sourceKey: row.event_key, sourceOrderItemKey: row.source_order_item_key, unitCostSar: row.unit_cost_sar,
  });
  return events.map(event => ({...event, sourceHash: sha(JSON.stringify(event))}));
}

function openingStateMap(rows) {
  return new Map((rows || []).map(row => [String(row.match_key || row.matchKey), {
    quantity: Number(row.quantity || 0), value: Number(row.value || 0), avgUnitCost: Number(row.avg_unit_cost || row.avgUnitCost || 0),
  }]));
}

function monthStart(value) {
  return `${String(value).slice(0, 7)}-01`;
}

async function readInventoryCostRun(args, runId) {
  return await queryJson(args, `
SELECT jsonb_build_object(
  'runId', run_id,
  'status', status,
  'sourceHash', source_hash,
  'sourceCutoffAt', source_cutoff_at,
  'startedAt', started_at,
  'completedAt', completed_at,
  'ledgerVersion', ledger_version,
  'eventCount', event_count,
  'saleCount', sale_count,
  'unvaluedSaleCount', unvalued_sale_count,
  'summary', summary
)::text
FROM ops.inventory_cost_run
WHERE run_id=${sqlLiteral(runId)};`);
}

async function authoritativeInventoryCostRunReadback(args, run) {
  const readback = await queryJson(args, `
SELECT jsonb_build_object(
  'runId', r.run_id,
  'status', r.status,
  'sourceHash', r.source_hash,
  'ledgerVersion', r.ledger_version,
  'eventRows', (SELECT count(*) FROM fact.inventory_cost_ledger l WHERE l.ledger_version = r.ledger_version),
  'saleRows', (SELECT count(*) FROM fact.inventory_cost_ledger l WHERE l.ledger_version = r.ledger_version AND l.event_type='sale'),
  'unvaluedSaleRows', (SELECT count(*) FROM fact.inventory_cost_ledger l WHERE l.ledger_version = r.ledger_version AND l.event_type='sale' AND l.unvalued_quantity > 0),
  'frozenRowsTouched', (SELECT count(*) FROM fact.inventory_cost_ledger l JOIN ops.accounting_period_close c ON c.month_start=date_trunc('month',l.effective_at)::date AND c.status='frozen' WHERE l.ledger_version = r.ledger_version)
)::text
FROM ops.inventory_cost_run r
WHERE r.run_id=${sqlLiteral(run.runId)};`);
  if (!readback
    || readback.status !== 'completed'
    || String(readback.sourceHash || '').toLowerCase() !== String(run.sourceHash || '').toLowerCase()
    || String(readback.ledgerVersion || '') !== String(run.ledgerVersion || '')
    || Number(readback.eventRows) !== Number(run.eventCount)
    || Number(readback.saleRows) !== Number(run.saleCount)
    || Number(readback.unvaluedSaleRows) !== Number(run.unvaluedSaleCount)
    || Number(readback.frozenRowsTouched) !== 0) {
    throw new Error(`Inventory cost ledger authoritative readback failed: ${JSON.stringify(readback)}`);
  }
  return readback;
}

async function markInventoryCostRunRunning(args, run, rebuildFrom) {
  if (args.dryRun) return {dryRun: true};
  await psql(args, `
BEGIN;
INSERT INTO ops.inventory_cost_run(
  run_id,ledger_version,started_at,completed_at,rebuild_from,source_cutoff_at,source_hash,
  event_count,sale_count,unvalued_sale_count,status,summary
) VALUES (
  ${[
    run.runId, run.ledgerVersion, run.startedAt, null, rebuildFrom, run.sourceCutoffAt, run.sourceHash,
    run.eventCount, run.saleCount, run.unvaluedSaleCount, 'running', JSON.stringify(run.summary),
  ].map(sqlLiteral).join(',')}
)
ON CONFLICT (run_id) DO UPDATE SET
  status = CASE WHEN ops.inventory_cost_run.status='completed' THEN ops.inventory_cost_run.status ELSE 'running' END,
  summary = CASE WHEN ops.inventory_cost_run.status='completed' THEN ops.inventory_cost_run.summary ELSE EXCLUDED.summary END
WHERE ops.inventory_cost_run.source_hash=EXCLUDED.source_hash
  AND ops.inventory_cost_run.ledger_version=EXCLUDED.ledger_version;
DO $inventory_cost_run_identity_guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ops.inventory_cost_run
    WHERE run_id=${sqlLiteral(run.runId)}
      AND source_hash=${sqlLiteral(run.sourceHash)}
      AND ledger_version=${sqlLiteral(run.ledgerVersion)}
  ) THEN
    RAISE EXCEPTION 'inventory-cost deterministic run identity conflict: %', ${sqlLiteral(run.runId)};
  END IF;
END
$inventory_cost_run_identity_guard$;
COMMIT;`);
  return await readInventoryCostRun(args, run.runId);
}

async function writeLedger(args, {events, ledgerRows, run, rebuildFrom}) {
  const eventColumns = ['event_key','match_key','effective_at','event_type','quantity','cost_amount_sar','source_table','source_key','source_order_item_key','estimated_unit_cost_sar','estimated_cost_basis','source_hash','period_key'];
  const ledgerColumns = ['event_key','match_key','effective_at','event_type','source_table','source_key','source_order_item_key','quantity','cost_amount_sar','quantity_before','value_before_sar','avg_unit_cost_before_sar','quantity_after','value_after_sar','avg_unit_cost_after_sar','valued_quantity','unvalued_quantity','estimated_quantity','settled_estimated_quantity','estimation_variance_sar','cogs_sar','valuation_status','valuation_basis','ledger_version'];
  const eventDbRows = events.map(event => ({
    event_key: event.eventKey, match_key: event.matchKey, effective_at: event.effectiveAt,
    event_type: event.eventType, quantity: event.quantity, cost_amount_sar: event.costAmountSar,
    source_table: event.sourceTable, source_key: event.sourceKey, source_order_item_key: event.sourceOrderItemKey,
    estimated_unit_cost_sar: event.estimatedUnitCostSar, estimated_cost_basis: event.estimatedCostBasis,
    source_hash: event.sourceHash, period_key: monthStart(event.effectiveAt),
  }));
  const ledgerDbRows = ledgerRows.map(row => ({
    event_key: row.eventKey, match_key: row.matchKey, effective_at: row.effectiveAt,
    event_type: row.eventType, source_table: row.sourceTable, source_key: row.sourceKey,
    source_order_item_key: row.sourceOrderItemKey, quantity: row.quantity, cost_amount_sar: row.costAmountSar,
    quantity_before: row.quantityBefore, value_before_sar: row.valueBeforeSar,
    avg_unit_cost_before_sar: row.avgUnitCostBeforeSar, quantity_after: row.quantityAfter,
    value_after_sar: row.valueAfterSar, avg_unit_cost_after_sar: row.avgUnitCostAfterSar,
    valued_quantity: row.valuedQuantity, unvalued_quantity: row.unvaluedQuantity,
    estimated_quantity: row.estimatedQuantity,
    settled_estimated_quantity: row.settledEstimatedQuantity,
    estimation_variance_sar: row.estimationVarianceSar,
    cogs_sar: row.cogsSar, valuation_status: row.valuationStatus,
    valuation_basis: row.valuationBasis, ledger_version: row.ledgerVersion,
  }));
  const condition = rebuildFrom ? `effective_at::date >= ${sqlLiteral(rebuildFrom)}::date` : 'true';
  let sql = 'BEGIN;\n';
  sql += "SELECT pg_advisory_xact_lock(hashtextextended('shein-inventory-cost-ledger-rebuild', 0));\n";
  // The read and write happen in separate processes/transactions. Lock every
  // mutable source used by the snapshot, then reject the write if any source
  // changed after the exact database statement timestamp returned by
  // loadSources(). This closes the gap where a new order could otherwise land
  // between the JSON snapshot and the ledger commit.
  sql += `LOCK TABLE
    ${SOURCE_TABLES.join(',\n    ')}
  IN SHARE MODE;\n`;
  sql += `DO $inventory_cost_rebuild_guard$\nBEGIN\n`;
  sql += `  IF EXISTS (\n`;
  sql += `    SELECT 1 FROM ops.inventory_cost_run\n`;
  sql += `    WHERE status = 'completed'\n`;
  sql += `      AND completed_at > ${sqlLiteral(run.startedAt)}::timestamptz\n`;
  sql += `  ) THEN\n`;
  sql += `    RAISE EXCEPTION 'stale inventory-cost rebuild refused: a newer snapshot committed after %', ${sqlLiteral(run.startedAt)}::timestamptz;\n`;
  sql += `  END IF;\nEND\n$inventory_cost_rebuild_guard$;\n`;
  const sourceSnapshot = String(run.sourceSnapshot || '').trim();
  if (!sourceSnapshot) throw new Error('Inventory cost source snapshot is missing');
  const sourceGuards = SOURCE_TABLES.map(table => {
    const expectedCount = Number(run.sourceCounts?.[table]);
    if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) {
      throw new Error(`Inventory cost source count is invalid: table=${table} count=${run.sourceCounts?.[table]}`);
    }
    return `EXISTS (
      SELECT 1
      FROM (
        SELECT
          count(*)::bigint AS row_count,
          count(*) FILTER (
            WHERE NOT txid_visible_in_snapshot(
              (xmin::text)::bigint,
              ${sqlLiteral(sourceSnapshot)}::txid_snapshot
            )
          )::bigint AS rows_not_visible_in_snapshot
        FROM ${table}
      ) source_state
      WHERE source_state.row_count <> ${expectedCount}
         OR source_state.rows_not_visible_in_snapshot > 0
    )`;
  });
  sql += `DO $inventory_cost_source_guard$\nBEGIN\n`;
  sql += `  IF ${sourceGuards.join('\n    OR ')}\n`;
  sql += `  THEN\n`;
  sql += `    RAISE EXCEPTION 'inventory-cost source changed after snapshot %; retry rebuild', ${sqlLiteral(run.sourceCutoffAt)}::timestamptz;\n`;
  sql += `  END IF;\nEND\n$inventory_cost_source_guard$;\n`;
  sql += `DELETE FROM fact.inventory_cost_event WHERE ${condition};\n`;
  sql += copyBlock('fact.inventory_cost_event', eventColumns, eventDbRows);
  sql += copyBlock('fact.inventory_cost_ledger', ledgerColumns, ledgerDbRows);
  sql += `INSERT INTO ops.inventory_cost_run(run_id,ledger_version,started_at,completed_at,rebuild_from,source_cutoff_at,source_hash,event_count,sale_count,unvalued_sale_count,status,summary) VALUES (`;
  sql += [run.runId, run.ledgerVersion, run.startedAt, run.completedAt, rebuildFrom, run.sourceCutoffAt, run.sourceHash, run.eventCount, run.saleCount, run.unvaluedSaleCount, 'completed', JSON.stringify(run.summary)].map(sqlLiteral).join(',');
  sql += `) ON CONFLICT (run_id) DO UPDATE SET
    completed_at=EXCLUDED.completed_at,
    status=EXCLUDED.status,
    summary=EXCLUDED.summary,
    event_count=EXCLUDED.event_count,
    sale_count=EXCLUDED.sale_count,
    unvalued_sale_count=EXCLUDED.unvalued_sale_count
  WHERE ops.inventory_cost_run.source_hash=EXCLUDED.source_hash
    AND ops.inventory_cost_run.ledger_version=EXCLUDED.ledger_version;
DO $inventory_cost_completion_guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ops.inventory_cost_run
    WHERE run_id=${sqlLiteral(run.runId)}
      AND source_hash=${sqlLiteral(run.sourceHash)}
      AND ledger_version=${sqlLiteral(run.ledgerVersion)}
      AND status='completed'
  ) THEN
    RAISE EXCEPTION 'inventory-cost completion identity conflict: %', ${sqlLiteral(run.runId)};
  END IF;
END
$inventory_cost_completion_guard$;
COMMIT;
`;
  return await psql(args, sql);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const boundary = await resolveRebuildBoundary(args);
  const source = await loadSources(args, boundary.rebuildFrom);
  const events = eventsFromSources(source || {});
  const sourceHash = sha(JSON.stringify({
    events,
    openingStates: [...openingStateMap(source?.openingStates).entries()]
      .sort(([left], [right]) => left.localeCompare(right)),
  }));
  const ledgerVersion = `moving-average-v1:${sourceHash.slice(0, 16)}`;
  const built = buildInventoryCostLedger(events, {openingStates: openingStateMap(source?.openingStates), ledgerVersion});
  const completedAt = new Date().toISOString();
  const saleRows = built.rows.filter(row => row.eventType === 'sale');
  const identity = inventoryCostRunIdentity(args.logicalRunKey, sourceHash);
  const summary = {
    rebuildFrom: boundary.rebuildFrom,
    latestFrozenMonth: boundary.latestFrozenMonth,
    sourceSnapshot: source?.sourceSnapshot || '',
    sourceCounts: source?.sourceCounts || {},
    eventTypes: built.rows.reduce((acc, row) => ({...acc, [row.eventType]: (acc[row.eventType] || 0) + 1}), {}),
    valuationStatuses: saleRows.reduce((acc, row) => ({...acc, [row.valuationStatus]: (acc[row.valuationStatus] || 0) + 1}), {}),
    estimatedSaleQuantity: saleRows.reduce((sum, row) => sum + Number(row.estimatedQuantity || 0), 0),
    settledEstimatedQuantity: saleRows.reduce((sum, row) => sum + Number(row.settledEstimatedQuantity || 0), 0),
    estimationVarianceSar: saleRows.reduce((sum, row) => sum + Number(row.estimationVarianceSar || 0), 0),
    endingProducts: built.endingStates.size,
    logicalRun: identity ? {
      key: identity.logicalRunKey,
      keyHash: identity.logicalRunKeyHash,
      sourceFingerprint: identity.sourceFingerprint,
      revision: identity.revision,
    } : null,
  };
  const run = {
    runId: identity?.runId || `inventory-cost-${completedAt.replace(/[-:.TZ]/g, '').slice(0, 14)}-${process.pid}`,
    ledgerVersion,
    startedAt,
    completedAt,
    // This is the database statement snapshot that produced the event set,
    // not the later Node completion time. A concurrent order arriving after
    // the read must therefore invalidate freshness instead of being claimed
    // as covered by this run.
    sourceCutoffAt: source?.sourceSnapshotAt || startedAt,
    sourceSnapshot: source?.sourceSnapshot || '',
    sourceCounts: source?.sourceCounts || {},
    sourceHash,
    eventCount: built.rows.length, saleCount: saleRows.length,
    unvaluedSaleCount: saleRows.filter(row => row.unvaluedQuantity > 0).length, summary,
  };

  let existingRun = null;
  let identityDecision = {action: identity ? 'start' : 'legacy'};
  if (identity && !args.dryRun) {
    existingRun = await readInventoryCostRun(args, run.runId);
    identityDecision = inventoryCostExistingRunDecision(existingRun, identity);
    if (identityDecision.action === 'conflict') {
      throw new Error(`Inventory cost logical run identity conflict: ${JSON.stringify({identity, existingRun})}`);
    }
    if (existingRun?.sourceCutoffAt) run.sourceCutoffAt = existingRun.sourceCutoffAt;
    if (identityDecision.action === 'verify_completed') {
      const readback = await authoritativeInventoryCostRunReadback(args, run);
      console.log(JSON.stringify({
        ok: true,
        dryRun: false,
        reused: true,
        logicalRunKey: identity.logicalRunKey,
        sourceFingerprint: identity.sourceFingerprint,
        run: {...run, completedAt: existingRun.completedAt || run.completedAt},
        write: {skipped: true, reason: 'completed_same_logical_run_and_source_fingerprint'},
        readback,
      }, null, 2));
      return;
    }
    run.summary.reconciledFromStatus = identityDecision.status || '';
    await markInventoryCostRunRunning(args, run, boundary.rebuildFrom);
  }

  const write = await writeLedger(args, {events, ledgerRows: built.rows, run, rebuildFrom: boundary.rebuildFrom});
  const readback = args.dryRun ? null : await authoritativeInventoryCostRunReadback(args, run);
  console.log(JSON.stringify({
    ok: true,
    dryRun: args.dryRun,
    reused: false,
    logicalRunKey: identity?.logicalRunKey || '',
    sourceFingerprint: identity?.sourceFingerprint || sourceHash,
    identityDecision,
    run,
    write,
    readback,
  }, null, 2));
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  main().catch(error => {
    console.error(error?.stack || error);
    process.exit(1);
  });
}
