import crypto from 'node:crypto';

const ALLOWED_MINIMUM_SOURCES = new Set([
  'activity_live_page',
  'query_goods',
  'dry_run',
  'ordinary_activity_query_supplier_goods_list_v2',
  'limited_discount_dry_run',
]);

export function normalizeActivityStockSnapshot(value = {}) {
  const totalInventoryQuantity = nonNegativeInteger(value.totalInventoryQuantity, 'totalInventoryQuantity');
  const totalUsableInventory = nonNegativeInteger(value.totalUsableInventory, 'totalUsableInventory');
  const totalLockedQuantity = nonNegativeInteger(value.totalLockedQuantity, 'totalLockedQuantity');
  if (totalUsableInventory > totalInventoryQuantity) {
    throw new Error(`Invalid stock snapshot: usable ${totalUsableInventory} exceeds total ${totalInventoryQuantity}`);
  }
  return {
    skuCode: String(value.skuCode || '').trim(),
    totalInventoryQuantity,
    totalUsableInventory,
    totalLockedQuantity,
  };
}

export function activityStockUnavailable(snapshot) {
  const normalized = normalizeActivityStockSnapshot(snapshot);
  return Math.max(
    normalized.totalLockedQuantity,
    normalized.totalInventoryQuantity - normalized.totalUsableInventory,
  );
}

export function computeActivityStockOverwriteQuantity(targetUsableInventory, snapshot) {
  const target = positiveInteger(targetUsableInventory, 'targetUsableInventory');
  return target + activityStockUnavailable(snapshot);
}

export function activityInventoryTargetKey(target = {}) {
  return [
    String(target.storeKey || '').trim().toUpperCase(),
    String(target.skc || '').trim().toLowerCase(),
    String(target.skuCode || '').trim(),
  ].join('::');
}

export function buildActivityInventoryIdempotencyKey({
  transactionHash,
  target,
  phase,
  overwriteQuantity,
  attempt,
}) {
  const source = JSON.stringify({
    transactionHash: normalizedHash(transactionHash),
    targetKey: activityInventoryTargetKey(target),
    phase: String(phase || ''),
    overwriteQuantity: positiveInteger(overwriteQuantity, 'overwriteQuantity'),
    attempt: positiveInteger(attempt, 'attempt'),
  });
  return `bi-marketing-activity-inventory-${crypto.createHash('sha256').update(source).digest('hex')}`.slice(0, 120);
}

export function normalizeActivityInventoryTargets(targets = []) {
  const normalized = [];
  const seen = new Set();
  for (const raw of targets || []) {
    const target = {
      storeKey: String(raw?.storeKey || '').trim().toUpperCase(),
      skc: String(raw?.skc || '').trim(),
      skuCode: String(raw?.skuCode || '').trim(),
      minimumUsableInventory: positiveInteger(raw?.minimumUsableInventory, 'minimumUsableInventory'),
      minimumSource: String(raw?.minimumSource || '').trim(),
      minimumEvidence: raw?.minimumEvidence || null,
      canonical: String(raw?.canonical || '').trim(),
    };
    if (!target.storeKey || !target.skc || !target.skuCode) {
      throw new Error('Activity inventory target requires storeKey, skc and skuCode');
    }
    if (!ALLOWED_MINIMUM_SOURCES.has(target.minimumSource)) {
      throw new Error(`Unsupported activity inventory minimum source: ${target.minimumSource || '(missing)'}`);
    }
    const key = activityInventoryTargetKey(target);
    if (seen.has(key)) throw new Error(`Duplicate activity inventory target: ${key}`);
    seen.add(key);
    normalized.push({...target, key});
  }
  return normalized.sort((a, b) => a.key.localeCompare(b.key));
}

