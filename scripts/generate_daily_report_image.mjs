#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {requireChromeExecutable} from '../lib/chrome_executable.mjs';
import {normalizeGoodsSn} from '../lib/product_sku_normalizer.mjs';
import {isValidSalesGoodsRow, salesAmountSar, salesQuantity} from '../lib/shein_sales_validity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'outputs', 'reports');
const FETCH_DIR = path.join(ROOT, 'outputs', 'shein_fetch');
const FX = 1.8;
const FONT_STACK = "'Noto Sans CJK SC','Noto Sans SC','WenQuanYi Micro Hei','Microsoft YaHei','PingFang SC',Arial,sans-serif";
const MONO_STACK = "'DIN Alternate','Arial Narrow','Roboto Mono','Consolas',Arial,sans-serif";
const OWNER_FALLBACK = {key: 'UNASSIGNED', name: '未分配', color: '#64748b', stores: []};

function parseArgs(argv) {
  const args = {date: null, groups: ['ALL'], out: null, asOf: null};
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
function money(n, digits = 2) { return Number(n || 0).toLocaleString('en-US', {minimumFractionDigits: digits, maximumFractionDigits: digits}); }
function int(n) { return Number(n || 0).toLocaleString('en-US', {maximumFractionDigits: 0}); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c])); }
function cut(s, max) { s = String(s || ''); return s.length > max ? `${s.slice(0, max - 1)}…` : s; }
function avg(n, d) { return d ? round2(Number(n || 0) / Number(d || 0)) : 0; }
function pct(n, d) { return d ? `${Math.round(Number(n || 0) * 1000 / Number(d || 0)) / 10}%` : '0%'; }
function cleanColor(value, fallback = '#64748b') { return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value) : fallback; }
function seconds(t) {
  const m = String(t || '').match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0) : 24 * 3600 - 1;
}
function bjParts(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date).reduce((a, p) => { if (p.type !== 'literal') a[p.type] = p.value; return a; }, {});
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
  const p = bjParts(d);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
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
async function readStoreDay(storeKey, date) {
  const file = path.join(FETCH_DIR, storeKey, `${date}.json`);
  try { return {file, missingFile: false, obj: JSON.parse(await fs.readFile(file, 'utf8'))}; }
  catch (err) { if (err.code === 'ENOENT') return {file, missingFile: true, obj: {}}; throw err; }
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
  const chrome = requireChromeExecutable('Chrome/Chromium for daily report rendering');
  const tmp = path.join(ROOT, 'profiles', 'daily-report-render');
  await fs.mkdir(tmp, {recursive: true});
  const fileUrl = process.platform === 'win32' ? `file:///${htmlFile.replace(/\\/g, '/')}` : `file://${htmlFile}`;
  const chromeArgs = [
    `--user-data-dir=${tmp}`, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--disable-dev-shm-usage',
    '--force-device-scale-factor=1', `--window-size=${width},${height}`, `--screenshot=${pngFile}`,
  ];
  if (process.platform !== 'win32') chromeArgs.push('--no-sandbox');
  chromeArgs.push(fileUrl);
  await run(chrome, chromeArgs);
}
function storeByKey(cfg, key) {
  return cfg.stores.find(s => String(s.storeKey).toUpperCase() === String(key).toUpperCase());
}
function storesForGroups(cfg, groups) {
  const seen = new Set();
  const stores = [];
  for (const groupKey of groups) {
    const keyName = String(groupKey || '').toUpperCase();
    const groupStores = keyName === 'ALL'
      ? (cfg.stores || []).filter(s => s.enabled !== false).map(s => s.storeKey)
      : (cfg.groups?.[keyName] || []);
    for (const storeKey of groupStores) {
      const key = String(storeKey).toUpperCase();
      if (seen.has(key)) continue;
      const store = storeByKey(cfg, key);
      if (store) {
        seen.add(key);
        stores.push(store);
      }
    }
  }
  return stores;
}
function ownerLookup(cfg) {
  const map = new Map();
  for (const group of cfg.ownerGroups || []) {
    const owner = {...group, color: cleanColor(group.color)};
    for (const storeKey of group.stores || []) map.set(String(storeKey).toUpperCase(), owner);
  }
  return map;
}
function includeBefore(item, asOfSec) {
  const t = String(item.orderCreateTime || item.allocateTimeFull || item.allocateTime || '');
  const m = t.match(/\d{4}-\d{2}-\d{2}[ T](\d{1,2}:\d{2}(?::\d{2})?)/);
  return !m || seconds(m[1]) <= asOfSec;
}
function itemOrderKey(item) { return item.orderNo || item.orderId || item.orderSn || item.orderCode || ''; }
function itemSku(item) {
  const raw = String(item.goodsSn || item.skuSn || item.skuCode || item.skcName || '').trim();
  return normalizeGoodsSn(raw, {goodsTitle: item.goodsTitle}) || raw || '未识别货号';
}
function summarizeCoverage(rows) {
  const total = rows.length;
  const ready = rows.filter(r => !r.missing).length;
  const missing = rows.filter(r => r.missing).map(r => r.storeKey);
  return {total, ready, missing, text: `${ready}/${total} 店`};
}
function addProduct(productMap, sku, storeRow, qty, sar, orderKey) {
  const row = productMap.get(sku) || {sku, qty: 0, sar: 0, orders: new Set(), stores: new Set()};
  row.qty += qty;
  row.sar = round2(row.sar + sar);
  if (orderKey) row.orders.add(orderKey);
  row.stores.add(storeRow.storeKey);
  productMap.set(sku, row);
}
async function daySummary(cfg, stores, date, {asOfSec = null} = {}) {
  const owners = ownerLookup(cfg);
  const rows = [];
  const products = new Map();
  const fetchTimes = [];
  for (const store of stores) {
    const owner = owners.get(String(store.storeKey).toUpperCase()) || OWNER_FALLBACK;
    const row = {
      storeKey: store.storeKey,
      group: store.groupKey || store.group || '',
      companyName: store.companyName || '',
      ownerKey: owner.key,
      ownerName: owner.name,
      ownerColor: cleanColor(owner.color),
      sar: 0,
      rmb: 0,
      ordersSet: new Set(),
      orders: 0,
      qty: 0,
      missing: false,
      fetchTime: null,
    };
    const {missingFile, obj} = await readStoreDay(store.storeKey, date);
    const goodsRows = Array.isArray(obj.goodsRows) ? obj.goodsRows : [];
    row.missing = missingFile || (!obj.summary && !goodsRows.length);
    row.fetchTime = obj.fetchTime || null;
    if (obj.fetchTime) fetchTimes.push(obj.fetchTime);

    if (goodsRows.length) {
      for (const item of goodsRows) {
        if (!isValidSalesGoodsRow(item)) continue;
        if (asOfSec !== null && !includeBefore(item, asOfSec)) continue;
        const qty = salesQuantity(item);
        const sar = salesAmountSar(item);
        if (qty <= 0 || sar <= 0) continue;
        row.sar = round2(row.sar + sar);
        row.qty += qty;
        const orderKey = itemOrderKey(item);
        if (orderKey) row.ordersSet.add(orderKey);
        if (store.productStatsEnabled !== false) addProduct(products, itemSku(item), row, qty, sar, orderKey);
      }
      row.orders = row.ordersSet.size;
    } else if (obj.summary) {
      row.sar = round2(obj.summary.salesSar || 0);
      row.orders = Number(obj.summary.positiveAmountOrderCount || 0);
      row.qty = Number(obj.summary.quantityPositiveAmount || 0);
    }
    row.rmb = round2(row.sar * FX);
    rows.push(row);
  }
  const totalSar = round2(rows.reduce((sum, r) => sum + r.sar, 0));
  const productRows = [...products.values()].map(p => ({...p, orders: p.orders.size, stores: p.stores.size}))
    .sort((a, b) => b.qty - a.qty || b.sar - a.sar || a.sku.localeCompare(b.sku, 'zh-CN'));
  return {
    date,
    rows: rows.map(({ordersSet, ...r}) => r),
    totalSar,
    totalRmb: round2(totalSar * FX),
    orders: rows.reduce((sum, r) => sum + r.orders, 0),
    qty: rows.reduce((sum, r) => sum + r.qty, 0),
    activeProducts: productRows.filter(p => p.qty > 0).length,
    rankedStores: rows.map(({ordersSet, ...r}) => r).sort((a, b) => b.sar - a.sar || b.orders - a.orders || b.qty - a.qty || a.storeKey.localeCompare(b.storeKey)),
    rankedProducts: productRows,
    latestFetchTime: fetchTimes.map(t => new Date(t)).filter(d => Number.isFinite(d.getTime())).sort((a, b) => b - a)[0]?.toISOString() || null,
  };
}

