#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {SheinOpenApiClient, SHEIN_OPENAPI_BASE_URLS} from '../../lib/shein_openapi_client.mjs';
import {
  formatStoreIdentityError,
  openApiIdentityToStorageIdentity,
  storeIdentityMatchesMerchantOnly,
  validateStoreIdentity,
} from '../../lib/shein_store_identity.mjs';
import {
  findActiveManualLimitedDiscount,
  loadManualLimitedDiscountRegistry,
  resolveLimitedDiscountInventoryTopUpAction,
} from '../../lib/marketing_manual_limited_discount_overrides.mjs';
import {
  assertMarketingAutomationAuthorization,
  MARKETING_AUTOMATION_ACTIONS,
} from '../../lib/marketing_automation_authorization.mjs';
import {closeWarehousePg, createWarehousePgPool} from '../../lib/warehouse_pg.mjs';
import {acquireCrossProcessTicketLock} from '../../lib/cross_process_ticket_lock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_CONFIG = process.env.SHEIN_OPENAPI_CONFIG_FILE || path.join(ROOT, 'config', 'shein_openapi.local.json');
const DEFAULT_OUT_DIR = path.join(ROOT, 'outputs', 'reports', 'manual-limited-discount-inventory');
const DEFAULT_PRICING_POLICY = path.join(ROOT, 'config', 'marketing_pricing_policy.json');
const FALLBACK_ACTIVITY_STOCK = 10;
const MANUAL_CONFIRM_TEXT = 'MANUAL_SPECIAL_LIMITED_DISCOUNT_STOCK_TOP_UP';
const AUTO_FALLBACK_CONFIRM_TEXT = 'AUTHORIZED_LIMITED_DISCOUNT_FALLBACK_STOCK_TOP_UP';
const STORE_ACCOUNT_TRUTH = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'store_account_truth.json'), 'utf8'));

function parseArgs(argv) {
  const args = {
    store: '',
    skc: '',
    config: DEFAULT_CONFIG,
    outDir: DEFAULT_OUT_DIR,
    biPortalData: path.join(ROOT, 'outputs', 'bi-portal', 'data.json'),
    maxBiAgeHours: 6,
    rescue: '',
    execute: false,
    confirm: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--store') args.store = String(argv[++i] || '').trim().toUpperCase();
    else if (arg === '--skc') args.skc = String(argv[++i] || '').trim();
    else if (arg === '--config') args.config = path.resolve(argv[++i] || '');
    else if (arg === '--out-dir') args.outDir = path.resolve(argv[++i] || '');
    else if (arg === '--bi-portal-data') args.biPortalData = path.resolve(argv[++i] || '');
    else if (arg === '--max-bi-age-hours') args.maxBiAgeHours = Number(argv[++i]);
    else if (arg === '--rescue') args.rescue = path.resolve(argv[++i] || '');
    else if (arg === '--execute') args.execute = true;
    else if (arg === '--dry-run') args.execute = false;
    else if (arg === '--confirm') args.confirm = String(argv[++i] || '').trim();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.store || !args.skc) throw new Error('Both --store and --skc are required');
  if (!Number.isFinite(args.maxBiAgeHours) || args.maxBiAgeHours <= 0) throw new Error('Invalid --max-bi-age-hours');
  return args;
}

function asArray(value) {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function buildInventoryIdempotencyKey({authorizationId, mode, store, skc, skuCode, activityStock, overwriteQuantity, validTo, sourceArtifact, retryAttempt = 1}) {
  const source = JSON.stringify({authorizationId, mode, store, skc, skuCode, activityStock, overwriteQuantity, validTo, sourceArtifact, retryAttempt});
  return `bi-marketing-inventory-${createHash('sha256').update(source).digest('hex')}`.slice(0, 120);
}

export function computePlatformOverwriteQuantity(activityStock, stockSnapshot) {
  const requiredUsable = Number(activityStock);
  const row = asArray(stockSnapshot?.rows)[0] || {};
  const locked = Math.max(0, Number(row.totalLockedQuantity || 0));
  const currentTotal = Math.max(0, Number(row.totalInventoryQuantity || 0));
  const currentUsable = Math.max(0, Number(row.totalUsableInventory || 0));
  const observedUnavailable = Math.max(locked, currentTotal - currentUsable);
  if (!Number.isInteger(requiredUsable) || requiredUsable <= 0) {
    throw new Error(`Invalid required usable inventory: ${activityStock}`);
  }
  return Math.max(currentTotal, requiredUsable + observedUnavailable);
}

function inventoryWriteLockPath(store, skc) {
  const safe = `${store}-${skc}`.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 120);
  return path.join(ROOT, 'state', 'locks', `marketing-inventory-${safe}.lock`);
}

