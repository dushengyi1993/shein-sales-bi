import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readManagedChromeIdentity, withChromeProfileStartup} from '../lib/chrome_profile_startup.mjs';
import {cleanupManagedStoreSession} from './cleanup_shein_store_browsers.mjs';
import {acquireBrowserTaskLease, releaseBrowserTaskLease} from '../lib/browser_task_lease.mjs';

const self = fileURLToPath(import.meta.url);
async function testManagedOwners(root) {
  const store = {storeKey: 'MOCK', profileKey: 'mock', port: 9333};
  const profileDir = path.join(root, 'profiles', 'persistent-mock-profile');
  const otherProfile = path.join(root, 'other profile');
  await fs.mkdir(profileDir, {recursive: true});
  await fs.mkdir(otherProfile);
  for (const format of ['windows', 'linux']) {
    const command = (type = '', directory = profileDir) => format === 'windows'
      ? `"C:\\Program Files\\Chrome\\chrome.exe" "--user-data-dir=${directory}" --remote-debugging-port=${store.port} ${type}`
      : ['/opt/chrome/chrome', `--user-data-dir=${directory}`, `--remote-debugging-port=${store.port}`, ...(type ? [type] : [])];
    const browser = {pid: 101, command: command(), startedAt: 'synthetic-start-1'};
    const children = ['renderer', 'utility', 'gpu-process'].map((type, index) => ({
      pid: 102 + index, startedAt: 'synthetic-child-start',
      command: command(format === 'windows' && index === 1 ? `"--type=${type}"`
        : format === 'windows' && index === 2 ? `--type="${type}"` : `--type=${type}`),
    }));
    const observed = [children[0], browser, ...children.slice(1)];
    const read = (rows, expected = null) => readManagedChromeIdentity({store, profileDir, observed: rows, expected});
    const session = await read(observed);
    assert.equal(session.browserPid, browser.pid, `${format}: inherited flags do not make children owners`);
    assert.deepEqual(await read(observed, session), session);
    assert.equal(observed.length, 4, 'identity selection preserves the full inventory');
    await assert.rejects(read(children), /ambiguous or unavailable/);
    await assert.rejects(read([...observed, {...browser, pid: 105}]), /ambiguous or unavailable/);
    await assert.rejects(read([...observed, {...browser, pid: 105, command: command('', otherProfile)}]), /ownership mismatch/);
    for (const pid of [0, -1, 1.5, '101', undefined]) {
      await assert.rejects(read([{...browser, pid}, ...children]), /Invalid managed session evidence/);
    }
    for (const startedAt of ['', null, 42, undefined]) {
      await assert.rejects(read([{...browser, startedAt}, ...children]), /Invalid managed session evidence/);
    }
    await assert.rejects(read([{...browser, pid: 106}, ...children], session), /changed since initial launcher/);
    await assert.rejects(read([{...browser, startedAt: 'synthetic-start-2'}, ...children], session), /changed since initial launcher/);

    // No real process inspection, signalling, probing or browser state is used.
    const singleton = path.join(profileDir, 'SingletonLock');
    await fs.writeFile(singleton, 'synthetic singleton');
    let live = true;
    const signals = [];
    const result = await cleanupManagedStoreSession(store, session, {
      root, env: {SHEIN_BI_RUNTIME_ROOT: path.join(root, 'runtime')},
      processes: async () => live ? observed : children,
      alive: async pid => { assert.equal(pid, browser.pid); return live; },
      signal: async (pid, name) => { signals.push([pid, name]); live = false; },
      sleep: async () => { throw new Error('unexpected mock cleanup sleep'); },
    });
    assert.deepEqual(signals, [[browser.pid, 'SIGTERM']], `${format}: cleanup signals only the browser owner`);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'managed_profile_still_in_use');
    assert.equal(await fs.readFile(singleton, 'utf8'), 'synthetic singleton', 'orphan children protect Singleton metadata');
    await assert.rejects(withChromeProfileStartup({
      root, profileDir, port: store.port, env: {SHEIN_BI_RUNTIME_ROOT: path.join(root, 'runtime')},
      processes: async () => children, probe: async () => false,
      prepare: async () => assert.fail('orphan children must prevent profile preparation'),
      launch: async () => assert.fail('orphan children must prevent another launch'),
      waitReady: async () => { throw new Error('synthetic orphan debug unavailable'); },
      reuse: async () => assert.fail('unavailable orphan session cannot be reused'),
    }), /synthetic orphan debug unavailable/);
  }
}

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
    await testManagedOwners(root);
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
    console.log('PASS: synthetic Windows/Linux browser owners, inherited child flags, ambiguous/invalid evidence rejection, orphan cleanup/startup guards; concurrent mock processes, one Profile metadata writer, safe reuse, port identity, active owner, independent store');
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
}
