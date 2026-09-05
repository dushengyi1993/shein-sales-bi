#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectMarketingRepairArtifacts, exportMarketingRepairArtifacts, importMarketingRepairArtifacts} from '../../lib/marketing_repair_artifacts.mjs';
import {
  loadExactHighClickSpecialPlan,
  loadExactManualRepairPlan,
  loadExactDriftRepairManifest,
  loadExactFallbackRepairPlan,
  sha256File,
} from '../../lib/marketing_repair_manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const QUEUE_CAS_CONFLICT_CODE = 'QUEUE_CAS_CONFLICT';
const QUEUE_MUTATION_LOCK_BUSY_CODE = 'QUEUE_MUTATION_LOCK_BUSY';
const QUEUE_MUTATION_LOCK_FAILED_CODE = 'QUEUE_MUTATION_LOCK_FAILED';
const QUEUE_MUTATION_LOCK_SUFFIX = '.mutation.lock';
const QUEUE_MUTATION_LOCK_OWNER = 'owner';

class QueueCasConflictError extends Error {
  constructor(message) {
    super(`[${QUEUE_CAS_CONFLICT_CODE}] ${message}`);
    this.name = 'QueueCasConflictError';
    this.code = QUEUE_CAS_CONFLICT_CODE;
  }
}

class QueueMutationLockError extends Error {
  constructor(message, code = QUEUE_MUTATION_LOCK_FAILED_CODE) {
    super(`[${code}] ${message}`);
    this.name = 'QueueMutationLockError';
    this.code = code;
  }
}

function parseArgs(argv) {
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'build';
  const args = {command};
  const start = command === argv[0] ? 1 : 0;
  for (let i = start; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    const value = inlineValue !== undefined ? inlineValue : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
    args[key] = value;
  }
  return args;
}

function rel(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, '/');
}

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function hashBytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function requiredSha256Arg(args, key, flag) {
  const value = String(args[key] || '').trim().toLowerCase();
  if (!value) throw new Error(`Missing ${flag}`);
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid ${flag}: expected a 64-hex SHA-256`);
  return value;
}

function assertExpectedQueuePair(queue, expected) {
  const actualQueueFingerprint = String(queue?.queueFingerprint || '').trim().toLowerCase();
  const actualSourceGuardHash = String(queue?.sourceGuardHash || '').trim().toLowerCase();
  if (actualQueueFingerprint !== expected.queueFingerprint || actualSourceGuardHash !== expected.sourceGuardHash) {
    throw new QueueCasConflictError(
      `Queue CAS conflict: expected queueFingerprint=${expected.queueFingerprint} sourceGuardHash=${expected.sourceGuardHash} `
      + `actual queueFingerprint=${actualQueueFingerprint || 'missing'} sourceGuardHash=${actualSourceGuardHash || 'missing'}; queue unchanged`,
    );
  }
}

function expectedQueuePair(args) {
  return {
    queueFingerprint: requiredSha256Arg(args, 'expectedQueueFingerprint', '--expected-queue-fingerprint'),
    sourceGuardHash: requiredSha256Arg(args, 'expectedSourceGuardHash', '--expected-source-guard-hash'),
  };
}

function expectedQueueStateSha256(args) {
  const value = String(args.expectedQueueStateSha256 || args.expectedStateSha256 || args.expectedQueueFileSha256 || '').trim().toLowerCase();
  if (!value) throw new Error('Missing --expected-queue-state-sha256');
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid --expected-queue-state-sha256: expected a 64-hex SHA-256');
  return value;
}

function queueMutationLockPath(queuePath) {
  return `${queuePath}${QUEUE_MUTATION_LOCK_SUFFIX}`;
}

function queueLockToken(value, flag = '--queue-lock-token') {
  const token = String(value || '').trim();
  if (!token || /[\r\n]/.test(token) || token.length > 256) {
    throw new Error(`Invalid ${flag}: expected a non-empty single-line token`);
  }
  return token;
}

async function readQueueSnapshot(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Queue file must be a regular non-symlink file: ${file}`);
  }
  const bytes = await fs.readFile(file);
  const queue = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  return {
    bytes,
    queue,
    queueStateSha256: hashBytes(bytes),
  };
}