async function loadClient(args) {
  const config = JSON.parse(await fs.readFile(args.config, 'utf8'));
  const stores = Array.isArray(config.stores)
    ? config.stores
    : Object.entries(config.stores || {}).map(([storeKey, value]) => ({storeKey, ...value}));
  const store = stores.find(row => String(row.storeKey || row.key || '').trim().toUpperCase() === args.store);
  if (!store?.openKeyId || !store?.secretKey) throw new Error(`OpenAPI credentials missing for ${args.store}`);
  const client = new SheinOpenApiClient({
    baseUrl: config.apiBaseUrls?.prodSemiManaged || SHEIN_OPENAPI_BASE_URLS.prodSemiManaged,
    openKeyId: store.openKeyId,
    secretKey: store.secretKey,
    inventoryStoreKey: args.store,
  });
  return {client, store};
}

async function assertStoreIdentity(client, configuredStore, storeKey) {
  const response = await client.request('/open-api/openapi-business-backend/query-store-info', {method: 'POST', body: {}, headers: {language: 'en'}});
  if (String(response.data?.code) !== '0') throw new Error(`store-info failed: ${response.data?.code} ${response.data?.msg || ''}`);
  const identity = validateStoreIdentity({
    store: configuredStore,
    truth: STORE_ACCOUNT_TRUTH.stores?.[storeKey],
    storageIdentity: openApiIdentityToStorageIdentity(response.data),
    href: 'openapi:/open-api/openapi-business-backend/query-store-info',
    context: 'manage_manual_limited_discount_inventory',
  });
  if (!identity.ok && !storeIdentityMatchesMerchantOnly(identity)) throw new Error(formatStoreIdentityError(identity));
  return identity;
}

function canonicalMatchKey(value) {
  return String(value || '').split(/[^\x00-\x7F]/, 1)[0].replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function shanghaiToday() {
  return new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());
}

function requireCurrentEtSnapshot(row, canonical, source) {
  const latestSnapshotDate = String(row?.operationalSnapshotDate || '').slice(0, 10);
  const today = shanghaiToday();
  if (!latestSnapshotDate || latestSnapshotDate !== today) {
    throw new Error(`${source} ET inventory snapshot is not current-day: ${canonical} latest=${latestSnapshotDate || 'missing'} today=${today}`);
  }
  return row;
}

