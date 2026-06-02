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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORES_PATH = path.join(ROOT, 'config', 'stores.json');

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
const DEFAULT_SHEIN_STORE_KEYS = ['DL', 'DX', 'FY', 'LQ', 'NM', 'HL', 'JY', 'ZL', 'TS', 'MZ', 'CX', 'YJ', 'XL', 'QY', 'QH', 'TZ', 'JSH', 'TZZ', 'XC', 'DSY', 'LGM'];
const DEFAULT_MANUAL_LOGIN_STORE_KEYS = ['DL', 'DX', 'FY', 'LQ', 'NM', 'HL', 'JY', 'ZL', 'TS', 'MZ', 'CX', 'YJ', 'XL', 'QY', 'QH', 'TZ', 'JSH', 'TZZ', 'XC'];
const BI_PORTAL_SECTION_KEYS = new Set(['homeProfit', 'rankings', 'profit', 'actions', 'linksData', 'comments', 'orders', 'afterSales', 'financeData', 'rtvData', 'waybills']);
const BI_PORTAL_SECTION_TIMEOUT_MS = Math.max(60_000, Number(process.env.SHEIN_BI_SECTION_TIMEOUT_MS || 900_000));
const biSectionInFlight = new Map();
const LINK_OPS_STORE_CAPABILITIES = {
  HL: {
    openapiAuthorized: true,
    verifiedRead: true,
    salesReconciliation: true,
    productPublishAdapter: true,
    note: 'HL 已完成 SHEIN OpenAPI 真实授权，并已验证商品/订单/库存等只读接口和销售对账；商品发布/编辑执行器已接入受控预检，真实提交仍要求 payload 完整和显式确认。',
  },
};

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
    return JSON.parse(await fs.readFile(file, 'utf8'));
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

function timingSafeEqualString(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
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
  return false;
}

async function loadAuthUsers(authFile) {
  const users = [];
  const local = await readJsonFile(authFile, null);
  if (local && Array.isArray(local.users)) {
    for (const u of local.users) {
      const username = String(u.username || u.email || '').trim();
      if (!username) continue;
      users.push({
        username,
        displayName: String(u.displayName || u.name || username).trim(),
        role: String(u.role || 'operator').trim(),
        password: typeof u.password === 'string' ? u.password : undefined,
        passwordSha256: typeof u.passwordSha256 === 'string' ? u.passwordSha256 : undefined,
        passwordHash: typeof u.passwordHash === 'string' ? u.passwordHash : undefined,
        source: path.relative(ROOT, authFile),
      });
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
        source: path.relative(ROOT, metabaseAdminFile),
      });
    }
  }
  return users;
}

function unauthorized(res) {
  send(res, 401, 'Authentication required', {
    'Content-Type': 'text/plain; charset=utf-8',
    'WWW-Authenticate': 'Basic realm="SHEIN BI Portal"',
  });
}

function authenticateRequest(req, res, users) {
  const header = req.headers.authorization || '';
  const m = /^Basic\s+(.+)$/i.exec(header);
  if (!m) {
    unauthorized(res);
    return null;
  }
  let decoded = '';
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    unauthorized(res);
    return null;
  }
  const sep = decoded.indexOf(':');
  if (sep < 0) {
    unauthorized(res);
    return null;
  }
  const username = decoded.slice(0, sep);
  const password = decoded.slice(sep + 1);
  const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!verifyPassword(user, password)) {
    unauthorized(res);
    return null;
  }
  return {
    username: user.username,
    displayName: user.displayName || user.username,
    role: user.role || 'operator',
    source: user.source,
  };
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

