#!/usr/bin/env node
/**
 * Read-only SHEIN OpenAPI official document catalog sync.
 *
 * This script indexes the public SHEIN OpenAPI document center into a local,
 * sanitized capability inventory. It never calls SHEIN business OpenAPI
 * endpoints and never reads or writes app/store secrets.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PORTAL_HOST = 'https://openapi-portal.sheincorp.com';
const DEFAULT_OUT = path.join(ROOT, 'outputs', 'shein-openapi-doc-catalog', 'official-capabilities.latest.json');
const DEFAULT_MARKDOWN = path.join(ROOT, 'docs', 'shein-openapi-official-capability-inventory.md');
const DOC_PUBLIC_BASE = 'https://open.sheincorp.com/documents';

const CATEGORY_TYPES = Object.freeze([
  {categoryType: 1, documentKind: 'api', label: 'OpenAPI'},
  {categoryType: 2, documentKind: 'webhook', label: 'Webhook'},
]);

const INTEGRATED_READ_ENDPOINTS = new Set([
  '/open-api/openapi-business-backend/query-store-info',
  '/open-api/goods/query-site-list',
  '/open-api/msc/warehouse/list',
  '/open-api/openapi-business-backend/product/query',
  '/open-api/goods/spu-info',
  '/open-api/stock/stock-query',
  '/open-api/order/order-list',
  '/open-api/order/order-detail',
  '/open-api/return-order/list',
  '/open-api/return-order/details',
  '/open-api/finance/report-order-list',
  '/open-api/finance/get-check-order-list',
  '/open-api/finance/get-check-order-detail',
]);

const CONTROLLED_WRITE_ENDPOINTS = new Map([
  ['/open-api/goods/product/publishOrEdit', 'copy_product_draft 通过 publishOrEdit 受控发品/复制上品'],
  ['/open-api/goods/modify-skc-shelf', 'activate_link / retire_link 受控上下架'],
  ['/open-api/stock/change-inventory/v2', 'update_inventory 受控改店铺虚拟库存'],
  ['/open-api/goods/update-cost', 'update_supply_price 受控改供货价'],
  ['/open-api/openapi-business-backend/product/price/save', 'update_product_price 受控改商品售价'],
  ['/open-api/goods/product/partialEdit', 'update_title / update_images 受控局部编辑；换图仍需完整图片字段和图片 URL 转换链路'],
  ['/open-api/goods/get-certificate-rule', 'certificate_review 证书要求查询'],
  ['/open-api/goods/certificate/get-all-certificate-type-list-v2', 'certificate_review 证书资料规则查询'],
  ['/open-api/goods/upload-certificate-file', 'certificate_review 证书文件上传'],
  ['/open-api/goods/save-or-update-certificate-pool', 'certificate_review 商品证书池创建/编辑'],
  ['/open-api/goods/save-or-update-supplier-certificate', 'certificate_review 店铺证书池创建/编辑'],
  ['/open-api/goods/save-certificate-pool-skc-bind', 'certificate_review SKC 绑定证书池'],
  ['/open-api/goods-compliance/update-skc-warning-certificate', 'certificate_review / compliance 警告语维护'],
]);

const SUPPORT_ENDPOINTS = new Map([
  ['/open-api/goods/product/check-publish-permission', 'copy_product_draft 发布权限预检'],
  ['/open-api/goods/product/check-edit-permission', 'partialEdit / publishOrEdit 编辑权限预检候选'],
  ['/open-api/goods/query-document-state', '商品审核状态回读候选'],
  ['/open-api/goods/searchProduct', 'copy_product_draft / update 结果强回读候选'],
  ['/open-api/goods/query-publish-fill-in-standard', '发品字段规则查询；可用于减少类目属性缺口'],
  ['/open-api/goods/query-category-tree', '发品类目查询候选'],
  ['/open-api/goods/image-category-suggestion', '图片/文本推荐类目候选'],
  ['/open-api/goods/query-attribute-template', '发品属性模板查询；copy_product_draft 已使用同类能力'],
  ['/open-api/goods/query-brand-list', '品牌列表查询候选'],
  ['/open-api/goods/query-ip-list', '店铺可用 IP 查询候选'],
  ['/open-api/goods/query-shelf-quota', '上架额度查询候选'],
  ['/open-api/goods/product/check-supplierSku-repeated', '商家 SKU 重复检查候选'],
  ['/open-api/goods/upload-pic', '换图链路图片上传能力；需补 multipart 调用适配器'],
  ['/open-api/goods/transform-pic', '换图链路外链转 SHEIN 图片 URL 能力；需补适配器'],
  ['/open-api/goods/upload-certificate-file', '证书文件上传候选'],
  ['/open-api/goods-certificates/search', '资质证书列表候选'],
  ['/open-api/goods-certificate-schemas/detail', '资质证书填写规则候选'],
  ['/open-api/goods-certificate-files/upload', '资质证书文件上传候选'],
  ['/open-api/goods-certificates/save', '资质证书创建/编辑候选'],
  ['/open-api/goods-certificates/bind', 'SKC 绑定资质证书候选'],
]);

const HIGH_VALUE_NEXT_ENDPOINTS = new Set([
  '/open-api/goods/upload-pic',
  '/open-api/goods/transform-pic',
  '/open-api/goods/query-document-state',
  '/open-api/goods/searchProduct',
  '/open-api/goods/query-publish-fill-in-standard',
  '/open-api/goods/query-shelf-quota',
  '/open-api/order/purchase-order-infos',
  '/open-api/shipping/delivery',
  '/open-api/goods/query-sku-sales',
]);

const OUT_OF_SCOPE_CATEGORIES = new Set(['MES', '排产', '面料', 'MDP印染', '认证仓', '物流']);

function parseArgs(argv) {
  const args = {
    portalHost: DEFAULT_PORTAL_HOST,
    outPath: DEFAULT_OUT,
    markdownPath: '',
    writeDefaultMarkdown: false,
    fixtureDir: '',
    includeDetails: false,
    detailLimit: 0,
    pretty: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--portal-host') args.portalHost = String(argv[++i] || '').replace(/\/+$/, '');
    else if (a === '--out') args.outPath = path.resolve(argv[++i]);
    else if (a === '--markdown') args.markdownPath = path.resolve(argv[++i]);
    else if (a === '--write-default-markdown') {
      args.writeDefaultMarkdown = true;
      if (!args.markdownPath) args.markdownPath = DEFAULT_MARKDOWN;
    } else if (a === '--fixture-dir') args.fixtureDir = path.resolve(argv[++i]);
    else if (a === '--include-details') args.includeDetails = true;
    else if (a === '--detail-limit') args.detailLimit = Number(argv[++i] || 0);
    else if (a === '--pretty') args.pretty = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/sync_shein_openapi_doc_catalog.mjs [options]

Examples:
  node scripts/sync_shein_openapi_doc_catalog.mjs --write-default-markdown --pretty
  node scripts/bi_ops_cli.mjs official-capabilities --out tmp/catalog.json --markdown docs/shein-openapi-official-capability-inventory.md

Options:
  --out <file>                 JSON inventory output.
  --markdown <file>            Optional Markdown inventory output.
  --write-default-markdown     Write docs/shein-openapi-official-capability-inventory.md.
  --include-details            Also fetch each document detail for schema counts/hash.
  --detail-limit <n>           Limit detail fetch count; 0 means no explicit limit.
  --fixture-dir <dir>          Offline fixtures containing category1.json/category2.json.
  --pretty                     Print human-readable summary.

Safety:
  This script is read-only against the public document center. It never calls
  SHEIN business OpenAPI endpoints and never prints/saves secrets.`);
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeEndpoint(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return new URL(text).pathname;
  return text.startsWith('/') ? text : `/${text}`;
}

function docUrl(row) {
  if (row.documentKind === 'webhook') return `${DOC_PUBLIC_BASE}/msgdoc/detail/${row.docId}`;
  return `${DOC_PUBLIC_BASE}/apidoc/detail/${row.docId}`;
}

function endpointLooksWrite(row) {
  const endpoint = row.endpoint.toLowerCase();
  const name = `${row.userDocName} ${row.title}`.toLowerCase();
  if (row.documentKind === 'webhook') return false;
  if (/\/(?:query|search|get|list|detail|infos?|stock-query|order-list|order-detail|spu-info|number-list)(?:$|[/-])/i.test(endpoint)) return false;
  if (/(查询|列表|详情|获取|查找|状态|规则|额度|枚举|信息|明细)/.test(name) && !/(更新|创建|编辑|上传|绑定|确认|取消|撤回|处理|下单|回传|打印|提交|保存|修改)/.test(name)) return false;
  return /(update|save|create|modify|import|upload|submit|process|confirm|cancel|revoke|bind|change|print|place|sync|orderToShipping|review|execute|add|remove|return|sign|switch)/i.test(endpoint)
    || /(更新|创建|编辑|上传|绑定|确认|取消|撤回|处理|下单|回传|打印|提交|保存|修改|新增|签收|切换)/.test(name);
}

function classifyRisk(row, readOrWrite, projectStatus) {
  if (row.documentKind === 'webhook') return 'low';
  if (projectStatus === 'controlled_write_adapter') return 'high';
  if (/price|cost|stock|inventory|orderToShipping|place-express|confirm|return|certificate|compliance|publishOrEdit|partialEdit|modify-skc/i.test(row.endpoint)) return 'high';
  if (readOrWrite === 'write') return 'medium';
  if (/finance|order|return-order|purchase/i.test(row.endpoint)) return 'medium';
  return 'low';
}

function classify(row) {
  const endpoint = row.endpoint;
  const readOrWrite = row.documentKind === 'webhook'
    ? 'webhook'
    : (endpointLooksWrite(row) ? 'write' : 'read');
  let projectStatus = 'candidate_unimplemented';
  let owner = 'openapi_capability_registry';
  let evidence = '';
  let nextStep = '按官方 schema 做只读探针或 dry-run 适配器；未验证前不开放真实写。';

  if (row.documentKind === 'webhook') {
    projectStatus = 'webhook_candidate';
    owner = 'webhook_receiver_future';
    nextStep = '如业务需要实时通知，先设计签名校验、幂等、重放防护和事件落库，再接收回调。';
  } else if (INTEGRATED_READ_ENDPOINTS.has(endpoint)) {
    projectStatus = 'integrated_read_parallel';
    owner = 'openapi_reconciliation_layer';
    evidence = '已进入 19 店 OpenAPI 授权/探针/隔离对账或现有只读探针链路。';
    nextStep = '继续按数据域双跑对账；稳定前不替换生产事实源。';
  } else if (CONTROLLED_WRITE_ENDPOINTS.has(endpoint)) {
    projectStatus = 'controlled_write_adapter';
    owner = 'link_ops_controlled_executor';
    evidence = CONTROLLED_WRITE_ENDPOINTS.get(endpoint);
    nextStep = '保持 BI 权限、safeWriteOperations、真实写白名单、payloadHash、确认和回读/人工核销边界。';
  } else if (SUPPORT_ENDPOINTS.has(endpoint)) {
    projectStatus = HIGH_VALUE_NEXT_ENDPOINTS.has(endpoint) ? 'schema_ready_adapter_next' : 'support_candidate';
    owner = 'link_ops_executor_support';
    evidence = SUPPORT_ENDPOINTS.get(endpoint);
    nextStep = HIGH_VALUE_NEXT_ENDPOINTS.has(endpoint)
      ? '优先补最小 CLI/执行器适配：只读/上传/转换先 dry-run 或预检，真实写仍走受控任务。'
      : '作为资料检查、回读或 payload mapper 的辅助能力排期。';
  } else if (OUT_OF_SCOPE_CATEGORIES.has(row.category)) {
    projectStatus = 'official_available_out_of_current_scope';
    owner = 'future_domain_owner';
    nextStep = '当前 BI/运营主路径暂不接；若业务进入该域，再按独立 owner、权限和回读模型设计。';
  }

  const riskLevel = classifyRisk(row, readOrWrite, projectStatus);
  const authScope = row.documentKind === 'webhook'
    ? '需要开放平台回调配置；项目接入前必须做签名/幂等/重放防护。'
    : '需要开放平台应用、店铺授权 openKeyId/secretKey、IP 白名单和对应业务权限包。';
  return {
    official_available: true,
    project_status: projectStatus,
    risk_level: riskLevel,
    read_or_write: readOrWrite,
    auth_scope: authScope,
    project_owner: owner,
    project_evidence: evidence,
    cli_next_step: nextStep,
  };
}

function flattenCategoryList(payload, meta) {
  const rows = [];
  const categories = asArray(payload?.info ?? payload?.data ?? payload);
  for (const category of categories) {
    const categoryName = String(category?.categoryName || category?.name || '').trim();
    const categoryId = String(category?.id || category?.categoryId || '').trim();
    const docs = asArray(category?.apiDocVoList || category?.apiDocList || category?.docList || category?.children);
    for (const doc of docs) {
      if (!doc?.openPath) continue;
      const row = {
        docId: String(doc.id || doc.docId || doc.apiDocId || '').trim(),
        categoryType: meta.categoryType,
        documentKind: meta.documentKind,
        documentKindLabel: meta.label,
        categoryId,
        category: categoryName,
        userDocName: String(doc.userDocName || '').trim(),
        title: String(doc.title || '').trim(),
        docName: String(doc.docName || '').trim(),
        method: String(doc.method || '').trim().toUpperCase(),
        endpoint: normalizeEndpoint(doc.openPath),
        isEvaluate: doc.isEvaluate ?? null,
      };
      rows.push({...row, ...classify(row), docUrl: docUrl(row)});
    }
  }
  return rows;
}

async function fetchJson(url, {method = 'GET'} = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      accept: 'application/json, text/plain, */*',
      'user-agent': 'Mozilla/5.0 SHEIN-BI-OfficialCatalog/1.0',
      origin: 'https://open.sheincorp.com',
      referer: 'https://open.sheincorp.com/documents/apidoc/detail/3001359',
    },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = {rawTextPreview: text.slice(0, 500)};
  }
  return {status: res.status, data, bytes: Buffer.byteLength(text), url};
}

