#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {
  LINK_OPS_MIGRATION_VERSION,
  createLinkOpsRepository,
  linkOpsPayloadHash,
  stripLinkOpsRepositoryMetadata,
} from '../lib/link_ops_repository.mjs';
import {detachOrphanTaskSession} from '../lib/link_ops_migration_compat.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    execute: false,
    taskFile: path.join(ROOT, 'state', 'bi_link_ops_tasks.json'),
    chatFile: path.join(ROOT, 'state', 'bi_link_ops_chats.json'),
    actionFile: path.join(ROOT, 'state', 'bi_action_state.json'),
    migrationFile: path.join(ROOT, 'infra', 'warehouse', 'migrations', '20260711_001_link_ops_runtime.sql'),
    manifestOut: '',
    quarantineOwner: 'quarantine:legacy-runtime',
    actorUser: process.env.USER || process.env.USERNAME || 'migration',
    skipLegacyConversations: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--execute') args.execute = true;
    else if (token === '--dry-run') args.execute = false;
    else if (token === '--task-file') args.taskFile = path.resolve(argv[++index]);
    else if (token === '--chat-file') args.chatFile = path.resolve(argv[++index]);
    else if (token === '--action-file') args.actionFile = path.resolve(argv[++index]);
    else if (token === '--migration-file') args.migrationFile = path.resolve(argv[++index]);
    else if (token === '--manifest-out') args.manifestOut = path.resolve(argv[++index]);
    else if (token === '--quarantine-owner') args.quarantineOwner = String(argv[++index] || '').trim();
    else if (token === '--default-owner') throw new Error('--default-owner was removed because it could assign anonymous history to a real account; use --quarantine-owner quarantine:<name>');
    else if (token === '--actor-user') args.actorUser = String(argv[++index] || '').trim();
    else if (token === '--skip-legacy-conversations') args.skipLegacyConversations = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return `Usage:
  node scripts/migrate_link_ops_runtime_to_postgres.mjs --dry-run [options]
  node scripts/migrate_link_ops_runtime_to_postgres.mjs --execute [options]

Options:
  --task-file FILE       Legacy task JSON file
  --chat-file FILE       Legacy chat JSON file
  --action-file FILE     Legacy action-state JSON file
  --migration-file FILE  Row-level PostgreSQL migration SQL
  --quarantine-owner ID  Isolation owner for anonymous/IP/system history; must start with quarantine:
  --actor-user USER      Audit actor for the import batch
  --skip-legacy-conversations
                         Start PostgreSQL with empty tasks/chats; action state is still imported
  --manifest-out FILE    Write the dry-run/import manifest atomically

PostgreSQL credentials are accepted only through PG*/SHEIN_WAREHOUSE_PG_* env vars.`;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function requiredText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function cleanRecord(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be a JSON object`);
  return stripLinkOpsRepositoryMetadata(value);
}

function cleanEnvelope(store, listKey) {
  return Object.fromEntries(
    Object.entries(store || {}).filter(([key]) => key !== listKey && key !== '_repository' && !key.startsWith('repository'))
  );
}

function isUntrustedLegacyIdentity(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return true;
  if (['anonymous', 'unknown', 'legacy', 'system', 'local-system', 'localhost'].includes(text)) return true;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(text)) return true;
  if (/^::1$/.test(text)) return true;
  if (/^system(?:[-_:]|$)/.test(text)) return true;
  return false;
}

function validateQuarantineOwner(value) {
  const owner = requiredText(value, 'quarantine owner');
  if (!/^quarantine:[A-Za-z0-9._:-]{1,100}$/.test(owner)) {
    throw new Error('quarantine owner must use the quarantine:<name> namespace');
  }
  return owner;
}

function resolveOwner(record, quarantineOwner, label, {allowUpdatedBy = false} = {}) {
  const candidates = [
    record?.ownerUser,
    record?.ownership?.ownerUser,
    record?.ownership?.actorKey,
    record?.ownership?.username,
    record?.requestedByUser,
    record?.createdByUser,
    allowUpdatedBy ? record?.updatedByUser : '',
  ];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (!isUntrustedLegacyIdentity(value)) return {ownerUser: value, quarantined: false};
  }
  return {
    ownerUser: validateQuarantineOwner(quarantineOwner),
    quarantined: true,
    quarantineReason: `${label} has no trusted legacy owner`,
  };
}

function resolveActor(record, owner, fallback) {
  const candidates = [record?.actorUser, record?.updatedByUser, record?.createdByUser, record?.requestedByUser, fallback, owner];
  return candidates.map(value => String(value || '').trim()).find(value => value && !isUntrustedLegacyIdentity(value)) || owner;
}

async function readJsonFile(file, fallback) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return structuredClone(fallback);
    throw error;
  }
  try {
    const value = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!isPlainObject(value)) throw new Error('top-level value must be an object');
    return value;
  } catch (error) {
    throw new Error(`Invalid JSON in ${file}: ${error.message}`);
  }
}

async function sha256File(file) {
  try {
    const bytes = await fs.readFile(file);
    return crypto.createHash('sha256').update(bytes).digest('hex');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {encoding: 'utf8', mode: 0o600});
  await fs.rename(temporary, file);
}

function assertUnique(entries, getId, label) {
  const seen = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const id = requiredText(getId(entries[index]), `${label}[${index}].id`);
    if (seen.has(id)) throw new Error(`Duplicate ${label} id: ${id}`);
    seen.add(id);
  }
  return seen;
}

async function buildImportPlan(args) {
  const [taskStore, chatStore, actionState, migrationSql, fileHashes] = await Promise.all([
    readJsonFile(args.taskFile, {version: 1, updatedAt: null, tasks: []}),
    readJsonFile(args.chatFile, {version: 1, updatedAt: null, sessions: []}),
    readJsonFile(args.actionFile, {version: 1, updatedAt: null, actions: {}}),
    fs.readFile(args.migrationFile, 'utf8'),
    Promise.all([sha256File(args.taskFile), sha256File(args.chatFile), sha256File(args.actionFile)]),
  ]);

  const sourceTasks = Array.isArray(taskStore.tasks)
    ? taskStore.tasks.map((record, index) => cleanRecord(record, `tasks[${index}]`))
    : [];
  const sourceSessions = Array.isArray(chatStore.sessions)
    ? chatStore.sessions.map((record, index) => cleanRecord(record, `sessions[${index}]`))
    : [];
  const sourceMessageCount = sourceSessions.reduce(
    (sum, session) => sum + (Array.isArray(session.messages) ? session.messages.length : 0),
    0,
  );
  const tasks = args.skipLegacyConversations ? [] : sourceTasks;
  const sessions = args.skipLegacyConversations ? [] : sourceSessions;
  const actions = isPlainObject(actionState.actions)
    ? Object.entries(actionState.actions).map(([key, record]) => ({key: requiredText(key, 'action key'), record: cleanRecord(record, `action ${key}`)}))
    : [];

  assertUnique(tasks, record => record.id || record.taskId, 'tasks');
  const sessionIds = assertUnique(sessions, record => record.id || record.sessionId, 'sessions');
  const messageIds = new Set();
  const sessionPlans = sessions.map((record, sortOrder) => {
    const id = requiredText(record.id || record.sessionId, `sessions[${sortOrder}].id`);
    const messages = Array.isArray(record.messages) ? record.messages.map((message, sequenceNo) => {
      const clean = cleanRecord(message, `session ${id} message ${sequenceNo}`);
      const messageId = requiredText(clean.id || clean.messageId, `session ${id} message ${sequenceNo}.id`);
      if (messageIds.has(messageId)) throw new Error(`Duplicate global message id: ${messageId}`);
      messageIds.add(messageId);
      return {record: clean, id: messageId, sequenceNo, payloadHash: linkOpsPayloadHash(clean)};
    }) : [];
    const session = {...record};
    delete session.messages;
    const ownership = resolveOwner(session, args.quarantineOwner, `session ${id}`);
    return {
      id,
      record: session,
      messages,
      sortOrder,
      ownerUser: ownership.ownerUser,
      actorUser: resolveActor(session, ownership.ownerUser, args.actorUser),
      quarantined: ownership.quarantined,
      payloadHash: linkOpsPayloadHash(session),
    };
  });

  const taskPlans = tasks.map((record, sortOrder) => {
    const id = requiredText(record.id || record.taskId, `tasks[${sortOrder}].id`);
    const detachedSession = detachOrphanTaskSession(record, sessionIds);
    const migratedRecord = detachedSession.record;
    const ownership = resolveOwner(migratedRecord, args.quarantineOwner, `task ${id}`);
    return {
      id,
      record: migratedRecord,
      sortOrder,
      ownerUser: ownership.ownerUser,
      actorUser: resolveActor(migratedRecord, ownership.ownerUser, args.actorUser),
      quarantined: ownership.quarantined,
      detachedOrphanSession: detachedSession.detached,
      originalChatSessionId: detachedSession.detached ? detachedSession.sessionId : '',
      payloadHash: linkOpsPayloadHash(migratedRecord),
    };
  });

  const actionPlans = actions.map(({key, record}) => {
    const ownership = resolveOwner(record, args.quarantineOwner, `action ${key}`, {allowUpdatedBy: true});
    return {
      id: key,
      record,
      ownerUser: ownership.ownerUser,
      actorUser: resolveActor(record, ownership.ownerUser, args.actorUser),
      quarantined: ownership.quarantined,
      payloadHash: linkOpsPayloadHash(record),
    };
  });

  const migrationHash = linkOpsPayloadHash(migrationSql);
  const manifestBase = {
    version: 1,
    migrationVersion: LINK_OPS_MIGRATION_VERSION,
    migrationHash,
    sourceFiles: [
      {kind: 'tasks', path: args.taskFile, sha256: fileHashes[0]},
      {kind: 'chats', path: args.chatFile, sha256: fileHashes[1]},
      {kind: 'actions', path: args.actionFile, sha256: fileHashes[2]},
    ],
    counts: {
      tasks: taskPlans.length,
      sessions: sessionPlans.length,
      messages: messageIds.size,
      actions: actionPlans.length,
    },
    sourceCounts: {
      tasks: sourceTasks.length,
      sessions: sourceSessions.length,
      messages: sourceMessageCount,
      actions: actions.length,
    },
    skippedLegacyConversations: {
      enabled: args.skipLegacyConversations,
      tasks: args.skipLegacyConversations ? sourceTasks.length : 0,
      sessions: args.skipLegacyConversations ? sourceSessions.length : 0,
      messages: args.skipLegacyConversations ? sourceMessageCount : 0,
    },
    owners: [...new Set([
      ...taskPlans.map(item => item.ownerUser),
      ...sessionPlans.map(item => item.ownerUser),
      ...actionPlans.map(item => item.ownerUser),
    ])].sort(),
    quarantine: {
      ownerUser: validateQuarantineOwner(args.quarantineOwner),
      tasks: taskPlans.filter(item => item.quarantined).length,
      sessions: sessionPlans.filter(item => item.quarantined).length,
      messages: sessionPlans.filter(item => item.quarantined).reduce((sum, item) => sum + item.messages.length, 0),
      actions: actionPlans.filter(item => item.quarantined).length,
    },
    detachedOrphanSessions: {
      tasks: taskPlans.filter(item => item.detachedOrphanSession).length,
      uniqueSessions: new Set(taskPlans.map(item => item.originalChatSessionId).filter(Boolean)).size,
      taskIds: taskPlans.filter(item => item.detachedOrphanSession).map(item => item.id),
    },
    hashes: {
      tasks: Object.fromEntries(taskPlans.map(item => [item.id, item.payloadHash])),
      sessions: Object.fromEntries(sessionPlans.map(item => [item.id, item.payloadHash])),
      messages: Object.fromEntries(sessionPlans.flatMap(item => item.messages.map(message => [message.id, message.payloadHash]))),
      actions: Object.fromEntries(actionPlans.map(item => [item.id, item.payloadHash])),
    },
  };
  const manifestHash = linkOpsPayloadHash(manifestBase);
  return {
    migrationSql,
    migrationHash,
    taskStoreMeta: args.skipLegacyConversations ? {version: 1, updatedAt: null} : cleanEnvelope(taskStore, 'tasks'),
    chatStoreMeta: args.skipLegacyConversations ? {version: 1, updatedAt: null} : cleanEnvelope(chatStore, 'sessions'),
    actionStoreMeta: cleanEnvelope(actionState, 'actions'),
    taskPlans,
    sessionPlans,
    actionPlans,
    manifest: {...manifestBase, manifestHash},
  };
}

async function ensureMigration(repository, plan) {
  let existing = null;
  try {
    existing = await repository.getMigration(LINK_OPS_MIGRATION_VERSION);
  } catch (error) {
    if (String(error?.code || '') !== '42P01' && String(error?.code || '') !== '3F000') throw error;
  }
  const storedHash = String(existing?.migration_hash || existing?.migrationHash || '').trim();
  if (storedHash && storedHash !== plan.migrationHash) {
    throw new Error(`Migration ${LINK_OPS_MIGRATION_VERSION} hash conflict: database=${storedHash} source=${plan.migrationHash}`);
  }
  if (!existing || !storedHash) {
    await repository.applyMigrationSql(plan.migrationSql, {
      version: LINK_OPS_MIGRATION_VERSION,
      migrationHash: plan.migrationHash,
    });
    return {applied: true, migrationHash: plan.migrationHash};
  }
  return {applied: false, migrationHash: storedHash};
}

function increment(counts, key, skipped) {
  counts[key] += 1;
  if (skipped) counts[`${key}Skipped`] += 1;
}

async function verifyHashes(repository, plan) {
  const checks = [
    ['task', plan.taskPlans, {}],
    ['session', plan.sessionPlans, {}],
    ['message', plan.sessionPlans.flatMap(session => session.messages), {}],
    ['record', plan.actionPlans, {recordType: 'action_state'}],
  ];
  const mismatches = [];
  for (const [entityType, items, options] of checks) {
    if (!items.length) continue;
    const stored = await repository.getStoredHashes(entityType, items.map(item => item.id), options);
    for (const item of items) {
      if (stored.get(item.id) !== item.payloadHash) {
        mismatches.push({entityType, id: item.id, expected: item.payloadHash, actual: stored.get(item.id) || null});
      }
    }
  }
  if (mismatches.length) {
    throw new Error(`Post-import hash verification failed: ${JSON.stringify(mismatches.slice(0, 20))}`);
  }
  return {ok: true, checked: checks.reduce((sum, [, items]) => sum + items.length, 0)};
}

async function executeImport(args, plan) {
  const repository = createLinkOpsRepository({mode: 'postgres', env: process.env});
  let batch = null;
  try {
    const migration = await ensureMigration(repository, plan);
    const batchId = `linkops_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${plan.manifest.manifestHash.slice(0, 12)}`;
    batch = await repository.beginImportBatch({
      batchId,
      idempotencyKey: `json-to-postgres:${plan.manifest.manifestHash}`,
      migrationVersion: LINK_OPS_MIGRATION_VERSION,
      manifestHash: plan.manifest.manifestHash,
      manifest: plan.manifest,
      actorUser: args.actorUser,
      sourceKind: 'json',
      counts: plan.manifest.counts,
    });
    if (batch.skipped && String(batch.status || '') === 'failed') {
      throw new Error(`Import batch ${batch.batch_id || batch.batchId} previously failed; inspect it before retrying`);
    }
    const counts = {
      sessions: 0, sessionsSkipped: 0,
      messages: 0, messagesSkipped: 0,
      tasks: 0, tasksSkipped: 0,
      actions: 0, actionsSkipped: 0,
    };

    await repository.importMeta('session_store', plan.chatStoreMeta, {actorUser: args.actorUser});
    await repository.importMeta('task_store', plan.taskStoreMeta, {actorUser: args.actorUser});
    await repository.importMeta('action_store', plan.actionStoreMeta, {actorUser: args.actorUser});

    for (const session of plan.sessionPlans) {
      const imported = await repository.importSession(session.record, {
        batchId: batch.batch_id || batch.batchId,
        ownerUser: session.ownerUser,
        actorUser: session.actorUser,
        sortOrder: session.sortOrder,
      });
      increment(counts, 'sessions', imported.skipped);
      for (const message of session.messages) {
        const importedMessage = await repository.importMessage(session.id, message.record, {
          batchId: batch.batch_id || batch.batchId,
          ownerUser: session.ownerUser,
          actorUser: session.actorUser,
          sequenceNo: message.sequenceNo,
        });
        increment(counts, 'messages', importedMessage.skipped);
      }
    }

    for (const task of plan.taskPlans) {
      const imported = await repository.importTask(task.record, {
        batchId: batch.batch_id || batch.batchId,
        ownerUser: task.ownerUser,
        actorUser: task.actorUser,
        sortOrder: task.sortOrder,
      });
      increment(counts, 'tasks', imported.skipped);
    }

    for (const action of plan.actionPlans) {
      const imported = await repository.importRecord('action_state', action.id, action.record, {
        batchId: batch.batch_id || batch.batchId,
        ownerUser: action.ownerUser,
        actorUser: action.actorUser,
        status: String(action.record.status || ''),
      });
      increment(counts, 'actions', imported.skipped);
    }

    const verification = await verifyHashes(repository, plan);
    if (!batch.skipped || ['prepared', 'running'].includes(String(batch.status || ''))) {
      await repository.finishImportBatch(batch.batch_id || batch.batchId, {status: 'succeeded', counts});
    }
    return {
      ok: true,
      mode: 'execute',
      migration,
      batchId: batch.batch_id || batch.batchId,
      batchReused: Boolean(batch.skipped),
      counts,
      verification,
      health: await repository.health(),
    };
  } catch (error) {
    const batchId = batch?.batch_id || batch?.batchId;
    if (batchId && (!batch.skipped || ['prepared', 'running'].includes(String(batch.status || '')))) {
      await repository.finishImportBatch(batchId, {
        status: 'failed',
        error: {code: String(error?.code || 'IMPORT_FAILED'), message: String(error?.message || error).slice(0, 2_000)},
      }).catch(() => {});
    }
    throw error;
  } finally {
    await repository.close();
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}

const plan = await buildImportPlan(args);
if (args.manifestOut) await writeJsonAtomic(args.manifestOut, plan.manifest);
if (!args.execute) {
  console.log(JSON.stringify({ok: true, mode: 'dry-run', manifest: plan.manifest}, null, 2));
} else {
  const result = await executeImport(args, plan);
  console.log(JSON.stringify({...result, manifest: plan.manifest}, null, 2));
}
