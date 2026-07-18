#!/usr/bin/env node
/**
 * Read-only SHEIN finance check-order collector.
 *
 * The finance list endpoint accepts at most seven calendar days per request.
 * This collector splits wider ranges, fetches every detail, and writes an
 * immutable artifact. It never changes SHEIN or PostgreSQL.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SheinOpenApiClient, SHEIN_OPENAPI_BASE_URLS} from '../lib/shein_openapi_client.mjs';
import {
  asArray,
  dateWindows,
  financeDetailInfo,
  financeListRows,
  financeListTotal,
  mapFinanceCheckOrder,
} from '../lib/shein_finance_check_orders.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    config: path.join(ROOT, 'config', 'shein_openapi.local.json'),
    outDir: path.join(ROOT, 'outputs', 'shein_openapi_finance'),
    pageSize: 30,
    store: '',
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') args.config = path.resolve(argv[++i]);
    else if (arg === '--date') args.start = args.end = argv[++i];
    else if (arg === '--start') args.start = argv[++i];
    else if (arg === '--end') args.end = argv[++i];
    else if (arg === '--out-dir') args.outDir = path.resolve(argv[++i]);
    else if (arg === '--page-size') args.pageSize = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/fetch_shein_openapi_finance_check_orders.mjs DL --start 2026-07-01 --end 2026-07-18');
      process.exit(0);
    } else rest.push(arg);
  }
  args.store = String(rest[0] || '').trim().toUpperCase();
  if (!args.store || !args.start) throw new Error('store and --date/--start are required');
  if (!args.end) args.end = args.start;
  args.pageSize = Math.max(1, Math.min(30, Number.isFinite(args.pageSize) ? Math.trunc(args.pageSize) : 30));
  return args;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function fetchWindow(client, window, pageSize) {
  const rows = [];
  let total = 0;
  for (let page = 1; page < 1000; page += 1) {
    const response = await client.request('/open-api/finance/get-check-order-list', {
      body: {
        startAddTime: `${window.start} 00:00:00`,
        endAddTime: `${window.end} 23:59:59`,
        page,
        pageSize,
      },
    });
    if (String(response.data?.code) !== '0') {
      throw new Error(`finance list ${window.start}..${window.end} failed: code=${response.data?.code} msg=${response.data?.msg}`);
    }
    const pageRows = financeListRows(response.data);
    total = financeListTotal(response.data, rows.length + pageRows.length);
    rows.push(...pageRows);
    if (!pageRows.length || rows.length >= total || pageRows.length < pageSize) break;
  }
  return {window, total, rows};
}

async function fetchDetail(client, checkOrderNo) {
  const response = await client.request('/open-api/finance/get-check-order-detail', {
    method: 'GET',
    query: {checkOrderNo},
  });
  if (String(response.data?.code) !== '0') {
    throw new Error(`finance detail ${checkOrderNo} failed: code=${response.data?.code} msg=${response.data?.msg}`);
  }
  return financeDetailInfo(response.data);
}

export async function collectFinanceCheckOrders(args, {config, client} = {}) {
  const effectiveConfig = config || await readJson(args.config);
  const store = asArray(effectiveConfig.stores).find((row) => String(row?.storeKey || '').toUpperCase() === args.store);
  if (!store?.enabled || !store?.openKeyId || !store?.secretKey) throw new Error(`${args.store} 未完成 SHEIN OpenAPI 授权`);
  const effectiveClient = client || new SheinOpenApiClient({
    baseUrl: effectiveConfig.apiBaseUrls?.prodSemiManaged || SHEIN_OPENAPI_BASE_URLS.prodSemiManaged,
    openKeyId: store.openKeyId,
    secretKey: store.secretKey,
    timeoutMs: Number(process.env.SHEIN_OPENAPI_FINANCE_REQUEST_TIMEOUT_MS || 45_000),
  });
  const fetchedAt = new Date().toISOString();
  const windows = [];
  for (const window of dateWindows(args.start, args.end, 7)) windows.push(await fetchWindow(effectiveClient, window, args.pageSize));
  const refs = new Map();
  for (const window of windows) {
    for (const row of window.rows) {
      const key = String(row?.checkOrderNo || '').trim();
      if (key) refs.set(key, {row, window: window.window});
    }
  }
  const orders = [];
  const items = [];
  for (const [checkOrderNo, ref] of refs) {
    const detail = await fetchDetail(effectiveClient, checkOrderNo);
    const mapped = mapFinanceCheckOrder({store, listRow: ref.row, detail, fetchedAt, sourceWindow: ref.window});
    orders.push(mapped.order);
    items.push(...mapped.items);
  }
  return {
    schemaVersion: 'shein-openapi-finance-check-orders/v1',
    storeKey: args.store,
    shopName: store.shopName || args.store,
    groupKey: store.groupKey || '',
    start: args.start,
    end: args.end,
    fetchedAt,
    requestWindows: windows.map(({window, total, rows}) => ({...window, total, fetched: rows.length})),
    summary: {
      checkOrders: orders.length,
      itemLines: items.length,
      settledCheckOrders: orders.filter(row => Number(row.check_status) === 3).length,
      nonzeroReturnExpenseLines: items.filter(row => row.return_expense_sar !== 0 || row.return_freight_subsidy_sar !== 0).length,
      returnExpenseSar: items.reduce((sum, row) => sum + row.return_expense_sar, 0),
      returnFreightSubsidySar: items.reduce((sum, row) => sum + row.return_freight_subsidy_sar, 0),
      netReturnCostSar: items.reduce((sum, row) => sum + row.net_return_cost_sar, 0),
    },
    orders,
    items,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const artifact = await collectFinanceCheckOrders(args);
  const stamp = artifact.fetchedAt.replace(/[-:.TZ]/g, '').slice(0, 14);
  const outFile = path.join(args.outDir, args.store, `${args.start}__${args.end}__${stamp}.json`);
  await fs.mkdir(path.dirname(outFile), {recursive: true});
  await fs.writeFile(outFile, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  const latestFile = path.join(args.outDir, args.store, 'latest.json');
  await fs.writeFile(latestFile, `${JSON.stringify({...artifact, artifactFile: path.relative(ROOT, outFile).replace(/\\/g, '/')}, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ok: true, storeKey: args.store, outFile: path.relative(ROOT, outFile).replace(/\\/g, '/'), summary: artifact.summary}, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error?.stack || error);
    process.exit(1);
  });
}
