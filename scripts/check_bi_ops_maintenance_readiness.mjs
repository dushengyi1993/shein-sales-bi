#!/usr/bin/env node
/**
 * Read-only readiness checker for SHEIN BI link-maintenance real-write work.
 *
 * This script does not call SHEIN and does not enable any write switch. It
 * answers one narrow question: do we have enough sanitized evidence to move a
 * maintenance operation beyond dry-run?
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const OPERATION_CONTRACTS = {
  retire_link: {
    label: '下架 / 归档链接',
    docId: '3001253',
    endpoint: '/open-api/goods/modify-skc-shelf',
    requiredDocKeywords: ['shelf_state'],
    requiredReadbackFields: ['shelf_state'],
    policy: '存量在售链接维护动作；必须先验证官方 schema、逐店权限包和执行后商品状态回读。',
  },
  update_title: {
    label: '改标题',
    docId: '3001810',
    endpoint: '/open-api/goods/product/partialEdit',
    requiredDocKeywords: [],
    requiredReadbackFields: ['title'],
    policy: '存量商品局部编辑动作；必须验证只改标题的最小 payload、旧值备份和标题回读。',
  },
  update_images: {
    label: '换图',
    docId: '3001810',
    endpoint: '/open-api/goods/product/partialEdit',
    requiredDocKeywords: [],
    requiredReadbackFields: ['image'],
    policy: '存量商品局部编辑动作；必须验证只换图的最小 payload、旧值备份和图片回读。',
  },
  update_inventory: {
    label: '改店铺虚拟库存',
    docId: '3001738',
    endpoint: '/open-api/stock/change-inventory/v2',
    requiredDocKeywords: [],
    requiredReadbackFields: ['stock'],
    policy: '店铺虚拟库存维护动作；必须验证库存更新 schema、逐店权限和库存查询强回读。',
  },
  update_supply_price: {
    label: '改供货价',
    docId: '3001681',
    endpoint: '/open-api/goods/update-cost',
    requiredDocKeywords: [],
    requiredReadbackFields: ['cost'],
    policy: '供货价维护动作；必须验证供货价更新 schema、逐店权限和价格强回读。',
  },
  update_product_price: {
    label: '改商品售价',
    docId: '3001407',
    endpoint: '/open-api/openapi-business-backend/product/price/save',
    requiredDocKeywords: [],
    requiredReadbackFields: ['price'],
    policy: '商品售价维护动作；必须验证售价更新 schema、逐店权限和价格强回读。',
  },
};

const SENSITIVE_KEY_RE = /(secret|token|cookie|password|passwd|authorization|openkeyid|appsecret|session|credential)/i;
const SENSITIVE_VALUE_RE = /(Bearer\s+[A-Za-z0-9._-]+|x-lt-signature|OPENAI_API_KEY|APP_SECRET|secretKey|openKeyId)/i;
const SANITIZED_META_KEYS = new Set(['cookieprovided', 'cookiehash', 'cookiesaved', 'cookieprinted']);

function parseArgs(argv) {
  const args = {
    operation: 'retire_link',
    docEvidenceFile: '',
    storeProbeFile: '',
    readbackEvidenceFile: '',
    expect: '',
    pretty: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--operation') args.operation = String(argv[++i] || '').trim();
    else if (a === '--doc-evidence') args.docEvidenceFile = path.resolve(argv[++i]);
    else if (a === '--store-probe') args.storeProbeFile = path.resolve(argv[++i]);
    else if (a === '--readback-evidence') args.readbackEvidenceFile = path.resolve(argv[++i]);
    else if (a === '--expect') args.expect = String(argv[++i] || '').trim();
    else if (a === '--pretty') args.pretty = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!OPERATION_CONTRACTS[args.operation]) {
    throw new Error(`Unsupported operation: ${args.operation}. Supported: ${Object.keys(OPERATION_CONTRACTS).join(', ')}`);
  }
  if (args.expect && !['blocked', 'schema_ready', 'pilot_ready'].includes(args.expect)) {
    throw new Error('--expect must be one of blocked, schema_ready, pilot_ready');
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/check_bi_ops_maintenance_readiness.mjs [options]

Examples:
  node scripts/check_bi_ops_maintenance_readiness.mjs --operation retire_link --expect blocked --pretty
  node scripts/check_bi_ops_maintenance_readiness.mjs \\
    --operation retire_link \\
    --doc-evidence tmp/shein-openapi-doc-detail/modify-skc-shelf.local.json \\
    --store-probe tmp/shein-openapi-maintenance/retire-link-store-probe.local.json \\
    --readback-evidence tmp/shein-openapi-maintenance/retire-link-readback.local.json \\
    --expect pilot_ready --pretty

Inputs must be sanitized JSON. This checker rejects evidence containing obvious
secret/token/cookie/password/openKeyId fields.`);
}

async function readJsonIfProvided(file) {
  if (!file) return {provided: false, json: null};
  const raw = await fs.readFile(file, 'utf8');
  const json = JSON.parse(raw);
  return {provided: true, json, file};
}

function scanSensitive(value, trail = []) {
  const hits = [];
  function walk(node, pathParts) {
    if (node == null) return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, [...pathParts, String(index)]));
      return;
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        const p = [...pathParts, k];
        if (SENSITIVE_KEY_RE.test(k) && !SANITIZED_META_KEYS.has(String(k).toLowerCase())) {
          hits.push({path: p.join('.'), reason: 'sensitive-key'});
        }
        walk(v, p);
      }
      return;
    }
    if (typeof node === 'string' && SENSITIVE_VALUE_RE.test(node)) {
      hits.push({path: pathParts.join('.'), reason: 'sensitive-value'});
    }
  }
  walk(value, trail);
  return hits;
}

function hasKeywordCheck(result, keyword) {
  return Array.isArray(result?.keywordChecks)
    && result.keywordChecks.some(x => String(x?.keyword || '').toLowerCase() === String(keyword).toLowerCase() && x.present === true);
}

function checkDocEvidence(contract, evidence) {
  const blockers = [];
  const warnings = [];
  if (!evidence.provided) {
    blockers.push('缺少官方文档详情 schema 证据：请先运行 verify_shein_openapi_doc_detail.mjs。');
    return {ok: false, blockers, warnings, summary: {provided: false}};
  }
  const sensitiveHits = scanSensitive(evidence.json);
  if (sensitiveHits.length) {
    blockers.push(`官方文档证据文件疑似包含敏感字段/值：${sensitiveHits.slice(0, 5).map(x => x.path).join(', ')}`);
  }
  const results = Array.isArray(evidence.json?.results) ? evidence.json.results : [];
  const result = results.find(x => String(x.docId || '') === String(contract.docId))
    || results.find(x => String(x.expectedEndpoint || x.endpoint || '') === contract.endpoint)
    || results[0];
  if (!result) {
    blockers.push('官方文档证据文件没有 results[]。');
    return {ok: false, blockers, warnings, summary: {provided: true, resultFound: false}};
  }
  if (result.verified !== true) blockers.push(`官方文档详情未 verified=true，当前 status=${result.status || 'unknown'}。`);
  if (String(result.endpoint || '') !== contract.endpoint) blockers.push(`官方文档 endpoint 不匹配：expected=${contract.endpoint} actual=${result.endpoint || '-'}`);
  for (const keyword of contract.requiredDocKeywords) {
    if (!hasKeywordCheck(result, keyword) && !JSON.stringify(result).toLowerCase().includes(keyword.toLowerCase())) {
      blockers.push(`官方文档 schema 未确认关键字段：${keyword}`);
    }
  }
  if (!result.requestFieldCount && !Array.isArray(result.requestFields)) {
    warnings.push('官方文档证据没有 requestFields 明细；后续实现 payload mapper 前仍需人工复核。');
  }
  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    summary: {
      provided: true,
      docId: result.docId || contract.docId,
      endpoint: result.endpoint || '',
      schemaHash: result.schemaHash || '',
      requestFieldCount: result.requestFieldCount ?? (Array.isArray(result.requestFields) ? result.requestFields.length : null),
      responseFieldCount: result.responseFieldCount ?? (Array.isArray(result.responseFields) ? result.responseFields.length : null),
    },
  };
}

function normalizeStores(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.stores)) return value.stores;
  if (Array.isArray(value?.results)) return value.results;
  return [];
}

function checkStoreProbe(contract, evidence) {
  const blockers = [];
  const warnings = [];
  if (!evidence.provided) {
    blockers.push('缺少逐店权限/接口可用性证据：需要证明该动作在目标店铺权限包内可调用。');
    return {ok: false, blockers, warnings, summary: {provided: false}};
  }
  const sensitiveHits = scanSensitive(evidence.json);
  if (sensitiveHits.length) {
    blockers.push(`逐店权限证据文件疑似包含敏感字段/值：${sensitiveHits.slice(0, 5).map(x => x.path).join(', ')}`);
  }
  const operation = String(evidence.json?.operation || evidence.json?.intent || '').trim();
  const endpoint = String(evidence.json?.endpoint || evidence.json?.path || '').trim();
  if (operation && operation !== contract.operation && operation !== '') {
    warnings.push(`逐店权限证据 operation=${operation}，请确认与当前动作一致。`);
  }
  if (endpoint && endpoint !== contract.endpoint) blockers.push(`逐店权限证据 endpoint 不匹配：expected=${contract.endpoint} actual=${endpoint}`);
  const stores = normalizeStores(evidence.json);
  if (!stores.length) blockers.push('逐店权限证据没有 stores/results 明细。');
  const badStores = stores.filter(store => !(store?.permissionVerified === true || store?.authorized === true || store?.ok === true));
  if (badStores.length) blockers.push(`仍有店铺未验证权限：${badStores.map(x => x.storeKey || x.store || '?').join(',')}`);
  const unsafeWrites = stores.filter(store => store?.actualWriteSubmitted === true || store?.sheinWriteAttempted === true);
  if (unsafeWrites.length) blockers.push('逐店权限探针证据显示已尝试真实写；该 readiness 检查只接受只读/权限探针证据。');
  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    summary: {
      provided: true,
      endpoint,
      storeCount: stores.length,
      verifiedStores: stores.filter(store => store?.permissionVerified === true || store?.authorized === true || store?.ok === true).map(x => x.storeKey || x.store || '?'),
    },
  };
}

function checkReadbackEvidence(contract, evidence) {
  const blockers = [];
  const warnings = [];
  if (!evidence.provided) {
    blockers.push('缺少执行后回读证据：需要证明写后可用强字段确认状态变化。');
    return {ok: false, blockers, warnings, summary: {provided: false}};
  }
  const sensitiveHits = scanSensitive(evidence.json);
  if (sensitiveHits.length) {
    blockers.push(`回读证据文件疑似包含敏感字段/值：${sensitiveHits.slice(0, 5).map(x => x.path).join(', ')}`);
  }
  const endpoint = String(evidence.json?.endpoint || evidence.json?.writeEndpoint || '').trim();
  if (endpoint && endpoint !== contract.endpoint) blockers.push(`回读证据写 endpoint 不匹配：expected=${contract.endpoint} actual=${endpoint}`);
  const readbackVerified = evidence.json?.readbackVerified === true
    || evidence.json?.postWriteReadbackVerified === true
    || evidence.json?.ok === true && evidence.json?.strongReadback === true;
  if (!readbackVerified) blockers.push('回读证据未标记 readbackVerified/postWriteReadbackVerified/strongReadback=true。');
  const fields = [
    ...(Array.isArray(evidence.json?.fields) ? evidence.json.fields : []),
    ...(Array.isArray(evidence.json?.readbackFields) ? evidence.json.readbackFields : []),
    ...(Array.isArray(evidence.json?.strongFields) ? evidence.json.strongFields : []),
  ].map(x => String(x).toLowerCase());
  for (const field of contract.requiredReadbackFields) {
    if (!fields.some(x => x.includes(String(field).toLowerCase()))) {
      blockers.push(`回读证据缺少强字段：${field}`);
    }
  }
  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    summary: {
      provided: true,
      endpoint,
      readbackEndpoint: evidence.json?.readbackEndpoint || evidence.json?.queryEndpoint || '',
      fields,
      readbackVerified,
    },
  };
}

function stateFromChecks(docCheck, storeCheck, readbackCheck) {
  if (!docCheck.ok) return 'blocked';
  if (!storeCheck.ok || !readbackCheck.ok) return 'schema_ready';
  return 'pilot_ready';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const contract = {...OPERATION_CONTRACTS[args.operation], operation: args.operation};
  const docEvidence = await readJsonIfProvided(args.docEvidenceFile);
  const storeProbe = await readJsonIfProvided(args.storeProbeFile);
  const readbackEvidence = await readJsonIfProvided(args.readbackEvidenceFile);
  const docCheck = checkDocEvidence(contract, docEvidence);
  const storeCheck = checkStoreProbe(contract, storeProbe);
  const readbackCheck = checkReadbackEvidence(contract, readbackEvidence);
  const state = stateFromChecks(docCheck, storeCheck, readbackCheck);
  const blockers = [...docCheck.blockers, ...storeCheck.blockers, ...readbackCheck.blockers];
  const warnings = [...docCheck.warnings, ...storeCheck.warnings, ...readbackCheck.warnings];
  const summary = {
    ok: args.expect ? state === args.expect : true,
    readinessState: state,
    operation: args.operation,
    label: contract.label,
    policy: contract.policy,
    implementationReady: docCheck.ok,
    realSubmitPilotReady: state === 'pilot_ready',
    businessEndpoint: contract.endpoint,
    blockers,
    warnings,
    checks: {
      officialDocSchema: docCheck,
      storePermissionProbe: storeCheck,
      postWriteReadback: readbackCheck,
    },
    safety: {
      readOnly: true,
      sheinBusinessWriteCalled: false,
      realWriteSwitchChanged: false,
      acceptsSecrets: false,
    },
    nextStep: state === 'blocked'
      ? '先补官方文档详情 schema 证据。'
      : state === 'schema_ready'
        ? 'schema 已可用于实现适配器草案；真实试点前还必须补逐店权限和执行后回读证据。'
        : '证据已满足进入人工评审/小范围试点讨论；仍需通过生产安全检查和真实写白名单。',
  };
  const output = args.pretty
    ? {
        ok: summary.ok,
        readinessState: summary.readinessState,
        operation: summary.operation,
        implementationReady: summary.implementationReady,
        realSubmitPilotReady: summary.realSubmitPilotReady,
        blockers: summary.blockers,
        warnings: summary.warnings,
        nextStep: summary.nextStep,
      }
    : summary;
  console.log(JSON.stringify(output, null, 2));
  if (!summary.ok) process.exit(2);
}

main().catch(err => {
  console.error(JSON.stringify({ok: false, error: err?.message || String(err), stack: err?.stack || ''}, null, 2));
  process.exit(1);
});
