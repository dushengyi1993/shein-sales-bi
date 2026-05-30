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
SELECT
  'storage_total' AS check_name,
  count(*)::text AS rows,
  round(sum(coalesce(shown_fee_rmb,0))::numeric,2)::text AS shown_fee_rmb,
  round(sum(coalesce(actual_fee_rmb,0))::numeric,2)::text AS actual_fee_rmb,
  round(sum(coalesce(actual_fee_sar,0))::numeric,2)::text AS actual_fee_sar,
  round(sum(coalesce(store_allocated_fee_sar,0))::numeric,2)::text AS store_allocated_fee_sar,
  round(sum(coalesce(product_allocated_fee_sar,0))::numeric,2)::text AS product_allocated_fee_sar,
  round(sum(coalesce(store_allocation_delta_sar,0))::numeric,4)::text AS store_allocation_delta_sar,
  round(sum(coalesce(product_allocation_delta_sar,0))::numeric,4)::text AS product_allocation_delta_sar
FROM mart.storage_fee_daily_reconciliation
WHERE fee_date >= ${sqlQuote(args.start)}::date
  AND fee_date < ${sqlQuote(args.end)}::date;

SELECT
  'product_method' AS check_name,
  storage_allocation_method,
  count(*)::text AS rows,
  round(sum(coalesce(actual_allocated_fee_sar,0))::numeric,2)::text AS storage_fee_sar
FROM mart.storage_fee_product_daily
WHERE date >= ${sqlQuote(args.start)}::date
  AND date < ${sqlQuote(args.end)}::date
GROUP BY storage_allocation_method
ORDER BY storage_allocation_method;

SELECT
  'profit_after_storage' AS check_name,
  count(*)::text AS rows,
  round(sum(coalesce(storage_fee_sar,0))::numeric,2)::text AS storage_fee_sar,
  round(sum(coalesce(profit_before_storage_sar,0))::numeric,2)::text AS profit_before_storage_sar,
  round(sum(coalesce(profit_after_storage_sar,0))::numeric,2)::text AS profit_after_storage_sar
FROM mart.profit_daily_store_product
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
  profitStorageFeeSar: numberField(profit, 'storage_fee_sar'),
}, null, 2));