async function loadCategory(args, meta) {
  if (args.fixtureDir) {
    const file = path.join(args.fixtureDir, `category${meta.categoryType}.json`);
    return {status: 200, data: JSON.parse(await fs.readFile(file, 'utf8')), bytes: 0, url: `fixture:${file}`};
  }
  const url = `${args.portalHost}/api/apiDoc/queryAllApiDocCategoryList?categoryType=${meta.categoryType}`;
  return await fetchJson(url);
}

function flattenDocFields(value) {
  const out = [];
  function parseMaybeJson(v) {
    if (typeof v !== 'string') return v;
    const text = v.trim();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return v; }
  }
  function visit(node) {
    node = parseMaybeJson(node);
    if (node == null) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node === 'object') {
      const name = node.name ?? node.field ?? node.key ?? node.title ?? node.paramName ?? node.code ?? '';
      const type = node.type ?? node.dataType ?? node.paramType ?? '';
      const required = node.required ?? node.isRequired ?? node.require ?? node.must ?? null;
      if (name || type || required !== null) out.push({name: String(name || ''), type: String(type || ''), required});
      for (const v of Object.values(node)) {
        if (v && typeof v === 'object') visit(v);
      }
    }
  }
  visit(value);
  return out;
}

async function fetchDetail(args, row) {
  if (args.fixtureDir) return null;
  const url = `${args.portalHost}/api/apiDoc/queryApiPublishDocDetailInfoById?id=${encodeURIComponent(row.docId)}&isLatest=true`;
  const {status, data, bytes} = await fetchJson(url);
  const info = data?.info ?? data?.data?.info ?? data?.data ?? null;
  const vo = info?.apiPublishDocVo ?? info?.apiDocVo ?? {};
  const detail = info?.apiPublishDocDetailVo ?? info?.apiDocDetailVo ?? {};
  const endpoint = normalizeEndpoint(vo.openPath ?? vo.path ?? vo.url ?? row.endpoint);
  const requestFields = [
    ...flattenDocFields(detail.requestHeader),
    ...flattenDocFields(detail.queryStrings),
    ...flattenDocFields(detail.requestBody),
  ];
  const responseFields = flattenDocFields(detail.responseBody);
  return {
    fetched: true,
    status,
    bytes,
    verified: String(data?.code ?? data?.retCode ?? '') === '0' && endpoint === row.endpoint,
    endpoint,
    method: String(vo.method || row.method || '').toUpperCase(),
    schemaHash: stableHash(JSON.stringify({
      endpoint,
      method: vo.method || row.method || '',
      requestHeader: detail.requestHeader || '',
      queryStrings: detail.queryStrings || '',
      requestBody: detail.requestBody || '',
      responseBody: detail.responseBody || '',
    })),
    requestFieldCount: requestFields.length,
    responseFieldCount: responseFields.length,
  };
}

