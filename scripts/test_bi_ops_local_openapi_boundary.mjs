#!/usr/bin/env node
/**
 * bi_ops_cli must not execute real SHEIN OpenAPI from the local machine.
 * This test does not call SHEIN; it verifies the CLI boundary blocks before any
 * local OpenAPI executor can be invoked.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bi-ops-local-openapi-boundary-'));
const checks = [];
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : actual === expected;
  checks.push({label, actual, expected: typeof expected === 'function' ? 'predicate' : expected, pass});
  return pass;
}
function runCli(args, env = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['scripts/bi_ops_cli.mjs', ...args], {
      cwd: ROOT,
      env: {...process.env, ...env, SHEIN_BI_ALLOW_LOCAL_OPENAPI_EXECUTOR: ''},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => resolve({code, stdout, stderr, text: `${stdout}\n${stderr}`}));
  });
}
async function writeJson(name, value) {
  const file = path.join(tmpRoot, name);
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

try {
  const config = await writeJson('openapi.json', {apiBaseUrls: {prodSemiManaged: 'http://127.0.0.1:9'}, stores: [{storeKey: 'SMK', openKeyId: 'dummy', secretKey: 'dummy'}]});
  const truth = await writeJson('truth.json', {stores: {SMK: {merchantId: 'dummy'}}});
  const image = path.join(tmpRoot, 'x.png');
  await fs.writeFile(image, Buffer.from('not-real-image'));

  const blockedSearch = await runCli(['search-product', '--openapi-config', config, '--store-truth', truth, '--store', 'SMK', '--product', 'SK-5110', '--mode', 'execute']);
  check('search-product local execute blocked', blockedSearch.code !== 0, true);
  check('search-product block mentions local boundary', blockedSearch.text, t => /cannot run local SHEIN OpenAPI through bi_ops_cli/.test(String(t)));

  const blockedUpload = await runCli(['upload-pic', '--openapi-config', config, '--store-truth', truth, '--store', 'SMK', '--image-type', '2', '--file', image, '--mode', 'execute']);
  check('upload-pic local execute blocked', blockedUpload.code !== 0, true);
  check('upload-pic block mentions cloud executor', blockedUpload.text, t => /shein-bi-tencent cloud BI executor|cannot run local SHEIN OpenAPI/.test(String(t)));

  const blockedDryRunWithConfig = await runCli(['audit-status', '--openapi-config', config, '--store', 'SMK', '--spu', 'SPU123']);
  check('dry-run with explicit config blocked without test override', blockedDryRunWithConfig.code !== 0, true);
  check('dry-run block tells fake-test override only', blockedDryRunWithConfig.text, t => /SHEIN_BI_ALLOW_LOCAL_OPENAPI_EXECUTOR=1 only for fake OpenAPI tests/.test(String(t)));

  const help = await runCli(['help']);
  check('help exits 0', help.code, 0);
  check('help says local direct OpenAPI forbidden', help.stdout, t => /本机不处于受控云端执行边界，不能直连真实 SHEIN OpenAPI/.test(String(t)));
  check('help does not say delegate to local image tool', help.stdout, t => !/委托本地 OpenAPI 图片工具/.test(String(t)));

  const failed = checks.filter(c => !c.pass);
  console.log(JSON.stringify({ok: failed.length === 0, checks}, null, 2));
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await fs.rm(tmpRoot, {recursive: true, force: true}).catch(() => {});
}
