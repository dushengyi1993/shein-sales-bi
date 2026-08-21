#!/usr/bin/env node
/**
 * Build a reviewed supplier-code normalization plan from fresh, read-only
 * OpenAPI product snapshots. This script never calls a SHEIN write endpoint.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {normalizeGoodsSnDetailed} from '../lib/product_sku_normalizer.mjs';
import {inferInputVoltage, productAttributesFromSpuInfo} from '../lib/retire_supplier_code_repair_payload.mjs';
import {resolveOpenApiProductCacheDir} from '../lib/shein_openapi_product_cache.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_ATTRIBUTE_ID = 1000546;
const STATUS = {1: 'ON_SHELF', 2: 'WAIT_SHELF', 3: 'SOLD_OUT', 4: 'OUT_SHELF'};
const ACTIVE_STATUS = new Set(['ON_SHELF', 'WAIT_SHELF', 'SOLD_OUT']);

function parseArgs(argv) {
  const args = {
    inputDir: resolveOpenApiProductCacheDir({rootDir: ROOT}),
    outDir: path.join(ROOT, 'tmp', 'supplier-code-normalization'),
    linkMasterCsv: '',
    linkMasterDir: '',
    maxSnapshotAgeMinutes: 180,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--input-dir') args.inputDir = path.resolve(argv[++i]);
    else if (a === '--out-dir') args.outDir = path.resolve(argv[++i]);
    else if (a === '--link-master-csv') args.linkMasterCsv = path.resolve(argv[++i]);
    else if (a === '--link-master-dir') args.linkMasterDir = path.resolve(argv[++i]);
    else if (a === '--max-snapshot-age-minutes') args.maxSnapshotAgeMinutes = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/build_supplier_code_normalization_plan.mjs [--input-dir <product-cache-dir>] [--out-dir tmp/supplier-code-normalization]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function asArray(value) { return Array.isArray(value) ? value : (value == null ? [] : [value]); }
function clean(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}
function sha256(value) { return crypto.createHash('sha256').update(stableJson(value), 'utf8').digest('hex'); }
function stamp() { return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14); }
function relative(file) { return path.relative(ROOT, file).replace(/\\/g, '/'); }

export function splitLeadingAnnotations(value) {
  let rest = clean(value);
  const annotations = [];
  while (true) {
    const match = rest.match(/^\s*(?:（([^\uFF09]{1,20})）|\(([^)]{1,20})\))\s*/u);
    if (!match) break;
    annotations.push(clean(match[1] ?? match[2]));
    rest = rest.slice(match[0].length).trim();
  }
  return {annotations, rest};
}

function productModel(info) {
  const row = asArray(info?.productAttributeInfoList || info?.product_attribute_info_list)
    .find(item => Number(item?.attributeId ?? item?.attribute_id) === MODEL_ATTRIBUTE_ID);
  return clean(row?.attributeValue ?? row?.attribute_value);
}

function desiredPrefix(status, annotations) {
  const normalized = new Set(annotations.map(value => clean(value).toUpperCase()));
  if (ACTIVE_STATUS.has(status) && normalized.has('全')) return '（全）';
  if (status === 'OUT_SHELF' && (normalized.has('废') || normalized.has('廢'))) return '（废）';
  return '';
}

function detailIndex(data) {
  const bySpu = new Map();
  for (const result of asArray(data?.detailResults)) {
    const info = result?.info || result?.data;
    const spu = clean(info?.spuName || info?.spu_name);
    if (result?.ok && info && spu) bySpu.set(spu, info);
  }
  return bySpu;
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows) {
  const columns = ['store', 'status', 'status_name', 'spu', 'skc', 'product_model', 'current_supplier_code', 'desired_supplier_code', 'annotations', 'canonical', 'rule'];
  return `${columns.join(',')}\n${rows.map(row => columns.map(column => csvEscape(row[column])).join(',')).join('\n')}\n`;
}

function parseCsv(text) {
  const matrix = [];
  let row = [], value = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { value += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(value); value = ''; }
    else if (char === '\n') { row.push(value.replace(/\r$/, '')); matrix.push(row); row = []; value = ''; }
    else value += char;
  }
  if (value || row.length) { row.push(value); matrix.push(row); }
  const header = matrix.shift() || [];
  return matrix.filter(values => values.some(Boolean)).map(values => Object.fromEntries(header.map((key, index) => [key, values[index] || ''])));
}

async function loadWarehouseStatusIndex(file) {
  if (!file) return new Map();
  const rows = parseCsv(await fs.readFile(file, 'utf8'));
  return new Map(rows.map(row => [`${clean(row.store_key).toUpperCase()}|${clean(row.skc)}`, clean(row.shelf_status)]));
}

