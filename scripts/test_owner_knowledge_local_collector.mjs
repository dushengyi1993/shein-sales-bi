import assert from 'node:assert/strict';
import {collectOwnerKnowledgeEvents, normalizeOwnerKnowledgeSyncState, redactOwnerKnowledgeSensitiveText} from '../lib/owner_knowledge_local_collector.mjs';

await assert.rejects(() => collectOwnerKnowledgeEvents(), error => error?.code === 'OWNER_KNOWLEDGE_SCANNER_RETIRED');
assert.deepEqual(normalizeOwnerKnowledgeSyncState(), {version: 2, retired: true});
assert.equal(redactOwnerKnowledgeSensitiveText('token=abcdefghijklmnop').includes('abcdefghijklmnop'), false);
console.log(JSON.stringify({ok: true, suite: 'owner_knowledge_local_collector_retired'}));
