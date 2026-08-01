#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  assessLinkRecoveryCompletion,
  planManualLoginLinkRecovery,
} from '../lib/cloud_manual_login_recovery.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_RUNTIME_DIR = process.env.SHEIN_MANUAL_LOGIN_RECOVERY_DIR
  || '/srv/shein-bi/runtime/cloud_manual_login_recovery';
const DEFAULT_PARTIAL_FILE = process.env.SHEIN_LINK_BUSINESS_PARTIAL_FILE
  || path.join(ROOT, 'state', 'cloud_ops_alerts', 'link-business-last-partial.json');
const DEFAULT_SUCCESS_FILE = process.env.SHEIN_LINK_BUSINESS_SUCCESS_FILE
  || path.join(ROOT, 'state', 'cloud_ops_alerts', 'link-business-last-success.json');

function parseArgs(argv) {
  const args = {
    storeKey: '',
    date: '',
    sessionId: '',
    runtimeDir: DEFAULT_RUNTIME_DIR,
    partialFile: DEFAULT_PARTIAL_FILE,
    successFile: DEFAULT_SUCCESS_FILE,
    maxAttempts: 3,
    retryDelayMs: 90_000,
    commandTimeoutMs: 20 * 60_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => String(argv[++i] || '');
    if (arg === '--store') args.storeKey = take().trim().toUpperCase();
    else if (arg === '--date') args.date = take().trim();
    else if (arg === '--session-id') args.sessionId = take().trim();
    else if (arg === '--runtime-dir') args.runtimeDir = path.resolve(take());
    else if (arg === '--partial-file') args.partialFile = path.resolve(take());
    else if (arg === '--success-file') args.successFile = path.resolve(take());
    else if (arg === '--max-attempts') args.maxAttempts = Math.max(1, Math.min(8, Number(take()) || 3));
    else if (arg === '--retry-delay-ms') args.retryDelayMs = Math.max(0, Number(take()) || 0);
    else if (arg === '--command-timeout-ms') args.commandTimeoutMs = Math.max(60_000, Number(take()) || args.commandTimeoutMs);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.storeKey) throw new Error('Missing --store');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error('Missing or invalid --date');
  if (!/^[A-Za-z0-9_.-]+$/.test(args.sessionId)) throw new Error('Missing or invalid --session-id');
  return args;
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, file);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function run(command, argv, {env = {}, timeoutMs = 0} = {}) {
  return new Promise(resolve => {
    const child = spawn(command, argv, {
      cwd: ROOT,
      stdio: 'inherit',
      env: {...process.env, ...env},
    });
    let settled = false;
    let timer = null;
    const done = result => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    child.on('error', error => done({ok: false, code: -1, timedOut: false, error: String(error?.message || error)}));
    child.on('close', code => done({ok: code === 0, code, timedOut: false, error: ''}));
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch {}
        done({ok: false, code: -1, timedOut: true, error: `timeout after ${timeoutMs}ms`});
      }, timeoutMs);
    }
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stateFile = path.join(args.runtimeDir, `${args.sessionId}.json`);
  const startedAt = new Date().toISOString();
  const requestedPlan = {required: true, storeKey: args.storeKey, date: args.date};
  const state = {
    schemaVersion: 'shein-manual-login-recovery/v1',
    sessionId: args.sessionId,
    storeKey: args.storeKey,
    date: args.date,
    status: 'running',
    startedAt,
    updatedAt: startedAt,
    attempts: [],
  };
  await writeJsonAtomic(stateFile, state);

  const partialAtStart = await readJson(args.partialFile, null);
  const livePlan = planManualLoginLinkRecovery({partialState: partialAtStart, storeKey: args.storeKey});
  if (!livePlan.required) {
    const successState = await readJson(args.successFile, null);
    const completion = assessLinkRecoveryCompletion({
      successState,
      partialState: partialAtStart,
      plan: requestedPlan,
      startedAt: '1970-01-01T00:00:00.000Z',
    });
    state.status = completion.complete ? 'completed' : 'not_required';
    state.reason = completion.complete ? 'already_recovered' : livePlan.reason;
    state.completion = completion;
    state.updatedAt = new Date().toISOString();
    state.completedAt = state.updatedAt;
    await writeJsonAtomic(stateFile, state);
    console.log(JSON.stringify({ok: true, stateFile, ...state}, null, 2));
    return;
  }

  for (let attempt = 1; attempt <= args.maxAttempts; attempt += 1) {
    const attemptStartedAt = new Date().toISOString();
    const result = await run('bash', ['scripts/cloud_link_business_sync.sh', args.date], {
      timeoutMs: args.commandTimeoutMs,
      env: {
        SHEIN_LINK_BUSINESS_STORES: args.storeKey,
        SHEIN_LINK_BUSINESS_STORE_ATTEMPTS: '2',
        SHEIN_LINK_BUSINESS_LEASE_TASK: 'manual-login-recovery',
      },
    });
    const partialState = await readJson(args.partialFile, null);
    const successState = await readJson(args.successFile, null);
    const completion = assessLinkRecoveryCompletion({
      successState,
      partialState,
      plan: requestedPlan,
      startedAt: attemptStartedAt,
    });
    state.attempts.push({
      attempt,
      startedAt: attemptStartedAt,
      finishedAt: new Date().toISOString(),
      command: result,
      completion,
    });
    state.updatedAt = new Date().toISOString();
    if (completion.complete) {
      state.status = 'completed';
      state.reason = 'targeted_link_business_recovery_completed';
      state.completedAt = state.updatedAt;
      state.completion = completion;
      await writeJsonAtomic(stateFile, state);
      await run(process.execPath, ['scripts/cloud_ops_watchdog.mjs', '--dry-run'], {timeoutMs: 180_000});
      console.log(JSON.stringify({ok: true, stateFile, ...state}, null, 2));
      return;
    }
    await writeJsonAtomic(stateFile, state);
    if (attempt < args.maxAttempts) await sleep(args.retryDelayMs);
  }

  state.status = 'failed';
  state.reason = 'targeted_link_business_recovery_not_verified';
  state.failedAt = new Date().toISOString();
  state.updatedAt = state.failedAt;
  await writeJsonAtomic(stateFile, state);
  console.error(JSON.stringify({ok: false, stateFile, ...state}, null, 2));
  process.exitCode = 2;
}

main().catch(error => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
