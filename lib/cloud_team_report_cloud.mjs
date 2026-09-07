import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {writeFileAtomic, writeJsonFileAtomic} from './atomic_file_publish.mjs';
import {acquireCrossProcessTicketLock} from './cross_process_ticket_lock.mjs';
import {assertRetireReviewDayBinding} from './link_retire_review_delivery_guard.mjs';
import {
  CLOUD_TEAM_REPORT_CLOUD_CONFIG,
  CLOUD_TEAM_REPORT_LANDING_ROOT,
  CLOUD_TEAM_REPORT_CLOUD_HOST,
  CLOUD_TEAM_REPORT_SCHEMA_VERSION,
  CLOUD_TEAM_REPORT_STATE_SCHEMA_VERSION,
  CloudTeamReportError,
  assertNoForbiddenBundleFields,
  buildDeliveryIdempotencyKey,
  computeDeliveryFingerprint,
  contractError,
  decodeBase64,
  hashOpaque,
  interpretLarkResult,
  normalizeAutomationId,
  normalizeBusinessDate,
  normalizeAttachmentName,
  normalizeFingerprint,
  normalizeSha256,
  safeErrorCode,
  safePublicReason,
  safeResult,
  sha256Bytes,
} from './cloud_team_report_common.mjs';

const DEFAULT_TIMEOUT_MS = 120_000;

async function readJson(file) {
  try {
    return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/u, ''));
  } catch (error) {
    if (error instanceof SyntaxError) throw contractError('LARK_CONFIG_INVALID', 'cloud lark config is not valid JSON');
    if (error?.code === 'ENOENT') throw contractError('LARK_CONFIG_MISSING', 'cloud lark config is missing');
    throw contractError('LARK_CONFIG_UNREADABLE', 'cloud lark config is unreadable');
  }
}

export function validateCloudLarkConfig(config) {
  const recipientChatId = String(config?.recipientChatId || '').trim();
  if (!/^oc_[A-Za-z0-9]+$/u.test(recipientChatId)) {
    throw contractError('LARK_RECIPIENT_CHAT_INVALID', 'cloud lark config must contain a group recipientChatId');
  }
  if (config?.defaultIdentity !== 'bot') {
    throw contractError('LARK_IDENTITY_LOCKED', 'cloud team report delivery requires defaultIdentity=bot');
  }
  return {recipientChatId};
}

export function buildCloudLandingPaths({
  landingRoot = CLOUD_TEAM_REPORT_LANDING_ROOT,
  automationId,
  businessDate,
  fingerprint,
  attachmentName = 'attachment.bin',
} = {}) {
  const root = path.resolve(String(landingRoot));
  const automation = normalizeAutomationId(automationId);
  const date = normalizeBusinessDate(businessDate);
  const digest = normalizeFingerprint(fingerprint);
  const safeAttachmentName = normalizeAttachmentName(attachmentName);
  const deliveryDir = path.resolve(root, automation, date, digest);
  const relative = path.relative(root, deliveryDir);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw contractError('CLOUD_LANDING_PATH_INVALID', 'cloud delivery path escaped the allowlisted landing root');
  }
  return Object.freeze({
    root,
    deliveryDir,
    stateFile: path.join(deliveryDir, 'state.json'),
    summaryFile: path.join(deliveryDir, 'summary.md'),
    attachmentFile: path.join(deliveryDir, safeAttachmentName),
    lockFile: path.join(deliveryDir, 'delivery.lock'),
  });
}

async function lstatOrNull(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function ensureLandingDirectory(paths) {
  await fs.mkdir(paths.root, {recursive: true, mode: 0o750});
  const rootStat = await lstatOrNull(paths.root);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw contractError('CLOUD_LANDING_PATH_INVALID', 'cloud landing root must be a real directory');
  }
  let current = paths.root;
  const relative = path.relative(paths.root, paths.deliveryDir);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await lstatOrNull(current);
    if (stat?.isSymbolicLink()) throw contractError('CLOUD_LANDING_SYMLINK', 'cloud delivery path must not contain symlinks');
    if (stat && !stat.isDirectory()) throw contractError('CLOUD_LANDING_PATH_INVALID', 'cloud delivery path contains a non-directory');
    if (!stat) await fs.mkdir(current, {mode: 0o750});
  }
}