function ownerBlocks(cfg, stores, summary) {
  const selected = new Set(stores.map(s => s.storeKey));
  const owners = [...(cfg.ownerGroups || []).map(g => ({...g, color: cleanColor(g.color)}))];
  const assigned = new Set(owners.flatMap(g => g.stores || []));
  const unassignedStores = stores.map(s => s.storeKey).filter(k => !assigned.has(k));
  if (unassignedStores.length) owners.push({...OWNER_FALLBACK, stores: unassignedStores});
  return owners.map(owner => {
    const storeKeys = (owner.stores || []).filter(k => selected.has(k));
    const rows = summary.rows.filter(r => storeKeys.includes(r.storeKey));
    const sar = round2(rows.reduce((sum, r) => sum + r.sar, 0));
    return {
      key: owner.key,
      name: owner.name,
      color: cleanColor(owner.color),
      stores: storeKeys,
      sar,
      rmb: round2(sar * FX),
      orders: rows.reduce((sum, r) => sum + r.orders, 0),
      qty: rows.reduce((sum, r) => sum + r.qty, 0),
      ready: rows.filter(r => !r.missing).length,
      total: rows.length,
    };
  }).filter(o => o.total > 0);
}

const defs = `<defs>
  <linearGradient id="hero" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fffdf8"/><stop offset=".58" stop-color="#f6f1e9"/><stop offset="1" stop-color="#efe6da"/></linearGradient>
  <linearGradient id="heroAccent" x1="0" x2="1"><stop offset="0" stop-color="#7357ff"/><stop offset="1" stop-color="#f97316"/></linearGradient>
  <linearGradient id="blue" x1="0" x2="1"><stop offset="0" stop-color="#2563eb"/><stop offset="1" stop-color="#60a5fa"/></linearGradient>
  <linearGradient id="orange" x1="0" x2="1"><stop offset="0" stop-color="#f97316"/><stop offset="1" stop-color="#fb923c"/></linearGradient>
  <linearGradient id="green" x1="0" x2="1"><stop offset="0" stop-color="#059669"/><stop offset="1" stop-color="#34d399"/></linearGradient>
  <linearGradient id="purple" x1="0" x2="1"><stop offset="0" stop-color="#7c3aed"/><stop offset="1" stop-color="#c084fc"/></linearGradient>
  <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#2f271c" flood-opacity=".09"/></filter>
  <style>
    .title{font:850 47px ${FONT_STACK};fill:#20201d;letter-spacing:-1.8px}
    .heroSub{font:500 17px ${FONT_STACK};fill:#716b62}
    .eyebrow{font:800 12px ${FONT_STACK};fill:#7357ff;letter-spacing:2.2px}
    .section{font:850 27px ${FONT_STACK};fill:#20201d;letter-spacing:-.8px}
    .note{font:500 15px ${FONT_STACK};fill:#716b62}
    .cardLabel{font:800 14px ${FONT_STACK};fill:#716b62}
    .cardNum{font:850 28px ${MONO_STACK};fill:#20201d}
    .cardSub{font:550 13px ${FONT_STACK};fill:#716b62}
    .rowLabel{font:780 15.5px ${FONT_STACK};fill:#20201d}
    .rowMeta{font:600 12.5px ${FONT_STACK};fill:#716b62}
    .rowVal{font:850 14.5px ${MONO_STACK};fill:#20201d}
    .tiny{font:700 11.5px ${FONT_STACK};fill:#716b62}
    .mono{font:850 15px ${MONO_STACK};fill:#20201d}
  </style>
</defs>`;
function sectionTitle(x, y, title, note = '') {
  return `<text x="${x}" y="${y}" class="section">${esc(title)}</text>${note ? `<text x="${x + 360}" y="${y}" class="note">${esc(note)}</text>` : ''}`;
}
function pill(x, y, text, color, w = null) {
  const width = w || Math.max(48, String(text).length * 15 + 18);
  return `<rect x="${x}" y="${y}" width="${width}" height="24" rx="12" fill="${cleanColor(color)}" opacity=".12" stroke="${cleanColor(color)}" stroke-width="1"/>
    <text x="${x + width / 2}" y="${y + 16}" text-anchor="middle" class="tiny" style="fill:${cleanColor(color)}">${esc(text)}</text>`;
}
function kpiCard(x, y, w, label, main, sub, accent = '#2563eb') {
  return `<rect x="${x}" y="${y}" width="${w}" height="118" rx="22" fill="#fffdf8" stroke="#ded7cc" filter="url(#softShadow)"/>
    <rect x="${x}" y="${y}" width="6" height="118" rx="3" fill="${cleanColor(accent)}"/>
    <text x="${x + 22}" y="${y + 35}" class="cardLabel">${esc(label)}</text>
    <text x="${x + 22}" y="${y + 73}" class="cardNum">${esc(main)}</text>
    <text x="${x + 22}" y="${y + 99}" class="cardSub">${esc(sub)}</text>`;
}
function ownerTable(rows, {x, y, width, totalSar}) {
  const rowH = 39;
  const max = Math.max(1, ...rows.map(r => r.sar));
  let out = ''; // section title is rendered by caller
  const boxY = y + 18;
  const h = 46 + rows.length * rowH;
  out += `<rect x="${x}" y="${boxY}" width="${width}" height="${h}" rx="22" fill="#fffdf8" stroke="#ded7cc" filter="url(#softShadow)"/>`;
  out += `<text x="${x + 24}" y="${boxY + 32}" class="rowMeta">负责人 / 店铺覆盖</text><text x="${x + width - 245}" y="${boxY + 32}" class="rowMeta">销售额</text><text x="${x + width - 110}" y="${boxY + 32}" class="rowMeta">订单 / 销量</text>`;
  rows.forEach((r, i) => {
    const yy = boxY + 46 + i * rowH;
    const barW = Math.round(210 * r.sar / max);
    out += `<line x1="${x + 18}" y1="${yy - 8}" x2="${x + width - 18}" y2="${yy - 8}" stroke="#f1f5f9"/>
      <circle cx="${x + 30}" cy="${yy + 8}" r="7" fill="${r.color}"/>
      <text x="${x + 48}" y="${yy + 13}" class="rowLabel">${esc(r.name)}</text>
      <text x="${x + 116}" y="${yy + 13}" class="rowMeta">${r.ready}/${r.total} 店｜${pct(r.sar, totalSar)}</text>
      <rect x="${x + 248}" y="${yy}" width="210" height="14" rx="7" fill="#eee7dc"/>
      <rect x="${x + 248}" y="${yy}" width="${barW}" height="14" rx="7" fill="${r.color}"/>
      <text x="${x + width - 245}" y="${yy + 13}" class="rowVal">${money(r.sar)}</text>
      <text x="${x + width - 110}" y="${yy + 13}" class="rowMeta">${int(r.orders)} / ${int(r.qty)}</text>`;
  });
  return {svg: out, height: h + 32};
}
function storeRanking(rows, {x, y, width, title, note, maxRows = rows.length}) {
  const visible = rows.slice(0, maxRows);
  const rowH = 35;
  const max = Math.max(1, ...visible.map(r => r.sar));
  let out = sectionTitle(x, y, title, note);
  const boxY = y + 18;
  const h = 48 + visible.length * rowH;
  out += `<rect x="${x}" y="${boxY}" width="${width}" height="${h}" rx="22" fill="#fffdf8" stroke="#ded7cc" filter="url(#softShadow)"/>`;
  out += `<text x="${x + 24}" y="${boxY + 32}" class="rowMeta">店铺</text><text x="${x + 128}" y="${boxY + 32}" class="rowMeta">负责人</text><text x="${x + width - 300}" y="${boxY + 32}" class="rowMeta">销售额 / 订单 / 销量</text>`;
  visible.forEach((r, i) => {
    const yy = boxY + 48 + i * rowH;
    const barX = x + 245;
    const barW = width - 563;
    const bw = Math.max(r.sar > 0 ? 4 : 0, Math.round(barW * r.sar / max));
    out += `<line x1="${x + 18}" y1="${yy - 9}" x2="${x + width - 18}" y2="${yy - 9}" stroke="#f8fafc"/>
      <text x="${x + 24}" y="${yy + 13}" class="rowLabel">${String(i + 1).padStart(2, '0')} ${esc(r.companyName ? `${r.storeKey} · ${r.companyName}` : r.storeKey)}</text>
      ${pill(x + 108, yy - 6, r.ownerName || '未分配', r.ownerColor || '#64748b', 92)}
      <rect x="${barX}" y="${yy}" width="${barW}" height="14" rx="7" fill="#eee7dc"/>
      <rect x="${barX}" y="${yy}" width="${bw}" height="14" rx="7" fill="${r.ownerColor || '#64748b'}"/>
      <text x="${x + width - 300}" y="${yy + 13}" class="rowVal">${money(r.sar)} SAR｜${int(r.orders)} 单｜${int(r.qty)} 件</text>`;
  });
  return {svg: out, height: h + 34};
}
function productRanking(rows, {x, y, width, title, note, maxRows = 12}) {
  const visible = rows.slice(0, maxRows);
  const rowH = 37;
  const max = Math.max(1, ...visible.map(r => r.qty));
  let out = sectionTitle(x, y, title, note);
  const boxY = y + 18;
  const h = 48 + visible.length * rowH;
  out += `<rect x="${x}" y="${boxY}" width="${width}" height="${h}" rx="22" fill="#fffdf8" stroke="#ded7cc" filter="url(#softShadow)"/>`;
  out += `<text x="${x + 24}" y="${boxY + 32}" class="rowMeta">标准货号</text><text x="${x + width - 330}" y="${boxY + 32}" class="rowMeta">销量 / 销售额 / 店铺</text>`;
  visible.forEach((r, i) => {
    const yy = boxY + 48 + i * rowH;
    const barX = x + 430;
    const barW = width - 770;
    const bw = Math.max(r.qty > 0 ? 4 : 0, Math.round(barW * r.qty / max));
    out += `<line x1="${x + 18}" y1="${yy - 9}" x2="${x + width - 18}" y2="${yy - 9}" stroke="#f8fafc"/>
      <text x="${x + 24}" y="${yy + 13}" class="rowLabel">${esc(cut(`${String(i + 1).padStart(2, '0')} ${r.sku}`, 36))}</text>
      <rect x="${barX}" y="${yy}" width="${barW}" height="14" rx="7" fill="#eee7dc"/>
      <rect x="${barX}" y="${yy}" width="${bw}" height="14" rx="7" fill="url(#purple)"/>
      <text x="${x + width - 330}" y="${yy + 13}" class="rowVal">${int(r.qty)} 件｜${money(r.sar)} SAR｜${int(r.stores)} 店</text>`;
  });
  if (!visible.length) out += `<text x="${x + 24}" y="${boxY + 76}" class="rowMeta">暂无产品明细数据</text>`;
  return {svg: out, height: h + 34};
}
function deltaLine(today, yesterday) {
  const diff = round2(today.totalSar - yesterday.totalSar);
  const sign = diff >= 0 ? '+' : '';
  return `${money(today.totalSar)} SAR，较昨日全天 ${sign}${money(diff)} SAR`;
}

