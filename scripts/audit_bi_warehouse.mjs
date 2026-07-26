#!/usr/bin/env node
/**
 * Lightweight health check for the SHEIN BI warehouse.
 *
 * This script is intentionally read-only. It is designed to run after the BI
 * pipeline so we can detect stale stores, broken ingestion, or an unusable
 * action queue before the user opens the BI portal. Metabase is retired from
 * the production BI path; it can still be checked explicitly with
 * --check-metabase when debugging archived dashboards.
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
    checkMetabase: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--distro') args.distro = argv[++i];
    else if (a === '--container') args.container = argv[++i];
    else if (a === '--database') args.database = argv[++i];
    else if (a === '--user') args.user = argv[++i];
    else if (a === '--out-dir') args.outDir = path.resolve(argv[++i]);
    else if (a === '--json') args.json = true;
    else if (a === '--check-metabase') args.checkMetabase = true;
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

async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return fallback; }
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

async function checkMetabase(args) {
  if (!args.checkMetabase) {
    return {
      ok: null,
      skipped: true,
      reason: 'Metabase 已退出生产 BI 入口；默认不再作为仓库体检依赖。',
    };
  }
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

function normalizedStoreKey(value) {
  return String(value || '').trim().toUpperCase();
}

/**
 * Product reconciliation is deliberately evaluated from the runner's semantic
 * report, not from the legacy browser/OpenAPI row-count comparison in the
 * warehouse. Browser four-state snapshots are diagnostic only; actionable
 * states are missing OpenAPI detail/stock or an unexplained API rollback.
 */
function assessOpenapiProductReconciliationReport(report, expectedStoreKeys, nowMs = Date.now()) {
  const expected = [...new Set((expectedStoreKeys || []).map(normalizedStoreKey).filter(Boolean))].sort();
  if (!report || typeof report !== 'object') {
    return {status: 'warning', warnings: ['尚未找到 OpenAPI 商品对账报告；请运行完整 19 店商品对账。'], notes: [], affectedStores: []};
  }
  const generatedAt = Date.parse(report.generatedAt || report.endedAt || '');
  if (!Number.isFinite(generatedAt) || nowMs - generatedAt > 48 * 3600_000) {
    return {status: 'warning', warnings: ['OpenAPI 商品对账报告超过 48 小时未更新；请运行完整 19 店商品对账。'], notes: [], affectedStores: []};
  }
  const rows = Array.isArray(report.results) ? report.results : [];
  const byStore = new Map(rows.map(row => [normalizedStoreKey(row?.storeKey), row]).filter(([key]) => key));
  const missing = expected.filter(storeKey => !byStore.has(storeKey));
  const warnings = [];
  if (missing.length) warnings.push(`OpenAPI 商品对账缺少店铺：${missing.join('、')}。`);
  const affectedStores = [];
  for (const storeKey of expected) {
    const row = byStore.get(storeKey);
    if (!row) continue;
    const semantic = row.semanticReconciliation;
    if (row.ok !== true) {
      affectedStores.push(storeKey);
      warnings.push(`${storeKey} 店商品对账未完成：${row.status || 'unknown'}。`);
      continue;
    }
    if (!semantic || semantic.policyVersion !== 'openapi-current-webhook-previous/v1') {
      affectedStores.push(storeKey);
      warnings.push(`${storeKey} 店商品对账仍是旧口径或缺少语义结果；请重新运行完整对账。`);
      continue;
    }
    if (semantic.status === 'warning') {
      affectedStores.push(storeKey);
      const detail = Array.isArray(semantic.warnings) ? semantic.warnings.join('；') : '存在可行动差异';
      warnings.push(`${storeKey} 店商品对账需处理：${detail}`);
    }
  }
  const diagnosticCount = rows.reduce((total, row) => {
    const diagnostic = row?.semanticReconciliation?.browserDiagnostic || {};
    return total
      + Number(diagnostic.apiOnlySkcCount || 0)
      + Number(diagnostic.browserOnlySkcCount || 0)
      + Number(diagnostic.binaryOnShelfDifferenceCount || 0)
      + Number(diagnostic.exactStatusDifferenceCount || 0);
  }, 0);
  const notes = warnings.length ? [] : [
    `OpenAPI 商品对账通过：${expected.length}/${expected.length} 店；浏览器快照差异仅保留为诊断证据，不作为失败。`,
    ...(diagnosticCount ? [`浏览器诊断差异计数 ${diagnosticCount}，不影响对账通过状态。`] : []),
  ];
  return {status: warnings.length ? 'warning' : 'ok', warnings, notes, affectedStores, generatedAt: report.generatedAt || report.endedAt || ''};
}

