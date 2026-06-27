#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => {
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        // keep null
      }
      resolve({code, stdout, stderr, json});
    });
  });
}

async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bi-ops-maintenance-readiness-'));
const docFile = path.join(dir, 'doc.json');
const storeFile = path.join(dir, 'stores.json');
const readbackFile = path.join(dir, 'readback.json');
const secretFile = path.join(dir, 'secret.json');

const noEvidence = await run(process.execPath, [
  'scripts/check_bi_ops_maintenance_readiness.mjs',
  '--operation', 'retire_link',
  '--expect', 'blocked',
]);
assert.equal(noEvidence.code, 0, noEvidence.stderr || noEvidence.stdout);
assert.equal(noEvidence.json.readinessState, 'blocked');
assert.equal(noEvidence.json.implementationReady, false);

await writeJson(docFile, {
  ok: true,
  cookieProvided: true,
  cookieHash: 'abc123def456',
  safety: {readOnly: true, sheinBusinessWriteCalled: false, cookieSaved: false, cookiePrinted: false},
  results: [{
    docId: '3001629',
    verified: true,
    status: 'verified',
    expectedEndpoint: '/open-api/goods/modify-skc-shelf',
    endpoint: '/open-api/goods/modify-skc-shelf',
    schemaHash: 'schema-hash',
    requestFieldCount: 2,
    responseFieldCount: 1,
    keywordChecks: [{keyword: 'shelf_state', present: true}],
    requestFields: [{title: 'shelf_state', type: 'number', required: true}],
  }],
});
const schemaReady = await run(process.execPath, [
  'scripts/check_bi_ops_maintenance_readiness.mjs',
  '--operation', 'retire_link',
  '--doc-evidence', docFile,
  '--expect', 'schema_ready',
]);
assert.equal(schemaReady.code, 0, schemaReady.stderr || schemaReady.stdout);
assert.equal(schemaReady.json.readinessState, 'schema_ready');
assert.equal(schemaReady.json.implementationReady, true);
assert.equal(schemaReady.json.realSubmitPilotReady, false);
assert.ok(schemaReady.json.blockers.some(x => String(x).includes('逐店权限')));
assert.ok(schemaReady.json.blockers.some(x => String(x).includes('回读')));

const cliSchemaReady = await run(process.execPath, [
  'scripts/bi_ops_cli.mjs',
  'maintenance-readiness',
  '--operation', 'retire_link',
  '--doc-evidence', docFile,
  '--expect', 'schema_ready',
]);
assert.equal(cliSchemaReady.code, 0, cliSchemaReady.stderr || cliSchemaReady.stdout);
assert.equal(cliSchemaReady.json.readinessState, 'schema_ready');
assert.equal(cliSchemaReady.json.operation, 'retire_link');

await writeJson(storeFile, {
  operation: 'retire_link',
  endpoint: '/open-api/goods/modify-skc-shelf',
  stores: [
    {storeKey: 'DX', permissionVerified: true, authorized: true, actualWriteSubmitted: false, sheinWriteAttempted: false},
  ],
});
await writeJson(readbackFile, {
  operation: 'retire_link',
  endpoint: '/open-api/goods/modify-skc-shelf',
  readbackEndpoint: '/open-api/openapi-business-backend/product/query',
  postWriteReadbackVerified: true,
  strongReadback: true,
  strongFields: ['supplierCode', 'supplierSku', 'shelf_state'],
});
const pilotReady = await run(process.execPath, [
  'scripts/check_bi_ops_maintenance_readiness.mjs',
  '--operation', 'retire_link',
  '--doc-evidence', docFile,
  '--store-probe', storeFile,
  '--readback-evidence', readbackFile,
  '--expect', 'pilot_ready',
]);
assert.equal(pilotReady.code, 0, pilotReady.stderr || pilotReady.stdout);
assert.equal(pilotReady.json.readinessState, 'pilot_ready');
assert.equal(pilotReady.json.realSubmitPilotReady, true);
assert.equal(pilotReady.json.safety.sheinBusinessWriteCalled, false);

await writeJson(secretFile, {
  operation: 'retire_link',
  endpoint: '/open-api/goods/modify-skc-shelf',
  stores: [
    {storeKey: 'DX', permissionVerified: true, secretKey: 'SHOULD_NOT_BE_HERE'},
  ],
});
const secretRejected = await run(process.execPath, [
  'scripts/check_bi_ops_maintenance_readiness.mjs',
  '--operation', 'retire_link',
  '--doc-evidence', docFile,
  '--store-probe', secretFile,
  '--readback-evidence', readbackFile,
  '--expect', 'pilot_ready',
]);
assert.equal(secretRejected.code, 2, 'secret-bearing evidence must not satisfy pilot_ready');
assert.ok(secretRejected.stdout.includes('敏感字段'));

console.log(JSON.stringify({
  ok: true,
  checked: [
    'missing evidence stays blocked',
    'doc schema evidence reaches schema_ready only',
    'bi_ops_cli maintenance-readiness forwards to the checker',
    'store permission plus readback evidence reaches pilot_ready',
    'secret-bearing evidence is rejected',
  ],
}, null, 2));
