#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {provisionBiSessionSecret} from './provision_bi_session_secret.mjs';
import {createLinkOpsJsonRepository} from '../lib/link_ops_json_repository.mjs';
import {createLinkOpsStoreGateway} from '../lib/link_ops_store_gateway.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-bi-ops-multitenant-'));
const portalDir = path.join(temp, 'portal');
const authFile = path.join(temp, 'auth.json');
const accessRolesFile = path.join(temp, 'access_roles.json');
const htpasswdFile = path.join(temp, 'empty.htpasswd');
const sessionSecretFile = path.join(temp, 'session_secret');
await provisionBiSessionSecret(sessionSecretFile);
const stateFile = path.join(temp, 'action_state.json');
const runtimeFile = path.join(temp, 'link_ops_runtime.json');
const taskFile = path.join(temp, 'tasks.json');
const chatFile = path.join(temp, 'chats.json');
const auditFile = path.join(temp, 'audit.jsonl');
const manualLoginStateFile = path.join(temp, 'manual_login.json');
const openapiConfigFile = path.join(temp, 'openapi.json');
const whitelistFile = path.join(temp, 'whitelist.json');
const port = await freePort();

const LEGACY_ALICE_TASK = 'lot_legacy_alice_0001';
const LEGACY_UNOWNED_TASK = 'lot_legacy_unowned_0001';
const LEGACY_ALICE_SESSION = 'los_legacy_alice_0001';
const LEGACY_UNOWNED_SESSION = 'los_legacy_unowned_0001';

await fs.mkdir(portalDir, {recursive: true});
await Promise.all([
  writeJson(authFile, {
    users: [
      {username: 'alice', password: 'alice-pass', role: 'operator', ownerKey: 'ALICE', readStores: ['DX'], writeStores: ['DX']},
      {username: 'charlie', password: 'charlie-pass', role: 'operator', ownerKey: 'CHARLIE', readStores: ['DX'], writeStores: ['DX']},
      {username: 'bob', password: 'bob-pass', role: 'operator', ownerKey: 'BOB', readStores: ['HL'], writeStores: ['HL']},
      {username: 'owner', password: 'owner-pass', role: 'owner', ownerKey: 'OWNER', readStores: ['*'], writeStores: ['*']},
      {username: 'viewer', password: 'viewer-pass', role: 'viewer', ownerKey: 'VIEWER', readStores: ['DX'], writeStores: ['DX']},
    ],
  }),
  writeJson(accessRolesFile, {
    defaults: {
      owner: {readStores: ['*'], writeStores: ['*']},
      operator: {readStores: [], writeStores: []},
      viewer: {readStores: [], writeStores: []},
    },
    users: {},
  }),
  fs.writeFile(htpasswdFile, '', 'utf8'),
  fs.writeFile(path.join(portalDir, 'index.html'), '<!doctype html><meta charset="utf-8"><title>multitenant test</title>', 'utf8'),
  writeJson(stateFile, {version: 1, updatedAt: null, actions: {}}),
  writeJson(taskFile, {
    version: 1,
    updatedAt: '2026-07-10T00:00:00.000Z',
    tasks: [
      legacyTask(LEGACY_ALICE_TASK, 'alice', 'DX'),
      legacyTask(LEGACY_UNOWNED_TASK, '127.0.0.1', 'DX'),
    ],
  }),
  writeJson(chatFile, {
    version: 1,
    updatedAt: '2026-07-10T00:00:00.000Z',
    sessions: [
      legacySession(LEGACY_ALICE_SESSION, 'alice', 'DX'),
      legacySession(LEGACY_UNOWNED_SESSION, '127.0.0.1', 'DX'),
    ],
  }),
  writeJson(openapiConfigFile, {stores: []}),
  writeJson(whitelistFile, {enabled: false, rules: []}),
]);

