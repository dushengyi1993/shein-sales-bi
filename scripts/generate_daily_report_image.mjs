#!/usr/bin/env node
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {normalizeGoodsSn} from '../lib/product_sku_normalizer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'outputs', 'reports');
const FETCH_DIR = path.join(ROOT, 'outputs', 'shein_fetch');
const FX = 1.8;

function parseArgs(argv) {
  const args = {date: null, groups: ['DSY', 'LGM'], out: null, asOf: null};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') args.date = argv[++i];
    else if (a === '--groups') args.groups = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--as-of') args.asOf = argv[++i];
  }
  return args;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function round2(n) { return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100; }
function money(n) { return Number(n || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c])); }
function cut(s, max) { s = String(s || ''); return s.length > max ? `${s.slice(0, max - 1)}…` : s; }
function seconds(t) {
  const m = String(t || '').match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0) : 24 * 3600 - 1;
}
function bjParts() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date()).reduce((a, p) => { if (p.type !== 'literal') a[p.type] = p.value; return a; }, {});
}
function bjDate(offset = 0) {
  const p = bjParts();
  const d = new Date(`${p.year}-${p.month}-${p.day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
function bjTime() { const p = bjParts(); return `${p.hour}:${p.minute}:${p.second}`; }
function bjNow() { const p = bjParts(); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`; }
function isoToBjString(value) {
  if (!value) return null;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false}).formatToParts(d).reduce((a, p) => { if (p.type !== 'literal') a[p.type] = p.value; return a; }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
function prevDate(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return fallback; throw err; }
}
async function chromePath() {
  const candidates = [
    'D:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ];
  for (const c of candidates) if (fss.existsSync(c)) return c;
  return 'chrome.exe';
}
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', reject);
    child.on('close', code => code ? reject(new Error(stderr || stdout || `exit ${code}`)) : resolve({stdout, stderr}));
  });
}
async function renderPng(htmlFile, pngFile, width, height) {
  const chrome = await chromePath();
  const tmp = path.join(ROOT, 'profiles', 'daily-report-render');
  await fs.mkdir(tmp, {recursive: true});
  await run(chrome, [
    `--user-data-dir=${tmp}`, '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=1', `--window-size=${width},${height}`,
    `--screenshot=${pngFile}`, `file:///${htmlFile.replace(/\\/g, '/')}`,
  ]);
}
function storesForGroups(cfg, groups) {
  return groups.flatMap(groupKey => (cfg.groups?.[groupKey] || [])
    .map(storeKey => cfg.stores.find(s => s.storeKey === storeKey))
    .filter(Boolean));
}
function includeBefore(item, asOfSec) {
  const t = String(item.orderCreateTime || item.allocateTimeFull || item.allocateTime || '');
  const m = t.match(/\d{4}-\d{2}-\d{2}[ T](\d{1,2}:\d{2}(?::\d{2})?)/);
  return !m || seconds(m[1]) <= asOfSec;
}
function itemOrderKey(item) { return item.orderNo || item.orderId || item.orderSn || item.orderCode || ''; }
async function daySummary(stores, date, {asOfSec = null} = {}) {
  const storeMap = new Map();
  const products = new Map();
  const fetchTimes = [];
  for (const store of stores) {
    storeMap.set(store.storeKey, {storeKey: store.storeKey, group: store.groupKey || store.group || '', sar: 0, orders: new Set(), qty: 0});
    const obj = await readJson(path.join(FETCH_DIR, store.storeKey, `${date}.json`), {});
    if (obj.fetchTime) fetchTimes.push(obj.fetchTime);
    for (const item of obj.goodsRows || []) {
      const qty = Number(item.number || 0);
      const sar = Number(item.currencyPrice || 0);
      if (qty <= 0 || sar <= 0) continue;
      if (asOfSec !== null && !includeBefore(item, asOfSec)) continue;
      const row = storeMap.get(store.storeKey);
      row.sar = round2(row.sar + sar);
      row.qty += qty;
      const orderKey = itemOrderKey(item);
      if (orderKey) row.orders.add(orderKey);
      if (store.productStatsEnabled === false) continue;
      const sku = normalizeGoodsSn(String(item.goodsSn || item.skuSn || item.skuCode || item.skcName || ''), {goodsTitle: item.goodsTitle});
      if (!sku) continue;
      const product = products.get(sku) || {sku, qty: 0, sar: 0};
      product.qty += qty;
      product.sar = round2(product.sar + sar);
      products.set(sku, product);
    }
  }
  const rows = [...storeMap.values()].map(r => ({...r, orders: r.orders.size}));
  const totalSar = round2(rows.reduce((sum, r) => sum + r.sar, 0));
  return {
    date,
    rows,
    totalSar,
    totalRmb: round2(totalSar * FX),
    orders: rows.reduce((sum, r) => sum + r.orders, 0),
    qty: rows.reduce((sum, r) => sum + r.qty, 0),
    rankedStores: [...rows].sort((a, b) => b.sar - a.sar || b.orders - a.orders || a.storeKey.localeCompare(b.storeKey)),
    rankedProducts: [...products.values()].sort((a, b) => b.qty - a.qty || b.sar - a.sar || a.sku.localeCompare(b.sku, 'zh-CN')),
    latestFetchTime: fetchTimes.map(t => new Date(t)).filter(d => Number.isFinite(d.getTime())).sort((a, b) => b - a)[0]?.toISOString() || null,
  };
}
function groupBlocks(cfg, groupKeys, summary) {
  const all = {label: '全部', sar: summary.totalSar, rmb: summary.totalRmb, orders: summary.orders, qty: summary.qty};
  const groups = groupKeys.map(groupKey => {
    const keys = new Set(cfg.groups?.[groupKey] || []);
    const rows = summary.rows.filter(r => keys.has(r.storeKey));
    const sar = round2(rows.reduce((sum, r) => sum + r.sar, 0));
    return {label: groupKey, sar, rmb: round2(sar * FX), orders: rows.reduce((sum, r) => sum + r.orders, 0), qty: rows.reduce((sum, r) => sum + r.qty, 0)};
  });
  return [all, ...groups];
}

