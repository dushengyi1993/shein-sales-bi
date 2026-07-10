#!/usr/bin/env node
/**
 * Probe SHEIN order history availability without fetching order item details.
 *
 * This is intentionally lighter than fetch_shein_sales.mjs: it calls only
 * /gsp/orderPlus/listOrder and reads meta.count, so we can discover each
 * store's first order date before running long backfills.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {connectCdp} from '../lib/shein_browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORES_PATH = path.join(ROOT, 'config', 'stores.json');
const REPORT_DIR = path.join(ROOT, 'outputs', 'reports');
const storesConfig = JSON.parse(await fs.readFile(STORES_PATH, 'utf8'));

function parseArgs(argv) {
  const args = {
    group: 'DSY',
    from: '2024-01-01',
    to: beijingDate(),
    perPage: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--group') args.group = argv[++i].toUpperCase();
    else if (a === '--stores') args.stores = argv[++i].split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--from') args.from = argv[++i];
    else if (a === '--to') args.to = argv[++i];
    else if (a === '--per-page') args.perPage = Number(argv[++i]);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.from) || !/^\d{4}-\d{2}-\d{2}$/.test(args.to)) {
    throw new Error('Expected --from/--to as YYYY-MM-DD');
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

function selectedStores(args) {
  const enabled = storesConfig.stores.filter(s => s.enabled !== false);
  if (args.stores?.length) {
    return args.stores.map(key => {
      const store = enabled.find(s => s.storeKey.toUpperCase() === key);
      if (!store) throw new Error(`Unknown or disabled store: ${key}`);
      return store;
    });
  }
  const keys = storesConfig.groups?.[args.group];
  if (!Array.isArray(keys)) throw new Error(`Unknown group: ${args.group}`);
  return keys.map(key => enabled.find(s => s.storeKey === key)).filter(Boolean);
}

function localDateTimeToUtcMs(ymd, hms, utcOffsetHours) {
  const [y, m, d] = ymd.split('-').map(Number);
  const [hh, mm, ss] = hms.split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm, ss) - Number(utcOffsetHours) * 3600_000;
}

function utcMsToLocalDateTime(ms, utcOffsetHours) {
  const d = new Date(ms + Number(utcOffsetHours) * 3600_000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

function accountRangeForBusinessRange(start, end, businessUtcOffsetHours, accountUtcOffsetHours) {
  const startUtc = localDateTimeToUtcMs(start, '00:00:00', businessUtcOffsetHours);
  const endUtc = localDateTimeToUtcMs(end, '23:59:59', businessUtcOffsetHours);
  return {
    allocateTimeStart: utcMsToLocalDateTime(startUtc, accountUtcOffsetHours),
    allocateTimeEnd: utcMsToLocalDateTime(endUtc, accountUtcOffsetHours),
  };
}

function* eachMonth(startDate, endDate) {
  const start = new Date(`${startDate.slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(`${endDate.slice(0, 7)}-01T00:00:00Z`);
  while (start <= end) {
    yield `${start.getUTCFullYear()}-${pad2(start.getUTCMonth() + 1)}`;
    start.setUTCMonth(start.getUTCMonth() + 1);
  }
}

function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function clampMonthRange(month, from, to) {
  const start = `${month}-01` < from ? from : `${month}-01`;
  const endOfMonth = `${month}-${pad2(daysInMonth(month))}`;
  const end = endOfMonth > to ? to : endOfMonth;
  return {start, end};
}


async function pageFetch(send, endpoint, payload) {
  const expression = `(() => {
    const endpoint = ${JSON.stringify(endpoint)};
    const payload = ${JSON.stringify(payload)};
    return fetch(endpoint, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json;Charset=utf-8',
        'Origin-Path': '/order-management/list',
        'Origin-Url': location.origin + '/#/gsp/order-management/list',
        'build-version': '2026-04-23 11:38'
      },
      body: JSON.stringify(payload)
    }).then(async res => {
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return {status: res.status, text, json};
    });
  })()`;
  const result = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  const value = result.result.value;
  if (!value?.json) throw new Error(`Non-JSON response from ${endpoint}: ${String(value?.text || '').slice(0, 300)}`);
  if (value.json.code !== '0') throw new Error(`${endpoint} failed: code=${value.json.code} msg=${value.json.msg}`);
  return value.json;
}

async function detectAccountUtcOffset(send, store) {
  if (store.accountUtcOffsetHours !== undefined) return Number(store.accountUtcOffsetHours);
  const result = await send('Runtime.evaluate', {
    expression: `(() => {
      const text = document.body?.innerText || '';
      const m = text.match(/UTC\\s*([+-])\\s*(\\d{1,2})(?::?(\\d{2}))?/i);
      if (!m) return null;
      const sign = m[1] === '-' ? -1 : 1;
      const hours = Number(m[2] || 0);
      const minutes = Number(m[3] || 0);
      return sign * (hours + minutes / 60);
    })()`,
    returnByValue: true,
  });
  const value = result.result?.value;
  return Number.isFinite(value) ? value : 8;
}

async function countOrders(send, store, start, end, perPage, timezone) {
  const accountRange = accountRangeForBusinessRange(
    start,
    end,
    timezone.businessUtcOffsetHours,
    timezone.accountUtcOffsetHours,
  );
  const payload = {
    allocateTimeStart: accountRange.allocateTimeStart,
    allocateTimeEnd: accountRange.allocateTimeEnd,
    excludeOrderType: 5,
    tabIndex: 1,
    page: 1,
    perPage,
  };
  const resp = await pageFetch(send, '/gsp/orderPlus/listOrder', payload);
  return {
    start,
    end,
    count: Number(resp.info?.meta?.count || 0),
    returned: Array.isArray(resp.info?.data) ? resp.info.data.length : 0,
    accountQueryRange: accountRange,
  };
}

async function probeStore(store, args) {
  const {send, page, close} = await connectCdp(store.port);
  try {
    const timezone = {
      businessUtcOffsetHours: Number(storesConfig.businessUtcOffsetHours ?? 8),
      accountUtcOffsetHours: await detectAccountUtcOffset(send, store),
    };
    const months = [];
    let firstMonth = null;
    for (const month of eachMonth(args.from, args.to)) {
      const range = clampMonthRange(month, args.from, args.to);
      const probe = await countOrders(send, store, range.start, range.end, args.perPage, timezone);
      months.push({month, ...probe});
      if (!firstMonth && probe.count > 0) firstMonth = month;
      console.log(JSON.stringify({storeKey: store.storeKey, month, count: probe.count}));
    }
    let firstOrderDate = null;
    if (firstMonth) {
      const range = clampMonthRange(firstMonth, args.from, args.to);
      const startDay = Number(range.start.slice(8, 10));
      const endDay = Number(range.end.slice(8, 10));
      for (let day = startDay; day <= endDay; day++) {
        const date = `${firstMonth}-${pad2(day)}`;
        const probe = await countOrders(send, store, date, date, args.perPage, timezone);
        if (probe.count > 0) {
          firstOrderDate = date;
          break;
        }
      }
    }
    return {
      storeKey: store.storeKey,
      shopName: store.shopName,
      groupKey: store.groupKey,
      port: store.port,
      pageUrl: page.url,
      timezone,
      from: args.from,
      to: args.to,
      firstMonth,
      firstOrderDate,
      totalCount: months.reduce((sum, m) => sum + Number(m.count || 0), 0),
      months,
    };
  } finally {
    close();
  }
}

async function writeReport(report) {
  await fs.mkdir(REPORT_DIR, {recursive: true});
  const file = path.join(REPORT_DIR, `history-range-probe-${report.group || 'stores'}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(file, JSON.stringify(report, null, 2), 'utf8');
  return file;
}

const args = parseArgs(process.argv.slice(2));
const stores = selectedStores(args);
const results = [];
for (const store of stores) {
  try {
    results.push(await probeStore(store, args));
  } catch (err) {
    results.push({
      storeKey: store.storeKey,
      shopName: store.shopName,
      groupKey: store.groupKey,
      error: String(err.stack || err),
    });
  }
}
const report = {
  generatedAt: new Date().toISOString(),
  group: args.group,
  stores: stores.map(s => s.storeKey),
  from: args.from,
  to: args.to,
  results,
};
const file = await writeReport(report);

console.log(JSON.stringify({
  ok: !results.some(r => r.error),
  from: args.from,
  to: args.to,
  reportFile: path.relative(ROOT, file),
  stores: results.map(r => ({
    storeKey: r.storeKey,
    firstOrderDate: r.firstOrderDate || null,
    totalCount: r.totalCount || 0,
    error: r.error ? String(r.error).slice(0, 200) : null,
  })),
}, null, 2));
