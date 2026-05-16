#!/usr/bin/env node
/**
 * Lightweight health check for the SHEIN BI warehouse and Metabase.
 *
 * This script is intentionally read-only. It is designed to run after the BI
 * pipeline so we can detect stale stores, broken ingestion, or an unusable
 * action queue before the user opens Metabase.
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    distro: 'Ubuntu-24.04',
    container: 'shein-warehouse-db',
    database: 'shein_bi',
    user: 'shein',
    outDir: path.join(ROOT, 'outputs', 'bi_audit'),
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--distro') args.distro = argv[++i];
    else if (a === '--container') args.container = argv[++i];
    else if (a === '--database') args.database = argv[++i];
    else if (a === '--user') args.user = argv[++i];
    else if (a === '--out-dir') args.outDir = path.resolve(argv[++i]);
    else if (a === '--json') args.json = true;
  }
  return args;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

async function runPsql(args, sql) {
  const useWsl = process.platform === 'win32';
  const shellQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
  const dockerPrefix = () => {
    if (process.platform === 'win32') return 'sudo ';
    if (typeof process.getuid === 'function' && process.getuid() === 0) return '';
    return 'sudo ';
  };
  const linuxCommand = `${dockerPrefix()}docker exec -i ${shellQuote(args.container)} psql -U ${shellQuote(args.user)} -d ${shellQuote(args.database)} -v ON_ERROR_STOP=1 -t -A`;
  const command = useWsl ? 'wsl' : 'bash';
  const commandArgs = useWsl
    ? [
        '-d',
        args.distro,
        '--',
        'bash',
        '-lc',
        linuxCommand,
      ]
    : [
        '-lc',
        linuxCommand,
      ];
  const child = spawn(command, commandArgs, {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d.toString(); });
  child.stderr.on('data', d => { stderr += d.toString(); });
  child.stdin.write(sql);
  child.stdin.end();
  const code = await new Promise(resolve => child.on('close', resolve));
  if (code !== 0) {
    throw new Error(`psql failed (${code})\nSTDOUT:\n${stdout.slice(-2000)}\nSTDERR:\n${stderr.slice(-4000)}`);
  }
  return stdout.trim();
}

async function readMetabaseSession() {
  const file = path.join(ROOT, 'infra', 'metabase', '.session.local.json');
  if (!fssync.existsSync(file)) return null;
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function checkMetabase() {
  const session = await readMetabaseSession();
  const url = (session?.metabaseUrl || 'http://localhost:3000').replace(/\/$/, '');
  try {
    const res = await fetch(`${url}/api/health`, {signal: AbortSignal.timeout(5000)});
    const text = await res.text();
    return {ok: res.ok, url, status: res.status, body: text.slice(0, 200)};
  } catch (err) {
    return {ok: false, url, error: String(err.message || err)};
  }
}

function evaluate(summary, metabase) {
  const warnings = [];
  const errors = [];

  if (!metabase.ok) warnings.push(`Metabase 健康检查失败：${metabase.error || metabase.body || metabase.status}`);

  const s = summary || {};
  const latest = s.latestDates || {};
  if (!latest.sales_date) errors.push('没有在 fact.store_daily_sales 中找到销售数据。');
  if (!latest.link_date) warnings.push('没有在 fact.link_master_snapshot 中找到链接数据。');
  if (!latest.business_date) warnings.push('没有在 fact.home_finance_snapshot 中找到业务域快照。');
  if (!latest.finance_detail_date) warnings.push('没有在 fact.finance_no_finish_order 中找到 gsfs 财务明细数据。');
  const linkLagDaysFromSales = latest.link_date && latest.sales_date
    ? Math.floor((Date.parse(`${latest.sales_date}T00:00:00Z`) - Date.parse(`${latest.link_date}T00:00:00Z`)) / 86400000)
    : 0;
  const linkLagDaysFromBusiness = latest.link_date && latest.business_date
    ? Math.floor((Date.parse(`${latest.business_date}T00:00:00Z`) - Date.parse(`${latest.link_date}T00:00:00Z`)) / 86400000)
    : 0;
  // Link performance is intentionally refreshed once per day at 05:30 for the
  // previous complete day.  When today's sales/business domains are refreshed
  // intraday, link_date = sales_date - 1 is normal and should not alarm.
  if (linkLagDaysFromSales > 1) {
    warnings.push(`链接数据超过 1 天未更新：link_date=${latest.link_date}，sales_date=${latest.sales_date}。请确认 05:30 链接同步是否成功完成。`);
  }
  if (linkLagDaysFromBusiness > 1) {
    warnings.push(`链接数据超过 1 天未更新：link_date=${latest.link_date}，business_date=${latest.business_date}。请确认 05:30 链接同步是否成功完成。`);
  }

  const storeCoverage = s.storeCoverage || {};
  const expectedStoreCount = Number(s.storeCount || 0) || 0;
  const miss = key => {
    const arr = Array.isArray(storeCoverage[key]) ? storeCoverage[key].filter(Boolean) : [];
    return arr.length ? `???${arr.join('?')}` : '';
  };
  if (expectedStoreCount && (storeCoverage.sales_store_count || 0) < expectedStoreCount) warnings.push(`销售最新日覆盖 ${storeCoverage.sales_store_count || 0}/${expectedStoreCount} 店${miss('sales_missing_stores')}`);
  if (expectedStoreCount && (storeCoverage.business_store_count || 0) < expectedStoreCount) warnings.push(`业务域最新日覆盖 ${storeCoverage.business_store_count || 0}/${expectedStoreCount} 店${miss('business_missing_stores')}`);
  if (expectedStoreCount && (storeCoverage.inventory_store_count || 0) < expectedStoreCount) warnings.push(`库存最新日覆盖 ${storeCoverage.inventory_store_count || 0}/${expectedStoreCount} 店${miss('inventory_missing_stores')}`);
  if (expectedStoreCount && (storeCoverage.quality_store_count || 0) < expectedStoreCount) warnings.push(`质量最新日覆盖 ${storeCoverage.quality_store_count || 0}/${expectedStoreCount} 店${miss('quality_missing_stores')}`);
  if (expectedStoreCount && (storeCoverage.finance_detail_store_count || 0) > 0 && (storeCoverage.finance_detail_store_count || 0) < expectedStoreCount) {
    warnings.push(`gsfs 财务明细覆盖 ${storeCoverage.finance_detail_store_count}/${expectedStoreCount} 店${miss('finance_detail_missing_stores')}；未覆盖店铺不要把财务明细空值当 0。`);
  }

  const counts = s.latestCounts || {};
  if ((counts.visible_inventory_rows || 0) <= 0) warnings.push('正确展示库存行数为空。');
  if ((counts.visible_inventory_total || 0) <= 0) warnings.push('正确展示库存合计为 0，库存入仓可能异常。');
  if ((counts.guided_actions || 0) > 500) warnings.push(`指导动作池过大：${counts.guided_actions} 条。`);
  if ((counts.guided_actions || 0) < 20) warnings.push(`指导动作池可能过小：${counts.guided_actions} 条。`);
  if (latest.finance_detail_date && (counts.finance_no_finish_orders || 0) <= 0) warnings.push('已存在 gsfs 财务明细日期，但没有加载到在途收入订单。');

  return {ok: errors.length === 0, errors, warnings};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sql = `
WITH
latest AS (
  SELECT
    (SELECT max(date) FROM fact.store_daily_sales) AS sales_date,
    (SELECT max(snapshot_date) FROM fact.link_master_snapshot) AS link_date,
    (SELECT max(snapshot_date) FROM fact.home_finance_snapshot) AS business_date,
    (SELECT max(snapshot_date) FROM fact.visible_inventory_snapshot) AS inventory_date,
    (SELECT max(snapshot_date) FROM fact.quality_skc_snapshot) AS quality_date,
    (SELECT max(snapshot_date) FROM fact.finance_no_finish_order) AS finance_detail_date
),
summary AS (
  SELECT jsonb_build_object(
    'storeCount', (SELECT count(*) FROM dim.store WHERE enabled IS DISTINCT FROM false),
    'latestDates', jsonb_build_object(
      'sales_date', (SELECT sales_date FROM latest),
      'link_date', (SELECT link_date FROM latest),
      'business_date', (SELECT business_date FROM latest),
      'inventory_date', (SELECT inventory_date FROM latest),
      'quality_date', (SELECT quality_date FROM latest),
      'finance_detail_date', (SELECT finance_detail_date FROM latest)
    ),
    'storeCoverage', jsonb_build_object(
      'sales_store_count', (SELECT count(DISTINCT store_key) FROM fact.store_daily_sales WHERE date = (SELECT sales_date FROM latest)),
      'business_store_count', (SELECT count(DISTINCT store_key) FROM fact.home_finance_snapshot WHERE snapshot_date = (SELECT business_date FROM latest)),
      'inventory_store_count', (SELECT count(DISTINCT store_key) FROM fact.visible_inventory_snapshot WHERE snapshot_date = (SELECT inventory_date FROM latest)),
      'quality_store_count', (SELECT count(DISTINCT store_key) FROM fact.quality_skc_snapshot WHERE snapshot_date = (SELECT quality_date FROM latest)),
      'finance_detail_store_count', (SELECT count(DISTINCT store_key) FROM fact.finance_no_finish_order WHERE snapshot_date = (SELECT finance_detail_date FROM latest)),
      'sales_missing_stores', (SELECT to_jsonb(array_agg(store_key ORDER BY store_key)) FROM dim.store s WHERE NOT EXISTS (SELECT 1 FROM fact.store_daily_sales f WHERE f.date = (SELECT sales_date FROM latest) AND f.store_key = s.store_key)),
      'business_missing_stores', (SELECT to_jsonb(array_agg(store_key ORDER BY store_key)) FROM dim.store s WHERE NOT EXISTS (SELECT 1 FROM fact.home_finance_snapshot f WHERE f.snapshot_date = (SELECT business_date FROM latest) AND f.store_key = s.store_key)),
      'inventory_missing_stores', (SELECT to_jsonb(array_agg(store_key ORDER BY store_key)) FROM dim.store s WHERE NOT EXISTS (SELECT 1 FROM fact.visible_inventory_snapshot f WHERE f.snapshot_date = (SELECT inventory_date FROM latest) AND f.store_key = s.store_key)),
      'quality_missing_stores', (SELECT to_jsonb(array_agg(store_key ORDER BY store_key)) FROM dim.store s WHERE NOT EXISTS (SELECT 1 FROM fact.quality_skc_snapshot f WHERE f.snapshot_date = (SELECT quality_date FROM latest) AND f.store_key = s.store_key)),
      'finance_detail_missing_stores', (SELECT to_jsonb(array_agg(store_key ORDER BY store_key)) FROM dim.store s WHERE NOT EXISTS (SELECT 1 FROM fact.finance_no_finish_order f WHERE f.snapshot_date = (SELECT finance_detail_date FROM latest) AND f.store_key = s.store_key))
    ),
    'latestCounts', jsonb_build_object(
      'sales_rows', (SELECT count(*) FROM fact.store_daily_sales WHERE date = (SELECT sales_date FROM latest)),
      'order_items', (SELECT count(*) FROM fact.order_item WHERE created_date = (SELECT sales_date FROM latest)),
      'link_master_rows', (SELECT count(*) FROM fact.link_master_snapshot WHERE snapshot_date = (SELECT link_date FROM latest)),
      'visible_inventory_rows', (SELECT count(*) FROM fact.visible_inventory_snapshot WHERE snapshot_date = (SELECT inventory_date FROM latest)),
      'visible_inventory_total', (SELECT coalesce(sum(inventory_quantity), 0) FROM fact.visible_inventory_snapshot WHERE snapshot_date = (SELECT inventory_date FROM latest)),
      'after_sales_rows', (SELECT count(*) FROM fact.after_sales_item WHERE snapshot_date = (SELECT business_date FROM latest)),
      'waybill_rows', (SELECT count(*) FROM fact.waybill_package WHERE snapshot_date = (SELECT business_date FROM latest)),
      'finance_no_finish_orders', (SELECT count(*) FROM fact.finance_no_finish_order WHERE snapshot_date = (SELECT finance_detail_date FROM latest)),
      'finance_no_finish_income_sar', (SELECT coalesce(sum(estimate_income_money_total),0) FROM fact.finance_no_finish_order WHERE snapshot_date = (SELECT finance_detail_date FROM latest)),
      'quality_rows', (SELECT count(*) FROM fact.quality_skc_snapshot WHERE snapshot_date = (SELECT quality_date FROM latest)),
      'comments_90d', (SELECT count(*) FROM fact.product_comment WHERE comment_date >= (SELECT business_date FROM latest) - interval '90 days'),
      'guided_actions', (SELECT count(*) FROM mart.bi_guided_action_current)
    ),
    'guidedActionByDomain', (SELECT coalesce(jsonb_object_agg(action_domain, n), '{}'::jsonb) FROM (SELECT action_domain, count(*) AS n FROM mart.bi_guided_action_current GROUP BY action_domain) t),
    'topRiskStores', (SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM (
      SELECT store_key, sales_sar, after_sales_case_count, low_display_stock_count, low_star_comment_count, risk_score
      FROM mart.bi_business_store_current
      ORDER BY risk_score DESC
      LIMIT 8
    ) t)
  ) AS payload
)
SELECT payload::text FROM summary;
`;
  const raw = await runPsql(args, sql);
  const summary = JSON.parse(raw);
  const metabase = await checkMetabase();
  const evaluation = evaluate(summary, metabase);
  const report = {
    ok: evaluation.ok,
    generatedAt: new Date().toISOString(),
    metabase,
    evaluation,
    summary,
  };
  await fs.mkdir(args.outDir, {recursive: true});
  const file = path.join(args.outDir, `bi-audit-${stamp()}.json`);
  await fs.writeFile(file, JSON.stringify(report, null, 2), 'utf8');
  const printable = {
    ok: report.ok,
    file: path.relative(ROOT, file).replace(/\\/g, '/'),
    latestDates: summary.latestDates,
    latestCounts: summary.latestCounts,
    guidedActionByDomain: summary.guidedActionByDomain,
    warnings: evaluation.warnings,
    errors: evaluation.errors,
  };
  console.log(JSON.stringify(printable, null, 2));
  if (args.json) console.log(JSON.stringify(report));
  if (!report.ok) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