const defs = `<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#07111f"/><stop offset="0.55" stop-color="#111827"/><stop offset="1" stop-color="#241238"/></linearGradient>
  <linearGradient id="all" x1="0" x2="1"><stop offset="0" stop-color="#10b981"/><stop offset="1" stop-color="#34d399"/></linearGradient>
  <linearGradient id="product" x1="0" x2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#f472b6"/></linearGradient>
  <linearGradient id="dsy" x1="0" x2="1"><stop offset="0" stop-color="#2563eb"/><stop offset="1" stop-color="#60a5fa"/></linearGradient>
  <linearGradient id="lgm" x1="0" x2="1"><stop offset="0" stop-color="#f97316"/><stop offset="1" stop-color="#fb923c"/></linearGradient>
  <style>
    .title{font:800 46px 'Microsoft YaHei','Noto Sans CJK SC',Arial,sans-serif;fill:#f8fafc}
    .sub{font:400 19px 'Microsoft YaHei','Noto Sans CJK SC',Arial,sans-serif;fill:#cbd5e1}
    .section{font:800 28px 'Microsoft YaHei','Noto Sans CJK SC',Arial,sans-serif;fill:#fff}
    .cardTitle{font:700 18px 'Microsoft YaHei','Noto Sans CJK SC',Arial,sans-serif;fill:#c4b5fd}
    .num{font:800 35px Arial,'Microsoft YaHei';fill:#fff}
    .small{font:400 16px 'Microsoft YaHei','Noto Sans CJK SC',Arial,sans-serif;fill:#94a3b8}
    .label{font:600 18px 'Microsoft YaHei','Noto Sans CJK SC',Arial,sans-serif;fill:#e2e8f0}
    .val{font:700 17px Arial,'Microsoft YaHei';fill:#f8fafc}
  </style>
</defs>`;
function sectionTitle(x, y, text, note = '') {
  return `<text x="${x}" y="${y}" class="section">${esc(text)}</text>${note ? `<text x="${x + 250}" y="${y}" class="sub">${esc(note)}</text>` : ''}`;
}
function scopeStyle(label) {
  if (String(label).toUpperCase() === 'DSY') return {bg:'#0b2454cc', stroke:'#2563eb', title:'#93c5fd', grad:'dsy'};
  if (String(label).toUpperCase() === 'LGM') return {bg:'#3b1b0acc', stroke:'#f97316', title:'#fdba74', grad:'lgm'};
  return {bg:'#052e25cc', stroke:'#10b981', title:'#86efac', grad:'all'};
}
function metricCard(x, y, w, block, mode) {
  const style = scopeStyle(block.label);
  const title = `${block.label}${mode === 'sales' ? '销售额' : '订单 / 销量'}`;
  const main = mode === 'sales' ? money(block.sar) : `${block.orders} / ${block.qty}`;
  const sub = mode === 'sales' ? `SAR / ${money(block.rmb)} RMB` : '有效订单 / 产品件数';
  return `<rect x="${x}" y="${y}" width="${w}" height="124" rx="24" fill="${style.bg}" stroke="${style.stroke}" stroke-width="1.6"/>
    <rect x="${x}" y="${y}" width="7" height="124" rx="4" fill="url(#${style.grad})"/>
    <text x="${x + 22}" y="${y + 39}" class="cardTitle" style="fill:${style.title}">${esc(title)}</text>
    <text x="${x + 22}" y="${y + 84}" class="num">${esc(main)}</text>
    <text x="${x + 24}" y="${y + 112}" class="small">${esc(sub)}</text>`;
}
function metricRow(blocks, y, mode) {
  const x0 = 48, gap = 24, w = 312;
  return blocks.slice(0, 3).map((b, i) => metricCard(x0 + i * (w + gap), y, w, b, mode)).join('');
}
function ranking(rows, {x, y, title, mode = 'store', maxRows = 15}) {
  const rowH = mode === 'product' ? 42 : 32;
  const labelW = mode === 'product' ? 390 : 112;
  const barW = mode === 'product' ? 440 : 463;
  const max = Math.max(1, ...rows.slice(0, maxRows).map(r => mode === 'product' ? r.qty : r.sar));
  let out = sectionTitle(x, y, title);
  rows.slice(0, maxRows).forEach((r, i) => {
    const yy = y + 38 + i * rowH;
    const label = mode === 'product' ? `${String(i + 1).padStart(2, '0')} ${r.sku}` : `${String(i + 1).padStart(2, '0')} ${r.storeKey}`;
    const value = mode === 'product' ? r.qty : r.sar;
    const display = mode === 'product' ? `${r.qty} 件 / ${money(r.sar)} SAR` : `${money(r.sar)} SAR`;
    const bw = Math.round(barW * value / max);
    const fillId = mode === 'product' ? 'product' : (String(r.group).toUpperCase() === 'LGM' ? 'lgm' : 'dsy');
    out += `<text x="${x}" y="${yy + 18}" class="label">${esc(cut(label, mode === 'product' ? 46 : 12))}</text>
      <rect x="${x + labelW}" y="${yy + 4}" width="${barW}" height="18" rx="9" fill="#172033"/>
      <rect x="${x + labelW}" y="${yy + 4}" width="${bw}" height="18" rx="9" fill="url(#${fillId})"/>
      <text x="${x + labelW + barW + 14}" y="${yy + 18}" class="val">${esc(display)}</text>`;
  });
  return out;
}
function rankingHeight(rows, maxRows, mode) { return 50 + Math.min(rows.length, maxRows) * (mode === 'product' ? 42 : 32); }

