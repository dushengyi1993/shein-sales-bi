#!/usr/bin/env node
/**
 * Cloud manual SHEIN login session helper.
 *
 * Starts a temporary visible Chrome inside Xvfb, exposes it through x11vnc +
 * websockify bound to 127.0.0.1, and records only non-secret session metadata.
 *
 * It never prints or stores SHEIN passwords, cookies, localStorage values, or
 * request headers. The only secret it creates is a short-lived access token for
 * the temporary noVNC websocket.
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORES_PATH = path.join(ROOT, 'config', 'stores.json');
const DEFAULT_STATE_FILE = process.env.SHEIN_MANUAL_LOGIN_STATE_FILE || '/srv/shein-bi/runtime/cloud_manual_login_sessions.json';
const DEFAULT_LOG_DIR = process.env.SHEIN_MANUAL_LOGIN_LOG_DIR || '/srv/shein-bi/logs/cloud-manual-login';
const DEFAULT_EXPIRES_MINUTES = 30;
const DEFAULT_WIDTH = 1365;
const DEFAULT_HEIGHT = 900;
const SBN_URL = 'https://sso.geiwohuo.com/#/sbn/merchandise/details';
const ORDER_URL = 'https://sso.geiwohuo.com/#/gsp/order-management/list';
const HOME_URL = 'https://sso.geiwohuo.com/#/gsp/home';
const CHROME_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];
const BUSY_SYNC_SERVICES = [
  'shein-bi-cloud-today.service',
  'shein-bi-cloud-yesterday.service',
  'shein-bi-cloud-link-business.service',
  'shein-bi-cloud-session-manager.service',
  'shein-bi-cloud-et-forwarder.service',
  'shein-bi-cloud-rtv-verify.service',
  'shein-bi-cloud-openapi-hl.service',
];

function parseArgs(argv) {
  const args = {
    command: argv[0] || 'list',
    storeKey: '',
    id: '',
    token: '',
    stateFile: DEFAULT_STATE_FILE,
    logDir: DEFAULT_LOG_DIR,
    target: 'sbn',
    expiresMinutes: DEFAULT_EXPIRES_MINUTES,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    basePath: '/cloud-login/session',
    showToken: false,
  };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--store') args.storeKey = String(argv[++i] || '').trim().toUpperCase();
    else if (a === '--id') args.id = String(argv[++i] || '').trim();
    else if (a === '--token') args.token = String(argv[++i] || '').trim();
    else if (a === '--state-file') args.stateFile = path.resolve(String(argv[++i] || args.stateFile));
    else if (a === '--log-dir') args.logDir = path.resolve(String(argv[++i] || args.logDir));
    else if (a === '--target') args.target = String(argv[++i] || args.target).trim().toLowerCase();
    else if (a === '--expires-minutes') args.expiresMinutes = Math.max(5, Math.min(120, Number(argv[++i] || args.expiresMinutes)));
    else if (a === '--width') args.width = Math.max(900, Number(argv[++i] || args.width));
    else if (a === '--height') args.height = Math.max(650, Number(argv[++i] || args.height));
    else if (a === '--base-path') args.basePath = String(argv[++i] || args.basePath);
    else if (a === '--show-token') args.showToken = true;
  }
  return args;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

function bjDate(offsetDays = 0) {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60_000;
  const bj = new Date(utc + 8 * 3600_000);
  bj.setDate(bj.getDate() + offsetDays);
  return `${bj.getFullYear()}-${pad2(bj.getMonth() + 1)}-${pad2(bj.getDate())}`;
}

function targetUrl(target) {
  if (target === 'order' || target === 'gsp') return ORDER_URL;
  if (target === 'home') return HOME_URL;
  return SBN_URL;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

async function readStoreConfig() {
  return await readJson(STORES_PATH, {stores: []});
}

function findStore(config, storeKey) {
  const key = String(storeKey || '').toUpperCase();
  const store = (config.stores || []).find(s => String(s.storeKey || '').toUpperCase() === key && s.enabled !== false);
  if (!store) throw new Error(`Unknown or disabled store: ${storeKey}`);
  return store;
}

function chromePath() {
  const p = CHROME_CANDIDATES.find(x => fssync.existsSync(x));
  if (!p) throw new Error('Chrome not found');
  return p;
}

function profileDir(store) {
  return path.join(ROOT, 'profiles', `persistent-${store.profileKey}-profile`);
}

async function isPortOpen(port) {
  return await new Promise(resolve => {
    const socket = net.createConnection({host: '127.0.0.1', port, timeout: 800}, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(false));
  });
}

async function isPidAlive(pid) {
  if (!Number(pid)) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function allocateRuntime(existingSessions = []) {
  const usedDisplays = new Set(existingSessions.map(s => Number(s.display)).filter(Boolean));
  const usedVnc = new Set(existingSessions.map(s => Number(s.vncPort)).filter(Boolean));
  const usedWs = new Set(existingSessions.map(s => Number(s.websockifyPort)).filter(Boolean));
  for (let i = 0; i < 40; i += 1) {
    const display = 120 + i;
    const vncPort = 5900 + i;
    const websockifyPort = 16080 + i;
    if (usedDisplays.has(display) || usedVnc.has(vncPort) || usedWs.has(websockifyPort)) continue;
    if (fssync.existsSync(`/tmp/.X${display}-lock`)) continue;
    if (await isPortOpen(vncPort)) continue;
    if (await isPortOpen(websockifyPort)) continue;
    return {display, vncPort, websockifyPort};
  }
  throw new Error('No free Xvfb/VNC/websockify slot');
}

function spawnDetached(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    detached: true,
    stdio: options.stdio || 'ignore',
    env: {...process.env, ...(options.env || {})},
  });
  child.unref();
  return child.pid;
}

async function waitForPort(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) return true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

async function waitForCdp(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(1000)});
      if (res.ok) return true;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 700));
  }
  return false;
}

async function loadStore() {
  return await readJson(DEFAULT_STATE_FILE, null);
}

function normalizeState(raw) {
  return {
    version: 1,
    updatedAt: raw?.updatedAt || null,
    sessions: Array.isArray(raw?.sessions) ? raw.sessions : [],
  };
}

function publicSession(session, options = {}) {
  const showToken = Boolean(options.showToken);
  return {
    id: session.id,
    storeKey: session.storeKey,
    shopName: session.shopName,
    target: session.target,
    status: session.status,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    completedAt: session.completedAt || null,
    closedAt: session.closedAt || null,
    display: session.display,
    width: session.width,
    height: session.height,
    websockifyPort: session.websockifyPort,
    alive: session.alive || null,
    openPath: session.openPath || '',
    openUrl: showToken ? session.openUrl : '',
    token: showToken ? session.token : undefined,
    finish: session.finish || null,
    error: session.error || '',
  };
}

async function refreshAlive(state) {
  const now = Date.now();
  let changed = false;
  for (const s of state.sessions) {
    const active = ['active', 'starting'].includes(String(s.status || ''));
    const expired = active && s.expiresAt && new Date(s.expiresAt).getTime() < now;
    const alive = {
      xvfb: await isPidAlive(s.pids?.xvfb),
      x11vnc: await isPidAlive(s.pids?.x11vnc),
      websockify: await isPidAlive(s.pids?.websockify),
      chrome: await isPidAlive(s.pids?.chrome),
      cdp: s.cdpPort ? await isPortOpen(s.cdpPort) : false,
      websocket: s.websockifyPort ? await isPortOpen(s.websockifyPort) : false,
    };
    s.alive = alive;
    if (expired) {
      s.status = 'expired';
      s.error = 'session expired';
      changed = true;
    }
    if (!['active', 'starting', 'expired'].includes(String(s.status || '')) && (s.token || s.openUrl || s.openPath)) {
      s.token = '';
      s.openUrl = '';
      s.openPath = '';
      changed = true;
    }
  }
  if (changed) state.updatedAt = new Date().toISOString();
  return state;
}

async function killPid(pid) {
  if (!Number(pid)) return {pid, ok: true, skipped: true};
  try {
    process.kill(-Number(pid), 'SIGTERM');
  } catch {
    try { process.kill(Number(pid), 'SIGTERM'); } catch {}
  }
  await new Promise(resolve => setTimeout(resolve, 800));
  if (await isPidAlive(pid)) {
    try {
      process.kill(-Number(pid), 'SIGKILL');
    } catch {
      try { process.kill(Number(pid), 'SIGKILL'); } catch {}
    }
  }
  return {pid, ok: !(await isPidAlive(pid))};
}

async function stopProcesses(session) {
  const pids = session.pids || {};
  const results = [];
  for (const key of ['chrome', 'websockify', 'x11vnc', 'xvfb']) {
    results.push({key, ...(await killPid(pids[key]))});
  }
  return results;
}

function listProcessLines() {
  if (process.platform === 'win32') return [];
  const ps = spawnSync('ps', ['-eo', 'pid=,args='], {encoding: 'utf8'});
  return String(ps.stdout || '')
    .split(/\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

function pidFromProcessLine(line) {
  const m = /^(\d+)\s+/.exec(String(line || ''));
  return m ? Number(m[1]) : 0;
}

function isAnySyncServiceActive() {
  if (process.platform === 'win32') return false;
  for (const service of BUSY_SYNC_SERVICES) {
    const r = spawnSync('systemctl', ['is-active', '--quiet', service], {stdio: 'ignore'});
    if (r.status === 0) return true;
  }
  return false;
}

function isManualRuntimeLine(line) {
  return (
    /\bXvfb\s+:1[2-5][0-9]\b/.test(line) ||
    /\bx11vnc\b.*\s-display\s+:1[2-5][0-9]\b/.test(line) ||
    /\bwebsockify\b.*127\.0\.0\.1:16(?:08[0-9]|09[0-9]|1[01][0-9])\b/.test(line)
  );
}

async function cleanupManualLoginRemnantsForStore(store, state) {
  if (isAnySyncServiceActive()) return {skipped: true, reason: 'sync-service-active', killed: []};
  const killed = [];
  for (const session of state.sessions || []) {
    const status = String(session.status || '');
    if (session.storeKey !== store.storeKey) continue;
    if (['active', 'starting'].includes(status)) continue;
    const stopResults = await stopProcesses(session);
    for (const r of stopResults) {
      if (r.pid && !r.skipped) killed.push({source: 'state', key: r.key, pid: r.pid, ok: r.ok});
    }
  }
  const prof = profileDir(store);
  const portNeedle = `--remote-debugging-port=${store.port}`;
  const pids = new Set();
  for (const line of listProcessLines()) {
    const pid = pidFromProcessLine(line);
    if (!pid || pid === process.pid) continue;
    if (line.includes(prof) && line.includes(portNeedle)) pids.add(pid);
    else if (isManualRuntimeLine(line)) pids.add(pid);
  }
  for (const pid of pids) {
    const result = await killPid(pid);
    killed.push({source: 'orphan-process', pid, ok: result.ok});
  }
  return {skipped: false, killed};
}

function run(command, args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, ...(options.env || {})},
    });
    let stdout = '';
    let stderr = '';
    let timer = null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => {
      clearTimeout(timer);
      resolve({ok: false, code: -1, stdout, stderr: `${stderr}\n${String(err?.stack || err)}`.trim(), timedOut: false});
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ok: code === 0, code, stdout, stderr, timedOut: false});
    });
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch {}
        resolve({ok: false, code: -1, stdout, stderr, timedOut: true});
      }, options.timeoutMs);
    }
  });
}

async function finishExport(session) {
  const exportRun = await run(process.execPath, [
    'scripts/export_shein_browser_session.mjs',
    '--store', session.storeKey,
    '--no-launch',
    '--wait-ms', '5000',
  ], {timeoutMs: 90_000});
  const probeRun = await run(process.execPath, [
    'scripts/bootstrap_shein_browser_session.mjs',
    '--store', session.storeKey,
    '--no-launch',
    '--date', bjDate(0),
  ], {timeoutMs: 90_000});
  return {
    export: {
      ok: exportRun.ok,
      code: exportRun.code,
      timedOut: exportRun.timedOut,
      stdoutPreview: String(exportRun.stdout || '').slice(-1600),
      stderrPreview: String(exportRun.stderr || '').slice(-1200),
    },
    probe: {
      ok: probeRun.ok,
      code: probeRun.code,
      timedOut: probeRun.timedOut,
      stdoutPreview: String(probeRun.stdout || '').slice(-1600),
      stderrPreview: String(probeRun.stderr || '').slice(-1200),
    },
  };
}

async function cmdStart(args) {
  if (!args.storeKey) throw new Error('Missing --store');
  const config = await readStoreConfig();
  const store = findStore(config, args.storeKey);
  const state = await refreshAlive(normalizeState(await readJson(args.stateFile, null)));
  const activeSame = state.sessions.find(s => s.storeKey === store.storeKey && ['active', 'starting'].includes(String(s.status || '')));
  if (activeSame) {
    return {ok: true, reused: true, session: publicSession(activeSame, {showToken: true}), sessions: state.sessions.map(s => publicSession(s))};
  }
  const activeAny = state.sessions.find(s => ['active', 'starting'].includes(String(s.status || '')));
  if (activeAny) {
    throw new Error(`Another manual login session is active: ${activeAny.storeKey}/${activeAny.id}. Close it first.`);
  }
  if (await isPortOpen(Number(store.port))) {
    const cleanup = await cleanupManualLoginRemnantsForStore(store, state);
    if (cleanup.killed?.length) {
      state.updatedAt = new Date().toISOString();
      await writeJson(args.stateFile, state);
    }
    if (await isPortOpen(Number(store.port))) {
      const suffix = cleanup.skipped ? ` Active sync service detected (${cleanup.reason});` : '';
      throw new Error(`${store.storeKey} CDP port ${store.port} is already open.${suffix} wait for sync task to finish or close that browser first.`);
    }
  }

  await fs.mkdir(args.logDir, {recursive: true});
  const runtime = await allocateRuntime(state.sessions);
  const id = `clogin_${stamp()}_${crypto.randomBytes(3).toString('hex')}`;
  const token = crypto.randomBytes(24).toString('base64url');
  const logFile = path.join(args.logDir, `${id}.log`);
  const logFd = fssync.openSync(logFile, 'a');
  const stdio = ['ignore', logFd, logFd];
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + args.expiresMinutes * 60_000);
  const url = targetUrl(args.target);

  const xvfbPid = spawnDetached('Xvfb', [
    `:${runtime.display}`,
    '-screen', '0', `${args.width}x${args.height}x24`,
    '-nolisten', 'tcp',
    '-ac',
  ], {stdio});
  await new Promise(resolve => setTimeout(resolve, 1000));

  const x11vncPid = spawnDetached('x11vnc', [
    '-display', `:${runtime.display}`,
    '-localhost',
    '-nopw',
    '-forever',
    '-shared',
    '-rfbport', String(runtime.vncPort),
    '-quiet',
  ], {stdio});
  if (!(await waitForPort(runtime.vncPort, 20_000))) {
    await killPid(x11vncPid);
    await killPid(xvfbPid);
    throw new Error(`x11vnc did not open port ${runtime.vncPort}`);
  }

  const websockifyPid = spawnDetached('websockify', [
    '--web', '/usr/share/novnc',
    '127.0.0.1:' + runtime.websockifyPort,
    '127.0.0.1:' + runtime.vncPort,
  ], {stdio});
  if (!(await waitForPort(runtime.websockifyPort, 20_000))) {
    await killPid(websockifyPid);
    await killPid(x11vncPid);
    await killPid(xvfbPid);
    throw new Error(`websockify did not open port ${runtime.websockifyPort}`);
  }

  const prof = profileDir(store);
  await fs.mkdir(prof, {recursive: true});
  const chromeArgs = [
    `--user-data-dir=${prof}`,
    `--disk-cache-dir=${path.join(prof, 'cache')}`,
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${store.port}`,
    '--profile-directory=Profile 1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-dev-shm-usage',
    '--window-size=' + args.width + ',' + args.height,
    url,
  ];
  const chromePid = spawnDetached(chromePath(), chromeArgs, {
    stdio,
    env: {DISPLAY: `:${runtime.display}`},
  });
  const cdpOk = await waitForCdp(Number(store.port), 35_000);
  if (!cdpOk) {
    await killPid(chromePid);
    await killPid(websockifyPid);
    await killPid(x11vncPid);
    await killPid(xvfbPid);
    throw new Error(`Chrome CDP port ${store.port} did not open`);
  }

  const openPath = `${args.basePath}/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`;
  const session = {
    id,
    token,
    storeKey: store.storeKey,
    shopName: store.shopName || '',
    target: args.target,
    status: 'active',
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    display: runtime.display,
    vncPort: runtime.vncPort,
    websockifyPort: runtime.websockifyPort,
    cdpPort: Number(store.port),
    width: args.width,
    height: args.height,
    openPath,
    openUrl: openPath,
    logFile,
    pids: {xvfb: xvfbPid, x11vnc: x11vncPid, websockify: websockifyPid, chrome: chromePid},
  };
  state.sessions = [session, ...state.sessions].slice(0, 80);
  state.updatedAt = new Date().toISOString();
  await writeJson(args.stateFile, state);
  return {ok: true, session: publicSession(session, {showToken: true}), sessions: state.sessions.map(s => publicSession(s))};
}

async function findSessionOrThrow(args, state) {
  const id = String(args.id || '').trim();
  if (!id) throw new Error('Missing --id');
  const idx = state.sessions.findIndex(s => String(s.id || '') === id);
  if (idx < 0) throw new Error(`Session not found: ${id}`);
  return {idx, session: state.sessions[idx]};
}

async function cmdList(args) {
  const state = await refreshAlive(normalizeState(await readJson(args.stateFile, null)));
  await writeJson(args.stateFile, state);
  return {
    ok: true,
    sessions: state.sessions.map(s => {
      const status = String(s.status || '');
      const alive = s.alive && Object.values(s.alive).some(Boolean);
      const controllable = ['active', 'starting', 'expired'].includes(status) || alive;
      return publicSession(s, {showToken: Boolean((args.showToken && controllable) || (args.token && args.token === s.token))});
    }),
  };
}

async function cmdStop(args, finish = false) {
  const state = await refreshAlive(normalizeState(await readJson(args.stateFile, null)));
  const {idx, session} = await findSessionOrThrow(args, state);
  if (!args.token) throw new Error('Missing --token');
  if (args.token !== session.token) throw new Error('Invalid token');
  let finishResult = null;
  if (finish && ['active', 'starting', 'expired'].includes(String(session.status || ''))) {
    finishResult = await finishExport(session);
    session.finish = finishResult;
  }
  session.status = finish ? (finishResult?.export?.ok ? 'completed' : 'completed_with_warning') : 'closed';
  if (finish) session.completedAt = new Date().toISOString();
  else session.closedAt = new Date().toISOString();
  session.stopResults = await stopProcesses(session);
  session.token = '';
  session.openUrl = '';
  session.openPath = '';
  state.sessions[idx] = session;
  state.updatedAt = new Date().toISOString();
  await writeJson(args.stateFile, state);
  return {ok: true, session: publicSession(session, {showToken: true})};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let result;
  if (args.command === 'start') result = await cmdStart(args);
  else if (args.command === 'list' || args.command === 'status') result = await cmdList(args);
  else if (args.command === 'finish') result = await cmdStop(args, true);
  else if (args.command === 'close' || args.command === 'stop') result = await cmdStop(args, false);
  else throw new Error(`Unknown command: ${args.command}`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});
