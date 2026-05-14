#!/usr/bin/env node
/**
 * Build or refresh a stable Lark Doc "ops dashboard" for SHEIN sales.
 *
 * Why this exists:
 * Lark Base Dashboard blocks may be created successfully by API while the
 * Feishu frontend still reports "配置数据发生变更，请重新配置". This script uses a
 * normal Lark Doc as the durable dashboard surface and links back to Base.
 *
 * Usage:
 *   node scripts/generate_lark_ops_report_doc.mjs --group DSY --month 2026-04 --create
 *   node scripts/generate_lark_ops_report_doc.mjs --group DSY --month 2026-04 --update
 *   node scripts/generate_lark_ops_report_doc.mjs --group DSY --month 2026-04 --dry-run
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {summarizeSalesGoodsRows} from '../lib/shein_sales_validity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_PATH = path.join(ROOT, 'state', 'lark_base.json');
const DOC_STATE_PATH = path.join(ROOT, 'state', 'lark_ops_dashboard_doc.json');
const STORES_PATH = path.join(ROOT, 'config', 'stores.json');
const FETCH_DIR = path.join(ROOT, 'outputs', 'shein_fetch');
const REPORT_DIR = path.join(ROOT, 'outputs', 'reports');
const FX_SAR_TO_RMB = 1.8;

function parseArgs(argv) {
  const args = {
    group: 'DSY',
    month: null,
    create: false,
    update: false,
    dryRun: false,
    as: 'user',
    title: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--group') args.group = argv[++i].toUpperCase();
    else if (a === '--month') args.month = argv[++i];
    else if (a === '--as') args.as = argv[++i];
    else if (a === '--title') args.title = argv[++i];
    else if (a === '--create') args.create = true;
    else if (a === '--update') args.update = true;
    else if (a === '--dry-run') args.dryRun = true;
  }
  if (!args.create && !args.update && !args.dryRun) args.update = true;
  return args;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function beijingParts(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
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
}

function beijingDate(offsetDays = 0) {
  const p = beijingParts();
  const d = new Date(`${p.year}-${p.month}-${p.day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function beijingNowString() {
  const p = beijingParts();
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

function monthOf(date) {
  return date.slice(0, 7);
}

function addDays(date, delta) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

function fmt(n, digits = 2) {
  return Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtInt(n) {
  return Number(n || 0).toLocaleString('en-US', {maximumFractionDigits: 0});
}

function pct(n) {
  return `${round2(n)}%`;
}

function bar(value, max, width = 18) {
  if (!max || max <= 0 || !value) return '░'.repeat(width);
  const filled = Math.max(0, Math.round((value / max) * width));
  return '█'.repeat(Math.min(width, filled)) + '░'.repeat(Math.max(0, width - filled));
}

function parseFirstJson(stdout) {
  const text = String(stdout || '').trim();
  const starts = [text.indexOf('{'), text.indexOf('[')].filter(i => i >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  if (start < 0) throw new Error(`No JSON in command output: ${text.slice(0, 500)}`);
  return JSON.parse(text.slice(start));
}

async function loadJsonIfExists(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

async function saveJson(file, obj) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', reject);
    child.on('close', code => resolve({code, ok: code === 0, stdout, stderr}));
  });
}

async function runLark(args) {
  const result = await run('lark-cli', args);
  let parsed = null;
  try { parsed = parseFirstJson(result.stdout); } catch {}
  if (!result.ok) {
    throw new Error(parsed?.error?.message || result.stderr || result.stdout || `lark-cli exited ${result.code}`);
  }
  return {...result, parsed};
}

function selectedStores(storesConfig, group) {
  const keys = storesConfig.groups?.[group] || [];
  return keys.map(key => storesConfig.stores.find(s => s.storeKey === key)).filter(Boolean);
}

async function loadStoreDay(store, date) {
  const file = path.join(FETCH_DIR, store.storeKey, `${date}.json`);
  const obj = await loadJsonIfExists(file);
  const summary = obj?.summary || {};
  const goodsSales = Array.isArray(obj?.goodsRows) ? summarizeSalesGoodsRows(obj.goodsRows) : null;
  const salesSar = goodsSales ? round2(goodsSales.salesSar) : round2(summary.salesSar || 0);
  const mtime = fssync.existsSync(file) ? fssync.statSync(file).mtime : null;
  return {
    storeKey: store.storeKey,
    shopName: store.shopName,
    groupKey: store.groupKey,
    date,
    salesSar,
    salesRmb: round2(salesSar * FX_SAR_TO_RMB),
    orders: Number(goodsSales?.positiveAmountOrderCount ?? summary.positiveAmountOrderCount ?? 0),
    qty: Number(goodsSales?.quantityPositiveAmount ?? summary.quantityPositiveAmount ?? 0),
    goodsLines: Number(summary.goodsLineCount || 0),
    missing: !obj?.summary,
    fetchTime: obj?.fetchTime || null,
    localMtime: mtime ? mtime.toISOString() : null,
  };
}

async function loadGroupDay(stores, date) {
  const rows = [];
  for (const store of stores) rows.push(await loadStoreDay(store, date));
  const totalSar = round2(rows.reduce((sum, r) => sum + r.salesSar, 0));
  const latestFetchTime = rows
    .map(r => r.fetchTime || r.localMtime)
    .filter(Boolean)
    .sort()
    .at(-1) || null;
  return {
    date,
    rows,
    totalSar,
    totalRmb: round2(totalSar * FX_SAR_TO_RMB),
    orders: rows.reduce((sum, r) => sum + r.orders, 0),
    qty: rows.reduce((sum, r) => sum + r.qty, 0),
    missingStores: rows.filter(r => r.missing).map(r => r.storeKey),
    latestFetchTime,
  };
}

async function loadMonthTrend(stores, month) {
  const trend = [];
  const today = beijingDate(0);
  const lastDay = month === monthOf(today) ? Number(today.slice(-2)) : daysInMonth(month);
  for (let day = 1; day <= lastDay; day++) {
    const date = `${month}-${pad2(day)}`;
    const dayData = await loadGroupDay(stores, date);
    trend.push(dayData);
  }
  return trend;
}

function historicalMonthlyRows(validation) {
  return (validation?.rows || []).map(r => ({
    month: r.month,
    salesSar: round2(r.storeTotalSar),
    productSar: round2(r.productTotalSar),
    diffSar: round2(r.diffSar),
    qty: Number(r.productQty || 0),
  }));
}

function table(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.map(cell => String(cell ?? '').replaceAll('\n', '<br>')).join(' | ')} |`),
  ].join('\n');
}

function markdownLink(label, url) {
  return `[${label}](${url})`;
}

function tableUrl(baseUrl, tableId) {
  return tableId ? `${baseUrl}?table=${tableId}` : baseUrl;
}

function getTableId(state, name) {
  return state.tables?.[name]?.table_id || null;
}

function buildMarkdown({
  title,
  group,
  month,
  baseUrl,
  state,
  monthly,
  product,
  validation,
  stores,
  yesterdayData,
  todayData,
  trend,
}) {
  const generatedAt = beijingNowString();
  const today = beijingDate(0);
  const yesterday = addDays(today, -1);
  const storeRows = (monthly?.rows || [])
    .filter(r => r.group === group && r.type === '店铺' && r.currency === 'SAR')
    .sort((a, b) => Number(b.total || 0) - Number(a.total || 0));
  const maxStore = Math.max(0, ...storeRows.map(r => Number(r.total || 0)));
  const productRows = (product?.topProducts || []).slice(0, 10);
  const maxProductQty = Math.max(0, ...productRows.map(r => Number(r.totalQty || 0)));
  const maxProductSar = Math.max(0, ...productRows.map(r => Number(r.totalSar || 0)));
  const maxDaily = Math.max(0, ...trend.map(d => Number(d.totalSar || 0)));
  const recentTrend = trend.slice(-14);
  const historyRows = historicalMonthlyRows(validation);

  const dashboardNotice = [
    '⚠️ 多维表格原生 Dashboard 目前已暂停作为交付入口：API 返回“创建成功”，但飞书前端仍提示配置变更，需要重新配置。',
    '本页改用更稳定的飞书文档承载经营看板，底层数据仍来自同一个多维表格事实表和展示表。',
  ].join(' ');

  const monthProgress = month === monthOf(today)
    ? `${Number(today.slice(-2))}/${daysInMonth(month)} 天`
    : `${daysInMonth(month)}/${daysInMonth(month)} 天`;
  const monthCompletionPct = month === monthOf(today)
    ? Number(today.slice(-2)) / daysInMonth(month) * 100
    : 100;

  const links = [
    ['多维表格首页', markdownLink('打开', baseUrl)],
    [`月度日销-${month}`, markdownLink('打开', tableUrl(baseUrl, getTableId(state, `月度日销-${month}`) || getTableId(state, `月度日销-${month.slice(0, 4)}汇总`)))],
    [`产品日销量-${month}`, markdownLink('打开', tableUrl(baseUrl, getTableId(state, `产品日销量-${month}`) || getTableId(state, `产品日销量-${month.slice(0, 4)}汇总`)))],
    ['产品月销量-宽表', markdownLink('打开', tableUrl(baseUrl, getTableId(state, '产品月销量-宽表')))],
    ['产品周销量-宽表', markdownLink('打开', tableUrl(baseUrl, getTableId(state, '产品周销量-宽表')))],
  ];

  return [
    `# ${title}`,
    '',
    `> 自动生成时间：${generatedAt}（北京时间）  `,
    `> 当前范围：${group} 组；统计月：${month}；口径：订单创建时间；汇率：1 SAR = 1.8 RMB；利润预测：25%。`,
    '',
    `> ${dashboardNotice}`,
    '',
    '## 1. 核心指标',
    '',
    table(
      ['指标', 'SAR', 'RMB', '说明'],
      [
        ['昨日完整业绩', fmt(yesterdayData.totalSar), fmt(yesterdayData.totalRmb), `${yesterday}；订单 ${fmtInt(yesterdayData.orders)}，销量 ${fmtInt(yesterdayData.qty)}`],
        ['今日最新业绩', fmt(todayData.totalSar), fmt(todayData.totalRmb), `${today}；订单 ${fmtInt(todayData.orders)}，销量 ${fmtInt(todayData.qty)}`],
        [`${month} 月累计`, fmt(monthly?.totals?.totalSar), fmt(monthly?.totals?.totalRmb), `进度 ${monthProgress}（${pct(monthCompletionPct)}）`],
        [`${month} 月日均`, fmt(monthly?.totals?.avgSar), fmt((monthly?.totals?.avgSar || 0) * FX_SAR_TO_RMB), `按已过自然日均值`],
        [`${month} 预测业绩`, fmt(monthly?.totals?.predictedSar), fmt(monthly?.totals?.predictedRmb), `日均 × 当月天数`],
        ['预测利润', '-', fmt(monthly?.totals?.predictedProfitRmb), '按 25% 利润率估算'],
      ],
    ),
    '',
    '## 2. 店铺月度排行',
    '',
    table(
      ['排名', '店铺', '月累计 SAR', '月日均 SAR', '占比', '可视条'],
      storeRows.map((r, idx) => [
        idx + 1,
        r.label,
        fmt(r.total),
        fmt(r.average),
        pct((Number(r.total || 0) / Number(monthly?.totals?.totalSar || 1)) * 100),
        bar(Number(r.total || 0), maxStore),
      ]),
    ),
    '',
    '## 3. 最近 14 天销售趋势',
    '',
    table(
      ['日期', '销售额 SAR', '订单', '销量', '趋势条'],
      recentTrend.map(d => [
        d.date,
        fmt(d.totalSar),
        fmtInt(d.orders),
        fmtInt(d.qty),
        bar(d.totalSar, maxDaily, 22),
      ]),
    ),
    '',
    '## 4. 本月热卖产品 Top 10',
    '',
    table(
      ['排名', '标准货号', '销量', '销售额 SAR', '销量条', '销售额条'],
      productRows.map((r, idx) => [
        idx + 1,
        r.goodsSn,
        fmtInt(r.totalQty),
        fmt(r.totalSar),
        bar(Number(r.totalQty || 0), maxProductQty, 14),
        bar(Number(r.totalSar || 0), maxProductSar, 14),
      ]),
    ),
    '',
    '## 5. 历史月度汇总与产品校验',
    '',
    table(
      ['月份', '店铺日销 SAR', '产品销售额 SAR', '差异 SAR', '产品销量'],
      historyRows.map(r => [
        r.month,
        fmt(r.salesSar),
        fmt(r.productSar),
        fmt(r.diffSar),
        fmtInt(r.qty),
      ]),
    ),
    '',
    validation?.ok ? '> ✅ 历史产品销售额与店铺日销逐月校验为 0 差异。' : '> ⚠️ 历史产品/店铺交叉校验未通过，请优先检查校验报告。',
    '',
    '## 6. 数据入口',
    '',
    table(['资源', '链接'], links),
    '',
    '## 7. 自动化状态',
    '',
    table(
      ['项目', '当前状态'],
      [
        ['同步频率', 'DSY 当天销售额每 3 小时同步：00:10 / 03:10 / 06:10 / 09:10 / 12:10 / 15:10 / 18:10 / 21:10'],
        ['前日最终版', '每天 02:00 按订单创建时间统计前一天完整业绩'],
        ['每日播报', '每天 09:00 飞书发送昨日完整业绩与今日最新业绩'],
        ['重启恢复', 'Windows 登录后 Watchdog 补跑漏掉日期；Codex App 不应成为定时任务前提'],
        ['今日数据更新时间', todayData.latestFetchTime ? `${todayData.latestFetchTime}（抓取文件时间）` : '未找到今日抓取文件'],
        ['缺失明细', [...new Set([...yesterdayData.missingStores, ...todayData.missingStores])].join(', ') || '无'],
      ],
    ),
    '',
    '---',
    '',
    '本页由工作区脚本 `scripts/generate_lark_ops_report_doc.mjs` 生成。若多维表格原生 Dashboard 后续恢复稳定，可再作为增强入口，不再作为唯一交付入口。',
    '',
  ].join('\n');
}

async function fetchDocText(doc) {
  const resp = await runLark([
    'docs', '+fetch',
    '--api-version', 'v2',
    '--as', 'user',
    '--doc', doc,
    '--doc-format', 'markdown',
    '--format', 'json',
  ]);
  return resp.parsed;
}

const args = parseArgs(process.argv.slice(2));
const state = await loadJsonIfExists(STATE_PATH);
if (!state?.baseToken) throw new Error(`Missing ${path.relative(ROOT, STATE_PATH)} baseToken.`);
const docState = await loadJsonIfExists(DOC_STATE_PATH) || {};
const storesConfig = await loadJsonIfExists(STORES_PATH);
const group = args.group;
const month = args.month || monthOf(beijingDate(0));
const title = args.title || `SHEIN ${group}经营看板（自动刷新）`;
const stores = selectedStores(storesConfig, group);
if (!stores.length) throw new Error(`No stores configured for group ${group}.`);

const monthly = await loadJsonIfExists(path.join(REPORT_DIR, `monthly-sales-${month}.json`));
if (!monthly) throw new Error(`Missing monthly report outputs/reports/monthly-sales-${month}.json. Run generate_monthly_sales_table first.`);
const product = await loadJsonIfExists(path.join(REPORT_DIR, `product-sales-${month}.json`)) || {};
const validation = await loadJsonIfExists(path.join(REPORT_DIR, 'history-product-vs-store-validation.json')) || {};
const today = beijingDate(0);
const yesterday = addDays(today, -1);
const todayData = await loadGroupDay(stores, today);
const yesterdayData = await loadGroupDay(stores, yesterday);
const trend = await loadMonthTrend(stores, month);
const baseUrl = state.baseCreateResponse?.data?.base?.url || `https://zcnm3ts63aph.feishu.cn/base/${state.baseToken}`;

const markdown = buildMarkdown({
  title,
  group,
  month,
  baseUrl,
  state,
  monthly,
  product,
  validation,
  stores,
  yesterdayData,
  todayData,
  trend,
});

await fs.mkdir(REPORT_DIR, {recursive: true});
const mdFile = path.join(REPORT_DIR, `lark-ops-dashboard-${group}-${month}.md`);
await fs.writeFile(mdFile, markdown, 'utf8');

let action = 'dry-run';
let response = null;
let docUrl = docState[group]?.url || docState.default?.url || null;
let documentId = docState[group]?.document_id || docState.default?.document_id || null;

if (!args.dryRun) {
  if (args.create || !docUrl) {
    action = 'create';
    response = await runLark([
      'docs', '+create',
      '--api-version', 'v2',
      '--as', args.as,
      '--doc-format', 'markdown',
      '--content', `@${path.relative(ROOT, mdFile).replace(/\\/g, '/')}`,
    ]);
    const document = response.parsed?.data?.document || response.parsed?.document || response.parsed?.data || {};
    docUrl = document.url || response.parsed?.data?.url || docUrl;
    documentId = document.document_id || document.document_token || response.parsed?.data?.document_id || documentId;
  } else {
    action = 'update';
    response = await runLark([
      'docs', '+update',
      '--api-version', 'v2',
      '--as', args.as,
      '--doc', docUrl,
      '--command', 'overwrite',
      '--doc-format', 'markdown',
      '--content', `@${path.relative(ROOT, mdFile).replace(/\\/g, '/')}`,
    ]);
  }

  const nextDocState = {
    ...docState,
    [group]: {
      title,
      document_id: documentId,
      url: docUrl,
      month,
      updated_at: new Date().toISOString(),
      markdown_file: path.relative(ROOT, mdFile).replace(/\\/g, '/'),
      action,
    },
    default: {
      title,
      document_id: documentId,
      url: docUrl,
      group,
      month,
      updated_at: new Date().toISOString(),
    },
  };
  await saveJson(DOC_STATE_PATH, nextDocState);

  const rawFile = path.join(REPORT_DIR, `lark-ops-dashboard-${group}-${month}-${action}.json`);
  await fs.writeFile(rawFile, JSON.stringify(response.parsed || {stdout: response.stdout}, null, 2), 'utf8');

  if (docUrl || documentId) {
    const verify = await fetchDocText(docUrl || documentId);
    const verifyFile = path.join(REPORT_DIR, `lark-ops-dashboard-${group}-${month}-fetch.json`);
    await fs.writeFile(verifyFile, JSON.stringify(verify, null, 2), 'utf8');
  }
}

console.log(JSON.stringify({
  ok: true,
  action,
  group,
  month,
  title,
  markdownFile: path.relative(ROOT, mdFile).replace(/\\/g, '/'),
  docUrl,
  documentId,
  monthlyTotalSar: round2(monthly?.totals?.totalSar),
  predictedSar: round2(monthly?.totals?.predictedSar),
  predictedProfitRmb: round2(monthly?.totals?.predictedProfitRmb),
  yesterday: {
    date: yesterday,
    salesSar: yesterdayData.totalSar,
    orders: yesterdayData.orders,
    qty: yesterdayData.qty,
  },
  today: {
    date: today,
    salesSar: todayData.totalSar,
    orders: todayData.orders,
    qty: todayData.qty,
    latestFetchTime: todayData.latestFetchTime,
  },
  productTopCount: product?.topProducts?.length || 0,
  validationOk: validation?.ok ?? null,
}, null, 2));