async function queryEtInventoryFromBi(canonical, biPortalData, maxAgeHours) {
  const doc = JSON.parse(await fs.readFile(biPortalData, 'utf8'));
  const generatedAt = new Date(doc.generatedAt || doc.createdAt || '');
  const ageHours = Number.isFinite(generatedAt.getTime()) ? (Date.now() - generatedAt.getTime()) / 3600000 : Infinity;
  if (ageHours < -0.25 || ageHours > maxAgeHours) {
    throw new Error(`BI ET inventory projection is stale or invalid: generatedAt=${doc.generatedAt || ''}, ageHours=${ageHours}`);
  }
  const targetMatchKey = canonicalMatchKey(canonical);
  const rows = Array.isArray(doc.inventoryDepletion?.products) ? doc.inventoryDepletion.products : [];
  const row = rows.find(item => (
    String(item.standard_goods_sn || '').trim() === String(canonical || '').trim()
    || String(item.match_key || '').trim().toUpperCase() === targetMatchKey
  ));
  if (!row?.has_et_inventory) throw new Error(`Fresh BI projection has no ET inventory evidence for ${canonical}`);
  if (row.inventory_match_status && row.inventory_match_status !== 'matched') {
    throw new Error(`BI ET inventory is not a fresh matched fact for ${canonical}: status=${row.inventory_match_status}`);
  }
  const operationalPolicy = String(row.et_operational_stock_policy || '09_loose_only');
  const latestSnapshotDate = String(
    operationalPolicy.includes('01_full_carton_exception')
      ? row.et_box_snapshot_date
      : row.et_store_snapshot_date,
  ).slice(0, 10);
  const today = shanghaiToday();
  if (!latestSnapshotDate || latestSnapshotDate < today) {
    throw new Error(`BI ET inventory snapshot is not current-day: ${canonical} latest=${latestSnapshotDate || 'missing'} today=${today}`);
  }
  const currentSellable = row.current_sellable_quantity ?? row.et_estimated_available_qty;
  if (currentSellable === null || currentSellable === undefined || !Number.isFinite(Number(currentSellable))) {
    throw new Error(`BI ET inventory has no usable current sellable quantity for ${canonical}`);
  }
  return {
    standardGoodsSn: row.standard_goods_sn,
    matchKey: row.match_key,
    estimatedAvailableQty: Number(currentSellable),
    looseSellableQty: Number(row.et_loose_sellable_qty),
    fullCartonQty: Number(row.et_full_carton_qty),
    storeSnapshotDate: row.et_store_snapshot_date,
    boxSnapshotDate: row.et_box_snapshot_date,
    operationalSnapshotDate: latestSnapshotDate,
    operationalStockPolicy: operationalPolicy,
    evidenceSource: 'bi_portal_et_projection',
    evidencePath: path.relative(ROOT, biPortalData).replaceAll(path.sep, '/'),
    evidenceGeneratedAt: doc.generatedAt || doc.createdAt || '',
    evidenceAgeHours: Number(ageHours.toFixed(4)),
  };
}

async function queryEtInventory(canonical, biPortalData, maxBiAgeHours) {
  const pool = createWarehousePgPool();
  try {
    const result = await pool.query(`
      SELECT
        standard_goods_sn,
        match_key,
        operational_sellable_qty,
        operational_stock_policy,
        loose_sellable_qty,
        full_carton_qty,
        store_snapshot_date,
        box_snapshot_date,
        CASE
          WHEN operational_stock_policy = '09_loose_plus_01_full_carton_exception' THEN box_snapshot_date
          ELSE store_snapshot_date
        END AS operational_snapshot_date
      FROM mart.et_product_inventory_current
      WHERE match_key = dim.product_match_key($1)
         OR dim.product_canonical_sn(standard_goods_sn) = dim.product_canonical_sn($1)
      ORDER BY greatest(coalesce(store_snapshot_date, DATE '1970-01-01'), coalesce(box_snapshot_date, DATE '1970-01-01')) DESC
      LIMIT 1
    `, [canonical]);
    const row = result.rows?.[0] || null;
    const normalized = row ? {
      standardGoodsSn: row.standard_goods_sn,
      matchKey: row.match_key,
      estimatedAvailableQty: Number(row.operational_sellable_qty),
      looseSellableQty: Number(row.loose_sellable_qty),
      fullCartonQty: Number(row.full_carton_qty),
      storeSnapshotDate: row.store_snapshot_date,
      boxSnapshotDate: row.box_snapshot_date,
      operationalSnapshotDate: row.operational_snapshot_date,
      operationalStockPolicy: row.operational_stock_policy,
      evidenceSource: 'mart.et_product_inventory_current',
    } : null;
    return normalized ? requireCurrentEtSnapshot(normalized, canonical, normalized.evidenceSource) : null;
  } finally {
    await closeWarehousePg(pool);
  }
}

