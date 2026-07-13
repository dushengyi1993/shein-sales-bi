#!/usr/bin/env node
/**
 * Serve the generated local SHEIN BI portal as a static website.
 *
 * Safe default:
 *   - binds to 127.0.0.1
 *   - serves only outputs/bi-portal
 *   - no external tunneling or firewall changes
 *
 * LAN collaboration:
 *   node scripts/serve_bi_portal.mjs --host 0.0.0.0 --port 8787
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import {SheinOpenApiClient, SHEIN_OPENAPI_BASE_URLS} from '../lib/shein_openapi_client.mjs';
import {executeUploadPic} from '../lib/openapi_adapters/upload_pic.mjs';
import {executeTransformPic} from '../lib/openapi_adapters/transform_pic.mjs';
import {
  createLoginRateLimiter,
  createSerialMutationQueue,
  isMutationMethod,
  loginRateKey,
  mutationOriginAllowed,
  portalResponseHeaders,
} from '../lib/portal_security.mjs';
import {
  formatStoreIdentityError,
  openApiIdentityToStorageIdentity,
  storeIdentityMatchesMerchantOnly,
  validateStoreIdentity,
} from '../lib/shein_store_identity.mjs';
import {
  acceptsGzip,
  readBiSectionCache,
  readBiSectionCacheAnyGeneratedAt,
  readBiSectionCacheRaw,
  readBiSectionStaleRaw,
  writeBiSectionCache,
} from '../lib/bi_section_cache.mjs';
import {
  BiOpsAgentGovernorError,
  createBiOpsAgentGovernor,
} from '../lib/bi_ops_agent_governor.mjs';
import {
  biOpsModelProfiles,
  modelProfilePublicSummary,
  selectBiOpsModelProfile,
} from '../lib/bi_ops_model_policy.mjs';
import {createConfiguredLinkOpsStoreGateway} from '../lib/link_ops_store_gateway.mjs';
import {createLinkOpsJobWorker} from '../lib/link_ops_job_worker.mjs';
import {linkOpsPayloadHash} from '../lib/link_ops_repository.mjs';
import {createOwnerKnowledgeService} from '../lib/owner_knowledge_service.mjs';
import {createOwnerKnowledgeGitPublisher} from '../lib/owner_knowledge_distribution.mjs';
import {BI_OPS_CLI_VERSION} from '../lib/partner_knowledge_cache.mjs';
import {buildPartnerCliRelease} from '../lib/partner_cli_release.mjs';
import {
  applyApprovedImageBindingsToPublishPayload,
  applyExplicitPublishPreparationOverrides,
  normalizePublishPreparationOverrides,
} from '../lib/link_ops_publish_asset_binding.mjs';
import {
  actorCanPublishOwnerKnowledge,
  isOwnerKnowledgeCandidateText,
  isOwnerKnowledgeDurableText,
} from '../lib/owner_knowledge_policy.mjs';
import {
  BI_OPS_ACTION_INTENTS,
  biOpsIntentPlanToTaskInput,
  runBiOpsIntentPlanner,
} from '../lib/bi_ops_intent_planner.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORES_PATH = path.join(ROOT, 'config', 'stores.json');
const SHEIN_OPENAPI_LOCAL_CONFIG_FILE = process.env.SHEIN_OPENAPI_CONFIG_FILE || path.join(ROOT, 'config', 'shein_openapi.local.json');
const BI_OPS_WRITE_WHITELIST_FILE = process.env.SHEIN_BI_OPS_WRITE_WHITELIST_FILE || path.join(ROOT, 'config', 'bi_ops_write_whitelist.local.json');
let partnerCliReleasePromise = null;

async function currentPartnerCliRelease() {
  if (!partnerCliReleasePromise) {
    partnerCliReleasePromise = buildPartnerCliRelease({sourceRoot: ROOT}).catch(error => {
      partnerCliReleasePromise = null;
      throw error;
    });
  }
  return await partnerCliReleasePromise;
}

function parseArgs(argv) {
  const args = {
    host: '127.0.0.1',
    port: 8787,
    dir: path.join(ROOT, 'outputs', 'bi-portal'),
    stateFile: path.join(ROOT, 'state', 'bi_action_state.json'),
    linkOpsTaskFile: path.join(ROOT, 'state', 'bi_link_ops_tasks.json'),
    linkOpsChatFile: path.join(ROOT, 'state', 'bi_link_ops_chats.json'),
    linkOpsRuntimeFile: process.env.SHEIN_LINK_OPS_RUNTIME_FILE || path.join(ROOT, 'state', 'bi_link_ops_runtime.json'),
    linkOpsAssetDir: '',
    manualLoginStateFile: process.env.SHEIN_MANUAL_LOGIN_STATE_FILE || '/srv/shein-bi/runtime/cloud_manual_login_sessions.json',
    authFile: path.join(ROOT, 'config', 'bi_users.local.json'),
    accessRolesFile: path.join(ROOT, 'config', 'bi_access_roles.json'),
    htpasswdFile: process.env.SHEIN_BI_HTPASSWD_FILE || '/srv/shein-bi/secrets/bi_basic_auth.htpasswd',
    sessionSecretFile: process.env.SHEIN_BI_SESSION_SECRET_FILE || path.join(ROOT, 'state', 'bi_portal_session_secret.local'),
    auditFile: path.join(ROOT, 'logs', 'bi_portal_action_audit.jsonl'),
    distro: 'Ubuntu-24.04',
    container: 'shein-warehouse-db',
    database: 'shein_bi',
    user: 'shein',
    readOnly: false,
    noAuth: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') args.host = argv[++i];
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--dir') args.dir = path.resolve(argv[++i]);
    else if (a === '--state-file') args.stateFile = path.resolve(argv[++i]);
    else if (a === '--link-ops-task-file') args.linkOpsTaskFile = path.resolve(argv[++i]);
    else if (a === '--link-ops-chat-file') args.linkOpsChatFile = path.resolve(argv[++i]);
    else if (a === '--link-ops-runtime-file') args.linkOpsRuntimeFile = path.resolve(argv[++i]);
    else if (a === '--link-ops-asset-dir') args.linkOpsAssetDir = path.resolve(argv[++i]);
    else if (a === '--manual-login-state-file') args.manualLoginStateFile = path.resolve(argv[++i]);
    else if (a === '--auth-file') args.authFile = path.resolve(argv[++i]);
    else if (a === '--access-roles-file') args.accessRolesFile = path.resolve(argv[++i]);
    else if (a === '--htpasswd-file') args.htpasswdFile = path.resolve(argv[++i]);
    else if (a === '--session-secret-file') args.sessionSecretFile = path.resolve(argv[++i]);
    else if (a === '--audit-file') args.auditFile = path.resolve(argv[++i]);
    else if (a === '--distro') args.distro = argv[++i];
    else if (a === '--container') args.container = argv[++i];
    else if (a === '--database') args.database = argv[++i];
    else if (a === '--user') args.user = argv[++i];
    else if (a === '--read-only') args.readOnly = true;
    else if (a === '--no-auth') args.noAuth = true;
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
    throw new Error(`Invalid --port: ${args.port}`);
  }
  if (!args.linkOpsAssetDir) {
    args.linkOpsAssetDir = path.join(path.dirname(args.linkOpsTaskFile), 'bi_link_ops_assets');
  }
  return args;
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

const LINK_OPS_MAX_UPLOAD_FILE_BYTES = 20 * 1024 * 1024;
const LINK_OPS_MAX_UPLOAD_TOTAL_BYTES = 120 * 1024 * 1024;
const OPENAPI_IMAGE_ASSET_MAX_FILE_BYTES = 3 * 1024 * 1024;
const OPENAPI_IMAGE_ASSET_ALLOWED_MIME = new Set(['image/jpeg', 'image/png']);
const OPENAPI_IMAGE_ASSET_TYPES = new Set([1, 2, 5, 6, 7]);
const DEFAULT_SHEIN_STORE_KEYS = ['DL', 'DX', 'FY', 'LQ', 'NM', 'HL', 'JY', 'ZL', 'TS', 'MZ', 'CX', 'YJ', 'XL', 'QY', 'QH', 'TZ', 'JSH', 'TZZ', 'XC'];
const DEFAULT_MANUAL_LOGIN_STORE_KEYS = ['DL', 'DX', 'FY', 'LQ', 'NM', 'HL', 'JY', 'ZL', 'TS', 'MZ', 'CX', 'YJ', 'XL', 'QY', 'QH', 'TZ', 'JSH', 'TZZ', 'XC'];
const BI_PORTAL_SECTION_KEYS = new Set(['homeProfit', 'homeRankings', 'rankings', 'profit', 'actions', 'linksData', 'productSalesDaily', 'homeTrafficDaily', 'productTrafficDaily', 'inventoryTrend', 'comments', 'orders', 'priceScatter', 'afterSales', 'rtvData', 'waybills']);
const BI_PORTAL_SECTION_TIMEOUT_MS = Math.max(60_000, Number(process.env.SHEIN_BI_SECTION_TIMEOUT_MS || 900_000));
const OPENAPI_READ_PROBE_SUMMARY_FILE = process.env.SHEIN_OPENAPI_READ_PROBE_SUMMARY_FILE
  || path.join(ROOT, 'state', 'openapi-probes', 'read-probes.latest.json');
const OPENAPI_SALES_RECONCILIATION_SUMMARY_FILE = process.env.SHEIN_OPENAPI_SALES_RECONCILIATION_SUMMARY_FILE
  || path.join(ROOT, 'state', 'openapi-probes', 'sales-reconciliation.latest.json');
const OPENAPI_RETURN_RECONCILIATION_SUMMARY_FILE = process.env.SHEIN_OPENAPI_RETURN_RECONCILIATION_SUMMARY_FILE
  || path.join(ROOT, 'state', 'openapi-probes', 'return-reconciliation.latest.json');
const OPENAPI_PRODUCT_RECONCILIATION_SUMMARY_FILE = process.env.SHEIN_OPENAPI_PRODUCT_RECONCILIATION_SUMMARY_FILE
  || path.join(ROOT, 'state', 'openapi-probes', 'product-reconciliation.latest.json');
const OPENAPI_READ_PROBE_FRESH_MS = Math.max(60_000, Number(process.env.SHEIN_OPENAPI_READ_PROBE_FRESH_MS || 14 * 24 * 60 * 60 * 1000));
const OPENAPI_SALES_RECONCILIATION_FRESH_MS = Math.max(60_000, Number(process.env.SHEIN_OPENAPI_SALES_RECONCILIATION_FRESH_MS || 14 * 24 * 60 * 60 * 1000));
const OPENAPI_RETURN_RECONCILIATION_FRESH_MS = Math.max(60_000, Number(process.env.SHEIN_OPENAPI_RETURN_RECONCILIATION_FRESH_MS || 14 * 24 * 60 * 60 * 1000));
const OPENAPI_PRODUCT_RECONCILIATION_FRESH_MS = Math.max(60_000, Number(process.env.SHEIN_OPENAPI_PRODUCT_RECONCILIATION_FRESH_MS || 14 * 24 * 60 * 60 * 1000));
const biSectionInFlight = new Map();
let biSectionBackgroundQueue = Promise.resolve();
let biProfitMartFreshnessPromise = null;
const DEFAULT_BI_PORTAL_CORE_WARMUP_SECTIONS = ['homeRankings', 'profit', 'homeProfit', 'afterSales', 'orders', 'waybills'];
const BI_PORTAL_CORE_WARMUP_INTERVAL_MS = Math.max(15_000, Number(process.env.SHEIN_BI_CORE_WARMUP_INTERVAL_MS || 60_000));
const biPortalCoreWarmupState = {
  generatedAt: '',
  status: 'idle',
  startedAt: 0,
  finishedAt: 0,
  inFlight: null,
  lastError: '',
};
const linkOpsExecutionLocks = new Set();
// Store capability must come from the same dynamic evidence for every store.
// Do not add one-store readiness fallbacks here: they make an expired shared
// probe look like an HL-only API deployment even when all stores are healthy.
const LINK_OPS_STORE_CAPABILITIES = {};
const LINK_OPS_OPENAPI_SUBMIT_CONFIRM_TEXT = 'SHEIN_OPENAPI_SUBMIT';
const BI_OPS_ACTION_INTENT_SET = new Set(BI_OPS_ACTION_INTENTS);
const LINK_OPS_PROTECTED_TASK_PATCH_FIELDS = new Set([
  'execution',
  'executionHistory',
  'lifecycle',
  'history',
  'requestMeta',
  'requestedBy',
  'requestedByUser',
  'createdAt',
  'assets',
  'writeAudit',
  'actorKey',
  'ownerKey',
  'ownership',
]);
const DEFAULT_OPENAPI_READ_DOMAINS = ['store_info', 'product', 'stock', 'order', 'return', 'finance'];
const DEFAULT_OPENAPI_WRITE_PRECHECK_DOMAINS = ['product_publish_precheck'];
const OPENAPI_READ_DOMAIN_LABELS = {
  store_info: '店铺信息',
  site_currency: '站点/币种',
  warehouse: '仓库',
  product: '商品/链接',
  stock: 'SHEIN虚拟库存',
  order: '订单',
  return: '退货退款',
  finance: '财务对账',
};
const OPENAPI_WRITE_DOMAIN_LABELS = {
  product_publish_precheck: '商品发布/编辑系统检查',
  product_status_precheck: '上下架系统检查',
  marketing_precheck: '营销报名系统检查',
};

const LINK_MAINTENANCE_INTENTS = new Set([
  'activate_link',
  'retire_link',
  'update_title',
  'update_images',
  'update_inventory',
  'update_supply_price',
  'update_product_price',
  'certificate_review',
]);
const LINK_OPS_MAINTENANCE_OFFICIAL_CANDIDATES = {
  activate_link: {
    endpoint: '/open-api/goods/modify-skc-shelf',
    label: '商品上下架',
    docUrl: 'https://open.sheincorp.com/documents/apidoc/detail/3001253',
    evidence: 'SHEIN 官方公开文档目录确认该接口为“商品上下架”；schema 字段包含 skc_site_info_list / shelf_state / site_list / skc_name，shelf_state=1 为上架。',
    missing: ['生产真实提交仍需窄范围 safeWriteOperations + 人/店/动作白名单 + 系统检查 payload hash + 回读/人工核销。'],
  },
  retire_link: {
    endpoint: '/open-api/goods/modify-skc-shelf',
    label: '商品上下架',
    docUrl: 'https://open.sheincorp.com/documents/apidoc/detail/3001253',
    evidence: 'SHEIN 官方公开文档目录确认该接口为“商品上下架”；schema 字段包含 skc_site_info_list / shelf_state / site_list / skc_name。',
    missing: ['生产真实提交仍需窄范围 safeWriteOperations + 人/店/动作白名单 + 系统检查 payload hash + 回读/人工核销。'],
  },
  update_title: {
    endpoint: '/open-api/goods/product/partialEdit',
    label: '商品局部编辑',
    docUrl: 'https://open.sheincorp.com/documents/apidoc/detail/3001810',
    evidence: 'SHEIN 官方文档索引显示存在 Product Partial Edit（商品局部编辑）接口，更适合存量链接标题维护。',
    missing: ['生产真实提交仍需窄范围 safeWriteOperations + 人/店/动作白名单 + 系统检查 payload hash + 回读/人工核销。'],
  },
  update_images: {
    endpoint: '/open-api/goods/product/partialEdit',
    label: '商品局部编辑',
    docUrl: 'https://open.sheincorp.com/documents/apidoc/detail/3001810',
    evidence: 'SHEIN 官方文档索引显示存在 Product Partial Edit（商品局部编辑）接口，更适合存量链接图片维护。',
    missing: ['换图需提供完整 SHEIN partialEdit 图片 JSON，生产真实提交仍需窄范围 safeWriteOperations + 人/店/动作白名单 + 系统检查 payload hash + 回读/人工核销。'],
  },
  update_inventory: {
    endpoint: '/open-api/stock/change-inventory/v2',
    label: '库存更新',
    docUrl: 'https://open.sheincorp.com/documents/apidoc/detail/3001738',
    evidence: 'SHEIN 官方公开文档目录确认该接口为“更新商家库存接口v2”；schema 字段包含 updateSkuInventoryQuantityRequests / skuCode / invType / changeType / changeQuantity。',
    missing: ['生产真实提交仍需窄范围 safeWriteOperations + 人/店/动作白名单 + 系统检查 payload hash + 库存回读/人工核销。'],
  },
  update_supply_price: {
    endpoint: '/open-api/goods/update-cost',
    label: '供货价更新',
    docUrl: 'https://open.sheincorp.com/documents/apidoc/detail/3001681',
    evidence: 'SHEIN 官方文档索引显示存在 Cost Price Update / 供货价更新接口。',
    missing: ['生产真实提交仍需窄范围 safeWriteOperations + 人/店/动作白名单 + 系统检查 payload hash + 回读/人工核销。'],
  },
  update_product_price: {
    endpoint: '/open-api/openapi-business-backend/product/price/save',
    label: '商品售价更新',
    docUrl: 'https://open.sheincorp.com/documents/apidoc/detail/3001407',
    evidence: 'SHEIN 官方公开文档目录确认该接口为“更新商品售价”；schema 字段包含 productPriceList / productCode / currencyCode / shopPrice / site。',
    missing: ['商品售价 API 同时写 shopPrice/specialPrice；生产真实提交仍需窄范围 safeWriteOperations + 人/店/动作白名单 + 系统检查 payload hash + 回读/人工核销。'],
  },
  certificate_review: {
    endpoint: '/open-api/goods/save-certificate-pool-skc-bind',
    label: '证书/资质维护',
    docUrl: 'https://open.sheincorp.com/documents/apidoc/detail/3001477',
    evidence: 'SHEIN 官方公开文档目录确认存在证书要求查询、证书文件上传、证书池创建/编辑、店铺证书池创建/编辑、SKC 绑定商品证书池等接口。',
    missing: ['证书动作需提供 certificatePayloads[{endpoint,body}] 且 endpoint 在证书允许列表；提交后默认人工核销审核状态，不自动判成功。'],
  },
};

const LINK_OPS_ACTION_CAPABILITY_DEFS = [
  {
    key: 'copy_product_draft',
    label: '复制上品 / 补链接',
    intent: 'copy_product_draft',
    stage: 'openapi_product_dry_run',
    precheck: true,
    realSubmit: false,
    confirmableState: 'openapi_product_preflight_ready',
    requiredConfirmText: LINK_OPS_OPENAPI_SUBMIT_CONFIRM_TEXT,
    reason: '可做 OpenAPI 商品发布/编辑 payload 系统检查；真实 publishOrEdit 只在 payload 完整、任务等你确认、显式确认文本同时满足时才会提交。',
  },
  {
    key: 'activate_link',
    label: '恢复 / 重新上架',
    intent: 'activate_link',
    stage: 'link_maintenance_dry_run',
    precheck: true,
    realSubmit: false,
    reason: '已接入官方商品上下架 OpenAPI 执行器；默认 系统检查 锁定 payload，真实上架必须命中总闸门、白名单、确认文本并完成回读/人工核销。',
  },
  {
    key: 'retire_link',
    label: '下架 / 归档链接',
    intent: 'retire_link',
    stage: 'link_maintenance_dry_run',
    precheck: true,
    realSubmit: false,
    reason: '已接入官方商品上下架 OpenAPI 执行器；默认 系统检查 锁定 payload，真实下架必须命中总闸门、白名单、确认文本并完成回读/人工核销。',
  },
  {
    key: 'update_title',
    label: '改标题',
    intent: 'update_title',
    stage: 'link_maintenance_dry_run',
    precheck: true,
    realSubmit: false,
    reason: '已接入官方商品局部编辑 OpenAPI 执行器；默认 系统检查 锁定标题 payload，真实改标题必须命中总闸门、白名单、确认文本并完成回读/人工核销。',
  },
  {
    key: 'update_images',
    label: '换图',
    intent: 'update_images',
    stage: 'link_maintenance_dry_run',
    precheck: true,
    realSubmit: false,
    reason: '已接入官方商品局部编辑 OpenAPI 执行器；换图要求提供完整 SHEIN partialEdit 图片 JSON，真实换图必须命中总闸门、白名单、确认文本并完成回读/人工核销。',
  },
  {
    key: 'update_inventory',
    label: '改店铺虚拟库存',
    intent: 'update_inventory',
    stage: 'link_maintenance_dry_run',
    precheck: true,
    realSubmit: false,
    reason: '已接入官方库存更新 OpenAPI 执行器；默认 系统检查 锁定库存 payload，真实改库存必须命中总闸门、白名单、确认文本并完成库存回读/人工核销。',
  },
  {
    key: 'update_supply_price',
    label: '改供货价',
    intent: 'update_supply_price',
    stage: 'link_maintenance_dry_run',
    precheck: true,
    realSubmit: false,
    reason: '已接入官方供货价更新 OpenAPI 执行器；默认 系统检查 锁定供货价 payload，真实改供货价必须命中总闸门、白名单、确认文本并完成回读/人工核销。',
  },
  {
    key: 'update_product_price',
    label: '改商品售价',
    intent: 'update_product_price',
    stage: 'link_maintenance_dry_run',
    precheck: true,
    realSubmit: false,
    reason: '已接入官方商品售价更新 OpenAPI 执行器；默认 系统检查 锁定售价 payload，真实改售价必须命中总闸门、白名单、确认文本并完成回读/人工核销。',
  },
  {
    key: 'campaign_signup',
    label: '营销活动报名',
    intent: 'campaign_signup',
    stage: 'task_only',
    precheck: false,
    realSubmit: false,
    reason: '官方公开 OpenAPI 目录当前无营销报名写接口证据；该动作不列入官方 API 可实现范围，继续走已有本地营销运营流程和人工确认。',
  },
  {
    key: 'flash_discount',
    label: '限时折扣',
    intent: 'flash_discount',
    stage: 'task_only',
    precheck: false,
    realSubmit: false,
    reason: '官方公开 OpenAPI 目录当前无限时折扣写接口证据；该动作不列入官方 API 可实现范围，继续走已有本地营销运营流程和人工确认。',
  },
  {
    key: 'certificate_review',
    label: '证书 / 资质',
    intent: 'certificate_review',
    stage: 'link_maintenance_dry_run',
    precheck: true,
    realSubmit: false,
    reason: '已接入官方证书/资质 OpenAPI JSON payload 执行器；真实提交仍必须命中总闸门、白名单、payload hash 和确认文本，提交后默认人工核销审核状态。',
  },
];

const LINK_OPS_REAL_SUBMIT_REQUIREMENTS = [
  '具体 BI 登录账号',
  '目标店铺写权限',
  '动作具备真实提交适配器',
  '系统检查通过',
  '任务停在等你确认状态',
  LINK_OPS_OPENAPI_SUBMIT_CONFIRM_TEXT,
  '执行后回读证据',
];

function configuredSheinStoreKeysSync() {
  try {
    const config = JSON.parse(fssync.readFileSync(STORES_PATH, 'utf8'));
    const stores = Array.isArray(config?.stores) ? config.stores : [];
    const storeKeys = stores
      .filter(s => s && s.enabled !== false && s.storeKey)
      .map(s => String(s.storeKey || '').trim().toUpperCase())
      .filter(Boolean);
    const groupKeys = Object.keys(config?.groups || {})
      .map(k => String(k || '').trim().toUpperCase())
      .filter(Boolean);
    return new Set([...DEFAULT_SHEIN_STORE_KEYS, ...storeKeys, ...groupKeys]);
  } catch {
    return new Set(DEFAULT_SHEIN_STORE_KEYS);
  }
}

const SHEIN_STORE_KEYS = configuredSheinStoreKeysSync();
const LINK_OPS_ALLOWED_UPLOAD_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/json',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const CLOUD_AI_MEMORY_TTL_MS = Math.max(0, Number(process.env.SHEIN_CLOUD_AI_MEMORY_TTL_MS || 0));
const CLOUD_AI_MEMORY_POLICY = Object.freeze({
  ttlMs: CLOUD_AI_MEMORY_TTL_MS,
  ttlHours: CLOUD_AI_MEMORY_TTL_MS ? Number((CLOUD_AI_MEMORY_TTL_MS / 3600000).toFixed(2)) : null,
  storage: 'raw_full_conversation_no_manual_summary',
  scope: 'same_link_ops_chat_session',
});

function safeFileStem(value, fallback = 'asset') {
  const s = String(value || '')
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+/g, '')
    .slice(0, 80);
  return s || fallback;
}

function safeTaskId(value) {
  const s = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{8,120}$/.test(s)) throw new Error('Invalid task id');
  return s;
}

function safeLinkOpsChatSessionId(value) {
  const s = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{8,120}$/.test(s)) throw new Error('Invalid chat session id');
  return s;
}

function safeCodexSessionId(value) {
  const s = String(value || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return '';
  return s.toLowerCase();
}

function assertInsideDir(baseDir, targetPath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(targetPath);
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Unsafe upload path');
  }
  return target;
}

async function deleteCodexSessionRecord(sessionId) {
  const id = safeCodexSessionId(sessionId);
  if (!id) return {ok: true, skipped: true, reason: 'missing_or_invalid_session_id', deletedFiles: []};
  const codexHome = path.resolve(process.env.CODEX_HOME || '/home/sheinops/.codex');
  const sessionsDir = assertInsideDir(codexHome, path.join(codexHome, 'sessions'));
  const deletedFiles = [];
  const warnings = [];
  async function walk(dir, depth = 0) {
    if (depth > 8) return;
    let entries = [];
    try {
      entries = await fs.readdir(dir, {withFileTypes: true});
    } catch (err) {
      if (err?.code !== 'ENOENT') warnings.push(String(err?.message || err).slice(0, 240));
      return;
    }
    for (const entry of entries) {
      const full = assertInsideDir(sessionsDir, path.join(dir, entry.name));
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.includes(id)) {
        await fs.rm(full, {force: true});
        deletedFiles.push(path.relative(codexHome, full).replace(/\\/g, '/'));
      }
    }
  }
  await walk(sessionsDir);
  return {ok: true, sessionId: id, deletedFiles, warnings};
}

function uploadExtensionFor(mime, name = '') {
  const ext = path.extname(String(name || '')).toLowerCase();
  const byMime = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'text/csv': '.csv',
    'application/json': '.json',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  };
  const allowedExt = new Set(Object.values(byMime));
  return allowedExt.has(ext) ? ext : (byMime[mime] || '.bin');
}

function hasUploadMagic(buffer, mime) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return false;
  if (mime === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mime === 'image/png') return buffer.length >= 8 && buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'image/webp') return buffer.length >= 12 && buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP';
  if (mime === 'application/pdf') return buffer.length >= 4 && buffer.slice(0, 4).toString('ascii') === '%PDF';
  if (mime === 'text/plain' || mime === 'text/csv' || mime === 'application/json') {
    if (buffer.includes(0)) return false;
    const head = buffer.slice(0, Math.min(buffer.length, 4096)).toString('utf8');
    if (mime === 'application/json') {
      const trimmed = head.trimStart();
      return trimmed.startsWith('{') || trimmed.startsWith('[');
    }
    return true;
  }
  if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07) && (buffer[3] === 0x04 || buffer[3] === 0x06 || buffer[3] === 0x08);
  }
  return false;
}

function writeResponseHead(res, status, headers = {}) {
  res.writeHead(status, portalResponseHeaders({
    'Cache-Control': 'no-store',
    ...headers,
  }));
}

function linkOpsRepositoryHttpDetails(error) {
  const code = String(error?.code || '');
  if (!code) return null;
  if (code === 'LINK_OPS_VALIDATION') {
    return {status: 400, body: {ok: false, error: error.message, code}};
  }
  if (code === 'LINK_OPS_NOT_FOUND') {
    return {status: 404, body: {ok: false, error: error.message, code}};
  }
  if (['LINK_OPS_REVISION_CONFLICT', 'LINK_OPS_IDEMPOTENCY_CONFLICT', 'LINK_OPS_IMPORT_CONFLICT', 'LINK_OPS_ALREADY_EXISTS', 'LINK_OPS_GATEWAY_CONFLICT'].includes(code)) {
    return {status: 409, body: {ok: false, error: error.message, code, retryable: code === 'LINK_OPS_REVISION_CONFLICT'}};
  }
  if (['WAREHOUSE_PG_UNAVAILABLE', 'WAREHOUSE_PG_CONFIGURATION', 'LINK_OPS_JSON_LOCK_TIMEOUT'].includes(code)) {
    return {status: 503, body: {ok: false, error: '自动运营存储暂不可用，请稍后重试。', code, retryable: true}};
  }
  if (code.startsWith('LINK_OPS_')) {
    return {status: 500, body: {ok: false, error: '自动运营状态保存失败，操作未被静默降级。', code}};
  }
  return null;
}

function send(res, status, body, headers = {}) {
  writeResponseHead(res, status, headers);
  res.end(body);
}

async function readJsonFile(file, fallback) {
  try {
    const text = await fs.readFile(file, 'utf8');
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

async function writeJsonFile(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

async function writeJsonFileCompact(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value), 'utf8');
  await fs.rename(tmp, file);
}

function loadOpenApiLocalConfigSync() {
  try {
    return JSON.parse(fssync.readFileSync(SHEIN_OPENAPI_LOCAL_CONFIG_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function maskCredentialPresence(value) {
  return {present: Boolean(value)};
}

function normalizeTokenList(value, {caseMode = 'lower'} = {}) {
  const raw = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(/[,\s，、]+/) : []);
  return [...new Set(raw
    .map(x => String(x || '').trim())
    .filter(Boolean)
    .map(x => {
      if (x === '*') return '*';
      if (caseMode === 'upper') return x.toUpperCase();
      if (caseMode === 'none') return x;
      return x.toLowerCase();
    }))];
}

function normalizeSafeWriteOperations(config) {
  const source = config?.safeWriteOperations && typeof config.safeWriteOperations === 'object'
    ? config.safeWriteOperations
    : {};
  const allowedOperations = normalizeTokenList(source.allowedOperations || source.operations || [], {caseMode: 'lower'});
  const allowedStores = normalizeStoreList(source.allowedStores || source.stores || []);
  return {
    enabled: Boolean(source.enabled),
    requireDryRun: source.requireDryRun !== false,
    allowedOperations,
    allowedStores,
  };
}

function safeWriteOperationAllowed(config, {operation = '', storeKey = ''} = {}) {
  const safe = normalizeSafeWriteOperations(config);
  const op = String(operation || '').trim().toLowerCase();
  const store = String(storeKey || '').trim().toUpperCase();
  const operationAllowed = Boolean(op) && (safe.allowedOperations.includes('*') || safe.allowedOperations.includes(op));
  const storeAllowed = Boolean(store) && (safe.allowedStores.includes('*') || safe.allowedStores.includes(store));
  return {
    ...safe,
    operation,
    storeKey: store,
    operationAllowed,
    storeAllowed,
    allowed: Boolean(safe.enabled && operationAllowed && storeAllowed),
  };
}

function loadBiOpsWriteWhitelistSync() {
  try {
    return JSON.parse(fssync.readFileSync(BI_OPS_WRITE_WHITELIST_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function actorIdentityCandidates(actor = {}) {
  return normalizeTokenList([
    actor?.username,
    actor?.displayName,
    actor?.name,
    actor?.ownerKey,
  ].filter(Boolean), {caseMode: 'lower'});
}

function actorRoleCandidate(actor = {}) {
  return String(actor?.role || '').trim().toLowerCase();
}

function normalizeBiOpsWriteWhitelistRule(input = {}, defaults = {}) {
  const rule = input && typeof input === 'object' ? input : {};
  const operations = normalizeTokenList(rule.operations || rule.operation || rule.allowedOperations || defaults.operations || defaults.operation || []);
  const stores = normalizeStoreList(rule.stores || rule.storeKeys || rule.store || rule.allowedStores || defaults.stores || defaults.store || []);
  const users = normalizeTokenList(rule.allowedUsers || rule.users || rule.usernames || rule.allowedUsernames || rule.username || []);
  const ownerKeys = normalizeTokenList(rule.allowedOwnerKeys || rule.ownerKeys || rule.ownerKey || []);
  const roles = normalizeTokenList(rule.allowedRoles || rule.roles || []);
  return {
    id: String(rule.id || defaults.id || `${stores.join(',')}:${operations.join(',')}`).trim(),
    enabled: rule.enabled !== false,
    realSubmit: rule.realSubmit === true || rule.allowRealSubmit === true,
    operations,
    stores,
    users,
    ownerKeys,
    roles,
    note: String(rule.note || rule.notes || '').trim().slice(0, 300),
  };
}

function normalizeBiOpsWriteWhitelist(config) {
  const source = config && typeof config === 'object' ? config : {};
  const rawRules = [];
  if (Array.isArray(source.rules)) {
    rawRules.push(...source.rules.map((rule, index) => normalizeBiOpsWriteWhitelistRule(rule, {id: `rules[${index}]`})));
  }
  for (const [storeKey, operations] of Object.entries(source)) {
    const store = String(storeKey || '').trim().toUpperCase();
    if (!SHEIN_STORE_KEYS.has(store) || !operations || typeof operations !== 'object' || Array.isArray(operations)) continue;
    for (const [operation, rule] of Object.entries(operations)) {
      rawRules.push(normalizeBiOpsWriteWhitelistRule(rule, {
        id: `${store}.${operation}`,
        stores: [store],
        operations: [operation],
      }));
    }
  }
  const enabled = source.enabled === true;
  const rules = rawRules
    .map(rule => ({
      ...rule,
      enabled: enabled && rule.enabled && rule.realSubmit,
    }))
    .filter(rule => rule.operations.length && rule.stores.length);
  return {
    enabled,
    rules,
    sourceFile: BI_OPS_WRITE_WHITELIST_FILE,
  };
}

function biOpsWriteWhitelistSync() {
  return normalizeBiOpsWriteWhitelist(loadBiOpsWriteWhitelistSync());
}

function biOpsWriteWhitelistRuleMatches(rule, {operation = '', storeKey = ''} = {}) {
  const op = String(operation || '').trim().toLowerCase();
  const store = String(storeKey || '').trim().toUpperCase();
  const operationAllowed = Boolean(op) && (rule.operations.includes('*') || rule.operations.includes(op));
  const storeAllowed = Boolean(store) && (rule.stores.includes('*') || rule.stores.includes(store));
  return operationAllowed && storeAllowed;
}

function biOpsWriteWhitelistConfigured({operation = '', storeKey = ''} = {}) {
  const whitelist = biOpsWriteWhitelistSync();
  const matches = whitelist.rules.filter(rule => rule.enabled && biOpsWriteWhitelistRuleMatches(rule, {operation, storeKey}));
  return {
    enabled: whitelist.enabled,
    configured: matches.some(rule => rule.users.length || rule.ownerKeys.length || rule.users.includes('*') || rule.ownerKeys.includes('*')),
    ruleCount: whitelist.rules.length,
    matchedRuleCount: matches.length,
  };
}

function biOpsWriteWhitelistAllowedForActor(actor, {operation = '', storeKey = ''} = {}) {
  const whitelist = biOpsWriteWhitelistSync();
  const identities = actorIdentityCandidates(actor);
  const role = actorRoleCandidate(actor);
  const matches = whitelist.rules.filter(rule => rule.enabled && biOpsWriteWhitelistRuleMatches(rule, {operation, storeKey}));
  for (const rule of matches) {
    const hasIdentitySelector = rule.users.length > 0 || rule.ownerKeys.length > 0;
    const userAllowed = rule.users.includes('*') || identities.some(id => rule.users.includes(id));
    const ownerAllowed = rule.ownerKeys.includes('*') || identities.some(id => rule.ownerKeys.includes(id));
    const roleAllowed = !rule.roles.length || rule.roles.includes('*') || (role && rule.roles.includes(role));
    if (hasIdentitySelector && (userAllowed || ownerAllowed) && roleAllowed) {
      return {
        allowed: true,
        enabled: whitelist.enabled,
        operation: String(operation || '').trim().toLowerCase(),
        storeKey: String(storeKey || '').trim().toUpperCase(),
        ruleId: rule.id,
        matchedRuleCount: matches.length,
      };
    }
  }
  const reason = !whitelist.enabled
    ? '真实写试点白名单未启用'
    : !matches.length
      ? '真实写试点白名单没有匹配的店铺+动作规则'
      : '真实写试点白名单没有匹配当前账号';
  return {
    allowed: false,
    enabled: whitelist.enabled,
    operation: String(operation || '').trim().toLowerCase(),
    storeKey: String(storeKey || '').trim().toUpperCase(),
    ruleId: '',
    matchedRuleCount: matches.length,
    reason,
  };
}

function biOpsWriteWhitelistSummary() {
  const whitelist = biOpsWriteWhitelistSync();
  const operations = [...new Set(whitelist.rules.flatMap(rule => rule.operations))].sort();
  const stores = [...new Set(whitelist.rules.flatMap(rule => rule.stores))].sort();
  return {
    enabled: whitelist.enabled,
    ruleCount: whitelist.rules.length,
    operations,
    stores,
    source: path.relative(ROOT, whitelist.sourceFile),
  };
}


function loadOpenApiReadProbeSummarySync() {
  try {
    const summary = JSON.parse(fssync.readFileSync(OPENAPI_READ_PROBE_SUMMARY_FILE, 'utf8'));
    const generatedAtMs = Date.parse(summary?.generatedAt || '');
    const fresh = openApiEvidenceTimestampFresh(generatedAtMs, OPENAPI_READ_PROBE_FRESH_MS);
    const byStore = new Map();
    for (const result of Array.isArray(summary?.results) ? summary.results : []) {
      const key = String(result?.storeKey || '').trim().toUpperCase();
      if (!key) continue;
      byStore.set(key, result);
    }
    return {summary, generatedAtMs, fresh, byStore};
  } catch {
    return {summary: null, generatedAtMs: NaN, fresh: false, byStore: new Map()};
  }
}

function openApiProbeResultIsReadReady(result) {
  return Boolean(result?.ok) && String(result?.status || '') === 'read_probe_ok';
}

function openApiEvidenceTimestampFresh(generatedAtMs, maxAgeMs, nowMs = Date.now()) {
  if (!Number.isFinite(generatedAtMs)) return false;
  const ageMs = nowMs - generatedAtMs;
  return ageMs >= -(5 * 60_000) && ageMs <= maxAgeMs;
}

function openApiReconciliationReadEvidenceOk(kind, result, row) {
  if (!result?.ok || !row || typeof row !== 'object') return false;
  const fields = kind === 'sales'
    ? ['apiSalesSar', 'api_sales_sar', 'apiOnlyOrderCount', 'api_only_order_count', 'browserOnlyOrderCount', 'browser_only_order_count']
    : kind === 'return'
      ? ['apiAmountSar', 'api_amount_sar', 'apiOnlyReturnCount', 'api_only_return_count', 'checkedDays', 'checked_days']
      : ['apiLinkCount', 'api_link_count', 'matchedSkcCount', 'matched_skc_count', 'apiOnlySkcCount', 'api_only_skc_count'];
  // A warning may describe reconciliation differences while still proving that
  // the API read and warehouse load completed. Require a real domain metric so
  // an empty/malformed outer result cannot unlock the controlled workflow.
  return fields.some(field => row[field] !== null && row[field] !== undefined && Number.isFinite(Number(row[field])));
}

function loadOpenApiSalesReconciliationSummarySync() {
  try {
    const summary = JSON.parse(fssync.readFileSync(OPENAPI_SALES_RECONCILIATION_SUMMARY_FILE, 'utf8'));
    const generatedAtMs = Date.parse(summary?.generatedAt || '');
    const fresh = openApiEvidenceTimestampFresh(generatedAtMs, OPENAPI_SALES_RECONCILIATION_FRESH_MS);
    const byStore = new Map();
    for (const result of Array.isArray(summary?.results) ? summary.results : []) {
      const key = String(result?.storeKey || '').trim().toUpperCase();
      if (!key) continue;
      const row = Array.isArray(result?.load?.reconciliation) ? result.load.reconciliation[0] : null;
      const readEvidenceOk = openApiReconciliationReadEvidenceOk('sales', result, row);
      byStore.set(key, {
        status: result?.status || row?.status || '',
        ok: readEvidenceOk,
        readEvidenceOk,
        date: summary?.date || row?.date || '',
        generatedAt: summary?.generatedAt || '',
        browserSalesSar: row?.browserSalesSar ?? null,
        apiSalesSar: row?.apiSalesSar ?? null,
        salesSarDelta: row?.salesSarDelta ?? null,
        browserOnlyOrderCount: row?.browserOnlyOrderCount ?? null,
        apiOnlyOrderCount: row?.apiOnlyOrderCount ?? null,
      });
    }
    return {summary, generatedAtMs, fresh, byStore};
  } catch {
    return {summary: null, generatedAtMs: NaN, fresh: false, byStore: new Map()};
  }
}

function summarizeOpenApiReturnRows(rows) {
  rows = Array.isArray(rows) ? rows : [];
  if (!rows.length) return null;
  const badRows = rows.filter((row) => String(row?.status || '') !== 'matched' || String(row?.warnings || '').trim());
  const missingRows = rows.filter((row) => String(row?.status || '') === 'missing_browser');
  const target = badRows.at(-1) || rows.at(-1);
  const amountDelta = rows.reduce((sum, row) => sum + Number(row?.amountSarDelta || 0), 0);
  const browserOnlyReturnCount = rows.reduce((sum, row) => sum + Number(row?.browserOnlyReturnCount || 0), 0);
  const apiOnlyReturnCount = rows.reduce((sum, row) => sum + Number(row?.apiOnlyReturnCount || 0), 0);
  const warnings = [...new Set(rows.flatMap((row) => String(row?.warnings || '').split(';')).map((x) => x.trim()).filter(Boolean))];
  return {
    status: missingRows.length ? 'missing_browser' : badRows.length ? 'warning' : 'matched',
    ok: true,
    date: target?.date || rows.at(-1)?.date || '',
    browserAmountSar: target?.browserAmountSar ?? null,
    apiAmountSar: target?.apiAmountSar ?? null,
    amountSarDelta: Math.round((amountDelta + Number.EPSILON) * 100) / 100,
    browserOnlyReturnCount,
    apiOnlyReturnCount,
    warnings: warnings.join(';'),
    checkedDays: rows.length,
    warningDays: badRows.length,
  };
}

function loadOpenApiReturnReconciliationSummarySync() {
  try {
    const summary = JSON.parse(fssync.readFileSync(OPENAPI_RETURN_RECONCILIATION_SUMMARY_FILE, 'utf8'));
    const generatedAtMs = Date.parse(summary?.generatedAt || '');
    const fresh = openApiEvidenceTimestampFresh(generatedAtMs, OPENAPI_RETURN_RECONCILIATION_FRESH_MS);
    const byStore = new Map();
    for (const result of Array.isArray(summary?.results) ? summary.results : []) {
      const key = String(result?.storeKey || '').trim().toUpperCase();
      if (!key) continue;
      const row = summarizeOpenApiReturnRows(result?.load?.reconciliation) || result?.reconciliation || null;
      const readEvidenceOk = openApiReconciliationReadEvidenceOk('return', result, row);
      byStore.set(key, {
        status: result?.status || row?.status || '',
        ok: Boolean(readEvidenceOk && row.status === 'matched'),
        readEvidenceOk,
        date: summary?.date || row?.date || '',
        generatedAt: summary?.generatedAt || '',
        browserAmountSar: row?.browserAmountSar ?? null,
        apiAmountSar: row?.apiAmountSar ?? null,
        amountSarDelta: row?.amountSarDelta ?? null,
        browserOnlyReturnCount: row?.browserOnlyReturnCount ?? null,
        apiOnlyReturnCount: row?.apiOnlyReturnCount ?? null,
        warnings: row?.warnings || '',
        checkedDays: row?.checkedDays ?? null,
        warningDays: row?.warningDays ?? null,
      });
    }
    return {summary, generatedAtMs, fresh, byStore};
  } catch {
    return {summary: null, generatedAtMs: NaN, fresh: false, byStore: new Map()};
  }
}

function loadOpenApiProductReconciliationSummarySync() {
  try {
    const summary = JSON.parse(fssync.readFileSync(OPENAPI_PRODUCT_RECONCILIATION_SUMMARY_FILE, 'utf8'));
    const generatedAtMs = Date.parse(summary?.generatedAt || '');
    const fresh = openApiEvidenceTimestampFresh(generatedAtMs, OPENAPI_PRODUCT_RECONCILIATION_FRESH_MS);
    const byStore = new Map();
    for (const result of Array.isArray(summary?.results) ? summary.results : []) {
      const key = String(result?.storeKey || '').trim().toUpperCase();
      if (!key) continue;
      const row = Array.isArray(result?.load?.reconciliation) ? result.load.reconciliation[0] : result?.reconciliation || null;
      const readEvidenceOk = openApiReconciliationReadEvidenceOk('product', result, row);
      byStore.set(key, {
        status: result?.status || row?.status || '',
        ok: readEvidenceOk,
        readEvidenceOk,
        generatedAt: summary?.generatedAt || row?.generated_at || row?.generatedAt || '',
        apiLinkCount: row?.api_link_count ?? row?.apiLinkCount ?? null,
        apiOnShelfCount: row?.api_on_shelf_count ?? row?.apiOnShelfCount ?? null,
        browserLinkCount: row?.browser_link_count ?? row?.browserLinkCount ?? null,
        browserOnShelfCount: row?.browser_on_shelf_count ?? row?.browserOnShelfCount ?? null,
        matchedSkcCount: row?.matched_skc_count ?? row?.matchedSkcCount ?? null,
        apiOnlySkcCount: row?.api_only_skc_count ?? row?.apiOnlySkcCount ?? null,
        browserOnlySkcCount: row?.browser_only_skc_count ?? row?.browserOnlySkcCount ?? null,
        statusMismatchCount: row?.status_mismatch_count ?? row?.statusMismatchCount ?? null,
        exactStatusMismatchCount: row?.exact_status_mismatch_count ?? row?.exactStatusMismatchCount ?? null,
        detailMissingCount: row?.detail_missing_count ?? row?.detailMissingCount ?? null,
        stockMissingCount: row?.stock_missing_count ?? row?.stockMissingCount ?? null,
        warnings: row?.warnings || '',
      });
    }
    return {summary, generatedAtMs, fresh, byStore};
  } catch {
    return {summary: null, generatedAtMs: NaN, fresh: false, byStore: new Map()};
  }
}

function openApiConfiguredStoresSync() {
  const config = loadOpenApiLocalConfigSync();
  const configured = new Map();
  const configStores = Array.isArray(config?.stores) ? config.stores : [];
  for (const entry of configStores) {
    const key = String(entry?.storeKey || '').trim().toUpperCase();
    if (key) configured.set(key, entry);
  }
  return {config, configured};
}

function openApiClientForConfiguredStore(storeKey) {
  const {config, configured} = openApiConfiguredStoresSync();
  const key = String(storeKey || '').trim().toUpperCase();
  const store = configured.get(key) || null;
  if (!store?.enabled || !store?.openKeyId || !store?.secretKey) {
    throw new Error(`${key || '目标店铺'} 未完成 SHEIN OpenAPI 授权`);
  }
  return {
    config,
    store,
    client: new SheinOpenApiClient({
      baseUrl: config?.apiBaseUrls?.prodSemiManaged || SHEIN_OPENAPI_BASE_URLS.prodSemiManaged,
      openKeyId: store.openKeyId,
      secretKey: store.secretKey,
    }),
  };
}

async function verifyOpenApiStoreIdentityForUtility(client, storeKey, configuredStore) {
  const truthRoot = await readJsonFile(path.join(ROOT, 'config', 'store_account_truth.json'), {stores: {}});
  const truth = truthRoot?.stores?.[storeKey] || null;
  if (!truth) return {ok: true, skipped: true, reason: 'no store_account_truth entry'};
  const response = await client.request('/open-api/openapi-business-backend/query-store-info', {method: 'POST', body: {}, headers: {language: 'en'}});
  const identity = validateStoreIdentity({
    store: configuredStore,
    truth,
    storageIdentity: openApiIdentityToStorageIdentity(response.data),
    href: 'openapi:/open-api/openapi-business-backend/query-store-info',
    context: 'serve_bi_portal_openapi_image_asset',
  });
  if (identity.ok || storeIdentityMatchesMerchantOnly(identity)) return {ok: true, identity, httpStatus: response.status};
  return {ok: false, identity, httpStatus: response.status, error: formatStoreIdentityError(identity)};
}

function openApiStoreCapability(storeKey, evidence = {}) {
  const {config, configured} = openApiConfiguredStoresSync();
  const probeSummary = evidence.probeSummary || loadOpenApiReadProbeSummarySync();
  const salesReconciliationSummary = evidence.salesReconciliationSummary || loadOpenApiSalesReconciliationSummarySync();
  const returnReconciliationSummary = evidence.returnReconciliationSummary || loadOpenApiReturnReconciliationSummarySync();
  const productReconciliationSummary = evidence.productReconciliationSummary || loadOpenApiProductReconciliationSummarySync();
  const key = String(storeKey || '').trim().toUpperCase();
  const local = configured.get(key) || null;
  const staticCap = LINK_OPS_STORE_CAPABILITIES[key] || {};
  const enabled = Boolean(local?.enabled);
  const hasOpenKey = Boolean(String(local?.openKeyId || '').trim());
  const hasSecret = Boolean(String(local?.secretKey || '').trim());
  const authorized = enabled && hasOpenKey && hasSecret;
  const probeResult = probeSummary.byStore.get(key) || null;
  const probeReadReady = authorized && probeSummary.fresh && openApiProbeResultIsReadReady(probeResult);
  const salesReconciliation = salesReconciliationSummary.byStore.get(key) || null;
  const returnReconciliation = returnReconciliationSummary.byStore.get(key) || null;
  const productReconciliation = productReconciliationSummary.byStore.get(key) || null;
  const reconciliationReadReady = authorized && Boolean(
    (salesReconciliationSummary.fresh && salesReconciliation?.readEvidenceOk)
    || (returnReconciliationSummary.fresh && returnReconciliation?.readEvidenceOk)
    || (productReconciliationSummary.fresh && productReconciliation?.readEvidenceOk)
  );
  const verifiedRead = authorized && (probeReadReady || reconciliationReadReady);
  const productPublishPrecheckAdapter = authorized && verifiedRead;
  const safeWrite = safeWriteOperationAllowed(config, {operation: 'copy_product_draft', storeKey: key});
  const whitelistConfigured = biOpsWriteWhitelistConfigured({operation: 'copy_product_draft', storeKey: key});
  const productPublishExecuteAdapter = productPublishPrecheckAdapter
    && safeWrite.allowed
    && whitelistConfigured.configured;
  return {
    storeKey: key,
    configured: configured.has(key),
    enabled,
    authorized,
    verifiedRead,
    probeReadReady,
    reconciliationReadReady,
    productPublishAdapter: productPublishPrecheckAdapter,
    productPublishPrecheckAdapter,
    productPublishExecuteAdapter,
    safeWriteEnabled: safeWrite.enabled,
    safeWrite,
    realSubmitWhitelist: whitelistConfigured,
    local,
    staticCap,
  };
}

function openApiRealSubmitControlForOperation(operation, storeKey) {
  const {config} = openApiConfiguredStoresSync();
  const safeWrite = safeWriteOperationAllowed(config, {operation, storeKey});
  const whitelistConfigured = biOpsWriteWhitelistConfigured({operation, storeKey});
  return {
    safeWrite,
    whitelistConfigured,
    enabled: Boolean(safeWrite.allowed && whitelistConfigured.configured),
  };
}

function linkOpsActionCapabilitiesForStore(storeKey, cap = openApiStoreCapability(storeKey)) {
  return LINK_OPS_ACTION_CAPABILITY_DEFS.map(def => {
    let precheckSupported = Boolean(def.precheck);
    let realSubmitSupported = false;
    let state = def.stage || 'task_only';
    let reason = def.reason || '';
    const realSubmitRequirements = [...LINK_OPS_REAL_SUBMIT_REQUIREMENTS];
    const realSubmitBlockers = [];
    let nextStep = '';
    if (def.key === 'copy_product_draft') {
      precheckSupported = Boolean(cap.productPublishPrecheckAdapter || cap.productPublishAdapter);
      realSubmitSupported = Boolean(cap.productPublishExecuteAdapter);
      state = realSubmitSupported
        ? 'confirmable_after_preflight'
        : precheckSupported
          ? 'dry_run_only_until_execute_adapter_enabled'
          : cap.authorized
            ? 'authorized_pending_probe'
            : 'pending_authorization';
      reason = realSubmitSupported
        ? '已具备商品发布/编辑执行适配器；仍必须 payload 完整、任务等你确认、显式确认文本和回读证据齐全才可提交。'
        : precheckSupported
          ? '已具备商品发布/编辑 系统检查；真实提交适配器未对该店放行。'
          : cap.authorized
            ? '已授权但只读探针/商品双跑尚未证明可用，暂不能进入商品发布 系统检查。'
            : '店铺尚未完成 OpenAPI 授权，不能进入商品发布 系统检查。';
      if (!cap.authorized) realSubmitBlockers.push('店铺未完成 OpenAPI 授权/密钥配置');
      if (cap.authorized && !cap.verifiedRead) realSubmitBlockers.push('最近只读探针/商品能力尚未证明可用');
      if (precheckSupported && !cap.safeWrite?.enabled) realSubmitBlockers.push('真实写总闸门未开启：safeWriteOperations.enabled=false');
      if (precheckSupported && cap.safeWrite?.enabled && !cap.safeWrite?.operationAllowed) realSubmitBlockers.push('真实写动作未进入 safeWriteOperations.allowedOperations 白名单');
      if (precheckSupported && cap.safeWrite?.enabled && !cap.safeWrite?.storeAllowed) realSubmitBlockers.push('目标店铺未进入 safeWriteOperations.allowedStores 白名单');
      if (precheckSupported && cap.safeWrite?.allowed && !cap.realSubmitWhitelist?.enabled) realSubmitBlockers.push('真实写试点白名单未启用：bi_ops_write_whitelist.local.json enabled=false');
      if (precheckSupported && cap.safeWrite?.allowed && cap.realSubmitWhitelist?.enabled && !cap.realSubmitWhitelist?.configured) realSubmitBlockers.push('真实写试点白名单未配置该店铺+动作+账号');
      if (precheckSupported && !cap.productPublishExecuteAdapter) realSubmitBlockers.push('商品发布/编辑真实提交适配器未对该店放行');
      nextStep = realSubmitSupported
        ? '先在会话里说明要做什么；系统检查资料完整后，你在聊天里同意即可提交。'
        : precheckSupported
          ? '继续完善 payload 与执行器放行条件；当前只允许 系统检查。'
          : cap.authorized
            ? '先跑/修复只读探针和商品双跑，再进入商品发布 系统检查。'
            : '先完成该店 OpenAPI 授权和云端私有密钥配置。';
    } else if (LINK_MAINTENANCE_INTENTS.has(def.intent)) {
      precheckSupported = true;
      const control = openApiRealSubmitControlForOperation(def.intent, storeKey);
      realSubmitSupported = Boolean(cap.authorized && cap.verifiedRead && control.enabled);
      state = realSubmitSupported ? 'confirmable_after_preflight' : 'dry_run_until_action_gate_enabled';
      const candidate = LINK_OPS_MAINTENANCE_OFFICIAL_CANDIDATES[def.intent] || null;
      if (candidate) {
        if (!cap.authorized) realSubmitBlockers.push('店铺未完成 OpenAPI 授权/密钥配置');
        if (cap.authorized && !cap.verifiedRead) realSubmitBlockers.push('最近只读探针/商品能力尚未证明可用');
        if (!control.safeWrite.enabled) realSubmitBlockers.push('真实写总闸门未开启：safeWriteOperations.enabled=false');
        if (control.safeWrite.enabled && !control.safeWrite.operationAllowed) realSubmitBlockers.push(`真实写动作未进入 safeWriteOperations.allowedOperations 白名单：${def.intent}`);
        if (control.safeWrite.enabled && !control.safeWrite.storeAllowed) realSubmitBlockers.push(`目标店铺未进入 safeWriteOperations.allowedStores 白名单：${storeKey}`);
        if (control.safeWrite.enabled && !control.whitelistConfigured.configured) realSubmitBlockers.push('未配置真实写试点白名单（人+店+动作）');
        if (!realSubmitSupported) {
          realSubmitBlockers.push(`官方接口 ${candidate.endpoint}（${candidate.label}）已纳入执行器，但尚未满足生产真实写门禁`);
          for (const item of candidate.missing || []) realSubmitBlockers.push(item);
        }
        nextStep = realSubmitSupported
          ? '先完成 系统检查 锁定 payload，再由有权限账号输入确认文本真实提交；提交后必须强回读或人工核销。'
          : `先为 ${def.intent} 配置窄范围 safeWriteOperations 和真实写白名单，并完成 系统检查 payload 锁定。`;
      } else {
        realSubmitBlockers.push('尚未接入 SHEIN 官方维护写接口');
        realSubmitBlockers.push('尚未验证维护动作执行后回读字段');
        nextStep = '先研究并验证官方维护写接口；在接口、payload、回读都确认前，只允许目标定位和风险 系统检查。';
      }
    } else {
      precheckSupported = false;
      realSubmitSupported = false;
      state = 'task_only_no_adapter';
      if (def.key === 'campaign_signup' || def.key === 'flash_discount') {
        realSubmitBlockers.push('官方公开 OpenAPI 目录当前无该营销写接口证据');
        realSubmitBlockers.push('该动作继续走已有本地营销运营流程和人工确认，不通过官方 OpenAPI 总闸门伪装成可提交');
        nextStep = '若后续 SHEIN 开放营销报名/限时折扣官方接口，再按 系统检查、白名单、确认文本、回读/人工核销重新接入。';
      } else {
        realSubmitBlockers.push('该动作当前还没有自动执行适配器，只能先按人工流程处理');
        nextStep = '先补动作专属系统检查和执行器，再讨论真实提交。';
      }
    }
    return {
      key: def.key,
      label: def.label,
      intent: def.intent,
      stage: def.stage,
      state,
      precheckSupported,
      realSubmitSupported,
      canSilentWrite: false,
      realSubmitRequirements,
      realSubmitBlockers: realSubmitSupported ? realSubmitBlockers : [...new Set(realSubmitBlockers)],
      requiredConfirmText: realSubmitSupported ? (def.requiredConfirmText || LINK_OPS_OPENAPI_SUBMIT_CONFIRM_TEXT) : '',
      confirmableState: realSubmitSupported ? (def.confirmableState || '') : '',
      nextStep,
      reason,
      officialCandidate: LINK_OPS_MAINTENANCE_OFFICIAL_CANDIDATES[def.intent] || null,
    };
  });
}

function openApiCapabilityLedger() {
  const {config, configured} = openApiConfiguredStoresSync();
  const safeWriteOperations = normalizeSafeWriteOperations(config);
  const realSubmitWhitelist = biOpsWriteWhitelistSummary();
  const probeSummary = loadOpenApiReadProbeSummarySync();
  const salesReconciliationSummary = loadOpenApiSalesReconciliationSummarySync();
  const returnReconciliationSummary = loadOpenApiReturnReconciliationSummarySync();
  const productReconciliationSummary = loadOpenApiProductReconciliationSummarySync();
  const stores = Array.from(SHEIN_STORE_KEYS)
    .filter(key => DEFAULT_MANUAL_LOGIN_STORE_KEYS.includes(key) || configured.has(key))
    .sort((a, b) => a.localeCompare(b));
  const rows = stores.map(storeKey => {
    const cap = openApiStoreCapability(storeKey, {
      probeSummary,
      salesReconciliationSummary,
      returnReconciliationSummary,
      productReconciliationSummary,
    });
    const {local, staticCap, enabled, authorized} = cap;
    const probeResult = probeSummary.byStore.get(storeKey) || null;
    const salesReconciliation = salesReconciliationSummary.byStore.get(storeKey) || null;
    const returnReconciliation = returnReconciliationSummary.byStore.get(storeKey) || null;
    const productReconciliation = productReconciliationSummary.byStore.get(storeKey) || null;
    const probeReadReady = cap.probeReadReady;
    const verifiedRead = cap.verifiedRead;
    const salesReconciliationReady = Boolean(salesReconciliationSummary.fresh && salesReconciliation && salesReconciliation.ok);
    const returnReconciliationReady = Boolean(returnReconciliationSummary.fresh && returnReconciliation && returnReconciliation.ok);
    const productReconciliationReady = Boolean(productReconciliationSummary.fresh && productReconciliation && productReconciliation.ok);
    const writePrecheck = Boolean(cap.productPublishAdapter);
    const readDomains = Array.isArray(staticCap.readDomains) && staticCap.readDomains.length
      ? staticCap.readDomains
      : (verifiedRead ? DEFAULT_OPENAPI_READ_DOMAINS : (authorized ? DEFAULT_OPENAPI_READ_DOMAINS : []));
    const writeDomains = Array.isArray(staticCap.writeDomains) && staticCap.writeDomains.length
      ? staticCap.writeDomains
      : (writePrecheck ? DEFAULT_OPENAPI_WRITE_PRECHECK_DOMAINS : []);
    const actionCapabilities = linkOpsActionCapabilitiesForStore(storeKey, cap);
    const realSubmitSupported = actionCapabilities.some(x => x.realSubmitSupported);
    const dryRunSupported = actionCapabilities.some(x => x.precheckSupported);
    const status = verifiedRead
      ? 'read_ready'
      : authorized
        ? 'authorized_pending_probe'
        : configured.has(storeKey)
          ? 'configured_disabled_or_incomplete'
          : 'pending_authorization';
    return {
      storeKey,
      storeName: '',
      status,
      configured: configured.has(storeKey),
      enabled,
      authorized,
      apiConnected: authorized,
      verifiedRead,
      salesReconciliation: salesReconciliationReady || Boolean(staticCap.salesReconciliation),
      salesReconciliationLatest: salesReconciliation,
      returnReconciliation: returnReconciliationReady || Boolean(staticCap.returnReconciliation),
      returnReconciliationLatest: returnReconciliation,
      productReconciliation: productReconciliationReady || Boolean(staticCap.productReconciliation),
      productReconciliationLatest: productReconciliation,
      writePrecheckReady: writePrecheck || dryRunSupported,
      writeConfirmable: realSubmitSupported,
      canSilentWrite: false,
      actionCapabilities,
      safeWriteEnabled: cap.safeWriteEnabled,
      safeWrite: {
        enabled: Boolean(cap.safeWrite?.enabled),
        operationAllowed: Boolean(cap.safeWrite?.operationAllowed),
        storeAllowed: Boolean(cap.safeWrite?.storeAllowed),
      },
      realSubmitWhitelist: cap.realSubmitWhitelist,
      readDomains,
      readDomainLabels: readDomains.map(k => OPENAPI_READ_DOMAIN_LABELS[k] || k),
      writeDomains,
      writeDomainLabels: writeDomains.map(k => OPENAPI_WRITE_DOMAIN_LABELS[k] || k),
      authorizedAt: local?.authorizedAt || null,
      shopName: local?.shopName || '',
      profileKey: local?.profileKey || '',
      credentialPresence: {
        apiCredential: maskCredentialPresence(authorized),
        encryptedCredential: maskCredentialPresence(local?.encryptedSecretKey),
      },
      note: staticCap.note || (verifiedRead
        ? `云端 API 读链路已有新鲜成功证据（${probeReadReady ? `通用探针 ${probeSummary.summary?.generatedAt || 'unknown'}` : '日常 OpenAPI 对账'}），销售双跑${salesReconciliation ? ` ${salesReconciliation.date || ''}=${salesReconciliation.status || 'unknown'}` : '待调度'}，退货双跑${returnReconciliation ? ` ${returnReconciliation.date || ''}=${returnReconciliation.status || 'unknown'}` : '待调度'}，商品基础资料双跑${productReconciliation ? `=${productReconciliation.status || 'unknown'}` : '待调度'}；真实写操作仍需资料检查、账号权限、你明确确认和提交后回读。`
        : authorized
          ? (probeResult && !openApiProbeResultIsReadReady(probeResult)
            ? `已授权，但最近云端只读探针未通过：${probeResult.status || 'unknown'}。`
            : '已检测到本地私有授权配置，但尚未完成新鲜的云端只读探针/对账登记。')
          : '待开放平台授权、换取店铺级 API 凭据，并写入云端私有配置。'),
    };
  });
  const counts = rows.reduce((acc, r) => {
    acc.total += 1;
    if (r.authorized) {
      acc.authorized += 1;
      acc.apiConnected += 1;
    }
    if (r.verifiedRead) acc.readReady += 1;
    if (r.salesReconciliation) acc.salesReconciliationReady += 1;
    if (r.returnReconciliation) acc.returnReconciliationReady += 1;
    if (r.productReconciliation) acc.productReconciliationReady += 1;
    if (r.writePrecheckReady) acc.writePrecheckReady += 1;
    if (r.writeConfirmable) {
      acc.writeConfirmable += 1;
      acc.controlledSubmitReady += 1;
    }
    return acc;
  }, {total: 0, authorized: 0, apiConnected: 0, readReady: 0, salesReconciliationReady: 0, returnReconciliationReady: 0, productReconciliationReady: 0, writePrecheckReady: 0, writeConfirmable: 0, controlledSubmitReady: 0});
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    environment: config?.environment || 'prod',
    probeSummary: {
      generatedAt: probeSummary.summary?.generatedAt || null,
      fresh: probeSummary.fresh,
      freshnessHours: Number((OPENAPI_READ_PROBE_FRESH_MS / 3600000).toFixed(2)),
      counts: probeSummary.summary?.counts || null,
    },
    salesReconciliationSummary: {
      generatedAt: salesReconciliationSummary.summary?.generatedAt || null,
      date: salesReconciliationSummary.summary?.date || null,
      fresh: salesReconciliationSummary.fresh,
      freshnessHours: Number((OPENAPI_SALES_RECONCILIATION_FRESH_MS / 3600000).toFixed(2)),
      counts: salesReconciliationSummary.summary?.counts || null,
    },
    returnReconciliationSummary: {
      generatedAt: returnReconciliationSummary.summary?.generatedAt || null,
      date: returnReconciliationSummary.summary?.date || null,
      fresh: returnReconciliationSummary.fresh,
      freshnessHours: Number((OPENAPI_RETURN_RECONCILIATION_FRESH_MS / 3600000).toFixed(2)),
      counts: returnReconciliationSummary.summary?.counts || null,
    },
    productReconciliationSummary: {
      generatedAt: productReconciliationSummary.summary?.generatedAt || null,
      fresh: productReconciliationSummary.fresh,
      freshnessHours: Number((OPENAPI_PRODUCT_RECONCILIATION_FRESH_MS / 3600000).toFixed(2)),
      counts: productReconciliationSummary.summary?.counts || null,
    },
    market: config?.market || 'SA',
    cooperationMode: config?.cooperationMode || '半托管',
    apiBase: config?.apiBaseUrls?.prodSemiManaged || 'https://openapi.sheincorp.com',
    allStoreKeys: rows.map(r => r.storeKey),
    counts,
    readDomainLabels: OPENAPI_READ_DOMAIN_LABELS,
    writeDomainLabels: OPENAPI_WRITE_DOMAIN_LABELS,
    actionCapabilityDefinitions: LINK_OPS_ACTION_CAPABILITY_DEFS.map(def => ({
      key: def.key,
      label: def.label,
      intent: def.intent,
      stage: def.stage,
      precheck: Boolean(def.precheck),
      realSubmit: false,
      reason: def.reason,
    })),
    safety: {
      naturalLanguageWrites: 'draft_dry_run_manual_confirm_only',
      secretsInResponse: false,
      canSilentWrite: false,
      realSubmitRequires: LINK_OPS_REAL_SUBMIT_REQUIREMENTS,
      safeWriteOperations: {
        enabled: safeWriteOperations.enabled,
        requireDryRun: safeWriteOperations.requireDryRun,
        allowedOperations: safeWriteOperations.allowedOperations,
        allowedStores: safeWriteOperations.allowedStores,
      },
      realSubmitWhitelist,
      maintenanceWrites: 'dry_run_only_until_official_endpoint_and_readback_verified',
      productionSourceSwitch: 'dual_run_reconcile_before_cutover',
    },
    rows,
  };
}

function projectOpenApiCapabilityStateForClient(action) {
  if (action?.realSubmitSupported) return 'ready';
  if (action?.precheckSupported) return 'can_prepare';
  return 'not_available';
}

function projectOpenApiCapabilityReasonForClient(action) {
  if (!action || typeof action !== 'object') return '';
  if (action.realSubmitSupported) {
    return '已接通：你在聊天里说要做什么，系统会检查资料，得到你同意后提交并回读结果。';
  }
  if (action.precheckSupported) {
    return '可先检查资料；真实操作还未对当前店铺/动作开放。';
  }
  if (action.key === 'campaign_signup' || action.key === 'flash_discount') {
    return 'SHEIN 当前没有开放这类官方写接口，暂不伪装成可自动提交。';
  }
  return '这个动作还没接入自动执行能力。';
}

function projectOpenApiCapabilityNextStepForClient(action) {
  if (!action || typeof action !== 'object') return '';
  if (action.realSubmitSupported) return '直接在聊天里安排，系统会把缺口、确认和结果都放回同一个会话。';
  if (action.precheckSupported) return '可以先让系统检查资料；等安全规则和执行能力齐全后再开放提交。';
  if (action.key === 'campaign_signup' || action.key === 'flash_discount') return '继续按现有营销流程处理；等官方接口明确后再接入。';
  return '需要先补动作执行器和结果回读。';
}

function projectOpenApiCapabilityBlockerForClient(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/未完成.*授权|密钥配置|pending_authorization/i.test(text)) return '店铺还没完成授权。';
  if (/只读探针|商品能力|read/i.test(text)) return '店铺接口连通性还没确认。';
  if (/safeWriteOperations|总闸门|allowedOperations|allowedStores|白名单|whitelist|bi_ops_write_whitelist/i.test(text)) return '当前账号、店铺或动作还没被安全规则放行。';
  if (/payload|hash|确认文本|SHEIN_[A-Z_]*OPENAPI_SUBMIT|dry[-_ ]?run/i.test(text)) return '还需要完成提交前资料检查和结果确认。';
  if (/真实提交适配器|执行器|官方接口/i.test(text)) return '这个动作的自动执行能力还没对当前店铺开放。';
  return sanitizeLinkOpsClientText(text, 180);
}

function projectOpenApiActionCapabilityForClient(action) {
  const blockers = [...new Set(asArray(action?.realSubmitBlockers)
    .map(projectOpenApiCapabilityBlockerForClient)
    .filter(Boolean))]
    .slice(0, 6);
  const officialCandidate = action?.officialCandidate && typeof action.officialCandidate === 'object'
    ? {
        label: sanitizeLinkOpsClientText(action.officialCandidate.label || '', 120),
        docUrl: String(action.officialCandidate.docUrl || '').trim(),
        endpoint: sanitizeLinkOpsClientText(action.officialCandidate.endpoint || '', 160),
      }
    : null;
  return {
    key: String(action?.key || '').trim(),
    label: sanitizeLinkOpsClientText(action?.label || '', 80),
    intent: String(action?.intent || '').trim(),
    state: projectOpenApiCapabilityStateForClient(action),
    precheckSupported: Boolean(action?.precheckSupported),
    realSubmitSupported: Boolean(action?.realSubmitSupported),
    canSilentWrite: false,
    realSubmitBlockers: action?.realSubmitSupported ? [] : blockers,
    nextStep: projectOpenApiCapabilityNextStepForClient(action),
    reason: projectOpenApiCapabilityReasonForClient(action),
    officialCandidate,
  };
}

function projectOpenApiCapabilityDefinitionsForClient(defs) {
  return asArray(defs).map(def => ({
    key: String(def?.key || '').trim(),
    label: sanitizeLinkOpsClientText(def?.label || '', 80),
    intent: String(def?.intent || '').trim(),
    precheck: Boolean(def?.precheck),
    realSubmit: false,
    reason: projectOpenApiCapabilityReasonForClient({
      key: def?.key,
      precheckSupported: Boolean(def?.precheck),
      realSubmitSupported: false,
    }),
  })).filter(row => row.key);
}

function projectOpenApiCapabilityRowForClient(row, actor = null) {
  if (!row || typeof row !== 'object') return null;
  const storeKey = String(row.storeKey || '').trim().toUpperCase();
  const actorWriteAllowed = actorCanWriteStores(actor, [storeKey]);
  const actionCapabilities = asArray(row.actionCapabilities)
    .map(action => {
      const projected = projectOpenApiActionCapabilityForClient(action);
      const actorWhitelist = biOpsWriteWhitelistAllowedForActor(actor, {operation: action?.intent, storeKey});
      return {
        ...projected,
        actorCanSubmit: Boolean(projected.realSubmitSupported && actorWriteAllowed && actorWhitelist.allowed),
      };
    })
    .filter(action => action.key);
  return {
    storeKey,
    storeName: sanitizeLinkOpsClientText(row.storeName || '', 80),
    status: String(row.status || '').trim(),
    configured: Boolean(row.configured),
    enabled: Boolean(row.enabled),
    authorized: Boolean(row.authorized),
    apiConnected: Boolean(row.apiConnected ?? row.authorized),
    verifiedRead: Boolean(row.verifiedRead),
    salesReconciliation: Boolean(row.salesReconciliation),
    salesReconciliationLatest: row.salesReconciliationLatest || null,
    returnReconciliation: Boolean(row.returnReconciliation),
    returnReconciliationLatest: row.returnReconciliationLatest || null,
    productReconciliation: Boolean(row.productReconciliation),
    productReconciliationLatest: row.productReconciliationLatest || null,
    writePrecheckReady: Boolean(row.writePrecheckReady),
    writeConfirmable: Boolean(row.writeConfirmable),
    actorCanSubmit: actionCapabilities.some(action => action.actorCanSubmit),
    canSilentWrite: false,
    actionCapabilities,
    safeWriteEnabled: Boolean(row.safeWriteEnabled),
    safeWrite: {
      enabled: Boolean(row.safeWrite?.enabled),
      operationAllowed: Boolean(row.safeWrite?.operationAllowed),
      storeAllowed: Boolean(row.safeWrite?.storeAllowed),
    },
    realSubmitWhitelist: {
      enabled: Boolean(row.realSubmitWhitelist?.enabled),
      configured: Boolean(row.realSubmitWhitelist?.configured),
      ruleCount: Number(row.realSubmitWhitelist?.ruleCount || 0) || 0,
      matchedRuleCount: Number(row.realSubmitWhitelist?.matchedRuleCount || 0) || 0,
    },
    readDomains: asArray(row.readDomains).map(x => String(x || '').trim()).filter(Boolean),
    readDomainLabels: asArray(row.readDomainLabels).map(x => sanitizeLinkOpsClientText(x, 80)).filter(Boolean),
    writeDomains: asArray(row.writeDomains).map(x => String(x || '').trim()).filter(Boolean),
    writeDomainLabels: asArray(row.writeDomainLabels).map(x => sanitizeLinkOpsClientText(x, 80)).filter(Boolean),
    authorizedAt: row.authorizedAt || null,
    shopName: sanitizeLinkOpsClientText(row.shopName || '', 120),
    profileKey: sanitizeLinkOpsClientText(row.profileKey || '', 80),
    credentialPresence: {
      apiCredential: {present: Boolean(row.credentialPresence?.apiCredential?.present)},
      encryptedCredential: {present: Boolean(row.credentialPresence?.encryptedCredential?.present)},
    },
    note: row.authorized
      ? (row.verifiedRead
        ? '店铺已接通；可在聊天里安排已开放的运营动作。'
        : '店铺已授权，接口连通性还在确认。')
      : '店铺还没完成授权。',
  };
}

function projectOpenApiCapabilityLedgerForClient(ledger, actor = null) {
  const rows = asArray(ledger?.rows)
    .map(row => projectOpenApiCapabilityRowForClient(row, actor))
    .filter(Boolean);
  return {
    ok: ledger?.ok !== false,
    generatedAt: ledger?.generatedAt || new Date().toISOString(),
    environment: ledger?.environment || 'prod',
    probeSummary: ledger?.probeSummary || null,
    salesReconciliationSummary: ledger?.salesReconciliationSummary || null,
    returnReconciliationSummary: ledger?.returnReconciliationSummary || null,
    productReconciliationSummary: ledger?.productReconciliationSummary || null,
    market: ledger?.market || 'SA',
    cooperationMode: ledger?.cooperationMode || '半托管',
    apiBase: ledger?.apiBase || '',
    allStoreKeys: asArray(ledger?.allStoreKeys).map(x => String(x || '').trim().toUpperCase()).filter(Boolean),
    counts: {
      ...(ledger?.counts || {
        total: rows.length,
        authorized: rows.filter(r => r.authorized).length,
        readReady: rows.filter(r => r.verifiedRead).length,
        writePrecheckReady: rows.filter(r => r.writePrecheckReady).length,
        writeConfirmable: rows.filter(r => r.writeConfirmable).length,
      }),
      actorControlledSubmitReady: rows.filter(r => r.actorCanSubmit).length,
    },
    readDomainLabels: ledger?.readDomainLabels || OPENAPI_READ_DOMAIN_LABELS,
    writeDomainLabels: ledger?.writeDomainLabels || OPENAPI_WRITE_DOMAIN_LABELS,
    actionCapabilityDefinitions: projectOpenApiCapabilityDefinitionsForClient(ledger?.actionCapabilityDefinitions),
    safety: {
      naturalLanguageWrites: 'chat_controlled_checked_execution',
      secretsInResponse: false,
      canSilentWrite: false,
      realSubmitRequires: ['账号有权限', '资料检查通过', '你在聊天里明确同意', '提交后回读或人工确认结果'],
      safeWriteOperations: {
        enabled: Boolean(ledger?.safety?.safeWriteOperations?.enabled),
        allowedOperations: asArray(ledger?.safety?.safeWriteOperations?.allowedOperations).map(x => String(x || '').trim()).filter(Boolean),
        allowedStores: asArray(ledger?.safety?.safeWriteOperations?.allowedStores).map(x => String(x || '').trim().toUpperCase()).filter(Boolean),
      },
      realSubmitWhitelist: {
        enabled: Boolean(ledger?.safety?.realSubmitWhitelist?.enabled),
        ruleCount: Number(ledger?.safety?.realSubmitWhitelist?.ruleCount || 0) || 0,
        operations: asArray(ledger?.safety?.realSubmitWhitelist?.operations).map(x => String(x || '').trim()).filter(Boolean),
        stores: asArray(ledger?.safety?.realSubmitWhitelist?.stores).map(x => String(x || '').trim().toUpperCase()).filter(Boolean),
      },
      maintenanceWrites: 'chat_controlled_checked_execution',
      productionSourceSwitch: 'cloud_current',
    },
    rows,
  };
}

async function manualLoginStoreKeys() {
  const config = await readJsonFile(STORES_PATH, null);
  const stores = Array.isArray(config?.stores) ? config.stores : [];
  const keys = stores
    .filter(s => s && s.enabled !== false && s.storeKey && s.profileKey && Number.isInteger(Number(s.port)))
    .map(s => String(s.storeKey || '').trim().toUpperCase())
    .filter(Boolean);
  return keys.length ? [...new Set(keys)] : DEFAULT_MANUAL_LOGIN_STORE_KEYS;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function md5Buffer(value) {
  return crypto.createHash('md5').update(value).digest();
}

function apacheApr1(password, salt) {
  const magic = '$apr1$';
  const normalizedSalt = String(salt || '').split('$')[0].slice(0, 8);
  const pw = Buffer.from(String(password || ''), 'utf8');
  const saltBuf = Buffer.from(normalizedSalt, 'utf8');
  let ctx = Buffer.concat([pw, Buffer.from(magic), saltBuf]);
  const final = md5Buffer(Buffer.concat([pw, saltBuf, pw]));
  for (let pl = pw.length; pl > 0; pl -= 16) ctx = Buffer.concat([ctx, final.slice(0, Math.min(16, pl))]);
  for (let i = pw.length; i > 0; i >>= 1) ctx = Buffer.concat([ctx, Buffer.from([i & 1 ? 0 : pw[0]])]);
  let digest = md5Buffer(ctx);
  for (let i = 0; i < 1000; i++) {
    const parts = [];
    if (i & 1) parts.push(pw); else parts.push(digest);
    if (i % 3) parts.push(saltBuf);
    if (i % 7) parts.push(pw);
    if (i & 1) parts.push(digest); else parts.push(pw);
    digest = md5Buffer(Buffer.concat(parts));
  }
  const itoa64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const to64 = (value, length) => {
    let out = '';
    let v = value;
    for (let i = 0; i < length; i++) {
      out += itoa64[v & 0x3f];
      v >>= 6;
    }
    return out;
  };
  const d = digest;
  const encoded =
    to64((d[0] << 16) | (d[6] << 8) | d[12], 4) +
    to64((d[1] << 16) | (d[7] << 8) | d[13], 4) +
    to64((d[2] << 16) | (d[8] << 8) | d[14], 4) +
    to64((d[3] << 16) | (d[9] << 8) | d[15], 4) +
    to64((d[4] << 16) | (d[10] << 8) | d[5], 4) +
    to64(d[11], 2);
  return `${magic}${normalizedSalt}$${encoded}`;
}

function timingSafeEqualString(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function verifyHtpasswdHash(hash, password) {
  const text = String(hash || '');
  if (text.startsWith('$apr1$')) {
    const parts = text.split('$');
    if (parts.length < 4) return false;
    return timingSafeEqualString(apacheApr1(password, parts[2]), text);
  }
  if (text.startsWith('{SHA}')) {
    const actual = crypto.createHash('sha1').update(String(password || ''), 'utf8').digest('base64');
    return timingSafeEqualString(`{SHA}${actual}`, text);
  }
  // Only keep support for the cleartext fallback for local/manual files. Do
  // not introduce new cleartext production users.
  return timingSafeEqualString(text, password);
}

function verifyPassword(user, password) {
  if (!user) return false;
  if (typeof user.password === 'string') {
    return timingSafeEqualString(user.password, password);
  }
  if (typeof user.passwordSha256 === 'string') {
    return timingSafeEqualString(user.passwordSha256, sha256Hex(password));
  }
  if (typeof user.passwordHash === 'string') {
    const parts = user.passwordHash.split(':');
    if (parts.length === 5 && parts[0] === 'pbkdf2' && parts[1] === 'sha256') {
      const iterations = Number(parts[2]);
      const salt = Buffer.from(parts[3], 'hex');
      const expected = Buffer.from(parts[4], 'hex');
      if (!Number.isInteger(iterations) || iterations < 10000 || !salt.length || !expected.length) return false;
      const actual = crypto.pbkdf2Sync(String(password || ''), salt, iterations, expected.length, 'sha256');
      return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    }
  }
  if (typeof user.htpasswdHash === 'string') {
    return verifyHtpasswdHash(user.htpasswdHash, password);
  }
  return false;
}

function normalizeStoreList(value) {
  if (value === '*' || value === 'all' || value === 'ALL') return ['*'];
  const raw = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(/[,\s]+/) : []);
  return [...new Set(raw.map(x => String(x || '').trim().toUpperCase()).filter(Boolean))];
}

function hasOwnField(obj, key) {
  return Boolean(obj && Object.prototype.hasOwnProperty.call(obj, key));
}

function firstOwnFieldValue(obj, keys) {
  for (const key of keys) {
    if (hasOwnField(obj, key)) return obj[key];
  }
  return undefined;
}

function userPublicFields(user) {
  const writeStores = normalizeStoreList(firstOwnFieldValue(user, ['writeStores', 'stores', 'storeKeys', 'allowedStores']) ?? []);
  return {
    username: user.username,
    displayName: String(user.displayName || user.name || user.username).trim(),
    role: String(user.role || 'operator').trim(),
    readStores: normalizeStoreList(hasOwnField(user, 'readStores') ? user.readStores : ['*']),
    writeStores,
    ownerKey: String(user.ownerKey || '').trim(),
    knowledgePublisher: user.knowledgePublisher === true,
    source: user.source,
  };
}

async function loadAccessRoles(file) {
  const cfg = await readJsonFile(file, {});
  const users = cfg && typeof cfg.users === 'object' ? cfg.users : {};
  const defaults = cfg && typeof cfg.defaults === 'object' ? cfg.defaults : {};
  return {users, defaults};
}

function applyAccessRole(user, accessRoles) {
  const pub = userPublicFields(user);
  const byUser = accessRoles.users?.[pub.username] || {};
  const role = String(byUser.role || pub.role || 'operator').trim();
  const byRole = accessRoles.defaults?.[role] || {};
  const readStores = hasOwnField(byUser, 'readStores')
    ? byUser.readStores
    : hasOwnField(user, 'readStores')
      ? user.readStores
      : hasOwnField(byRole, 'readStores')
        ? byRole.readStores
        : ['*'];
  const writeStores = hasOwnField(byUser, 'writeStores')
    ? byUser.writeStores
    : hasOwnField(user, 'writeStores')
      ? user.writeStores
      : hasOwnField(byRole, 'writeStores')
        ? byRole.writeStores
        : [];
  return {
    ...pub,
    ...byRole,
    ...byUser,
    username: pub.username,
    displayName: String(byUser.displayName || byRole.displayName || pub.displayName || pub.username).trim(),
    role,
    readStores: normalizeStoreList(readStores),
    writeStores: normalizeStoreList(writeStores),
    source: pub.source,
  };
}

async function loadHtpasswdUsers(file) {
  try {
    const text = await fs.readFile(file, 'utf8');
    return text.split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#') && line.includes(':'))
      .map(line => {
        const idx = line.indexOf(':');
        const username = line.slice(0, idx).trim();
        const htpasswdHash = line.slice(idx + 1).trim();
        return username ? {
          username,
          displayName: username,
          role: 'operator',
          htpasswdHash,
          source: file,
        } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function loadAuthUsers(authFile) {
  const users = [];
  const local = await readJsonFile(authFile, null);
  if (local && Array.isArray(local.users)) {
    for (const u of local.users) {
      const username = String(u.username || u.email || '').trim();
      if (!username) continue;
      const authUser = {
        username,
        displayName: String(u.displayName || u.name || username).trim(),
        role: String(u.role || 'operator').trim(),
        password: typeof u.password === 'string' ? u.password : undefined,
        passwordSha256: typeof u.passwordSha256 === 'string' ? u.passwordSha256 : undefined,
        passwordHash: typeof u.passwordHash === 'string' ? u.passwordHash : undefined,
        ownerKey: String(u.ownerKey || '').trim(),
        source: path.relative(ROOT, authFile),
      };
      if (hasOwnField(u, 'readStores')) authUser.readStores = normalizeStoreList(u.readStores);
      const rawWriteStores = firstOwnFieldValue(u, ['writeStores', 'stores', 'storeKeys', 'allowedStores']);
      if (rawWriteStores !== undefined) authUser.writeStores = normalizeStoreList(rawWriteStores);
      users.push(authUser);
    }
  }

  // Fallback to the existing local Metabase admin credential so the BI portal
  // can be used immediately without copying secrets into code or chat.
  const metabaseAdminFile = path.join(ROOT, 'infra', 'metabase', '.admin.local.json');
  const metabaseAdmin = await readJsonFile(metabaseAdminFile, null);
  if (metabaseAdmin?.email && metabaseAdmin?.password) {
    const username = String(metabaseAdmin.email).trim();
    if (!users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
      const displayName = [metabaseAdmin.first_name, metabaseAdmin.last_name].filter(Boolean).join(' ').trim() || username;
      users.push({
        username,
        displayName,
        role: 'admin',
        password: String(metabaseAdmin.password),
        readStores: ['*'],
        writeStores: ['*'],
        source: path.relative(ROOT, metabaseAdminFile),
      });
    }
  }
  return users;
}

async function loadPortalUsers(args) {
  const accessRoles = await loadAccessRoles(args.accessRolesFile);
  const seen = new Set();
  const users = [];
  for (const user of await loadAuthUsers(args.authFile)) {
    const key = String(user.username || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    users.push({...user, ...applyAccessRole(user, accessRoles)});
    seen.add(key);
  }
  for (const user of await loadHtpasswdUsers(args.htpasswdFile)) {
    const key = String(user.username || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    users.push({...user, ...applyAccessRole(user, accessRoles)});
    seen.add(key);
  }
  return users;
}

function actorFromUser(user) {
  return {
    username: user.username,
    displayName: user.displayName || user.username,
    role: user.role || 'operator',
    readStores: normalizeStoreList(user.readStores || ['*']),
    writeStores: normalizeStoreList(user.writeStores || []),
    ownerKey: user.ownerKey || '',
    knowledgePublisher: user.knowledgePublisher === true,
    source: user.source,
  };
}

function unauthorized(res, redirectTo = '/') {
  send(res, 401, 'Authentication required', {
    'Content-Type': 'text/plain; charset=utf-8',
    'Location': `/login?next=${encodeURIComponent(redirectTo || '/')}`,
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

async function ensureSessionSecret(file) {
  try {
    const text = (await fs.readFile(file, 'utf8')).trim();
    if (text.length >= 32) return text;
  } catch {}
  const secret = crypto.randomBytes(48).toString('base64url');
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, secret + '\n', {encoding: 'utf8', mode: 0o600});
  try { await fs.chmod(file, 0o600); } catch {}
  return secret;
}

function signSessionPayload(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifySessionToken(token, secret) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (!timingSafeEqualString(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    if (Number(payload.exp || 0) < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function sessionCookie(token, req, maxAgeSec = 86400 * 14) {
  const secure = String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
  return `bi_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}

function clearSessionCookie(req) {
  const secure = String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
  return `bi_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

function authenticateBasicRequest(req, users) {
  const header = req.headers.authorization || '';
  const m = /^Basic\s+(.+)$/i.exec(header);
  if (!m) {
    return null;
  }
  let decoded = '';
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  const sep = decoded.indexOf(':');
  if (sep < 0) {
    return null;
  }
  const username = decoded.slice(0, sep);
  const password = decoded.slice(sep + 1);
  const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!verifyPassword(user, password)) {
    return null;
  }
  return actorFromUser(user);
}

function authenticateSessionRequest(req, users, sessionSecret) {
  const token = parseCookies(req).bi_session;
  const payload = verifySessionToken(token, sessionSecret);
  if (!payload?.username) return null;
  const user = users.find(u => u.username.toLowerCase() === String(payload.username).toLowerCase());
  return user ? actorFromUser(user) : null;
}

function authenticateRequest(req, users, sessionSecret) {
  return authenticateSessionRequest(req, users, sessionSecret) || authenticateBasicRequest(req, users);
}

function isPublicPath(pathname) {
  return pathname === '/login' || pathname === '/api/login' || pathname === '/favicon.ico';
}

function isApiPath(pathname) {
  return pathname.startsWith('/api/');
}

function isTrustedInternalRequest(req) {
  const remote = normalizeRemoteAddress(req);
  const hasProxyHeaders = Boolean(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['x-forwarded-proto']);
  return !hasProxyHeaders && (remote === '127.0.0.1' || remote === '::1' || remote === 'localhost');
}

function internalActor() {
  return {
    username: 'local-system',
    displayName: '服务器内部任务',
    role: 'system',
    readStores: ['*'],
    writeStores: ['*'],
    ownerKey: 'SYSTEM',
    knowledgePublisher: false,
    source: 'trusted-localhost',
  };
}

function publicActor(actor) {
  if (!actor) return null;
  return {
    username: actor.username,
    displayName: actor.displayName,
    role: actor.role,
    readStores: normalizeStoreList(actor.readStores || ['*']),
    writeStores: normalizeStoreList(actor.writeStores || []),
    ownerKey: actor.ownerKey || '',
  };
}

function canWriteAllStores(actor) {
  const role = String(actor?.role || '').toLowerCase();
  return role === 'admin' || role === 'owner' || normalizeStoreList(actor?.writeStores || []).includes('*');
}

function inferredLinkOpsStoreActor(value) {
  const candidates = [
    ...(Array.isArray(value?.tasks) ? value.tasks : []),
    ...(Array.isArray(value?.sessions) ? value.sessions : []),
    ...(value?.actions && typeof value.actions === 'object' ? Object.values(value.actions) : []),
  ];
  for (const record of candidates) {
    const actor = String(
      record?.updatedByUser
      || record?.actorUser
      || record?.requestedByUser
      || record?.createdByUser
      || record?.ownerUser
      || record?.ownership?.ownerUser
      || record?.ownership?.actorKey
      || record?.ownership?.username
      || ''
    ).trim();
    if (actor) return actor;
  }
  return '';
}

async function readLinkOpsTaskStore(args) {
  if (args.linkOpsStoreGateway) return args.linkOpsStoreGateway.readTaskStore();
  return readLinkOpsTaskStore(args);
}

async function writeLinkOpsTaskStore(args, value) {
  if (args.linkOpsStoreGateway) {
    return args.linkOpsStoreGateway.replaceTaskStore(value, {actorUser: inferredLinkOpsStoreActor(value)});
  }
  await writeLinkOpsTaskStore(args, value);
  return value;
}

async function readLinkOpsChatStore(args) {
  if (args.linkOpsStoreGateway) return args.linkOpsStoreGateway.readChatStore();
  return readLinkOpsChatStore(args);
}

async function writeLinkOpsChatStore(args, value) {
  if (args.linkOpsStoreGateway) {
    return args.linkOpsStoreGateway.replaceChatStore(value, {actorUser: inferredLinkOpsStoreActor(value)});
  }
  await writeLinkOpsChatStore(args, value);
  return value;
}

async function readLinkOpsActionState(args) {
  if (args.linkOpsStoreGateway) return args.linkOpsStoreGateway.readActionState();
  return readLinkOpsActionState(args);
}

async function writeLinkOpsActionState(args, value) {
  if (args.linkOpsStoreGateway) {
    return args.linkOpsStoreGateway.replaceActionState(value, {actorUser: inferredLinkOpsStoreActor(value)});
  }
  await writeLinkOpsActionState(args, value);
  return value;
}

function actorHasGlobalOpsView(actor) {
  const role = String(actor?.role || '').trim().toLowerCase();
  return role === 'admin' || role === 'owner';
}

function isInternalSystemActor(actor) {
  return String(actor?.username || '') === 'local-system' || String(actor?.role || '').toLowerCase() === 'system';
}

function requireConcreteOperatorActor(actor) {
  const role = String(actor?.role || '').trim().toLowerCase();
  if (actor && !isInternalSystemActor(actor) && ['admin', 'owner', 'operator'].includes(role)) return null;
  return {
    ok: false,
    error: '自动运营写操作必须使用具体 BI operator/owner 登录账号，不能使用匿名、只读或服务器内部任务身份',
  };
}

function actorCanReadStores(actor, stores) {
  const targets = normalizeStoreList(stores);
  if (!targets.length) return true;
  const allowed = new Set(normalizeStoreList(actor?.readStores || []));
  if (allowed.has('*')) return true;
  return targets.every(store => allowed.has(store));
}

function requireReadStores(actor, stores) {
  const targets = normalizeStoreList(stores);
  if (actorCanReadStores(actor, targets)) return null;
  return {
    ok: false,
    error: '当前账号没有这些店铺的自动运营查看权限',
    stores: targets,
    allowedStores: normalizeStoreList(actor?.readStores || []),
  };
}

function actorCanWriteStores(actor, stores) {
  const targets = normalizeStoreList(stores);
  if (!targets.length) return true;
  if (canWriteAllStores(actor)) return true;
  const allowed = new Set(normalizeStoreList(actor?.writeStores || []));
  return targets.every(s => allowed.has(s));
}

function requireWriteStores(actor, stores) {
  const targets = normalizeStoreList(stores);
  if (actorCanWriteStores(actor, targets)) return null;
  return {
    ok: false,
    error: '当前账号没有这些店铺的自动运营写权限',
    stores: targets,
    allowedStores: normalizeStoreList(actor?.writeStores || []),
  };
}

function requireWriteTargets(actor, targets) {
  const normalized = normalizeLinkOpsTargetSet(targets);
  const stores = normalizeConcreteStoreKeys(normalized.writeStores.length ? normalized.writeStores : normalized.stores);
  return stores.length ? requireWriteStores(actor, stores) : null;
}

function normalizeOpsActorKey(value) {
  return String(value || '').normalize('NFKC').trim().toLowerCase();
}

function actorOpsKey(actor) {
  return normalizeOpsActorKey(actor?.username || '');
}

function isConcreteLegacyOpsActor(value) {
  const raw = String(value || '').normalize('NFKC').trim();
  const key = normalizeOpsActorKey(raw);
  if (!key || ['local-system', 'system', 'anonymous', 'unknown', 'localhost'].includes(key)) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(key)) return false;
  if (key.includes(':') && /^[0-9a-f:.]+$/i.test(key)) return false;
  return true;
}

function linkOpsOwnershipForRecord(record) {
  const existing = record?.ownership && typeof record.ownership === 'object' ? record.ownership : {};
  const explicitActor = normalizeOpsActorKey(existing.actorKey || record?.actorKey || record?.ownerActorKey || '');
  const requestedByUser = String(record?.requestedByUser || '').normalize('NFKC').trim();
  const legacyActor = !explicitActor && isConcreteLegacyOpsActor(requestedByUser)
    ? normalizeOpsActorKey(requestedByUser)
    : '';
  const actorKey = explicitActor || legacyActor;
  const source = String(existing.source || '').trim()
    || (explicitActor ? 'stored' : legacyActor ? 'legacy_requested_by_user' : 'legacy_unowned');
  return {
    version: 1,
    state: actorKey ? 'owned' : 'legacy_unowned',
    actorKey,
    username: String(existing.username || (actorKey ? requestedByUser || actorKey : '')).trim(),
    ownerKey: String(existing.ownerKey || record?.ownerKey || '').trim(),
    assignedAt: String(existing.assignedAt || (actorKey ? record?.createdAt || record?.updatedAt || '' : '')).trim(),
    source,
  };
}

function normalizeLinkOpsRecordOwnership(record) {
  if (!record || typeof record !== 'object') return record;
  const ownership = linkOpsOwnershipForRecord(record);
  return {
    ...record,
    actorKey: ownership.actorKey,
    ownerKey: ownership.ownerKey,
    ownership,
  };
}

function bindLinkOpsRecordToActor(record, actor, source = 'created') {
  const now = new Date().toISOString();
  const actorKey = actorOpsKey(actor);
  if (!actorKey) throw new Error('Missing concrete BI actor identity');
  const ownership = {
    version: 1,
    state: 'owned',
    actorKey,
    username: String(actor?.username || '').trim(),
    ownerKey: String(actor?.ownerKey || '').trim(),
    assignedAt: now,
    source: String(source || 'created'),
  };
  return {
    ...record,
    actorKey,
    ownerKey: ownership.ownerKey,
    ownership,
  };
}

function linkOpsSessionStores(session) {
  const targets = normalizeLinkOpsTargetSet(session?.targets || {});
  return normalizeStoreList([
    ...targets.stores,
    ...targets.writeStores,
    ...targets.sourceStores,
  ]);
}

function linkOpsAccessDenied(kind, reason, stores = []) {
  return {
    ok: false,
    error: reason,
    resource: kind,
    stores: normalizeStoreList(stores),
  };
}

function authorizeLinkOpsRecord(actor, record, {
  kind = 'task',
  mode = 'read',
  globalView = false,
  claimLegacy = false,
} = {}) {
  const normalized = normalizeLinkOpsRecordOwnership(record);
  const ownership = normalized?.ownership || linkOpsOwnershipForRecord(normalized);
  const actorKey = actorOpsKey(actor);
  const stores = kind === 'session' ? linkOpsSessionStores(normalized) : taskWriteStores(normalized);
  const sourceStores = kind === 'task' ? taskSourceStores(normalized) : [];
  const globalReadAllowed = mode === 'read' && globalView && actorHasGlobalOpsView(actor);
  if (!actorKey || isInternalSystemActor(actor)) {
    return {ok: false, record: normalized, denied: linkOpsAccessDenied(kind, '必须使用具体 BI 登录账号访问自动运营数据', stores)};
  }
  if (globalView && mode === 'read' && !globalReadAllowed) {
    return {ok: false, record: normalized, denied: linkOpsAccessDenied(kind, '只有 owner/admin 可以使用全局自动运营查看范围', stores)};
  }
  let nextRecord = normalized;
  let claimedLegacy = false;
  let ownershipMigrated = false;
  if (!globalReadAllowed) {
    if (ownership.actorKey && ownership.actorKey !== actorKey) {
      return {ok: false, record: normalized, denied: linkOpsAccessDenied(kind, '该自动运营记录属于其他 BI 账号', stores)};
    }
    if (ownership.actorKey === actorKey && mode !== 'read' && (!ownership.ownerKey || !ownership.username)) {
      const migratedOwnership = {
        ...ownership,
        username: String(actor?.username || ownership.username || '').trim(),
        ownerKey: String(actor?.ownerKey || ownership.ownerKey || '').trim(),
        assignedAt: ownership.assignedAt || new Date().toISOString(),
      };
      nextRecord = {
        ...normalized,
        actorKey,
        ownerKey: migratedOwnership.ownerKey,
        ownership: migratedOwnership,
      };
      ownershipMigrated = true;
    }
    if (!ownership.actorKey) {
      if (mode === 'read' && actorHasGlobalOpsView(actor)) {
        // Owners may inspect quarantined single-user legacy rows before deciding
        // whether to claim them; operators never inherit anonymous legacy data.
      } else if (mode !== 'read' && claimLegacy && actorHasGlobalOpsView(actor)) {
        nextRecord = bindLinkOpsRecordToActor(normalized, actor, 'legacy_owner_claim');
        claimedLegacy = true;
      } else {
        return {ok: false, record: normalized, denied: linkOpsAccessDenied(kind, '旧版自动运营记录尚未安全归属；仅 owner/admin 可查看并在首次修改时认领', stores)};
      }
    }
  }
  const storeDenied = kind === 'session' || globalReadAllowed
    ? requireReadStores(actor, stores)
    : requireWriteStores(actor, stores);
  if (storeDenied) return {ok: false, record: nextRecord, denied: storeDenied};
  const sourceStoreDenied = kind === 'task' ? requireReadStores(actor, sourceStores) : null;
  if (sourceStoreDenied) return {ok: false, record: nextRecord, denied: sourceStoreDenied};
  return {ok: true, record: nextRecord, claimedLegacy, ownershipMigrated, globalView: globalReadAllowed};
}

function linkOpsTasksForActor(tasks, actor, {globalView = false, mode = 'read'} = {}) {
  return asArray(tasks)
    .map(task => authorizeLinkOpsRecord(actor, task, {kind: 'task', mode, globalView, claimLegacy: false}))
    .filter(access => access.ok)
    .map(access => access.record);
}

function linkOpsSessionsForActor(sessions, actor, {globalView = false, mode = 'read'} = {}) {
  return asArray(sessions)
    .map(session => authorizeLinkOpsRecord(actor, session, {kind: 'session', mode, globalView, claimLegacy: false}))
    .filter(access => access.ok)
    .map(access => access.record);
}

function requestedGlobalOpsView(url) {
  const scope = String(url?.searchParams?.get('scope') || '').trim().toLowerCase();
  return ['all', 'global', 'audit'].includes(scope)
    || ['1', 'true', 'yes'].includes(String(url?.searchParams?.get('global') || '').trim().toLowerCase());
}

function actionStatePatchStore(patch) {
  const key = String(patch?.key || '').trim();
  const keyStore = String(key.split('|')[1] || '').trim().toUpperCase();
  const explicitStore = String(patch?.storeKey || patch?.store_key || patch?.store || '').trim().toUpperCase();
  if (!keyStore || !SHEIN_STORE_KEYS.has(keyStore)) {
    return {ok: false, error: 'Action-state key must contain a valid SHEIN store', key, keyStore};
  }
  if (explicitStore && keyStore && explicitStore !== keyStore) {
    return {ok: false, error: 'Action-state store does not match key', key, keyStore, explicitStore};
  }
  return {ok: true, key, storeKey: keyStore};
}

function loginPageHtml({error = '', next = '/', user = ''} = {}) {
  const safeNext = next && String(next).startsWith('/') && !String(next).startsWith('//') ? String(next) : '/';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>SHEIN BI 登录</title><style>
:root{color-scheme:light;--bg:#f6f1ea;--ink:#211b16;--muted:#7a6f65;--line:#e6d9c9;--brand:#7357ff;--brand2:#f97316;--card:rgba(255,255,255,.86)}
*{box-sizing:border-box}body{margin:0;min-height:100vh;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:radial-gradient(circle at 12% 8%,#efe7ff 0,transparent 34%),radial-gradient(circle at 88% 18%,#ffe8c7 0,transparent 30%),linear-gradient(135deg,#fbf7f1,#efe9df);color:var(--ink);display:grid;place-items:center;padding:24px}
.shell{width:min(980px,100%);display:grid;grid-template-columns:1.08fr .92fr;gap:22px;align-items:stretch}.hero,.card{border:1px solid rgba(120,98,72,.16);background:var(--card);backdrop-filter:blur(18px);box-shadow:0 24px 80px rgba(38,28,17,.12);border-radius:28px}
.hero{padding:38px;display:flex;flex-direction:column;justify-content:space-between;min-height:520px;overflow:hidden;position:relative}.hero:after{content:"";position:absolute;inset:auto -80px -100px auto;width:300px;height:300px;border-radius:50%;background:linear-gradient(135deg,var(--brand),var(--brand2));opacity:.16}
.eyebrow{font-size:13px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);font-weight:800}.hero h1{font-size:46px;line-height:1.05;margin:22px 0 16px;letter-spacing:-.05em}.hero p{font-size:16px;line-height:1.8;color:var(--muted);max-width:520px}.chips{display:flex;flex-wrap:wrap;gap:10px;margin-top:28px}.chips span{border:1px solid var(--line);background:#fff8;padding:9px 12px;border-radius:999px;font-weight:700;font-size:13px}
.card{padding:30px}.card h2{margin:0 0 8px;font-size:26px;letter-spacing:-.04em}.sub{margin:0 0 24px;color:var(--muted);line-height:1.6}.field{margin:14px 0}.field label{display:block;font-size:13px;font-weight:800;color:#51463b;margin:0 0 8px}.field input{width:100%;border:1px solid var(--line);border-radius:16px;padding:14px 15px;font-size:16px;background:#fff;color:var(--ink);outline:none}.field input:focus{border-color:var(--brand);box-shadow:0 0 0 4px rgba(115,87,255,.12)}
.btn{width:100%;border:0;border-radius:16px;background:linear-gradient(135deg,var(--brand),#8b5cf6);color:#fff;font-weight:900;font-size:16px;padding:14px 18px;cursor:pointer;margin-top:16px;box-shadow:0 12px 34px rgba(115,87,255,.28)}.btn:hover{filter:brightness(1.04)}.err{background:#fff0f0;border:1px solid #ffd1d1;color:#b42318;padding:12px 14px;border-radius:14px;margin-bottom:14px;font-weight:700}.foot{margin-top:18px;color:var(--muted);font-size:12px;line-height:1.6}
@media(max-width:820px){.shell{grid-template-columns:1fr}.hero{min-height:auto}.hero h1{font-size:36px}}
</style></head><body><main class="shell"><section class="hero"><div><div class="eyebrow">SHEIN BI · Ops Console</div><h1>经营数据和自动运营，统一从这里进入。</h1><p>登录后可以查看全部店铺数据；自动运营写操作会按账号权限控制店铺范围，并写入记录日志。</p><div class="chips"><span>全店数据可读</span><span>店铺写权限隔离</span><span>操作可追溯</span><span>Codex 受控网关</span></div></div><p>安全边界：不会静默修改 SHEIN，写动作会进入当前会话处理；系统会自动检查资料、按账号权限拦截越界、提交后回读结果。</p></section><section class="card"><h2>登录 BI</h2><p class="sub">使用你的 BI 账号进入。原公网账号密码继续有效，只是不再使用浏览器弹框。</p>${error ? `<div class="err">${htmlEscape(error)}</div>` : ''}<form method="post" action="/api/login"><input type="hidden" name="next" value="${htmlEscape(safeNext)}"/><div class="field"><label>账号</label><input name="username" autocomplete="username" value="${htmlEscape(user)}" autofocus required/></div><div class="field"><label>密码</label><input name="password" type="password" autocomplete="current-password" required/></div><button class="btn" type="submit">进入系统</button></form><div class="foot">如果你能看到这个页面，说明公网 Basic Auth 已经不再拦截；后续权限会在系统内识别到具体操作者。</div></section></main></body></html>`;
}

function normalizeRemoteAddress(req) {
  const forwardedFor = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)[0];
  const forwardedRealIp = String(req.headers['x-real-ip'] || '').trim();
  const forwarded = forwardedFor || forwardedRealIp;
  if (forwarded) return forwarded.startsWith('::ffff:') ? forwarded.slice(7) : forwarded;
  const raw = String(req.socket.remoteAddress || '');
  if (raw.startsWith('::ffff:')) return raw.slice(7);
  if (raw === '::1') return '127.0.0.1';
  return raw || 'unknown';
}

function actorLabel(actor, req) {
  return actor?.displayName || actor?.username || normalizeRemoteAddress(req);
}

function actorUser(actor, req) {
  return actor?.username || normalizeRemoteAddress(req);
}

function requestBearerToken(req) {
  const match = /^Bearer\s+(.+)$/i.exec(String(req?.headers?.authorization || '').trim());
  return match ? match[1].trim() : '';
}

function ownerKnowledgeActivationActor(req) {
  const expected = String(process.env.SHEIN_OWNER_KNOWLEDGE_GITHUB_ACTIVATION_TOKEN || '');
  const supplied = requestBearerToken(req);
  if (!expected || !supplied) return null;
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(supplied, 'utf8');
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  return {
    username: 'github-owner-knowledge-ci',
    displayName: 'GitHub owner knowledge CI',
    role: 'knowledge_activation',
    readStores: [],
    writeStores: [],
    ownerKey: '',
    source: 'github-actions',
  };
}

function createAsyncExclusiveRunner() {
  let tail = Promise.resolve();
  return async work => {
    let release;
    const ticket = new Promise(resolve => { release = resolve; });
    const previous = tail;
    tail = ticket;
    await previous.catch(() => {});
    try {
      return await work();
    } finally {
      release();
    }
  };
}

function ownerKnowledgeContextForTask(task, message = '') {
  const targets = normalizeLinkOpsTargetSet(task?.targets || {});
  return {
    question: String(message || task?.command || ''),
    command: String(task?.command || ''),
    intents: asArray(task?.intents).map(String),
    stores: normalizeConcreteStoreKeys(targets.stores),
    productRefs: targets.productRefs,
    targets,
  };
}

function ownerKnowledgeTaskSnapshot(bundle) {
  return {
    version: 1,
    fingerprint: String(bundle?.fingerprint || ''),
    capturedAt: new Date().toISOString(),
    rules: asArray(bundle?.rules).slice(0, 20).map(rule => ({
      ruleKey: String(rule?.ruleKey || ''),
      versionId: String(rule?.versionId || ''),
      text: String(rule?.text || '').slice(0, 1_200),
      risk: String(rule?.risk || ''),
      tags: asArray(rule?.tags).map(String).slice(0, 20),
      machinePolicy: rule?.machinePolicy && typeof rule.machinePolicy === 'object' ? rule.machinePolicy : null,
    })),
  };
}

async function bindOwnerKnowledgeToTask(task, args, message = '') {
  const service = args?.ownerKnowledgeService;
  if (!task || !service) return {task, changed: false, bundle: null};
  const bundle = await service.getActiveBundle(ownerKnowledgeContextForTask(task, message), {limit: 20});
  const previous = String(task?.ownerKnowledgePolicy?.fingerprint || '');
  if (previous && previous === bundle.fingerprint) return {task, changed: false, bundle};
  return {
    task: {
      ...task,
      ownerKnowledgePolicy: ownerKnowledgeTaskSnapshot(bundle),
      updatedAt: new Date().toISOString(),
    },
    changed: true,
    bundle,
  };
}

async function captureOwnerKnowledgeFromBiMessage({actor, userMessage, session, args, req}) {
  const service = args?.ownerKnowledgeService;
  if (!service || !actorCanPublishOwnerKnowledge(actor, service.authorityId)) return {captured: false, reason: 'not_publisher'};
  if (!isOwnerKnowledgeCandidateText(userMessage)) return {captured: false, reason: 'not_reusable_experience'};
  const latestUser = [...asArray(session?.messages)].reverse().find(message => message?.role === 'user');
  const durable = isOwnerKnowledgeDurableText(userMessage);
  const withConsistencyLock = args?.withOwnerKnowledgeConsistencyLock || (work => work());
  const result = await withConsistencyLock(() => {
    args?.bumpOwnerKnowledgeGeneration?.();
    return service.ingest([{
        text: String(userMessage || '').slice(0, 4_000),
        sourceKind: 'owner_bi_message',
        sourceId: `${session?.id || 'session'}:${latestUser?.id || 'message'}`,
        sourceAt: latestUser?.at || new Date().toISOString(),
        explicitDurable: durable,
        activation: durable ? 'active' : 'candidate',
      }], {actor, actorUser: actorUser(actor, req)});
  });
  return {captured: true, durable, result};
}

async function appendAudit(file, entry) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.appendFile(file, JSON.stringify(entry) + '\n', 'utf8');
}

function compactLinkOpsAuditEntry(entry) {
  const task = entry?.task && typeof entry.task === 'object' ? entry.task : {};
  const writeAudit = task.writeAudit && typeof task.writeAudit === 'object' ? task.writeAudit : null;
  return {
    at: String(entry?.at || ''),
    type: String(entry?.type || ''),
    ok: entry?.ok ?? null,
    actor: entry?.actor ? {
      username: String(entry.actor.username || ''),
      displayName: String(entry.actor.displayName || ''),
      role: String(entry.actor.role || ''),
      ownerKey: String(entry.actor.ownerKey || ''),
    } : null,
    remoteAddress: String(entry?.remoteAddress || entry?.requestMeta?.remoteAddress || ''),
    task: {
      id: String(task.id || ''),
      status: String(task.status || ''),
      progress: task.progress ?? null,
      stores: normalizeStoreList(task.stores || task.targetStores || []),
      sourceStores: normalizeStoreList(task.sourceStores || []),
      writeStores: normalizeStoreList(task.writeStores || []),
      execution: task.execution ? {
        runId: String(task.execution.runId || ''),
        state: String(task.execution.state || ''),
        canSilentWrite: Boolean(task.execution.canSilentWrite),
        canAutoSubmit: Boolean(task.execution.canAutoSubmit),
      } : null,
      writeAudit: writeAudit ? {
        runId: String(writeAudit.runId || ''),
        requestedMode: String(writeAudit.requestedMode || ''),
        finalState: String(writeAudit.finalState || ''),
        submitted: Boolean(writeAudit.submitted),
        confirmTextPresent: Boolean(writeAudit.confirmTextPresent),
        executeAllowed: Boolean(writeAudit.executeAllowed),
        targetStores: normalizeStoreList(writeAudit.targetStores || []),
        sourceStores: normalizeStoreList(writeAudit.sourceStores || []),
        writeStores: normalizeStoreList(writeAudit.writeStores || []),
        blockerCount: Number(writeAudit.blockerCount || 0),
        warningCount: Number(writeAudit.warningCount || 0),
        executorPayloadHashes: Array.isArray(writeAudit.executorEvidence)
          ? writeAudit.executorEvidence.map(x => ({
            storeKey: String(x?.storeKey || ''),
            mode: String(x?.mode || ''),
            state: String(x?.state || ''),
            payloadHash: String(x?.payloadHash || ''),
          })).filter(x => x.storeKey || x.payloadHash).slice(0, 20)
          : [],
      } : null,
    },
    denied: entry?.denied ? {
      error: String(entry.denied.error || ''),
      stores: normalizeStoreList(entry.denied.stores || []),
      allowedStores: normalizeStoreList(entry.denied.allowedStores || []),
    } : null,
  };
}

async function readLinkOpsAuditEntries(file, {taskId = '', limit = 40} = {}) {
  const id = String(taskId || '').trim();
  const max = Math.max(1, Math.min(100, Number(limit || 40)));
  let text = '';
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  const lines = text.split(/\r?\n/).filter(Boolean).slice(-5000);
  for (let i = lines.length - 1; i >= 0 && rows.length < max; i -= 1) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const type = String(entry?.type || '');
    if (!type.startsWith('link-ops-') && !type.startsWith('auth-')) continue;
    const entryTaskId = String(entry?.task?.id || entry?.taskId || '');
    const writeTaskId = String(entry?.task?.writeAudit?.taskId || '');
    if (id && entryTaskId !== id && writeTaskId !== id) continue;
    rows.push(compactLinkOpsAuditEntry(entry));
  }
  return rows;
}

function requestMeta(req) {
  return {
    remoteAddress: normalizeRemoteAddress(req),
    socketAddress: req.socket.remoteAddress || '',
    forwardedFor: String(req.headers['x-forwarded-for'] || ''),
    realIp: String(req.headers['x-real-ip'] || ''),
    userAgent: req.headers['user-agent'] || '',
  };
}

function actorAuditContext(actor, req) {
  return {
    username: actorUser(actor, req),
    displayName: actorLabel(actor, req),
    role: String(actor?.role || ''),
    ownerKey: String(actor?.ownerKey || ''),
    readStores: normalizeStoreList(actor?.readStores || ['*']),
    writeStores: normalizeStoreList(actor?.writeStores || []),
  };
}

function isCopySourceTitleHint(text, copyProductIntent = false) {
  if (!copyProductIntent) return false;
  const sourceText = String(text || '');
  return /标题[\s\S]{0,24}(?:复制|沿用|照搬|直接用|用|取|来自|源链接|那条)/.test(sourceText)
    || /(?:复制|沿用|照搬|直接用|用|取)[\s\S]{0,24}标题/.test(sourceText)
    || /title[\s\S]{0,24}(?:copy|same|source|use)/i.test(sourceText);
}

function isExplicitUpdateTitleIntent(text) {
  return /改标题|换标题|标题\s*(?:改成|改为|换成|设为|设置为|=|：|:)|title\s*(?:to|=|:)/i.test(String(text || ''));
}

function normalizeIntentsForCommand(intents = [], command = '') {
  const out = [...new Set(asArray(intents).map(x => String(x || '').trim()).filter(Boolean))];
  if (out.includes('copy_product_draft') && out.includes('update_title') && isCopySourceTitleHint(command, true) && !isExplicitUpdateTitleIntent(command)) {
    return out.filter(x => x !== 'update_title');
  }
  return out.length ? out : ['manual_review'];
}

function inferLinkOpsIntent(command) {
  const text = String(command || '').trim();
  const lower = text.toLowerCase();
  const intents = [];
  const activateLinkIntent = /恢复上架|重新上架|再次上架|改为上架|设为上架|设置上架|恢复在售|改回在售|上架回来/.test(text)
    || /\b(activate_link|on_shelf|onshelf|relist|restore_listing)\b/.test(lower);
  const naturalPublishIntent = /(?:给|在)\s*[A-Z]{2,3}\s*店铺?\s*上(?:一|1)(?:个|款)\s*[A-Z0-9-]+/i.test(text);
  const copyProductIntent = naturalPublishIntent
    || /补(?:一|1)?(?:个|条|款)?(?:新)?(?:链接|链|商品|上品)|补链|缺(?:少)?(?:上架|在售|可售|新)?(?:的)?(?:链接|链)|复制|拷贝|参考|上品|草稿|覆盖|创建草稿|创建链接|上链接|发链接|发布商品|刊登|提交审核/.test(text)
    || /\b(copy|draft|create|publish|coverage)\b/.test(lower);
  if (activateLinkIntent) intents.push('activate_link');
  if (copyProductIntent) intents.push('copy_product_draft');
  const copySourceTitleHint = isCopySourceTitleHint(text, copyProductIntent);
  const explicitUpdateTitleIntent = isExplicitUpdateTitleIntent(text);
  if ((/标题|title/.test(lower) && !copySourceTitleHint) || explicitUpdateTitleIntent) intents.push('update_title');
  if (/主图|图片|套图|image|photo|pic/.test(lower)) intents.push('update_images');
  if (/库存|补库存|改库存|虚拟库存|stock|inventory/.test(lower)) intents.push('update_inventory');
  const supplyPriceIntent = /供货价|成本价|cost price|supply price|cost\b/.test(lower);
  if (supplyPriceIntent) intents.push('update_supply_price');
  if (!supplyPriceIntent && /售价|原价|销售价|商品价|price/.test(lower)) intents.push('update_product_price');
  if (/下架|死链|淘汰|归档|停掉|移除|删除链接/.test(text)) intents.push('retire_link');
  if (/营销|活动|报名/.test(text)) intents.push('campaign_signup');
  if (/限时|折扣|秒杀|促销|discount/.test(lower)) intents.push('flash_discount');
  if (/证书|资质|合规/.test(text)) intents.push('certificate_review');
  if (!intents.length) intents.push('manual_review');
  return normalizeIntentsForCommand(intents, text);
}

function linkOpsIntentLabel(intent) {
  return ({
    copy_product_draft: '补链接/复制上品',
    update_title: '换标题',
    update_images: '换图',
    update_inventory: '改库存',
    update_supply_price: '改供货价',
    update_product_price: '改商品售价',
    activate_link: '恢复/重新上架',
    retire_link: '下架/归档链接',
    campaign_signup: '报营销活动',
    flash_discount: '限时折扣',
    certificate_review: '证书/资质',
    manual_review: '人工复核',
  })[intent] || String(intent || '');
}

function linkOpsStatusLabel(status) {
  return ({
    chatting: '会话中',
    sending: '发送中',
    task_created: '已开始处理',
    draft: '草案',
    confirmed: '待开始',
    in_progress: '执行中',
    waiting_review: '等你确认',
    done: '完成',
    archived: '归档',
  })[status] || String(status || '');
}

function inferLinkOpsTargets(command, options = {}) {
  const includeAttributeOverrides = options.includeAttributeOverrides !== false;
  const text = String(command || '');
  const productInferenceText = text
    .replace(/["“][^"”\r\n]*[\\/][^"”\r\n]*["”]/gu, ' ')
    .replace(/(?:[A-Za-z]:)?(?:[\\/][^\\/\s，。；;"“”]+){2,}/gu, ' ');
  const allStoreMentioned = /全店|所有店|所有店铺|全部店|全部店铺|19\s*店|十九\s*店|各店|每个店/.test(text);
  const allStoresAsSourceScope = /(?:全店|所有店|所有店铺|全部店|全部店铺|19\s*店|十九\s*店|各店|每个店)(?:里|中|内|范围|里面)?[\s\S]{0,36}?(?:流量|曝光|销量|最高|最好|现有|已有|源链接|挑|选|找)/.test(text);
  const allStoresRequested = allStoreMentioned && !allStoresAsSourceScope;
  const storeMatches = allStoresRequested
    ? DEFAULT_MANUAL_LOGIN_STORE_KEYS
    : [...new Set((text.match(/\b[A-Z]{2,3}\b/gi) || [])
    .map(x => x.toUpperCase())
    .filter(x => SHEIN_STORE_KEYS.has(x)))].slice(0, 24);
  const copyToMatch = /(?:从|复制|拷贝|参考)?\s*\b([A-Z]{2,3})\b[\s\S]{0,48}?(?:到|至|给|复制到|拷贝到|上到|铺到)\s*\b([A-Z]{2,3})\b/i.exec(text);
  const missingLinkLike = /缺(?:少)?(?:上架|在售|可售|新)?(?:的)?(?:链接|链)/.test(text);
  const naturalPublishLike = /(?:给|在)\s*[A-Z]{2,3}\s*店铺?\s*上(?:一|1)(?:个|款)\s*[A-Z0-9-]+/i.test(text);
  const copyLike = naturalPublishLike
    || /复制|拷贝|参考|补.*链接|补链|缺(?:少)?(?:上架|在售|可售|新)?(?:的)?(?:链接|链)|上链接|创建链接|发布商品|刊登/.test(text)
    || /\b(copy|draft|create|publish)\b/i.test(text);
  const sourceStores = [];
  const writeStores = [];
  if (copyToMatch) {
    const source = String(copyToMatch[1] || '').trim().toUpperCase();
    const target = String(copyToMatch[2] || '').trim().toUpperCase();
    if (SHEIN_STORE_KEYS.has(source)) sourceStores.push(source);
    if (SHEIN_STORE_KEYS.has(target)) writeStores.push(target);
  }
  if (copyLike && storeMatches.length === 1 && !sourceStores.length && !writeStores.length) {
    if (!allStoresAsSourceScope && !missingLinkLike) sourceStores.push(storeMatches[0]);
    writeStores.push(storeMatches[0]);
  }
  const namedProductMatches = productInferenceText.match(/\b[A-Z]{1,6}-?\d{1,8}[A-Z]?(?:-[A-Z0-9]+)?[\u4e00-\u9fa5]{1,24}?(?=(?:补|复制|改|换|上架|下架|，|,|。|；|;|\s|$))/giu) || [];
  const alnumMatches = productInferenceText.match(/\b(?:[A-Z]{1,6}-?\d{1,8}[A-Z]?(?:-[A-Z0-9]+)?(?:[\u4e00-\u9fa5A-Za-z0-9-]*)?|(?:sv|sb)\d{8,})\b/giu) || [];
  const numericProductMatches = (productInferenceText.match(/(?<!\d)(\d{3,6}[A-Z]?)(?=\s*(?:缝纫机|咖啡机|空气炸锅|热风梳|厨师机|脱毛仪|榨汁机|绞肉机|吸尘器|电磁炉|按摩器|链接|货号|产品|品))/giu) || [])
    .map(x => x.match(/\d{3,6}[A-Z]?/i)?.[0] || '');
  const skuMatches = [...new Set([...namedProductMatches, ...alnumMatches, ...numericProductMatches]
    .map(x => x
      .replace(/[，。；、,.]+$/g, '')
      .replace(/(各店|全店|所有店|差链接|弱链接|死链接|缺链接|链接|建议|库存|虚拟库存|供货价|成本价|售价|原价|销售价|商品价|价格|标题|上架|下架|换图|补新|补链|覆盖|改成|改为|设置|设为|更新为|调到|调成).*$/u, ''))
    .filter(x => /\d/.test(x) && !/^19$/.test(x)))].slice(0, 24);
  return {
    stores: storeMatches,
    sourceStores,
    writeStores,
    sourceScope: allStoresAsSourceScope || missingLinkLike ? 'all_stores' : '',
    productRefs: skuMatches,
    attributeOverrides: includeAttributeOverrides ? inferLinkOpsAttributeOverrides(text, {task: options.attributeContextTask || null}) : [],
  };
}

function normalizeInputCurrentOverrideValue(value, unit = 'mA') {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const numeric = Number(raw.replace(/,/g, ''));
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const normalizedUnit = String(unit || 'mA').trim().toLowerCase();
  const milliamps = normalizedUnit === 'a' || normalizedUnit === '安'
    ? Math.round(numeric * 1000)
    : Math.round(numeric);
  if (!Number.isFinite(milliamps) || milliamps <= 0) return null;
  return {
    attribute_extra_value: String(milliamps),
    attribute_unit: 'mA',
    display_value: `${milliamps}mA`,
  };
}

function cleanManualAttributeOverrideValue(value) {
  return String(value || '')
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, '')
    .replace(/(?:就行|即可|可以|吧|哈|啊|呀|算|处理)$/u, '')
    .replace(/[，。；;,.]+$/g, '')
    .trim()
    .slice(0, 500);
}

function normalizeGenericAttributeOverrideValue(attributeId, rawValue) {
  const cleaned = cleanManualAttributeOverrideValue(rawValue);
  if (!cleaned) return null;
  if (Number(attributeId) === 1002323) {
    const normalized = normalizeInputCurrentOverrideValue(
      (cleaned.match(/[0-9]+(?:\.[0-9]+)?/) || [''])[0] || cleaned,
      /(?:^|[^a-z])a(?:$|[^a-z])|安/i.test(cleaned) && !/mA|毫安/i.test(cleaned) ? 'A' : 'mA',
    );
    return normalized?.attribute_extra_value || null;
  }
  return cleaned;
}

function collectPreValidTextRowsFromTask(task) {
  const rows = [];
  const collectInfo = info => {
    if (!info || typeof info !== 'object') return;
    for (const row of asArray(info.pre_valid_result || info.preValidResult)) {
      const form = String(row?.form_name || row?.form || row?.module || '').trim();
      for (const message of asArray(row?.messages || row?.message)) {
        const text = String(message || '').trim();
        if (text) rows.push(form ? `${form}：${text}` : text);
      }
    }
  };
  for (const run of asArray(task?.execution?.openApiProductExecutors)) {
    collectInfo(run?.publishResult?.info);
    collectInfo(run?.result?.publishResult?.info);
  }
  for (const row of asArray(task?.execution?.writeAudit?.executorEvidence)) {
    collectInfo(row?.publishResult?.info);
  }
  rows.push(
    ...asArray(task?.preflight?.blockers),
    ...asArray(task?.execution?.preflight?.blockers),
    ...asArray(task?.blockers),
  );
  return rows.map(x => String(x || '').trim()).filter(Boolean);
}

function collectRequiredAttributeHintsFromTask(task) {
  const hints = [];
  const seen = new Set();
  const add = (label, attributeId) => {
    const id = Number(attributeId);
    const cleanLabel = String(label || '')
      .replace(/^[\s:：，,。；;、]+|[\s:：，,。；;、]+$/g, '')
      .replace(/^所以/u, '')
      .trim()
      .slice(0, 80);
    if (!cleanLabel || !Number.isFinite(id) || id <= 0) return;
    const key = `${id}|${cleanLabel}`;
    if (seen.has(key)) return;
    seen.add(key);
    hints.push({attribute_id: id, label: cleanLabel});
  };
  for (const text of collectPreValidTextRowsFromTask(task)) {
    const source = String(text || '');
    for (const match of source.matchAll(/(?:所以|，|,|；|;|。|：|:|\s|^)([^()，,。；;:：\s]{1,40})\((\d{3,})\)\s*(?:为)?必填/gu)) {
      add(match[1], match[2]);
    }
    for (const match of source.matchAll(/([^()，,。；;:：\s]{1,40})\((\d{3,})\)[^，,。；;\n]{0,24}(?:必填|必须填|需要填|不能为空|缺少|未填写)/gu)) {
      add(match[1], match[2]);
    }
  }
  return hints.slice(0, 12);
}

function inferContextualAttributeOverrides(text, task) {
  const sourceText = String(text || '');
  const hints = collectRequiredAttributeHintsFromTask(task);
  if (!hints.length) return [];
  const overrides = [];
  const push = (hint, rawValue) => {
    const value = normalizeGenericAttributeOverrideValue(hint.attribute_id, rawValue);
    if (!value) return;
    overrides.push({
      attribute_id: hint.attribute_id,
      attributeId: hint.attribute_id,
      attribute_extra_value: value,
      attributeExtraValue: value,
      attribute_unit: Number(hint.attribute_id) === 1002323 ? 'mA' : '',
      display_value: Number(hint.attribute_id) === 1002323 ? `${value}mA` : value,
      label: hint.label,
      source: 'chat_prevalid_required_attribute',
    });
  };
  for (const hint of hints) {
    const label = hint.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const named = new RegExp(`${label}(?:\\s*(?:按|用|填|填写|写|写成|写为|设为|设置为|是|为|=|：|:)\\s*)?([^，。；;\\n]+)`, 'iu').exec(sourceText);
    if (named) push(hint, named[1]);
  }
  const already = new Set(overrides.map(row => Number(row.attribute_id)));
  const missingHints = hints.filter(hint => !already.has(Number(hint.attribute_id)));
  if (missingHints.length === 1) {
    const valueOnly = /(?:按|用|填|填写|写|写成|写为|设为|设置为|是|为|=|：|:)\s*([^，。；;\n]+)/iu.exec(sourceText)
      || /^([^，。；;\n]{1,80})$/u.exec(sourceText.trim());
    if (valueOnly) push(missingHints[0], valueOnly[1]);
  }
  return normalizeLinkOpsAttributeOverrides(overrides);
}

function inferLinkOpsAttributeOverrides(text, options = {}) {
  const sourceText = String(text || '');
  const overrides = [];
  const pushInputCurrent = (rawValue, rawUnit, source = 'chat_manual_override') => {
    const normalized = normalizeInputCurrentOverrideValue(rawValue, rawUnit);
    if (!normalized?.attribute_extra_value) return;
    overrides.push({
      attribute_id: 1002323,
      attributeId: 1002323,
      attribute_extra_value: normalized.attribute_extra_value,
      attributeExtraValue: normalized.attribute_extra_value,
      attribute_unit: normalized.attribute_unit,
      display_value: normalized.display_value,
      label: '输入电流',
      source,
    });
  };
  const patterns = [
    /(?:输入电流|电流)(?:\s*(?:按|用|填|写|设为|设置为|是|为|=|：|:)\s*)?([0-9]+(?:\.[0-9]+)?)\s*(mA|毫安|A|安)\b/giu,
    /([0-9]+(?:\.[0-9]+)?)\s*(mA|毫安|A|安)\s*(?:作为|当作|按|填到|写到|写入)?\s*(?:输入电流|电流)/giu,
  ];
  for (const pattern of patterns) {
    for (const match of sourceText.matchAll(pattern)) {
      pushInputCurrent(match[1], /^(a|安)$/i.test(match[2] || '') ? 'A' : 'mA');
    }
  }
  return normalizeLinkOpsAttributeOverrides([
    ...overrides,
    ...inferContextualAttributeOverrides(sourceText, options.task),
  ]);
}

function normalizeLinkOpsAttributeOverrides(value = []) {
  const rows = Array.isArray(value)
    ? value
    : typeof value === 'object' && value
      ? Object.entries(value).map(([attributeId, attributeValue]) => ({attributeId, attributeValue}))
      : [];
  const byId = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const attributeId = Number(row.attribute_id ?? row.attributeId ?? row.id);
    if (!Number.isFinite(attributeId) || attributeId <= 0) continue;
    const attributeValue = String(
      row.attribute_extra_value
      ?? row.attributeExtraValue
      ?? row.attribute_value
      ?? row.attributeValue
      ?? row.value
      ?? ''
    ).trim();
    if (!attributeValue) continue;
    byId.set(attributeId, {
      attribute_id: attributeId,
      attribute_extra_value: attributeValue.slice(0, 500),
      attribute_unit: String(row.attribute_unit || row.attributeUnit || '').trim().slice(0, 40),
      display_value: String(row.display_value || row.displayValue || '').trim().slice(0, 120),
      label: String(row.label || '').trim().slice(0, 80),
      source: String(row.source || 'manual_override').trim().slice(0, 80),
    });
  }
  return [...byId.values()].slice(0, 24);
}

function normalizeStandardGoodsSnDisplayRef(value) {
  const text = String(value || '').normalize('NFKC').replace(/\s+/g, '').trim();
  if (!text) return '';
  if (/\p{Script=Han}/u.test(text)) return text;
  return '';
}

function normalizeLinkOpsTargetSet(targets = {}) {
  const stores = Array.isArray(targets?.stores)
    ? targets.stores
    : typeof targets?.stores === 'string'
      ? targets.stores.split(/[,\s，、]+/)
      : [];
  const sourceStores = Array.isArray(targets?.sourceStores || targets?.readStores)
    ? (targets.sourceStores || targets.readStores)
    : typeof (targets?.sourceStores || targets?.readStores) === 'string'
      ? String(targets.sourceStores || targets.readStores).split(/[,\s，、]+/)
      : [];
  const writeStores = Array.isArray(targets?.writeStores || targets?.targetStores)
    ? (targets.writeStores || targets.targetStores)
    : typeof (targets?.writeStores || targets?.targetStores) === 'string'
      ? String(targets.writeStores || targets.targetStores).split(/[,\s，、]+/)
      : [];
  const rawProductRefs = Array.isArray(targets?.productRefs)
    ? targets.productRefs
    : typeof targets?.productRefs === 'string'
      ? targets.productRefs.split(/[,\s，、]+/)
      : [];
  const standardGoodsSn = normalizeStandardGoodsSnDisplayRef(targets?.standardGoodsSn || targets?.standard_goods_sn);
  const productRefs = standardGoodsSn
    ? [standardGoodsSn, ...rawProductRefs.filter(ref => String(ref || '').normalize('NFKC').replace(/\s+/g, '').trim() !== standardGoodsSn)]
    : rawProductRefs;
  const attributeOverrides = normalizeLinkOpsAttributeOverrides(
    targets?.attributeOverrides
    || targets?.attribute_overrides
    || targets?.manualAttributeOverrides
    || targets?.manual_attribute_overrides
    || []
  );
  const clean = (arr, max) => [...new Set(arr
    .map(x => String(x || '').trim())
    .filter(Boolean))]
    .slice(0, max);
  return {
    stores: clean(stores, 32),
    sourceStores: clean(sourceStores, 32),
    writeStores: clean(writeStores, 32),
    sourceScope: ['all_stores', 'target_stores'].includes(String(targets?.sourceScope || targets?.source_scope || '').trim())
      ? String(targets.sourceScope || targets.source_scope).trim()
      : '',
    productRefs: clean(productRefs, 48),
    standardGoodsSn,
    attributeOverrides,
  };
}

function mergeLinkOpsTargets(...items) {
  const normalized = items.map(x => normalizeLinkOpsTargetSet(x));
  return normalizeLinkOpsTargetSet({
    stores: normalized.flatMap(x => x.stores),
    sourceStores: normalized.flatMap(x => x.sourceStores),
    writeStores: normalized.flatMap(x => x.writeStores),
    sourceScope: normalized.find(x => x.sourceScope)?.sourceScope || '',
    productRefs: normalized.flatMap(x => x.productRefs),
    standardGoodsSn: normalized.find(x => x.standardGoodsSn)?.standardGoodsSn || '',
    attributeOverrides: normalized.flatMap(x => x.attributeOverrides),
  });
}

function normalizeTargetsForIntents(intents = [], targets = {}) {
  const normalized = normalizeLinkOpsTargetSet(targets);
  const intentSet = new Set(asArray(intents).map(x => String(x || '').trim()).filter(Boolean));
  const sourceStoreSet = new Set(normalizeConcreteStoreKeys(normalized.sourceStores));
  const rawWrites = normalizeConcreteStoreKeys(normalized.writeStores);
  const sourcePrunedWrites = rawWrites.length > 1
    ? rawWrites.filter(store => !sourceStoreSet.has(store))
    : rawWrites;
  const writes = sourcePrunedWrites.length ? sourcePrunedWrites : rawWrites;
  const stores = normalizeConcreteStoreKeys(normalized.stores);
  const hasWritableIntent = intentSet.has('copy_product_draft')
    || ['campaign_signup', 'flash_discount'].some(intent => intentSet.has(intent))
    || [...intentSet].some(intent => LINK_MAINTENANCE_INTENTS.has(intent));
  if (writes.length) {
    return normalizeLinkOpsTargetSet({
      ...normalized,
      stores: writes,
      writeStores: writes,
      sourceStores: normalized.sourceStores,
    });
  }
  if (hasWritableIntent && stores.length) {
    return normalizeLinkOpsTargetSet({
      ...normalized,
      stores,
      writeStores: stores,
      sourceStores: normalized.sourceStores,
    });
  }
  return normalized;
}

function inferTargetsFromChatSession(session) {
  const messages = recentCloudAiMessages(session?.messages);
  const userText = messages
    .filter(m => m?.role === 'user')
    .map(m => String(m?.content || ''))
    .join('\n');
  return mergeLinkOpsTargets(
    session?.targets && typeof session.targets === 'object' ? session.targets : {},
    inferLinkOpsTargets(userText, {includeAttributeOverrides: false}),
    {attributeOverrides: inferLinkOpsAttributeOverrides(userText)}
  );
}

async function inferTargetsFromTaskChatSession(args, task) {
  const sessionId = String(task?.chatSessionId || task?.chat?.sessionId || '').trim();
  if (!sessionId || !args?.linkOpsChatFile) return {};
  try {
    const data = normalizeLinkOpsChatStore(await readLinkOpsChatStore(args));
    const session = data.sessions.find(row => String(row?.id || '') === sessionId);
    if (!session) return {};
    return inferTargetsFromChatSession(session);
  } catch {
    return {};
  }
}

function summarizeLinkOpsTargets(targets = {}) {
  const t = normalizeLinkOpsTargetSet(targets);
  const parts = [];
  if (t.stores.length) parts.push(`店铺=${t.stores.join(',')}`);
  if (t.productRefs.length) parts.push(`货号/SKC=${t.productRefs.join(',')}`);
  if (t.attributeOverrides.length) {
    parts.push(`人工参数=${t.attributeOverrides.map(row => `${row.label || row.attribute_id}=${row.attribute_extra_value}`).join(',')}`);
  }
  return parts.join('；') || '暂未识别到明确店铺或货号/SKC';
}

function normalizeConcreteStoreKeys(stores = []) {
  return [...new Set((Array.isArray(stores) ? stores : [])
    .map(x => String(x || '').trim().toUpperCase())
    .filter(x => x && SHEIN_STORE_KEYS.has(x) && !['DSY', 'LGM'].includes(x)))];
}

function buildLinkOpsCapabilitySummary(targets = {}) {
  const t = normalizeLinkOpsTargetSet(targets);
  const stores = normalizeConcreteStoreKeys(t.stores);
  if (!stores.length) {
    return [
      '尚未锁定具体店铺；写操作需先明确目标店铺，再判断是否有官方 OpenAPI 授权或云端 WebAPI/headless 执行路径。',
      '回答时不能把“未锁定店铺”说成“没有权限”，应提示先补齐目标店铺。',
    ].join('\n');
  }
  return stores.map(store => {
    const cap = openApiStoreCapability(store);
    if (cap.verifiedRead) {
      return `${store}: OpenAPI 已授权且云端只读探针通过；商品发布/编辑可以检查权限、站点、品牌、仓库和发布资料；真实提交仍需你确认并回读结果。`;
    }
    if (cap.authorized) {
      return `${store}: 已检测到 OpenAPI 私有授权配置；尚未完成云端只读探针/对账登记，写操作只能先做系统检查。`;
    }
    return `${store}: 暂未登记官方 OpenAPI 授权；写操作需先走云端 WebAPI/headless 受控执行，或完成该店 OpenAPI 接入。`;
  }).join('\n');
}

function linkOpsCapabilityNotes(intents = [], targets = {}) {
  const writeIntents = ['copy_product_draft', 'update_title', 'update_images', 'update_inventory', 'update_supply_price', 'update_product_price', 'activate_link', 'retire_link', 'campaign_signup', 'flash_discount', 'certificate_review'];
  if (!intents.some(x => writeIntents.includes(x))) return [];
  const stores = normalizeConcreteStoreKeys(normalizeLinkOpsTargetSet(targets).stores);
  const notes = [];
  const openApiStores = stores.filter(store => openApiStoreCapability(store).authorized);
  const adapterStores = stores.filter(store => openApiStoreCapability(store).productPublishAdapter);
  if (openApiStores.length) {
    notes.push(`${openApiStores.join(',')} 已检测到 OpenAPI 授权配置；复制/补链任务会优先从源链接/WebAPI 快照自动还原类目、属性、图片、SKU、供货价、库存和尺寸重量；只有自动还原失败时才提示补源店、源 SKC 或发布资料，不能一上来就说“缺发布资料”。`);
  }
  if (adapterStores.length) {
    notes.push(`${adapterStores.join(',')} 已可做商品发布/编辑系统检查；默认只在你确认后提交，不静默提交 SHEIN。`);
  }
  const notOpenApiStores = stores.filter(store => !openApiStoreCapability(store).authorized);
  if (notOpenApiStores.length) {
    notes.push(`${notOpenApiStores.join(',')} 尚未登记官方 OpenAPI 授权；真实写操作需先走云端 WebAPI/headless 受控路径或补齐该店 OpenAPI。`);
  }
  if (!stores.length) {
    notes.push('尚未识别具体目标店铺；执行前必须补齐店铺，不能泛化为所有店可执行。');
  }
  return notes;
}

function compactLinkOpsTitleText(text, max = 36) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/[。；;，,]+$/g, '')
    .trim()
    .slice(0, max);
}

function buildLinkOpsSessionTitle(message, targets = {}) {
  const text = String(message || '').trim();
  const t = normalizeLinkOpsTargetSet(targets);
  const intents = inferLinkOpsIntent(text).filter(x => x !== 'manual_review');
  const action = intents.length ? linkOpsIntentLabel(intents[0]) : '数据复盘';
  if (t.productRefs.length || t.stores.length) {
    const target = [
      t.productRefs.slice(0, 2).join('、'),
      t.stores.length ? `${t.stores.slice(0, 3).join('、')}店` : '',
    ].filter(Boolean).join(' · ');
    return compactLinkOpsTitleText(`${target} · ${action}`, 48);
  }
  return compactLinkOpsTitleText(text, 40) || '新的运营会话';
}

function isLinkOpsActionCommand(command) {
  const text = String(command || '').trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  const intents = inferLinkOpsIntent(text).filter(x => x !== 'manual_review');
  if (!intents.length) return false;
  const actionVerb = /恢复上架|重新上架|再次上架|改为上架|设为上架|设置上架|恢复在售|下架|归档|停掉|移除|删除链接|换图|换主图|换图片|换套图|更换图片|更换主图|替换图片|上传图片|改标题|换标题|标题改|改库存|设置库存|库存改|改供货价|改成本价|改售价|改商品价|改价格|设置价格|调价|补(?:一|1)?(?:个|条|款)?(?:新)?(?:链接|链|商品|上品)|补链接|补链|缺(?:少)?(?:上架|在售|可售|新)?(?:的)?(?:链接|链)|复制|复制上品|创建草稿|创建链接|上品|上链接|发链接|发布商品|刊登|提交审核|报活动|报名|限时折扣|设置折扣|补证书|补资质|上传证书/.test(text)
    || /(?:给|在)\s*[A-Z]{2,3}\s*店铺?\s*上(?:一|1)(?:个|款)\s*[A-Z0-9-]+/i.test(text)
    || /(?:标题|title)\s*(?:改成|改为|更新为|设置为|设为|换成|到|=|：|:)/i.test(text)
    || /(?:改成|改为|更新为|设置为|设为|换成)\s*[^，。；\n]{0,80}(?:标题|title)/i.test(text)
    || /(?:库存|虚拟库存|供货价|成本价|售价|原价|销售价|商品价|价格)\s*(?:改成|改为|更新为|设置为|设为|到|=|：|:)/.test(text)
    || /(?:改成|改为|更新为|设置为|设为|调到|调成)\s*[^，。；\n]{0,24}(?:库存|虚拟库存|供货价|成本价|售价|原价|销售价|商品价|价格)/.test(text)
    || /\b(activate_link|on_shelf|onshelf|relist|restore_listing|retire|remove|archive|replace image|update title|create draft|create link|publish|submit review|campaign|discount)\b/.test(lower);
  if (!actionVerb) return false;
  const strongCommand = /把|将|要求|安排|加入当前任务|加入动作池|执行|处理|现在|立即|直接|提交审核/.test(text)
    || /^(恢复上架|重新上架|再次上架|上架|下架|归档|换图|改标题|改库存|设置库存|改供货价|改成本价|改售价|改商品价|改价格|设置价格|调价|补(?:一|1)?(?:个|条|款)?(?:新)?(?:链接|链|商品|上品)|补链接|补链|报活动|报名|设置折扣|补证书|补资质)/.test(text);
  const giveCommand = /给.+(重新生成|生成|换|更换|改|上架|下架|报|报名|设置|补)/.test(text);
  const exploratory = /建议|分析|看看|找出|哪些|哪个|是否|能否|能不能|可以吗|怎么|如何|为什么|原因/.test(text);
  if (exploratory && !strongCommand && !giveCommand) return false;
  return strongCommand || giveCommand || !exploratory;
}

function isConfirmExecuteChatCommand(command) {
  const text = String(command || '').trim();
  if (!text || text.length > 120) return false;
  if (/？|\?|能否|能不能|可以吗|是否|为什么|怎么|如何/.test(text)) return false;
  if (/^(干|做|执行|提交|发|走|开干|开始干|赶紧干|快干|马上干|直接干)([啊呀啦吧呗嘛。，,！!\s]*)$/.test(text)) return true;
  return /^(确认|同意|可以|行|好|好的|ok|OK|执行|开始|提交|照做|按这个|按上面|就这样|走|去做|发吧|提交吧|执行吧|可以干|可以做|干吧|做吧|开干|开始干|开始做|去干)([，,。\s！!]*)(执行|开始|提交|审核|处理|做|干|发|吧|了|$)/.test(text)
    || /(确认|同意|可以|行|好|好的|ok|OK|按这个|按上面|就这样).*(执行|提交|审核|处理|做|干|发)|(执行|提交|审核|处理|做|干|发).*[吧啊呀啦]|那就.*(执行|提交|做|干|发)/.test(text);
}

function messageTimeMs(message) {
  const t = Date.parse(String(message?.at || ''));
  return Number.isFinite(t) ? t : 0;
}

function recentCloudAiMessages(messages, nowMs = Date.now()) {
  return (Array.isArray(messages) ? messages : [])
    .filter(m => {
      if (!CLOUD_AI_MEMORY_TTL_MS) return true;
      const t = messageTimeMs(m);
      return t && nowMs - t <= CLOUD_AI_MEMORY_TTL_MS;
    });
}

function hasActionableLinkOpsContext(session) {
  const messages = recentCloudAiMessages(session?.messages);
  const prior = messages.slice(0, -1).slice(-10);
  const text = prior
    .filter(m => m?.role === 'user')
    .map(m => String(m?.content || ''))
    .join('\n');
  const intents = inferLinkOpsIntent(text).filter(x => x !== 'manual_review');
  if (!intents.length) return false;
  return /恢复上架|重新上架|再次上架|改为上架|设为上架|设置上架|恢复在售|下架|归档|停掉|移除|删除链接|换图|更换图片|改标题|换标题|补链接|补链|缺(?:少)?(?:上架|在售|可售|新)?(?:的)?(?:链接|链)|复制|上品|上链接|发链接|发布商品|刊登|提交审核|报活动|报名|限时折扣|设置折扣|补证书|补资质|上传证书|任务|动作/.test(text);
}

function compactChatLine(value, max = 420) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function buildConfirmedLinkOpsCommandFromSession(session, latestMessage) {
  const messages = recentCloudAiMessages(session?.messages);
  const prior = messages.slice(0, -1);
  const userLines = prior
    .filter(m => m?.role === 'user')
    .map(m => compactChatLine(m.content))
    .filter(x => x && !isConfirmExecuteChatCommand(x))
    .slice(-4);
  const command = [
    `确认执行：${compactChatLine(latestMessage, 120)}`,
    userLines.length ? `上文用户意图：\n${userLines.map(x => `- ${x}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  return command.slice(0, 2000);
}

function findDuplicateAutoTask(tasks, sessionId, command) {
  const sid = String(sessionId || '');
  const cmd = String(command || '').trim();
  if (!sid || !cmd) return null;
  return (Array.isArray(tasks) ? tasks : []).find(t =>
    String(t.chatSessionId || '') === sid &&
    String(t.command || '').trim() === cmd &&
    String(t.source || '') === 'chat_auto_action' &&
    !['done', 'archived'].includes(String(t.status || ''))
  ) || null;
}

function findReusableChatTask(tasks, sessionId) {
  const sid = String(sessionId || '');
  if (!sid) return null;
  return activeChatTasks(tasks, sid)[0] || null;
}

function activeChatTasks(tasks, sessionId) {
  const sid = String(sessionId || '');
  if (!sid) return [];
  return (Array.isArray(tasks) ? tasks : [])
    .filter(t =>
      String(t.chatSessionId || '') === sid &&
      !['done', 'archived'].includes(String(t.status || ''))
    )
    .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
}

function chatTaskDisplayName(task) {
  const refs = normalizeLinkOpsTargetSet(task?.targets || {}).productRefs;
  const stores = taskWriteStores(task);
  const intents = asArray(task?.intents).map(linkOpsIntentLabel).filter(Boolean);
  return [
    refs.length ? refs.slice(0, 2).join('/') : '',
    stores.length ? `${stores.slice(0, 3).join('/')}店` : '',
    intents.length ? intents.slice(0, 2).join('/') : '',
  ].filter(Boolean).join(' · ') || String(task?.id || '').slice(0, 18) || '当前处理';
}

function taskHasProductPublishPayloadHashes(task, writeStores) {
  const stores = normalizeConcreteStoreKeys(writeStores);
  return stores.length > 0 && stores.every(store => payloadHashForStoreFromTaskExecution(task, store));
}

function taskHasMaintenancePayloadHashes(task, writeStores, maintenanceIntents) {
  const stores = normalizeConcreteStoreKeys(writeStores);
  const ops = asArray(maintenanceIntents).map(x => String(x || '').trim()).filter(Boolean);
  if (!stores.length || !ops.length) return false;
  return stores.every(store => ops.every(op => payloadHashForMaintenanceFromTaskExecution(task, store, op)));
}

function chatNaturalExecutionEligibility(task) {
  const status = String(task?.status || '');
  const state = String(task?.execution?.state || '');
  const preflightOk = task?.execution?.preflight?.ok === true;
  const intents = asArray(task?.intents).map(x => String(x || '').trim()).filter(Boolean);
  const writeStores = taskWriteStores(task);
  const hasProductPublish = intents.includes('copy_product_draft');
  const maintenanceIntents = intents.filter(intent => LINK_MAINTENANCE_INTENTS.has(intent));
  const stateMatches = (hasProductPublish && state === 'openapi_product_preflight_ready')
    || (maintenanceIntents.length > 0 && state === 'link_maintenance_preflight_ready');
  const hashesOk = (hasProductPublish && taskHasProductPublishPayloadHashes(task, writeStores))
    || (maintenanceIntents.length > 0 && taskHasMaintenancePayloadHashes(task, writeStores, maintenanceIntents));
  const reasons = [];
  if (status !== 'waiting_review') reasons.push('还没停在等你一句话执行的状态');
  if (!stateMatches) reasons.push('资料还没查到可提交状态');
  if (!preflightOk) reasons.push('资料检查还没通过');
  if (!hashesOk) reasons.push('缺少这次资料检查快照');
  return {ok: status === 'waiting_review' && stateMatches && preflightOk && hashesOk, reasons};
}

function eligibleChatNaturalExecutionTasks(tasks, sessionId) {
  return activeChatTasks(tasks, sessionId).filter(task => chatNaturalExecutionEligibility(task).ok);
}

function updateLinkOpsTaskFromChatCommand(task, body, actor, req) {
  const command = String(body.command || body.text || '').trim();
  if (!command) throw new Error('Missing command');
  if (command.length > 2000) throw new Error('Command too long');
  const now = new Date().toISOString();
  const previousIntents = Array.isArray(task.intents) ? task.intents : [];
  const intents = normalizeIntentsForCommand([...previousIntents, ...inferLinkOpsIntent(command)], command);
  const targets = normalizeTargetsForIntents(intents, mergeLinkOpsTargets(
    task.targets && typeof task.targets === 'object' ? task.targets : {},
    inferLinkOpsTargets(command),
    body.targets && typeof body.targets === 'object' ? body.targets : {}
  ));
  const preview = {
    ...(task.preview && typeof task.preview === 'object' ? task.preview : {}),
    summary: `随会话更新：${intents.map(linkOpsIntentLabel).join(' / ')}；任务持续合并最新指令，不为同一会话重复开新任务。`,
    riskNotes: linkOpsRiskNotes(intents, targets),
    capabilitySummary: buildLinkOpsCapabilitySummary(targets),
    agentAnswer: '',
    structuredAnswer: '',
    agentMode: typeof body.agentMode === 'string' ? body.agentMode.slice(0, 80) : (task.preview?.agentMode || ''),
    agentDurationMs: Number.isFinite(Number(body.agentDurationMs)) ? Number(body.agentDurationMs) : (task.preview?.agentDurationMs || 0),
  };
  const next = {
    ...task,
    status: ['draft'].includes(String(task.status || '')) ? 'confirmed' : task.status,
    progress: Math.max(normalizeProgress(task.progress, 10), 30),
    source: task.source || 'chat_auto_action',
    command,
    intents,
    targets,
    preview,
    note: '已根据会话最新指令更新；继续对话会继续修订同一个任务，而不是生成重复任务。',
    updatedAt: now,
  };
  next.history = appendTaskHistory(next, 'updated_from_chat_command', actor, req, {
    status: next.status,
    progress: next.progress,
    chatSessionId: next.chatSessionId || body.chatSessionId || '',
  });
  return next;
}

function linkOpsRiskNotes(intents, targets = {}) {
  const notes = ['当前只是理解需求和检查资料，不会自动修改 SHEIN 后台。'];
  if (intents.includes('copy_product_draft')) {
    notes.push('复制上品会先按源店/源 SKC 或 BI 中曝光/销量最高的候选源链接自动还原发布参数；系统会检查类目、属性、图片、SKU、价格、库存100、尺寸重量和计划上架时间。');
  }
  if (intents.includes('update_title') || intents.includes('update_images')) {
    notes.push('标题/图片会影响流量承接，初期必须人工确认素材和目标链接。');
  }
  if (intents.includes('activate_link')) {
    notes.push('恢复上架前必须确认店铺虚拟库存、售价/供货价、活动价和证书/资质状态，否则只检查不提交。');
  }
  if (intents.includes('campaign_signup') || intents.includes('flash_discount')) {
    notes.push('活动/限时折扣需校验成本、最低利润率、限量、有效期和是否与官方活动冲突。');
  }
  if (intents.includes('retire_link')) {
    notes.push('下架前必须确认不是唯一承接链接，并先准备替代链接。');
  }
  notes.push(...linkOpsCapabilityNotes(intents, targets));
  return notes;
}

function buildLinkOpsTaskFromCommand(body, actor, req) {
  const command = String(body.command || body.text || '').trim();
  if (!command) throw new Error('Missing command');
  if (command.length > 2000) throw new Error('Command too long');
  const now = new Date().toISOString();
  const intents = normalizeIntentsForCommand(inferLinkOpsIntent(command), command);
  const targets = normalizeTargetsForIntents(intents, mergeLinkOpsTargets(
    body.targets && typeof body.targets === 'object' ? body.targets : {},
    inferLinkOpsTargets(command)
  ));
  const id = `lot_${now.replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto.randomBytes(4).toString('hex')}`;
  return bindLinkOpsRecordToActor({
    id,
    version: 1,
    status: 'draft',
    progress: 10,
    source: typeof body.source === 'string' ? body.source.slice(0, 80) : 'natural_language',
    chatSessionId: typeof body.chatSessionId === 'string' ? body.chatSessionId.slice(0, 80) : '',
    command,
    intents,
    targets,
    preview: {
      summary: `识别为：${intents.join(' / ')}；当前会话会跟进这件事；系统会先查源链接、资料缺口和店铺权限。`,
      riskNotes: linkOpsRiskNotes(intents, targets),
      capabilitySummary: buildLinkOpsCapabilitySummary(targets),
      agentAnswer: '',
      structuredAnswer: '',
      agentMode: typeof body.agentMode === 'string' ? body.agentMode.slice(0, 80) : '',
      agentDurationMs: Number.isFinite(Number(body.agentDurationMs)) ? Number(body.agentDurationMs) : 0,
      nextChecks: [
        '确认目标店铺和货号/SKC。',
        '匹配现有链接、覆盖矩阵和表现数据。',
        '确认价格、库存、证书、图片、标题、活动规则和本机素材是否已上传/同步到云端。',
        '生成执行前预览；缺素材或缺接口权限时停在执行准备，不静默写 SHEIN。',
      ],
    },
    requestedBy: actorLabel(actor, req),
    requestedByUser: actorUser(actor, req),
    requestMeta: requestMeta(req),
    createdAt: now,
    updatedAt: now,
    execution: {
      mode: 'manual_confirm_first',
      enabled: false,
      note: '确认后进入执行准备；真实 SHEIN 写执行器和素材上传链路未齐全前，不直接改后台。',
    },
    history: [{
      at: now,
      event: 'created',
      by: actorLabel(actor, req),
      user: actorUser(actor, req),
      status: 'draft',
      progress: 10,
    }],
  }, actor, 'created');
}

function normalizeLinkOpsTaskStore(value) {
  const tasks = Array.isArray(value?.tasks) ? value.tasks : [];
  return {
    version: 1,
    updatedAt: value?.updatedAt || null,
    tasks: tasks
      .filter(x => x && typeof x === 'object')
      .map(normalizeLinkOpsRecordOwnership)
      .slice(0, 1000),
  };
}

function linkOpsClientTextHasInternalLeak(value) {
  const text = compactChatLine(value, 20000);
  const crossEntryNeedles = [
    String.fromCharCode(39134, 20070),
    ['只', '读', '建议'].join(''),
    ['验证', '器'].join(''),
    ['查看', '审计'].join(''),
    ['我已经调用过', ' SHEIN ', '写接口'].join(''),
    ['系统', '已', '锁住', '任务'].join(''),
    ['系统已经把', '内部检查结果', '收口到聊天里'].join(''),
    ['请按聊天里的', '缺口继续'].join(''),
  ];
  const hasCrossEntryLeak = crossEntryNeedles.some(needle => text.includes(needle))
    || /回到\s*BI/i.test(text)
    || /SHEIN_[A-Z_]*OPENAPI_SUBMIT|SHEIN_OPENAPI_SUBMIT|dry[- ]?run|payload hash|store identity mismatch|account_and_merchant_mismatch/i.test(text);
  return hasCrossEntryLeak;
}

function stripLinkOpsInternalLeakLines(value) {
  const text = String(value || '');
  if (!text.trim()) return '';
  const lines = text.split('\n');
  const kept = [];
  let dropped = 0;
  for (const line of lines) {
    if (linkOpsClientTextHasInternalLeak(line)) {
      dropped += 1;
      continue;
    }
    kept.push(line);
  }
  const cleaned = kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {cleaned, dropped};
}

function fallbackLinkOpsClientText() {
  return '我已收到，会继续在这个会话里处理；如果还差资料，我会直接列出具体字段，如果可以执行，我会直接说明状态和结果。';
}

function sanitizeLinkOpsClientText(value, max = 600) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const text = compactChatLine(raw, max)
    .replace(/HL\s*仓库列表/g, '目标店仓库列表')
    .replace(/OpenAPI/g, '接口')
    .replace(/dry[- ]?run|Dry[- ]?run|预检/g, '资料检查')
    .replace(/真实提交\s*payload hash\s*与\s*dry-run\s*锁定值不一致\s*[:：]?\s*expected=[a-f0-9]{64}\s+actual=[a-f0-9]{64}/ig, '提交前检测到发布资料与确认时的版本发生变化，已安全停止提交；需要重新检查后再确认')
    .replace(/\b[a-f0-9]{64}\b/ig, '[内部校验值已隐藏]')
    .replace(/payload hash/ig, '本次检查快照');
  if (linkOpsClientTextHasInternalLeak(text)) {
    const stripped = stripLinkOpsInternalLeakLines(text);
    return stripped.cleaned || fallbackLinkOpsClientText();
  }
  return text;
}

function sanitizeLinkOpsClientMarkdown(value, max = 16000) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const text = raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/HL\s*仓库列表/g, '目标店仓库列表')
    .replace(/OpenAPI/g, '接口')
    .replace(/dry[- ]?run|Dry[- ]?run|预检/g, '资料检查')
    .replace(/真实提交\s*payload hash\s*与\s*dry-run\s*锁定值不一致\s*[:：]?\s*expected=[a-f0-9]{64}\s+actual=[a-f0-9]{64}/ig, '提交前检测到发布资料与确认时的版本发生变化，已安全停止提交；需要重新检查后再确认')
    .replace(/\b[a-f0-9]{64}\b/ig, '[内部校验值已隐藏]')
    .replace(/payload hash/ig, '本次检查快照')
    .slice(0, max);
  if (linkOpsClientTextHasInternalLeak(text)) {
    const stripped = stripLinkOpsInternalLeakLines(text);
    return stripped.cleaned || fallbackLinkOpsClientText();
  }
  return text;
}

function projectLinkOpsClientMessages(values, max = 600) {
  return asArray(values)
    .map(value => sanitizeLinkOpsClientText(value, max))
    .filter(Boolean)
    .slice(0, 8);
}

function projectLinkOpsClientMode(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (/dry[- ]?run/i.test(s)) return 'check';
  if (/execute/i.test(s)) return 'execute';
  return sanitizeLinkOpsClientText(s, 80);
}

function projectLinkOpsPreflightForClient(preflight) {
  if (!preflight || typeof preflight !== 'object') return null;
  return {
    ok: preflight.ok === true,
    blockers: cleanHumanBlockerList(preflight.blockers)
      .map(x => sanitizeLinkOpsClientText(x, 600))
      .filter(Boolean)
      .slice(0, 8),
    warnings: cleanHumanBlockerList(preflight.warnings)
      .map(x => sanitizeLinkOpsClientText(x, 600))
      .filter(Boolean)
      .slice(0, 8),
  };
}

function projectLinkOpsPublishResultForClient(publishResult) {
  if (!publishResult || typeof publishResult !== 'object') return null;
  const info = publishResult.info && typeof publishResult.info === 'object' ? publishResult.info : {};
  const preValid = asArray(info.pre_valid_result || info.preValidResult).map(row => {
    const sourceMessages = asArray(row?.messages || row?.message)
      .map(message => sanitizeLinkOpsClientText(message, 600))
      .filter(Boolean);
    return {
      form_name: sanitizeLinkOpsClientText(row?.form_name || row?.form || row?.module || '平台提示', 120),
      messages: [...new Set(sourceMessages)].slice(0, 6),
    };
  }).filter(row => row.messages.length);
  return {
    code: publishResult.code == null ? '' : String(publishResult.code),
    msg: sanitizeLinkOpsClientText(publishResult.msg || '', 240),
    info: {
      success: info.success === true,
      pre_valid_result: preValid,
    },
  };
}

function projectLinkOpsProductExecutorForClient(executor) {
  if (!executor || typeof executor !== 'object') return null;
  const publishResult = executor.publishResult || executor.result?.publishResult || null;
  return {
    storeKey: String(executor.storeKey || executor.result?.storeKey || '').toUpperCase(),
    sourceStore: String(executor.sourceStore || executor.result?.sourceStore || '').toUpperCase(),
    sourceSkc: sanitizeLinkOpsClientText(executor.sourceSkc || executor.result?.sourceSkc || '', 120),
    mode: projectLinkOpsClientMode(executor.mode || executor.result?.mode || ''),
    state: String(executor.state || executor.status || executor.result?.state || ''),
    status: String(executor.status || executor.result?.status || ''),
    publishResult: projectLinkOpsPublishResultForClient(publishResult),
  };
}

function projectLinkOpsMaintenanceExecutorForClient(executor) {
  if (!executor || typeof executor !== 'object') return null;
  const result = executor.result && typeof executor.result === 'object' ? executor.result : executor;
  const payload = result.payload && typeof result.payload === 'object'
    ? result.payload
    : executor.payload && typeof executor.payload === 'object'
      ? executor.payload
      : {};
  const operations = asArray(executor.operations || result.operations || result.payload?.summary?.operations || executor.payload?.summary?.operations)
    .map(x => String(x || '').trim())
    .filter(Boolean)
    .slice(0, 12);
  const matchedLinksCount = Number(result.matchedLinksCount ?? result.adapterEvidence?.matchedLinksCount ?? executor.adapterEvidence?.matchedLinksCount ?? 0) || 0;
  return {
    storeKey: String(result.storeKey || '').toUpperCase(),
    mode: projectLinkOpsClientMode(result.mode || executor.mode || ''),
    state: String(result.state || executor.state || executor.status || ''),
    status: String(result.status || executor.status || ''),
    adapterKind: sanitizeLinkOpsClientText(result.adapterKind || executor.adapterKind || '', 120),
    matchedLinksCount,
    adapterEvidence: {matchedLinksCount},
    payload: {
      found: Boolean(payload.found || payload.payloadHash || operations.length),
      summary: {operations},
    },
    publishResult: projectLinkOpsPublishResultForClient(result.publishResult || executor.publishResult || null),
    readbackStatus: sanitizeLinkOpsClientText(result.readbackStatus || result.readback?.status || executor.readbackStatus || '', 120),
  };
}

function projectLinkOpsExecutionForClient(execution) {
  if (!execution || typeof execution !== 'object') return null;
  const writeAudit = execution.writeAudit && typeof execution.writeAudit === 'object' ? execution.writeAudit : {};
  const productExecutors = asArray(execution.openApiProductExecutors)
    .map(projectLinkOpsProductExecutorForClient)
    .filter(Boolean);
  const maintenancePrechecks = asArray(execution.linkMaintenancePrechecks)
    .map(projectLinkOpsMaintenanceExecutorForClient)
    .filter(Boolean);
  const maintenanceExecutors = asArray(execution.linkMaintenanceExecutors)
    .map(projectLinkOpsMaintenanceExecutorForClient)
    .filter(Boolean);
  return {
    mode: projectLinkOpsClientMode(execution.mode || ''),
    state: String(execution.state || ''),
    preflight: projectLinkOpsPreflightForClient(execution.preflight),
    writeAudit: {
      requestedMode: projectLinkOpsClientMode(writeAudit.requestedMode || ''),
      submitted: Boolean(writeAudit.submitted || writeAudit.actualWriteSubmitted),
      executeAllowed: Boolean(writeAudit.executeAllowed),
      actualWriteSubmitted: Boolean(writeAudit.actualWriteSubmitted),
      issuedExecuteToExecutor: Boolean(writeAudit.issuedExecuteToExecutor),
      sheinWriteAttempted: Boolean(writeAudit.sheinWriteAttempted),
    },
    openApiProductExecutors: productExecutors,
    linkMaintenancePrechecks: maintenancePrechecks,
    linkMaintenanceExecutors: maintenanceExecutors,
  };
}

function projectLinkOpsTargetsForClient(targets, intents = []) {
  const intentList = asArray(intents).map(x => String(x || '').trim()).filter(Boolean);
  const normalized = normalizeTargetsForIntents(intentList, targets || {});
  const hasCopyProduct = intentList.includes('copy_product_draft');
  const rawProductRefs = asArray(normalized.productRefs)
    .map(x => compactChatLine(x, 120))
    .filter(Boolean);
  const nonSourceProductRefs = rawProductRefs.filter(x => !/^(?:sv|sb)\d{8,}$/i.test(String(x || '').trim()));
  const productRefs = hasCopyProduct && nonSourceProductRefs.length ? nonSourceProductRefs : rawProductRefs;
  return {
    stores: normalizeConcreteStoreKeys(normalized.stores),
    writeStores: normalizeConcreteStoreKeys(normalized.writeStores),
    sourceStores: normalizeConcreteStoreKeys(normalized.sourceStores),
    productRefs: productRefs.slice(0, 12),
    sourceScope: sanitizeLinkOpsClientText(normalized.sourceScope || '', 80),
    attributeOverrides: asArray(normalized.attributeOverrides).map(item => ({
      attribute_id: item?.attribute_id ?? item?.attributeId ?? null,
      label: sanitizeLinkOpsClientText(item?.label || item?.attribute_name || item?.name || '', 120),
      attribute_extra_value: sanitizeLinkOpsClientText(item?.attribute_extra_value || item?.value || item?.display_value || item?.displayValue || '', 120),
      display_value: sanitizeLinkOpsClientText(item?.display_value || item?.displayValue || item?.attribute_extra_value || item?.value || '', 120),
      attribute_unit: sanitizeLinkOpsClientText(item?.attribute_unit || item?.unit || '', 40),
    })).filter(item => item.label || item.display_value).slice(0, 12),
  };
}

function projectLinkOpsOwnershipForClient(record) {
  const ownership = linkOpsOwnershipForRecord(record);
  return {
    state: ownership.state,
    actorKey: ownership.actorKey,
    ownerKey: ownership.ownerKey,
    source: ownership.source,
  };
}

function projectLinkOpsPlanningForClient(planning) {
  if (!planning || typeof planning !== 'object' || Array.isArray(planning)) return null;
  const parameters = planning.parameters && typeof planning.parameters === 'object' && !Array.isArray(planning.parameters)
    ? planning.parameters
    : {};
  const ambiguity = planning.ambiguity && typeof planning.ambiguity === 'object' && !Array.isArray(planning.ambiguity)
    ? planning.ambiguity
    : {};
  const risk = planning.risk && typeof planning.risk === 'object' && !Array.isArray(planning.risk)
    ? planning.risk
    : {};
  const modelProfile = planning.modelProfile && typeof planning.modelProfile === 'object' && !Array.isArray(planning.modelProfile)
    ? planning.modelProfile
    : {};
  const finiteOrNull = value => value === null || value === undefined || value === ''
    ? null
    : Number.isFinite(Number(value)) ? Number(value) : null;
  const textList = (value, max = 20, chars = 160) => asArray(value)
    .map(entry => sanitizeLinkOpsClientText(entry, chars))
    .filter(Boolean)
    .slice(0, max);
  return {
    version: Math.max(0, Number(planning.version || 0)),
    jobId: sanitizeLinkOpsClientText(planning.jobId || '', 180),
    requestType: sanitizeLinkOpsClientText(planning.requestType || '', 40),
    parameters: {
      timeRange: sanitizeLinkOpsClientText(parameters.timeRange || '', 80),
      dateFrom: sanitizeLinkOpsClientText(parameters.dateFrom || '', 40),
      dateTo: sanitizeLinkOpsClientText(parameters.dateTo || '', 40),
      metrics: textList(parameters.metrics, 20, 80),
      groupBy: sanitizeLinkOpsClientText(parameters.groupBy || '', 80),
      comparison: sanitizeLinkOpsClientText(parameters.comparison || '', 80),
      rankDirection: sanitizeLinkOpsClientText(parameters.rankDirection || '', 40),
      limit: finiteOrNull(parameters.limit),
      title: sanitizeLinkOpsClientText(parameters.title || '', 500),
      inventory: finiteOrNull(parameters.inventory),
      supplyPrice: finiteOrNull(parameters.supplyPrice),
      productPrice: finiteOrNull(parameters.productPrice),
      currency: sanitizeLinkOpsClientText(parameters.currency || '', 12),
      discountRate: finiteOrNull(parameters.discountRate),
      discountPrice: finiteOrNull(parameters.discountPrice),
      quantity: finiteOrNull(parameters.quantity),
      activityId: sanitizeLinkOpsClientText(parameters.activityId || '', 120),
      startAt: sanitizeLinkOpsClientText(parameters.startAt || '', 80),
      endAt: sanitizeLinkOpsClientText(parameters.endAt || '', 80),
      sourceScope: sanitizeLinkOpsClientText(parameters.sourceScope || '', 160),
      standardGoodsSn: sanitizeLinkOpsClientText(parameters.standardGoodsSn || '', 160),
      imageInstruction: sanitizeLinkOpsClientText(parameters.imageInstruction || '', 500),
      actionNote: sanitizeLinkOpsClientText(parameters.actionNote || '', 500),
      attributeOverrides: asArray(parameters.attributeOverrides).map(item => ({
        attributeId: sanitizeLinkOpsClientText(item?.attributeId || item?.attribute_id || '', 120),
        label: sanitizeLinkOpsClientText(item?.label || '', 160),
        value: sanitizeLinkOpsClientText(item?.value || item?.attribute_extra_value || '', 300),
        unit: sanitizeLinkOpsClientText(item?.unit || item?.attribute_unit || '', 40),
      })).filter(item => item.attributeId || item.label || item.value).slice(0, 30),
    },
    ambiguity: {
      hasAmbiguity: Boolean(ambiguity.hasAmbiguity),
      reasons: textList(ambiguity.reasons, 20, 300),
      clarifyingQuestions: textList(ambiguity.clarifyingQuestions, 20, 300),
    },
    risk: {
      level: sanitizeLinkOpsClientText(risk.level || '', 40),
      writeRequested: Boolean(risk.writeRequested),
      requiresHumanConfirmation: Boolean(risk.requiresHumanConfirmation),
      reasons: textList(risk.reasons, 20, 300),
    },
    confidence: Math.max(0, Math.min(1, Number(planning.confidence || 0))),
    summary: sanitizeLinkOpsClientText(planning.summary || '', 1_000),
    ignored: Boolean(planning.ignored),
    ignoredReason: sanitizeLinkOpsClientText(planning.ignoredReason || '', 160),
    ignoredRequestType: sanitizeLinkOpsClientText(planning.ignoredRequestType || '', 40),
    advisory: Boolean(planning.advisory),
    factsApplied: Boolean(planning.factsApplied),
    modelProfile: {
      tier: sanitizeLinkOpsClientText(modelProfile.tier || '', 40),
      model: sanitizeLinkOpsClientText(modelProfile.model || '', 120),
      reasoning: sanitizeLinkOpsClientText(modelProfile.reasoning || '', 40),
      timeoutMs: Math.max(0, Number(modelProfile.timeoutMs || 0)),
      reason: sanitizeLinkOpsClientText(modelProfile.reason || '', 120),
    },
    completedAt: sanitizeLinkOpsClientText(planning.completedAt || '', 80),
  };
}

function projectLinkOpsTaskForClient(task) {
  const execution = projectLinkOpsExecutionForClient(task?.execution);
  const preflight = projectLinkOpsPreflightForClient(task?.preflight) || execution?.preflight || null;
  const intents = asArray(task?.intents).map(x => String(x || '').trim()).filter(Boolean).slice(0, 12);
  return {
    id: String(task?.id || ''),
    title: sanitizeLinkOpsClientText(task?.title || '', 160),
    status: String(task?.status || ''),
    progress: normalizeProgress(task?.progress, 0),
    intents,
    targets: projectLinkOpsTargetsForClient(task?.targets || {}, intents),
    chatSessionId: String(task?.chatSessionId || task?.chat?.sessionId || ''),
    ownership: projectLinkOpsOwnershipForClient(task),
    createdAt: task?.createdAt || '',
    updatedAt: task?.updatedAt || '',
    lifecycle: task?.lifecycle && typeof task.lifecycle === 'object' ? {
      lifecycleStatus: String(task.lifecycle.lifecycleStatus || task.lifecycle.status || ''),
      status: String(task.lifecycle.status || task.lifecycle.lifecycleStatus || ''),
    } : null,
    planning: projectLinkOpsPlanningForClient(task?.planning),
    preflight,
    execution,
    assets: asArray(task?.assets).map(projectLinkOpsAssetForClient).slice(0, 30),
  };
}

function projectLinkOpsTaskStoreForClient(value, {limit = 120} = {}) {
  const store = normalizeLinkOpsTaskStore(value);
  const max = Math.max(1, Math.min(500, Number(limit || 120)));
  return {
    version: store.version,
    updatedAt: store.updatedAt,
    tasks: store.tasks.slice(0, max).map(projectLinkOpsTaskForClient),
  };
}

function projectLinkOpsTaskStoreForActor(value, actor, {limit = 120, globalView = false} = {}) {
  const store = normalizeLinkOpsTaskStore(value);
  return projectLinkOpsTaskStoreForClient({
    ...store,
    tasks: linkOpsTasksForActor(store.tasks, actor, {globalView, mode: 'read'}),
  }, {limit});
}

function projectLinkOpsAssetForClient(asset) {
  if (!asset || typeof asset !== 'object') return null;
  return {
    id: String(asset.id || ''),
    name: sanitizeLinkOpsClientText(asset.name || asset.originalName || '', 180),
    kind: sanitizeLinkOpsClientText(asset.kind || '', 60),
    mime: sanitizeLinkOpsClientText(asset.mime || asset.type || '', 120),
    size: Number(asset.size ?? asset.bytes ?? 0) || 0,
    createdAt: asset.createdAt || asset.uploadedAt || '',
  };
}

function projectLinkOpsChatMessageForClient(message) {
  if (!message || typeof message !== 'object') return null;
  const role = String(message.role || '').trim() === 'user' ? 'user' : 'assistant';
  const meta = message.meta && typeof message.meta === 'object' ? {
    mode: sanitizeLinkOpsClientText(message.meta.mode || '', 60),
    autoTaskId: String(message.meta.autoTaskId || ''),
    intentPlanJobId: sanitizeLinkOpsClientText(message.meta.intentPlanJobId || '', 180),
  } : null;
  return {
    id: String(message.id || ''),
    role,
    content: role === 'assistant'
      ? sanitizeLinkOpsClientMarkdown(message.content || '', 16000)
      : String(message.content || '').slice(0, 4000),
    at: message.at || message.createdAt || '',
    ...(meta && (meta.mode || meta.autoTaskId || meta.intentPlanJobId) ? {meta} : {}),
  };
}

function projectLinkOpsChatSessionForClient(session) {
  if (!session || typeof session !== 'object') return null;
  return {
    id: String(session.id || ''),
    version: Number(session.version || 1) || 1,
    status: sanitizeLinkOpsClientText(session.status || '', 40),
    title: sanitizeLinkOpsClientText(session.title || '', 120),
    autoTitle: session.autoTitle !== false,
    targets: projectLinkOpsTargetsForClient(session.targets || {}),
    ownership: projectLinkOpsOwnershipForClient(session),
    memoryPolicy: CLOUD_AI_MEMORY_POLICY,
    createdAt: session.createdAt || '',
    updatedAt: session.updatedAt || '',
    assets: asArray(session.assets).map(projectLinkOpsAssetForClient).filter(Boolean).slice(0, 30),
    messages: asArray(session.messages).map(projectLinkOpsChatMessageForClient).filter(Boolean).slice(-80),
  };
}

function projectLinkOpsChatStoreForClient(value, {limit = 80} = {}) {
  const store = normalizeLinkOpsChatStore(value);
  const max = Math.max(1, Math.min(300, Number(limit || 80)));
  return {
    version: store.version,
    updatedAt: store.updatedAt,
    memoryPolicy: CLOUD_AI_MEMORY_POLICY,
    sessions: store.sessions.slice(0, max).map(projectLinkOpsChatSessionForClient).filter(Boolean),
  };
}

function projectLinkOpsChatStoreForActor(value, actor, {limit = 80, globalView = false} = {}) {
  const store = normalizeLinkOpsChatStore(value);
  return projectLinkOpsChatStoreForClient({
    ...store,
    sessions: linkOpsSessionsForActor(store.sessions, actor, {globalView, mode: 'read'}),
  }, {limit});
}

function taskTargetStores(task) {
  return normalizeStoreList(task?.targets?.stores || task?.stores || []);
}

function taskSourceStores(task) {
  const targets = normalizeLinkOpsTargetSet(task?.targets || {});
  return normalizeStoreList(targets.sourceStores);
}

function taskWriteStores(task) {
  const targets = normalizeLinkOpsTargetSet(task?.targets || {});
  const explicit = normalizeStoreList(targets.writeStores);
  return explicit.length ? explicit : taskTargetStores(task);
}

function normalizeLinkOpsChatStore(value) {
  const sessions = Array.isArray(value?.sessions) ? value.sessions : [];
  return {
    version: 1,
    updatedAt: value?.updatedAt || null,
    memoryPolicy: CLOUD_AI_MEMORY_POLICY,
    sessions: sessions
      .filter(x => x && typeof x === 'object')
      .map(session => normalizeLinkOpsRecordOwnership({
        ...session,
        memoryPolicy: CLOUD_AI_MEMORY_POLICY,
        codexSessionId: safeCodexSessionId(session.codexSessionId || ''),
        messages: recentCloudAiMessages(session.messages),
      }))
      .slice(0, 300),
  };
}

function buildChatSessionFromMessage(body, actor, req) {
  const message = String(body.message || body.command || body.text || '').trim();
  if (!message) throw new Error('Missing message');
  if (message.length > 4000) throw new Error('Message too long');
  const now = new Date().toISOString();
  const id = `los_${now.replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto.randomBytes(4).toString('hex')}`;
  const targets = normalizeTargetsForIntents(inferLinkOpsIntent(message), mergeLinkOpsTargets(
    inferLinkOpsTargets(message),
    body.targets && typeof body.targets === 'object' ? body.targets : {}
  ));
  return bindLinkOpsRecordToActor({
    id,
    version: 1,
    status: 'chatting',
    title: buildLinkOpsSessionTitle(message, targets),
    autoTitle: true,
    targets,
    memoryPolicy: CLOUD_AI_MEMORY_POLICY,
    codexSessionId: '',
    requestedBy: actorLabel(actor, req),
    requestedByUser: actorUser(actor, req),
    requestMeta: requestMeta(req),
    createdAt: now,
    updatedAt: now,
    messages: [{
      id: `msg_${crypto.randomBytes(5).toString('hex')}`,
      role: 'user',
      content: message,
      at: now,
    }],
  }, actor, 'created');
}

function buildUploadChatSession(actor, req) {
  const now = new Date().toISOString();
  const id = `los_${now.replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto.randomBytes(4).toString('hex')}`;
  return bindLinkOpsRecordToActor({
    id,
    version: 1,
    status: 'chatting',
    title: '上传资料',
    autoTitle: true,
    targets: {},
    assets: [],
    memoryPolicy: CLOUD_AI_MEMORY_POLICY,
    codexSessionId: '',
    requestedBy: actorLabel(actor, req),
    requestedByUser: actorUser(actor, req),
    requestMeta: requestMeta(req),
    createdAt: now,
    updatedAt: now,
    messages: [],
  }, actor, 'created');
}

function appendChatMessage(session, body, actor, req) {
  const content = String(body.message || body.command || body.text || '').trim();
  if (!content) throw new Error('Missing message');
  if (content.length > 4000) throw new Error('Message too long');
  const now = new Date().toISOString();
  const messages = Array.isArray(session.messages) ? session.messages.slice() : [];
  messages.push({id: `msg_${crypto.randomBytes(5).toString('hex')}`, role: 'user', content, at: now});
  const targets = normalizeTargetsForIntents(inferLinkOpsIntent(content), mergeLinkOpsTargets(
    session.targets && typeof session.targets === 'object' ? session.targets : {},
    inferLinkOpsTargets(content)
  ));
  const titleText = messages.filter(m => m.role === 'user').map(m => m.content).slice(0, 2).join('\n');
  return {
    ...session,
    status: 'chatting',
    updatedAt: now,
    memoryPolicy: CLOUD_AI_MEMORY_POLICY,
    title: session.autoTitle === false ? session.title : buildLinkOpsSessionTitle(titleText || content, targets),
    autoTitle: session.autoTitle === false ? false : true,
    targets,
    messages,
    updatedBy: actorLabel(actor, req),
  };
}

function appendAssistantChatMessage(session, answer, meta = {}) {
  const now = new Date().toISOString();
  const messages = Array.isArray(session.messages) ? session.messages.slice() : [];
  messages.push({id: `msg_${crypto.randomBytes(5).toString('hex')}`, role: 'assistant', content: String(answer || '').slice(0, 16000), at: now, meta});
  return {
    ...session,
    updatedAt: now,
    memoryPolicy: CLOUD_AI_MEMORY_POLICY,
    targets: session.targets && typeof session.targets === 'object' ? session.targets : {},
    messages,
  };
}

function summarizeLinkOpsSessionAssets(session) {
  const assets = asArray(session?.assets).filter(a => a && (a.originalName || a.name || a.mime));
  if (!assets.length) return '暂无';
  return assets.slice(0, 12).map(a => {
    const name = sanitizeLinkOpsClientText(a.originalName || a.name || '文件', 120);
    const kind = sanitizeLinkOpsClientText(a.kind || assetKindForMime(a.mime || '') || 'file', 40);
    const bytes = Number(a.bytes ?? a.size ?? 0) || 0;
    return `${name}（${kind}${bytes ? `, ${bytes} bytes` : ''}）`;
  }).join('；');
}

function attachAssetsToChatSession(session, assets, {message = '', meta = {}} = {}) {
  const incoming = asArray(assets).filter(a => a && a.id);
  const existing = asArray(session?.assets).filter(a => a && a.id);
  const seen = new Set();
  const mergedAssets = [...incoming, ...existing].filter(asset => {
    const id = String(asset.id || '');
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).slice(0, 230);
  const base = {
    ...session,
    status: 'chatting',
    updatedAt: new Date().toISOString(),
    memoryPolicy: CLOUD_AI_MEMORY_POLICY,
    targets: session?.targets && typeof session.targets === 'object' ? session.targets : {},
    assets: mergedAssets,
  };
  return message ? appendAssistantChatMessage(base, message, meta) : base;
}

function mergeLinkOpsSessionAssetsIntoTask(task, session, actor, req) {
  const sessionAssets = asArray(session?.assets).filter(a => a && a.id);
  if (!sessionAssets.length || !task?.id) return task;
  const existing = asArray(task.assets).filter(a => a && a.id);
  const existingIds = new Set(existing.map(a => String(a.id || '')));
  const inherited = sessionAssets
    .filter(a => !existingIds.has(String(a.id || '')))
    .map(a => ({
      ...a,
      taskId: String(task.id || ''),
      linkedFromSessionId: String(session?.id || a.sessionId || ''),
    }));
  if (!inherited.length) return task;
  const nextTask = {
    ...task,
    assets: [...inherited, ...existing].slice(0, 230),
    updatedAt: new Date().toISOString(),
  };
  nextTask.history = appendTaskHistory(nextTask, 'attach_chat_session_assets', actor, req, {
    sessionId: String(session?.id || ''),
    assetCount: inherited.length,
  });
  return nextTask;
}

function replaceLinkOpsTaskInStore(store, task) {
  const tasks = asArray(store?.tasks).slice();
  const idx = tasks.findIndex(t => String(t?.id || '') === String(task?.id || ''));
  if (idx < 0) return store;
  tasks[idx] = task;
  return {version: 1, updatedAt: new Date().toISOString(), tasks};
}

const LINK_OPS_ALLOWED_STATUSES = new Set([
  'draft',
  'confirmed',
  'in_progress',
  'waiting_review',
  'submitted_but_readback_pending',
  'needs_manual_resolve',
  'done',
  'archived',
]);
const LINK_OPS_RESTRICTED_LIFECYCLE_STATUSES = new Set([
  'submitted_but_readback_pending',
  'submitted_readback_failed',
  'suspicious_write_attempted',
  'needs_manual_resolve',
]);

function normalizeProgress(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function appendTaskHistory(task, event, actor, req, extra = {}) {
  const history = Array.isArray(task.history) ? task.history.slice(-80) : [];
  history.push({
    at: new Date().toISOString(),
    event,
    by: actorLabel(actor, req),
    user: actorUser(actor, req),
    ...extra,
  });
  return history;
}

function appendExecutionHistory(task, entry = {}) {
  const history = Array.isArray(task?.executionHistory) ? task.executionHistory.slice(-60) : [];
  history.push({
    at: new Date().toISOString(),
    version: 1,
    ...entry,
  });
  return history;
}

function isOwnerActor(actor) {
  return actorHasGlobalOpsView(actor);
}

function taskRequiresOwnerLifecycleResolve(task) {
  const status = String(task?.status || '');
  const lifecycleStatus = String(task?.lifecycle?.lifecycleStatus || task?.lifecycle?.status || '');
  return LINK_OPS_RESTRICTED_LIFECYCLE_STATUSES.has(status)
    || LINK_OPS_RESTRICTED_LIFECYCLE_STATUSES.has(lifecycleStatus);
}

function patchLinkOpsTask(task, body, actor, req) {
  for (const field of Object.keys(body || {})) {
    if (LINK_OPS_PROTECTED_TASK_PATCH_FIELDS.has(field)) {
      throw new Error(`Protected field cannot be patched from client: ${field}`);
    }
  }
  if (taskRequiresOwnerLifecycleResolve(task) && !isOwnerActor(actor)) {
    throw new Error('任务已进入提交后/需人工处理状态，只有全店管理账号可以人工核销或归档。');
  }
  const next = {
    ...task,
    updatedAt: new Date().toISOString(),
  };
  const event = String(body.event || body.action || 'update').slice(0, 80);
  if (body.status !== undefined) {
    const status = String(body.status || '').trim();
    if (!LINK_OPS_ALLOWED_STATUSES.has(status)) throw new Error(`Invalid status: ${status}`);
    if (LINK_OPS_RESTRICTED_LIFECYCLE_STATUSES.has(status)) {
      throw new Error('提交后生命周期状态只能由受控执行器写入，不能从客户端手动设置。');
    }
    if (taskRequiresOwnerLifecycleResolve(task) && !isOwnerActor(actor)) {
      throw new Error('任务已进入提交后/需人工处理状态，只有全店管理账号可以手动变更状态。');
    }
    if (taskRequiresOwnerLifecycleResolve(task) && ['confirmed', 'in_progress', 'waiting_review'].includes(status)) {
      throw new Error('提交后待回读或回读异常的任务不能手动改回可执行状态，必须先人工核销为 done 或 archived。');
    }
    next.status = status;
    if (['done', 'archived'].includes(status)) {
      next.assetRetention = {
        policy: 'keep_until_task_delete',
        note: '任务完成/归档后暂保留素材用于复核；删除任务时同步清理素材目录。',
        updatedAt: new Date().toISOString(),
      };
      if (taskRequiresOwnerLifecycleResolve(task)) {
        next.lifecycle = {
          ...(task.lifecycle && typeof task.lifecycle === 'object' ? task.lifecycle : {}),
          status: status === 'done' ? 'manual_resolved_done' : 'manual_resolved_archived',
          terminal: true,
          manualResolution: {
            by: actorLabel(actor, req),
            user: actorUser(actor, req),
            at: new Date().toISOString(),
            note: typeof body.note === 'string' ? body.note.trim().slice(0, 1000) : '',
          },
        };
      }
    }
  }
  if (body.progress !== undefined) {
    next.progress = normalizeProgress(body.progress, normalizeProgress(task.progress, 0));
  }
  if (typeof body.note === 'string') {
    next.note = body.note.trim().slice(0, 2000);
  }
  if (typeof body.command === 'string') {
    next.command = body.command.trim().slice(0, 2000) || next.command;
  }
  if (body.preview && typeof body.preview === 'object') {
    next.preview = {
      ...(task.preview && typeof task.preview === 'object' ? task.preview : {}),
      ...body.preview,
    };
    next.preview.agentAnswer = '';
    next.preview.structuredAnswer = '';
    if (Array.isArray(next.preview.titleCandidates)) next.preview.titleCandidates = next.preview.titleCandidates.slice(0, 20).map(x => String(x).slice(0, 240));
  }
  next.history = appendTaskHistory(next, event, actor, req, {
    status: next.status,
    progress: normalizeProgress(next.progress, 0),
    hasAgentAnswer: !!next.preview?.agentAnswer,
    hasNote: !!next.note,
  });
  if (taskRequiresOwnerLifecycleResolve(task) && ['done', 'archived'].includes(String(next.status || ''))) {
    next.executionHistory = appendExecutionHistory(task, {
      event: 'manual_lifecycle_resolve',
      fromStatus: task.status || '',
      toStatus: next.status || '',
      actor: actorAuditContext(actor, req),
      requestMeta: requestMeta(req),
      note: typeof body.note === 'string' ? body.note.trim().slice(0, 1000) : '',
    });
  }
  return next;
}

function linkOpsTaskNeedsMaterial(task) {
  const intents = Array.isArray(task?.intents) ? task.intents : [];
  const needs = [];
  if (intents.includes('update_images')) needs.push('image');
  if (intents.includes('copy_product_draft')) needs.push('image_or_certificate');
  if (intents.includes('certificate_review')) needs.push('certificate');
  if (intents.includes('update_title')) needs.push('title_text_or_rule');
  return needs;
}

function assetKindForMime(mime) {
  if (String(mime || '').startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'certificate';
  if (mime === 'text/plain' || mime === 'text/csv' || mime === 'application/json') return 'text';
  if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'spreadsheet';
  return 'file';
}

function buildAssetRecord({taskId = '', sessionId = '', file, buffer, storedPath, actor, req}) {
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  return {
    id: `loa_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    taskId,
    sessionId,
    originalName: String(file.name || 'asset').slice(0, 180),
    mime: String(file.type || '').toLowerCase().trim(),
    kind: assetKindForMime(String(file.type || '').toLowerCase().trim()),
    bytes: buffer.length,
    sha256,
    storedName: path.basename(storedPath),
    storedRelativePath: path.relative(ROOT, storedPath).replace(/\\/g, '/'),
    uploadedAt: new Date().toISOString(),
    uploadedBy: actorLabel(actor, req),
    uploadedByUser: actorUser(actor, req),
  };
}

async function storeLinkOpsUploadedFiles({bucketId, taskId = '', sessionId = '', files, args, actor, req}) {
  const safeBucket = safeFileStem(bucketId, 'upload');
  if (!safeBucket) throw new Error('Invalid upload bucket');
  const normalizedFiles = Array.isArray(files) ? files : [];
  if (!normalizedFiles.length) throw new Error('Missing files');
  if (normalizedFiles.length > 40) throw new Error('一次最多上传 40 个文件');
  let totalBytes = 0;
  const baseDir = path.resolve(args.linkOpsAssetDir);
  const bucketDir = assertInsideDir(baseDir, path.join(baseDir, safeBucket));
  await fs.mkdir(bucketDir, {recursive: true});
  const added = [];
  const writtenPaths = [];
  try {
    for (const file of normalizedFiles) {
      const mime = String(file?.type || '').toLowerCase().trim();
      if (!LINK_OPS_ALLOWED_UPLOAD_MIME.has(mime)) throw new Error(`不支持的文件类型：${mime || 'unknown'}。支持 JPG/PNG/WebP、PDF、TXT/CSV/JSON、XLSX。`);
      const raw = String(file?.dataBase64 || file?.base64 || '').replace(/^data:[^;]+;base64,/, '');
      if (!raw) throw new Error('Missing file content');
      const buffer = Buffer.from(raw, 'base64');
      if (!buffer.length) throw new Error('Empty file');
      if (buffer.length > LINK_OPS_MAX_UPLOAD_FILE_BYTES) throw new Error(`文件太大：${file?.name || 'asset'}，单个文件不能超过 20MB`);
      totalBytes += buffer.length;
      if (totalBytes > LINK_OPS_MAX_UPLOAD_TOTAL_BYTES) throw new Error('本次上传总大小超过 120MB');
      if (!hasUploadMagic(buffer, mime)) throw new Error(`文件内容和类型不匹配：${file?.name || mime}`);
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
      const ext = uploadExtensionFor(mime, file?.name || '');
      const stem = safeFileStem(path.basename(String(file?.name || 'asset'), path.extname(String(file?.name || ''))), 'asset');
      const storedName = `${sha256.slice(0, 16)}-${stem}${ext}`;
      const storedPath = assertInsideDir(bucketDir, path.join(bucketDir, storedName));
      await fs.writeFile(storedPath, buffer);
      writtenPaths.push(storedPath);
      added.push(buildAssetRecord({taskId, sessionId, file: {...file, type: mime}, buffer, storedPath, actor, req}));
    }
  } catch (err) {
    await Promise.allSettled(writtenPaths.map(file => fs.rm(file, {force: true})));
    throw err;
  }
  return {assets: added, totalBytes};
}

function normalizeOpenApiImageAssetType(value) {
  const type = Number(value);
  return Number.isInteger(type) ? type : NaN;
}

async function writeOpenApiImageAssetTempFile({file, buffer, tmpDir}) {
  const mime = String(file?.type || '').toLowerCase().trim();
  const ext = uploadExtensionFor(mime, file?.name || '');
  const stem = safeFileStem(path.basename(String(file?.name || 'image'), path.extname(String(file?.name || ''))), 'image');
  const storedName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${stem}${ext}`;
  const filePath = assertInsideDir(tmpDir, path.join(tmpDir, storedName));
  await fs.mkdir(tmpDir, {recursive: true});
  await fs.writeFile(filePath, buffer);
  return filePath;
}

async function executeOpenApiImageAssetUtility({action, body, args, actor, req}) {
  const storeKey = String(body.storeKey || body.store || '').trim().toUpperCase();
  if (!storeKey || !SHEIN_STORE_KEYS.has(storeKey)) throw new Error('Invalid store');
  const actorGate = requireConcreteOperatorActor(actor);
  if (actorGate) {
    await appendAudit(args.auditFile, {at: new Date().toISOString(), type: `openapi-image-asset-${action}-denied`, actor, ...requestMeta(req), denied: actorGate});
    const error = new Error(actorGate.error || 'actor denied');
    error.status = 403;
    error.response = actorGate;
    throw error;
  }
  const denied = requireWriteStores(actor, [storeKey]);
  if (denied) {
    await appendAudit(args.auditFile, {at: new Date().toISOString(), type: `openapi-image-asset-${action}-denied`, actor, ...requestMeta(req), storeKey, denied});
    const error = new Error(denied.error || 'store write denied');
    error.status = 403;
    error.response = denied;
    throw error;
  }
  const imageType = normalizeOpenApiImageAssetType(body.imageType ?? body.image_type ?? body.type);
  if (!OPENAPI_IMAGE_ASSET_TYPES.has(imageType)) throw new Error('imageType must be one of 1/2/5/6/7');
  const {store, client} = openApiClientForConfiguredStore(storeKey);
  const identity = await verifyOpenApiStoreIdentityForUtility(client, storeKey, store);
  if (!identity.ok) {
    await appendAudit(args.auditFile, {at: new Date().toISOString(), type: `openapi-image-asset-${action}-denied-identity`, actor, ...requestMeta(req), storeKey, identity: {ok: false, httpStatus: identity.httpStatus || null, error: identity.error || ''}});
    const error = new Error(identity.error || 'store identity validation failed');
    error.status = 409;
    throw error;
  }
  let adapterResult;
  let auditFileMeta = null;
  let tempFile = '';
  try {
    if (action === 'upload-pic') {
      const file = Array.isArray(body.files) ? body.files[0] : (body.file || null);
      const mime = String(file?.type || file?.mime || '').toLowerCase().trim();
      if (!OPENAPI_IMAGE_ASSET_ALLOWED_MIME.has(mime)) throw new Error('upload-pic only accepts image/jpeg or image/png');
      const raw = String(file?.dataBase64 || file?.base64 || '').replace(/^data:[^;]+;base64,/, '');
      if (!raw) throw new Error('Missing file content');
      const buffer = Buffer.from(raw, 'base64');
      if (!buffer.length) throw new Error('Empty file');
      if (buffer.length > OPENAPI_IMAGE_ASSET_MAX_FILE_BYTES) throw new Error(`image exceeds 3MB OpenAPI limit: ${buffer.length} bytes`);
      if (!hasUploadMagic(buffer, mime)) throw new Error(`文件内容和类型不匹配：${file?.name || mime}`);
      auditFileMeta = {
        name: String(file?.name || 'image').slice(0, 180),
        mime,
        bytes: buffer.length,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      };
      const tmpDir = assertInsideDir(path.resolve(args.linkOpsAssetDir), path.join(path.resolve(args.linkOpsAssetDir), '.openapi-image-tmp'));
      tempFile = await writeOpenApiImageAssetTempFile({file: {...file, type: mime}, buffer, tmpDir});
      adapterResult = await executeUploadPic(client, {imageType, filePath: tempFile}, {mode: 'execute'});
    } else if (action === 'transform-pic') {
      const originalUrl = String(body.url || body.originalUrl || body.original_url || '').trim();
      adapterResult = await executeTransformPic(client, {imageType, originalUrl}, {mode: 'execute'});
    } else {
      throw new Error(`Unsupported image asset action: ${action}`);
    }
  } finally {
    if (tempFile) await fs.rm(tempFile, {force: true}).catch(() => {});
  }
  if (!adapterResult?.ok) {
    const message = (adapterResult?.blockers || adapterResult?.errors || []).join('; ') || adapterResult?.msg || `${action} failed`;
    const error = new Error(message);
    error.status = 502;
    error.response = {ok: false, error: message, adapterResult: {code: adapterResult?.code || '', msg: adapterResult?.msg || '', traceId: adapterResult?.traceId || ''}};
    throw error;
  }
  const result = action === 'upload-pic'
    ? {
      imageUrl: adapterResult.result?.imageUrl || '',
      width: adapterResult.result?.width || 0,
      height: adapterResult.result?.height || 0,
      size: adapterResult.result?.size || 0,
      imageHexType: adapterResult.result?.imageHexType || '',
    }
    : {
      originalUrl: adapterResult.result?.originalUrl || '',
      transformedUrl: adapterResult.result?.transformedUrl || '',
      failureReason: adapterResult.result?.failureReason || '',
    };
  await appendAudit(args.auditFile, {
    at: new Date().toISOString(),
    type: `openapi-image-asset-${action}`,
    actor,
    ...requestMeta(req),
    storeKey,
    imageType,
    file: auditFileMeta,
    identity: {ok: true, httpStatus: identity.httpStatus || null},
    result: {...result, traceId: adapterResult.traceId || ''},
  });
  return {
    ok: true,
    action,
    mode: 'execute',
    storeKey,
    imageType,
    adapterResult: {
      ok: true,
      mode: 'execute',
      endpoint: action === 'upload-pic' ? '/open-api/goods/upload-pic' : '/open-api/goods/transform-pic',
      code: adapterResult.code || '0',
      msg: adapterResult.msg || '',
      traceId: adapterResult.traceId || '',
      result,
    },
    storeIdentity: {ok: true, httpStatus: identity.httpStatus || null},
    result,
    code: adapterResult.code || '0',
    msg: adapterResult.msg || '',
    traceId: adapterResult.traceId || '',
    safety: {
      cloudCredentialsOnly: true,
      productWriteSubmitted: false,
      outputOmitsSecretsAndFileBytes: true,
    },
  };
}

function findLinkOpsTaskOrThrow(store, taskId) {
  const id = safeTaskId(taskId);
  const tasks = Array.isArray(store?.tasks) ? store.tasks.slice() : [];
  const idx = tasks.findIndex(t => String(t.id || '') === id);
  if (idx < 0) throw new Error('Task not found');
  return {id, tasks, idx, task: tasks[idx]};
}

async function attachLinkOpsAssets({store, taskId, sessionId = '', files, args, actor, req}) {
  const {id, tasks, idx} = findLinkOpsTaskOrThrow(store, taskId);
  const {assets: added, totalBytes} = await storeLinkOpsUploadedFiles({bucketId: id, taskId: id, sessionId, files, args, actor, req});
  const task = tasks[idx];
  const assets = Array.isArray(task.assets) ? task.assets.slice(-200) : [];
  const nextTask = {
    ...task,
    assets: [...added, ...assets],
    updatedAt: new Date().toISOString(),
  };
  nextTask.history = appendTaskHistory(nextTask, 'upload_assets', actor, req, {
    status: nextTask.status,
    progress: normalizeProgress(nextTask.progress, 0),
    assetCount: added.length,
    totalBytes,
  });
  tasks[idx] = nextTask;
  return {
    store: {version: 1, updatedAt: new Date().toISOString(), tasks},
    task: nextTask,
    assets: added,
  };
}

async function appendLinkOpsChatAssistantMessageForTask(args, task, answer, meta = {}) {
  const sessionId = String(task?.chatSessionId || task?.sessionId || task?.targets?.chatSessionId || '').trim();
  const content = String(answer || '').trim();
  if (!sessionId || !content) return {ok: false, reason: 'missing_session_or_answer'};
  const current = normalizeLinkOpsChatStore(await readLinkOpsChatStore(args));
  const idx = current.sessions.findIndex(s => String(s.id || '') === sessionId);
  if (idx < 0) return {ok: false, reason: 'session_not_found'};
  const sessions = current.sessions.slice();
  sessions[idx] = appendAssistantChatMessage(sessions[idx], content, meta);
  const next = {version: 1, updatedAt: new Date().toISOString(), memoryPolicy: CLOUD_AI_MEMORY_POLICY, sessions};
  await writeLinkOpsChatStore(args, next);
  return {ok: true, session: sessions[idx], store: next};
}

async function removeLinkOpsTaskAssetDir(taskId, args) {
  const id = safeTaskId(taskId);
  const baseDir = path.resolve(args.linkOpsAssetDir);
  const taskDir = assertInsideDir(baseDir, path.join(baseDir, id));
  await fs.rm(taskDir, {recursive: true, force: true});
}

function runPreflightForLinkOpsTask(task) {
  const blockers = [];
  const warnings = [];
  const assets = Array.isArray(task.assets) ? task.assets : [];
  const hasJsonAsset = assets.some(a => String(a?.mime || '').toLowerCase() === 'application/json' || /\.json$/i.test(String(a?.originalName || a?.storedRelativePath || '')));
  const needs = linkOpsTaskNeedsMaterial(task);
  const intents = Array.isArray(task?.intents) ? task.intents : [];
  const targets = normalizeLinkOpsTargetSet(task?.targets || {});
  const stores = normalizeConcreteStoreKeys(targets.stores);
  const status = String(task.status || 'draft');
  if (!['confirmed', 'in_progress', 'waiting_review'].includes(status)) {
    blockers.push('我还没有把这件事整理成可执行处理；你直接在聊天里明确要做什么，我会继续往下查。');
  }
  if (needs.includes('image') && !intents.includes('copy_product_draft') && !assets.some(a => a.kind === 'image') && !hasJsonAsset) {
    blockers.push('缺少图片素材：请上传图片，或上传系统导出的图片资料 JSON。');
  }
  if (needs.includes('image_or_certificate') && !assets.some(a => a.kind === 'image' || a.kind === 'certificate' || a.mime === 'application/json')) {
    warnings.push('复制上品暂未上传图片/证书/发布资料；如果系统不能从源商品详情还原素材，会提示你补。');
  }
  if (needs.includes('image') && intents.includes('copy_product_draft') && !assets.some(a => a.kind === 'image')) {
    warnings.push('复制上品未上传图片素材；系统会优先尝试从源店商品快照复制图片，源快照不足时再提示你补。');
  }
  if (needs.includes('certificate') && !assets.some(a => a.kind === 'certificate' || a.kind === 'text' || a.mime === 'application/pdf' || a.mime === 'application/json') && !task?.certificatePayload && !task?.targets?.certificatePayload && !Array.isArray(task?.certificatePayloads) && !Array.isArray(task?.targets?.certificatePayloads)) {
    blockers.push('缺少证书/资质材料：请上传 PDF/JSON，或提供 certificatePayloads[{endpoint,body}]。');
  }
  if (needs.includes('title_text_or_rule') && !assets.some(a => a.kind === 'text')) {
    warnings.push('标题类任务未上传标题文本/规则文件；如果标题已写在会话或任务说明里，可人工确认后继续。');
  }
  const authorizedStores = stores.filter(store => openApiStoreCapability(store).authorized);
  const storesMissingProductAdapter = stores.filter(store => openApiStoreCapability(store).authorized && !openApiStoreCapability(store).productPublishAdapter);
  if (intents.includes('copy_product_draft') && storesMissingProductAdapter.length) {
    warnings.push(`${storesMissingProductAdapter.join(',')} OpenAPI 已授权，但最近只读探针未证明可用；本任务会先停在会话里，需先修复店铺连通性后再继续。`);
  }
  const nonOpenApiStores = stores.filter(store => !openApiStoreCapability(store).authorized);
  if (intents.some(x => ['copy_product_draft', 'update_title', 'update_images', 'update_inventory', 'update_supply_price', 'update_product_price', 'activate_link', 'retire_link', 'campaign_signup', 'flash_discount', 'certificate_review'].includes(x)) && nonOpenApiStores.length) {
    warnings.push(`${nonOpenApiStores.join(',')} 暂无官方 OpenAPI 授权记录；后续执行需走云端 WebAPI/headless 受控路径或先完成该店 OpenAPI 接入。`);
  }
  if (authorizedStores.length && !stores.some(store => openApiStoreCapability(store).productPublishAdapter)) {
    warnings.push(`${authorizedStores.join(',')} 已具备授权配置，但当前动作暂无可真实提交的适配器；系统只检查，不会静默写后台。`);
  }
  if (!Array.isArray(task.history)) warnings.push('任务缺少历史记录，建议先刷新任务状态。');
  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    needs,
    assetCount: assets.length,
  };
}

function openApiProductExecutorTargetStores(task) {
  const intents = Array.isArray(task?.intents) ? task.intents : [];
  const stores = normalizeConcreteStoreKeys(taskWriteStores(task));
  if (!intents.includes('copy_product_draft')) return [];
  return stores.filter(store => openApiStoreCapability(store).productPublishPrecheckAdapter);
}

function shouldRunImmediateChatSystemCheck(task) {
  const intents = Array.isArray(task?.intents) ? task.intents : [];
  const hasProductPublish = intents.includes('copy_product_draft') && openApiProductExecutorTargetStores(task).length > 0;
  const hasMaintenanceAction = intents.some(intent => LINK_MAINTENANCE_INTENTS.has(intent)) && openApiMaintenanceExecutorTargetStores(task).length > 0;
  return hasProductPublish || hasMaintenanceAction;
}

function executionPreValidMessagesFromRun(run) {
  const rows = asArray(run?.publishResult?.info?.pre_valid_result || run?.publishResult?.info?.preValidResult);
  const out = [];
  for (const row of rows) {
    const label = String(row?.form_name || row?.form || row?.module || '平台规则').trim();
    for (const msg of asArray(row?.messages || row?.message)) {
      const text = String(msg || '').trim();
      if (text) out.push(`${label}：${text}`);
    }
  }
  if (!out.length && run?.publishResult?.info?.success === false) {
    out.push('平台返回未通过，但没有给出具体字段明细。');
  }
  return [...new Set(out)];
}

function humanSourceMetricLine(source = {}) {
  const m = source.metrics && typeof source.metrics === 'object' ? source.metrics : {};
  const parts = [];
  if (Number(m.c30SaleCnt || 0)) parts.push(`近30天销量 ${m.c30SaleCnt}`);
  if (Number(m.c7SaleCnt || 0)) parts.push(`近7天销量 ${m.c7SaleCnt}`);
  if (Number(m.c30GoodsUv || 0)) parts.push(`近30天商品访客 ${m.c30GoodsUv}`);
  if (Number(m.c30EpsUv || 0)) parts.push(`近30天曝光/访问 ${m.c30EpsUv}`);
  if (Number(m.totalSaleVolume || 0)) parts.push(`历史销量 ${m.totalSaleVolume}`);
  if (m.lastSaleDate) parts.push(`最近成交 ${String(m.lastSaleDate).slice(0, 10)}`);
  return parts.join('，') || `候选分 ${Number(source.score || 0).toFixed(0)}`;
}

function cleanHumanBlockerMessage(value) {
  return String(value || '')
    .replace(/Because\s+Power Supply\(147\)\s+selected\s+Power Adapter\(1007239\),?\s+Input voltage\(1002322\)\s+is required/ig, '供电方式选择了电源适配器，因此输入电压是必填项')
    .replace(/Hazardous materials classification\s*:\s*The template attribute under type is required/ig, '危险品分类：这是当前商品类型的必填属性')
    .replace(/Hazardous materials classification/ig, '危险品分类')
    .replace(/Input voltage\(1002322\)/ig, '输入电压')
    .replace(/Power Supply\(147\)/ig, '供电方式')
    .replace(/Power Adapter\(1007239\)/ig, '电源适配器')
    .replace(/The template attribute under type is required/ig, '这是当前商品类型的必填属性')
    .replace(/真实提交\s*payload hash\s*与\s*dry-run\s*锁定值不一致\s*[:：]?\s*expected=[a-f0-9]{64}\s+actual=[a-f0-9]{64}/ig, '提交前检测到发布资料与确认时的版本发生变化，已安全停止提交；系统需要重新检查，确认更新后的源链接和发布资料后再继续。')
    .replace(/\b[a-f0-9]{64}\b/ig, '[内部校验值已隐藏]')
    .replace(/dry-run|Dry-run|预检/g, '资料检查')
    .replace(/系统检查/g, '资料检查')
    .replace(/payload hash/g, '本次检查快照')
    .replace(/payload/g, '发布资料')
    .replace(/OpenAPI/g, '接口')
    .replace(/SHEIN publishOrEdit/g, 'SHEIN 创建/编辑接口')
    .replace(/真实提交必须显式输入确认文本\s*SHEIN_OPENAPI_SUBMIT。?/g, '我需要你在聊天里明确说“可以执行/提交吧/照做”。')
    .replace(/真实提交必须先完成一次\s*资料检查，并停在“等你确认”状态。?/g, '我需要先把资料查完整，确认没有硬性缺口后才能提交。')
    .replace(/真实提交前缺少已通过的\s*接口\s*商品资料检查证据。?/g, '商品资料还没检查通过。')
    .replace(/真实提交前缺少已通过的\s*OpenAPI\s*商品系统检查证据。?/g, '商品资料还没检查通过。')
    .replace(/([A-Z]{2,4})\s*商品发布\/编辑真实提交未被服务端总闸门放行；本次只能重新\s*资料检查。?/g, '$1 现在还没放开直接提交，我会先把资料查完整。')
    .replace(/([A-Z]{2,4})\s*未命中真实写试点白名单（人\+店\+动作），不能真实提交。?/g, '$1 这个账号/店铺/动作暂时不在可提交范围。')
    .replace(/([A-Z]{2,4})\s*缺少上一次\s*资料检查\s*锁定的\s*本次检查快照，不能真实提交。?/g, '$1 缺少刚才那次资料检查快照，需要先重新查一遍。')
    .replace(/缺少上一次\s*资料检查\s*锁定的发布资料 hash/g, '缺少刚才那次资料检查的快照')
    .replace(/；{2,}/g, '；')
    .replace(/。{2,}/g, '。')
    .trim();
}

function cleanHumanBlockerList(values) {
  const cleaned = uniqueMessages(asArray(values))
    .map(cleanHumanBlockerMessage)
    .map(x => String(x || '').replace(/[。；;,\s]+$/g, '').trim())
    .filter(Boolean);
  return uniqueMessages(cleaned);
}

function linkOpsHumanStatus(task) {
  const status = String(task?.status || '');
  const state = String(task?.execution?.state || task?.lifecycle?.lifecycleStatus || '');
  if (status === 'done') return '完成';
  if (status === 'submitted_but_readback_pending' || state === 'submitted') return '已提交，正在确认结果';
  if (status === 'needs_manual_resolve' || /readback_failed|suspicious/.test(state)) return '已提交，但需要人工确认结果';
  if (state === 'publish_pre_valid_failed') return 'SHEIN 预校验未通过，正在重新检查资料';
  if (state === 'openapi_product_preflight_ready' || state === 'link_maintenance_preflight_ready') return '资料已通过，等你一句话确认执行';
  if (state === 'blocked') return '卡住了，需要补充';
  if (status === 'waiting_review') return '等你确认执行';
  if (status === 'confirmed' || status === 'in_progress') return '正在处理';
  return '已收到';
}

function linkOpsPublishResultSucceeded(result = {}) {
  if (!result || typeof result !== 'object') return false;
  if (String(result.code ?? '') !== '0') return false;
  const info = result.info && typeof result.info === 'object' ? result.info : null;
  if (info && info.success === false) return false;
  return Boolean(info?.success === true || info?.spu_name || asArray(info?.skc_list).length || result.submitted === true);
}

function linkOpsPublishResultSummaryFromExecutors(execs = []) {
  const summary = {
    spuNames: [],
    skcNames: [],
    skuCodes: [],
    versions: [],
    taskNos: [],
    traceIds: [],
  };
  for (const executor of asArray(execs)) {
    const result = executor?.publishResult && typeof executor.publishResult === 'object' ? executor.publishResult : null;
    if (!result) continue;
    if (result.traceId) summary.traceIds.push(String(result.traceId));
    const info = result.info && typeof result.info === 'object' ? result.info : null;
    if (!info) continue;
    if (info.spu_name) summary.spuNames.push(String(info.spu_name));
    if (info.spuName) summary.spuNames.push(String(info.spuName));
    if (info.version) summary.versions.push(String(info.version));
    if (info.taskNo) summary.taskNos.push(String(info.taskNo));
    if (info.task_no) summary.taskNos.push(String(info.task_no));
    for (const skc of asArray(info.skc_list || info.skcList)) {
      if (skc?.skc_name) summary.skcNames.push(String(skc.skc_name));
      if (skc?.skcName) summary.skcNames.push(String(skc.skcName));
      for (const sku of asArray(skc?.sku_list || skc?.skuList)) {
        if (sku?.sku_code) summary.skuCodes.push(String(sku.sku_code));
        if (sku?.skuCode) summary.skuCodes.push(String(sku.skuCode));
      }
    }
  }
  const unique = values => [...new Set(values.map(x => String(x || '').trim()).filter(Boolean))];
  for (const key of Object.keys(summary)) summary[key] = unique(summary[key]);
  return summary;
}

function formatLinkOpsPublishResultSummary(summary = {}) {
  const parts = [];
  if (asArray(summary.spuNames).length) parts.push(`SPU：${summary.spuNames.slice(0, 3).join('、')}`);
  if (asArray(summary.skcNames).length) parts.push(`SKC：${summary.skcNames.slice(0, 5).join('、')}`);
  if (asArray(summary.skuCodes).length) parts.push(`SKU：${summary.skuCodes.slice(0, 5).join('、')}`);
  if (asArray(summary.versions).length) parts.push(`版本：${summary.versions.slice(0, 2).join('、')}`);
  if (!parts.length && asArray(summary.taskNos).length) parts.push(`平台任务号：${summary.taskNos.slice(0, 3).join('、')}`);
  if (asArray(summary.traceIds).length) parts.push(`traceId：${summary.traceIds.slice(0, 2).join('、')}`);
  return parts;
}

function buildChatExecutionAnswer(task, {userMessage = ''} = {}) {
  const execs = [
    ...asArray(task?.execution?.openApiProductExecutors),
    ...asArray(task?.execution?.linkMaintenanceExecutors || task?.execution?.linkMaintenancePrechecks),
  ];
  const intents = asArray(task?.intents).map(x => String(x || '').trim()).filter(Boolean);
  const hasProductPublishIntent = intents.includes('copy_product_draft');
  const maintenanceLabels = intents
    .filter(intent => LINK_MAINTENANCE_INTENTS.has(intent))
    .map(linkOpsIntentLabel);
  const maintenanceText = maintenanceLabels.length ? maintenanceLabels.join('、') : '维护动作';
  const lifecycleStatus = String(task?.lifecycle?.lifecycleStatus || task?.lifecycle?.status || '');
  const lifecycleReadbacks = asArray(task?.lifecycle?.readbacks);
  const readbackMatched = lifecycleStatus === 'submitted_readback_matched'
    || (lifecycleReadbacks.length > 0 && lifecycleReadbacks.every(row => row?.ok && /matched/i.test(String(row?.status || '')) && Number(row?.matchedCount || 0) > 0));
  const pre = task?.execution?.preflight || {};
  const preValidMessages = execs.flatMap(executionPreValidMessagesFromRun);
  const executorBlockers = execs.flatMap(x => asArray(x?.blockers));
  const rawBlockers = [
    ...asArray(pre.blockers),
    ...execs.flatMap(x => asArray(x?.payload?.validation?.blockers)),
    ...executorBlockers,
    ...preValidMessages,
  ].filter(value => !(preValidMessages.length && /publishOrEdit\s*平台预校验失败/i.test(String(value || ''))));
  const payloadDriftBlocked = rawBlockers.some(value => /payload hash\s*与\s*dry-run\s*锁定值不一致/i.test(String(value || '')));
  const blockers = cleanHumanBlockerList(rawBlockers);
  const submitted = Boolean(task?.execution?.actualWriteSubmitted || task?.execution?.writeAudit?.actualWriteSubmitted);
  const writeAttempted = Boolean(task?.execution?.sheinWriteAttempted || task?.execution?.writeAudit?.sheinWriteAttempted);
  const state = String(task?.execution?.state || task?.lifecycle?.lifecycleStatus || '');
  const needsManualResolve = Boolean(task?.lifecycle?.needsManualResolve || task?.execution?.lifecycle?.needsManualResolve || task?.execution?.writeAudit?.requiresManualResolve || task?.needsManualResolve);
  const readbackFailed = lifecycleStatus === 'submitted_readback_failed'
    || state === 'submitted_readback_failed'
    || needsManualResolve
    || String(task?.status || '') === 'needs_manual_resolve'
    || execs.some(x => x?.readback && x.readback.ok === false && /not_found|weak|failed/i.test(String(x.readback.status || '')));
  const publishSummary = linkOpsPublishResultSummaryFromExecutors(execs);
  const publishSummaryLines = formatLinkOpsPublishResultSummary(publishSummary);
  const publishPreValidFailed = !submitted && hasProductPublishIntent && (
    state === 'publish_pre_valid_failed'
    || execs.some(x => String(x?.state || '') === 'publish_pre_valid_failed')
    || execs.some(x => {
      const result = x?.publishResult && typeof x.publishResult === 'object' ? x.publishResult : null;
      const info = result?.info && typeof result.info === 'object' ? result.info : null;
      return result
        && String(result.code ?? '') === '0'
        && Boolean(info)
        && (info.success === false || asArray(info.pre_valid_result).length > 0);
    })
  );
  const status = linkOpsHumanStatus(task);
  const lines = [];
  lines.push(`收到，我按你这句“${compactChatLine(userMessage, 80)}”继续处理。`);
  lines.push(`当前状态：${status}。`);
  if (publishPreValidFailed) {
    const missing = blockers.length ? blockers.slice(0, 5).join('；') : '平台没有给出具体字段，我会继续按商品资料重新检查。';
    lines.push(`SHEIN 这次没有创建新链接，平台还要求补充：${missing}。`);
    lines.push('我会根据源链接资料和 SHEIN 官方模板自动重新整理并检查；在资料检查通过前不会再次提交。只有现有资料确实无法判断时，我才会明确告诉你缺哪一个业务值。');
  } else if (submitted) {
    if (readbackMatched) {
      lines.push(hasProductPublishIntent
        ? 'SHEIN 已返回提交成功，回读也已匹配到新链接，这件事已完成。'
        : `SHEIN 已返回提交成功，回读也已匹配到目标链接，${maintenanceText}已完成。`);
    } else if (intents.includes('certificate_review')) {
      lines.push('SHEIN 已返回提交成功；证书/资质类结果需要等平台审核或人工确认。我已把这次提交留在当前会话里跟进，不会重复提交。');
    } else if (readbackFailed) {
      if (publishSummaryLines.length) {
        lines.push([
          hasProductPublishIntent ? 'SHEIN 已返回创建成功，平台返回的新商品信息：' : `SHEIN 已返回提交成功，平台返回的 ${maintenanceText} 信息：`,
          ...publishSummaryLines.map(line => `- ${line}`),
        ].join('\n'));
      } else {
        lines.push(hasProductPublishIntent
          ? 'SHEIN 已返回创建成功，但平台没有在返回里给出完整的新链接编号。'
          : `SHEIN 已返回提交成功，但平台没有在返回里给出完整的 ${maintenanceText} 编号。`);
      }
      lines.push(hasProductPublishIntent
        ? '自动回读没有在商品列表/审核记录里强匹配到这条新链接，所以我已把任务锁住，等你在 SHEIN 后台人工确认或核销；我不会重复提交，避免重复铺货。'
        : `自动回读没有强匹配到目标链接状态，所以我已把任务锁住，等你人工确认或核销；我不会重复提交，避免重复执行 ${maintenanceText}。`);
    } else {
      lines.push(hasProductPublishIntent
        ? 'SHEIN 已返回提交成功，我正在核对新链接是否已经出现在商品列表或审核记录里。确认后会直接把新链接结果发在这里。'
        : `SHEIN 已返回提交成功，我正在回读目标链接状态，确认 ${maintenanceText} 是否已经生效。`);
    }
  } else if (writeAttempted) {
    lines.push('这次没有确认创建成功。我会先复查平台返回和商品列表；确认前不会重复提交，避免重复铺货。');
  } else if (payloadDriftBlocked) {
    lines.push('提交前检测到发布资料与确认时的版本发生变化，系统已安全停止；这次没有向 SHEIN 发出创建请求。');
    lines.push('你不需要猜字段或粘贴内部校验值。我会重新检查并把更新后的源链接和发布资料说清楚，确认后再继续。');
  } else if (blockers.length) {
    lines.push(`还差：${blockers.slice(0, 5).join('；')}。`);
    lines.push('你不用点别的按钮，直接在聊天里补缺的字段或说明怎么处理，我会接着往下做。');
  } else if (String(task?.execution?.state || '') === 'openapi_product_preflight_ready' || String(task?.execution?.state || '') === 'link_maintenance_preflight_ready') {
    lines.push('资料已经查完，可以提交。你如果要继续，就直接说“可以执行”或“提交吧”。');
  } else {
    lines.push('我已经把任务推进了一步；后续缺口和结果都会继续在这个会话里说清楚。');
  }
  return lines.join('\n\n');
}

async function executeChatNaturalLanguageTask({task, taskData, session, userMessage, actor, req, args}) {
  const current = normalizeLinkOpsTaskStore(taskData || {version: 1, updatedAt: null, tasks: []});
  if (taskRequiresOwnerLifecycleResolve(task)) {
    const deniedLifecycle = {
      ok: false,
      error: '该任务已进入提交后待回读/需人工处理状态，禁止重新检查或重复提交；请由全店管理账号人工核销为完成或归档。',
      taskId: task?.id || '',
      status: task?.status || '',
      lifecycleStatus: task?.lifecycle?.lifecycleStatus || task?.lifecycle?.status || '',
    };
    await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-chat-natural-execute-denied-lifecycle', actor, ...requestMeta(req), session: {id: session?.id || ''}, task: {id: task?.id || '', stores: taskTargetStores(task), writeStores: taskWriteStores(task)}, denied: deniedLifecycle});
    return {handled: true, task, taskData: current, answer: '这件事已经提交过，正在等平台结果或需要人工确认。为了避免重复创建/重复修改，我不会重新提交；请让全店管理账号先核销为完成或归档。'};
  }
  const denied = requireWriteStores(actor, taskWriteStores(task));
  if (denied) {
    await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-chat-natural-execute-denied', actor, ...requestMeta(req), session: {id: session?.id || ''}, task: {id: task.id, stores: taskTargetStores(task), writeStores: taskWriteStores(task)}, denied});
    return {handled: true, task, taskData: current, answer: `我不能替这个账号执行这件事：${denied.error || denied.reason || '没有目标店铺写权限'}。`};
  }
  const id = String(task.id || '').trim();
  if (id && linkOpsExecutionLocks.has(id)) {
    return {handled: true, task, taskData: current, answer: '这件事正在处理上一条指令。你不用刷新，也不用重复发；结果回来后会自动更新到这个会话里。'};
  }
  if (id) linkOpsExecutionLocks.add(id);
  try {
    const updated = await startControlledLinkOpsExecution(task, actor, req, args, {
      mode: 'execute',
      executionMode: 'execute',
      confirm: LINK_OPS_OPENAPI_SUBMIT_CONFIRM_TEXT,
      confirmText: LINK_OPS_OPENAPI_SUBMIT_CONFIRM_TEXT,
      source: 'chat_natural_language_execute',
    });
    const tasks = current.tasks.slice();
    const idx = tasks.findIndex(t => String(t.id || '') === String(updated.id || ''));
    if (idx >= 0) tasks[idx] = updated;
    else tasks.unshift(updated);
    const nextData = {version: 1, updatedAt: new Date().toISOString(), tasks: tasks.slice(0, 1000)};
    await writeLinkOpsTaskStore(args, nextData);
    await appendAudit(args.auditFile, {
      at: new Date().toISOString(),
      type: 'link-ops-chat-natural-execute',
      actor,
      ...requestMeta(req),
      session: {id: session?.id || ''},
      task: {
        id: updated.id,
        status: updated.status,
        state: updated.execution?.state || '',
        stores: taskTargetStores(updated),
        writeStores: taskWriteStores(updated),
      },
      naturalLanguageConfirm: compactChatLine(userMessage, 200),
      submitted: Boolean(updated.execution?.actualWriteSubmitted || updated.execution?.writeAudit?.actualWriteSubmitted),
    });
    return {handled: true, task: updated, taskData: nextData, answer: buildChatExecutionAnswer(updated, {userMessage})};
  } catch (err) {
    return {handled: true, task, taskData: current, answer: `我收到你的确认了，但执行没有跑完：${String(err?.message || err || 'unknown error')}。\n\n这件事没有被重复提交；你可以继续在聊天里补充或让我重试。`};
  } finally {
    if (id) linkOpsExecutionLocks.delete(id);
  }
}

async function runChatNaturalLanguageExecutionIfPossible({session, userMessage, taskData, actor, req, args}) {
  const current = normalizeLinkOpsTaskStore(taskData || {version: 1, updatedAt: null, tasks: []});
  const actorTasks = linkOpsTasksForActor(current.tasks, actor, {mode: 'mutate'});
  const activeTasks = activeChatTasks(actorTasks, session?.id);
  const eligibleTasks = eligibleChatNaturalExecutionTasks(actorTasks, session?.id);
  if (!activeTasks.length) {
    return {
      handled: true,
      task: null,
      taskData: current,
      answer: '我收到你这句话了，但这个会话里还没有明确要处理的事情。你直接说要做什么，比如“给 DL 的 505 缝纫机补一条链接，复制所有店里流量最高的那条”，我会先查源链接和缺口。',
    };
  }
  if (eligibleTasks.length !== 1) {
    if (eligibleTasks.length > 1) {
      const names = eligibleTasks.slice(0, 4).map(chatTaskDisplayName).join('；');
      await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-chat-natural-execute-ambiguous', actor, ...requestMeta(req), session: {id: session?.id || ''}, taskCount: eligibleTasks.length, tasks: eligibleTasks.slice(0, 10).map(t => ({id: t.id, name: chatTaskDisplayName(t), status: t.status, state: t.execution?.state || ''}))});
      return {handled: true, task: eligibleTasks[0], taskData: current, answer: `这个会话里有 ${eligibleTasks.length} 件事都已经查完，我不能猜你要执行哪一个。你直接说清楚要继续哪件事，或者新开一个会话，例如“继续 ${names.split('；')[0] || '第一件'}”。`};
    }
    if (activeTasks.length === 1) {
      const task = activeTasks[0];
      const eligibility = chatNaturalExecutionEligibility(task);
      await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-chat-natural-execute-needs-check', actor, ...requestMeta(req), session: {id: session?.id || ''}, task: {id: task.id, status: task.status, state: task.execution?.state || '', reasons: eligibility.reasons}});
      const checked = await runImmediateChatSystemCheckIfPossible({task, taskData: current, actor, req, args, updated: true});
      if (checked.task && chatNaturalExecutionEligibility(checked.task).ok) {
        await appendAudit(args.auditFile, {
          at: new Date().toISOString(),
          type: 'link-ops-chat-natural-execute-after-refresh',
          actor,
          ...requestMeta(req),
          session: {id: session?.id || ''},
          task: {id: checked.task.id, status: checked.task.status, state: checked.task.execution?.state || ''},
          naturalLanguageConfirm: compactChatLine(userMessage, 200),
        });
        return await executeChatNaturalLanguageTask({task: checked.task, taskData: checked.taskData, session, userMessage, actor, req, args});
      }
      if (checked.answer) return {handled: true, task: checked.task, taskData: checked.taskData, answer: checked.answer};
      const reason = eligibility.reasons.length ? eligibility.reasons.join('；') : '还没形成唯一可提交任务';
      return {handled: true, task, taskData: current, answer: `我先不提交：${reason}。你不用点按钮，继续在聊天里补字段或说清楚要处理哪一条，我会先把资料查完整。`};
    }
    const names = activeTasks.slice(0, 5).map(chatTaskDisplayName).join('；');
    await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-chat-natural-execute-no-eligible', actor, ...requestMeta(req), session: {id: session?.id || ''}, taskCount: activeTasks.length, tasks: activeTasks.slice(0, 10).map(t => ({id: t.id, name: chatTaskDisplayName(t), status: t.status, state: t.execution?.state || '', reasons: chatNaturalExecutionEligibility(t).reasons}))});
    return {handled: true, task: activeTasks[0], taskData: current, answer: `我先不提交：这个会话里有 ${activeTasks.length} 件未完成事项，但没有唯一一件处于“资料已查完、等你一句话执行”的状态。你可以直接说要继续哪一个，例如：${names || '指定店铺和货号'}。`};
  }
  let task = eligibleTasks[0];
  const previousKnowledgeFingerprint = String(task?.ownerKnowledgePolicy?.fingerprint || '');
  const knowledgeBinding = await bindOwnerKnowledgeToTask(task, args, userMessage);
  if (knowledgeBinding.changed) {
    task = knowledgeBinding.task;
    const reboundStore = replaceLinkOpsTaskInStore(current, task);
    await writeLinkOpsTaskStore(args, reboundStore);
    const checked = await runImmediateChatSystemCheckIfPossible({task, taskData: reboundStore, actor, req, args, updated: true});
    if (previousKnowledgeFingerprint && previousKnowledgeFingerprint !== knowledgeBinding.bundle?.fingerprint) {
      return {
        handled: true,
        task: checked.task,
        taskData: checked.taskData,
        answer: `${checked.answer || '我已按负责人最新规则重新检查。'}\n\n负责人长期规则刚刚有更新；为避免沿用旧预演直接提交，请你再说一次“可以执行”。`,
      };
    }
    task = checked.task || task;
    if (!chatNaturalExecutionEligibility(task).ok) {
      return {handled: true, task, taskData: checked.taskData, answer: checked.answer || '我已按负责人规则重新检查，目前还不能提交。'};
    }
    return await executeChatNaturalLanguageTask({task, taskData: checked.taskData, session, userMessage, actor, req, args});
  }
  return await executeChatNaturalLanguageTask({task, taskData: current, session, userMessage, actor, req, args});
}

function buildChatSystemCheckAnswer(task, {updated = false} = {}) {
  const productExecs = asArray(task?.execution?.openApiProductExecutors);
  const maintenanceExecs = asArray(task?.execution?.linkMaintenanceExecutors || task?.execution?.linkMaintenancePrechecks);
  const execs = [...productExecs, ...maintenanceExecs];
  const first = productExecs[0] || {};
  const source = first?.payload?.inferredSource || task?.execution?.hlOpenApiExecutor?.payload?.inferredSource || null;
  const targetStores = normalizeConcreteStoreKeys(taskWriteStores(task));
  const refs = normalizeLinkOpsTargetSet(task?.targets || {}).productRefs;
  const intents = asArray(task?.intents).map(x => String(x || '').trim()).filter(Boolean);
  const maintenanceIntents = intents.filter(intent => LINK_MAINTENANCE_INTENTS.has(intent));
  const maintenanceOperations = uniqueMessages(maintenanceExecs.flatMap(exec => asArray(exec?.payload?.summary?.operations)))
    .filter(Boolean);
  const maintenanceMatchedLinks = maintenanceExecs.flatMap(exec => asArray(exec?.adapterEvidence?.matchedLinks));
  const blockers = cleanHumanBlockerList([
    ...asArray(task?.execution?.preflight?.blockers),
    ...execs.flatMap(x => asArray(x?.payload?.validation?.blockers)),
    ...execs.flatMap(x => asArray(x?.blockers)),
    ...execs.flatMap(executionPreValidMessagesFromRun),
  ]);
  const warnings = cleanHumanBlockerList([
    ...asArray(task?.execution?.preflight?.warnings),
    ...execs.flatMap(x => asArray(x?.payload?.validation?.warnings)),
    ...execs.flatMap(x => asArray(x?.warnings)),
  ]);
  const state = String(task?.execution?.state || '');
  const ready = ['openapi_product_preflight_ready', 'link_maintenance_preflight_ready'].includes(state)
    && task?.execution?.preflight?.ok === true;
  const hasCopyProduct = intents.includes('copy_product_draft');
  const lines = [];
  lines.push(updated ? '我已按你刚补充的信息重新检查了一遍。' : '收到，我先替你查了资料和执行缺口。');
  if (targetStores.length || refs.length) {
    lines.push(`目标：${targetStores.length ? targetStores.join('/') + ' 店' : '未锁定店铺'}${refs.length ? ` · ${refs.join(' / ')}` : ''}`);
  }
  if (hasCopyProduct) {
    if (source?.sourceStore && source?.sourceSkc) {
      const product = source.standardGoodsSn || source.metrics?.rawGoodsSn || '';
      lines.push(`我选中的源链接：${source.sourceStore} 店 · ${source.sourceSkc}${product ? ` · ${product}` : ''}。`);
      lines.push(`选择依据：这是当前候选里综合流量/销量最高的一条；${humanSourceMetricLine(source)}。`);
    } else {
      lines.push('我还没有选定可复制的源链接：当前数据里没找到足够明确的同货号在售 SKC。');
    }
  }
  if (maintenanceIntents.length) {
    const opNames = (maintenanceOperations.length ? maintenanceOperations : maintenanceIntents)
      .map(linkOpsIntentLabel)
      .filter(Boolean);
    lines.push(`我要执行的维护动作：${opNames.join('、')}。`);
    if (maintenanceMatchedLinks.length) {
      const sample = maintenanceMatchedLinks.slice(0, 4).map(row => [
        row.storeKey || row.store || '',
        row.skc || row.skcName || '',
        row.standardGoodsSn || row.standard_goods_sn || '',
        row.shelfStatusName || row.shelf_status_name || '',
      ].filter(Boolean).join(' · ')).filter(Boolean);
      lines.push(`已定位到 ${maintenanceMatchedLinks.length} 条目标链接${sample.length ? `：${sample.join('；')}` : ''}。`);
    }
  }
  if (blockers.length) {
    lines.push(`还差：${blockers.slice(0, 5).join('；')}。`);
    lines.push('能从源链接和 SHEIN 官方模板确定的字段我会自动补齐；只有确实需要业务判断的值，你再直接在聊天里说明，我收到后会自动重新检查。');
  } else if (ready) {
    lines.push('目前资料已经够了，资料检查通过。');
    if (warnings.length) lines.push(`提交前需要你注意：${warnings.slice(0, 4).join('；')}。`);
    lines.push(hasCopyProduct
      ? '如果要创建这条新链接，你直接在聊天里说“可以执行”“提交吧”或“照做”，我会提交到 SHEIN，并把结果回读给你。'
      : '如果要执行这次维护，你直接在聊天里说“可以执行”“提交吧”或“照做”，我会提交到 SHEIN，并把结果回读给你。');
  } else if (warnings.length) {
    lines.push(`提醒：${warnings.slice(0, 4).join('；')}。`);
    lines.push('没有硬阻断；如果你认可这些默认值，直接在聊天里说“可以执行”或“提交吧”。');
  } else {
    lines.push('我已经开始处理，会继续在这个会话里跟进。');
  }
  return lines.join('\n\n');
}

async function runImmediateChatSystemCheckIfPossible({task, taskData, actor, req, args, updated = false}) {
  if (!task || !shouldRunImmediateChatSystemCheck(task)) {
    return {task, taskData, answer: ''};
  }
  if (taskRequiresOwnerLifecycleResolve(task)) {
    await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-chat-immediate-system-check-denied-lifecycle', actor, ...requestMeta(req), task: {id: task?.id || '', status: task?.status || '', lifecycleStatus: task?.lifecycle?.lifecycleStatus || task?.lifecycle?.status || '', stores: taskTargetStores(task), writeStores: taskWriteStores(task)}});
    return {
      task,
      taskData,
      answer: '这件事已经提交过，正在等平台结果或需要人工确认。为了避免重复创建/重复修改，我不会重新检查或重新提交；请让全店管理账号先核销为完成或归档。',
    };
  }
  const lockId = String(task.id || '').trim();
  if (lockId && linkOpsExecutionLocks.has(lockId)) {
    return {
      task,
      taskData,
      answer: '我已收到，这件事正在处理上一条指令。等结果回来后会自动更新到这个会话里，你不用刷新页面或重复点击。',
    };
  }
  if (lockId) linkOpsExecutionLocks.add(lockId);
  try {
    const checked = await startControlledLinkOpsExecution(task, actor, req, args, {
      mode: 'dry-run',
      executionMode: 'dry-run',
      source: 'chat_immediate_system_check',
    });
    const current = normalizeLinkOpsTaskStore(taskData || {tasks: []});
    const tasks = current.tasks.length ? current.tasks.slice() : [checked];
    const idx = tasks.findIndex(t => String(t.id || '') === String(checked.id || ''));
    if (idx >= 0) tasks[idx] = checked;
    else tasks.unshift(checked);
    const nextData = {version: 1, updatedAt: new Date().toISOString(), tasks: tasks.slice(0, 1000)};
    await writeLinkOpsTaskStore(args, nextData);
    await appendAudit(args.auditFile, {
      at: new Date().toISOString(),
      type: 'link-ops-chat-immediate-system-check',
      actor,
      ...requestMeta(req),
      task: {
        id: checked.id,
        status: checked.status,
        state: checked.execution?.state || '',
        stores: taskTargetStores(checked),
        writeStores: taskWriteStores(checked),
      },
    });
    return {task: checked, taskData: nextData, answer: buildChatSystemCheckAnswer(checked, {updated})};
  } catch (err) {
    const answer = `我已收到，但刚才自动检查没有跑完：${String(err?.message || err || 'unknown error')}。\n\n你不用重新说需求，稍后我会继续按当前会话处理。`;
    return {task, taskData, answer};
  } finally {
    if (lockId) linkOpsExecutionLocks.delete(lockId);
  }
}


function compactLinkOpsRef(value) {
  return String(value || '').toLowerCase().replace(/[\s_\-（）()【】\[\]，,。.;；:：/\\]+/g, '');
}

function linkOpsRowStore(row) {
  return String(row?.store_key || row?.storeKey || '').trim().toUpperCase();
}

function linkOpsRowSkc(row) {
  return String(row?.skc || row?.skcCode || row?.skc_code || '').trim();
}

function linkOpsRowStandard(row) {
  return String(row?.standard_goods_sn || row?.standardGoodsSn || row?.product_display_name || row?.productDisplayName || row?.raw_goods_sn || row?.rawGoodsSn || '').trim();
}

function linkOpsRowIsOnShelf(row) {
  if (row?.is_on_shelf !== undefined) return Boolean(row.is_on_shelf);
  if (row?.isOnShelf !== undefined) return Boolean(row.isOnShelf);
  const name = String(row?.shelf_status_name || row?.shelfStatusName || '').trim();
  return /已上架|在售|上架中|on/i.test(name) && !/已下架|待上架|售罄/.test(name);
}

function linkOpsRowStatusName(row) {
  return String(row?.shelf_status_name || row?.shelfStatusName || (linkOpsRowIsOnShelf(row) ? '已上架' : '未知')).trim() || '未知';
}

function linkOpsRowSalesScore(row) {
  return Number(row?.c30_sale_cnt || row?.c30SaleCnt || 0) * 1000
    + Number(row?.c7_sale_cnt || row?.c7SaleCnt || 0) * 1200
    + Number(row?.sale_cnt || row?.saleCnt || 0) * 100
    + Number(row?.goods_uv || row?.goodsUv || 0);
}

function linkOpsRowMatchesRef(row, ref) {
  const raw = String(ref || '').trim();
  if (!raw) return false;
  const skc = linkOpsRowSkc(row);
  if (skc && skc.toLowerCase() === raw.toLowerCase()) return true;
  const q = compactLinkOpsRef(raw);
  if (!q) return false;
  const fields = [
    skc,
    linkOpsRowStandard(row),
    row?.product_display_name,
    row?.productDisplayName,
    row?.raw_goods_sn,
    row?.rawGoodsSn,
    row?.product_name_cn,
    row?.productNameCn,
    row?.goods_sn,
    row?.goodsSn,
  ].map(compactLinkOpsRef).filter(Boolean);
  return fields.some(value => value === q || value.includes(q) || q.includes(value));
}

function extractLinkOpsStoreLinkRows(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  if (Array.isArray(data?.storeLinks)) return data.storeLinks;
  if (Array.isArray(data?.links)) return data.links;
  return [];
}

async function loadLinkOpsStoreLinks(args) {
  const root = args.dir || path.join(ROOT, 'outputs', 'bi-portal');
  const candidates = [
    path.join(root, 'data.json'),
    path.join(root, 'sections', 'linksData.json'),
  ];
  const errors = [];
  for (const file of candidates) {
    try {
      const data = await readJsonFile(file, {});
      const rows = extractLinkOpsStoreLinkRows(data);
      if (rows.length) return {file, rows, source: path.relative(ROOT, file).replace(/\\/g, '/')};
      errors.push(`${path.relative(ROOT, file).replace(/\\/g, '/')}:0 rows`);
    } catch (err) {
      errors.push(`${path.relative(ROOT, file).replace(/\\/g, '/')}:${err?.message || String(err)}`);
    }
  }
  return {file: candidates.at(-1), rows: [], error: errors.join('；') || 'no link source'};
}

function summarizeMaintenanceLink(row) {
  return {
    storeKey: linkOpsRowStore(row),
    skc: linkOpsRowSkc(row),
    standardGoodsSn: linkOpsRowStandard(row),
    shelfStatusName: linkOpsRowStatusName(row),
    isOnShelf: linkOpsRowIsOnShelf(row),
    sameProductOnShelfCount: Number(row?.same_product_on_shelf_count ?? row?.sameProductOnShelfCount ?? 0),
    c7SaleCnt: Number(row?.c7_sale_cnt ?? row?.c7SaleCnt ?? 0),
    c30SaleCnt: Number(row?.c30_sale_cnt ?? row?.c30SaleCnt ?? 0),
    goodsUv: Number(row?.goods_uv ?? row?.goodsUv ?? 0),
    retireCandidate: Boolean(row?.retire_candidate ?? row?.retireCandidate),
  };
}

function hasTitleMaintenanceMaterial(task) {
  const assets = Array.isArray(task?.assets) ? task.assets : [];
  if (assets.some(a => a?.kind === 'text' || String(a?.mime || '').startsWith('text/') || String(a?.mime || '') === 'application/json')) return true;
  const text = String(task?.command || '');
  return /(?:标题|title).{0,16}(?:改成|改为|换成|更新为|改到|=>|：|:)/i.test(text);
}

function hasImageMaintenanceMaterial(task) {
  const assets = Array.isArray(task?.assets) ? task.assets : [];
  return assets.some(a => a?.kind === 'image' || String(a?.mime || '').startsWith('image/'));
}

function groupMaintenanceRowsByStoreAndStandard(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${linkOpsRowStore(row)}|${compactLinkOpsRef(linkOpsRowStandard(row))}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

async function runLinkMaintenancePrechecks(task, args, body = {}) {
  const intents = Array.isArray(task?.intents) ? task.intents : [];
  const maintenanceIntents = intents.filter(intent => LINK_MAINTENANCE_INTENTS.has(intent));
  if (!maintenanceIntents.length) return [];
  const targets = normalizeLinkOpsTargetSet(task?.targets || {});
  const stores = normalizeConcreteStoreKeys(taskWriteStores(task));
  const productRefs = targets.productRefs;
  const actorForGate = body.actorForWriteGate || null;
  const denied = actorForGate ? requireWriteStores(actorForGate, taskWriteStores(task)) : null;
  const now = new Date().toISOString();
  const runId = `lmp_${now.replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto.randomBytes(4).toString('hex')}`;
  const blockers = [];
  const warnings = [];
  if (denied) blockers.push(`维护系统检查启动前权限复核失败：${denied.error}`);
  if (!stores.length) blockers.push('维护动作必须明确目标店铺。');
  if (!productRefs.length) blockers.push('维护动作必须明确目标货号或 SKC。');
  const {file, rows, error} = await loadLinkOpsStoreLinks(args);
  if (error) blockers.push(`无法读取 BI 链接快照：${error}`);
  if (!rows.length) blockers.push('BI 链接快照为空，无法定位目标链接。');
  const relevantRows = rows.filter(row => stores.includes(linkOpsRowStore(row)));
  const allGroups = groupMaintenanceRowsByStoreAndStandard(relevantRows);
  const matches = [];
  const missingTargets = [];
  for (const store of stores) {
    for (const ref of productRefs) {
      const candidates = relevantRows
        .filter(row => linkOpsRowStore(row) === store && linkOpsRowMatchesRef(row, ref))
        .sort((a, b) => Number(linkOpsRowIsOnShelf(b)) - Number(linkOpsRowIsOnShelf(a)) || linkOpsRowSalesScore(b) - linkOpsRowSalesScore(a))
        .slice(0, 20);
      if (!candidates.length) {
        missingTargets.push({storeKey: store, ref});
        continue;
      }
      matches.push(...candidates.map(row => ({ref, row})));
    }
  }
  if (missingTargets.length) {
    blockers.push(`未在最新 BI 链接快照中定位到：${missingTargets.map(x => `${x.storeKey}/${x.ref}`).join('、')}。`);
  }
  const uniqueMatches = [];
  const seen = new Set();
  for (const item of matches) {
    const row = item.row;
    const key = `${linkOpsRowStore(row)}|${linkOpsRowSkc(row)}|${compactLinkOpsRef(linkOpsRowStandard(row))}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueMatches.push(item);
  }
  if (maintenanceIntents.includes('retire_link') && uniqueMatches.length) {
    const matchedActiveByGroup = new Map();
    for (const item of uniqueMatches) {
      if (!linkOpsRowIsOnShelf(item.row)) continue;
      const key = `${linkOpsRowStore(item.row)}|${compactLinkOpsRef(linkOpsRowStandard(item.row))}`;
      matchedActiveByGroup.set(key, (matchedActiveByGroup.get(key) || 0) + 1);
    }
    for (const [key, matchedActiveCount] of matchedActiveByGroup.entries()) {
      const groupRows = allGroups.get(key) || [];
      const activeBefore = groupRows.filter(linkOpsRowIsOnShelf).length;
      const activeAfter = activeBefore - matchedActiveCount;
      if (activeBefore > 0 && activeAfter <= 0) {
        const sample = groupRows.find(linkOpsRowIsOnShelf) || groupRows[0] || {};
        blockers.push(`${linkOpsRowStore(sample)} / ${linkOpsRowStandard(sample) || linkOpsRowSkc(sample)} 下架后将没有已上架承接链接；必须先确认替代链接或改为补链任务。`);
      }
    }
  }
  if (maintenanceIntents.includes('activate_link') && uniqueMatches.length) {
    const inactiveMatches = uniqueMatches.filter(item => !linkOpsRowIsOnShelf(item.row));
    if (!inactiveMatches.length) {
      warnings.push('恢复上架任务匹配到的链接当前都已是已上架状态；执行器会阻断无目标 payload，避免重复提交。');
    }
  }
  if (maintenanceIntents.includes('update_title') && !hasTitleMaintenanceMaterial(task)) {
    blockers.push('换标题任务缺少新标题或标题规则：请在指令中写明“标题改成…”或上传文本/JSON 素材。');
  }
  if (maintenanceIntents.includes('update_images') && !hasImageMaintenanceMaterial(task)) {
    blockers.push('换图任务缺少图片素材：请先上传图片后再系统检查。');
  }
  blockers.push('旧链接维护本地系统检查已被 OpenAPI 维护执行器替代；请通过受控执行器生成 payload hash 后再进入真实提交门禁。');
  const matchedLinks = uniqueMatches.map(item => ({
    ref: item.ref,
    ...summarizeMaintenanceLink(item.row),
  }));
  const readbackFingerprint = {
    taskId: task?.id || '',
    intents: maintenanceIntents,
    targetStores: stores,
    productRefs,
    matchedSkcs: matchedLinks.map(x => x.skc).filter(Boolean).slice(0, 80),
    matchedStandards: [...new Set(matchedLinks.map(x => x.standardGoodsSn).filter(Boolean))].slice(0, 80),
    snapshotFile: path.relative(ROOT, file).replace(/\\/g, '/'),
    readbackStatus: 'dry_run_only_no_real_submit',
    readbackHint: '后续接入官方维护写接口后，必须用 targetStore + skc + standardGoodsSn 回读商品列表状态/标题/图片版本。',
  };
  const state = blockers.length ? 'blocked' : 'link_maintenance_preflight_ready';
  const result = {
    ok: blockers.length === 0,
    runId,
    mode: 'dry-run',
    adapterKind: 'link_maintenance_precheck',
    state,
    startedAt: now,
    endedAt: new Date().toISOString(),
    storeKey: stores.join(','),
    task: {
      id: task?.id || '',
      status: task?.status || '',
      stores,
      productRefs,
      intents,
    },
    adapterEvidence: {
      realSubmit: false,
      canSilentWrite: false,
      matchedLinksCount: matchedLinks.length,
      missingTargets,
      matchedLinks: matchedLinks.slice(0, 80),
      snapshotFile: path.relative(ROOT, file).replace(/\\/g, '/'),
      maintenanceIntents,
      submitBoundary: '旧本地系统检查不负责真实提交；维护写动作必须走 OpenAPI 维护执行器、payload hash、白名单和回读门禁。',
    },
    readbackFingerprint,
    blockers,
    warnings,
    safety: {
      canSilentWrite: false,
      realSubmit: false,
      executeSupported: false,
      note: '旧本地系统检查仅保留兼容；维护写真实提交必须走 OpenAPI 维护执行器、确认文本、白名单和回读。',
    },
  };
  return [{
    ok: result.ok,
    mode: 'dry-run',
    storeKey: stores.join(','),
    code: null,
    timedOut: false,
    result,
    stderrTail: '',
  }];
}

function uniqueMessages(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const s = String(value || '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function buildLinkOpsExecutionWriteAudit({task, actor, req, runId, at, requestedMode, finalState, submitted, executorRuns = [], blockers = [], warnings = [], confirmTextPresent = false, executeAllowed = false, lifecycleTransition = null, realSubmitWhitelistChecks = []}) {
  const issuedExecuteToExecutor = executorRuns.some(executorRun => String(executorRun?.mode || '') === 'execute');
  const sheinWriteAttempted = executorRuns.some(executorRun => Boolean(executorRun?.result?.publishResult));
  const suspiciousWriteAttempted = executorRuns.some(executorRun => Boolean(executorRun?.result?.suspiciousWriteAttempted) || String(executorRun?.result?.state || '') === 'suspicious_write_attempted');
  const lifecycleLocked = Boolean(lifecycleTransition?.locked);
  const requiresManualResolve = Boolean(lifecycleTransition?.needsManualResolve || suspiciousWriteAttempted);
  return {
    version: 1,
    at,
    runId,
    taskId: String(task?.id || ''),
    actor: actorAuditContext(actor, req),
    requestMeta: requestMeta(req),
    targetStores: taskTargetStores(task),
    sourceStores: taskSourceStores(task),
    writeStores: taskWriteStores(task),
    productRefs: normalizeLinkOpsTargetSet(task?.targets || {}).productRefs,
    intents: Array.isArray(task?.intents) ? task.intents : [],
    requestedMode,
    requestedRealSubmit: requestedMode === 'execute',
    finalState,
    lifecycleTransition,
    submitted: Boolean(submitted),
    actualWriteSubmitted: Boolean(submitted),
    confirmTextPresent: Boolean(confirmTextPresent),
    executeAllowed: Boolean(executeAllowed),
    realSubmitWhitelistChecks,
    issuedExecuteToExecutor,
    sheinWriteAttempted,
    suspiciousWriteAttempted,
    submittedPossibly: Boolean(suspiciousWriteAttempted),
    lifecycleLocked,
    requiresManualResolve,
    blocked: Boolean(blockers.length || lifecycleLocked || requiresManualResolve),
    blockerCount: blockers.length,
    warningCount: warnings.length,
    canAutoSubmit: false,
    canSilentWrite: false,
    executorEvidence: executorRuns.map((executorRun, index) => {
      const result = executorRun?.result || {};
      return {
        storeKey: result.storeKey || executorRun?.storeKey || '',
        mode: executorRun?.mode || '',
        state: result.state || '',
        ok: Boolean(result.ok),
        childRunId: result.runId || '',
        savedTo: result.savedTo || '',
        adapterKind: result.adapterKind || '',
        payloadFound: Boolean(result.payload?.found),
        payloadHash: result.payload?.payloadHash || '',
        payloadHashAlgorithm: result.payload?.payloadHashAlgorithm || '',
        payloadSummary: result.payload?.summary || null,
        approvedImageOrderLocked: Boolean(result.evidence?.approvedImageOrderLocked),
        adapterEvidence: result.adapterEvidence || null,
        readbackFingerprint: result.readbackFingerprint || null,
        suspiciousWriteAttempted: Boolean(result.suspiciousWriteAttempted) || String(result.state || '') === 'suspicious_write_attempted',
        submittedPossibly: Boolean(result.submittedPossibly || result.suspiciousWriteAttempted),
        readback: result.readback ? {
          ok: Boolean(result.readback.ok),
          status: result.readback.status || '',
          scannedRows: result.readback.scannedRows ?? null,
          matchedCount: Array.isArray(result.readback.matchedRows) ? result.readback.matchedRows.length : 0,
          weakMatchedCount: Array.isArray(result.readback.weakMatchedRows) ? result.readback.weakMatchedRows.length : 0,
          calls: Array.isArray(result.readback.calls) ? result.readback.calls.map(call => ({
            name: call?.name || '',
            path: call?.path || '',
            method: call?.method || '',
            httpStatus: call?.httpStatus ?? null,
            code: call?.code ?? null,
            msg: call?.msg ?? null,
            traceId: call?.traceId ?? null,
          })).slice(0, 10) : [],
        } : null,
        publishResult: result.publishResult ? {
          httpStatus: result.publishResult.httpStatus,
          code: result.publishResult.code,
          msg: result.publishResult.msg,
          traceId: result.publishResult.traceId,
          hasInfo: result.publishResult.info !== undefined && result.publishResult.info !== null,
        } : null,
        openapiCalls: Array.isArray(result.openapi?.calls)
          ? result.openapi.calls.map(call => ({
            name: call?.name || '',
            path: call?.path || '',
            method: call?.method || '',
            httpStatus: call?.httpStatus ?? null,
            code: call?.code ?? null,
            msg: call?.msg ?? null,
            traceId: call?.traceId ?? null,
          })).slice(0, 20)
          : [],
        executorContextPresent: Boolean(result.executorContext),
        index,
      };
    }),
  };
}

function executorReadbackOutcomes(executorResults = []) {
  return executorResults
    .filter(result => result?.state === 'submitted' || result?.publishResult?.code === '0')
    .map(result => ({
      storeKey: String(result?.storeKey || ''),
      childRunId: String(result?.runId || ''),
      publishCode: result?.publishResult?.code ?? null,
      publishTraceId: result?.publishResult?.traceId || '',
      ok: Boolean(result?.readback?.ok),
      status: String(result?.readback?.status || ''),
      matchedCount: Array.isArray(result?.readback?.matchedRows) ? result.readback.matchedRows.length : 0,
      weakMatchedCount: Array.isArray(result?.readback?.weakMatchedRows) ? result.readback.weakMatchedRows.length : 0,
    }));
}

function classifyLinkOpsLifecycle({
  task,
  requestedMode,
  executorState,
  submitted,
  suspiciousWriteAttempted = false,
  ok,
  executorResults = [],
  originalStatus = '',
}) {
  const readbacks = executorReadbackOutcomes(executorResults);
  if (suspiciousWriteAttempted) {
    return {
      version: 1,
      fromStatus: originalStatus,
      toStatus: 'needs_manual_resolve',
      status: 'suspicious_write_attempted',
      lifecycleStatus: 'suspicious_write_attempted',
      terminal: false,
      locked: true,
      needsManualResolve: true,
      requestedMode,
      executorState,
      submitted: false,
      submittedPossibly: true,
      readbacks,
      note: 'SHEIN 真实写执行器在提交模式下异常中断或超时，无法确认 SHEIN 是否已接收写请求；任务已锁定，禁止重复提交，需全店管理账号人工核销。',
    };
  }
  if (executorState === 'publish_pre_valid_failed') {
    return {
      version: 1,
      fromStatus: originalStatus,
      toStatus: 'waiting_review',
      status: 'publish_pre_valid_failed',
      lifecycleStatus: 'publish_pre_valid_failed',
      terminal: false,
      locked: false,
      needsManualResolve: false,
      requestedMode,
      executorState,
      submitted: false,
      submittedPossibly: false,
      readbacks,
      note: 'SHEIN publishOrEdit 已返回平台预校验失败，平台未创建成功新链接；请修复发布资料字段后重新检查/提交。',
    };
  }
  if (submitted) {
    const allMatched = readbacks.length > 0
      && readbacks.every(row => row.ok && /matched/i.test(row.status || '') && row.matchedCount > 0);
    const pending = readbacks.length === 0
      || readbacks.some(row => !row.status || /pending|planned|running/i.test(row.status || ''));
    if (allMatched) {
      return {
        version: 1,
        fromStatus: originalStatus,
        toStatus: 'done',
        status: 'submitted_readback_matched',
        lifecycleStatus: 'submitted_readback_matched',
        terminal: true,
        locked: false,
        needsManualResolve: false,
        requestedMode,
        executorState,
        submitted: true,
        readbacks,
        note: 'SHEIN 写接口已返回成功，且商品列表回读已匹配到目标链接/商品。',
      };
    }
    if (pending) {
      return {
        version: 1,
        fromStatus: originalStatus,
        toStatus: 'submitted_but_readback_pending',
        status: 'submitted_but_readback_pending',
        lifecycleStatus: 'submitted_but_readback_pending',
        terminal: false,
        locked: true,
        needsManualResolve: false,
        requestedMode,
        executorState,
        submitted: true,
        readbacks,
        note: 'SHEIN 写接口已返回成功，但还没有完成可靠回读；任务保持锁定，禁止重复提交。',
      };
    }
    return {
      version: 1,
      fromStatus: originalStatus,
      toStatus: 'needs_manual_resolve',
      status: 'submitted_readback_failed',
      lifecycleStatus: 'submitted_readback_failed',
      terminal: false,
      locked: true,
      needsManualResolve: true,
      requestedMode,
      executorState,
      submitted: true,
      readbacks,
      note: 'SHEIN 写接口已返回成功，但回读未匹配或失败；不能重试提交，需全店管理账号人工核销。',
    };
  }
  return {
    version: 1,
    fromStatus: originalStatus,
    toStatus: requestedMode === 'execute' && !ok ? 'waiting_review' : '',
    status: requestedMode === 'execute' && !ok ? 'execute_blocked_no_write_attempted' : (ok ? executorState : 'preflight_blocked'),
    lifecycleStatus: requestedMode === 'execute' && !ok ? 'execute_blocked_no_write_attempted' : (ok ? executorState : 'preflight_blocked'),
    terminal: false,
    locked: false,
    needsManualResolve: false,
    requestedMode,
    executorState,
    submitted: false,
    readbacks,
    note: requestedMode === 'execute'
      ? '本次没有完成 SHEIN 真实写提交；保留在等你确认/系统检查状态，需先解决阻断后重新 系统检查。'
      : '本次为 系统检查/系统检查，没有调用 SHEIN 真实写接口。',
  };
}

function parseChildJsonOutput(stdout = '') {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }
  return null;
}

function payloadHashForStoreFromTaskExecution(task, storeKey = '') {
  const target = String(storeKey || '').trim().toUpperCase();
  const runs = Array.isArray(task?.execution?.openApiProductExecutors)
    ? task.execution.openApiProductExecutors
    : [];
  const match = runs.find(run => String(run?.storeKey || '').trim().toUpperCase() === target)
    || (runs.length === 1 ? runs[0] : null);
  const hash = String(match?.payload?.payloadHash || '').trim();
  return hash || '';
}

function payloadHashForMaintenanceFromTaskExecution(task, storeKey = '', operation = '') {
  const target = String(storeKey || '').trim().toUpperCase();
  const op = String(operation || '').trim().toLowerCase();
  const runs = Array.isArray(task?.execution?.linkMaintenanceExecutors)
    ? task.execution.linkMaintenanceExecutors
    : [];
  const match = runs.find(run => {
    const storeMatches = String(run?.storeKey || '').trim().toUpperCase() === target
      || String(run?.storeKey || '').split(',').map(x => x.trim().toUpperCase()).includes(target);
    const operations = Array.isArray(run?.payload?.summary?.operations) ? run.payload.summary.operations.map(x => String(x).toLowerCase()) : [];
    return storeMatches && (!op || operations.includes(op));
  }) || (runs.length === 1 ? runs[0] : null);
  const hash = String(match?.payload?.payloadHash || '').trim();
  return hash || '';
}

async function runOpenApiProductExecutorForStore(task, args, body = {}, storeKey = '', executionContext = {}) {
  const targetStore = String(storeKey || '').trim().toUpperCase();
  if (!targetStore) throw new Error('Missing OpenAPI product executor target store');
  const actorForGate = body.actorForWriteGate || null;
  const denied = actorForGate ? requireWriteStores(actorForGate, [targetStore]) : null;
  if (denied) {
    return {
      ok: false,
      mode: 'dry-run',
      storeKey: targetStore,
      code: null,
      timedOut: false,
      result: {
        ok: false,
        state: 'blocked',
        blockers: [`${targetStore} 子执行器启动前权限复核失败：${denied.error}`],
        warnings: [],
        permissionDenied: denied,
      },
      stderrTail: '',
    };
  }
  const cap = openApiStoreCapability(targetStore);
  const requestedExecute = String(body.mode || body.executionMode || '').toLowerCase() === 'execute' || body.execute === true;
  const mode = requestedExecute && cap.productPublishExecuteAdapter
    ? 'execute'
    : 'dry-run';
  const {actorForWriteGate: _actorForWriteGate, ...safeBodyForSnapshot} = body && typeof body === 'object' ? body : {};
  const expectedPayloadHash = mode === 'execute'
    ? payloadHashForStoreFromTaskExecution(task, targetStore)
    : '';
  const capturePublishPayload = executionContext?.capturePublishPayload === true && mode === 'dry-run';
  const taskSnapshotDir = path.join(ROOT, 'tmp', 'link-ops-executor-task-json');
  const taskSnapshotFile = path.join(taskSnapshotDir, `${safeTaskId(task.id)}-${crypto.randomBytes(4).toString('hex')}.json`);
  const payloadCaptureFile = capturePublishPayload
    ? path.join(taskSnapshotDir, `${safeTaskId(task.id)}-${crypto.randomBytes(4).toString('hex')}.payload.json`)
    : '';
  await fs.mkdir(taskSnapshotDir, {recursive: true});
  await fs.writeFile(taskSnapshotFile, `${JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    executionContext: {
      ...executionContext,
      request: safeBodyForSnapshot,
      targetStore,
      requestedMode: mode,
      expectedPayloadHash,
      payloadHashSource: expectedPayloadHash ? 'task.execution.openApiProductExecutors' : '',
      issuedAt: new Date().toISOString(),
    },
    tasks: [task],
  }, null, 2)}\n`, 'utf8');
  const childArgs = [
    path.join(ROOT, 'scripts', 'link_ops_hl_openapi_executor.mjs'),
    '--config', SHEIN_OPENAPI_LOCAL_CONFIG_FILE,
    '--task-json', taskSnapshotFile,
    '--task-id', String(task.id || ''),
    '--store', targetStore,
    mode === 'execute' ? '--execute' : '--dry-run',
  ];
  if (mode === 'execute') {
    childArgs.push('--confirm', String(body.confirm || body.confirmText || ''));
  }
  if (payloadCaptureFile) childArgs.push('--payload-out', payloadCaptureFile);
  let result;
  let capturedPublishPayload = null;
  try {
    result = await runChildProcess(process.execPath, childArgs, {
      cwd: ROOT,
      timeoutMs: Number(process.env.SHEIN_LINK_OPS_OPENAPI_EXECUTOR_TIMEOUT_MS || 180_000),
    });
    if (payloadCaptureFile) capturedPublishPayload = await readJsonFile(payloadCaptureFile, null);
  } finally {
    await fs.rm(taskSnapshotFile, {force: true}).catch(() => {});
    if (payloadCaptureFile) await fs.rm(payloadCaptureFile, {force: true}).catch(() => {});
  }
  const parsed = parseChildJsonOutput(result.stdout);
  if (parsed) {
    return {
      ok: Boolean(parsed.ok),
      mode,
      storeKey: targetStore,
      code: result.code,
      timedOut: result.timedOut,
      result: parsed,
      capturedPublishPayload,
      stderrTail: String(result.stderr || '').slice(-1200),
    };
  }
  return {
    ok: false,
    mode,
    storeKey: targetStore,
    code: result.code,
    timedOut: result.timedOut,
    capturedPublishPayload,
      result: {
        ok: false,
        state: mode === 'execute' ? 'suspicious_write_attempted' : (result.timedOut ? 'timeout' : 'error'),
        blockers: mode === 'execute'
          ? []
          : [`${targetStore} OpenAPI 商品系统检查执行器未返回可解析结果：code=${result.code}${result.timedOut ? ' timeout=true' : ''}`],
        warnings: mode === 'execute'
          ? [`${targetStore} OpenAPI 商品执行器在真实提交模式下未返回可解析结果：code=${result.code}${result.timedOut ? ' timeout=true' : ''}。无法确认 SHEIN 是否已接收写请求，任务已锁定，禁止重复提交，需人工核销。`]
          : [],
        suspiciousWriteAttempted: mode === 'execute',
        submittedPossibly: mode === 'execute',
        rawStdoutTail: String(result.stdout || '').slice(-1200),
        rawStderrTail: String(result.stderr || '').slice(-1200),
    },
    stderrTail: String(result.stderr || '').slice(-1200),
  };
}

async function prepareApprovedPublishAssetsForTask(task, args, body, actor, req) {
  if (!task || typeof task !== 'object') throw new Error('Task not found');
  if (taskRequiresOwnerLifecycleResolve(task)) {
    const error = new Error('该任务已进入提交后待回读/人工处理状态，不能替换发布素材');
    error.status = 409;
    throw error;
  }
  const targetStore = String(body.store || body.storeKey || '').trim().toUpperCase();
  if (!targetStore) throw new Error('Missing target store for publish asset binding');
  const writeStores = taskWriteStores(task);
  if (!writeStores.includes(targetStore)) throw new Error(`目标店铺 ${targetStore} 不在该任务写入范围 ${writeStores.join('/') || '(empty)'}`);
  const denied = requireWriteStores(actor, [targetStore]);
  if (denied) {
    const error = new Error(denied.error || '当前账号没有目标店铺写权限');
    error.status = 403;
    error.response = denied;
    throw error;
  }
  if (body.sourceApproved !== true) throw new Error('必须明确 sourceApproved=true 才能绑定人工审核素材');
  const bindings = asArray(body.bindings);
  if (!bindings.length || bindings.length > 14) throw new Error('Approved publish asset binding requires 1-14 uploaded images');
  const publishPreparation = normalizePublishPreparationOverrides(body.publishPreparation || body);
  const taskForCapture = {
    ...task,
    status: String(task.status || '') === 'draft' ? 'confirmed' : task.status,
    targets: {
      ...(task.targets && typeof task.targets === 'object' ? task.targets : {}),
      standardGoodsSn: publishPreparation.standardGoodsSn || task?.targets?.standardGoodsSn || '',
      supplyPrice: publishPreparation.supplyPrice,
      inventory: publishPreparation.inventory,
      categoryId: publishPreparation.categoryId,
      titleAr: publishPreparation.titles.ar || '',
      titleEn: publishPreparation.titles.en || '',
      publishPreparation,
    },
    publishPreparation,
  };
  const captureTask = {
    ...taskForCapture,
    // The reviewed bindings below replace every publish image. Raw image assets
    // attached to the task must not make the base-payload capture fall back to
    // source images or block this explicit same-task preparation step.
    assets: asArray(taskForCapture.assets).filter(asset => !String(asset?.mime || asset?.type || '').toLowerCase().startsWith('image/')),
  };
  const captured = await runOpenApiProductExecutorForStore(
    captureTask,
    args,
    {mode: 'dry-run', source: 'approved_publish_asset_prepare', actorForWriteGate: actor},
    targetStore,
    {capturePublishPayload: true, publishPreparation},
  );
  if (!captured.capturedPublishPayload) {
    const error = new Error('无法从当前任务生成可绑定图片的发布 payload；没有创建新任务，也没有回退到源链接图片');
    error.status = 409;
    error.response = {
      ok: false,
      error: error.message,
      blockers: captured.result?.blockers || [],
      warnings: captured.result?.warnings || [],
      payloadSource: captured.result?.payload?.source || null,
    };
    throw error;
  }
  const explicit = applyExplicitPublishPreparationOverrides(captured.capturedPublishPayload, publishPreparation);
  const bound = applyApprovedImageBindingsToPublishPayload(explicit.payload, bindings, {sourceApproved: true});
  const now = new Date().toISOString();
  const bindingFingerprint = crypto.createHash('sha256').update(JSON.stringify({
    targetStore,
    bindings: bound.bindings.map(row => ({name: row.name, role: row.role, imageType: row.imageType, imageUrl: row.imageUrl, sha256: row.sha256})),
    publishPreparation,
  })).digest('hex');
  const nextTask = {
    ...taskForCapture,
    openapiPublishPayload: bound.payload,
    publishAssetBinding: {
      schemaVersion: 1,
      sourceApproved: true,
      authority: 'human_reviewed_source',
      targetStore,
      boundAt: now,
      boundByUser: actorUser(actor, req),
      bindingFingerprint,
      imageCount: bound.bindings.length,
      images: bound.bindings.map(row => ({
        name: row.name,
        relativePath: row.relativePath,
        role: row.role,
        imageType: row.imageType,
        imageUrl: row.imageUrl,
        width: row.width,
        height: row.height,
        sha256: row.sha256,
      })),
      evidence: bound.evidence,
      publishPreparation: explicit.evidence,
    },
    execution: {
      ...(task.execution && typeof task.execution === 'object' ? task.execution : {}),
      state: 'needs_repreflight',
      openApiProductExecutors: [],
      preflight: {
        ok: false,
        blockers: ['人工审核图片和显式发布字段已绑定到同一任务，需要基于新 payload 重新预演。'],
        warnings: [],
      },
    },
    note: '人工审核图片已上传并绑定到同一任务；旧预演锁已作废，必须重新预演后才能提交。',
    updatedAt: now,
  };
  nextTask.history = appendTaskHistory(nextTask, 'approved_publish_assets_bound', actor, req, {
    targetStore,
    bindingFingerprint,
    imageCount: bound.bindings.length,
    boundNames: bound.evidence.boundNames,
    publishPreparation: explicit.evidence,
  });
  return {
    task: nextTask,
    binding: {
      targetStore,
      bindingFingerprint,
      payloadSource: 'task',
      ...bound.evidence,
      publishPreparation: explicit.evidence,
      preflightInvalidated: true,
    },
  };
}

async function runOpenApiProductExecutors(task, args, body = {}) {
  const stores = openApiProductExecutorTargetStores(task);
  const out = [];
  for (const store of stores) {
    out.push(await runOpenApiProductExecutorForStore(task, args, body, store, body.executionContext || {}));
  }
  return out;
}

function openApiMaintenanceExecutorTargetStores(task) {
  const intents = Array.isArray(task?.intents) ? task.intents : [];
  if (!intents.some(intent => LINK_MAINTENANCE_INTENTS.has(intent))) return [];
  return normalizeConcreteStoreKeys(taskWriteStores(task));
}

async function runOpenApiMaintenanceExecutorForStore(task, args, body = {}, storeKey = '', executionContext = {}) {
  const targetStore = String(storeKey || '').trim().toUpperCase();
  if (!targetStore) throw new Error('Missing OpenAPI maintenance executor target store');
  const actorForGate = body.actorForWriteGate || null;
  const denied = actorForGate ? requireWriteStores(actorForGate, [targetStore]) : null;
  if (denied) {
    return {
      ok: false,
      mode: 'dry-run',
      storeKey: targetStore,
      code: null,
      timedOut: false,
      result: {
        ok: false,
        state: 'blocked',
        blockers: [`${targetStore} 维护执行器启动前权限复核失败：${denied.error}`],
        warnings: [],
        permissionDenied: denied,
      },
      stderrTail: '',
    };
  }
  const intents = Array.isArray(task?.intents) ? task.intents.filter(intent => LINK_MAINTENANCE_INTENTS.has(intent)) : [];
  const cap = openApiStoreCapability(targetStore);
  const requestedExecute = String(body.mode || body.executionMode || '').toLowerCase() === 'execute' || body.execute === true;
  const allActionsEnabled = intents.length > 0 && intents.every(intent => {
    const control = openApiRealSubmitControlForOperation(intent, targetStore);
    return cap.authorized && cap.verifiedRead && control.enabled;
  });
  const mode = requestedExecute && allActionsEnabled ? 'execute' : 'dry-run';
  const {actorForWriteGate: _actorForWriteGate, ...safeBodyForSnapshot} = body && typeof body === 'object' ? body : {};
  const expectedPayloadHash = mode === 'execute'
    ? (intents.map(intent => payloadHashForMaintenanceFromTaskExecution(task, targetStore, intent)).find(Boolean) || '')
    : '';
  const taskSnapshotDir = path.join(ROOT, 'tmp', 'link-ops-maintenance-task-json');
  const taskSnapshotFile = path.join(taskSnapshotDir, `${safeTaskId(task.id)}-${crypto.randomBytes(4).toString('hex')}.json`);
  await fs.mkdir(taskSnapshotDir, {recursive: true});
  await fs.writeFile(taskSnapshotFile, `${JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    executionContext: {
      ...executionContext,
      request: safeBodyForSnapshot,
      targetStore,
      requestedMode: mode,
      expectedPayloadHash,
      payloadHashSource: expectedPayloadHash ? 'task.execution.linkMaintenanceExecutors' : '',
      issuedAt: new Date().toISOString(),
    },
    tasks: [task],
  }, null, 2)}\n`, 'utf8');
  const childArgs = [
    path.join(ROOT, 'scripts', 'link_ops_maintenance_openapi_executor.mjs'),
    '--config', SHEIN_OPENAPI_LOCAL_CONFIG_FILE,
    '--task-json', taskSnapshotFile,
    '--task-id', String(task.id || ''),
    '--store', targetStore,
    '--dir', args.dir || path.join(ROOT, 'outputs', 'bi-portal'),
    mode === 'execute' ? '--execute' : '--dry-run',
  ];
  if (mode === 'execute') childArgs.push('--confirm', String(body.confirm || body.confirmText || ''));
  let result;
  try {
    result = await runChildProcess(process.execPath, childArgs, {
      cwd: ROOT,
      timeoutMs: Number(process.env.SHEIN_LINK_OPS_OPENAPI_EXECUTOR_TIMEOUT_MS || 180_000),
    });
  } finally {
    await fs.rm(taskSnapshotFile, {force: true}).catch(() => {});
  }
  const parsed = parseChildJsonOutput(result.stdout);
  if (parsed) {
    return {
      ok: Boolean(parsed.ok),
      mode,
      storeKey: targetStore,
      code: result.code,
      timedOut: result.timedOut,
      result: parsed,
      stderrTail: String(result.stderr || '').slice(-1200),
    };
  }
  return {
    ok: false,
    mode,
    storeKey: targetStore,
    code: result.code,
    timedOut: result.timedOut,
    result: {
      ok: false,
      state: mode === 'execute' ? 'suspicious_write_attempted' : (result.timedOut ? 'timeout' : 'error'),
      blockers: mode === 'execute'
        ? []
        : [`${targetStore} OpenAPI 维护执行器未返回可解析结果：code=${result.code}${result.timedOut ? ' timeout=true' : ''}`],
      warnings: mode === 'execute'
        ? [`${targetStore} OpenAPI 维护执行器在真实提交模式下未返回可解析结果：code=${result.code}${result.timedOut ? ' timeout=true' : ''}。无法确认 SHEIN 是否已接收写请求，任务已锁定，禁止重复提交，需人工核销。`]
        : [],
      suspiciousWriteAttempted: mode === 'execute',
      submittedPossibly: mode === 'execute',
      rawStdoutTail: String(result.stdout || '').slice(-1200),
      rawStderrTail: String(result.stderr || '').slice(-1200),
    },
    stderrTail: String(result.stderr || '').slice(-1200),
  };
}

async function runOpenApiMaintenanceExecutors(task, args, body = {}) {
  const stores = openApiMaintenanceExecutorTargetStores(task);
  const out = [];
  for (const store of stores) {
    out.push(await runOpenApiMaintenanceExecutorForStore(task, args, body, store, body.executionContext || {}));
  }
  return out;
}

async function startControlledLinkOpsExecution(task, actor, req, args, body = {}) {
  const originalStatus = String(task?.status || 'draft');
  const now = new Date().toISOString();
  const rawRequestedMode = String(body.mode || body.executionMode || (body.execute === true ? 'execute' : 'dry-run') || 'dry-run').toLowerCase();
  const requestedMode = rawRequestedMode === 'execute' ? 'execute' : 'dry-run';
  let ownerKnowledgeDistribution = null;
  let ownerKnowledgeDistributionError = '';
  const ownerKnowledgeGenerationAtStart = Number(args?.getOwnerKnowledgeGeneration?.() || 0);
  if (requestedMode === 'execute') {
    try {
      ownerKnowledgeDistribution = await args.ownerKnowledgeService?.distributionManifest();
    } catch (error) {
      ownerKnowledgeDistributionError = String(error?.message || error);
    }
    const testMarkerFile = String(process.env.SHEIN_OWNER_KNOWLEDGE_TEST_PRE_EXECUTE_MARKER_FILE || '').trim();
    if (testMarkerFile) {
      await fs.mkdir(path.dirname(testMarkerFile), {recursive: true});
      await fs.writeFile(testMarkerFile, `${JSON.stringify({at: new Date().toISOString(), fingerprint: ownerKnowledgeDistribution?.fingerprint || ''})}\n`, 'utf8');
    }
  }
  const priorKnowledgeFingerprint = String(task?.ownerKnowledgePolicy?.fingerprint || '');
  const knowledgeBinding = await bindOwnerKnowledgeToTask(task, args, task?.command || '');
  if (knowledgeBinding.changed) task = knowledgeBinding.task;
  const intents = normalizeIntentsForCommand(Array.isArray(task?.intents) ? task.intents : [], task?.command || '');
  const chatTargets = await inferTargetsFromTaskChatSession(args, task);
  const mergedTargets = normalizeTargetsForIntents(intents, mergeLinkOpsTargets(task?.targets || {}, chatTargets));
  const normalizedOriginalTargets = normalizeTargetsForIntents(intents, task?.targets || {});
  if (JSON.stringify(mergedTargets) !== JSON.stringify(normalizedOriginalTargets) || JSON.stringify(intents) !== JSON.stringify(Array.isArray(task?.intents) ? task.intents : [])) {
    task = {
      ...task,
      intents,
      targets: mergedTargets,
      executionHints: {
        ...(task?.executionHints && typeof task.executionHints === 'object' ? task.executionHints : {}),
        chatTargetsMergedAt: now,
      },
    };
  }
  const confirmText = String(body.confirm || body.confirmText || '').trim();
  const confirmTextPresent = confirmText === LINK_OPS_OPENAPI_SUBMIT_CONFIRM_TEXT;
  let executeAllowed = false;
  const auditActor = actorAuditContext(actor, req);
  const auditRequestMeta = requestMeta(req);
  const targetStores = taskTargetStores(task);
  const sourceStores = taskSourceStores(task);
  const writeStores = taskWriteStores(task);
  const productRefs = normalizeLinkOpsTargetSet(task?.targets || {}).productRefs;
  const maintenanceIntents = intents.filter(intent => LINK_MAINTENANCE_INTENTS.has(intent));
  const hasProductPublishIntent = intents.includes('copy_product_draft');
  const hasMaintenanceIntent = maintenanceIntents.length > 0;
  const realSubmitOperations = [
    ...(hasProductPublishIntent ? ['copy_product_draft'] : []),
    ...maintenanceIntents,
  ];
  const realSubmitWhitelistChecks = realSubmitOperations.flatMap(operation =>
    writeStores.map(store => biOpsWriteWhitelistAllowedForActor(actor, {operation, storeKey: store}))
  );
  const autoConfirmed = originalStatus === 'draft';
  const runnableTask = autoConfirmed
    ? {
      ...task,
      status: 'confirmed',
      progress: Math.max(normalizeProgress(task.progress, 0), 30),
      note: task.note || '用户要求开始执行，系统已进入资料检查。',
      updatedAt: now,
    }
    : task;
  const preflight = runPreflightForLinkOpsTask(runnableTask);
  if (requestedMode === 'execute' && priorKnowledgeFingerprint && knowledgeBinding.changed) {
    preflight.blockers.push('负责人长期规则在上次系统检查后发生更新；必须按新规则重新系统检查，不能沿用旧预演直接提交。');
  }
  if (requestedMode === 'execute') {
    if (ownerKnowledgeDistributionError || !ownerKnowledgeDistribution?.ready || !ownerKnowledgeDistribution?.current) {
      preflight.blockers.push('负责人规则尚未完成 GitHub 校验并同步到当前版本；真实提交暂时关闭，请稍后重试。');
    }
    const unsupportedExecuteIntents = intents
      .filter(intent => intent !== 'copy_product_draft' && intent !== 'manual_review' && !LINK_MAINTENANCE_INTENTS.has(intent));
    if (!hasProductPublishIntent && !hasMaintenanceIntent) {
      preflight.blockers.push('这件事还没有接入可提交动作；我只能先检查资料或让你补材料。');
    }
    if (hasProductPublishIntent && hasMaintenanceIntent) {
      preflight.blockers.push('复制上品和链接维护写动作必须拆成两个任务分别真实提交，避免一次确认覆盖不同生命周期动作。');
    }
    if (unsupportedExecuteIntents.length) {
      preflight.blockers.push(`以下动作尚未接入真实提交适配器：${unsupportedExecuteIntents.map(linkOpsIntentLabel).join('、')}；不能和真实 SHEIN 写提交混在同一次执行里。`);
    }
    if (!confirmTextPresent) {
      preflight.blockers.push(`真实提交必须显式输入确认文本 ${LINK_OPS_OPENAPI_SUBMIT_CONFIRM_TEXT}。`);
    }
    if (originalStatus !== 'waiting_review') {
      preflight.blockers.push('真实提交必须先完成一次 系统检查，并停在“等你确认”状态。');
    }
    if (hasProductPublishIntent) {
      if (task?.execution?.state !== 'openapi_product_preflight_ready' || task?.execution?.preflight?.ok !== true) {
        preflight.blockers.push('真实提交前缺少已通过的 OpenAPI 商品系统检查证据。');
      }
      const notEnabledStores = writeStores.filter(store => !openApiStoreCapability(store).productPublishExecuteAdapter);
      if (notEnabledStores.length) {
        preflight.blockers.push(`${notEnabledStores.join(',')} 商品发布/编辑真实提交未被服务端总闸门放行；本次只能重新 系统检查。`);
      }
      const whitelistDenied = realSubmitWhitelistChecks.filter(check => check.operation === 'copy_product_draft' && !check.allowed);
      if (whitelistDenied.length) {
        preflight.blockers.push(`${whitelistDenied.map(check => check.storeKey).join(',')} 未命中真实写试点白名单（人+店+动作），不能真实提交。`);
      }
      const storesMissingPayloadHash = writeStores.filter(store => !payloadHashForStoreFromTaskExecution(task, store));
      if (storesMissingPayloadHash.length) {
        preflight.blockers.push(`${storesMissingPayloadHash.join(',')} 缺少上一次 系统检查 锁定的 payload hash，不能真实提交。`);
      }
    }
    if (hasMaintenanceIntent) {
      if (task?.execution?.state !== 'link_maintenance_preflight_ready' || task?.execution?.preflight?.ok !== true) {
        preflight.blockers.push('真实提交前缺少已通过的 OpenAPI 维护系统检查证据。');
      }
      for (const store of writeStores) {
        const cap = openApiStoreCapability(store);
        if (!cap.authorized) preflight.blockers.push(`${store} 未完成 OpenAPI 授权/密钥配置，不能真实执行维护写动作。`);
        if (cap.authorized && !cap.verifiedRead) preflight.blockers.push(`${store} 最近只读探针未证明可用，不能真实执行维护写动作。`);
        for (const operation of maintenanceIntents) {
          const control = openApiRealSubmitControlForOperation(operation, store);
          if (!control.safeWrite.allowed) {
            const reasons = [];
            if (!control.safeWrite.enabled) reasons.push('真实写总闸门未开启');
            if (control.safeWrite.enabled && !control.safeWrite.operationAllowed) reasons.push(`动作 ${operation} 未进入 allowedOperations`);
            if (control.safeWrite.enabled && !control.safeWrite.storeAllowed) reasons.push(`店铺 ${store} 未进入 allowedStores`);
            preflight.blockers.push(`${store}/${linkOpsIntentLabel(operation)} 未被服务端真实写总闸门放行：${reasons.join('，') || 'safeWriteOperations 不允许'}`);
          }
          const whitelist = realSubmitWhitelistChecks.find(check => check.operation === operation && check.storeKey === store);
          if (!whitelist?.allowed) {
            preflight.blockers.push(`${store}/${linkOpsIntentLabel(operation)} 未命中真实写试点白名单（人+店+动作），不能真实提交。`);
          }
          if (!payloadHashForMaintenanceFromTaskExecution(task, store, operation)) {
            preflight.blockers.push(`${store}/${linkOpsIntentLabel(operation)} 缺少上一次 系统检查 锁定的 payload hash，不能真实提交。`);
          }
        }
      }
    }
    executeAllowed = confirmTextPresent
      && originalStatus === 'waiting_review'
      && preflight.blockers.length === 0
      && (
        (hasProductPublishIntent && task?.execution?.state === 'openapi_product_preflight_ready' && task?.execution?.preflight?.ok === true)
        || (hasMaintenanceIntent && task?.execution?.state === 'link_maintenance_preflight_ready' && task?.execution?.preflight?.ok === true)
      );
  }
  const executionContext = {
    actor: auditActor,
    requestMeta: auditRequestMeta,
    parentTaskId: String(task?.id || ''),
    targetStores,
    sourceStores,
    writeStores,
    productRefs,
    attributeOverrides: normalizeLinkOpsTargetSet(task?.targets || {}).attributeOverrides,
    intents,
    requestedMode,
    realSubmitWhitelistChecks,
    parentIssuedAt: now,
  };
  const runExecutors = async allowExecute => {
    const product = await runOpenApiProductExecutors(runnableTask, args, {
      ...body,
      actorForWriteGate: actor,
      mode: allowExecute && hasProductPublishIntent ? 'execute' : 'dry-run',
      executionMode: allowExecute && hasProductPublishIntent ? 'execute' : 'dry-run',
      execute: allowExecute && hasProductPublishIntent,
      confirm: allowExecute && hasProductPublishIntent ? confirmText : '',
      confirmText: allowExecute && hasProductPublishIntent ? confirmText : '',
      executionContext,
    });
    const maintenance = await runOpenApiMaintenanceExecutors(runnableTask, args, {
      ...body,
      actorForWriteGate: actor,
      mode: allowExecute && hasMaintenanceIntent ? 'execute' : 'dry-run',
      executionMode: allowExecute && hasMaintenanceIntent ? 'execute' : 'dry-run',
      execute: allowExecute && hasMaintenanceIntent,
      confirm: allowExecute && hasMaintenanceIntent ? confirmText : '',
      confirmText: allowExecute && hasMaintenanceIntent ? confirmText : '',
      executionContext,
    });
    return {product, maintenance};
  };
  const verifyDistributionUnchanged = async () => {
    let latest = null;
    try {
      latest = await args.ownerKnowledgeService?.distributionManifest();
    } catch (error) {
      return {ok: false, error: String(error?.message || error)};
    }
    const expected = ownerKnowledgeDistribution;
    const requiredCurrent = Boolean(expected?.ready && expected?.current && latest?.ready && latest?.current);
    const sameSnapshot = requiredCurrent
      && String(latest.fingerprint || '') === String(expected.fingerprint || '')
      && String(latest.activeFingerprint || '') === String(expected.activeFingerprint || '')
      && String(latest.sourceCommit || '') === String(expected.sourceCommit || '')
      && Number(args?.getOwnerKnowledgeGeneration?.() || 0) === ownerKnowledgeGenerationAtStart
      && (!Number(expected.distributionRevision || 0)
        || Number(latest.distributionRevision || 0) === Number(expected.distributionRevision || 0));
    const testMarkerFile = String(process.env.SHEIN_OWNER_KNOWLEDGE_TEST_PRE_EXECUTE_MARKER_FILE || '').trim();
    if (testMarkerFile) {
      await fs.writeFile(`${testMarkerFile}.final`, `${JSON.stringify({
        ok: sameSnapshot,
        expectedFingerprint: expected?.fingerprint || '',
        latestFingerprint: latest?.fingerprint || '',
        expectedSourceCommit: expected?.sourceCommit || '',
        latestSourceCommit: latest?.sourceCommit || '',
        expectedGeneration: ownerKnowledgeGenerationAtStart,
        latestGeneration: Number(args?.getOwnerKnowledgeGeneration?.() || 0),
      })}\n`, 'utf8');
    }
    return sameSnapshot ? {ok: true, manifest: latest} : {ok: false, manifest: latest};
  };
  let openApiProductExecutors;
  let openApiMaintenanceExecutors;
  if (requestedMode === 'execute') {
    const testMarkerFile = String(process.env.SHEIN_OWNER_KNOWLEDGE_TEST_PRE_EXECUTE_MARKER_FILE || '').trim();
    if (testMarkerFile) await fs.writeFile(`${testMarkerFile}.ready`, `${new Date().toISOString()}\n`, 'utf8');
    const testGenerationBumpMs = Math.max(0, Math.min(4_000, Number(process.env.SHEIN_OWNER_KNOWLEDGE_TEST_BUMP_DURING_EXECUTE_MS || 0)));
    if (testGenerationBumpMs) {
      const timer = setTimeout(() => args?.bumpOwnerKnowledgeGeneration?.(), testGenerationBumpMs);
      timer.unref?.();
    }
    const testDelayMs = Math.max(0, Math.min(5_000, Number(process.env.SHEIN_OWNER_KNOWLEDGE_TEST_PRE_EXECUTE_DELAY_MS || 0)));
    if (testDelayMs) await new Promise(resolve => setTimeout(resolve, testDelayMs));
    const withConsistencyLock = args?.withOwnerKnowledgeConsistencyLock || (work => work());
    const guarded = await withConsistencyLock(async () => {
      const guard = await verifyDistributionUnchanged();
      if (!guard.ok || !executeAllowed) return {guard, executions: null};
      return {guard, executions: await runExecutors(true)};
    });
    if (!guarded.guard.ok) {
      preflight.blockers.push('负责人规则在执行准备期间发生变化或尚未完成 GitHub 校验；本次未向 SHEIN 发出真实写请求，请重新系统检查和确认。');
      executeAllowed = false;
    }
    if (guarded.executions) {
      openApiProductExecutors = guarded.executions.product;
      openApiMaintenanceExecutors = guarded.executions.maintenance;
    } else {
      const dryRun = await runExecutors(false);
      openApiProductExecutors = dryRun.product;
      openApiMaintenanceExecutors = dryRun.maintenance;
    }
  } else {
    const dryRun = await runExecutors(false);
    openApiProductExecutors = dryRun.product;
    openApiMaintenanceExecutors = dryRun.maintenance;
  }
  const linkMaintenancePrechecks = openApiMaintenanceExecutors;
  const executorRuns = [...openApiProductExecutors, ...openApiMaintenanceExecutors];
  const executorResults = executorRuns.map(x => x.result).filter(Boolean);
  const issuedExecuteToExecutor = executorRuns.some(x => String(x?.mode || '') === 'execute');
  const sheinWriteAttempted = executorResults.some(x => Boolean(x?.publishResult));
  const suspiciousWriteAttempted = executorResults.some(x => Boolean(x?.suspiciousWriteAttempted) || String(x?.state || '') === 'suspicious_write_attempted');
  const combinedBlockers = uniqueMessages([
    ...preflight.blockers,
    ...executorResults.flatMap(x => asArray(x?.blockers)),
  ]);
  const combinedWarnings = uniqueMessages([
    ...preflight.warnings,
    ...executorResults.flatMap(x => asArray(x?.warnings)),
  ]);
  const ok = combinedBlockers.length === 0;
  const runId = `lor_${now.replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto.randomBytes(4).toString('hex')}`;
  const hasOpenApiProductExecutor = openApiProductExecutors.length > 0;
  const hasOpenApiMaintenanceExecutor = openApiMaintenanceExecutors.length > 0;
  const submitted = executorResults.some(x => x?.state === 'submitted');
  const publishPreValidFailed = executorResults.some(x => x?.state === 'publish_pre_valid_failed' || x?.publishResult?.info?.success === false);
  const executorState = submitted
    ? 'submitted'
    : suspiciousWriteAttempted
      ? 'suspicious_write_attempted'
      : publishPreValidFailed
        ? 'publish_pre_valid_failed'
    : hasOpenApiProductExecutor
      ? (ok ? 'openapi_product_preflight_ready' : 'blocked')
      : hasOpenApiMaintenanceExecutor
        ? (ok ? 'link_maintenance_preflight_ready' : 'blocked')
        : (ok ? 'ready_for_prefill' : 'blocked');
  const lifecycleTransition = classifyLinkOpsLifecycle({
    task: runnableTask,
    requestedMode,
    executorState,
    submitted,
    suspiciousWriteAttempted,
    ok,
    executorResults,
    originalStatus,
  });
  const nextStatus = lifecycleTransition.toStatus || (hasOpenApiProductExecutor || hasOpenApiMaintenanceExecutor
      ? 'waiting_review'
      : (ok ? 'in_progress' : 'waiting_review'));
  const nextProgress = submitted
    ? (lifecycleTransition.terminal
      ? 100
      : Math.max(normalizeProgress(task.progress, 0), lifecycleTransition.needsManualResolve ? 85 : 82))
    : suspiciousWriteAttempted
      ? Math.max(normalizeProgress(task.progress, 0), 85)
    : publishPreValidFailed
      ? Math.max(normalizeProgress(task.progress, 0), 62)
    : ok
      ? Math.max(normalizeProgress(task.progress, 0), hasOpenApiProductExecutor ? 70 : (hasOpenApiMaintenanceExecutor ? 68 : 65))
      : Math.max(normalizeProgress(task.progress, 0), 45);
  const writeAudit = buildLinkOpsExecutionWriteAudit({
    task: runnableTask,
    actor,
    req,
      runId,
      at: now,
      requestedMode,
      finalState: executorState,
      submitted,
      executorRuns,
      blockers: combinedBlockers,
      warnings: combinedWarnings,
      confirmTextPresent,
      executeAllowed,
      lifecycleTransition,
      realSubmitWhitelistChecks,
    });
  const mapProductExecutor = (executorRun, index) => {
    const executorResult = executorRun.result || {};
    return {
      storeKey: executorResult.storeKey || executorRun.storeKey || '',
      ok: Boolean(executorResult.ok),
      mode: executorRun.mode || '',
      state: executorResult.state || '',
      runId: executorResult.runId || '',
      savedTo: executorResult.savedTo || '',
      payload: executorResult.payload || null,
      openapi: executorResult.openapi ? {
        canPublishProduct: executorResult.openapi.canPublishProduct,
        publishPermissionReason: executorResult.openapi.publishPermissionReason,
        sites: executorResult.openapi.sites,
        brands: executorResult.openapi.brands,
        warehouses: executorResult.openapi.warehouses,
        calls: executorResult.openapi.calls,
      } : null,
      publishResult: executorResult.publishResult || null,
      readbackFingerprint: executorResult.readbackFingerprint || null,
      readback: executorResult.readback || null,
      safety: executorResult.safety || null,
      index,
    };
  };
  const mapMaintenanceExecutor = (executorRun, index) => {
    const executorResult = executorRun.result || {};
    return {
      storeKey: executorResult.storeKey || executorRun.storeKey || '',
      ok: Boolean(executorResult.ok),
      mode: executorRun.mode || '',
      state: executorResult.state || '',
      runId: executorResult.runId || '',
      savedTo: executorResult.savedTo || '',
      adapterKind: executorResult.adapterKind || '',
      payload: executorResult.payload || null,
      adapterEvidence: executorResult.adapterEvidence || null,
      publishResult: executorResult.publishResult || null,
      readbackFingerprint: executorResult.readbackFingerprint || null,
      readback: executorResult.readback || null,
      safety: executorResult.safety || null,
      index,
    };
  };
  const next = {
    ...runnableTask,
    status: nextStatus,
    progress: nextProgress,
    note: submitted
      ? lifecycleTransition.note
      : suspiciousWriteAttempted
        ? lifecycleTransition.note
        : publishPreValidFailed
          ? lifecycleTransition.note
      : ok && hasOpenApiProductExecutor
        ? 'OpenAPI 商品执行器 系统检查通过；仍需最终执行确认，系统不会静默提交 SHEIN。'
        : ok && hasOpenApiMaintenanceExecutor
          ? 'OpenAPI 维护执行器 系统检查通过；仍需最终执行确认，系统不会静默提交 SHEIN。'
          : ok
            ? '受控执行器已完成前置检查；当前停在执行准备/预填阶段，不会静默提交 SHEIN。'
            : `执行器阻断：${combinedBlockers.join('；')}`,
    execution: {
      ...(task.execution && typeof task.execution === 'object' ? task.execution : {}),
      mode: hasOpenApiProductExecutor ? 'openapi_product_executor' : (hasOpenApiMaintenanceExecutor ? 'openapi_maintenance_executor' : 'controlled_prefill'),
      enabled: true,
      runId,
      state: executorState,
      canAutoSubmit: false,
      canSilentWrite: false,
      preflight: {
        ...preflight,
        ok,
        blockers: combinedBlockers,
        warnings: combinedWarnings,
      },
      openApiProductExecutors: openApiProductExecutors.map(mapProductExecutor),
      linkMaintenanceExecutors: openApiMaintenanceExecutors.map(mapMaintenanceExecutor),
      linkMaintenancePrechecks: openApiMaintenanceExecutors.map(mapMaintenanceExecutor),
      hlOpenApiExecutor: executorResults.length === 1 ? {
        ok: Boolean(executorResults[0].ok),
        mode: executorRuns[0]?.mode || '',
        state: executorResults[0].state || '',
        runId: executorResults[0].runId || '',
        savedTo: executorResults[0].savedTo || '',
        payload: executorResults[0].payload || null,
        openapi: executorResults[0].openapi ? {
          canPublishProduct: executorResults[0].openapi.canPublishProduct,
          publishPermissionReason: executorResults[0].openapi.publishPermissionReason,
          sites: executorResults[0].openapi.sites,
          brands: executorResults[0].openapi.brands,
          warehouses: executorResults[0].openapi.warehouses,
          calls: executorResults[0].openapi.calls,
        } : null,
        adapterEvidence: executorResults[0].adapterEvidence || null,
        publishResult: executorResults[0].publishResult || null,
        readbackFingerprint: executorResults[0].readbackFingerprint || null,
        readback: executorResults[0].readback || null,
        safety: executorResults[0].safety || null,
      } : null,
      startedAt: now,
      startedBy: actorLabel(actor, req),
      startedByUser: actorUser(actor, req),
      requestMeta: auditRequestMeta,
      writeAudit,
      autoConfirmed,
      confirmTextPresent,
      executeAllowed,
      requestedRealSubmit: requestedMode === 'execute',
      issuedExecuteToExecutor,
      sheinWriteAttempted,
      actualWriteSubmitted: submitted,
      realSubmitBoundary: submitted
        ? '已调用 SHEIN 写接口并收到提交成功状态；后续仍需回读确认 SHEIN 侧最终状态。'
        : requestedMode === 'execute'
          ? '本次没有完成 SHEIN 真实写提交；请查看 blockers、executeAllowed、issuedExecuteToExecutor 和 sheinWriteAttempted。'
          : '本次为 系统检查/系统检查，没有调用 SHEIN 真实写接口。',
      lifecycle: lifecycleTransition,
      note: hasOpenApiProductExecutor
        ? 'OpenAPI 商品执行器已接入。默认只做系统检查；真实 publishOrEdit 必须任务已确认、payload 完整、显式 execute 和确认文本同时满足。'
        : hasOpenApiMaintenanceExecutor
          ? 'OpenAPI 维护执行器已接入。默认只做系统检查；真实提交必须命中服务端总闸门、真实写白名单、系统检查 payload hash 和确认文本，提交后必须回读或人工核销。'
          : '第一版只做材料/权限/防重检查和执行准备；正式 SHEIN 提交必须后续接具体适配器并保留人工确认。',
    },
    lifecycle: lifecycleTransition,
    executionHistory: appendExecutionHistory(runnableTask, {
      event: 'controlled_execution_run',
      runId,
      requestedMode,
      originalStatus,
      finalStatus: nextStatus,
      finalState: executorState,
      submitted,
      actualWriteSubmitted: submitted,
      executeAllowed,
      confirmTextPresent,
      issuedExecuteToExecutor,
      sheinWriteAttempted,
      lifecycleStatus: lifecycleTransition.lifecycleStatus,
      lifecycleLocked: Boolean(lifecycleTransition.locked),
      needsManualResolve: Boolean(lifecycleTransition.needsManualResolve),
      blockerCount: combinedBlockers.length,
      warningCount: combinedWarnings.length,
      actor: auditActor,
      requestMeta: auditRequestMeta,
      executorRuns: executorRuns.map(executorRun => {
        const result = executorRun?.result || {};
        return {
          storeKey: result.storeKey || executorRun?.storeKey || '',
          mode: executorRun?.mode || '',
          state: result.state || '',
          ok: Boolean(result.ok),
          runId: result.runId || '',
          payloadHash: result.payload?.payloadHash || '',
          publishCode: result.publishResult?.code ?? null,
          publishTraceId: result.publishResult?.traceId || '',
          readbackStatus: result.readback?.status || '',
          readbackOk: Boolean(result.readback?.ok),
        };
      }),
    }),
    updatedAt: now,
  };
  const historyEvent = ok
    ? (submitted
      ? (hasOpenApiMaintenanceExecutor ? 'openapi_maintenance_submitted' : 'openapi_product_submitted')
      : (hasOpenApiProductExecutor ? 'openapi_product_preflight_ready' : (hasOpenApiMaintenanceExecutor ? 'link_maintenance_preflight_ready' : 'start_controlled_executor')))
    : 'executor_blocked';
  next.history = appendTaskHistory(next, historyEvent, actor, req, {
    status: next.status,
    progress: normalizeProgress(next.progress, 0),
    runId,
    writeAudit,
    autoConfirmed,
    confirmTextPresent,
    executeAllowed,
    originalStatus,
    blockers: combinedBlockers,
    warnings: combinedWarnings,
    openApiProductExecutors: openApiProductExecutors.map(executorRun => {
      const executorResult = executorRun.result || {};
      return {
        storeKey: executorResult.storeKey || '',
        state: executorResult.state || '',
        runId: executorResult.runId || '',
        savedTo: executorResult.savedTo || '',
        payloadFound: Boolean(executorResult.payload?.found),
        payloadHash: executorResult.payload?.payloadHash || '',
        payloadSummary: executorResult.payload?.summary || null,
        canPublishProduct: executorResult.openapi?.canPublishProduct ?? null,
        publishResult: executorResult.publishResult ? {
          httpStatus: executorResult.publishResult.httpStatus,
          code: executorResult.publishResult.code,
          msg: executorResult.publishResult.msg,
          traceId: executorResult.publishResult.traceId,
        } : null,
      };
    }),
    linkMaintenanceExecutors: openApiMaintenanceExecutors.map(executorRun => {
      const executorResult = executorRun.result || {};
      return {
        storeKey: executorResult.storeKey || '',
        state: executorResult.state || '',
        runId: executorResult.runId || '',
        savedTo: executorResult.savedTo || '',
        adapterKind: executorResult.adapterKind || '',
        payloadFound: Boolean(executorResult.payload?.found),
        payloadHash: executorResult.payload?.payloadHash || '',
        operations: executorResult.payload?.summary?.operations || [],
        matchedLinksCount: Number(executorResult.adapterEvidence?.matchedLinksCount || 0),
        realSubmit: Boolean(executorResult.adapterEvidence?.realSubmit),
        publishResult: executorResult.publishResult ? {
          code: executorResult.publishResult.code,
          msg: executorResult.publishResult.msg,
          traceId: executorResult.publishResult.traceId,
        } : null,
        readbackStatus: executorResult.readback?.status || '',
      };
    }),
    linkMaintenancePrechecks: openApiMaintenanceExecutors.map(executorRun => {
      const executorResult = executorRun.result || {};
      return {
        storeKey: executorResult.storeKey || '',
        state: executorResult.state || '',
        runId: executorResult.runId || '',
        adapterKind: executorResult.adapterKind || '',
        matchedLinksCount: Number(executorResult.adapterEvidence?.matchedLinksCount || 0),
        realSubmit: Boolean(executorResult.adapterEvidence?.realSubmit),
      };
    }),
  });
  return next;
}

function runChildProcess(command, args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      env: {...process.env, ...(options.env || {})},
      windowsHide: true,
      stdio: [options.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
    }, options.timeoutMs || 120_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    if (options.stdin) {
      child.stdin.on('error', err => {
        stderr += `\nstdin error: ${err?.message || err}`;
      });
      try {
        child.stdin.write(String(options.stdin));
        child.stdin.end();
      } catch (err) {
        stderr += `\nstdin write failed: ${err?.message || err}`;
        try { child.kill('SIGTERM'); } catch {}
      }
    }
    child.on('error', err => {
      clearTimeout(timer);
      resolve({ok: false, code: -1, timedOut, stdout, stderr: String(err?.stack || err)});
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ok: code === 0 && !timedOut, code, timedOut, stdout, stderr});
    });
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function dockerPrefix() {
  if (process.platform === 'win32') return 'sudo ';
  if (typeof process.getuid === 'function' && process.getuid() === 0) return '';
  return 'sudo ';
}

function psqlSpawnCommand(args, extraFlags = '') {
  const psql = `${dockerPrefix()}docker exec -i ${shellQuote(args.container)} psql -U ${shellQuote(args.user)} -d ${shellQuote(args.database)} -v ON_ERROR_STOP=1${extraFlags}`;
  if (process.platform === 'win32') {
    return {
      command: 'wsl',
      args: ['-d', args.distro, '--', 'bash', '-lc', psql],
    };
  }
  return {
    command: 'bash',
    args: ['-lc', psql],
  };
}

async function readBiPortalCoreMeta(root) {
  const data = await readJsonFile(path.join(root, 'data.json'), {});
  return {
    generatedAt: data?.generatedAt || data?.__sections?.generatedAt || '',
    mode: data?.__sections?.mode || 'legacy',
  };
}

function roundNumber(value, digits = 2) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  const m = 10 ** digits;
  return Math.round(n * m) / m;
}

function homeProfitScopeOrder(scopeValue) {
  const scope = String(scopeValue || '').toUpperCase();
  if (!scope) return 0;
  if (scope.startsWith('GROUP:')) return 1;
  return 2;
}

function emptyHomeProfitScopeRow(date, scopeValue) {
  return {
    date,
    scope_value: scopeValue,
    scope_order: homeProfitScopeOrder(scopeValue),
    gross_revenue_sar: 0,
    net_revenue_sar: 0,
    quantity: 0,
    order_lines: 0,
    orders: 0,
    product_cost_sar: 0,
    return_delivery_fee_sar: 0,
    rtv_recoverable_cost_sar: 0,
    rtv_09_recoverable_cost_sar: 0,
    rtv_received_quantity: 0,
    rtv_received_to_09_quantity: 0,
    profit_before_storage_sar: 0,
    storage_fee_sar: 0,
    storage_matched: 0,
    fallback_storage_fee_sar: 0,
    profit_if_rtv_received_resellable_sar: 0,
    profit_if_rtv_09_resellable_sar: 0,
    known_net_revenue_sar: 0,
    known_gross_revenue_sar: 0,
    missing_cost_revenue_sar: 0,
    missing_cost_quantity: 0,
    missing_cost_lines: 0,
    reversal_lines: 0,
  };
}

function buildHomeProfitSummaryFromProfitData(profitData, sourceMeta = {}) {
  const profit = profitData?.profit && typeof profitData.profit === 'object' ? profitData.profit : {};
  const rows = Array.isArray(profit.dailyStoreProducts) ? profit.dailyStoreProducts : [];
  const storageRows = Array.isArray(profit.storeStorageDaily) ? profit.storeStorageDaily : [];
  const map = new Map();
  const getRow = (date, scopeValue) => {
    const key = `${date}|${scopeValue}`;
    if (!map.has(key)) map.set(key, emptyHomeProfitScopeRow(date, scopeValue));
    return map.get(key);
  };
  const addProfitRow = (scopeValue, r) => {
    const date = String(r?.date || '').slice(0, 10);
    if (!date) return;
    const row = getRow(date, scopeValue);
    row.gross_revenue_sar += Number(r.gross_revenue_sar || 0);
    row.net_revenue_sar += Number(r.net_revenue_sar || 0);
    row.quantity += Number(r.quantity || 0);
    row.order_lines += Number(r.order_lines || 0);
    row.orders += Number(r.orders || 0);
    row.product_cost_sar += Number(r.product_cost_sar || 0);
    row.return_delivery_fee_sar += Number(r.return_delivery_fee_sar || 0);
    row.rtv_recoverable_cost_sar += Number(r.rtv_recoverable_cost_sar || 0);
    row.rtv_09_recoverable_cost_sar += Number(r.rtv_09_recoverable_cost_sar || 0);
    row.rtv_received_quantity += Number(r.rtv_received_quantity || 0);
    row.rtv_received_to_09_quantity += Number(r.rtv_received_to_09_quantity || 0);
    row.profit_before_storage_sar += Number(r.profit_before_storage_sar || 0);
    row.fallback_storage_fee_sar += Number(r.storage_fee_sar || 0);
    row.profit_if_rtv_received_resellable_sar += Number(r.profit_if_rtv_received_resellable_sar ?? r.profit_before_storage_sar ?? 0);
    row.profit_if_rtv_09_resellable_sar += Number(r.profit_if_rtv_09_resellable_sar ?? r.profit_before_storage_sar ?? 0);
    row.known_net_revenue_sar += Number(r.known_net_revenue_sar ?? r.known_gross_revenue_sar ?? 0);
    row.known_gross_revenue_sar += Number(r.known_gross_revenue_sar ?? 0);
    row.missing_cost_revenue_sar += Number(r.missing_cost_revenue_sar || 0);
    row.missing_cost_quantity += Number(r.missing_cost_quantity || 0);
    row.missing_cost_lines += Number(r.missing_cost_lines || 0);
    row.reversal_lines += Number(r.reversal_lines || 0);
  };
  const addStorageRow = (scopeValue, r) => {
    const date = String(r?.date || '').slice(0, 10);
    if (!date) return;
    const row = getRow(date, scopeValue);
    row.storage_fee_sar += Number(r.storage_fee_sar || 0);
    row.storage_matched += 1;
  };
  for (const r of rows) {
    const store = String(r?.store_key || '').trim().toUpperCase();
    if (!store) continue;
    const group = String(r?.group_key || 'OTHER').trim().toUpperCase() || 'OTHER';
    addProfitRow('', r);
    addProfitRow(`GROUP:${group}`, r);
    addProfitRow(store, r);
  }
  for (const r of storageRows) {
    const store = String(r?.store_key || '').trim().toUpperCase();
    if (!store) continue;
    const group = String(r?.group_key || 'OTHER').trim().toUpperCase() || 'OTHER';
    addStorageRow('', r);
    addStorageRow(`GROUP:${group}`, r);
    addStorageRow(store, r);
  }
  const moneyFields = [
    'gross_revenue_sar',
    'net_revenue_sar',
    'product_cost_sar',
    'return_delivery_fee_sar',
    'rtv_recoverable_cost_sar',
    'rtv_09_recoverable_cost_sar',
    'profit_before_storage_sar',
    'storage_fee_sar',
    'fallback_storage_fee_sar',
    'profit_if_rtv_received_resellable_sar',
    'profit_if_rtv_09_resellable_sar',
    'known_net_revenue_sar',
    'known_gross_revenue_sar',
    'missing_cost_revenue_sar',
  ];
  const countFields = ['quantity', 'order_lines', 'orders', 'rtv_received_quantity', 'rtv_received_to_09_quantity', 'missing_cost_quantity', 'missing_cost_lines', 'reversal_lines', 'storage_matched'];
  const dailyScopes = Array.from(map.values()).map(row => {
    const effectiveStorage = Number(row.storage_matched || 0) > 0 ? Number(row.storage_fee_sar || 0) : Number(row.fallback_storage_fee_sar || 0);
    const out = {...row};
    out.profit_after_storage_sar = Number(out.profit_before_storage_sar || 0) - effectiveStorage;
    out.profit_if_rtv_received_resellable_after_storage_sar = Number(out.profit_if_rtv_received_resellable_sar || 0) - effectiveStorage;
    out.profit_if_rtv_09_resellable_after_storage_sar = Number(out.profit_if_rtv_09_resellable_sar || 0) - effectiveStorage;
    out.cost_coverage_revenue_rate = Number(out.net_revenue_sar || 0) > 0 ? roundNumber(Number(out.known_net_revenue_sar || 0) / Number(out.net_revenue_sar || 0), 4) : null;
    out.profit_margin_after_storage = Number(out.known_net_revenue_sar || 0) > 0 ? roundNumber(out.profit_after_storage_sar / Number(out.known_net_revenue_sar || 0), 4) : null;
    for (const field of moneyFields) out[field] = roundNumber(out[field], 2);
    for (const field of ['profit_after_storage_sar', 'profit_if_rtv_received_resellable_after_storage_sar', 'profit_if_rtv_09_resellable_after_storage_sar']) out[field] = roundNumber(out[field], 2);
    for (const field of countFields) out[field] = roundNumber(out[field], 0);
    return out;
  }).sort((a, b) => String(a.date).localeCompare(String(b.date)) || Number(a.scope_order || 0) - Number(b.scope_order || 0) || String(a.scope_value || '').localeCompare(String(b.scope_value || '')));
  return {
    homeProfitSummary: {
      dailyScopes,
      source: 'profit_section_cache',
      sourceGeneratedAt: String(sourceMeta.sourceGeneratedAt || ''),
      staleSource: Boolean(sourceMeta.staleSource),
    },
  };
}

function scheduleBiSectionBackgroundGeneration(args, root, section, generatedAt, options = {}) {
  const key = `${root}|${section}|${generatedAt || ''}`;
  if (biSectionInFlight.has(key)) return true;
  const previousQueue = biSectionBackgroundQueue.catch(() => {});
  const run = previousQueue.then(async () => {
    const startedAt = Date.now();
    logBiPortalCoreWarmup('section-background-start', {section, generatedAt});
    const latestMeta = await readBiPortalCoreMeta(root).catch(() => null);
    const latestGeneratedAt = String(latestMeta?.generatedAt || '');
    if (latestGeneratedAt && generatedAt && latestGeneratedAt !== String(generatedAt || '')) {
      logBiPortalCoreWarmup('section-background-skip', {section, reason: 'core-changed', generatedAt, latestGeneratedAt});
      return null;
    }
    const currentCache = await readBiSectionCache(root, section, generatedAt).catch(() => null);
    if (currentCache) {
      logBiPortalCoreWarmup('section-background-skip', {section, reason: 'already-cached', generatedAt});
      return currentCache;
    }
    const payload = await generateBiSection(args, root, section, generatedAt);
    logBiPortalCoreWarmup('section-background-done', {section, generatedAt, durationMs: Date.now() - startedAt});
    return payload;
  }).catch(err => {
    console.warn('BI section background generation failed', section, err?.message || err);
  }).finally(() => {
    biSectionInFlight.delete(key);
  });
  biSectionInFlight.set(key, run);
  biSectionBackgroundQueue = run.catch(() => {});
  return true;
}

async function deriveHomeProfitSectionFromProfitCache(root, generatedAt) {
  const currentProfitCache = await readBiSectionCache(root, 'profit', generatedAt);
  const profitCache = currentProfitCache || await readBiSectionCacheAnyGeneratedAt(root, 'profit');
  if (!profitCache?.data?.profit) return null;
  const sourceGeneratedAt = String(profitCache.generatedAt || '');
  const data = buildHomeProfitSummaryFromProfitData(profitCache.data, {
    sourceGeneratedAt,
    staleSource: Boolean(generatedAt && sourceGeneratedAt && sourceGeneratedAt !== String(generatedAt || '')),
  });
  return writeBiSectionCache(root, 'homeProfit', generatedAt, data, {
    code: 0,
    timedOut: false,
    stderr: '',
  });
}

async function refreshProfitMarts(args) {
  if (process.env.SHEIN_BI_PROFIT_MART_REFRESH_DISABLED === '1') {
    return {
      code: 0,
      timedOut: false,
      stdout: '[refreshProfitMarts] disabled by SHEIN_BI_PROFIT_MART_REFRESH_DISABLED=1',
      stderr: '',
    };
  }
  const timeoutMs = Math.max(60_000, Number(process.env.SHEIN_BI_PROFIT_MART_REFRESH_TIMEOUT_MS || 600_000));
  const run = await runChildProcess('bash', [
    path.join(ROOT, 'scripts', 'refresh_profit_marts.sh'),
  ], {
    cwd: ROOT,
    timeoutMs,
    env: {
      SHEIN_BI_DB_CONTAINER: args.container,
      SHEIN_BI_DB_DATABASE: args.database,
      SHEIN_BI_DB_USER: args.user,
    },
  });
  if (!run.ok) {
    const tail = String(run.stderr || run.stdout || '').slice(-4000);
    throw new Error(`profit mart cache refresh failed: code=${run.code} timedOut=${run.timedOut} ${tail}`);
  }
  return run;
}

async function readProfitMartCacheFreshness(args) {
  const sql = `
SELECT jsonb_build_object(
  'factOrderMax', (SELECT max(created_date) FROM fact.order_item),
  'profitCacheMax', (SELECT max(created_date) FROM mart.profit_order_item_cache),
  'profitCacheRows', (SELECT count(*) FROM mart.profit_order_item_cache),
  'metaRefreshedAt', (SELECT max(refreshed_at) FROM mart.profit_mart_cache_meta WHERE cache_key='profit_marts' AND status='ok')
)::text;
`;
  const psql = psqlSpawnCommand(args, ' -q -t -A');
  const run = await runChildProcess(psql.command, psql.args, {
    cwd: ROOT,
    timeoutMs: Math.max(30_000, Number(process.env.SHEIN_BI_PROFIT_MART_FRESHNESS_TIMEOUT_MS || 60_000)),
    stdin: sql,
  });
  if (!run.ok) {
    const tail = String(run.stderr || run.stdout || '').slice(-1000);
    throw new Error(`profit mart freshness check failed: code=${run.code} timedOut=${run.timedOut} ${tail}`);
  }
  return JSON.parse(String(run.stdout || '{}').trim() || '{}');
}

async function ensureProfitMartCacheFresh(args, generatedAt = '') {
  if (process.env.SHEIN_BI_PROFIT_MART_REFRESH_DISABLED === '1') return null;
  if (biProfitMartFreshnessPromise) return biProfitMartFreshnessPromise;
  biProfitMartFreshnessPromise = (async () => {
    let freshness;
    try {
      freshness = await readProfitMartCacheFreshness(args);
    } catch (err) {
      const refreshed = await refreshProfitMarts(args);
      return {
        ...refreshed,
        stderr: `${refreshed.stderr || ''}\n[ensureProfitMartCacheFresh] freshness check failed; refreshed cache instead: ${err?.message || err}`,
      };
    }
    const factOrderMax = String(freshness.factOrderMax || '').slice(0, 10);
    const profitCacheMax = String(freshness.profitCacheMax || '').slice(0, 10);
    const profitCacheRows = Number(freshness.profitCacheRows || 0);
    const metaRefreshedAtMs = Date.parse(String(freshness.metaRefreshedAt || ''));
    const generatedAtMs = Date.parse(String(generatedAt || ''));
    const generatedFresh = !generatedAtMs || (Number.isFinite(metaRefreshedAtMs) && metaRefreshedAtMs >= generatedAtMs);
    if (profitCacheRows > 0 && factOrderMax && profitCacheMax >= factOrderMax && generatedFresh) {
      return {
        code: 0,
        timedOut: false,
        stdout: `[ensureProfitMartCacheFresh] cache fresh factOrderMax=${factOrderMax} profitCacheMax=${profitCacheMax} rows=${profitCacheRows} metaRefreshedAt=${freshness.metaRefreshedAt || ''} coreGeneratedAt=${generatedAt || ''}`,
        stderr: '',
      };
    }
    return refreshProfitMarts(args);
  })().finally(() => {
    biProfitMartFreshnessPromise = null;
  });
  return biProfitMartFreshnessPromise;
}

async function generateBiSection(args, root, section, generatedAt) {
  const profitBackedSections = new Set(['profit', 'homeProfit', 'homeRankings', 'rankings', 'productSalesDaily']);
  const useProfitMartCache = profitBackedSections.has(section) && process.env.SHEIN_BI_PROFIT_MART_CACHE_DISABLED !== '1';
  const sourceMode = useProfitMartCache ? 'cache' : 'view';
  const refreshRun = sourceMode === 'cache' ? await ensureProfitMartCacheFresh(args, generatedAt) : null;
  if (sourceMode === 'cache' && section === 'homeProfit') {
    const currentProfitCache = await readBiSectionCache(root, 'profit', generatedAt);
    if (!currentProfitCache) {
      const generated = await generateBiSection(args, root, 'profit', generatedAt);
      if (!generated?.data?.profit) {
        throw new Error('homeProfit requires a fresh profit section cache');
      }
    }
  }
  const run = await runChildProcess(process.execPath, [
    path.join(ROOT, 'scripts', 'generate_bi_portal.mjs'),
    '--section', section,
    '--json-only',
    '--out-dir', root,
    '--distro', args.distro,
    '--container', args.container,
    '--database', args.database,
    '--user', args.user,
  ], {
    cwd: ROOT,
    timeoutMs: BI_PORTAL_SECTION_TIMEOUT_MS,
    env: {
      SHEIN_BI_PORTAL_TIMEOUT_MS: String(Math.max(BI_PORTAL_SECTION_TIMEOUT_MS + 60_000, Number(process.env.SHEIN_BI_PORTAL_TIMEOUT_MS || 0) || 0)),
      SHEIN_BI_PROFIT_MART_SOURCE: sourceMode,
    },
  });
  if (!run.ok) {
    const tail = String(run.stderr || run.stdout || '').slice(-2000);
    throw new Error(`BI section ${section} generation failed: code=${run.code} timedOut=${run.timedOut} ${tail}`);
  }
  let data;
  try {
    data = JSON.parse(run.stdout || '{}');
  } catch (err) {
    throw new Error(`BI section ${section} returned invalid JSON: ${err?.message || err}`);
  }
  if (section === 'homeRankings') {
    data = compactHomeRankingsSectionData(data);
  }
  return writeBiSectionCache(root, section, generatedAt, data, refreshRun ? {
    ...run,
    stderr: `${run.stderr || ''}\n${refreshRun.stdout || ''}\n${refreshRun.stderr || ''}`,
  } : run);
}

function compactHomeRankingsSectionData(data) {
  if (!data?.rankings || typeof data.rankings !== 'object') return data;
  const compact = {...data, rankings: {...data.rankings}};
  for (const key of ['dailyProducts', 'dailyStoreProducts']) {
    const rows = Array.isArray(compact.rankings[key]) ? compact.rankings[key] : null;
    if (!rows) continue;
    compact.rankings[key] = rows.map(row => {
      if (!row || typeof row !== 'object') return row;
      const {
        goods_title: _goodsTitle,
        skc_list: _skcList,
        product_display_name: _productDisplayName,
        product_display_name_source: _productDisplayNameSource,
        ...rest
      } = row;
      return rest;
    });
  }
  return compact;
}

async function loadBiSection(args, root, section, options = {}) {
  const force = !!options.force;
  const allowGenerate = options.allowGenerate !== false;
  const allowStale = options.allowStale !== false;
  if (!BI_PORTAL_SECTION_KEYS.has(section)) {
    return {status: 404, payload: {ok: false, error: 'Unknown BI section', section}};
  }
  const meta = await readBiPortalCoreMeta(root);
  if (meta.mode !== 'api' && !force) {
    return {status: 400, payload: {ok: false, error: 'BI portal is not in api data mode', section, mode: meta.mode}};
  }
  if (force && options.asyncRefresh) {
    if (!allowGenerate) {
      return {status: 403, payload: {ok: false, section, error: 'Section refresh is disabled in read-only or unauthenticated LAN mode'}};
    }
    const refreshScheduled = scheduleBiSectionBackgroundGeneration(args, root, section, meta.generatedAt);
    const currentRaw = await readBiSectionCacheRaw(root, section, meta.generatedAt, true, {
      ...options,
      extraFields: {refreshScheduled, coreGeneratedAt: meta.generatedAt},
    });
    if (currentRaw) {
      return {status: 202, rawBody: currentRaw.body, headers: {...currentRaw.headers, 'X-BI-Section-Refresh-Scheduled': 'true'}};
    }
    const staleRaw = await readBiSectionStaleRaw(root, section, meta.generatedAt, {...options, refreshScheduled});
    if (staleRaw) {
      return {status: 202, rawBody: staleRaw.body, headers: {...staleRaw.headers, 'X-BI-Section-Refresh-Scheduled': 'true'}};
    }
    const stale = await readBiSectionCacheAnyGeneratedAt(root, section);
    if (stale) {
      return {status: 202, payload: {...stale, cacheHit: true, staleSection: true, cacheStale: true, refreshScheduled, coreGeneratedAt: meta.generatedAt}};
    }
    return {status: 202, payload: {ok: true, section, generatedAt: meta.generatedAt, data: {}, refreshScheduled, cacheHit: false}};
  }
  if (section === 'homeProfit') {
    const cached = !force ? await readBiSectionCache(root, section, meta.generatedAt) : null;
    const cachedSourceGeneratedAt = String(cached?.data?.homeProfitSummary?.sourceGeneratedAt || '');
    if (cached && cachedSourceGeneratedAt === String(meta.generatedAt || '')) {
      const rawCached = await readBiSectionCacheRaw(root, section, meta.generatedAt, true, options);
      if (rawCached) return {status: 200, rawBody: rawCached.body, headers: rawCached.headers};
      return {status: 200, payload: {...cached, cacheHit: true}};
    }
    if (cached && cachedSourceGeneratedAt !== String(meta.generatedAt || '')) {
      const currentProfitCache = await readBiSectionCache(root, 'profit', meta.generatedAt);
      if (!currentProfitCache) {
        const rawCached = await readBiSectionCacheRaw(root, section, meta.generatedAt, true, options);
        if (rawCached) return {status: 200, rawBody: rawCached.body, headers: rawCached.headers};
        return {status: 200, payload: {...cached, cacheHit: true}};
      }
    }
    if (!allowGenerate) {
      return {
        status: 503,
        payload: {
          ok: false,
          error: 'BI section cache miss; generation is disabled in read-only or unauthenticated LAN mode',
          section,
          generatedAt: meta.generatedAt,
        },
      };
    }
    const key = `${root}|${section}|${meta.generatedAt || ''}|derive`;
    if (!biSectionInFlight.has(key)) {
      biSectionInFlight.set(key, deriveHomeProfitSectionFromProfitCache(root, meta.generatedAt).finally(() => {
        biSectionInFlight.delete(key);
      }));
    }
    const payload = await biSectionInFlight.get(key);
    if (payload) {
      const rawGenerated = await readBiSectionCacheRaw(root, section, meta.generatedAt, false, options);
      if (rawGenerated) return {status: 200, rawBody: rawGenerated.body, headers: rawGenerated.headers};
      return {status: 200, payload: {...payload, cacheHit: false}};
    }
    return {
      status: 503,
      payload: {
        ok: false,
        section,
        generatedAt: meta.generatedAt,
        error: 'homeProfit requires a profit section cache; prewarm or request profit first',
      },
    };
  }
  if (!force) {
    const rawCached = await readBiSectionCacheRaw(root, section, meta.generatedAt, true, options);
    if (rawCached) return {status: 200, rawBody: rawCached.body, headers: rawCached.headers};
    const cached = await readBiSectionCache(root, section, meta.generatedAt);
    if (cached) return {status: 200, payload: {...cached, cacheHit: true}};
  }
  if (!allowGenerate) {
    if (!force && allowStale) {
      const staleRaw = await readBiSectionStaleRaw(root, section, meta.generatedAt, options);
      if (staleRaw) return {status: 200, rawBody: staleRaw.body, headers: staleRaw.headers};
      const stale = await readBiSectionCacheAnyGeneratedAt(root, section);
      if (stale) {
        return {status: 200, payload: {...stale, cacheHit: true, staleSection: true, cacheStale: true, coreGeneratedAt: meta.generatedAt}};
      }
    }
    return {
      status: 503,
      payload: {
        ok: false,
        error: 'BI section cache miss; generation is disabled in read-only or unauthenticated LAN mode',
        section,
        generatedAt: meta.generatedAt,
      },
    };
  }
  const key = `${root}|${section}|${meta.generatedAt || ''}`;
  if (!force && allowStale) {
    const staleRaw = await readBiSectionStaleRaw(root, section, meta.generatedAt, options);
    if (staleRaw) {
      scheduleBiSectionBackgroundGeneration(args, root, section, meta.generatedAt);
      return {status: 200, rawBody: staleRaw.body, headers: staleRaw.headers};
    }
  }
  if (!biSectionInFlight.has(key)) {
    biSectionInFlight.set(key, generateBiSection(args, root, section, meta.generatedAt).finally(() => {
      biSectionInFlight.delete(key);
    }));
  }
  const payload = await biSectionInFlight.get(key);
  const rawGenerated = await readBiSectionCacheRaw(root, section, meta.generatedAt, false, options);
  if (rawGenerated) return {status: 200, rawBody: rawGenerated.body, headers: rawGenerated.headers};
  return {status: 200, payload: {...payload, cacheHit: false}};
}


function configuredBiPortalCoreWarmupSections() {
  const raw = String(process.env.SHEIN_BI_CORE_WARMUP_SECTIONS || '').trim();
  const candidates = raw
    ? raw.split(',').map(x => x.trim()).filter(Boolean)
    : DEFAULT_BI_PORTAL_CORE_WARMUP_SECTIONS;
  const seen = new Set();
  const sections = [];
  for (const section of candidates) {
    if (!BI_PORTAL_SECTION_KEYS.has(section) || seen.has(section)) continue;
    seen.add(section);
    sections.push(section);
  }
  return sections;
}

function logBiPortalCoreWarmup(message, extra = {}) {
  const parts = Object.entries(extra)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${String(value)}`);
  console.error(`[bi-core-warmup] ${message}${parts.length ? ` ${parts.join(' ')}` : ''}`);
}

async function scheduleBiPortalCoreWarmup(args, root, options = {}) {
  if (process.env.SHEIN_BI_CORE_WARMUP_DISABLED === '1') {
    return {scheduled: false, reason: 'disabled'};
  }
  const allowGenerate = options.allowGenerate !== false;
  if (!allowGenerate) return {scheduled: false, reason: 'generation-disabled'};

  let meta;
  try {
    meta = options.meta || await readBiPortalCoreMeta(root);
  } catch (err) {
    biPortalCoreWarmupState.lastError = err?.message || String(err || 'read core meta failed');
    logBiPortalCoreWarmup('skip', {reason: 'read-meta-failed', error: biPortalCoreWarmupState.lastError});
    return {scheduled: false, reason: 'read-meta-failed'};
  }
  const generatedAt = String(meta?.generatedAt || '');
  if (meta?.mode !== 'api' || !generatedAt) {
    return {scheduled: false, reason: 'not-api-mode', mode: meta?.mode || 'unknown'};
  }
  if (biPortalCoreWarmupState.inFlight) {
    return {
      scheduled: false,
      reason: 'already-running',
      generatedAt,
      runningGeneratedAt: biPortalCoreWarmupState.generatedAt,
    };
  }
  if (biPortalCoreWarmupState.generatedAt === generatedAt && biPortalCoreWarmupState.status === 'done') {
    return {scheduled: false, reason: 'already-warm', generatedAt};
  }

  const sections = configuredBiPortalCoreWarmupSections();
  if (!sections.length) return {scheduled: false, reason: 'no-sections', generatedAt};

  const run = runBiPortalCoreWarmup(args, root, {generatedAt, mode: meta.mode}, {
    ...options,
    allowGenerate,
    sections,
  }).finally(() => {
    if (biPortalCoreWarmupState.inFlight === run) biPortalCoreWarmupState.inFlight = null;
  });
  biPortalCoreWarmupState.inFlight = run;
  return {scheduled: true, generatedAt, sections};
}

async function runBiPortalCoreWarmup(args, root, meta, options = {}) {
  const generatedAt = String(meta?.generatedAt || '');
  const sections = Array.isArray(options.sections) && options.sections.length
    ? options.sections
    : configuredBiPortalCoreWarmupSections();
  const startedAt = Date.now();
  biPortalCoreWarmupState.generatedAt = generatedAt;
  biPortalCoreWarmupState.status = 'running';
  biPortalCoreWarmupState.startedAt = startedAt;
  biPortalCoreWarmupState.finishedAt = 0;
  biPortalCoreWarmupState.lastError = '';
  logBiPortalCoreWarmup('start', {
    generatedAt,
    reason: options.reason || 'watcher',
    sections: sections.join(','),
  });

  const failures = [];
  const results = [];
  try {
    for (const section of sections) {
      const latestMeta = await readBiPortalCoreMeta(root).catch(() => meta);
      const latestGeneratedAt = String(latestMeta?.generatedAt || '');
      if (latestGeneratedAt && latestGeneratedAt !== generatedAt) {
        biPortalCoreWarmupState.status = 'stale';
        biPortalCoreWarmupState.lastError = `core generatedAt changed during warmup: ${generatedAt} -> ${latestGeneratedAt}`;
        logBiPortalCoreWarmup('stop-stale', {
          generatedAt,
          latestGeneratedAt,
          nextSection: section,
        });
        return {ok: false, stale: true, generatedAt, latestGeneratedAt, results, failures};
      }

      const sectionStartedAt = Date.now();
      try {
        const existingCache = await readBiSectionCache(root, section, generatedAt).catch(() => null);
        const existingHomeProfitSource = String(existingCache?.data?.homeProfitSummary?.sourceGeneratedAt || '');
        if (existingCache && (section !== 'homeProfit' || existingHomeProfitSource === generatedAt)) {
          results.push({section, status: 200, durationMs: Date.now() - sectionStartedAt, ok: true, cacheHit: true});
          logBiPortalCoreWarmup('section-skip-cache', {section, generatedAt});
          continue;
        }
        const result = await loadBiSection(args, root, section, {
          force: true,
          allowGenerate: options.allowGenerate !== false,
          allowStale: false,
          gzip: false,
          skipCoreWarmupWait: true,
        });
        const durationMs = Date.now() - sectionStartedAt;
        const ok = result?.status >= 200 && result.status < 300;
        results.push({section, status: result?.status || 0, durationMs, ok});
        logBiPortalCoreWarmup('section', {
          section,
          status: result?.status || 0,
          durationMs,
          cacheMode: result?.rawBody ? 'raw' : 'json',
        });
        if (!ok) failures.push({section, status: result?.status || 0, error: result?.payload?.error || 'non-2xx'});
      } catch (err) {
        const durationMs = Date.now() - sectionStartedAt;
        const error = err?.message || String(err || 'section failed');
        failures.push({section, status: 500, error});
        logBiPortalCoreWarmup('section-failed', {section, durationMs, error: error.slice(0, 500)});
      }
    }
  } catch (err) {
    const error = err?.message || String(err || 'warmup failed');
    failures.push({section: '*', status: 500, error});
    logBiPortalCoreWarmup('failed', {generatedAt, error: error.slice(0, 500)});
  } finally {
    biPortalCoreWarmupState.finishedAt = Date.now();
  }

  if (failures.length) {
    biPortalCoreWarmupState.status = 'error';
    biPortalCoreWarmupState.lastError = failures.map(x => `${x.section}:${x.error || x.status}`).join('; ').slice(0, 1000);
  } else {
    biPortalCoreWarmupState.status = 'done';
    biPortalCoreWarmupState.lastError = '';
  }
  const durationSec = Math.round((Date.now() - startedAt) / 1000);
  logBiPortalCoreWarmup('done', {
    generatedAt,
    status: biPortalCoreWarmupState.status,
    durationSec,
    failures: failures.length,
  });
  return {ok: failures.length === 0, generatedAt, results, failures};
}

function startBiPortalCoreWarmupWatcher(args, root, options = {}) {
  if (process.env.SHEIN_BI_CORE_WARMUP_DISABLED === '1') return null;
  if (options.allowGenerate === false) {
    logBiPortalCoreWarmup('disabled', {reason: 'generation-disabled'});
    return null;
  }
  const tick = () => {
    scheduleBiPortalCoreWarmup(args, root, {...options, reason: 'watcher'}).catch(err => {
      biPortalCoreWarmupState.lastError = err?.message || String(err || 'schedule failed');
      logBiPortalCoreWarmup('schedule-failed', {error: biPortalCoreWarmupState.lastError.slice(0, 500)});
    });
  };
  tick();
  const timer = setInterval(tick, BI_PORTAL_CORE_WARMUP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

async function askReadonlyOpsAgent(question, options = {}) {
  const text = String(question || '').trim();
  if (!text) throw new Error('Missing question');
  const maxQuestionChars = Math.max(2_000, Math.min(50_000, Number(process.env.SHEIN_BI_OPS_AGENT_MAX_QUESTION_CHARS || 12_000)));
  if (text.length > maxQuestionChars) throw new Error('Question too long');
  const codexSessionId = safeCodexSessionId(options.codexSessionId || '');
  const profile = options.profile && typeof options.profile === 'object'
    ? options.profile
    : selectBiOpsModelProfile({mode: options.mode || 'query', question: options.routingText || text});
  const codexMetaFile = path.join(os.tmpdir(), `shein-linkops-codex-session-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`);
  const result = await runChildProcess(process.execPath, [
    path.join(ROOT, 'scripts', 'lark_sales_qa_bot.mjs'),
    '--answer',
    text,
  ], {
    cwd: ROOT,
    timeoutMs: Math.max(20_000, Number(profile.timeoutMs || 45_000) + 10_000),
    env: {
      CODEX_HOME: process.env.CODEX_HOME || '/home/sheinops/.codex',
      SHEIN_QA_CODEX_GATEWAY_ENABLED: process.env.SHEIN_QA_CODEX_GATEWAY_ENABLED || '1',
      SHEIN_QA_CODEX_GATEWAY_TIMEOUT_MS: String(profile.timeoutMs || 45_000),
      SHEIN_QA_CODEX_MODEL: profile.model,
      SHEIN_QA_CODEX_REASONING_EFFORT: profile.reasoning,
      SHEIN_QA_CODEX_EPHEMERAL: codexSessionId ? '0' : '1',
      SHEIN_QA_LLM_ENABLED: process.env.SHEIN_BI_AGENT_ALLOW_DIRECT_LLM_FALLBACK || '0',
      SHEIN_QA_LLM_TIMEOUT_MS: process.env.SHEIN_QA_LLM_TIMEOUT_MS || '45000',
      SHEIN_QA_CODEX_SESSION_ID: codexSessionId,
      SHEIN_QA_CODEX_SESSION_META_FILE: codexMetaFile,
    },
  });
  const codexMeta = await readJsonFile(codexMetaFile, null);
  await fs.rm(codexMetaFile, {force: true}).catch(() => {});
  if (!result.ok) {
    const error = new Error(`Ops agent failed code=${result.code} timeout=${result.timedOut} stderr=${String(result.stderr || '').slice(-500)}`);
    error.status = 503;
    error.code = result.timedOut ? 'AGENT_TIMEOUT' : 'AGENT_UPSTREAM_FAILED';
    throw error;
  }
  return {
    answer: String(result.stdout || '').trim(),
    stderrTail: String(result.stderr || '').slice(-1000),
    codexSessionId: codexMeta?.sessionId || codexSessionId || '',
    codexResumed: Boolean(codexMeta?.resumed),
    profile: modelProfilePublicSummary(profile),
  };
}

async function readBodyJson(req, limitBytes = 1024 * 1024) {
  const raw = await readBodyText(req, limitBytes);
  return raw ? JSON.parse(raw) : {};
}

async function readBodyText(req, limitBytes = 1024 * 1024) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk.toString('utf8');
    if (raw.length > limitBytes) throw new Error('Request body too large');
  }
  return raw;
}

async function readFirstRunCheckSummary() {
  const mdFile = path.join(ROOT, 'outputs', 'bi_first_run_check', 'latest.md');
  const jsonFile = path.join(ROOT, 'outputs', 'bi_first_run_check', 'latest.json');
  try {
    const [mdStat, jsonStat, content, raw] = await Promise.all([
      fs.stat(mdFile),
      fs.stat(jsonFile),
      fs.readFile(mdFile, 'utf8'),
      fs.readFile(jsonFile, 'utf8'),
    ]);
    const j = JSON.parse(raw);
    const verdict = j.verdict || {};
    const warnings = Array.isArray(verdict.warnings) ? verdict.warnings : [];
    const errors = Array.isArray(verdict.errors) ? verdict.errors : [];
    return {
      exists: true,
      file: path.relative(ROOT, mdFile),
      jsonFile: path.relative(ROOT, jsonFile),
      updatedAt: new Date(Math.max(mdStat.mtimeMs, jsonStat.mtimeMs)).toISOString(),
      generatedAt: j.generatedAt || null,
      status: verdict.status || 'unknown',
      warnings: warnings.length,
      errors: errors.length,
      warningMessages: warnings,
      errorMessages: errors,
      content,
      preview: content.slice(0, 6000),
    };
  } catch (err) {
    return {
      exists: false,
      error: err?.message || String(err),
      file: path.relative(ROOT, mdFile),
      jsonFile: path.relative(ROOT, jsonFile),
    };
  }
}

async function runFirstRunCheck() {
  const script = path.join(ROOT, 'scripts', 'check_bi_first_run.mjs');
  const child = spawn(process.execPath, [script], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  child.stdout.on('data', d => { stdout += d.toString(); });
  child.stderr.on('data', d => { stderr += d.toString(); });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 60_000);
  const code = await new Promise(resolve => child.on('close', resolve));
  clearTimeout(timer);
  let parsed = null;
  try {
    parsed = stdout.trim() ? JSON.parse(stdout.trim()) : null;
  } catch {
    parsed = null;
  }
  return {
    code,
    timedOut,
    stdout: stdout.trim().slice(0, 8000),
    stderr: stderr.trim().slice(0, 4000),
    parsed,
  };
}

let firstRunCheckInFlight = false;

function sendJson(res, status, value, headers = {}) {
  send(res, status, JSON.stringify(value, null, 2), {'Content-Type': 'application/json; charset=utf-8', ...headers});
}

function agentErrorHttpDetails(error) {
  const status = Number(error?.status || 0);
  const safeStatus = status >= 400 && status <= 599 ? status : 503;
  const retryAfterSec = Math.max(0, Number(error?.retryAfterSec || 0));
  return {
    status: safeStatus,
    headers: retryAfterSec ? {'Retry-After': String(Math.ceil(retryAfterSec))} : {},
    body: {
      ok: false,
      error: safeStatus === 429
        ? String(error?.message || '智能运营请求过于频繁，请稍后再试')
        : '智能运营服务暂时不可用，请稍后重试',
      code: String(error?.code || 'AGENT_UNAVAILABLE'),
      retryAfterSec,
    },
  };
}

function requestedAgentProfile(actor, requestedValue, options = {}) {
  const requested = String(requestedValue || '').trim().toLowerCase();
  const profiles = biOpsModelProfiles();
  if (requested && !profiles[requested]) {
    const error = new Error('不支持的智能运营模型档位');
    error.status = 400;
    error.code = 'AGENT_PROFILE_INVALID';
    throw error;
  }
  if (requested === 'owner' && !actorHasGlobalOpsView(actor)) {
    const error = new Error('只有 owner/admin 可以显式使用 owner 模型档位');
    error.status = 403;
    error.code = 'AGENT_PROFILE_FORBIDDEN';
    throw error;
  }
  if (requested === 'deep' && !actorHasGlobalOpsView(actor)) {
    const error = new Error('只有 owner/admin 可以手动指定 deep；系统仍会按任务风险自动升级');
    error.status = 403;
    error.code = 'AGENT_PROFILE_FORBIDDEN';
    throw error;
  }
  return selectBiOpsModelProfile({
    profile: requested,
    mode: options.mode || 'query',
    question: options.question || '',
    intents: options.intents || [],
    stores: options.stores || [],
    actorRole: actor?.role || '',
    ownerEscalation: requested === 'owner',
  });
}

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safePath(root, requestUrl) {
  const url = new URL(requestUrl, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname || '/');
  if (pathname === '/') pathname = '/index.html';
  pathname = pathname.replace(/^\/+/, '');
  const resolved = path.resolve(root, pathname);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    return null;
  }
  return resolved;
}

const NOVNC_ROOT_CANDIDATES = [
  '/usr/share/novnc',
  '/usr/share/novnc-pkg',
  path.join(ROOT, 'vendor', 'novnc'),
];

function novncRoot() {
  return NOVNC_ROOT_CANDIDATES.find(p => fssync.existsSync(path.join(p, 'vnc.html'))) || '';
}

function manualLoginScriptArgs(args, command, extra = []) {
  return [
    path.join(ROOT, 'scripts', 'cloud_manual_login_session.mjs'),
    command,
    '--state-file', args.manualLoginStateFile,
    '--base-path', '/cloud-login/session',
    ...extra,
  ];
}

function parseJsonStdout(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const idx = text.lastIndexOf('\n{');
  if (idx >= 0) {
    try { return JSON.parse(text.slice(idx + 1)); } catch {}
  }
  return null;
}

async function runManualLoginHelper(args, command, extra = [], timeoutMs = 180_000) {
  const result = await runChildProcess(process.execPath, manualLoginScriptArgs(args, command, extra), {
    timeoutMs,
    env: {
      SHEIN_MANUAL_LOGIN_STATE_FILE: args.manualLoginStateFile,
      SHEIN_MANUAL_LOGIN_LOG_DIR: process.env.SHEIN_MANUAL_LOGIN_LOG_DIR || '/srv/shein-bi/logs/cloud-manual-login',
    },
  });
  const parsed = parseJsonStdout(result.stdout);
  if (!result.ok || !parsed) {
    const err = String(result.stderr || result.stdout || `manual login helper failed code=${result.code}`).slice(-1200);
    return {ok: false, error: err, run: result};
  }
  return parsed;
}

async function readManualLoginState(args) {
  const state = await readJsonFile(args.manualLoginStateFile, {version: 1, updatedAt: null, sessions: []});
  return {
    version: 1,
    updatedAt: state?.updatedAt || null,
    sessions: Array.isArray(state?.sessions) ? state.sessions : [],
  };
}

async function findManualLoginSession(args, id, token) {
  const state = await readManualLoginState(args);
  const session = state.sessions.find(s => String(s.id || '') === String(id || ''));
  if (!session) return {ok: false, status: 404, error: 'Session not found'};
  if (String(session.token || '') !== String(token || '')) return {ok: false, status: 403, error: 'Invalid token'};
  if (!['active', 'starting'].includes(String(session.status || ''))) return {ok: false, status: 410, error: `Session is ${session.status || 'not active'}`};
  if (session.expiresAt && new Date(session.expiresAt).getTime() < Date.now()) return {ok: false, status: 410, error: 'Session expired'};
  return {ok: true, session};
}

async function manualLoginMaintenanceHtml(actor) {
  const writableStores = (await manualLoginStoreKeys()).filter(storeKey => actorCanWriteStores(actor, [storeKey]));
  const manualStoresJson = JSON.stringify(writableStores).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SHEIN 登录维护中心</title>
  <style>
    :root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--text:#111827;--muted:#6b7280;--line:#e5e7eb;--brand:#2563eb;--good:#059669;--warn:#d97706;--bad:#dc2626}
    @media (prefers-color-scheme:dark){:root{--bg:#0b1120;--card:#111827;--text:#e5e7eb;--muted:#94a3b8;--line:#263244;--brand:#60a5fa}}
    body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    header{position:sticky;top:0;background:color-mix(in srgb,var(--card) 92%,transparent);backdrop-filter:blur(12px);border-bottom:1px solid var(--line);padding:18px 24px;z-index:2}
    h1{margin:0;font-size:22px} .sub{color:var(--muted);margin-top:4px}
    main{max-width:1180px;margin:0 auto;padding:24px}
    .grid{display:grid;grid-template-columns:360px 1fr;gap:18px}
    .card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:18px;box-shadow:0 12px 30px rgba(15,23,42,.06)}
    label{display:block;margin:12px 0 6px;color:var(--muted)} select,input{width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:12px;padding:11px 12px;background:transparent;color:var(--text)}
    button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:0;border-radius:12px;background:var(--brand);color:white;padding:10px 14px;font-weight:700;cursor:pointer;text-decoration:none}
    button.secondary{background:#64748b}.danger{background:var(--bad)}.good{background:var(--good)}
    .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.status{display:inline-flex;border-radius:999px;padding:3px 9px;font-size:12px;background:#e2e8f0;color:#334155}.status.active{background:#dcfce7;color:#166534}.status.bad{background:#fee2e2;color:#991b1b}
    table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid var(--line);padding:10px;text-align:left;vertical-align:top}th{color:var(--muted);font-weight:600}
    .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.hint{color:var(--muted);font-size:13px}.msg{white-space:pre-wrap;border-radius:12px;background:rgba(148,163,184,.14);padding:12px;margin-top:12px}
  </style>
</head>
<body>
  <header><h1>SHEIN 登录维护中心</h1><div class="sub">云端临时浏览器入口。只在需要人工登录时打开；完成后请点“我已完成并关闭”。</div></header>
  <main class="grid">
    <section class="card">
      <h2>开启临时登录窗口</h2>
      <label>店铺</label><select id="store"></select>
      <label>打开页面</label><select id="target"><option value="sbn">SBN 商品分析 / 链接表现</option><option value="order">订单后台</option><option value="home">后台首页</option></select>
      <label>有效时间</label><select id="minutes"><option value="30">30 分钟</option><option value="15">15 分钟</option><option value="60">60 分钟</option></select>
      <div class="row" style="margin-top:16px"><button id="start">打开云端登录窗口</button><button class="secondary" id="refresh">刷新状态</button></div>
      <p class="hint">说明：窗口会使用该店云端独立 profile；不会显示或记录密码/cookie。若遇到验证码/滑块，你在远程窗口里手动处理即可。</p>
      <div id="message" class="msg" hidden></div>
    </section>
    <section class="card">
      <div class="row" style="justify-content:space-between"><h2>当前会话</h2><a class="btn secondary" href="/">返回 BI</a></div>
      <div id="sessions"></div>
    </section>
  </main>
  <script>
    const STORES = ${manualStoresJson};
    let SESSION_TOKENS = new Map();
    const $ = id => document.getElementById(id);
    const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    function sameOriginUrl(value){
      try {
        const parsed = new URL(String(value || ''), location.origin);
        return parsed.origin === location.origin && (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.href : '';
      } catch { return ''; }
    }
    $('store').innerHTML = STORES.map(s => '<option value="'+esc(s)+'">'+esc(s)+'</option>').join('');
    function msg(text){ const el=$('message'); el.hidden=false; el.textContent=text; }
    async function api(url, opts={}){
      const r = await fetch(url, {headers:{'Content-Type':'application/json'}, ...opts});
      const j = await r.json().catch(()=>({ok:false,error:'Invalid JSON'}));
      if(!r.ok || j.ok===false) throw new Error(j.error || ('HTTP '+r.status));
      return j;
    }
    function sessionRow(s){
      const status = String(s.status || 'unknown');
      const active = status === 'active' || status === 'starting';
      const canControl = active || status === 'expired' || (s.alive && Object.values(s.alive).some(Boolean));
      const openUrl = sameOriginUrl(s.openUrl);
      const open = active && openUrl ? '<a class="btn" target="_blank" rel="noopener noreferrer" href="'+esc(openUrl)+'">进入窗口</a>' : '';
      const id = esc(s.id);
      const controls = canControl ? '<button type="button" class="good" data-finish="'+id+'">我已完成并关闭</button><button type="button" class="danger" data-close="'+id+'">直接关闭</button>' : '';
      return '<tr><td><b>'+esc(s.storeKey)+'</b><br><span class="hint">'+esc(s.shopName||'')+'</span></td><td><span class="status '+(active?'active':(status==='expired'?'bad':''))+'">'+esc(status)+'</span><br><span class="hint">过期 '+esc(s.expiresAt||'-')+'</span></td><td class="mono">'+id+'</td><td><div class="row">'+open+controls+'</div></td></tr>';
    }
    async function refresh(){
      const j = await api('/api/cloud-login/sessions');
      const sessions = j.sessions || [];
      SESSION_TOKENS = new Map(sessions.map(s => [String(s.id || ''), String(s.token || '')]));
      $('sessions').innerHTML = sessions.length ? '<table><thead><tr><th>店铺</th><th>状态</th><th>会话</th><th>操作</th></tr></thead><tbody>'+sessions.map(sessionRow).join('')+'</tbody></table>' : '<p class="hint">当前没有临时登录窗口。</p>';
      document.querySelectorAll('[data-finish]').forEach(b=>b.onclick=async()=>{ b.disabled=true; try{ await api('/api/cloud-login/sessions/'+encodeURIComponent(b.dataset.finish)+'/finish',{method:'POST',body:JSON.stringify({token:SESSION_TOKENS.get(String(b.dataset.finish||''))||''})}); msg('已导出登录态并关闭窗口。'); await refresh(); }catch(e){ msg('完成失败：'+e.message); b.disabled=false; }});
      document.querySelectorAll('[data-close]').forEach(b=>b.onclick=async()=>{ b.disabled=true; try{ await api('/api/cloud-login/sessions/'+encodeURIComponent(b.dataset.close)+'/close',{method:'POST',body:JSON.stringify({token:SESSION_TOKENS.get(String(b.dataset.close||''))||''})}); msg('已关闭窗口。'); await refresh(); }catch(e){ msg('关闭失败：'+e.message); b.disabled=false; }});
    }
    $('refresh').onclick = refresh;
    $('start').onclick = async () => {
      $('start').disabled = true;
      try {
        const j = await api('/api/cloud-login/sessions', {method:'POST', body:JSON.stringify({storeKey:$('store').value,target:$('target').value,expiresMinutes:Number($('minutes').value)})});
        msg('已开启 '+j.session.storeKey+' 临时登录窗口。新窗口打开后请完成登录，再回本页点“我已完成并关闭”。');
        await refresh();
        const openUrl = sameOriginUrl(j.session.openUrl);
        if(!openUrl) throw new Error('服务器返回了不安全的窗口地址');
        window.open(openUrl, '_blank', 'noopener,noreferrer');
      } catch(e) { msg('开启失败：'+e.message); }
      finally { $('start').disabled = false; }
    };
    refresh().catch(e=>msg('读取状态失败：'+e.message));
  </script>
</body>
</html>`;
}

function manualLoginSessionHtml(session, token) {
  const pathParam = `api/cloud-login/sessions/${encodeURIComponent(session.id)}/ws/${encodeURIComponent(token)}`;
  const vncUrl = `/cloud-login/novnc/vnc.html?autoconnect=1&resize=scale&path=${encodeURIComponent(pathParam)}`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(session.storeKey)} 云端登录窗口</title><style>body{margin:0;background:#0f172a;color:#e5e7eb;font:14px system-ui}.bar{height:48px;display:flex;align-items:center;justify-content:space-between;padding:0 14px;background:#111827;border-bottom:1px solid #243044}.bar b{font-size:16px}.bar a{color:#93c5fd}iframe{display:block;width:100vw;height:calc(100vh - 48px);border:0;background:#111}</style></head><body><div class="bar"><b>${htmlEscape(session.storeKey)} 云端 SHEIN 登录窗口</b><span>有效期至 ${htmlEscape(session.expiresAt || '-')}；登录完成后回“登录维护中心”点完成关闭。 <a href="/cloud-login-maintenance">返回维护中心</a></span></div><iframe src="${htmlEscape(vncUrl)}" allow="clipboard-read; clipboard-write"></iframe></body></html>`;
}

async function serveNovncAsset(req, res, url) {
  const root = novncRoot();
  if (!root) return send(res, 503, 'noVNC is not installed', {'Content-Type': 'text/plain; charset=utf-8'});
  let rel = decodeURIComponent(url.pathname.replace(/^\/cloud-login\/novnc\/?/, ''));
  if (!rel) rel = 'vnc.html';
  const file = path.resolve(root, rel);
  const rootResolved = path.resolve(root);
  if (file !== rootResolved && !file.startsWith(rootResolved + path.sep)) {
    return send(res, 403, 'Forbidden', {'Content-Type': 'text/plain; charset=utf-8'});
  }
  try {
    const st = await fs.stat(file);
    const finalFile = st.isDirectory() ? path.join(file, 'vnc.html') : file;
    const data = await fs.readFile(finalFile);
    const ext = path.extname(finalFile).toLowerCase();
    return send(res, 200, data, {'Content-Type': types[ext] || 'application/octet-stream'});
  } catch {
    return send(res, 404, 'Not found', {'Content-Type': 'text/plain; charset=utf-8'});
  }
}

async function handleManualLoginWsUpgrade(req, socket, args, {authRequired, authUsers, sessionSecret}) {
  const fail = (status, text) => {
    try {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${text}`);
    } catch {}
    try { socket.destroy(); } catch {}
  };
  const url = new URL(req.url || '/', 'http://localhost');
  const m = /^\/api\/cloud-login\/sessions\/([^/]+)\/ws\/([^/]+)$/.exec(url.pathname);
  if (!m) return fail(404, 'Not Found');
  const id = decodeURIComponent(m[1]);
  const token = decodeURIComponent(m[2]);
  const found = await findManualLoginSession(args, id, token);
  if (!found.ok) return fail(found.status || 403, found.error || 'Forbidden');
  const trustedInternal = authRequired && isTrustedInternalRequest(req);
  const actor = authRequired ? (authenticateRequest(req, authUsers, sessionSecret) || (trustedInternal ? internalActor() : null)) : null;
  if (authRequired && !actor) return fail(401, 'Authentication required');
  if (authRequired && requireWriteStores(actor, [found.session.storeKey])) return fail(403, 'Store write permission required');
  const port = Number(found.session.websockifyPort);
  if (!Number.isInteger(port) || port <= 0) return fail(503, 'Bad websockify port');
  const upstream = net.createConnection({host: '127.0.0.1', port}, () => {
    const headers = {...req.headers, host: `127.0.0.1:${port}`};
    const lines = [`GET /websockify HTTP/1.1`];
    for (const [key, value] of Object.entries(headers)) {
      if (Array.isArray(value)) for (const v of value) lines.push(`${key}: ${v}`);
      else if (value !== undefined) lines.push(`${key}: ${value}`);
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => fail(502, 'Websocket upstream unavailable'));
  socket.on('error', () => { try { upstream.destroy(); } catch {} });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const linkOpsStoreGateway = createConfiguredLinkOpsStoreGateway({
    env: process.env,
    rootDir: ROOT,
    taskFile: args.linkOpsTaskFile,
    sessionFile: args.linkOpsChatFile,
    actionFile: args.stateFile,
    runtimeFile: args.linkOpsRuntimeFile,
  });
  Object.defineProperty(args, 'linkOpsStoreGateway', {
    value: linkOpsStoreGateway,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  const initialLinkOpsStorageHealth = await linkOpsStoreGateway.health();
  if (!initialLinkOpsStorageHealth?.ok) {
    throw new Error('Link Ops storage health check failed');
  }
  const ownerKnowledgeGitRepoDir = String(process.env.SHEIN_OWNER_KNOWLEDGE_GIT_REPO_DIR || '').trim();
  const ownerKnowledgeDistributionPublisher = ownerKnowledgeGitRepoDir
    ? createOwnerKnowledgeGitPublisher({
        repoDir: ownerKnowledgeGitRepoDir,
        branch: process.env.SHEIN_OWNER_KNOWLEDGE_GIT_BRANCH || 'owner-knowledge',
        remote: process.env.SHEIN_OWNER_KNOWLEDGE_GIT_REMOTE || 'origin',
        lockFile: process.env.SHEIN_OWNER_KNOWLEDGE_GIT_LOCK_FILE || '',
      })
    : null;
  const ownerKnowledgeService = createOwnerKnowledgeService({
    repository: linkOpsStoreGateway.repository,
    authorityId: process.env.SHEIN_OWNER_KNOWLEDGE_PRINCIPAL || 'dushengyi',
    distributionPublisher: ownerKnowledgeDistributionPublisher,
  });
  const withOwnerKnowledgeConsistencyLock = createAsyncExclusiveRunner();
  let ownerKnowledgeGeneration = 0;
  Object.defineProperty(args, 'ownerKnowledgeService', {
    value: ownerKnowledgeService,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  Object.defineProperty(args, 'withOwnerKnowledgeConsistencyLock', {
    value: withOwnerKnowledgeConsistencyLock,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  Object.defineProperty(args, 'getOwnerKnowledgeGeneration', {
    value: () => ownerKnowledgeGeneration,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  Object.defineProperty(args, 'bumpOwnerKnowledgeGeneration', {
    value: () => { ownerKnowledgeGeneration += 1; return ownerKnowledgeGeneration; },
    enumerable: false,
    configurable: false,
    writable: false,
  });
  const initialOwnerKnowledgeDistribution = await ownerKnowledgeService.ensureDistribution({actorUser: 'portal-startup'});
  Object.defineProperty(args, 'initialOwnerKnowledgeDistribution', {
    value: initialOwnerKnowledgeDistribution,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  const ownerKnowledgeReconcileMs = Math.max(
    5 * 60_000,
    Number(process.env.SHEIN_OWNER_KNOWLEDGE_RECONCILE_MS || 60 * 60_000)
  );
  const ownerKnowledgeReconcileTimer = setInterval(() => {
    ownerKnowledgeService.ensureDistribution({actorUser: 'portal-reconcile'}).then(result => {
      if (result?.error || result?.pending) {
        return appendAudit(args.auditFile, {
          at: new Date().toISOString(),
          type: 'owner-knowledge-distribution-pending',
          result: {source: result.source, fingerprint: result.fingerprint, activeFingerprint: result.activeFingerprint, error: result.error},
        });
      }
      return null;
    }).catch(error => console.error(`[owner-knowledge-distribution] ${String(error?.message || error)}`));
  }, ownerKnowledgeReconcileMs);
  ownerKnowledgeReconcileTimer.unref?.();
  const root = path.resolve(args.dir);
  const indexFile = path.join(root, 'index.html');
  if (!fssync.existsSync(indexFile)) {
    throw new Error(`BI portal not found: ${indexFile}. Run scripts/run_bi_daily_pipeline.ps1 first.`);
  }
  const authRequired = !args.noAuth && !args.readOnly;
  const authUsers = authRequired ? await loadPortalUsers(args) : [];
  if (authRequired && authUsers.length === 0) {
    throw new Error(`BI portal requires at least one user from ${args.authFile}, ${args.htpasswdFile}, or infra/metabase/.admin.local.json`);
  }
  const sessionSecret = authRequired ? await ensureSessionSecret(args.sessionSecretFile) : '';
  const allowGenerateSections = !(args.readOnly || (args.host === '0.0.0.0' && !authRequired));
  const loginRateLimiter = createLoginRateLimiter();
  const enqueueMutationRequest = createSerialMutationQueue();
  const opsAgentGovernor = createBiOpsAgentGovernor({
    maxConcurrent: Number(process.env.SHEIN_BI_AGENT_MAX_CONCURRENT || 2),
    maxConcurrentPerActor: Number(process.env.SHEIN_BI_AGENT_MAX_CONCURRENT_PER_ACTOR || 1),
    maxQueue: Number(process.env.SHEIN_BI_AGENT_MAX_QUEUE || 12),
    maxQueuedPerActor: Number(process.env.SHEIN_BI_AGENT_MAX_QUEUED_PER_ACTOR || 3),
    rateLimit: Number(process.env.SHEIN_BI_AGENT_RATE_LIMIT || 12),
    rateWindowMs: Number(process.env.SHEIN_BI_AGENT_RATE_WINDOW_MS || 10 * 60_000),
    queueTimeoutMs: Number(process.env.SHEIN_BI_AGENT_QUEUE_TIMEOUT_MS || 30_000),
    failureThreshold: Number(process.env.SHEIN_BI_AGENT_FAILURE_THRESHOLD || 4),
    failureWindowMs: Number(process.env.SHEIN_BI_AGENT_FAILURE_WINDOW_MS || 5 * 60_000),
    circuitCooldownMs: Number(process.env.SHEIN_BI_AGENT_CIRCUIT_COOLDOWN_MS || 2 * 60_000),
  });

  const intentPlannerEnabled = String(
    process.env.SHEIN_BI_INTENT_PLANNER_ENABLED
    ?? (linkOpsStoreGateway.mode === 'postgres' ? '1' : '0')
  ).trim() === '1';
  const jobWorkerEnabled = String(
    process.env.SHEIN_BI_JOB_WORKER_ENABLED
    ?? (linkOpsStoreGateway.mode === 'postgres' ? '1' : '0')
  ).trim() === '1';
  const intentPlannerCodexArgsPrefix = (() => {
    const raw = String(process.env.SHEIN_BI_CODEX_ARGS_PREFIX_JSON || '').trim();
    if (!raw) return [];
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('SHEIN_BI_CODEX_ARGS_PREFIX_JSON must be valid JSON');
    }
    if (!Array.isArray(parsed) || parsed.length > 16 || parsed.some(entry => typeof entry !== 'string' || !entry || entry.length > 1_000 || entry.includes('\0'))) {
      throw new Error('SHEIN_BI_CODEX_ARGS_PREFIX_JSON must be an array of 1-16 safe strings');
    }
    return parsed;
  })();

  function intentPlannerActorSnapshot(actor) {
    return {
      username: String(actor?.username || '').trim(),
      displayName: String(actor?.displayName || '').trim(),
      role: String(actor?.role || '').trim(),
      ownerKey: String(actor?.ownerKey || '').trim(),
      readStores: normalizeStoreList(actor?.readStores || []),
      writeStores: normalizeStoreList(actor?.writeStores || []),
    };
  }

  function intentPlannerContext(task, session) {
    return {
      task: task ? {
        id: String(task.id || ''),
        status: String(task.status || ''),
        command: String(task.command || '').slice(0, 2_000),
        intents: asArray(task.intents).slice(0, 20),
        targets: normalizeLinkOpsTargetSet(task.targets || {}),
      } : null,
      session: session ? {
        id: String(session.id || ''),
        targets: normalizeLinkOpsTargetSet(session.targets || {}),
        messages: recentCloudAiMessages(session.messages)
          .filter(message => message?.role === 'user')
          .slice(-6)
          .map(message => ({role: 'user', content: String(message.content || '').slice(0, 1_000)})),
      } : null,
      ownerKnowledge: task?.ownerKnowledgePolicy && typeof task.ownerKnowledgePolicy === 'object'
        ? task.ownerKnowledgePolicy
        : null,
    };
  }

  function intentPlannerTaskSnapshot(task) {
    const repositoryRevision = Number(task?.repositoryRevision);
    const businessState = {
      command: String(task?.command || ''),
      status: String(task?.status || ''),
      progress: normalizeProgress(task?.progress, 0),
      intents: asArray(task?.intents).map(String),
      targets: normalizeLinkOpsTargetSet(task?.targets || {}),
      lifecycle: task?.lifecycle && typeof task.lifecycle === 'object' ? task.lifecycle : null,
      preflight: task?.preflight && typeof task.preflight === 'object' ? task.preflight : null,
      execution: task?.execution && typeof task.execution === 'object' ? task.execution : null,
      assets: asArray(task?.assets),
      ownerKnowledgePolicy: task?.ownerKnowledgePolicy && typeof task.ownerKnowledgePolicy === 'object'
        ? task.ownerKnowledgePolicy
        : null,
    };
    return {
      repositoryRevision: Number.isSafeInteger(repositoryRevision) && repositoryRevision > 0 ? repositoryRevision : null,
      updatedAt: String(task?.updatedAt || ''),
      fingerprint: linkOpsPayloadHash(businessState),
    };
  }

  function intentPlannerTaskSnapshotIsStale(queuedSnapshot, task) {
    // Jobs created before snapshot binding (or with malformed payloads) are
    // fail-closed. They may finish as stale, but can never alter a newer task.
    if (!queuedSnapshot || typeof queuedSnapshot !== 'object') return true;
    const queuedFingerprint = String(queuedSnapshot.fingerprint || '');
    if (!/^[a-f0-9]{64}$/i.test(queuedFingerprint)) return true;
    const current = intentPlannerTaskSnapshot(task);
    const queuedRevision = Number(queuedSnapshot.repositoryRevision);
    const revisionChanged = Number.isSafeInteger(queuedRevision) && queuedRevision > 0
      && Number.isSafeInteger(current.repositoryRevision) && current.repositoryRevision > 0
      && queuedRevision !== current.repositoryRevision;
    const fingerprintChanged = queuedFingerprint !== current.fingerprint;
    return revisionChanged || fingerprintChanged;
  }

  async function enqueueIntentPlanJob({task, session, message, actor, req}) {
    if (!intentPlannerEnabled || !task?.id || !session?.id) return null;
    let taskForJob = task;
    try {
      const freshTaskStore = normalizeLinkOpsTaskStore(await readLinkOpsTaskStore(args));
      const freshTask = freshTaskStore.tasks.find(row => String(row?.id || '') === String(task.id || ''));
      if (freshTask) taskForJob = freshTask;
    } catch {}
    const ownerUser = actorUser(actor, req);
    const latestMessage = asArray(session.messages).at(-1);
    const idempotencySeed = {
      kind: 'intent_plan',
      taskId: taskForJob.id,
      sessionId: session.id,
      messageId: latestMessage?.id || '',
      message: String(message || '').slice(0, 4_000),
      ownerKnowledgeFingerprint: String(taskForJob?.ownerKnowledgePolicy?.fingerprint || ''),
    };
    const digest = linkOpsPayloadHash(idempotencySeed);
    const jobId = `job_intent_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${digest.slice(0, 12)}`;
    const idempotencyKey = `intent-plan:${digest}`;
    const job = await linkOpsStoreGateway.enqueueJob({
      id: jobId,
      kind: 'intent_plan',
      taskId: String(taskForJob.id),
      chatSessionId: String(session.id),
      ownerUser,
      actorUser: ownerUser,
      writeBoundary: 'none',
      payload: {
        kind: 'intent_plan',
        message: String(message || '').slice(0, 4_000),
        actor: intentPlannerActorSnapshot(actor),
        context: intentPlannerContext(taskForJob, session),
        ownerKnowledgeFingerprint: String(taskForJob?.ownerKnowledgePolicy?.fingerprint || ''),
        taskSnapshot: intentPlannerTaskSnapshot(taskForJob),
      },
      queuedAt: new Date().toISOString(),
    }, {idempotencyKey, ownerUser, actorUser: ownerUser});
    linkOpsJobWorker?.wake();
    return job;
  }

  function publicLinkOpsJob(job) {
    if (!job) return null;
    return {
      id: String(job.jobId || job.id || ''),
      kind: String(job.kind || job.type || job.payload?.kind || ''),
      taskId: String(job.taskId || ''),
      chatSessionId: String(job.chatSessionId || ''),
      status: String(job.status || ''),
      writeBoundary: String(job.writeBoundary || 'none'),
      attempt: Number(job.attempt || 0),
      queuedAt: job.queuedAt || null,
      startedAt: job.startedAt || null,
      finishedAt: job.finishedAt || null,
      result: job.result && typeof job.result === 'object' ? {
        summary: String(job.result.summary || '').slice(0, 500),
        requestType: String(job.result.requestType || ''),
        taskId: String(job.result.taskId || job.taskId || ''),
        applied: Boolean(job.result.applied),
        plannerDowngradeIgnored: Boolean(job.result.plannerDowngradeIgnored),
        plannerFactsIgnored: Boolean(job.result.plannerFactsIgnored),
        advisoryOnly: Boolean(job.result.advisoryOnly),
        staleIgnored: Boolean(job.result.staleIgnored),
        chatFeedbackSuppressed: Boolean(job.result.chatFeedbackSuppressed),
      } : {},
      error: job.error && typeof job.error === 'object' ? {
        code: String(job.error.code || '').slice(0, 120),
        message: String(job.error.message || '').slice(0, 500),
        retryable: Boolean(job.error.retryable),
      } : {},
    };
  }

  function actorCanReadLinkOpsJob(actor, job, {globalView = false} = {}) {
    if (globalView && actorHasGlobalOpsView(actor)) return true;
    return actorOpsKey(actor) === normalizeOpsActorKey(job?.ownerUser || job?.actorUser || '');
  }

  async function applyIntentPlanJob(job) {
    const payload = job.payload && typeof job.payload === 'object' ? job.payload : {};
    const actor = payload.actor && typeof payload.actor === 'object' ? payload.actor : {};
    const message = String(payload.message || '').trim();
    if (!message) throw Object.assign(new Error('Intent-plan job is missing its message'), {code: 'MISSING_MESSAGE'});
    const queuedKnowledgeFingerprint = String(payload.ownerKnowledgeFingerprint || payload.context?.ownerKnowledge?.fingerprint || '');
    if (queuedKnowledgeFingerprint) {
      const currentKnowledge = await ownerKnowledgeService.getActiveBundle({
        question: message,
        command: payload.context?.task?.command || '',
        intents: payload.context?.task?.intents || [],
        stores: payload.context?.task?.targets?.stores || [],
        productRefs: payload.context?.task?.targets?.productRefs || [],
        targets: payload.context?.task?.targets || {},
      }, {limit: 20});
      if (currentKnowledge.fingerprint !== queuedKnowledgeFingerprint) {
        return {
          applied: false,
          taskId: job.taskId,
          requestType: 'advisory',
          summary: '负责人长期规则已更新；过期的后台理解结果已忽略。',
          confidence: 0,
          factsChanged: false,
          plannerDowngradeIgnored: false,
          plannerFactsIgnored: false,
          advisoryOnly: true,
          staleIgnored: true,
          chatFeedbackSuppressed: true,
        };
      }
    }
    const profile = selectBiOpsModelProfile({profile: 'balanced'}, process.env);
    const allowedStores = [...SHEIN_STORE_KEYS];
    const plan = await opsAgentGovernor.run(actorOpsKey(actor), () => runBiOpsIntentPlanner({
      message,
      context: payload.context || {},
    }, {
      allowedStores,
      model: profile.model,
      reasoning: profile.reasoning,
      timeoutMs: profile.timeoutMs,
      codexBin: process.env.SHEIN_BI_CODEX_BIN || 'codex',
      codexArgsPrefix: intentPlannerCodexArgsPrefix,
      env: {
        ...process.env,
        CODEX_HOME: process.env.CODEX_HOME || '/home/sheinops/.codex',
      },
    }), {tier: profile.name, kind: 'intent-plan', sessionId: job.chatSessionId});

    return enqueueMutationRequest(async () => {
      const taskStore = normalizeLinkOpsTaskStore(await readLinkOpsTaskStore(args));
      const taskIndex = taskStore.tasks.findIndex(task => String(task?.id || '') === String(job.taskId || ''));
      if (taskIndex < 0) throw Object.assign(new Error('Intent-plan task no longer exists'), {code: 'TASK_NOT_FOUND'});
      const access = authorizeLinkOpsRecord(actor, taskStore.tasks[taskIndex], {kind: 'task', mode: 'mutate'});
      if (!access.ok) throw Object.assign(new Error(access.denied?.error || 'Intent-plan task ownership changed'), {code: 'TASK_ACCESS_DENIED'});
      const task = access.record;
      if (intentPlannerTaskSnapshotIsStale(payload.taskSnapshot, task)) {
        return {
          applied: false,
          taskId: task.id,
          requestType: plan.requestType,
          summary: '结构化理解完成时任务已被后续指令更新；过期结果已忽略。',
          confidence: plan.confidence,
          factsChanged: false,
          plannerDowngradeIgnored: false,
          plannerFactsIgnored: false,
          advisoryOnly: true,
          staleIgnored: true,
          chatFeedbackSuppressed: true,
        };
      }
      const previousTargets = normalizeLinkOpsTargetSet(task.targets || {});
      const previousIntents = asArray(task.intents).map(String);
      const existingActionIntents = previousIntents.filter(intent => BI_OPS_ACTION_INTENT_SET.has(intent));
      const existingActionTask = existingActionIntents.length > 0;
      const plannerIsActionPlan = ['action', 'mixed'].includes(plan.requestType);
      // The deterministic state machine has already created an action task from
      // the user's explicit command. A slower model pass is advisory only: it
      // cannot downgrade or expand intents, stores, products or parameters.
      const plannerDowngradeIgnored = existingActionTask && !plannerIsActionPlan;
      let candidateAdapted = null;
      if (plannerIsActionPlan) {
        candidateAdapted = biOpsIntentPlanToTaskInput(plan, {allowedStores, command: task.command || message});
        if (!existingActionTask) {
          const writeDenied = requireWriteStores(actor, candidateAdapted.targets.writeStores);
          const readDenied = requireReadStores(actor, candidateAdapted.targets.sourceStores);
          if (writeDenied || readDenied) {
            throw Object.assign(new Error((writeDenied || readDenied).error), {code: 'INTENT_PLAN_PERMISSION_DENIED'});
          }
        }
      }
      const candidateTargets = candidateAdapted
        ? normalizeTargetsForIntents(
            [...previousIntents, ...candidateAdapted.intents],
            mergeLinkOpsTargets(previousTargets, candidateAdapted.targets)
          )
        : previousTargets;
      const candidateIntents = candidateAdapted
        ? normalizeIntentsForCommand([...previousIntents, ...candidateAdapted.intents], task.command || message)
        : previousIntents;
      const plannerFactsIgnored = existingActionTask && Boolean(candidateAdapted) && (
        JSON.stringify(previousTargets) !== JSON.stringify(candidateTargets)
        || JSON.stringify(previousIntents) !== JSON.stringify(candidateIntents)
      );
      const adapted = existingActionTask ? null : candidateAdapted;
      const nextTargets = adapted
        ? candidateTargets
        : previousTargets;
      const nextIntents = adapted
        ? candidateIntents
        : previousIntents;
      const factsChanged = JSON.stringify(previousTargets) !== JSON.stringify(nextTargets)
        || JSON.stringify(previousIntents) !== JSON.stringify(nextIntents);
      const completedAt = new Date().toISOString();
      const plannerResultIgnored = plannerDowngradeIgnored || plannerFactsIgnored;
      const advisoryPlanning = existingActionTask ? {
        ...(task.planning && typeof task.planning === 'object' ? task.planning : {}),
        version: Number(plan.version || 1),
        requestType: 'action',
        parameters: task.planning?.parameters && typeof task.planning.parameters === 'object'
          ? task.planning.parameters
          : {},
        ambiguity: {hasAmbiguity: false, reasons: [], clarifyingQuestions: []},
        risk: {
          level: String(task.planning?.risk?.level || 'medium'),
          writeRequested: true,
          requiresHumanConfirmation: true,
          reasons: uniqueMessages([
            ...asArray(task.planning?.risk?.reasons),
            '后台模型只做辅助理解，不能修改已经锁定的动作、店铺、商品或预演事实。',
          ]),
        },
        confidence: Number(task.planning?.confidence || 0),
        summary: plannerResultIgnored
          ? '后台结构化结果与当前受控动作事实冲突，已忽略；任务事实和系统检查结果保持不变。'
          : '后台结构化检查仅作辅助理解；已锁定的任务事实和系统检查结果保持不变。',
        advisory: true,
        factsApplied: false,
        ignored: plannerResultIgnored,
        ignoredReason: plannerDowngradeIgnored
          ? 'existing_action_cannot_be_downgraded_to_query'
          : plannerFactsIgnored
            ? 'existing_action_facts_are_authoritative'
            : '',
        ignoredRequestType: String(plan.requestType || ''),
      } : null;
      const updatedTask = {
        ...task,
        intents: nextIntents,
        targets: nextTargets,
        planning: {
          ...(advisoryPlanning || adapted?.planning || {}),
          ...(!existingActionTask && adapted ? {factsApplied: factsChanged, advisory: false} : {}),
          jobId: job.jobId,
          modelProfile: modelProfilePublicSummary(profile),
          completedAt,
        },
        preview: existingActionTask
          ? (task.preview && typeof task.preview === 'object' ? task.preview : {})
          : {
              ...(task.preview && typeof task.preview === 'object' ? task.preview : {}),
              summary: plan.summary,
              riskNotes: [...plan.risk.reasons],
              structuredIntent: {
                requestType: plan.requestType,
                confidence: plan.confidence,
                ambiguity: plan.ambiguity,
              },
            },
        updatedAt: completedAt,
      };
      if (factsChanged) {
        updatedTask.execution = {
          ...(task.execution && typeof task.execution === 'object' ? task.execution : {}),
          state: 'needs_repreflight',
          preflight: {
            ...(task.execution?.preflight && typeof task.execution.preflight === 'object' ? task.execution.preflight : {}),
            ok: false,
            blockers: uniqueMessages([
              ...asArray(task.execution?.preflight?.blockers),
              '结构化意图规划更新了目标事实，必须重新做系统检查后才能提交。',
            ]),
          },
        };
      }
      updatedTask.history = appendTaskHistory(updatedTask, 'structured_intent_planned', actor, {headers: {}, socket: {}}, {
        jobId: job.jobId,
        requestType: plan.requestType,
        confidence: plan.confidence,
        factsChanged,
        plannerDowngradeIgnored,
        plannerFactsIgnored,
        advisoryOnly: existingActionTask,
      });
      const tasks = taskStore.tasks.slice();
      tasks[taskIndex] = updatedTask;
      await writeLinkOpsTaskStore(args, {...taskStore, updatedAt: completedAt, tasks});

      const chatStore = normalizeLinkOpsChatStore(await readLinkOpsChatStore(args));
      const sessionIndex = chatStore.sessions.findIndex(session => String(session?.id || '') === String(job.chatSessionId || ''));
      const chatFeedbackSuppressed = existingActionTask || (
        !factsChanged
        && String(task.status || '') === 'waiting_review'
        && task.execution?.preflight?.ok === true
      );
      if (sessionIndex >= 0) {
        const sessionAccess = authorizeLinkOpsRecord(actor, chatStore.sessions[sessionIndex], {kind: 'session', mode: 'mutate'});
        if (sessionAccess.ok) {
          const alreadyReported = asArray(sessionAccess.record.messages)
            .some(messageRow => String(messageRow?.meta?.intentPlanJobId || '') === String(job.jobId));
          if (!alreadyReported && !chatFeedbackSuppressed) {
            const questions = asArray(plan.ambiguity?.clarifyingQuestions).filter(Boolean);
            const answer = questions.length
              ? `结构化检查完成：${plan.summary}\n\n还需要你确认：\n${questions.map(question => `- ${question}`).join('\n')}`
              : `结构化检查完成：${plan.summary}\n\n我已把识别出的店铺、商品、动作参数和风险写入当前任务；任何真实写操作仍会先重新检查并等你确认。`;
            const sessions = chatStore.sessions.slice();
            sessions[sessionIndex] = appendAssistantChatMessage(sessionAccess.record, answer, {
              mode: 'structured-intent-plan',
              intentPlanJobId: job.jobId,
              autoTaskId: updatedTask.id,
              agentProfile: modelProfilePublicSummary(profile),
            });
            await writeLinkOpsChatStore(args, {...chatStore, updatedAt: completedAt, sessions});
          }
        }
      }

      return {
        applied: true,
        taskId: updatedTask.id,
        requestType: plan.requestType,
        summary: plan.summary,
        confidence: plan.confidence,
        factsChanged,
        plannerDowngradeIgnored,
        plannerFactsIgnored,
        advisoryOnly: existingActionTask,
        staleIgnored: false,
        chatFeedbackSuppressed,
      };
    });
  }

  let linkOpsJobWorker = null;
  if (jobWorkerEnabled) {
    linkOpsJobWorker = createLinkOpsJobWorker({
      store: linkOpsStoreGateway,
      handlers: {intent_plan: applyIntentPlanJob},
      pollMs: Number(process.env.SHEIN_BI_JOB_POLL_MS || 1_500),
      leaseMs: Number(process.env.SHEIN_BI_JOB_LEASE_MS || 10 * 60_000),
      onEvent: event => appendAudit(args.auditFile, {type: `link-ops-job-${event.event}`, ...event}),
    });
  }

  const handleRequest = async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const trustedInternal = authRequired && isTrustedInternalRequest(req);
      const authenticatedActor = authRequired ? authenticateRequest(req, authUsers, sessionSecret) : null;
      const knowledgeBearer = url.pathname.startsWith('/api/owner-knowledge/') ? requestBearerToken(req) : '';
      const activationActor = url.pathname === '/api/owner-knowledge/distribution/activate' ? ownerKnowledgeActivationActor(req) : null;
      const knowledgeDeviceActor = knowledgeBearer && !activationActor ? await ownerKnowledgeService.authenticateBearer(knowledgeBearer) : null;
      const actor = authRequired ? (authenticatedActor || activationActor || knowledgeDeviceActor || (trustedInternal ? internalActor() : null)) : null;
      const ownerKnowledgeActivationRequest = url.pathname === '/api/owner-knowledge/distribution/activate';
      // This endpoint is bearer-only and is called by GitHub Actions, which has no browser Origin header.
      // Every cookie/session-backed mutation continues through the normal origin guard.
      if (!ownerKnowledgeActivationRequest && !mutationOriginAllowed(req, {trustedInternal})) {
        await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'mutation-origin-denied', actor, ...requestMeta(req), path: url.pathname, method: req.method});
        return sendJson(res, 403, {ok: false, error: 'Cross-origin state-changing request denied'});
      }
      if (authRequired && !actor && !isPublicPath(url.pathname)) {
        if (isApiPath(url.pathname)) return unauthorized(res, url.pathname);
        writeResponseHead(res, 302, {
          'Cache-Control': 'no-store',
          'Location': `/login?next=${encodeURIComponent(req.url || '/')}`,
        });
        res.end();
        return;
      }
      if (url.pathname === '/login') {
        if (req.method !== 'GET') return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
        if (actor) {
          writeResponseHead(res, 302, {'Cache-Control': 'no-store', 'Location': url.searchParams.get('next') || '/'});
          res.end();
          return;
        }
        return send(res, 200, loginPageHtml({
          error: url.searchParams.get('error') || '',
          next: url.searchParams.get('next') || '/',
          user: url.searchParams.get('user') || '',
        }), {'Content-Type': 'text/html; charset=utf-8'});
      }
      if (url.pathname === '/api/login') {
        if (req.method !== 'POST') return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
        const contentType = String(req.headers['content-type'] || '');
        let body;
        if (contentType.includes('application/json')) {
          body = await readBodyJson(req, 32 * 1024).catch(err => ({_error: err?.message || String(err)}));
        } else {
          const raw = await readBodyText(req, 32 * 1024).catch(err => `__ERROR__${err?.message || String(err)}`);
          if (raw.startsWith('__ERROR__')) body = {_error: raw.slice(9)};
          else body = Object.fromEntries(new URLSearchParams(raw));
        }
        if (body._error) return sendJson(res, 400, {ok: false, error: body._error});
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        const rateKey = loginRateKey(req, username);
        const rate = loginRateLimiter.inspect(rateKey);
        if (!rate.allowed) {
          await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'auth-login', ok: false, rateLimited: true, username, ...requestMeta(req)});
          const retryHeaders = {'Retry-After': String(rate.retryAfterSec)};
          if (contentType.includes('application/json')) return sendJson(res, 429, {ok: false, error: '登录尝试过多，请稍后重试'}, retryHeaders);
          writeResponseHead(res, 302, {...retryHeaders, 'Location': `/login?error=${encodeURIComponent('登录尝试过多，请稍后重试')}&user=${encodeURIComponent(username)}&next=${encodeURIComponent(String(body.next || '/'))}`});
          res.end();
          return;
        }
        const user = authUsers.find(u => u.username.toLowerCase() === username.toLowerCase());
        if (!verifyPassword(user, password)) {
          const failedRate = loginRateLimiter.fail(rateKey);
          await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'auth-login', ok: false, rateLimited: !failedRate.allowed, username, ...requestMeta(req)});
          const next = String(body.next || '/');
          const status = failedRate.allowed ? 401 : 429;
          const message = failedRate.allowed ? '账号或密码不正确' : '登录尝试过多，请稍后重试';
          const retryHeaders = failedRate.allowed ? {} : {'Retry-After': String(failedRate.retryAfterSec)};
          if (contentType.includes('application/json')) return sendJson(res, status, {ok: false, error: message}, retryHeaders);
          writeResponseHead(res, 302, {...retryHeaders, 'Location': `/login?error=${encodeURIComponent(message)}&user=${encodeURIComponent(username)}&next=${encodeURIComponent(next)}`});
          res.end();
          return;
        }
        loginRateLimiter.success(rateKey);
        const actorLogin = actorFromUser(user);
        const token = signSessionPayload({username: user.username, iat: Date.now(), exp: Date.now() + 14 * 86400 * 1000}, sessionSecret);
        await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'auth-login', ok: true, actor: actorLogin, ...requestMeta(req)});
        if (contentType.includes('application/json')) {
          writeResponseHead(res, 200, {
            'Cache-Control': 'no-store',
            'Content-Type': 'application/json; charset=utf-8',
            'Set-Cookie': sessionCookie(token, req),
          });
          res.end(JSON.stringify({ok: true, user: publicActor(actorLogin)}));
          return;
        }
        const next = String(body.next || '/');
        writeResponseHead(res, 302, {
          'Cache-Control': 'no-store',
          'Set-Cookie': sessionCookie(token, req),
          'Location': next.startsWith('/') && !next.startsWith('//') ? next : '/',
        });
        res.end();
        return;
      }
      if (url.pathname === '/api/logout') {
        if (req.method !== 'POST') return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
        await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'auth-logout', ok: true, actor, ...requestMeta(req)});
        writeResponseHead(res, 200, {
          'Cache-Control': 'no-store',
          'Set-Cookie': clearSessionCookie(req),
          'Content-Type': 'application/json; charset=utf-8',
        });
        res.end(JSON.stringify({ok: true}));
        return;
      }
      if (url.pathname === '/api/auth/me') {
        return sendJson(res, actor ? 200 : 401, {ok: Boolean(actor), user: publicActor(actor)});
      }
      if (url.pathname === '/api/partner-cli/manifest' || url.pathname === '/api/partner-cli/bundle') {
        if (req.method !== 'GET') return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
        try {
          const release = await currentPartnerCliRelease();
          const etag = `"pcli-${release.manifest.bundleSha256}"`;
          if (String(req.headers['if-none-match'] || '') === etag) {
            writeResponseHead(res, 304, {'Cache-Control': 'private, no-cache, must-revalidate', ETag: etag});
            res.end();
            return;
          }
          const data = url.pathname.endsWith('/bundle') ? release.bundle : release.manifest;
          if (url.pathname.endsWith('/bundle')) {
            await appendAudit(args.auditFile, {
              at: new Date().toISOString(),
              type: 'partner-cli-bundle-download',
              actor,
              ...requestMeta(req),
              release: {version: release.manifest.version, bundleSha256: release.manifest.bundleSha256},
            });
          }
          return sendJson(res, 200, {ok: true, data}, {'Cache-Control': 'private, no-cache, must-revalidate', ETag: etag});
        } catch (error) {
          return sendJson(res, 503, {ok: false, error: `CLI 发布包尚未就绪：${error?.message || String(error)}`}, {'Cache-Control': 'no-store'});
        }
      }
      if (url.pathname === '/api/owner-knowledge/distribution/activate') {
        if (req.method !== 'POST') return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
        if (actor?.role !== 'knowledge_activation') return sendJson(res, 403, {ok: false, error: 'GitHub distribution activation denied'});
        const body = await readBodyJson(req, 64 * 1024).catch(error => ({_error: error?.message || String(error)}));
        if (body._error) return sendJson(res, 400, {ok: false, error: body._error});
        try {
          const distribution = await args.withOwnerKnowledgeConsistencyLock(() => ownerKnowledgeService.activatePendingDistribution({
              sourceCommit: body.sourceCommit,
              fingerprint: body.fingerprint,
              bundleSha256: body.bundleSha256,
              actorUser: 'github-actions',
            }));
          await appendAudit(args.auditFile, {
            at: new Date().toISOString(),
            type: 'owner-knowledge-distribution-activated',
            actor,
            ...requestMeta(req),
            distribution: {sourceCommit: distribution.sourceCommit, fingerprint: distribution.fingerprint, ruleCount: distribution.ruleCount},
          });
          return sendJson(res, 200, {ok: true, data: distribution}, {'Cache-Control': 'no-store'});
        } catch (error) {
          await appendAudit(args.auditFile, {
            at: new Date().toISOString(),
            type: 'owner-knowledge-distribution-activation-denied',
            actor,
            ...requestMeta(req),
            error: String(error?.message || error).slice(0, 500),
            code: String(error?.code || ''),
          });
          return sendJson(res, Number(error?.status || 409), {ok: false, error: error?.message || String(error), code: error?.code || 'OWNER_KNOWLEDGE_ACTIVATION_FAILED'});
        }
      }
      if (url.pathname === '/api/owner-knowledge/manifest') {
        if (req.method !== 'GET') return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
        const manifest = await ownerKnowledgeService.distributionManifest();
        if (!manifest.ready) return sendJson(res, 503, {ok: false, error: '负责人规则包尚未完成发布', data: manifest}, {'Cache-Control': 'no-store'});
        const data = {
          schemaVersion: 1,
          authorityId: ownerKnowledgeService.authorityId,
          ...manifest,
          cli: {
            minimumVersion: process.env.SHEIN_BI_OPS_CLI_MIN_VERSION || BI_OPS_CLI_VERSION,
            recommendedVersion: process.env.SHEIN_BI_OPS_CLI_RECOMMENDED_VERSION || BI_OPS_CLI_VERSION,
          },
        };
        const etag = `\"okb-${crypto.createHash('sha256').update(`${data.fingerprint}|${data.activeFingerprint}|${data.sourceCommit}|${data.current}`).digest('hex').slice(0, 32)}\"`;
        if (String(req.headers['if-none-match'] || '') === etag) {
          writeResponseHead(res, 304, {'Cache-Control': 'private, no-cache, must-revalidate', ETag: etag});
          res.end();
          return;
        }
        return sendJson(res, 200, {ok: true, data}, {'Cache-Control': 'private, no-cache, must-revalidate', ETag: etag});
      }
      if (url.pathname === '/api/owner-knowledge/bundle') {
        if (req.method !== 'GET') return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
        const bundle = await ownerKnowledgeService.distributionBundle();
        if (!bundle.manifest?.ready) return sendJson(res, 503, {ok: false, error: '负责人规则包尚未完成发布'}, {'Cache-Control': 'no-store'});
        const data = {...bundle, manifest: {schemaVersion: 1, authorityId: ownerKnowledgeService.authorityId, ...bundle.manifest}};
        const etag = `\"okb-${crypto.createHash('sha256').update(`${bundle.fingerprint}|${bundle.manifest.sourceCommit}`).digest('hex').slice(0, 32)}\"`;
        return sendJson(res, 200, {ok: true, data}, {'Cache-Control': 'private, no-cache, must-revalidate', ETag: etag});
      }
      if (url.pathname === '/api/owner-knowledge/events') {
        if (req.method !== 'POST') return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
        if (!actorCanPublishOwnerKnowledge(actor, ownerKnowledgeService.authorityId)) {
          await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'owner-knowledge-publish-denied', actor, ...requestMeta(req)});
          return sendJson(res, 403, {ok: false, error: '当前账号只能使用负责人规则，不能修改或覆盖'});
        }
        const body = await readBodyJson(req, 2 * 1024 * 1024).catch(error => ({_error: error?.message || String(error)}));
        if (body._error) return sendJson(res, 400, {ok: false, error: body._error});
        const experiences = Array.isArray(body.experiences) ? body.experiences : Array.isArray(body.events) ? body.events : [];
        try {
          const result = await args.withOwnerKnowledgeConsistencyLock(async () => {
            args.bumpOwnerKnowledgeGeneration();
            return await ownerKnowledgeService.ingest(experiences, {
                actor,
                actorUser: actorUser(actor, req),
                sourceKind: knowledgeDeviceActor ? 'owner_local_sync' : 'owner_bi_manual',
                deviceId: actor?.knowledgeDeviceId || '',
              });
          });
          await appendAudit(args.auditFile, {
            at: new Date().toISOString(),
            type: 'owner-knowledge-published',
            actor,
            ...requestMeta(req),
            result: {
              count: result.results.length,
              active: result.results.filter(row => row.activation === 'active').length,
              candidates: result.results.filter(row => row.activation === 'candidate').length,
              fingerprint: result.bundle.fingerprint,
              distribution: {
                current: result.distribution?.current,
                source: result.distribution?.source,
                sourceCommit: result.distribution?.sourceCommit,
              },
            },
          });
          return sendJson(res, 200, result, {'Cache-Control': 'no-store'});
        } catch (error) {
          return sendJson(res, Number(error?.status || 400), {ok: false, error: error?.message || String(error), code: error?.code || 'OWNER_KNOWLEDGE_PUBLISH_FAILED'});
        }
      }
      if (url.pathname === '/api/owner-knowledge/status') {
        if (req.method !== 'GET') return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
        if (!actorCanPublishOwnerKnowledge(actor, ownerKnowledgeService.authorityId)) return sendJson(res, 403, {ok: false, error: '负责人权限 required'});
        return sendJson(res, 200, {ok: true, data: await ownerKnowledgeService.status()}, {'Cache-Control': 'no-store'});
      }
      if (url.pathname === '/api/owner-knowledge/active') {
        if (req.method !== 'GET') return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
        if (!actorCanPublishOwnerKnowledge(actor, ownerKnowledgeService.authorityId)) return sendJson(res, 403, {ok: false, error: '当前账号只能在业务流程中使用负责人规则'});
        const query = String(url.searchParams.get('q') || '').slice(0, 2_000);
        const bundle = await ownerKnowledgeService.getActiveBundle({question: query}, {limit: Math.max(1, Math.min(50, Number(url.searchParams.get('limit') || 20)))});
        return sendJson(res, 200, {ok: true, data: bundle}, {'Cache-Control': 'no-store'});
      }
      if (url.pathname === '/api/owner-knowledge/devices') {
        if (req.method !== 'POST') return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
        const body = await readBodyJson(req, 64 * 1024).catch(error => ({_error: error?.message || String(error)}));
        if (body._error) return sendJson(res, 400, {ok: false, error: body._error});
        try {
          const issued = await ownerKnowledgeService.issueDevice({
            actor,
            actorUser: actorUser(actor, req),
            deviceId: String(body.deviceId || ''),
            deviceName: String(body.deviceName || ''),
          });
          await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'owner-knowledge-device-enrolled', actor, ...requestMeta(req), device: {deviceId: issued.deviceId, deviceName: issued.deviceName, enrolledAt: issued.enrolledAt}});
          return sendJson(res, 201, {ok: true, data: issued}, {'Cache-Control': 'no-store'});
        } catch (error) {
          return sendJson(res, Number(error?.status || 400), {ok: false, error: error?.message || String(error), code: error?.code || 'OWNER_KNOWLEDGE_DEVICE_ENROLL_FAILED'});
        }
      }
      if (url.pathname === '/api/health') {
        const urlHost = args.host === '0.0.0.0' ? '127.0.0.1' : args.host;
        return sendJson(res, 200, {
          ok: true,
          service: 'shein-bi-portal',
          time: new Date().toISOString(),
          host: args.host,
          port: args.port,
          url: `http://${urlHost}:${args.port}/`,
          lanMode: args.host === '0.0.0.0',
          root,
          stateFile: args.stateFile,
          linkOpsTaskFile: args.linkOpsTaskFile,
          linkOpsChatFile: args.linkOpsChatFile,
          linkOpsRuntimeFile: args.linkOpsRuntimeFile,
          linkOpsStorage: await linkOpsStoreGateway.health(),
          ownerKnowledgeDistribution: (value => {
            return {ready: Boolean(value.ready), current: Boolean(value.current), source: String(value.source || ''), ruleCount: Number(value.ruleCount || 0)};
          })(await ownerKnowledgeService.distributionManifest()),
          linkOpsJobs: {
            intentPlannerEnabled,
            workerEnabled: Boolean(linkOpsJobWorker),
            workerRunning: Boolean(linkOpsJobWorker?.isRunning()),
          },
          linkOpsAssetDir: args.linkOpsAssetDir,
          manualLoginStateFile: args.manualLoginStateFile,
          writableActionState: !args.readOnly,
          writableLinkOpsTasks: !args.readOnly,
          writableLinkOpsChats: !args.readOnly,
          readOnly: args.readOnly,
          authRequired,
          allowGenerateSections,
          biCoreWarmup: {
            generatedAt: biPortalCoreWarmupState.generatedAt,
            status: biPortalCoreWarmupState.status,
            startedAt: biPortalCoreWarmupState.startedAt ? new Date(biPortalCoreWarmupState.startedAt).toISOString() : null,
            finishedAt: biPortalCoreWarmupState.finishedAt ? new Date(biPortalCoreWarmupState.finishedAt).toISOString() : null,
            inFlight: Boolean(biPortalCoreWarmupState.inFlight),
            lastError: biPortalCoreWarmupState.lastError,
          },
          user: actor ? {
            username: actor.username,
            displayName: actor.displayName,
            role: actor.role,
            readStores: normalizeStoreList(actor.readStores || ['*']),
            writeStores: normalizeStoreList(actor.writeStores || []),
            ownerKey: actor.ownerKey || '',
          } : null,
        });
      }
      {
        const m = /^\/api\/bi\/section\/([^/]+)$/.exec(url.pathname);
        if (m) {
          if (req.method !== 'GET') return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
          const section = decodeURIComponent(m[1]);
          const force = url.searchParams.get('refresh') === '1';
          const asyncRefresh = force && ['1', 'true', 'yes'].includes(String(url.searchParams.get('async') || '').toLowerCase());
          const allowGenerate = allowGenerateSections;
          if (force && !allowGenerate) {
            return sendJson(res, 403, {ok: false, section, error: 'Section refresh is disabled in read-only or unauthenticated LAN mode'});
          }
          try {
            const result = await loadBiSection(args, root, section, {force, asyncRefresh, allowGenerate, gzip: acceptsGzip(req.headers['accept-encoding'])});
            if (result.rawBody) return send(res, result.status, result.rawBody, result.headers || {'Content-Type': 'application/json; charset=utf-8'});
            return sendJson(res, result.status, result.payload);
          } catch (err) {
            return sendJson(res, 500, {ok: false, section, error: err?.message || String(err || 'BI section failed')});
          }
        }
      }
      if (url.pathname === '/favicon.ico') {
        return send(res, 204, '', {'Content-Type': 'image/x-icon'});
      }
      if (url.pathname === '/v1' || url.pathname.startsWith('/v1/')) {
        return send(res, 410, '旧版 BI 已封存，不再提供线上入口；请访问 / 使用当前 BI 主系统。', {'Content-Type': 'text/plain; charset=utf-8'});
      }
      if (url.pathname === '/v2' || url.pathname.startsWith('/v2/')) {
        writeResponseHead(res, 301, {'Location': '/'});
        res.end();
        return;
      }
      if (url.pathname === '/cloud-login-maintenance') {
        return send(res, 200, await manualLoginMaintenanceHtml(authRequired ? actor : internalActor()), {'Content-Type': 'text/html; charset=utf-8'});
      }
      if (url.pathname.startsWith('/cloud-login/session/')) {
        const m = /^\/cloud-login\/session\/([^/]+)$/.exec(url.pathname);
        if (!m) return send(res, 404, 'Not found', {'Content-Type': 'text/plain; charset=utf-8'});
        const found = await findManualLoginSession(args, decodeURIComponent(m[1]), url.searchParams.get('token') || '');
        if (!found.ok) return send(res, found.status || 403, found.error || 'Forbidden', {'Content-Type': 'text/plain; charset=utf-8'});
        const denied = authRequired ? requireWriteStores(actor, [found.session.storeKey]) : null;
        if (denied) return send(res, 403, 'Store write permission required', {'Content-Type': 'text/plain; charset=utf-8'});
        return send(res, 200, manualLoginSessionHtml(found.session, url.searchParams.get('token') || ''), {'Content-Type': 'text/html; charset=utf-8'});
      }
      if (url.pathname.startsWith('/cloud-login/novnc/')) {
        return await serveNovncAsset(req, res, url);
      }
      if (url.pathname === '/api/cloud-login/sessions') {
        if (req.method === 'GET') {
          const result = await runManualLoginHelper(args, 'list', ['--show-token'], 45_000);
          const sessions = (Array.isArray(result.sessions) ? result.sessions : [])
            .filter(session => !authRequired || actorCanWriteStores(actor, [session.storeKey]));
          return sendJson(res, result.ok === false ? 500 : 200, {...result, sessions});
        }
        if (req.method === 'POST') {
          if (args.readOnly) return sendJson(res, 403, {ok: false, error: 'Read-only LAN preview mode'});
          const body = await readBodyJson(req, 32 * 1024).catch(err => ({_error: err?.message || String(err)}));
          if (body._error) return sendJson(res, 400, {ok: false, error: body._error});
          const storeKey = String(body.storeKey || body.store || '').trim().toUpperCase();
          if (!(new Set(await manualLoginStoreKeys())).has(storeKey)) return sendJson(res, 400, {ok: false, error: 'Invalid store'});
          const denied = requireWriteStores(actor, [storeKey]);
          if (denied) {
            await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'cloud-manual-login-denied', actor, ...requestMeta(req), storeKey, denied});
            return sendJson(res, 403, denied);
          }
          const target = String(body.target || 'sbn').trim().toLowerCase();
          const expires = Math.max(5, Math.min(120, Number(body.expiresMinutes || 30)));
          const result = await runManualLoginHelper(args, 'start', ['--store', storeKey, '--target', target, '--expires-minutes', String(expires)], 90_000);
          await appendAudit(args.auditFile, {
            at: new Date().toISOString(),
            type: 'cloud-manual-login-start',
            actor,
            ...requestMeta(req),
            storeKey,
            target,
            ok: result.ok !== false,
            sessionId: result.session?.id || '',
          });
          return sendJson(res, result.ok === false ? 500 : 200, result);
        }
        return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
      }
      {
        const m = /^\/api\/cloud-login\/sessions\/([^/]+)\/(finish|close)$/.exec(url.pathname);
        if (m) {
          if (req.method !== 'POST') return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
          if (args.readOnly) return sendJson(res, 403, {ok: false, error: 'Read-only LAN preview mode'});
          const body = await readBodyJson(req, 32 * 1024).catch(err => ({_error: err?.message || String(err)}));
          if (body._error) return sendJson(res, 400, {ok: false, error: body._error});
          const id = decodeURIComponent(m[1]);
          const action = m[2];
          const token = String(body.token || url.searchParams.get('token') || '').trim();
          if (!token) return sendJson(res, 400, {ok: false, error: 'Missing session token'});
          const found = await findManualLoginSession(args, id, token);
          if (!found.ok) return sendJson(res, found.status || 403, {ok: false, error: found.error || 'Forbidden'});
          const denied = authRequired ? requireWriteStores(actor, [found.session.storeKey]) : null;
          if (denied) return sendJson(res, 403, denied);
          const extra = ['--id', id];
          extra.push('--token', token);
          const result = await runManualLoginHelper(args, action, extra, action === 'finish' ? 180_000 : 60_000);
          await appendAudit(args.auditFile, {
            at: new Date().toISOString(),
            type: `cloud-manual-login-${action}`,
            actor,
            ...requestMeta(req),
            sessionId: id,
            ok: result.ok !== false,
            storeKey: result.session?.storeKey || '',
          });
          return sendJson(res, result.ok === false ? 500 : 200, result);
        }
      }
      if (url.pathname === '/api/first-run-check') {
        if (req.method === 'GET') {
          return sendJson(res, 200, {ok: true, firstRunCheck: await readFirstRunCheckSummary()});
        }
        if (req.method === 'POST') {
          if (args.readOnly) {
            return sendJson(res, 403, {ok: false, error: 'Read-only LAN preview mode'});
          }
          await appendAudit(args.auditFile, {
            at: new Date().toISOString(),
            type: 'first-run-check',
            actor,
            ...requestMeta(req),
          });
          if (firstRunCheckInFlight) return sendJson(res, 409, {ok: false, error: 'First run check already running'});
          firstRunCheckInFlight = true;
          try {
            const run = await runFirstRunCheck();
            const firstRunCheck = await readFirstRunCheckSummary();
            const generated = !run.timedOut && (run.code === 0 || run.code === 2) && firstRunCheck.exists;
            return sendJson(res, generated ? 200 : 500, {
              ok: generated,
              run,
              firstRunCheck,
            });
          } finally {
            firstRunCheckInFlight = false;
          }
        }
        return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
      }
      if (url.pathname === '/api/openapi-capabilities') {
        if (req.method !== 'GET') return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
        return sendJson(res, 200, {
          ...projectOpenApiCapabilityLedgerForClient(openApiCapabilityLedger(), actor),
          agentRuntime: {
            governor: opsAgentGovernor.snapshot(),
            profiles: Object.fromEntries(Object.entries(biOpsModelProfiles()).map(([key, value]) => [key, modelProfilePublicSummary(value)])),
            policy: 'code_first_then_tiered_model',
          },
        });
      }
      if (url.pathname === '/api/action-state') {
        if (req.method === 'GET') {
          const data = await readLinkOpsActionState(args);
          return sendJson(res, 200, {ok: true, data});
        }
        if (req.method === 'POST') {
          if (args.readOnly) {
            return sendJson(res, 403, {ok: false, error: 'Read-only LAN preview mode'});
          }
          const body = await readBodyJson(req);
          const patches = Array.isArray(body.actions) ? body.actions : [body];
          if (patches.length > 300) return sendJson(res, 400, {ok: false, error: 'Too many actions'});
          const actorGate = requireConcreteOperatorActor(actor);
          if (actorGate) {
            await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'action-state-denied', actor, ...requestMeta(req), denied: actorGate});
            return sendJson(res, 403, actorGate);
          }
          const patchScopes = patches.map(actionStatePatchStore);
          const invalidScope = patchScopes.find(scope => !scope.ok);
          if (invalidScope) {
            await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'action-state-denied', actor, ...requestMeta(req), denied: invalidScope});
            return sendJson(res, 400, {ok: false, error: invalidScope.error});
          }
          const denied = requireWriteStores(actor, patchScopes.map(scope => scope.storeKey));
          if (denied) {
            await appendAudit(args.auditFile, {
              at: new Date().toISOString(),
              type: 'action-state-denied',
              actor,
              ...requestMeta(req),
              stores: patchScopes.map(scope => scope.storeKey),
              denied,
            });
            return sendJson(res, 403, denied);
          }
          const current = await readLinkOpsActionState(args);
          const actions = current.actions && typeof current.actions === 'object' ? current.actions : {};
          for (const patch of patches) {
            const key = String(patch.key || '');
            const status = String(patch.status || 'open');
            const owner = typeof patch.owner === 'string' ? patch.owner.trim().slice(0, 80) : undefined;
            const note = typeof patch.note === 'string' ? patch.note.trim().slice(0, 500) : undefined;
            if (!key) return sendJson(res, 400, {ok: false, error: 'Missing key'});
            if (!['open', 'done', 'review', 'ignored'].includes(status)) {
              return sendJson(res, 400, {ok: false, error: 'Invalid status'});
            }
            const prev = actions[key] && typeof actions[key] === 'object' ? actions[key] : {};
            const nextItem = {
              status,
              owner: owner ?? String(prev.owner || ''),
              note: note ?? String(prev.note || ''),
              updatedAt: new Date().toISOString(),
              updatedBy: actorLabel(actor, req),
              updatedByUser: actorUser(actor, req),
            };
            if (status === 'open' && !nextItem.owner && !nextItem.note) delete actions[key];
            else actions[key] = nextItem;
          }
          const next = {version: 1, updatedAt: new Date().toISOString(), actions};
          await writeLinkOpsActionState(args, next);
          await appendAudit(args.auditFile, {
            at: new Date().toISOString(),
            type: 'action-state',
            actor,
            ...requestMeta(req),
            patches: patches.map(p => ({
              key: String(p.key || '').slice(0, 240),
              status: String(p.status || 'open'),
              owner: typeof p.owner === 'string' ? p.owner.slice(0, 80) : undefined,
              hasNote: typeof p.note === 'string' && p.note.length > 0,
            })),
          });
          return sendJson(res, 200, {ok: true, data: next});
        }
        return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
      }
      if (url.pathname === '/api/link-ops-tasks') {
        if (req.method === 'GET') {
          const current = normalizeLinkOpsTaskStore(await readLinkOpsTaskStore(args));
          const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 120)));
          const globalView = requestedGlobalOpsView(url);
          if (globalView && !actorHasGlobalOpsView(actor)) {
            return sendJson(res, 403, {ok: false, error: '只有 owner/admin 可以使用 scope=all 查看全局自动运营任务'});
          }
          let sessionId = String(url.searchParams.get('sessionId') || url.searchParams.get('chatSessionId') || '').trim();
          if (sessionId) {
            try { sessionId = safeLinkOpsChatSessionId(sessionId); } catch (err) {
              return sendJson(res, 400, {ok: false, error: err?.message || 'Invalid chat session id'});
            }
            const messageTaskIds = new Set();
            const chatStore = normalizeLinkOpsChatStore(await readLinkOpsChatStore(args));
            const session = chatStore.sessions.find(row => String(row?.id || '') === sessionId);
            if (session) {
              const sessionAccess = authorizeLinkOpsRecord(actor, session, {kind: 'session', mode: 'read', globalView});
              if (!sessionAccess.ok) return sendJson(res, 403, sessionAccess.denied);
              for (const message of asArray(sessionAccess.record?.messages)) {
                const id = String(message?.meta?.autoTaskId || '').trim();
                if (id) messageTaskIds.add(id);
              }
            } else {
              const orphanTasks = current.tasks.filter(task => String(task?.chatSessionId || task?.chat?.sessionId || '') === sessionId);
              if (!orphanTasks.length) return sendJson(res, 404, {ok: false, error: 'Chat session not found'});
              if (!linkOpsTasksForActor(orphanTasks, actor, {globalView, mode: 'read'}).length) {
                return sendJson(res, 403, {ok: false, error: '该 legacy 会话任务属于其他 BI 账号或超出店铺范围'});
              }
            }
            const scoped = {
              ...current,
              tasks: current.tasks.filter(task => String(task?.chatSessionId || task?.chat?.sessionId || '') === sessionId || messageTaskIds.has(String(task?.id || ''))),
            };
            return sendJson(res, 200, {ok: true, data: projectLinkOpsTaskStoreForActor(scoped, actor, {limit, globalView})});
          }
          return sendJson(res, 200, {ok: true, data: projectLinkOpsTaskStoreForActor(current, actor, {limit, globalView})});
        }
        if (req.method === 'POST') {
          if (args.readOnly) {
            return sendJson(res, 403, {ok: false, error: 'Read-only LAN preview mode'});
          }
          const actorGate = requireConcreteOperatorActor(actor);
          if (actorGate) {
            await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-task-denied', actor, ...requestMeta(req), denied: actorGate});
            return sendJson(res, 403, actorGate);
          }
          let task;
          let body;
          try {
            body = await readBodyJson(req);
            task = buildLinkOpsTaskFromCommand(body, actor, req);
          } catch (err) {
            return sendJson(res, 400, {ok: false, error: err?.message || String(err || 'Invalid request')});
          }
          const denied = requireWriteStores(actor, taskWriteStores(task));
          if (denied) {
            await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-task-denied', actor, ...requestMeta(req), task: {stores: taskTargetStores(task), writeStores: taskWriteStores(task), sourceStores: taskSourceStores(task), commandLength: String(task.command || '').length}, denied});
            return sendJson(res, 403, denied);
          }
          const sourceDenied = requireReadStores(actor, taskSourceStores(task));
          if (sourceDenied) {
            await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-task-denied', actor, ...requestMeta(req), task: {stores: taskTargetStores(task), writeStores: taskWriteStores(task), sourceStores: taskSourceStores(task), commandLength: String(task.command || '').length}, denied: sourceDenied});
            return sendJson(res, 403, sourceDenied);
          }
          if (task.chatSessionId) {
            let sessionId;
            try { sessionId = safeLinkOpsChatSessionId(task.chatSessionId); } catch (err) {
              return sendJson(res, 400, {ok: false, error: err?.message || 'Invalid chat session id'});
            }
            const chatStore = normalizeLinkOpsChatStore(await readLinkOpsChatStore(args));
            const sessionIdx = chatStore.sessions.findIndex(session => String(session?.id || '') === sessionId);
            if (sessionIdx < 0) return sendJson(res, 404, {ok: false, error: 'Chat session not found'});
            const sessionAccess = authorizeLinkOpsRecord(actor, chatStore.sessions[sessionIdx], {kind: 'session', mode: 'mutate', claimLegacy: true});
            if (!sessionAccess.ok) {
              await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-task-denied-session', actor, ...requestMeta(req), session: {id: sessionId}, denied: sessionAccess.denied});
              return sendJson(res, 403, sessionAccess.denied);
            }
            task.chatSessionId = sessionId;
            if (sessionAccess.claimedLegacy || sessionAccess.ownershipMigrated) {
              const sessions = chatStore.sessions.slice();
              sessions[sessionIdx] = sessionAccess.record;
              await writeLinkOpsChatStore(args, {...chatStore, updatedAt: new Date().toISOString(), sessions});
            }
          }
          const knowledgeBinding = await bindOwnerKnowledgeToTask(task, args, task.command || '');
          task = knowledgeBinding.task;
          const current = normalizeLinkOpsTaskStore(await readLinkOpsTaskStore(args));
          const next = {
            version: 1,
            updatedAt: new Date().toISOString(),
            tasks: [task, ...current.tasks].slice(0, 1000),
          };
          await writeLinkOpsTaskStore(args, next);
          await appendAudit(args.auditFile, {
            at: new Date().toISOString(),
            type: 'link-ops-task',
            actor,
            ...requestMeta(req),
            task: {
              id: task.id,
              status: task.status,
              intents: task.intents,
              stores: task.targets?.stores || [],
              productRefs: task.targets?.productRefs || [],
              commandLength: task.command.length,
              ownerKnowledgeFingerprint: String(task.ownerKnowledgePolicy?.fingerprint || ''),
            },
          });
          return sendJson(res, 200, {
            ok: true,
            data: projectLinkOpsTaskStoreForActor(next, actor, {limit: 500}),
            task: projectLinkOpsTaskForClient(task),
          });
        }
        if (req.method === 'PATCH') {
          if (args.readOnly) {
            return sendJson(res, 403, {ok: false, error: 'Read-only LAN preview mode'});
          }
          const actorGate = requireConcreteOperatorActor(actor);
          if (actorGate) {
            await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-task-update-denied', actor, ...requestMeta(req), denied: actorGate});
            return sendJson(res, 403, actorGate);
          }
          let body;
          try {
            body = await readBodyJson(req);
          } catch (err) {
            return sendJson(res, 400, {ok: false, error: err?.message || String(err || 'Invalid request')});
          }
          let id = String(body.id || '').trim();
          if (!id) return sendJson(res, 400, {ok: false, error: 'Missing task id'});
          try { id = safeTaskId(id); } catch (err) {
            return sendJson(res, 400, {ok: false, error: err?.message || 'Invalid task id'});
          }
          const current = normalizeLinkOpsTaskStore(await readLinkOpsTaskStore(args));
          const idx = current.tasks.findIndex(t => String(t.id || '') === id);
          if (idx < 0) return sendJson(res, 404, {ok: false, error: 'Task not found'});
          const access = authorizeLinkOpsRecord(actor, current.tasks[idx], {kind: 'task', mode: 'mutate', claimLegacy: true});
          if (!access.ok) {
            await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-task-update-denied', actor, ...requestMeta(req), task: {id, stores: taskTargetStores(current.tasks[idx]), writeStores: taskWriteStores(current.tasks[idx]), sourceStores: taskSourceStores(current.tasks[idx])}, denied: access.denied});
            return sendJson(res, 403, access.denied);
          }
          current.tasks[idx] = access.record;
          let updated;
          try {
            updated = patchLinkOpsTask(access.record, body, actor, req);
          } catch (err) {
            const error = err?.message || String(err || 'Invalid patch');
            await appendAudit(args.auditFile, {
              at: new Date().toISOString(),
              type: 'link-ops-task-update-denied',
              actor,
              ...requestMeta(req),
              task: {
                id,
                status: current.tasks[idx]?.status || '',
                stores: taskTargetStores(current.tasks[idx]),
                writeStores: taskWriteStores(current.tasks[idx]),
                sourceStores: taskSourceStores(current.tasks[idx]),
              },
              denied: {ok: false, error},
            });
            const deniedStatus = /只有全店管理账号|权限|denied|forbidden|unauthorized/i.test(error) ? 403 : 400;
            return sendJson(res, deniedStatus, {ok: false, error});
          }
          const tasks = current.tasks.slice();
          tasks[idx] = updated;
          const next = {version: 1, updatedAt: new Date().toISOString(), tasks};
          await writeLinkOpsTaskStore(args, next);
          await appendAudit(args.auditFile, {
            at: new Date().toISOString(),
            type: 'link-ops-task-update',
            actor,
            ...requestMeta(req),
            task: {
              id,
              event: String(body.event || body.action || 'update').slice(0, 80),
              status: updated.status,
              progress: normalizeProgress(updated.progress, 0),
              claimedLegacy: access.claimedLegacy,
              ownershipMigrated: access.ownershipMigrated,
            },
          });
          return sendJson(res, 200, {
            ok: true,
            data: projectLinkOpsTaskStoreForActor(next, actor, {limit: 500}),
            task: projectLinkOpsTaskForClient(updated),
          });
        }
        if (req.method === 'DELETE') {
          if (args.readOnly) {
            return sendJson(res, 403, {ok: false, error: 'Read-only LAN preview mode'});
          }
          const actorGate = requireConcreteOperatorActor(actor);
          if (actorGate) {
            await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-task-delete-denied', actor, ...requestMeta(req), denied: actorGate});
            return sendJson(res, 403, actorGate);
          }
          let id = String(url.searchParams.get('id') || '').trim();
          if (!id) return sendJson(res, 400, {ok: false, error: 'Missing task id'});
          try { id = safeTaskId(id); } catch (err) {
            return sendJson(res, 400, {ok: false, error: err?.message || 'Invalid task id'});
          }
          const current = normalizeLinkOpsTaskStore(await readLinkOpsTaskStore(args));
          const taskIdx = current.tasks.findIndex(t => String(t.id || '') === id);
          if (taskIdx < 0) return sendJson(res, 404, {ok: false, error: 'Task not found'});
          const access = authorizeLinkOpsRecord(actor, current.tasks[taskIdx], {kind: 'task', mode: 'mutate', claimLegacy: true});
          if (!access.ok) {
            await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-task-delete-denied', actor, ...requestMeta(req), task: {id, stores: taskTargetStores(current.tasks[taskIdx]), writeStores: taskWriteStores(current.tasks[taskIdx]), sourceStores: taskSourceStores(current.tasks[taskIdx])}, denied: access.denied});
            return sendJson(res, 403, access.denied);
          }
          const task = access.record;
          current.tasks[taskIdx] = task;
          if (taskRequiresOwnerLifecycleResolve(task) && !isOwnerActor(actor)) {
            const deniedLifecycle = {
              ok: false,
              error: '提交后待回读/需人工处理任务只有全店管理账号可以删除或归档。',
              taskId: id,
              status: task.status || '',
              lifecycleStatus: task.lifecycle?.status || '',
            };
            await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-task-delete-denied', actor, ...requestMeta(req), task: {id, stores: taskTargetStores(task), writeStores: taskWriteStores(task), sourceStores: taskSourceStores(task)}, denied: deniedLifecycle});
            return sendJson(res, 403, deniedLifecycle);
          }
          const next = {
            version: 1,
            updatedAt: new Date().toISOString(),
            tasks: current.tasks.filter(t => String(t.id || '') !== id),
          };
          await writeLinkOpsTaskStore(args, next);
          let assetsDeleted = false;
          try {
            await removeLinkOpsTaskAssetDir(id, args);
            assetsDeleted = true;
          } catch {}
          await appendAudit(args.auditFile, {
            at: new Date().toISOString(),
            type: 'link-ops-task-delete',
            actor,
            ...requestMeta(req),
            task: {id, status: task.status, commandLength: String(task.command || '').length, assetsDeleted, claimedLegacy: access.claimedLegacy},
          });
          return sendJson(res, 200, {
            ok: true,
            data: projectLinkOpsTaskStoreForActor(next, actor, {limit: 500}),
            deleted: {id},
          });
        }
        return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
      }
      if (url.pathname === '/api/openapi-image-asset/upload-pic' || url.pathname === '/api/openapi-image-asset/transform-pic') {
        if (args.readOnly) return sendJson(res, 403, {ok: false, error: 'Read-only LAN preview mode'});
        if (req.method !== 'POST') return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
        const action = url.pathname.endsWith('/transform-pic') ? 'transform-pic' : 'upload-pic';
        const limitBytes = action === 'upload-pic' ? Math.ceil(OPENAPI_IMAGE_ASSET_MAX_FILE_BYTES * 1.5) + 128 * 1024 : 64 * 1024;
        let body;
        try {
          body = await readBodyJson(req, limitBytes);
        } catch (err) {
          return sendJson(res, 400, {ok: false, error: err?.message || String(err || 'Invalid request')});
        }
        try {
          const result = await executeOpenApiImageAssetUtility({action, body, args, actor, req});
          return sendJson(res, 200, result);
        } catch (err) {
          const status = Number(err?.status || 0) || 400;
          return sendJson(res, status, err?.response || {ok: false, error: err?.message || String(err || `${action} failed`)});
        }
      }
      if (url.pathname === '/api/link-ops-publish-assets') {
        if (args.readOnly) return sendJson(res, 403, {ok: false, error: 'Read-only LAN preview mode'});
        if (req.method !== 'POST') return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
        const actorGate = requireConcreteOperatorActor(actor);
        if (actorGate) {
          await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-publish-assets-denied', actor, ...requestMeta(req), denied: actorGate});
          return sendJson(res, 403, actorGate);
        }
        let body;
        try {
          body = await readBodyJson(req, 1024 * 1024);
        } catch (error) {
          return sendJson(res, 400, {ok: false, error: error?.message || String(error)});
        }
        const taskRef = String(body.taskId || body.id || '').trim();
        if (!taskRef) return sendJson(res, 400, {ok: false, error: 'Missing task id'});
        let current = normalizeLinkOpsTaskStore(await readLinkOpsTaskStore(args));
        let found;
        try {
          found = findLinkOpsTaskOrThrow(current, taskRef);
        } catch (error) {
          const message = error?.message || String(error);
          return sendJson(res, message === 'Invalid task id' ? 400 : 404, {ok: false, error: message});
        }
        const access = authorizeLinkOpsRecord(actor, found.task, {kind: 'task', mode: 'mutate', claimLegacy: true});
        if (!access.ok) {
          await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-publish-assets-denied', actor, ...requestMeta(req), task: {id: found.task.id}, denied: access.denied});
          return sendJson(res, 403, access.denied);
        }
        const lockId = String(access.record.id || taskRef);
        if (linkOpsExecutionLocks.has(lockId)) return sendJson(res, 409, {ok: false, error: '该任务正在执行其他检查，请等待当前操作结束'});
        linkOpsExecutionLocks.add(lockId);
        try {
          const prepared = await prepareApprovedPublishAssetsForTask(access.record, args, body, actor, req);
          const tasks = current.tasks.slice();
          tasks[found.idx] = prepared.task;
          current = {version: 1, updatedAt: new Date().toISOString(), tasks};
          await writeLinkOpsTaskStore(args, current);
          await appendAudit(args.auditFile, {
            at: new Date().toISOString(),
            type: 'link-ops-publish-assets-bound',
            actor,
            ...requestMeta(req),
            task: {id: prepared.task.id, stores: taskTargetStores(prepared.task), writeStores: taskWriteStores(prepared.task)},
            binding: {
              targetStore: prepared.binding.targetStore,
              bindingFingerprint: prepared.binding.bindingFingerprint,
              imageCount: prepared.binding.boundImageCount,
              boundNames: prepared.binding.boundNames,
              publishPreparation: prepared.binding.publishPreparation,
            },
          });
          return sendJson(res, 200, {
            ok: true,
            task: projectLinkOpsTaskForClient(prepared.task),
            binding: prepared.binding,
          });
        } catch (error) {
          await appendAudit(args.auditFile, {
            at: new Date().toISOString(),
            type: 'link-ops-publish-assets-failed',
            actor,
            ...requestMeta(req),
            task: {id: taskRef},
            error: String(error?.message || error).slice(0, 500),
          });
          return sendJson(res, Number(error?.status || 400), error?.response || {ok: false, error: error?.message || String(error)});
        } finally {
          linkOpsExecutionLocks.delete(lockId);
        }
      }
      if (url.pathname === '/api/link-ops-assets') {
        if (args.readOnly) return sendJson(res, 403, {ok: false, error: 'Read-only LAN preview mode'});
        if (req.method === 'POST') {
          const actorGate = requireConcreteOperatorActor(actor);
          if (actorGate) {
            await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-assets-upload-denied', actor, ...requestMeta(req), denied: actorGate});
            return sendJson(res, 403, actorGate);
          }
          let body;
          try {
            body = await readBodyJson(req, Math.ceil(LINK_OPS_MAX_UPLOAD_TOTAL_BYTES * 1.45));
          } catch (err) {
            return sendJson(res, 400, {ok: false, error: err?.message || String(err || 'Invalid upload')});
          }
          const current = normalizeLinkOpsTaskStore(await readLinkOpsTaskStore(args));
          const taskRef = String(body.taskId || body.id || '').trim();
          let targetTask = null;
          if (taskRef) {
            let foundTask;
            try {
              foundTask = findLinkOpsTaskOrThrow(current, taskRef);
            } catch (err) {
              const message = err?.message || String(err || 'Task not found');
              return sendJson(res, message === 'Invalid task id' ? 400 : 404, {ok: false, error: message});
            }
            const access = authorizeLinkOpsRecord(actor, foundTask.task, {kind: 'task', mode: 'mutate', claimLegacy: true});
            if (!access.ok) {
              await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-assets-upload-denied', actor, ...requestMeta(req), task: {id: foundTask.task.id, stores: taskTargetStores(foundTask.task), writeStores: taskWriteStores(foundTask.task), sourceStores: taskSourceStores(foundTask.task)}, denied: access.denied});
              return sendJson(res, 403, access.denied);
            }
            targetTask = access.record;
            current.tasks[foundTask.idx] = targetTask;
          }

          const chatCurrent = normalizeLinkOpsChatStore(await readLinkOpsChatStore(args));
          let sessionId = String(body.sessionId || body.chatSessionId || targetTask?.chatSessionId || targetTask?.chat?.sessionId || targetTask?.targets?.chatSessionId || '').trim();
          let chatSession = null;
          let chatCreated = false;
          if (sessionId) {
            try { sessionId = safeLinkOpsChatSessionId(sessionId); } catch (err) {
              return sendJson(res, 400, {ok: false, error: err?.message || 'Invalid chat session id'});
            }
            const sessionIdx = chatCurrent.sessions.findIndex(s => String(s.id || '') === sessionId);
            if (sessionIdx < 0) return sendJson(res, 404, {ok: false, error: 'Chat session not found'});
            const sessionAccess = authorizeLinkOpsRecord(actor, chatCurrent.sessions[sessionIdx], {kind: 'session', mode: 'mutate', claimLegacy: true});
            if (!sessionAccess.ok) {
              await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-assets-upload-denied', actor, ...requestMeta(req), session: {id: sessionId}, denied: sessionAccess.denied});
              return sendJson(res, 403, sessionAccess.denied);
            }
            chatSession = sessionAccess.record;
            chatCurrent.sessions[sessionIdx] = chatSession;
          } else {
            chatSession = buildUploadChatSession(actor, req);
            sessionId = chatSession.id;
            chatCreated = true;
          }

          let result;
          let responseStore = current;
          let responseTask = targetTask;
          let uploadCheckAnswer = '';
          try {
            if (targetTask) {
              result = await attachLinkOpsAssets({
                store: current,
                taskId: targetTask.id,
                sessionId,
                files: body.files,
                args,
                actor,
                req,
              });
              responseStore = result.store;
              responseTask = result.task;
              try {
                const checkResult = await runImmediateChatSystemCheckIfPossible({
                  task: result.task,
                  taskData: result.store,
                  actor,
                  req,
                  args,
                  updated: true,
                });
                responseStore = checkResult.taskData || result.store;
                responseTask = checkResult.task || result.task;
                uploadCheckAnswer = checkResult.answer || '';
              } catch (err) {
                uploadCheckAnswer = `我已收到你上传的资料，但重新检查时没有跑完：${String(err?.message || err || 'unknown error')}。你可以继续在聊天里补充或让我重试。`;
              }
              await writeLinkOpsTaskStore(args, responseStore);
            } else {
              const stored = await storeLinkOpsUploadedFiles({
                bucketId: `session-${sessionId}`,
                sessionId,
                files: body.files,
                args,
                actor,
                req,
              });
              result = {assets: stored.assets, totalBytes: stored.totalBytes};
            }
          } catch (err) {
            return sendJson(res, 400, {ok: false, error: err?.message || String(err || 'Upload failed')});
          }

          const assetNames = result.assets.map(a => a.originalName || a.name || '文件').slice(0, 6).join('、');
          const sessionMessage = targetTask
            ? `我已收到你上传的 ${result.assets.length} 个文件${assetNames ? `：${assetNames}` : ''}。${uploadCheckAnswer ? `

${uploadCheckAnswer}` : `

我已经把这些文件同步到当前处理事项里。你可以继续在聊天里补充，或让我重新检查。`}`
            : `我已收到你上传的 ${result.assets.length} 个文件${assetNames ? `：${assetNames}` : ''}。

这些文件已放到当前会话资料里。你可以直接继续说要处理什么，我会把这些文件作为上下文一起参考；还不会提交或修改 SHEIN。`;
          chatSession = attachAssetsToChatSession(chatSession, result.assets, {
            message: sessionMessage,
            meta: {mode: targetTask ? 'bi-ops-upload-check' : 'bi-ops-session-upload', autoTaskId: responseTask?.id || ''},
          });
          const sessions = chatCreated
            ? [chatSession, ...chatCurrent.sessions].slice(0, 300)
            : chatCurrent.sessions.map(s => String(s.id || '') === chatSession.id ? chatSession : s);
          const nextChatStore = {version: 1, updatedAt: new Date().toISOString(), memoryPolicy: CLOUD_AI_MEMORY_POLICY, sessions};
          await writeLinkOpsChatStore(args, nextChatStore);
          const projectedChatSession = projectLinkOpsChatSessionForClient(chatSession);
          await appendAudit(args.auditFile, {
            at: new Date().toISOString(),
            type: 'link-ops-assets-upload',
            actor,
            ...requestMeta(req),
            task: {
              id: responseTask?.id || '',
              status: responseTask?.status || 'session_upload',
              assetCount: result.assets.length,
              systemCheckState: responseTask?.execution?.state || '',
            },
            assets: result.assets.map(a => ({id: a.id, kind: a.kind, mime: a.mime, bytes: a.bytes, sha256: a.sha256})),
          });
          return sendJson(res, 200, {
            ok: true,
            data: projectLinkOpsTaskStoreForActor(responseStore, actor, {limit: 500}),
            task: responseTask ? projectLinkOpsTaskForClient(responseTask) : null,
            assets: result.assets.map(projectLinkOpsAssetForClient).filter(Boolean),
            session: projectedChatSession,
          });
        }
        return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
      }
      if (url.pathname === '/api/link-ops-execute') {
        if (args.readOnly) return sendJson(res, 403, {ok: false, error: 'Read-only LAN preview mode'});
        if (req.method === 'POST') {
          const actorGate = requireConcreteOperatorActor(actor);
          if (actorGate) {
            await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-execute-denied', actor, ...requestMeta(req), denied: actorGate});
            return sendJson(res, 403, actorGate);
          }
          const body = await readBodyJson(req, 256 * 1024).catch(err => ({_error: err?.message || String(err)}));
          if (body._error) return sendJson(res, 400, {ok: false, error: body._error});
          let id = String(body.id || body.taskId || '').trim();
          if (!id) return sendJson(res, 400, {ok: false, error: 'Missing task id'});
          try { id = safeTaskId(id); } catch (err) {
            return sendJson(res, 400, {ok: false, error: err?.message || 'Invalid task id'});
          }
          const current = normalizeLinkOpsTaskStore(await readLinkOpsTaskStore(args));
          const idx = current.tasks.findIndex(t => String(t.id || '') === id);
          if (idx < 0) return sendJson(res, 404, {ok: false, error: 'Task not found'});
          const access = authorizeLinkOpsRecord(actor, current.tasks[idx], {kind: 'task', mode: 'mutate', claimLegacy: true});
          if (!access.ok) {
            await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-execute-denied', actor, ...requestMeta(req), task: {id, stores: taskTargetStores(current.tasks[idx]), writeStores: taskWriteStores(current.tasks[idx]), sourceStores: taskSourceStores(current.tasks[idx])}, denied: access.denied});
            return sendJson(res, 403, access.denied);
          }
          current.tasks[idx] = access.record;
          if (taskRequiresOwnerLifecycleResolve(access.record)) {
            const deniedLifecycle = {
              ok: false,
              error: '该任务已进入提交后待回读/需人工处理状态，禁止重新系统检查或执行；请由全店管理账号人工核销为完成或归档。',
              taskId: id,
              status: access.record.status || '',
              lifecycleStatus: access.record.lifecycle?.lifecycleStatus || access.record.lifecycle?.status || '',
            };
            await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-execute-denied', actor, ...requestMeta(req), task: {id, stores: taskTargetStores(access.record), writeStores: taskWriteStores(access.record), sourceStores: taskSourceStores(access.record)}, denied: deniedLifecycle});
            return sendJson(res, 409, deniedLifecycle);
          }
          if (linkOpsExecutionLocks.has(id)) {
            const deniedLock = {ok: false, error: '该自动运营任务正在执行/系统检查中，请等待当前请求结束后再重试', taskId: id};
            await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-execute-denied', actor, ...requestMeta(req), task: {id, stores: taskTargetStores(current.tasks[idx]), writeStores: taskWriteStores(current.tasks[idx]), sourceStores: taskSourceStores(current.tasks[idx])}, denied: deniedLock});
            return sendJson(res, 409, deniedLock);
          }
          linkOpsExecutionLocks.add(id);
          try {
            const updated = await startControlledLinkOpsExecution(access.record, actor, req, args, body);
            const tasks = current.tasks.slice();
            tasks[idx] = updated;
            const next = {version: 1, updatedAt: new Date().toISOString(), tasks};
            await writeLinkOpsTaskStore(args, next);
            await appendAudit(args.auditFile, {
              at: new Date().toISOString(),
              type: 'link-ops-execute',
              actor,
              ...requestMeta(req),
              task: {
                id: updated.id,
                status: updated.status,
                progress: normalizeProgress(updated.progress, 0),
                execution: {
                  runId: updated.execution?.runId || '',
                  state: updated.execution?.state || '',
                  lifecycleStatus: updated.lifecycle?.lifecycleStatus || updated.execution?.lifecycle?.lifecycleStatus || '',
                  lifecycleLocked: Boolean(updated.lifecycle?.locked || updated.execution?.lifecycle?.locked),
                  needsManualResolve: Boolean(updated.lifecycle?.needsManualResolve || updated.execution?.lifecycle?.needsManualResolve),
                  canSilentWrite: false,
                  canAutoSubmit: false,
                },
                writeAudit: updated.execution?.writeAudit || null,
              },
            });
            return sendJson(res, 200, {
              ok: true,
              data: projectLinkOpsTaskStoreForActor(next, actor, {limit: 500}),
              task: projectLinkOpsTaskForClient(updated),
              execution: projectLinkOpsExecutionForClient(updated.execution),
            });
          } finally {
            linkOpsExecutionLocks.delete(id);
          }
        }
        return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
      }
      if (url.pathname === '/api/link-ops-audit') {
        if (req.method !== 'GET') return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
        let taskId = String(url.searchParams.get('taskId') || url.searchParams.get('id') || '').trim();
        const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || 40)));
        if (taskId) {
          try { taskId = safeTaskId(taskId); } catch (err) {
            return sendJson(res, 400, {ok: false, error: err?.message || 'Invalid task id'});
          }
          const current = normalizeLinkOpsTaskStore(await readLinkOpsTaskStore(args));
          const task = current.tasks.find(t => String(t.id || '') === taskId);
          if (!task) return sendJson(res, 404, {ok: false, error: 'Task not found'});
          const access = authorizeLinkOpsRecord(actor, task, {kind: 'task', mode: 'read', globalView: actorHasGlobalOpsView(actor)});
          if (!access.ok) return sendJson(res, 403, access.denied);
        } else if (!actorHasGlobalOpsView(actor)) {
          return sendJson(res, 403, {ok: false, error: '只有全店管理账号可以查看全局自动运营记录'});
        }
        const entries = await readLinkOpsAuditEntries(args.auditFile, {taskId, limit});
        return sendJson(res, 200, {ok: true, taskId, entries});
      }
      if (url.pathname === '/api/link-ops-jobs') {
        if (req.method !== 'GET') return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
        const globalView = requestedGlobalOpsView(url);
        if (globalView && !actorHasGlobalOpsView(actor)) {
          return sendJson(res, 403, {ok: false, error: '只有 owner/admin 可以使用 scope=all 查看全局后台作业'});
        }
        const status = String(url.searchParams.get('status') || '').trim();
        if (status && !['queued', 'running', 'succeeded', 'failed', 'uncertain_write'].includes(status)) {
          return sendJson(res, 400, {ok: false, error: 'Invalid job status'});
        }
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 80)));
        const jobs = await linkOpsStoreGateway.listJobs({
          status,
          ownerUser: globalView ? '' : actorUser(actor, req),
          limit,
        });
        return sendJson(res, 200, {
          ok: true,
          data: jobs.filter(job => actorCanReadLinkOpsJob(actor, job, {globalView})).map(publicLinkOpsJob),
          worker: {
            enabled: Boolean(linkOpsJobWorker),
            running: Boolean(linkOpsJobWorker?.isRunning()),
          },
        });
      }
      {
        const match = /^\/api\/link-ops-jobs\/([^/]+)$/.exec(url.pathname);
        if (match) {
          if (req.method !== 'GET') return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
          const jobId = decodeURIComponent(match[1]);
          if (!/^[A-Za-z0-9._:-]{1,180}$/.test(jobId)) return sendJson(res, 400, {ok: false, error: 'Invalid job id'});
          const job = await linkOpsStoreGateway.getJob(jobId);
          if (!job) return sendJson(res, 404, {ok: false, error: 'Job not found'});
          const globalView = requestedGlobalOpsView(url);
          if (!actorCanReadLinkOpsJob(actor, job, {globalView})) {
            return sendJson(res, 403, {ok: false, error: '该后台作业属于其他 BI 账号'});
          }
          return sendJson(res, 200, {ok: true, data: publicLinkOpsJob(job)});
        }
      }
      if (url.pathname === '/api/link-ops-chats') {
        if (req.method === 'GET') {
          const current = normalizeLinkOpsChatStore(await readLinkOpsChatStore(args));
          const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 80)));
          const globalView = requestedGlobalOpsView(url);
          if (globalView && !actorHasGlobalOpsView(actor)) {
            return sendJson(res, 403, {ok: false, error: '只有 owner/admin 可以使用 scope=all 查看全局自动运营会话'});
          }
          return sendJson(res, 200, {ok: true, data: projectLinkOpsChatStoreForActor(current, actor, {limit, globalView})});
        }
        if (req.method === 'POST') {
          if (args.readOnly) return sendJson(res, 403, {ok: false, error: 'Read-only LAN preview mode'});
          const actorGate = requireConcreteOperatorActor(actor);
          if (actorGate) {
            await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-chat-denied', actor, ...requestMeta(req), denied: actorGate});
            return sendJson(res, 403, actorGate);
          }
          let body;
          try {
            body = await readBodyJson(req, 512 * 1024);
          } catch (err) {
            return sendJson(res, 400, {ok: false, error: err?.message || String(err || 'Invalid request')});
          }
          const current = normalizeLinkOpsChatStore(await readLinkOpsChatStore(args));
          const sessionId = String(body.sessionId || body.id || '').trim();
          let session;
          let created = false;
          let autoTask = null;
          let taskData = null;
          let intentPlanJob = null;
          let shouldEnqueueIntentPlan = false;
          let userMessage = '';
          let ownerKnowledgeCapture = null;
          try {
            userMessage = String(body.message || body.command || body.text || '').trim();
            if (sessionId) {
              let safeSessionId;
              try { safeSessionId = safeLinkOpsChatSessionId(sessionId); } catch (err) {
                return sendJson(res, 400, {ok: false, error: err?.message || 'Invalid chat session id'});
              }
              const existingIdx = current.sessions.findIndex(s => String(s.id || '') === safeSessionId);
              if (existingIdx < 0) return sendJson(res, 404, {ok: false, error: 'Chat session not found'});
              const sessionAccess = authorizeLinkOpsRecord(actor, current.sessions[existingIdx], {kind: 'session', mode: 'mutate', claimLegacy: true});
              if (!sessionAccess.ok) {
                await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-chat-denied', actor, ...requestMeta(req), session: {id: safeSessionId}, denied: sessionAccess.denied});
                return sendJson(res, 403, sessionAccess.denied);
              }
              current.sessions[existingIdx] = sessionAccess.record;
              session = appendChatMessage(sessionAccess.record, body, actor, req);
            } else {
              session = buildChatSessionFromMessage(body, actor, req);
              created = true;
            }
            const sessionStoreDenied = requireReadStores(actor, linkOpsSessionStores(session));
            if (sessionStoreDenied) {
              await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-chat-denied', actor, ...requestMeta(req), session: {id: session.id, created}, denied: sessionStoreDenied});
              return sendJson(res, 403, sessionStoreDenied);
            }
            // PostgreSQL enforces task.chat_session_id -> session.id. Persist a
            // brand-new chat before any auto-task is written, then update the
            // same session with assistant/preflight messages at the end.
            if (created && linkOpsStoreGateway.mode === 'postgres') {
              const bootstrapSessions = [session, ...current.sessions].slice(0, 300);
              await writeLinkOpsChatStore(args, {
                version: 1,
                updatedAt: new Date().toISOString(),
                memoryPolicy: CLOUD_AI_MEMORY_POLICY,
                sessions: bootstrapSessions,
              });
              await appendAudit(args.auditFile, {
                at: new Date().toISOString(),
                type: 'link-ops-chat-session-bootstrap',
                actor,
                ...requestMeta(req),
                session: {id: session.id, created: true},
              });
            }
            let attributeContextTask = null;
            try {
              const contextTaskData = normalizeLinkOpsTaskStore(await readLinkOpsTaskStore(args));
              attributeContextTask = findReusableChatTask(linkOpsTasksForActor(contextTaskData.tasks, actor, {mode: 'mutate'}), session.id);
            } catch {}
            const conversationTargets = inferTargetsFromChatSession(session);
            const userMessageTargets = inferLinkOpsTargets(userMessage, {attributeContextTask});
            const userAttributeOverrides = normalizeLinkOpsTargetSet(userMessageTargets).attributeOverrides;
            try {
              ownerKnowledgeCapture = await captureOwnerKnowledgeFromBiMessage({actor, userMessage, session, args, req});
            } catch (error) {
              ownerKnowledgeCapture = {captured: false, error};
            }
            const explicitActionCommand = isLinkOpsActionCommand(userMessage);
            const confirmExecuteCommand = isConfirmExecuteChatCommand(userMessage);
            const shouldAutoTask = explicitActionCommand || (confirmExecuteCommand && hasActionableLinkOpsContext(session));
            const effectiveTaskCommand = explicitActionCommand
              ? userMessage
              : shouldAutoTask
                ? buildConfirmedLinkOpsCommandFromSession(session, userMessage)
                : userMessage;
            if (shouldAutoTask) {
              const denied = requireWriteTargets(actor, conversationTargets);
              if (denied) {
                await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-chat-preflight-denied', actor, ...requestMeta(req), session: {id: session.id, created}, targets: conversationTargets, denied});
                return sendJson(res, 403, denied);
              }
            }
            let agentAnswer = '';
            let agentDurationMs = 0;
            let codexResumed = false;
            let naturalExecutionHandled = false;
            if (confirmExecuteCommand && !explicitActionCommand) {
              taskData = normalizeLinkOpsTaskStore(await readLinkOpsTaskStore(args));
              const executionResult = await runChatNaturalLanguageExecutionIfPossible({
                session,
                userMessage,
                taskData,
                actor,
                req,
                args,
              });
              naturalExecutionHandled = Boolean(executionResult.handled);
              autoTask = executionResult.task;
              taskData = executionResult.taskData;
              agentAnswer = executionResult.answer || '';
            }
            const shouldAskOpsAgent = body.askAgent !== false && !shouldAutoTask && !userAttributeOverrides.length;
            if (!naturalExecutionHandled && shouldAskOpsAgent) {
              const rememberedMessages = recentCloudAiMessages(session.messages);
              const conversation = rememberedMessages.map(m => `${m.role === 'assistant' ? '智能体' : '用户'}：${m.content}`).join('\n');
              const ownerKnowledgePrompt = await ownerKnowledgeService.promptContext({
                question: userMessage,
                stores: conversationTargets.stores,
                productRefs: conversationTargets.productRefs,
                targets: conversationTargets,
              }, {limit: 12});
              const extraRules = shouldAutoTask
                ? [
                    confirmExecuteCommand
                      ? '本条最新用户消息是对上文方案的确认执行。系统会继承上文用户意图和智能体定位，在同一会话里继续处理。'
                      : '本条最新用户消息已识别为明确运营动作命令。系统会在当前会话里开始处理，并立刻做一次不提交 SHEIN 的资料检查。',
                    '你的回复不能声称已经执行，也不要只说“没有权限所以不能”；应像 Codex 一样说明“我先查了什么、选中了哪个源链接、还缺什么、用户补哪一句就能继续”。',
                    '如果目标店铺属于 19 店已授权范围，应说明该店 OpenAPI 已授权且只读探针通过；复制/补链会优先从源链接自动取类目、属性、图片、SKU、价格、库存、尺寸重量等参数，只有自动还原失败才需要补资料；不能一上来就说缺 payload 或没有权限。',
                  ]
                : [
                    '每一轮都要根据整段会话和最新 BI JSON 上下文重新查数；如果最新用户消息换了店铺、货号或指标，以最新消息为准，缺省时再沿用上文。',
                  ];
              const question = [
                '这是 SHEIN 链接管理中台的一段运营会话。请只围绕 SHEIN 数据、链接管理、标题/图片/活动/补链建议回答。',
                '云端 AI 统一记忆规则：同一中台会话保存并传递原始会话文本，不在业务层手动摘要压缩；真正触及模型上下文上限时，由模型/调用层处理，最新用户消息永远优先。',
                '云端 AI 统一权限边界：允许电商运营分析、受控图表、标题/卖点/图片方案草稿、公开竞品参考、以及链接/商品运营任务草案；敏感登录材料和底层维护类请求只能拒绝说明，不能展示细节，也不能在聊天里直接改经营看板底层系统。',
                '明确的 SHEIN 链接/商品运营写动作（改标题、换图、补链接、上架/下架、报活动等）只能在同一会话里受控处理和资料检查，不允许绕过中台静默写后台。',
                '如果信息还不够，先问需要补充什么；如果已经可以形成任务，请给出清晰的下一步和风险边界。',
                '遇到“这个链接/这个品/2,223 这个”等指代时，必须结合上文已出现的店铺、货号、SKC、曝光/访客/销量数字重新定位；不能因为最新一句没写全就否定上轮数据。',
                '负责人已发布的长期规则只读生效；其他账号和当前模型都不得把自己的习惯反向写成长期规则。与本轮相关的负责人规则：\n' + ownerKnowledgePrompt.text,
                '会话已识别目标：' + summarizeLinkOpsTargets(conversationTargets),
                '会话已上传资料：' + summarizeLinkOpsSessionAssets(session),
                '会话目标执行能力：\n' + buildLinkOpsCapabilitySummary(conversationTargets),
                ...extraRules,
                rememberedMessages.length ? conversation : '当前没有可继承的短期上下文，请按最新用户消息独立处理。',
              ].join('\n\n');
              const startedAt = Date.now();
              let profile;
              try {
                profile = requestedAgentProfile(actor, body.agentProfile || body.profile || '', {
                  mode: 'query',
                  question: userMessage,
                  stores: conversationTargets.stores,
                });
              } catch (err) {
                const failure = agentErrorHttpDetails(err);
                return sendJson(res, failure.status, failure.body, failure.headers);
              }
              let result;
              try {
                result = await opsAgentGovernor.run(actorOpsKey(actor), () => askReadonlyOpsAgent(question, {
                  codexSessionId: session.codexSessionId || '',
                  profile,
                  routingText: userMessage,
                }), {tier: profile.name, sessionId: session.id, kind: 'chat'});
              } catch (err) {
                const failure = agentErrorHttpDetails(err);
                await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'ops-agent-chat-failed', actor, ...requestMeta(req), session: {id: session.id}, profile: modelProfilePublicSummary(profile), errorCode: failure.body.code});
                return sendJson(res, failure.status, failure.body, failure.headers);
              }
              agentDurationMs = Date.now() - startedAt;
              agentAnswer = result.answer;
              codexResumed = Boolean(result.codexResumed);
              if (result.codexSessionId) session.codexSessionId = result.codexSessionId;
              session.agentProfile = result.profile;
            }
            if (!naturalExecutionHandled && shouldAutoTask) {
              const taskStore = normalizeLinkOpsTaskStore(await readLinkOpsTaskStore(args));
              const actorTasks = linkOpsTasksForActor(taskStore.tasks, actor, {mode: 'mutate'});
              const duplicate = findDuplicateAutoTask(actorTasks, session.id, effectiveTaskCommand);
              const reusable = duplicate || findReusableChatTask(actorTasks, session.id);
              if (duplicate) {
                autoTask = duplicate;
                const denied = requireWriteStores(actor, taskWriteStores(autoTask));
                if (denied) {
                  await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-chat-auto-task-denied', actor, ...requestMeta(req), session: {id: session.id}, task: {id: autoTask.id, stores: taskTargetStores(autoTask), writeStores: taskWriteStores(autoTask), sourceStores: taskSourceStores(autoTask)}, denied});
                  return sendJson(res, 403, denied);
                }
                taskData = taskStore;
              } else if (reusable) {
                const idx = taskStore.tasks.findIndex(t => String(t.id || '') === String(reusable.id || ''));
                autoTask = updateLinkOpsTaskFromChatCommand(reusable, {
                  command: effectiveTaskCommand,
                  source: 'chat_auto_action',
                  chatSessionId: session.id,
                  targets: conversationTargets,
                  agentAnswer,
                  agentMode: agentAnswer ? 'bi-ops-chat' : '',
                  agentDurationMs,
                }, actor, req);
                const denied = requireWriteStores(actor, taskWriteStores(autoTask));
                if (denied) {
                  await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-chat-update-task-denied', actor, ...requestMeta(req), session: {id: session.id}, task: {id: autoTask.id, stores: taskTargetStores(autoTask), writeStores: taskWriteStores(autoTask), sourceStores: taskSourceStores(autoTask)}, denied});
                  return sendJson(res, 403, denied);
                }
                autoTask.status = ['done', 'archived'].includes(String(autoTask.status || '')) ? autoTask.status : 'confirmed';
                const tasks = taskStore.tasks.slice();
                if (idx >= 0) tasks[idx] = autoTask;
                taskData = {version: 1, updatedAt: new Date().toISOString(), tasks};
                await writeLinkOpsTaskStore(args, taskData);
                await appendAudit(args.auditFile, {
                  at: new Date().toISOString(),
                  type: 'link-ops-chat-update-task',
                  actor,
                  ...requestMeta(req),
                  session: {id: session.id},
                  task: {
                    id: autoTask.id,
                    status: autoTask.status,
                    intents: autoTask.intents,
                    stores: autoTask.targets?.stores || [],
                    productRefs: autoTask.targets?.productRefs || [],
                    commandLength: autoTask.command.length,
                  },
                });
              } else {
                autoTask = buildLinkOpsTaskFromCommand({
                  command: effectiveTaskCommand,
                  source: 'chat_auto_action',
                  chatSessionId: session.id,
                  targets: conversationTargets,
                  agentAnswer,
                  agentMode: agentAnswer ? 'bi-ops-chat' : '',
                  agentDurationMs,
                }, actor, req);
                const denied = requireWriteStores(actor, taskWriteStores(autoTask));
                if (denied) {
                  await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-chat-auto-task-denied', actor, ...requestMeta(req), session: {id: session.id}, task: {id: autoTask.id, stores: taskTargetStores(autoTask), writeStores: taskWriteStores(autoTask), sourceStores: taskSourceStores(autoTask)}, denied});
                  return sendJson(res, 403, denied);
                }
                autoTask.status = 'confirmed';
                autoTask.progress = Math.max(normalizeProgress(autoTask.progress, 10), 30);
                autoTask.note = '来自运营会话的明确指令；系统会先查源链接、资料缺口和店铺权限，不会静默改 SHEIN。';
                autoTask.execution = {
                  ...(autoTask.execution || {}),
                  mode: 'manual_confirm_first',
                  enabled: false,
                  note: '已收到明确运营命令；先做不提交的资料检查，真实写后台仍需你在聊天里确认，并回读结果。',
                };
                autoTask.preview = {
                  ...(autoTask.preview || {}),
                  summary: `来自会话的明确动作：${autoTask.intents.map(linkOpsIntentLabel).join(' / ')}；系统会在会话里说明源链接、缺口和下一步。`,
                };
                autoTask.history = appendTaskHistory(autoTask, 'auto_created_from_chat_command', actor, req, {
                  status: autoTask.status,
                  progress: autoTask.progress,
                  chatSessionId: session.id,
                });
                taskData = {
                  version: 1,
                  updatedAt: new Date().toISOString(),
                  tasks: [autoTask, ...taskStore.tasks].slice(0, 1000),
                };
                await writeLinkOpsTaskStore(args, taskData);
                await appendAudit(args.auditFile, {
                  at: new Date().toISOString(),
                  type: 'link-ops-chat-auto-task',
                  actor,
                  ...requestMeta(req),
                  session: {id: session.id},
                  task: {
                    id: autoTask.id,
                    status: autoTask.status,
                    intents: autoTask.intents,
                    stores: autoTask.targets?.stores || [],
                    productRefs: autoTask.targets?.productRefs || [],
                    commandLength: autoTask.command.length,
                  },
                });
              }
              const taskWithSessionAssets = mergeLinkOpsSessionAssetsIntoTask(autoTask, session, actor, req);
              if (taskWithSessionAssets !== autoTask) {
                autoTask = taskWithSessionAssets;
                taskData = replaceLinkOpsTaskInStore(taskData, autoTask);
                await writeLinkOpsTaskStore(args, taskData);
              }
              const knowledgeBinding = await bindOwnerKnowledgeToTask(autoTask, args, userMessage);
              if (knowledgeBinding.changed) {
                autoTask = knowledgeBinding.task;
                taskData = replaceLinkOpsTaskInStore(taskData, autoTask);
                await writeLinkOpsTaskStore(args, taskData);
              }
              const checkResult = await runImmediateChatSystemCheckIfPossible({
                task: autoTask,
                taskData,
                actor,
                req,
                args,
                updated: Boolean(reusable && !duplicate),
              });
              autoTask = checkResult.task;
              taskData = checkResult.taskData;
              const autoTaskNote = reusable && !duplicate
                ? '收到，我已把这句补充合并到当前处理里，不会重复开新任务。你继续在聊天里补字段或说“执行吧”即可。'
                : '收到，我已开始处理这件事。系统会在这个会话里说明选中的对象、资料缺口和下一步。';
              const humanCheckAnswer = checkResult.answer || autoTaskNote;
              agentAnswer = agentAnswer ? `${agentAnswer}\n\n${humanCheckAnswer}` : humanCheckAnswer;
              shouldEnqueueIntentPlan = Boolean(intentPlannerEnabled && autoTask?.id && explicitActionCommand);
              if (shouldEnqueueIntentPlan) {
                agentAnswer += '\n\n我已把结构化意图检查放到后台作业中；它只做辅助理解和风险提示，不会改动已经锁定的店铺、商品、参数或预演事实，更不会替你授权或直接提交 SHEIN。';
              }
            }
            if (!naturalExecutionHandled && !shouldAutoTask && userAttributeOverrides.length) {
              const taskStore = normalizeLinkOpsTaskStore(await readLinkOpsTaskStore(args));
              const reusable = findReusableChatTask(linkOpsTasksForActor(taskStore.tasks, actor, {mode: 'mutate'}), session.id);
              if (reusable) {
                const denied = requireWriteStores(actor, taskWriteStores(reusable));
                if (denied) {
                  await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-chat-attribute-update-denied', actor, ...requestMeta(req), session: {id: session.id}, task: {id: reusable.id}, denied});
                  return sendJson(res, 403, denied);
                }
                const mergedTargets = mergeLinkOpsTargets(reusable.targets || {}, {attributeOverrides: userAttributeOverrides});
                if (JSON.stringify(normalizeLinkOpsTargetSet(reusable.targets || {})) !== JSON.stringify(mergedTargets)) {
                  const idx = taskStore.tasks.findIndex(t => String(t.id || '') === String(reusable.id || ''));
                  const nowForOverride = new Date().toISOString();
                  const updatedTask = {
                    ...reusable,
                    targets: mergedTargets,
                    note: '会话已补充商品参数；系统会重新检查发布资料并刷新当前处理。',
                    execution: {
                      ...(reusable.execution && typeof reusable.execution === 'object' ? reusable.execution : {}),
                      state: 'needs_repreflight',
                      preflight: {
                        ...(reusable.execution?.preflight && typeof reusable.execution.preflight === 'object' ? reusable.execution.preflight : {}),
                        ok: false,
                        blockers: uniqueMessages([
                          ...asArray(reusable.execution?.preflight?.blockers),
                          '会话人工参数已更新，需要重新检查资料后才能提交。',
                        ]),
                      },
                    },
                    executionHistory: appendExecutionHistory(reusable, {
                      event: 'chat_manual_attribute_override',
                      at: nowForOverride,
                      sessionId: session.id,
                      message: compactChatLine(userMessage, 260),
                      attributeOverrides: userAttributeOverrides,
                      actor: actorAuditContext(actor, req),
                      requestMeta: requestMeta(req),
                    }),
                    history: appendTaskHistory(reusable, 'chat_manual_attribute_override', actor, req, {
                      sessionId: session.id,
                      attributeOverrides: userAttributeOverrides,
                    }),
                    updatedAt: nowForOverride,
                  };
                  const tasks = taskStore.tasks.slice();
                  if (idx >= 0) tasks[idx] = updatedTask;
                  taskData = {version: 1, updatedAt: nowForOverride, tasks};
                  await writeLinkOpsTaskStore(args, taskData);
                  autoTask = updatedTask;
                  await appendAudit(args.auditFile, {
                    at: nowForOverride,
                    type: 'link-ops-chat-manual-attribute-override',
                    actor,
                    ...requestMeta(req),
                    session: {id: session.id},
                    task: {id: updatedTask.id, status: updatedTask.status},
                    attributeOverrides: userAttributeOverrides,
                  });
                  const checkResult = await runImmediateChatSystemCheckIfPossible({
                    task: updatedTask,
                    taskData,
                    actor,
                    req,
                    args,
                    updated: true,
                  });
                  autoTask = checkResult.task;
                  taskData = checkResult.taskData;
                  if (checkResult.answer) {
                    agentAnswer = agentAnswer ? `${agentAnswer}\n\n${checkResult.answer}` : checkResult.answer;
                  }
                }
              } else if (!agentAnswer) {
                agentAnswer = '我收到了这个补充参数，但当前会话里还没有明确要处理的商品/链接。你直接说要做什么，例如“给 DL 的 505 缝纫机补一条链接”，我会把这个参数一起带入检查。';
              }
            }
            if (agentAnswer) {
              session = appendAssistantChatMessage(session, agentAnswer, {
                mode: 'bi-ops-chat',
                durationMs: agentDurationMs,
                codexSessionId: session.codexSessionId || '',
                codexResumed,
                agentProfile: session.agentProfile || null,
                autoTaskId: autoTask?.id || '',
              });
            }
          } catch (err) {
            return sendJson(res, 500, {ok: false, error: err?.message || String(err || 'Chat failed')});
          }
          const sessions = created
            ? [session, ...current.sessions].slice(0, 300)
            : current.sessions.map(s => String(s.id || '') === session.id ? session : s);
          const next = {version: 1, updatedAt: new Date().toISOString(), memoryPolicy: CLOUD_AI_MEMORY_POLICY, sessions};
          await writeLinkOpsChatStore(args, next);
          if (ownerKnowledgeCapture?.captured) {
            await appendAudit(args.auditFile, {
              at: new Date().toISOString(),
              type: 'owner-knowledge-bi-message-captured',
              actor,
              ...requestMeta(req),
              session: {id: session.id},
              durable: ownerKnowledgeCapture.durable,
              result: {count: ownerKnowledgeCapture.result.results.length, active: ownerKnowledgeCapture.result.results.filter(row => row.activation === 'active').length},
            });
          } else if (ownerKnowledgeCapture?.error) {
            await appendAudit(args.auditFile, {
              at: new Date().toISOString(),
              type: 'owner-knowledge-bi-message-capture-failed',
              actor,
              ...requestMeta(req),
              session: {id: session.id},
              error: String(ownerKnowledgeCapture.error?.message || ownerKnowledgeCapture.error).slice(0, 500),
            });
          }
          if (shouldEnqueueIntentPlan && autoTask) {
            try {
              intentPlanJob = await enqueueIntentPlanJob({task: autoTask, session, message: userMessage, actor, req});
              await appendAudit(args.auditFile, {
                at: new Date().toISOString(),
                type: 'link-ops-intent-plan-queued',
                actor,
                ...requestMeta(req),
                session: {id: session.id},
                task: {id: autoTask.id},
                job: publicLinkOpsJob(intentPlanJob),
              });
            } catch (error) {
              await appendAudit(args.auditFile, {
                at: new Date().toISOString(),
                type: 'link-ops-intent-plan-queue-failed',
                actor,
                ...requestMeta(req),
                session: {id: session.id},
                task: {id: autoTask.id},
                error: String(error?.message || error).slice(0, 500),
              });
            }
          }
          await appendAudit(args.auditFile, {
            at: new Date().toISOString(),
            type: 'link-ops-chat',
            actor,
            ...requestMeta(req),
            session: {id: session.id, created, messageCount: Array.isArray(session.messages) ? session.messages.length : 0},
          });
          return sendJson(res, 200, {
            ok: true,
            data: projectLinkOpsChatStoreForActor(next, actor, {limit: 300}),
            session: projectLinkOpsChatSessionForClient(session),
            autoTask: autoTask ? projectLinkOpsTaskForClient(autoTask) : null,
            job: publicLinkOpsJob(intentPlanJob),
            taskData: taskData ? projectLinkOpsTaskStoreForActor(taskData, actor, {limit: 500}) : null,
          });
        }
        if (req.method === 'PATCH') {
          if (args.readOnly) return sendJson(res, 403, {ok: false, error: 'Read-only LAN preview mode'});
          const actorGate = requireConcreteOperatorActor(actor);
          if (actorGate) {
            await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-chat-update-denied', actor, ...requestMeta(req), denied: actorGate});
            return sendJson(res, 403, actorGate);
          }
          const body = await readBodyJson(req, 256 * 1024).catch(err => ({_error: err?.message || String(err)}));
          if (body._error) return sendJson(res, 400, {ok: false, error: body._error});
          let id = String(body.id || body.sessionId || '').trim();
          if (!id) return sendJson(res, 400, {ok: false, error: 'Missing session id'});
          try { id = safeLinkOpsChatSessionId(id); } catch (err) {
            return sendJson(res, 400, {ok: false, error: err?.message || 'Invalid chat session id'});
          }
          const current = normalizeLinkOpsChatStore(await readLinkOpsChatStore(args));
          const idx = current.sessions.findIndex(s => String(s.id || '') === id);
          if (idx < 0) return sendJson(res, 404, {ok: false, error: 'Chat session not found'});
          const access = authorizeLinkOpsRecord(actor, current.sessions[idx], {kind: 'session', mode: 'mutate', claimLegacy: true});
          if (!access.ok) {
            await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-chat-update-denied', actor, ...requestMeta(req), session: {id}, denied: access.denied});
            return sendJson(res, 403, access.denied);
          }
          const session = {
            ...access.record,
            title: typeof body.title === 'string' ? body.title.trim().slice(0, 100) : access.record.title,
            autoTitle: typeof body.title === 'string' ? false : access.record.autoTitle,
            status: typeof body.status === 'string' ? body.status.trim().slice(0, 40) : access.record.status,
            memoryPolicy: CLOUD_AI_MEMORY_POLICY,
            updatedAt: new Date().toISOString(),
          };
          const sessions = current.sessions.slice();
          sessions[idx] = session;
          const next = {version: 1, updatedAt: new Date().toISOString(), memoryPolicy: CLOUD_AI_MEMORY_POLICY, sessions};
          await writeLinkOpsChatStore(args, next);
          await appendAudit(args.auditFile, {
            at: new Date().toISOString(),
            type: 'link-ops-chat-update',
            actor,
            ...requestMeta(req),
            session: {id, claimedLegacy: access.claimedLegacy, ownershipMigrated: access.ownershipMigrated, status: session.status || ''},
          });
          return sendJson(res, 200, {
            ok: true,
            data: projectLinkOpsChatStoreForActor(next, actor, {limit: 300}),
            session: projectLinkOpsChatSessionForClient(session),
          });
        }
        if (req.method === 'DELETE') {
          if (args.readOnly) return sendJson(res, 403, {ok: false, error: 'Read-only LAN preview mode'});
          const actorGate = requireConcreteOperatorActor(actor);
          if (actorGate) {
            await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-chat-delete-denied', actor, ...requestMeta(req), denied: actorGate});
            return sendJson(res, 403, actorGate);
          }
          let id = String(url.searchParams.get('id') || '').trim();
          if (!id) return sendJson(res, 400, {ok: false, error: 'Missing session id'});
          try { id = safeLinkOpsChatSessionId(id); } catch (err) {
            return sendJson(res, 400, {ok: false, error: err?.message || 'Invalid chat session id'});
          }
          const current = normalizeLinkOpsChatStore(await readLinkOpsChatStore(args));
          const sessionIdx = current.sessions.findIndex(s => String(s.id || '') === id);
          if (sessionIdx < 0) return sendJson(res, 404, {ok: false, error: 'Chat session not found'});
          const access = authorizeLinkOpsRecord(actor, current.sessions[sessionIdx], {kind: 'session', mode: 'mutate', claimLegacy: true});
          if (!access.ok) {
            await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-chat-delete-denied', actor, ...requestMeta(req), session: {id}, denied: access.denied});
            return sendJson(res, 403, access.denied);
          }
          const deletedSession = access.record;
          let codexSessionDelete = {ok: true, skipped: true, reason: 'no_codex_session_id', deletedFiles: []};
          if (deletedSession?.codexSessionId) {
            try {
              codexSessionDelete = await deleteCodexSessionRecord(deletedSession.codexSessionId);
            } catch (err) {
              codexSessionDelete = {
                ok: false,
                sessionId: safeCodexSessionId(deletedSession.codexSessionId),
                deletedFiles: [],
                warnings: [String(err?.message || err).slice(0, 300)],
              };
            }
          }
          const next = {version: 1, updatedAt: new Date().toISOString(), memoryPolicy: CLOUD_AI_MEMORY_POLICY, sessions: current.sessions.filter(s => String(s.id || '') !== id)};
          await writeLinkOpsChatStore(args, next);
          await appendAudit(args.auditFile, {
            at: new Date().toISOString(),
            type: 'link-ops-chat-delete',
            actor,
            ...requestMeta(req),
            session: {
              id,
              existed: Boolean(deletedSession),
              messageCount: Array.isArray(deletedSession?.messages) ? deletedSession.messages.length : 0,
              codexSessionId: deletedSession?.codexSessionId || '',
              codexSessionDelete,
            },
          });
          return sendJson(res, 200, {
            ok: true,
            data: projectLinkOpsChatStoreForActor(next, actor, {limit: 300}),
            deleted: {
              id,
              existed: Boolean(deletedSession),
              codexSession: {
                ok: codexSessionDelete.ok !== false,
                skipped: Boolean(codexSessionDelete.skipped),
                deletedFiles: Array.isArray(codexSessionDelete.deletedFiles) ? codexSessionDelete.deletedFiles.length : 0,
              },
            },
          });
        }
        return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
      }
      if (url.pathname === '/api/ops-agent/ask') {
        if (req.method === 'POST') {
          if (args.readOnly) {
            return sendJson(res, 403, {ok: false, error: 'Read-only LAN preview mode'});
          }
          let body;
          try {
            body = await readBodyJson(req, 256 * 1024);
          } catch (err) {
            return sendJson(res, 400, {ok: false, error: err?.message || String(err || 'Invalid request')});
          }
          const question = String(body.question || body.command || body.text || '').trim();
          const startedAt = Date.now();
          try {
            const profile = requestedAgentProfile(actor, body.profile || body.agentProfile || '', {mode: 'query', question});
            const result = await opsAgentGovernor.run(actorOpsKey(actor), () => askReadonlyOpsAgent(question, {
              profile,
              routingText: question,
            }), {tier: profile.name, kind: 'ask'});
            await appendAudit(args.auditFile, {
              at: new Date().toISOString(),
              type: 'ops-agent-ask',
              actor,
              ...requestMeta(req),
              questionPreview: question.slice(0, 240),
              answerLength: result.answer.length,
              durationMs: Date.now() - startedAt,
              profile: result.profile,
              ok: true,
            });
            return sendJson(res, 200, {
              ok: true,
              mode: 'bi-ops-chat',
              answer: result.answer,
              durationMs: Date.now() - startedAt,
              profile: result.profile,
            });
          } catch (err) {
            await appendAudit(args.auditFile, {
              at: new Date().toISOString(),
              type: 'ops-agent-ask',
              actor,
              ...requestMeta(req),
              questionPreview: question.slice(0, 240),
              durationMs: Date.now() - startedAt,
              ok: false,
              error: String(err?.message || err).slice(0, 500),
            });
            const failure = agentErrorHttpDetails(err);
            return sendJson(res, failure.status, failure.body, failure.headers);
          }
        }
        return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        scheduleBiPortalCoreWarmup(args, root, {allowGenerate: allowGenerateSections, reason: 'index'}).catch(err => {
          biPortalCoreWarmupState.lastError = err?.message || String(err || 'schedule failed');
          logBiPortalCoreWarmup('schedule-failed', {reason: 'index', error: biPortalCoreWarmupState.lastError.slice(0, 500)});
        });
      }
      let file = safePath(root, req.url || '/');
      if (!file) return send(res, 403, 'Forbidden', {'Content-Type': 'text/plain; charset=utf-8'});
      let stat;
      try {
        stat = await fs.stat(file);
      } catch {
        return send(res, 404, 'Not found', {'Content-Type': 'text/plain; charset=utf-8'});
      }
      if (stat.isDirectory()) {
        file = path.join(file, 'index.html');
        try {
          stat = await fs.stat(file);
        } catch {
          return send(res, 404, 'Not found', {'Content-Type': 'text/plain; charset=utf-8'});
        }
      }
      const ext = path.extname(file).toLowerCase();
      const data = await fs.readFile(file);
      send(res, 200, data, {'Content-Type': types[ext] || 'application/octet-stream'});
    } catch (err) {
      const storageFailure = linkOpsRepositoryHttpDetails(err);
      if (storageFailure) {
        return sendJson(res, storageFailure.status, storageFailure.body);
      }
      if (String(req.url || '').startsWith('/api/')) {
        return sendJson(res, 500, {ok: false, error: 'Server error'});
      }
      send(res, 500, 'Server error', {'Content-Type': 'text/plain; charset=utf-8'});
    }
  };

  const server = http.createServer((req, res) => {
    const task = () => handleRequest(req, res);
    if (isMutationMethod(req.method)) {
      void enqueueMutationRequest(task);
      return;
    }
    void task();
  });

  server.on('upgrade', (req, socket) => {
    handleManualLoginWsUpgrade(req, socket, args, {authRequired, authUsers, sessionSecret}).catch(err => {
      try {
        socket.write(`HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${String(err?.message || err)}`);
      } catch {}
      try { socket.destroy(); } catch {}
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(args.port, args.host, resolve);
  });

  startBiPortalCoreWarmupWatcher(args, root, {allowGenerate: allowGenerateSections});
  linkOpsJobWorker?.start();

  let shuttingDown = false;
  const shutdown = async signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ok: true, event: 'shutdown', signal, time: new Date().toISOString()}));
    await linkOpsJobWorker?.stop();
    await new Promise(resolve => server.close(resolve));
    await linkOpsStoreGateway.close();
  };
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('SIGINT', () => { void shutdown('SIGINT'); });

  const urlHost = args.host === '0.0.0.0' ? '127.0.0.1' : args.host;
  console.log(JSON.stringify({
    ok: true,
    url: `http://${urlHost}:${args.port}/`,
    host: args.host,
    port: args.port,
    root,
    stateFile: args.stateFile,
    linkOpsTaskFile: args.linkOpsTaskFile,
    linkOpsChatFile: args.linkOpsChatFile,
    linkOpsRuntimeFile: args.linkOpsRuntimeFile,
    linkOpsStorage: initialLinkOpsStorageHealth,
    ownerKnowledgeDistribution: {
      ready: Boolean(initialOwnerKnowledgeDistribution?.ready),
      current: Boolean(initialOwnerKnowledgeDistribution?.current),
      source: String(initialOwnerKnowledgeDistribution?.source || ''),
      ruleCount: Number(initialOwnerKnowledgeDistribution?.ruleCount || 0),
    },
    manualLoginStateFile: args.manualLoginStateFile,
    lanMode: args.host === '0.0.0.0',
    readOnly: args.readOnly,
    authRequired,
    allowGenerateSections,
    biCoreWarmupSections: configuredBiPortalCoreWarmupSections(),
    authUsers: authUsers.map(u => ({username: u.username, displayName: u.displayName, role: u.role, source: u.source})),
  }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
