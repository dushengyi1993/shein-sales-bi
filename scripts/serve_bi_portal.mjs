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
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    host: '127.0.0.1',
    port: 8787,
    dir: path.join(ROOT, 'outputs', 'bi-portal'),
    stateFile: path.join(ROOT, 'state', 'bi_action_state.json'),
    linkOpsTaskFile: path.join(ROOT, 'state', 'bi_link_ops_tasks.json'),
    linkOpsChatFile: path.join(ROOT, 'state', 'bi_link_ops_chats.json'),
    linkOpsAssetDir: '',
    authFile: path.join(ROOT, 'config', 'bi_users.local.json'),
    auditFile: path.join(ROOT, 'logs', 'bi_portal_action_audit.jsonl'),
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
    else if (a === '--auth-file') args.authFile = path.resolve(argv[++i]);
    else if (a === '--audit-file') args.auditFile = path.resolve(argv[++i]);
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
};

const LINK_OPS_MAX_UPLOAD_FILE_BYTES = 10 * 1024 * 1024;
const LINK_OPS_MAX_UPLOAD_TOTAL_BYTES = 30 * 1024 * 1024;
const SHEIN_STORE_KEYS = new Set(['DL', 'DX', 'FY', 'LQ', 'NM', 'HL', 'JY', 'ZL', 'TS', 'MZ', 'CX', 'YJ', 'XL', 'QY', 'QH', 'TZ', 'DSY', 'LGM']);
const LINK_OPS_ALLOWED_UPLOAD_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/json',
]);

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

function assertInsideDir(baseDir, targetPath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(targetPath);
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Unsafe upload path');
  }
  return target;
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
  const text = (Array.isArray(session?.messages) ? session.messages : [])
    .slice(-12)
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

function isLinkOpsActionCommand(command) {
  const text = String(command || '').trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  const intents = inferLinkOpsIntent(text).filter(x => x !== 'manual_review');
  if (!intents.length) return false;
  const actionVerb = /下架|归档|停掉|移除|删除链接|换图|更换图片|改标题|换标题|补链接|补链|复制上品|创建草稿|创建链接|上品|报活动|报名|限时折扣|设置折扣|补证书|补资质|上传证书/.test(text)
    || /\b(retire|remove|archive|replace image|update title|create draft|campaign|discount)\b/.test(lower);
  if (!actionVerb) return false;
  const strongCommand = /把|将|要求|安排|加入任务池|加入动作池|执行|处理|现在|立即|直接/.test(text)
    || /^(下架|归档|换图|改标题|补链接|补链|报活动|报名|设置折扣|补证书|补资质)/.test(text);
  const giveCommand = /给.+(重新生成|生成|换|更换|改|下架|报|报名|设置|补)/.test(text);
  const exploratory = /建议|分析|看看|找出|哪些|哪个|是否|能否|能不能|可以吗|怎么|如何|为什么|原因/.test(text);
  if (exploratory && !strongCommand && !giveCommand) return false;
  return strongCommand || giveCommand || !exploratory;
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

function linkOpsRiskNotes(intents) {
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
      riskNotes: linkOpsRiskNotes(intents),
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
    sessions: sessions.filter(x => x && typeof x === 'object').slice(0, 300),
  };
}