function evaluate(summary, metabase, productReconciliation = null) {
  const warnings = [];
  const errors = [];
  const notes = [];

  if (metabase && metabase.skipped) {
    // Metabase is an archived/manual dashboard surface now. Do not warn unless
    // the operator explicitly asks for --check-metabase and it fails.
  } else if (metabase && !metabase.ok) {
    warnings.push(`Metabase 健康检查失败：${metabase.error || metabase.body || metabase.status}`);
  }

  const s = summary || {};
  const latest = s.latestDates || {};
  if (!latest.sales_date) errors.push('没有在 fact.store_daily_sales 中找到销售数据。');
  if (!latest.link_date) warnings.push('没有在 fact.link_master_snapshot 中找到链接数据。');
  if (!latest.business_date) warnings.push('没有在 fact.home_finance_snapshot 中找到业务域快照。');
  if (!latest.finance_detail_date) warnings.push('没有在 fact.finance_module_stat_snapshot 中找到 gsfs 财务模块快照。');
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
    return arr.length ? `：缺少 ${arr.join('、')}` : '';
  };
  if (expectedStoreCount && (storeCoverage.sales_store_count || 0) < expectedStoreCount) {
    if (storeCoverage.sales_coverage_is_event_driven_today === true) {
      const missingStores = Array.isArray(storeCoverage.sales_missing_stores)
        ? storeCoverage.sales_missing_stores.filter(Boolean)
        : [];
      notes.push(`今日销售采用 Webhook 订单事件增量；${missingStores.length ? missingStores.join('、') : '尚无订单的店铺'}暂未产生订单事实，按 0 销量处理，不判为数据缺失。`);
    } else {
      warnings.push(`销售最新日覆盖 ${storeCoverage.sales_store_count || 0}/${expectedStoreCount} 店${miss('sales_missing_stores')}`);
    }
  }
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

  const accounting = s.accountingHealth || {};
  const profitCache = accounting.profit_cache || {};
  if (!profitCache.status) {
    errors.push('利润缓存尚未发布；拒绝让体检或 BI 页面回退到昂贵的实时利润视图。');
  } else if (profitCache.status !== 'ok') {
    errors.push(`利润缓存状态异常：${profitCache.status}。`);
  } else {
    const factOrderMax = String(profitCache.fact_order_max_date || '').slice(0, 10);
    const cacheOrderMax = String(profitCache.source_max_order_date || '').slice(0, 10);
    const factStorageMax = String(profitCache.fact_storage_fee_max_date || '').slice(0, 10);
    const cacheStorageMax = String(profitCache.source_max_storage_fee_date || '').slice(0, 10);
    if (factOrderMax && cacheOrderMax < factOrderMax) {
      errors.push(`利润缓存落后于订单事实：cache=${cacheOrderMax || '-'} fact=${factOrderMax}。`);
    }
    if (factStorageMax && cacheStorageMax < factStorageMax) {
      errors.push(`利润缓存落后于仓储费事实：cache=${cacheStorageMax || '-'} fact=${factStorageMax}。`);
    }
  }
  const latestCostRun = accounting.latest_cost_run || {};
  if (!latestCostRun.run_id) {
    warnings.push('尚无已完成的移动平均成本台账运行；利润中的商品成本不能视为已锁定历史成本。');
  } else {
    if (latestCostRun.status !== 'completed') errors.push(`最近成本台账运行未完成：run=${latestCostRun.run_id} status=${latestCostRun.status || '-'}`);
    if (Number(latestCostRun.frozen_rows_touched || 0) !== 0) {
      errors.push(`最近成本台账运行触碰了冻结会计期：run=${latestCostRun.run_id} rows=${latestCostRun.frozen_rows_touched}`);
    }
    if (Number(latestCostRun.unvalued_sale_count || 0) > 0) {
      warnings.push(`最近成本台账仍有 ${latestCostRun.unvalued_sale_count} 条销售缺少可用历史成本；这些行不会硬算利润。`);
    }
  }

  const storage = accounting.storage_reconciliation || {};
  const maxStorageDelta = Math.max(
    Math.abs(Number(storage.max_store_delta_sar || 0)),
    Math.abs(Number(storage.max_product_delta_sar || 0)),
    Math.abs(Number(storage.max_product_store_delta_sar || 0)),
  );
  if (maxStorageDelta > 0.01) {
    errors.push(`仓储费分摊未守恒：最大差额 ${maxStorageDelta.toFixed(4)} SAR（允许误差 0.01 SAR）。`);
  }
  if (Number(storage.unresolved_replacement_chain_count || 0) > 0) {
    errors.push(`仓储费存在 ${storage.unresolved_replacement_chain_count} 条“待支付→已支付”替换链未收敛到唯一 canonical 账单。`);
  }
  if (Number(storage.canonical_duplicate_count || 0) > 0) {
    errors.push(`仓储费 canonical 替换链出现 ${storage.canonical_duplicate_count} 组重复保留账单，拒绝继续使用可能双算的利润缓存。`);
  }
  const rawStorageDate = String(storage.latest_raw_fee_date || '').slice(0, 10);
  const canonicalStorageDate = String(storage.latest_canonical_fee_date || '').slice(0, 10);
  if (rawStorageDate && (!canonicalStorageDate || canonicalStorageDate < rawStorageDate)) {
    errors.push(`仓储费 canonical 总账日期陈旧：canonical=${canonicalStorageDate || '-'} raw=${rawStorageDate}。`);
  }
  if (Number(storage.detail_missing_days || 0) > 0) {
    warnings.push(`有 ${storage.detail_missing_days} 个 canonical 仓储费日期缺少可用货号明细，金额已进入 CENTRAL_POOL 或库存证据回退，未把缺失明细当作 0。`);
  }
  if (Number(storage.detail_scaled_days || 0) > 0) {
    notes.push(`有 ${storage.detail_scaled_days} 个 canonical 仓储费日期的货号明细已按日缩放至 canonical 总账；这是保持明细与实际账单守恒的正常处理。`);
  }
  if (Number(storage.detail_inherited_bill_count || 0) > 0) {
    warnings.push(`有 ${storage.detail_inherited_bill_count} 个 canonical 仓储费账单缺少自身明细，已继承单一 superseded 明细源；未合并多份替换链导出。`);
  }
  if (Number(storage.central_pool_fee_sar || 0) > 0) {
    notes.push(`有 ${Number(storage.central_pool_fee_sar).toFixed(2)} SAR 仓储费无法证明具体店铺归属，已保守留在 CENTRAL_POOL；金额仍计入总利润且未丢失。`);
  }

  const finance = accounting.finance_return_cost || {};
  if (!finance.latest_fetched_at) {
    warnings.push('尚未采集 OpenAPI 财务核对单或退货单实际费用；退货费只能使用按包裹估算值。');
  } else if (Number(finance.actual_cost_lines || 0) === 0) {
    warnings.push('OpenAPI 数据已采集，但财务核对单与退货单 performance_price 均没有非零实际退货费用；利润继续保留按包裹估算并明确标注。');
  }
  if (Math.abs(Number(finance.max_reconciliation_delta_sar || 0)) > 0.01) {
    errors.push(`实际退货费分摊未守恒：最大差额 ${Number(finance.max_reconciliation_delta_sar).toFixed(4)} SAR。`);
  }
  if (Number(finance.unmapped_lines || 0) > 0) {
    warnings.push(`有 ${finance.unmapped_lines} 条实际退货费尚未映射到订单行，金额 ${Number(finance.unmapped_actual_cost_sar || 0).toFixed(2)} SAR；该金额已单列风险，未静默计入或丢弃。`);
  }

  if (productReconciliation?.status === 'warning') {
    warnings.push(...productReconciliation.warnings);
  } else if (productReconciliation?.status === 'ok') {
    notes.push(...productReconciliation.notes);
  }

  return {ok: errors.length === 0, errors, warnings, notes};
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
    (SELECT max(snapshot_date) FROM fact.finance_module_stat_snapshot) AS finance_detail_date
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
      'sales_store_count', (
        SELECT count(DISTINCT store_key)
        FROM (
          SELECT store_key FROM fact.store_daily_sales WHERE date = (SELECT sales_date FROM latest)
          UNION
          SELECT store_key FROM fact.openapi_store_daily_sales WHERE date = (SELECT sales_date FROM latest)
        ) covered_sales_store
      ),
      'sales_fact_store_count', (SELECT count(DISTINCT store_key) FROM fact.store_daily_sales WHERE date = (SELECT sales_date FROM latest)),
      'sales_probe_store_count', (SELECT count(DISTINCT store_key) FROM fact.openapi_store_daily_sales WHERE date = (SELECT sales_date FROM latest)),
      'sales_coverage_is_event_driven_today', (
        (SELECT sales_date FROM latest) = current_date
        AND ops.shein_webhook_primary_sales_enabled(current_date)
      ),
      'business_store_count', (SELECT count(DISTINCT store_key) FROM fact.home_finance_snapshot WHERE snapshot_date = (SELECT business_date FROM latest)),
      'inventory_store_count', (SELECT count(DISTINCT store_key) FROM fact.visible_inventory_snapshot WHERE snapshot_date = (SELECT inventory_date FROM latest)),
      'quality_store_count', (SELECT count(DISTINCT store_key) FROM fact.quality_skc_snapshot WHERE snapshot_date = (SELECT quality_date FROM latest)),
      'finance_detail_store_count', (SELECT count(DISTINCT store_key) FROM fact.finance_module_stat_snapshot WHERE snapshot_date = (SELECT finance_detail_date FROM latest)),
      'sales_missing_stores', (
        SELECT to_jsonb(array_agg(store_key ORDER BY store_key))
        FROM dim.store s
        WHERE s.enabled IS DISTINCT FROM false
          AND NOT EXISTS (
            SELECT 1 FROM fact.store_daily_sales f
            WHERE f.date = (SELECT sales_date FROM latest) AND f.store_key = s.store_key
          )
          AND NOT EXISTS (
            SELECT 1 FROM fact.openapi_store_daily_sales f
            WHERE f.date = (SELECT sales_date FROM latest) AND f.store_key = s.store_key
          )
      ),
      'business_missing_stores', (SELECT to_jsonb(array_agg(store_key ORDER BY store_key)) FROM dim.store s WHERE NOT EXISTS (SELECT 1 FROM fact.home_finance_snapshot f WHERE f.snapshot_date = (SELECT business_date FROM latest) AND f.store_key = s.store_key)),
      'inventory_missing_stores', (SELECT to_jsonb(array_agg(store_key ORDER BY store_key)) FROM dim.store s WHERE NOT EXISTS (SELECT 1 FROM fact.visible_inventory_snapshot f WHERE f.snapshot_date = (SELECT inventory_date FROM latest) AND f.store_key = s.store_key)),
      'quality_missing_stores', (SELECT to_jsonb(array_agg(store_key ORDER BY store_key)) FROM dim.store s WHERE NOT EXISTS (SELECT 1 FROM fact.quality_skc_snapshot f WHERE f.snapshot_date = (SELECT quality_date FROM latest) AND f.store_key = s.store_key)),
      'finance_detail_missing_stores', (SELECT to_jsonb(array_agg(store_key ORDER BY store_key)) FROM dim.store s WHERE NOT EXISTS (SELECT 1 FROM fact.finance_module_stat_snapshot f WHERE f.snapshot_date = (SELECT finance_detail_date FROM latest) AND f.store_key = s.store_key))
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
    'accountingHealth', jsonb_build_object(
      'profit_cache', coalesce((
        SELECT jsonb_build_object(
          'status', m.status,
          'refreshed_at', m.refreshed_at,
          'source_max_order_date', m.source_max_order_date,
          'source_max_storage_fee_date', m.source_max_storage_fee_date,
          'fact_order_max_date', (SELECT max(created_date)::date FROM fact.order_item),
          'fact_storage_fee_max_date', (SELECT max(fee_date)::date FROM mart.et_storage_fee_daily),
          'row_counts', m.row_counts
        )
        FROM mart.profit_mart_cache_meta m
        WHERE m.cache_key = 'profit_marts'
      ), '{}'::jsonb),
      'latest_cost_run', coalesce((
        SELECT jsonb_build_object(
          'run_id', r.run_id,
          'status', r.status,
          'completed_at', r.completed_at,
          'rebuild_from', r.rebuild_from,
          'event_count', r.event_count,
          'sale_count', r.sale_count,
          'unvalued_sale_count', r.unvalued_sale_count,
          'frozen_rows_touched', (
            SELECT count(*)
            FROM fact.inventory_cost_ledger l
            JOIN ops.accounting_period_close c
              ON c.month_start = date_trunc('month', l.effective_at)::date
             AND c.status = 'frozen'
            WHERE l.ledger_version = r.ledger_version
          )
        )
        FROM ops.inventory_cost_run r
        ORDER BY r.completed_at DESC NULLS LAST, r.started_at DESC
        LIMIT 1
      ), '{}'::jsonb),
      'storage_reconciliation', coalesce((
        WITH canonical AS (
          SELECT * FROM mart.et_storage_fee_bill_canonical
        ),
        raw_storage AS (
          SELECT
            coalesce(ship_time::date, create_time::date, push_time::date) AS fee_date,
            income_bill_id,
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
            AND coalesce(ship_time::date, create_time::date, push_time::date) IS NOT NULL
        ),
        replacement_candidate AS (
          SELECT
            canonical_business_key,
            count(*) FILTER (WHERE payment_state = 'paid') AS paid_count,
            count(*) FILTER (WHERE payment_state = 'pending') AS pending_count,
            count(*) FILTER (WHERE payment_state = 'other') AS other_count
          FROM raw_storage
          GROUP BY canonical_business_key
        ),
        replacement_audit AS (
          SELECT
            r.canonical_business_key,
            count(c.income_bill_id) AS canonical_count,
            max(c.canonical_reason) AS canonical_reason
          FROM replacement_candidate r
          LEFT JOIN canonical c USING (canonical_business_key)
          WHERE r.paid_count = 1 AND r.pending_count >= 1 AND r.other_count = 0
          GROUP BY r.canonical_business_key
        ),
        canonical_detail_source AS (
          SELECT * FROM mart.et_storage_fee_canonical_detail_source
        ),
        detail_by_bill AS (
          SELECT s.fee_date, s.canonical_income_bill_id, s.detail_source_reason, count(*) AS detail_rows,
            sum(coalesce(d.shown_fee_rmb,0)) AS detail_shown_fee_rmb
          FROM canonical_detail_source s
          JOIN fact.et_storage_fee_product_detail d
            ON d.fee_date = s.fee_date
           AND d.income_bill_id = s.detail_source_income_bill_id
          WHERE s.detail_source_income_bill_id IS NOT NULL
          GROUP BY s.fee_date, s.canonical_income_bill_id, s.detail_source_reason
        ),
        detail_coverage AS (
          SELECT
            c.fee_date,
            count(*) AS canonical_bill_count,
            count(db.canonical_income_bill_id) FILTER (WHERE coalesce(db.detail_shown_fee_rmb,0) <> 0) AS covered_bill_count,
            sum(c.shown_fee_rmb) AS canonical_shown_fee_rmb,
            sum(coalesce(db.detail_shown_fee_rmb,0)) AS detail_shown_fee_rmb
          FROM canonical c
          LEFT JOIN detail_by_bill db
            ON db.fee_date = c.fee_date
           AND db.canonical_income_bill_id = c.income_bill_id
          GROUP BY c.fee_date
        ),
        fee AS (
          SELECT fee_date, sum(actual_fee_sar) AS actual_fee_sar
          FROM mart.et_storage_fee_daily
          GROUP BY fee_date
        ),
        store_alloc AS (
          SELECT date AS fee_date, sum(allocated_storage_fee_sar) AS allocated_fee_sar
          FROM mart.storage_fee_store_daily_cache
          GROUP BY date
        ),
        product_alloc AS (
          SELECT date AS fee_date, sum(actual_allocated_fee_sar) AS allocated_fee_sar
          FROM mart.storage_fee_product_daily_cache
          GROUP BY date
        ),
        product_store_alloc AS (
          SELECT
            date AS fee_date,
            sum(storage_fee_sar) AS allocated_fee_sar,
            sum(storage_fee_sar) FILTER (WHERE store_key = 'CENTRAL_POOL') AS central_pool_fee_sar
          FROM mart.storage_fee_product_store_daily_cache
          GROUP BY date
        ),
        reconciliation AS (
          SELECT
            f.fee_date,
            f.actual_fee_sar - coalesce(s.allocated_fee_sar,0) AS store_allocation_delta_sar,
            f.actual_fee_sar - coalesce(p.allocated_fee_sar,0) AS product_allocation_delta_sar,
            f.actual_fee_sar - coalesce(ps.allocated_fee_sar,0) AS product_store_allocation_delta_sar,
            coalesce(ps.central_pool_fee_sar,0) AS central_pool_fee_sar
          FROM fee f
          LEFT JOIN store_alloc s USING (fee_date)
          LEFT JOIN product_alloc p USING (fee_date)
          LEFT JOIN product_store_alloc ps USING (fee_date)
        )
        SELECT jsonb_build_object(
          'days', count(*),
          'max_store_delta_sar', coalesce(max(abs(store_allocation_delta_sar)),0),
          'max_product_delta_sar', coalesce(max(abs(product_allocation_delta_sar)),0),
          'max_product_store_delta_sar', coalesce(max(abs(product_store_allocation_delta_sar)),0),
          'central_pool_fee_sar', coalesce(sum(central_pool_fee_sar),0),
          'unresolved_replacement_chain_count', (
            SELECT count(*) FROM replacement_audit
            WHERE canonical_count <> 1
               OR canonical_reason <> 'status_replacement_paid_supersedes_pending'
          ),
          'canonical_duplicate_count', (
            SELECT count(*) FROM replacement_audit WHERE canonical_count > 1
          ),
          'detail_covered_days', (
            SELECT count(*) FROM detail_coverage
            WHERE covered_bill_count = canonical_bill_count
          ),
          'detail_missing_days', (
            SELECT count(*) FROM detail_coverage
            WHERE covered_bill_count < canonical_bill_count
          ),
          'detail_scaled_days', (
            SELECT count(*) FROM detail_coverage
            WHERE covered_bill_count = canonical_bill_count
              AND abs(canonical_shown_fee_rmb - detail_shown_fee_rmb) > 0.05
          ),
          'detail_inherited_bill_count', (
            SELECT count(*) FROM canonical_detail_source
            WHERE detail_source_reason = 'superseded_bill_detail_fallback'
          ),
          'detail_inherited_days', (
            SELECT count(DISTINCT fee_date) FROM canonical_detail_source
            WHERE detail_source_reason = 'superseded_bill_detail_fallback'
          ),
          'latest_raw_fee_date', (SELECT max(fee_date) FROM raw_storage),
          'latest_canonical_fee_date', (SELECT max(fee_date) FROM canonical)
        )
        FROM reconciliation
      ), '{}'::jsonb),
      'finance_return_cost', jsonb_build_object(
        'latest_fetched_at', greatest(
          (SELECT max(fetched_at) FROM fact.openapi_finance_check_order),
          (SELECT max(updated_at) FROM fact.openapi_return_item)
        ),
        'covered_stores', (
          SELECT count(DISTINCT store_key)
          FROM (
            SELECT store_key FROM fact.openapi_finance_check_order
            UNION ALL
            SELECT store_key FROM fact.openapi_return_item
          ) covered
        ),
        'check_orders', (SELECT count(*) FROM fact.openapi_finance_check_order),
        'settled_check_orders', (SELECT count(*) FROM fact.openapi_finance_check_order WHERE check_status = 3),
        'finance_actual_cost_lines', (
          SELECT count(*) FROM fact.openapi_finance_check_order_item
          WHERE check_status = 3
            AND (coalesce(return_expense_sar,0) <> 0 OR coalesce(return_freight_subsidy_sar,0) <> 0)
        ),
        'return_order_actual_cost_lines', (
          SELECT count(*) FROM fact.openapi_return_item WHERE coalesce(performance_price,0) > 0
        ),
        'actual_cost_lines', (SELECT count(*) FROM mart.return_cost_actual),
        'actual_cost_sar', (SELECT coalesce(sum(actual_return_cost_sar),0) FROM mart.return_cost_actual),
        'actual_fee_sources', coalesce((
          SELECT jsonb_object_agg(fee_source, source_count)
          FROM (
            SELECT fee_source, count(*) AS source_count
            FROM mart.return_cost_actual
            GROUP BY fee_source
          ) source_counts
        ), '{}'::jsonb),
        'mapped_lines', (
          SELECT count(*) FROM (
            SELECT mapped FROM mart.finance_return_cost_reconciliation
            UNION ALL
            SELECT mapped FROM mart.return_order_performance_cost_reconciliation
          ) r WHERE mapped
        ),
        'unmapped_lines', (
          SELECT count(*) FROM (
            SELECT mapped FROM mart.finance_return_cost_reconciliation
            UNION ALL
            SELECT mapped FROM mart.return_order_performance_cost_reconciliation
          ) r WHERE NOT mapped
        ),
        'mapped_actual_cost_sar', (
          SELECT coalesce(sum(mapped_cost_sar),0) FROM (
            SELECT mapped_net_return_cost_sar AS mapped_cost_sar FROM mart.finance_return_cost_reconciliation
            UNION ALL
            SELECT mapped_return_performance_cost_sar AS mapped_cost_sar FROM mart.return_order_performance_cost_reconciliation
          ) r
        ),
        'unmapped_actual_cost_sar', (
          SELECT coalesce(sum(unmapped_cost_sar),0) FROM (
            SELECT unmapped_net_return_cost_sar AS unmapped_cost_sar FROM mart.finance_return_cost_reconciliation
            UNION ALL
            SELECT unmapped_return_performance_cost_sar AS unmapped_cost_sar FROM mart.return_order_performance_cost_reconciliation
          ) r
        ),
        'max_reconciliation_delta_sar', (
          SELECT coalesce(max(abs(reconciliation_delta_sar)),0) FROM (
            SELECT reconciliation_delta_sar FROM mart.finance_return_cost_reconciliation
            UNION ALL
            SELECT reconciliation_delta_sar FROM mart.return_order_performance_cost_reconciliation
          ) r
        )
      )
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
  const metabase = await checkMetabase(args);
  const storeConfig = await readJson(path.join(ROOT, 'config', 'stores.json'), {});
  const expectedStoreKeys = (Array.isArray(storeConfig?.stores) ? storeConfig.stores : [])
    .filter(store => store?.enabled !== false)
    .map(store => store?.storeKey);
  const productReport = await readJson(path.join(ROOT, 'state', 'openapi-probes', 'product-reconciliation.latest.json'), null);
  const productReconciliation = assessOpenapiProductReconciliationReport(productReport, expectedStoreKeys);
  const evaluation = evaluate(summary, metabase, productReconciliation);
  const report = {
    ok: evaluation.ok,
    generatedAt: new Date().toISOString(),
    metabase,
    productReconciliation,
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
    accountingHealth: summary.accountingHealth,
    productReconciliation,
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
