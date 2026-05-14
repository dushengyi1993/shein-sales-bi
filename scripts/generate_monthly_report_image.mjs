#!/usr/bin/env node
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {normalizeGoodsSn} from '../lib/product_sku_normalizer.mjs';
import {isValidSalesGoodsRow, salesAmountSar, salesQuantity} from '../lib/shein_sales_validity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'outputs', 'reports');
const FETCH_DIR = path.join(ROOT, 'outputs', 'shein_fetch');
const FX = 1.8;
const PROFIT_RATE = 0.25;

function parseArgs(argv) {
  const args = {month: null, groups: ['DSY', 'LGM'], out: null};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--month') args.month = argv[++i];
    else if (a === '--groups') args.groups = argv[++i].split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--out') args.out = argv[++i];
  }
  return args;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function round2(n) { return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100; }
function money(n) { return Number(n || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c])); }
function cut(s, max) { s = String(s || ''); return s.length > max ? `${s.slice(0, max - 1)}...` : s; }
function bjParts(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date).reduce((a, p) => { if (p.type !== 'literal') a[p.type] = p.value; return a; }, {});
}
function bjMonth(offsetMonths = 0) {
  const p = bjParts();
  const d = new Date(Date.UTC(Number(p.year), Number(p.month) - 1 + offsetMonths, 1));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}
function bjNow() {
  const p = bjParts();
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
function isoToBjString(value) {
  if (!value) return null;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  const p = bjParts(d);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
function monthDays(month) {
  const [year, mm] = month.split('-').map(Number);
  const days = new Date(Date.UTC(year, mm, 0)).getUTCDate();
  return Array.from({length: days}, (_, i) => `${month}-${pad2(i + 1)}`);
}
async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return fallback; throw err; }
}
function storesForGroups(cfg, groups) {
  return groups.flatMap(groupKey => (cfg.groups?.[groupKey] || [])
    .map(storeKey => cfg.stores.find(s => s.storeKey === storeKey))
    .filter(Boolean));
}
function itemOrderKey(item) { return item.orderNo || item.orderId || item.orderSn || item.orderCode || ''; }
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
  const tmp = path.join(ROOT, 'profiles', 'monthly-report-render');
  await fs.mkdir(tmp, {recursive: true});
  await run(chrome, [
    `--user-data-dir=${tmp}`, '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=1', `--window-size=${width},${height}`,
    `--screenshot=${pngFile}`, `file:///${htmlFile.replace(/\\/g, '/')}`,
  ]);
}

async function monthSummary(stores, month) {
  const storeMap = new Map();
  const dailyMap = new Map(monthDays(month).map(day => [day, {date: day, sar: 0, orders: new Set(), qty: 0}]));
  const products = new Map();
  const fetchTimes = [];
  for (const store of stores) {
    storeMap.set(store.storeKey, {
      storeKey: store.storeKey,
      group: store.groupKey || store.group || '',
      shopName: store.shopName || '',
      sar: 0,
      orders: new Set(),
      qty: 0,
      daysWithSales: 0,
    });
    for (const day of monthDays(month)) {
      const obj = await readJson(path.join(FETCH_DIR, store.storeKey, `${day}.json`), {});
      if (obj.fetchTime) fetchTimes.push(obj.fetchTime);
      let dayStoreSar = 0;
      for (const item of obj.goodsRows || []) {
        if (!isValidSalesGoodsRow(item)) continue;
        const qty = salesQuantity(item);
        const sar = salesAmountSar(item);
        if (qty <= 0 || sar <= 0) continue;
        const storeRow = storeMap.get(store.storeKey);
        const dailyRow = dailyMap.get(day);
        storeRow.sar = round2(storeRow.sar + sar);
        storeRow.qty += qty;
        dayStoreSar = round2(dayStoreSar + sar);
        dailyRow.sar = round2(dailyRow.sar + sar);
        dailyRow.qty += qty;
        const orderKey = itemOrderKey(item);
        if (orderKey) {
          storeRow.orders.add(orderKey);
          dailyRow.orders.add(`${store.storeKey}:${orderKey}`);
        }
        if (store.productStatsEnabled === false) continue;
        const rawSku = String(item.goodsSn || item.skuSn || item.skuCode || item.skcName || '').trim();
        const sku = normalizeGoodsSn(rawSku, {goodsTitle: item.goodsTitle});
        if (!sku) continue;
        const product = products.get(sku) || {sku, title: '', qty: 0, sar: 0};
        product.qty += qty;
        product.sar = round2(product.sar + sar);
        if (!product.title && item.goodsTitle) product.title = String(item.goodsTitle).slice(0, 500);
        products.set(sku, product);
      }
      if (dayStoreSar > 0) storeMap.get(store.storeKey).daysWithSales += 1;
    }
  }
  const storeRows = [...storeMap.values()].map(r => ({...r, orders: r.orders.size}));
  const dailyRows = [...dailyMap.values()].map(r => ({...r, orders: r.orders.size}));
  const totalSar = round2(storeRows.reduce((sum, r) => sum + r.sar, 0));
  return {
    storeRows,
    dailyRows,
    totalSar,
    totalRmb: round2(totalSar * FX),
    profitRmb: round2(totalSar * FX * PROFIT_RATE),
    orders: storeRows.reduce((sum, r) => sum + r.orders, 0),
    qty: storeRows.reduce((sum, r) => sum + r.qty, 0),
    rankedStores: [...storeRows].sort((a, b) => b.sar - a.sar || b.orders - a.orders || a.storeKey.localeCompare(b.storeKey)),
    rankedProductsByQty: [...products.values()].sort((a, b) => b.qty - a.qty || b.sar - a.sar || a.sku.localeCompare(b.sku, 'zh-CN')),
    rankedProductsBySales: [...products.values()].sort((a, b) => b.sar - a.sar || b.qty - a.qty || a.sku.localeCompare(b.sku, 'zh-CN')),
    latestFetchTime: fetchTimes.map(t => new Date(t)).filter(d => Number.isFinite(d.getTime())).sort((a, b) => b - a)[0]?.toISOString() || null,
  };
}

