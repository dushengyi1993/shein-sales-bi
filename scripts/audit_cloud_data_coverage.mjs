#!/usr/bin/env node
/**
 * Read-only cloud BI coverage audit.
 *
 * This checks only daily facts where a missing (date, store) row is a strong
 * ingestion signal. Event/detail tables such as after-sales, comments, waybill
 * packages, and fulfillment lines are intentionally excluded because "no row"
 * can be legitimate business state there.
 */
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_STORE_WHERE = 'enabled IS DISTINCT FROM false';

const TABLE_RULES = [
  {
    key: 'sales',
    label: 'SHEIN 销售日报',
    table: 'fact.store_daily_sales',
    dateColumn: 'date',
    storeColumn: 'store_key',
    severity: 'error',
    storeWhere: DEFAULT_STORE_WHERE,
    // Webhook-primary sales only materializes today's row after a store has an
    // order event. A missing row today can therefore mean a legitimate zero,
    // while the next-day 03:00 finalizer materializes explicit zero rows. Keep
    // the prior day informational until 04:00 so the 00:50/01:50/02:50
    // watchdog runs do not alert on stores with legitimately zero orders.
    allowSparseCurrentDay: true,
    finalizationGraceHours: 4,
  },
  {
    key: 'linkPerformance',
    label: '链接/流量日指标',
    table: 'fact.link_performance_daily',
    dateColumn: 'date',
    storeColumn: 'store_key',
    severity: 'error',
    storeWhere: `${DEFAULT_STORE_WHERE} AND product_stats_enabled IS DISTINCT FROM false`,
    zeroMetricExpression: [
      'coalesce(sum(eps_uv),0)',
      'coalesce(sum(goods_uv),0)',
      'coalesce(sum(sale_cnt),0)',
      'coalesce(sum(pay_order_cnt),0)',
    ].join(' + '),
  },
  {
    key: 'productStoreCoverage',
    label: '产品店铺覆盖',
    table: 'fact.product_store_coverage',
    dateColumn: 'date',
    storeColumn: 'store_key',
    severity: 'error',
    storeWhere: `${DEFAULT_STORE_WHERE} AND product_stats_enabled IS DISTINCT FROM false`,
  },
];

