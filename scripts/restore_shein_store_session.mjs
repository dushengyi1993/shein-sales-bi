#!/usr/bin/env node
/**
 * Restore one SHEIN store session without relying on cloud-side saved passwords.
 *
 * Order of operations:
 * 1. First probe the current persistent Chrome profile. If it is still logged in,
 *    export it immediately and do not overwrite it with an older session file.
 * 2. Only when the current profile is not logged in, bootstrap Chrome from the
 *    exported browser/WebAPI session files.
 * 3. Run the normal auto relogin probe, which verifies both GSP order WebAPI and
 *    SBN product-analysis login state. If bootstrap was enough, this exits via
 *    the fast "alreadyOk" path; otherwise it can still use Chrome autofill as a
 *    fallback where available.
 *
 * Console output is secret-safe: child scripts only print counts/status and never
 * cookie/header/password values.
 */
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    store: '',
    date: '',
    headless: true,
    timeoutMs: 180_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--store') args.store = String(argv[++i] || '').trim().toUpperCase();
    else if (a === '--date') args.date = String(argv[++i] || '').trim();
    else if (a === '--timeout-ms') args.timeoutMs = Math.max(30_000, Number(argv[++i] || args.timeoutMs));
    else if (a === '--headless') args.headless = true;
    else if (a === '--visible') args.headless = false;
    else if (!a.startsWith('--') && !args.store) args.store = String(a || '').trim().toUpperCase();
  }
  if (!args.store) throw new Error('Missing --store, e.g. --store DL');
  return args;
}

function runNode(script, args, timeoutMs) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => finish({ok: false, code: -1, stdout, stderr: `${stderr}\n${String(err?.stack || err)}`.trim(), timedOut: false}));
    child.on('close', code => finish({ok: code === 0, code, stdout, stderr, timedOut: false}));
    timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      finish({ok: false, code: -1, stdout, stderr, timedOut: true});
    }, timeoutMs);
  });
}

function parseLastJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const start = text.lastIndexOf('\n{');
  if (start >= 0) {
    try {
      return JSON.parse(text.slice(start + 1));
    } catch {}
  }
  return null;
}

function preview(text, max = 1200) {
  return String(text || '').slice(0, max);
}

const args = parseArgs(process.argv.slice(2));
const common = [
  '--store',
  args.store,
  ...(args.date ? ['--date', args.date] : []),
  args.headless ? '--headless' : '--visible',
  '--timeout-ms',
  String(args.timeoutMs),
];

async function runAutoRelogin({checkOnly = false, timeoutMs = args.timeoutMs} = {}) {
  const runArgs = [
    args.store,
    ...(args.date ? ['--date', args.date] : []),
    args.headless ? '--headless' : '--visible',
    '--timeout-ms',
    String(timeoutMs),
    ...(checkOnly ? ['--check-only'] : []),
  ];
  const result = await runNode('auto_relogin_shein_store.mjs', runArgs, timeoutMs + 30_000);
  return {result, parsed: parseLastJson(result.stdout)};
}

async function exportCurrentSession() {
  const exported = await runNode('export_shein_browser_session.mjs', [
    '--store',
    args.store,
    '--no-launch',
    args.headless ? '--headless' : '--visible',
    '--wait-ms',
    '1000',
  ], 45_000);
  const exportJson = parseLastJson(exported.stdout);
  return {
    ok: Boolean(exported.ok && exportJson?.ok),
    code: exported.code,
    timedOut: exported.timedOut,
    parsedOk: Boolean(exportJson?.ok),
    stores: Array.isArray(exportJson?.stores) ? exportJson.stores.map(r => ({
      storeKey: r.storeKey,
      ok: r.ok,
      cookieCount: r.cookieCount || 0,
      localStorageCount: r.localStorageCount || 0,
      sessionStorageCount: r.sessionStorageCount || 0,
      file: r.file || '',
    })) : [],
    stderrPreview: preview(exported.stderr),
  };
}

const current = await runAutoRelogin({checkOnly: true, timeoutMs: Math.min(args.timeoutMs, 75_000)});
console.log(`[restore_shein_store_session] ${args.store} current_profile_probe ${current.result.ok ? 'ok' : 'failed'}${current.result.timedOut ? ' timed_out' : ''}`);

let bootstrap = null;
let bootstrapJson = null;
let relogin = current.result;
let reloginJson = current.parsed;
let restoreMode = 'current_profile';
let exportSession = null;
if (!(current.result.ok && current.parsed?.ok)) {
  bootstrap = await runNode('bootstrap_shein_browser_session.mjs', common, args.timeoutMs + 30_000);
  bootstrapJson = parseLastJson(bootstrap.stdout);
  console.log(`[restore_shein_store_session] ${args.store} bootstrap ${bootstrap.ok ? 'ok' : 'failed'}${bootstrap.timedOut ? ' timed_out' : ''}`);

  const fullRelogin = await runAutoRelogin({checkOnly: false, timeoutMs: args.timeoutMs});
  relogin = fullRelogin.result;
  reloginJson = fullRelogin.parsed;
  restoreMode = 'bootstrap_then_relogin';
  console.log(`[restore_shein_store_session] ${args.store} relogin_probe ${relogin.ok ? 'ok' : 'failed'}${relogin.timedOut ? ' timed_out' : ''}`);
}

const reloginOk = Boolean(relogin.ok && reloginJson?.ok);
if (reloginOk) {
  exportSession = await exportCurrentSession();
  console.log(`[restore_shein_store_session] ${args.store} export_session ${exportSession.ok ? 'ok' : 'failed'}${exportSession.timedOut ? ' timed_out' : ''}`);
}

const ok = Boolean(reloginOk && (!exportSession || exportSession.ok));
const summary = {
  ok,
  date: args.date || reloginJson?.date || bootstrapJson?.date || null,
  stores: [args.store],
  failedStores: ok ? [] : [args.store],
  restoreMode,
  currentProfile: {
    ok: current.result.ok,
    timedOut: current.result.timedOut,
    code: current.result.code,
    parsedOk: Boolean(current.parsed?.ok),
    reportFile: current.parsed?.reportFile || '',
    stderrPreview: preview(current.result.stderr),
  },
  bootstrap: bootstrap ? {
    ok: bootstrap.ok,
    timedOut: bootstrap.timedOut,
    code: bootstrap.code,
    parsedOk: Boolean(bootstrapJson?.ok),
    stderrPreview: preview(bootstrap.stderr),
  } : null,
  relogin: {
    ok: relogin.ok,
    timedOut: relogin.timedOut,
    code: relogin.code,
    parsedOk: Boolean(reloginJson?.ok),
    reportFile: reloginJson?.reportFile || '',
    stderrPreview: preview(relogin.stderr),
  },
  exportSession,
  reportFile: reloginJson?.reportFile || '',
};

console.log(JSON.stringify(summary, null, 2));
process.exit(ok ? 0 : 1);