function requestMeta(req) {
  return {
    remoteAddress: normalizeRemoteAddress(req),
    socketAddress: req.socket.remoteAddress || '',
    forwardedFor: String(req.headers['x-forwarded-for'] || ''),
    realIp: String(req.headers['x-real-ip'] || ''),
    userAgent: req.headers['user-agent'] || '',
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
  const storeMatches = [...new Set((text.match(/\b[A-Z]{2,3}\b/g) || [])
    .map(x => x.toUpperCase())
    .filter(x => SHEIN_STORE_KEYS.has(x)))].slice(0, 24);
  const skuMatches = [...new Set((text.match(/\b(?:[A-Z]{1,6}-?\d{1,8}[A-Z]?(?:-[A-Z0-9]+)?(?:[\u4e00-\u9fa5A-Za-z0-9-]*)?|(?:sv|sb)\d{8,})\b/giu) || [])
    .map(x => x
      .replace(/[，。；、,.]+$/g, '')
      .replace(/(各店|全店|所有店|差链接|弱链接|死链接|缺链接|链接|建议|下架|换图|补新|补链|覆盖).*$/u, ''))
    .filter(x => /\d/.test(x)))].slice(0, 24);
  return {
    stores: storeMatches,
    productRefs: skuMatches,
  };
}

function normalizeLinkOpsTargetSet(targets = {}) {
  const stores = Array.isArray(targets?.stores)
    ? targets.stores
    : typeof targets?.stores === 'string'
      ? targets.stores.split(/[,\s，、]+/)
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
    productRefs: clean(productRefs, 48),
  };
}

function mergeLinkOpsTargets(...items) {
  return normalizeLinkOpsTargetSet({
    stores: items.flatMap(x => normalizeLinkOpsTargetSet(x).stores),
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
    const cap = LINK_OPS_STORE_CAPABILITIES[store];
    if (cap?.openapiAuthorized) {
      return `${store}: OpenAPI 已授权；只读/销售对账已验证；商品发布/提交审核写适配器=${cap.productPublishAdapter ? '已实现' : '待实现验证'}。`;
    }
    return `${store}: 暂未登记官方 OpenAPI 授权；写操作需先走云端 WebAPI/headless 受控执行，或完成该店 OpenAPI 接入。`;
  }).join('\n');
}