function parseArgs(argv) {
  const args = {
    distro: 'Ubuntu-24.04',
    container: 'shein-warehouse-db',
    database: 'shein_bi',
    user: 'shein',
    start: '',
    end: '',
    recentDays: 1,
    tables: TABLE_RULES.map(r => r.key),
    expectedStart: 'first-seen',
    statementTimeoutMs: 25_000,
    maxRows: 200,
    json: false,
    strict: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--distro') args.distro = argv[++i];
    else if (a === '--container') args.container = argv[++i];
    else if (a === '--database') args.database = argv[++i];
    else if (a === '--user') args.user = argv[++i];
    else if (a === '--start') args.start = argv[++i];
    else if (a === '--end') args.end = argv[++i];
    else if (a === '--recent-days') args.recentDays = Math.max(1, Number(argv[++i] || 1));
    else if (a === '--tables') args.tables = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--expected-start') args.expectedStart = String(argv[++i] || '').trim();
    else if (a === '--statement-timeout-ms') args.statementTimeoutMs = Math.max(0, Number(argv[++i] || 0));
    else if (a === '--max-rows') args.maxRows = Math.max(1, Number(argv[++i] || 200));
    else if (a === '--json') args.json = true;
    else if (a === '--strict') args.strict = true;
    else if (a === '--all') args.tables = TABLE_RULES.map(r => r.key);
  }
  if (args.start && !/^\d{4}-\d{2}-\d{2}$/.test(args.start)) throw new Error('--start must be YYYY-MM-DD');
  if (args.end && !/^\d{4}-\d{2}-\d{2}$/.test(args.end)) throw new Error('--end must be YYYY-MM-DD');
  if (args.start && !args.end) args.end = args.start;
  if (args.end && !args.start) args.start = args.end;
  if (!['first-seen', 'range-start'].includes(args.expectedStart)) {
    throw new Error('--expected-start must be one of: first-seen, range-start');
  }
  return args;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function runPsql(args, sql) {
  const useWsl = process.platform === 'win32';
  const dockerPrefix = () => {
    if (process.platform === 'win32') return 'sudo ';
    if (typeof process.getuid === 'function' && process.getuid() === 0) return '';
    return 'sudo ';
  };
  const linuxCommand = `${dockerPrefix()}docker exec -i ${shellQuote(args.container)} psql -U ${shellQuote(args.user)} -d ${shellQuote(args.database)} -v ON_ERROR_STOP=1 -t -A -F $'\\t'`;
  const command = useWsl ? 'wsl' : 'bash';
  const commandArgs = useWsl
    ? ['-d', args.distro, '--', 'bash', '-lc', linuxCommand]
    : ['-lc', linuxCommand];
  const child = spawn(command, commandArgs, {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  const statementTimeout = Number(args.statementTimeoutMs || 0);
  child.stdin.write(statementTimeout > 0 ? `SET statement_timeout = ${Math.floor(statementTimeout)};\n${sql}` : sql);
  child.stdin.end();
  const code = await new Promise(resolve => child.on('close', resolve));
  if (code !== 0) {
    throw new Error(`psql failed (${code})\nSTDOUT:\n${stdout.slice(-2000)}\nSTDERR:\n${stderr.slice(-4000)}`);
  }
  return stdout
    .split(/\r?\n/)
    .filter(line => line.trim() !== 'SET')
    .join('\n')
    .trim();
}

function sqlLiteral(value) {
  if (value === null || value === undefined || value === '') return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function qIdent(identifier) {
  return String(identifier).split('.').map(part => `"${part.replace(/"/g, '""')}"`).join('.');
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function splitLines(text) {
  return String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

async function latestDate(args, rule) {
  const sql = `SELECT max(${qIdent(rule.dateColumn)})::date::text FROM ${qIdent(rule.table)};`;
  return (await runPsql(args, sql)).trim();
}

async function expectedStores(args, rule = {}) {
  const sql = `
SELECT count(*)::int, string_agg(store_key, ',' ORDER BY store_key)
FROM dim.store
WHERE ${rule.storeWhere || DEFAULT_STORE_WHERE};
`;
  const out = await runPsql(args, sql);
  const [count, stores] = out.split('\t');
  return {
    count: Number(count || 0),
    stores: String(stores || '').split(',').filter(Boolean),
  };
}

async function databaseClock(args) {
  const out = (await runPsql(args, "SELECT current_date::text, extract(hour FROM localtime)::int;")).trim();
  const [currentDate, currentHour] = out.split('\t');
  return {
    currentDate,
    currentHour: Number(currentHour || 0),
  };
}

export function classifyMissingCoverageRows({
  rows,
  allowSparseCurrentDay = false,
  currentDate = '',
  currentHour = 0,
  finalizationGraceHours = 0,
  explicitRange = false,
}) {
  const missingRows = rows.filter(row => row.missingStoreCount > 0);
  if (!allowSparseCurrentDay || explicitRange || !currentDate) {
    return {blockingRows: missingRows, nonBlockingCurrentDayRows: []};
  }
  const priorDate = addDays(currentDate, -1);
  const priorDateInGrace = Number(currentHour) < Number(finalizationGraceHours || 0);
  const isNonBlocking = row => row.date === currentDate
    || (priorDateInGrace && row.date === priorDate);
  return {
    blockingRows: missingRows.filter(row => !isNonBlocking(row)),
    nonBlockingCurrentDayRows: missingRows.filter(isNonBlocking),
  };
}

async function auditRule(args, rule, clock) {
  const expected = await expectedStores(args, rule);
  const latest = await latestDate(args, rule);
  if (!latest) {
    return {
      key: rule.key,
      label: rule.label,
      table: rule.table,
      severity: rule.severity,
      storeScope: rule.storeWhere || DEFAULT_STORE_WHERE,
      expectedStoreCount: expected.count,
      expectedStores: expected.stores,
      latestDate: '',
      start: '',
      end: '',
      ok: false,
      missingDateCount: 0,
      missingStoreDateCells: 0,
      zeroMetricDates: [],
      rows: [],
      issues: [`${rule.label} 没有任何数据`],
    };
  }

  const end = args.end || latest;
  const start = args.start || addDays(end, 1 - args.recentDays);
  const expectedPredicate = args.expectedStart === 'first-seen'
    ? 'sf.first_date IS NOT NULL AND d.d >= sf.first_date'
    : 'true';
  const metricSelect = rule.zeroMetricExpression
    ? ', coalesce(m.metric_sum, 0)::numeric AS metric_sum'
    : ', NULL::numeric AS metric_sum';
  const metricJoin = rule.zeroMetricExpression
    ? `LEFT JOIN (
      SELECT ${qIdent(rule.dateColumn)}::date AS d, count(*)::int AS row_count, (${rule.zeroMetricExpression})::numeric AS metric_sum
      FROM ${qIdent(rule.table)}
      WHERE ${qIdent(rule.dateColumn)}::date BETWEEN ${sqlLiteral(start)}::date AND ${sqlLiteral(end)}::date
      GROUP BY 1
    ) m ON m.d = c.d`
    : `LEFT JOIN (
      SELECT ${qIdent(rule.dateColumn)}::date AS d, count(*)::int AS row_count
      FROM ${qIdent(rule.table)}
      WHERE ${qIdent(rule.dateColumn)}::date BETWEEN ${sqlLiteral(start)}::date AND ${sqlLiteral(end)}::date
      GROUP BY 1
    ) m ON m.d = c.d`;

  const sql = `
WITH store_scope AS (
  SELECT store_key
  FROM dim.store
  WHERE ${rule.storeWhere || DEFAULT_STORE_WHERE}
),
store_first AS (
  SELECT s.store_key, min(t.${qIdent(rule.dateColumn)})::date AS first_date
  FROM store_scope s
  LEFT JOIN ${qIdent(rule.table)} t ON t.${qIdent(rule.storeColumn)} = s.store_key
  GROUP BY s.store_key
),
days AS (
  SELECT generate_series(${sqlLiteral(start)}::date, ${sqlLiteral(end)}::date, '1 day'::interval)::date AS d
),
expected AS (
  SELECT d.d, sf.store_key
  FROM days d
  CROSS JOIN store_first sf
  WHERE ${expectedPredicate}
),
actual AS (
  SELECT DISTINCT ${qIdent(rule.dateColumn)}::date AS d, ${qIdent(rule.storeColumn)} AS store_key
  FROM ${qIdent(rule.table)}
  WHERE ${qIdent(rule.dateColumn)}::date BETWEEN ${sqlLiteral(start)}::date AND ${sqlLiteral(end)}::date
),
coverage AS (
  SELECT
    e.d,
    count(a.store_key)::int AS store_count,
    string_agg(e.store_key, ',' ORDER BY e.store_key) FILTER (WHERE a.store_key IS NULL) AS missing_stores
  FROM expected e
  LEFT JOIN actual a ON a.d = e.d AND a.store_key = e.store_key
  GROUP BY e.d
)
SELECT
  c.d::text,
  c.store_count,
  coalesce(c.missing_stores, ''),
  coalesce(m.row_count, 0)::int
  ${metricSelect}
FROM coverage c
${metricJoin}
ORDER BY c.d;
`;

  const rows = splitLines(await runPsql(args, sql)).map(line => {
    const [date, storeCount, missingStores, rowCount, metricSum] = line.split('\t');
    const missing = String(missingStores || '').split(',').filter(Boolean);
    return {
      date,
      storeCount: Number(storeCount || 0),
      expectedStoreCount: expected.count,
      missingStores: missing,
      missingStoreCount: missing.length,
      rowCount: Number(rowCount || 0),
      metricSum: metricSum === '' || metricSum === undefined ? null : Number(metricSum),
    };
  });

  const {
    blockingRows: missingRows,
    nonBlockingCurrentDayRows,
  } = classifyMissingCoverageRows({
    rows,
    allowSparseCurrentDay: Boolean(rule.allowSparseCurrentDay),
    currentDate: clock.currentDate,
    currentHour: clock.currentHour,
    finalizationGraceHours: Number(rule.finalizationGraceHours || 0),
    explicitRange: Boolean(args.start || args.end),
  });
  const zeroMetricDates = rule.zeroMetricExpression
    ? rows.filter(r => r.rowCount > 0 && r.storeCount >= expected.count && Number(r.metricSum || 0) === 0).map(r => r.date)
    : [];
  const issues = [];
  if (missingRows.length) {
    const sample = missingRows.slice(0, 5).map(r => `${r.date} 缺 ${r.missingStores.join(',')}`).join('；');
    issues.push(`${rule.label} 覆盖不足：${missingRows.length} 天、${missingRows.reduce((sum, r) => sum + r.missingStoreCount, 0)} 个店铺日缺口；${sample}`);
  }
  if (zeroMetricDates.length) {
    issues.push(`${rule.label} 存在全 0 指标日期：${zeroMetricDates.slice(0, 8).join(', ')}`);
  }
  return {
    key: rule.key,
    label: rule.label,
    table: rule.table,
    severity: rule.severity,
    storeScope: rule.storeWhere || DEFAULT_STORE_WHERE,
    expectedStart: args.expectedStart,
    expectedStoreCount: expected.count,
    expectedStores: expected.stores,
    latestDate: latest,
    start,
    end,
    ok: issues.length === 0,
    missingDateCount: missingRows.length,
    missingStoreDateCells: missingRows.reduce((sum, r) => sum + r.missingStoreCount, 0),
    nonBlockingCurrentDayGapCount: nonBlockingCurrentDayRows.reduce((sum, r) => sum + r.missingStoreCount, 0),
    nonBlockingCurrentDayRows: nonBlockingCurrentDayRows.slice(0, args.maxRows),
    zeroMetricDates,
    rows: rows.filter(r => r.missingStoreCount > 0 || zeroMetricDates.includes(r.date)).slice(0, args.maxRows),
    issues,
  };
}

function textReport(report) {
  const lines = [];
  lines.push(`cloud data coverage audit: ${report.ok ? 'OK' : 'ISSUES'} expectedStart=${report.args.expectedStart} generatedAt=${report.generatedAt}`);
  for (const check of report.checks) {
    lines.push(`- ${check.label} (${check.key}) ${check.start}..${check.end} expectedStores=${check.expectedStoreCount}: ${check.ok ? 'OK' : `missingDates=${check.missingDateCount} cells=${check.missingStoreDateCells} zeroMetricDates=${check.zeroMetricDates.length}`}`);
    for (const row of check.rows.slice(0, 12)) {
      const missing = row.missingStores?.length ? ` missing=${row.missingStores.join(',')}` : '';
      const zero = check.zeroMetricDates.includes(row.date) ? ' metricSum=0' : '';
      lines.push(`  ${row.date} stores=${row.storeCount}/${row.expectedStoreCount}${missing}${zero}`);
    }
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const selected = TABLE_RULES.filter(r => args.tables.includes(r.key));
  const unknown = args.tables.filter(key => !TABLE_RULES.some(r => r.key === key));
  if (unknown.length) throw new Error(`Unknown --tables key(s): ${unknown.join(', ')}`);
  const clock = await databaseClock(args);
  const checks = [];
  for (const rule of selected) checks.push(await auditRule(args, rule, clock));
  const issueCount = checks.reduce((sum, c) => sum + c.issues.length, 0);
  const report = {
    ok: issueCount === 0,
    generatedAt: new Date().toISOString(),
    args: {
      start: args.start,
      end: args.end,
      recentDays: args.recentDays,
      tables: args.tables,
      expectedStart: args.expectedStart,
      statementTimeoutMs: args.statementTimeoutMs,
      currentDate: clock.currentDate,
      currentHour: clock.currentHour,
    },
    issueCount,
    checks,
  };

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(textReport(report));
  if (args.strict && !report.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err?.stack || String(err));
    process.exitCode = 1;
  });
}