const args = parseArgs(process.argv.slice(2));
const date = args.date || bjDate();
const ydate = prevDate(date);
const asOf = args.asOf || bjTime();
const asOfSec = seconds(asOf);
const cfg = await readJson(path.join(ROOT, 'config', 'stores.json'));
const stores = storesForGroups(cfg, args.groups);
const today = await daySummary(cfg, stores, date, {asOfSec});
const yesterdayFull = await daySummary(cfg, stores, ydate);
const ownerRows = ownerBlocks(cfg, stores, today).sort((a, b) => b.sar - a.sar || a.name.localeCompare(b.name, 'zh-CN'));
const todayCoverage = summarizeCoverage(today.rows);
const yesterdayCoverage = summarizeCoverage(yesterdayFull.rows);
const fetchText = isoToBjString(today.latestFetchTime) || '未找到今日抓取时间';
const healthColor = todayCoverage.ready === todayCoverage.total ? '#059669' : (todayCoverage.ready ? '#f97316' : '#dc2626');
const missingText = todayCoverage.missing.length ? `缺失：${todayCoverage.missing.join('、')}` : '所有店铺已有今日明细';

const width = 1280;
let cy = 40;
let body = '';
body += `<rect x="32" y="${cy}" width="1216" height="156" rx="30" fill="url(#hero)"/>`;
body += `<rect x="32" y="${cy}" width="1216" height="156" rx="30" fill="none" stroke="#ded7cc"/>`;
body += `<rect x="64" y="${cy + 34}" width="94" height="24" rx="12" fill="#ede7ff"/><text x="111" y="${cy + 51}" text-anchor="middle" class="eyebrow">BI V2</text>`;
body += `<text x="64" y="${cy + 92}" class="title">SHEIN 全店经营晨报</text>`;
body += `<rect x="1010" y="${cy + 42}" width="196" height="42" rx="21" fill="${healthColor}" opacity=".18" stroke="${healthColor}"/>
  <text x="1108" y="${cy + 69}" text-anchor="middle" style="font:850 18px ${FONT_STACK};fill:${healthColor}">覆盖 ${todayCoverage.text}</text>`;
