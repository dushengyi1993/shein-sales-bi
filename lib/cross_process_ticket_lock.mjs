import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function processAppearsAlive(pid) {
  const value = Number(pid || 0);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function processStartIdentity(pid) {
  if (process.platform !== 'linux') return '';
  try {
    const raw = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    const close = raw.lastIndexOf(')');
    if (close < 0) return '';
    const fields = raw.slice(close + 1).trim().split(/\s+/u);
    const startTicks = fields[19] || '';
    return /^\d+$/.test(startTicks) ? startTicks : '';
  } catch {
    return '';
  }
}

async function ticketOwnerAppearsAlive(holder) {
  const pid = Number(holder?.pid || 0);
  if (!processAppearsAlive(pid)) return false;
  const expectedStart = String(holder?.processStart || '');
  if (!expectedStart) return true;
  const observedStart = await processStartIdentity(pid);
  return !observedStart || observedStart === expectedStart;
}

async function readJson(file) {
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); } catch { return null; }
}

function sameFileIdentity(left, right) {
  if (!left || !right) return false;
  if (Number(left.ino || 0) > 0 || Number(right.ino || 0) > 0) {
    return Number(left.dev || 0) === Number(right.dev || 0) && Number(left.ino || 0) === Number(right.ino || 0);
  }
  return Number(left.birthtimeMs || 0) === Number(right.birthtimeMs || 0)
    && Number(left.size || 0) === Number(right.size || 0);
}

async function removeDeadStaleTicket(ticketFile, staleMs) {
  const firstStat = await fs.stat(ticketFile).catch(() => null);
  if (!firstStat) return false;
  const firstHolder = await readJson(ticketFile);
  const firstPid = Number(firstHolder?.pid || 0);
  const hasTrustedOwner = Number.isInteger(firstPid) && firstPid > 0 && Boolean(firstHolder?.nonce);
  const firstIsStale = Date.now() - firstStat.mtimeMs > staleMs;
  // A ticket held by a trusted owner whose process is still alive must never
  // be reclaimed merely because its mtime looks stale. A stalled heartbeat,
  // clock skew, or coarse filesystem timestamps must not fracture the mutual
  // exclusion that the ticket queue provides.
  const trustedOwnerIsAlive = hasTrustedOwner && await ticketOwnerAppearsAlive(firstHolder);
  if (trustedOwnerIsAlive) return false;
  // Stale age may only reclaim tickets without a trusted live owner: legacy
  // or malformed tickets (no trusted holder) require a stale mtime, while a
  // trusted owner that is verifiably dead (or whose PID was recycled) is
  // reclaimed regardless of age.
  if (!hasTrustedOwner && !firstIsStale) return false;

  const [currentStat, currentHolder] = await Promise.all([
    fs.stat(ticketFile).catch(() => null),
    readJson(ticketFile),
  ]);
  if (!currentStat || !sameFileIdentity(firstStat, currentStat)) return false;
  const currentPid = Number(currentHolder?.pid || 0);
  const currentHasTrustedOwner = Number.isInteger(currentPid) && currentPid > 0 && Boolean(currentHolder?.nonce);
  if (currentHasTrustedOwner !== hasTrustedOwner
    || currentHolder?.nonce !== firstHolder?.nonce
    || currentPid !== firstPid
    || String(currentHolder?.processStart || '') !== String(firstHolder?.processStart || '')) return false;
  const currentIsStale = Date.now() - currentStat.mtimeMs > staleMs;
  const currentTrustedOwnerIsAlive = currentHasTrustedOwner && await ticketOwnerAppearsAlive(currentHolder);
  if (currentTrustedOwnerIsAlive) return false;
  if (!currentHasTrustedOwner && !currentIsStale) return false;
  await fs.rm(ticketFile, {force: true});
  return true;
}

function timeoutError(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

function ticketOrder(holder) {
  const value = String(holder?.orderNs || '');
  return /^\d+$/.test(value) ? BigInt(value) : null;
}

function compareTickets(left, right) {
  if (left.order === null && right.order !== null) return -1;
  if (left.order !== null && right.order === null) return 1;
  if (left.order !== null && right.order !== null && left.order !== right.order) return left.order < right.order ? -1 : 1;
  return left.name.localeCompare(right.name);
}

export async function acquireCrossProcessTicketLock(lockPath, {
  timeoutMs = 30_000,
  staleMs = 10 * 60_000,
  heartbeatMs = Math.max(25, Math.min(30_000, Math.floor(staleMs / 3))),
  pollMs = Math.max(25, Math.min(250, Math.floor(staleMs / 4))),
  timeoutMessage = `cross-process lock timeout: ${lockPath}`,
  timeoutCode = '',
} = {}) {
  const resolved = path.resolve(String(lockPath || ''));
  if (!lockPath || resolved === path.parse(resolved).root) throw new TypeError('cross-process lock path is required');
  const queueDir = `${resolved}.tickets`;
  await fs.mkdir(queueDir, {recursive: true});

  const nonce = crypto.randomBytes(16).toString('hex');
  const ticketName = `${nonce}.json`;
  const ticketFile = path.join(queueDir, ticketName);
  let handle;
  let heartbeat;
  let released = false;

  const release = async () => {
    if (released) return;
    released = true;
    if (heartbeat) clearInterval(heartbeat);
    try { await handle?.close(); } catch {}
    const current = await readJson(ticketFile);
    if (current?.nonce === nonce) await fs.rm(ticketFile, {force: true}).catch(() => {});
  };

  try {
    handle = await fs.open(ticketFile, 'wx', 0o600);
    const orderNs = process.hrtime.bigint().toString();
    const processStart = await processStartIdentity(process.pid);
    await handle.writeFile(JSON.stringify({pid: process.pid, nonce, processStart, orderNs, at: new Date().toISOString()}));
    await handle.sync();
    heartbeat = setInterval(() => {
      const now = new Date();
      handle.utimes(now, now).catch(() => {});
    }, Math.max(25, heartbeatMs));
    heartbeat.unref?.();

    const deadline = Date.now() + Math.max(1, timeoutMs);
    while (true) {
      const names = (await fs.readdir(queueDir).catch(() => []))
        .filter(name => name.endsWith('.json'))
        .sort();
      const active = [];
      for (const name of names) {
        const file = path.join(queueDir, name);
        if (await removeDeadStaleTicket(file, staleMs)) continue;
        if (await fs.stat(file).catch(() => null)) {
          const holder = await readJson(file);
          active.push({name, order: ticketOrder(holder)});
        }
      }
      active.sort(compareTickets);
      if (!active.some(ticket => ticket.name === ticketName)) throw new Error(`cross-process lock ticket disappeared: ${ticketFile}`);
      if (active[0]?.name === ticketName) return release;
      if (Date.now() >= deadline) {
        await release();
        throw timeoutError(timeoutMessage, timeoutCode);
      }
      await new Promise(resolve => setTimeout(resolve, Math.max(25, pollMs)));
    }
  } catch (error) {
    await release();
    throw error;
  }
}