async function resolveEtInventory(canonical, biPortalData, maxBiAgeHours) {
  try {
    const direct = await queryEtInventory(canonical, biPortalData, maxBiAgeHours);
    if (direct) return direct;
  } catch (error) {
    const fallback = await queryEtInventoryFromBi(canonical, biPortalData, maxBiAgeHours);
    return {...fallback, directQueryError: `${error.code || error.name || 'Error'}: ${error.message}`};
  }
  return await queryEtInventoryFromBi(canonical, biPortalData, maxBiAgeHours);
}

async function findProduct(client, targetSkc) {
  for (let pageNum = 1; pageNum <= 100; pageNum += 1) {
    const response = await client.requestReadOnly('/open-api/openapi-business-backend/product/query', {
      method: 'POST',
      body: {pageNum, pageSize: 100},
      headers: {language: 'en'},
    });
    if (String(response.data?.code) !== '0') throw new Error(`product/query failed: ${response.data?.code} ${response.data?.msg || ''}`);
    const rows = asArray(response.data?.info?.data);
    const match = rows.find(row => String(row?.skcName || '').trim() === targetSkc);
    if (match) return match;
    if (rows.length < 100) break;
  }
  return null;
}

export async function resolveInventoryTarget(args) {
  if (!args.rescue) {
    const registry = await loadManualLimitedDiscountRegistry();
    const entry = findActiveManualLimitedDiscount(registry, args.store, args.skc, new Date());
    if (!entry) throw new Error(`No active manual-special registry entry for ${args.store}::${args.skc}`);
    return {
      mode: 'manual_special',
      canonical: entry.canonical,
      activityStock: entry.activityStock,
      targetPrice: entry.specialPrice,
      validTo: entry.validTo,
      sourceArtifact: entry.sourceArtifact,
      confirmText: MANUAL_CONFIRM_TEXT,
    };
  }
  const rescue = JSON.parse(await fs.readFile(args.rescue, 'utf8'));
  if (String(rescue.storeKey || '').trim().toUpperCase() !== args.store) {
    throw new Error(`Rescue store mismatch: expected ${args.store}, got ${rescue.storeKey || '(missing)'}`);
  }
  const rows = asArray(rescue.rows).filter(row => String(row?.skc || '').trim() === args.skc);
  if (rows.length !== 1) throw new Error(`Authorized fallback rescue must contain exactly one matching row; found ${rows.length}`);
  const row = rows[0];
  if (row.manualSpecialLimitedDiscount === true) {
    throw new Error('Manual-special rows must use registry mode, not authorized fallback rescue mode');
  }
  const pricingPolicy = JSON.parse(await fs.readFile(DEFAULT_PRICING_POLICY, 'utf8'));
  const configuredActivityStock = Number(pricingPolicy?.limitedDiscount?.defaultActivityStock);
  const activityStock = Number(
    row.activityStock
    ?? rescue.activityStock
    ?? (Number.isInteger(configuredActivityStock) && configuredActivityStock > 0
      ? configuredActivityStock
      : FALLBACK_ACTIVITY_STOCK),
  );
  if (!Number.isInteger(activityStock) || activityStock <= 0) throw new Error(`Invalid rescue activityStock: ${activityStock}`);
  const canonical = String(row.canonical || '').trim();
  if (!canonical) throw new Error('Authorized fallback rescue row is missing canonical');
  return {
    mode: 'authorized_auto_fallback',
    canonical,
    activityStock,
    targetPrice: Number(row.limitedDiscountPrice),
    validTo: String(rescue.endTime || ''),
    sourceArtifact: path.relative(ROOT, args.rescue).replaceAll(path.sep, '/'),
    confirmText: AUTO_FALLBACK_CONFIRM_TEXT,
  };
}