async function loadLiveLinkIndex(dir) {
  const out = new Map();
  if (!dir) return out;
  const stores = (await fs.readdir(dir, {withFileTypes: true})).filter(entry => entry.isDirectory());
  for (const entry of stores) {
    const storeDir = path.join(dir, entry.name);
    const files = (await fs.readdir(storeDir)).filter(name => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name)).sort().reverse();
    if (!files.length) continue;
    const data = JSON.parse(await fs.readFile(path.join(storeDir, files[0]), 'utf8'));
    for (const row of asArray(data?.linkRows)) {
      const store = clean(row?.storeKey || data?.store?.storeKey || entry.name).toUpperCase();
      const skc = clean(row?.skc);
      if (!store || !skc) continue;
      out.set(`${store}|${skc}`, {
        status: clean(row?.shelfStatus),
        supplierCode: clean(row?.rawGoodsSn || row?.raw_goods_sn || row?.standardGoodsSn || row?.standard_goods_sn),
        fetchTime: clean(data?.fetchTime),
        sourceFile: relative(path.join(storeDir, files[0])),
      });
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const generatedAt = new Date().toISOString();
  const stores = (await fs.readdir(args.inputDir, {withFileTypes: true}))
    .filter(entry => entry.isDirectory()).map(entry => entry.name.toUpperCase()).sort();
  const candidates = [];
  const blockers = [];
  const snapshotEvidence = [];
  const seen = new Set();
  const inputVoltageByTarget = {};
  const warehouseStatus = await loadWarehouseStatusIndex(args.linkMasterCsv);
  const liveLinkStatus = await loadLiveLinkIndex(args.linkMasterDir);

  for (const store of stores) {
    const file = path.join(args.inputDir, store, 'latest.json');
    let data;
    try { data = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
    catch (error) {
      blockers.push({store, reason: 'missing_or_invalid_openapi_snapshot', error: clean(error?.message || error)});
      continue;
    }
    const fetchedAt = clean(data.fetchedAt);
    const ageMinutes = fetchedAt ? (Date.now() - Date.parse(fetchedAt)) / 60000 : Infinity;
    snapshotEvidence.push({store, file: relative(file), fetchedAt, ageMinutes: Math.round(ageMinutes * 10) / 10, summary: data.summary || null});
    if (!Number.isFinite(ageMinutes) || ageMinutes > args.maxSnapshotAgeMinutes) {
      blockers.push({store, reason: 'stale_openapi_snapshot', fetchedAt, ageMinutes});
      continue;
    }
    const details = detailIndex(data);
    for (const row of asArray(data.normalizedRows)) {
      const key = `${store}|${clean(row?.skc)}`;
      const liveStatusCode = Number(row?.shelfStatusCode);
      const liveLink = liveLinkStatus.get(key) || null;
      const warehouseRowStatus = liveLink?.status || warehouseStatus.get(key) || '';
      let status = liveLink?.status || STATUS[liveStatusCode] || '';
      if (!liveLink && liveStatusCode === 0) {
        if (['WAIT_SHELF', 'SOLD_OUT', 'OUT_SHELF'].includes(warehouseRowStatus)) status = warehouseRowStatus;
        else {
          blockers.push({store, spu: clean(row?.spu), skc: clean(row?.skc), current_supplier_code: clean(row?.supplierCode), live_status_code: liveStatusCode, warehouse_status: warehouseRowStatus, reason: 'inactive_live_status_not_safely_classified'});
          continue;
        }
      }
      if (!status) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      const spu = clean(row?.spu);
      const skc = clean(row?.skc);
      const current = clean(row?.supplierCode);
      const info = details.get(spu);
      if (!info || !current) {
        blockers.push({store, status, spu, skc, current_supplier_code: current, reason: info ? 'missing_live_supplier_code' : 'missing_live_spu_detail'});
        continue;
      }
      if (liveLink?.supplierCode && liveLink.supplierCode !== current) {
        blockers.push({store, status, spu, skc, openapi_supplier_code: current, browser_supplier_code: liveLink.supplierCode, reason: 'supplier_code_source_mismatch'});
        continue;
      }
      const model = productModel(info);
      const {annotations, rest} = splitLeadingAnnotations(current);
      const normalized = normalizeGoodsSnDetailed(rest, {goodsTitle: clean(row?.productNameEn || row?.productNameAr)});
      let canonical = normalized.matched ? clean(normalized.canonical) : rest;
      let rule = normalized.matched ? 'configured_alias' : (annotations.length ? 'strip_annotation_only' : 'unchanged_unmapped');
      if (model.toUpperCase() === 'BHRL-13' && canonical === 'BHRL-09激光脱毛仪') {
        canonical = 'BHRL-13激光脱毛仪';
        rule = 'product_model_BHRL-13_override';
      }
      const explicitlyConfiguredAlias = normalized.matched && normalized.source !== 'config/product_catalog.json:prefix_model_descriptor';
      if (rule === 'unchanged_unmapped') continue;
      if (!canonical || normalized.ignored || (normalized.needsReview && normalized.matched && !explicitlyConfiguredAlias && rule !== 'product_model_BHRL-13_override')) {
        blockers.push({store, status, spu, skc, product_model: model, current_supplier_code: current, cleaned_supplier_code: rest, reason: normalized.reviewReason || 'supplier_code_not_safe_to_normalize'});
        continue;
      }
      const desired = `${desiredPrefix(status, annotations)}${canonical}`;
      if (desired === current) continue;
      candidates.push({
        store,
        status,
        status_name: row.shelfStatusName || '',
        fetched_at: fetchedAt,
        spu,
        skc,
        product_model: model,
        current_supplier_code: current,
        desired_supplier_code: desired,
        annotations: annotations.join(' / '),
        canonical,
        rule,
      });
      const inferredVoltage = inferInputVoltage(productAttributesFromSpuInfo(info));
      if (inferredVoltage?.attribute_extra_value) {
        inputVoltageByTarget[`${store}|${skc}`] = {
          attribute_extra_value: inferredVoltage.attribute_extra_value,
          source: `live_openapi_spu_info:${store}:${spu}:attribute_${inferredVoltage.source_attribute_id || 'voltage'}`,
          source_value: inferredVoltage.source_value || '',
          fetched_at: fetchedAt,
        };
      }
    }
  }

  candidates.sort((a, b) => a.store.localeCompare(b.store) || a.status.localeCompare(b.status) || a.skc.localeCompare(b.skc));
  const planCore = {
    schemaVersion: 'supplier-code-normalization-plan/v1',
    rules: {
      activeKeepFullPrefix: true,
      outShelfKeepWastePrefix: true,
      stripOtherLeadingAnnotations: true,
      annotatedAliasesParticipateInNormalization: true,
      modelOverrides: {'BHRL-13|BHRL-09激光脱毛仪': 'BHRL-13激光脱毛仪'},
    },
    attributeEvidence: {
      inputVoltageByTarget,
      inputCurrentByCanonical: {
        'SK-777碎冰机和刨冰机': {
          attribute_extra_value: '1.36',
          attribute_value_id: 304301999,
          unit: 'A',
          derivation: '300W / 220V = 1.36A maximum across the declared 220-240V range',
          source: 'https://www.sokany.com/sokany-sk-777-vertical-ice-crusher-260w-silent-motor-500g-50db-auto-led.html',
          sourceType: 'manufacturer_specification',
        },
      },
    },
    candidates,
  };
  const planHash = sha256(planCore);
  const countsByStatus = Object.fromEntries(Object.values(STATUS).map(status => [status, candidates.filter(row => row.status === status).length]));
  const countsByRule = Object.fromEntries([...new Set(candidates.map(row => row.rule))].sort().map(rule => [rule, candidates.filter(row => row.rule === rule).length]));
  const output = {
    ...planCore,
    generatedAt,
    planHash,
    planHashAlgorithm: 'sha256-stable-json-v1',
    summary: {stores: stores.length, candidates: candidates.length, blockers: blockers.length, countsByStatus, countsByRule},
    blockers,
    snapshotEvidence,
    safety: {readOnly: true, writeEndpointsCalled: [], executeRequiresNewPayloadHash: true},
  };
  const runDir = path.join(args.outDir, `${stamp()}-live-plan`);
  await fs.mkdir(runDir, {recursive: true});
  await fs.writeFile(path.join(runDir, 'normalization-plan.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(runDir, 'normalization-review.csv'), toCsv(candidates), 'utf8');
  await fs.writeFile(path.join(runDir, 'normalization-blockers.json'), `${JSON.stringify(blockers, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ok: blockers.length === 0 && candidates.length > 0, outDir: relative(runDir), planHash, summary: output.summary, blockers: blockers.slice(0, 20)}, null, 2));
  process.exit(blockers.length === 0 && candidates.length > 0 ? 0 : 2);
}

main().catch(error => { console.error(error?.stack || error?.message || String(error)); process.exit(1); });
