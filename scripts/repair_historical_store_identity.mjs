#!/usr/bin/env node
/**
 * Repair a proven historical browser-profile/store identity mix-up.
 *
 * Default mode is read-only and prints a deterministic manifest hash. Execution
 * requires both --execute and the exact --confirm-hash value from that dry-run.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {validateHistoricalStoreIdentityConfig} from '../lib/historical_store_identity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    container: 'shein-warehouse-db',
    database: 'shein_bi',
    user: 'shein',
    distro: 'Ubuntu-24.04',
    execute: false,
    confirmHash: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--container') args.container = argv[++index];
    else if (arg === '--database') args.database = argv[++index];
    else if (arg === '--user') args.user = argv[++index];
    else if (arg === '--distro') args.distro = argv[++index];
    else if (arg === '--execute') args.execute = true;
    else if (arg === '--confirm-hash') args.confirmHash = String(argv[++index] || '').trim();
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/repair_historical_store_identity.mjs [--execute --confirm-hash <sha256>]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function psqlSpawn(args) {
  const docker = `sudo docker exec -i ${shellQuote(args.container)} psql -X -U ${shellQuote(args.user)} -d ${shellQuote(args.database)} -v ON_ERROR_STOP=1 -qAt`;
  if (process.platform === 'win32') {
    return {command: 'wsl', args: ['-d', args.distro, '--', 'bash', '-lc', docker]};
  }
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return {
      command: 'bash',
      args: ['-lc', docker.replace(/^sudo /, '')],
    };
  }
  return {command: 'bash', args: ['-lc', docker]};
}

async function runPsql(args, sql) {
  const command = psqlSpawn(args);
  const child = spawn(command.command, command.args, {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
  child.stdin.end(sql);
  const code = await new Promise(resolve => child.on('close', resolve));
  const out = Buffer.concat(stdout).toString('utf8').trim();
  const err = Buffer.concat(stderr).toString('utf8').trim();
  if (code !== 0) throw new Error(`psql failed (${code})\n${err.slice(-6000)}\n${out.slice(-2000)}`);
  return out;
}

function correctionValues(corrections) {
  return corrections.map(row => `(
    ${sqlLiteral(row.id)},
    ${sqlLiteral(row.sourceStoreKey)},
    ${sqlLiteral(row.effectiveStoreKey)},
    ${sqlLiteral(row.startDate)}::date,
    ${sqlLiteral(row.endDate)}::date,
    ${Number(row.expectedItemRows || 0)}
  )`).join(',\n');
}

function correctionCte(corrections) {
  return `corrections(correction_id,source_store_key,effective_store_key,start_date,end_date,expected_item_rows) AS (
  VALUES ${correctionValues(corrections)}
)`;
}

function inspectionSql(corrections, incidentId) {
  return `
WITH
${correctionCte(corrections)},
link_owner AS (
  SELECT skc,min(store_key) AS owner_store,count(DISTINCT store_key) AS owner_store_count
  FROM fact.link_master_snapshot
  WHERE coalesce(skc,'')<>''
  GROUP BY skc
),
candidate_items AS (
  SELECT
    c.correction_id,
    oi.order_item_key AS old_order_item_key,
    regexp_replace(oi.order_item_key,'^[^_]+__',c.effective_store_key||'__') AS new_order_item_key,
    oi.order_key AS old_order_key,
    regexp_replace(oi.order_key,'^[^_]+__',c.effective_store_key||'__') AS new_order_key,
    oi.order_no,
    oi.created_date,
    c.source_store_key,
    c.effective_store_key,
    oi.standard_goods_sn,
    oi.skc,
    oi.quantity,
    oi.sales_sar,
    oi.source_file,
    lo.owner_store,
    lo.owner_store_count
  FROM fact.order_item oi
  JOIN corrections c
    ON oi.store_key=c.source_store_key
   AND oi.created_date BETWEEN c.start_date AND c.end_date
   AND oi.source_file LIKE 'outputs/shein_fetch/'||c.source_store_key||'/%'
  LEFT JOIN link_owner lo ON lo.skc=oi.skc
),
candidate_orders AS (
  SELECT DISTINCT old_order_key,new_order_key,order_no,created_date,source_store_key,effective_store_key
  FROM candidate_items
),
candidate_json AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'correctionId',correction_id,
    'oldOrderItemKey',old_order_item_key,
    'newOrderItemKey',new_order_item_key,
    'oldOrderKey',old_order_key,
    'newOrderKey',new_order_key,
    'orderNo',order_no,
    'createdDate',created_date,
    'sourceStoreKey',source_store_key,
    'effectiveStoreKey',effective_store_key,
    'standardGoodsSn',standard_goods_sn,
    'skc',skc,
    'quantity',quantity,
    'salesSar',sales_sar,
    'sourceFile',source_file,
    'ownerStore',owner_store
  ) ORDER BY old_order_item_key),'[]'::jsonb) AS rows
  FROM candidate_items
),
cross_store_after_sales AS (
  SELECT count(DISTINCT a.order_no) AS orders
  FROM fact.after_sales_item a
  WHERE EXISTS (
    SELECT 1 FROM fact.order_item oi
    WHERE oi.order_no=a.order_no
      AND oi.store_key<>a.store_key
      AND (
        (coalesce(a.skc,'')<>'' AND oi.skc=a.skc)
        OR dim.product_match_key(oi.standard_goods_sn)=dim.product_match_key(a.standard_goods_sn)
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM fact.order_item oi
    WHERE oi.order_no=a.order_no
      AND oi.store_key=a.store_key
      AND (
        (coalesce(a.skc,'')<>'' AND oi.skc=a.skc)
        OR dim.product_match_key(oi.standard_goods_sn)=dim.product_match_key(a.standard_goods_sn)
      )
  )
)
SELECT jsonb_build_object(
  'incidentId',${sqlLiteral(incidentId)},
  'candidateItemRows',(SELECT count(*) FROM candidate_items),
  'candidateOrders',(SELECT count(*) FROM candidate_orders),
  'candidateQuantity',(SELECT coalesce(sum(quantity),0) FROM candidate_items),
  'candidateSalesSar',(SELECT coalesce(sum(sales_sar),0) FROM candidate_items),
  'uniqueSkcOwnerConfirmed',(SELECT count(*) FROM candidate_items WHERE owner_store_count=1 AND owner_store=effective_store_key),
  'uniqueSkcOwnerUnresolved',(SELECT count(*) FROM candidate_items WHERE coalesce(owner_store_count,0)<>1),
  'uniqueSkcOwnerContradictions',(SELECT count(*) FROM candidate_items WHERE owner_store_count=1 AND owner_store<>effective_store_key),
  'headers',(SELECT count(*) FROM fact.order_header h JOIN candidate_orders c ON c.old_order_key=h.order_key),
  'paymentFlags',(SELECT count(*) FROM fact.order_payment_flag p JOIN candidate_orders c ON c.old_order_key=p.order_key),
  'oldRecheckRows',(SELECT count(*) FROM ops.order_status_recheck_state r JOIN candidate_items c ON c.old_order_item_key=r.order_item_key),
  'correctRecheckRows',(SELECT count(*) FROM ops.order_status_recheck_state r JOIN candidate_items c ON c.new_order_item_key=r.order_item_key),
  'openApiConfirmedOrders',(
    SELECT count(DISTINCT c.order_no)
    FROM candidate_orders c
    JOIN fact.openapi_order_item oi
      ON oi.order_no=c.order_no AND oi.store_key=c.effective_store_key
  ),
  'afterSalesConfirmedOrders',(
    SELECT count(DISTINCT c.order_no)
    FROM candidate_orders c
    JOIN fact.after_sales_item a
      ON a.order_no=c.order_no AND a.store_key=c.effective_store_key
  ),
  'currentCrossStoreAfterSalesOrders',(SELECT orders FROM cross_store_after_sales),
  'itemKeyCollisions',(
    SELECT count(*) FROM candidate_items c
    JOIN fact.order_item x ON x.order_item_key=c.new_order_item_key AND x.order_item_key<>c.old_order_item_key
  ),
  'headerKeyCollisions',(
    SELECT count(*) FROM candidate_orders c
    JOIN fact.order_header x ON x.order_key=c.new_order_key AND x.order_key<>c.old_order_key
  ),
  'paymentKeyCollisions',(
    SELECT count(*) FROM candidate_orders c
    JOIN fact.order_payment_flag x ON x.order_key=c.new_order_key AND x.order_key<>c.old_order_key
  ),
  'duplicateNewItemKeys',(
    SELECT count(*) FROM (
      SELECT new_order_item_key FROM candidate_items GROUP BY new_order_item_key HAVING count(*)>1
    ) d
  ),
  'duplicateNewOrderKeys',(
    SELECT count(*) FROM (
      SELECT new_order_key FROM candidate_orders GROUP BY new_order_key HAVING count(*)>1
    ) d
  ),
  'costEventReferences',(
    SELECT count(*) FROM fact.inventory_cost_event e
    JOIN candidate_items c ON c.old_order_item_key=e.source_order_item_key
  ),
  'costLedgerReferences',(
    SELECT count(*) FROM fact.inventory_cost_ledger l
    JOIN candidate_items c ON c.old_order_item_key=l.source_order_item_key
  ),
  'priorAuditRows',(
    SELECT count(*) FROM ops.order_store_reassignment_audit
    WHERE run_id LIKE ${sqlLiteral(`${incidentId}:%`)}
  ),
  'countsByCorrection',(
    SELECT coalesce(jsonb_object_agg(correction_id,row_count),'{}'::jsonb)
    FROM (
      SELECT correction_id,count(*) AS row_count FROM candidate_items GROUP BY correction_id
    ) grouped
  ),
  'candidates',(SELECT rows FROM candidate_json)
)::text;
`;
}

function assertInspectionReady(inspection, corrections) {
  const expectedItemRows = corrections.reduce((sum, row) => sum + Number(row.expectedItemRows || 0), 0);
  const failures = [];
  if (Number(inspection.candidateItemRows) !== expectedItemRows) {
    failures.push(`candidate rows ${inspection.candidateItemRows}/${expectedItemRows}`);
  }
  if (Number(inspection.candidateOrders) <= 0) failures.push('no candidate orders');
  if (Number(inspection.headers) !== Number(inspection.candidateOrders)) failures.push('header coverage mismatch');
  if (Number(inspection.paymentFlags) !== Number(inspection.candidateOrders)) failures.push('payment coverage mismatch');
  if (Number(inspection.uniqueSkcOwnerConfirmed) !== expectedItemRows) failures.push('unique SKC ownership is not complete');
  for (const key of [
    'uniqueSkcOwnerUnresolved',
    'uniqueSkcOwnerContradictions',
    'itemKeyCollisions',
    'headerKeyCollisions',
    'paymentKeyCollisions',
    'duplicateNewItemKeys',
    'duplicateNewOrderKeys',
    'costEventReferences',
    'costLedgerReferences',
  ]) {
    if (Number(inspection[key] || 0) !== 0) failures.push(`${key}=${inspection[key]}`);
  }
  for (const correction of corrections) {
    const actual = Number(inspection.countsByCorrection?.[correction.id] || 0);
    if (actual !== Number(correction.expectedItemRows || 0)) {
      failures.push(`${correction.id} rows ${actual}/${correction.expectedItemRows}`);
    }
  }
  if (failures.length) throw new Error(`Historical store identity repair preflight failed: ${failures.join('; ')}`);
}

function executionSql({config, corrections, runId, manifestHash}) {
  const totalExpected = corrections.reduce((sum, row) => sum + Number(row.expectedItemRows || 0), 0);
  const correctionRows = corrections.map(row => `(
    ${sqlLiteral(row.id)},
    ${sqlLiteral(config.incidentId)},
    ${sqlLiteral(row.sourceStoreKey)},
    ${sqlLiteral(row.effectiveStoreKey)},
    ${sqlLiteral(row.startDate)}::date,
    ${sqlLiteral(row.endDate)}::date,
    ${Number(row.expectedItemRows || 0)},
    ${sqlLiteral(config.reason)},
    ${sqlLiteral(JSON.stringify({...config.evidence, correctionExpectedItemRows: row.expectedItemRows}))}::jsonb
  )`).join(',\n');
  return `
BEGIN;
SET LOCAL lock_timeout='15s';
SET LOCAL statement_timeout='10min';
SELECT pg_advisory_xact_lock(hashtextextended('historical-store-identity-repair',0));

CREATE TABLE IF NOT EXISTS ops.historical_store_identity_correction (
  correction_id text PRIMARY KEY,
  incident_id text NOT NULL,
  source_store_key text NOT NULL REFERENCES dim.store(store_key),
  effective_store_key text NOT NULL REFERENCES dim.store(store_key),
  start_date date NOT NULL,
  end_date date NOT NULL,
  expected_item_rows integer,
  reason text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_store_key<>effective_store_key),
  CHECK (start_date<=end_date)
);
CREATE TABLE IF NOT EXISTS ops.order_store_reassignment_audit (
  run_id text NOT NULL,
  correction_id text NOT NULL,
  old_order_item_key text NOT NULL,
  new_order_item_key text NOT NULL,
  old_order_key text,
  new_order_key text,
  order_no text,
  created_date date,
  source_store_key text NOT NULL,
  effective_store_key text NOT NULL,
  standard_goods_sn text,
  skc text,
  quantity numeric,
  sales_sar numeric,
  source_file text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  repaired_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id,old_order_item_key)
);
CREATE INDEX IF NOT EXISTS order_store_reassignment_audit_order_idx
  ON ops.order_store_reassignment_audit(order_no,created_date);

INSERT INTO ops.historical_store_identity_correction(
  correction_id,incident_id,source_store_key,effective_store_key,start_date,end_date,
  expected_item_rows,reason,evidence
) VALUES
${correctionRows}
ON CONFLICT (correction_id) DO UPDATE SET
  incident_id=EXCLUDED.incident_id,
  source_store_key=EXCLUDED.source_store_key,
  effective_store_key=EXCLUDED.effective_store_key,
  start_date=EXCLUDED.start_date,
  end_date=EXCLUDED.end_date,
  expected_item_rows=EXCLUDED.expected_item_rows,
  reason=EXCLUDED.reason,
  evidence=EXCLUDED.evidence,
  active=true,
  updated_at=clock_timestamp();

CREATE TEMP TABLE repair_corrections ON COMMIT DROP AS
SELECT * FROM (VALUES ${correctionValues(corrections)})
  AS v(correction_id,source_store_key,effective_store_key,start_date,end_date,expected_item_rows);

CREATE TEMP TABLE repair_item_map ON COMMIT DROP AS
WITH link_owner AS (
  SELECT skc,min(store_key) AS owner_store,count(DISTINCT store_key) AS owner_store_count
  FROM fact.link_master_snapshot WHERE coalesce(skc,'')<>'' GROUP BY skc
)
SELECT
  c.correction_id,
  oi.order_item_key AS old_order_item_key,
  regexp_replace(oi.order_item_key,'^[^_]+__',c.effective_store_key||'__') AS new_order_item_key,
  oi.order_key AS old_order_key,
  regexp_replace(oi.order_key,'^[^_]+__',c.effective_store_key||'__') AS new_order_key,
  oi.order_no,
  oi.created_date,
  c.source_store_key,
  c.effective_store_key,
  oi.standard_goods_sn,
  oi.skc,
  oi.quantity,
  oi.sales_sar,
  oi.source_file,
  lo.owner_store,
  lo.owner_store_count
FROM fact.order_item oi
JOIN repair_corrections c
  ON oi.store_key=c.source_store_key
 AND oi.created_date BETWEEN c.start_date AND c.end_date
 AND oi.source_file LIKE 'outputs/shein_fetch/'||c.source_store_key||'/%'
LEFT JOIN link_owner lo ON lo.skc=oi.skc;

CREATE TEMP TABLE repair_order_map ON COMMIT DROP AS
SELECT DISTINCT
  correction_id,old_order_key,new_order_key,order_no,created_date,source_store_key,effective_store_key
FROM repair_item_map;

DO $validation$
DECLARE
  item_count integer;
  order_count integer;
  invalid_count integer;
BEGIN
  SELECT count(*) INTO item_count FROM repair_item_map;
  IF item_count<>${totalExpected} THEN
    RAISE EXCEPTION 'candidate item count changed: % expected ${totalExpected}',item_count;
  END IF;
  SELECT count(*) INTO invalid_count
  FROM repair_corrections c
  LEFT JOIN (
    SELECT correction_id,count(*) AS n FROM repair_item_map GROUP BY correction_id
  ) x USING(correction_id)
  WHERE coalesce(x.n,0)<>c.expected_item_rows;
  IF invalid_count<>0 THEN RAISE EXCEPTION 'per-correction item counts changed'; END IF;
  SELECT count(*) INTO invalid_count FROM repair_item_map
  WHERE owner_store_count IS DISTINCT FROM 1 OR owner_store IS DISTINCT FROM effective_store_key;
  IF invalid_count<>0 THEN RAISE EXCEPTION 'SKC ownership validation failed for % rows',invalid_count; END IF;
  SELECT count(*) INTO invalid_count FROM (
    SELECT new_order_item_key FROM repair_item_map GROUP BY new_order_item_key HAVING count(*)>1
  ) duplicate_keys;
  IF invalid_count<>0 THEN RAISE EXCEPTION 'duplicate new order item keys: %',invalid_count; END IF;
  SELECT count(*) INTO invalid_count
  FROM repair_item_map m JOIN fact.order_item x
    ON x.order_item_key=m.new_order_item_key AND x.order_item_key<>m.old_order_item_key;
  IF invalid_count<>0 THEN RAISE EXCEPTION 'new order item key collisions: %',invalid_count; END IF;
  SELECT count(*) INTO invalid_count
  FROM repair_order_map m JOIN fact.order_header x
    ON x.order_key=m.new_order_key AND x.order_key<>m.old_order_key;
  IF invalid_count<>0 THEN RAISE EXCEPTION 'new order header key collisions: %',invalid_count; END IF;
  SELECT count(*) INTO invalid_count
  FROM repair_order_map m JOIN fact.order_payment_flag x
    ON x.order_key=m.new_order_key AND x.order_key<>m.old_order_key;
  IF invalid_count<>0 THEN RAISE EXCEPTION 'new payment key collisions: %',invalid_count; END IF;
  SELECT count(*) INTO invalid_count
  FROM fact.inventory_cost_event e JOIN repair_item_map m
    ON m.old_order_item_key=e.source_order_item_key;
  IF invalid_count<>0 THEN RAISE EXCEPTION 'inventory cost event references require a dedicated ledger rebuild: %',invalid_count; END IF;
  SELECT count(*) INTO invalid_count
  FROM fact.inventory_cost_ledger l JOIN repair_item_map m
    ON m.old_order_item_key=l.source_order_item_key;
  IF invalid_count<>0 THEN RAISE EXCEPTION 'inventory cost ledger references require a dedicated ledger rebuild: %',invalid_count; END IF;
  SELECT count(*) INTO order_count FROM repair_order_map;
  SELECT count(*) INTO invalid_count
  FROM repair_order_map m LEFT JOIN fact.order_header h ON h.order_key=m.old_order_key
  WHERE h.order_key IS NULL;
  IF invalid_count<>0 THEN RAISE EXCEPTION 'missing order headers: %',invalid_count; END IF;
  SELECT count(*) INTO invalid_count
  FROM repair_order_map m LEFT JOIN fact.order_payment_flag p ON p.order_key=m.old_order_key
  WHERE p.order_key IS NULL;
  IF invalid_count<>0 THEN RAISE EXCEPTION 'missing payment flags: %',invalid_count; END IF;
  RAISE NOTICE 'validated % item rows / % orders',item_count,order_count;
END
$validation$;

INSERT INTO ops.order_store_reassignment_audit(
  run_id,correction_id,old_order_item_key,new_order_item_key,old_order_key,new_order_key,
  order_no,created_date,source_store_key,effective_store_key,standard_goods_sn,skc,
  quantity,sales_sar,source_file,evidence
)
SELECT
  ${sqlLiteral(runId)},m.correction_id,m.old_order_item_key,m.new_order_item_key,
  m.old_order_key,m.new_order_key,m.order_no,m.created_date,m.source_store_key,
  m.effective_store_key,m.standard_goods_sn,m.skc,m.quantity,m.sales_sar,m.source_file,
  jsonb_build_object(
    'manifestHash',${sqlLiteral(manifestHash)},
    'ownerStore',m.owner_store,
    'ownerStoreCount',m.owner_store_count,
    'reason',${sqlLiteral(config.reason)}
  )
FROM repair_item_map m;

-- Recheck rows already contain independent correct-store fetches for many
-- orders. Keep those newer correct rows and discard only the duplicate old-key
-- rows; migrate the remaining old-key rows in place.
DELETE FROM ops.order_status_recheck_state old_state
USING repair_item_map m
WHERE old_state.order_item_key=m.old_order_item_key
  AND EXISTS (
    SELECT 1 FROM ops.order_status_recheck_state correct_state
    WHERE correct_state.order_item_key=m.new_order_item_key
  );

UPDATE ops.order_status_recheck_state state
SET order_item_key=m.new_order_item_key,
    order_key=m.new_order_key,
    store_key=m.effective_store_key,
    group_key=store_row.group_key,
    raw_summary=coalesce(state.raw_summary,'{}'::jsonb)||jsonb_build_object(
      '_storeIdentityCorrection',jsonb_build_object(
        'runId',${sqlLiteral(runId)},
        'correctionId',m.correction_id,
        'sourceStoreKey',m.source_store_key,
        'effectiveStoreKey',m.effective_store_key,
        'manifestHash',${sqlLiteral(manifestHash)}
      )
    ),
    updated_at=clock_timestamp()
FROM repair_item_map m
JOIN dim.store store_row ON store_row.store_key=m.effective_store_key
WHERE state.order_item_key=m.old_order_item_key;

UPDATE fact.order_item item
SET order_item_key=m.new_order_item_key,
    order_key=m.new_order_key,
    store_key=m.effective_store_key,
    group_key=store_row.group_key,
    raw_summary=coalesce(item.raw_summary,'{}'::jsonb)||jsonb_build_object(
      '_storeIdentityCorrection',jsonb_build_object(
        'runId',${sqlLiteral(runId)},
        'correctionId',m.correction_id,
        'sourceStoreKey',m.source_store_key,
        'effectiveStoreKey',m.effective_store_key,
        'manifestHash',${sqlLiteral(manifestHash)}
      )
    ),
    updated_at=clock_timestamp()
FROM repair_item_map m
JOIN dim.store store_row ON store_row.store_key=m.effective_store_key
WHERE item.order_item_key=m.old_order_item_key;

UPDATE fact.order_header header
SET order_key=m.new_order_key,
    store_key=m.effective_store_key,
    group_key=store_row.group_key,
    raw_summary=coalesce(header.raw_summary,'{}'::jsonb)||jsonb_build_object(
      '_storeIdentityCorrection',jsonb_build_object(
        'runId',${sqlLiteral(runId)},
        'correctionId',m.correction_id,
        'sourceStoreKey',m.source_store_key,
        'effectiveStoreKey',m.effective_store_key,
        'manifestHash',${sqlLiteral(manifestHash)}
      )
    ),
    updated_at=clock_timestamp()
FROM repair_order_map m
JOIN dim.store store_row ON store_row.store_key=m.effective_store_key
WHERE header.order_key=m.old_order_key;

UPDATE fact.order_payment_flag payment
SET order_key=m.new_order_key,
    store_key=m.effective_store_key,
    group_key=store_row.group_key,
    raw_evidence=coalesce(payment.raw_evidence,'{}'::jsonb)||jsonb_build_object(
      '_storeIdentityCorrection',jsonb_build_object(
        'runId',${sqlLiteral(runId)},
        'correctionId',m.correction_id,
        'sourceStoreKey',m.source_store_key,
        'effectiveStoreKey',m.effective_store_key,
        'manifestHash',${sqlLiteral(manifestHash)}
      )
    ),
    updated_at=clock_timestamp()
FROM repair_order_map m
JOIN dim.store store_row ON store_row.store_key=m.effective_store_key
WHERE payment.order_key=m.old_order_key;

UPDATE raw.local_file_catalog catalog
SET store_key=c.effective_store_key,
    raw_meta=coalesce(catalog.raw_meta,'{}'::jsonb)||jsonb_build_object(
      '_storeIdentityCorrection',jsonb_build_object(
        'runId',${sqlLiteral(runId)},
        'correctionId',c.correction_id,
        'sourceStoreKey',c.source_store_key,
        'effectiveStoreKey',c.effective_store_key,
        'manifestHash',${sqlLiteral(manifestHash)}
      )
    ),
    loaded_at=clock_timestamp()
FROM repair_corrections c
WHERE catalog.file_kind='sales'
  AND catalog.store_key=c.source_store_key
  AND catalog.target_date BETWEEN c.start_date AND c.end_date
  AND catalog.file_path LIKE 'outputs/shein_fetch/'||c.source_store_key||'/%';

CREATE TEMP TABLE repair_daily_scope ON COMMIT DROP AS
SELECT DISTINCT day::date AS date,store_key
FROM (
  SELECT generate_series(min(start_date),max(end_date),interval '1 day') AS day
  FROM repair_corrections
) dates
CROSS JOIN (
  SELECT source_store_key AS store_key FROM repair_corrections
  UNION
  SELECT effective_store_key FROM repair_corrections
) stores;

DELETE FROM fact.store_daily_sales daily
USING repair_daily_scope scope
WHERE daily.date=scope.date AND daily.store_key=scope.store_key;

INSERT INTO fact.store_daily_sales(
  date,store_key,group_key,shop_name,valid_order_count,goods_line_count,
  quantity_all,quantity_positive_amount,sales_sar,sales_rmb,fetch_time,
  source_file,raw_summary,updated_at
)
SELECT
  scope.date,
  scope.store_key,
  store_row.group_key,
  store_row.shop_name,
  count(DISTINCT item.order_no) FILTER (WHERE coalesce(item.sales_sar,0)>0)::integer,
  count(item.order_item_key)::integer,
  coalesce(sum(item.quantity),0),
  coalesce(sum(item.quantity) FILTER (WHERE coalesce(item.sales_sar,0)>0),0),
  round(coalesce(sum(item.sales_sar),0)::numeric,2),
  round(coalesce(sum(item.sales_rmb),0)::numeric,2),
  clock_timestamp(),
  'historical-store-identity-repair',
  jsonb_build_object(
    'source','historical-store-identity-repair',
    'runId',${sqlLiteral(runId)},
    'incidentId',${sqlLiteral(config.incidentId)},
    'manifestHash',${sqlLiteral(manifestHash)}
  ),
  clock_timestamp()
FROM repair_daily_scope scope
JOIN dim.store store_row ON store_row.store_key=scope.store_key
LEFT JOIN fact.order_item item
  ON item.created_date=scope.date AND item.store_key=scope.store_key
GROUP BY scope.date,scope.store_key,store_row.group_key,store_row.shop_name;

DO $post_validation$
DECLARE invalid_count integer;
BEGIN
  SELECT count(*) INTO invalid_count FROM fact.order_item item
  JOIN repair_item_map m ON item.order_item_key=m.new_order_item_key
  WHERE item.store_key<>m.effective_store_key
     OR item.order_key<>m.new_order_key
     OR item.order_item_key NOT LIKE item.store_key||'__%'
     OR item.order_key NOT LIKE item.store_key||'__%';
  IF invalid_count<>0 THEN RAISE EXCEPTION 'post-repair key/store validation failed: %',invalid_count; END IF;

  SELECT count(*) INTO invalid_count
  FROM fact.after_sales_item a
  WHERE EXISTS (
    SELECT 1 FROM fact.order_item oi
    WHERE oi.order_no=a.order_no AND oi.store_key<>a.store_key
      AND ((coalesce(a.skc,'')<>'' AND oi.skc=a.skc)
        OR dim.product_match_key(oi.standard_goods_sn)=dim.product_match_key(a.standard_goods_sn))
  )
  AND NOT EXISTS (
    SELECT 1 FROM fact.order_item oi
    WHERE oi.order_no=a.order_no AND oi.store_key=a.store_key
      AND ((coalesce(a.skc,'')<>'' AND oi.skc=a.skc)
        OR dim.product_match_key(oi.standard_goods_sn)=dim.product_match_key(a.standard_goods_sn))
  );
  IF invalid_count<>0 THEN RAISE EXCEPTION 'cross-store after-sales matches remain: %',invalid_count; END IF;

  WITH aggregate_sales AS (
    SELECT created_date AS date,store_key,
      count(DISTINCT order_no) FILTER (WHERE coalesce(sales_sar,0)>0)::integer AS orders,
      count(*)::integer AS lines,
      coalesce(sum(quantity),0) AS quantity,
      round(coalesce(sum(sales_sar),0)::numeric,2) AS sales
    FROM fact.order_item
    WHERE (created_date,store_key) IN (SELECT date,store_key FROM repair_daily_scope)
    GROUP BY created_date,store_key
  )
  SELECT count(*) INTO invalid_count
  FROM fact.store_daily_sales daily
  LEFT JOIN aggregate_sales aggregate USING(date,store_key)
  WHERE (daily.date,daily.store_key) IN (SELECT date,store_key FROM repair_daily_scope)
    AND (
      daily.valid_order_count<>coalesce(aggregate.orders,0)
      OR daily.goods_line_count<>coalesce(aggregate.lines,0)
      OR abs(daily.quantity_positive_amount-coalesce(aggregate.quantity,0))>0.0001
      OR abs(daily.sales_sar-coalesce(aggregate.sales,0))>0.01
    );
  IF invalid_count<>0 THEN RAISE EXCEPTION 'daily sales reconciliation failed: %',invalid_count; END IF;
END
$post_validation$;

COMMIT;

SELECT jsonb_build_object(
  'ok',true,
  'runId',${sqlLiteral(runId)},
  'manifestHash',${sqlLiteral(manifestHash)},
  'itemRows',(SELECT count(*) FROM ops.order_store_reassignment_audit WHERE run_id=${sqlLiteral(runId)}),
  'orders',(SELECT count(DISTINCT order_no) FROM ops.order_store_reassignment_audit WHERE run_id=${sqlLiteral(runId)}),
  'salesSar',(SELECT coalesce(sum(sales_sar),0) FROM ops.order_store_reassignment_audit WHERE run_id=${sqlLiteral(runId)})
)::text;
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = JSON.parse(await fs.readFile(
    path.join(ROOT, 'config', 'historical_store_identity_corrections.json'),
    'utf8',
  ));
  const storeConfig = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'stores.json'), 'utf8'));
  const corrections = validateHistoricalStoreIdentityConfig(config, storeConfig.stores);
  const rawInspection = await runPsql(args, inspectionSql(corrections, config.incidentId));
  const inspection = JSON.parse(rawInspection.split(/\r?\n/).find(line => line.trim().startsWith('{')));
  if (Number(inspection.candidateItemRows) === 0 && Number(inspection.priorAuditRows) > 0) {
    console.log(JSON.stringify({
      ok: true,
      mode: args.execute ? 'execute' : 'dry-run',
      alreadyApplied: true,
      incidentId: config.incidentId,
      priorAuditRows: inspection.priorAuditRows,
    }, null, 2));
    return;
  }
  assertInspectionReady(inspection, corrections);
  const manifest = {
    configVersion: config.version,
    incidentId: config.incidentId,
    corrections,
    candidates: inspection.candidates,
  };
  const manifestHash = sha256(canonicalJson(manifest));
  const printableInspection = {...inspection};
  delete printableInspection.candidates;
  if (!args.execute) {
    console.log(JSON.stringify({
      ok: true,
      mode: 'dry-run',
      manifestHash,
      inspection: printableInspection,
      executeCommand: `node scripts/repair_historical_store_identity.mjs --execute --confirm-hash ${manifestHash}`,
    }, null, 2));
    return;
  }
  if (!/^[a-f0-9]{64}$/i.test(args.confirmHash) || args.confirmHash !== manifestHash) {
    throw new Error(`Refusing execution: confirm hash mismatch expected=${manifestHash} actual=${args.confirmHash || '(missing)'}`);
  }
  const runId = `${config.incidentId}:${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  const output = await runPsql(args, executionSql({config, corrections, runId, manifestHash}));
  const resultLine = output.split(/\r?\n/).reverse().find(line => line.trim().startsWith('{'));
  const result = resultLine ? JSON.parse(resultLine) : {ok: true, raw: output};
  console.log(JSON.stringify({
    ...result,
    mode: 'execute',
    nextSteps: [
      'refresh profit marts',
      'regenerate and prewarm BI portal',
      'run warehouse audit and verify gross/net/return-risk readback',
    ],
  }, null, 2));
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exit(1);
});
