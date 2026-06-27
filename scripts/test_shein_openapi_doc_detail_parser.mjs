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
    child.on('close', code => resolve({code, stdout, stderr}));
  });
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-openapi-doc-detail-'));
const fixturePath = path.join(dir, 'fixture.json');
const outPath = path.join(dir, 'evidence.json');

await fs.writeFile(fixturePath, JSON.stringify({
  httpStatus: 200,
  body: {
    code: '0',
    msg: 'OK',
    info: {
      apiPublishDocVo: {
        userDocName: '商品上下架',
        openPath: '/open-api/goods/modify-skc-shelf',
        method: 'POST',
      },
      apiPublishDocDetailVo: {
        requestHeader: JSON.stringify([{title: 'x-lt-openKeyId', type: 'string', required: true}]),
        requestBody: JSON.stringify([
          {title: 'skc', type: 'string', required: true, description: '商品 SKC'},
          {title: 'shelf_state', type: 'number', required: true, description: '1 上架，2 下架'},
        ]),
        responseBody: JSON.stringify([{title: 'success', type: 'boolean'}]),
        description: '<p>商品上下架接口。</p>',
      },
    },
  },
}, null, 2), 'utf8');

const ok = await run(process.execPath, [
  'scripts/verify_shein_openapi_doc_detail.mjs',
  '--doc-id', '3001253',
  '--endpoint', '/open-api/goods/modify-skc-shelf',
  '--fixture', fixturePath,
  '--out', outPath,
  '--require-verified',
  '--pretty',
]);
assert.equal(ok.code, 0, ok.stderr || ok.stdout);
assert.match(ok.stdout, /modify-skc-shelf/);
const evidence = JSON.parse(await fs.readFile(outPath, 'utf8'));
assert.equal(evidence.ok, true);
assert.equal(evidence.safety.readOnly, true);
assert.equal(evidence.safety.sheinBusinessWriteCalled, false);
assert.equal(evidence.safety.cookieSaved, false);
assert.equal(evidence.results[0].verified, true);
assert.equal(evidence.results[0].endpointMatches, true);
assert.equal(evidence.results[0].keywordChecks[0].keyword, 'shelf_state');
assert.equal(evidence.results[0].keywordChecks[0].present, true);
assert.ok(evidence.results[0].requestFields.some(x => x.title === 'shelf_state' || x.name === 'shelf_state'));

const unauthFixturePath = path.join(dir, 'unauth.json');
const unauthOutPath = path.join(dir, 'unauth-evidence.json');
await fs.writeFile(unauthFixturePath, JSON.stringify({
  httpStatus: 401,
  body: {code: '401', msg: 'Unauthorized'},
}, null, 2), 'utf8');
const unauth = await run(process.execPath, [
  'scripts/verify_shein_openapi_doc_detail.mjs',
  '--doc-id', '3001253',
  '--endpoint', '/open-api/goods/modify-skc-shelf',
  '--fixture', unauthFixturePath,
  '--out', unauthOutPath,
  '--require-verified',
]);
assert.equal(unauth.code, 2, 'auth-required fixture must not pass --require-verified');
const unauthEvidence = JSON.parse(await fs.readFile(unauthOutPath, 'utf8'));
assert.equal(unauthEvidence.ok, false);
assert.equal(unauthEvidence.results[0].status, 'auth_required');
assert.equal(unauthEvidence.results[0].authRequired, true);

console.log(JSON.stringify({
  ok: true,
  checked: [
    'modify-skc-shelf fixture verifies endpoint and shelf_state',
    'auth-required response is not accepted as schema evidence',
    'evidence artifact is sanitized and read-only',
  ],
}, null, 2));

