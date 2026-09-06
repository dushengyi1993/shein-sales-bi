import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolveResultEvidenceArtifact} from '../scripts/inventory/daily_inventory_version_publisher.mjs';

const dateInChina = () => new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());
const fail = (code, message) => Object.assign(new Error(message), {code});
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

export function inventoryMaintenanceRequest(body = {}, {today = dateInChina()} = {}) {
  const commandId = String(body.commandId || '').trim();
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(commandId)) throw fail('INVALID_COMMAND_ID', 'commandId must contain 1-160 safe characters');
  const date = String(body.date || today);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date + 'T12:00:00Z').toISOString().slice(0, 10) !== date) {
    throw fail('INVALID_INVENTORY_DATE', 'date must be a valid YYYY-MM-DD');
  }
  const maxRows = Number(body.maxRows ?? 1000);
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 1000) throw fail('INVALID_MAX_ROWS', 'maxRows must be 1-1000');
  // Force/recheck never changes a request identity. A new command always makes a new plan.
  return {kind: 'inventory_maintenance', commandId, date, dryRun: body.dryRun === true || body.mode === 'dry-run', maxRows};
}

export async function enqueueInventoryMaintenance({store, actor, body = {}} = {}) {
  const ownerUser = String(typeof actor === 'string' ? actor : actor?.username || actor?.user || '').trim();
  if (!ownerUser) throw fail('INVENTORY_OWNER_REQUIRED', 'A concrete authenticated owner is required');
  if (typeof store?.enqueueJob !== 'function' || typeof store?.getJob !== 'function') throw new TypeError('A durable job store is required');
  const payload = inventoryMaintenanceRequest(body);
  const identity = digest(JSON.stringify([ownerUser, payload.commandId]));
  const id = 'job_inventory_' + identity.slice(0, 40);
  const queued = await store.enqueueJob({
    id, kind: payload.kind, ownerUser, actorUser: ownerUser, writeBoundary: 'none', payload,
  }, {ownerUser, actorUser: ownerUser, idempotencyKey: 'inventory-maintenance:' + identity});
  // Repository idempotency receipts may retain the initial queued projection.
  // Return the current authoritative job, including running/terminal/uncertain.
  const current = await store.getJob(queued.jobId || queued.id || id);
  if (!current || current.ownerUser !== ownerUser) throw fail('INVENTORY_JOB_READBACK_FAILED', 'Queued inventory job could not be read back for its owner');
  return current;
}

export function inventoryJobBatchId(job) {
  return 'job-' + digest(String(job.jobId || job.id)).slice(0, 40);
}

/** Own the complete process group until every descendant is stopped.
 * Linux is mandatory for production; Windows only enqueues via the HTTP CLI.
 */
