import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {resolveManualLimitedDiscountRegistryPath} from '../lib/marketing_manual_limited_discount_overrides.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-v6-registry-'));
const registry = path.join(temp, 'runtime', 'registry.json');
const script = path.join(root, 'scripts/marketing/manage_manual_limited_discount_override.mjs');
async function run(args, preload = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...(preload ? ['--import', pathToFileURL(preload).href] : []), script, ...args, '--registry', registry], {cwd: root, env: {...process.env, SHEIN_BI_MANUAL_LIMITED_DISCOUNT_LOCK_FILE: '', V6_REGISTRY_TARGET: registry}});
    let output = '';
    child.stdout.on('data', b => { output += b; });
    child.stderr.on('data', b => { output += b; });
    child.on('error', reject);
    child.on('close', code => resolve({code, output}));
  });
}
function register(skc) {
  return ['register', '--store', 'FY', '--skc', skc, '--special-price', '37', '--valid-from', '2026-09-05 00:00:00', '--valid-to', '2026-09-10 23:59:59', '--activity-stock', '10', '--reason', 'test approved price', '--source-thread-id', 'test', '--source-artifact', 'outputs/test.json'];
}
try {
  assert.equal(resolveManualLimitedDiscountRegistryPath({env: {}, platform: 'linux'}).replaceAll('\\', '/').endsWith('/srv/shein-bi/runtime/marketing_manual_limited_discount_overrides.json'), true);
  const seed = path.join(temp, 'seed.json');
  const bytes = Buffer.from('{ "schemaVersion": 1, "entries": [] }\r\n');
  await fs.writeFile(seed, bytes);
  const migrate = await run(['migrate', '--seed', seed]);
  assert.equal(migrate.code, 0, migrate.output);
  assert.deepEqual(await fs.readFile(registry), bytes, 'migration preserves exact seed bytes');
  const registered = await Promise.all([run(register('test-skc-one')), run(register('test-skc-two'))]);
  for (const result of registered) assert.equal(result.code, 0, result.output);
  const before = await fs.readFile(registry);
  assert.equal(JSON.parse(before).entries.length, 2, 'concurrent writers retain both registrations');
  const repeatedMigration = await run(['migrate', '--seed', seed]);
  assert.equal(repeatedMigration.code, 0, repeatedMigration.output);
  assert.deepEqual(await fs.readFile(registry), before, 'existing runtime is not overwritten by seed');
  const preload = path.join(temp, 'deny-target-rename.mjs');
  await fs.writeFile(preload, "import fs from 'node:fs/promises'; const rename=fs.rename; fs.rename=async (from,to)=>{ if(String(to)===process.env.V6_REGISTRY_TARGET) throw Object.assign(new Error('simulated EACCES'),{code:'EACCES'}); return rename(from,to); };\n");
  const failed = await run(register('test-skc-three'), preload);
  assert.notEqual(failed.code, 0, 'rename failure propagates');
  assert.deepEqual(await fs.readFile(registry), before, 'failed atomic rename never falls back to in-place overwrite');
  assert.deepEqual(await fs.readFile(seed), bytes, 'source seed remains untouched');
  console.log('PASS: runtime defaults, exact migration, concurrent updates, existing registry protection, atomic failure');
} finally {
  await fs.rm(temp, {recursive: true, force: true});
}