body += `<text x="66" y="${cy + 124}" class="heroSub">${esc(date)}｜截至 ${esc(asOf.slice(0, 5))}｜最新抓取 ${esc(fetchText)}｜生成 ${esc(bjNow())}（北京时间）</text>`;
body += `<text x="66" y="${cy + 145}" class="heroSub">口径：订单创建时间｜正金额商品明细｜标准货号归并｜全店负责人分组｜1 SAR = 1.8 RMB</text>`;
cy += 196;

body += sectionTitle(48, cy, '今日最新 vs 昨日完整', '今日为截至当前时间，昨日为完整自然日；两者并列展示，不混作同一口径');
cy += 24;
const cardGap = 16;
const cardW = Math.floor((width - 96 - cardGap * 5) / 6);
const todayDelta = round2(today.totalSar - yesterdayFull.totalSar);
const todayDeltaSign = todayDelta >= 0 ? '+' : '';
const cards = [
  ['今日成交额', `${money(today.totalSar)} SAR`, `${money(today.totalRmb)} RMB`, '#7357ff'],
  ['今日订单', `${int(today.orders)} 单`, `客单 ${money(avg(today.totalSar, today.orders))} SAR`, '#f97316'],
  ['今日销量', `${int(today.qty)} 件`, `件均 ${money(avg(today.totalSar, today.qty))} SAR`, '#db2777'],
  ['昨日成交额', `${money(yesterdayFull.totalSar)} SAR`, `${money(yesterdayFull.totalRmb)} RMB`, '#20201d'],
  ['昨日订单', `${int(yesterdayFull.orders)} 单`, `销量 ${int(yesterdayFull.qty)} 件`, '#14b8a6'],
  ['今日进度', `${todayDeltaSign}${money(todayDelta)}`, `相对昨日全天`, todayDelta >= 0 ? '#059669' : '#dc2626'],
];
cards.forEach((c, i) => { body += kpiCard(48 + i * (cardW + cardGap), cy, cardW, c[0], c[1], c[2], c[3]); });
cy += 148;

