import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {acquireCrossProcessTicketLock} from './cross_process_ticket_lock.mjs';
import {readBrowserLeases} from './browser_task_lease.mjs';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Windows PowerShell otherwise emits the active OEM code page into redirected
// stdout. Both process consumers must use this UTF-8 transport, including JSON.
export function runPowerShellUtf8(script, {env = process.env} = {}) {
  const source = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $OutputEncoding = [Console]::OutputEncoding;\n" + script;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
    {encoding: 'utf8', windowsHide: true, timeout: 10_000, env});
  if (result.error || result.status !== 0) throw new Error('PowerShell process inspection failed');
  if (result.stdout.includes('\uFFFD')) throw new Error('PowerShell process inspection returned invalid UTF-8');
  return result.stdout;
}

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

export function chromeProcessFlag(command, name) {
  if (Array.isArray(command)) {
    const argument = command.find(value => value.startsWith(`--${name}=`));
    return argument?.slice(name.length + 3) || '';
  }
  const pattern = new RegExp(`(?:^|\\s)(?:"--${name}=([^\"]+)"|--${name}="([^\"]+)"|--${name}=([^\\s]+))`);
  const matched = String(command || '').match(pattern);
  return matched ? matched[1] || matched[2] || matched[3] || '' : '';
}

export async function listChromeProcesses() {
  if (process.platform === 'win32') {
    const command = "@(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='chromium.exe'\" | Select-Object ProcessId,CommandLine,@{Name='StartedAt';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress";
    const parsed = JSON.parse(runPowerShellUtf8(command).trim() || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean).map(row => ({pid: row.ProcessId, command: row.CommandLine, startedAt: row.StartedAt}));
  }
  if (process.platform !== 'linux') throw new Error('Chrome profile ownership inspection is unsupported on this platform');
  const processes = [];
  for (const entry of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const command = (await fs.readFile(`/proc/${entry}/cmdline`, 'utf8')).split('\0').filter(Boolean);
      if (/chrome|chromium/i.test(path.basename(command[0] || ''))) {
        const stat = await fs.readFile(`/proc/${entry}/stat`, 'utf8');
        const startedAt = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19];
        processes.push({pid: Number(entry), command, startedAt});
      }
    } catch (error) {
      if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) throw error;
    }
  }
  return processes;
}

export async function chromeProfileIdentity(profileDir) {
  const actual = await fs.realpath(profileDir);
  const stat = await fs.stat(actual, {bigint: true});
  const identity = stat.ino ? `${stat.dev}:${stat.ino}` : (process.platform === 'win32' ? actual.toLowerCase() : actual);
  return crypto.createHash('sha256').update(identity).digest('hex');
}

export async function chromeProcessOwnsProfile(row, profileDir) {
  const directory = chromeProcessFlag(row.command, 'user-data-dir');
  if (!directory) return false;
  // An unreadable declared profile is not evidence of absence.
  return await chromeProfileIdentity(directory) === await chromeProfileIdentity(profileDir);
}

export const MANAGED_SESSION_FIELDS = Object.freeze(['version', 'storeKey', 'port', 'browserPid', 'profileIdentity', 'processStart']);

export function validateManagedSession(session, storeKey) {
  if (session?.version !== 1 || session.storeKey !== storeKey
    || !Number.isInteger(session.port) || session.port < 1024 || session.port > 65535
    || !Number.isInteger(session.browserPid) || session.browserPid <= 0
    || !/^[a-f0-9]{64}$/.test(session.profileIdentity || '')
    || typeof session.processStart !== 'string' || !session.processStart) throw new Error('Invalid managed session evidence');
  return session;
}