const args = parseArgs(process.argv.slice(2));
const date = args.date || bjDate();
const ydate = prevDate(date);
const asOf = args.asOf || bjTime();
const asOfSec = seconds(asOf);
const cfg = await readJson(path.join(ROOT, 'config', 'stores.json'));
const stores = storesForGroups(cfg, args.groups);
const today = await daySummary(stores, date, {asOfSec});
const yesterdayFull = await daySummary(stores, ydate);
const todayBlocks = groupBlocks(cfg, args.groups, today);
const yesterdayBlocks = groupBlocks(cfg, args.groups, yesterdayFull);
const todayFetchText = isoToBjString(today.latestFetchTime) || `${date} ${asOf.slice(0, 5)}:00`;

const todayStoreRows = 15;
const yesterdayStoreRows = 15;
const yesterdayProductRows = Math.min(24, Math.max(12, yesterdayFull.rankedProducts.length));
let y = 48;
y += 95;
y += 44 + 124 + 24 + 124 + 42;
y += rankingHeight(today.rankedStores, todayStoreRows, 'store') + 52;
y += 44 + 124 + 24 + 124 + 42;
y += rankingHeight(yesterdayFull.rankedStores, yesterdayStoreRows, 'store') + 48;
y += rankingHeight(yesterdayFull.rankedProducts, yesterdayProductRows, 'product') + 80;
const height = Math.max(1900, y);
const width = 1080;
await fs.mkdir(OUT_DIR, {recursive: true});
const png = args.out ? path.resolve(args.out) : path.join(OUT_DIR, `daily-visual-report-${date}.png`);
const htmlFile = png.replace(/\.png$/i, '.html');

