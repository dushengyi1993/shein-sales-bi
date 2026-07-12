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
  if (!firstStat || Date.now() - firstStat.mtimeMs <= staleMs) return false;
  const firstHolder = await readJson(ticketFile);
  if (processAppearsAlive(firstHolder?.pid)) return false;

  const [currentStat, currentHolder] = await Promise.all([
    fs.stat(ticketFile).catch(() => null),
    readJson(ticketFile),
  ]);
  if (!currentStat || !sameFileIdentity(firstStat, currentStat)) return false;
  if (Date.now() - currentStat.mtimeMs <= staleMs || processAppearsAlive(currentHolder?.pid)) return false;
  if (firstHolder?.nonce && currentHolder?.nonce !== firstHolder.nonce) return false;
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
    await handle.writeFile(JSON.stringify({pid: process.pid, nonce, orderNs, at: new Date().toISOString()}));
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
