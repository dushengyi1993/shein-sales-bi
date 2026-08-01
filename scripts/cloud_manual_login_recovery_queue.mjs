#!/usr/bin/env node
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_RUNTIME_DIR = process.env.SHEIN_MANUAL_LOGIN_RECOVERY_DIR
  || '/srv/shein-bi/runtime/cloud_manual_login_recovery';
const DEFAULT_LOG_DIR = process.env.SHEIN_MANUAL_LOGIN_LOG_DIR
  || '/srv/shein-bi/logs/cloud-manual-login';

function parseArgs(argv) {
  const args = {
    runtimeDir: DEFAULT_RUNTIME_DIR,
    logDir: DEFAULT_LOG_DIR,
    maxItems: 8,
    staleProcessingMs: 30 * 60_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => String(argv[++i] || '');
    if (arg === '--runtime-dir') args.runtimeDir = path.resolve(take());
    else if (arg === '--log-dir') args.logDir = path.resolve(take());
    else if (arg === '--max-items') args.maxItems = Math.max(1, Math.min(30, Number(take()) || 8));
    else if (arg === '--stale-processing-ms') args.staleProcessingMs = Math.max(60_000, Number(take()) || args.staleProcessingMs);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

async function readJson(file) {
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

async function ensureDirs(runtimeDir, logDir) {
  const dirs = {
    queue: path.join(runtimeDir, 'queue'),
    processing: path.join(runtimeDir, 'processing'),
    completed: path.join(runtimeDir, 'completed'),
    failed: path.join(runtimeDir, 'failed'),
  };
  await Promise.all([...Object.values(dirs), logDir].map(dir => fs.mkdir(dir, {recursive: true})));
  return dirs;
}

async function listJson(dir) {
  try {
    return (await fs.readdir(dir))
      .filter(name => name.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
}

async function reclaimStaleProcessing(dirs, staleProcessingMs) {
  const reclaimed = [];
  const now = Date.now();
  for (const name of await listJson(dirs.processing)) {
    const source = path.join(dirs.processing, name);
    const stat = await fs.stat(source).catch(() => null);
    if (!stat || now - stat.mtimeMs < staleProcessingMs) continue;
    const target = path.join(dirs.queue, name);
    await fs.rename(source, target);
    reclaimed.push(name);
  }
  return reclaimed;
}

function validQueueItem(item, expectedSessionId) {
  const sessionId = String(item?.sessionId || '');
  const storeKey = String(item?.storeKey || '').trim().toUpperCase();
  const date = String(item?.date || '').trim();
  if (item?.schemaVersion !== 'shein-manual-login-recovery-queue/v1') throw new Error('invalid queue schema');
  if (sessionId !== expectedSessionId || !/^[A-Za-z0-9_.-]+$/.test(sessionId)) throw new Error('invalid session id');
  if (!/^[A-Z0-9_-]{1,16}$/.test(storeKey)) throw new Error('invalid store key');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('invalid date');
  return {sessionId, storeKey, date};
}

function runWorker(item, args, logFile) {
  return new Promise(resolve => {
    const logFd = fssync.openSync(logFile, 'a');
    const child = spawn(process.execPath, [
      path.join(ROOT, 'scripts', 'cloud_manual_login_recovery.mjs'),
      '--store', item.storeKey,
      '--date', item.date,
      '--session-id', item.sessionId,
      '--runtime-dir', args.runtimeDir,
    ], {
      cwd: ROOT,
      stdio: ['ignore', logFd, logFd],
      env: {...process.env},
    });
    fssync.closeSync(logFd);
    child.on('error', error => resolve({ok: false, code: -1, error: String(error?.message || error)}));
    child.on('close', code => resolve({ok: code === 0, code, error: ''}));
  });
}

async function moveQueueFile(source, destinationDir, name) {
  const target = path.join(destinationDir, name);
  await fs.rm(target, {force: true});
  await fs.rename(source, target);
  return target;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dirs = await ensureDirs(args.runtimeDir, args.logDir);
  const reclaimed = await reclaimStaleProcessing(dirs, args.staleProcessingMs);
  const names = (await listJson(dirs.queue)).slice(0, args.maxItems);
  const results = [];

  for (const name of names) {
    const queued = path.join(dirs.queue, name);
    const processing = path.join(dirs.processing, name);
    try {
      await fs.rename(queued, processing);
    } catch (error) {
      results.push({name, ok: false, status: 'claim_failed', error: String(error?.message || error)});
      continue;
    }
    await fs.utimes(processing, new Date(), new Date()).catch(() => {});
    try {
      const raw = await readJson(processing);
      const expectedSessionId = name.slice(0, -'.json'.length);
      const item = validQueueItem(raw, expectedSessionId);
      const logFile = path.join(args.logDir, `${item.sessionId}-recovery.log`);
      const run = await runWorker(item, args, logFile);
      const state = await readJson(path.join(args.runtimeDir, `${item.sessionId}.json`)).catch(() => null);
      const complete = run.ok && ['completed', 'not_required'].includes(String(state?.status || ''));
      const archive = await moveQueueFile(processing, complete ? dirs.completed : dirs.failed, name);
      results.push({
        name,
        storeKey: item.storeKey,
        date: item.date,
        ok: complete,
        status: state?.status || 'worker_state_missing',
        workerCode: run.code,
        archive,
        logFile,
      });
    } catch (error) {
      const archive = await moveQueueFile(processing, dirs.failed, name).catch(() => '');
      results.push({name, ok: false, status: 'invalid_or_failed', error: String(error?.message || error), archive});
    }
  }

  const failed = results.filter(result => !result.ok);
  console.log(JSON.stringify({
    ok: failed.length === 0,
    reclaimed,
    queued: names.length,
    processed: results.length,
    failed: failed.length,
    results,
  }, null, 2));
  if (failed.length) process.exitCode = 2;
}

main().catch(error => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