async function assertArtifactPathSafe(file, label) {
  const stat = await lstatOrNull(file);
  if (!stat) return null;
  if (stat.isSymbolicLink()) throw contractError('CLOUD_ARTIFACT_SYMLINK', `${label} must not be a symlink`);
  if (!stat.isFile()) throw contractError('CLOUD_ARTIFACT_PATH_INVALID', `${label} must be a regular file`);
  return stat;
}

async function stageArtifact(file, bytes, label) {
  const existing = await assertArtifactPathSafe(file, label);
  if (existing) {
    const current = await fs.readFile(file);
    if (!current.equals(bytes)) throw contractError('CLOUD_ARTIFACT_DRIFT', `${label} already exists with different bytes`);
    return;
  }
  await writeFileAtomic(file, bytes, {mode: 0o600});
  const published = await assertArtifactPathSafe(file, label);
  if (!published) throw contractError('CLOUD_ARTIFACT_PUBLISH_FAILED', `${label} was not published`);
}

async function readState(file) {
  const stat = await lstatOrNull(file);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) throw contractError('CLOUD_STATE_PATH_INVALID', 'delivery state must be a regular file');
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    throw contractError('CLOUD_STATE_INVALID', 'delivery state is not valid JSON');
  }
}

function stateBindingMatches(state, context) {
  return state?.schemaVersion === CLOUD_TEAM_REPORT_STATE_SCHEMA_VERSION
    && state?.automationId === context.automationId
    && state?.businessDate === context.businessDate
    && state?.fingerprint === context.fingerprint
    && state?.attachmentSha256 === context.attachmentSha256
    && state?.attachmentName === context.attachmentName
    && state?.summarySha256 === context.summarySha256;
}

function assertStateContract(state, context) {
  if (!stateBindingMatches(state, context)) {
    throw contractError('CLOUD_STATE_BINDING_MISMATCH', 'existing delivery state belongs to a different report binding');
  }
  if (!['pending', 'partial', 'failed', 'unknown', 'ok'].includes(state.status)) {
    throw contractError('CLOUD_STATE_INVALID', 'delivery state has an invalid status');
  }
  let normalizedUnknownReceipt = false;
  for (const kind of ['summary', 'attachment']) {
    const item = state?.items?.[kind];
    if (!item || typeof item !== 'object' || typeof item.accepted !== 'boolean'
      || !Number.isSafeInteger(item.attempts) || item.attempts < 0
      || item.idempotencyKeySha256 !== hashOpaque(context.idempotencyKeys[kind])) {
      throw contractError('CLOUD_STATE_INVALID', 'delivery state has an invalid item receipt');
    }
    if (item.unknown !== undefined && typeof item.unknown !== 'boolean') {
      throw contractError('CLOUD_STATE_INVALID', 'delivery state has an invalid unknown receipt flag');
    }
    const hasMessageId = typeof item.messageId === 'string' && item.messageId.trim().length > 0;
    if (item.accepted && !hasMessageId) {
      item.accepted = false;
      item.unknown = true;
      item.errorCode = 'lark_receipt_unknown';
      delete item.messageId;
      normalizedUnknownReceipt = true;
    } else if (item.messageId !== undefined && !hasMessageId) {
      throw contractError('CLOUD_STATE_INVALID', 'delivery state has an invalid lark receipt field');
    }
    if (item.fileKey !== undefined && (typeof item.fileKey !== 'string' || !item.fileKey.trim())) {
      throw contractError('CLOUD_STATE_INVALID', 'delivery state has an invalid lark receipt field');
    }
  }
  if (normalizedUnknownReceipt) state.status = 'unknown';
  return normalizedUnknownReceipt;
}

function newState(context, now) {
  return {
    schemaVersion: CLOUD_TEAM_REPORT_STATE_SCHEMA_VERSION,
    sendBoundaryVersion: 1,
    automationId: context.automationId,
    businessDate: context.businessDate,
    fingerprint: context.fingerprint,
    attachmentSha256: context.attachmentSha256,
    summarySha256: context.summarySha256,
    attachmentName: context.attachmentName,
    status: 'pending',
    items: {
      summary: {
        accepted: false,
        attempts: 0,
        idempotencyKeySha256: hashOpaque(context.idempotencyKeys.summary),
      },
      attachment: {
        accepted: false,
        attempts: 0,
        idempotencyKeySha256: hashOpaque(context.idempotencyKeys.attachment),
      },
    },
    sensitiveFieldsOmitted: true,
    updatedAt: now(),
  };
}

