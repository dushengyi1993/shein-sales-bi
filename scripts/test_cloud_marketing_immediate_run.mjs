import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {
  businessDateAtEpoch,
  consumeImmediateAuthorization,
  DEFAULT_IMMEDIATE_AUTHORIZATION_FILE,
  deriveConsumedAuthorizationFile,
  findImmediateAuthorizationContinuation,
  issueImmediateAuthorization,
  IMMEDIATE_CONFIRMATION_TOKEN,
  runImmediateAuthorizationCli,
  inspectImmediateAuthorization,
  verifyImmediateAuthorizationContinuation,
  verifyIssuedImmediateAuthorization,
  verifyConsumedImmediateAuthorization,
} from '../lib/cloud_marketing_immediate_authorization.mjs';
import {writeJsonFileAtomic} from '../lib/atomic_file_publish.mjs';
import {runActivityInventoryTransaction} from '../lib/marketing_activity_inventory_transaction.mjs';
import {
  assertCanStartUnit,
  createDeadlineContract,
  deadlineBoundAdapterFactory,
} from '../lib/cloud_marketing_deadline_contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POSIX_SECURE_TMP_MARKER = 'SHEIN_TEST_CLOUD_MARKETING_IMMEDIATE_SECURE_TMP';
if (process.platform !== 'win32'
  && typeof process.getuid === 'function'
  && process.getuid() !== 0
  && process.env[POSIX_SECURE_TMP_MARKER] !== '1') {
  const isolated = spawnSync('sudo', [
    '-n', 'env', `${POSIX_SECURE_TMP_MARKER}=1`, process.execPath, fileURLToPath(import.meta.url),
  ], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (isolated.stdout) process.stdout.write(isolated.stdout);
  if (isolated.stderr) process.stderr.write(isolated.stderr);
  if (isolated.error) throw isolated.error;
  process.exit(isolated.status ?? 1);
}
const tempBase = process.platform === 'win32' ? path.join(root, 'tmp') : '/run';
const tempRoot = await fsp.mkdtemp(path.join(tempBase, 'cloud-marketing-immediate-contract-'));
const nativeWslHarnessRoots = [];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function exists(file) {
  return fsp.lstat(file).then(() => true).catch(error => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
}

function shellPath(file) {
  const raw = String(file);
  if (process.platform === 'win32' && raw.startsWith('/')) return raw;
  const resolved = path.resolve(raw).replaceAll('\\', '/');
  if (process.platform === 'win32' && /^[A-Za-z]:\//.test(resolved)) {
    return `/mnt/${resolved[0].toLowerCase()}${resolved.slice(2)}`;
  }
  return resolved;
}

function bashQuote(value) {
  return `'${String(value ?? '').replaceAll("'", "'\\''")}'`;
}

function wslEnvironmentArgs(environment, extraKeys = []) {
  const allowedExtraKeys = new Set(extraKeys);
  return Object.entries(environment)
    .filter(([key, value]) => (key.startsWith('SHEIN_BI_') || allowedExtraKeys.has(key)) && value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`);
}

function wslExec(args, {environment = {}, extraKeys = [], timeout = 120000} = {}) {
  return spawnSync('wsl.exe', [
    '--exec', 'env', ...wslEnvironmentArgs(environment, extraKeys), ...args,
  ], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    timeout,
  });
}

function bashExec(command, {environment = {}, timeout = 120000} = {}) {
  if (process.platform === 'win32') {
    return wslExec(['bash', '-lc', command], {environment, timeout});
  }
  const nativeEnvironment = {...process.env};
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete nativeEnvironment[key];
    else nativeEnvironment[key] = String(value);
  }
  return spawnSync('bash', ['-c', command], {
    cwd: root,
    env: nativeEnvironment,
    encoding: 'utf8',
    timeout,
  });
}

function wslMkdir(directory) {
  const result = wslExec(['mkdir', '-p', directory]);
  assert.equal(result.error, undefined, `wsl mkdir spawn failed: ${result.error?.message || ''}`);
  assert.equal(result.status, 0, `wsl mkdir failed for ${directory}: ${result.stderr || result.stdout}`);
}

function wslSudo(args, label) {
  const result = wslExec(['sudo', '-n', ...args]);
  assert.equal(result.error, undefined, `${label} spawn failed: ${result.error?.message || ''}`);
  assert.equal(result.status, 0, `${label} failed: ${result.stderr || result.stdout}`);
}

function wslIdentity() {
  const uid = wslExec(['id', '-u']);
  const gid = wslExec(['id', '-g']);
  assert.equal(uid.status, 0, `native WSL uid probe failed: ${uid.stderr || uid.stdout}`);
  assert.equal(gid.status, 0, `native WSL gid probe failed: ${gid.stderr || gid.stdout}`);
  return {uid: uid.stdout.trim(), gid: gid.stdout.trim()};
}

function prepareNativeAuthorizationRoot(rootDirectory, {writableDirectories = [], authorizationDirectories = []} = {}) {
  const {uid, gid} = wslIdentity();
  const rootOwnedDirectories = [
    rootDirectory,
    ...authorizationDirectories.map(directory => path.posix.dirname(directory)),
  ];
  wslSudo(['mkdir', '-p', ...new Set([...rootOwnedDirectories, ...writableDirectories, ...authorizationDirectories])],
    `native authorization root mkdir ${rootDirectory}`);
  wslSudo(['chown', '0:0', ...new Set(rootOwnedDirectories)],
    `native authorization root owner ${rootDirectory}`);
  wslSudo(['chmod', '755', ...new Set(rootOwnedDirectories)],
    `native authorization root mode ${rootDirectory}`);
  for (const directory of writableDirectories) {
    wslSudo(['chown', '-R', `${uid}:${gid}`, directory], `native writable directory owner ${directory}`);
  }
  for (const directory of authorizationDirectories) {
    wslSudo(['chown', `${uid}:${gid}`, directory], `native authorization leaf owner ${directory}`);
    wslSudo(['chmod', '700', directory], `native authorization leaf mode ${directory}`);
  }
}

function wslCopy(source, destination) {
  const result = wslExec(['cp', '-f', shellPath(source), shellPath(destination)]);
  assert.equal(result.error, undefined, `wsl cp spawn failed: ${result.error?.message || ''}`);
  assert.equal(result.status, 0, `wsl cp failed: ${source} -> ${destination}: ${result.stderr || result.stdout}`);
}

function wslExists(file) {
  const result = wslExec(['test', '-e', file]);
  assert.equal(result.error, undefined, `wsl test spawn failed: ${result.error?.message || ''}`);
  return result.status === 0;
}

function wslFileNames(directory) {
  const result = wslExec(['bash', '-lc', `find -- ${bashQuote(directory)} -maxdepth 1 -type f -printf '%f\\n'`]);
  assert.equal(result.error, undefined, `wsl find spawn failed: ${result.error?.message || ''}`);
  assert.equal(result.status, 0, `wsl find failed for ${directory}: ${result.stderr || result.stdout}`);
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function wslChmod(mode, file) {
  if (process.platform !== 'win32') return;
  const result = wslExec(['chmod', mode, shellPath(file)]);
  assert.equal(result.error, undefined, `wsl chmod spawn failed: ${result.error?.message || ''}`);
  assert.equal(result.status, 0, `wsl chmod failed for ${file}: ${result.stderr || result.stdout}`);
}

async function expectReject(action, codeOrPattern) {
  await assert.rejects(action, error => {
    if (codeOrPattern instanceof RegExp) return codeOrPattern.test(String(error?.message || error));
    return error?.code === codeOrPattern;
  });
}

function runNativeWslAuthorizationIssue({moduleFile, authorizationFile, queueFile, rootDir, sourceGuardFile, date, nowEpoch}) {
  const script = [
    "const {pathToFileURL}=await import('node:url');",
    "const {issueImmediateAuthorization,IMMEDIATE_CONFIRMATION_TOKEN}=await import(pathToFileURL(process.env.MODE_MODULE).href);",
    'try {',
    '  const value = await issueImmediateAuthorization({',
    '    authorizationFile: process.env.MODE_AUTH,',
    '    queueFile: process.env.MODE_QUEUE,',
    '    root: process.env.MODE_ROOT,',
    '    sourceGuardFile: process.env.MODE_GUARD,',
    '    date: process.env.MODE_DATE,',
    '    maxGroups: 1,',
    '    ttlSec: 3600,',
    '    reason: "native POSIX authorization directory contract",',
    '    confirmationToken: IMMEDIATE_CONFIRMATION_TOKEN,',
    '    nowEpoch: Number(process.env.MODE_NOW),',
    '    timeZone: "Asia/Shanghai",',
    '  });',
    '  process.stdout.write(JSON.stringify(value));',
    '} catch (error) {',
    '  process.stderr.write(`${error.code || "ERROR"}: ${error.message}`);',
    '  process.exitCode = 1;',
    '}',
  ].join('\n');
  return wslExec(['node', '--input-type=module', '-e', script], {
    environment: {
      MODE_MODULE: shellPath(moduleFile),
      MODE_AUTH: authorizationFile,
      MODE_QUEUE: queueFile,
      MODE_ROOT: rootDir,
      MODE_GUARD: sourceGuardFile,
      MODE_DATE: date,
      MODE_NOW: String(nowEpoch),
    },
    extraKeys: ['MODE_MODULE', 'MODE_AUTH', 'MODE_QUEUE', 'MODE_ROOT', 'MODE_GUARD', 'MODE_DATE', 'MODE_NOW'],
  });
}

function runNativeWslAuthorizationVerify({moduleFile, authorizationFile, queueFile, rootDir, date, nowEpoch}) {
  const script = [
    "const {pathToFileURL}=await import('node:url');",
    "const {verifyIssuedImmediateAuthorization}=await import(pathToFileURL(process.env.MODE_MODULE).href);",
    'try {',
    '  const value = await verifyIssuedImmediateAuthorization({',
    '    authorizationFile: process.env.MODE_AUTH,',
    '    queueFile: process.env.MODE_QUEUE,',
    '    root: process.env.MODE_ROOT,',
    '    date: process.env.MODE_DATE,',
    '    nowEpoch: Number(process.env.MODE_NOW),',
    '    timeZone: "Asia/Shanghai",',
    '  });',
    '  process.stdout.write(JSON.stringify(value));',
    '} catch (error) {',
    '  process.stderr.write(`${error.code || "ERROR"}: ${error.message}`);',
    '  process.exitCode = 1;',
    '}',
  ].join('\n');
  return wslExec(['node', '--input-type=module', '-e', script], {
    environment: {
      MODE_MODULE: shellPath(moduleFile),
      MODE_AUTH: authorizationFile,
      MODE_QUEUE: queueFile,
      MODE_ROOT: rootDir,
      MODE_DATE: date,
      MODE_NOW: String(nowEpoch),
    },
    extraKeys: ['MODE_MODULE', 'MODE_AUTH', 'MODE_QUEUE', 'MODE_ROOT', 'MODE_DATE', 'MODE_NOW'],
  });
}

try {
  const date = businessDateAtEpoch(Math.floor(Date.now() / 1000), 'Asia/Shanghai');
  // Use a deterministic noon-in-business-date clock so the test remains
  // stable even when the host is close to midnight.
  const issueEpoch = Math.floor(Date.parse(`${date}T04:00:00.000Z`) / 1000);
  const guardFile = path.join(tempRoot, 'outputs', 'reports', `marketing-daily-guard-${date}.json`);
  const hostSourceGuardFile = path.join(tempRoot, 'host-physical', 'data', 'shein-bi', 'outputs', 'reports', `marketing-daily-guard-${date}.json`);
  const differentHostSourceGuardFile = path.join(tempRoot, 'host-physical', 'data', 'shein-bi', 'outputs', 'reports', `marketing-daily-guard-${date}.different.json`);
  const queueFile = path.join(tempRoot, 'state', 'cloud_marketing_live_guard', 'repair-queues', `marketing-repair-${date}.json`);
  const authorizationFile = path.join(tempRoot, 'runtime', 'marketing-repair-immediate', 'authorization.json');
  const authorizationDir = path.dirname(authorizationFile);
  const sourceGuard = path.relative(tempRoot, guardFile).replaceAll(path.sep, '/');
  const guardBytes = Buffer.from(`${JSON.stringify({reportDate: date, contract: true})}\n`, 'utf8');
  await fsp.mkdir(path.dirname(hostSourceGuardFile), {recursive: true});
  await fsp.writeFile(hostSourceGuardFile, guardBytes);
  await fsp.writeFile(differentHostSourceGuardFile, Buffer.from(`${JSON.stringify({reportDate: date, contract: false})}\n`, 'utf8'));
  const sourceGuardHash = sha256(guardBytes);
  const queue = {
    schemaVersion: 1,
    date,
    sourceGuard,
    sourceGuardHash,
    queueFingerprint: sha256('queue-fingerprint-v1'),
    status: 'pending',
    stages: {
      highClickSpecial: {status: 'not_required'},
      manualSpecialRestore: {status: 'not_required'},
      driftRepair: {status: 'not_required'},
      fallbackRepair: {status: 'pending'},
    },
  };
  await fsp.mkdir(path.dirname(queueFile), {recursive: true});
  await fsp.writeFile(queueFile, `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
  const originalQueueBytes = await fsp.readFile(queueFile);

  const missingAuthorizationFile = path.join(tempRoot, 'runtime-missing', 'marketing-repair-immediate', 'authorization.json');
  await expectReject(
    issueImmediateAuthorization({
      authorizationFile: missingAuthorizationFile,
      queueFile,
      root: tempRoot,
      sourceGuardFile: hostSourceGuardFile,
      date,
      maxGroups: 1,
      ttlSec: 3600,
      reason: 'missing authorization directory must fail closed',
      confirmationToken: IMMEDIATE_CONFIRMATION_TOKEN,
      nowEpoch: issueEpoch,
      timeZone: 'Asia/Shanghai',
    }),
    'IMMEDIATE_AUTHORIZATION_DIRECTORY_MISSING',
  );
  assert.equal(await exists(path.dirname(missingAuthorizationFile)), false,
    'issue must not auto-create the authorization directory');
  await fsp.mkdir(authorizationDir, {recursive: true});
  if (process.platform !== 'win32') await fsp.chmod(authorizationDir, 0o700);

  const symlinkRealAncestor = path.join(tempRoot, 'runtime-symlink-real');
  const symlinkAuthorizationDir = path.join(symlinkRealAncestor, 'marketing-repair-immediate');
  const symlinkAncestor = path.join(tempRoot, 'runtime-symlink-ancestor');
  await fsp.mkdir(symlinkAuthorizationDir, {recursive: true});
  if (process.platform !== 'win32') await fsp.chmod(symlinkAuthorizationDir, 0o700);
  await fsp.symlink(symlinkRealAncestor, symlinkAncestor, process.platform === 'win32' ? 'junction' : 'dir');
  await expectReject(
    issueImmediateAuthorization({
      authorizationFile: path.join(symlinkAncestor, 'marketing-repair-immediate', 'authorization.json'),
      queueFile,
      root: tempRoot,
      sourceGuardFile: hostSourceGuardFile,
      date,
      maxGroups: 1,
      ttlSec: 3600,
      reason: 'authorization ancestor symlink must fail closed',
      confirmationToken: IMMEDIATE_CONFIRMATION_TOKEN,
      nowEpoch: issueEpoch,
      timeZone: 'Asia/Shanghai',
    }),
    'IMMEDIATE_AUTHORIZATION_DIRECTORY_ANCESTOR_SYMLINK',
  );

  const baseIssueArgs = [
    'issue',
    '--date', date,
    '--queue', queueFile,
    '--source-guard-file', hostSourceGuardFile,
    '--max-groups', '7',
    '--ttl-sec', '3600',
    '--reason', IMMEDIATE_CONFIRMATION_TOKEN,
    '--authorization-file', path.join(authorizationDir, 'cli-confirmation.json'),
    '--root', tempRoot,
    '--now-epoch', String(issueEpoch),
    '--time-zone', 'Asia/Shanghai',
  ];
  await expectReject(
    runImmediateAuthorizationCli(baseIssueArgs),
    'IMMEDIATE_AUTHORIZATION_CONFIRMATION_REQUIRED',
  );
  assert.equal(await exists(path.join(authorizationDir, 'cli-confirmation.json')), false,
    'missing confirmation token must fail before creating an authorization file');
  await expectReject(
    runImmediateAuthorizationCli([...baseIssueArgs, '--confirm-token', 'WRONG_CONFIRMATION']),
    'IMMEDIATE_AUTHORIZATION_CONFIRMATION_REQUIRED',
  );
  assert.equal(await exists(path.join(authorizationDir, 'cli-confirmation.json')), false,
    'wrong confirmation token must fail before creating an authorization file');

  if (process.platform !== 'win32') {
    const modeDir = path.join(tempRoot, 'runtime-mode', 'marketing-repair-immediate');
    const modeAuth = path.join(modeDir, 'mode.json');
    await fsp.mkdir(modeDir, {recursive: true});
    await fsp.chmod(modeDir, 0o750);
    await expectReject(
      issueImmediateAuthorization({
        authorizationFile: modeAuth,
        queueFile,
        root: tempRoot,
        sourceGuardFile: hostSourceGuardFile,
        date,
        maxGroups: 1,
        ttlSec: 3600,
        reason: 'directory mode contract test',
        confirmationToken: IMMEDIATE_CONFIRMATION_TOKEN,
        nowEpoch: issueEpoch,
        timeZone: 'Asia/Shanghai',
      }),
      'IMMEDIATE_AUTHORIZATION_DIRECTORY_MODE_INVALID',
    );
    await fsp.chmod(modeDir, 0o500);
    await expectReject(
      issueImmediateAuthorization({
        authorizationFile: path.join(modeDir, 'owner-no-write.json'),
        queueFile,
        root: tempRoot,
        sourceGuardFile: hostSourceGuardFile,
        date,
        maxGroups: 1,
        ttlSec: 3600,
        reason: 'directory owner permissions must include rwx',
        confirmationToken: IMMEDIATE_CONFIRMATION_TOKEN,
        nowEpoch: issueEpoch,
        timeZone: 'Asia/Shanghai',
      }),
      'IMMEDIATE_AUTHORIZATION_DIRECTORY_MODE_INVALID',
    );
    await fsp.chmod(modeDir, 0o700);
    const modeIssued = await issueImmediateAuthorization({
      authorizationFile: modeAuth,
      queueFile,
      root: tempRoot,
      sourceGuardFile: hostSourceGuardFile,
      date,
      maxGroups: 1,
      ttlSec: 3600,
      reason: 'directory mode accepted contract test',
      confirmationToken: IMMEDIATE_CONFIRMATION_TOKEN,
      nowEpoch: issueEpoch,
      timeZone: 'Asia/Shanghai',
    });
    assert.equal(modeIssued.status, 'issued');
    assert.equal((await fsp.stat(modeAuth)).mode & 0o777, 0o600,
      'issued authorization source must be mode 0600');
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      await fsp.chown(modeDir, 1, 1);
      await expectReject(
        issueImmediateAuthorization({
          authorizationFile: path.join(modeDir, 'owner-mismatch.json'),
          queueFile,
          root: tempRoot,
          sourceGuardFile: hostSourceGuardFile,
          date,
          maxGroups: 1,
          ttlSec: 3600,
          reason: 'directory owner contract test',
          confirmationToken: IMMEDIATE_CONFIRMATION_TOKEN,
          nowEpoch: issueEpoch,
          timeZone: 'Asia/Shanghai',
        }),
        'IMMEDIATE_AUTHORIZATION_DIRECTORY_OWNER_MISMATCH',
      );
      await fsp.chown(modeDir, process.getuid(), process.getgid());
    }
  } else {
    // The focused command is normally launched by Windows Node in this
    // workspace. Exercise the same POSIX owner/mode checks under a fixed,
    // root-owned non-writable ancestor chain in native WSL.
    const modeNativeRoot = `/var/lib/cloud-marketing-auth-mode-${process.pid}-${Date.now()}`;
    nativeWslHarnessRoots.push(modeNativeRoot);
    const modeNativeDir = `${modeNativeRoot}/runtime/marketing-repair-immediate`;
    const modeNativeData = `${modeNativeRoot}/data`;
    const modeNativeQueue = `${modeNativeData}/queue.json`;
    const modeNativeGuard = `${modeNativeData}/guard.json`;
    const modeNativeModule = path.join(root, 'lib', 'cloud_marketing_immediate_authorization.mjs');
    const modeQueueFile = path.join(tempRoot, 'native-mode-queue.json');
    const modeGuardFile = path.join(tempRoot, 'native-mode-guard.json');
    await fsp.writeFile(modeGuardFile, guardBytes);
    await fsp.writeFile(modeQueueFile, `${JSON.stringify({
      ...queue,
      sourceGuard: 'guard.json',
      sourceGuardHash,
    }, null, 2)}\n`);
    prepareNativeAuthorizationRoot(modeNativeRoot, {
      writableDirectories: [modeNativeData],
      authorizationDirectories: [modeNativeDir],
    });
    wslCopy(modeGuardFile, modeNativeGuard);
    wslCopy(modeQueueFile, modeNativeQueue);

    const modeIssue = authorizationFile => runNativeWslAuthorizationIssue({
      moduleFile: modeNativeModule,
      authorizationFile,
      queueFile: modeNativeQueue,
      rootDir: modeNativeRoot,
      sourceGuardFile: modeNativeGuard,
      date,
      nowEpoch: issueEpoch,
    });
    const assertNativeModeFailure = (result, label, pattern) => {
      assert.equal(result.error, undefined, `${label} spawn failed: ${result.error?.message || ''}`);
      assert.notEqual(result.status, 0, `${label} must fail closed`);
      assert.match(`${result.stdout || ''}${result.stderr || ''}`, pattern, `${label} error code mismatch`);
    };

    wslSudo(['chmod', '757', `${modeNativeRoot}/runtime`], 'native mutable ancestor setup');
    assertNativeModeFailure(
      modeIssue(`${modeNativeDir}/mutable-ancestor.json`),
      'native POSIX mutable authorization ancestor',
      /IMMEDIATE_AUTHORIZATION_DIRECTORY_ANCESTOR_MODE_INVALID/,
    );
    wslSudo(['chmod', '755', `${modeNativeRoot}/runtime`], 'native fixed ancestor restore');

    wslChmod('750', modeNativeDir);
    assertNativeModeFailure(
      modeIssue(`${modeNativeDir}/mode-750.json`),
      'native POSIX mode 0750',
      /IMMEDIATE_AUTHORIZATION_DIRECTORY_MODE_INVALID/,
    );
    wslChmod('500', modeNativeDir);
    assertNativeModeFailure(
      modeIssue(`${modeNativeDir}/mode-500.json`),
      'native POSIX mode 0500',
      /IMMEDIATE_AUTHORIZATION_DIRECTORY_MODE_INVALID/,
    );
    wslChmod('700', modeNativeDir);
    const nativeModeIssued = modeIssue(`${modeNativeDir}/mode-700.json`);
    assert.equal(nativeModeIssued.error, undefined, `native POSIX mode 0700 spawn failed: ${nativeModeIssued.error?.message || ''}`);
    assert.equal(nativeModeIssued.status, 0, `native POSIX mode 0700 must issue: ${nativeModeIssued.stderr || nativeModeIssued.stdout}`);
    const nativeModeFileMode = wslExec(['stat', '-c', '%a', `${modeNativeDir}/mode-700.json`]);
    assert.equal(nativeModeFileMode.error, undefined, `native authorization mode read failed: ${nativeModeFileMode.error?.message || ''}`);
    assert.equal(nativeModeFileMode.status, 0, `native authorization mode read failed: ${nativeModeFileMode.stderr || ''}`);
    assert.equal(nativeModeFileMode.stdout.trim(), '600', 'native issued authorization file must be mode 0600');

    const nativeUidResult = wslExec(['id', '-u']);
    const nativeGidResult = wslExec(['id', '-g']);
    assert.equal(nativeUidResult.error, undefined, `native uid probe failed: ${nativeUidResult.error?.message || ''}`);
    assert.equal(nativeGidResult.error, undefined, `native gid probe failed: ${nativeGidResult.error?.message || ''}`);
    const nativeUid = Number(nativeUidResult.stdout.trim());
    const nativeGid = Number(nativeGidResult.stdout.trim());
    if (nativeUid === 0 && Number.isInteger(nativeGid)) {
      const nativeModeAuth = `${modeNativeDir}/mode-700.json`;
      const chownFileResult = wslExec(['chown', '1:1', nativeModeAuth]);
      assert.equal(chownFileResult.status, 0, `native authorization owner setup failed: ${chownFileResult.stderr || ''}`);
      assertNativeModeFailure(
        runNativeWslAuthorizationVerify({
          moduleFile: modeNativeModule,
          authorizationFile: nativeModeAuth,
          queueFile: modeNativeQueue,
          rootDir: modeNativeRoot,
          date,
          nowEpoch: issueEpoch + 1,
        }),
        'native POSIX authorization file owner mismatch',
        /IMMEDIATE_AUTHORIZATION_FILE_OWNER_MISMATCH/,
      );
      const restoreFileOwner = wslExec(['chown', `${nativeUid}:${nativeGid}`, nativeModeAuth]);
      assert.equal(restoreFileOwner.status, 0, `native authorization file owner restore failed: ${restoreFileOwner.stderr || ''}`);
      const chownResult = wslExec(['chown', '1:1', modeNativeDir]);
      assert.equal(chownResult.status, 0, `native owner setup failed: ${chownResult.stderr || ''}`);
      assertNativeModeFailure(
        modeIssue(`${modeNativeDir}/owner-mismatch.json`),
        'native POSIX owner mismatch',
        /IMMEDIATE_AUTHORIZATION_DIRECTORY_OWNER_MISMATCH/,
      );
      const restoreOwner = wslExec(['chown', `${nativeUid}:${nativeGid}`, modeNativeDir]);
      assert.equal(restoreOwner.status, 0, `native owner restore failed: ${restoreOwner.stderr || ''}`);
    }
  }

  await expectReject(
    issueImmediateAuthorization({
      authorizationFile: path.join(authorizationDir, 'bad-max-groups.json'),
      queueFile,
      root: tempRoot,
      sourceGuardFile: hostSourceGuardFile,
      date,
      maxGroups: 33,
      ttlSec: 3600,
      reason: 'invalid max groups contract test',
      confirmationToken: IMMEDIATE_CONFIRMATION_TOKEN,
      nowEpoch: issueEpoch,
      timeZone: 'Asia/Shanghai',
    }),
    /maxGroups must be an integer from 1 through 32/,
  );

  await expectReject(
    issueImmediateAuthorization({
      authorizationFile: path.join(authorizationDir, 'bad-guard-namespace.json'),
      queueFile,
      root: tempRoot,
      sourceGuardFile: differentHostSourceGuardFile,
      date,
      maxGroups: 7,
      ttlSec: 3600,
      reason: 'different host guard bytes must fail',
      confirmationToken: IMMEDIATE_CONFIRMATION_TOKEN,
      nowEpoch: issueEpoch,
      timeZone: 'Asia/Shanghai',
    }),
    /sourceGuardHash mismatch/,
  );
  assert.equal(await exists(path.join(authorizationDir, 'bad-guard-namespace.json')), false,
    'a source guard SHA mismatch must not create an authorization file');

  const deadlineIssue = options => issueImmediateAuthorization({
    authorizationFile: path.join(authorizationDir, options.name),
    queueFile,
    root: tempRoot,
    sourceGuardFile: hostSourceGuardFile,
    date,
    maxGroups: 1,
    reason: 'deadline pair contract test',
    confirmationToken: IMMEDIATE_CONFIRMATION_TOKEN,
    nowEpoch: issueEpoch,
    timeZone: 'Asia/Shanghai',
    ...options,
  });
  await expectReject(
    deadlineIssue({
      name: 'bad-deadline-equal.json',
      gracefulCutoffEpoch: issueEpoch + 3600,
      outerHardDeadlineEpoch: issueEpoch + 3600,
    }),
    /outerHardDeadlineEpoch must be at least 900s after gracefulCutoffEpoch/,
  );
  await expectReject(
    deadlineIssue({
      name: 'bad-deadline-gap.json',
      gracefulCutoffEpoch: issueEpoch + 3600,
      outerHardDeadlineEpoch: issueEpoch + 4499,
    }),
    /outerHardDeadlineEpoch must be at least 900s after gracefulCutoffEpoch/,
  );
  await expectReject(
    deadlineIssue({
      name: 'bad-graceful-budget.json',
      gracefulCutoffEpoch: issueEpoch + 899,
      outerHardDeadlineEpoch: issueEpoch + 1799,
    }),
    'IMMEDIATE_AUTHORIZATION_EXPIRED',
  );

  const issued = await issueImmediateAuthorization({
    authorizationFile,
    queueFile,
    root: tempRoot,
    sourceGuardFile: hostSourceGuardFile,
    date,
    maxGroups: 7,
    ttlSec: 3600,
    reason: 'manual immediate repair contract test',
    confirmationToken: IMMEDIATE_CONFIRMATION_TOKEN,
    nowEpoch: issueEpoch,
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(issued.maxGroups, 7);
  assert.equal(issued.queueStateSha256, sha256(originalQueueBytes));
  assert.equal(issued.queueFingerprint, queue.queueFingerprint);
  assert.equal(issued.sourceGuardHash, sourceGuardHash);
  assert.equal(issued.gracefulCutoffEpoch - issueEpoch >= 900, true);
  assert.equal(issued.outerHardDeadlineEpoch - issued.gracefulCutoffEpoch >= 900, true);
  assert.equal(issued.outerHardDeadlineEpoch, issueEpoch + 4500);
  assert.equal(await exists(authorizationFile), true, 'issue must create one pending authorization artifact');
  if (process.platform !== 'win32') {
    assert.equal((await fsp.stat(authorizationFile)).mode & 0o777, 0o600,
      'pending authorization source must be mode 0600');
  }
  await fsp.mkdir(path.dirname(guardFile), {recursive: true});
  await fsp.writeFile(guardFile, guardBytes);
  // Runtime bind aliases share an inode; equal bytes in a different file are
  // deliberately insufficient. Exercise old records without reissuing them.
  const previousStateRoot = process.env.SHEIN_BI_STATE_ROOT;
  const aliasStateRoot = path.join(tempRoot, 'runtime-state');
  const physicalQueue = path.join(aliasStateRoot, path.relative(path.join(tempRoot, 'state'), queueFile));
  await fsp.mkdir(path.dirname(physicalQueue), {recursive: true});
  await fsp.link(queueFile, physicalQueue);
  process.env.SHEIN_BI_STATE_ROOT = aliasStateRoot;
  try {
    const aliasAuth = path.join(authorizationDir, 'runtime-alias.json');
    const aliasIssued = await issueImmediateAuthorization({
      authorizationFile: aliasAuth, queueFile, root: tempRoot, date, sourceGuardFile: hostSourceGuardFile,
      maxGroups: 1, ttlSec: 3600, reason: 'runtime queue alias offline test',
      confirmationToken: IMMEDIATE_CONFIRMATION_TOKEN, nowEpoch: issueEpoch,
    });
    assert.equal(aliasIssued.queueFile, physicalQueue, 'new issue must store the runtime path');
    const options = {authorizationFile: aliasAuth, queueFile: physicalQueue, root: tempRoot, date, nowEpoch: issueEpoch + 1};
    assert.equal((await verifyIssuedImmediateAuthorization({...options, queueFile})).ok, true);
    const oldRecord = JSON.parse(await fsp.readFile(aliasAuth, 'utf8'));
    oldRecord.queueFile = queueFile;
    await fsp.writeFile(aliasAuth, JSON.stringify(oldRecord));
    assert.equal((await verifyIssuedImmediateAuthorization(options)).ok, true, 'legacy host-path record accepts exact inode');
    await fsp.unlink(physicalQueue);
    await fsp.writeFile(physicalQueue, originalQueueBytes);
    await expectReject(verifyIssuedImmediateAuthorization(options), 'IMMEDIATE_AUTHORIZATION_BINDING_MISMATCH');
    await fsp.unlink(physicalQueue);
    await fsp.link(queueFile, physicalQueue);
    const savedQueue = `${queueFile}.saved`;
    await fsp.rename(queueFile, savedQueue);
    await expectReject(verifyIssuedImmediateAuthorization(options), 'IMMEDIATE_AUTHORIZATION_MISSING');
    await fsp.writeFile(queueFile, originalQueueBytes);
    await expectReject(verifyIssuedImmediateAuthorization(options), 'IMMEDIATE_AUTHORIZATION_BINDING_MISMATCH');
    await fsp.unlink(queueFile);
    await fsp.rename(savedQueue, queueFile);
    const realOpen = fsp.open;
    let swapped = false;
    fsp.open = async (...args) => {
      const handle = await realOpen(...args);
      if (args[0] === queueFile) {
        const read = handle.readFile.bind(handle);
        handle.readFile = async (...readArgs) => {
          const bytes = await read(...readArgs);
          await fsp.rename(queueFile, savedQueue);
          await fsp.writeFile(queueFile, originalQueueBytes);
          swapped = true;
          return bytes;
        };
      }
      return handle;
    };
    try {
      await assert.rejects(verifyIssuedImmediateAuthorization(options), error =>
        ['IMMEDIATE_AUTHORIZATION_FILE_PATH_SWAPPED', 'IMMEDIATE_AUTHORIZATION_FILE_RACE'].includes(error.code));
    } finally {
      fsp.open = realOpen;
      if (swapped) { await fsp.unlink(queueFile); await fsp.rename(savedQueue, queueFile); }
    }
    const consumedAlias = await consumeImmediateAuthorization(options);
    assert.equal(consumedAlias.ok, true);
    await expectReject(consumeImmediateAuthorization({...options, queueFile}), 'IMMEDIATE_AUTHORIZATION_ALREADY_CONSUMED');
    const continuation = await verifyImmediateAuthorizationContinuation({
      receiptFile: consumedAlias.receiptFile || deriveConsumedAuthorizationFile(aliasAuth, aliasIssued.authorizationId),
      queueFile, root: tempRoot, date, nowEpoch: issueEpoch + 2,
    });
    assert.equal(continuation.authorizationId, aliasIssued.authorizationId, 'continuation retains original authorization');
  } finally {
    if (previousStateRoot === undefined) delete process.env.SHEIN_BI_STATE_ROOT;
    else process.env.SHEIN_BI_STATE_ROOT = previousStateRoot;
  }
  const issuedVerification = await verifyIssuedImmediateAuthorization({
    authorizationFile,
    queueFile,
    root: tempRoot,
    date,
    nowEpoch: issueEpoch + 1,
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(issuedVerification.ok, true, 'pending authorization must be verifiable before consume');
  assert.equal(await exists(authorizationFile), true, 'verification must not consume the pending source');

  await expectReject(
    consumeImmediateAuthorization({
      authorizationFile,
      queueFile,
      root: tempRoot,
      date,
      nowEpoch: issueEpoch + 1,
      timeZone: 'Asia/Shanghai',
      expectedAuthorizationId: '00000000-0000-4000-8000-000000000000',
      expectedAuthorizationFileSha256: issuedVerification.authorizationFileSha256,
      expectedQueueStateSha256: issuedVerification.queueStateSha256,
      expectedQueueFingerprint: issuedVerification.queueFingerprint,
      expectedSourceGuardHash: issuedVerification.sourceGuardHash,
      expectedMaxGroups: issuedVerification.maxGroups,
      expectedGracefulCutoffEpoch: issuedVerification.gracefulCutoffEpoch,
      expectedOuterHardDeadlineEpoch: issuedVerification.outerHardDeadlineEpoch,
      expectedReason: issuedVerification.reason,
    }),
    'IMMEDIATE_AUTHORIZATION_BINDING_MISMATCH',
  );
  assert.equal(await exists(authorizationFile), true,
    'a consume binding mismatch must fail before the one-time source is claimed');

  const consumed = await consumeImmediateAuthorization({
    authorizationFile,
    queueFile,
    root: tempRoot,
    date,
    nowEpoch: issueEpoch + 1,
    timeZone: 'Asia/Shanghai',
    expectedAuthorizationId: issuedVerification.authorizationId,
    expectedAuthorizationFileSha256: issuedVerification.authorizationFileSha256,
    expectedQueueStateSha256: issuedVerification.queueStateSha256,
    expectedQueueFingerprint: issuedVerification.queueFingerprint,
    expectedSourceGuardHash: issuedVerification.sourceGuardHash,
    expectedMaxGroups: issuedVerification.maxGroups,
    expectedGracefulCutoffEpoch: issuedVerification.gracefulCutoffEpoch,
    expectedOuterHardDeadlineEpoch: issuedVerification.outerHardDeadlineEpoch,
    expectedReason: issuedVerification.reason,
  });
  assert.equal(consumed.status, 'consumed');
  assert.equal(consumed.maxGroups, 7);
  assert.equal(consumed.queueStateSha256, issued.queueStateSha256);
  assert.equal(await exists(authorizationFile), false, 'one-time source must be atomically closed after consume');
  assert.equal(await exists(consumed.consumedReceiptFile), true, 'consumed receipt must remain auditable');

  const verified = await verifyConsumedImmediateAuthorization({
    receiptFile: consumed.consumedReceiptFile,
    queueFile,
    root: tempRoot,
    date,
    nowEpoch: issueEpoch + 2,
    timeZone: 'Asia/Shanghai',
    expectedAuthorizationId: consumed.authorizationId,
    expectedQueueStateSha256: consumed.queueStateSha256,
    expectedQueueFingerprint: consumed.queueFingerprint,
    expectedSourceGuardHash: consumed.sourceGuardHash,
    expectedMaxGroups: consumed.maxGroups,
    expectedGracefulCutoffEpoch: consumed.gracefulCutoffEpoch,
    expectedOuterHardDeadlineEpoch: consumed.outerHardDeadlineEpoch,
    expectedReason: consumed.reason,
    expectedReceiptSha256: consumed.consumedReceiptSha256,
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.remainingSec >= 900, true);

  await expectReject(
    consumeImmediateAuthorization({
      authorizationFile,
      queueFile,
      root: tempRoot,
      date,
      nowEpoch: issueEpoch + 3,
      timeZone: 'Asia/Shanghai',
    }),
    'IMMEDIATE_AUTHORIZATION_ALREADY_CONSUMED',
  );

  const claimFailureFile = path.join(authorizationDir, 'claim-finalize-failure.json');
  const claimFailureIssued = await issueImmediateAuthorization({
    authorizationFile: claimFailureFile,
    queueFile,
    root: tempRoot,
    sourceGuardFile: hostSourceGuardFile,
    date,
    maxGroups: 1,
    ttlSec: 3600,
    reason: 'claimed receipt survives consumed receipt finalization failure',
    confirmationToken: IMMEDIATE_CONFIRMATION_TOKEN,
    nowEpoch: issueEpoch,
    timeZone: 'Asia/Shanghai',
  });
  const claimFailureReceipt = deriveConsumedAuthorizationFile(claimFailureFile, claimFailureIssued.authorizationId);
  await expectReject(
    consumeImmediateAuthorization({
      authorizationFile: claimFailureFile,
      queueFile,
      root: tempRoot,
      date,
      nowEpoch: issueEpoch + 4,
      timeZone: 'Asia/Shanghai',
      receiptWriter: async () => { throw new Error('forced consumed receipt finalization failure'); },
    }),
    'IMMEDIATE_AUTHORIZATION_CLAIMED_RECEIPT_FINALIZE_FAILED',
  );
  assert.equal(await exists(claimFailureFile), false,
    'receipt finalization failure must not reopen the one-time source');
  assert.equal(await exists(claimFailureReceipt), true,
    'receipt finalization failure must retain an auditable claimed receipt');
  const claimedDoc = JSON.parse(await fsp.readFile(claimFailureReceipt, 'utf8'));
  assert.equal(claimedDoc.status, 'claimed');
  assert.equal(claimedDoc.claimedFrom, claimFailureFile);
  assert.equal(claimedDoc.claimedReceiptFile, claimFailureReceipt);
  if (process.platform !== 'win32') {
    const claimedStat = await fsp.stat(claimFailureReceipt);
    assert.equal(claimedStat.mode & 0o777, 0o600);
    assert.equal(claimedStat.uid, process.getuid(), 'claimed receipt owner must remain the service uid');
  }
  await expectReject(
    consumeImmediateAuthorization({
      authorizationFile: claimFailureFile,
      queueFile,
      root: tempRoot,
      date,
      nowEpoch: issueEpoch + 5,
      timeZone: 'Asia/Shanghai',
    }),
    'IMMEDIATE_AUTHORIZATION_ALREADY_CONSUMED',
  );

  // A real child consumes the one-time source and is then SIGKILLed before it
  // can enter any worker executor. At 22:56 (past graceful, before outer), the
  // immutable receipt must be the only continuation admission and cannot be
  // consumed again.
  const lateIssueEpoch = Math.floor(Date.parse(`${date}T14:30:00.000Z`) / 1000);
  const lateGracefulEpoch = Math.floor(Date.parse(`${date}T14:55:00.000Z`) / 1000);
  const lateOuterEpoch = Math.floor(Date.parse(`${date}T15:10:00.000Z`) / 1000);
  const lateConsumeEpoch = Math.floor(Date.parse(`${date}T14:39:00.000Z`) / 1000);
  const lateRestartEpoch = Math.floor(Date.parse(`${date}T14:56:00.000Z`) / 1000);
  const crashAuthorizationFile = path.join(authorizationDir, 'consume-then-sigkill.json');
  const crashIssued = await issueImmediateAuthorization({
    authorizationFile: crashAuthorizationFile,
    queueFile,
    root: tempRoot,
    sourceGuardFile: hostSourceGuardFile,
    date,
    maxGroups: 1,
    gracefulCutoffEpoch: lateGracefulEpoch,
    outerHardDeadlineEpoch: lateOuterEpoch,
    reason: '22:56 crash continuation test',
    confirmationToken: IMMEDIATE_CONFIRMATION_TOKEN,
    nowEpoch: lateIssueEpoch,
    timeZone: 'Asia/Shanghai',
  });
  const crashConsumer = path.join(tempRoot, 'consume-then-sigkill.mjs');
  const authorizationModuleUrl = pathToFileURL(path.join(root, 'lib', 'cloud_marketing_immediate_authorization.mjs')).href;
  await fsp.writeFile(crashConsumer, `
import {consumeImmediateAuthorization} from ${JSON.stringify(authorizationModuleUrl)};
await consumeImmediateAuthorization(${JSON.stringify({
    authorizationFile: crashAuthorizationFile,
    queueFile,
    root: tempRoot,
    date,
    nowEpoch: lateConsumeEpoch,
    timeZone: 'Asia/Shanghai',
    expectedAuthorizationId: crashIssued.authorizationId,
  })});
process.kill(process.pid, 'SIGKILL');
`);
  const killedAfterConsume = spawnSync(process.execPath, [crashConsumer], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
  assert.equal(killedAfterConsume.error, undefined, killedAfterConsume.error?.message || 'SIGKILL consumer spawn failed');
  assert.ok(killedAfterConsume.signal === 'SIGKILL' || killedAfterConsume.status !== 0,
    'fault injector must terminate after consume without a graceful worker return');
  const crashReceiptFile = deriveConsumedAuthorizationFile(crashAuthorizationFile, crashIssued.authorizationId);
  assert.equal(await exists(crashAuthorizationFile), false,
    `SIGKILL continuation source must remain atomically unlinked: status=${killedAfterConsume.status} signal=${killedAfterConsume.signal} stderr=${killedAfterConsume.stderr}`);
  assert.equal(await exists(crashReceiptFile), true, 'SIGKILL continuation must retain immutable receipt');
  const crashReceiptBytes = await fsp.readFile(crashReceiptFile);
  const crashReceiptSha256 = sha256(crashReceiptBytes);
  const crashContinuation = await verifyImmediateAuthorizationContinuation({
    receiptFile: crashReceiptFile,
    queueFile,
    root: tempRoot,
    date,
    nowEpoch: lateRestartEpoch,
    timeZone: 'Asia/Shanghai',
    expectedAuthorizationId: crashIssued.authorizationId,
    expectedQueueStateSha256: crashIssued.queueStateSha256,
    expectedQueueFingerprint: crashIssued.queueFingerprint,
    expectedSourceGuardHash: crashIssued.sourceGuardHash,
    expectedMaxGroups: crashIssued.maxGroups,
    expectedGracefulCutoffEpoch: crashIssued.gracefulCutoffEpoch,
    expectedOuterHardDeadlineEpoch: crashIssued.outerHardDeadlineEpoch,
    expectedReason: crashIssued.reason,
    expectedReceiptSha256: crashReceiptSha256,
  });
  assert.equal(crashContinuation.continuation, true);
  assert.ok(crashContinuation.gracefulRemainingSec < 0 && crashContinuation.outerRemainingSec > 0,
    '22:56 restart must be admitted only inside graceful<now<outer continuation window');
  const discoveredCrashContinuation = await findImmediateAuthorizationContinuation({
    authorizationFile: crashAuthorizationFile,
    queueFile,
    root: tempRoot,
    date,
    nowEpoch: lateRestartEpoch,
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(discoveredCrashContinuation.receiptSha256, crashReceiptSha256,
    'source-unlinked restart must discover the exact immutable receipt SHA');
  await expectReject(verifyImmediateAuthorizationContinuation({
    receiptFile: crashReceiptFile,
    queueFile,
    root: tempRoot,
    date,
    nowEpoch: lateOuterEpoch,
    timeZone: 'Asia/Shanghai',
  }), 'IMMEDIATE_AUTHORIZATION_EXPIRED');
  await expectReject(consumeImmediateAuthorization({
    authorizationFile: crashAuthorizationFile,
    queueFile,
    root: tempRoot,
    date,
    nowEpoch: lateRestartEpoch,
    timeZone: 'Asia/Shanghai',
    expectedAuthorizationId: crashIssued.authorizationId,
  }), 'IMMEDIATE_AUTHORIZATION_ALREADY_CONSUMED');

  // Historical receipt A must not seal the reusable authorization path. B is
  // independently issued, verified, inspected and consumed; A remains
  // immutable and cannot be replayed.
  const rotatingAuthorizationFile = path.join(authorizationDir, 'authorization-rotation.json');
  const rotationA = await issueImmediateAuthorization({
    authorizationFile: rotatingAuthorizationFile,
    queueFile,
    root: tempRoot,
    sourceGuardFile: hostSourceGuardFile,
    date,
    maxGroups: 1,
    ttlSec: 3600,
    reason: 'authorization rotation A',
    confirmationToken: IMMEDIATE_CONFIRMATION_TOKEN,
    nowEpoch: issueEpoch,
    timeZone: 'Asia/Shanghai',
  });
  const rotationAConsumed = await consumeImmediateAuthorization({
    authorizationFile: rotatingAuthorizationFile,
    queueFile,
    root: tempRoot,
    date,
    nowEpoch: issueEpoch + 1,
    timeZone: 'Asia/Shanghai',
    expectedAuthorizationId: rotationA.authorizationId,
  });
  const rotationB = await issueImmediateAuthorization({
    authorizationFile: rotatingAuthorizationFile,
    queueFile,
    root: tempRoot,
    sourceGuardFile: hostSourceGuardFile,
    date,
    maxGroups: 2,
    ttlSec: 3600,
    reason: 'authorization rotation B',
    confirmationToken: IMMEDIATE_CONFIRMATION_TOKEN,
    nowEpoch: issueEpoch + 2,
    timeZone: 'Asia/Shanghai',
  });
  const rotationBVerified = await verifyIssuedImmediateAuthorization({
    authorizationFile: rotatingAuthorizationFile,
    queueFile,
    root: tempRoot,
    date,
    nowEpoch: issueEpoch + 3,
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(rotationBVerified.authorizationId, rotationB.authorizationId,
    'historical A receipt must not block verify-issued for current authorization B');
  assert.equal((await inspectImmediateAuthorization({authorizationFile: rotatingAuthorizationFile})).authorizationId,
    rotationB.authorizationId, 'inspect default path must return current B');
  assert.equal((await inspectImmediateAuthorization({authorizationFile: rotationAConsumed.consumedReceiptFile})).authorizationId,
    rotationA.authorizationId, 'inspect explicit A receipt must remain auditable');
  const rotationBConsumed = await consumeImmediateAuthorization({
    authorizationFile: rotatingAuthorizationFile,
    queueFile,
    root: tempRoot,
    date,
    nowEpoch: issueEpoch + 4,
    timeZone: 'Asia/Shanghai',
    expectedAuthorizationId: rotationB.authorizationId,
  });
  assert.notEqual(rotationBConsumed.consumedReceiptFile, rotationAConsumed.consumedReceiptFile);
  const rotationContinuation = await findImmediateAuthorizationContinuation({
    authorizationFile: rotatingAuthorizationFile,
    queueFile,
    root: tempRoot,
    date,
    nowEpoch: issueEpoch + 5,
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(rotationContinuation.authorizationId, rotationB.authorizationId,
    'latest current authorization B must win continuation discovery over historical receipt A');
  const staleQueueFile = path.join(tempRoot, 'state', 'cloud_marketing_live_guard', 'repair-queues', `marketing-repair-${date}-stale.json`);
  await fsp.writeFile(staleQueueFile, `${JSON.stringify({...queue, queueFingerprint: sha256('queue-fingerprint-stale')}, null, 2)}\n`, 'utf8');
  await expectReject(findImmediateAuthorizationContinuation({
    authorizationFile: rotatingAuthorizationFile,
    queueFile: staleQueueFile,
    root: tempRoot,
    date,
    nowEpoch: issueEpoch + 5,
    timeZone: 'Asia/Shanghai',
  }), 'IMMEDIATE_AUTHORIZATION_BINDING_MISMATCH');
  const scheduledStaleContinuation = await findImmediateAuthorizationContinuation({
    authorizationFile: rotatingAuthorizationFile,
    queueFile: staleQueueFile,
    root: tempRoot,
    date,
    nowEpoch: issueEpoch + 5,
    timeZone: 'Asia/Shanghai',
    scheduledDiscovery: true,
  });
  assert.equal(scheduledStaleContinuation.stale, true,
    'scheduled discovery must convert a structurally valid stale receipt into an auditable no-op');
  assert.equal(scheduledStaleContinuation.continuation, false);
  assert.equal(scheduledStaleContinuation.reason, 'current_queue_binding_mismatch');
  const scheduledExpiredContinuation = await findImmediateAuthorizationContinuation({
    authorizationFile: crashAuthorizationFile,
    queueFile,
    root: tempRoot,
    date,
    nowEpoch: lateOuterEpoch + 1,
    timeZone: 'Asia/Shanghai',
    scheduledDiscovery: true,
  });
  assert.equal(scheduledExpiredContinuation.reason, 'continuation_authorization_expired',
    'scheduled discovery must defer an expired immutable receipt without executing it');
  await expectReject(consumeImmediateAuthorization({
    authorizationFile: rotatingAuthorizationFile,
    queueFile,
    root: tempRoot,
    date,
    nowEpoch: issueEpoch + 5,
    timeZone: 'Asia/Shanghai',
    expectedAuthorizationId: rotationA.authorizationId,
  }), 'IMMEDIATE_AUTHORIZATION_ALREADY_CONSUMED');

  await expectReject(
    verifyConsumedImmediateAuthorization({
      receiptFile: consumed.consumedReceiptFile,
      queueFile,
      root: tempRoot,
      date: date === '2000-01-01' ? '2000-01-02' : '2000-01-01',
      nowEpoch: issueEpoch + 2,
      timeZone: 'Asia/Shanghai',
    }),
    /business date mismatch|current business date/,
  );

  await fsp.writeFile(queueFile, `${JSON.stringify({...queue, updatedAt: 'sha-drift'}, null, 2)}\n`, 'utf8');
  await expectReject(
    verifyConsumedImmediateAuthorization({
      receiptFile: consumed.consumedReceiptFile,
      queueFile,
      root: tempRoot,
      date,
      nowEpoch: issueEpoch + 2,
      timeZone: 'Asia/Shanghai',
    }),
    /queue file SHA-256 mismatch|sourceGuardHash mismatch/,
  );
  await fsp.writeFile(queueFile, originalQueueBytes);

  await fsp.writeFile(queueFile, `${JSON.stringify({...queue, queueFingerprint: 'f'.repeat(64)}, null, 2)}\n`, 'utf8');
  await expectReject(
    verifyConsumedImmediateAuthorization({
      receiptFile: consumed.consumedReceiptFile,
      queueFile,
      root: tempRoot,
      date,
      nowEpoch: issueEpoch + 2,
      timeZone: 'Asia/Shanghai',
    }),
    /queue file SHA-256 mismatch|queueFingerprint mismatch/,
  );
  await fsp.writeFile(queueFile, originalQueueBytes);

  await fsp.writeFile(guardFile, Buffer.from(`${JSON.stringify({reportDate: date, changed: true})}\n`, 'utf8'));
  await expectReject(
    verifyConsumedImmediateAuthorization({
      receiptFile: consumed.consumedReceiptFile,
      queueFile,
      root: tempRoot,
      date,
      nowEpoch: issueEpoch + 2,
      timeZone: 'Asia/Shanghai',
    }),
    /sourceGuardHash mismatch/,
  );
  await fsp.writeFile(guardFile, guardBytes);

  await expectReject(
    verifyConsumedImmediateAuthorization({
      receiptFile: consumed.consumedReceiptFile,
      queueFile,
      root: tempRoot,
      date,
      nowEpoch: consumed.gracefulCutoffEpoch - 899,
      timeZone: 'Asia/Shanghai',
    }),
    'IMMEDIATE_AUTHORIZATION_EXPIRED',
  );

  const receiptOriginalBytes = await fsp.readFile(consumed.consumedReceiptFile);
  const tamperedReceipt = JSON.parse(receiptOriginalBytes.toString('utf8'));
  tamperedReceipt.maxGroups = 33;
  await writeJsonFileAtomic(consumed.consumedReceiptFile, tamperedReceipt, {mode: 0o600});
  await expectReject(
    verifyConsumedImmediateAuthorization({
      receiptFile: consumed.consumedReceiptFile,
      queueFile,
      root: tempRoot,
      date,
      nowEpoch: issueEpoch + 2,
      timeZone: 'Asia/Shanghai',
    }),
    /maxGroups must be an integer from 1 through 32/,
  );
  await fsp.writeFile(consumed.consumedReceiptFile, receiptOriginalBytes);

  // Real local harness: issue a fresh authorization against a temporary root,
  // run the actual fallback wrapper with a stub host-heavy runner that exits
  // 75, and prove that wrapper admission did not consume the source.
  const useNativeWslHarness = process.platform === 'win32';
  const harnessStageRoot = path.join(tempRoot, 'runtime-harness');
  const harnessRoot = useNativeWslHarness
    ? `/var/lib/cloud-marketing-immediate-contract-${process.pid}-${Date.now()}`
    : harnessStageRoot;
  if (useNativeWslHarness) nativeWslHarnessRoots.push(harnessRoot);
  const harnessStateDir = path.join(harnessStageRoot, 'state', 'cloud_marketing_live_guard');
  const harnessQueueFile = path.join(harnessStateDir, 'repair-queues', `marketing-repair-${date}.json`);
  const harnessGuardFile = path.join(harnessStageRoot, 'state', 'guard.json');
  const harnessAuthorizationFile = path.join(harnessStageRoot, 'runtime', 'marketing-repair-immediate', 'authorization.json');
  const harnessHostMarker = path.join(harnessStageRoot, 'host-heavy-called.txt');
  const harnessStageHostMarker = path.join(harnessStageRoot, 'host-heavy-called.txt');
  const harnessStateRuntimePath = useNativeWslHarness
    ? `${harnessRoot}/state/cloud_marketing_live_guard`
    : harnessStateDir;
  const harnessGuardRuntimePath = useNativeWslHarness ? `${harnessRoot}/state/guard.json` : harnessGuardFile;
  const harnessQueueRuntimePath = useNativeWslHarness
    ? `${harnessRoot}/state/cloud_marketing_live_guard/repair-queues/marketing-repair-${date}.json`
    : harnessQueueFile;
  const harnessAuthorizationRuntimePath = useNativeWslHarness
    ? `${harnessRoot}/runtime/marketing-repair-immediate/authorization.json`
    : harnessAuthorizationFile;
  await fsp.mkdir(path.join(harnessStageRoot, 'scripts', 'lib'), {recursive: true});
  await fsp.mkdir(path.join(harnessStageRoot, 'lib'), {recursive: true});
  await fsp.mkdir(path.dirname(harnessQueueFile), {recursive: true});
  await fsp.mkdir(path.dirname(harnessAuthorizationFile), {recursive: true});
  if (process.platform !== 'win32') await fsp.chmod(path.dirname(harnessAuthorizationFile), 0o700);
  await fsp.writeFile(harnessGuardFile, guardBytes);
  const harnessQueue = {
    ...queue,
    sourceGuard: 'state/guard.json',
    sourceGuardHash,
  };
  await fsp.writeFile(harnessQueueFile, `${JSON.stringify(harnessQueue, null, 2)}\n`, 'utf8');
  await fsp.copyFile(path.join(root, 'scripts', 'manage_cloud_marketing_immediate_run.mjs'), path.join(harnessStageRoot, 'scripts', 'manage_cloud_marketing_immediate_run.mjs'));
  await fsp.copyFile(path.join(root, 'lib', 'cloud_marketing_immediate_authorization.mjs'), path.join(harnessStageRoot, 'lib', 'cloud_marketing_immediate_authorization.mjs'));
  await fsp.copyFile(path.join(root, 'lib', 'cloud_marketing_deadline_contract.mjs'), path.join(harnessStageRoot, 'lib', 'cloud_marketing_deadline_contract.mjs'));
  await fsp.copyFile(path.join(root, 'lib', 'atomic_file_publish.mjs'), path.join(harnessStageRoot, 'lib', 'atomic_file_publish.mjs'));
  await fsp.writeFile(path.join(harnessStageRoot, 'scripts', 'run_host_heavy_job.sh'),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > "${shellPath(harnessStageHostMarker)}"\nexit 75\n`, 'utf8');
  if (useNativeWslHarness) {
    prepareNativeAuthorizationRoot(harnessRoot, {
      writableDirectories: [
        `${harnessRoot}/scripts`,
        `${harnessRoot}/lib`,
        `${harnessRoot}/state`,
        `${harnessRoot}/logs`,
        `${harnessRoot}/bin`,
      ],
      authorizationDirectories: [`${harnessRoot}/runtime/marketing-repair-immediate`],
    });
    wslMkdir(`${harnessRoot}/scripts/lib`);
    wslMkdir(`${harnessRoot}/lib`);
    wslMkdir(`${harnessRoot}/state/cloud_marketing_live_guard/repair-queues`);
    wslMkdir(`${harnessRoot}/runtime/marketing-repair-immediate`);
    wslCopy(harnessGuardFile, harnessGuardRuntimePath);
    wslCopy(harnessQueueFile, harnessQueueRuntimePath);
    wslCopy(path.join(harnessStageRoot, 'scripts', 'manage_cloud_marketing_immediate_run.mjs'), `${harnessRoot}/scripts/manage_cloud_marketing_immediate_run.mjs`);
    wslCopy(path.join(harnessStageRoot, 'lib', 'cloud_marketing_immediate_authorization.mjs'), `${harnessRoot}/lib/cloud_marketing_immediate_authorization.mjs`);
    wslCopy(path.join(harnessStageRoot, 'lib', 'cloud_marketing_deadline_contract.mjs'), `${harnessRoot}/lib/cloud_marketing_deadline_contract.mjs`);
    wslCopy(path.join(harnessStageRoot, 'lib', 'atomic_file_publish.mjs'), `${harnessRoot}/lib/atomic_file_publish.mjs`);
    wslCopy(path.join(harnessStageRoot, 'scripts', 'run_host_heavy_job.sh'), `${harnessRoot}/scripts/run_host_heavy_job.sh`);
  }
  const harnessNow = Math.floor(Date.now() / 1000);
  const harnessGraceful = harnessNow + 1800;
  const harnessOuter = harnessNow + 2700;
  let harnessIssued;
  if (useNativeWslHarness) {
    wslChmod('700', `${harnessRoot}/runtime/marketing-repair-immediate`);
    const issueRun = wslExec([
      'node', `${harnessRoot}/scripts/manage_cloud_marketing_immediate_run.mjs`,
      'issue', '--date', date, '--queue', harnessQueueRuntimePath,
      '--root', harnessRoot, '--source-guard-file', harnessGuardRuntimePath,
      '--max-groups', '7', '--graceful-cutoff-epoch', String(harnessGraceful),
      '--outer-hard-deadline-epoch', String(harnessOuter),
      '--reason', 'real wrapper 75 defer harness',
      '--confirm-token', IMMEDIATE_CONFIRMATION_TOKEN,
      '--authorization-file', harnessAuthorizationRuntimePath,
      '--now-epoch', String(harnessNow), '--time-zone', 'Asia/Shanghai',
    ]);
    assert.equal(issueRun.error, undefined, `native WSL issue spawn failed: ${issueRun.error?.message || ''}`);
    assert.equal(issueRun.status, 0, `native WSL issue failed: ${issueRun.stderr || issueRun.stdout}`);
    harnessIssued = JSON.parse(issueRun.stdout);
    wslChmod('600', harnessAuthorizationRuntimePath);
    wslCopy(harnessAuthorizationRuntimePath, harnessAuthorizationFile);
  } else {
    harnessIssued = await issueImmediateAuthorization({
      authorizationFile: harnessAuthorizationFile,
      queueFile: harnessQueueFile,
      root: harnessRoot,
      sourceGuardFile: harnessGuardFile,
      date,
      maxGroups: 7,
      gracefulCutoffEpoch: harnessGraceful,
      outerHardDeadlineEpoch: harnessOuter,
      reason: 'real wrapper 75 defer harness',
      confirmationToken: IMMEDIATE_CONFIRMATION_TOKEN,
      nowEpoch: harnessNow,
      timeZone: 'Asia/Shanghai',
    });
  }
  const harnessEnv = {
    ...process.env,
    SHEIN_BI_ROOT: useNativeWslHarness ? harnessRoot : shellPath(harnessRoot),
    SHEIN_BI_TZ: 'Asia/Shanghai',
    SHEIN_BI_MARKETING_IMMEDIATE_RUN: 'false',
    SHEIN_BI_MARKETING_IMMEDIATE_AUTHORIZATION_FILE: useNativeWslHarness
      ? harnessAuthorizationRuntimePath
      : shellPath(harnessAuthorizationFile),
    SHEIN_BI_MARKETING_LIVE_STATE_DIR: useNativeWslHarness
      ? harnessStateRuntimePath
      : shellPath(harnessStateDir),
    SHEIN_BI_MARKETING_REPAIR_MIN_START_BUDGET_SEC: '900',
    SHEIN_BI_MARKETING_RUN_ID: 'immediate-wrapper-75-harness',
  };
  const harnessProbe = bashExec(
    'if [[ -e "$SHEIN_BI_MARKETING_IMMEDIATE_AUTHORIZATION_FILE" ]]; then printf yes; else printf "no path=%s dir=%s\\n" "$SHEIN_BI_MARKETING_IMMEDIATE_AUTHORIZATION_FILE" "$(dirname "$SHEIN_BI_MARKETING_IMMEDIATE_AUTHORIZATION_FILE")"; ls -ld "$(dirname "$SHEIN_BI_MARKETING_IMMEDIATE_AUTHORIZATION_FILE")" 2>&1 || true; fi',
    {environment: harnessEnv},
  );
  assert.match(harnessProbe.stdout, /^yes$/, `bash harness path probe failed: ${harnessProbe.stdout} ${harnessProbe.stderr}`);
  const wrapperPath = path.join(root, 'scripts', 'run_cloud_marketing_fallback_slot.sh');
  const wrapperRun = bashExec(`bash ${bashQuote(shellPath(wrapperPath))}`, {environment: harnessEnv});
  assert.equal(wrapperRun.error, undefined, `wrapper harness spawn failed: ${wrapperRun.error?.message || ''}`);
  assert.equal(wrapperRun.status, 75, `stub host-heavy runner must return 75: ${wrapperRun.stderr || wrapperRun.stdout}`);
  if (useNativeWslHarness) wslCopy(harnessAuthorizationRuntimePath, harnessAuthorizationFile);
  assert.equal(await exists(harnessAuthorizationFile), true,
    'wrapper host-heavy defer must leave the issued authorization source retryable');
  const harnessReceiptNames = useNativeWslHarness
    ? wslFileNames(`${harnessRoot}/runtime/marketing-repair-immediate`)
      .filter(name => name.startsWith('authorization.json.consumed.'))
    : (await fsp.readdir(path.dirname(harnessAuthorizationFile)))
      .filter(name => name.startsWith('authorization.json.consumed.'));
  assert.deepEqual(harnessReceiptNames, [], 'wrapper host-heavy defer must not publish a consumed receipt');
  assert.equal(await exists(harnessHostMarker), true,
    `the local stub host-heavy runner must actually execute: ${wrapperRun.stderr || wrapperRun.stdout || '(no wrapper output)'} auth=${harnessEnv.SHEIN_BI_MARKETING_IMMEDIATE_AUTHORIZATION_FILE} root=${harnessEnv.SHEIN_BI_ROOT} sourceExists=${await exists(harnessAuthorizationFile)}`);

  // A normal scheduled timer must ignore a stale issued authorization from an
  // old business date/queue instead of turning it into immediate mode and
  // failing closed before the ordinary 20:45/21:15 window logic.
  const staleHarness = {
    ...harnessIssued,
    date: '2026-08-26',
    queueFile: useNativeWslHarness
      ? `${harnessRoot}/state/cloud_marketing_live_guard/repair-queues/marketing-repair-2026-08-26.json`
      : shellPath(path.join(harnessStateDir, 'repair-queues', 'marketing-repair-2026-08-26.json')),
  };
  await fsp.writeFile(harnessAuthorizationFile, `${JSON.stringify(staleHarness, null, 2)}\n`, 'utf8');
  if (useNativeWslHarness) wslCopy(harnessAuthorizationFile, harnessAuthorizationRuntimePath);
  await fsp.rm(harnessHostMarker, {force: true});
  const ordinaryStaleWrapperRun = bashExec(`bash ${bashQuote(shellPath(wrapperPath))}`, {
    environment: {...harnessEnv, SHEIN_BI_MARKETING_IMMEDIATE_RUN: undefined},
  });
  assert.equal(ordinaryStaleWrapperRun.error, undefined,
    `ordinary stale wrapper harness spawn failed: ${ordinaryStaleWrapperRun.error?.message || ''}`);
  assert.equal(ordinaryStaleWrapperRun.status, 75,
    `ordinary scheduled stale authorization must return the managed timer defer/skip status instead of exit64: ${ordinaryStaleWrapperRun.stderr || ordinaryStaleWrapperRun.stdout}`);
  assert.doesNotMatch(ordinaryStaleWrapperRun.stderr, /immediate authorization verification failed/,
    'ordinary scheduled stale authorization must not enter immediate fail-closed verification');
  if (useNativeWslHarness) wslCopy(harnessAuthorizationRuntimePath, harnessAuthorizationFile);
  assert.deepEqual(JSON.parse(await fsp.readFile(harnessAuthorizationFile, 'utf8')), staleHarness,
    'ordinary scheduled stale authorization must remain immutable audit evidence');
  await fsp.rm(harnessHostMarker, {force: true});

  const explicitStaleWrapperRun = bashExec(`bash ${bashQuote(shellPath(wrapperPath))}`, {
    environment: {...harnessEnv, SHEIN_BI_MARKETING_IMMEDIATE_RUN: 'true'},
  });
  assert.equal(explicitStaleWrapperRun.error, undefined,
    `explicit stale wrapper harness spawn failed: ${explicitStaleWrapperRun.error?.message || ''}`);
  assert.equal(explicitStaleWrapperRun.status, 64,
    'explicit immediate run with a stale authorization must fail closed');
  assert.match(explicitStaleWrapperRun.stderr, /immediate authorization verification failed/,
    'explicit immediate stale authorization must report immediate verification failure');
  assert.equal(await exists(harnessHostMarker), false, 'explicit stale authorization must stop before host-heavy admission');
  assert.equal(await exists(harnessAuthorizationFile), true, 'stale authorization source remains auditable and retryable');

  // Execute the worker's real pending-authorization verifier in a temporary
  // copy and stop immediately after it. The expected fields are deliberately
  // supplied to the node process on the right side of the pipeline; a broken
  // left-side assignment would return 64 here instead of the injected 75.
  const workerHarnessAuth = path.join(harnessStageRoot, 'runtime', 'worker', 'authorization.json');
  const workerHarnessAuthRuntimePath = useNativeWslHarness
    ? `${harnessRoot}/runtime/worker/authorization.json`
    : workerHarnessAuth;
  await fsp.mkdir(path.dirname(workerHarnessAuth), {recursive: true});
  if (process.platform !== 'win32') await fsp.chmod(path.dirname(workerHarnessAuth), 0o700);
  if (useNativeWslHarness) {
    prepareNativeAuthorizationRoot(harnessRoot, {
      authorizationDirectories: [`${harnessRoot}/runtime/worker`],
    });
  }
  const workerNow = Math.floor(Date.now() / 1000);
  const workerGraceful = workerNow + 1800;
  const workerOuter = workerNow + 2700;
  let workerIssued;
  if (useNativeWslHarness) {
    const issueRun = wslExec([
      'node', `${harnessRoot}/scripts/manage_cloud_marketing_immediate_run.mjs`,
      'issue', '--date', date, '--queue', harnessQueueRuntimePath,
      '--root', harnessRoot, '--source-guard-file', harnessGuardRuntimePath,
      '--max-groups', '7', '--graceful-cutoff-epoch', String(workerGraceful),
      '--outer-hard-deadline-epoch', String(workerOuter),
      '--reason', 'real worker verifier env binding harness',
      '--confirm-token', IMMEDIATE_CONFIRMATION_TOKEN,
      '--authorization-file', workerHarnessAuthRuntimePath,
      '--now-epoch', String(workerNow), '--time-zone', 'Asia/Shanghai',
    ]);
    assert.equal(issueRun.error, undefined, `native WSL worker issue spawn failed: ${issueRun.error?.message || ''}`);
    assert.equal(issueRun.status, 0, `native WSL worker issue failed: ${issueRun.stderr || issueRun.stdout}`);
    workerIssued = JSON.parse(issueRun.stdout);
    wslChmod('600', workerHarnessAuthRuntimePath);
    wslCopy(workerHarnessAuthRuntimePath, workerHarnessAuth);
  } else {
    workerIssued = await issueImmediateAuthorization({
      authorizationFile: workerHarnessAuth,
      queueFile: harnessQueueFile,
      root: harnessRoot,
      sourceGuardFile: harnessGuardFile,
      date,
      maxGroups: 7,
      gracefulCutoffEpoch: workerGraceful,
      outerHardDeadlineEpoch: workerOuter,
      reason: 'real worker verifier env binding harness',
      confirmationToken: IMMEDIATE_CONFIRMATION_TOKEN,
      nowEpoch: workerNow,
      timeZone: 'Asia/Shanghai',
    });
  }
  wslChmod('700', path.dirname(workerHarnessAuth));
  wslChmod('600', workerHarnessAuth);
  await fsp.copyFile(path.join(root, 'scripts', 'lib', 'shared_lock.sh'), path.join(harnessStageRoot, 'scripts', 'lib', 'shared_lock.sh'));
  if (useNativeWslHarness) wslCopy(path.join(harnessStageRoot, 'scripts', 'lib', 'shared_lock.sh'), `${harnessRoot}/scripts/lib/shared_lock.sh`);
  const workerSource = await fsp.readFile(path.join(root, 'scripts', 'cloud_marketing_repair_worker.sh'), 'utf8');
  const workerStamp = 'STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"';
  assert.equal(workerSource.includes(workerStamp), true, 'worker harness injection anchor must remain unique');
  const workerHarnessSource = workerSource.replace(workerStamp,
    `if verify_immediate_authorization; then :; else status=$?; exit "$status"; fi\nexit 75\n${workerStamp}`);
  const workerHarnessPath = path.join(harnessStageRoot, 'scripts', 'worker-verifier-harness.sh');
  await fsp.writeFile(workerHarnessPath, workerHarnessSource, 'utf8');
  if (useNativeWslHarness) wslCopy(workerHarnessPath, `${harnessRoot}/scripts/worker-verifier-harness.sh`);
  const workerEnv = {
    ...harnessEnv,
    SHEIN_BI_MARKETING_IMMEDIATE_AUTHORIZATION_FILE: useNativeWslHarness
      ? workerHarnessAuthRuntimePath
      : shellPath(workerHarnessAuth),
    SHEIN_BI_MARKETING_IMMEDIATE_RUN: 'false',
    SHEIN_BI_MARKETING_REPAIR_DATE: date,
    SHEIN_BI_MARKETING_REPAIR_MAX_GROUPS: '7',
    SHEIN_BI_MARKETING_CLOUD_FALLBACK_ENABLED: 'true',
    SHEIN_BI_MARKETING_REPAIR_MIN_START_BUDGET_SEC: '900',
    SHEIN_BI_MARKETING_REPAIR_GRACEFUL_CUTOFF_EPOCH: String(workerGraceful),
    SHEIN_BI_MARKETING_REPAIR_SLOT_HARD_DEADLINE_EPOCH: String(workerOuter),
    SHEIN_BI_MARKETING_IMMEDIATE_AUTHORIZATION_ID: workerIssued.authorizationId,
    SHEIN_BI_MARKETING_IMMEDIATE_DATE: workerIssued.date,
    SHEIN_BI_MARKETING_IMMEDIATE_QUEUE_STATE_SHA256: workerIssued.queueStateSha256,
    SHEIN_BI_MARKETING_IMMEDIATE_QUEUE_FINGERPRINT: workerIssued.queueFingerprint,
    SHEIN_BI_MARKETING_IMMEDIATE_SOURCE_GUARD_HASH: workerIssued.sourceGuardHash,
    SHEIN_BI_MARKETING_IMMEDIATE_MAX_GROUPS: String(workerIssued.maxGroups),
    SHEIN_BI_MARKETING_IMMEDIATE_GRACEFUL_CUTOFF_EPOCH: String(workerIssued.gracefulCutoffEpoch),
    SHEIN_BI_MARKETING_IMMEDIATE_OUTER_HARD_DEADLINE_EPOCH: String(workerIssued.outerHardDeadlineEpoch),
    SHEIN_BI_MARKETING_IMMEDIATE_REASON: workerIssued.reason,
    SHEIN_BI_MARKETING_REPAIR_EXECUTION_LOCATION: 'local',
    SHEIN_BI_MARKETING_REPAIR_BUSY_SERVICES: '',
  };
  const workerRun = bashExec(
    `bash ${bashQuote(useNativeWslHarness ? `${harnessRoot}/scripts/worker-verifier-harness.sh` : shellPath(workerHarnessPath))}`,
    {environment: workerEnv},
  );
  assert.equal(workerRun.error, undefined, `worker verifier harness spawn failed: ${workerRun.error?.message || ''}`);
  assert.equal(workerRun.status, 75,
    `worker verifier must receive the expected metadata on the node side of the pipeline: ${workerRun.stderr || workerRun.stdout}`);
  if (useNativeWslHarness) wslCopy(workerHarnessAuthRuntimePath, workerHarnessAuth);
  assert.equal(await exists(workerHarnessAuth), true, 'worker verification must not consume the source');
  const workerReceiptNames = useNativeWslHarness
    ? wslFileNames(`${harnessRoot}/runtime/worker`).filter(name => name.startsWith('authorization.json.consumed.'))
    : (await fsp.readdir(path.dirname(workerHarnessAuth)))
      .filter(name => name.startsWith('authorization.json.consumed.'));
  assert.deepEqual(workerReceiptNames, [],
  'worker admission verifier must not create a consumed receipt');

  // A lease acquisition failure must leave the one-time authorization source
  // pending. The real worker verifier and queue capture run first; only the
  // lease action is forced to fail, while the consume hook records whether it
  // was reached.
  const leaseFailureMarker = path.join(harnessStageRoot, 'lease-failure-order.log');
  const leaseFailureMarkerRuntimePath = useNativeWslHarness
    ? `${harnessRoot}/state/lease-failure-order.log`
    : leaseFailureMarker;
  await fsp.rm(leaseFailureMarker, {force: true});
  if (useNativeWslHarness) {
    const removed = wslExec(['rm', '-f', '--', leaseFailureMarkerRuntimePath]);
    assert.equal(removed.error, undefined, `lease-failure marker reset spawn failed: ${removed.error?.message || ''}`);
    assert.equal(removed.status, 0, `lease-failure marker reset failed: ${removed.stderr || removed.stdout}`);
  }
  const leaseFailureOverrides = [
    'write_state() { :; }',
    'run_final_readback() { return 0; }',
    'send_daily_group_report() { return 0; }',
    'mark_queue_conflict() { :; }',
    'acquire_repair_critical_locks() {',
    '  REPAIR_ARTIFACT_REGISTRY_LOCKS_HELD=1',
    '  QUEUE_MUTATION_LOCK_HELD=1',
    '  STAGE_CRITICAL_SECTION_HELD=1',
    '  return 0',
    '}',
    'release_repair_critical_locks() {',
    '  REPAIR_ARTIFACT_REGISTRY_LOCKS_HELD=0',
    '  QUEUE_MUTATION_LOCK_HELD=0',
    '  STAGE_CRITICAL_SECTION_HELD=0',
    '  return 0',
    '}',
    'assert_current_queue_registry_locked() { return 0; }',
    'consume_immediate_authorization_locked() {',
    '  printf "consume\\n" >> "$SHEIN_TEST_LEASE_MARKER"',
    '  return 66',
    '}',
    'lease_action() {',
    '  if [[ "${1:-}" == "acquire" ]]; then',
    '    printf "lease\\n" >> "$SHEIN_TEST_LEASE_MARKER"',
    '    return 75',
    '  fi',
    '  return 0',
    '}',
  ].join('\n');
  const leaseFailureWorkerSource = workerSource.replace(workerStamp,
    `${leaseFailureOverrides}\n${workerStamp}`);
  const leaseFailureWorkerPath = path.join(harnessStageRoot, 'scripts', 'worker-lease-failure-harness.sh');
  await fsp.writeFile(leaseFailureWorkerPath, leaseFailureWorkerSource, 'utf8');
  if (useNativeWslHarness) wslCopy(leaseFailureWorkerPath, `${harnessRoot}/scripts/worker-lease-failure-harness.sh`);
  const leaseFailureEnv = {
    ...workerEnv,
    SHEIN_BI_MARKETING_REPAIR_LOG_DIR: useNativeWslHarness
      ? `${harnessRoot}/logs`
      : path.join(harnessStageRoot, 'logs'),
    SHEIN_TEST_LEASE_MARKER: leaseFailureMarkerRuntimePath,
  };
  const leaseFailureRun = useNativeWslHarness
    ? spawnSync('wsl.exe', [
      '--exec', 'env', ...wslEnvironmentArgs(leaseFailureEnv, ['SHEIN_TEST_LEASE_MARKER']),
      'bash', '-lc', `bash ${bashQuote(`${harnessRoot}/scripts/worker-lease-failure-harness.sh`)}`,
    ], {cwd: root, env: process.env, encoding: 'utf8', timeout: 120000})
    : spawnSync('bash', ['-c', `bash ${bashQuote(shellPath(leaseFailureWorkerPath))}`], {
      cwd: root,
      env: {...process.env, ...leaseFailureEnv},
      encoding: 'utf8',
      timeout: 120000,
    });
  if (useNativeWslHarness && wslExists(leaseFailureMarkerRuntimePath)) {
    wslCopy(leaseFailureMarkerRuntimePath, leaseFailureMarker);
  }
  assert.equal(leaseFailureRun.error, undefined, `lease-failure harness spawn failed: ${leaseFailureRun.error?.message || ''}`);
  assert.equal(leaseFailureRun.status, 75,
    `worker must defer when browser lease acquisition fails: ${leaseFailureRun.stderr || leaseFailureRun.stdout}`);
  assert.equal((await fsp.readFile(leaseFailureMarker, 'utf8')).trim(), 'lease',
    'lease failure must occur before the consume hook');
  if (useNativeWslHarness) wslCopy(workerHarnessAuthRuntimePath, workerHarnessAuth);
  assert.equal(await exists(workerHarnessAuth), true,
    'lease acquisition failure must leave the one-time authorization source pending');
  const leaseFailureReceipts = useNativeWslHarness
    ? wslFileNames(`${harnessRoot}/runtime/worker`).filter(name => name.startsWith('authorization.json.consumed.'))
    : (await fsp.readdir(path.dirname(workerHarnessAuth)))
      .filter(name => name.startsWith('authorization.json.consumed.'));
  assert.deepEqual(leaseFailureReceipts, [],
    'lease acquisition failure must not publish a consumed authorization receipt');

  // Unrelated service states no longer own admission. Keep the actual worker
  // entry and pending authorization verifier; every service state must reach
  // the real lease helper, whose controlled conflict still prevents consume.
  const busyProbeMarker = path.join(harnessStageRoot, 'busy-probe-order.log');
  const busyProbeMarkerRuntimePath = useNativeWslHarness
    ? `${harnessRoot}/state/busy-probe-order.log`
    : busyProbeMarker;
  const fakeSystemctl = path.join(harnessStageRoot, 'bin', 'systemctl');
  const fakeSystemctlRuntime = useNativeWslHarness ? `${harnessRoot}/bin/systemctl` : fakeSystemctl;
  await fsp.mkdir(path.dirname(fakeSystemctl), {recursive: true});
  await fsp.writeFile(fakeSystemctl, [
    '#!/usr/bin/env bash',
    'set -u',
    'mode="${SHEIN_TEST_SYSTEMCTL_MODE:-unknown}"',
    'case "${1:-}" in',
    '  is-active)',
    '    case "$mode" in',
    '      active) printf "active\\n"; exit 0 ;;',
    '      unknown) printf "unknown\\n"; exit 4 ;;',
    '      failed-zero-pid|failed-nonzero-pid|show-error) printf "failed\\n"; exit 3 ;;',
    '    esac',
    '    ;;',
    '  show)',
    '    case "$mode" in',
    '      failed-zero-pid)',
    '        printf "ActiveState=failed\\nSubState=failed\\nMainPID=0\\nControlPID=0\\n"',
    '        exit 0',
    '        ;;',
    '      failed-nonzero-pid)',
    '        printf "ActiveState=failed\\nSubState=failed\\nMainPID=321\\nControlPID=0\\n"',
    '        exit 0',
    '        ;;',
    '      show-error)',
    '        printf "show unavailable\\n" >&2',
    '        exit 1',
    '        ;;',
    '    esac',
    '    ;;',
    'esac',
    'printf "unexpected systemctl fixture call mode=%s command=%s\\n" "$mode" "${1:-missing}" >&2',
    'exit 125',
    '',
  ].join('\n'), 'utf8');
  if (useNativeWslHarness) {
    wslMkdir(`${harnessRoot}/bin`);
    wslCopy(fakeSystemctl, fakeSystemctlRuntime);
    wslChmod('755', fakeSystemctlRuntime);
  } else {
    await fsp.chmod(fakeSystemctl, 0o755);
  }
  const busyProbeOverrides = leaseFailureOverrides;
  const busyProbeWorkerSource = workerSource.replace(workerStamp,
    `${busyProbeOverrides}\n${workerStamp}`);
  const busyProbeWorkerPath = path.join(harnessStageRoot, 'scripts', 'worker-busy-probe-harness.sh');
  await fsp.writeFile(busyProbeWorkerPath, busyProbeWorkerSource, 'utf8');
  if (useNativeWslHarness) wslCopy(busyProbeWorkerPath, `${harnessRoot}/scripts/worker-busy-probe-harness.sh`);
  const busyProbeEnv = {
    ...workerEnv,
    SHEIN_BI_MARKETING_REPAIR_LOG_DIR: useNativeWslHarness ? `${harnessRoot}/logs` : path.join(harnessStageRoot, 'logs'),
    SHEIN_BI_MARKETING_REPAIR_BUSY_SERVICES: 'probe.service',
    SHEIN_TEST_LEASE_MARKER: busyProbeMarkerRuntimePath,
    SHEIN_TEST_SYSTEMCTL_MODE: 'unknown',
    PATH: useNativeWslHarness
      ? `${harnessRoot}/bin:/usr/bin:/bin`
      : `${path.dirname(fakeSystemctl)}${path.delimiter}${process.env.PATH || ''}`,
  };
  const resetBusyProbeMarker = async () => {
    await fsp.rm(busyProbeMarker, {force: true});
    if (useNativeWslHarness) {
      const removed = wslExec(['rm', '-f', '--', busyProbeMarkerRuntimePath]);
      assert.equal(removed.error, undefined, `busy-probe marker reset spawn failed: ${removed.error?.message || ''}`);
      assert.equal(removed.status, 0, `busy-probe marker reset failed: ${removed.stderr || removed.stdout}`);
    }
  };
  const runBusyProbe = mode => {
    const environment = {...busyProbeEnv, SHEIN_TEST_SYSTEMCTL_MODE: mode};
    return useNativeWslHarness
      ? spawnSync('wsl.exe', [
        '--exec', 'env', ...wslEnvironmentArgs(environment, [
          'PATH', 'SHEIN_TEST_LEASE_MARKER', 'SHEIN_TEST_SYSTEMCTL_MODE',
        ]),
        'bash', '-lc', `bash ${bashQuote(`${harnessRoot}/scripts/worker-busy-probe-harness.sh`)}`,
      ], {cwd: root, env: process.env, encoding: 'utf8', timeout: 120000})
      : spawnSync('bash', ['-c', `bash ${bashQuote(busyProbeWorkerPath)}`], {
        cwd: root,
        env: {...process.env, ...environment},
        encoding: 'utf8',
        timeout: 120000,
      });
  };
  const assertAuthorizationPending = async label => {
    if (useNativeWslHarness) wslCopy(workerHarnessAuthRuntimePath, workerHarnessAuth);
    assert.equal(await exists(workerHarnessAuth), true,
      `${label} must preserve the pending one-time authorization source`);
    const receipts = useNativeWslHarness
      ? wslFileNames(`${harnessRoot}/runtime/worker`).filter(name => name.startsWith('authorization.json.consumed.'))
      : (await fsp.readdir(path.dirname(workerHarnessAuth))).filter(name => name.startsWith('authorization.json.consumed.'));
    assert.deepEqual(receipts, [], `${label} must not publish a claimed or consumed receipt`);
  };
  for (const mode of ['active', 'unknown', 'failed-zero-pid', 'failed-nonzero-pid', 'show-error']) {
    await resetBusyProbeMarker();
    const result = runBusyProbe(mode);
    assert.equal(result.error, undefined, mode + ': ' + (result.error?.message || ''));
    assert.equal(result.status, 75,
      mode + ' unrelated service must reach the conflicting lease: ' + result.stderr + result.stdout);
    if (useNativeWslHarness) wslCopy(busyProbeMarkerRuntimePath, busyProbeMarker);
    assert.equal((await fsp.readFile(busyProbeMarker, 'utf8')).trim(), 'lease',
      mode + ' must reach lease and leave consume unreachable');
    await assertAuthorizationPending(mode + ' actual lease defer');
  }

  // Runtime deadline contract: once a transaction has started, crossing the
  // outer epoch cannot disable its finally/restore path, while a new write is
  // still rejected. This exercises the actual inventory transaction runner,
  // not a source-string assertion.
  let deadlineNow = 100;
  let usableInventory = 0;
  const deadlineContract = createDeadlineContract({
    gracefulCutoffEpoch: 150,
    outerHardDeadlineEpoch: 1050,
    nowEpoch: deadlineNow,
  });
  assert.doesNotThrow(() => assertCanStartUnit(deadlineContract, {nowEpoch: 1049, continuation: true}),
    'a persisted continuation remains admissible throughout graceful < now < outer');
  assert.throws(() => assertCanStartUnit(deadlineContract, {nowEpoch: 151, continuation: false}),
    /graceful cutoff/, 'new work must remain forbidden once graceful closes');
  const phases = [];
  const adapter = await deadlineBoundAdapterFactory(async () => ({
    async resolveTargets(targets) { return targets; },
    async acquireLock() { return async () => {}; },
    async readStock(target) {
      return {skuCode: target.skuCode, totalInventoryQuantity: usableInventory, totalUsableInventory: usableInventory,
        totalLockedQuantity: 0, temporaryInventoryQuantity: 0};
    },
    async writeStock(input) {
      phases.push(input.phase);
      usableInventory = input.desiredUsableInventory;
      return {ok: true};
    },
  }), deadlineContract, {nowEpoch: () => deadlineNow, label: 'deadline runtime harness'} )({});
  const transactionTarget = {
    storeKey: 'TEST',
    skc: 'TEST-SKC',
    skuCode: 'TEST-SKU',
    minimumUsableInventory: 1,
    minimumSource: 'dry_run',
    minimumEvidence: {harness: true},
    canonical: 'test::test-skc',
  };
  const transactionEvidence = await runActivityInventoryTransaction({
    targets: [transactionTarget],
    transactionHash: 'a'.repeat(64),
    acquireLock: adapter.acquireLock,
    readStock: adapter.readStock,
    writeStock: adapter.writeStock,
    submit: async () => {
      deadlineNow = 1051;
      return {ok: true};
    },
    readEnrollment: async () => ({ok: true}),
    now: () => new Date(deadlineNow * 1000),
    sleep: async () => {},
    maxWriteAttempts: 1,
    restoreWriteAttempts: 1,
    readbackAttempts: 1,
    readbackDelayMs: 0,
  });
  assert.equal(transactionEvidence.ok, true, 'started transaction must finish restore/readback after outer epoch');
  assert.deepEqual(phases, ['temporary_raise', 'restore'], 'transaction finally must perform restore after outer epoch');
  deadlineNow = 151;
  await assert.rejects(
    adapter.writeStock({
      target: transactionTarget,
      desiredUsableInventory: 2,
      overwriteQuantity: 2,
      phase: 'temporary_raise',
      writeAttempt: 1,
      idempotencyKey: 'new-write-without-finalization-budget',
    }),
    /without 900s for inventory restore and terminal readback/,
    'a new inventory write must reserve the full finalization budget before outer',
  );
  deadlineNow = 1051;
  await assert.rejects(
    adapter.writeStock({
      target: transactionTarget,
      desiredUsableInventory: 2,
      overwriteQuantity: 2,
      phase: 'temporary_raise',
      writeAttempt: 1,
      idempotencyKey: 'new-write-after-outer',
    }),
    /outer hard deadline/,
    'a new inventory write after outer must still fail closed',
  );

  // Runtime worker-loop regression: the one-item/group executor contract must
  // not turn manual/drift status=3 into an immediate service defer. The actual
  // worker shell loop is used; only the downstream executors and external
  // resource probes are replaced inside this temporary harness. Each executor
  // invocation returns one unique terminal unit, while the first invocation
  // returns status=3 with more work remaining. This proves one service can
  // consume multiple units without replaying the first one.
  const loopUseNativeWslHarness = process.platform === 'win32';
  const loopStageRoot = path.join(tempRoot, 'worker-loop-harness');
  const loopRoot = loopUseNativeWslHarness
    ? `/tmp/cloud-marketing-worker-loop-${process.pid}-${Date.now()}`
    : loopStageRoot;
  if (loopUseNativeWslHarness) nativeWslHarnessRoots.push(loopRoot);
  const loopStageStateDir = path.join(loopStageRoot, 'state', 'cloud_marketing_live_guard');
  const loopStageQueueFile = path.join(loopStageStateDir, 'repair-queues', `marketing-repair-${date}.json`);
  const loopStageLogFile = path.join(loopStageRoot, 'executor-calls.log');
  const loopStageDriftResult = path.join(loopStageRoot, 'tmp', 'marketing-signup', 'limited-discount-rescue', `batch-drift-fix-result-${date}.json`);
  const loopStageFallbackResult = path.join(loopStageRoot, 'outputs', 'reports', `new-listing-7d-limited-discount-execution-summary-${date}.json`);
  const loopStageHighResult = path.join(loopStageRoot, 'outputs', 'reports', `high-click-low-conversion-special-execution-${date}.json`);
  const loopStageWorker = path.join(loopStageRoot, 'scripts', 'worker-loop-harness.sh');
  const loopStageFakeNode = path.join(loopStageRoot, 'bin', 'node');
  await fsp.mkdir(path.dirname(loopStageQueueFile), {recursive: true});
  await fsp.mkdir(path.dirname(loopStageWorker), {recursive: true});
  await fsp.mkdir(path.join(loopStageRoot, 'scripts', 'lib'), {recursive: true});
  await fsp.mkdir(path.join(loopStageRoot, 'lib'), {recursive: true});
  await fsp.mkdir(path.dirname(loopStageFakeNode), {recursive: true});
  const loopGuardBytes = Buffer.from(JSON.stringify({date, fixture: 'isolated worker loop'}) + '\n');
  await fsp.writeFile(path.join(loopStageRoot, 'guard.json'), loopGuardBytes);
  await fsp.writeFile(path.join(loopStageRoot, 'plan.json'), JSON.stringify({date, items: []}) + '\n');
  for (const relative of ['scripts/resolve_cloud_runtime_artifact.mjs', 'lib/cloud_runtime_path_policy.mjs']) {
    await fsp.copyFile(path.join(root, relative), path.join(loopStageRoot, relative));
  }
  const loopQueue = {
    schemaVersion: 1,
    date,
    sourceGuard: 'guard.json',
    sourceGuardHash: sha256(loopGuardBytes),
    queueFingerprint: '1'.repeat(64),
    status: 'pending',
    stages: {
      highClickSpecial: {status: 'not_required', workFingerprint: 'h'.repeat(64)},
      manualSpecialRestore: {status: 'pending', planPath: 'plan.json', workFingerprint: 'm'.repeat(64)},
      driftRepair: {status: 'pending', workFingerprint: 'd'.repeat(64)},
      fallbackRepair: {status: 'completed', workFingerprint: 'f'.repeat(64)},
    },
  };
  await fsp.writeFile(loopStageQueueFile, `${JSON.stringify(loopQueue, null, 2)}\n`, 'utf8');
  await fsp.copyFile(path.join(root, 'scripts', 'lib', 'shared_lock.sh'), path.join(loopStageRoot, 'scripts', 'lib', 'shared_lock.sh'));
  const loopFakeNodeSource = [
    '#!/usr/bin/env bash',
    'set -Eeuo pipefail',
    'REAL_NODE="${REAL_NODE:-/usr/bin/node}"',
    'script="${1:-}"',
    'if [[ "$script" != "scripts/marketing/batch_apply_high_click_special_discounts.mjs" && "$script" != "scripts/marketing/batch_restore_manual_limited_discounts.mjs" && "$script" != "scripts/marketing/batch_fix_limited_discount_drift.mjs" && "$script" != "scripts/marketing/batch_apply_new_listing_limited_discount.mjs" ]]; then',
    '  exec "$REAL_NODE" "$@"',
    'fi',
    'if [[ "$script" == "scripts/marketing/batch_apply_high_click_special_discounts.mjs" ]]; then',
    '  kind=high',
    '  count_file="$SHEIN_TEST_HIGH_COUNT"',
    '  result_path=""',
    'elif [[ "$script" == "scripts/marketing/batch_restore_manual_limited_discounts.mjs" ]]; then',
    '  kind=manual',
    '  count_file="$SHEIN_TEST_MANUAL_COUNT"',
    '  result_path=""',
    'elif [[ "$script" == "scripts/marketing/batch_fix_limited_discount_drift.mjs" ]]; then',
    '  kind=drift',
    '  count_file="$SHEIN_TEST_DRIFT_COUNT"',
    '  result_path="$SHEIN_TEST_DRIFT_RESULT"',
    'else',
    '  kind=fallback',
    '  count_file="$SHEIN_TEST_FALLBACK_COUNT"',
    '  result_path="$SHEIN_TEST_FALLBACK_RESULT"',
    'fi',
    'executor_args="$*"',
    'expected_fingerprint=""',
    'shift',
    'while (( $# > 0 )); do',
    '  if [[ "$1" == "--result" && $# -ge 2 ]]; then result_path="$2"; shift 2;',
    '  elif [[ "$1" == "--expected-work-fingerprint" && $# -ge 2 ]]; then expected_fingerprint="$2"; shift 2;',
    '  else shift; fi',
    'done',
    'mkdir -p "$(dirname "$count_file")" "$(dirname "$SHEIN_TEST_EXECUTOR_LOG")"',
    'call=0',
    'if [[ -f "$count_file" ]]; then call="$(<"$count_file")"; fi',
    'call=$((call + 1))',
    'printf "%s" "$call" > "$count_file"',
    'printf "%s:%s:%s\\n" "$kind" "$call" "$executor_args" >> "$SHEIN_TEST_EXECUTOR_LOG"',
    'if [[ -z "$result_path" ]]; then echo "missing result path" >&2; exit 66; fi',
    'SHEIN_TEST_RESULT="$result_path" SHEIN_TEST_KIND="$kind" SHEIN_TEST_CALL="$call" SHEIN_TEST_EXPECTED_FINGERPRINT="$expected_fingerprint" "$REAL_NODE" <<\'NODE_RESULT\'',
    'const fs = req' + 'uire("node:fs");',
    'const kind = process.env.SHEIN_TEST_KIND;',
    'const call = Number(process.env.SHEIN_TEST_CALL);',
    'const mode = process.env.SHEIN_TEST_ACCOUNTING_MODE || "";',
    'const workFingerprint = process.env.SHEIN_TEST_EXPECTED_FINGERPRINT || "";',
    'const accounting = mode === "accounting" || mode === "zero";',
    'const processed = mode === "zero" ? 0 : 1;',
    'const deadlineDeferred = accounting ? 1 : 0;',
    'const remaining = accounting ? 1 : (call === 1 ? 1 : 0);',
    'const row = {storeKey: kind.toUpperCase(), rescuePath: kind + "-" + call, sourceRescuePath: kind + "-" + call, ok: true, terminalBlocked: false, recoverableDeferred: false, deferred: false};',
    'const rows = Array.from({length: call}, (_, index) => ({...row, rescuePath: kind + "-" + (index + 1), sourceRescuePath: kind + "-" + (index + 1)}));',
    'const processedRow = {...row, ok: accounting ? false : row.ok, deferred: accounting, recoverableDeferred: accounting};',
    'const groupRows = accounting ? (processed ? [processedRow] : []) : rows;',
    'let doc;',
    'if (mode === "settled_resume") {',
    '  if (kind === "high") {',
    '    const terminal = {...row, ok: false, terminal: true, classification: "submitted_without_exact_readback"};',
    '    doc = {workFingerprint, execute: true, results: [terminal], processedThisRunResults: [], totals: {planned: 1, processed: 1, processedThisRun: 0, resumedItems: 1, remainingItems: 0, recoverablePending: 0, blocked: 1, failed: 0}};',
    '  } else if (kind === "manual") {',
    '    doc = {workFingerprint, dryRunOnly: false, results: [row], processedThisRunResults: [], totals: {processed: 1, processedThisRun: 0, resumedItems: 1, remainingItems: 0, deadlineDeferred: 0, recoverableDeferred: 0, terminalBlocked: 0}};',
    '  } else if (kind === "drift") {',
    '    doc = {workFingerprint, dryRunOnly: false, complete: true, resumedGroups: 1, deferredGroups: 0, deadlineDeferred: 0, results: [{...row, ok: false, terminalBlocked: true}], totals: {groupsProcessed: 1, completedGroups: 0, businessBlockedGroups: 1, failedGroups: 0}};',
    '  } else {',
    '    doc = {workFingerprint, dryRunOnly: false, complete: true, resumedGroups: 1, deferredGroups: 0, deadlineDeferred: 0, results: [row], totals: {storesProcessed: 1, storesBlocked: 0, storesFailed: 0}};',
    '  }',
    '} else if (kind === "high") {',
    '  doc = {workFingerprint, execute: true, results: groupRows, processedThisRunResults: processed ? [processedRow] : [], totals: {planned: groupRows.length + remaining, processed: groupRows.length, processedThisRun: processed, resumedItems: accounting ? 0 : call - 1, remainingItems: remaining, recoverablePending: accounting ? 1 : 0, blocked: 0, failed: 0}};',
    '} else if (kind === "manual") {',
    '  doc = {workFingerprint, dryRunOnly: false, totals: {processed: groupRows.length, processedThisRun: processed, resumedItems: accounting ? 0 : call - 1, remainingItems: remaining, deadlineDeferred, recoverableDeferred: accounting ? 1 : 0, terminalBlocked: 0}, processedThisRunResults: processed ? [processedRow] : [], results: groupRows};',
    '} else if (kind === "drift") {',
    '  doc = {workFingerprint, dryRunOnly: false, complete: remaining === 0, resumedGroups: accounting ? 0 : call - 1, deferredGroups: remaining, deadlineDeferred, results: groupRows, totals: {groupsProcessed: groupRows.length, completedGroups: accounting ? 0 : groupRows.length, businessBlockedGroups: 0, failedGroups: 0}};',
    '} else {',
    '  doc = {workFingerprint, dryRunOnly: false, complete: remaining === 0, resumedGroups: accounting ? 0 : call - 1, deferredGroups: remaining, deadlineDeferred, results: groupRows, totals: {storesProcessed: groupRows.length, storesBlocked: 0, storesFailed: 0}};',
    '}',
    'fs.mkdirSync(req' + 'uire("node:path").dirname(process.env.SHEIN_TEST_RESULT), {recursive: true});',
    'fs.writeFileSync(process.env.SHEIN_TEST_RESULT, JSON.stringify(doc, null, 2) + "\\n");',
    'console.log(JSON.stringify(doc));',
    'NODE_RESULT',
    'if [[ "${SHEIN_TEST_ACCOUNTING_MODE:-}" == "accounting" || "${SHEIN_TEST_ACCOUNTING_MODE:-}" == "zero" ]]; then exit 4; fi',
    'if [[ "${SHEIN_TEST_ACCOUNTING_MODE:-}" == "settled_resume" ]]; then exit 0; fi',
    'if (( call == 1 )); then exit 3; fi',
    'if (( call == 2 )); then exit 0; fi',
    'exit 66',
  ].join('\n') + '\n';
  await fsp.writeFile(loopStageFakeNode, loopFakeNodeSource, 'utf8');
  if (process.platform !== 'win32') await fsp.chmod(loopStageFakeNode, 0o755);
  await fsp.copyFile(path.join(root, 'lib', 'atomic_file_publish.mjs'), path.join(loopStageRoot, 'lib', 'atomic_file_publish.mjs'));
  const workerSourceForLoop = await fsp.readFile(path.join(root, 'scripts', 'cloud_marketing_repair_worker.sh'), 'utf8');
  const loopWorkerStamp = 'STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"';
  assert.equal(workerSourceForLoop.includes(loopWorkerStamp), true, 'worker loop harness injection anchor must remain unique');
  const loopOverrides = [
    'ensure_browser_lease() { return 0; }',
    'consume_group_budget() {',
    '  local count="${1:-0}"',
    '  printf "budget:%s:%s\\n" "$count" "$REMAINING_GROUPS" >> "$SHEIN_TEST_EXECUTOR_LOG"',
    '  [[ "$count" =~ ^[0-9]+$ ]] || count=0',
    '  if (( count >= REMAINING_GROUPS )); then REMAINING_GROUPS=0; else REMAINING_GROUPS=$((REMAINING_GROUPS - count)); fi',
    '}',
    'run_final_readback() { return 0; }',
    'send_daily_group_report() { return 0; }',
    'acquire_repair_artifact_registry_locks() {',
    '  printf "lock:artifact\\n" >> "$SHEIN_TEST_EXECUTOR_LOG"',
    '  REPAIR_ARTIFACT_REGISTRY_LOCKS_HELD=1',
    '}',
    'release_repair_artifact_registry_locks() { REPAIR_ARTIFACT_REGISTRY_LOCKS_HELD=0; return 0; }',
    'acquire_repair_queue_mutation_lock() {',
    '  printf "lock:queue\\n" >> "$SHEIN_TEST_EXECUTOR_LOG"',
    '  QUEUE_MUTATION_LOCK_HELD=1',
    '  QUEUE_MUTATION_LOCK_TOKEN=test-token',
    '}',
    'release_repair_queue_mutation_lock() { QUEUE_MUTATION_LOCK_HELD=0; QUEUE_MUTATION_LOCK_TOKEN=""; return 0; }',
    'assert_current_queue_pair_locked() {',
    '  printf "cas:%s\\n" "${1:-stage}" >> "$SHEIN_TEST_EXECUTOR_LOG"',
    '  local snapshot fields=()',
    '  snapshot="$(queue_snapshot_value)" || return 66',
    '  mapfile -t fields <<<"$snapshot"',
    '  [[ "${#fields[@]}" -eq 3 ]] || return 66',
    '  [[ "${fields[0]}" == "$QUEUE_EXPECTED_STATE_SHA256" && "${fields[1]}" == "$QUEUE_EXPECTED_FINGERPRINT" && "${fields[2]}" == "$QUEUE_EXPECTED_SOURCE_GUARD_HASH" ]] || return 73',
    '}',
    'assert_current_queue_registry_locked() { printf "cas:registry\\n" >> "$SHEIN_TEST_EXECUTOR_LOG"; return 0; }',
    'assert_current_queue_state_locked() { printf "cas:state\\n" >> "$SHEIN_TEST_EXECUTOR_LOG"; return 0; }',
    'update_stage() {',
    '  local stage="$1" status="$2" readback_ok="$3" detail="$4" result_path="${5:-}"',
    '  STAGE_NAME="$stage" STAGE_STATUS="$status" STAGE_RESULT="$result_path" QUEUE_FILE="$QUEUE_FILE" "$REAL_NODE" - <<\'NODE_LOOP_STAGE\'',
    'const fs = req' + 'uire("node:fs");',
    'const file = process.env.QUEUE_FILE;',
    'const value = JSON.parse(fs.readFileSync(file, "utf8"));',
    'const stage = process.env.STAGE_NAME;',
    'if (!value.stages?.[stage]) process.exit(66);',
    'value.stages[stage].status = process.env.STAGE_STATUS;',
    'value.stages[stage].lastTestResult = process.env.STAGE_RESULT || "";',
    'fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\\n");',
    'NODE_LOOP_STAGE',
    '  refresh_queue_pair_locked || return 66',
    '  release_repair_critical_locks || return 75',
    '}',
  ].join('\n');
  const loopWorkerHarnessSource = workerSourceForLoop.replace(loopWorkerStamp,
    `${loopOverrides}\n${loopWorkerStamp}`);
  await fsp.writeFile(loopStageWorker, loopWorkerHarnessSource, 'utf8');
  const loopRuntimeStateDir = loopUseNativeWslHarness
    ? `${loopRoot}/state/cloud_marketing_live_guard`
    : loopStageStateDir;
  const loopRuntimeQueueFile = loopUseNativeWslHarness
    ? `${loopRoot}/state/cloud_marketing_live_guard/repair-queues/marketing-repair-${date}.json`
    : loopStageQueueFile;
  const loopRuntimeLogFile = loopUseNativeWslHarness
    ? `${loopRoot}/executor-calls.log`
    : loopStageLogFile;
  const loopRuntimeDriftResult = loopUseNativeWslHarness
    ? `${loopRoot}/tmp/marketing-signup/limited-discount-rescue/batch-drift-fix-result-${date}.json`
    : loopStageDriftResult;
  const loopRuntimeHighResult = loopUseNativeWslHarness
    ? `${loopRoot}/outputs/reports/high-click-low-conversion-special-execution-${date}.json`
    : loopStageHighResult;
  const loopRuntimeFallbackResult = loopUseNativeWslHarness
    ? `${loopRoot}/outputs/reports/new-listing-7d-limited-discount-execution-summary-${date}.json`
    : loopStageFallbackResult;
  if (loopUseNativeWslHarness) {
    wslMkdir(`${loopRoot}/scripts/lib`);
    wslMkdir(`${loopRoot}/state/locks`);
    wslMkdir(`${loopRoot}/state/cloud_marketing_live_guard/repair-queues`);
    wslMkdir(`${loopRoot}/bin`);
    wslMkdir(`${loopRoot}/lib`);
    wslMkdir(`${loopRoot}/registry`);
    wslCopy(loopStageQueueFile, loopRuntimeQueueFile);
    for (const relative of ['guard.json', 'plan.json', 'scripts/resolve_cloud_runtime_artifact.mjs', 'lib/cloud_runtime_path_policy.mjs']) {
      wslCopy(path.join(loopStageRoot, relative), loopRoot + '/' + relative);
    }
    wslCopy(path.join(loopStageRoot, 'scripts', 'lib', 'shared_lock.sh'), `${loopRoot}/scripts/lib/shared_lock.sh`);
    wslCopy(path.join(loopStageRoot, 'lib', 'atomic_file_publish.mjs'), `${loopRoot}/lib/atomic_file_publish.mjs`);
    wslCopy(loopStageFakeNode, `${loopRoot}/bin/node`);
    wslCopy(loopStageWorker, `${loopRoot}/scripts/worker-loop-harness.sh`);
    wslChmod('755', `${loopRoot}/bin/node`);
  }
  const loopNow = Math.floor(Date.now() / 1000);
  const loopEnv = {
    SHEIN_BI_ROOT: loopUseNativeWslHarness ? loopRoot : loopRoot,
    SHEIN_BI_TZ: 'Asia/Shanghai',
    SHEIN_BI_MARKETING_REPAIR_DATE: date,
    SHEIN_BI_MARKETING_LIVE_STATE_DIR: loopRuntimeStateDir,
    SHEIN_BI_MARKETING_REPAIR_MAX_GROUPS: '32',
    SHEIN_BI_MARKETING_REPAIR_EXECUTION_LOCATION: 'local',
    SHEIN_BI_MARKETING_CLOUD_FALLBACK_ENABLED: 'true',
    SHEIN_BI_MARKETING_REPAIR_MIN_START_BUDGET_SEC: '900',
    SHEIN_BI_MARKETING_REPAIR_GRACEFUL_CUTOFF_EPOCH: String(loopNow + 1800),
    SHEIN_BI_MARKETING_REPAIR_SLOT_HARD_DEADLINE_EPOCH: String(loopNow + 2700),
    SHEIN_BI_MARKETING_IMMEDIATE_RUN: 'false',
    SHEIN_BI_MARKETING_IMMEDIATE_AUTHORIZATION_FILE: loopUseNativeWslHarness
      ? `${loopRoot}/no-authorization.json`
      : path.join(loopRoot, 'no-authorization.json'),
    SHEIN_BI_MARKETING_REPAIR_LOCK_FILE: loopUseNativeWslHarness
      ? `${loopRoot}/state/locks/worker.lock`
      : path.join(loopRoot, 'state', 'locks', 'worker.lock'),
    SHEIN_BI_MARKETING_ARTIFACT_PUBLICATION_LOCK_FILE: loopUseNativeWslHarness
      ? `${loopRoot}/state/locks/artifact.lock`
      : path.join(loopRoot, 'state', 'locks', 'artifact.lock'),
    SHEIN_BI_MARKETING_ARTIFACT_PUBLICATION_LOCK_WAIT_SEC: '1',
    SHEIN_BI_MARKETING_PLAN_REGISTRY_FILE: loopUseNativeWslHarness
      ? `${loopRoot}/registry/current.json`
      : path.join(loopRoot, 'registry', 'current.json'),
    SHEIN_BI_MARKETING_PLAN_REGISTRY_ROOT: loopUseNativeWslHarness
      ? `${loopRoot}/registry`
      : path.join(loopRoot, 'registry'),
    SHEIN_BI_MARKETING_REPAIR_LOG_DIR: loopUseNativeWslHarness
      ? `${loopRoot}/logs`
      : path.join(loopRoot, 'logs'),
    SHEIN_BI_MARKETING_REPAIR_RESUME_RECEIPT: loopUseNativeWslHarness
      ? `${loopRoot}/resume.json`
      : path.join(loopRoot, 'resume.json'),
    SHEIN_BI_MARKETING_REPAIR_RUN_ID: 'worker-loop-regression',
    SHEIN_BI_MARKETING_REPAIR_BUSY_SERVICES: '',
    SHEIN_TEST_EXECUTOR_LOG: loopRuntimeLogFile,
    SHEIN_TEST_HIGH_COUNT: loopUseNativeWslHarness ? `${loopRoot}/high.count` : path.join(loopRoot, 'high.count'),
    SHEIN_TEST_MANUAL_COUNT: loopUseNativeWslHarness ? `${loopRoot}/manual.count` : path.join(loopRoot, 'manual.count'),
    SHEIN_TEST_DRIFT_COUNT: loopUseNativeWslHarness ? `${loopRoot}/drift.count` : path.join(loopRoot, 'drift.count'),
    SHEIN_TEST_DRIFT_RESULT: loopRuntimeDriftResult,
    SHEIN_TEST_FALLBACK_COUNT: loopUseNativeWslHarness ? `${loopRoot}/fallback.count` : path.join(loopRoot, 'fallback.count'),
    SHEIN_TEST_FALLBACK_RESULT: loopUseNativeWslHarness
      ? `${loopRoot}/outputs/reports/new-listing-7d-limited-discount-execution-summary-${date}.json`
      : loopStageFallbackResult,
    REAL_NODE: loopUseNativeWslHarness ? '/usr/bin/node' : process.execPath,
    PATH: loopUseNativeWslHarness
      ? `${loopRoot}/bin:/usr/bin:/bin`
      : `${path.join(loopRoot, 'bin')}${path.delimiter}${process.env.PATH || ''}`,
  };
  const loopWorkerCommand = loopUseNativeWslHarness
    ? `bash ${bashQuote(`${loopRoot}/scripts/worker-loop-harness.sh`)}`
    : `bash ${bashQuote(loopStageWorker)}`;
  const loopRun = loopUseNativeWslHarness
    ? spawnSync('wsl.exe', [
      '--exec', 'env', ...wslEnvironmentArgs(loopEnv, [
        'PATH', 'REAL_NODE', 'SHEIN_TEST_EXECUTOR_LOG', 'SHEIN_TEST_HIGH_COUNT', 'SHEIN_TEST_MANUAL_COUNT',
        'SHEIN_TEST_DRIFT_COUNT', 'SHEIN_TEST_DRIFT_RESULT', 'SHEIN_TEST_FALLBACK_COUNT',
        'SHEIN_TEST_FALLBACK_RESULT', 'SHEIN_TEST_ACCOUNTING_MODE',
      ]), 'bash', '-lc', loopWorkerCommand,
    ], {cwd: root, env: process.env, encoding: 'utf8', timeout: 120000})
    : spawnSync('bash', ['-c', loopWorkerCommand], {
      cwd: root,
      env: {...process.env, ...loopEnv},
      encoding: 'utf8',
      timeout: 120000,
    });
  if (loopUseNativeWslHarness) {
    if (wslExists(loopRuntimeLogFile)) wslCopy(loopRuntimeLogFile, loopStageLogFile);
    if (wslExists(loopRuntimeQueueFile)) wslCopy(loopRuntimeQueueFile, loopStageQueueFile);
  }
  const loopFailureEvidence = await (async () => {
    try { return await fsp.readFile(loopStageLogFile, 'utf8'); } catch { return ''; }
  })();
  const loopWorkerFailureEvidence = loopUseNativeWslHarness
    ? wslExec(['bash', '-lc', `find -- ${bashQuote(`${loopRoot}/logs`)} -maxdepth 1 -type f -print -exec tail -n 80 {} \\;`]).stdout
    : '';
  const loopQueueFailureEvidence = await (async () => {
    try { return await fsp.readFile(loopStageQueueFile, 'utf8'); } catch { return ''; }
  })();
  assert.equal(loopRun.error, undefined, `worker loop harness spawn failed: ${loopRun.error?.message || ''}`);
  assert.equal(loopRun.status, 0, `worker loop must continue after executor status=3: ${loopRun.stderr || loopRun.stdout}\nloop evidence=${loopFailureEvidence}\nworker log=${loopWorkerFailureEvidence}\nqueue=${loopQueueFailureEvidence}`);
  const loopLogLines = (await fsp.readFile(loopStageLogFile, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
  const loopExecutorCalls = loopLogLines.filter(line => /^(manual|drift):/.test(line));
  assert.deepEqual(loopExecutorCalls.map(line => line.split(':', 2).join(':')),
    ['manual:1', 'manual:2', 'drift:1', 'drift:2'],
    `same worker service must consume two manual and two drift units without replay: ${loopLogLines.join(' | ')}`);
  assert.equal(loopExecutorCalls.filter(line => line.startsWith('manual:')).every(line => (
    line.includes('--max-items 1')
    && line.includes(`--graceful-cutoff-epoch ${loopNow + 1800}`)
    && line.includes(`--outer-hard-deadline-epoch ${loopNow + 2700}`)
  )), true, 'manual loop must pass one-item and both deadline arguments on every invocation');
  assert.equal(loopExecutorCalls.filter(line => line.startsWith('drift:')).every(line => (
    line.includes('--max-groups 1')
    && line.includes(`--graceful-cutoff-epoch ${loopNow + 1800}`)
    && line.includes(`--outer-hard-deadline-epoch ${loopNow + 2700}`)
  )), true, 'drift loop must pass one-group and both deadline arguments on every invocation');
  assert.equal(loopLogLines.filter(line => line.startsWith('cas:')).length >= 4, true,
    `each serial unit must cross a fresh queue/CAS critical section: ${loopLogLines.join(' | ')}`);
  const loopQueueAfter = JSON.parse(await fsp.readFile(loopStageQueueFile, 'utf8'));
  assert.equal(loopQueueAfter.stages.manualSpecialRestore.status, 'completed');
  assert.equal(loopQueueAfter.stages.driftRepair.status, 'completed');

  // The deadline/recoverable paths must account a unit that already produced
  // durable progress before deciding to pause. Run all three remaining
  // runner kinds with one processed unit and a deadline result, then assert
  // that the worker consumed exactly three of its aggregate budget units.
  const resetLoopHarness = async queueDocument => {
    await fsp.writeFile(loopStageQueueFile, `${JSON.stringify(queueDocument, null, 2)}\n`, 'utf8');
    const stageFiles = [
      loopStageLogFile,
      path.join(loopStageRoot, 'high.count'),
      path.join(loopStageRoot, 'manual.count'),
      path.join(loopStageRoot, 'drift.count'),
      path.join(loopStageRoot, 'fallback.count'),
      loopStageDriftResult,
      loopStageFallbackResult,
      loopStageHighResult,
    ];
    await Promise.all(stageFiles.map(file => fsp.rm(file, {force: true})));
    if (loopUseNativeWslHarness) {
      wslCopy(loopStageQueueFile, loopRuntimeQueueFile);
      const runtimeFiles = [
        loopRuntimeLogFile,
        `${loopRoot}/high.count`,
        `${loopRoot}/manual.count`,
        `${loopRoot}/drift.count`,
        `${loopRoot}/fallback.count`,
        loopRuntimeDriftResult,
        loopRuntimeFallbackResult,
        loopRuntimeHighResult,
      ];
      for (const file of runtimeFiles) {
        const removed = wslExec(['rm', '-f', '--', file]);
        assert.equal(removed.error, undefined, `loop harness reset spawn failed for ${file}: ${removed.error?.message || ''}`);
        assert.equal(removed.status, 0, `loop harness reset failed for ${file}: ${removed.stderr || removed.stdout}`);
      }
    }
  };
  const runLoopHarness = environment => {
    const extraKeys = [
      'PATH', 'REAL_NODE', 'SHEIN_TEST_EXECUTOR_LOG', 'SHEIN_TEST_HIGH_COUNT', 'SHEIN_TEST_MANUAL_COUNT',
      'SHEIN_TEST_DRIFT_COUNT', 'SHEIN_TEST_DRIFT_RESULT', 'SHEIN_TEST_FALLBACK_COUNT',
      'SHEIN_TEST_FALLBACK_RESULT', 'SHEIN_TEST_ACCOUNTING_MODE',
    ];
    return loopUseNativeWslHarness
      ? spawnSync('wsl.exe', [
        '--exec', 'env', ...wslEnvironmentArgs(environment, extraKeys), 'bash', '-lc', loopWorkerCommand,
      ], {cwd: root, env: process.env, encoding: 'utf8', timeout: 120000})
      : spawnSync('bash', ['-c', loopWorkerCommand], {
        cwd: root,
        env: {...process.env, ...environment},
        encoding: 'utf8',
        timeout: 120000,
      });
  };
  const accountingQueue = {
    ...loopQueue,
    stages: {
      highClickSpecial: {status: 'not_required', workFingerprint: 'h'.repeat(64)},
      manualSpecialRestore: {status: 'pending', planPath: 'plan.json', workFingerprint: 'm'.repeat(64)},
      driftRepair: {status: 'pending', workFingerprint: 'd'.repeat(64)},
      fallbackRepair: {status: 'pending', workFingerprint: 'f'.repeat(64)},
    },
  };
  await resetLoopHarness(accountingQueue);
  const accountingRun = runLoopHarness({
    ...loopEnv,
    SHEIN_BI_MARKETING_REPAIR_MAX_GROUPS: '3',
    SHEIN_TEST_ACCOUNTING_MODE: 'accounting',
  });
  if (loopUseNativeWslHarness) {
    if (wslExists(loopRuntimeLogFile)) wslCopy(loopRuntimeLogFile, loopStageLogFile);
    if (wslExists(loopRuntimeQueueFile)) wslCopy(loopRuntimeQueueFile, loopStageQueueFile);
  }
  assert.equal(accountingRun.error, undefined, `accounting harness spawn failed: ${accountingRun.error?.message || ''}`);
  assert.equal(accountingRun.status, 0,
    `deadline/recoverable accounting harness must complete safely: ${accountingRun.stderr || accountingRun.stdout}`);
  const accountingLogLines = (await fsp.readFile(loopStageLogFile, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
  assert.deepEqual(accountingLogLines.filter(line => /^(manual|drift|fallback):/.test(line)).map(line => line.split(':', 2).join(':')),
    ['manual:1', 'drift:1', 'fallback:1'],
    `all three runner deadline/recoverable paths must process one unit: ${accountingLogLines.join(' | ')}`);
  assert.deepEqual(accountingLogLines.filter(line => line.startsWith('budget:')).map(line => line.split(':').slice(0, 2).join(':')),
    ['budget:1', 'budget:1', 'budget:1'],
    `each processed unit must consume one aggregate budget unit: ${accountingLogLines.join(' | ')}`);
  assert.deepEqual(accountingLogLines.filter(line => line.startsWith('budget:')).map(line => line.split(':')[2]),
    ['3', '2', '1'],
    `budget accounting must run before each deadline/recoverable pause: ${accountingLogLines.join(' | ')}`);
  const accountingQueueAfter = JSON.parse(await fsp.readFile(loopStageQueueFile, 'utf8'));
  assert.equal(accountingQueueAfter.stages.manualSpecialRestore.status, 'pending');
  assert.equal(accountingQueueAfter.stages.driftRepair.status, 'pending');
  assert.equal(accountingQueueAfter.stages.fallbackRepair.status, 'pending');

  // A deadline result with no processed unit must pause without invoking the
  // budget consumer. This is deliberately run with max=1 so an accidental
  // consume(0) is visible in the harness log rather than hidden by progress.
  await resetLoopHarness(accountingQueue);
  const zeroRun = runLoopHarness({
    ...loopEnv,
    SHEIN_BI_MARKETING_REPAIR_MAX_GROUPS: '1',
    SHEIN_TEST_ACCOUNTING_MODE: 'zero',
  });
  if (loopUseNativeWslHarness) {
    if (wslExists(loopRuntimeLogFile)) wslCopy(loopRuntimeLogFile, loopStageLogFile);
    if (wslExists(loopRuntimeQueueFile)) wslCopy(loopRuntimeQueueFile, loopStageQueueFile);
  }
  assert.equal(zeroRun.error, undefined, `zero-progress harness spawn failed: ${zeroRun.error?.message || ''}`);
  assert.equal(zeroRun.status, 0,
    `zero-progress deadline harness must complete safely: ${zeroRun.stderr || zeroRun.stdout}`);
  const zeroLogLines = (await fsp.readFile(loopStageLogFile, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
  assert.deepEqual(zeroLogLines.filter(line => /^(manual|drift|fallback):/.test(line)).map(line => line.split(':', 2).join(':')),
    ['manual:1', 'drift:1', 'fallback:1'],
    `zero-progress deadline paths must still be recorded as attempted once: ${zeroLogLines.join(' | ')}`);
  assert.deepEqual(zeroLogLines.filter(line => line.startsWith('budget:')), [],
    `processedThisRun=0 must not consume group budget: ${zeroLogLines.join(' | ')}`);

  // Simulate a crash after each executor has atomically published a settled
  // same-fingerprint result but before the queue stage update. A resumed
  // executor reports no new work; the worker must classify the persistent
  // evidence, update the queue once, and continue without replay or budget use.
  const settledResumeQueue = {
    ...loopQueue,
    stages: {
      highClickSpecial: {status: 'pending', planPath: 'plan.json', workFingerprint: 'h'.repeat(64)},
      manualSpecialRestore: {status: 'pending', planPath: 'plan.json', workFingerprint: 'm'.repeat(64)},
      driftRepair: {status: 'pending', workFingerprint: 'd'.repeat(64)},
      fallbackRepair: {status: 'pending', workFingerprint: 'f'.repeat(64)},
    },
  };
  await resetLoopHarness(settledResumeQueue);
  const settledResumeRun = runLoopHarness({
    ...loopEnv,
    SHEIN_BI_MARKETING_REPAIR_MAX_GROUPS: '4',
    SHEIN_TEST_ACCOUNTING_MODE: 'settled_resume',
  });
  if (loopUseNativeWslHarness) {
    if (wslExists(loopRuntimeLogFile)) wslCopy(loopRuntimeLogFile, loopStageLogFile);
    if (wslExists(loopRuntimeQueueFile)) wslCopy(loopRuntimeQueueFile, loopStageQueueFile);
  }
  assert.equal(settledResumeRun.error, undefined,
    `settled crash-resume harness spawn failed: ${settledResumeRun.error?.message || ''}`);
  assert.equal(settledResumeRun.status, 0,
    `same-fingerprint settled results must close queue stages without replay: ${settledResumeRun.stderr || settledResumeRun.stdout}`);
  const settledResumeLogLines = (await fsp.readFile(loopStageLogFile, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
  assert.deepEqual(
    settledResumeLogLines.filter(line => /^(high|manual|drift|fallback):/.test(line)).map(line => line.split(':', 2).join(':')),
    ['high:1', 'manual:1', 'drift:1', 'fallback:1'],
    `each settled stage must be inspected exactly once without replay: ${settledResumeLogLines.join(' | ')}`,
  );
  assert.deepEqual(settledResumeLogLines.filter(line => line.startsWith('budget:')), [],
    `resumed settled results with zero new work must not consume budget: ${settledResumeLogLines.join(' | ')}`);
  const settledResumeQueueAfter = JSON.parse(await fsp.readFile(loopStageQueueFile, 'utf8'));
  assert.equal(settledResumeQueueAfter.stages.highClickSpecial.status, 'blocked',
    'submitted_without_exact_readback must remain terminal and must not be replayed');
  assert.equal(settledResumeQueueAfter.stages.manualSpecialRestore.status, 'completed');
  assert.equal(settledResumeQueueAfter.stages.driftRepair.status, 'blocked');
  assert.equal(settledResumeQueueAfter.stages.fallbackRepair.status, 'completed');

  // A lease release failure happens after business work has already stopped.
  // It must change a nominal success into an explicit failure state without
  // invoking any executor again.
  const releaseFailureWorkerPath = path.join(loopStageRoot, 'scripts', 'worker-release-failure-harness.sh');
  const releaseFailureOverrides = loopOverrides
    .replace('ensure_browser_lease() { return 0; }', [
      'ensure_browser_lease() { LEASE_ACQUIRED=1; return 0; }',
      'cleanup_store_browsers() { return 0; }',
      'lease_action() {',
      '  if [[ "${1:-}" == "release" ]]; then',
      '    printf "lease-release-failed\\n" >> "$SHEIN_TEST_EXECUTOR_LOG"',
      '    return 75',
      '  fi',
      '  return 0',
      '}',
    ].join('\n'));
  const releaseFailureWorkerSource = workerSourceForLoop.replace(loopWorkerStamp,
    `${releaseFailureOverrides}\n${loopWorkerStamp}`);
  await fsp.writeFile(releaseFailureWorkerPath, releaseFailureWorkerSource, 'utf8');
  const releaseFailureRuntimePath = loopUseNativeWslHarness
    ? `${loopRoot}/scripts/worker-release-failure-harness.sh`
    : releaseFailureWorkerPath;
  if (loopUseNativeWslHarness) wslCopy(releaseFailureWorkerPath, releaseFailureRuntimePath);
  const noWorkQueue = {
    ...loopQueue,
    stages: {
      highClickSpecial: {status: 'not_required', workFingerprint: 'h'.repeat(64)},
      manualSpecialRestore: {status: 'not_required', workFingerprint: 'm'.repeat(64)},
      driftRepair: {status: 'not_required', workFingerprint: 'd'.repeat(64)},
      fallbackRepair: {status: 'not_required', workFingerprint: 'f'.repeat(64)},
    },
  };
  await resetLoopHarness(noWorkQueue);
  const releaseFailureCommand = `bash ${bashQuote(releaseFailureRuntimePath)}`;
  const releaseFailureRun = loopUseNativeWslHarness
    ? spawnSync('wsl.exe', [
      '--exec', 'env', ...wslEnvironmentArgs(loopEnv, [
        'PATH', 'REAL_NODE', 'SHEIN_TEST_EXECUTOR_LOG', 'SHEIN_TEST_HIGH_COUNT', 'SHEIN_TEST_MANUAL_COUNT',
        'SHEIN_TEST_DRIFT_COUNT', 'SHEIN_TEST_DRIFT_RESULT', 'SHEIN_TEST_FALLBACK_COUNT',
        'SHEIN_TEST_FALLBACK_RESULT', 'SHEIN_TEST_ACCOUNTING_MODE',
      ]), 'bash', '-lc', releaseFailureCommand,
    ], {cwd: root, env: process.env, encoding: 'utf8', timeout: 120000})
    : spawnSync('bash', ['-c', releaseFailureCommand], {
      cwd: root,
      env: {...process.env, ...loopEnv},
      encoding: 'utf8',
      timeout: 120000,
    });
  if (loopUseNativeWslHarness && wslExists(loopRuntimeLogFile)) wslCopy(loopRuntimeLogFile, loopStageLogFile);
  assert.equal(releaseFailureRun.error, undefined,
    `lease-release failure harness spawn failed: ${releaseFailureRun.error?.message || ''}`);
  assert.equal(releaseFailureRun.status, 75,
    `lease release failure must prevent nominal success: ${releaseFailureRun.stderr || releaseFailureRun.stdout}`);
  const releaseFailureLog = await fsp.readFile(loopStageLogFile, 'utf8');
  assert.match(releaseFailureLog, /lease-release-failed/);
  assert.match(`${releaseFailureRun.stderr}\n${releaseFailureRun.stdout}`, /browser lease release failed/,
    'lease release failure must emit an explicit terminal error');
  assert.doesNotMatch(releaseFailureLog, /^(?:high|manual|drift|fallback):/m,
    'lease release failure handling must not repeat business execution');

  const wrapper = await fsp.readFile(path.join(root, 'scripts', 'run_cloud_marketing_fallback_slot.sh'), 'utf8');
  assert.ok(wrapper.indexOf('--location "$STATE_DIR"') < wrapper.indexOf('verify-issued'),
    'formal wrapper must resolve the worker runtime state namespace before admission');
  const worker = await fsp.readFile(path.join(root, 'scripts', 'cloud_marketing_repair_worker.sh'), 'utf8');
  assert.equal(DEFAULT_IMMEDIATE_AUTHORIZATION_FILE, '/srv/shein-bi/marketing-repair-immediate/authorization.json');
  assert.match(wrapper, /\/srv\/shein-bi\/marketing-repair-immediate\/authorization\.json/,
    'wrapper default must stay below the root-owned /srv/shein-bi ancestor, outside the sheinops-owned runtime tree');
  const help = spawnSync(process.execPath, ['scripts/manage_cloud_marketing_immediate_run.mjs', 'help'], {
    cwd: root, encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  assert.equal(help.status, 0, help.stderr || help.stdout);
  assert.match(help.stdout, /default authorization file: \/srv\/shein-bi\/marketing-repair-immediate\/authorization\.json/);
  assert.match(help.stdout, /root creates \/srv\/shein-bi\/marketing-repair-immediate owned by sheinops:sheinops with mode 0700/);
  assert.match(wrapper, /EXPLICIT_IMMEDIATE_RUN="\$\{SHEIN_BI_MARKETING_IMMEDIATE_RUN:-\}"/,
    'wrapper must distinguish an explicit immediate-run override from an absent environment value');
  assert.match(wrapper, /-e "\$IMMEDIATE_AUTHORIZATION_FILE" \|\| -L "\$IMMEDIATE_AUTHORIZATION_FILE"/,
    'a pending fixed authorization artifact must automatically select immediate mode for a direct service start');
  assert.match(wrapper, /IMMEDIATE_RUN=true/,
    'authorization-file presence must enable immediate consume without systemctl environment injection');
  assert.match(wrapper, /IMMEDIATE_RUN=false/,
    'an explicit false override must retain a normal evening-path escape hatch');
  assert.match(wrapper, /outside 20:45-22:55 same-day fallback window; defer[\s\S]*exit 75/,
    'normal window rejection must remain present');
  assert.equal(wrapper.includes('manage_cloud_marketing_immediate_run.mjs" consume'), false,
    'wrapper must not consume the one-time authorization before host-heavy admission');
  assert.ok(wrapper.indexOf('verify-issued') < wrapper.indexOf('exec /usr/bin/env bash'),
    'wrapper must only verify and forward the pending source before invoking the worker');
  assert.ok(wrapper.indexOf('find-continuation') < wrapper.indexOf('exec /usr/bin/env bash'),
    'wrapper must discover source-unlinked immutable continuation before invoking the worker');
  assert.match(wrapper, /find-continuation[\s\S]*--scheduled-discovery/,
    'only the scheduled wrapper path may request stale continuation discovery');
  assert.match(wrapper, /stale===true[\s\S]*stale continuation ignored for scheduled run/,
    'scheduled stale continuation must be an explicit no-op before host-heavy admission');
  assert.match(wrapper, /SHEIN_BI_MARKETING_IMMEDIATE_CONTINUATION/);
  assert.match(wrapper, /SHEIN_BI_MARKETING_IMMEDIATE_RECEIPT_SHA256/);
  assert.match(wrapper, /IMMEDIATE_GRACEFUL_CUTOFF_EPOCH/);
  assert.match(wrapper, /IMMEDIATE_OUTER_HARD_DEADLINE_EPOCH/);
  assert.match(wrapper, /IMMEDIATE_OUTER_HARD_DEADLINE_EPOCH < IMMEDIATE_GRACEFUL_CUTOFF_EPOCH \+ MIN_START_BUDGET_SEC/,
    'wrapper must preserve at least 900 seconds between graceful and outer deadlines');
  assert.match(wrapper, /HOST_HARD_DEADLINE_EPOCH=\$\(\(OUTER_HARD_DEADLINE_EPOCH \+ HOST_FINALIZATION_RESERVE_SEC\)\)/,
    'host watchdog must leave the complete terminal snapshot finalization window after the executor outer deadline');
  assert.ok(worker.indexOf('if verify_immediate_authorization; then') < worker.indexOf('prepare_shared_lock_file "$LOCK_FILE"'),
    'worker must revalidate consumed authorization before opening its service lock');
  assert.ok((worker.match(/if verify_immediate_authorization; then/g) || []).length >= 2,
    'worker must repeat authorization validation after the service/artifact lock and before locked queue capture');
  const initialCriticalLock = worker.indexOf('if acquire_repair_critical_locks; then', worker.indexOf('if [[ ! -f "$QUEUE_FILE" ]]'));
  const secondAuthorizationCheck = worker.indexOf('if verify_immediate_authorization; then', initialCriticalLock);
  const initialQueueCapture = worker.indexOf('if refresh_queue_pair_locked && assert_current_queue_registry_locked; then', secondAuthorizationCheck);
  assert.ok(initialCriticalLock >= 0 && secondAuthorizationCheck > initialCriticalLock && initialQueueCapture > secondAuthorizationCheck,
    'the second exact authorization check and initial queue capture must run while the queue mutation lock is held');
  assert.ok(worker.indexOf('release_repair_critical_locks || true', initialQueueCapture) > initialQueueCapture,
    'the initial exact queue capture must release the complete critical lock set only after capture');
  assert.match(worker, /immediate authorization changed before locked queue capture/,
    'a queue identity race after the first validation must fail closed');
  assert.match(worker, /expected-graceful-cutoff-epoch/);
  assert.match(worker, /expected-outer-hard-deadline-epoch/);
  assert.match(worker, /verify-continuation/);
  assert.match(worker, /immutable continuation receipt already owns authorization; no reconsume/);
  assert.match(worker, /CONTINUATION_MODE=1/,
    'claimed/consumed authorization restart must force all parent executors into continuation-only mode');
  assert.match(worker, /FALLBACK_OUTER_HARD_DEADLINE_EPOCH - FALLBACK_GRACEFUL_CUTOFF_EPOCH < FALLBACK_MIN_START_BUDGET_SEC/,
    'worker must preserve at least 900 seconds between graceful and outer deadlines');
  assert.doesNotMatch(worker, /IMMEDIATE_OUTER_HARD_DEADLINE_EPOCH != IMMEDIATE_GRACEFUL_CUTOFF_EPOCH/,
    'immediate mode must not bind the graceful cutoff and hard deadline to the same epoch');
  const verifyIndex = worker.indexOf('if verify_immediate_authorization; then');
  const consumeIndex = worker.indexOf('if consume_immediate_authorization_locked; then');
  assert.doesNotMatch(worker, /ACTIVE_BUSY="\$\(active_busy_services\)"/);
  assert.doesNotMatch(worker, /CURRENT_MINUTE >= 23 && CURRENT_MINUTE <= 42/);
  const leaseIndex = worker.indexOf('\nensure_browser_lease\n');
  const firstExecutorIndex = worker.indexOf('node scripts/marketing/batch_apply_high_click_special_discounts.mjs');
  assert.ok(verifyIndex >= 0 && leaseIndex > verifyIndex && consumeIndex > leaseIndex && firstExecutorIndex > consumeIndex,
    'immediate authorization order must be verify < lease < consume < first executor');
  assert.ok(consumeIndex > initialQueueCapture,
    'authorization consume must remain after exact queue capture and lease admission');
  const consumeLockIndex = worker.lastIndexOf('if acquire_repair_critical_locks; then', consumeIndex);
  const consumeReleaseIndex = worker.indexOf('release_repair_critical_locks || true', consumeIndex);
  assert.ok(consumeLockIndex > leaseIndex && consumeReleaseIndex > consumeIndex,
    'authorization consume must run under the complete critical lock set and release it afterward');

  const fallbackStart = worker.indexOf('if (( IS_CLOUD_EXECUTION == 1 )) && [[ "$CLOUD_FALLBACK_ENABLED" == "true" ]]');
  const fallbackEnd = worker.indexOf('\n\nensure_browser_lease', fallbackStart);
  assert.ok(fallbackStart >= 0 && fallbackEnd > fallbackStart, 'cloud fallback branch must remain identifiable');
  const fallbackBlock = worker.slice(fallbackStart, fallbackEnd);
  const immediateBranchStart = fallbackBlock.indexOf('if [[ "$IMMEDIATE_MODE" == "1" ]]');
  const normalResumeBranch = fallbackBlock.indexOf('elif [[ -f "$RESUME_RECEIPT" ]]');
  assert.ok(immediateBranchStart >= 0 && normalResumeBranch > immediateBranchStart,
    'immediate exact-queue branch must precede the normal resume/readback branch');
  const immediateBranch = fallbackBlock.slice(immediateBranchStart, normalResumeBranch);
  assert.doesNotMatch(immediateBranch, /run_final_readback|rebuild_repair_queue/,
    'immediate mode must not rescan or rebuild the queue before execution');
  assert.match(immediateBranch, /exact queue identity/);
  assert.match(fallbackBlock, /run_final_readback/,
    'normal cloud fallback must retain its no-receipt final-readback path');

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'issue_requires_fixed_confirmation_token_and_reason_cannot_substitute',
      'issue_binds_date_queue_sha_queue_fingerprint_source_guard_hash_max_groups_deadline_reason',
      'issue_accepts_host_guard_namespace_and_rejects_different_guard_sha',
      'graceful_and_outer_deadlines_keep_a_900_second_finalization_margin',
      'consume_is_one_time_and_leaves_consumed_receipt',
      'sigkill_after_consume_restarts_at_2256_from_exact_receipt_only_without_reconsume',
      'historical_receipt_A_does_not_block_issue_verify_consume_inspect_of_B',
      'receipt_finalize_failure_leaves_irreversible_claimed_terminal_evidence',
      'authorization_owner_ancestor_symlink_and_directory_identity_fail_closed',
      'worker_revalidates_before_service_lock_and_consumes_after_lease_before_executor',
      'lease_failure_leaves_one_time_authorization_pending',
      'unrelated_service_states_reach_actual_lease_conflict_without_consuming_authorization',
      'lease_release_failure_changes_nominal_success_to_explicit_failure_without_replay',
      'worker_serial_manual_and_drift_loops_consume_multiple_units_without_replay',
      'processed_one_deadline_recoverable_units_consume_budget_for_manual_drift_fallback',
      'processed_zero_deadline_units_do_not_consume_budget',
      'four_stage_settled_result_crash_resume_updates_queue_without_replay',
      'submitted_without_exact_readback_is_terminal_and_not_replayed',
      'date_sha_fingerprint_source_guard_timeout_and_max_groups_fail_closed',
      'immediate_skips_rescan_and_queue_rebuild',
      'normal_clock_gate_and_no_receipt_readback_preserved',
    ],
  }, null, 2));
} finally {
  await fsp.rm(tempRoot, {recursive: true, force: true});
  for (const harnessRoot of nativeWslHarnessRoots) {
    let cleanup = wslExec(['rm', '-rf', '--', harnessRoot]);
    if ((cleanup.error || cleanup.status !== 0) && harnessRoot.startsWith('/var/lib/cloud-marketing-')) {
      cleanup = wslExec(['sudo', '-n', 'rm', '-rf', '--', harnessRoot]);
    }
    if (cleanup.error || cleanup.status !== 0) {
      process.stderr.write(`warning: native WSL harness cleanup failed root=${harnessRoot}: ${cleanup.stderr || cleanup.stdout || cleanup.error?.message || ''}\n`);
    }
  }
}
