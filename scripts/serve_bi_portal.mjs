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
import {gzipSync} from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORES_PATH = path.join(ROOT, 'config', 'stores.json');
const SHEIN_OPENAPI_LOCAL_CONFIG_FILE = process.env.SHEIN_OPENAPI_CONFIG_FILE || path.join(ROOT, 'config', 'shein_openapi.local.json');
const BI_OPS_WRITE_WHITELIST_FILE = process.env.SHEIN_BI_OPS_WRITE_WHITELIST_FILE || path.join(ROOT, 'config', 'bi_ops_write_whitelist.local.json');

function parseArgs(argv) {
  const args = {
    host: '127.0.0.1',
    port: 8787,
    dir: path.join(ROOT, 'outputs', 'bi-portal'),
    stateFile: path.join(ROOT, 'state', 'bi_action_state.json'),
    linkOpsTaskFile: path.join(ROOT, 'state', 'bi_link_ops_tasks.json'),
    linkOpsChatFile: path.join(ROOT, 'state', 'bi_link_ops_chats.json'),
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
const DEFAULT_SHEIN_STORE_KEYS = ['DL', 'DX', 'FY', 'LQ', 'NM', 'HL', 'JY', 'ZL', 'TS', 'MZ', 'CX', 'YJ', 'XL', 'QY', 'QH', 'TZ', 'JSH', 'TZZ', 'XC'];
const DEFAULT_MANUAL_LOGIN_STORE_KEYS = ['DL', 'DX', 'FY', 'LQ', 'NM', 'HL', 'JY', 'ZL', 'TS', 'MZ', 'CX', 'YJ', 'XL', 'QY', 'QH', 'TZ', 'JSH', 'TZZ', 'XC'];
const BI_PORTAL_SECTION_KEYS = new Set(['homeProfit', 'homeRankings', 'rankings', 'profit', 'actions', 'linksData', 'productTrafficDaily', 'inventoryTrend', 'comments', 'orders', 'afterSales', 'rtvData', 'waybills']);
const BI_PORTAL_SECTION_TIMEOUT_MS = Math.max(60_000, Number(process.env.SHEIN_BI_SECTION_TIMEOUT_MS || 900_000));
const OPENAPI_READ_PROBE_SUMMARY_FILE = path.join(ROOT, 'state', 'openapi-probes', 'read-probes.latest.json');
const OPENAPI_SALES_RECONCILIATION_SUMMARY_FILE = path.join(ROOT, 'state', 'openapi-probes', 'sales-reconciliation.latest.json');
const OPENAPI_RETURN_RECONCILIATION_SUMMARY_FILE = path.join(ROOT, 'state', 'openapi-probes', 'return-reconciliation.latest.json');
const OPENAPI_PRODUCT_RECONCILIATION_SUMMARY_FILE = path.join(ROOT, 'state', 'openapi-probes', 'product-reconciliation.latest.json');
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
const LINK_OPS_STORE_CAPABILITIES = {
  HL: {
    openapiAuthorized: true,
    verifiedRead: true,
    salesReconciliation: true,
    productPublishAdapter: true,
    readDomains: ['store_info', 'site_currency', 'warehouse', 'product', 'stock', 'order', 'return', 'finance'],
    writeDomains: ['product_publish_precheck'],
    note: 'HL 已完成 SHEIN OpenAPI 真实授权，并已验证商品/订单/库存等只读接口和销售对账；商品发布/编辑执行器已接入受控预检，真实提交仍要求 payload 完整和显式确认。',
  },
};
const LINK_OPS_OPENAPI_SUBMIT_CONFIRM_TEXT = 'SHEIN_OPENAPI_SUBMIT';
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
  product_publish_precheck: '商品发布/编辑预检',
  product_status_precheck: '上下架预检',
  marketing_precheck: '营销报名预检',
};

const LINK_MAINTENANCE_INTENTS = new Set(['retire_link', 'update_title', 'update_images']);
const LINK_OPS_MAINTENANCE_OFFICIAL_CANDIDATES = {
  retire_link: {
    endpoint: '/open-api/goods/modify-skc-shelf',
    label: '商品上下架',
    docUrl: 'https://open.sheincorp.com/documents/apidoc/detail/3001629',
    evidence: 'SHEIN 官方文档索引显示该接口为“商品上下架”；搜索索引还提示下架需设置 shelf_state=2。',
    missing: ['请求参数 schema 未从登录态官方详情页确认', '权限包/店铺授权范围未逐店验证', '执行后商品列表/详情回读字段未验证'],
  },
  update_title: {
    endpoint: '/open-api/goods/product/publishOrEdit',
    label: '商品发布/编辑',
    docUrl: 'https://open.sheincorp.com/documents/apidoc/detail/3001707',
    evidence: '已验证 publishOrEdit 是商品发布/编辑接口，但当前只作为 copy_product_draft 的完整 payload 执行器使用。',
    missing: ['改标题最小 payload 未验证', '仅改标题是否影响图片/库存/价格/站点等字段未验证', '执行后标题回读字段未验证'],
  },
  update_images: {
    endpoint: '/open-api/goods/product/publishOrEdit',
    label: '商品发布/编辑',
    docUrl: 'https://open.sheincorp.com/documents/apidoc/detail/3001707',
    evidence: '已验证 publishOrEdit 是商品发布/编辑接口，但当前只作为 copy_product_draft 的完整 payload 执行器使用。',
    missing: ['换图最小 payload 未验证', '仅换图是否影响标题/库存/价格/站点等字段未验证', '执行后图片回读字段未验证'],
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
    reason: '可做 OpenAPI 商品发布/编辑 payload 预检；真实 publishOrEdit 只在 payload 完整、任务待复核、显式确认文本同时满足时才会提交。',
  },
  {
    key: 'retire_link',
    label: '下架 / 归档链接',
    intent: 'retire_link',
    stage: 'link_maintenance_dry_run',
    precheck: true,
    realSubmit: false,
    reason: '已能定位目标链接、校验写权限和唯一承接风险；已发现官方候选接口 /open-api/goods/modify-skc-shelf，但参数、权限和回读未验证，所以不会真实下架。',
  },
  {
    key: 'update_title',
    label: '改标题',
    intent: 'update_title',
    stage: 'link_maintenance_dry_run',
    precheck: true,
    realSubmit: false,
    reason: '已能校验目标链接、写权限和标题素材；publishOrEdit 可能可编辑商品，但改标题最小 payload 与回读未验证，所以不会真实改标题。',
  },
  {
    key: 'update_images',
    label: '换图',
    intent: 'update_images',
    stage: 'link_maintenance_dry_run',
    precheck: true,
    realSubmit: false,
    reason: '已能校验目标链接、写权限和图片素材；publishOrEdit 可能可编辑商品，但换图最小 payload 与回读未验证，所以不会真实换图。',
  },
  {
    key: 'campaign_signup',
    label: '营销活动报名',
    intent: 'campaign_signup',
    stage: 'task_only',
    precheck: false,
    realSubmit: false,
    reason: '营销报名仍走本地/运营专用流程，尚未接入 BI 自动运营真实提交。',
  },
  {
    key: 'flash_discount',
    label: '限时折扣',
    intent: 'flash_discount',
    stage: 'task_only',
    precheck: false,
    realSubmit: false,
    reason: '限时折扣仍走本地/运营专用流程，尚未接入 BI 自动运营真实提交。',
  },
  {
    key: 'certificate_review',
    label: '证书 / 资质',
    intent: 'certificate_review',
    stage: 'task_only',
    precheck: false,
    realSubmit: false,
    reason: '资质证书目前只进入任务池和素材管理，尚未接入 SHEIN 真实上传/提交接口。',
  },
];

const LINK_OPS_REAL_SUBMIT_REQUIREMENTS = [
  '具体 BI 登录账号',
  '目标店铺写权限',
  '动作具备真实提交适配器',
  'dry-run 预检通过',
  '任务停在待复核状态',
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
  return false;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
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

async function writeBufferFileAtomic(file, buffer) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, buffer);
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
    const fresh = Number.isFinite(generatedAtMs) && Date.now() - generatedAtMs <= OPENAPI_READ_PROBE_FRESH_MS;
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

function loadOpenApiSalesReconciliationSummarySync() {
  try {
    const summary = JSON.parse(fssync.readFileSync(OPENAPI_SALES_RECONCILIATION_SUMMARY_FILE, 'utf8'));
    const generatedAtMs = Date.parse(summary?.generatedAt || '');
    const fresh = Number.isFinite(generatedAtMs) && Date.now() - generatedAtMs <= OPENAPI_SALES_RECONCILIATION_FRESH_MS;
    const byStore = new Map();
    for (const result of Array.isArray(summary?.results) ? summary.results : []) {
      const key = String(result?.storeKey || '').trim().toUpperCase();
      if (!key) continue;
      const row = Array.isArray(result?.load?.reconciliation) ? result.load.reconciliation[0] : null;
      byStore.set(key, {
        status: result?.status || row?.status || '',
        ok: Boolean(result?.ok),
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
    const fresh = Number.isFinite(generatedAtMs) && Date.now() - generatedAtMs <= OPENAPI_RETURN_RECONCILIATION_FRESH_MS;
    const byStore = new Map();
    for (const result of Array.isArray(summary?.results) ? summary.results : []) {
      const key = String(result?.storeKey || '').trim().toUpperCase();
      if (!key) continue;
      const row = summarizeOpenApiReturnRows(result?.load?.reconciliation) || result?.reconciliation || null;
      byStore.set(key, {
        status: result?.status || row?.status || '',
        ok: Boolean(result?.ok) && (!row || row.status === 'matched'),
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
    const fresh = Number.isFinite(generatedAtMs) && Date.now() - generatedAtMs <= OPENAPI_PRODUCT_RECONCILIATION_FRESH_MS;
    const byStore = new Map();
    for (const result of Array.isArray(summary?.results) ? summary.results : []) {
      const key = String(result?.storeKey || '').trim().toUpperCase();
      if (!key) continue;
      const row = Array.isArray(result?.load?.reconciliation) ? result.load.reconciliation[0] : result?.reconciliation || null;
      byStore.set(key, {
        status: result?.status || row?.status || '',
        ok: Boolean(result?.ok),
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

function openApiStoreCapability(storeKey) {
  const {config, configured} = openApiConfiguredStoresSync();
  const probeSummary = loadOpenApiReadProbeSummarySync();
  const key = String(storeKey || '').trim().toUpperCase();
  const local = configured.get(key) || null;
  const staticCap = LINK_OPS_STORE_CAPABILITIES[key] || {};
  const enabled = Boolean(local?.enabled);
  const hasOpenKey = Boolean(String(local?.openKeyId || '').trim());
  const hasSecret = Boolean(String(local?.secretKey || '').trim());
  const authorized = enabled && hasOpenKey && hasSecret;
  const probeResult = probeSummary.byStore.get(key) || null;
  const probeReadReady = authorized && probeSummary.fresh && openApiProbeResultIsReadReady(probeResult);
  const verifiedRead = authorized && (Boolean(staticCap.verifiedRead) || probeReadReady);
  const productPublishPrecheckAdapter = authorized && verifiedRead;
  const safeWrite = safeWriteOperationAllowed(config, {operation: 'copy_product_draft', storeKey: key});
  const whitelistConfigured = biOpsWriteWhitelistConfigured({operation: 'copy_product_draft', storeKey: key});
  const productPublishExecuteAdapter = authorized
    && Boolean(staticCap.productPublishAdapter)
    && safeWrite.allowed
    && whitelistConfigured.configured;
  return {
    storeKey: key,
    configured: configured.has(key),
    enabled,
    authorized,
    verifiedRead,
    probeReadReady,
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
        ? '已具备商品发布/编辑执行适配器；仍必须 payload 完整、任务待复核、显式确认文本和回读证据齐全才可提交。'
        : precheckSupported
          ? '已具备商品发布/编辑 dry-run 预检；真实提交适配器未对该店放行。'
          : cap.authorized
            ? '已授权但只读探针/商品双跑尚未证明可用，暂不能进入商品发布 dry-run。'
            : '店铺尚未完成 OpenAPI 授权，不能进入商品发布 dry-run。';
      if (!cap.authorized) realSubmitBlockers.push('店铺未完成 OpenAPI 授权/密钥配置');
      if (cap.authorized && !cap.verifiedRead) realSubmitBlockers.push('最近只读探针/商品能力尚未证明可用');
      if (precheckSupported && cap.staticCap?.productPublishAdapter && !cap.safeWrite?.enabled) realSubmitBlockers.push('真实写总闸门未开启：safeWriteOperations.enabled=false');
      if (precheckSupported && cap.staticCap?.productPublishAdapter && cap.safeWrite?.enabled && !cap.safeWrite?.operationAllowed) realSubmitBlockers.push('真实写动作未进入 safeWriteOperations.allowedOperations 白名单');
      if (precheckSupported && cap.staticCap?.productPublishAdapter && cap.safeWrite?.enabled && !cap.safeWrite?.storeAllowed) realSubmitBlockers.push('目标店铺未进入 safeWriteOperations.allowedStores 白名单');
      if (precheckSupported && cap.staticCap?.productPublishAdapter && cap.safeWrite?.allowed && !cap.realSubmitWhitelist?.enabled) realSubmitBlockers.push('真实写试点白名单未启用：bi_ops_write_whitelist.local.json enabled=false');
      if (precheckSupported && cap.staticCap?.productPublishAdapter && cap.safeWrite?.allowed && cap.realSubmitWhitelist?.enabled && !cap.realSubmitWhitelist?.configured) realSubmitBlockers.push('真实写试点白名单未配置该店铺+动作+账号');
      if (precheckSupported && !cap.productPublishExecuteAdapter) realSubmitBlockers.push('商品发布/编辑真实提交适配器未对该店放行');
      nextStep = realSubmitSupported
        ? '先创建任务并跑 dry-run；只有任务回到待复核且 payload 完整时，网页/CLI 才可带确认文本执行。'
        : precheckSupported
          ? '继续完善 payload 与执行器放行条件；当前只允许 dry-run 预检。'
          : cap.authorized
            ? '先跑/修复只读探针和商品双跑，再进入商品发布 dry-run。'
            : '先完成该店 OpenAPI 授权和云端私有密钥配置。';
    } else if (LINK_MAINTENANCE_INTENTS.has(def.intent)) {
      precheckSupported = true;
      realSubmitSupported = false;
      state = 'dry_run_only_no_real_submit';
      const candidate = LINK_OPS_MAINTENANCE_OFFICIAL_CANDIDATES[def.intent] || null;
      if (candidate) {
        realSubmitBlockers.push(`官方候选接口 ${candidate.endpoint}（${candidate.label}）尚未完成安全验证`);
        for (const item of candidate.missing || []) realSubmitBlockers.push(item);
        nextStep = `先用隔离探针验证 ${candidate.endpoint} 的参数、权限包和执行后商品列表/详情回读；在 payload、回读和异常锁定都确认前，只允许目标定位和风险 dry-run。`;
      } else {
        realSubmitBlockers.push('尚未接入 SHEIN 官方维护写接口');
        realSubmitBlockers.push('尚未验证维护动作执行后回读字段');
        nextStep = '先研究并验证官方维护写接口；在接口、payload、回读都确认前，只允许目标定位和风险 dry-run。';
      }
    } else {
      precheckSupported = false;
      realSubmitSupported = false;
      state = 'task_only_no_adapter';
      realSubmitBlockers.push('该动作当前只有任务池/人工流程，没有自动执行适配器');
      nextStep = '先补动作专属预检和执行器，再讨论真实提交。';
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
    const cap = openApiStoreCapability(storeKey);
    const {local, staticCap, enabled, authorized} = cap;
    const probeResult = probeSummary.byStore.get(storeKey) || null;
    const salesReconciliation = salesReconciliationSummary.byStore.get(storeKey) || null;
    const returnReconciliation = returnReconciliationSummary.byStore.get(storeKey) || null;
    const productReconciliation = productReconciliationSummary.byStore.get(storeKey) || null;
    const probeReadReady = authorized && probeSummary.fresh && openApiProbeResultIsReadReady(probeResult);
    const verifiedRead = authorized && (Boolean(staticCap.verifiedRead) || probeReadReady);
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
      note: staticCap.note || (probeReadReady
        ? `云端只读探针已通过（${probeSummary.summary?.generatedAt || 'unknown'}），销售双跑${salesReconciliation ? ` ${salesReconciliation.date || ''}=${salesReconciliation.status || 'unknown'}` : '待调度'}，退货双跑${returnReconciliation ? ` ${returnReconciliation.date || ''}=${returnReconciliation.status || 'unknown'}` : '待调度'}，商品基础资料双跑${productReconciliation ? `=${productReconciliation.status || 'unknown'}` : '待调度'}；商品发布/编辑可进入 OpenAPI dry-run 权限与 payload 预检，真实写操作仍需单独适配、人工确认和回读。`
        : authorized
          ? (probeResult && !openApiProbeResultIsReadReady(probeResult)
            ? `已授权，但最近云端只读探针未通过：${probeResult.status || 'unknown'}。`
            : '已检测到本地私有授权配置，但尚未完成新鲜的云端只读探针/对账登记。')
          : '待开放平台授权、换取店铺级 API 凭据，并写入云端私有配置。'),
    };
  });
  const counts = rows.reduce((acc, r) => {
    acc.total += 1;
    if (r.authorized) acc.authorized += 1;
    if (r.verifiedRead) acc.readReady += 1;
    if (r.salesReconciliation) acc.salesReconciliationReady += 1;
    if (r.returnReconciliation) acc.returnReconciliationReady += 1;
    if (r.productReconciliation) acc.productReconciliationReady += 1;
    if (r.writePrecheckReady) acc.writePrecheckReady += 1;
    if (r.writeConfirmable) acc.writeConfirmable += 1;
    return acc;
  }, {total: 0, authorized: 0, readReady: 0, salesReconciliationReady: 0, returnReconciliationReady: 0, productReconciliationReady: 0, writePrecheckReady: 0, writeConfirmable: 0});
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

function isInternalSystemActor(actor) {
  return String(actor?.username || '') === 'local-system' || String(actor?.role || '').toLowerCase() === 'system';
}

function requireConcreteOperatorActor(actor) {
  if (!isInternalSystemActor(actor)) return null;
  return {
    ok: false,
    error: '自动运营写操作必须使用具体 BI 登录账号，不能使用服务器内部任务身份',
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
</style></head><body><main class="shell"><section class="hero"><div><div class="eyebrow">SHEIN BI · Ops Console</div><h1>经营数据和自动运营，统一从这里进入。</h1><p>登录后可以查看全部店铺数据；自动运营写操作会按账号权限控制店铺范围，并写入审计日志。</p><div class="chips"><span>全店数据可读</span><span>店铺写权限隔离</span><span>操作可追溯</span><span>Codex 受控网关</span></div></div><p>安全边界：不会静默修改 SHEIN，写动作必须进入任务池、预检、确认、执行器和回读链路。</p></section><section class="card"><h2>登录 BI</h2><p class="sub">使用你的 BI 账号进入。原公网账号密码继续有效，只是不再使用浏览器弹框。</p>${error ? `<div class="err">${htmlEscape(error)}</div>` : ''}<form method="post" action="/api/login"><input type="hidden" name="next" value="${htmlEscape(safeNext)}"/><div class="field"><label>账号</label><input name="username" autocomplete="username" value="${htmlEscape(user)}" autofocus required/></div><div class="field"><label>密码</label><input name="password" type="password" autocomplete="current-password" required/></div><button class="btn" type="submit">进入系统</button></form><div class="foot">如果你能看到这个页面，说明公网 Basic Auth 已经不再拦截；后续权限会在系统内识别到具体操作者。</div></section></main></body></html>`;
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

function inferLinkOpsIntent(command) {
  const text = String(command || '').trim();
  const lower = text.toLowerCase();
  const intents = [];
  if (/补|复制|上品|上架|草稿|覆盖|缺链接|缺链/.test(text) || /\b(copy|draft|create|publish|coverage)\b/.test(lower)) intents.push('copy_product_draft');
  if (/标题|title/.test(lower)) intents.push('update_title');
  if (/主图|图片|套图|image|photo|pic/.test(lower)) intents.push('update_images');
  if (/下架|死链|淘汰|归档|停掉|移除|删除链接/.test(text)) intents.push('retire_link');
  if (/营销|活动|报名/.test(text)) intents.push('campaign_signup');
  if (/限时|折扣|秒杀|促销|discount/.test(lower)) intents.push('flash_discount');
  if (/证书|资质|合规/.test(text)) intents.push('certificate_review');
  if (!intents.length) intents.push('manual_review');
  return intents;
}

function linkOpsIntentLabel(intent) {
  return ({
    copy_product_draft: '补链接/复制上品',
    update_title: '换标题',
    update_images: '换图',
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
    task_created: '已建任务',
    draft: '草案',
    confirmed: '待开始',
    in_progress: '执行中',
    waiting_review: '待复核',
    done: '完成',
    archived: '归档',
  })[status] || String(status || '');
}

function inferLinkOpsTargets(command) {
  const text = String(command || '');
  const allStoresRequested = /全店|所有店|全部店|19\s*店|十九\s*店|各店|每个店/.test(text);
  const storeMatches = allStoresRequested
    ? DEFAULT_MANUAL_LOGIN_STORE_KEYS
    : [...new Set((text.match(/\b[A-Z]{2,3}\b/g) || [])
    .map(x => x.toUpperCase())
    .filter(x => SHEIN_STORE_KEYS.has(x)))].slice(0, 24);
  const copyToMatch = /(?:从|复制|拷贝|参考)?\s*\b([A-Z]{2,3})\b[\s\S]{0,48}?(?:到|至|给|复制到|拷贝到|上到|铺到)\s*\b([A-Z]{2,3})\b/i.exec(text);
  const sourceStores = [];
  const writeStores = [];
  if (copyToMatch) {
    const source = String(copyToMatch[1] || '').trim().toUpperCase();
    const target = String(copyToMatch[2] || '').trim().toUpperCase();
    if (SHEIN_STORE_KEYS.has(source)) sourceStores.push(source);
    if (SHEIN_STORE_KEYS.has(target)) writeStores.push(target);
  }
  const skuMatches = [...new Set((text.match(/\b(?:[A-Z]{1,6}-?\d{1,8}[A-Z]?(?:-[A-Z0-9]+)?(?:[\u4e00-\u9fa5A-Za-z0-9-]*)?|(?:sv|sb)\d{8,})\b/giu) || [])
    .map(x => x
      .replace(/[，。；、,.]+$/g, '')
      .replace(/(各店|全店|所有店|差链接|弱链接|死链接|缺链接|链接|建议|下架|换图|补新|补链|覆盖).*$/u, ''))
    .filter(x => /\d/.test(x)))].slice(0, 24);
  return {
    stores: storeMatches,
    sourceStores,
    writeStores,
    productRefs: skuMatches,
  };
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
  const productRefs = Array.isArray(targets?.productRefs)
    ? targets.productRefs
    : typeof targets?.productRefs === 'string'
      ? targets.productRefs.split(/[,\s，、]+/)
      : [];
  const clean = (arr, max) => [...new Set(arr
    .map(x => String(x || '').trim())
    .filter(Boolean))]
    .slice(0, max);
  return {
    stores: clean(stores, 32),
    sourceStores: clean(sourceStores, 32),
    writeStores: clean(writeStores, 32),
    productRefs: clean(productRefs, 48),
  };
}

function mergeLinkOpsTargets(...items) {
  return normalizeLinkOpsTargetSet({
    stores: items.flatMap(x => normalizeLinkOpsTargetSet(x).stores),
    sourceStores: items.flatMap(x => normalizeLinkOpsTargetSet(x).sourceStores),
    writeStores: items.flatMap(x => normalizeLinkOpsTargetSet(x).writeStores),
    productRefs: items.flatMap(x => normalizeLinkOpsTargetSet(x).productRefs),
  });
}

function inferTargetsFromChatSession(session) {
  const text = recentCloudAiMessages(session?.messages)
    .map(m => String(m?.content || ''))
    .join('\n');
  return mergeLinkOpsTargets(
    session?.targets && typeof session.targets === 'object' ? session.targets : {},
    inferLinkOpsTargets(text)
  );
}

function summarizeLinkOpsTargets(targets = {}) {
  const t = normalizeLinkOpsTargetSet(targets);
  const parts = [];
  if (t.stores.length) parts.push(`店铺=${t.stores.join(',')}`);
  if (t.productRefs.length) parts.push(`货号/SKC=${t.productRefs.join(',')}`);
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
      return `${store}: OpenAPI 已授权且云端只读探针通过；商品发布/编辑可进入 dry-run 权限、站点、品牌、仓库和 payload 预检；真实提交仍需显式确认和回读。`;
    }
    if (cap.authorized) {
      return `${store}: 已检测到 OpenAPI 私有授权配置；尚未完成云端只读探针/对账登记，写操作只可进入 dry-run 预检。`;
    }
    return `${store}: 暂未登记官方 OpenAPI 授权；写操作需先走云端 WebAPI/headless 受控执行，或完成该店 OpenAPI 接入。`;
  }).join('\n');
}

function linkOpsCapabilityNotes(intents = [], targets = {}) {
  const writeIntents = ['copy_product_draft', 'update_title', 'update_images', 'retire_link', 'campaign_signup', 'flash_discount', 'certificate_review'];
  if (!intents.some(x => writeIntents.includes(x))) return [];
  const stores = normalizeConcreteStoreKeys(normalizeLinkOpsTargetSet(targets).stores);
  const notes = [];
  const openApiStores = stores.filter(store => openApiStoreCapability(store).authorized);
  const adapterStores = stores.filter(store => openApiStoreCapability(store).productPublishAdapter);
  if (openApiStores.length) {
    notes.push(`${openApiStores.join(',')} 已检测到 OpenAPI 授权配置；当前任务应进入 API dry-run 预检/执行准备，缺发布 payload 时说明缺类目、属性、图片、SKU、成本、库存等资料，不能说“没有权限”，也不能谎称已提交审核。`);
  }
  if (adapterStores.length) {
    notes.push(`${adapterStores.join(',')} 已可做商品发布/编辑 OpenAPI 受控预检；默认仍只做 dry-run/人工确认，不静默提交 SHEIN。`);
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
  const actionVerb = /下架|归档|停掉|移除|删除链接|换图|更换图片|改标题|换标题|补链接|补链|复制|复制上品|创建草稿|创建链接|上品|上链接|发链接|发布商品|刊登|提交审核|报活动|报名|限时折扣|设置折扣|补证书|补资质|上传证书/.test(text)
    || /\b(retire|remove|archive|replace image|update title|create draft|create link|publish|submit review|campaign|discount)\b/.test(lower);
  if (!actionVerb) return false;
  const strongCommand = /把|将|要求|安排|加入任务池|加入动作池|执行|处理|现在|立即|直接|提交审核/.test(text)
    || /^(下架|归档|换图|改标题|补链接|补链|报活动|报名|设置折扣|补证书|补资质)/.test(text);
  const giveCommand = /给.+(重新生成|生成|换|更换|改|下架|报|报名|设置|补)/.test(text);
  const exploratory = /建议|分析|看看|找出|哪些|哪个|是否|能否|能不能|可以吗|怎么|如何|为什么|原因/.test(text);
  if (exploratory && !strongCommand && !giveCommand) return false;
  return strongCommand || giveCommand || !exploratory;
}

function isConfirmExecuteChatCommand(command) {
  const text = String(command || '').trim();
  if (!text || text.length > 80) return false;
  if (/？|\?|能否|能不能|可以吗|是否|为什么|怎么|如何/.test(text)) return false;
  return /^(确认|同意|可以|行|好|好的|ok|OK|执行|开始|提交|照做|按这个|按上面|就这样|走|去做)([，,。\s！!]*)(执行|开始|提交|审核|处理|做|吧|了|$)/.test(text)
    || /确认.*(执行|提交|审核|处理)|同意.*(执行|提交|审核|处理)|(执行|提交|审核|处理).*吧/.test(text);
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
    .map(m => String(m?.content || ''))
    .join('\n');
  const intents = inferLinkOpsIntent(text).filter(x => x !== 'manual_review');
  if (!intents.length) return false;
  return /下架|归档|停掉|移除|删除链接|换图|更换图片|改标题|换标题|补链接|补链|复制|上品|上链接|发链接|发布商品|刊登|提交审核|报活动|报名|限时折扣|设置折扣|补证书|补资质|上传证书|任务|动作/.test(text);
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
  const assistantLines = prior
    .filter(m => m?.role === 'assistant')
    .map(m => compactChatLine(m.content, 700))
    .filter(Boolean)
    .slice(-2);
  const command = [
    `确认执行：${compactChatLine(latestMessage, 120)}`,
    userLines.length ? `上文用户意图：\n${userLines.map(x => `- ${x}`).join('\n')}` : '',
    assistantLines.length ? `上文智能体定位：\n${assistantLines.map(x => `- ${x}`).join('\n')}` : '',
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
  return (Array.isArray(tasks) ? tasks : [])
    .filter(t =>
      String(t.chatSessionId || '') === sid &&
      !['done', 'archived'].includes(String(t.status || ''))
    )
    .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))[0] || null;
}

function updateLinkOpsTaskFromChatCommand(task, body, actor, req) {
  const command = String(body.command || body.text || '').trim();
  if (!command) throw new Error('Missing command');
  if (command.length > 2000) throw new Error('Command too long');
  const now = new Date().toISOString();
  const previousIntents = Array.isArray(task.intents) ? task.intents : [];
  const intents = [...new Set([...previousIntents, ...inferLinkOpsIntent(command)])];
  const targets = mergeLinkOpsTargets(
    task.targets && typeof task.targets === 'object' ? task.targets : {},
    inferLinkOpsTargets(command),
    body.targets && typeof body.targets === 'object' ? body.targets : {}
  );
  const preview = {
    ...(task.preview && typeof task.preview === 'object' ? task.preview : {}),
    summary: `随会话更新：${intents.map(linkOpsIntentLabel).join(' / ')}；任务持续合并最新指令，不为同一会话重复开新任务。`,
    riskNotes: linkOpsRiskNotes(intents, targets),
    capabilitySummary: buildLinkOpsCapabilitySummary(targets),
    agentAnswer: typeof body.agentAnswer === 'string' ? body.agentAnswer.slice(0, 12000) : (task.preview?.agentAnswer || ''),
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
  const notes = ['当前只是建立任务草案，不会自动修改 SHEIN 后台。'];
  if (intents.includes('copy_product_draft')) {
    notes.push('复制上品需执行前检查：源 SKC、类目参数、证书/资质、图片、价格、库存100、计划上架时间。');
  }
  if (intents.includes('update_title') || intents.includes('update_images')) {
    notes.push('标题/图片会影响流量承接，初期必须人工确认素材和目标链接。');
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
  const intents = inferLinkOpsIntent(command);
  const targets = mergeLinkOpsTargets(
    inferLinkOpsTargets(command),
    body.targets && typeof body.targets === 'object' ? body.targets : {}
  );
  const id = `lot_${now.replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto.randomBytes(4).toString('hex')}`;
  return {
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
      summary: `识别为：${intents.join(' / ')}；任务池只承载可执行事项，确认后再检查材料并进入执行队列。`,
      riskNotes: linkOpsRiskNotes(intents, targets),
      capabilitySummary: buildLinkOpsCapabilitySummary(targets),
      agentAnswer: typeof body.agentAnswer === 'string' ? body.agentAnswer.slice(0, 12000) : '',
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
  };
}

function normalizeLinkOpsTaskStore(value) {
  const tasks = Array.isArray(value?.tasks) ? value.tasks : [];
  return {
    version: 1,
    updatedAt: value?.updatedAt || null,
    tasks: tasks.filter(x => x && typeof x === 'object').slice(0, 1000),
  };
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
      .map(session => ({
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
  const targets = mergeLinkOpsTargets(
    inferLinkOpsTargets(message),
    body.targets && typeof body.targets === 'object' ? body.targets : {}
  );
  return {
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
  };
}

function appendChatMessage(session, body, actor, req) {
  const content = String(body.message || body.command || body.text || '').trim();
  if (!content) throw new Error('Missing message');
  if (content.length > 4000) throw new Error('Message too long');
  const now = new Date().toISOString();
  const messages = Array.isArray(session.messages) ? session.messages.slice() : [];
  messages.push({id: `msg_${crypto.randomBytes(5).toString('hex')}`, role: 'user', content, at: now});
  const targets = mergeLinkOpsTargets(
    session.targets && typeof session.targets === 'object' ? session.targets : {},
    inferLinkOpsTargets(content)
  );
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
    targets: mergeLinkOpsTargets(
      session.targets && typeof session.targets === 'object' ? session.targets : {},
      inferLinkOpsTargets(answer)
    ),
    messages,
  };
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
  return canWriteAllStores(actor);
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
    if (typeof next.preview.agentAnswer === 'string') next.preview.agentAnswer = next.preview.agentAnswer.slice(0, 16000);
    if (typeof next.preview.structuredAnswer === 'string') next.preview.structuredAnswer = next.preview.structuredAnswer.slice(0, 16000);
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
  return 'file';
}

function buildAssetRecord({taskId, file, buffer, storedPath, actor, req}) {
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  return {
    id: `loa_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    taskId,
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

function findLinkOpsTaskOrThrow(store, taskId) {
  const id = safeTaskId(taskId);
  const tasks = Array.isArray(store?.tasks) ? store.tasks.slice() : [];
  const idx = tasks.findIndex(t => String(t.id || '') === id);
  if (idx < 0) throw new Error('Task not found');
  return {id, tasks, idx, task: tasks[idx]};
}

async function attachLinkOpsAssets({store, taskId, files, args, actor, req}) {
  const {id, tasks, idx} = findLinkOpsTaskOrThrow(store, taskId);
  const normalizedFiles = Array.isArray(files) ? files : [];
  if (!normalizedFiles.length) throw new Error('Missing files');
  if (normalizedFiles.length > 40) throw new Error('Too many files');
  let totalBytes = 0;
  const baseDir = path.resolve(args.linkOpsAssetDir);
  const taskDir = assertInsideDir(baseDir, path.join(baseDir, id));
  await fs.mkdir(taskDir, {recursive: true});
  const added = [];
  const writtenPaths = [];
  try {
    for (const file of normalizedFiles) {
      const mime = String(file?.type || '').toLowerCase().trim();
      if (!LINK_OPS_ALLOWED_UPLOAD_MIME.has(mime)) throw new Error(`Unsupported file type: ${mime || 'unknown'}`);
      const raw = String(file?.dataBase64 || file?.base64 || '').replace(/^data:[^;]+;base64,/, '');
      if (!raw) throw new Error('Missing file content');
      const buffer = Buffer.from(raw, 'base64');
      if (!buffer.length) throw new Error('Empty file');
      if (buffer.length > LINK_OPS_MAX_UPLOAD_FILE_BYTES) throw new Error(`File too large: ${file?.name || 'asset'}`);
      totalBytes += buffer.length;
      if (totalBytes > LINK_OPS_MAX_UPLOAD_TOTAL_BYTES) throw new Error('Upload batch too large');
      if (!hasUploadMagic(buffer, mime)) throw new Error(`File content does not match type: ${file?.name || mime}`);
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
      const ext = uploadExtensionFor(mime, file?.name || '');
      const stem = safeFileStem(path.basename(String(file?.name || 'asset'), path.extname(String(file?.name || ''))), 'asset');
      const storedName = `${sha256.slice(0, 16)}-${stem}${ext}`;
      const storedPath = assertInsideDir(taskDir, path.join(taskDir, storedName));
      await fs.writeFile(storedPath, buffer);
      writtenPaths.push(storedPath);
      added.push(buildAssetRecord({taskId: id, file: {...file, type: mime}, buffer, storedPath, actor, req}));
    }
  } catch (err) {
    await Promise.allSettled(writtenPaths.map(file => fs.rm(file, {force: true})));
    throw err;
  }
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
  const needs = linkOpsTaskNeedsMaterial(task);
  const intents = Array.isArray(task?.intents) ? task.intents : [];
  const targets = normalizeLinkOpsTargetSet(task?.targets || {});
  const stores = normalizeConcreteStoreKeys(targets.stores);
  const status = String(task.status || 'draft');
  if (!['confirmed', 'in_progress', 'waiting_review'].includes(status)) {
    blockers.push('任务必须先点“确认成任务”，不能从草案直接执行。');
  }
  if (needs.includes('image') && !intents.includes('copy_product_draft') && !assets.some(a => a.kind === 'image')) {
    blockers.push('缺少图片素材：请先上传或同步商品图。');
  }
  if (needs.includes('image_or_certificate') && !assets.some(a => a.kind === 'image' || a.kind === 'certificate' || a.mime === 'application/json')) {
    warnings.push('复制上品暂未上传图片/证书/发布 payload；若执行器不能从源商品详情还原素材，会在 OpenAPI 预检中继续阻断。');
  }
  if (needs.includes('image') && intents.includes('copy_product_draft') && !assets.some(a => a.kind === 'image')) {
    warnings.push('复制上品未上传图片素材；系统会优先尝试从源店商品快照复制图片，源快照不足时再阻断。');
  }
  if (needs.includes('certificate') && !assets.some(a => a.kind === 'certificate' || a.mime === 'application/pdf')) {
    blockers.push('缺少证书/资质文件。');
  }
  if (needs.includes('title_text_or_rule') && !assets.some(a => a.kind === 'text')) {
    warnings.push('标题类任务未上传标题文本/规则文件；如果标题已写在会话或任务说明里，可人工确认后继续。');
  }
  const authorizedStores = stores.filter(store => openApiStoreCapability(store).authorized);
  const storesMissingProductAdapter = stores.filter(store => openApiStoreCapability(store).authorized && !openApiStoreCapability(store).productPublishAdapter);
  if (intents.includes('copy_product_draft') && storesMissingProductAdapter.length) {
    warnings.push(`${storesMissingProductAdapter.join(',')} OpenAPI 已授权，但最近只读探针未证明可用；本任务可留在草案/待复核，需先修复探针后再做商品发布 dry-run。`);
  }
  const nonOpenApiStores = stores.filter(store => !openApiStoreCapability(store).authorized);
  if (intents.some(x => ['copy_product_draft', 'update_title', 'update_images', 'retire_link', 'campaign_signup', 'flash_discount', 'certificate_review'].includes(x)) && nonOpenApiStores.length) {
    warnings.push(`${nonOpenApiStores.join(',')} 暂无官方 OpenAPI 授权记录；后续执行需走云端 WebAPI/headless 受控路径或先完成该店 OpenAPI 接入。`);
  }
  if (authorizedStores.length && !stores.some(store => openApiStoreCapability(store).productPublishAdapter)) {
    warnings.push(`${authorizedStores.join(',')} 已具备授权配置，但当前动作暂无可真实提交的适配器；系统只做 dry-run/预检，不会静默写后台。`);
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
  if (denied) blockers.push(`维护预检启动前权限复核失败：${denied.error}`);
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
  if (maintenanceIntents.includes('update_title') && !hasTitleMaintenanceMaterial(task)) {
    blockers.push('换标题任务缺少新标题或标题规则：请在指令中写明“标题改成…”或上传文本/JSON 素材。');
  }
  if (maintenanceIntents.includes('update_images') && !hasImageMaintenanceMaterial(task)) {
    blockers.push('换图任务缺少图片素材：请先上传图片后再预检。');
  }
  blockers.push('链接维护真实写接口尚未接入：当前只完成目标定位、权限和材料 dry-run，不会提交 SHEIN。');
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
      submitBoundary: '未确认 SHEIN 官方维护写接口前，系统只做 dry-run 预检，不真实上下架/改标题/换图。',
    },
    readbackFingerprint,
    blockers,
    warnings,
    safety: {
      canSilentWrite: false,
      realSubmit: false,
      executeSupported: false,
      note: '维护动作当前只有 dry-run 适配器；真实提交必须后续按具体官方接口单独接入、确认和回读。',
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
      ? '本次没有完成 SHEIN 真实写提交；保留在待复核/预检状态，需先解决阻断后重新 dry-run。'
      : '本次为 dry-run/预检，没有调用 SHEIN 真实写接口。',
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
  const taskSnapshotDir = path.join(ROOT, 'tmp', 'link-ops-executor-task-json');
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
          : [`${targetStore} OpenAPI 商品预检执行器未返回可解析结果：code=${result.code}${result.timedOut ? ' timeout=true' : ''}`],
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

async function runOpenApiProductExecutors(task, args, body = {}) {
  const stores = openApiProductExecutorTargetStores(task);
  const out = [];
  for (const store of stores) {
    out.push(await runOpenApiProductExecutorForStore(task, args, body, store, body.executionContext || {}));
  }
  return out;
}

async function startControlledLinkOpsExecution(task, actor, req, args, body = {}) {
  const originalStatus = String(task?.status || 'draft');
  const now = new Date().toISOString();
  const rawRequestedMode = String(body.mode || body.executionMode || (body.execute === true ? 'execute' : 'dry-run') || 'dry-run').toLowerCase();
  const requestedMode = rawRequestedMode === 'execute' ? 'execute' : 'dry-run';
  const confirmText = String(body.confirm || body.confirmText || '').trim();
  const confirmTextPresent = confirmText === LINK_OPS_OPENAPI_SUBMIT_CONFIRM_TEXT;
  let executeAllowed = false;
  const auditActor = actorAuditContext(actor, req);
  const auditRequestMeta = requestMeta(req);
  const targetStores = taskTargetStores(task);
  const sourceStores = taskSourceStores(task);
  const writeStores = taskWriteStores(task);
  const productRefs = normalizeLinkOpsTargetSet(task?.targets || {}).productRefs;
  const intents = Array.isArray(task?.intents) ? task.intents : [];
  const realSubmitWhitelistChecks = intents.includes('copy_product_draft')
    ? writeStores.map(store => biOpsWriteWhitelistAllowedForActor(actor, {operation: 'copy_product_draft', storeKey: store}))
    : [];
  const autoConfirmed = originalStatus === 'draft';
  const runnableTask = autoConfirmed
    ? {
      ...task,
      status: 'confirmed',
      progress: Math.max(normalizeProgress(task.progress, 0), 30),
      note: task.note || '用户点击开始执行，系统已自动确认成可执行任务并进入预检。',
      updatedAt: now,
    }
    : task;
  const preflight = runPreflightForLinkOpsTask(runnableTask);
  if (requestedMode === 'execute') {
    const unsupportedExecuteIntents = intents
      .filter(intent => intent !== 'copy_product_draft' && intent !== 'manual_review');
    if (!intents.includes('copy_product_draft')) {
      preflight.blockers.push('当前任务不包含已接入真实提交适配器的动作；只能 dry-run、建任务或补材料。');
    }
    if (unsupportedExecuteIntents.length) {
      preflight.blockers.push(`以下动作尚未接入真实提交适配器：${unsupportedExecuteIntents.map(linkOpsIntentLabel).join('、')}；不能和真实 SHEIN 写提交混在同一次执行里。`);
    }
    if (!confirmTextPresent) {
      preflight.blockers.push(`真实提交必须显式输入确认文本 ${LINK_OPS_OPENAPI_SUBMIT_CONFIRM_TEXT}。`);
    }
    if (originalStatus !== 'waiting_review') {
      preflight.blockers.push('真实提交必须先完成一次 dry-run 预检，并停在“待复核”状态。');
    }
    if (task?.execution?.state !== 'openapi_product_preflight_ready' || task?.execution?.preflight?.ok !== true) {
      preflight.blockers.push('真实提交前缺少已通过的 OpenAPI 商品预检证据。');
    }
    if (intents.includes('copy_product_draft')) {
      const notEnabledStores = writeStores.filter(store => !openApiStoreCapability(store).productPublishExecuteAdapter);
      if (notEnabledStores.length) {
        preflight.blockers.push(`${notEnabledStores.join(',')} 商品发布/编辑真实提交未被服务端总闸门放行；本次只能重新 dry-run。`);
      }
      const whitelistDenied = realSubmitWhitelistChecks.filter(check => !check.allowed);
      if (whitelistDenied.length) {
        preflight.blockers.push(`${whitelistDenied.map(check => check.storeKey).join(',')} 未命中真实写试点白名单（人+店+动作），不能真实提交。`);
      }
      const storesMissingPayloadHash = writeStores.filter(store => !payloadHashForStoreFromTaskExecution(task, store));
      if (storesMissingPayloadHash.length) {
        preflight.blockers.push(`${storesMissingPayloadHash.join(',')} 缺少上一次 dry-run 锁定的 payload hash，不能真实提交。`);
      }
    }
    executeAllowed = confirmTextPresent
      && originalStatus === 'waiting_review'
      && task?.execution?.state === 'openapi_product_preflight_ready'
      && task?.execution?.preflight?.ok === true
      && preflight.blockers.length === 0;
  }
  const executionContext = {
    actor: auditActor,
    requestMeta: auditRequestMeta,
    parentTaskId: String(task?.id || ''),
    targetStores,
    sourceStores,
    writeStores,
    productRefs,
    intents,
    requestedMode,
    realSubmitWhitelistChecks,
    parentIssuedAt: now,
  };
  const openApiProductExecutors = await runOpenApiProductExecutors(runnableTask, args, {
    ...body,
    actorForWriteGate: actor,
    mode: executeAllowed ? 'execute' : 'dry-run',
    executionMode: executeAllowed ? 'execute' : 'dry-run',
    execute: executeAllowed,
    confirm: executeAllowed ? confirmText : '',
    confirmText: executeAllowed ? confirmText : '',
    executionContext,
  });
  const linkMaintenancePrechecks = await runLinkMaintenancePrechecks(runnableTask, args, {
    ...body,
    actorForWriteGate: actor,
    mode: 'dry-run',
    executionMode: 'dry-run',
    execute: false,
    confirm: '',
    confirmText: '',
    executionContext,
  });
  const executorRuns = [...openApiProductExecutors, ...linkMaintenancePrechecks];
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
  const hasLinkMaintenancePrecheck = linkMaintenancePrechecks.length > 0;
  const submitted = executorResults.some(x => x?.state === 'submitted');
  const executorState = submitted
    ? 'submitted'
    : suspiciousWriteAttempted
      ? 'suspicious_write_attempted'
    : hasOpenApiProductExecutor
      ? (ok ? 'openapi_product_preflight_ready' : 'blocked')
      : hasLinkMaintenancePrecheck
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
  const nextStatus = lifecycleTransition.toStatus || (hasOpenApiProductExecutor || hasLinkMaintenancePrecheck
      ? 'waiting_review'
      : (ok ? 'in_progress' : 'waiting_review'));
  const nextProgress = submitted
    ? (lifecycleTransition.terminal
      ? 100
      : Math.max(normalizeProgress(task.progress, 0), lifecycleTransition.needsManualResolve ? 85 : 82))
    : suspiciousWriteAttempted
      ? Math.max(normalizeProgress(task.progress, 0), 85)
    : ok
      ? Math.max(normalizeProgress(task.progress, 0), hasOpenApiProductExecutor ? 70 : 65)
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
  const next = {
    ...runnableTask,
    status: nextStatus,
    progress: nextProgress,
    note: submitted
      ? lifecycleTransition.note
      : suspiciousWriteAttempted
        ? lifecycleTransition.note
      : ok && hasOpenApiProductExecutor
        ? 'OpenAPI 商品执行器 dry-run 预检通过；仍需最终执行确认，系统不会静默提交 SHEIN。'
        : ok
          ? '受控执行器已完成前置检查；当前停在执行准备/预填阶段，不会静默提交 SHEIN。'
          : `执行器阻断：${combinedBlockers.join('；')}`,
    execution: {
      ...(task.execution && typeof task.execution === 'object' ? task.execution : {}),
      mode: hasOpenApiProductExecutor ? 'openapi_product_executor' : (hasLinkMaintenancePrecheck ? 'link_maintenance_precheck' : 'controlled_prefill'),
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
      openApiProductExecutors: openApiProductExecutors.map((executorRun, index) => {
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
      }),
      linkMaintenancePrechecks: linkMaintenancePrechecks.map((executorRun, index) => {
        const executorResult = executorRun.result || {};
        return {
          storeKey: executorResult.storeKey || executorRun.storeKey || '',
          ok: Boolean(executorResult.ok),
          mode: executorRun.mode || '',
          state: executorResult.state || '',
          runId: executorResult.runId || '',
          adapterKind: executorResult.adapterKind || '',
          adapterEvidence: executorResult.adapterEvidence || null,
          readbackFingerprint: executorResult.readbackFingerprint || null,
          safety: executorResult.safety || null,
          index,
        };
      }),
      hlOpenApiExecutor: executorResults.length === 1 ? {
        ok: Boolean(executorResults[0].ok),
        mode: openApiProductExecutors[0]?.mode || '',
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
          : '本次为 dry-run/预检，没有调用 SHEIN 真实写接口。',
      lifecycle: lifecycleTransition,
      note: hasOpenApiProductExecutor
        ? 'OpenAPI 商品执行器已接入。默认只做预检；真实 publishOrEdit 必须任务已确认、payload 完整、显式 execute 和确认文本同时满足。'
        : hasLinkMaintenancePrecheck
          ? '链接维护 dry-run 适配器已接入：只做目标定位、权限和材料检查；未确认官方写接口前不会真实上下架/改标题/换图。'
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
  next.history = appendTaskHistory(next, ok ? (submitted ? 'openapi_product_submitted' : (hasOpenApiProductExecutor ? 'openapi_product_preflight_ready' : 'start_controlled_executor')) : 'executor_blocked', actor, req, {
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
    linkMaintenancePrechecks: linkMaintenancePrechecks.map(executorRun => {
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

async function readBiSectionCache(root, section, generatedAt) {
  const file = path.join(root, 'sections', `${section}.json`);
  const cached = await readJsonFile(file, null);
  if (!cached || typeof cached !== 'object') return null;
  const expectedGeneratedAt = String(generatedAt || '');
  const cachedGeneratedAt = String(cached.generatedAt || '');
  if (expectedGeneratedAt && cachedGeneratedAt !== expectedGeneratedAt) return null;
  if (!cached.data || typeof cached.data !== 'object') return null;
  return cached;
}

function appendJsonFieldsToJsonObjectBuffer(buffer, fields = {}) {
  if (!Buffer.isBuffer(buffer)) return null;
  const pairs = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (!pairs.length) return buffer;
  let end = buffer.length;
  while (end > 0) {
    const c = buffer[end - 1];
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
    end--;
  }
  if (end < 2 || buffer[end - 1] !== 0x7d) return null;
  const extra = pairs.map(([key, value]) => {
    return `,\n  ${JSON.stringify(key)}: ${JSON.stringify(value)}`;
  }).join('');
  return Buffer.concat([
    buffer.subarray(0, end - 1),
    Buffer.from(`${extra}\n}\n`, 'utf8'),
  ]);
}

function appendCacheHitToJsonObjectBuffer(buffer, cacheHit, extraFields = {}) {
  return appendJsonFieldsToJsonObjectBuffer(buffer, {cacheHit: Boolean(cacheHit), ...extraFields});
}

function extractJsonStringFieldFromHead(head, field) {
  const re = new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`);
  return re.exec(head)?.[1] || '';
}

function acceptsGzip(value) {
  return /\bgzip\b/i.test(String(value || ''));
}

async function writeBiSectionGzipCache(file, rawBuffer) {
  const gzipFile = `${file}.gz`;
  const gzipped = gzipSync(rawBuffer, {level: 6});
  await writeBufferFileAtomic(gzipFile, gzipped);
  return gzipped;
}

async function readOrCreateBiSectionGzipCache(file, rawBuffer) {
  const gzipFile = `${file}.gz`;
  const [rawStat, gzipStat] = await Promise.all([
    fs.stat(file).catch(() => null),
    fs.stat(gzipFile).catch(() => null),
  ]);
  if (gzipStat?.size > 0 && (!rawStat || gzipStat.mtimeMs >= rawStat.mtimeMs)) {
    const existing = await fs.readFile(gzipFile).catch(() => null);
    if (existing?.length) return existing;
  }
  const gzipped = gzipSync(rawBuffer, {level: 6});
  writeBufferFileAtomic(gzipFile, gzipped).catch(() => {});
  return gzipped;
}

async function readBiSectionCacheRaw(root, section, generatedAt, cacheHit = true, options = {}) {
  const file = path.join(root, 'sections', `${section}.json`);
  const buffer = await fs.readFile(file).catch(() => null);
  if (!buffer || !buffer.length) return null;

  // Section cache files put metadata before the heavy `data` object. Validate the
  // freshness contract from the small head instead of JSON.parse-ing 10MB+ files
  // on every request.
  const head = buffer.subarray(0, Math.min(buffer.length, 8192)).toString('utf8');
  const expectedGeneratedAt = String(generatedAt || '');
  const cachedGeneratedAt = extractJsonStringFieldFromHead(head, 'generatedAt');
  if (expectedGeneratedAt && cachedGeneratedAt !== expectedGeneratedAt) return null;
  if (extractJsonStringFieldFromHead(head, 'section') !== section) return null;
  if (!/"data"\s*:/.test(head)) return null;

  const extraFields = options.extraFields && typeof options.extraFields === 'object' ? options.extraFields : {};
  const hasExtraFields = Object.keys(extraFields).length > 0;

  if (options.gzip) {
    const rawBody = hasExtraFields ? appendCacheHitToJsonObjectBuffer(buffer, cacheHit, extraFields) : null;
    const body = rawBody
      ? gzipSync(rawBody, {level: 6})
      : await readOrCreateBiSectionGzipCache(file, buffer);
    return {
      body,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Encoding': 'gzip',
        'Content-Length': String(body.length),
        'Vary': 'Accept-Encoding',
        'X-BI-Section-Cache-Hit': cacheHit ? 'true' : 'false',
        'X-BI-Section-Mode': hasExtraFields ? 'raw-cache-gzip-meta' : 'raw-cache-gzip',
        ...(extraFields.staleSection ? {'X-BI-Section-Stale': 'true'} : {}),
      },
    };
  }

  const body = appendCacheHitToJsonObjectBuffer(buffer, cacheHit, extraFields);
  if (!body) return null;
  return {
    body,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-BI-Section-Cache-Hit': cacheHit ? 'true' : 'false',
      'X-BI-Section-Mode': 'raw-cache',
      ...(extraFields.staleSection ? {'X-BI-Section-Stale': 'true'} : {}),
    },
  };
}

async function writeBiSectionCache(root, section, generatedAt, data, run) {
  const dir = path.join(root, 'sections');
  await fs.mkdir(dir, {recursive: true});
  const file = path.join(dir, `${section}.json`);
  const payload = {
    ok: true,
    section,
    generatedAt: generatedAt || '',
    cachedAt: new Date().toISOString(),
    data,
    run: run ? {
      code: run.code,
      timedOut: Boolean(run.timedOut),
      stderrTail: String(run.stderr || '').slice(-4000),
    } : null,
  };
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  await writeBufferFileAtomic(file, raw);
  try {
    await writeBiSectionGzipCache(file, raw);
  } catch (err) {
    console.warn('BI section gzip cache write failed', section, err?.message || err);
  }
  return payload;
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

async function readBiSectionCacheAnyGeneratedAt(root, section) {
  const file = path.join(root, 'sections', `${section}.json`);
  const cached = await readJsonFile(file, null);
  if (!cached || typeof cached !== 'object') return null;
  if (String(cached.section || '') !== section) return null;
  if (!cached.data || typeof cached.data !== 'object') return null;
  return cached;
}

async function readBiSectionStaleRaw(root, section, currentGeneratedAt, options = {}) {
  const stale = await readBiSectionCacheRaw(root, section, '', true, {
    ...options,
    extraFields: {
      staleSection: true,
      cacheStale: true,
      refreshScheduled: Boolean(options.refreshScheduled),
      coreGeneratedAt: String(currentGeneratedAt || ''),
    },
  });
  if (!stale) return null;
  return {
    body: stale.body,
    headers: {
      ...stale.headers,
      'X-BI-Section-Stale': 'true',
      'Cache-Control': 'no-store',
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
  const profitBackedSections = new Set(['profit', 'homeProfit', 'homeRankings', 'rankings']);
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
  const maxQuestionChars = Math.max(12000, Number(process.env.SHEIN_BI_OPS_AGENT_MAX_QUESTION_CHARS || 480000));
  if (text.length > maxQuestionChars) throw new Error('Question too long');
  const codexSessionId = safeCodexSessionId(options.codexSessionId || '');
  const codexMetaFile = path.join(os.tmpdir(), `shein-linkops-codex-session-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`);
  const result = await runChildProcess(process.execPath, [
    path.join(ROOT, 'scripts', 'lark_sales_qa_bot.mjs'),
    '--answer',
    text,
  ], {
    cwd: ROOT,
    timeoutMs: Number(process.env.SHEIN_BI_OPS_AGENT_TIMEOUT_MS || 190_000),
    env: {
      CODEX_HOME: process.env.CODEX_HOME || '/home/sheinops/.codex',
      SHEIN_QA_CODEX_GATEWAY_ENABLED: process.env.SHEIN_QA_CODEX_GATEWAY_ENABLED || '1',
      SHEIN_QA_CODEX_GATEWAY_TIMEOUT_MS: process.env.SHEIN_QA_CODEX_GATEWAY_TIMEOUT_MS || '600000',
      SHEIN_QA_CODEX_MODEL: process.env.SHEIN_QA_CODEX_MODEL || 'gpt-5.5',
      SHEIN_QA_CODEX_REASONING_EFFORT: process.env.SHEIN_QA_CODEX_REASONING_EFFORT || 'xhigh',
      SHEIN_QA_LLM_ENABLED: process.env.SHEIN_QA_LLM_ENABLED || '1',
      SHEIN_QA_LLM_TIMEOUT_MS: process.env.SHEIN_QA_LLM_TIMEOUT_MS || '45000',
      SHEIN_QA_CODEX_SESSION_ID: codexSessionId,
      SHEIN_QA_CODEX_SESSION_META_FILE: codexMetaFile,
    },
  });
  const codexMeta = await readJsonFile(codexMetaFile, null);
  await fs.rm(codexMetaFile, {force: true}).catch(() => {});
  if (!result.ok) {
    throw new Error(`Ops agent failed code=${result.code} timeout=${result.timedOut} stderr=${String(result.stderr || '').slice(-500)}`);
  }
  return {
    answer: String(result.stdout || '').trim(),
    stderrTail: String(result.stderr || '').slice(-1000),
    codexSessionId: codexMeta?.sessionId || codexSessionId || '',
    codexResumed: Boolean(codexMeta?.resumed),
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

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value, null, 2), {'Content-Type': 'application/json; charset=utf-8'});
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

async function manualLoginMaintenanceHtml() {
  const manualStoresJson = JSON.stringify(await manualLoginStoreKeys()).replace(/</g, '\\u003c');
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
    const $ = id => document.getElementById(id);
    $('store').innerHTML = STORES.map(s => '<option value="'+s+'">'+s+'</option>').join('');
    function msg(text){ const el=$('message'); el.hidden=false; el.textContent=text; }
    async function api(url, opts={}){
      const r = await fetch(url, {headers:{'Content-Type':'application/json'}, ...opts});
      const j = await r.json().catch(()=>({ok:false,error:'Invalid JSON'}));
      if(!r.ok || j.ok===false) throw new Error(j.error || ('HTTP '+r.status));
      return j;
    }
    function sessionRow(s){
      const active = s.status === 'active' || s.status === 'starting';
      const canControl = active || s.status === 'expired' || (s.alive && Object.values(s.alive).some(Boolean));
      const open = active && s.openUrl ? '<a class="btn" target="_blank" href="'+s.openUrl+'">进入窗口</a>' : '';
      return '<tr><td><b>'+s.storeKey+'</b><br><span class="hint">'+(s.shopName||'')+'</span></td><td><span class="status '+(active?'active':(s.status==='expired'?'bad':''))+'">'+s.status+'</span><br><span class="hint">过期 '+(s.expiresAt||'-')+'</span></td><td class="mono">'+s.id+'</td><td><div class="row">'+open+(canControl?'<button class="good" data-finish="'+s.id+'" data-token="'+(s.token||'')+'">我已完成并关闭</button><button class="danger" data-close="'+s.id+'" data-token="'+(s.token||'')+'">直接关闭</button>':'')+'</div></td></tr>';
    }
    async function refresh(){
      const j = await api('/api/cloud-login/sessions');
      const sessions = j.sessions || [];
      $('sessions').innerHTML = sessions.length ? '<table><thead><tr><th>店铺</th><th>状态</th><th>会话</th><th>操作</th></tr></thead><tbody>'+sessions.map(sessionRow).join('')+'</tbody></table>' : '<p class="hint">当前没有临时登录窗口。</p>';
      document.querySelectorAll('[data-finish]').forEach(b=>b.onclick=async()=>{ b.disabled=true; try{ await api('/api/cloud-login/sessions/'+encodeURIComponent(b.dataset.finish)+'/finish',{method:'POST',body:JSON.stringify({token:b.dataset.token})}); msg('已导出登录态并关闭窗口。'); await refresh(); }catch(e){ msg('完成失败：'+e.message); b.disabled=false; }});
      document.querySelectorAll('[data-close]').forEach(b=>b.onclick=async()=>{ b.disabled=true; try{ await api('/api/cloud-login/sessions/'+encodeURIComponent(b.dataset.close)+'/close',{method:'POST',body:JSON.stringify({token:b.dataset.token})}); msg('已关闭窗口。'); await refresh(); }catch(e){ msg('关闭失败：'+e.message); b.disabled=false; }});
    }
    $('refresh').onclick = refresh;
    $('start').onclick = async () => {
      $('start').disabled = true;
      try {
        const j = await api('/api/cloud-login/sessions', {method:'POST', body:JSON.stringify({storeKey:$('store').value,target:$('target').value,expiresMinutes:Number($('minutes').value)})});
        msg('已开启 '+j.session.storeKey+' 临时登录窗口。新窗口打开后请完成登录，再回本页点“我已完成并关闭”。');
        await refresh();
        window.open(j.session.openUrl, '_blank', 'noopener,noreferrer');
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

async function handleManualLoginWsUpgrade(req, socket, args) {
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

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const trustedInternal = authRequired && isTrustedInternalRequest(req);
      const authenticatedActor = authRequired ? authenticateRequest(req, authUsers, sessionSecret) : null;
      const actor = authRequired ? (authenticatedActor || (trustedInternal ? internalActor() : null)) : null;
      if (authRequired && !actor && !isPublicPath(url.pathname)) {
        if (isApiPath(url.pathname)) return unauthorized(res, url.pathname);
        res.writeHead(302, {
          'Cache-Control': 'no-store',
          'Location': `/login?next=${encodeURIComponent(req.url || '/')}`,
        });
        res.end();
        return;
      }
      if (url.pathname === '/login') {
        if (req.method !== 'GET') return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
        if (actor) {
          res.writeHead(302, {'Cache-Control': 'no-store', 'Location': url.searchParams.get('next') || '/'});
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
        const user = authUsers.find(u => u.username.toLowerCase() === username.toLowerCase());
        if (!verifyPassword(user, password)) {
          await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'auth-login', ok: false, username, ...requestMeta(req)});
          const next = String(body.next || '/');
          if (contentType.includes('application/json')) return sendJson(res, 401, {ok: false, error: '账号或密码不正确'});
          res.writeHead(302, {'Cache-Control': 'no-store', 'Location': `/login?error=${encodeURIComponent('账号或密码不正确')}&user=${encodeURIComponent(username)}&next=${encodeURIComponent(next)}`});
          res.end();
          return;
        }
        const actorLogin = actorFromUser(user);
        const token = signSessionPayload({username: user.username, iat: Date.now(), exp: Date.now() + 14 * 86400 * 1000}, sessionSecret);
        await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'auth-login', ok: true, actor: actorLogin, ...requestMeta(req)});
        if (contentType.includes('application/json')) {
          res.writeHead(200, {
            'Cache-Control': 'no-store',
            'Content-Type': 'application/json; charset=utf-8',
            'Set-Cookie': sessionCookie(token, req),
          });
          res.end(JSON.stringify({ok: true, user: publicActor(actorLogin)}));
          return;
        }
        const next = String(body.next || '/');
        res.writeHead(302, {
          'Cache-Control': 'no-store',
          'Set-Cookie': sessionCookie(token, req),
          'Location': next.startsWith('/') && !next.startsWith('//') ? next : '/',
        });
        res.end();
        return;
      }
      if (url.pathname === '/api/logout') {
        if (req.method !== 'POST' && req.method !== 'GET') return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
        await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'auth-logout', ok: true, actor, ...requestMeta(req)});
        res.writeHead(req.method === 'GET' ? 302 : 200, {
          'Cache-Control': 'no-store',
          'Set-Cookie': clearSessionCookie(req),
          ...(req.method === 'GET' ? {'Location': '/login'} : {'Content-Type': 'application/json; charset=utf-8'}),
        });
        res.end(req.method === 'GET' ? '' : JSON.stringify({ok: true}));
        return;
      }
      if (url.pathname === '/api/auth/me') {
        return sendJson(res, actor ? 200 : 401, {ok: Boolean(actor), user: publicActor(actor)});
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
        res.writeHead(301, {'Location': '/'});
        res.end();
        return;
      }
      if (url.pathname === '/cloud-login-maintenance') {
        return send(res, 200, await manualLoginMaintenanceHtml(), {'Content-Type': 'text/html; charset=utf-8'});
      }
      if (url.pathname.startsWith('/cloud-login/session/')) {
        const m = /^\/cloud-login\/session\/([^/]+)$/.exec(url.pathname);
        if (!m) return send(res, 404, 'Not found', {'Content-Type': 'text/plain; charset=utf-8'});
        const found = await findManualLoginSession(args, decodeURIComponent(m[1]), url.searchParams.get('token') || '');
        if (!found.ok) return send(res, found.status || 403, found.error || 'Forbidden', {'Content-Type': 'text/plain; charset=utf-8'});
        return send(res, 200, manualLoginSessionHtml(found.session, url.searchParams.get('token') || ''), {'Content-Type': 'text/html; charset=utf-8'});
      }
      if (url.pathname.startsWith('/cloud-login/novnc/')) {
        return await serveNovncAsset(req, res, url);
      }
      if (url.pathname === '/api/cloud-login/sessions') {
        if (req.method === 'GET') {
          const result = await runManualLoginHelper(args, 'list', ['--show-token'], 45_000);
          return sendJson(res, result.ok === false ? 500 : 200, result);
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
        return sendJson(res, 200, openApiCapabilityLedger());
      }
      if (url.pathname === '/api/action-state') {
        if (req.method === 'GET') {
          const data = await readJsonFile(args.stateFile, {version: 1, updatedAt: null, actions: {}});
          return sendJson(res, 200, {ok: true, data});
        }
        if (req.method === 'POST') {
          if (args.readOnly) {
            return sendJson(res, 403, {ok: false, error: 'Read-only LAN preview mode'});
          }
          const body = await readBodyJson(req);
          const current = await readJsonFile(args.stateFile, {version: 1, updatedAt: null, actions: {}});
          const actions = current.actions && typeof current.actions === 'object' ? current.actions : {};
          const patches = Array.isArray(body.actions) ? body.actions : [body];
          if (patches.length > 300) return sendJson(res, 400, {ok: false, error: 'Too many actions'});
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
          await writeJsonFile(args.stateFile, next);
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
          const current = normalizeLinkOpsTaskStore(await readJsonFile(args.linkOpsTaskFile, {version: 1, updatedAt: null, tasks: []}));
          const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 120)));
          return sendJson(res, 200, {ok: true, data: {...current, tasks: current.tasks.slice(0, limit)}});
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
          try {
            const body = await readBodyJson(req);
            task = buildLinkOpsTaskFromCommand(body, actor, req);
          } catch (err) {
            return sendJson(res, 400, {ok: false, error: err?.message || String(err || 'Invalid request')});
          }
          const denied = requireWriteStores(actor, taskWriteStores(task));
          if (denied) {
            await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-task-denied', actor, ...requestMeta(req), task: {stores: taskTargetStores(task), writeStores: taskWriteStores(task), sourceStores: taskSourceStores(task), commandLength: String(task.command || '').length}, denied});
            return sendJson(res, 403, denied);
          }
          const current = normalizeLinkOpsTaskStore(await readJsonFile(args.linkOpsTaskFile, {version: 1, updatedAt: null, tasks: []}));
          const next = {
            version: 1,
            updatedAt: new Date().toISOString(),
            tasks: [task, ...current.tasks].slice(0, 1000),
          };
          await writeJsonFile(args.linkOpsTaskFile, next);
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
            },
          });
          return sendJson(res, 200, {ok: true, data: next, task});
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
          const id = String(body.id || '').trim();
          if (!id) return sendJson(res, 400, {ok: false, error: 'Missing task id'});
          const current = normalizeLinkOpsTaskStore(await readJsonFile(args.linkOpsTaskFile, {version: 1, updatedAt: null, tasks: []}));
          const idx = current.tasks.findIndex(t => String(t.id || '') === id);
          if (idx < 0) return sendJson(res, 404, {ok: false, error: 'Task not found'});
          const denied = requireWriteStores(actor, taskWriteStores(current.tasks[idx]));
          if (denied) {
            await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-task-update-denied', actor, ...requestMeta(req), task: {id, stores: taskTargetStores(current.tasks[idx]), writeStores: taskWriteStores(current.tasks[idx]), sourceStores: taskSourceStores(current.tasks[idx])}, denied});
            return sendJson(res, 403, denied);
          }
          let updated;
          try {
            updated = patchLinkOpsTask(current.tasks[idx], body, actor, req);
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
          await writeJsonFile(args.linkOpsTaskFile, next);
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
            },
          });
          return sendJson(res, 200, {ok: true, data: next, task: updated});
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
          const id = String(url.searchParams.get('id') || '').trim();
          if (!id) return sendJson(res, 400, {ok: false, error: 'Missing task id'});
          const current = normalizeLinkOpsTaskStore(await readJsonFile(args.linkOpsTaskFile, {version: 1, updatedAt: null, tasks: []}));
          const task = current.tasks.find(t => String(t.id || '') === id);
          if (!task) return sendJson(res, 404, {ok: false, error: 'Task not found'});
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
          const denied = requireWriteStores(actor, taskWriteStores(task));
          if (denied) {
            await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-task-delete-denied', actor, ...requestMeta(req), task: {id, stores: taskTargetStores(task), writeStores: taskWriteStores(task), sourceStores: taskSourceStores(task)}, denied});
            return sendJson(res, 403, denied);
          }
          const next = {
            version: 1,
            updatedAt: new Date().toISOString(),
            tasks: current.tasks.filter(t => String(t.id || '') !== id),
          };
          await writeJsonFile(args.linkOpsTaskFile, next);
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
            task: {id, status: task.status, commandLength: String(task.command || '').length, assetsDeleted},
          });
          return sendJson(res, 200, {ok: true, data: next, deleted: {id}});
        }
        return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
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
          const current = normalizeLinkOpsTaskStore(await readJsonFile(args.linkOpsTaskFile, {version: 1, updatedAt: null, tasks: []}));
          let targetTask;
          try {
            targetTask = findLinkOpsTaskOrThrow(current, body.taskId || body.id).task;
          } catch (err) {
            const message = err?.message || String(err || 'Task not found');
            return sendJson(res, message === 'Invalid task id' ? 400 : 404, {ok: false, error: message});
          }
          const denied = requireWriteStores(actor, taskWriteStores(targetTask));
          if (denied) {
            await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-assets-upload-denied', actor, ...requestMeta(req), task: {id: targetTask.id, stores: taskTargetStores(targetTask), writeStores: taskWriteStores(targetTask), sourceStores: taskSourceStores(targetTask)}, denied});
            return sendJson(res, 403, denied);
          }
          let result;
          try {
            result = await attachLinkOpsAssets({
              store: current,
              taskId: body.taskId || body.id,
              files: body.files,
              args,
              actor,
              req,
            });
          } catch (err) {
            return sendJson(res, 400, {ok: false, error: err?.message || String(err || 'Upload failed')});
          }
          await writeJsonFile(args.linkOpsTaskFile, result.store);
          await appendAudit(args.auditFile, {
            at: new Date().toISOString(),
            type: 'link-ops-assets-upload',
            actor,
            ...requestMeta(req),
            task: {
              id: result.task.id,
              status: result.task.status,
              assetCount: result.assets.length,
            },
            assets: result.assets.map(a => ({id: a.id, kind: a.kind, mime: a.mime, bytes: a.bytes, sha256: a.sha256})),
          });
          return sendJson(res, 200, {ok: true, data: result.store, task: result.task, assets: result.assets});
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
          const id = String(body.id || body.taskId || '').trim();
          if (!id) return sendJson(res, 400, {ok: false, error: 'Missing task id'});
          const current = normalizeLinkOpsTaskStore(await readJsonFile(args.linkOpsTaskFile, {version: 1, updatedAt: null, tasks: []}));
          const idx = current.tasks.findIndex(t => String(t.id || '') === id);
          if (idx < 0) return sendJson(res, 404, {ok: false, error: 'Task not found'});
          if (taskRequiresOwnerLifecycleResolve(current.tasks[idx])) {
            const deniedLifecycle = {
              ok: false,
              error: '该任务已进入提交后待回读/需人工处理状态，禁止重新预检或执行；请由全店管理账号人工核销为完成或归档。',
              taskId: id,
              status: current.tasks[idx].status || '',
              lifecycleStatus: current.tasks[idx].lifecycle?.lifecycleStatus || current.tasks[idx].lifecycle?.status || '',
            };
            await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-execute-denied', actor, ...requestMeta(req), task: {id, stores: taskTargetStores(current.tasks[idx]), writeStores: taskWriteStores(current.tasks[idx]), sourceStores: taskSourceStores(current.tasks[idx])}, denied: deniedLifecycle});
            return sendJson(res, 409, deniedLifecycle);
          }
          const denied = requireWriteStores(actor, taskWriteStores(current.tasks[idx]));
          if (denied) {
            await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-execute-denied', actor, ...requestMeta(req), task: {id, stores: taskTargetStores(current.tasks[idx]), writeStores: taskWriteStores(current.tasks[idx]), sourceStores: taskSourceStores(current.tasks[idx])}, denied});
            return sendJson(res, 403, denied);
          }
          if (linkOpsExecutionLocks.has(id)) {
            const deniedLock = {ok: false, error: '该自动运营任务正在执行/预检中，请等待当前请求结束后再重试', taskId: id};
            await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-execute-denied', actor, ...requestMeta(req), task: {id, stores: taskTargetStores(current.tasks[idx]), writeStores: taskWriteStores(current.tasks[idx]), sourceStores: taskSourceStores(current.tasks[idx])}, denied: deniedLock});
            return sendJson(res, 409, deniedLock);
          }
          linkOpsExecutionLocks.add(id);
          try {
            const updated = await startControlledLinkOpsExecution(current.tasks[idx], actor, req, args, body);
            const tasks = current.tasks.slice();
            tasks[idx] = updated;
            const next = {version: 1, updatedAt: new Date().toISOString(), tasks};
            await writeJsonFile(args.linkOpsTaskFile, next);
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
            return sendJson(res, 200, {ok: true, data: next, task: updated, execution: updated.execution});
          } finally {
            linkOpsExecutionLocks.delete(id);
          }
        }
        return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
      }
      if (url.pathname === '/api/link-ops-audit') {
        if (req.method !== 'GET') return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
        const taskId = String(url.searchParams.get('taskId') || url.searchParams.get('id') || '').trim();
        const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || 40)));
        if (taskId) {
          const current = normalizeLinkOpsTaskStore(await readJsonFile(args.linkOpsTaskFile, {version: 1, updatedAt: null, tasks: []}));
          const task = current.tasks.find(t => String(t.id || '') === taskId);
          if (!task) return sendJson(res, 404, {ok: false, error: 'Task not found'});
          const denied = requireWriteStores(actor, taskWriteStores(task));
          if (denied) return sendJson(res, 403, denied);
        } else if (!canWriteAllStores(actor)) {
          return sendJson(res, 403, {ok: false, error: '只有全店管理账号可以查看全局自动运营审计'});
        }
        const entries = await readLinkOpsAuditEntries(args.auditFile, {taskId, limit});
        return sendJson(res, 200, {ok: true, taskId, entries});
      }
      if (url.pathname === '/api/link-ops-chats') {
        if (req.method === 'GET') {
          const current = normalizeLinkOpsChatStore(await readJsonFile(args.linkOpsChatFile, {version: 1, updatedAt: null, sessions: []}));
          const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 80)));
          return sendJson(res, 200, {ok: true, data: {...current, sessions: current.sessions.slice(0, limit)}});
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
          const current = normalizeLinkOpsChatStore(await readJsonFile(args.linkOpsChatFile, {version: 1, updatedAt: null, sessions: []}));
          const sessionId = String(body.sessionId || body.id || '').trim();
          let session;
          let created = false;
          let autoTask = null;
          let taskData = null;
          try {
            const userMessage = String(body.message || body.command || body.text || '').trim();
            if (sessionId) {
              const existing = current.sessions.find(s => String(s.id || '') === sessionId);
              if (!existing) return sendJson(res, 404, {ok: false, error: 'Chat session not found'});
              session = appendChatMessage(existing, body, actor, req);
            } else {
              session = buildChatSessionFromMessage(body, actor, req);
              created = true;
            }
            const conversationTargets = inferTargetsFromChatSession(session);
            const explicitActionCommand = isLinkOpsActionCommand(userMessage);
            const confirmExecuteCommand = isConfirmExecuteChatCommand(userMessage);
            const shouldAutoTask = !body.noAutoTask && (explicitActionCommand || (confirmExecuteCommand && hasActionableLinkOpsContext(session)));
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
            if (body.askAgent !== false) {
              const rememberedMessages = recentCloudAiMessages(session.messages);
              const conversation = rememberedMessages.map(m => `${m.role === 'assistant' ? '智能体' : '用户'}：${m.content}`).join('\n');
              const extraRules = shouldAutoTask
                ? [
                    confirmExecuteCommand
                      ? '本条最新用户消息是对上文方案的确认执行。系统会继承上文用户意图和智能体定位，把同一会话加入或更新到链接运营任务池。'
                      : '本条最新用户消息已识别为明确运营动作命令。系统会自动把它加入链接运营任务池，等待人工确认/执行器预检。',
                    '你的回复不能声称已经执行，也不要只说“没有权限所以不能”；应明确说“已加入待确认动作/任务，执行前还会核对目标、素材、权限和风险”。',
                    '如果目标店铺属于 19 店已授权范围，应说明该店 OpenAPI 已授权且只读探针通过；当前写动作会进入 dry-run 预检，真实提交仍取决于 payload 完整性、动作适配器、人工确认和回读，不能笼统说“没有权限”。',
                  ]
                : [
                    '每一轮都要根据整段会话和最新 BI JSON 上下文重新查数；如果最新用户消息换了店铺、货号或指标，以最新消息为准，缺省时再沿用上文。',
                  ];
              const question = [
                '这是 SHEIN 链接管理中台的一段运营会话。请只围绕 SHEIN 数据、链接管理、标题/图片/活动/补链建议回答。',
                '云端 AI 统一记忆规则：同一中台会话保存并传递原始会话文本，不在业务层手动摘要压缩；真正触及模型上下文上限时，由模型/调用层处理，最新用户消息永远优先。',
                '云端 AI 统一权限边界：允许电商运营分析、受控图表、标题/卖点/图片方案草稿、公开竞品参考、以及链接/商品运营任务草案；敏感登录材料和底层维护类请求只能拒绝说明，不能展示细节，也不能在聊天里直接改经营看板底层系统。',
                '明确的 SHEIN 链接/商品运营写动作（改标题、换图、补链接、下架、报活动等）只能进入同一会话任务池、预检和审计，不允许绕过中台静默写后台。',
                '如果信息还不够，先问需要补充什么；如果已经可以形成任务，请给出清晰的下一步和风险边界。',
                '遇到“这个链接/这个品/2,223 这个”等指代时，必须结合上文已出现的店铺、货号、SKC、曝光/访客/销量数字重新定位；不能因为最新一句没写全就否定上轮数据。',
                '会话已识别目标：' + summarizeLinkOpsTargets(conversationTargets),
                '会话目标执行能力：\n' + buildLinkOpsCapabilitySummary(conversationTargets),
                ...extraRules,
                rememberedMessages.length ? conversation : '当前没有可继承的短期上下文，请按最新用户消息独立处理。',
              ].join('\n\n');
              const startedAt = Date.now();
              const result = await askReadonlyOpsAgent(question, {codexSessionId: session.codexSessionId || ''});
              agentDurationMs = Date.now() - startedAt;
              agentAnswer = result.answer;
              codexResumed = Boolean(result.codexResumed);
              if (result.codexSessionId) session.codexSessionId = result.codexSessionId;
            }
            if (shouldAutoTask) {
              const taskStore = normalizeLinkOpsTaskStore(await readJsonFile(args.linkOpsTaskFile, {version: 1, updatedAt: null, tasks: []}));
              const duplicate = findDuplicateAutoTask(taskStore.tasks, session.id, effectiveTaskCommand);
              const reusable = duplicate || findReusableChatTask(taskStore.tasks, session.id);
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
                  agentMode: agentAnswer ? 'readonly-codex-gateway' : '',
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
                await writeJsonFile(args.linkOpsTaskFile, taskData);
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
                  agentMode: agentAnswer ? 'readonly-codex-gateway' : '',
                  agentDurationMs,
                }, actor, req);
                const denied = requireWriteStores(actor, taskWriteStores(autoTask));
                if (denied) {
                  await appendAudit(args.auditFile, {at: new Date().toISOString(), type: 'link-ops-chat-auto-task-denied', actor, ...requestMeta(req), session: {id: session.id}, task: {id: autoTask.id, stores: taskTargetStores(autoTask), writeStores: taskWriteStores(autoTask), sourceStores: taskSourceStores(autoTask)}, denied});
                  return sendJson(res, 403, denied);
                }
                autoTask.status = 'confirmed';
                autoTask.progress = Math.max(normalizeProgress(autoTask.progress, 10), 30);
                autoTask.note = '来自运营会话的明确指令，已自动进入待执行任务；真正执行前仍会检查目标、素材、权限和风险，不会静默改 SHEIN。';
                autoTask.execution = {
                  ...(autoTask.execution || {}),
                  mode: 'manual_confirm_first',
                  enabled: false,
                  note: '已收到明确运营命令；当前执行器仍只做受控预检/准备，真实写后台需通过执行器校验和人工边界。',
                };
                autoTask.preview = {
                  ...(autoTask.preview || {}),
                  summary: `来自会话的明确动作：${autoTask.intents.map(linkOpsIntentLabel).join(' / ')}；已自动加入任务池，等待执行前预检。`,
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
                await writeJsonFile(args.linkOpsTaskFile, taskData);
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
              const autoTaskNote = reusable && !duplicate
                ? `已更新当前会话的链接运营任务：${autoTask.id}（${linkOpsStatusLabel(autoTask.status)}）。不会重复开新任务；执行前仍会核对目标、素材、权限和风险。`
                : `已自动加入链接运营任务池：${autoTask.id}（${linkOpsStatusLabel(autoTask.status)}）。执行前仍会核对目标、素材、权限和风险，不会静默改 SHEIN。`;
              agentAnswer = agentAnswer ? `${agentAnswer}\n\n${autoTaskNote}` : autoTaskNote;
            }
            if (agentAnswer) {
              session = appendAssistantChatMessage(session, agentAnswer, {
                mode: body.askAgent === false ? 'system-auto-task' : 'readonly-codex-gateway',
                durationMs: agentDurationMs,
                codexSessionId: session.codexSessionId || '',
                codexResumed,
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
          await writeJsonFile(args.linkOpsChatFile, next);
          await appendAudit(args.auditFile, {
            at: new Date().toISOString(),
            type: 'link-ops-chat',
            actor,
            ...requestMeta(req),
            session: {id: session.id, created, messageCount: Array.isArray(session.messages) ? session.messages.length : 0},
          });
          return sendJson(res, 200, {ok: true, data: next, session, autoTask, taskData});
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
          const id = String(body.id || body.sessionId || '').trim();
          if (!id) return sendJson(res, 400, {ok: false, error: 'Missing session id'});
          const current = normalizeLinkOpsChatStore(await readJsonFile(args.linkOpsChatFile, {version: 1, updatedAt: null, sessions: []}));
          const idx = current.sessions.findIndex(s => String(s.id || '') === id);
          if (idx < 0) return sendJson(res, 404, {ok: false, error: 'Chat session not found'});
          const session = {
            ...current.sessions[idx],
            title: typeof body.title === 'string' ? body.title.trim().slice(0, 100) : current.sessions[idx].title,
            autoTitle: typeof body.title === 'string' ? false : current.sessions[idx].autoTitle,
            status: typeof body.status === 'string' ? body.status.trim().slice(0, 40) : current.sessions[idx].status,
            memoryPolicy: CLOUD_AI_MEMORY_POLICY,
            updatedAt: new Date().toISOString(),
          };
          const sessions = current.sessions.slice();
          sessions[idx] = session;
          const next = {version: 1, updatedAt: new Date().toISOString(), memoryPolicy: CLOUD_AI_MEMORY_POLICY, sessions};
          await writeJsonFile(args.linkOpsChatFile, next);
          return sendJson(res, 200, {ok: true, data: next, session});
        }
        if (req.method === 'DELETE') {
          if (args.readOnly) return sendJson(res, 403, {ok: false, error: 'Read-only LAN preview mode'});
          const id = String(url.searchParams.get('id') || '').trim();
          if (!id) return sendJson(res, 400, {ok: false, error: 'Missing session id'});
          const current = normalizeLinkOpsChatStore(await readJsonFile(args.linkOpsChatFile, {version: 1, updatedAt: null, sessions: []}));
          const deletedSession = current.sessions.find(s => String(s.id || '') === id) || null;
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
          await writeJsonFile(args.linkOpsChatFile, next);
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
          return sendJson(res, 200, {ok: true, data: next, deleted: {id, existed: Boolean(deletedSession), codexSession: codexSessionDelete}});
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
            const result = await askReadonlyOpsAgent(question);
            await appendAudit(args.auditFile, {
              at: new Date().toISOString(),
              type: 'ops-agent-ask',
              actor,
              ...requestMeta(req),
              questionPreview: question.slice(0, 240),
              answerLength: result.answer.length,
              durationMs: Date.now() - startedAt,
              ok: true,
            });
            return sendJson(res, 200, {
              ok: true,
              mode: 'readonly-codex-gateway',
              answer: result.answer,
              durationMs: Date.now() - startedAt,
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
            return sendJson(res, 500, {ok: false, error: err?.message || String(err || 'Ops agent failed')});
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
      send(res, 500, `Server error: ${err.message || err}`, {'Content-Type': 'text/plain; charset=utf-8'});
    }
  });

  server.on('upgrade', (req, socket) => {
    handleManualLoginWsUpgrade(req, socket, args).catch(err => {
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

  const urlHost = args.host === '0.0.0.0' ? '127.0.0.1' : args.host;
  console.log(JSON.stringify({
    ok: true,
    url: `http://${urlHost}:${args.port}/`,
    host: args.host,
    port: args.port,
    root,
    stateFile: args.stateFile,
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