export async function runInventoryGuardProcess({
  root,
  env,
  signal,
  spawnProcess = spawn,
  timeoutMs = 3_600_000,
  stopGraceMs = 5000,
  scriptPath = null,
  killProcessGroup = null,
  isGroupAlive = null,
  pollIntervalMs = 50,
  killTimeoutMs = 10_000,
}) {
  if (signal?.aborted) throw signal.reason || fail('JOB_LEASE_LOST', 'Inventory job lease lost before dispatch');

  const targetScript = scriptPath || path.join(root, 'scripts', 'cloud_daily_inventory_replenishment_guard.sh');
  const child = spawnProcess('bash', [targetScript], {
    cwd: root, env, detached: true, stdio: ['ignore', 'ignore', 'ignore'],
  });
  const pgid = child.pid;
  let stoppingError = null;
  let settled = false;
  let cleanupPromise = null;

  const sendSignalToGroup = sig => {
    if (!pgid) return;
    if (typeof killProcessGroup === 'function') {
      return killProcessGroup(pgid, sig);
    }
    try {
      process.kill(-pgid, sig);
    } catch (err) {
      if (err?.code !== 'ESRCH') throw err;
    }
  };

  const checkGroupAlive = () => {
    if (!pgid) return false;
    if (typeof isGroupAlive === 'function') {
      return isGroupAlive(pgid);
    }
    try {
      process.kill(-pgid, 0);
    } catch (err) {
      if (err?.code === 'ESRCH') return false;
      if (err?.code === 'EPERM') return true;
      throw err;
    }

    if (process.platform === 'linux') {
      try {
        const pids = fsSync.readdirSync('/proc');
        let foundAnyInGroup = false;
        let foundExecutableInGroup = false;

        for (const p of pids) {
          if (!/^[0-9]+$/.test(p)) continue;
          try {
            const stat = fsSync.readFileSync('/proc/' + p + '/stat', 'utf8');
            const idx = stat.lastIndexOf(')');
            if (idx === -1) continue;
            const rest = stat.substring(idx + 2).split(' ');
            const state = rest[0];
            const pgrp = rest[2];
            if (pgrp === String(pgid)) {
              foundAnyInGroup = true;
              if (state !== 'Z' && state !== 'X') {
                foundExecutableInGroup = true;
                break;
              }
            }
          } catch {}
        }

        if (foundAnyInGroup && !foundExecutableInGroup) {
          return false;
        }
        if (foundExecutableInGroup) return true;
      } catch {}
    }

    return true;
  };

  function ensureDescendantsTerminated(initialReason = null) {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      if (!pgid) return;
      const alive = checkGroupAlive();
      if (!alive && !initialReason) return;

      try {
        sendSignalToGroup('SIGTERM');
      } catch {}

      const termDeadline = performance.now() + stopGraceMs;
      while (performance.now() < termDeadline) {
        if (!checkGroupAlive()) return;
        await new Promise(r => setTimeout(r, pollIntervalMs));
      }

      try {
        sendSignalToGroup('SIGKILL');
      } catch {}

      const killDeadline = performance.now() + killTimeoutMs;
      while (performance.now() < killDeadline) {
        if (!checkGroupAlive()) return;
        try {
          sendSignalToGroup('SIGKILL');
        } catch {}
        await new Promise(r => setTimeout(r, pollIntervalMs));
      }

      if (checkGroupAlive()) {
        const stuckError = fail(
          'INVENTORY_GUARD_PROCESS_GROUP_STUCK',
          'Process group ' + pgid + ' could not be terminated within ' + killTimeoutMs + 'ms; possible D-state descendant. Automatic retry is strictly disabled.',
        );
        stuckError.cause = initialReason;
        throw stuckError;
      }
    })();
    return cleanupPromise;
  }

  return new Promise((resolve, reject) => {
    let timeoutTimer = null;

    const stop = async error => {
      if (stoppingError || settled) return;
      stoppingError = error;
      try {
        await ensureDescendantsTerminated(error);
      } catch (termError) {
        stoppingError = termError;
      }
      void finish(stoppingError);
    };

    const onAbort = () => {
      void stop(signal.reason || fail('JOB_LEASE_LOST', 'Inventory job lease lost'));
    };

    timeoutTimer = setTimeout(() => {
      void stop(fail('INVENTORY_GUARD_TIMEOUT', 'Inventory guard exceeded its run deadline'));
    }, timeoutMs);

    signal?.addEventListener('abort', onAbort, {once: true});

    const finish = async (error, status) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      signal?.removeEventListener('abort', onAbort);

      try {
        if (stoppingError) {
          await ensureDescendantsTerminated(stoppingError);
        } else if (checkGroupAlive()) {
          await ensureDescendantsTerminated();
        }
      } catch (cleanupError) {
        error = error || cleanupError;
      }

      if (error || stoppingError) reject(error || stoppingError);
      else resolve({status});
    };

    child.once('error', error => void finish(error));
    child.once('close', (status, childSignal) => void finish(
      childSignal && !stoppingError ? fail('INVENTORY_GUARD_SIGNAL', 'Inventory guard terminated by signal ' + childSignal) : null,
      status,
    ));

    if (signal?.aborted) onAbort();
  });
}

