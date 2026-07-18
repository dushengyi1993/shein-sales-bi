#!/usr/bin/env node
/**
 * Durable limited-discount replacement transaction.
 *
 * SHEIN does not expose an atomic replace API. This wrapper therefore:
 *   1. locks the exact rescue hash;
 *   2. snapshots every old activity/SKC before any delete;
 *   3. persists each destructive phase atomically;
 *   4. creates and reads back the desired replacement;
 *   5. recreates the previous protection for every still-uncovered SKC.
 *
 * apply_hl_limited_discount_rescue.mjs is deliberately create-only. All
 * replacement writes must pass through this wrapper.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  assertMarketingAutomationAuthorization,
  MARKETING_AUTOMATION_ACTIONS,
} from '../../lib/marketing_automation_authorization.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_OUT_DIR = path.join(ROOT, 'tmp/marketing-signup/limited-discount-rescue');
const DEFAULT_JOURNAL_DIR = path.join(ROOT, 'state/marketing-replacement-transactions');
const APPLY_SCRIPT = process.env.SHEIN_MARKETING_APPLY_SCRIPT || 'scripts/marketing/apply_hl_limited_discount_rescue.mjs';
const REMOVE_SCRIPT = process.env.SHEIN_MARKETING_REMOVE_SCRIPT || 'scripts/marketing/remove_skc_from_limited_discount.mjs';

function parseArgs(argv) {
  const args = {
    storeKey: '',
    port: 0,
    rescue: '',
    execute: false,
    expectedRescueHash: '',
    outDir: DEFAULT_OUT_DIR,
    journalDir: DEFAULT_JOURNAL_DIR,
    transactionId: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--store' || arg === '--store-key') args.storeKey = String(argv[++i] || '').trim().toUpperCase();
    else if (arg.startsWith('--store=')) args.storeKey = String(arg.slice('--store='.length)).trim().toUpperCase();
    else if (arg.startsWith('--store-key=')) args.storeKey = String(arg.slice('--store-key='.length)).trim().toUpperCase();
    else if (arg === '--port') args.port = Number(argv[++i]);
    else if (arg.startsWith('--port=')) args.port = Number(arg.slice('--port='.length));
    else if (arg === '--rescue') args.rescue = path.resolve(argv[++i] || '');
    else if (arg.startsWith('--rescue=')) args.rescue = path.resolve(arg.slice('--rescue='.length));
    else if (arg === '--execute') args.execute = true;
    else if (arg === '--dry-run') args.execute = false;
    else if (arg === '--expected-rescue-hash') args.expectedRescueHash = String(argv[++i] || '').trim().toLowerCase();
    else if (arg.startsWith('--expected-rescue-hash=')) args.expectedRescueHash = String(arg.slice('--expected-rescue-hash='.length)).trim().toLowerCase();
    else if (arg === '--out-dir') args.outDir = path.resolve(argv[++i] || '');
    else if (arg.startsWith('--out-dir=')) args.outDir = path.resolve(arg.slice('--out-dir='.length));
    else if (arg === '--journal-dir') args.journalDir = path.resolve(argv[++i] || '');
    else if (arg.startsWith('--journal-dir=')) args.journalDir = path.resolve(arg.slice('--journal-dir='.length));
    else if (arg === '--transaction-id') args.transactionId = String(argv[++i] || '').trim();
    else if (arg.startsWith('--transaction-id=')) args.transactionId = String(arg.slice('--transaction-id='.length)).trim();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.storeKey) throw new Error('Missing --store');
  if (!Number.isFinite(args.port) || args.port <= 0) throw new Error('Missing/invalid --port');
  if (!args.rescue) throw new Error('Missing --rescue');
  if (args.expectedRescueHash && !/^[a-f0-9]{64}$/.test(args.expectedRescueHash)) {
    throw new Error(`Invalid --expected-rescue-hash: ${args.expectedRescueHash}`);
  }
  return args;
}

function rel(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, '/');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function unique(values) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

function parseDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const normalized = raw.replace(' ', 'T');
  const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  const parsed = new Date(hasExplicitZone ? normalized : `${normalized}+08:00`);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, file);
}

async function pathExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(command, commandArgs, timeoutMs = 1200000) {
  return await new Promise(resolve => {
    const startedAt = new Date().toISOString();
    const child = spawn(command, commandArgs, {
      cwd: ROOT,
      shell: false,
      windowsHide: true,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ok: false, startedAt, finishedAt: new Date().toISOString(), exitCode: null, timedOut, stdout, stderr, error: error.message});
    });
    child.on('close', exitCode => {
      clearTimeout(timer);
      resolve({ok: exitCode === 0 && !timedOut, startedAt, finishedAt: new Date().toISOString(), exitCode, timedOut, stdout, stderr});
    });
  });
}

function parseLastJson(text) {
  const source = String(text || '').trim();
  for (let start = source.lastIndexOf('{'); start >= 0; start = source.lastIndexOf('{', start - 1)) {
    try { return JSON.parse(source.slice(start)); } catch {}
  }
  return null;
}

async function loadToolResult(commandResult) {
  const parsed = parseLastJson(commandResult.stdout) || parseLastJson(commandResult.stderr);
  if (!parsed?.out) return {...commandResult, parsed, full: null, outPath: ''};
  const outPath = path.resolve(ROOT, parsed.out);
  const full = await fs.readFile(outPath, 'utf8').then(JSON.parse).catch(() => null);
  return {...commandResult, parsed, full, outPath};
}

async function applyRescue({args, rescuePath, execute, startDelayMinutes = 20}) {
  const rescueText = await fs.readFile(rescuePath, 'utf8');
  const rescueHash = sha256(rescueText);
  const commandArgs = [
    APPLY_SCRIPT,
    '--store', args.storeKey,
    '--port', String(args.port),
    '--rescue', rescuePath,
    '--expected-rescue-hash', rescueHash,
    '--start-delay-minutes', String(startDelayMinutes),
    execute ? '--execute' : '--dry-run',
  ];
  return await loadToolResult(await runCommand(process.execPath, commandArgs));
}

async function removeSkcs({args, activityId, skcs, execute}) {
  return await loadToolResult(await runCommand(process.execPath, [
    REMOVE_SCRIPT,
    '--store', args.storeKey,
    '--activity-id', String(activityId),
    '--skcs', skcs.join(','),
    execute ? '--execute' : '--dry-run',
  ], 600000));
}

function commandSummary(result) {
  return {
    ok: result?.ok === true,
    exitCode: result?.exitCode ?? null,
    timedOut: result?.timedOut === true,
    out: result?.outPath ? rel(result.outPath) : (result?.parsed?.out || ''),
    createdActivityId: result?.full?.createdActivityId || null,
    reason: result?.full?.reason || result?.full?.error?.message || result?.stderr?.slice(-1200) || '',
  };
}

function conflictActivities(full) {
  return (full?.before?.conflictActivities || []).map(activity => ({
    activityId: Number(activity.activity_id),
    actName: String(activity.act_name || ''),
    state: Number(activity.state),
    startTime: activity.start_time || '',
    endTime: activity.end_time || '',
    targetSkcs: unique(activity.targetSkcs || []),
    extraSkcs: unique(activity.extraSkcs || []),
    targetGoods: (activity.targetGoods || []).map(good => ({
      skc: String(good.skc || ''),
      product_act_price: good.product_act_price,
      attend_num_sum: good.attend_num_sum,
      stock_num: good.stock_num,
    })),
  })).filter(activity => Number.isFinite(activity.activityId) && activity.activityId > 0);
}

function invalidBySkc(full) {
  const result = new Map();
  for (const row of full?.validation?.invalid || []) {
    const skc = String(row?.skc || '').trim();
    if (!skc) continue;
    const oldConflictOnly = row.reason === 'query_goods error_code'
      && row.error_code === 'mrs-simple_platform_limit_discounts-0006';
    if (oldConflictOnly) continue;
    if (!result.has(skc)) result.set(skc, []);
    result.get(skc).push(row);
  }
  for (const skc of full?.validation?.missing || []) {
    const value = String(skc || '').trim();
    if (!value) continue;
    if (!result.has(value)) result.set(value, []);
    result.get(value).push({skc: value, reason: 'query_goods missing'});
  }
  return result;
}

function exactCoveredSkcs(full, rows, rescue) {
  const expected = new Map(rows.map(row => [String(row.skc), row]));
  const covered = new Set();
  for (const exact of full?.after?.exactReadbackRows || []) {
    if (exact?.ok && expected.has(String(exact.skc))) covered.add(String(exact.skc));
  }
  const activities = full?.before?.conflictActivities || full?.after?.conflictActivities || [];
  for (const activity of activities) {
    const end = parseDate(activity.end_time);
    const expectedEnd = parseDate(rescue.endTime);
    for (const good of activity.targetGoods || []) {
      const skc = String(good.skc || '');
      const row = expected.get(skc);
      if (!row) continue;
      const priceOk = Math.abs(Number(good.product_act_price) - Number(row.limitedDiscountPrice)) <= 0.01;
      const stockOk = Number(good.attend_num_sum || 0) >= Number(row.activityStock || rescue.activityStock || 10);
      const endOk = !expectedEnd || Boolean(end && end >= expectedEnd);
      if (priceOk && stockOk && endOk && [2, 3].includes(Number(activity.state))) covered.add(skc);
    }
  }
  return covered;
}

async function writeSubsetRescue(baseRescue, rows, args, label, overrides = {}) {
  const safeLabel = String(label).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80);
  const file = path.join(args.outDir, `limited-discount-tx-${args.storeKey}-${args.transactionId}-${safeLabel}.json`);
  const value = {
    ...baseRescue,
    ...overrides,
    createdAt: new Date().toISOString(),
    parentRescue: rel(args.rescue),
    transactionId: args.transactionId,
    rows,
  };
  await writeJsonAtomic(file, value);
  return {file, value, hash: sha256(await fs.readFile(file, 'utf8'))};
}

function snapshotRows(snapshot) {
  const planned = new Set(snapshot.plannedSkcs || []);
  return (snapshot.beforeGoods || [])
    .filter(good => planned.has(String(good.skc || '')))
    .map(good => ({
      storeKey: snapshot.storeKey,
      skc: String(good.skc || ''),
      canonical: '',
      supplierNo: good.sku_supplier_no || '',
      limitedDiscountPrice: Number(good.product_act_price),
      finalTargetPrice: Number(good.product_act_price),
      activityStock: Math.max(1, Number(good.attend_num_sum || 10)),
      needsLimitedDiscount: true,
      sourceRule: 'transaction_compensation_restore_previous_protection',
      note: `Restore activity ${snapshot.activityId} after an incomplete replacement transaction`,
    }))
    .filter(row => row.skc && Number.isFinite(row.limitedDiscountPrice) && row.limitedDiscountPrice > 0);
}

async function restorePreviousProtection({args, baseRescue, snapshots, journal, persistJournal}) {
  const desiredCovered = new Set(journal.desiredCoveredSkcs || []);
  const restoredCovered = new Set();
  const claimed = new Set(desiredCovered);
  const attempts = [];
  for (const snapshot of snapshots) {
    const rows = snapshotRows(snapshot).filter(row => !claimed.has(row.skc));
    if (!rows.length) continue;
    const restoreEnd = snapshot.endTime || baseRescue.endTime;
    const prepared = await writeSubsetRescue(baseRescue, rows, args, `restore-${snapshot.activityId}`, {
      purpose: 'limited_discount_transaction_compensation_restore',
      sourceLimitedDiscountName: snapshot.actName,
      activityNamePrefix: `${args.storeKey}限时折扣事务回滚`,
      endTime: restoreEnd,
      activityStock: undefined,
    });
    const dryRun = await applyRescue({args, rescuePath: prepared.file, execute: false, startDelayMinutes: 1});
    const alreadyCovered = exactCoveredSkcs(dryRun.full, rows, prepared.value);
    for (const skc of alreadyCovered) {
      claimed.add(skc);
      restoredCovered.add(skc);
    }
    const uncoveredRows = rows.filter(row => !claimed.has(row.skc));
    const attempt = {
      sourceActivityId: snapshot.activityId,
      rescuePath: rel(prepared.file),
      rescueHash: prepared.hash,
      targetSkcs: rows.map(row => row.skc),
      alreadyCoveredSkcs: [...alreadyCovered],
      dryRun: commandSummary(dryRun),
      execute: null,
      restoredSkcs: [],
      ok: false,
    };
    if (!uncoveredRows.length) {
      attempt.ok = true;
      attempts.push(attempt);
      continue;
    }
    const executable = uncoveredRows.length === rows.length
      ? prepared
      : await writeSubsetRescue(prepared.value, uncoveredRows, args, `restore-uncovered-${snapshot.activityId}`);
    const executableDryRun = uncoveredRows.length === rows.length
      ? dryRun
      : await applyRescue({args, rescuePath: executable.file, execute: false, startDelayMinutes: 1});
    attempt.executableDryRun = commandSummary(executableDryRun);
    if (!executableDryRun.full?.ok || executableDryRun.full?.requiresTransactionalReplacement) {
      attempt.error = 'compensation preflight failed or found a conflicting activity';
      attempts.push(attempt);
      journal.compensationAttempts = attempts;
      await persistJournal('compensation_failed');
      continue;
    }
    const execute = await applyRescue({args, rescuePath: executable.file, execute: true, startDelayMinutes: 1});
    attempt.execute = commandSummary(execute);
    const exact = exactCoveredSkcs(execute.full, uncoveredRows, executable.value);
    for (const skc of exact) {
      claimed.add(skc);
      restoredCovered.add(skc);
    }
    attempt.restoredSkcs = [...exact];
    attempt.ok = execute.full?.ok === true && exact.size === uncoveredRows.length;
    if (!attempt.ok) attempt.error = 'compensation create/readback did not cover every expected SKC';
    attempts.push(attempt);
    journal.compensationAttempts = attempts;
    journal.restoredCoveredSkcs = [...restoredCovered].sort();
    await persistJournal(attempt.ok ? 'compensating' : 'compensation_failed');
  }
  const removed = unique(snapshots.flatMap(snapshot => snapshot.plannedSkcs || []));
  const protectedSkcs = new Set([...desiredCovered, ...restoredCovered]);
  const uncoveredSkcs = removed.filter(skc => !protectedSkcs.has(skc));
  return {
    ok: uncoveredSkcs.length === 0,
    attempts,
    desiredCoveredSkcs: [...desiredCovered].sort(),
    restoredCoveredSkcs: [...restoredCovered].sort(),
    protectedSkcs: [...protectedSkcs].sort(),
    uncoveredSkcs,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await fs.mkdir(args.outDir, {recursive: true});
  await fs.mkdir(args.journalDir, {recursive: true});
  const rescueText = await fs.readFile(args.rescue, 'utf8');
  const rescueHash = sha256(rescueText);
  if (args.expectedRescueHash && rescueHash !== args.expectedRescueHash) {
    throw new Error(`Rescue hash mismatch: expected=${args.expectedRescueHash} actual=${rescueHash}`);
  }
  const rescue = JSON.parse(rescueText);
  const rows = (rescue.rows || []).filter(row => row && row.needsLimitedDiscount !== false);
  if (!rows.length) throw new Error('Transaction rescue has no rows');
  args.transactionId = args.transactionId || sha256(`${args.storeKey}\n${rescueHash}`).slice(0, 24);
  const journalPath = path.join(args.journalDir, `limited-discount-tx-${args.storeKey}-${args.transactionId}.json`);
  const outputPath = path.join(args.outDir, `limited-discount-transaction-${args.execute ? 'execute' : 'dry-run'}-${args.storeKey}-${args.transactionId}.json`);
  const automationAuthorization = args.execute ? await assertMarketingAutomationAuthorization({
    action: MARKETING_AUTOMATION_ACTIONS.CREATE_OR_REPLACE_ACTIVITY,
    storeKey: args.storeKey,
    payloadHash: process.env.SHEIN_BI_MARKETING_RUN_PAYLOAD_HASH || rescueHash,
  }) : null;
  let journal = await fs.readFile(journalPath, 'utf8').then(JSON.parse).catch(() => null);
  if (journal && journal.rescueHash !== rescueHash) {
    throw new Error(`Transaction id collision with another rescue hash: ${args.transactionId}`);
  }
  journal = journal || {
    schemaVersion: 1,
    transactionId: args.transactionId,
    storeKey: args.storeKey,
    rescuePath: rel(args.rescue),
    rescueHash,
    runPayloadHash: process.env.SHEIN_BI_MARKETING_RUN_PAYLOAD_HASH || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    execute: args.execute,
    phase: 'initialized',
    mutationsStarted: false,
    snapshots: [],
    removals: [],
    desiredCoveredSkcs: [],
    restoredCoveredSkcs: [],
    compensationAttempts: [],
    attempt: 1,
    attemptStartedAt: new Date().toISOString(),
    attemptHistory: [],
    terminal: false,
  };
  const persistJournal = async phase => {
    journal.phase = phase;
    journal.updatedAt = new Date().toISOString();
    await writeJsonAtomic(journalPath, journal);
  };

  if (args.execute && journal.phase === 'completed' && journal.result) {
    const result = {...journal.result, resumedFromTerminalJournal: true};
    await writeJsonAtomic(outputPath, result);
    console.log(JSON.stringify({...result, out: rel(outputPath)}, null, 2));
    if (!result.ok) process.exitCode = result.safe === true ? 2 : 4;
    return;
  }

  // A terminated process may have deleted goods after the last journal update.
  // Restore first and stop; a later bounded worker run may attempt replacement.
  if (args.execute && journal.mutationsStarted && !['completed', 'safe_blocked', 'recovered_after_interruption'].includes(journal.phase)) {
    const recovery = await restorePreviousProtection({
      args,
      baseRescue: rescue,
      snapshots: journal.snapshots || [],
      journal,
      persistJournal,
    });
    journal.recovery = recovery;
    journal.terminal = !recovery.ok;
    await persistJournal(recovery.ok ? 'recovered_after_interruption' : 'unsafe_uncovered');
    const result = {
      ok: false,
      safe: recovery.ok,
      terminal: !recovery.ok,
      status: recovery.ok ? 'recovered_after_interruption' : 'unsafe_uncovered',
      execute: true,
      transactionId: args.transactionId,
      rescueHash,
      journalPath: rel(journalPath),
      recovery,
    };
    await writeJsonAtomic(outputPath, result);
    console.log(JSON.stringify({...result, out: rel(outputPath)}, null, 2));
    process.exitCode = recovery.ok ? 2 : 4;
    return;
  }

  const resetSafeAttempt = async reason => {
    journal.attemptHistory = journal.attemptHistory || [];
    journal.attemptHistory.push({
      attempt: Number(journal.attempt || 1),
      attemptStartedAt: journal.attemptStartedAt || journal.createdAt,
      finishedAt: journal.updatedAt,
      phase: journal.phase,
      reason,
      result: journal.result || null,
      snapshots: journal.snapshots || [],
      removals: journal.removals || [],
      compensationAttempts: journal.compensationAttempts || [],
    });
    journal.attempt = Number(journal.attempt || 1) + 1;
    journal.attemptStartedAt = new Date().toISOString();
    journal.mutationsStarted = false;
    journal.snapshots = [];
    journal.removals = [];
    journal.desiredCoveredSkcs = [];
    journal.restoredCoveredSkcs = [];
    journal.compensationAttempts = [];
    journal.currentMutation = null;
    journal.recovery = null;
    journal.result = null;
    journal.terminal = false;
    await persistJournal('retry_initialized');
  };

  if (args.execute && ['safe_blocked', 'recovered_after_interruption', 'create_failed_without_deletion'].includes(journal.phase)) {
    await resetSafeAttempt(`retry after safe prior phase ${journal.phase}`);
  }

  const initial = await applyRescue({args, rescuePath: args.rescue, execute: false});
  const initialInvalid = invalidBySkc(initial.full);
  const initiallyBlockedSkcs = [...initialInvalid.keys()];
  const eligibleRows = rows.filter(row => !initialInvalid.has(String(row.skc)));
  const initialConflicts = conflictActivities(initial.full);
  const result = {
    ok: false,
    safe: true,
    terminal: false,
    status: 'pending',
    execute: args.execute,
    transactionId: args.transactionId,
    rescuePath: rel(args.rescue),
    rescueHash,
    journalPath: rel(journalPath),
    automationAuthorization,
    targetSkcs: rows.map(row => String(row.skc)),
    initiallyBlockedSkcs,
    initialBlockers: Object.fromEntries(initialInvalid),
    initialDryRun: commandSummary(initial),
    snapshots: [],
    removals: [],
    postDeleteDryRun: null,
    desiredCreate: null,
    desiredCoveredSkcs: [],
    compensation: null,
    uncoveredSkcs: [],
  };
  if (!initial.full) throw new Error('Initial transactional preflight did not produce a readable artifact');

  const initiallyExactCovered = exactCoveredSkcs(initial.full, rows, rescue);
  if (initiallyExactCovered.size === rows.length) {
    result.ok = true;
    result.status = 'already_exactly_covered';
    result.desiredCoveredSkcs = [...initiallyExactCovered].sort();
    journal.result = result;
    journal.desiredCoveredSkcs = result.desiredCoveredSkcs;
    journal.terminal = false;
    await persistJournal('completed');
    await writeJsonAtomic(outputPath, result);
    console.log(JSON.stringify({...result, out: rel(outputPath)}, null, 2));
    return;
  }

  if (!eligibleRows.length) {
    result.status = 'initial_platform_blocked_preserved';
    result.terminal = true;
    journal.result = result;
    journal.terminal = true;
    await persistJournal('safe_blocked');
    await writeJsonAtomic(outputPath, result);
    console.log(JSON.stringify({...result, out: rel(outputPath)}, null, 2));
    process.exitCode = 2;
    return;
  }

  const prepared = eligibleRows.length === rows.length
    ? {file: args.rescue, value: rescue, hash: rescueHash}
    : await writeSubsetRescue(rescue, eligibleRows, args, 'initial-executable-subset');
  const preflight = eligibleRows.length === rows.length
    ? initial
    : await applyRescue({args, rescuePath: prepared.file, execute: false});
  const conflicts = conflictActivities(preflight.full);

  // No replacement is needed. A create-only write has no destructive rollback
  // requirement, but still uses the exact hashed rescue and exact readback.
  if (!conflicts.length) {
    if (!preflight.full?.ok) {
      result.status = 'create_preflight_blocked_without_deletion';
      result.terminal = true;
      journal.result = result;
      journal.terminal = true;
      await persistJournal('safe_blocked');
      await writeJsonAtomic(outputPath, result);
      console.log(JSON.stringify({...result, out: rel(outputPath)}, null, 2));
      process.exitCode = 2;
      return;
    }
    if (!args.execute) {
      result.ok = true;
      result.status = 'dry_run_create_only';
      await persistJournal('dry_run');
      await writeJsonAtomic(outputPath, result);
      console.log(JSON.stringify({...result, out: rel(outputPath)}, null, 2));
      return;
    }
    const created = await applyRescue({args, rescuePath: prepared.file, execute: true});
    const covered = exactCoveredSkcs(created.full, eligibleRows, prepared.value);
    result.desiredCreate = commandSummary(created);
    result.desiredCoveredSkcs = [...covered].sort();
    result.ok = created.full?.ok === true && covered.size === eligibleRows.length && initiallyBlockedSkcs.length === 0;
    result.status = result.ok ? 'created_without_replacement' : 'create_failed_without_deletion';
    result.safe = true;
    result.terminal = initiallyBlockedSkcs.length > 0;
    journal.result = result;
    journal.desiredCoveredSkcs = result.desiredCoveredSkcs;
    journal.terminal = result.terminal;
    await persistJournal(result.ok ? 'completed' : (result.terminal ? 'safe_blocked' : 'create_failed_without_deletion'));
    await writeJsonAtomic(outputPath, result);
    console.log(JSON.stringify({...result, out: rel(outputPath)}, null, 2));
    if (!result.ok) process.exitCode = 2;
    return;
  }

  const snapshots = [];
  for (const conflict of conflicts) {
    const skcs = conflict.targetSkcs.filter(skc => eligibleRows.some(row => String(row.skc) === skc));
    if (!skcs.length) continue;
    const snapshotResult = await removeSkcs({args, activityId: conflict.activityId, skcs, execute: false});
    const before = snapshotResult.full?.results?.[0]?.before;
    if (!snapshotResult.full?.ok || !before || (before.missingToRemove || []).length) {
      throw new Error(`Could not lock pre-delete snapshot for activity ${conflict.activityId}`);
    }
    snapshots.push({
      storeKey: args.storeKey,
      activityId: conflict.activityId,
      actName: conflict.actName,
      state: conflict.state,
      startTime: conflict.startTime,
      endTime: conflict.endTime,
      plannedSkcs: skcs,
      beforeGoods: before.goods || [],
      snapshotArtifact: snapshotResult.outPath ? rel(snapshotResult.outPath) : '',
    });
  }
  const snapshottedSkcs = new Set(snapshots.flatMap(snapshot => snapshot.plannedSkcs));
  const missingSnapshot = eligibleRows.map(row => String(row.skc)).filter(skc => !snapshottedSkcs.has(skc));
  if (missingSnapshot.length) throw new Error(`Target SKCs have conflicts but no complete pre-delete snapshot: ${missingSnapshot.join(',')}`);
  result.snapshots = snapshots;
  journal.snapshots = snapshots;
  journal.mutationsStarted = false;
  await persistJournal('pre_delete_snapshot_locked');

  if (!args.execute) {
    result.ok = true;
    result.status = 'dry_run_transaction_locked';
    await persistJournal('dry_run');
    await writeJsonAtomic(outputPath, result);
    console.log(JSON.stringify({...result, out: rel(outputPath)}, null, 2));
    return;
  }

  journal.mutationsStarted = true;
  await persistJournal('delete_started');
  for (const snapshot of snapshots) {
    journal.currentMutation = {activityId: snapshot.activityId, skcs: snapshot.plannedSkcs, startedAt: new Date().toISOString()};
    await persistJournal('deleting_old_protection');
    const removed = await removeSkcs({args, activityId: snapshot.activityId, skcs: snapshot.plannedSkcs, execute: true});
    const removal = {
      activityId: snapshot.activityId,
      skcs: snapshot.plannedSkcs,
      command: commandSummary(removed),
      ok: removed.full?.ok === true,
      artifact: removed.outPath ? rel(removed.outPath) : '',
    };
    result.removals.push(removal);
    journal.removals.push(removal);
    journal.currentMutation = null;
    await persistJournal(removal.ok ? 'old_protection_removed' : 'delete_failed');
    if (!removal.ok) {
      const compensation = await restorePreviousProtection({args, baseRescue: rescue, snapshots, journal, persistJournal});
      result.compensation = compensation;
      result.safe = compensation.ok;
      result.status = compensation.ok ? 'delete_failed_restored' : 'unsafe_uncovered';
      result.uncoveredSkcs = compensation.uncoveredSkcs;
      journal.result = result;
      journal.terminal = !compensation.ok;
      await persistJournal(compensation.ok ? 'recovered_after_interruption' : 'unsafe_uncovered');
      await writeJsonAtomic(outputPath, result);
      console.log(JSON.stringify({...result, out: rel(outputPath)}, null, 2));
      process.exitCode = compensation.ok ? 2 : 4;
      return;
    }
  }

  const postDelete = await applyRescue({args, rescuePath: prepared.file, execute: false});
  result.postDeleteDryRun = commandSummary(postDelete);
  const postInvalid = invalidBySkc(postDelete.full);
  const executableRows = eligibleRows.filter(row => !postInvalid.has(String(row.skc)));
  const postBlockedSkcs = [...postInvalid.keys()];
  result.postDeleteBlockedSkcs = postBlockedSkcs;
  let desiredCovered = new Set();

  if (executableRows.length) {
    const executable = executableRows.length === eligibleRows.length
      ? prepared
      : await writeSubsetRescue(prepared.value, executableRows, args, 'post-delete-executable-subset');
    const executablePreflight = executableRows.length === eligibleRows.length
      ? postDelete
      : await applyRescue({args, rescuePath: executable.file, execute: false});
    result.executablePreflight = commandSummary(executablePreflight);
    if (executablePreflight.full?.ok && !executablePreflight.full?.requiresTransactionalReplacement) {
      await persistJournal('desired_create_started');
      const created = await applyRescue({args, rescuePath: executable.file, execute: true});
      result.desiredCreate = commandSummary(created);
      desiredCovered = exactCoveredSkcs(created.full, executableRows, executable.value);
    }
  }
  journal.desiredCoveredSkcs = [...desiredCovered].sort();
  result.desiredCoveredSkcs = [...desiredCovered].sort();
  await persistJournal('desired_create_readback');

  const compensation = await restorePreviousProtection({
    args,
    baseRescue: rescue,
    snapshots,
    journal,
    persistJournal,
  });
  result.compensation = compensation;
  result.uncoveredSkcs = compensation.uncoveredSkcs;
  result.safe = compensation.ok;
  const desiredAll = eligibleRows.every(row => desiredCovered.has(String(row.skc)));
  result.ok = desiredAll && initiallyBlockedSkcs.length === 0 && postBlockedSkcs.length === 0 && compensation.ok;
  if (result.ok) result.status = 'replaced_all';
  else if (!compensation.ok) result.status = 'unsafe_uncovered';
  else if (postBlockedSkcs.length || initiallyBlockedSkcs.length) result.status = 'platform_blocked_old_protection_restored';
  else result.status = 'replacement_failed_old_protection_restored';
  result.terminal = result.status === 'platform_blocked_old_protection_restored' || !result.safe;
  journal.result = result;
  journal.terminal = result.terminal;
  journal.restoredCoveredSkcs = compensation.restoredCoveredSkcs;
  await persistJournal(result.ok ? 'completed' : (result.safe ? (result.terminal ? 'safe_blocked' : 'recovered_after_interruption') : 'unsafe_uncovered'));
  await writeJsonAtomic(outputPath, result);
  console.log(JSON.stringify({...result, out: rel(outputPath)}, null, 2));
  if (!result.ok) process.exitCode = result.safe ? 2 : 4;
}

main().catch(async error => {
  console.error(JSON.stringify({ok: false, safe: false, error: error.message, stack: error.stack}, null, 2));
  process.exitCode = 4;
});
