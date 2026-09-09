#!/usr/bin/env node
/** Load immutable finance check-order artifacts into the warehouse. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {container: 'shein-warehouse-db', database: 'shein_bi', user: 'shein', dryRun: false};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--file') args.file = path.resolve(argv[++i]);
    else if (arg === '--store') args.store = String(argv[++i] || '').toUpperCase();
    else if (arg === '--container') args.container = argv[++i];
    else if (arg === '--database') args.database = argv[++i];
    else if (arg === '--user') args.user = argv[++i];
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--ensure-only') args.ensureOnly = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/load_shein_openapi_finance_warehouse.mjs --store DL [--file artifact.json]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.file && args.store) args.file = path.join(ROOT, 'outputs', 'shein_openapi_finance', args.store, 'latest.json');
  if (!args.ensureOnly && !args.file) throw new Error('--file or --store is required');
  return args;
}

function csv(value) {
  if (value === null || value === undefined || value === '') return '';
  const string = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(string) ? `"${string.replace(/"/g, '""')}"` : string;
}

function line(columns, row) {
  return `${columns.map(column => csv(row[column])).join(',')}\n`;
}

function ident(name) {
  return name.split('.').map(part => `"${part.replace(/"/g, '""')}"`).join('.');
}

function literal(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function runPsql(args, sql) {
  if (args.dryRun) return {dryRun: true, sqlBytes: Buffer.byteLength(sql)};
  const useWsl = process.platform === 'win32';
  const command = useWsl ? 'wsl' : (process.env.SHEIN_BI_DOCKER_COMMAND || 'sudo');
  const commandArgs = useWsl
    ? ['-d', process.env.SHEIN_BI_WSL_DISTRO || 'Ubuntu-24.04', '--', 'bash', '-lc', `sudo docker exec -i ${args.container} psql -U ${args.user} -d ${args.database} -v ON_ERROR_STOP=1`]
    : command === 'sudo'
      ? ['-n', 'docker', 'exec', '-i', args.container, 'psql', '-U', args.user, '-d', args.database, '-v', 'ON_ERROR_STOP=1']
      : ['exec', '-i', args.container, 'psql', '-U', args.user, '-d', args.database, '-v', 'ON_ERROR_STOP=1'];
  const child = spawn(command, commandArgs, {cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
  const stdout = [];
  const stderr = [];
  let stdinError = null;
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
  // psql may exit on a SQL error before consuming a large COPY input. Preserve
  // its database error instead of crashing on the resulting broken pipe.
  child.stdin.on('error', error => { stdinError = error; });
  child.stdin.end(sql);
  const code = await completion;
  if (code !== 0 || stdinError) {
    const detail = Buffer.concat(stderr).toString('utf8').slice(-5000) || stdinError?.message || '';
    throw new Error(`psql failed (${code}): ${detail}`);
  }
  return {stdout: Buffer.concat(stdout).toString('utf8')};
}

const DDL = `
CREATE TABLE IF NOT EXISTS fact.openapi_finance_check_order (
  check_order_key text PRIMARY KEY, store_key text NOT NULL REFERENCES dim.store(store_key), group_key text,
  shop_name text, check_order_no text NOT NULL, bz_order_no text, report_order_no text, check_status integer,
  second_order_type integer, income_expenditure_type integer, business_completed_time timestamp,
  completed_pay_time timestamp, estimate_pay_time timestamp, site text, currency_code text,
  estimate_income_money_total numeric, source_window_start date, source_window_end date,
  fetched_at timestamptz NOT NULL, payload_hash text NOT NULL, raw_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(store_key, check_order_no)
);
CREATE INDEX IF NOT EXISTS idx_finance_check_order_business ON fact.openapi_finance_check_order(store_key,bz_order_no);
CREATE TABLE IF NOT EXISTS fact.openapi_finance_check_order_item (
  check_order_item_key text PRIMARY KEY, check_order_key text NOT NULL REFERENCES fact.openapi_finance_check_order(check_order_key) ON DELETE CASCADE,
  store_key text NOT NULL REFERENCES dim.store(store_key), group_key text, shop_name text, check_order_no text NOT NULL,
  bz_order_no text, report_order_no text, check_status integer, second_order_type integer, income_expenditure_type integer,
  business_completed_time timestamp, completed_pay_time timestamp, estimate_pay_time timestamp, site text, currency_code text,
  estimate_income_money_total numeric, source_window_start date, source_window_end date, fetched_at timestamptz NOT NULL,
  line_index integer NOT NULL, detail_line_id text, sku_code text, goods_id text, entity_id text,
  return_expense_sar numeric NOT NULL DEFAULT 0, return_freight_subsidy_sar numeric NOT NULL DEFAULT 0,
  net_return_cost_sar numeric NOT NULL DEFAULT 0, stock_expense_sar numeric, performance_cost_sar numeric,
  service_fee_sar numeric, income_amount_sar numeric, seller_currency_price numeric, payload_hash text NOT NULL,
  raw_summary jsonb NOT NULL DEFAULT '{}'::jsonb, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_finance_check_item_business ON fact.openapi_finance_check_order_item(store_key,bz_order_no,sku_code);
`;

function copyUpsert(table, columns, conflict, rows) {
  if (!rows.length) return '';
  const stage = `stage_${table.replace(/\W/g, '_')}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const updates = columns.filter(column => !conflict.includes(column) && column !== 'updated_at')
    .map(column => `${ident(column)}=EXCLUDED.${ident(column)}`).join(',');
  let sql = `CREATE TEMP TABLE "${stage}" (LIKE ${ident(table)} INCLUDING DEFAULTS) ON COMMIT DROP;\n`;
  sql += `COPY "${stage}" (${columns.map(ident).join(',')}) FROM STDIN WITH (FORMAT csv, NULL '');\n`;
  for (const row of rows) sql += line(columns, row);
  sql += '\\.\n';
  sql += `INSERT INTO ${ident(table)} (${columns.map(ident).join(',')}) SELECT ${columns.map(ident).join(',')} FROM "${stage}" `;
  sql += `ON CONFLICT (${conflict.map(ident).join(',')}) DO UPDATE SET ${updates}, updated_at=now();\n`;
  return sql;
}

// Every loader, including ensure-only, takes the same transaction lock before
// DDL or DML. Parallel store fetches must not interleave CREATE INDEX and INSERT.
const TRANSACTION_BEGIN = "BEGIN;\nSELECT pg_advisory_xact_lock(hashtextextended('shein-bi:finance-warehouse-load:v1', 0));\n";

export function buildFinanceEnsureSql() {
  return `${TRANSACTION_BEGIN}${DDL}\nCOMMIT;\n`;
}

export function buildFinanceArtifactSql(artifact) {
  const orderColumns = ['check_order_key','store_key','group_key','shop_name','check_order_no','bz_order_no','report_order_no','check_status','second_order_type','income_expenditure_type','business_completed_time','completed_pay_time','estimate_pay_time','site','currency_code','estimate_income_money_total','source_window_start','source_window_end','fetched_at','payload_hash','raw_summary'];
  const itemColumns = ['check_order_item_key','check_order_key','store_key','group_key','shop_name','check_order_no','bz_order_no','report_order_no','check_status','second_order_type','income_expenditure_type','business_completed_time','completed_pay_time','estimate_pay_time','site','currency_code','estimate_income_money_total','source_window_start','source_window_end','fetched_at','line_index','detail_line_id','sku_code','goods_id','entity_id','return_expense_sar','return_freight_subsidy_sar','net_return_cost_sar','stock_expense_sar','performance_cost_sar','service_fee_sar','income_amount_sar','seller_currency_price','payload_hash','raw_summary'];
  const orders = Array.isArray(artifact.orders) ? artifact.orders : [];
  const items = Array.isArray(artifact.items) ? artifact.items : [];
  const keys = orders.map(row => literal(row.check_order_key));
  let sql = `${TRANSACTION_BEGIN}${DDL}\n`;
  if (keys.length) sql += `DELETE FROM fact.openapi_finance_check_order_item WHERE check_order_key IN (${keys.join(',')});\n`;
  sql += copyUpsert('fact.openapi_finance_check_order', orderColumns, ['check_order_key'], orders);
  sql += copyUpsert('fact.openapi_finance_check_order_item', itemColumns, ['check_order_item_key'], items);
  sql += 'COMMIT;\n';
  return sql;
}

export async function loadFinanceArtifact(args, artifact) {
  const orders = Array.isArray(artifact.orders) ? artifact.orders : [];
  const items = Array.isArray(artifact.items) ? artifact.items : [];
  const sql = buildFinanceArtifactSql(artifact);
  const result = await runPsql(args, sql);
  return {ok: true, orders: orders.length, items: items.length, ...result};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.ensureOnly) {
    const result = await runPsql(args, buildFinanceEnsureSql());
    console.log(JSON.stringify({ok: true, ensureOnly: true, ...result}, null, 2));
    return;
  }
  const artifact = JSON.parse(await fs.readFile(args.file, 'utf8'));
  const result = await loadFinanceArtifact(args, artifact);
  console.log(JSON.stringify({...result, storeKey: artifact.storeKey, file: path.relative(ROOT, args.file).replace(/\\/g, '/')}, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error?.stack || error);
    process.exit(1);
  });
}