async function persistState(file, state, now) {
  state.updatedAt = now();
  await writeJsonFileAtomic(file, state, {mode: 0o600});
}

async function acquireDeliveryLock(file) {
  const queueDir = `${path.resolve(file)}.tickets`;
  await fs.mkdir(queueDir, {recursive: true, mode: 0o700});
  const queueStat = await lstatOrNull(queueDir);
  if (!queueStat?.isDirectory() || queueStat.isSymbolicLink()) {
    throw contractError('CLOUD_LOCK_SYMLINK', 'delivery lock queue must be a real directory');
  }
  try {
    return await acquireCrossProcessTicketLock(file, {
      timeoutMs: 5_000,
      staleMs: 10 * 60_000,
      timeoutMessage: 'another delivery is using this fingerprint',
      timeoutCode: 'DELIVERY_IN_PROGRESS',
    });
  } catch (error) {
    if (error?.code === 'DELIVERY_IN_PROGRESS') {
      throw contractError('DELIVERY_IN_PROGRESS', 'another delivery is using this fingerprint');
    }
    throw contractError('CLOUD_LOCK_FAILED', 'could not acquire the delivery lock');
  }
}

export function readProcStat(pid, {fsImpl = fsSync, platform = process.platform} = {}) {
  if (platform !== 'linux') return null;
  try {
    const stat = fsImpl.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const idx = stat.lastIndexOf(')');
    if (idx === -1) return { error: new Error('malformed procfs stat line') };
    const rest = stat.substring(idx + 2).split(' ');
    return {
      pid: Number(pid),
      state: rest[0],
      ppid: Number(rest[1]),
      pgrp: Number(rest[2]),
      starttime: rest[19],
    };
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ESRCH') {
      return null;
    }
    // Fail-closed: EACCES, EPERM, or unreadable procfs means state cannot be verified
    return { error: err };
  }
}

export function scanLinuxProcessTree(rootPids, knownBirthtimes = new Map(), {fsImpl = fsSync, platform = process.platform} = {}) {
  if (platform !== 'linux') return { tree: new Map(), birthtimes: new Map(), unverified: false };
  const birthtimes = new Map(knownBirthtimes);
  const ppidMap = new Map();
  const allStats = new Map();
  let unverified = false;

  try {
    const entries = fsImpl.readdirSync ? fsImpl.readdirSync('/proc') : [];
    for (const entry of entries) {
      if (!/^[0-9]+$/.test(entry)) continue;
      const st = readProcStat(entry, {fsImpl, platform});
      if (!st) continue;
      if (st.error) {
        unverified = true;
        continue;
      }
      allStats.set(st.pid, st);
      if (!ppidMap.has(st.ppid)) ppidMap.set(st.ppid, []);
      ppidMap.get(st.ppid).push(st.pid);
    }
  } catch (err) {
    // Cannot inspect /proc: fail closed
    return { tree: new Map(), birthtimes: new Map(), unverified: true, scanError: err };
  }

  const tree = new Map();
  const queue = Array.isArray(rootPids) ? [...rootPids] : [rootPids];
  for (const r of queue) {
    if (typeof r === 'number' && allStats.has(r)) {
      const st = allStats.get(r);
      if (birthtimes.has(r) && birthtimes.get(r) !== st.starttime) {
        continue;
      }
      birthtimes.set(r, st.starttime);
      tree.set(r, st);
    }
  }

  const rootPgrps = new Set();
  for (const st of tree.values()) {
    if (st.pgrp) rootPgrps.add(st.pgrp);
  }

  for (const [pid, st] of allStats.entries()) {
    if (!tree.has(pid) && rootPgrps.has(st.pgrp)) {
      if (birthtimes.has(pid) && birthtimes.get(pid) !== st.starttime) {
        continue;
      }
      birthtimes.set(pid, st.starttime);
      tree.set(pid, st);
    }
  }

  const visitQueue = Array.from(tree.keys());
  while (visitQueue.length > 0) {
    const curr = visitQueue.shift();
    const children = ppidMap.get(curr) || [];
    for (const childPid of children) {
      if (!tree.has(childPid)) {
        const cStat = allStats.get(childPid);
        if (!cStat) continue;
        if (birthtimes.has(childPid) && birthtimes.get(childPid) !== cStat.starttime) {
          continue;
        }
        birthtimes.set(childPid, cStat.starttime);
        tree.set(childPid, cStat);
        visitQueue.push(childPid);
      }
    }
  }

  return { tree, birthtimes, unverified };
}

