#!/usr/bin/env node
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {collectOwnerKnowledgeEvents, normalizeOwnerKnowledgeSyncState} from '../lib/owner_knowledge_local_collector.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    command: 'sync',
    baseUrl: process.env.SHEIN_OWNER_KNOWLEDGE_BASE_URL || 'https://sa.dushengyi.cc',
    codexHome: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    projectRoot: ROOT,
    credentialFile: process.env.SHEIN_OWNER_KNOWLEDGE_CREDENTIAL_FILE || path.join(os.homedir(), '.codex', 'owner-knowledge', 'device.json'),
    stateFile: process.env.SHEIN_OWNER_KNOWLEDGE_STATE_FILE || path.join(os.homedir(), '.codex', 'owner-knowledge', 'sync-state.json'),
    debounceSeconds: 15,
    reconcileSeconds: 60 * 60,
    logFile: process.env.SHEIN_OWNER_KNOWLEDGE_LOG_FILE || path.join(os.homedir(), '.codex', 'owner-knowledge', 'sync.log'),
  };
  if (argv[0] && !argv[0].startsWith('--')) args.command = argv.shift();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base-url') args.baseUrl = argv[++index];
    else if (arg === '--codex-home') args.codexHome = path.resolve(argv[++index]);
    else if (arg === '--project-root') args.projectRoot = path.resolve(argv[++index]);
    else if (arg === '--credential-file') args.credentialFile = path.resolve(argv[++index]);
    else if (arg === '--state-file') args.stateFile = path.resolve(argv[++index]);
    else if (arg === '--debounce-seconds') args.debounceSeconds = positiveSeconds(argv[++index], '--debounce-seconds');
    else if (arg === '--reconcile-seconds') args.reconcileSeconds = positiveSeconds(argv[++index], '--reconcile-seconds');
    // Kept for existing task installations. It now controls only the low-frequency reconcile.
    else if (arg === '--interval-seconds') args.reconcileSeconds = positiveSeconds(argv[++index], '--interval-seconds');
    else if (arg === '--log-file') args.logFile = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  args.baseUrl = String(args.baseUrl || '').replace(/\/+$/, '');
  return args;
}

function positiveSeconds(value, option) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`${option} must be a positive number`);
  return seconds;
}

async function readJson(file, fallback) {
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); } catch { return fallback; }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), {encoding: 'utf8', mode: 0o600});
  await fs.rename(temp, file);
  try { await fs.chmod(file, 0o600); } catch {}
}

async function credential(args) {
  const raw = await readJson(args.credentialFile, null);
  const value = raw?.data?.token ? raw.data : raw;
  if (!value?.token) throw new Error(`负责人同步设备尚未登记：${args.credentialFile}`);
  return value;
}

