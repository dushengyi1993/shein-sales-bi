import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {acquireCrossProcessTicketLock} from './cross_process_ticket_lock.mjs';

export const INVENTORY_BOOTSTRAP_LOCK_SCHEMA = 'daily-inventory-bootstrap-locks/v1';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function registryHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

export function normalizeInventoryBootstrapLockRegistry(document) {
  const locks = {};
  for (const [rawKey, rawEntry] of Object.entries(document?.locks || {})) {
    const matchKey = String(rawEntry?.matchKey || rawKey || '').trim().toUpperCase();
    if (!matchKey) throw new Error('bootstrap lock matchKey is required');
    if (locks[matchKey]) throw new Error(`duplicate normalized bootstrap lock key: ${matchKey}`);
    const normalized = {
      matchKey,
      canonical: String(rawEntry?.canonical || ''),
      storeKey: String(rawEntry?.storeKey || '').trim().toUpperCase(),
      skc: String(rawEntry?.skc || ''),
      skuCode: String(rawEntry?.skuCode || ''),
      targetUsableInventory: Number(rawEntry?.targetUsableInventory || 0),
      policyVersion: String(rawEntry?.policyVersion || ''),
      status: String(rawEntry?.status || 'active'),
      createdAt: String(rawEntry?.createdAt || ''),
      updatedAt: String(rawEntry?.updatedAt || ''),
      planHash: String(rawEntry?.planHash || ''),
    };
    if (!normalized.canonical || !normalized.storeKey || !normalized.skc || !normalized.skuCode) {
      throw new Error(`bootstrap lock identity is incomplete: ${matchKey}`);
    }
    if (!Number.isInteger(normalized.targetUsableInventory) || normalized.targetUsableInventory < 1) {
      throw new Error(`bootstrap lock target is invalid: ${matchKey}`);
    }
    if (!normalized.policyVersion || !['pending', 'active'].includes(normalized.status)) {
      throw new Error(`bootstrap lock policy/status is invalid: ${matchKey}`);
    }
    if (!/^[a-f0-9]{64}$/.test(normalized.planHash)) throw new Error(`bootstrap lock planHash is invalid: ${matchKey}`);
    locks[matchKey] = normalized;
  }
  return {
    schemaVersion: INVENTORY_BOOTSTRAP_LOCK_SCHEMA,
    updatedAt: String(document?.updatedAt || ''),
    locks: Object.fromEntries(Object.entries(locks).sort(([left], [right]) => left.localeCompare(right))),
  };
}

export async function readInventoryBootstrapLockRegistry(file) {
  let document = null;
  try {
    document = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (document && document.schemaVersion !== INVENTORY_BOOTSTRAP_LOCK_SCHEMA) {
    throw new Error(`unsupported inventory bootstrap lock schema: ${document.schemaVersion || '(missing)'}`);
  }
  const registry = normalizeInventoryBootstrapLockRegistry(document || {});
  return {
    exists: document !== null,
    registry,
    hash: registryHash(registry),
  };
}

export async function upsertInventoryBootstrapLock(file, entry, {
  now = new Date().toISOString(),
  expectedRegistryHash = '',
  transition = '',
} = {}) {
  const matchKey = String(entry?.matchKey || '').trim().toUpperCase();
  if (!matchKey) throw new Error('bootstrap lock matchKey is required');
  const release = await acquireCrossProcessTicketLock(`${file}.lock`, {
    timeoutMs: 60_000,
    staleMs: 20 * 60_000,
    timeoutMessage: `inventory bootstrap lock registry timeout: ${file}`,
  });
  try {
    const current = await readInventoryBootstrapLockRegistry(file);
    if (expectedRegistryHash && current.hash !== expectedRegistryHash) {
      throw new Error(`bootstrap lock registry hash changed: expected=${expectedRegistryHash} actual=${current.hash}`);
    }
    const previous = current.registry.locks[matchKey];
    if (previous && (
      previous.storeKey !== String(entry.storeKey || '').trim().toUpperCase()
      || previous.skc !== String(entry.skc || '')
      || previous.skuCode !== String(entry.skuCode || '')
    )) {
      throw new Error(`bootstrap lock identity mismatch for ${matchKey}`);
    }
    const requestedStatus = String(entry?.status || previous?.status || 'active');
    if (transition === 'reserve_pending') {
      if (requestedStatus !== 'pending') throw new Error(`bootstrap reserve must request pending: ${matchKey}`);
      if (previous) {
        if (previous.status === 'pending' && previous.planHash === String(entry.planHash || '')) {
          return {registry: current.registry, hash: current.hash, entry: previous};
        }
        throw new Error(`bootstrap canonical is already reserved: ${matchKey}`);
      }
    } else if (transition === 'activate') {
      if (requestedStatus !== 'active' || !previous || !['pending', 'active'].includes(previous.status)) {
        throw new Error(`bootstrap activation requires an existing pending/active lock: ${matchKey}`);
      }
    } else {
      if (previous?.status === 'active' && requestedStatus === 'pending') {
        throw new Error(`bootstrap lock cannot transition active to pending: ${matchKey}`);
      }
      if (previous?.status === 'pending' && requestedStatus === 'pending' && previous.planHash !== String(entry.planHash || '')) {
        throw new Error(`bootstrap pending reservation cannot change plan: ${matchKey}`);
      }
    }
    const next = normalizeInventoryBootstrapLockRegistry({
      ...current.registry,
      updatedAt: now,
      locks: {
        ...current.registry.locks,
        [matchKey]: {
          ...entry,
          matchKey,
          storeKey: String(entry.storeKey || '').trim().toUpperCase(),
          targetUsableInventory: Number(entry.targetUsableInventory || 0),
          status: requestedStatus,
          createdAt: previous?.createdAt || now,
          updatedAt: now,
        },
      },
    });
    await fs.mkdir(path.dirname(file), {recursive: true});
    const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, file);
      const directory = await fs.open(path.dirname(file), 'r').catch(() => null);
      if (directory) {
        try { await directory.sync(); } catch (error) {
          if (!['EINVAL', 'EPERM', 'ENOTSUP'].includes(error?.code)) throw error;
        } finally { await directory.close(); }
      }
    } catch (error) {
      try { await handle?.close(); } catch {}
      await fs.rm(temporary, {force: true}).catch(() => {});
      throw error;
    }
    return {registry: next, hash: registryHash(next), entry: next.locks[matchKey]};
  } finally {
    await release();
  }
}

export function reserveInventoryBootstrapLock(file, entry, options = {}) {
  return upsertInventoryBootstrapLock(file, {...entry, status: 'pending'}, {...options, transition: 'reserve_pending'});
}

export function activateInventoryBootstrapLock(file, entry, options = {}) {
  return upsertInventoryBootstrapLock(file, {...entry, status: 'active'}, {...options, transition: 'activate'});
}