function summarize(rows) {
  const byCategory = {};
  const byStatus = {};
  const byKind = {};
  const byRisk = {};
  for (const row of rows) {
    byCategory[row.category] = (byCategory[row.category] || 0) + 1;
    byStatus[row.project_status] = (byStatus[row.project_status] || 0) + 1;
    byKind[row.read_or_write] = (byKind[row.read_or_write] || 0) + 1;
    byRisk[row.risk_level] = (byRisk[row.risk_level] || 0) + 1;
  }
  return {
    total: rows.length,
    apiCount: rows.filter(x => x.documentKind === 'api').length,
    webhookCount: rows.filter(x => x.documentKind === 'webhook').length,
    byCategory,
    byStatus,
    byReadOrWrite: byKind,
    byRisk,
  };
}

function mdEscape(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function markdownTable(rows) {
  const header = '| 分类 | docId | 名称 | 方法 | endpoint | 读/写 | 项目状态 | 风险 | CLI 下一步 |';
  const sep = '|---|---:|---|---|---|---|---|---|---|';
  const body = rows.map(row => [
    row.category,
    row.docId,
    row.userDocName || row.title,
    row.method,
    row.endpoint,
    row.read_or_write,
    row.project_status,
    row.risk_level,
    row.cli_next_step,
  ].map(mdEscape).join(' | ')).map(line => `| ${line} |`);
  return [header, sep, ...body].join('\n');
}

function generateMarkdown(inventory) {
  const lines = [];
  lines.push('# SHEIN OpenAPI 官方能力台账');
  lines.push('');
  lines.push(`> 生成时间：\`${inventory.generatedAt}\`。来源：SHEIN 开放平台公开文档中心目录接口；本文件不包含任何密钥、Cookie 或店铺授权值。`);
  lines.push('');
  lines.push('## 刷新方式');
  lines.push('');
  lines.push('```powershell');
  lines.push('node scripts/bi_ops_cli.mjs official-capabilities --write-default-markdown --pretty');
  lines.push('```');
  lines.push('');
  lines.push('## 总览');
  lines.push('');
  lines.push(`- 官方目录接口数：${inventory.summary.total}（OpenAPI ${inventory.summary.apiCount}，Webhook ${inventory.summary.webhookCount}）。`);
  lines.push(`- 项目已接只读并行层：${inventory.summary.byStatus.integrated_read_parallel || 0}。`);
  lines.push(`- 项目已接受控写适配器：${inventory.summary.byStatus.controlled_write_adapter || 0}。`);
  lines.push(`- 首批应补 adapter/schema 的官方能力：${inventory.summary.byStatus.schema_ready_adapter_next || 0}。`);
  lines.push('');
  lines.push('## 项目状态口径');
  lines.push('');
  lines.push('- `integrated_read_parallel`：已进入 19 店 OpenAPI 授权/探针/隔离双跑或现有只读探针链路，不直接覆盖生产事实源。');
  lines.push('- `controlled_write_adapter`：已有受控写适配器；真实提交仍必须经过 BI 权限、`safeWriteOperations`、真实写白名单、dry-run `payloadHash`、确认和回读/人工核销。');
  lines.push('- `schema_ready_adapter_next`：官方能力已确认，适合优先补 CLI/执行器适配，但未完成前不得承诺可真实写。');
  lines.push('- `support_candidate`：可作为资料检查、payload mapper 或回读辅助能力排期。');
  lines.push('- `candidate_unimplemented`：官方提供但项目未接；需按业务优先级设计 owner、幂等、回读和安全边界。');
  lines.push('- `official_available_out_of_current_scope`：官方提供但当前 BI/运营主路径暂不覆盖。');
  lines.push('- `webhook_candidate`：官方消息能力；接入前必须设计签名校验、幂等、重放防护和事件落库。');
  lines.push('');
  lines.push('## 分类计数');
  lines.push('');
  lines.push('| 分类 | 数量 |');
  lines.push('|---|---:|');
  for (const [category, count] of Object.entries(inventory.summary.byCategory)) {
    lines.push(`| ${mdEscape(category)} | ${count} |`);
  }
  lines.push('');
  lines.push('## 完整接口台账');
  lines.push('');
  lines.push(markdownTable(inventory.capabilities));
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceResponses = [];
  let rows = [];
  for (const meta of CATEGORY_TYPES) {
    const response = await loadCategory(args, meta);
    sourceResponses.push({
      categoryType: meta.categoryType,
      documentKind: meta.documentKind,
      status: response.status,
      bytes: response.bytes,
      url: response.url,
      code: response.data?.code ?? '',
      msg: response.data?.msg ?? '',
    });
    if (String(response.data?.code ?? '0') !== '0') {
      throw new Error(`Official category ${meta.categoryType} returned code=${response.data?.code} msg=${response.data?.msg || ''}`);
    }
    rows.push(...flattenCategoryList(response.data, meta));
  }
  rows.sort((a, b) => Number(a.categoryType) - Number(b.categoryType)
    || String(a.category).localeCompare(String(b.category), 'zh-Hans-CN')
    || String(a.docId).localeCompare(String(b.docId)));

  if (args.includeDetails) {
    const limit = args.detailLimit > 0 ? args.detailLimit : rows.length;
    let fetched = 0;
    for (const row of rows) {
      if (fetched >= limit) break;
      row.schema = await fetchDetail(args, row);
      fetched += 1;
    }
  }

  const inventory = {
    schemaVersion: 'shein-openapi-official-capability-inventory/v1',
    generatedAt: new Date().toISOString(),
    source: {
      portalHost: args.portalHost,
      publicDocBase: DOC_PUBLIC_BASE,
      categoryEndpoints: sourceResponses,
      fixtureDir: args.fixtureDir ? path.relative(ROOT, args.fixtureDir).replace(/\\/g, '/') : '',
    },
    safety: {
      readOnlyDocumentCenter: true,
      sheinBusinessOpenApiCalled: false,
      secretsRead: false,
      secretsSaved: false,
    },
    summary: summarize(rows),
    capabilities: rows,
  };
  await writeJson(args.outPath, inventory);
  if (args.markdownPath) {
    await fs.mkdir(path.dirname(args.markdownPath), {recursive: true});
    await fs.writeFile(args.markdownPath, generateMarkdown(inventory), 'utf8');
  }
  const printable = args.pretty
    ? {
        ok: true,
        savedTo: path.relative(ROOT, args.outPath).replace(/\\/g, '/'),
        markdown: args.markdownPath ? path.relative(ROOT, args.markdownPath).replace(/\\/g, '/') : '',
        summary: inventory.summary,
        priorityNext: rows
          .filter(row => row.project_status === 'schema_ready_adapter_next')
          .map(row => ({docId: row.docId, category: row.category, name: row.userDocName || row.title, method: row.method, endpoint: row.endpoint, nextStep: row.cli_next_step})),
      }
    : {ok: true, savedTo: path.relative(ROOT, args.outPath).replace(/\\/g, '/'), markdown: args.markdownPath ? path.relative(ROOT, args.markdownPath).replace(/\\/g, '/') : '', summary: inventory.summary};
  console.log(JSON.stringify(printable, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({ok: false, error: err?.message || String(err), stack: err?.stack || ''}, null, 2));
  process.exit(1);
});
