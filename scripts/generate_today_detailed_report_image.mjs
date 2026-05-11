#!/usr/bin/env node
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {normalizeGoodsSn} from '../lib/product_sku_normalizer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FETCH_DIR = path.join(ROOT, 'outputs', 'shein_fetch');
const OUT_DIR = path.join(ROOT, 'outputs', 'reports');
const FX = 1.8;

function parseArgs(argv) {
  const args = {date: null, groups: ['DSY', 'LGM'], out: null};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') args.date = argv[++i];
    else if (a === '--groups') args.groups = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--out') args.out = argv[++i];
  }
  return args;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function round2(n) { return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100; }
function money(n, digits = 2) { return Number(n || 0).toLocaleString('en-US', {minimumFractionDigits: digits, maximumFractionDigits: digits}); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c])); }
function cut(s, max) { s = String(s || ''); return s.length > max ? `${s.slice(0, max - 1)}…` : s; }
function bjParts(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date).reduce((a, p) => { if (p.type !== 'literal') a[p.type] = p.value; return a; }, {});
}
function bjDate() {
  const p = bjParts();
  return `${p.year}-${p.month}-${p.day}`;
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
async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return fallback; throw err; }
}
function storesForGroups(cfg, groups) {
  return groups.flatMap(groupKey => (cfg.groups?.[groupKey] || [])
    .map(storeKey => cfg.stores.find(s => s.storeKey === storeKey))
    .filter(Boolean));
}
function itemOrderKey(item) {
  return item.orderNo || item.orderId || item.orderSn || item.orderCode || '';
}
function itemSku(item) {
  const raw = String(item.goodsSn || item.skuSn || item.skuCode || item.skcName || '').trim();
  return normalizeGoodsSn(raw, {goodsTitle: item.goodsTitle}) || raw || '未识别货号';
}
async function loadToday(cfg, groups, date) {
  const stores = storesForGroups(cfg, groups);
  const storeRows = [];
  const productMap = new Map();
  const fetchTimes = [];

  for (const store of stores) {
    const obj = await readJson(path.join(FETCH_DIR, store.storeKey, `${date}.json`), {});
    if (obj.fetchTime) fetchTimes.push(obj.fetchTime);
    const summary = obj.summary || {};
    const row = {
      storeKey: store.storeKey,
      group: store.groupKey || store.group || '',
      sar: round2(summary.salesSar || 0),
      rmb: round2((summary.salesSar || 0) * FX),
      orders: Number(summary.positiveAmountOrderCount || 0),
      qty: Number(summary.quantityPositiveAmount || 0),
      goodsLines: Number(summary.goodsLineCount || 0),
      missing: !obj.summary,
    };
    storeRows.push(row);

    for (const item of obj.goodsRows || []) {
      const qty = Number(item.number || 0);
      const sar = Number(item.currencyPrice || 0);
      if (qty <= 0 || sar <= 0) continue;
      const sku = itemSku(item);
      const p = productMap.get(sku) || {
        sku,
        qty: 0,
        sar: 0,
        orders: new Set(),
        stores: new Set(),
        dsyQty: 0,
        lgmQty: 0,
        dsySar: 0,
        lgmSar: 0,
      };
      p.qty += qty;
      p.sar = round2(p.sar + sar);
      const orderKey = itemOrderKey(item);
      if (orderKey) p.orders.add(orderKey);
      p.stores.add(store.storeKey);
      if (row.group === 'LGM') {
        p.lgmQty += qty;
        p.lgmSar = round2(p.lgmSar + sar);
      } else {
        p.dsyQty += qty;
        p.dsySar = round2(p.dsySar + sar);
      }
      productMap.set(sku, p);
    }
  }

  const totalSar = round2(storeRows.reduce((s, r) => s + r.sar, 0));
  const groupRows = groups.map(group => {
    const keys = new Set(cfg.groups?.[group] || []);
    const rows = storeRows.filter(r => keys.has(r.storeKey));
    const activeProducts = new Set();
    for (const p of productMap.values()) {
      if (group === 'LGM' && p.lgmQty > 0) activeProducts.add(p.sku);
      if (group !== 'LGM' && p.dsyQty > 0) activeProducts.add(p.sku);
    }
    const sar = round2(rows.reduce((s, r) => s + r.sar, 0));
    return {
      group,
      sar,
      rmb: round2(sar * FX),
      orders: rows.reduce((s, r) => s + r.orders, 0),
      qty: rows.reduce((s, r) => s + r.qty, 0),
      activeProducts: activeProducts.size,
    };
  });
  const allActiveProducts = new Set([...productMap.values()].filter(p => p.qty > 0).map(p => p.sku)).size;

  return {
    date,
    storeRows,
    groupRows,
    total: {
      sar: totalSar,
      rmb: round2(totalSar * FX),
      orders: storeRows.reduce((s, r) => s + r.orders, 0),
      qty: storeRows.reduce((s, r) => s + r.qty, 0),
      activeProducts: allActiveProducts,
    },
    products: [...productMap.values()].map(p => ({
      ...p,
      orders: p.orders.size,
      stores: p.stores.size,
    })).sort((a, b) => b.qty - a.qty || b.sar - a.sar || a.sku.localeCompare(b.sku, 'zh-CN')),
    latestFetchTime: fetchTimes.map(t => new Date(t)).filter(d => Number.isFinite(d.getTime())).sort((a, b) => b - a)[0]?.toISOString() || null,
  };
}
async function chromePath() {
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'D:/Program Files/Google/Chrome/Application/chrome.exe',
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

const defs = `<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#07111f"/><stop offset="0.58" stop-color="#111827"/><stop offset="1" stop-color="#241238"/></linearGradient>
  <linearGradient id="all" x1="0" x2="1"><stop offset="0" stop-color="#10b981"/><stop offset="1" stop-color="#34d399"/></linearGradient>
  <linearGradient id="dsy" x1="0" x2="1"><stop offset="0" stop-color="#2563eb"/><stop offset="1" stop-color="#60a5fa"/></linearGradient>
  <linearGradient id="lgm" x1="0" x2="1"><stop offset="0" stop-color="#f97316"/><stop offset="1" stop-color="#fb923c"/></linearGradient>
  <linearGradient id="product" x1="0" x2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#f472b6"/></linearGradient>
  <style>
    .title{font:800 48px 'Microsoft YaHei','Noto Sans CJK SC',Arial,sans-serif;fill:#f8fafc}
    .sub{font:400 19px 'Microsoft YaHei','Noto Sans CJK SC',Arial,sans-serif;fill:#cbd5e1}
    .section{font:800 29px 'Microsoft YaHei','Noto Sans CJK SC',Arial,sans-serif;fill:#fff}
    .cardTitle{font:700 18px 'Microsoft YaHei','Noto Sans CJK SC',Arial,sans-serif;fill:#c4b5fd}
    .num{font:800 34px Arial,'Microsoft YaHei';fill:#fff}
    .small{font:400 16px 'Microsoft YaHei','Noto Sans CJK SC',Arial,sans-serif;fill:#94a3b8}
    .label{font:600 18px 'Microsoft YaHei','Noto Sans CJK SC',Arial,sans-serif;fill:#e2e8f0}
    .val{font:700 17px Arial,'Microsoft YaHei';fill:#f8fafc}
    .tableHead{font:800 17px 'Microsoft YaHei',Arial,sans-serif;fill:#cbd5e1}
    .tableCell{font:600 16px 'Microsoft YaHei',Arial,sans-serif;fill:#e2e8f0}
  </style>
</defs>`;
function scopeStyle(label) {
  if (String(label).toUpperCase() === 'DSY') return {bg:'#0b2454cc', stroke:'#2563eb', title:'#93c5fd', grad:'dsy'};
  if (String(label).toUpperCase() === 'LGM') return {bg:'#3b1b0acc', stroke:'#f97316', title:'#fdba74', grad:'lgm'};
  return {bg:'#052e25cc', stroke:'#10b981', title:'#86efac', grad:'all'};
}
function sectionTitle(x, y, text, note = '') {
  return `<text x="${x}" y="${y}" class="section">${esc(text)}</text>${note ? `<text x="${x + 620}" y="${y}" class="sub">${esc(note)}</text>` : ''}`;
}
function metricCard(x, y, w, h, label, title, main, sub) {
  const style = scopeStyle(label);
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="24" fill="${style.bg}" stroke="${style.stroke}" stroke-width="1.6"/>
    <rect x="${x}" y="${y}" width="7" height="${h}" rx="4" fill="url(#${style.grad})"/>
    <text x="${x + 22}" y="${y + 38}" class="cardTitle" style="fill:${style.title}">${esc(title)}</text>
    <text x="${x + 22}" y="${y + 83}" class="num">${esc(main)}</text>
    <text x="${x + 24}" y="${y + 112}" class="small">${esc(sub)}</text>`;
}
function metricGrid(summary, y) {
  const blocks = [{label:'全部', ...summary.total}, ...summary.groupRows.map(g => ({label:g.group, ...g}))];
  const x0 = 48, gap = 22, w = 360, h = 124;
  let out = '';
  blocks.forEach((b, i) => {
    const x = x0 + (i % 3) * (w + gap);
    const yy = y + Math.floor(i / 3) * (h + 22);
    out += metricCard(x, yy, w, h, b.label, `${b.label} 今日销售额`, `${money(b.sar)} SAR`, `${money(b.rmb)} RMB`);
  });
  blocks.forEach((b, i) => {
    const x = x0 + (i % 3) * (w + gap);
    const yy = y + h + 22 + Math.floor(i / 3) * (h + 22);
    out += metricCard(x, yy, w, h, b.label, `${b.label} 订单 / 销量 / 动销`, `${b.orders} / ${b.qty} / ${b.activeProducts}`, '有效订单 / 产品件数 / 动销货号');
  });
  return out;
}
function storeRanking(rows, x, y) {
  const sorted = [...rows].sort((a, b) => b.sar - a.sar || b.orders - a.orders || b.qty - a.qty || a.storeKey.localeCompare(b.storeKey));
  const max = Math.max(1, ...sorted.map(r => r.sar));
  const rowH = 34, labelW = 92, barW = 565;
  let out = sectionTitle(x, y, `今日店铺排行（${sorted.length}店完整）`, '颜色区分 DSY / LGM，按销售额降序');
  sorted.forEach((r, i) => {
    const yy = y + 42 + i * rowH;
    const bw = Math.round(barW * r.sar / max);
    const fill = r.group === 'LGM' ? 'lgm' : 'dsy';
    out += `<text x="${x}" y="${yy + 18}" class="label">${String(i + 1).padStart(2, '0')} ${esc(r.storeKey)}</text>
      <rect x="${x + labelW}" y="${yy + 4}" width="${barW}" height="18" rx="9" fill="#172033"/>
      <rect x="${x + labelW}" y="${yy + 4}" width="${bw}" height="18" rx="9" fill="url(#${fill})"/>
      <text x="${x + labelW + barW + 14}" y="${yy + 18}" class="val">${money(r.sar)} SAR / ${money(r.rmb)} RMB｜单 ${r.orders}｜量 ${r.qty}</text>`;
  });
  return out;
}
function productRanking(products, x, y) {
  const rows = products;
  const max = Math.max(1, ...rows.map(r => r.qty));
  const rowH = 40, labelW = 420, barW = 360;
  let out = sectionTitle(x, y, `今日产品销量排行（${rows.length} 个动销货号）`, '按销量降序，展示全部今日动销货号');
  rows.forEach((r, i) => {
    const yy = y + 44 + i * rowH;
    const bw = Math.max(4, Math.round(barW * r.qty / max));
    const split = `DSY ${r.dsyQty} / LGM ${r.lgmQty}`;
    out += `<text x="${x}" y="${yy + 19}" class="label">${esc(cut(`${String(i + 1).padStart(2, '0')} ${r.sku}`, 42))}</text>
      <rect x="${x + labelW}" y="${yy + 5}" width="${barW}" height="18" rx="9" fill="#172033"/>
      <rect x="${x + labelW}" y="${yy + 5}" width="${bw}" height="18" rx="9" fill="url(#product)"/>
      <text x="${x + labelW + barW + 14}" y="${yy + 19}" class="val">${r.qty} 件｜${money(r.sar)} SAR｜${split}｜${r.stores} 店</text>`;
  });
  return out;
}

const args = parseArgs(process.argv.slice(2));
const date = args.date || bjDate();
const cfg = await readJson(path.join(ROOT, 'config', 'stores.json'));
const summary = await loadToday(cfg, args.groups, date);
const fetchText = isoToBjString(summary.latestFetchTime) || '未找到';
const productRows = Math.max(1, summary.products.length);
const width = 1240;
const height = Math.max(1650, 660 + 44 + 15 * 34 + 86 + productRows * 40 + 90);
await fs.mkdir(OUT_DIR, {recursive: true});
const png = args.out ? path.resolve(args.out) : path.join(OUT_DIR, `today-detailed-report-${date}.png`);
const htmlFile = png.replace(/\.png$/i, '.html');

let body = '';
body += `<text x="48" y="72" class="title">SHEIN 今日经营日报</text>`;
body += `<text x="50" y="110" class="sub">日期：${esc(date)}｜数据抓取时间：${esc(fetchText)}（北京时间）｜生成时间：${esc(bjNow())}（北京时间）</text>`;
let cy = 154;
body += sectionTitle(48, cy, '今日核心数据', '全部 / DSY / LGM');
cy += 26;
body += metricGrid(summary, cy);
cy += 2 * 124 + 22 + 64;
body += storeRanking(summary.storeRows, 48, cy);
cy += 44 + 15 * 34 + 74;
body += productRanking(summary.products, 48, cy);
body += `<text x="48" y="${height - 38}" class="small">口径：订单创建时间｜北京时间自然日｜正金额商品明细汇总｜货号按标准货号归并｜1 SAR = 1.8 RMB。</text>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${defs}<rect width="${width}" height="${height}" fill="url(#bg)"/><circle cx="1090" cy="118" r="180" fill="#7c3aed" opacity=".20"/><circle cx="120" cy="${height - 150}" r="235" fill="#06b6d4" opacity=".12"/>${body}</svg>`;
await fs.writeFile(htmlFile, `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#08111f}svg{display:block}</style>${svg}`, 'utf8');
await renderPng(htmlFile, png, width, height);

console.log(JSON.stringify({
  ok: true,
  date,
  png,
  html: htmlFile,
  height,
  latestFetchTime: fetchText,
  totalSar: summary.total.sar,
  totalRmb: summary.total.rmb,
  orders: summary.total.orders,
  qty: summary.total.qty,
  activeProducts: summary.total.activeProducts,
  productRows: summary.products.length,
}, null, 2));