export function checkProcessAlive(pid, expectedBirthtime, isAliveFn, {fsImpl = fsSync, platform = process.platform} = {}) {
  if (typeof isAliveFn === 'function') return isAliveFn(pid, expectedBirthtime);
  if (platform === 'linux') {
    const st = readProcStat(pid, {fsImpl, platform});
    if (st && st.error) {
      // EACCES / EPERM / unreadable: fail closed, treat as unverified/alive
      return true;
    }
    if (!st) return false;
    if (expectedBirthtime !== undefined && expectedBirthtime !== null && st.starttime !== expectedBirthtime) {
      return false; // PID reused
    }
    if (st.state === 'Z' || st.state === 'X') return false;
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err?.code === 'ESRCH') return false;
    if (err?.code === 'EPERM') return true;
    return true; // Fail closed on unexpected errors
  }
}

function runTaskkillBounded(args, timeoutMs = 2000) {
  return new Promise(resolve => {
    let child;
    let timer = null;
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawn('taskkill', args, {windowsHide: true, stdio: 'ignore'});
      child.on('close', code => finish({exitCode: code, ok: code === 0}));
      child.on('error', err => finish({exitCode: -1, ok: false, error: err}));
      timer = setTimeout(() => {
        try { child.kill(); } catch {}
        finish({exitCode: -1, ok: false, timedOut: true});
      }, timeoutMs);
    } catch (err) {
      finish({exitCode: -1, ok: false, error: err});
    }
  });
}