function groupBlocks(cfg, groupKeys, summary, daysInMonth) {
  const all = {label: '全部', sar: summary.totalSar, rmb: summary.totalRmb, orders: summary.orders, qty: summary.qty, avg: round2(summary.totalSar / daysInMonth)};
  const groups = groupKeys.map(groupKey => {
    const keys = new Set(cfg.groups?.[groupKey] || []);
    const rows = summary.storeRows.filter(r => keys.has(r.storeKey));
    const sar = round2(rows.reduce((sum, r) => sum + r.sar, 0));
    return {
      label: groupKey,
      sar,
      rmb: round2(sar * FX),
      orders: rows.reduce((sum, r) => sum + r.orders, 0),
      qty: rows.reduce((sum, r) => sum + r.qty, 0),
      avg: round2(sar / daysInMonth),
    };
  });
  return [all, ...groups];
}

const defs = `<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#06151f"/><stop offset="0.55" stop-color="#101827"/><stop offset="1" stop-color="#231334"/></linearGradient>
  <linearGradient id="all" x1="0" x2="1"><stop offset="0" stop-color="#10b981"/><stop offset="1" stop-color="#34d399"/></linearGradient>
  <linearGradient id="dsy" x1="0" x2="1"><stop offset="0" stop-color="#2563eb"/><stop offset="1" stop-color="#60a5fa"/></linearGradient>
  <linearGradient id="lgm" x1="0" x2="1"><stop offset="0" stop-color="#f97316"/><stop offset="1" stop-color="#fb923c"/></linearGradient>
  <linearGradient id="product" x1="0" x2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#f472b6"/></linearGradient>
  <style>
    .title{font:800 48px 'Microsoft YaHei','Noto Sans CJK SC',Arial,sans-serif;fill:#f8fafc}
    .sub{font:400 19px 'Microsoft YaHei','Noto Sans CJK SC',Arial,sans-serif;fill:#cbd5e1}
    .section{font:800 28px 'Microsoft YaHei','Noto Sans CJK SC',Arial,sans-serif;fill:#fff}
    .cardTitle{font:700 18px 'Microsoft YaHei','Noto Sans CJK SC',Arial,sans-serif;fill:#c4b5fd}
    .num{font:800 34px Arial,'Microsoft YaHei';fill:#fff}
    .small{font:400 16px 'Microsoft YaHei','Noto Sans CJK SC',Arial,sans-serif;fill:#94a3b8}
    .label{font:600 17px 'Microsoft YaHei','Noto Sans CJK SC',Arial,sans-serif;fill:#e2e8f0}
    .val{font:700 16px Arial,'Microsoft YaHei';fill:#f8fafc}
    .axis{font:400 13px Arial,'Microsoft YaHei';fill:#94a3b8}
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
  const title = `${block.label}${mode === 'sales' ? '月销售额' : mode === 'orders' ? '订单 / 销量' : '日均销售额'}`;
  const main = mode === 'sales' ? money(block.sar) : mode === 'orders' ? `${block.orders} / ${block.qty}` : money(block.avg);
  const sub = mode === 'sales' ? `SAR / ${money(block.rmb)} RMB` : mode === 'orders' ? '有效订单 / 产品件数' : 'SAR / 天';
  return `<rect x="${x}" y="${y}" width="${w}" height="118" rx="22" fill="${style.bg}" stroke="${style.stroke}" stroke-width="1.5"/>
    <rect x="${x}" y="${y}" width="7" height="118" rx="4" fill="url(#${style.grad})"/>
    <text x="${x + 21}" y="${y + 37}" class="cardTitle" style="fill:${style.title}">${esc(title)}</text>
    <text x="${x + 21}" y="${y + 80}" class="num">${esc(main)}</text>
    <text x="${x + 23}" y="${y + 106}" class="small">${esc(sub)}</text>`;
}
function metricRow(blocks, y, mode) {
  const x0 = 48, gap = 24, w = 312;
  return blocks.slice(0, 3).map((b, i) => metricCard(x0 + i * (w + gap), y, w, b, mode)).join('');
}
function trendChart(rows, x, y, w, h) {
  const max = Math.max(1, ...rows.map(r => r.sar));
  const gap = 4;
  const barW = Math.max(8, Math.floor((w - gap * (rows.length - 1)) / rows.length));
  let out = sectionTitle(x, y, '每日销售趋势', `最高单日 ${money(max)} SAR`);
  const baseY = y + 42 + h;
  rows.forEach((r, i) => {
    const bh = Math.max(2, Math.round(h * r.sar / max));
    const bx = x + i * (barW + gap);
    const day = Number(r.date.slice(-2));
    out += `<rect x="${bx}" y="${baseY - bh}" width="${barW}" height="${bh}" rx="4" fill="url(#all)" opacity="${r.sar > 0 ? '.95' : '.25'}"/>`;
    if (day === 1 || day % 5 === 0 || day === rows.length) {
      out += `<text x="${bx + barW / 2}" y="${baseY + 20}" class="axis" text-anchor="middle">${day}</text>`;
    }
  });
  out += `<line x1="${x}" y1="${baseY}" x2="${x + w}" y2="${baseY}" stroke="#334155" stroke-width="1"/>`;
  return out;
}
function ranking(rows, {x, y, title, mode = 'store', maxRows = 15}) {
  const rowH = mode === 'product' ? 42 : 32;
  const labelW = mode === 'product' ? 390 : 112;
  const barW = mode === 'product' ? 430 : 463;
  const max = Math.max(1, ...rows.slice(0, maxRows).map(r => mode === 'product' ? (r.qty || r.sar) : r.sar));
  let out = sectionTitle(x, y, title);
  rows.slice(0, maxRows).forEach((r, i) => {
    const yy = y + 38 + i * rowH;
    const label = mode === 'product' ? `${String(i + 1).padStart(2, '0')} ${r.sku}` : `${String(i + 1).padStart(2, '0')} ${r.storeKey}`;
    const value = mode === 'product' ? (r.qty || r.sar) : r.sar;
    const display = mode === 'product' ? `${r.qty} 件 / ${money(r.sar)} SAR` : `${money(r.sar)} SAR`;
    const bw = Math.round(barW * value / max);
    const fillId = mode === 'product' ? 'product' : (String(r.group).toUpperCase() === 'LGM' ? 'lgm' : 'dsy');
    out += `<text x="${x}" y="${yy + 18}" class="label">${esc(cut(label, mode === 'product' ? 45 : 12))}</text>
      <rect x="${x + labelW}" y="${yy + 4}" width="${barW}" height="18" rx="9" fill="#172033"/>
      <rect x="${x + labelW}" y="${yy + 4}" width="${bw}" height="18" rx="9" fill="url(#${fillId})"/>
      <text x="${x + labelW + barW + 14}" y="${yy + 18}" class="val">${esc(display)}</text>`;
  });
  return out;
}
function rankingHeight(rows, maxRows, mode) { return 50 + Math.min(rows.length, maxRows) * (mode === 'product' ? 42 : 32); }

const args = parseArgs(process.argv.slice(2));
const month = args.month || bjMonth(-1);
if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`Invalid --month: ${month}`);
const cfg = await readJson(path.join(ROOT, 'config', 'stores.json'));
const stores = storesForGroups(cfg, args.groups);
const days = monthDays(month);
const summary = await monthSummary(stores, month);
const blocks = groupBlocks(cfg, args.groups, summary, days.length);
const latestFetchText = isoToBjString(summary.latestFetchTime) || '未找到';
const topQtyRows = Math.min(18, Math.max(10, summary.rankedProductsByQty.length));

let y = 48;
y += 96;
y += 42 + 118 + 24 + 118 + 24 + 118 + 44;
y += 42 + 230 + 64;
y += rankingHeight(summary.rankedStores, 15, 'store') + 52;
y += rankingHeight(summary.rankedProductsByQty, topQtyRows, 'product') + 76;
const width = 1080;
const height = Math.max(1880, y);

await fs.mkdir(OUT_DIR, {recursive: true});
const png = args.out ? path.resolve(args.out) : path.join(OUT_DIR, `monthly-sales-report-${month}.png`);
const htmlFile = png.replace(/\.png$/i, '.html');

let body = '';
body += `<text x="48" y="72" class="title">SHEIN ${esc(month)} 销售月报</text>`;
body += `<text x="50" y="110" class="sub">数据抓取时间：${esc(latestFetchText)} ｜ 统计范围：${esc(month)}-01 至 ${esc(days.at(-1))} ｜ 生成时间：${esc(bjNow())}（北京时间）</text>`;
let cy = 152;
body += sectionTitle(48, cy, '月度核心指标', '全部 / DSY / LGM');
cy += 24;
body += metricRow(blocks, cy, 'sales');
cy += 142;
body += metricRow(blocks, cy, 'orders');
cy += 142;
body += metricRow(blocks, cy, 'avg');
cy += 172;
body += `<rect x="48" y="${cy - 35}" width="984" height="74" rx="18" fill="#0f172acc" stroke="#334155" stroke-width="1"/>
  <text x="72" y="${cy - 7}" class="small">按固定口径估算利润</text>
  <text x="72" y="${cy + 26}" class="num">${esc(money(summary.profitRmb))} RMB</text>
  <text x="470" y="${cy + 10}" class="small">口径：销售额 SAR x ${FX} x ${(PROFIT_RATE * 100).toFixed(0)}%</text>`;
cy += 76;
body += trendChart(summary.dailyRows, 48, cy, 984, 230);
cy += 42 + 230 + 66;
body += ranking(summary.rankedStores, {x: 48, y: cy, title: '店铺销售排行', mode: 'store', maxRows: 15});
cy += rankingHeight(summary.rankedStores, 15, 'store') + 56;
body += ranking(summary.rankedProductsByQty, {x: 48, y: cy, title: '产品销量排行', mode: 'product', maxRows: topQtyRows});
body += `<text x="48" y="${height - 38}" class="small">口径：订单创建时间｜北京时间自然日｜正金额商品行计销售额和销量｜店铺颜色：DSY 蓝色、LGM 橙色。</text>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${defs}<rect width="${width}" height="${height}" fill="url(#bg)"/><circle cx="920" cy="126" r="160" fill="#10b981" opacity=".13"/><circle cx="160" cy="${height - 145}" r="220" fill="#6366f1" opacity=".12"/>${body}</svg>`;
await fs.writeFile(htmlFile, `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#08111f}svg{display:block}</style>${svg}`, 'utf8');
await renderPng(htmlFile, png, width, height);
console.log(JSON.stringify({
  ok: true,
  month,
  groups: args.groups,
  png,
  html: htmlFile,
  width,
  height,
  totalSar: summary.totalSar,
  totalRmb: summary.totalRmb,
  profitRmb: summary.profitRmb,
  orders: summary.orders,
  qty: summary.qty,
  latestFetchTime: summary.latestFetchTime,
  storeCount: summary.storeRows.length,
  productCount: summary.rankedProductsByQty.length,
}, null, 2));
