import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {acquireCrossProcessTicketLock} from './cross_process_ticket_lock.mjs';
import {readBrowserLeases} from './browser_task_lease.mjs';

export async function probeChromeDebugPort(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${Number(port)}/json/version`, {signal: AbortSignal.timeout(1500)});
    const value = await response.json();
    return response.ok && typeof value.webSocketDebuggerUrl === 'string';
  } catch { return false; }
}

export async function openExistingChromePage(port, url) {
  const response = await fetch(`http://127.0.0.1:${Number(port)}/json/new?${encodeURIComponent(url)}`, {method: 'PUT', signal: AbortSignal.timeout(10_000)});
  if (!response.ok) throw new Error(`Existing Chrome rejected a new page: HTTP ${response.status}`);
  const page = await response.json();
  if (!page.id) throw new Error('Existing Chrome did not return a page identity');
  return page.id;
}

export async function waitForChromeDebugPort(port, timeoutMs = 20_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await probeChromeDebugPort(port)) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Chrome did not expose its expected debug port before the deadline');
}

function flag(command, name) {
  if (Array.isArray(command)) {
    const argument = command.find(value => value.startsWith(`--${name}=`));
    return argument?.slice(name.length + 3) || '';
  }
  const pattern = new RegExp(`(?:^|\\s)(?:"--${name}=([^\"]+)"|--${name}="([^\"]+)"|--${name}=([^\\s]+))`);
  const matched = String(command || '').match(pattern);
  return matched ? matched[1] || matched[2] || matched[3] || '' : '';
}

async function listChromeProcesses() {
  if (process.platform === 'win32') {
    const command = "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='chromium.exe'\" | Select-Object ProcessId,CommandLine) | ConvertTo-Json -Compress";
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {encoding: 'utf8', windowsHide: true, timeout: 10_000});
    if (result.error || result.status !== 0) throw new Error('Chrome process ownership inspection failed');
    const parsed = JSON.parse(result.stdout.trim() || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean).map(row => ({pid: row.ProcessId, command: row.CommandLine}));
  }
  if (process.platform !== 'linux') throw new Error('Chrome profile ownership inspection is unsupported on this platform');
  const processes = [];
  for (const entry of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const command = (await fs.readFile(`/proc/${entry}/cmdline`, 'utf8')).split('\0').filter(Boolean);
      if (/chrome|chromium/i.test(path.basename(command[0] || ''))) processes.push({pid: Number(entry), command});
    } catch (error) {
      if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) throw error;
    }
  }
  return processes;
}

export function assertChromeProfileLeaseOwner({root, storeKey, env = process.env}) {
  if (!storeKey) return;
  const conflicting = readBrowserLeases({root}).find(item => item.valid
    && String(item.lease.storeKey).toUpperCase() === String(storeKey).toUpperCase()
    && !(item.lease.task === env.SHEIN_BI_BROWSER_LEASE_TASK && item.lease.runId === env.SHEIN_BI_BROWSER_LEASE_RUN_ID));
  if (conflicting) throw Object.assign(new Error(`Chrome Profile is owned by another active task: ${storeKey}`), {code: 'PROFILE_LEASE_ACTIVE'});
}

/** Serialize process admission and metadata writes for the physical Profile.
 * A running Chrome owns Local State; a second caller only opens a CDP tab.
 */
export async function withChromeProfileStartup({root, profileDir, storeKey = '', port,
  probe, prepare, launch, waitReady, reuse, env = process.env, processes = listChromeProcesses}) {
  await fs.mkdir(profileDir, {recursive: true});
  const actualProfile = await fs.realpath(profileDir);
  const stat = await fs.stat(actualProfile, {bigint: true});
  const identity = stat.ino ? `${stat.dev}:${stat.ino}` : actualProfile.toLowerCase();
  const runtimeRoot = env.SHEIN_BI_RUNTIME_ROOT || (process.platform === 'linux' ? '/srv/shein-bi/runtime' : path.join(os.homedir(), '.shein-bi', 'runtime'));
  const digest = crypto.createHash('sha256').update(identity).digest('hex');
  const lock = await acquireCrossProcessTicketLock(path.join(runtimeRoot, 'locks', 'chrome-profile-startup', `${digest}.lock`), {timeoutMs: 30_000});
  try {
    assertChromeProfileLeaseOwner({root, storeKey, env});
    const observed = await processes();
    const matching = [];
    for (const process of observed) {
      const directory = flag(process.command, 'user-data-dir');
      if (!directory) continue;
      let actual, processProfileStat;
      try { actual = await fs.realpath(directory); processProfileStat = await fs.stat(actual, {bigint: true}); } catch { continue; }
      const sameInode = stat.ino !== 0n && processProfileStat.dev === stat.dev && processProfileStat.ino === stat.ino;
      if (sameInode || actual === actualProfile || (globalThis.process.platform === 'win32' && actual.toLowerCase() === actualProfile.toLowerCase())) matching.push(process);
    }
    const running = await probe();
    if (running || matching.length) {
      if (!matching.some(process => Number(flag(process.command, 'remote-debugging-port')) === Number(port))) {
        throw new Error('Chrome Profile/debug-port ownership mismatch; existing browser retained');
      }
      if (!running) await waitReady();
      await reuse();
      return {launched: false, reused: true};
    }
    await prepare();
    await launch();
    await waitReady();
    return {launched: true, reused: false};
  } finally {
    await lock();
  }
}
