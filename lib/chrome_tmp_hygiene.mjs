import fs from 'node:fs';
import path from 'node:path';

const CHROME_TMP_NAME = /^\.?com\.google\.Chrome\.[A-Za-z0-9_-]+$/;

function summarizeOwnerUids(items) {
  const counts = new Map();
  for (const item of items) {
    const key = Number.isInteger(item.uid) ? String(item.uid) : 'unknown';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export function inspectChromeTmpDirectories({
  tmpRoot = '/tmp',
  ownerUid,
  fsImpl = fs,
} = {}) {
  const owned = [];
  const foreign = [];
  const unsafe = [];
  for (const name of fsImpl.readdirSync(tmpRoot)) {
    if (!CHROME_TMP_NAME.test(name)) continue;
    const candidate = path.join(tmpRoot, name);
    let stat;
    try {
      stat = fsImpl.lstatSync(candidate);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink?.() || !stat.isDirectory?.()) {
      unsafe.push({path: candidate, uid: Number.isInteger(stat.uid) ? stat.uid : null});
      continue;
    }
    const item = {path: candidate, uid: Number.isInteger(stat.uid) ? stat.uid : null};
    if (Number.isInteger(ownerUid) && item.uid === ownerUid) owned.push(item);
    else foreign.push(item);
  }
  owned.sort((a, b) => a.path.localeCompare(b.path));
  foreign.sort((a, b) => a.path.localeCompare(b.path));
  unsafe.sort((a, b) => a.path.localeCompare(b.path));
  return {
    owned,
    foreign,
    unsafe,
    foreignOwnerUids: summarizeOwnerUids(foreign),
  };
}

export function cleanupOwnedChromeTmpDirectories({
  enabled,
  dryRun = false,
  liveCount = 0,
  tmpRoot = '/tmp',
  ownerUid,
  fsImpl = fs,
} = {}) {
  if (!enabled) {
    return {enabled: false, skipped: 'disabled', beforeCount: 0, afterCount: 0, removed: []};
  }
  if (!Number.isInteger(ownerUid) || ownerUid < 0) {
    return {enabled: true, skipped: 'owner-uid-unavailable', beforeCount: 0, afterCount: 0, removed: []};
  }

  const before = inspectChromeTmpDirectories({tmpRoot, ownerUid, fsImpl});
  const base = {
    enabled: true,
    ownerUid,
    liveCount,
    beforeCount: before.owned.length,
    observedCount: before.owned.length + before.foreign.length + before.unsafe.length,
    foreignCount: before.foreign.length,
    foreignOwnerUids: before.foreignOwnerUids,
    unsafeCount: before.unsafe.length,
  };
  if (liveCount > 0) {
    return {...base, skipped: 'live-chrome-processes', afterCount: before.owned.length, removed: []};
  }

  const removed = [];
  for (const item of before.owned) {
    if (dryRun) {
      removed.push({path: item.path, dryRun: true});
      continue;
    }
    try {
      fsImpl.rmSync(item.path, {recursive: true, force: true});
      removed.push({path: item.path});
    } catch (err) {
      removed.push({path: item.path, error: err?.code || String(err?.message || err)});
    }
  }

  const after = inspectChromeTmpDirectories({tmpRoot, ownerUid, fsImpl});
  return {
    ...base,
    afterCount: dryRun ? before.owned.length : after.owned.length,
    afterObservedCount: after.owned.length + after.foreign.length + after.unsafe.length,
    foreignCount: after.foreign.length,
    foreignOwnerUids: after.foreignOwnerUids,
    unsafeCount: after.unsafe.length,
    removed,
  };
}
