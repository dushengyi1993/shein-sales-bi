/**
 * Small, filesystem-only lease registry for store-scoped browser work.
 *
 * Lease files deliberately contain no secrets and are safe for the cleanup
 * service to inspect.  A lease is valid only while its TTL is current and,
 * for a local owner, the recorded owner PID is still alive.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const LEASE_VERSION = 1;

function safePart(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized.replace(/[^A-Za-z0-9_.-]/g, '_');
}

function nowIso(nowMs) {
  return new Date(nowMs).toISOString();
}

function parseLease(file) {
  try {
    const lease = JSON.parse(fs.readFileSync(file, 'utf8'));
    return lease && typeof lease === 'object' ? lease : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function atomicWrite(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, {recursive: true});
  const temporary = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {encoding: 'utf8', flag: 'wx'});
    fs.renameSync(temporary, file);
  } finally {
    try { fs.rmSync(temporary, {force: true}); } catch {}
  }
}

function atomicCreate(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, {recursive: true});
  const temporary = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {encoding: 'utf8', flag: 'wx'});
    fs.linkSync(temporary, file);
  } finally {
    try { fs.rmSync(temporary, {force: true}); } catch {}
  }
}

export function browserLeaseDir(root) {
  return path.join(path.resolve(root), 'state', 'browser_task_leases');
}

export function browserLeasePath({root, task, storeKey}) {
  return path.join(browserLeaseDir(root), `${safePart(task, 'task')}--${safePart(storeKey, 'storeKey')}.json`);
}

export function assessBrowserLease(lease, {nowMs = Date.now(), hostname = os.hostname(), isPidAlive = pidAlive} = {}) {
  if (!lease || lease.version !== LEASE_VERSION || !lease.task || !lease.storeKey || !lease.runId) {
    return {valid: false, reason: 'malformed'};
  }
  const expiresMs = Date.parse(lease.expiresAt || '');
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) return {valid: false, reason: 'expired'};
  const ownerHost = String(lease.owner?.hostname || '');
  const ownerPid = Number(lease.owner?.pid || 0);
  if (ownerHost === hostname && !isPidAlive(ownerPid)) return {valid: false, reason: 'owner_dead'};
  return {valid: true, reason: 'active', expiresMs};
}

export function readBrowserLeases({root, nowMs = Date.now(), hostname = os.hostname(), isPidAlive = pidAlive} = {}) {
  const dir = browserLeaseDir(root);
  let names = [];
  try { names = fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort(); } catch { return []; }
  return names.map(name => {
    const file = path.join(dir, name);
    const lease = parseLease(file);
    return {file, lease, ...assessBrowserLease(lease, {nowMs, hostname, isPidAlive})};
  });
}

export function reclaimStaleBrowserLeases({root, nowMs = Date.now(), hostname = os.hostname(), isPidAlive = pidAlive} = {}) {
  const reclaimed = [];
  for (const item of readBrowserLeases({root, nowMs, hostname, isPidAlive})) {
    if (item.valid) continue;
    try {
      fs.rmSync(item.file, {force: true});
      reclaimed.push({file: item.file, task: item.lease?.task || null, storeKey: item.lease?.storeKey || null, reason: item.reason});
    } catch (err) {
      reclaimed.push({file: item.file, reason: item.reason, error: err?.code || String(err?.message || err)});
    }
  }
  return reclaimed;
}

export function acquireBrowserTaskLease({root, task, storeKey, runId = randomUUID(), ttlSec = 4500, ownerPid = process.pid, hostname = os.hostname(), nowMs = Date.now(), metadata = {}} = {}) {
  const file = browserLeasePath({root, task, storeKey});
  const ttlMs = Math.max(1, Number(ttlSec) || 0) * 1000;
  const existing = parseLease(file);
  const state = assessBrowserLease(existing, {nowMs, hostname});
  if (state.valid && existing.runId !== runId) {
    const error = new Error(`browser lease is already active for task=${task} store=${storeKey}`);
    error.code = 'LEASE_ACTIVE';
    error.lease = existing;
    throw error;
  }
  if (existing && !state.valid) {
    try { fs.rmSync(file, {force: true}); } catch {}
  }
  const lease = {
    version: LEASE_VERSION,
    task: String(task),
    storeKey: String(storeKey).toUpperCase(),
    runId: String(runId),
    owner: {pid: Number(ownerPid), hostname: String(hostname)},
    acquiredAt: existing?.runId === runId ? existing.acquiredAt : nowIso(nowMs),
    heartbeatAt: nowIso(nowMs),
    expiresAt: nowIso(nowMs + ttlMs),
    ttlSec: Math.max(1, Number(ttlSec) || 0),
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
  };
  if (!existing) atomicCreate(file, lease);
  else atomicWrite(file, lease);
  return {file, lease, reclaimed: existing && !state.valid ? state.reason : null};
}

export function heartbeatBrowserTaskLease({root, task, storeKey, runId, ttlSec, ownerPid = process.pid, hostname = os.hostname(), nowMs = Date.now()} = {}) {
  const file = browserLeasePath({root, task, storeKey});
  const current = parseLease(file);
  if (!current || current.runId !== runId) {
    const error = new Error(`browser lease does not belong to runId for task=${task} store=${storeKey}`);
    error.code = 'LEASE_NOT_OWNED';
    throw error;
  }
  return acquireBrowserTaskLease({
    root, task, storeKey, runId, ttlSec: ttlSec ?? current.ttlSec,
    ownerPid, hostname, nowMs, metadata: current.metadata,
  });
}

export function releaseBrowserTaskLease({root, task, storeKey, runId} = {}) {
  const file = browserLeasePath({root, task, storeKey});
  const current = parseLease(file);
  if (!current) return {released: false, reason: 'missing'};
  if (current.runId !== runId) return {released: false, reason: 'not_owner'};
  fs.rmSync(file, {force: true});
  return {released: true, file};
}