function linkOpsCapabilityNotes(intents = [], targets = {}) {
  const writeIntents = ['copy_product_draft', 'update_title', 'update_images', 'retire_link', 'campaign_signup', 'flash_discount', 'certificate_review'];
  if (!intents.some(x => writeIntents.includes(x))) return [];
  const stores = normalizeConcreteStoreKeys(normalizeLinkOpsTargetSet(targets).stores);
  const notes = [];
  if (stores.includes('HL')) {
    notes.push('HL OpenAPI 已授权且商品发布/编辑受控执行器已接入；当前任务应进入 HL API 预检/执行准备，缺发布 payload 时说明缺类目、属性、图片、SKU、成本、库存等资料，不能说“没有权限”，也不能谎称已提交审核。');
  }
  const notOpenApiStores = stores.filter(store => store !== 'HL');
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

const LINK_OPS_ALLOWED_STATUSES = new Set(['draft', 'confirmed', 'in_progress', 'waiting_review', 'done', 'archived']);

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

function patchLinkOpsTask(task, body, actor, req) {
  const next = {
    ...task,
    updatedAt: new Date().toISOString(),
  };
  const event = String(body.event || body.action || 'update').slice(0, 80);
  if (body.status !== undefined) {
    const status = String(body.status || '').trim();
    if (!LINK_OPS_ALLOWED_STATUSES.has(status)) throw new Error(`Invalid status: ${status}`);
    next.status = status;
    if (['done', 'archived'].includes(status)) {
      next.assetRetention = {
        policy: 'keep_until_task_delete',
        note: '任务完成/归档后暂保留素材用于复核；删除任务时同步清理素材目录。',
        updatedAt: new Date().toISOString(),
      };
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
  if (body.execution && typeof body.execution === 'object') {
    next.execution = {
      ...(task.execution && typeof task.execution === 'object' ? task.execution : {}),
      ...body.execution,
    };
  }
  next.history = appendTaskHistory(next, event, actor, req, {
    status: next.status,
    progress: normalizeProgress(next.progress, 0),
    hasAgentAnswer: !!next.preview?.agentAnswer,
    hasNote: !!next.note,
  });
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

async function attachLinkOpsAssets({store, taskId, files, args, actor, req}) {
  const id = safeTaskId(taskId);
  const tasks = Array.isArray(store.tasks) ? store.tasks.slice() : [];
  const idx = tasks.findIndex(t => String(t.id || '') === id);
  if (idx < 0) throw new Error('Task not found');
  const normalizedFiles = Array.isArray(files) ? files : [];
  if (!normalizedFiles.length) throw new Error('Missing files');
  if (normalizedFiles.length > 40) throw new Error('Too many files');
  let totalBytes = 0;
  const baseDir = path.resolve(args.linkOpsAssetDir);
  const taskDir = assertInsideDir(baseDir, path.join(baseDir, id));
  await fs.mkdir(taskDir, {recursive: true});
  const added = [];
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
    added.push(buildAssetRecord({taskId: id, file: {...file, type: mime}, buffer, storedPath, actor, req}));
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
  if (intents.includes('copy_product_draft') && stores.includes('HL') && !LINK_OPS_STORE_CAPABILITIES.HL?.productPublishAdapter) {
    blockers.push('HL OpenAPI 已授权，但商品发布/提交审核写适配器尚未实现验证；本任务已进入执行准备，需先接入 publish/submit adapter 后才能真实提交审核。');
  }
  const nonOpenApiStores = stores.filter(store => !LINK_OPS_STORE_CAPABILITIES[store]?.openapiAuthorized);
  if (intents.some(x => ['copy_product_draft', 'update_title', 'update_images', 'retire_link', 'campaign_signup', 'flash_discount', 'certificate_review'].includes(x)) && nonOpenApiStores.length) {
    warnings.push(`${nonOpenApiStores.join(',')} 暂无官方 OpenAPI 授权记录；后续执行需走云端 WebAPI/headless 受控路径或先完成该店 OpenAPI 接入。`);
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

function shouldRunHlOpenApiProductExecutor(task) {
  const intents = Array.isArray(task?.intents) ? task.intents : [];
  const targets = normalizeLinkOpsTargetSet(task?.targets || {});
  const stores = normalizeConcreteStoreKeys(targets.stores);
  return intents.includes('copy_product_draft') && stores.includes('HL');
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

async function runHlOpenApiProductExecutor(task, args, body = {}) {
  const mode = String(body.mode || body.executionMode || '').toLowerCase() === 'execute' || body.execute === true
    ? 'execute'
    : 'dry-run';
  const taskSnapshotDir = path.join(ROOT, 'tmp', 'link-ops-executor-task-json');
  const taskSnapshotFile = path.join(taskSnapshotDir, `${safeTaskId(task.id)}-${crypto.randomBytes(4).toString('hex')}.json`);
  await fs.mkdir(taskSnapshotDir, {recursive: true});
  await fs.writeFile(taskSnapshotFile, `${JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    tasks: [task],
  }, null, 2)}\n`, 'utf8');
  const childArgs = [
    path.join(ROOT, 'scripts', 'link_ops_hl_openapi_executor.mjs'),
    '--task-json', taskSnapshotFile,
    '--task-id', String(task.id || ''),
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
      code: result.code,
      timedOut: result.timedOut,
      result: parsed,
      stderrTail: String(result.stderr || '').slice(-1200),
    };
  }
  return {
    ok: false,
    mode,
    code: result.code,
    timedOut: result.timedOut,
    result: {
      ok: false,
      state: result.timedOut ? 'timeout' : 'error',
      blockers: [`HL OpenAPI 执行器未返回可解析结果：code=${result.code}${result.timedOut ? ' timeout=true' : ''}`],
      warnings: [],
      rawStdoutTail: String(result.stdout || '').slice(-1200),
      rawStderrTail: String(result.stderr || '').slice(-1200),
    },
    stderrTail: String(result.stderr || '').slice(-1200),
  };
}

async function startControlledLinkOpsExecution(task, actor, req, args, body = {}) {
  const originalStatus = String(task?.status || 'draft');
  const now = new Date().toISOString();
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
  let hlOpenApiExecutor = null;
  if (shouldRunHlOpenApiProductExecutor(runnableTask)) {
    hlOpenApiExecutor = await runHlOpenApiProductExecutor(runnableTask, args, body);
  }
  const executorResult = hlOpenApiExecutor?.result || null;
  const combinedBlockers = uniqueMessages([
    ...preflight.blockers,
    ...asArray(executorResult?.blockers),
  ]);
  const combinedWarnings = uniqueMessages([
    ...preflight.warnings,
    ...asArray(executorResult?.warnings),
  ]);
  const ok = combinedBlockers.length === 0;
  const runId = `lor_${now.replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto.randomBytes(4).toString('hex')}`;
  const executorState = executorResult?.state || (ok ? 'ready_for_prefill' : 'blocked');
  const submitted = executorState === 'submitted';
  const nextStatus = submitted
    ? 'in_progress'
    : hlOpenApiExecutor
      ? 'waiting_review'
      : (ok ? 'in_progress' : 'waiting_review');
  const nextProgress = submitted
    ? Math.max(normalizeProgress(task.progress, 0), 80)
    : ok
      ? Math.max(normalizeProgress(task.progress, 0), hlOpenApiExecutor ? 70 : 65)
      : Math.max(normalizeProgress(task.progress, 0), 45);
  const next = {
    ...runnableTask,
    status: nextStatus,
    progress: nextProgress,
    note: submitted
      ? 'HL OpenAPI 已提交 publishOrEdit，等待 SHEIN 审核/状态回查。'
      : ok && hlOpenApiExecutor
        ? 'HL OpenAPI 执行器预检通过；仍需最终执行确认，系统不会静默提交 SHEIN。'
        : ok
          ? '受控执行器已完成前置检查；当前停在执行准备/预填阶段，不会静默提交 SHEIN。'
          : `执行器阻断：${combinedBlockers.join('；')}`,
    execution: {
      ...(task.execution && typeof task.execution === 'object' ? task.execution : {}),
      mode: hlOpenApiExecutor ? 'hl_openapi_product_executor' : 'controlled_prefill',
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
      hlOpenApiExecutor: executorResult ? {
        ok: Boolean(executorResult.ok),
        mode: hlOpenApiExecutor.mode,
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
        safety: executorResult.safety || null,
      } : null,
      startedAt: now,
      startedBy: actorLabel(actor, req),
      autoConfirmed,
      note: hlOpenApiExecutor
        ? 'HL OpenAPI 执行器已接入。默认只做预检；真实 publishOrEdit 必须任务已确认、payload 完整、显式 execute 和确认文本同时满足。'
        : '第一版只做材料/权限/防重检查和执行准备；正式 SHEIN 提交必须后续接具体适配器并保留人工确认。',
    },
    updatedAt: now,
  };
  next.history = appendTaskHistory(next, ok ? (submitted ? 'hl_openapi_submitted' : (hlOpenApiExecutor ? 'hl_openapi_preflight_ready' : 'start_controlled_executor')) : 'executor_blocked', actor, req, {
    status: next.status,
    progress: normalizeProgress(next.progress, 0),
    runId,
    autoConfirmed,
    originalStatus,
    blockers: combinedBlockers,
    warnings: combinedWarnings,
    hlOpenApiExecutor: executorResult ? {
      state: executorResult.state || '',
      runId: executorResult.runId || '',
      savedTo: executorResult.savedTo || '',
      payloadFound: Boolean(executorResult.payload?.found),
      payloadSummary: executorResult.payload?.summary || null,
      canPublishProduct: executorResult.openapi?.canPublishProduct ?? null,
      publishResult: executorResult.publishResult ? {
        httpStatus: executorResult.publishResult.httpStatus,
        code: executorResult.publishResult.code,
        msg: executorResult.publishResult.msg,
        traceId: executorResult.publishResult.traceId,
      } : null,
    } : null,
  });
  return next;
}

function runChildProcess(command, args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      env: {...process.env, ...(options.env || {})},
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
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

function appendCacheHitToJsonObjectBuffer(buffer, cacheHit) {
  if (!Buffer.isBuffer(buffer)) return null;
  let end = buffer.length;
  while (end > 0) {
    const c = buffer[end - 1];
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
    end--;
  }
  if (end < 2 || buffer[end - 1] !== 0x7d) return null;
  return Buffer.concat([
    buffer.subarray(0, end - 1),
    Buffer.from(`,\n  "cacheHit": ${cacheHit ? 'true' : 'false'}\n}\n`, 'utf8'),
  ]);
}

function extractJsonStringFieldFromHead(head, field) {
  const re = new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`);
  return re.exec(head)?.[1] || '';
}

async function readBiSectionCacheRaw(root, section, generatedAt, cacheHit = true) {
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

  const body = appendCacheHitToJsonObjectBuffer(buffer, cacheHit);
  if (!body) return null;
  return {
    body,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-BI-Section-Cache-Hit': cacheHit ? 'true' : 'false',
      'X-BI-Section-Mode': 'raw-cache',
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
  await writeJsonFileCompact(file, payload);
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

async function generateBiSection(args, root, section, generatedAt) {
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
  return writeBiSectionCache(root, section, generatedAt, data, run);
}

async function loadBiSection(args, root, section, options = {}) {
  const force = !!options.force;
  const allowGenerate = options.allowGenerate !== false;
  if (!BI_PORTAL_SECTION_KEYS.has(section)) {
    return {status: 404, payload: {ok: false, error: 'Unknown BI section', section}};
  }
  const meta = await readBiPortalCoreMeta(root);
  if (meta.mode !== 'api' && !force) {
    return {status: 400, payload: {ok: false, error: 'BI portal is not in api data mode', section, mode: meta.mode}};
  }
  if (section === 'homeProfit') {
    const cached = !force ? await readBiSectionCache(root, section, meta.generatedAt) : null;
    const cachedSourceGeneratedAt = String(cached?.data?.homeProfitSummary?.sourceGeneratedAt || '');
    if (cached && cachedSourceGeneratedAt === String(meta.generatedAt || '')) {
      const rawCached = await readBiSectionCacheRaw(root, section, meta.generatedAt, true);
      if (rawCached) return {status: 200, rawBody: rawCached.body, headers: rawCached.headers};
      return {status: 200, payload: {...cached, cacheHit: true}};
    }
    if (cached && cachedSourceGeneratedAt !== String(meta.generatedAt || '')) {
      const currentProfitCache = await readBiSectionCache(root, 'profit', meta.generatedAt);
      if (!currentProfitCache) {
        const rawCached = await readBiSectionCacheRaw(root, section, meta.generatedAt, true);
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
      const rawGenerated = await readBiSectionCacheRaw(root, section, meta.generatedAt, false);
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
    const rawCached = await readBiSectionCacheRaw(root, section, meta.generatedAt, true);
    if (rawCached) return {status: 200, rawBody: rawCached.body, headers: rawCached.headers};
    const cached = await readBiSectionCache(root, section, meta.generatedAt);
    if (cached) return {status: 200, payload: {...cached, cacheHit: true}};
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
  const key = `${root}|${section}|${meta.generatedAt || ''}`;
  if (!biSectionInFlight.has(key)) {
    biSectionInFlight.set(key, generateBiSection(args, root, section, meta.generatedAt).finally(() => {
      biSectionInFlight.delete(key);
    }));
  }
  const payload = await biSectionInFlight.get(key);
  const rawGenerated = await readBiSectionCacheRaw(root, section, meta.generatedAt, false);
  if (rawGenerated) return {status: 200, rawBody: rawGenerated.body, headers: rawGenerated.headers};
  return {status: 200, payload: {...payload, cacheHit: false}};
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
  let raw = '';
  for await (const chunk of req) {
    raw += chunk.toString('utf8');
    if (raw.length > limitBytes) throw new Error('Request body too large');
  }
  return raw ? JSON.parse(raw) : {};
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
  const authRequired = args.host === '0.0.0.0' && !args.noAuth && !args.readOnly;
  const authUsers = authRequired ? await loadAuthUsers(args.authFile) : [];
  if (authRequired && authUsers.length === 0) {
    throw new Error(`LAN collaboration requires at least one user in ${args.authFile} or infra/metabase/.admin.local.json`);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const actor = authRequired ? authenticateRequest(req, res, authUsers) : null;
      if (authRequired && !actor) return;
      const url = new URL(req.url || '/', 'http://localhost');
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
          user: actor ? {
            username: actor.username,
            displayName: actor.displayName,
            role: actor.role,
          } : null,
        });
      }
      {
        const m = /^\/api\/bi\/section\/([^/]+)$/.exec(url.pathname);
        if (m) {
          if (req.method !== 'GET') return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
          const section = decodeURIComponent(m[1]);
          const force = url.searchParams.get('refresh') === '1';
          const allowGenerate = !(args.readOnly || (args.host === '0.0.0.0' && !authRequired));
          if (force && !allowGenerate) {
            return sendJson(res, 403, {ok: false, section, error: 'Section refresh is disabled in read-only or unauthenticated LAN mode'});
          }
          try {
            const result = await loadBiSection(args, root, section, {force, allowGenerate});
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
          let task;
          try {
            const body = await readBodyJson(req);
            task = buildLinkOpsTaskFromCommand(body, actor, req);
          } catch (err) {
            return sendJson(res, 400, {ok: false, error: err?.message || String(err || 'Invalid request')});
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
          let updated;
          try {
            updated = patchLinkOpsTask(current.tasks[idx], body, actor, req);
          } catch (err) {
            return sendJson(res, 400, {ok: false, error: err?.message || String(err || 'Invalid patch')});
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
          const id = String(url.searchParams.get('id') || '').trim();
          if (!id) return sendJson(res, 400, {ok: false, error: 'Missing task id'});
          const current = normalizeLinkOpsTaskStore(await readJsonFile(args.linkOpsTaskFile, {version: 1, updatedAt: null, tasks: []}));
          const task = current.tasks.find(t => String(t.id || '') === id);
          if (!task) return sendJson(res, 404, {ok: false, error: 'Task not found'});
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
          let body;
          try {
            body = await readBodyJson(req, Math.ceil(LINK_OPS_MAX_UPLOAD_TOTAL_BYTES * 1.45));
          } catch (err) {
            return sendJson(res, 400, {ok: false, error: err?.message || String(err || 'Invalid upload')});
          }
          const current = normalizeLinkOpsTaskStore(await readJsonFile(args.linkOpsTaskFile, {version: 1, updatedAt: null, tasks: []}));
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
          const body = await readBodyJson(req, 256 * 1024).catch(err => ({_error: err?.message || String(err)}));
          if (body._error) return sendJson(res, 400, {ok: false, error: body._error});
          const id = String(body.id || body.taskId || '').trim();
          if (!id) return sendJson(res, 400, {ok: false, error: 'Missing task id'});
          const current = normalizeLinkOpsTaskStore(await readJsonFile(args.linkOpsTaskFile, {version: 1, updatedAt: null, tasks: []}));
          const idx = current.tasks.findIndex(t => String(t.id || '') === id);
          if (idx < 0) return sendJson(res, 404, {ok: false, error: 'Task not found'});
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
                canSilentWrite: false,
                canAutoSubmit: false,
              },
            },
          });
          return sendJson(res, 200, {ok: true, data: next, task: updated, execution: updated.execution});
        }
        return sendJson(res, 405, {ok: false, error: 'Method not allowed'});
      }
      if (url.pathname === '/api/link-ops-chats') {
        if (req.method === 'GET') {
          const current = normalizeLinkOpsChatStore(await readJsonFile(args.linkOpsChatFile, {version: 1, updatedAt: null, sessions: []}));
          const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 80)));
          return sendJson(res, 200, {ok: true, data: {...current, sessions: current.sessions.slice(0, limit)}});
        }
        if (req.method === 'POST') {
          if (args.readOnly) return sendJson(res, 403, {ok: false, error: 'Read-only LAN preview mode'});
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
            const shouldAutoTask = explicitActionCommand || (confirmExecuteCommand && hasActionableLinkOpsContext(session));
            const effectiveTaskCommand = explicitActionCommand
              ? userMessage
              : shouldAutoTask
                ? buildConfirmedLinkOpsCommandFromSession(session, userMessage)
                : userMessage;
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
                    '如果目标店铺是 HL，应说明 HL 已有 OpenAPI 授权和只读/销售对账能力；当前缺口是商品发布/提交审核写适配器尚未实现验证，不能笼统说 HL 没有权限。',
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
    authUsers: authUsers.map(u => ({username: u.username, displayName: u.displayName, role: u.role, source: u.source})),
  }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