async function assertQueueMutationLockOwner(queuePath, token) {
  const lockPath = queueMutationLockPath(queuePath);
  let stat;
  try {
    stat = await fs.lstat(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new QueueMutationLockError(`queue mutation lock is not held: ${lockPath}`, QUEUE_MUTATION_LOCK_BUSY_CODE);
    }
    throw new QueueMutationLockError(`queue mutation lock could not be inspected: ${lockPath}: ${error.message}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new QueueMutationLockError(`queue mutation lock must be a real directory: ${lockPath}`);
  }
  let actualToken;
  try {
    actualToken = (await fs.readFile(path.join(lockPath, QUEUE_MUTATION_LOCK_OWNER), 'utf8')).trim();
  } catch (error) {
    throw new QueueMutationLockError(`queue mutation lock owner could not be read: ${lockPath}: ${error.message}`);
  }
  if (actualToken !== token) {
    throw new QueueMutationLockError(`queue mutation lock owner mismatch: ${lockPath}`, QUEUE_MUTATION_LOCK_BUSY_CODE);
  }
}

async function createQueueMutationLock(queuePath, token) {
  const lockPath = queueMutationLockPath(queuePath);
  await fs.mkdir(path.dirname(lockPath), {recursive: true});
  try {
    // The lock is deliberately a non-reclaimable directory. A process that
    // dies leaves an operator-visible lock and the next mutation fails closed.
    await fs.mkdir(lockPath, {mode: 0o700});
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new QueueMutationLockError(`queue mutation lock is already held: ${lockPath}`, QUEUE_MUTATION_LOCK_BUSY_CODE);
    }
    throw new QueueMutationLockError(`queue mutation lock could not be acquired: ${lockPath}: ${error.message}`);
  }
  try {
    await fs.writeFile(path.join(lockPath, QUEUE_MUTATION_LOCK_OWNER), `${token}\n`, {encoding: 'utf8', flag: 'wx', mode: 0o600});
  } catch (error) {
    try {
      await fs.rmdir(lockPath);
    } catch {
      // Do not broaden cleanup into recursive deletion. The lock remains a
      // visible recovery decision if this process cannot prove it is empty.
    }
    throw new QueueMutationLockError(`queue mutation lock owner could not be written: ${lockPath}: ${error.message}`);
  }
  return lockPath;
}

async function releaseQueueMutationLock(queuePath, token, {allowMissing = false} = {}) {
  const lockPath = queueMutationLockPath(queuePath);
  try {
    await assertQueueMutationLockOwner(queuePath, token);
    await fs.unlink(path.join(lockPath, QUEUE_MUTATION_LOCK_OWNER));
    await fs.rmdir(lockPath);
  } catch (error) {
    if (allowMissing && error?.code === QUEUE_MUTATION_LOCK_BUSY_CODE && /not held/.test(error.message)) return false;
    if (error instanceof QueueMutationLockError) throw error;
    throw new QueueMutationLockError(`queue mutation lock could not be released: ${lockPath}: ${error.message}`);
  }
  return true;
}

async function acquireQueueMutationLock(queuePath, requestedToken = '') {
  const token = requestedToken ? queueLockToken(requestedToken) : crypto.randomUUID();
  if (requestedToken) {
    await assertQueueMutationLockOwner(queuePath, token);
    return {token, ownedByCaller: true, release: async () => {}};
  }
  await createQueueMutationLock(queuePath, token);
  let released = false;
  return {
    token,
    ownedByCaller: false,
    release: async () => {
      if (released) return;
      await releaseQueueMutationLock(queuePath, token);
      released = true;
    },
  };
}

async function maybePauseBeforeQueueRename() {
  if (process.env.NODE_ENV !== 'test') return;
  const holdMs = Number(process.env.SHEIN_MARKETING_REPAIR_QUEUE_TEST_HOLD_BEFORE_RENAME_MS || 0);
  if (!Number.isSafeInteger(holdMs) || holdMs <= 0) return;
  const marker = String(process.env.SHEIN_MARKETING_REPAIR_QUEUE_TEST_BEFORE_RENAME_MARKER || '').trim();
  if (marker) {
    await fs.mkdir(path.dirname(marker), {recursive: true});
    await fs.writeFile(marker, `${process.pid}\n`, 'utf8');
  }
  await new Promise(resolve => setTimeout(resolve, holdMs));
}

function exactStageKey(storeKey, skc) {
  return `${String(storeKey || '').trim().toUpperCase()}::${String(skc || '').trim()}`;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeJsonAtomic(file, value, {expectedQueueStateSha256 = ''} = {}) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, bytes);
  try {
    await maybePauseBeforeQueueRename();
    if (expectedQueueStateSha256) {
      const current = await readQueueSnapshot(file);
      assertExpectedQueueState(current, expectedQueueStateSha256);
    }
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, {force: true}).catch(() => {});
  }
  return hashBytes(bytes);
}

function assertExpectedQueueState(snapshot, expectedStateSha256) {
  if (snapshot.queueStateSha256 !== expectedStateSha256) {
    throw new QueueCasConflictError(
      `Queue CAS conflict: expected queueStateSha256=${expectedStateSha256} actual queueStateSha256=${snapshot.queueStateSha256}; queue unchanged`,
    );
  }
}

function preserveStage(existing, next) {
  if (!existing || existing.inputFingerprint !== next.inputFingerprint) return next;
  if (String(existing.status || '') === 'pending' && existing.previousPartial) {
    return {...next, previousPartial: existing.previousPartial};
  }
  if (String(existing.status || '') === 'partial') {
    const partialAudit = {
      status: 'partial',
      readbackOk: existing.readbackOk ?? null,
      detail: existing.detail || '',
      resultPath: existing.resultPath || '',
      updatedAt: existing.updatedAt || '',
    };
    for (const key of [
      'checkpoint',
      'checkpoints',
      'completedItems',
      'completedKeys',
      'completedTuples',
      'processedItems',
      'processedKeys',
      'processedTuples',
      'successfulItems',
      'successfulKeys',
      'successfulTuples',
    ]) {
      if (existing[key] !== undefined) partialAudit[key] = existing[key];
    }
    return {
      ...next,
      ...existing,
      status: 'pending',
      previousPartial: partialAudit,
      inputFingerprint: next.inputFingerprint,
      updatedAt: next.updatedAt,
    };
  }
  if (!['completed', 'blocked', 'failed'].includes(String(existing.status || ''))) return next;
  return {...next, ...existing, inputFingerprint: next.inputFingerprint};
}

function queueStatusFromStages(stages, {empty = false, afterUpdate = false} = {}) {
  if (empty) return 'completed';
  const statuses = Object.values(stages).map(stage => String(stage?.status || 'pending'));
  if (statuses.some(status => status === 'partial')) return 'failed';
  if (statuses.some(status => status === 'failed')) return 'failed';
  const terminal = statuses.every(status => ['not_required', 'completed', 'blocked'].includes(status));
  if (!terminal) return 'pending';
  if (statuses.some(status => status === 'blocked')) return 'blocked';
  return afterUpdate ? 'awaiting_final_readback' : 'completed';
}

async function buildQueue(args) {
  const date = String(args.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid --date: ${date || 'missing'}`);
  const guardPath = path.resolve(ROOT, args.guard || `outputs/reports/marketing-daily-guard-${date}.json`);
  const manualPlanPath = path.resolve(ROOT, args.manualPlan || `tmp/marketing-signup/manual-limited-discount-restore/${date}/manual-limited-discount-restore-plan.json`);
  const highClickPlanPath = path.resolve(ROOT, args.highClickPlan || `outputs/reports/high-click-low-conversion-special-plan-${date}.json`);
  const driftPlanDir = path.resolve(ROOT, args.driftPlanDir || `tmp/marketing-signup/limited-discount-fallback/target-price-drift-${date}`);
  const fallbackPlanPath = path.resolve(ROOT, args.fallbackPlan || `outputs/reports/new-listing-7d-limited-discount-plan-${date}.json`);
  const queuePath = path.resolve(ROOT, args.queue || `state/cloud_marketing_live_guard/repair-queues/marketing-repair-${date}.json`);
  const guard = await readJson(guardPath);
  if (String(guard.reportDate || '') !== date) throw new Error(`Guard reportDate mismatch: expected=${date} actual=${guard.reportDate || 'missing'}`);

  const manualRows = Number(guard?.manualSpecialLimitedDiscount?.actionCount || 0);
  const highClickRows = Number(guard?.highClickLowConversionSpecial?.actionCount || 0);
  const rawDriftRows = Number((guard?.limitedDiscountTargetPriceDrift?.belowRows || []).length);
  const guardHash = await sha256File(guardPath);
  const highClick = await loadExactHighClickSpecialPlan({
    root: ROOT,
    planPath: highClickPlanPath,
    guardPath,
    date,
  });
  if (highClick.entries.length !== highClickRows) {
    throw new Error(`High-click queue row mismatch: guard=${highClickRows} plan=${highClick.entries.length}`);
  }
  const highClickKeys = new Set(highClick.entries.map(entry => entry.key));
  const driftGuardRows = Array.isArray(guard?.limitedDiscountTargetPriceDrift?.belowRows)
    ? guard.limitedDiscountTargetPriceDrift.belowRows
    : [];
  const driftKeysHandledByHighClickSpecial = driftGuardRows
    .map(row => exactStageKey(row?.storeKey || row?.store_key, row?.skc))
    .filter(key => key !== '::' && highClickKeys.has(key));
  const driftKeysHandledByHighClickSpecialUnique = [...new Set(driftKeysHandledByHighClickSpecial)].sort();
  const driftRowsHandledByHighClickSpecial = driftKeysHandledByHighClickSpecialUnique.length;
  const executableDriftRows = rawDriftRows - driftKeysHandledByHighClickSpecial.length;

  let manual = null;
  if (manualRows > 0) {
    manual = await loadExactManualRepairPlan({root: ROOT, planPath: manualPlanPath, guardPath, date});
    if (manual.entries.length !== manualRows) {
      throw new Error(`Manual queue row mismatch: guard=${manualRows} plan=${manual.entries.length}`);
    }
  }

  let drift = null;
  if (rawDriftRows > 0) {
    drift = await loadExactDriftRepairManifest({root: ROOT, planDir: driftPlanDir, guardPath, date});
    const manifestRows = drift.entries.reduce((sum, entry) => sum + Number(entry.count || 0), 0);
    if (manifestRows !== executableDriftRows) {
      throw new Error(
        `Drift queue row mismatch: guardBelowRows=${rawDriftRows} `
        + `handledByHighClickSpecial=${driftKeysHandledByHighClickSpecial.length} `
        + `expectedExecutable=${executableDriftRows} manifest=${manifestRows}`,
      );
    }
    const expectedExecutableDriftKeys = new Set(driftGuardRows
      .map(row => exactStageKey(row?.storeKey || row?.store_key, row?.skc))
      .filter(key => key !== '::' && !highClickKeys.has(key)));
    const manifestDriftKeys = new Set((drift.entries || []).flatMap(entry => entry.rescue.rows || [])
      .map(row => exactStageKey(row?.storeKey, row?.skc)));
    const unexpectedManifestKeys = [...manifestDriftKeys]
      .filter(key => !expectedExecutableDriftKeys.has(key))
      .sort();
    const missingManifestKeys = [...expectedExecutableDriftKeys]
      .filter(key => !manifestDriftKeys.has(key))
      .sort();
    if (unexpectedManifestKeys.length || missingManifestKeys.length) {
      throw new Error(
        `Drift queue key mismatch (not explained by high-click stage): `
        + `unexpected=${unexpectedManifestKeys.join(',') || '(none)'} `
        + `missing=${missingManifestKeys.join(',') || '(none)'}`,
      );
    }
  }

  const fallback = await loadExactFallbackRepairPlan({root: ROOT, planPath: fallbackPlanPath, guardPath, date});
  const fallbackRows = fallback.entries.reduce((sum, entry) => sum + Number(entry.count || 0), 0);
  const driftKeys = new Set((drift?.entries || []).flatMap(entry => entry.rescue.rows || [])
    .map(row => exactStageKey(row?.storeKey, row?.skc)));
  const fallbackKeys = new Set(fallback.entries.flatMap(entry => entry.rescue.rows || [])
    .map(row => exactStageKey(row?.storeKey, row?.skc)));
  const manualKeys = new Set((manual?.entries || []).map(entry => `${entry.storeKey}::${entry.skc}`));
  const allKeys = [...highClickKeys, ...manualKeys, ...driftKeys, ...fallbackKeys];
  const countsByKey = allKeys.reduce((acc, key) => acc.set(key, (acc.get(key) || 0) + 1), new Map());
  const overlappingWorkKeys = [...countsByKey.entries()].filter(([, count]) => count > 1).map(([key]) => key).sort();
  if (overlappingWorkKeys.length) {
    throw new Error(`Repair stages overlap on ${overlappingWorkKeys.length} exact store+SKC keys: ${overlappingWorkKeys.slice(0, 20).join(',')}`);
  }
  const mutationLock = await acquireQueueMutationLock(queuePath, args.queueLockToken || '');
  try {
    const existing = await readJson(queuePath).catch(error => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    const now = new Date().toISOString();
    const stageDefinitions = {
    highClickSpecial: {
      status: highClickRows > 0 ? 'pending' : 'not_required',
      rows: highClickRows,
      groups: highClick.entries.length,
      planPath: highClick.planRelativePath,
      inputFingerprint: hashJson({guardHash, workFingerprint: highClick.workFingerprint}),
      workFingerprint: highClick.workFingerprint,
      updatedAt: now,
    },
    manualSpecialRestore: {
      status: manualRows > 0 ? 'pending' : 'not_required',
      rows: manualRows,
      groups: manual?.entries.length || 0,
      planPath: manual?.planRelativePath || '',
      inputFingerprint: manual
        ? hashJson({guardHash, workFingerprint: manual.workFingerprint})
        : hashJson({guardHash, stage: 'manualSpecialRestore', manualRows: 0}),
      workFingerprint: manual?.workFingerprint || '',
      updatedAt: now,
    },
    driftRepair: {
      status: executableDriftRows > 0 ? 'pending' : 'not_required',
      rows: executableDriftRows,
      groups: drift?.entries.length || 0,
      planPath: drift?.manifestRelativePath || '',
      inputFingerprint: drift
        ? hashJson({guardHash, workFingerprint: drift.workFingerprint, executableDriftRows})
        : hashJson({guardHash, stage: 'driftRepair', executableDriftRows: 0}),
      workFingerprint: drift?.workFingerprint || '',
      updatedAt: now,
    },
    fallbackRepair: {
      status: fallbackRows > 0 ? 'pending' : 'not_required',
      rows: fallbackRows,
      groups: fallback.entries.length,
      planPath: fallback.planRelativePath,
      inputFingerprint: hashJson({guardHash, workFingerprint: fallback.workFingerprint}),
      workFingerprint: fallback.workFingerprint,
      updatedAt: now,
    },
    };
    const stages = Object.fromEntries(Object.entries(stageDefinitions).map(([name, stage]) => [
      name,
      preserveStage(existing?.stages?.[name], stage),
    ]));
    const totalRows = highClickRows + manualRows + executableDriftRows + fallbackRows;
    const totalGroups = stageDefinitions.highClickSpecial.groups + stageDefinitions.manualSpecialRestore.groups + stageDefinitions.driftRepair.groups + stageDefinitions.fallbackRepair.groups;
    const queue = {
    schemaVersion: 1,
    date,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    status: queueStatusFromStages(stages, {empty: totalRows === 0}),
    sourceGuard: rel(guardPath),
    sourceGuardHash: guardHash,
    queueFingerprint: hashJson({
      guardHash,
      stages: Object.fromEntries(Object.entries(stageDefinitions).map(([name, stage]) => [name, stage.inputFingerprint])),
    }),
    counts: {
      totalRows,
      totalGroups,
      highClickRows,
      highClickGroups: stageDefinitions.highClickSpecial.groups,
      manualRows,
      manualGroups: stageDefinitions.manualSpecialRestore.groups,
      driftRows: executableDriftRows,
      driftGroups: stageDefinitions.driftRepair.groups,
      driftRawRows: rawDriftRows,
      driftRowsHandledByHighClickSpecial,
      driftKeysHandledByHighClickSpecial: driftKeysHandledByHighClickSpecialUnique,
      fallbackRows,
      fallbackGroups: stageDefinitions.fallbackRepair.groups,
    },
    deduplication: {
      key: 'storeKey+skc',
      overlappingWorkKeys: 0,
      highClickPriorityExcludedDriftKeys: driftKeysHandledByHighClickSpecialUnique,
    },
    stages,
    };
    const queueStateSha256 = await writeJsonAtomic(queuePath, queue);
    console.log(JSON.stringify({
      ok: true,
      queue: rel(queuePath),
      status: queue.status,
      counts: queue.counts,
      queueFingerprint: queue.queueFingerprint,
      sourceGuardHash: queue.sourceGuardHash,
      queueStateSha256,
    }, null, 2));
  } finally {
    await mutationLock.release();
  }
}

async function updateStage(args) {
  const queuePath = path.resolve(ROOT, args.queue || '');
  if (!args.queue) throw new Error('Missing --queue');
  const stageName = String(args.stage || '');
  const status = String(args.status || '');
  if (!stageName || !status) throw new Error('Missing --stage or --status');
  if (!['pending', 'completed', 'blocked', 'failed', 'partial'].includes(status)) {
    throw new Error(`Unsupported --status for queue stage: ${status}`);
  }
  const expected = expectedQueuePair(args);
  const expectedStateSha256 = expectedQueueStateSha256(args);
  const mutationLock = await acquireQueueMutationLock(queuePath, args.queueLockToken || '');
  try {
    const snapshot = await readQueueSnapshot(queuePath);
    assertExpectedQueuePair(snapshot.queue, expected);
    assertExpectedQueueState(snapshot, expectedStateSha256);
    if (!snapshot.queue.stages?.[stageName]) throw new Error(`Unknown queue stage: ${stageName}`);
    const currentQueue = snapshot.queue;
    currentQueue.stages[stageName] = {
      ...currentQueue.stages[stageName],
      status,
      readbackOk: String(args.readbackOk || 'false') === 'true',
      detail: String(args.detail || ''),
      resultPath: String(args.resultPath || ''),
      updatedAt: new Date().toISOString(),
    };
    currentQueue.status = queueStatusFromStages(currentQueue.stages, {afterUpdate: true});
    currentQueue.updatedAt = new Date().toISOString();
    const queueStateSha256 = await writeJsonAtomic(queuePath, currentQueue, {expectedQueueStateSha256: expectedStateSha256});
    console.log(JSON.stringify({
      ok: true,
      queue: rel(queuePath),
      stage: stageName,
      status,
      queueStatus: currentQueue.status,
      queueFingerprint: currentQueue.queueFingerprint,
      sourceGuardHash: currentQueue.sourceGuardHash,
      queueStateSha256,
    }, null, 2));
  } finally {
    if (!mutationLock.ownedByCaller) await mutationLock.release();
  }
}

async function handoffLocal(args) {
  const queuePath = path.resolve(ROOT, args.queue || '');
  if (!args.queue) throw new Error('Missing --queue');
  const expected = expectedQueuePair(args);
  const expectedStateSha256 = expectedQueueStateSha256(args);
  const mutationLock = await acquireQueueMutationLock(queuePath, args.queueLockToken || '');
  try {
    const snapshot = await readQueueSnapshot(queuePath);
    assertExpectedQueuePair(snapshot.queue, expected);
    assertExpectedQueueState(snapshot, expectedStateSha256);
    const currentQueue = snapshot.queue;
    if (['completed', 'blocked'].includes(String(currentQueue.status || ''))) {
      console.log(JSON.stringify({
        ok: true,
        queue: rel(queuePath),
        status: currentQueue.status,
        unchanged: true,
        queueFingerprint: currentQueue.queueFingerprint,
        sourceGuardHash: currentQueue.sourceGuardHash,
        queueStateSha256: snapshot.queueStateSha256,
      }, null, 2));
      return;
    }
    if (Object.values(currentQueue.stages || {}).some(stage => String(stage?.status || '') === 'failed')) {
      throw new Error('Cannot hand off a queue with failed stages; rebuild the exact queue first');
    }
    currentQueue.status = 'deferred_to_local';
    currentQueue.handoff = {
      location: 'local',
      reason: String(args.reason || 'cloud marketing writes are disabled'),
      handedOffAt: new Date().toISOString(),
    };
    currentQueue.updatedAt = new Date().toISOString();
    const queueStateSha256 = await writeJsonAtomic(queuePath, currentQueue, {expectedQueueStateSha256: expectedStateSha256});
    console.log(JSON.stringify({
      ok: true,
      queue: rel(queuePath),
      status: currentQueue.status,
      counts: currentQueue.counts,
      queueFingerprint: currentQueue.queueFingerprint,
      sourceGuardHash: currentQueue.sourceGuardHash,
      queueStateSha256,
    }, null, 2));
  } finally {
    if (!mutationLock.ownedByCaller) await mutationLock.release();
  }
}

async function acquireQueueLockCommand(args) {
  if (!args.queue) throw new Error('Missing --queue');
  const queuePath = path.resolve(ROOT, args.queue);
  const token = queueLockToken(args.queueLockToken);
  const lockPath = await createQueueMutationLock(queuePath, token);
  console.log(JSON.stringify({ok: true, queue: rel(queuePath), queueLockPath: lockPath, queueLockToken: token}, null, 2));
}

async function releaseQueueLockCommand(args) {
  if (!args.queue) throw new Error('Missing --queue');
  const queuePath = path.resolve(ROOT, args.queue);
  const token = queueLockToken(args.queueLockToken);
  const released = await releaseQueueMutationLock(queuePath, token, {allowMissing: true});
  console.log(JSON.stringify({ok: true, queue: rel(queuePath), released}, null, 2));
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (['inspect-artifacts', 'export-artifacts', 'import-artifacts'].includes(args.command)) {
    let inspected;
    if (args.command === 'import-artifacts') {
      if (!args.bundle || !args.destination) throw new Error('Missing --bundle or --destination');
      inspected = await importMarketingRepairArtifacts({bundleFile: args.bundle, destination: args.destination});
    } else {
      if (!args.queue) throw new Error('Missing --queue');
      if (args.command === 'export-artifacts' && !args.out) throw new Error('Missing --out');
      const options = {root: args.root ? path.resolve(args.root) : ROOT, queue: args.queue, out: args.out};
      inspected = args.command === 'export-artifacts'
        ? await exportMarketingRepairArtifacts(options) : await inspectMarketingRepairArtifacts(options);
    }
    console.log(JSON.stringify({...inspected, files: inspected.files.map(({logicalPath, sizeBytes, sha256}) => ({logicalPath, sizeBytes, sha256}))}, null, 2));
  }
  else if (args.command === 'build') await buildQueue(args);
  else if (args.command === 'update-stage') await updateStage(args);
  else if (args.command === 'handoff-local') await handoffLocal(args);
  else if (args.command === 'acquire-lock') await acquireQueueLockCommand(args);
  else if (args.command === 'release-lock') await releaseQueueLockCommand(args);
  else throw new Error(`Unknown command: ${args.command}`);
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = error?.code === QUEUE_CAS_CONFLICT_CODE
    ? 73
    : [QUEUE_MUTATION_LOCK_BUSY_CODE, QUEUE_MUTATION_LOCK_FAILED_CODE].includes(error?.code)
      ? 75
      : 1;
}