const child = spawn(process.execPath, [
  path.join(ROOT, 'scripts', 'serve_bi_portal.mjs'),
  '--host', '127.0.0.1',
  '--port', String(port),
  '--dir', portalDir,
  '--auth-file', authFile,
  '--access-roles-file', accessRolesFile,
  '--htpasswd-file', htpasswdFile,
  '--session-secret-file', sessionSecretFile,
  '--state-file', stateFile,
  '--link-ops-task-file', taskFile,
  '--link-ops-chat-file', chatFile,
  '--link-ops-runtime-file', runtimeFile,
  '--manual-login-state-file', manualLoginStateFile,
  '--audit-file', auditFile,
], {
  cwd: ROOT,
  env: {
    ...process.env,
    SHEIN_BI_CORE_WARMUP_DISABLED: '1',
    SHEIN_OPENAPI_CONFIG_FILE: openapiConfigFile,
    SHEIN_BI_OPS_WRITE_WHITELIST_FILE: whitelistFile,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });

const base = `http://127.0.0.1:${port}`;
const results = {checks: 0};

try {
  await waitForServer();
  const cookies = {
    alice: await login('alice', 'alice-pass'),
    charlie: await login('charlie', 'charlie-pass'),
    bob: await login('bob', 'bob-pass'),
    owner: await login('owner', 'owner-pass'),
    viewer: await login('viewer', 'viewer-pass'),
  };

  await testActionStateGates(cookies);
  await testActionStateCasGateway(cookies);
  await testActionStateCasConcurrency(cookies);
  const sessions = await testSessionIsolation(cookies);
  await testTaskIsolation(cookies, sessions);
  await testLegacyOwnership(cookies);

  const auditText = await fs.readFile(auditFile, 'utf8');
  assert.match(auditText, /action-state-denied/);
  assert.match(auditText, /link-ops-chat-(?:update-|delete-)?denied/);
  assert.match(auditText, /link-ops-task-update-denied/);
  results.checks += 3;

  console.log(JSON.stringify({ok: true, checks: results.checks, suite: 'bi_ops_multitenant_isolation'}, null, 2));
} finally {
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await fs.rm(temp, {recursive: true, force: true});
}

async function testActionStateGates(cookies) {
  const dxKey = '2026-07-11|DX|inventory|low stock|SKU-A|';
  const hlKey = '2026-07-11|HL|inventory|low stock|SKU-B|';

  await expectStatus('/api/action-state', 200, {
    method: 'POST', cookie: cookies.alice, body: {key: dxKey, status: 'review', note: 'alice owns DX'},
  });
  await expectStatus('/api/action-state', 403, {
    method: 'POST', cookie: cookies.alice, body: {key: hlKey, status: 'done'},
  });
  await expectStatus('/api/action-state', 403, {
    method: 'POST', cookie: cookies.viewer, body: {key: dxKey, status: 'done'},
  });
  await expectStatus('/api/action-state', 403, {
    method: 'POST', cookie: cookies.alice, body: {
      actions: [
        {key: dxKey, status: 'done'},
        {key: hlKey, status: 'done'},
      ],
    },
  });
  await expectStatus('/api/action-state', 400, {
    method: 'POST', cookie: cookies.alice, body: {key: 'missing-store', status: 'done'},
  });

  const raw = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assert.equal(raw.actions[dxKey]?.status, 'review', 'mixed-store batch must be atomic and leave the prior DX state unchanged');
  assert.equal(raw.actions[hlKey], undefined, 'operator must not write an unauthorized store action');
  results.checks += 7;
}

async function testActionStateCasGateway(cookies) {
  const dxKey = '2026-07-11|DX|inventory|low stock|SKU-A|';
  const dxKey2 = '2026-07-11|DX|inventory|low stock|SKU-C|';
  const dxKey3 = '2026-07-11|DX|inventory|low stock|SKU-D|';

  // Single update through the route must carry the same-request fresh
  // repositoryRevision under the CAS gateway.
  await expectStatus('/api/action-state', 200, {
    method: 'POST', cookie: cookies.alice, body: {key: dxKey, status: 'done', note: 'CAS update'},
  });
  let data = (await expectStatus('/api/action-state', 200, {cookie: cookies.alice})).json.data;
  assert.equal(data.actions[dxKey]?.status, 'done', 'single update must persist under the gateway');

  // Single delete is an explicit row delete bound to the fresh revision, not
  // an ignored omission.
  await expectStatus('/api/action-state', 200, {
    method: 'POST', cookie: cookies.alice, body: {key: dxKey3, status: 'open', note: 'temporary'},
  });
  await expectStatus('/api/action-state', 200, {
    method: 'POST', cookie: cookies.alice, body: {key: dxKey3, status: 'open', note: ''},
  });
  data = (await expectStatus('/api/action-state', 200, {cookie: cookies.alice})).json.data;
  assert.equal(data.actions[dxKey3], undefined, 'deleted action must disappear from GET');
  const rawRuntime = JSON.parse(await fs.readFile(runtimeFile, 'utf8'));
  assert.ok(rawRuntime.records?.action_state?.[dxKey3]?.deletedAt, 'delete must be a repository deletion, not a no-op omission');

  // A multi-action batch in one request must be applied as a single atomic
  // changes array: update dxKey and create dxKey2 in the same POST.
  await expectStatus('/api/action-state', 200, {
    method: 'POST', cookie: cookies.alice, body: {
      actions: [
        {key: dxKey, status: 'review', note: 'batched update'},
        {key: dxKey2, status: 'ignored', note: 'batched create'},
      ],
    },
  });
  data = (await expectStatus('/api/action-state', 200, {cookie: cookies.alice})).json.data;
  assert.equal(data.actions[dxKey]?.status, 'review', 'batched update must persist');
  assert.equal(data.actions[dxKey2]?.status, 'ignored', 'batched create must persist');
  results.checks += 8;
}

async function testActionStateCasConcurrency(cookies) {
  // A second store instance over the same runtime is the concurrent writer
  // that races the portal's fresh read.
  const repository = createLinkOpsJsonRepository({
    taskFile,
    sessionFile: chatFile,
    actionFile: stateFile,
    runtimeFile,
  });
  const peer = createLinkOpsStoreGateway({repository});
  const dxKey = '2026-07-11|DX|inventory|low stock|SKU-A|';
  const atomicKey = '2026-07-11|DX|inventory|low stock|SKU-ATOMIC|';

  const peerState = await peer.readActionState();
  const winnerSnapshot = structuredClone(peerState.actions[dxKey]);
  const winnerReadback = await peer.applyActionChanges([
    {
      key: dxKey,
      expectedRevision: winnerSnapshot.repositoryRevision,
      record: {...winnerSnapshot, status: 'ignored', note: 'concurrent winner'},
    },
  ], {actorUser: 'owner'});
  const winnerRevision = Number(winnerReadback.actions[dxKey].repositoryRevision);
  assert.equal(winnerRevision, Number(winnerSnapshot.repositoryRevision) + 1, 'winner advances the revision');

  // A stale writer that read before the winner must fail closed and never
  // overwrite the winner's committed row.
  await assert.rejects(
    peer.applyActionChanges([
      {
        key: dxKey,
        expectedRevision: winnerSnapshot.repositoryRevision,
        record: {...winnerSnapshot, status: 'done', note: 'stale loser'},
      },
    ], {actorUser: 'alice'}),
    error => error?.code === 'LINK_OPS_REVISION_CONFLICT',
    'stale revision must surface a repository conflict'
  );
  const afterConflict = await peer.readActionState();
  assert.equal(afterConflict.actions[dxKey].status, 'ignored', 'stale writer must not overwrite the winner');
  assert.equal(afterConflict.actions[dxKey].note, 'concurrent winner');
  assert.equal(Number(afterConflict.actions[dxKey].repositoryRevision), winnerRevision);

  // A stale update inside an atomic batch rejects the whole batch; the create
  // in the same batch must not partially persist.
  await assert.rejects(
    peer.applyActionChanges([
      {
        key: dxKey,
        expectedRevision: winnerSnapshot.repositoryRevision,
        record: {...winnerSnapshot, status: 'done'},
      },
      {
        key: atomicKey,
        expectedRevision: null,
        record: {status: 'review', note: 'must roll back', updatedAt: new Date().toISOString()},
      },
    ], {actorUser: 'alice'}),
    error => error?.code === 'LINK_OPS_REVISION_CONFLICT',
    'a stale entry in an atomic batch must reject the batch'
  );
  const atomicState = await peer.readActionState();
  assert.equal(atomicState.actions[atomicKey], undefined, 'conflicting batch must persist nothing');

  // The portal route still fails closed with the normalized 409 conflict
  // response when the store advanced between its snapshot and write: peer
  // deletes the row first, and the portal's create attempt collides.
  await peer.applyActionChanges([
    {key: dxKey, delete: true, expectedRevision: winnerRevision},
  ], {actorUser: 'owner'});
  const conflict = await request('/api/action-state', {
    method: 'POST', cookie: cookies.alice, body: {key: dxKey, status: 'review', note: 'after winner'},
  });
  assert.equal(conflict.status, 409, 'concurrent store advance must fail closed at the HTTP boundary');
  assert.equal(conflict.json?.code, 'LINK_OPS_ALREADY_EXISTS');
  results.checks += 12;
}

async function testSessionIsolation(cookies) {
  const aliceInitial = await expectStatus('/api/link-ops-chats?limit=50', 200, {cookie: cookies.alice});
  assert.deepEqual(sessionIds(aliceInitial), [LEGACY_ALICE_SESSION]);

  const ownerDefault = await expectStatus('/api/link-ops-chats?limit=50', 200, {cookie: cookies.owner});
  assert.deepEqual(sessionIds(ownerDefault), [LEGACY_UNOWNED_SESSION]);
  const ownerGlobalSeed = await expectStatus('/api/link-ops-chats?scope=all&limit=50', 200, {cookie: cookies.owner});
  assert.deepEqual(new Set(sessionIds(ownerGlobalSeed)), new Set([LEGACY_ALICE_SESSION, LEGACY_UNOWNED_SESSION]));
  await expectStatus('/api/link-ops-chats?scope=all', 403, {cookie: cookies.alice});

  const alice = await createSession(cookies.alice, 'DX 日常观察记录');
  const charlie = await createSession(cookies.charlie, 'DX 另一位运营的观察记录');
  const bob = await createSession(cookies.bob, 'HL 日常观察记录');

  assert.equal(alice.ownership?.actorKey, 'alice');
  assert.equal(alice.ownership?.ownerKey, 'ALICE');
  await expectStatus('/api/link-ops-chats', 200, {
    method: 'POST', cookie: cookies.alice, body: {sessionId: alice.id, message: '追加本人记录', askAgent: false},
  });
  await expectStatus('/api/link-ops-chats', 403, {
    method: 'POST', cookie: cookies.alice, body: {sessionId: charlie.id, message: '越权追加', askAgent: false},
  });
  await expectStatus('/api/link-ops-chats', 403, {
    method: 'POST', cookie: cookies.owner, body: {sessionId: alice.id, message: 'owner 不应默认污染他人会话', askAgent: false},
  });
  await expectStatus('/api/link-ops-chats', 403, {
    method: 'PATCH', cookie: cookies.alice, body: {id: charlie.id, title: '越权改名'},
  });
  await expectStatus(`/api/link-ops-chats?id=${encodeURIComponent(charlie.id)}`, 403, {
    method: 'DELETE', cookie: cookies.alice,
  });
  await expectStatus('/api/link-ops-chats', 200, {
    method: 'PATCH', cookie: cookies.alice, body: {id: alice.id, title: 'Alice renamed'},
  });

  const disposable = await createSession(cookies.alice, 'DX disposable session');
  await expectStatus(`/api/link-ops-chats?id=${encodeURIComponent(disposable.id)}`, 200, {
    method: 'DELETE', cookie: cookies.alice,
  });
  const ownerGlobal = await expectStatus('/api/link-ops-chats?scope=all&limit=50', 200, {cookie: cookies.owner});
  assert.ok(sessionIds(ownerGlobal).includes(charlie.id));
  assert.ok(sessionIds(ownerGlobal).includes(bob.id));
  assert.ok(!sessionIds(ownerGlobal).includes(disposable.id));
  results.checks += 18;
  return {alice, charlie, bob};
}

async function testTaskIsolation(cookies, sessions) {
  const alice = await createTask(cookies.alice, 'Alice DX task', 'DX');
  const charlie = await createTask(cookies.charlie, 'Charlie DX task', 'DX');
  const bob = await createTask(cookies.bob, 'Bob HL task', 'HL');
  const aliceLinked = await createTask(cookies.alice, 'Alice linked DX task', 'DX', sessions.alice.id);

  assert.equal(alice.ownership?.actorKey, 'alice');
  assert.equal(alice.ownership?.ownerKey, 'ALICE');
  assert.equal(aliceLinked.chatSessionId, sessions.alice.id);

  await expectStatus('/api/link-ops-tasks', 403, {
    method: 'POST', cookie: cookies.alice, body: taskBody('cross-session task', 'DX', sessions.charlie.id),
  });
  await expectStatus('/api/link-ops-tasks', 403, {
    method: 'POST', cookie: cookies.alice, body: taskBody('wrong-store task', 'HL', sessions.alice.id),
  });

  const aliceList = await expectStatus('/api/link-ops-tasks?limit=100', 200, {cookie: cookies.alice});
  const aliceIds = taskIds(aliceList);
  assert.ok(aliceIds.includes(LEGACY_ALICE_TASK));
  assert.ok(aliceIds.includes(alice.id));
  assert.ok(aliceIds.includes(aliceLinked.id));
  assert.ok(!aliceIds.includes(LEGACY_UNOWNED_TASK));
  assert.ok(!aliceIds.includes(charlie.id));
  assert.ok(!aliceIds.includes(bob.id));

  await expectStatus('/api/link-ops-tasks?scope=all', 403, {cookie: cookies.alice});
  const ownerGlobal = await expectStatus('/api/link-ops-tasks?scope=all&limit=100', 200, {cookie: cookies.owner});
  for (const id of [LEGACY_ALICE_TASK, LEGACY_UNOWNED_TASK, alice.id, aliceLinked.id, charlie.id, bob.id]) {
    assert.ok(taskIds(ownerGlobal).includes(id), `owner scope=all missing ${id}`);
  }
  await expectStatus(`/api/link-ops-tasks?sessionId=${encodeURIComponent(sessions.charlie.id)}`, 403, {cookie: cookies.alice});
  const ownerScoped = await expectStatus(`/api/link-ops-tasks?scope=all&sessionId=${encodeURIComponent(sessions.alice.id)}`, 200, {cookie: cookies.owner});
  assert.ok(taskIds(ownerScoped).includes(aliceLinked.id));

  await expectStatus('/api/link-ops-tasks', 403, {
    method: 'PATCH', cookie: cookies.alice, body: {id: charlie.id, status: 'done'},
  });
  await expectStatus(`/api/link-ops-tasks?id=${encodeURIComponent(charlie.id)}`, 403, {
    method: 'DELETE', cookie: cookies.alice,
  });
  await expectStatus('/api/link-ops-execute', 403, {
    method: 'POST', cookie: cookies.alice, body: {taskId: charlie.id, mode: 'dry_run'},
  });
  await expectStatus('/api/link-ops-assets', 403, {
    method: 'POST', cookie: cookies.alice, body: {taskId: charlie.id, sessionId: sessions.charlie.id, files: []},
  });
  await expectStatus('/api/link-ops-assets', 403, {
    method: 'POST', cookie: cookies.alice, body: {sessionId: sessions.charlie.id, files: []},
  });
  await expectStatus('/api/link-ops-tasks', 403, {
    method: 'PATCH', cookie: cookies.owner, body: {id: alice.id, status: 'done', note: 'owner must not silently mutate another actor'},
  });
  await expectStatus(`/api/link-ops-audit?taskId=${encodeURIComponent(alice.id)}`, 200, {cookie: cookies.owner});
  await expectStatus(`/api/link-ops-audit?taskId=${encodeURIComponent(alice.id)}`, 403, {cookie: cookies.charlie});

  await expectStatus('/api/link-ops-tasks', 200, {
    method: 'PATCH', cookie: cookies.alice, body: {id: alice.id, note: 'own task update'},
  });
  const disposable = await createTask(cookies.alice, 'Alice disposable task', 'DX');
  await expectStatus(`/api/link-ops-tasks?id=${encodeURIComponent(disposable.id)}`, 200, {
    method: 'DELETE', cookie: cookies.alice,
  });
  const rawTasks = JSON.parse(await fs.readFile(taskFile, 'utf8')).tasks;
  assert.ok(rawTasks.some(task => task.id === charlie.id), 'cross-tenant delete must not remove Charlie task');
  assert.ok(!rawTasks.some(task => task.id === disposable.id), 'operator should be able to delete own task');
  results.checks += 34;
}

async function testLegacyOwnership(cookies) {
  await expectStatus('/api/link-ops-tasks', 200, {
    method: 'PATCH', cookie: cookies.alice, body: {id: LEGACY_ALICE_TASK, note: 'derived legacy owner'},
  });
  await expectStatus('/api/link-ops-tasks', 403, {
    method: 'PATCH', cookie: cookies.alice, body: {id: LEGACY_UNOWNED_TASK, note: 'operator cannot claim anonymous legacy'},
  });
  await expectStatus('/api/link-ops-tasks', 200, {
    method: 'PATCH', cookie: cookies.owner, body: {id: LEGACY_UNOWNED_TASK, note: 'owner safely claims anonymous legacy'},
  });
  await expectStatus('/api/link-ops-chats', 200, {
    method: 'PATCH', cookie: cookies.alice, body: {id: LEGACY_ALICE_SESSION, title: 'legacy alice claimed by derivation'},
  });
  await expectStatus('/api/link-ops-chats', 200, {
    method: 'PATCH', cookie: cookies.owner, body: {id: LEGACY_UNOWNED_SESSION, title: 'legacy owner claim'},
  });

  const rawTasks = JSON.parse(await fs.readFile(taskFile, 'utf8')).tasks;
  const rawChats = JSON.parse(await fs.readFile(chatFile, 'utf8')).sessions;
  const legacyAliceTask = rawTasks.find(task => task.id === LEGACY_ALICE_TASK);
  const legacyOwnerTask = rawTasks.find(task => task.id === LEGACY_UNOWNED_TASK);
  const legacyAliceSession = rawChats.find(session => session.id === LEGACY_ALICE_SESSION);
  const legacyOwnerSession = rawChats.find(session => session.id === LEGACY_UNOWNED_SESSION);

  assert.equal(legacyAliceTask.ownership?.actorKey, 'alice');
  assert.equal(legacyAliceTask.ownership?.ownerKey, 'ALICE');
  assert.equal(legacyAliceTask.ownership?.source, 'legacy_requested_by_user');
  assert.equal(legacyOwnerTask.ownership?.actorKey, 'owner');
  assert.equal(legacyOwnerTask.ownership?.source, 'legacy_owner_claim');
  assert.equal(legacyAliceSession.ownership?.actorKey, 'alice');
  assert.equal(legacyAliceSession.ownership?.ownerKey, 'ALICE');
  assert.equal(legacyAliceSession.ownership?.source, 'legacy_requested_by_user');
  assert.equal(legacyOwnerSession.ownership?.actorKey, 'owner');
  assert.equal(legacyOwnerSession.ownership?.source, 'legacy_owner_claim');
  results.checks += 15;
}

function legacyTask(id, requestedByUser, storeKey) {
  return {
    id,
    version: 1,
    status: 'draft',
    progress: 10,
    source: 'legacy_test',
    command: `${storeKey} legacy task`,
    requestedBy: requestedByUser,
    requestedByUser,
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
    intents: ['update_inventory'],
    targets: {stores: [storeKey], writeStores: [storeKey], productRefs: ['SKU-LEGACY']},
    history: [],
  };
}

function legacySession(id, requestedByUser, storeKey) {
  return {
    id,
    version: 1,
    status: 'chatting',
    title: `${storeKey} legacy session`,
    requestedBy: requestedByUser,
    requestedByUser,
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
    targets: {stores: [storeKey]},
    messages: [{id: `${id}_message`, role: 'user', content: 'legacy', at: '2026-07-10T00:00:00.000Z'}],
  };
}

function taskBody(label, storeKey, chatSessionId = '') {
  return {
    source: 'multitenant_test',
    command: `${label}: 更新 ${storeKey} 的 SKU-TEST 库存`,
    chatSessionId,
    targets: {stores: [storeKey], writeStores: [storeKey], productRefs: ['SKU-TEST']},
  };
}

async function createTask(cookie, label, storeKey, chatSessionId = '') {
  const response = await expectStatus('/api/link-ops-tasks', 200, {
    method: 'POST', cookie, body: taskBody(label, storeKey, chatSessionId),
  });
  assert.ok(response.json?.task?.id, `missing task id for ${label}`);
  results.checks += 1;
  return response.json.task;
}

async function createSession(cookie, message) {
  const response = await expectStatus('/api/link-ops-chats', 200, {
    method: 'POST', cookie, body: {message, askAgent: false},
  });
  assert.ok(response.json?.session?.id, `missing session id for ${message}`);
  results.checks += 1;
  return response.json.session;
}

function taskIds(response) {
  return (response.json?.data?.tasks || []).map(task => task.id);
}

function sessionIds(response) {
  return (response.json?.data?.sessions || []).map(session => session.id);
}

async function expectStatus(urlPath, expected, options = {}) {
  const response = await request(urlPath, options);
  assert.equal(response.status, expected, `${options.method || 'GET'} ${urlPath}: ${response.text}`);
  results.checks += 1;
  return response;
}

async function request(urlPath, {method = 'GET', cookie = '', body = undefined} = {}) {
  const response = await fetch(`${base}${urlPath}`, {
    method,
    headers: {
      ...(cookie ? {cookie} : {}),
      ...(body === undefined ? {} : {'content-type': 'application/json'}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return {status: response.status, headers: response.headers, text, json};
}

async function login(username, password) {
  const response = await request('/api/login', {method: 'POST', body: {username, password}});
  const cookie = (response.headers.get('set-cookie') || '').match(/bi_session=[^;]+/)?.[0] || '';
  assert.equal(response.status, 200, `login failed for ${username}: ${response.text}`);
  assert.ok(cookie, `login cookie missing for ${username}`);
  return cookie;
}

async function waitForServer() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`portal exited before startup\nstdout=${stdout}\nstderr=${stderr}`);
    try {
      const response = await fetch(`${base}/login`, {redirect: 'manual'});
      if (response.status >= 200 && response.status < 500) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`portal startup timed out\nstdout=${stdout}\nstderr=${stderr}`);
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const selected = typeof address === 'object' && address ? address.port : 0;
  await new Promise(resolve => server.close(resolve));
  return selected;
}