export async function cleanupProcessTree({
  child,
  trackedPids = new Set(),
  knownBirthtimes = new Map(),
  graceMs = 500,
  killTimeoutMs = 3000,
  pollIntervalMs = 30,
  isAliveFn = null,
  killFn = null,
  fsImpl = fsSync,
  platform = process.platform,
  taskkillRunner = runTaskkillBounded,
} = {}) {
  const rootPid = child?.pid;
  const initialPids = new Set(trackedPids);
  if (rootPid) initialPids.add(rootPid);

  const useSimulationOrLinux = platform === 'linux' || (platform !== 'win32' && (typeof isAliveFn === 'function' || typeof killFn === 'function'));
  if (useSimulationOrLinux) {
    let currentBirthtimes = new Map(knownBirthtimes);
    for (const p of initialPids) {
      if (!currentBirthtimes.has(p)) {
        const st = readProcStat(p, {fsImpl, platform});
        if (st && !st.error) currentBirthtimes.set(p, st.starttime);
        else currentBirthtimes.set(p, null);
      }
    }
    if (platform === 'linux') {
      const scanResult = scanLinuxProcessTree(Array.from(initialPids), currentBirthtimes, {fsImpl, platform});
      if (scanResult.unverified) {
        // Failed to scan /proc cleanly: fail closed
        return {ok: false, unverified: true, alivePids: Array.from(initialPids)};
      }
      currentBirthtimes = scanResult.birthtimes;
    }

    const getAliveTargets = () => {
      if (platform === 'linux') {
        const scanResult = scanLinuxProcessTree(Array.from(currentBirthtimes.keys()), currentBirthtimes, {fsImpl, platform});
        if (scanResult.unverified) {
          return {unverified: true, alive: Array.from(currentBirthtimes.keys()).map(pid => ({pid, btime: currentBirthtimes.get(pid)}))};
        }
        currentBirthtimes = scanResult.birthtimes;
      }
      const alive = [];
      for (const [pid, btime] of currentBirthtimes.entries()) {
        if (checkProcessAlive(pid, btime, isAliveFn, {fsImpl, platform})) {
          alive.push({pid, btime});
        }
      }
      return {unverified: false, alive};
    };

    let {unverified, alive: aliveList} = getAliveTargets();
    if (unverified) {
      return {ok: false, unverified: true, alivePids: aliveList.map(a => a.pid)};
    }
    if (aliveList.length === 0) {
      return {ok: true, alivePids: []};
    }

    // 1. Send SIGTERM to alive targets
    for (const {pid, btime} of aliveList) {
      if (checkProcessAlive(pid, btime, isAliveFn, {fsImpl})) {
        try {
          if (typeof killFn === 'function') killFn(pid, 'SIGTERM');
          else process.kill(pid, 'SIGTERM');
        } catch (err) {
          if (err?.code !== 'ESRCH') {}
        }
      }
    }

    const graceDeadline = Date.now() + graceMs;
    while (Date.now() < graceDeadline) {
      const state = getAliveTargets();
      if (state.unverified) return {ok: false, unverified: true, alivePids: state.alive.map(a => a.pid)};
      aliveList = state.alive;
      if (aliveList.length === 0) return {ok: true, alivePids: []};
      await new Promise(r => setTimeout(r, pollIntervalMs));
    }

    // 2. Step up to SIGKILL
    const killDeadline = Date.now() + killTimeoutMs;
    while (Date.now() < killDeadline) {
      const state = getAliveTargets();
      if (state.unverified) return {ok: false, unverified: true, alivePids: state.alive.map(a => a.pid)};
      aliveList = state.alive;
      if (aliveList.length === 0) return {ok: true, alivePids: []};
      for (const {pid, btime} of aliveList) {
        if (checkProcessAlive(pid, btime, isAliveFn, {fsImpl})) {
          try {
            if (typeof killFn === 'function') killFn(pid, 'SIGKILL');
            else process.kill(pid, 'SIGKILL');
          } catch (err) {
            if (err?.code !== 'ESRCH') {}
          }
        }
      }
      await new Promise(r => setTimeout(r, pollIntervalMs));
    }

    const finalState = getAliveTargets();
    if (finalState.unverified) {
      return {ok: false, unverified: true, alivePids: finalState.alive.map(a => a.pid)};
    }
    if (finalState.alive.length > 0) {
      return {ok: false, unverified: finalState.unverified, alivePids: finalState.alive.map(a => a.pid)};
    }
    return {ok: true, alivePids: []};
  } else if (platform === 'win32') {
    // Windows: when rootPid is present, attempt bounded taskkill /T /F
    let rootTreeNonOk = false;
    if (rootPid) {
      const tkRes = await taskkillRunner(['/pid', String(rootPid), '/t', '/f'], 2500);
      if (!tkRes || !tkRes.ok) {
        // Any non-ok (timeout, error, non-zero including exitCode 128 where root already closed)
        // means tree destruction could NOT be proven to Windows kernel.
        rootTreeNonOk = true;
      }
    }

    // Kill any explicitly tracked child PIDs individually with bounded execution
    for (const pid of initialPids) {
      if (pid !== rootPid) {
        await taskkillRunner(['/pid', String(pid), '/f'], 1000);
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }

    // Readback verification: poll until tracked PIDs are confirmed dead
    const deadline = Date.now() + killTimeoutMs;
    while (Date.now() < deadline) {
      let anyAlive = false;
      for (const pid of initialPids) {
        if (checkProcessAlive(pid, null, isAliveFn, {platform})) {
          anyAlive = true;
          break;
        }
      }
      if (!anyAlive) {
        // Tracked PIDs are dead, but if rootTree failed/timed out/128, descendants cannot be verified
        if (rootTreeNonOk) {
          return {ok: false, unverified: true, alivePids: rootPid ? [rootPid] : []};
        }
        return {ok: true, alivePids: []};
      }
      await new Promise(r => setTimeout(r, pollIntervalMs));
    }

    const remaining = [];
    for (const pid of initialPids) {
      if (checkProcessAlive(pid, null, isAliveFn, {platform})) remaining.push(pid);
    }
    if (rootTreeNonOk || remaining.length > 0) {
      return {ok: false, unverified: rootTreeNonOk, alivePids: remaining};
    }
    return {ok: true, alivePids: []};
  } else {
    for (const pid of initialPids) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    return {ok: true, alivePids: []};
  }
}

export function runLarkCommand({spawnImpl = spawn, args, cwd, timeoutMs = DEFAULT_TIMEOUT_MS, signal} = {}) {
  return new Promise(resolve => {
    let child;
    let settled = false;
    let timer = null;
    let pollTimer = null;
    let onAbort = null;
    let killed = false;
    let timedOut = false;
    const trackedPids = new Set();
    const knownBirthtimes = new Map();
    let cleanupPromise = null;

    const clearAllTimers = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (signal && onAbort) {
        try { signal.removeEventListener('abort', onAbort); } catch {}
        onAbort = null;
      }
    };

    const finish = result => {
      if (settled) return;
      settled = true;
      clearAllTimers();
      resolve({stdout, stderr, ...result});
    };

    if (signal?.aborted) {
      resolve({exitCode: -1, stdout: '', stderr: '', timedOut: true, aborted: true});
      return;
    }

    try {
      child = spawnImpl('lark-cli', args, {
        ...(cwd ? {cwd} : {}),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch {
      resolve({exitCode: -1, stdout: '', stderr: '', spawnError: true});
      return;
    }

    let stdout = '';
    let stderr = '';

    const executeCleanup = (initialResult) => {
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = (async () => {
        clearAllTimers();
        let cleanupRes;
        try {
          cleanupRes = await cleanupProcessTree({
            child,
            trackedPids,
            knownBirthtimes,
            graceMs: 300,
            killTimeoutMs: 2500,
            pollIntervalMs: 30,
          });
        } catch (cleanupErr) {
          cleanupRes = {ok: false, error: cleanupErr, alivePids: Array.from(trackedPids)};
        }

        if (!cleanupRes?.ok) {
          finish({
            ...initialResult,
            cleanupFailed: true,
            aliveDescendants: cleanupRes?.alivePids || [],
            errorCode: 'descendant_cleanup_stuck',
          });
        } else {
          finish(initialResult);
        }
      })().catch(unhandledErr => {
        finish({
          ...initialResult,
          cleanupFailed: true,
          errorCode: 'descendant_cleanup_stuck',
          error: unhandledErr,
        });
      });
      return cleanupPromise;
    };

    if (signal) {
      onAbort = () => {
        killed = true;
        void executeCleanup({exitCode: -1, timedOut: false, aborted: true, killed: true});
      };
      signal.addEventListener('abort', onAbort, {once: true});
      if (signal.aborted) {
        onAbort();
        return;
      }
    }

    if (child?.pid) {
      trackedPids.add(child.pid);
      if (process.platform === 'linux') {
        const rootStat = readProcStat(child.pid);
        if (rootStat && !rootStat.error) knownBirthtimes.set(child.pid, rootStat.starttime);
        pollTimer = setInterval(() => {
          const {tree, birthtimes} = scanLinuxProcessTree(Array.from(trackedPids), knownBirthtimes);
          for (const [p, b] of birthtimes.entries()) {
            trackedPids.add(p);
            knownBirthtimes.set(p, b);
          }
        }, 30);
        pollTimer.unref?.();
      }
    }

    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on?.('data', chunk => { stdout += String(chunk); });
    child.stderr?.on?.('data', chunk => { stderr += String(chunk); });
    child.on?.('error', () => {
      void executeCleanup({exitCode: -1, spawnError: true});
    });
    child.on?.('close', code => {
      if (killed || timedOut) {
        void executeCleanup({
          exitCode: -1,
          timedOut,
          aborted: signal?.aborted || false,
          killed: true,
        });
      } else {
        void executeCleanup({
          exitCode: Number.isInteger(code) ? code : -1,
          killed: false,
          aborted: false,
        });
      }
    });

    timer = setTimeout(() => {
      killed = true;
      timedOut = true;
      void executeCleanup({exitCode: -1, timedOut: true, aborted: false, killed: true});
    }, timeoutMs);
  });
}

async function sendItem({kind, context, config, deliveryDir, file, summary, spawnImpl, timeoutMs, executionIdentityVerified, signal}) {
  const common = [
    'im', '+messages-send',
    '--as', 'bot',
    '--chat-id', config.recipientChatId,
  ];
  let args;
  let cwd;
  if (kind === 'summary') {
    args = [...common, '--markdown', summary, '--idempotency-key', context.idempotencyKeys.summary];
  } else {
    if (path.dirname(file) !== deliveryDir) {
      throw contractError('CLOUD_ARTIFACT_PATH_INVALID', 'attachment must stay in the verified delivery directory');
    }
    args = [...common, '--file', path.basename(file), '--idempotency-key', context.idempotencyKeys.attachment];
    cwd = deliveryDir;
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await runLarkCommand({spawnImpl, args, cwd, timeoutMs, signal});
    if (raw.cleanupFailed) {
      return {accepted: false, errorCode: 'lark_receipt_unknown', unknown: true, retryable: false};
    }
    const preflightFailure = raw.spawnError === true;
    if (raw.aborted || signal?.aborted) {
      return {accepted: false, errorCode: 'lark_receipt_unknown', unknown: true, retryable: false};
    }
    const response = interpretLarkResult({
      exitCode: raw.exitCode,
      stdout: raw.stdout,
      stderr: raw.stderr,
      executionIdentityVerified,
      spawnError: raw.spawnError,
      timedOut: raw.timedOut,
      retryable: preflightFailure,
    });
    if (!response.retryable || attempt === 1) return response;
  }
  return {accepted: false, errorCode: 'lark_process_failed', retryable: true};
}
function validateBundle(bundle) {
  assertNoForbiddenBundleFields(bundle);
  if (bundle?.schemaVersion !== CLOUD_TEAM_REPORT_SCHEMA_VERSION) throw contractError('INVALID_BUNDLE', 'unsupported cloud team report bundle');
  const automationId = normalizeAutomationId(bundle.automationId);
  const businessDate = normalizeBusinessDate(bundle.businessDate);
  const attachmentSha256 = normalizeSha256(bundle.expectedAttachmentSha256, 'expected attachment SHA-256');
  const attachmentName = normalizeAttachmentName(bundle.attachmentName);
  const attachmentBytes = decodeBase64(bundle.attachmentBase64, 'attachment');
  const summaryBytes = decodeBase64(bundle.summaryBase64, 'summary');
  const actualAttachmentSha256 = sha256Bytes(attachmentBytes);
  if (actualAttachmentSha256 !== attachmentSha256) throw contractError('ATTACHMENT_SHA256_MISMATCH', 'cloud attachment SHA-256 does not match expected value');
  const fingerprint = computeDeliveryFingerprint({automationId, businessDate, attachmentSha256});
  if (bundle.fingerprint !== undefined && normalizeFingerprint(bundle.fingerprint) !== fingerprint) {
    throw contractError('BUNDLE_FINGERPRINT_MISMATCH', 'cloud bundle fingerprint does not match its binding');
  }
  return {
    automationId,
    businessDate,
    attachmentSha256,
    attachmentName,
    summarySha256: sha256Bytes(summaryBytes),
    fingerprint,
    summaryBytes,
    attachmentBytes,
    idempotencyKeys: {
      summary: buildDeliveryIdempotencyKey({fingerprint, kind: 'summary'}),
      attachment: buildDeliveryIdempotencyKey({fingerprint, kind: 'attachment'}),
    },
  };
}

function resultFromState(context, state, extra = {}) {
  return safeResult({
    ok: state?.status === 'ok',
    status: state?.status || 'failed',
    automationId: context.automationId,
    businessDate: context.businessDate,
    fingerprint: context.fingerprint,
    attachmentName: context.attachmentName,
    attachmentSha256: context.attachmentSha256,
    summarySha256: context.summarySha256,
    items: state?.items,
    ...extra,
  });
}

export async function deliverCloudTeamReport({
  bundle,
  configPath = process.env.CLOUD_TEAM_REPORT_CLOUD_CONFIG || CLOUD_TEAM_REPORT_CLOUD_CONFIG,
  signal,
  config: configOverride,
  landingRoot = CLOUD_TEAM_REPORT_LANDING_ROOT,
  spawnImpl = spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => new Date().toISOString(),
  executionIdentityVerified = false,
} = {}) {
  const context = validateBundle(bundle);
  const paths = buildCloudLandingPaths({
    landingRoot,
    automationId: context.automationId,
    businessDate: context.businessDate,
    fingerprint: context.fingerprint,
    attachmentName: context.attachmentName,
  });
  let releaseDayLock;
  let releaseLock;
  try {
    if(context.automationId==='shein-3') {
      const automationRoot=path.join(paths.root,context.automationId);
      await ensureLandingDirectory({...paths,deliveryDir:automationRoot});
      releaseDayLock=await acquireDeliveryLock(path.join(automationRoot,`.review-${context.businessDate}.lock`));
      await assertRetireReviewDayBinding({root:automationRoot,date:context.businessDate,fingerprint:context.fingerprint});
    }
    await ensureLandingDirectory(paths);
    releaseLock=await acquireDeliveryLock(paths.lockFile);
    await stageArtifact(paths.summaryFile, context.summaryBytes, 'summary.md');
    await stageArtifact(paths.attachmentFile, context.attachmentBytes, context.attachmentName);
    let state = await readState(paths.stateFile);
    const freshState = !state;
    if (state && assertStateContract(state, context)) {
      await persistState(paths.stateFile, state, now);
    }
    if (!state) {
      state = newState(context, now);
      await persistState(paths.stateFile, state, now);
    }

    let config;
    try {
      config = validateCloudLarkConfig(configOverride || await readJson(configPath));
    } catch (configError) {
      const code = safeErrorCode(configError, 'LARK_CONFIG_INVALID');
      const unknown = ['summary','attachment'].some(kind => state.items[kind]?.unknown === true);
      state.status = unknown ? 'unknown' : 'failed';
      state.lastError = code;
      if(freshState) {
        for(const kind of ['summary','attachment'])state.items[kind].confirmedFailure=true;
      }
      await persistState(paths.stateFile, state, now);
      return resultFromState(context, state, {
        errorCode: code,
        retryable: !unknown,
      });
    }
    let firstFailure = null;
    for (const kind of ['summary', 'attachment']) {
      const existing = state.items?.[kind];
      if (existing?.accepted === true) continue;
      if (existing?.unknown === true) {
        state.status = 'unknown';
        firstFailure = {errorCode: existing.errorCode || 'lark_receipt_unknown'};
        break;
      }
      const neverAttempted = state.sendBoundaryVersion === 1 && existing?.attempts === 0;
      if(!freshState && !neverAttempted && existing?.confirmedFailure!==true) {
        state.items[kind]={...existing,accepted:false,unknown:true,errorCode:'delivery_receipt_unconfirmed'};
        state.status='unknown';
        await persistState(paths.stateFile,state,now);
        firstFailure={errorCode:'delivery_receipt_unconfirmed',retryable:false};
        break;
      }
      if (kind === 'attachment' && state.items?.summary?.accepted !== true) break;
      const item = state.items[kind] || {accepted: false, attempts: 0};
      item.attempts = Number(item.attempts || 0) + 1;
      item.unknown=true;
      item.confirmedFailure=false;
      state.items[kind]=item;
      state.status='unknown';
      // Every business report persists uncertainty before the external call.
      // The version also proves untouched attachment items have never been sent.
      await persistState(paths.stateFile,state,now);
      const response = await sendItem({
        kind,
        context,
        config,
        deliveryDir: paths.deliveryDir,
        file: paths.attachmentFile,
        summary: context.summaryBytes.toString('utf8'),
        spawnImpl,
        timeoutMs,
        executionIdentityVerified,
        signal,
      });
      if (response.accepted) {
        item.accepted = true;
        delete item.unknown;
        delete item.confirmedFailure;
        item.messageId = response.messageId;
        if (response.fileKey) item.fileKey = response.fileKey;
        else delete item.fileKey;
        delete item.errorCode;
        delete item.sourceCode;
        delete item.executionIdentityVerified;
        delete item.botMembershipInferred;
      } else {
        item.accepted = false;
        if (response.unknown) item.unknown = true;
        else delete item.unknown;
        item.confirmedFailure=response.unknown!==true;
        item.errorCode = response.errorCode;
        if (response.sourceCode) item.sourceCode = response.sourceCode;
        if (response.executionIdentityVerified !== undefined) item.executionIdentityVerified = response.executionIdentityVerified;
        if (response.botMembershipInferred !== undefined) item.botMembershipInferred = response.botMembershipInferred;
        if (!firstFailure) firstFailure = response;
      }
      state.items[kind] = item;
      state.status = state.items.summary.accepted && state.items.attachment.accepted
        ? 'ok'
        : (state.items.summary.unknown || state.items.attachment.unknown
          ? 'unknown'
          : (state.items.summary.accepted || state.items.attachment.accepted ? 'partial' : 'failed'));
      await persistState(paths.stateFile, state, now);
      if (!response.accepted) break;
    }
    const result = resultFromState(context, state, firstFailure ? {
      errorCode: firstFailure.errorCode,
      sourceCode: firstFailure.sourceCode || null,
      executionIdentityVerified: firstFailure.executionIdentityVerified ?? null,
      retryable: firstFailure.retryable ?? null,
    } : {});
    return result;
  } finally {
    if(releaseLock)await releaseLock().catch(() => {});
    if(releaseDayLock)await releaseDayLock().catch(() => {});
  }
}

export function cloudFailureResult(error) {
  const code = safeErrorCode(error);
  return {
    ok: false,
    errorCode: code,
    reason: error instanceof CloudTeamReportError ? safePublicReason(code) : 'cloud team report delivery failed',
  };
}

export {CLOUD_TEAM_REPORT_CLOUD_HOST};