export async function runInventoryMaintenanceJob(job, context, {
  root = process.env.SHEIN_BI_ROOT || '/opt/shein-bi/app',
  inventoryRuntimeRoot = process.env.SHEIN_BI_INVENTORY_RUNTIME_ROOT || '/srv/shein-bi/runtime/daily-inventory-replenishment',
  runGuard = runInventoryGuardProcess,
  resolveEvidence = resolveResultEvidenceArtifact,
  platform = process.platform,
  now = () => Date.now(),
  loadPolicy = async () => JSON.parse(await fs.readFile(path.join(root, 'config', 'inventory_replenishment_policy.json'), 'utf8')),
} = {}) {
  if (platform !== 'linux') throw fail('CLOUD_INVENTORY_REQUIRED', 'Inventory execution requires the managed Linux cloud runner');
  if (typeof context?.advanceWriteBoundary !== 'function' || typeof context?.checkLeaseAsync !== 'function' || !context.signal) {
    throw fail('INVENTORY_LEASE_CONTEXT_REQUIRED', 'Durable job lease and write-boundary context are required');
  }
  const request = inventoryMaintenanceRequest(job.payload);
  if (request.date !== dateInChina()) throw fail('INVENTORY_DATE_EXPIRED', 'Inventory maintenance must execute against the current China business day; use a new command');
  const previous = new Date(request.date + 'T12:00:00Z');
  previous.setUTCDate(previous.getUTCDate() - 1);
  const batchId = inventoryJobBatchId(job);
  const policy = await loadPolicy();
  const contextName = 'cloud_daily_inventory_replenishment_guard';
  const automatic = policy?.execution?.automaticExecution;
  const authorizationId = automatic?.authorizationByContext?.[contextName] || (automatic?.allowedContext === contextName ? automatic.authorizationId : '');
  if (automatic?.enabled !== true || !authorizationId || policy?.execution?.perRunUserConfirmationRequired !== false) {
    throw fail('INVENTORY_AUTOMATIC_AUTHORIZATION_MISSING', 'Current inventory policy does not authorize the managed automatic guard');
  }
  await context.checkLeaseAsync();
  // Readback supports a crash after immutable publication but before finishJob.
  const prior = await resolveEvidence({inventoryRuntimeRoot, date: request.date, batchId, commandId: request.commandId});
  if (prior) return projectInventoryEvidence(prior, request);
  const startedAt = now();
  const env = {
    ...process.env, SHEIN_BI_ROOT: root,
    SHEIN_BI_INVENTORY_AUTOMATION_CONTEXT: contextName,
    SHEIN_BI_INVENTORY_AUTOMATION_AUTHORIZATION: authorizationId,
    SHEIN_BI_INVENTORY_RUNTIME_ROOT: inventoryRuntimeRoot,
    SHEIN_BI_INVENTORY_RUN_DATE: request.date,
    SHEIN_BI_INVENTORY_BUSINESS_DATE: previous.toISOString().slice(0, 10),
    SHEIN_BI_INVENTORY_MAX_ROWS: String(request.maxRows),
    SHEIN_BI_INVENTORY_COMMAND_ID: request.commandId,
    SHEIN_BI_INVENTORY_BATCH_ID: batchId,
    SHEIN_BI_INVENTORY_FORCE_RECHECK: '1',
    SHEIN_BI_INVENTORY_DRY_RUN: request.dryRun ? '1' : '0',
    SHEIN_BI_INVENTORY_LOCK_WAIT_SECONDS: '300',
    SHEIN_BI_INVENTORY_RUN_DEADLINE_EPOCH: String(Math.floor(startedAt / 1000) + 3600),
    SHEIN_BI_INVENTORY_STOCK_NOT_BEFORE: new Date(startedAt - 1800_000).toISOString(),
    SHEIN_BI_INVENTORY_REFRESH_TOKEN: 'inventory-job:' + batchId,
  };
  // Confirm the durable irreversible boundary before starting any guard child.
  await context.advanceWriteBoundary(request.dryRun ? 'read_only' : 'inventory_guard_dispatched');
  context.checkLease?.();
  let outcome;
  let guardError;
  try { outcome = await runGuard({root, env, signal: context.signal}); } catch (error) { guardError = error; }
  await context.checkLeaseAsync();
  const evidence = await resolveEvidence({inventoryRuntimeRoot, date: request.date, batchId, commandId: request.commandId});
  if (evidence) return projectInventoryEvidence(evidence, request);
  const error = fail('INVENTORY_GUARD_UNCERTAIN', 'Inventory guard has no complete verified artifact set for this command; no automatic business retry');
  error.uncertainWrite = !request.dryRun;
  error.cause = guardError;
  error.guardExitStatus = outcome?.status ?? null;
  throw error;
}

function projectInventoryEvidence(evidence, request) {
  if ((evidence.status === 'dry_run_ready' && !request.dryRun)
    || (request.dryRun && ['done', 'warning'].includes(evidence.status))
    || (typeof evidence.execute === 'boolean' && evidence.execute === request.dryRun)) {
    throw fail('INVENTORY_EVIDENCE_MODE_CONFLICT', 'Immutable command mode differs from this request; use a new command ID under the existing user authorization');
  }
  return {
    ok: evidence.status === 'done' || evidence.status === 'dry_run_ready',
    state: evidence.status === 'dry_run_ready' ? 'dry_run_completed' : evidence.status === 'done' ? 'completed' : evidence.status === 'warning' ? 'completed_with_warning' : evidence.status,
    commandId: request.commandId, batchId: evidence.batchId, version: evidence.version,
    status: evidence.status, dryRun: request.dryRun, planHash: evidence.planHash, counts: evidence.counts,
  };
}
