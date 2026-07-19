#!/usr/bin/env node
/**
 * Verify that ET storage-fee totals, store allocation, product allocation, and
 * profit-after-storage fields reconcile for a date range.
 *
 * This intentionally queries the mart views that own the storage-fee model.
 * Before the storage-fee schema is applied it should fail with a missing
 * relation/column error; after the schema is applied it should fail only when
 * the allocation totals no longer reconcile.
 */
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    mode: 'local',
    start: '2026-05-01',
    end: '2026-06-01',
    container: 'shein-warehouse-db',
    database: 'shein_bi',
    user: 'shein',
    host: '',
    tolerance: 0.05,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--mode') args.mode = argv[++i];
    else if (a === '--start') args.start = argv[++i];
    else if (a === '--end') args.end = argv[++i];
    else if (a === '--host') args.host = argv[++i];
    else if (a === '--container') args.container = argv[++i];
    else if (a === '--database') args.database = argv[++i];
    else if (a === '--user') args.user = argv[++i];
    else if (a === '--tolerance') args.tolerance = Number(argv[++i]);
  }
  if (!['local', 'cloud'].includes(args.mode)) throw new Error(`Unsupported --mode ${args.mode}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.start)) throw new Error(`Invalid --start ${args.start}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.end)) throw new Error(`Invalid --end ${args.end}`);
  if (!Number.isFinite(args.tolerance) || args.tolerance < 0) throw new Error(`Invalid --tolerance ${args.tolerance}`);
  return args;
}

function sqlQuote(v) {
  return `'${String(v).replaceAll("'", "''")}'`;
}

function run(cmd, input) {
  const res = spawnSync(cmd[0], cmd.slice(1), {
    input,
    encoding: 'utf8',
    cwd: ROOT,
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw new Error(`Command failed (${res.status}): ${cmd.join(' ')}\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`);
  }
  return res.stdout;
}

function psql(args, sql) {
  if (args.mode === 'cloud') {
    if (!args.host) throw new Error('--host is required when --mode cloud');
    const inner = `sudo docker exec -i ${args.container} psql -U ${args.user} -d ${args.database} -v ON_ERROR_STOP=1 -A -F $'\\t'`;
    return run(['ssh', args.host, inner], sql);
  }
  if (process.platform !== 'win32') {
    const docker = [
      'docker', 'exec', '-i', args.container,
      'psql', '-U', args.user, '-d', args.database,
      '-v', 'ON_ERROR_STOP=1',
      '-A',
      '-F', '\t',
    ];
    if (/^(1|true|yes)$/i.test(String(process.env.SHEIN_DOCKER_USE_SUDO || ''))) {
      return run(['sudo', ...docker], sql);
    }
    return run(docker, sql);
  }
  return run([
    'wsl',
    '-d', 'Ubuntu-24.04',
    '--',
    'docker', 'exec', '-i', args.container,
    'psql', '-U', args.user, '-d', args.database,
    '-v', 'ON_ERROR_STOP=1',
    '-A',
    '-F', '\t',
  ], sql);
}

function parseTsvBlocks(stdout) {
  const rows = [];
  let header = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || /^\(\d+ rows?\)$/.test(line)) {
      header = null;
      continue;
    }
    const cells = line.split('\t');
    if (!header) {
      header = cells;
      continue;
    }
    rows.push(Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])));
  }
  return rows;
}