async function readPlatformStock(client, skuCodes) {
  const response = await client.request('/open-api/stock/stock-query', {
    method: 'POST',
    body: {skuCodeList: skuCodes, warehouseType: '2', invType: 'VI'},
    headers: {language: 'en'},
  });
  if (String(response.data?.code) !== '0') throw new Error(`stock-query failed: ${response.data?.code} ${response.data?.msg || ''}`);
  const rows = asArray(response.data?.info)
    .flatMap(group => asArray(group?.goodsInventory))
    .flatMap(group => asArray(group?.skuList))
    .filter(row => skuCodes.includes(String(row?.skuCode || '')));
  return {
    response: {code: response.data?.code, msg: response.data?.msg || '', traceId: response.data?.traceId || ''},
    rows: rows.map(row => ({
      skuCode: row.skuCode,
      totalInventoryQuantity: Number(row.totalInventoryQuantity),
      totalUsableInventory: Number(row.totalUsableInventory),
      totalLockedQuantity: Number(row.totalLockedQuantity),
    })),
    totalUsableInventory: rows.reduce((sum, row) => sum + Number(row.totalUsableInventory || 0), 0),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.execute) {
    throw new Error(
      'Legacy persistent marketing inventory top-up is disabled. '
      + 'Use the inventory-aware ordinary/limited-discount runner so temporary stock is restored in finally.',
    );
  }
  const target = await resolveInventoryTarget(args);
  const payloadHash = createHash('sha256').update(JSON.stringify({
    action: 'top_up_limited_discount_virtual_inventory',
    storeKey: args.store,
    skc: args.skc,
    activityStock: target.activityStock,
    target,
  })).digest('hex');
  const automationAuthorization = args.execute ? await assertMarketingAutomationAuthorization({
    action: MARKETING_AUTOMATION_ACTIONS.TOP_UP_VIRTUAL_INVENTORY,
    storeKey: args.store,
    payloadHash,
  }) : null;
  if (args.execute && args.confirm !== target.confirmText) throw new Error(`Execute requires --confirm ${target.confirmText}`);
  const et = await resolveEtInventory(target.canonical, args.biPortalData, args.maxBiAgeHours);
  const {client, store} = await loadClient(args);
  const identity = await assertStoreIdentity(client, store, args.store);
  const product = await findProduct(client, args.skc);
  if (!product) throw new Error(`OpenAPI product/query did not return ${args.store}::${args.skc}`);
  const skuCodes = [...new Set(asArray(product.skuCodeList).map(String).filter(Boolean))];
  if (skuCodes.length !== 1) throw new Error(`Guarded top-up currently requires exactly one SKU code; found ${skuCodes.length}`);
  const before = await readPlatformStock(client, skuCodes);
  const initialDecision = resolveLimitedDiscountInventoryTopUpAction({
    platformStock: before.totalUsableInventory,
    etStock: et?.estimatedAvailableQty ?? null,
    activityStock: target.activityStock,
  });
  let decision = initialDecision;
  let preWrite = null;
  let writeResponse = null;
  const writeResponses = [];
  let after = before;
  let readbackAttempts = 0;
  let idempotencyKey = '';
  const idempotencyKeys = [];
  let writeReadbackFailure = '';
  let releaseWriteLock = null;
  if (args.execute && decision.action === 'top_up_platform_virtual_stock') {
    releaseWriteLock = await acquireCrossProcessTicketLock(inventoryWriteLockPath(args.store, args.skc), {
      timeoutMs: 60_000,
      staleMs: 10 * 60_000,
      timeoutMessage: `inventory top-up lock timeout for ${args.store}::${args.skc}`,
      timeoutCode: 'MARKETING_INVENTORY_LOCK_TIMEOUT',
    });
    try {
      // Re-read while holding the per-link lock. If another authorized process
      // already raised stock, do not overwrite the newer value back down.
      preWrite = await readPlatformStock(client, skuCodes);
      decision = resolveLimitedDiscountInventoryTopUpAction({
        platformStock: preWrite.totalUsableInventory,
        etStock: et?.estimatedAvailableQty ?? null,
        activityStock: target.activityStock,
      });
      after = preWrite;
      if (decision.action === 'top_up_platform_virtual_stock') {
        for (let writeAttempt = 1; writeAttempt <= 2; writeAttempt += 1) {
          const overwriteQuantity = computePlatformOverwriteQuantity(target.activityStock, after);
          idempotencyKey = buildInventoryIdempotencyKey({
            authorizationId: automationAuthorization?.authorizationId || '',
            mode: target.mode,
            store: args.store,
            skc: args.skc,
            skuCode: skuCodes[0],
            activityStock: target.activityStock,
            overwriteQuantity,
            validTo: target.validTo,
            sourceArtifact: target.sourceArtifact,
            retryAttempt: writeAttempt,
          });
          idempotencyKeys.push(idempotencyKey);
          const response = await client.request('/open-api/stock/change-inventory/v2', {
            method: 'POST',
            body: {
              updateSkuInventoryQuantityRequests: [{
                idempotencyKey,
                skuCode: skuCodes[0],
                invType: 'VI',
                changeType: 'OVERWRITE',
                changeQuantity: overwriteQuantity,
                changeReason: target.mode === 'manual_special'
                  ? 'Restore user-approved manual special limited discount after verified ET stock guard'
                  : 'Create user-authorized automatic limited discount fallback after verified ET stock guard',
              }],
            },
            headers: {language: 'en'},
          });
          writeResponse = {writeAttempt, code: response.data?.code, msg: response.data?.msg || '', traceId: response.data?.traceId || '', info: response.data?.info || null};
          writeResponses.push(writeResponse);
          if (String(response.data?.code) !== '0' || response.data?.info?.success === false) {
            throw new Error(`change-inventory failed: ${response.data?.code} ${response.data?.msg || ''}`);
          }
          for (let attempt = 1; attempt <= 10; attempt += 1) {
            readbackAttempts += 1;
            after = await readPlatformStock(client, skuCodes);
            if (after.totalUsableInventory >= target.activityStock) break;
            if (attempt < 10) await sleep(3000);
          }
          if (after.totalUsableInventory >= target.activityStock) break;
          if (writeAttempt < 2) await sleep(3000);
        }
        if (after.totalUsableInventory < target.activityStock) {
          writeReadbackFailure = `Inventory writes returned success but readback usable inventory ${after.totalUsableInventory} < ${target.activityStock}`;
        }
      }
    } finally {
      await releaseWriteLock?.();
      releaseWriteLock = null;
    }
  }
  const ok = decision.ok && (!args.execute || decision.action !== 'top_up_platform_virtual_stock' || after.totalUsableInventory >= target.activityStock);
  const output = {
    ok,
    mode: args.execute ? 'execute' : 'dry-run',
    createdAt: new Date().toISOString(),
    storeKey: args.store,
    skc: args.skc,
    canonical: target.canonical,
    inventoryPurpose: target.mode,
    automationAuthorization,
    target: {
      price: target.targetPrice,
      activityStock: target.activityStock,
      validTo: target.validTo,
      sourceArtifact: target.sourceArtifact,
    },
    identity: {ok: identity.ok || storeIdentityMatchesMerchantOnly(identity), expectedMerchantId: identity.expectedMerchantId, actualMerchantIds: identity.actualMerchantIds || []},
    etInventory: et,
    skuCodes,
    before,
    preWrite,
    initialDecision,
    decision,
    idempotencyKey: idempotencyKey || null,
    idempotencyKeys,
    writeResponse,
    writeResponses,
    writeReadbackFailure,
    after,
    readbackAttempts,
    writeAttempted: Boolean(args.execute && decision.action === 'top_up_platform_virtual_stock'),
  };
  await fs.mkdir(args.outDir, {recursive: true});
  const prefix = target.mode === 'manual_special' ? 'manual-limited-inventory' : 'authorized-fallback-inventory';
  const out = path.join(args.outDir, `${prefix}-${args.store}-${args.skc}-${Date.now()}.json`);
  await fs.writeFile(out, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ok, out: path.relative(ROOT, out).replaceAll(path.sep, '/'), decision, etInventory: et, before: before.totalUsableInventory, after: after.totalUsableInventory}, null, 2));
  if (!ok) process.exitCode = 2;
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) await main();