// Caller holds the physical profile lock. No network or process mutation.
export async function readManagedChromeIdentity({store, profileDir, observed, expected = null}) {
  if (expected) validateManagedSession(expected, store.storeKey);
  const owners = [];
  for (const row of observed) {
    // Child processes can inherit the profile/port flags but are not browser
    // owners. Keep them in the process inventory for startup/cleanup guards.
    if (chromeProcessFlag(row.command, 'type')) continue;
    if (Number(chromeProcessFlag(row.command, 'remote-debugging-port')) !== Number(store.port)) continue;
    if (!await chromeProcessOwnsProfile(row, profileDir)) throw new Error('Chrome Profile/debug-port ownership mismatch; existing browser retained');
    owners.push(row);
  }
  if (owners.length !== 1) throw new Error('Managed session browser PID is ambiguous or unavailable');
  const evidence = {version: 1, storeKey: store.storeKey, port: Number(store.port), browserPid: owners[0].pid,
    profileIdentity: await chromeProfileIdentity(profileDir), processStart: owners[0].startedAt};
  validateManagedSession(evidence, store.storeKey);
  if (expected && MANAGED_SESSION_FIELDS.some(key => expected[key] !== evidence[key])) {
    throw new Error('Managed session changed since initial launcher; existing browser retained');
  }
  return evidence;
}

export async function withChromeProfileLock({root, profileDir, storeKey, env = process.env}, action) {
  const digest = await chromeProfileIdentity(profileDir);
  const runtimeRoot = env.SHEIN_BI_RUNTIME_ROOT || (process.platform === 'linux' ? '/srv/shein-bi/runtime' : path.join(os.homedir(), '.shein-bi', 'runtime'));
  const lock = await acquireCrossProcessTicketLock(path.join(runtimeRoot, 'locks', 'chrome-profile-startup', `${digest}.lock`), {timeoutMs: 30_000});
  try {
    assertChromeProfileLeaseOwner({root, storeKey, env});
    return await action();
  } finally { await lock(); }
}

export async function inspectManagedStoreSession(store, expected = null, {
  root = ROOT, env = process.env, processes = listChromeProcesses,
  probe = () => probeChromeDebugPort(store.port),
} = {}) {
  if (expected) validateManagedSession(expected, store.storeKey);
  let observed = [], evidence;
  const profileDir = path.join(root, 'profiles', `persistent-${store.profileKey}-profile`);
  const refuseLaunch = () => { throw new Error('Managed session unavailable; relaunch forbidden'); };
  await withChromeProfileStartup({root, profileDir, storeKey: store.storeKey, port: store.port, env,
    processes: async () => (observed = await processes()), probe,
    prepare: refuseLaunch, launch: refuseLaunch, waitReady: refuseLaunch,
    reuse: async () => { evidence = await readManagedChromeIdentity({store, profileDir, observed, expected}); },
  });
  return evidence;
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
  probe, prepare, launch, waitReady, reuse, env = process.env, processes = listChromeProcesses,
  captureManagedSession = false}) {
  await fs.mkdir(profileDir, {recursive: true});
  const actualProfile = await fs.realpath(profileDir);
  const stat = await fs.stat(actualProfile, {bigint: true});
  return await withChromeProfileLock({root, profileDir, storeKey, env}, async () => {
    // Opt-in receipt is captured before this SAME startup lock is released.
    // Never let a post-lock observer claim a replacement browser as its own.
    const resultWithIdentity = async result => captureManagedSession ? {
      ...result,
      managedSession: await readManagedChromeIdentity({
        store: {storeKey, port}, profileDir, observed: await processes(),
      }),
    } : result;
    const observed = await processes();
    const matching = [];
    for (const process of observed) {
      const directory = chromeProcessFlag(process.command, 'user-data-dir');
      if (!directory) continue;
      let actual, processProfileStat;
      try { actual = await fs.realpath(directory); processProfileStat = await fs.stat(actual, {bigint: true}); } catch { continue; }
      const sameInode = stat.ino !== 0n && processProfileStat.dev === stat.dev && processProfileStat.ino === stat.ino;
      if (sameInode || actual === actualProfile || (globalThis.process.platform === 'win32' && actual.toLowerCase() === actualProfile.toLowerCase())) matching.push(process);
    }
    const running = await probe();
    if (running || matching.length) {
      if (!matching.some(process => Number(chromeProcessFlag(process.command, 'remote-debugging-port')) === Number(port))) {
        throw new Error('Chrome Profile/debug-port ownership mismatch; existing browser retained');
      }
      if (!running) await waitReady();
      await reuse();
      return await resultWithIdentity({launched: false, reused: true});
    }
    await prepare();
    await launch();
    await waitReady();
    return await resultWithIdentity({launched: true, reused: false});
  });
}
