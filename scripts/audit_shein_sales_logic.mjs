#!/usr/bin/env node
/**
 * SHEIN automation consistency audit.
 *
 * This is a guardrail script for low-level accounting mistakes:
 * - ALL/DSY/LGM double counting
 * - dashboard statistics cards using non-KPI fields
 * - stale/partial refresh after one group fails
 * - product totals drifting from store totals
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORES_PATH = path.join(ROOT, 'config', 'stores.json');
const REPORT_CFG_PATH = path.join(ROOT, 'config', 'lark_report.json');
const STATE_PATH = path.join(ROOT, 'state', 'lark_base.json');
const FETCH_DIR = path.join(ROOT, 'outputs', 'shein_fetch');
const REPORT_DIR = path.join(ROOT, 'outputs', 'reports');
const FX = 1.8;
const EPS = 0.03;

function parseArgs(argv) {
  const args = {month: null, date: null, online: true};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--month') args.month = argv[++i];
    else if (a === '--date') args.date = argv[++i];
    else if (a === '--offline') args.online = false;
  }
  return args;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function round2(n) { return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100; }
function beijingDate(offsetDays = 0) {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'})
    .formatToParts(new Date()).reduce((acc, p) => { if (p.type !== 'literal') acc[p.type] = p.value; return acc; }, {});
  const d = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function monthDates(month) {
  return Array.from({length: daysInMonth(month)}, (_, i) => `${month}-${pad2(i + 1)}`);
}
async function readJson(file, fallback = null) {
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (err) { if (err.code === 'ENOENT') return fallback; throw err; }
}
function moneyFromText(text) {
  const m = String(text || '').replace(/,/g, '').match(/(-?\d+(?:\.\d+)?)\s*SAR/);
  return m ? Number(m[1]) : 0;
}
function uniq(arr) { return [...new Set(arr)]; }
function diff(a, b) { return Math.abs(round2(a) - round2(b)); }

function makeAudit() {
  const issues = [];
  return {
    issues,
    check(condition, severity, code, message, details = {}) {
      if (!condition) issues.push({severity, code, message, details});
    },
    warn(condition, code, message, details = {}) {
      if (!condition) issues.push({severity: 'warn', code, message, details});
    },
  };
}

function groupStoreKeys(cfg, group) {
  const enabled = cfg.stores.filter(s => s.enabled !== false);
  if (group === 'ALL_DYNAMIC') return enabled.map(s => s.storeKey);
  return (cfg.groups?.[group] || []).filter(k => enabled.some(s => s.storeKey === k));
}

async function auditStoreConfig(audit, cfg) {
  const enabled = cfg.stores.filter(s => s.enabled !== false);
  const enabledKeys = enabled.map(s => s.storeKey);
  audit.check(enabledKeys.length === uniq(enabledKeys).length, 'error', 'STORE_DUPLICATE', '启用店铺代号存在重复', {enabledKeys});
  const dsy = cfg.groups?.DSY || [];
  const lgm = cfg.groups?.LGM || [];
  const overlap = dsy.filter(k => lgm.includes(k));
  audit.check(overlap.length === 0, 'error', 'GROUP_OVERLAP', 'DSY/LGM 店铺分组存在重叠，会导致分组合计重复', {overlap});
  const union = uniq([...dsy, ...lgm]).sort();
  audit.check(JSON.stringify(union) === JSON.stringify([...enabledKeys].sort()), 'error', 'GROUP_UNION_MISMATCH', 'DSY/LGM 并集与启用店铺不一致', {union, enabledKeys: [...enabledKeys].sort()});
  const all = cfg.groups?.ALL || [];
  audit.warn(JSON.stringify([...all].sort()) === JSON.stringify([...enabledKeys].sort()), 'ALL_GROUP_STALE', 'groups.ALL 与启用店铺不一致；ALL 口径应优先动态取启用店铺', {all: [...all].sort(), enabledKeys: [...enabledKeys].sort()});
  for (const store of enabled) {
    audit.check((cfg.groups?.[store.groupKey] || []).includes(store.storeKey), 'error', 'STORE_GROUPKEY_MISMATCH', '店铺 groupKey 与 groups 配置不一致', {storeKey: store.storeKey, groupKey: store.groupKey});
  }
}

async function loadFetch(storeKey, date) {
  return await readJson(path.join(FETCH_DIR, storeKey, `${date}.json`), null);
}
async function dayTotals(cfg, date, group = 'ALL_DYNAMIC') {
  const keys = group === 'ALL_DYNAMIC' ? groupStoreKeys(cfg, 'ALL_DYNAMIC') : groupStoreKeys(cfg, group);
  let salesSar = 0, orders = 0, qty = 0;
  const missing = [];
  const fetchTimes = [];
  for (const key of keys) {
    const obj = await loadFetch(key, date);
    if (!obj?.summary) { missing.push(key); continue; }
    salesSar += Number(obj.summary.salesSar || 0);
    orders += Number(obj.summary.positiveAmountOrderCount || 0);
    qty += Number(obj.summary.quantityPositiveAmount || 0);
    if (obj.fetchTime) fetchTimes.push(obj.fetchTime);
  }
  return {salesSar: round2(salesSar), salesRmb: round2(salesSar * FX), orders, qty, missing, fetchTimes};
}
async function monthStoreTotal(cfg, month, group = 'ALL_DYNAMIC') {
  let salesSar = 0;
  const missing = [];
  for (const date of monthDates(month)) {
    const d = await dayTotals(cfg, date, group);
    salesSar += d.salesSar;
    missing.push(...d.missing.map(storeKey => `${date}:${storeKey}`));
  }
  return {salesSar: round2(salesSar), missing};
}
async function monthProductTotal(cfg, month, group = 'ALL_DYNAMIC') {
  const keys = group === 'ALL_DYNAMIC' ? groupStoreKeys(cfg, 'ALL_DYNAMIC') : groupStoreKeys(cfg, group);
  const productKeys = keys.filter(k => {
    const store = cfg.stores.find(s => s.storeKey === k);
    return store?.productStatsEnabled !== false;
  });
  let salesSar = 0, qty = 0;
  const missing = [];
  for (const key of productKeys) {
    for (const date of monthDates(month)) {
      const obj = await loadFetch(key, date);
      if (!obj?.summary) { missing.push(`${date}:${key}`); continue; }
      for (const g of obj.goodsRows || []) {
        const sar = Number(g.currencyPrice || 0);
        const n = Number(g.number || 0);
        if (sar > 0 && n > 0) { salesSar += sar; qty += n; }
      }
    }
  }
  return {salesSar: round2(salesSar), qty, missing};
}

async function auditLocalTotals(audit, cfg, month, date) {
  const todayAll = await dayTotals(cfg, date, 'ALL_DYNAMIC');
  const todayDsy = await dayTotals(cfg, date, 'DSY');
  const todayLgm = await dayTotals(cfg, date, 'LGM');
  audit.check(diff(todayAll.salesSar, todayDsy.salesSar + todayLgm.salesSar) <= EPS, 'error', 'TODAY_GROUP_SUM_MISMATCH', '今日 ALL 不等于 DSY+LGM', {todayAll, todayDsy, todayLgm});

  const monthAll = await monthStoreTotal(cfg, month, 'ALL_DYNAMIC');
  const monthDsy = await monthStoreTotal(cfg, month, 'DSY');
  const monthLgm = await monthStoreTotal(cfg, month, 'LGM');
  audit.check(diff(monthAll.salesSar, monthDsy.salesSar + monthLgm.salesSar) <= EPS, 'error', 'MONTH_GROUP_SUM_MISMATCH', '本月 ALL 不等于 DSY+LGM', {monthAll, monthDsy, monthLgm});

  const productAll = await monthProductTotal(cfg, month, 'ALL_DYNAMIC');
  audit.check(diff(productAll.salesSar, monthAll.salesSar) <= EPS, 'error', 'PRODUCT_STORE_TOTAL_MISMATCH', '本月产品明细合计与店铺日销合计不一致', {productAll, monthAll, delta: round2(productAll.salesSar - monthAll.salesSar)});
  audit.warn(todayAll.missing.length === 0, 'TODAY_FETCH_MISSING', '今日存在缺失店铺明细文件', {missing: todayAll.missing});
}

async function auditDashboardReport(audit, month) {
  const report = await readJson(path.join(REPORT_DIR, `main-dashboard-v3-${month}.json`), null);
  audit.check(!!report, 'error', 'MAIN_DASHBOARD_REPORT_MISSING', '缺少主看板最新本地报告', {month});
  if (!report) return;
  const rows = report.summary || [];
  const all = rows.find(r => r.scope === '全部');
  const dsy = rows.find(r => r.scope === 'DSY');
  const lgm = rows.find(r => r.scope === 'LGM');
  audit.check(!!all && !!dsy && !!lgm, 'error', 'MAIN_DASHBOARD_SCOPE_ROWS_MISSING', '主看板摘要缺少 全部/DSY/LGM 行', {rows});
  if (all && dsy && lgm) {
    audit.check(diff(moneyFromText(all.month), moneyFromText(dsy.month) + moneyFromText(lgm.month)) <= EPS, 'error', 'DASHBOARD_MONTH_SCOPE_MISMATCH', '主看板报告本月 ALL 不等于 DSY+LGM', {all, dsy, lgm});
    audit.check(diff(moneyFromText(all.today), moneyFromText(dsy.today) + moneyFromText(lgm.today)) <= EPS, 'error', 'DASHBOARD_TODAY_SCOPE_MISMATCH', '主看板报告今日 ALL 不等于 DSY+LGM', {all, dsy, lgm});
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTransientLarkFailure(result) {
  const text = `${result.stderr || ''}\n${result.stdout || ''}`;
  return /EOF|HTTP 500|5000|OpenAPISearchRecord limited|tls|x509|certificate|not open\.feishu\.cn/i.test(text);
}

async function runLarkOnce(args) {
  return await new Promise(resolve => {
    const child = spawn('lark-cli', args, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('close', code => {
      let parsed = null;
      const text = stdout.trim();
      const starts = [text.indexOf('{'), text.indexOf('[')].filter(i => i >= 0);
      try { if (starts.length) parsed = JSON.parse(text.slice(Math.min(...starts))); } catch {}
      resolve({ok: code === 0, code, stdout, stderr, parsed});
    });
    child.on('error', err => resolve({ok: false, code: -1, stdout, stderr: String(err.stack || err)}));
  });
}

async function runLark(args, {retries = 3} = {}) {
  let last = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    last = await runLarkOnce(args);
    if (last.ok || !isTransientLarkFailure(last) || attempt === retries) return last;
    await sleep(800 * attempt);
  }
  return last;
}

async function auditLiveScopeTable(audit, state) {
  const baseToken = state.baseToken;
  const tableId = state.tables?.['看板数据-MAIN-范围汇总']?.table_id;
  if (!baseToken || !tableId) {
    audit.issues.push({severity: 'warn', code: 'LIVE_SCOPE_TABLE_SKIPPED', message: '未找到主看板范围汇总表，跳过云端 KPI 校验'});
    return;
  }
  const fields = ['范围', '今日SAR', 'KPI今日SAR', '月累计SAR', 'KPI月累计SAR', '预测业绩SAR', 'KPI预测业绩SAR', '预测利润RMB', 'KPI预测利润RMB'];
  const args = ['base', '+record-list', '--as', 'user', '--base-token', baseToken, '--table-id', tableId, '--limit', '20', '--format', 'json'];
  for (const f of fields) args.push('--field-id', f);
  const r = await runLark(args);
  audit.check(r.ok, 'error', 'LIVE_SCOPE_TABLE_READ_FAILED', '读取云端主看板范围汇总表失败', {stderr: r.stderr.slice(-1000), stdout: r.stdout.slice(-1000)});
  if (!r.ok) return;
  const rows = r.parsed?.data?.data || [];
  const mapped = rows.map(row => Object.fromEntries(fields.map((f, i) => [f, row[i]])));
  const all = mapped.find(r => r['范围'] === '全部');
  const sub = mapped.filter(r => r['范围'] !== '全部');
  audit.check(!!all && sub.length >= 2, 'error', 'LIVE_SCOPE_ROWS_BAD', '云端范围汇总表不是 全部+两个分组 的结构', {mapped});
  if (all) {
    for (const f of ['今日SAR', '月累计SAR', '预测业绩SAR', '预测利润RMB']) {
      audit.check(diff(Number(all[f] || 0), Number(all[`KPI${f}`] || 0)) <= EPS, 'error', 'LIVE_KPI_ALL_MISMATCH', `全部行 ${f} 与 KPI${f} 不一致`, {all});
    }
  }
  for (const row of sub) {
    for (const f of ['KPI今日SAR', 'KPI月累计SAR', 'KPI预测业绩SAR', 'KPI预测利润RMB']) {
      audit.check(Number(row[f] || 0) === 0, 'error', 'LIVE_KPI_SUBGROUP_NOT_ZERO', `分组行 ${f} 必须为 0，避免统计卡重复求和`, {row});
    }
  }
}

async function listLiveUniqueKeys(baseToken, tableId) {
  const rows = [];
  let offset = 0;
  while (true) {
    const r = await runLark([
      'base', '+record-list',
      '--as', 'user',
      '--base-token', baseToken,
      '--table-id', tableId,
      '--field-id', '唯一键',
      '--offset', String(offset),
      '--limit', '200',
      '--format', 'json',
    ]);
    if (!r.ok) return {ok: false, rows, stderr: r.stderr, stdout: r.stdout};
    const data = r.parsed?.data || {};
    const values = data.data || [];
    const ids = data.record_id_list || [];
    const fields = data.fields || [];
    const keyIndex = Math.max(0, fields.indexOf('唯一键'));
    for (let i = 0; i < values.length; i++) {
      const row = values[i];
      const rawKey = Array.isArray(row) ? row[keyIndex] : (row?.fields?.['唯一键'] ?? row?.['唯一键']);
      rows.push({recordId: ids[i] || row?.record_id || row?.id || null, key: String(rawKey ?? '').trim()});
    }
    if (!data.has_more) break;
    offset += values.length || 200;
  }
  return {ok: true, rows};
}

function duplicateKeySummary(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!row.key) continue;
    if (!grouped.has(row.key)) grouped.set(row.key, []);
    grouped.get(row.key).push(row.recordId);
  }
  return [...grouped.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, ids]) => ({key, count: ids.length, recordIds: ids}));
}

async function auditLiveUniqueKeys(audit, state, month) {
  const baseToken = state.baseToken;
  const checks = [
    {name: '店铺日报事实', tableId: state.tables?.['店铺日报事实']?.table_id},
    {name: `月度日销-${month}`, tableId: state.tables?.[`月度日销-${month}`]?.table_id},
  ].filter(x => x.tableId);
  for (const check of checks) {
    const result = await listLiveUniqueKeys(baseToken, check.tableId);
    audit.check(result.ok, 'error', 'LIVE_UNIQUE_KEY_READ_FAILED', `读取 ${check.name} 唯一键失败`, {tableId: check.tableId, stderr: result.stderr?.slice(-1000), stdout: result.stdout?.slice(-1000)});
    if (!result.ok) continue;
    const duplicates = duplicateKeySummary(result.rows);
    audit.check(duplicates.length === 0, 'error', 'LIVE_UNIQUE_KEY_DUPLICATE', `${check.name} 存在重复唯一键，会导致月表/看板/日报口径不一致`, {tableId: check.tableId, duplicateCount: duplicates.length, samples: duplicates.slice(0, 20)});
  }
}

async function auditDashboardBlocks(audit, state) {
  const dashboardId = state.dashboards?.['SHEIN经营看板 v3-主看板']?.dashboard_id || 'blkFn3qHrwdsrJyX';
  const baseToken = state.baseToken;
  const blocks = state.dashboards?.['SHEIN经营看板 v3-主看板']?.blocks || [];
  const stats = blocks.filter(b => b.type === 'statistics' && !String(b.action || '').startsWith('deleted'));
  for (const b of stats) {
    const blockId = b.blockId || b.block_id || b.id;
    if (!blockId || !baseToken) continue;
    const r = await runLark(['base', '+dashboard-block-get', '--as', 'user', '--base-token', baseToken, '--dashboard-id', dashboardId, '--block-id', blockId]);
    audit.check(r.ok, 'error', 'DASHBOARD_BLOCK_READ_FAILED', '读取看板组件失败', {name: b.name, blockId, stderr: r.stderr.slice(-500)});
    if (!r.ok) continue;
    const block = r.parsed?.data?.block || r.parsed?.block || r.parsed?.data;
    const fields = (block?.data_config?.series || []).map(s => s?.field_name).filter(Boolean);
    audit.check(fields.length > 0 && fields.every(field => String(field || '').startsWith('KPI')), 'error', 'STAT_BLOCK_NOT_KPI', '顶部统计卡未全部使用 KPI 专用字段，存在重复求和风险', {name: block?.name || b.name, fields});
  }
}

async function auditScriptGuards(audit) {
  const files = {
    intraday: await fs.readFile(path.join(ROOT, 'scripts', 'scheduled_intraday_dsy.ps1'), 'utf8'),
    yesterday: await fs.readFile(path.join(ROOT, 'scripts', 'scheduled_yesterday_final_dsy.ps1'), 'utf8'),
    daily: await fs.readFile(path.join(ROOT, 'scripts', 'scheduled_daily_report_dsy.ps1'), 'utf8'),
    watchdogPs: await fs.readFile(path.join(ROOT, 'scripts', 'scheduled_watchdog_dsy.ps1'), 'utf8'),
    watchdog: await fs.readFile(path.join(ROOT, 'scripts', 'watchdog_sales_automation.mjs'), 'utf8'),
    dashboard: await fs.readFile(path.join(ROOT, 'scripts', 'setup_lark_dashboard_main_v3.mjs'), 'utf8'),
  };
  for (const [name, text] of Object.entries({intraday: files.intraday, yesterday: files.yesterday})) {
    audit.check(text.includes('--no-monthly --no-compact-display --no-dashboard'), 'error', 'SCHEDULED_GROUP_RUN_REFRESHES_DERIVED', `${name} 分组抓取必须先禁用派生刷新`, {});
    audit.check(text.includes('generate_monthly_sales_table.mjs') && text.includes('--include-lgm'), 'error', 'SCHEDULED_MISSING_UNIFIED_MONTHLY_REFRESH', `${name} 缺少两组成功后的统一月表刷新`, {});
    audit.check(text.includes('generate_compact_display_tables.mjs') && text.includes('--group ALL'), 'error', 'SCHEDULED_MISSING_UNIFIED_COMPACT_REFRESH', `${name} 缺少两组成功后的统一年度/宽表刷新`, {});
  }
  audit.check(files.watchdogPs.includes('generate_monthly_sales_table.mjs') && files.watchdogPs.includes('--include-lgm'), 'error', 'WATCHDOG_WRAPPER_MISSING_UNIFIED_MONTHLY_REFRESH', 'watchdog 包装脚本缺少两组成功后的统一月表刷新', {});
  audit.check(files.watchdogPs.includes('generate_compact_display_tables.mjs') && files.watchdogPs.includes('--group ALL'), 'error', 'WATCHDOG_WRAPPER_MISSING_UNIFIED_COMPACT_REFRESH', 'watchdog 包装脚本缺少两组成功后的统一年度/宽表刷新', {});
  audit.check(!files.daily.includes('--sync-today'), 'error', 'DAILY_REPORT_SHOULD_NOT_RUN_HEAVY_SYNC', '定时日报应使用早上同步后的数据，不应在发送前再跑完整同步', {});
  audit.check(!files.daily.includes('generate_compact_display_tables.mjs'), 'error', 'DAILY_REPORT_SHOULD_NOT_REFRESH_COMPACT', '定时日报不应在发送前刷新年度/周月宽表，避免长时间卡住', {});
  audit.check(files.watchdog.includes('--no-monthly') && files.watchdog.includes('--no-compact-display') && files.watchdog.includes('--no-dashboard'), 'error', 'WATCHDOG_GROUP_REFRESH_RISK', 'watchdog 分组补跑不应单组刷新看板/派生表', {});
  const statLines = files.dashboard.split(/\r?\n/).filter(l => l.includes('statisticBlock(') && !l.includes('function statisticBlock'));
  for (const line of statLines) {
    audit.check(line.includes("'KPI") || line.includes('"KPI'), 'error', 'DASHBOARD_SOURCE_STAT_NOT_KPI', '源码中的统计卡未使用 KPI 字段', {line: line.trim()});
  }
  audit.check(files.dashboard.includes("field_name: '\\u8303\\u56f4'") || files.dashboard.includes("field_name: '范围'"), 'error', 'DASHBOARD_TREND_NO_SCOPE_GROUP', '趋势图必须按范围分组，否则会重复展示/求和', {});
}

async function auditReportConfig(audit, cfg) {
  const reportCfg = await readJson(REPORT_CFG_PATH, {});
  const groups = reportCfg.reportGroups || [];
  audit.check(JSON.stringify(groups) === JSON.stringify(['DSY', 'LGM']), 'error', 'REPORT_GROUPS_NOT_15_STORE', '日报应按 DSY/LGM 两组汇总，不能包含 ALL 或漏组', {reportGroups: groups});
  const seenStores = groups.flatMap(g => groupStoreKeys(cfg, g));
  audit.check(seenStores.length === uniq(seenStores).length, 'error', 'REPORT_GROUP_STORE_DUPLICATE', '日报分组包含重复店铺，会导致总额重复', {seenStores});
}

const args = parseArgs(process.argv.slice(2));
const date = args.date || beijingDate();
const month = args.month || date.slice(0, 7);
const audit = makeAudit();
const cfg = await readJson(STORES_PATH);
const state = await readJson(STATE_PATH, {});

await auditStoreConfig(audit, cfg);
await auditReportConfig(audit, cfg);
await auditLocalTotals(audit, cfg, month, date);
await auditDashboardReport(audit, month);
await auditScriptGuards(audit);
if (args.online) {
  await auditLiveScopeTable(audit, state);
  await auditLiveUniqueKeys(audit, state, month);
  await auditDashboardBlocks(audit, state);
}

const errors = audit.issues.filter(i => i.severity === 'error');
const warnings = audit.issues.filter(i => i.severity === 'warn');
const result = {
  ok: errors.length === 0,
  date,
  month,
  checkedAt: new Date().toISOString(),
  issueCount: audit.issues.length,
  errorCount: errors.length,
  warningCount: warnings.length,
  issues: audit.issues,
};
await fs.mkdir(REPORT_DIR, {recursive: true});
const file = path.join(REPORT_DIR, `sales-logic-audit-${date}.json`);
await fs.writeFile(file, JSON.stringify(result, null, 2), 'utf8');
console.log(JSON.stringify({...result, reportFile: path.relative(ROOT, file)}, null, 2));
if (!result.ok) process.exitCode = 1;