export async function planActivityInventoryTransaction({
  targets,
  readStock,
  transactionHash,
  now = () => new Date(),
}) {
  const normalizedTargets = normalizeActivityInventoryTargets(targets);
  if (typeof readStock !== 'function') throw new Error('readStock callback is required');
  const plannedAt = isoNow(now);
  const rows = [];
  const blockers = [];
  for (const target of normalizedTargets) {
    try {
      const before = normalizeActivityStockSnapshot(await readStock(target));
      const requiresTemporaryRaise = before.totalUsableInventory < target.minimumUsableInventory;
      rows.push({
        ...target,
        before,
        requiresTemporaryRaise,
        temporaryOverwriteQuantity: requiresTemporaryRaise
          ? computeActivityStockOverwriteQuantity(target.minimumUsableInventory, before)
          : null,
        restoreTargetUsableInventory: before.totalUsableInventory,
      });
    } catch (error) {
      blockers.push({
        key: target.key,
        storeKey: target.storeKey,
        skc: target.skc,
        skuCode: target.skuCode,
        reason: 'live_stock_read_failed',
        error: error.message,
      });
    }
  }
  return {
    schemaVersion: 1,
    transactionHash: normalizedHash(transactionHash),
    mode: 'dry-run',
    plannedAt,
    ok: blockers.length === 0,
    ready: blockers.length === 0,
    writeAttempted: false,
    submitAttempted: false,
    rows,
    blockers,
  };
}