body += sectionTitle(48, cy, '负责人分组概览', `全店铺 ${today.rows.length} 店｜今日总额：${deltaLine(today, yesterdayFull)}｜昨日覆盖 ${yesterdayCoverage.text}`);
cy += 36;
const owner = ownerTable(ownerRows, {x: 48, y: cy, width: 1184, totalSar: today.totalSar});
body += owner.svg;
cy += owner.height;

const todayStore = storeRanking(today.rankedStores, {x: 48, y: cy, width: 1184, title: `今日店铺排行（${today.rows.length} 店）`, note: '颜色按负责人区分，按销售额降序'});
body += todayStore.svg;
cy += todayStore.height;

const todayProducts = productRanking(today.rankedProducts, {x: 48, y: cy, width: 1184, title: '今日热卖产品 Top 12', note: '截至当前时间，给今天补货、活动和运营动作排序', maxRows: 12});
body += todayProducts.svg;
cy += todayProducts.height;

const yesterdayStore = storeRanking(yesterdayFull.rankedStores, {x: 48, y: cy, width: 1184, title: '昨日完整店铺 Top 10', note: `${ydate} 完整自然日，帮助判断今天起量情况`, maxRows: 10});
body += yesterdayStore.svg;
cy += yesterdayStore.height;

const yesterdayProducts = productRanking(yesterdayFull.rankedProducts, {x: 48, y: cy, width: 1184, title: '昨日完整产品销量 Top 12', note: '用于次日补货、活动和链接动作优先级', maxRows: 12});
body += yesterdayProducts.svg;
cy += yesterdayProducts.height;