function buildChatSessionFromMessage(body, actor, req) {
  const message = String(body.message || body.command || body.text || '').trim();
  if (!message) throw new Error('Missing message');
  if (message.length > 4000) throw new Error('Message too long');
  const now = new Date().toISOString();
  const id = `los_${now.replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto.randomBytes(4).toString('hex')}`;
  return {
    id,
    version: 1,
    status: 'chatting',
    title: message.slice(0, 80),
    targets: mergeLinkOpsTargets(
      inferLinkOpsTargets(message),
      body.targets && typeof body.targets === 'object' ? body.targets : {}
    ),
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
  const messages = Array.isArray(session.messages) ? session.messages.slice(-80) : [];
  messages.push({id: `msg_${crypto.randomBytes(5).toString('hex')}`, role: 'user', content, at: now});
  return {
    ...session,
    status: 'chatting',
    updatedAt: now,
    title: session.title || content.slice(0, 80),
    targets: mergeLinkOpsTargets(
      session.targets && typeof session.targets === 'object' ? session.targets : {},
      inferLinkOpsTargets(content)
    ),
    messages,
    updatedBy: actorLabel(actor, req),
  };
}

function appendAssistantChatMessage(session, answer, meta = {}) {
  const now = new Date().toISOString();
  const messages = Array.isArray(session.messages) ? session.messages.slice(-80) : [];
  messages.push({id: `msg_${crypto.randomBytes(5).toString('hex')}`, role: 'assistant', content: String(answer || '').slice(0, 16000), at: now, meta});
  return {
    ...session,
    updatedAt: now,
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
  if (normalizedFiles.length > 20) throw new Error('Too many files');
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

function runPreflightForLinkOpsTask(task) {
  const blockers = [];
  const warnings = [];
  const assets = Array.isArray(task.assets) ? task.assets : [];
  const needs = linkOpsTaskNeedsMaterial(task);
  const status = String(task.status || 'draft');
  if (!['confirmed', 'in_progress', 'waiting_review'].includes(status)) {
    blockers.push('任务必须先点“确认成任务”，不能从草案直接执行。');
  }
  if (needs.includes('image') && !assets.some(a => a.kind === 'image')) {
    blockers.push('缺少图片素材：请先上传或同步商品图。');
  }
  if (needs.includes('image_or_certificate') && !assets.some(a => a.kind === 'image' || a.kind === 'certificate')) {
    blockers.push('复制上品缺少图片/证书素材：请先上传或同步可复用素材。');
  }
  if (needs.includes('certificate') && !assets.some(a => a.kind === 'certificate' || a.mime === 'application/pdf')) {
    blockers.push('缺少证书/资质文件。');
  }
  if (needs.includes('title_text_or_rule') && !assets.some(a => a.kind === 'text')) {
    warnings.push('标题类任务未上传标题文本/规则文件；如果标题已写在会话或任务说明里，可人工确认后继续。');
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

function startControlledLinkOpsExecution(task, actor, req) {
  const preflight = runPreflightForLinkOpsTask(task);
  const now = new Date().toISOString();
  const runId = `lor_${now.replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto.randomBytes(4).toString('hex')}`;
  const next = {
    ...task,
    status: preflight.ok ? 'in_progress' : 'waiting_review',
    progress: preflight.ok ? Math.max(normalizeProgress(task.progress, 0), 65) : Math.max(normalizeProgress(task.progress, 0), 45),
    note: preflight.ok
      ? '受控执行器已完成前置检查；当前第一版停在执行准备/预填阶段，不会静默提交 SHEIN。'
      : `执行器未启动：${preflight.blockers.join('；')}`,
    execution: {
      ...(task.execution && typeof task.execution === 'object' ? task.execution : {}),
      mode: 'controlled_prefill',
      enabled: true,
      runId,
      state: preflight.ok ? 'ready_for_prefill' : 'blocked',
      canAutoSubmit: false,
      canSilentWrite: false,
      preflight,
      startedAt: now,
      startedBy: actorLabel(actor, req),
      note: '第一版只做材料/权限/防重检查和执行准备；正式 SHEIN 提交必须后续接具体适配器并保留人工确认。',
    },
    updatedAt: now,
  };
  next.history = appendTaskHistory(next, preflight.ok ? 'start_controlled_executor' : 'executor_blocked', actor, req, {
    status: next.status,
    progress: normalizeProgress(next.progress, 0),
    runId,
    blockers: preflight.blockers,
    warnings: preflight.warnings,
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

async function askReadonlyOpsAgent(question) {
  const text = String(question || '').trim();
  if (!text) throw new Error('Missing question');
  if (text.length > 12000) throw new Error('Question too long');
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
      SHEIN_QA_CODEX_GATEWAY_TIMEOUT_MS: process.env.SHEIN_QA_CODEX_GATEWAY_TIMEOUT_MS || '180000',
      SHEIN_QA_LLM_ENABLED: process.env.SHEIN_QA_LLM_ENABLED || '1',
      SHEIN_QA_LLM_TIMEOUT_MS: process.env.SHEIN_QA_LLM_TIMEOUT_MS || '45000',
    },
  });
  if (!result.ok) {
    throw new Error(`Ops agent failed code=${result.code} timeout=${result.timedOut} stderr=${String(result.stderr || '').slice(-500)}`);
  }
  return {
    answer: String(result.stdout || '').trim(),
    stderrTail: String(result.stderr || '').slice(-1000),
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
      if (url.pathname === '/favicon.ico') {
        return send(res, 204, '', {'Content-Type': 'image/x-icon'});
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
          await appendAudit(args.auditFile, {
            at: new Date().toISOString(),
            type: 'link-ops-task-delete',
            actor,
            ...requestMeta(req),
            task: {id, status: task.status, commandLength: String(task.command || '').length},
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
          const updated = startControlledLinkOpsExecution(current.tasks[idx], actor, req);
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
            const shouldAutoTask = isLinkOpsActionCommand(userMessage);
            let agentAnswer = '';
            let agentDurationMs = 0;
            if (body.askAgent !== false) {
              const conversation = (session.messages || []).slice(-10).map(m => `${m.role === 'assistant' ? '智能体' : '用户'}：${m.content}`).join('\n');
              const extraRules = shouldAutoTask
                ? [
                    '本条最新用户消息已识别为明确运营动作命令。系统会自动把它加入链接运营任务池，等待人工确认/执行器预检。',
                    '你的回复不能声称已经执行，也不要只说“没有权限所以不能”；应明确说“已加入待确认动作/任务，执行前还会核对目标、素材、权限和风险”。',
                  ]
                : [
                    '每一轮都要根据整段会话和最新 BI JSON 上下文重新查数；如果最新用户消息换了店铺、货号或指标，以最新消息为准，缺省时再沿用上文。',
                  ];
              const question = [
                '这是 SHEIN 链接管理中台的一段运营会话。请只围绕 SHEIN 数据、链接管理、标题/图片/活动/补链建议回答。',
                '如果信息还不够，先问需要补充什么；如果已经可以形成任务，请给出清晰的下一步和风险边界。',
                '遇到“这个链接/这个品/2,223 这个”等指代时，必须结合上文已出现的店铺、货号、SKC、曝光/访客/销量数字重新定位；不能因为最新一句没写全就否定上轮数据。',
                '会话已识别目标：' + summarizeLinkOpsTargets(conversationTargets),
                ...extraRules,
                conversation,
              ].join('\n\n');
              const startedAt = Date.now();
              const result = await askReadonlyOpsAgent(question);
              agentDurationMs = Date.now() - startedAt;
              agentAnswer = result.answer;
            }
            if (shouldAutoTask) {
              const taskStore = normalizeLinkOpsTaskStore(await readJsonFile(args.linkOpsTaskFile, {version: 1, updatedAt: null, tasks: []}));
              const duplicate = findDuplicateAutoTask(taskStore.tasks, session.id, userMessage);
              if (duplicate) {
                autoTask = duplicate;
                taskData = taskStore;
              } else {
                autoTask = buildLinkOpsTaskFromCommand({
                  command: userMessage,
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
              const autoTaskNote = `已自动加入链接运营任务池：${autoTask.id}（${linkOpsStatusLabel(autoTask.status)}）。执行前仍会核对目标、素材、权限和风险，不会静默改 SHEIN。`;
              agentAnswer = agentAnswer ? `${agentAnswer}\n\n${autoTaskNote}` : autoTaskNote;
            }
            if (agentAnswer) {
              session = appendAssistantChatMessage(session, agentAnswer, {
                mode: body.askAgent === false ? 'system-auto-task' : 'readonly-codex-gateway',
                durationMs: agentDurationMs,
                autoTaskId: autoTask?.id || '',
              });
            }
          } catch (err) {
            return sendJson(res, 500, {ok: false, error: err?.message || String(err || 'Chat failed')});
          }
          const sessions = created
            ? [session, ...current.sessions].slice(0, 300)
            : current.sessions.map(s => String(s.id || '') === session.id ? session : s);
          const next = {version: 1, updatedAt: new Date().toISOString(), sessions};
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
            status: typeof body.status === 'string' ? body.status.trim().slice(0, 40) : current.sessions[idx].status,
            updatedAt: new Date().toISOString(),
          };
          const sessions = current.sessions.slice();
          sessions[idx] = session;
          const next = {version: 1, updatedAt: new Date().toISOString(), sessions};
          await writeJsonFile(args.linkOpsChatFile, next);
          return sendJson(res, 200, {ok: true, data: next, session});
        }
        if (req.method === 'DELETE') {
          if (args.readOnly) return sendJson(res, 403, {ok: false, error: 'Read-only LAN preview mode'});
          const id = String(url.searchParams.get('id') || '').trim();
          if (!id) return sendJson(res, 400, {ok: false, error: 'Missing session id'});
          const current = normalizeLinkOpsChatStore(await readJsonFile(args.linkOpsChatFile, {version: 1, updatedAt: null, sessions: []}));
          const next = {version: 1, updatedAt: new Date().toISOString(), sessions: current.sessions.filter(s => String(s.id || '') !== id)};
          await writeJsonFile(args.linkOpsChatFile, next);
          return sendJson(res, 200, {ok: true, data: next, deleted: {id}});
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