export async function runActivityInventoryTransaction({
  targets,
  transactionHash,
  acquireLock,
  readStock,
  writeStock,
  submit,
  readEnrollment,
  validateEnrollment = defaultEnrollmentValidator,
  now = () => new Date(),
  sleep = defaultSleep,
  maxWriteAttempts = 2,
  readbackAttempts = 4,
  readbackDelayMs = 250,
}) {
  const normalizedTargets = normalizeActivityInventoryTargets(targets);
  normalizedHash(transactionHash);
  for (const [name, callback] of Object.entries({acquireLock, readStock, writeStock, submit, readEnrollment})) {
    if (typeof callback !== 'function') throw new Error(`${name} callback is required`);
  }
  const startedAt = isoNow(now);
  const startedMs = dateMs(startedAt);
  const evidence = {
    schemaVersion: 1,
    transactionHash: normalizedHash(transactionHash),
    mode: 'execute',
    startedAt,
    restoredAt: null,
    durationMs: null,
    ok: false,
    safe: false,
    submitAttempted: false,
    writeAttempted: false,
    rows: [],
    submit: null,
    enrollmentReadback: null,
    enrollmentAfterRestore: null,
    blockers: [],
  };
  const locks = [];
  const rowByKey = new Map();
  let submitError = null;

  try {
    for (const target of normalizedTargets) {
      const release = await acquireLock(target);
      if (typeof release !== 'function') throw new Error(`Lock callback did not return a release function: ${target.key}`);
      locks.push({target, release});
    }

    for (const target of normalizedTargets) {
      const before = normalizeActivityStockSnapshot(await readStock(target));
      const row = {
        ...target,
        before,
        temporaryRaise: null,
        beforeSubmit: null,
        restoreAttempt: null,
        afterRestore: null,
        restoreOk: false,
      };
      evidence.rows.push(row);
      rowByKey.set(target.key, row);
      if (before.totalUsableInventory >= target.minimumUsableInventory) continue;
      const overwriteQuantity = computeActivityStockOverwriteQuantity(target.minimumUsableInventory, before);
      const temporaryRaise = await writeAndReadExact({
        target,
        desiredUsableInventory: target.minimumUsableInventory,
        overwriteQuantity,
        phase: 'temporary_raise',
        transactionHash,
        writeStock,
        readStock,
        now,
        sleep,
        maxWriteAttempts,
        readbackAttempts,
        readbackDelayMs,
      });
      evidence.writeAttempted = evidence.writeAttempted || temporaryRaise.writeAttempted;
      row.temporaryRaise = temporaryRaise;
      if (!temporaryRaise.ok) {
        evidence.blockers.push({
          key: target.key,
          reason: 'temporary_raise_failed',
          error: temporaryRaise.error || '',
        });
        throw new Error(`Temporary activity inventory raise failed for ${target.key}: ${temporaryRaise.error || 'readback mismatch'}`);
      }
    }

    for (const target of normalizedTargets) {
      const beforeSubmit = normalizeActivityStockSnapshot(await readStock(target));
      rowByKey.get(target.key).beforeSubmit = beforeSubmit;
      if (beforeSubmit.totalUsableInventory < target.minimumUsableInventory) {
        throw new Error(
          `Activity inventory dropped below live minimum before submit for ${target.key}: `
          + `${beforeSubmit.totalUsableInventory} < ${target.minimumUsableInventory}`,
        );
      }
    }

    evidence.submitAttempted = true;
    try {
      const result = await submit({transactionHash: evidence.transactionHash, rows: evidence.rows});
      evidence.submit = {
        ok: result?.ok !== false,
        result: result ?? null,
        finishedAt: isoNow(now),
      };
      if (result?.ok === false) throw new Error(result.error || result.reason || 'activity submit returned ok=false');
      evidence.enrollmentReadback = await readEnrollment({
        phase: 'after_submit_before_restore',
        transactionHash: evidence.transactionHash,
        submitResult: result,
      });
      const enrollment = validateEnrollment(evidence.enrollmentReadback, {
        phase: 'after_submit_before_restore',
        submitResult: result,
      });
      if (!enrollment?.ok) {
        throw new Error(enrollment?.reason || 'activity enrollment readback failed before inventory restore');
      }
    } catch (error) {
      submitError = error;
      if (!evidence.submit) {
        evidence.submit = {ok: false, error: error.message, finishedAt: isoNow(now)};
      } else {
        evidence.submit.ok = false;
        evidence.submit.error = error.message;
      }
    }
  } catch (error) {
    submitError = submitError || error;
  } finally {
    for (const target of [...normalizedTargets].reverse()) {
      const row = rowByKey.get(target.key);
      if (!row?.temporaryRaise?.writeAttempted) {
        if (row) {
          row.afterRestore = row.before;
          row.restoreOk = true;
        }
        continue;
      }
      try {
        const beforeRestore = normalizeActivityStockSnapshot(await readStock(target));
        const overwriteQuantity = computeActivityStockOverwriteQuantity(
          row.before.totalUsableInventory,
          beforeRestore,
        );
        const restoreAttempt = await writeAndReadExact({
          target,
          desiredUsableInventory: row.before.totalUsableInventory,
          overwriteQuantity,
          phase: 'restore',
          transactionHash,
          writeStock,
          readStock,
          now,
          sleep,
          maxWriteAttempts,
          readbackAttempts,
          readbackDelayMs,
        });
        row.restoreAttempt = {
          ...restoreAttempt,
          beforeRestore,
          lockedQuantityChanged: beforeRestore.totalLockedQuantity !== row.before.totalLockedQuantity,
          unavailableChanged: activityStockUnavailable(beforeRestore) !== activityStockUnavailable(row.before),
        };
        row.afterRestore = restoreAttempt.after;
        row.restoreOk = restoreAttempt.ok
          && restoreAttempt.after?.totalUsableInventory === row.before.totalUsableInventory;
        if (!row.restoreOk) {
          evidence.blockers.push({
            key: target.key,
            reason: 'restore_failed_or_original_usable_not_exact',
            expectedUsable: row.before.totalUsableInventory,
            actualUsable: restoreAttempt.after?.totalUsableInventory ?? null,
            error: restoreAttempt.error || '',
          });
        }
      } catch (error) {
        row.restoreAttempt = {ok: false, error: error.message};
        row.restoreOk = false;
        evidence.blockers.push({key: target.key, reason: 'restore_failed', error: error.message});
      }
    }

    if (evidence.submitAttempted) {
      try {
        evidence.enrollmentAfterRestore = await readEnrollment({
          phase: 'after_restore',
          transactionHash: evidence.transactionHash,
          submitResult: evidence.submit?.result,
        });
        const enrollment = validateEnrollment(evidence.enrollmentAfterRestore, {
          phase: 'after_restore',
          submitResult: evidence.submit?.result,
        });
        if (!enrollment?.ok) {
          evidence.blockers.push({
            reason: 'activity_invalid_or_withdrawn_after_inventory_restore',
            error: enrollment?.reason || 'post-restore enrollment readback failed',
          });
        }
      } catch (error) {
        evidence.blockers.push({reason: 'post_restore_enrollment_read_failed', error: error.message});
      }
    }

    for (const {target, release} of locks.reverse()) {
      try {
        await release();
      } catch (error) {
        evidence.blockers.push({key: target.key, reason: 'inventory_lock_release_failed', error: error.message});
      }
    }
    evidence.restoredAt = isoNow(now);
    evidence.durationMs = Math.max(0, dateMs(evidence.restoredAt) - startedMs);
  }

  if (submitError) {
    evidence.blockers.push({reason: 'submit_or_pre_submit_failed', error: submitError.message});
  }
  const restoredExactly = evidence.rows.every(row => row.restoreOk === true);
  const postRestoreEnrollment = !evidence.submitAttempted
    || validateEnrollment(evidence.enrollmentAfterRestore, {
      phase: 'after_restore',
      submitResult: evidence.submit?.result,
    })?.ok === true;
  evidence.ok = !submitError
    && evidence.submit?.ok === true
    && restoredExactly
    && postRestoreEnrollment
    && evidence.blockers.length === 0;
  evidence.safe = restoredExactly && postRestoreEnrollment;
  return evidence;
}

