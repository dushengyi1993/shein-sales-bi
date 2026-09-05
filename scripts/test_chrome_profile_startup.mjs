import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {withChromeProfileStartup} from '../lib/chrome_profile_startup.mjs';
import {acquireBrowserTaskLease, releaseBrowserTaskLease} from '../lib/browser_task_lease.mjs';

const self = fileURLToPath(import.meta.url);
async function simulate(config, overrides = {}) {
  const statePath = path.join(config.root, `${config.storeKey}.browser.json`);
  const state = async () => JSON.parse(await fs.readFile(statePath, 'utf8').catch(e => { if (e.code === 'ENOENT') return 'null'; throw e; }));
  return withChromeProfileStartup({...config,
    env: {SHEIN_BI_RUNTIME_ROOT: path.join(config.root, 'runtime'), ...(config.env || {})},
    processes: async () => (await state()) ? [{command: [`--user-data-dir=${config.profileDir}`, `--remote-debugging-port=${config.port}`]}] : [],
    probe: async () => Boolean(await state()),
    prepare: async () => {
      await fs.appendFile(path.join(config.root, 'metadata-writes.log'), `${config.storeKey}\n`);
      await fs.writeFile(path.join(config.profileDir, 'Local State'), '{"optimization_guide":{"on_device_foundational_model_user_settings":false}}');
      await new Promise(resolve => setTimeout(resolve, 60));
    },
    launch: async () => { await fs.writeFile(statePath, JSON.stringify({port: config.port})); },
    waitReady: async () => { assert.ok(await state()); },
    reuse: async () => { await fs.appendFile(path.join(config.root, 'reuse.log'), `${config.storeKey}\n`); },
    ...overrides,
  });
}
if (process.argv[2] === '--child') {
  console.log(JSON.stringify(await simulate(JSON.parse(process.argv[3]))));
} else {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-v6-profile-'));
  const cfg = {root, profileDir: path.join(root, 'profiles', 'DL'), storeKey: 'DL', port: 9321};
  const child = config => new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, [self, '--child', JSON.stringify(config)], {stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    process.stdout.on('data', b => { stdout += b; }); process.stderr.on('data', b => { stderr += b; });
    process.on('error', reject); process.on('close', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
  try {
    const results = await Promise.all([child(cfg), child(cfg)]);
    assert.equal(results.filter(r => r.launched).length, 1);
    assert.equal(results.filter(r => r.reused).length, 1);
    assert.equal(await fs.readFile(path.join(root, 'metadata-writes.log'), 'utf8'), 'DL\n', 'two processes write Local State only once');
    const before = await fs.readFile(path.join(cfg.profileDir, 'Local State'));
    const quoted = await simulate(cfg, {processes: async () => [{command: `chrome.exe "--user-data-dir=${cfg.profileDir}" --remote-debugging-port=${cfg.port}`} ]});
    assert.equal(quoted.reused, true, 'Windows quoted profile arguments preserve identity');
    await assert.rejects(simulate(cfg, {processes: async () => [{command: [`--user-data-dir=${cfg.profileDir}`, '--remote-debugging-port=9999']}]}), /ownership mismatch/);
    await assert.rejects(simulate(cfg, {probe: async () => false, waitReady: async () => { throw new Error('existing browser debug unavailable'); }}), /existing browser debug unavailable/);
    assert.deepEqual(await fs.readFile(path.join(cfg.profileDir, 'Local State')), before);
    const lease = {root, storeKey: 'DL', task: 'owner', runId: 'first', ttlSec: 60};
    acquireBrowserTaskLease(lease);
    await assert.rejects(simulate(cfg), {code: 'PROFILE_LEASE_ACTIVE'});
    const owned = await simulate({...cfg, env: {SHEIN_BI_BROWSER_LEASE_TASK: 'owner', SHEIN_BI_BROWSER_LEASE_RUN_ID: 'first'}});
    assert.equal(owned.reused, true);
    await child({...cfg, storeKey: 'FY', profileDir: path.join(root, 'profiles', 'FY'), port: 9330});
    assert.equal(releaseBrowserTaskLease(lease).released, true);
    assert.deepEqual(await fs.readFile(path.join(cfg.profileDir, 'Local State')), before, 'other store and refused callers leave DL metadata unchanged');
    console.log('PASS: real concurrent processes, one Profile metadata writer, safe reuse, port identity, active owner, independent store');
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
}