let body = '';
body += `<text x="48" y="72" class="title">SHEIN 经营日报</text>`;
body += `<text x="50" y="110" class="sub">数据抓取时间：${esc(todayFetchText)} ｜ 统计截至：${esc(date)} ${esc(asOf.slice(0, 5))} ｜ 生成时间：${esc(bjNow())}（北京时间）</text>`;
let cy = 152;
body += sectionTitle(48, cy, '今日截至当前', '销售额、订单和销量分别展示 全部 / DSY / LGM');
cy += 26;
body += metricRow(todayBlocks, cy, 'sales');
cy += 148;
body += metricRow(todayBlocks, cy, 'orders');
cy += 178;
body += ranking(today.rankedStores, {x: 48, y: cy, title: '今日店铺排行', mode: 'store', maxRows: todayStoreRows});
cy += rankingHeight(today.rankedStores, todayStoreRows, 'store') + 56;
body += sectionTitle(48, cy, '\u6628\u65e5\u5168\u5929', `\u6628\u65e5 ${ydate} \u5b8c\u6574\u81ea\u7136\u65e5`);
cy += 26;
body += metricRow(yesterdayBlocks, cy, 'sales');
cy += 148;
body += metricRow(yesterdayBlocks, cy, 'orders');
cy += 178;
body += ranking(yesterdayFull.rankedStores, {x: 48, y: cy, title: '\u6628\u65e5\u5168\u5929\u5e97\u94fa\u6392\u884c', mode: 'store', maxRows: yesterdayStoreRows});
cy += rankingHeight(yesterdayFull.rankedStores, yesterdayStoreRows, 'store') + 52;
body += ranking(yesterdayFull.rankedProducts, {x: 48, y: cy, title: '\u6628\u65e5\u5168\u5929\u4ea7\u54c1\u9500\u91cf\u6392\u884c', mode: 'product', maxRows: yesterdayProductRows});
body += `<text x="48" y="${height - 38}" class="small">\u53e3\u5f84\uff1a\u8ba2\u5355\u521b\u5efa\u65f6\u95f4\uff5c\u5317\u4eac\u65f6\u95f4\u81ea\u7136\u65e5\uff5c\u4eca\u65e5\u6309\u5f53\u524d\u622a\u6b62\u65f6\u95f4\u7edf\u8ba1\uff1b\u6628\u65e5\u6309\u5b8c\u6574\u81ea\u7136\u65e5\u7edf\u8ba1\u3002</text>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${defs}<rect width="${width}" height="${height}" fill="url(#bg)"/><circle cx="930" cy="130" r="165" fill="#7c3aed" opacity=".20"/><circle cx="130" cy="${height - 130}" r="210" fill="#06b6d4" opacity=".13"/>${body}</svg>`;
await fs.writeFile(htmlFile, `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#08111f}svg{display:block}</style>${svg}`, 'utf8');
await renderPng(htmlFile, png, width, height);
console.log(JSON.stringify({ok: true, date, yesterday: ydate, asOf, png, html: htmlFile, height, todaySar: today.totalSar, yesterdayFullSar: yesterdayFull.totalSar, todayStores: today.rankedStores.length, yesterdayProducts: yesterdayFull.rankedProducts.length}, null, 2));