async function writeAndReadExact({
  target,
  desiredUsableInventory,
  overwriteQuantity,
  phase,
  transactionHash,
  writeStock,
  readStock,
  now,
  sleep,
  maxWriteAttempts,
  readbackAttempts,
  readbackDelayMs,
}) {
  const result = {
    phase,
    desiredUsableInventory,
    overwriteQuantity,
    startedAt: isoNow(now),
    finishedAt: null,
    writeAttempted: false,
    attempts: [],
    after: null,
    ok: false,
    error: '',
  };
  for (let writeAttempt = 1; writeAttempt <= maxWriteAttempts; writeAttempt += 1) {
    const idempotencyKey = buildActivityInventoryIdempotencyKey({
      transactionHash,
      target,
      phase,
      overwriteQuantity,
      attempt: writeAttempt,
    });
    let response;
    try {
      result.writeAttempted = true;
      response = await writeStock({
        target,
        overwriteQuantity,
        desiredUsableInventory,
        phase,
        writeAttempt,
        idempotencyKey,
      });
      if (response?.ok === false) throw new Error(response.error || response.message || 'inventory write returned ok=false');
    } catch (error) {
      result.attempts.push({writeAttempt, idempotencyKey, write: {ok: false, error: error.message}, readbacks: []});
      result.error = error.message;
      continue;
    }
    const attempt = {writeAttempt, idempotencyKey, write: response ?? {ok: true}, readbacks: []};
    result.attempts.push(attempt);
    for (let readAttempt = 1; readAttempt <= readbackAttempts; readAttempt += 1) {
      try {
        const after = normalizeActivityStockSnapshot(await readStock(target));
        attempt.readbacks.push({readAttempt, ok: true, stock: after});
        result.after = after;
        if (after.totalUsableInventory === desiredUsableInventory) {
          result.ok = true;
          result.error = '';
          result.finishedAt = isoNow(now);
          return result;
        }
      } catch (error) {
        attempt.readbacks.push({readAttempt, ok: false, error: error.message});
        result.error = error.message;
      }
      if (readAttempt < readbackAttempts) await sleep(readbackDelayMs);
    }
    result.error = result.error
      || `inventory readback usable ${result.after?.totalUsableInventory ?? 'missing'} did not equal ${desiredUsableInventory}`;
  }
  result.finishedAt = isoNow(now);
  return result;
}

function defaultEnrollmentValidator(value) {
  if (value?.ok === true) return {ok: true};
  return {ok: false, reason: value?.reason || value?.error || 'enrollment readback did not return ok=true'};
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`);
  return number;
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${label} must be a non-negative integer`);
  return number;
}

function normalizedHash(value) {
  const hash = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Activity inventory transaction hash must be SHA256');
  return hash;
}

function isoNow(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Transaction clock returned an invalid date');
  return date.toISOString();
}

function dateMs(value) {
  const number = new Date(value).getTime();
  return Number.isFinite(number) ? number : 0;
}

function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
