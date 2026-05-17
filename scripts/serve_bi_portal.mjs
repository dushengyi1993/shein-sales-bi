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
    else if (a === '--auth-file') args.authFile = path.resolve(argv[++i]);
    else if (a === '--audit-file') args.auditFile = path.resolve(argv[++i]);
    else if (a === '--read-only') args.readOnly = true;
    else if (a === '--no-auth') args.noAuth = true;
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
    throw new Error(`Invalid --port: ${args.port}`);
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
  if (/补|复制|上品|上架|草稿|覆盖|缺链接|缺链/.test(text)) intents.push('copy_product_draft');
  if (/标题|title/.test(lower)) intents.push('update_title');
  if (/主图|图片|套图|image|photo|pic/.test(lower)) intents.push('update_images');
  if (/下架|死链|淘汰|归档/.test(text)) intents.push('retire_link');
  if (/营销|活动|报名/.test(text)) intents.push('campaign_signup');
  if (/限时|折扣|秒杀|促销|discount/.test(lower)) intents.push('flash_discount');
  if (/证书|资质|合规/.test(text)) intents.push('certificate_review');
  if (!intents.length) intents.push('manual_review');
  return intents;
}

function inferLinkOpsTargets(command) {
  const text = String(command || '');
  const storeMatches = [...new Set((text.match(/\b[A-Z]{2}\b/g) || []).filter(x => x.length === 2))].slice(0, 24);
  const skuMatches = [...new Set((text.match(/[A-Z]{1,6}-?\d{2,8}[A-Z]?(?:[\u4e00-\u9fa5A-Za-z0-9-]*)?/g) || [])
    .map(x => x.replace(/[，。；、,.]+$/g, ''))
    .filter(x => /\d/.test(x)))].slice(0, 24);
  return {
    stores: storeMatches,
    productRefs: skuMatches,
  };
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
  const targets = {
    ...inferLinkOpsTargets(command),
    ...(body.targets && typeof body.targets === 'object' ? body.targets : {}),
  };
  const id = `lot_${now.replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto.randomBytes(4).toString('hex')}`;
  return {
    id,
    version: 1,
    status: 'draft',
    source: 'natural_language',
    command,
    intents,
    targets,
    preview: {
      summary: `识别为：${intents.join(' / ')}；等待人工补充/确认后才会进入执行队列。`,
      riskNotes: linkOpsRiskNotes(intents),
      nextChecks: [
        '确认目标店铺和货号/SKC。',
        '匹配现有链接、覆盖矩阵和表现数据。',
        '确认价格、库存、证书、图片、标题和活动规则。',
        '生成执行前预览，不直接写 SHEIN。',
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
      note: '基座阶段禁用自动执行。',
    },
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
          writableActionState: !args.readOnly,
          writableLinkOpsTasks: !args.readOnly,
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
