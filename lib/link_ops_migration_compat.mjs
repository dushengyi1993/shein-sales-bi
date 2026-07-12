const MIGRATION_KEY = 'linkOpsMigration';
const ORPHAN_KEY = 'detachedOrphanChatSession';

function cloneRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('task record must be a JSON object');
  }
  return structuredClone(record);
}

function sessionReferences(record) {
  return [
    ['chatSessionId', record.chatSessionId],
    ['sessionId', record.sessionId],
    ['chat.sessionId', record.chat?.sessionId],
  ].map(([path, value]) => [path, String(value || '').trim()]).filter(([, value]) => value);
}

function deletePath(record, path) {
  if (path === 'chat.sessionId') {
    if (record.chat && typeof record.chat === 'object' && !Array.isArray(record.chat)) {
      delete record.chat.sessionId;
      if (!Object.keys(record.chat).length) delete record.chat;
    }
    return;
  }
  delete record[path];
}

function setPath(record, path, value) {
  if (path === 'chat.sessionId') {
    if (!record.chat || typeof record.chat !== 'object' || Array.isArray(record.chat)) record.chat = {};
    record.chat.sessionId = value;
    return;
  }
  record[path] = value;
}

export function detachOrphanTaskSession(record, knownSessionIds) {
  const clean = cloneRecord(record);
  const references = sessionReferences(clean);
  if (!references.length) return {record: clean, detached: false, sessionId: '', paths: []};
  const uniqueIds = [...new Set(references.map(([, value]) => value))];
  if (uniqueIds.length !== 1) {
    throw new Error(`Task has conflicting chat session references: ${uniqueIds.join(', ')}`);
  }
  const sessionId = uniqueIds[0];
  const known = knownSessionIds instanceof Set ? knownSessionIds : new Set(knownSessionIds || []);
  if (known.has(sessionId)) return {record: clean, detached: false, sessionId, paths: references.map(([path]) => path)};

  const paths = references.map(([path]) => path);
  for (const path of paths) deletePath(clean, path);
  const migration = clean[MIGRATION_KEY] && typeof clean[MIGRATION_KEY] === 'object' && !Array.isArray(clean[MIGRATION_KEY])
    ? clean[MIGRATION_KEY]
    : {};
  clean[MIGRATION_KEY] = {
    ...migration,
    [ORPHAN_KEY]: {
      sessionId,
      paths,
      reason: 'legacy task referenced a chat session absent from the JSON snapshot',
    },
  };
  return {record: clean, detached: true, sessionId, paths};
}

export function restoreDetachedOrphanTaskSession(record) {
  const clean = cloneRecord(record);
  const marker = clean[MIGRATION_KEY]?.[ORPHAN_KEY];
  const sessionId = String(marker?.sessionId || '').trim();
  const paths = Array.isArray(marker?.paths) ? marker.paths.map(String) : [];
  if (!sessionId || !paths.length) return {record: clean, restored: false, sessionId: '', paths: []};
  for (const path of paths) {
    if (!['chatSessionId', 'sessionId', 'chat.sessionId'].includes(path)) {
      throw new Error(`Unsupported orphan chat session path: ${path}`);
    }
    setPath(clean, path, sessionId);
  }
  const migration = {...clean[MIGRATION_KEY]};
  delete migration[ORPHAN_KEY];
  if (Object.keys(migration).length) clean[MIGRATION_KEY] = migration;
  else delete clean[MIGRATION_KEY];
  return {record: clean, restored: true, sessionId, paths};
}
