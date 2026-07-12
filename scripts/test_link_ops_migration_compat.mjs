#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  detachOrphanTaskSession,
  restoreDetachedOrphanTaskSession,
} from '../lib/link_ops_migration_compat.mjs';

const known = new Set(['session-live']);
const live = detachOrphanTaskSession({id: 'task-live', chatSessionId: 'session-live'}, known);
assert.equal(live.detached, false);
assert.equal(live.record.chatSessionId, 'session-live');

const original = {
  id: 'task-orphan',
  chatSessionId: 'session-missing',
  chat: {sessionId: 'session-missing', source: 'legacy'},
  status: 'waiting_review',
};
const detached = detachOrphanTaskSession(original, known);
assert.equal(detached.detached, true);
assert.equal(detached.sessionId, 'session-missing');
assert.equal(detached.record.chatSessionId, undefined);
assert.equal(detached.record.chat.sessionId, undefined);
assert.equal(detached.record.chat.source, 'legacy');
assert.equal(detached.record.linkOpsMigration.detachedOrphanChatSession.sessionId, 'session-missing');
assert.equal(original.chatSessionId, 'session-missing', 'input must not be mutated');

const restored = restoreDetachedOrphanTaskSession(detached.record);
assert.equal(restored.restored, true);
assert.equal(restored.record.chatSessionId, 'session-missing');
assert.equal(restored.record.chat.sessionId, 'session-missing');
assert.equal(restored.record.chat.source, 'legacy');
assert.equal(restored.record.linkOpsMigration, undefined);

assert.throws(
  () => detachOrphanTaskSession({id: 'bad', chatSessionId: 'a', chat: {sessionId: 'b'}}, known),
  /conflicting chat session references/,
);

console.log('link_ops_migration_compat: orphan detach and rollback restoration passed');