function numberField(row, key) {
  const n = Number(row?.[key] ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function assertDelta(row, key, tolerance) {
  const delta = Math.abs(numberField(row, key));
  if (delta > tolerance) {
    throw new Error(`${row.check_name}.${key}=${delta.toFixed(6)} exceeds tolerance ${tolerance}`);
  }
}

const args = parseArgs(process.argv.slice(2));
const sql = `
-- This health check runs after refresh_profit_marts.sql.  Read canonical
-- ledger totals plus published caches only; never expand the live product /
-- store allocation views during a production audit.
WITH fee AS (
  SELECT fee_date,
    sum(shown_fee_rmb) AS shown_fee_rmb,
    sum(actual_fee_rmb) AS actual_fee_rmb,
    sum(actual_fee_sar) AS actual_fee_sar
  FROM mart.et_storage_fee_daily
  WHERE fee_date >= ${sqlQuote(args.start)}::date
    AND fee_date < ${sqlQuote(args.end)}::date
  GROUP BY fee_date
),
store_alloc AS (
  SELECT date AS fee_date, sum(allocated_storage_fee_sar) AS allocated_fee_sar
  FROM mart.storage_fee_store_daily_cache
  WHERE date >= ${sqlQuote(args.start)}::date
    AND date < ${sqlQuote(args.end)}::date
  GROUP BY date
),
product_alloc AS (
  SELECT date AS fee_date, sum(actual_allocated_fee_sar) AS allocated_fee_sar
  FROM mart.storage_fee_product_daily_cache
  WHERE date >= ${sqlQuote(args.start)}::date
    AND date < ${sqlQuote(args.end)}::date
  GROUP BY date
),
product_store_alloc AS (
  SELECT date AS fee_date, sum(storage_fee_sar) AS allocated_fee_sar
  FROM mart.storage_fee_product_store_daily_cache
  WHERE date >= ${sqlQuote(args.start)}::date
    AND date < ${sqlQuote(args.end)}::date
  GROUP BY date
),
daily_reconciliation AS (
  SELECT f.*,
    f.actual_fee_sar - coalesce(s.allocated_fee_sar,0) AS store_allocation_delta_sar,
    f.actual_fee_sar - coalesce(p.allocated_fee_sar,0) AS product_allocation_delta_sar,
    f.actual_fee_sar - coalesce(ps.allocated_fee_sar,0) AS product_store_allocation_delta_sar
  FROM fee f
  LEFT JOIN store_alloc s USING (fee_date)
  LEFT JOIN product_alloc p USING (fee_date)
  LEFT JOIN product_store_alloc ps USING (fee_date)
)
SELECT
  'storage_total' AS check_name,
  count(*)::text AS rows,
  round(sum(coalesce(shown_fee_rmb,0))::numeric,2)::text AS shown_fee_rmb,
  round(sum(coalesce(actual_fee_rmb,0))::numeric,2)::text AS actual_fee_rmb,
  round(sum(coalesce(actual_fee_sar,0))::numeric,2)::text AS actual_fee_sar,
  round(sum(coalesce(actual_fee_sar - store_allocation_delta_sar,0))::numeric,2)::text AS store_allocated_fee_sar,
  round(sum(coalesce(actual_fee_sar - product_allocation_delta_sar,0))::numeric,2)::text AS product_allocated_fee_sar,
  round(max(abs(store_allocation_delta_sar))::numeric,4)::text AS store_allocation_delta_sar,
  round(max(abs(product_allocation_delta_sar))::numeric,4)::text AS product_allocation_delta_sar,
  round(max(abs(product_store_allocation_delta_sar))::numeric,4)::text AS product_store_allocation_delta_sar
FROM daily_reconciliation;

SELECT
  'product_method' AS check_name,
  storage_allocation_method,
  count(*)::text AS rows,
  round(sum(coalesce(actual_allocated_fee_sar,0))::numeric,2)::text AS storage_fee_sar
FROM mart.storage_fee_product_daily_cache
WHERE date >= ${sqlQuote(args.start)}::date
  AND date < ${sqlQuote(args.end)}::date
GROUP BY storage_allocation_method
ORDER BY storage_allocation_method;

WITH raw_storage AS (
  SELECT
    coalesce(ship_time::date, create_time::date, push_time::date) AS fee_date,
    CASE
      WHEN lower(concat_ws(' ', status, status_name)) ~ '(已支付|支付成功|已完成|已结算|paid|done|completed|settled)' THEN 'paid'
      WHEN lower(concat_ws(' ', status, status_name)) ~ '(等待支付|待支付|待付款|未支付|pending|awaiting.?payment|unpaid)' THEN 'pending'
      ELSE 'other'
    END AS payment_state,
    concat_ws('|',
      coalesce(ship_time::date, create_time::date, push_time::date)::text,
      coalesce(billing_period_date::date, coalesce(ship_time::date, create_time::date, push_time::date))::text,
      to_char(coalesce(other_income,0), 'FM999999999999990.000000'),
      coalesce(nullif(client_from_id,''), nullif(raw_summary->>'ClientId',''), nullif(raw_summary->>'OwnerClientId',''), ''),
      coalesce(nullif(remark,''), nullif(raw_summary->>'Remark',''), nullif(raw_summary->>'remark',''), ''),
      coalesce(nullif(raw_summary->>'CountryId',''), nullif(raw_summary->>'countryId',''), nullif(raw_summary->>'CountryCode',''), nullif(raw_summary->>'countryCode',''), ''),
      coalesce(nullif(oversea_id,''), nullif(raw_summary->>'OverseaId',''), nullif(raw_summary->>'overseaId',''), '')
    ) AS canonical_business_key
  FROM fact.et_income_bill
  WHERE (sort = '2' OR sort_name = '仓储费')
    AND coalesce(ship_time::date, create_time::date, push_time::date) >= ${sqlQuote(args.start)}::date
    AND coalesce(ship_time::date, create_time::date, push_time::date) < ${sqlQuote(args.end)}::date
),
replacement_candidate AS (
  SELECT canonical_business_key,
    count(*) FILTER (WHERE payment_state = 'paid') AS paid_count,
    count(*) FILTER (WHERE payment_state = 'pending') AS pending_count,
    count(*) FILTER (WHERE payment_state = 'other') AS other_count
  FROM raw_storage
  GROUP BY canonical_business_key
),
replacement_audit AS (
  SELECT r.canonical_business_key, count(c.income_bill_id) AS canonical_count,
    max(c.canonical_reason) AS canonical_reason
  FROM replacement_candidate r
  LEFT JOIN mart.et_storage_fee_bill_canonical c USING (canonical_business_key)
  WHERE r.paid_count = 1 AND r.pending_count >= 1 AND r.other_count = 0
  GROUP BY r.canonical_business_key
),
canonical_detail_source AS (
  SELECT * FROM mart.et_storage_fee_canonical_detail_source
  WHERE fee_date >= ${sqlQuote(args.start)}::date
    AND fee_date < ${sqlQuote(args.end)}::date
),
detail_by_bill AS (
  SELECT s.fee_date, s.canonical_income_bill_id, s.detail_source_reason,
    sum(coalesce(d.shown_fee_rmb,0)) AS detail_shown_fee_rmb
  FROM canonical_detail_source s
  JOIN fact.et_storage_fee_product_detail d
    ON d.fee_date = s.fee_date AND d.income_bill_id = s.detail_source_income_bill_id
  WHERE s.detail_source_income_bill_id IS NOT NULL
  GROUP BY s.fee_date, s.canonical_income_bill_id, s.detail_source_reason
),
detail_coverage AS (
  SELECT c.fee_date,
    count(*) AS canonical_bill_count,
    count(db.canonical_income_bill_id) FILTER (WHERE coalesce(db.detail_shown_fee_rmb,0) <> 0) AS covered_bill_count,
    sum(c.shown_fee_rmb) AS canonical_shown_fee_rmb,
    sum(coalesce(db.detail_shown_fee_rmb,0)) AS detail_shown_fee_rmb
  FROM mart.et_storage_fee_bill_canonical c
  LEFT JOIN detail_by_bill db
    ON db.fee_date = c.fee_date AND db.canonical_income_bill_id = c.income_bill_id
  WHERE c.fee_date >= ${sqlQuote(args.start)}::date
    AND c.fee_date < ${sqlQuote(args.end)}::date
  GROUP BY c.fee_date
)
SELECT
  'canonical_audit' AS check_name,
  (SELECT count(*) FROM replacement_audit
    WHERE canonical_count <> 1 OR canonical_reason <> 'status_replacement_paid_supersedes_pending')::text AS unresolved_replacement_chain_count,
  (SELECT count(*) FROM replacement_audit WHERE canonical_count > 1)::text AS canonical_duplicate_count,
  (SELECT count(*) FROM detail_coverage WHERE covered_bill_count < canonical_bill_count)::text AS detail_missing_days,
  (SELECT count(*) FROM detail_coverage
    WHERE covered_bill_count = canonical_bill_count
      AND abs(canonical_shown_fee_rmb - detail_shown_fee_rmb) > 0.05)::text AS detail_scaled_days,
  (SELECT count(*) FROM canonical_detail_source
    WHERE detail_source_reason = 'superseded_bill_detail_fallback')::text AS detail_inherited_bill_count,
  (SELECT max(fee_date)::text FROM raw_storage) AS latest_raw_fee_date,
  (SELECT max(fee_date)::text FROM mart.et_storage_fee_bill_canonical
    WHERE fee_date >= ${sqlQuote(args.start)}::date
      AND fee_date < ${sqlQuote(args.end)}::date) AS latest_canonical_fee_date;

SELECT
  'profit_after_storage' AS check_name,
  count(*)::text AS rows,
  round(sum(coalesce(storage_fee_sar,0))::numeric,2)::text AS storage_fee_sar,
  round(sum(coalesce(profit_before_storage_sar,0))::numeric,2)::text AS profit_before_storage_sar,
  round(sum(coalesce(profit_after_storage_sar,0))::numeric,2)::text AS profit_after_storage_sar
FROM mart.profit_daily_store_product_cache
WHERE date >= ${sqlQuote(args.start)}::date
  AND date < ${sqlQuote(args.end)}::date;
`;

const output = psql(args, sql);
process.stdout.write(output);

const rows = parseTsvBlocks(output);
const total = rows.find(r => r.check_name === 'storage_total');
if (!total) throw new Error('storage_total check returned no row');
if (numberField(total, 'rows') <= 0) throw new Error('storage_total check returned zero fee days');
assertDelta(total, 'store_allocation_delta_sar', args.tolerance);
assertDelta(total, 'product_allocation_delta_sar', args.tolerance);
assertDelta(total, 'product_store_allocation_delta_sar', args.tolerance);

const canonical = rows.find(r => r.check_name === 'canonical_audit');
if (!canonical) throw new Error('canonical_audit check returned no row');
if (numberField(canonical, 'unresolved_replacement_chain_count') > 0) {
  throw new Error(`canonical_audit.unresolved_replacement_chain_count=${canonical.unresolved_replacement_chain_count}`);
}
if (numberField(canonical, 'canonical_duplicate_count') > 0) {
  throw new Error(`canonical_audit.canonical_duplicate_count=${canonical.canonical_duplicate_count}`);
}
const rawDate = String(canonical.latest_raw_fee_date || '').slice(0, 10);
const canonicalDate = String(canonical.latest_canonical_fee_date || '').slice(0, 10);
if (rawDate && (!canonicalDate || canonicalDate < rawDate)) {
  throw new Error(`canonical_audit.latest date stale: canonical=${canonicalDate || '-'} raw=${rawDate}`);
}

const profit = rows.find(r => r.check_name === 'profit_after_storage');
if (!profit) throw new Error('profit_after_storage check returned no row');
if (numberField(profit, 'storage_fee_sar') <= 0) throw new Error('profit_after_storage.storage_fee_sar is not positive');

console.log(JSON.stringify({
  ok: true,
  mode: args.mode,
  host: args.host || null,
  start: args.start,
  end: args.end,
  actualFeeSar: numberField(total, 'actual_fee_sar'),
  storeAllocatedFeeSar: numberField(total, 'store_allocated_fee_sar'),
  productAllocatedFeeSar: numberField(total, 'product_allocated_fee_sar'),
  productStoreAllocationDeltaSar: numberField(total, 'product_store_allocation_delta_sar'),
  profitStorageFeeSar: numberField(profit, 'storage_fee_sar'),
  canonicalAudit: {
    detailMissingDays: numberField(canonical, 'detail_missing_days'),
    detailScaledDays: numberField(canonical, 'detail_scaled_days'),
    detailInheritedBillCount: numberField(canonical, 'detail_inherited_bill_count'),
    latestRawFeeDate: rawDate || null,
    latestCanonicalFeeDate: canonicalDate || null,
  },
}, null, 2));