const footerY = cy + 8;
body += `<rect x="48" y="${footerY}" width="1184" height="82" rx="22" fill="#fff7ed" stroke="#fed7aa"/>
  <text x="72" y="${footerY + 32}" style="font:800 16px ${FONT_STACK};fill:#9a3412">数据健康提示</text>
  <text x="72" y="${footerY + 58}" class="note" style="fill:#9a3412">今日覆盖 ${todayCoverage.text}；${esc(missingText)}。如出现缺失，日报图保留已成功店铺数据，不把单店失败扩散成整条中断。</text>`;
cy += 126;

const height = Math.max(1850, cy);
await fs.mkdir(OUT_DIR, {recursive: true});
const png = args.out ? path.resolve(args.out) : path.join(OUT_DIR, `daily-visual-report-${date}.png`);
const htmlFile = png.replace(/\.png$/i, '.html');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${defs}<rect width="${width}" height="${height}" fill="#f8fafc"/><circle cx="1180" cy="230" r="190" fill="#dbeafe" opacity=".65"/><circle cx="80" cy="${height - 160}" r="220" fill="#ffedd5" opacity=".8"/>${body}</svg>`;
await fs.writeFile(htmlFile, `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#f8fafc}svg{display:block}</style>${svg}`, 'utf8');
await renderPng(htmlFile, png, width, height);
console.log(JSON.stringify({
  ok: true,
  date,
  yesterday: ydate,
  asOf,
  png,
  html: htmlFile,
  width,
  height,
  todaySar: today.totalSar,
  yesterdayFullSar: yesterdayFull.totalSar,
  todayStores: today.rows.length,
  todayCoverage,
  yesterdayCoverage,
  ownerRows: ownerRows.length,
  productRows: yesterdayFull.rankedProducts.length,
}, null, 2));
