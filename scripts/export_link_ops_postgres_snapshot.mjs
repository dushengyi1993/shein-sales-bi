#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {createLinkOpsRepository, linkOpsPayloadHash} from '../lib/link_ops_repository.mjs';
import {restoreDetachedOrphanTaskSession} from '../lib/link_ops_migration_compat.mjs';

function parseArgs(argv) {
  const args = {outputDir: '', force: false};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--output-dir') args.outputDir = path.resolve(argv[++index]);
    else if (token === '--force') args.force = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return `Usage:
  node scripts/export_link_ops_postgres_snapshot.mjs --output-dir DIR [--force]

Exports row-level PostgreSQL runtime state into rollback-compatible JSON files.
Credentials are accepted only through PG*/SHEIN_WAREHOUSE_PG_* env vars.`;
}

async function writeAtomic(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(temporary, text, {encoding: 'utf8', mode: 0o600});
  await fs.rename(temporary, file);
  return {
    file: path.basename(file),
    bytes: Buffer.byteLength(text),
    sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
  };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}
if (!args.outputDir) throw new Error('--output-dir is required');

const existing = await fs.stat(args.outputDir).catch(error => {
  if (error?.code === 'ENOENT') return null;
  throw error;
});
if (existing && !args.force) {
  const names = await fs.readdir(args.outputDir);
  if (names.length) throw new Error(`Output directory is not empty: ${args.outputDir}; pass --force to overwrite named export files`);
}

const repository = createLinkOpsRepository({mode: 'postgres', env: process.env});
try {
  const snapshot = await repository.exportSnapshot();
  const exportedAt = new Date().toISOString();
  const files = [];
  const restoredTasks = snapshot.taskStore.tasks.map(task => restoreDetachedOrphanTaskSession(task));
  const taskStore = {
    ...snapshot.taskStore,
    tasks: restoredTasks.map(result => result.record),
  };
  files.push(await writeAtomic(path.join(args.outputDir, 'bi_link_ops_tasks.json'), taskStore));
  files.push(await writeAtomic(path.join(args.outputDir, 'bi_link_ops_chats.json'), snapshot.sessionStore));
  files.push(await writeAtomic(path.join(args.outputDir, 'bi_action_state.json'), snapshot.actionState));
  files.push(await writeAtomic(path.join(args.outputDir, 'bi_link_ops_runtime.json'), snapshot.runtime));
  const manifestBase = {
    version: 1,
    exportedAt,
    source: 'postgres-row-level',
    storageHealth: await repository.health(),
    counts: {
      tasks: snapshot.taskStore.tasks.length,
      sessions: snapshot.sessionStore.sessions.length,
      messages: snapshot.sessionStore.sessions.reduce((sum, session) => sum + (session.messages?.length || 0), 0),
      actions: Object.keys(snapshot.actionState.actions || {}).length,
      jobs: snapshot.runtime.jobs.length,
      events: snapshot.runtime.events.length,
      restoredOrphanTaskSessions: restoredTasks.filter(result => result.restored).length,
    },
    files,
  };
  const manifest = {...manifestBase, manifestHash: linkOpsPayloadHash(manifestBase)};
  await writeAtomic(path.join(args.outputDir, 'manifest.json'), manifest);
  console.log(JSON.stringify({ok: true, outputDir: args.outputDir, manifest}, null, 2));
} finally {
  await repository.close();
}
