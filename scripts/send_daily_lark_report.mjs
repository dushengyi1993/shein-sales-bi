#!/usr/bin/env node
/**
 * Build and optionally send the daily SHEIN performance report through Lark.
 *
 * The scheduled mode should run a fresh intraday sync first, then send:
 *   node scripts/send_daily_lark_report.mjs --sync-today --send
 *
 * Preview without sending:
 *   node scripts/send_daily_lark_report.mjs --dry-run
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {normalizeGoodsSn} from '../lib/product_sku_normalizer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORES_PATH = path.join(ROOT, 'config', 'stores.json');
const REPORT_CONFIG_PATH = path.join(ROOT, 'config', 'lark_report.json');
const STATE_PATH = path.join(ROOT, 'state', 'lark_base.json');
const FETCH_DIR = path.join(ROOT, 'outputs', 'shein_fetch');
const PAYLOAD_DIR = path.join(ROOT, 'outputs', 'lark_payloads');
const REPORT_DIR = path.join(ROOT, 'outputs', 'reports');
const FEISHU_BASE_PAUSE_FLAG = path.join(ROOT, 'state', 'feishu-base-sync-paused.flag');
const FX_SAR_TO_RMB = 1.8;

function envTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const args = {
    group: null,
    syncToday: false,
    send: false,
    dryRun: false,
    visual: false,
    monthlyVisual: null,
    monthlyVisualMonth: null,
    as: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--group') args.group = argv[++i].toUpperCase();
    else if (a === '--groups') args.groups = argv[++i].split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--date') args.today = argv[++i];
    else if (a === '--recipient-user-id') args.recipientUserId = argv[++i];
    else if (a === '--as') args.as = argv[++i];
    else if (a === '--idempotency-key') args.idempotencyKey = argv[++i];
    else if (a === '--sync-today') args.syncToday = true;
    else if (a === '--send') args.send = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--visual') args.visual = true;
    else if (a === '--monthly-visual') args.monthlyVisual = true;
    else if (a === '--no-monthly-visual') args.monthlyVisual = false;
    else if (a === '--monthly-visual-month') args.monthlyVisualMonth = argv[++i];
  }
  return args;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function beijingDate(offsetDays = 0) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date()).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  const d = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function localDateTimeString(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function latestFetchTimeText(dayData) {
  const latest = (dayData.rows || [])
    .map(r => r.fetchTime ? new Date(r.fetchTime) : null)
    .filter(d => d && Number.isFinite(d.getTime()))
    .sort((a, b) => b - a)[0];
  return latest ? localDateTimeString(latest) : '未找到';
}

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

function parseFirstJson(stdout) {
  const text = String(stdout || '').trim();
  const starts = [text.indexOf('{'), text.indexOf('[')].filter(i => i >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  if (start < 0) throw new Error(`No JSON in command output: ${text.slice(0, 500)}`);
  return JSON.parse(text.slice(start));
}

function runNode(script, args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('close', code => resolve({ok: code === 0, code, stdout, stderr}));
    child.on('error', err => resolve({ok: false, code: -1, stdout, stderr: String(err.stack || err)}));
  });
}

function parseJsonLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('{') && line.endsWith('}'))
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function summarizeSyncFailure(item, groupKey) {
  const parsedLines = parseJsonLines(item.stdout);
  const storeErrors = parsedLines
    .filter(row => row.storeKey && row.error)
    .map(row => {
      let reason = String(row.error || '').replace(/\s+/g, ' ');
      if (reason.includes('子系统登录重定向')) reason = '子系统登录重定向，需要重新登录 SHEIN 店铺后台';
      reason = reason.slice(0, 160);
      return `${row.storeKey}：${reason}`;
    });
  if (storeErrors.length) return `${groupKey} 当天最新同步失败：${storeErrors.join('；')}。日报将继续按已落表数据发送。`;
  const finalLine = [...parsedLines].reverse().find(row => row.finalStatus || row.logFile);
  if (finalLine?.logFile) return `${groupKey} 当天最新同步失败，详见 ${finalLine.logFile}。日报将继续按已落表数据发送。`;
  const detail = (item.stderr || item.stdout || '').replace(/\s+/g, ' ').slice(-240);
  return `${groupKey} 当天最新同步失败，今日数据可能不是最新。${detail ? `原因摘要：${detail}` : ''}`;
}

async function writePayload(name, obj) {
  await fs.mkdir(PAYLOAD_DIR, {recursive: true});
  const safe = name.replace(/[^a-z0-9._-]+/gi, '-');
  const file = path.join(PAYLOAD_DIR, `${Date.now()}-${safe}.json`);
  await fs.writeFile(file, JSON.stringify(obj, null, 2), 'utf8');
  return file;
}

async function runLark(args, payloadName = null, payload = null) {
  const finalArgs = [...args];
  if (payload) {
    const payloadFile = await writePayload(payloadName || 'payload', payload);
    finalArgs.push('--json', `@${path.relative(ROOT, payloadFile).replace(/\\/g, '/')}`);
  }
  return await new Promise((resolve, reject) => {
    const child = spawn('lark-cli', finalArgs, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', reject);
    child.on('close', code => {
      let parsed = null;
      try { parsed = parseFirstJson(stdout); } catch {}
      if (code !== 0) reject(new Error(parsed?.error?.message || stderr || stdout || `lark-cli exited ${code}`));
      else resolve({stdout, stderr, parsed});
    });
  });
}

async function loadJsonIfExists(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

function selectedStores(storesConfig, group) {
  const keys = storesConfig.groups?.[group] || [];
  return keys.map(key => storesConfig.stores.find(s => s.storeKey === key)).filter(Boolean);
}

function selectedReportGroups(storesConfig, args, reportConfig) {
  const configured = args.groups || reportConfig.reportGroups || [args.group];
  const seen = new Set();
  const groups = [];
  for (const key of configured.map(s => String(s).toUpperCase()).filter(Boolean)) {
    if (seen.has(key)) continue;
    if (!Array.isArray(storesConfig.groups?.[key])) continue;
    seen.add(key);
    groups.push(key);
  }
  if (!groups.length) throw new Error('No report groups configured.');
  return groups;
}

async function loadStoreDay(store, date) {
  const file = path.join(FETCH_DIR, store.storeKey, `${date}.json`);
  const obj = await loadJsonIfExists(file);
  const summary = obj?.summary || {};
  return {
    storeKey: store.storeKey,
    shopName: store.shopName,
    groupKey: store.groupKey,
    salesSar: round2(summary.salesSar || 0),
    salesRmb: round2((summary.salesSar || 0) * FX_SAR_TO_RMB),
    orders: Number(summary.positiveAmountOrderCount || 0),
    goods: Number(summary.goodsLineCount || 0),
    qty: Number(summary.quantityPositiveAmount || 0),
    missing: !obj?.summary,
    fetchTime: obj?.fetchTime || null,
  };
}

async function loadGroupDay(stores, date) {
  const rows = [];
  for (const store of stores) rows.push(await loadStoreDay(store, date));
  const totalSar = round2(rows.reduce((s, r) => s + r.salesSar, 0));
  return {
    date,
    rows,
    totalSar,
    totalRmb: round2(totalSar * FX_SAR_TO_RMB),
    orders: rows.reduce((s, r) => s + r.orders, 0),
    qty: rows.reduce((s, r) => s + r.qty, 0),
    missingStores: rows.filter(r => r.missing).map(r => r.storeKey),
    rankedStores: [...rows].sort((a, b) =>
      b.salesSar - a.salesSar ||
      b.orders - a.orders ||
      b.qty - a.qty ||
      a.storeKey.localeCompare(b.storeKey)
    ),
  };
}

async function loadReportDay(storesConfig, groupKeys, date) {
  const groups = [];
  for (const groupKey of groupKeys) {
    const data = await loadGroupDay(selectedStores(storesConfig, groupKey), date);
    groups.push({groupKey, ...data});
  }
  const rows = groups.flatMap(g => g.rows);
  const totalSar = round2(groups.reduce((s, g) => s + g.totalSar, 0));
  return {
    date,
    groups,
    rows,
    totalSar,
    totalRmb: round2(totalSar * FX_SAR_TO_RMB),
    orders: groups.reduce((s, g) => s + g.orders, 0),
    qty: groups.reduce((s, g) => s + g.qty, 0),
    missingStores: groups.flatMap(g => g.missingStores.map(storeKey => `${g.groupKey}:${storeKey}`)),
    rankedStores: [...rows].sort((a, b) =>
      b.salesSar - a.salesSar ||
      b.orders - a.orders ||
      b.qty - a.qty ||
      a.storeKey.localeCompare(b.storeKey)
    ),
  };
}

function monthDates(month) {
  const [y, m] = month.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({length: days}, (_, i) => `${month}-${pad2(i + 1)}`);
}

function previousMonth(date) {
  const d = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

function shouldBuildMonthlyVisual(args, today) {
  if (args.monthlyVisual === false) return false;
  if (args.monthlyVisual === true) return true;
  return args.visual && today.endsWith('-01');
}

async function loadTopProductsFromFetch(storesConfig, groupKeys, date, limit = 5) {
  const month = date.slice(0, 7);
  const stores = groupKeys.flatMap(groupKey => selectedStores(storesConfig, groupKey)).filter(s => s.productStatsEnabled !== false);
  const byProduct = new Map();
  for (const store of stores) {
    for (const day of monthDates(month)) {
      const obj = await loadJsonIfExists(path.join(FETCH_DIR, store.storeKey, `${day}.json`));
      for (const g of obj?.goodsRows || []) {
        const rawGoodsSn = String(g.goodsSn || g.skuSn || g.skuCode || g.skcName || '').trim();
        const goodsSn = normalizeGoodsSn(rawGoodsSn, {goodsTitle: g.goodsTitle});
        const qty = Number(g.number || 0);
        const sar = Number(g.currencyPrice || 0);
        if (!goodsSn || qty <= 0 || sar <= 0) continue;
        if (!byProduct.has(goodsSn)) byProduct.set(goodsSn, {goodsSn, goodsTitle: String(g.goodsTitle || '').slice(0, 500), totalQty: 0, totalSar: 0});
        const row = byProduct.get(goodsSn);
        row.totalQty += qty;
        row.totalSar = round2(row.totalSar + sar);
        if (!row.goodsTitle && g.goodsTitle) row.goodsTitle = String(g.goodsTitle).slice(0, 500);
      }
    }
  }
  return [...byProduct.values()]
    .sort((a, b) => b.totalQty - a.totalQty || b.totalSar - a.totalSar || a.goodsSn.localeCompare(b.goodsSn, 'zh-CN'))
    .slice(0, limit);
}

function formatMoney(n) {
  return Number(n || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
}

function formatStoreList(rows, showGroup = false) {
  if (!rows.length) return '暂无店铺数据';
  return rows.map((r, i) => {
    const missing = r.missing ? '，明细缺失' : '';
    const group = showGroup && r.groupKey ? `${r.groupKey}/` : '';
    return `${i + 1}. ${group}${r.storeKey} ${formatMoney(r.salesSar)} SAR（订单 ${r.orders}，销量 ${r.qty}${missing}）`;
  }).join('\n');
}

function formatProductList(rows) {
  if (!rows.length) return '暂无产品销量数据';
  return rows.map((r, i) => `${i + 1}. ${r.goodsSn}：${r.totalQty} 件，${formatMoney(r.totalSar)} SAR`).join('\n');
}

function formatGroupSummary(dayData) {
  if (!dayData.groups || dayData.groups.length <= 1) return '';
  return dayData.groups.map(g =>
    `${g.groupKey}小计：${formatMoney(g.totalSar)} SAR / ${formatMoney(g.totalRmb)} RMB（订单 ${g.orders}，销量 ${g.qty}）`
  ).join('\n');
}

function formatMissingStores(dayData, showGroup = false) {
  return dayData.rows
    .filter(r => r.missing)
    .map(r => showGroup && r.groupKey ? `${r.groupKey}:${r.storeKey}` : r.storeKey)
    .join(', ');
}

function buildMessage({groupLabel, today, yesterday, todayData, yesterdayData, topProducts, baseUrl, syncWarning = ''}) {
  const generatedAt = localDateTimeString();
  const todayFetchAt = latestFetchTimeText(todayData);
  const yesterdayFetchAt = latestFetchTimeText(yesterdayData);
  const multiGroup = (todayData.groups?.length || 0) > 1 || (yesterdayData.groups?.length || 0) > 1;
  const yesterdayMissing = formatMissingStores(yesterdayData, multiGroup);
  const todayMissing = formatMissingStores(todayData, multiGroup);
  const missingNote = [
    yesterdayMissing ? `昨日缺少明细：${yesterdayMissing}` : '',
    todayMissing ? `今日缺少明细：${todayMissing}` : '',
  ].filter(Boolean).join('\n');
  const yesterdayGroupSummary = formatGroupSummary(yesterdayData);
  const todayGroupSummary = formatGroupSummary(todayData);
  return [
    `SHEIN ${groupLabel} 业绩简报`,
    `生成时间：${generatedAt}（北京时间）`,
    `今日数据抓取时间：${todayFetchAt}（北京时间）`,
    `昨日数据抓取时间：${yesterdayFetchAt}（北京时间）`,
    '',
    `【昨日完整业绩｜${yesterday}】`,
    `${multiGroup ? '全部店销售额' : '销售额'}：${formatMoney(yesterdayData.totalSar)} SAR / ${formatMoney(yesterdayData.totalRmb)} RMB`,
    `${multiGroup ? '全部店有效订单' : '有效订单'}：${yesterdayData.orders}，产品销量：${yesterdayData.qty}`,
    yesterdayGroupSummary ? `分组汇总：\n${yesterdayGroupSummary}` : '',
    '店铺排行：',
    formatStoreList(yesterdayData.rankedStores, multiGroup),
    '',
    `【今日最新业绩｜${today}】`,
    `${multiGroup ? '全部店销售额' : '销售额'}：${formatMoney(todayData.totalSar)} SAR / ${formatMoney(todayData.totalRmb)} RMB`,
    `${multiGroup ? '全部店有效订单' : '有效订单'}：${todayData.orders}，产品销量：${todayData.qty}`,
    todayGroupSummary ? `分组汇总：\n${todayGroupSummary}` : '',
    '店铺排行：',
    formatStoreList(todayData.rankedStores, multiGroup),
    '',
    '【本月热卖产品 Top 5】',
    formatProductList(topProducts),
    '',
    syncWarning ? `【同步提醒】\n${syncWarning}\n` : '',
    missingNote ? `【注意】\n${missingNote}\n` : '',
    `多维表格：${baseUrl}`,
  ].filter(Boolean).join('\n');
}

async function findReportRecord(baseToken, tableId, uniqueKey) {
  const resp = await runLark([
    'base', '+record-search',
    '--as', 'user',
    '--base-token', baseToken,
    '--table-id', tableId,
  ], `daily-report-search-${uniqueKey}`, {
    keyword: uniqueKey,
    search_fields: ['唯一键'],
    select_fields: ['唯一键'],
    offset: 0,
    limit: 10,
  });
  return resp.parsed?.data?.record_id_list?.[0] || null;
}

async function upsertReportLog({baseToken, tableId, uniqueKey, sentAt, yesterday, yesterdaySar, todaySar, status, summary, note}) {
  const record = {
    '唯一键': uniqueKey,
    '发送时间': sentAt,
    '昨日日期': `${yesterday} 00:00:00`,
    '昨日总计SAR': round2(yesterdaySar),
    '今日截至SAR': round2(todaySar),
    '发送状态': status,
    '消息摘要': summary.slice(0, 1000),
    '备注': note || '',
  };
  const recordId = await findReportRecord(baseToken, tableId, uniqueKey);
  const cmd = [
    'base', '+record-upsert',
    '--as', 'user',
    '--base-token', baseToken,
    '--table-id', tableId,
  ];
  if (recordId) cmd.push('--record-id', recordId);
  const resp = await runLark(cmd, `daily-report-log-${uniqueKey}`, record);
  return {recordId: recordId || resp.parsed?.data?.record?.record_id || resp.parsed?.record?.record_id || null};
}

const args = parseArgs(process.argv.slice(2));
const storesConfig = JSON.parse(await fs.readFile(STORES_PATH, 'utf8'));
const reportConfig = await loadJsonIfExists(REPORT_CONFIG_PATH) || {};
const state = JSON.parse(await fs.readFile(STATE_PATH, 'utf8'));
const feishuBasePaused = envTruthy(process.env.SHEIN_FEISHU_BASE_PAUSED)
  || await fileExists(FEISHU_BASE_PAUSE_FLAG);
args.as = args.as || reportConfig.defaultIdentity || 'user';
args.group = args.group || 'DSY';
if (!['user', 'bot'].includes(args.as)) {
  throw new Error(`Invalid report identity: ${args.as}. Expected user or bot.`);
}
const today = args.today || beijingDate(0);
const yesterday = (() => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
})();

const recipientUserId = args.recipientUserId || reportConfig.recipientUserId;
if ((args.send || args.dryRun) && !recipientUserId) {
  throw new Error('Missing recipient user id. Set config/lark_report.json recipientUserId or pass --recipient-user-id.');
}

let syncResult = null;
let syncWarning = '';
let syncDashboardRefresh = null;
const reportGroups = selectedReportGroups(storesConfig, args, reportConfig);
const groupLabel = reportGroups.join('/');
if (args.syncToday) {
  const syncResults = [];
  for (const groupKey of reportGroups) {
    const syncArgs = ['--mode', 'intraday', '--group', groupKey, '--no-monthly', '--no-compact-display', '--no-dashboard'];
    if (feishuBasePaused) syncArgs.push('--no-lark-base', '--no-products');
    const configuredStores = reportConfig.syncStoresByGroup?.[groupKey];
    if (Array.isArray(configuredStores) && configuredStores.length) {
      syncArgs.push('--stores', configuredStores.join(','));
    }
    const item = await runNode('run_sales_sync_job.mjs', syncArgs);
    syncResults.push({groupKey, ...item});
    if (!item.ok) {
      syncWarning += `${summarizeSyncFailure(item, groupKey)}\n`;
    }
  }
  syncResult = {ok: syncResults.every(r => r.ok), results: syncResults};
  if (!syncResult.ok) {
    throw new Error(`今日同步未成功，日报已停止发送，避免使用旧数据。请先处理同步失败：\n${syncWarning.trim()}`);
  }
  const month = today.slice(0, 7);
  // 日报前置同步只做轻量刷新：抓取/事实表/产品日事实 + 主看板。
  // 月表、年度汇总、周/月宽表由定时同步统一刷新，不放在日报发送前，避免日报长时间卡住。
  if (feishuBasePaused) {
    syncDashboardRefresh = {ok: true, skipped: true, reason: 'feishu_base_paused'};
  } else {
    const dashboard = await runNode('setup_lark_dashboard_main_v3.mjs', ['--month', month]);
    syncDashboardRefresh = {
      ok: dashboard.ok,
      code: dashboard.code,
      parsed: dashboard.ok ? parseFirstJson(dashboard.stdout) : null,
      stdoutTail: dashboard.stdout.slice(-2000),
      stderrTail: dashboard.stderr.slice(-2000),
    };
    if (!dashboard.ok) {
      throw new Error(`今日同步已成功，但主看板刷新失败，日报已停止发送以避免看板/日报口径不一致：${dashboard.stderr || dashboard.stdout}`);
    }
  }
}

const yesterdayData = await loadReportDay(storesConfig, reportGroups, yesterday);
const todayData = await loadReportDay(storesConfig, reportGroups, today);
const topProducts = await loadTopProductsFromFetch(storesConfig, reportGroups, today, 5);
const baseUrl = state.baseCreateResponse?.data?.base?.url || `https://zcnm3ts63aph.feishu.cn/base/${state.baseToken}`;
const message = buildMessage({groupLabel, today, yesterday, todayData, yesterdayData, topProducts, baseUrl, syncWarning: syncWarning.trim()});

await fs.mkdir(REPORT_DIR, {recursive: true});
const localReportFile = path.join(REPORT_DIR, `daily-lark-report-${today}.txt`);
await fs.writeFile(localReportFile, message, 'utf8');

let visualResult = null;
if (args.visual) {
  const image = await runNode('generate_daily_report_image.mjs', ['--date', today, '--groups', reportGroups.join(',')]);
  visualResult = {ok: image.ok, stdout: image.stdout, stderr: image.stderr, parsed: image.ok ? parseFirstJson(image.stdout) : null};
  if (!image.ok) throw new Error(`Generate daily visual report failed: ${image.stderr || image.stdout}`);
}

let monthlyVisualResult = null;
if (shouldBuildMonthlyVisual(args, today)) {
  const month = args.monthlyVisualMonth || previousMonth(today);
  const image = await runNode('generate_monthly_report_image.mjs', ['--month', month, '--groups', reportGroups.join(',')]);
  monthlyVisualResult = {ok: image.ok, stdout: image.stdout, stderr: image.stderr, parsed: image.ok ? parseFirstJson(image.stdout) : null};
  if (!image.ok) throw new Error(`Generate monthly visual report failed: ${image.stderr || image.stdout}`);
}

let sendResult = null;
if (args.send || args.dryRun) {
  const cmd = [
    'im', '+messages-send',
    '--as', args.as,
    '--user-id', recipientUserId,
    '--text', message,
    '--idempotency-key', args.idempotencyKey || `sr-${today.replaceAll('-', '')}-${groupLabel.replaceAll('/', '')}`,
  ];
  if (args.dryRun && !args.send) cmd.push('--dry-run');
  sendResult = await runLark(cmd);
  if (args.visual && visualResult?.parsed?.png) {
    const relImage = path.relative(ROOT, visualResult.parsed.png).replace(/\\/g, '/');
    const imageCmd = [
      'im', '+messages-send',
      '--as', args.as,
      '--user-id', recipientUserId,
      '--image', relImage,
      '--idempotency-key', `${args.idempotencyKey || `sr-${today.replaceAll('-', '')}-${groupLabel.replaceAll('/', '')}`}-img`,
    ];
    if (args.dryRun && !args.send) imageCmd.push('--dry-run');
    await runLark(imageCmd);
  }
  if (monthlyVisualResult?.parsed?.png) {
    const relImage = path.relative(ROOT, monthlyVisualResult.parsed.png).replace(/\\/g, '/');
    const month = monthlyVisualResult.parsed.month || args.monthlyVisualMonth || previousMonth(today);
    const imageCmd = [
      'im', '+messages-send',
      '--as', args.as,
      '--user-id', recipientUserId,
      '--image', relImage,
      '--idempotency-key', `${args.idempotencyKey || `sr-${today.replaceAll('-', '')}-${groupLabel.replaceAll('/', '')}`}-month-${month.replaceAll('-', '')}-img`,
    ];
    if (args.dryRun && !args.send) imageCmd.push('--dry-run');
    await runLark(imageCmd);
  }
}

let reportLog = null;
if (args.send && !feishuBasePaused && state.tables?.['飞书日报记录']?.table_id) {
  reportLog = await upsertReportLog({
    baseToken: state.baseToken,
    tableId: state.tables['飞书日报记录'].table_id,
    uniqueKey: `daily-report__${today}__${groupLabel.replaceAll('/', '-')}`,
    sentAt: localDateTimeString(),
    yesterday,
    yesterdaySar: yesterdayData.totalSar,
    todaySar: todayData.totalSar,
    status: '成功',
    summary: message,
    note: `recipient=${recipientUserId}; identity=${args.as}${syncWarning ? '; syncWarning=true' : ''}`,
  });
}

console.log(JSON.stringify({
  ok: true,
  mode: args.send ? 'send' : (args.dryRun ? 'dry-run' : 'build-only'),
  group: args.group,
  reportGroups,
  today,
  yesterday,
  recipientUserId: recipientUserId ? `${recipientUserId.slice(0, 6)}...` : null,
  syncToday: args.syncToday,
  feishuBasePaused,
  syncOk: syncResult ? syncResult.ok : null,
  syncDashboardOk: syncDashboardRefresh ? syncDashboardRefresh.ok : null,
  syncDashboardSkipped: !!syncDashboardRefresh?.skipped,
  syncWarning: syncWarning.trim() || null,
  yesterdayTotalSar: yesterdayData.totalSar,
  todayTotalSar: todayData.totalSar,
  topProductCount: topProducts.length,
  visual: args.visual,
  visualFile: visualResult?.parsed?.png ? path.relative(ROOT, visualResult.parsed.png) : null,
  monthlyVisual: Boolean(monthlyVisualResult),
  monthlyVisualMonth: monthlyVisualResult?.parsed?.month || null,
  monthlyVisualFile: monthlyVisualResult?.parsed?.png ? path.relative(ROOT, monthlyVisualResult.parsed.png) : null,
  localReportFile: path.relative(ROOT, localReportFile),
  sendDryRun: args.dryRun && !args.send,
  sendOk: sendResult ? true : null,
  reportLog,
  reportLogSkipped: args.send && feishuBasePaused,
}, null, 2));