async function api(args, pathname, {method = 'GET', body = null} = {}) {
  const auth = await credential(args);
  const response = await fetch(args.baseUrl + pathname, {
    method,
    headers: {
      Authorization: `Bearer ${auth.token}`,
      ...(body === null ? {} : {'Content-Type': 'application/json'}),
      'User-Agent': 'shein-owner-knowledge-sync/1',
    },
    ...(body === null ? {} : {body: JSON.stringify(body)}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!response.ok) throw new Error(`owner knowledge API ${response.status}: ${json?.error || text.slice(0, 500)}`);
  return json;
}

async function collect(args) {
  const rawState = await readJson(args.stateFile, normalizeOwnerKnowledgeSyncState({}, args.projectRoot));
  return collectOwnerKnowledgeEvents({codexHome: args.codexHome, projectRoot: args.projectRoot, state: rawState});
}

async function syncOnce(args) {
  const collected = await collect(args);
  const batches = [];
  for (let index = 0; index < collected.events.length; index += 100) batches.push(collected.events.slice(index, index + 100));
  let published = 0;
  for (const experiences of batches) {
    const result = await api(args, '/api/owner-knowledge/events', {method: 'POST', body: {experiences}});
    published += result?.results?.length || 0;
  }
  await writeJsonAtomic(args.stateFile, collected.nextState);
  return {...collected.summary, published, batches: batches.length, stateFile: args.stateFile};
}

function redactLogText(value) {
  return String(value || '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/((?:token|api[_-]?key|secret|password|authorization)\s*[:=]\s*)[^\s,;，；]+/gi, '$1[REDACTED]');
}

function logger(args) {
  return async (entry, isError = false) => {
    const line = JSON.stringify(JSON.parse(JSON.stringify(entry, (_key, value) => typeof value === 'string' ? redactLogText(value) : value)));
    (isError ? console.error : console.log)(line);
    if (args.logFile) {
      try {
        await fs.mkdir(path.dirname(args.logFile), {recursive: true});
        const stat = await fs.stat(args.logFile).catch(() => null);
        if (stat && stat.size > 2 * 1024 * 1024) {
          await fs.rm(`${args.logFile}.1`, {force: true}).catch(() => {});
          await fs.rename(args.logFile, `${args.logFile}.1`);
        }
        await fs.appendFile(args.logFile, `${line}\n`, 'utf8');
      } catch (error) {
        console.error(JSON.stringify({ok: false, command: 'watch-log', error: redactLogText(String(error?.message || error))}));
      }
    }
  };
}

function watchRoots(args) {
  return [
    path.join(args.codexHome, 'sessions'),
    path.join(args.codexHome, 'memories', 'extensions', 'ad_hoc', 'notes'),
  ];
}

async function watch(args) {
  const log = logger(args);
  let stopped = false;
  let syncing = false;
  let eventPending = false;
  let debounceTimer = null;
  let reconcileTimer = null;
  const watchers = [];
  const runSync = async reason => {
    if (stopped) return;
    if (syncing) {
      if (reason === 'event') eventPending = true;
      return;
    }
    syncing = true;
    try {
      const summary = await syncOnce(args);
      await log({ok: true, command: 'watch-sync', reason, at: new Date().toISOString(), summary});
    } catch (error) {
      await log({ok: false, command: 'watch-sync', reason, at: new Date().toISOString(), error: String(error?.message || error)}, true);
    } finally {
      syncing = false;
      if (eventPending && !stopped) {
        eventPending = false;
        scheduleEventSync();
      }
    }
  };
  const scheduleEventSync = () => {
    if (stopped) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { debounceTimer = null; void runSync('event'); }, args.debounceSeconds * 1_000);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (reconcileTimer) clearInterval(reconcileTimer);
    for (const watcher of watchers) watcher.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  for (const root of watchRoots(args)) {
    try {
      await fs.mkdir(root, {recursive: true});
      watchers.push(fsSync.watch(root, {recursive: true}, scheduleEventSync));
    } catch (error) {
      await log({ok: false, command: 'watch-init', root, error: String(error?.message || error)}, true);
    }
  }
  reconcileTimer = setInterval(() => { void runSync('reconcile'); }, args.reconcileSeconds * 1_000);
  await runSync('startup');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'scan') {
    const collected = await collect(args);
    console.log(JSON.stringify({ok: true, command: 'scan', summary: collected.summary}, null, 2));
    return;
  }
  if (args.command === 'status') {
    const result = await api(args, '/api/owner-knowledge/status');
    console.log(JSON.stringify({ok: true, command: 'status', data: result.data}, null, 2));
    return;
  }
  if (args.command === 'sync') {
    console.log(JSON.stringify({ok: true, command: 'sync', summary: await syncOnce(args)}, null, 2));
    return;
  }
  if (args.command === 'watch') {
    await watch(args);
    return;
  }
  throw new Error(`Unknown command: ${args.command}`);
}

await main().catch(error => {
  console.error(JSON.stringify({ok: false, error: String(error?.message || error)}));
  process.exitCode = 1;
});
