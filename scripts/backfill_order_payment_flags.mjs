#!/usr/bin/env node
/**
 * Backfill order-level payment/COD flags from existing SHEIN raw sales artifacts.
 *
 * Typical uses:
 *   node scripts/backfill_order_payment_flags.mjs --browser-dir outputs/shein_fetch --dry-run
 *   node scripts/backfill_order_payment_flags.mjs --browser-dir outputs/shein_fetch --export-csv tmp/order-payment-flags.csv
 *   node scripts/backfill_order_payment_flags.mjs --browser-dir outputs/shein_fetch --apply
 *
 * The script is source-read-only. It only writes to PostgreSQL when --apply is
 * passed, or writes a local CSV when --export-csv is passed.
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {
  ORDER_PAYMENT_FLAG_COLUMNS,
  ORDER_PAYMENT_FLAG_CREATE_SQL,
  ORDER_PAYMENT_FLAG_TABLE,
  extractPaymentFlagsFromSalesArtifact,
} from '../lib/order_payment_flags.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    distro: 'Ubuntu-24.04',
    container: 'shein-warehouse-db',
    database: 'shein_bi',
    user: 'shein',
    browserDirs: [],
    openapiDirs: [],
    dryRun: false,
    apply: false,
    exportCsv: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--distro') args.distro = argv[++i];
    else if (a === '--container') args.container = argv[++i];
    else if (a === '--database') args.database = argv[++i];
    else if (a === '--user') args.user = argv[++i];
    else if (a === '--browser-dir') args.browserDirs.push(path.resolve(argv[++i]));
    else if (a === '--openapi-dir') args.openapiDirs.push(path.resolve(argv[++i]));
    else if (a === '--date') {
      args.start = argv[++i];
      args.end = args.start;
    } else if (a === '--start') args.start = argv[++i];
    else if (a === '--end') args.end = argv[++i];
    else if (a === '--export-csv') args.exportCsv = path.resolve(argv[++i]);
    else if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  node scripts/backfill_order_payment_flags.mjs --browser-dir outputs/shein_fetch --dry-run
  node scripts/backfill_order_payment_flags.mjs --browser-dir outputs/shein_fetch --openapi-dir outputs/shein_openapi_fetch --export-csv tmp/order-payment-flags.csv
  node scripts/backfill_order_payment_flags.mjs --browser-dir outputs/shein_fetch --apply

Options:
  --browser-dir <dir>   SHEIN browser/WebAPI raw sales root; can repeat.
  --openapi-dir <dir>   SHEIN OpenAPI raw sales root; can repeat.
  --start/--end         Optional artifact date window.
  --date                Single artifact date.
  --export-csv <file>   Write a CSV instead of only printing summary.
  --apply               Upsert into PostgreSQL using local docker/wsl context.
  --dry-run             Do not write to PostgreSQL.`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!args.browserDirs.length && !args.openapiDirs.length) {
    args.browserDirs.push(path.join(ROOT, 'outputs', 'shein_fetch'));
    args.openapiDirs.push(path.join(ROOT, 'outputs', 'shein_openapi_fetch'));
  }
  if (args.start && !args.end) args.end = args.start;
  return args;
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function dateFromFile(file) {
  const m = path.basename(file).match(/^(\d{4}-\d{2}-\d{2})\.json$/);
  return m ? m[1] : '';
}

async function listJsonFiles(dir, args) {
  const out = [];
  async function walk(d) {
    if (!fssync.existsSync(d)) return;
    const entries = await fs.readdir(d, {withFileTypes: true});
    for (const entry of entries) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.isFile() && /\.json$/i.test(entry.name) && !/_summary\.json$/i.test(entry.name)) {
        const dte = dateFromFile(p);
        if (!dte) continue;
        if (args.start && dte < args.start) continue;
        if (args.end && dte > args.end) continue;
        out.push(p);
      }
    }
  }
  await walk(dir);
  return out.sort();
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function csvEscape(value) {
  if (value === null || value === undefined || value === '') return '';
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvLine(values) {
  return values.map(csvEscape).join(',') + '\n';
}

function qIdent(ident) {
  return ident.split('.').map((x) => `"${x.replace(/"/g, '""')}"`).join('.');
}

function tempName(table) {
  return `stage_${table.replace(/\W+/g, '_')}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function dockerPrefix() {
  if (process.platform === 'win32') return 'sudo ';
  if (typeof process.getuid === 'function' && process.getuid() === 0) return '';
  return 'sudo ';
}

function psqlSpawnCommand(args) {
  const psql = `${dockerPrefix()}docker exec -i ${shellQuote(args.container)} psql -U ${shellQuote(args.user)} -d ${shellQuote(args.database)} -v ON_ERROR_STOP=1`;
  if (process.platform === 'win32') {
    return {
      command: 'wsl',
      args: ['-d', args.distro, '--', 'bash', '-lc', psql],
    };
  }
  return {
    command: 'bash',
    args: ['-lc', psql],
  };
}

async function runPsqlScript(args, script) {
  const psql = psqlSpawnCommand(args);
  const child = spawn(psql.command, psql.args, {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.stdin.write(script);
  child.stdin.end();
  const code = await new Promise((resolve) => child.on('close', resolve));
  if (code !== 0) {
    throw new Error(`psql failed (${code})\nSTDOUT:\n${stdout.slice(-4000)}\nSTDERR:\n${stderr.slice(-4000)}`);
  }
  return {stdout, stderr};
}

async function upsertRows(args, rows) {
  if (!rows.length) return {table: ORDER_PAYMENT_FLAG_TABLE, rows: 0, skipped: true};
  const stage = tempName(ORDER_PAYMENT_FLAG_TABLE);
  const conflictColumns = ['order_key'];
  const nonConflict = ORDER_PAYMENT_FLAG_COLUMNS.filter((c) => !conflictColumns.includes(c) && c !== 'updated_at');
  const updateSet = [
    ...nonConflict.map((c) => `${qIdent(c)} = EXCLUDED.${qIdent(c)}`),
    'updated_at = now()',
  ].join(',\n    ');
  const sqlColumns = ORDER_PAYMENT_FLAG_COLUMNS.map(qIdent).join(', ');
  let script = `BEGIN;\n${ORDER_PAYMENT_FLAG_CREATE_SQL}\n`;
  script += `CREATE TEMP TABLE "${stage}" (LIKE ${qIdent(ORDER_PAYMENT_FLAG_TABLE)} INCLUDING DEFAULTS) ON COMMIT DROP;\n`;
  script += `COPY "${stage}" (${sqlColumns}) FROM STDIN WITH (FORMAT csv, NULL '');\n`;
  for (const row of rows) script += csvLine(ORDER_PAYMENT_FLAG_COLUMNS.map((c) => row[c]));
  script += '\\.\n';
  script += `INSERT INTO ${qIdent(ORDER_PAYMENT_FLAG_TABLE)} (${sqlColumns})\n`;
  script += `SELECT ${sqlColumns} FROM "${stage}"\n`;
  script += `ON CONFLICT (${conflictColumns.map(qIdent).join(', ')}) DO UPDATE SET\n    ${updateSet};\n`;
  script += 'COMMIT;\n';
  await runPsqlScript(args, script);
  return {table: ORDER_PAYMENT_FLAG_TABLE, rows: rows.length};
}

function mergeRows(left, right) {
  if (!left) return right;
  if (!right) return left;
  const isCod = left.is_cod === true || right.is_cod === true
    ? true
    : left.is_cod === false || right.is_cod === false
      ? false
      : null;
  const chosen = right.is_cod === true && left.is_cod !== true ? right : left;
  return {
    ...chosen,
    created_date: [left.created_date, right.created_date].filter(Boolean).sort()[0] || chosen.created_date,
    is_cod: isCod,
    payment_method: isCod === true ? 'COD' : isCod === false ? 'NON_COD' : chosen.payment_method,
    raw_evidence: {
      mergedByBackfill: true,
      left: left.raw_evidence,
      right: right.raw_evidence,
    },
    updated_at: new Date().toISOString(),
  };
}

async function collectFromDir(dir, sourceKind, args) {
  const files = await listJsonFiles(dir, args);
  const rows = [];
  const errors = [];
  for (const file of files) {
    let data;
    try {
      data = await readJson(file);
    } catch (err) {
      errors.push({file: rel(file), error: String(err.message || err).slice(0, 500)});
      continue;
    }
    rows.push(...extractPaymentFlagsFromSalesArtifact(data, {
      date: data.start || data.date || dateFromFile(file),
      sourceFile: rel(file),
      sourceKind,
    }));
  }
  return {files, rows, errors};
}

async function exportCsv(file, rows) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  let text = csvLine(ORDER_PAYMENT_FLAG_COLUMNS);
  for (const row of rows) text += csvLine(ORDER_PAYMENT_FLAG_COLUMNS.map((c) => row[c]));
  await fs.writeFile(file, text, 'utf8');
}

function summarize(rows, fileCount, errors) {
  const byDate = rows.reduce((acc, row) => {
    if (!row.created_date) return acc;
    acc.min = acc.min ? (row.created_date < acc.min ? row.created_date : acc.min) : row.created_date;
    acc.max = acc.max ? (row.created_date > acc.max ? row.created_date : acc.max) : row.created_date;
    return acc;
  }, {min: null, max: null});
  const codRows = rows.filter((r) => r.is_cod === true);
  const unknownRows = rows.filter((r) => r.is_cod === null || r.is_cod === undefined);
  return {
    fileCount,
    rows: rows.length,
    codRows: codRows.length,
    nonCodRows: rows.length - codRows.length - unknownRows.length,
    unknownRows: unknownRows.length,
    codSharePct: rows.length ? Math.round((codRows.length / rows.length) * 10000) / 100 : 0,
    minDate: byDate.min,
    maxDate: byDate.max,
    errors: errors.slice(0, 20),
    errorCount: errors.length,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const byKey = new Map();
  const errors = [];
  let fileCount = 0;

  for (const dir of args.browserDirs) {
    const result = await collectFromDir(dir, 'browser_webapi', args);
    fileCount += result.files.length;
    errors.push(...result.errors);
    for (const row of result.rows) byKey.set(row.order_key, mergeRows(byKey.get(row.order_key), row));
  }
  for (const dir of args.openapiDirs) {
    const result = await collectFromDir(dir, 'openapi', args);
    fileCount += result.files.length;
    errors.push(...result.errors);
    for (const row of result.rows) byKey.set(row.order_key, mergeRows(byKey.get(row.order_key), row));
  }

  const rows = [...byKey.values()].sort((a, b) => (
    String(a.created_date).localeCompare(String(b.created_date))
    || String(a.store_key).localeCompare(String(b.store_key))
    || String(a.order_no).localeCompare(String(b.order_no))
  ));

  if (args.exportCsv) await exportCsv(args.exportCsv, rows);
  const apply = args.apply && !args.dryRun ? await upsertRows(args, rows) : {skipped: true, apply: args.apply, dryRun: args.dryRun};

  console.log(JSON.stringify({
    ok: true,
    dryRun: args.dryRun,
    apply,
    exportCsv: args.exportCsv ? rel(args.exportCsv) : null,
    summary: summarize(rows, fileCount, errors),
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
