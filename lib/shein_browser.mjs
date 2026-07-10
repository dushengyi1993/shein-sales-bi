/**
 * Shared SHEIN browser interaction layer.
 *
 * P1-#3 refactor: extracts commonly copy-pasted browser utility functions
 * from 10+ marketing scripts into a single shared module.
 *
 * Usage:
 *   import {httpJson, sleep, isCdpOpen, connectStorePage, ensureBrowser} from '../../lib/shein_browser.mjs';
 */
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function httpJson(url) {
  const res = await fetch(url, {signal: AbortSignal.timeout(8000)});
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return await res.json();
}

export async function isCdpOpen(port) {
  try {
    await httpJson(`http://127.0.0.1:${port}/json/version`);
    return true;
  } catch {
    return false;
  }
}

export async function connectStorePage(store) {
  const targets = await httpJson(`http://127.0.0.1:${store.port}/json/list`);
  const page = targets.find(t => t.type === 'page' && String(t.url || '').includes('sso.geiwohuo.com'))
    || targets.find(t => t.type === 'page');
  if (!page) throw new Error(`port ${store.port} no page target`);
  return {page, wsUrl: page.webSocketDebuggerUrl};
}

export async function connectCdp(port, {
  pageUrlPattern = /geiwohuo|shein/i,
  targetTimeoutMs = 2500,
  openTimeoutMs = 10_000,
  commandTimeoutMs = 30_000,
} = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {signal: AbortSignal.timeout(targetTimeoutMs)});
  if (!response.ok) throw new Error(`CDP target list failed on port ${port}: HTTP ${response.status}`);
  const targets = await response.json();
  const page = targets.find(target => target.type === 'page' && pageUrlPattern.test(String(target.url || '')))
    || targets.find(target => target.type === 'page');
  if (!page?.webSocketDebuggerUrl) throw new Error(`No Chrome page target on port ${port}`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let sequence = 0;
  let closed = false;
  const pending = new Map();

  const rejectPending = error => {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  ws.addEventListener('message', event => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (!message.id || !pending.has(message.id)) return;
    const entry = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });
  ws.addEventListener('close', () => rejectPending(new Error(`CDP websocket closed on port ${port}`)));
  ws.addEventListener('error', () => rejectPending(new Error(`CDP websocket error on port ${port}`)));

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP websocket open timed out on port ${port}`)), openTimeoutMs);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, {once: true});
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`CDP websocket failed to open on port ${port}`)); }, {once: true});
  });

  const send = (method, params = {}, {timeoutMs = commandTimeoutMs} = {}) => {
    if (closed || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`CDP websocket is not open on port ${port}`));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP command timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      pending.set(id, {resolve, reject, timer, method});
      try {
        ws.send(JSON.stringify({id, method, params}));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  };

  const close = () => {
    rejectPending(new Error(`CDP connection closed by client on port ${port}`));
    try { ws.close(); } catch {}
  };

  await send('Runtime.enable');
  await send('Page.enable');
  return {ws, send, page, close};
}

/**
 * Ensure a store browser is running. Launches if not open and noLaunch is false.
 * Returns true if browser was launched by this call.
 */
export async function ensureBrowser(store, {noLaunch = false, headless = false, visible = false, launchFn} = {}) {
  if (await isCdpOpen(store.port)) return {launched: false};
  if (noLaunch) throw new Error(`browser not open for ${store.storeKey} on port ${store.port} and --no-launch was passed`);
  if (typeof launchFn === 'function') {
    await launchFn(store, {headless, visible});
  } else {
    // Fallback: use spawnSync to call launch_store_browser.mjs
    const mode = headless ? '--headless' : (visible ? '--visible' : '--background');
    const r = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'launch_store_browser.mjs'),
      store.storeKey,
      mode,
      '--url',
      'https://sso.geiwohuo.com/#/mbrs/marketing/list',
    ], {cwd: ROOT, encoding: 'utf8', timeout: 25_000});
    if (r.status !== 0) throw new Error(`launch browser failed for ${store.storeKey}: ${r.stderr || r.stdout}`);
  }
  // Wait for debug port
  const deadline = Date.now() + 20_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      await httpJson(`http://127.0.0.1:${store.port}/json/version`);
      return {launched: true};
    } catch (err) {
      lastError = err;
      await sleep(500);
    }
  }
  throw new Error(`Chrome debug port not ready for ${store.storeKey} on ${store.port}: ${lastError?.message || 'timeout'}`);
}

/**
 * Close existing store Chrome processes by profile key.
 * Works on Windows only; on Linux/cloud, use cleanup_shein_store_browsers.mjs instead.
 */
export function closeExistingStoreChrome(store) {
  if (process.platform !== 'win32') return;
  const profileNeedle = `persistent-${store.profileKey}-profile`;
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$needle = '${String(profileNeedle).replaceAll("'", "''")}'`,
    "$procs = Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | Where-Object { $_.CommandLine -like \"*$needle*\" }",
    "foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }",
  ].join('\n');
  spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ], {stdio: 'ignore', timeout: 20_000});
}

/**
 * PowerShell single-quote helper for Windows process management.
 */
export function psSingleQuote(value) {
  return `'${String(value ?? '').replaceAll("'", "''")}'`;
}

/**
 * Bring a store's Chrome window to front on Windows.
 */
export function bringStoreWindowToFront(store) {
  if (process.platform !== 'win32') return;
  const profileNeedle = `persistent-${store.profileKey}-profile`;
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    'Add-Type @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class Win32BringToFront {',
    '  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
    '}',
    '"@',
    `\$needle = ${psSingleQuote(profileNeedle)}`,
    '$rootIds = @(Get-CimInstance Win32_Process -Filter "name=\'chrome.exe\'" | Where-Object { $_.CommandLine -like "*$needle*" } | Select-Object -ExpandProperty ProcessId)',
    '$wins = @(Get-Process chrome | Where-Object { $_.MainWindowHandle -ne 0 -and ($rootIds -contains $_.Id) })',
    'if (-not $wins -or $wins.Count -eq 0) { $wins = @(Get-Process chrome | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like \'*SHEIN*\' }) }',
    '$p = $wins | Select-Object -First 1',
    'if ($p) { [Win32BringToFront]::ShowWindowAsync($p.MainWindowHandle, 3) | Out-Null; Start-Sleep -Milliseconds 200; [Win32BringToFront]::SetForegroundWindow($p.MainWindowHandle) | Out-Null }',
  ].join('\n');
  spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ], {stdio: 'ignore', timeout: 20_000});
}
