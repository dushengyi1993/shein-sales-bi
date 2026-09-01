#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  RESTORE_CONFIRMATION,
  activeBrowserProcessesFromProc,
  checkRestoreCapacity,
  classifyRestorePublicationPaths,
  createEncryptedBrowserStateBackup as createEncryptedBrowserStateBackupImpl,
  parseArgs,
  readKeyFile,
  restoreRecordIdentity,
  restoreEncryptedBrowserStateBackup as restoreEncryptedBrowserStateBackupImpl,
  validateRecordIdentity,
  validateRestorePublicationParent,
  verifyEncryptedBrowserStateBackup as verifyEncryptedBrowserStateBackupImpl,
} from './manage_encrypted_browser_state_backup.mjs';

const implementation = await fs.readFile(new URL('./manage_encrypted_browser_state_backup.mjs', import.meta.url), 'utf8');
const renameHelperImplementation = await fs.readFile(
  new URL('./rename_restore_directory_noreplace_linux.py', import.meta.url),
  'utf8',
);
assert.match(implementation, /fs\.constants\.O_RDONLY \| \(fs\.constants\.O_NOFOLLOW \|\| 0\)/,
  'key/archive opens must request O_NOFOLLOW where the platform exposes it');
assert.match(implementation, /before\.nlink !== 1n/,
  'the Linux key contract must reject hard links');
assert.match(implementation, /before\.mode & 0o77n/,
  'the Linux key contract must deny group/world file access');
assert.match(implementation, /parentStat\.mode & 0o22n/,
  'the Linux key contract must reject a group/world-writable parent directory');
assert.match(implementation, /before\.uid !== BigInt\(expectedOwnerUid\)/,
  'the key contract must enforce the injected/production owner identity');
assert.match(implementation, /if \(process\.platform === 'win32'\) return undefined;\s*return 0;/,
  'the non-Windows production key owner must default to root even for a non-root caller');
assert.match(implementation, /before\.size === after\.size.*before\.ino === after\.ino.*before\.dev === after\.dev/,
  'the key result must bind to stable before/after fstat fields on one descriptor');
assert.doesNotMatch(implementation, /createReadStream\(entry\.absolute\)/,
  'create must never reopen an inventoried source by pathname');
assert.match(implementation, /fd: sourceHandle\.fd[\s\S]*autoClose: false/,
  'source bytes must stream from one explicitly managed O_NOFOLLOW descriptor');
assert.match(implementation, /before\.dev === snapshot\.dev[\s\S]*before\.ino === snapshot\.ino/,
  'source fstat comparisons must bind inventory dev and ino');
assert.match(implementation, /pathStat\.isSymbolicLink\(\)[\s\S]*sameEntrySnapshot\(entry, pathStat\)/,
  'the terminal source path binding must reject a final symlink or inode replacement');
assert.doesNotMatch(implementation, /fsp\.rename\(staging, resolved\)|\bmv\s+-n\b/,
  'restore publication must not retain an lstat-then-rename or mv -n fallback');
assert.match(implementation, /publishRestoreStagingNoReplace[\s\S]*renameat2\(RENAME_NOREPLACE\)/,
  'restore must route final publication through the Linux no-replace helper');
assert.match(renameHelperImplementation, /RENAME_NOREPLACE = 1/,
  'the Linux helper must select the kernel RENAME_NOREPLACE flag');
assert.match(renameHelperImplementation, /getattr\(libc, "renameat2", None\)/,
  'the Linux helper must call libc renameat2 directly');
assert.match(renameHelperImplementation, /value\.st_uid != os\.geteuid\(\)[\s\S]*st_mode\) & 0o022/,
  'the Linux helper must retain staging owner/mode checks across the syscall');
assert.match(renameHelperImplementation, /os\.fsync\(parent_fd\)/,
  'the Linux helper must fsync the bound destination parent where supported');
assert.doesNotMatch(implementation, /fsp\.rm\([^)]*recursive:\s*true/,
  'restore failure handling must never recursively delete a captured staging or destination path');
assert.doesNotMatch(implementation, /cleanupOwnedRestoreStaging/,
  'the recursive staging cleanup helper must no longer exist in restore failure handling');

const syntheticDirectoryStat = ({
  dev = 10n,
  ino = 20n,
  uid = 1000n,
  mode = 0o40700n,
  directory = true,
  symlink = false,
} = {}) => ({
  dev,
  ino,
  uid,
  mode,
  isDirectory: () => directory,
  isSymbolicLink: () => symlink,
});

assert.deepEqual(
  validateRestorePublicationParent(syntheticDirectoryStat(), {platform: 'linux', euid: 1000}),
  {dev: '10', ino: '20', uid: '1000', mode: 0o700},
  'a private parent owned by the current euid must pass pure validation',
);
assert.equal(
  validateRestorePublicationParent(syntheticDirectoryStat({uid: 0n}), {platform: 'linux', euid: 1000}).uid,
  '0',
  'a private root-owned parent must pass pure validation',
);
assert.throws(
  () => validateRestorePublicationParent(syntheticDirectoryStat({uid: 2000n}), {platform: 'linux', euid: 1000}),
  /owned by euid 1000 or root/,
  'a parent owned by another uid must fail closed',
);
assert.throws(
  () => validateRestorePublicationParent(syntheticDirectoryStat({mode: 0o40720n}), {platform: 'linux', euid: 1000}),
  /must not be group\/world writable/,
  'a group-writable parent must fail closed',
);
assert.throws(
  () => validateRestorePublicationParent(syntheticDirectoryStat({symlink: true}), {platform: 'linux', euid: 1000}),
  /non-symlink directory/,
  'a symlink parent must fail closed',
);
assert.throws(
  () => validateRestorePublicationParent(syntheticDirectoryStat(), {platform: 'win32', euid: 1000}),
  /supported only on Linux.*no ordinary rename fallback/,
  'a platform without the Linux primitive must fail closed',
);

const expectedStaging = {dev: '30', ino: '40'};
const ownedStagingStat = syntheticDirectoryStat({dev: 30n, ino: 40n});
const competitorStat = syntheticDirectoryStat({dev: 30n, ino: 41n});
assert.deepEqual(
  classifyRestorePublicationPaths({
    stagingStat: ownedStagingStat,
    destinationStat: competitorStat,
    expectedStaging,
  }),
  {
    ownedStaging: true,
    publishedDestination: false,
    stagingPathReplaced: false,
    competingDestination: true,
    manualInspectionRequired: false,
  },
  'a competing destination is classified as untouchable while the captured staging inode still provably names the owned staging path',
);
assert.equal(
  classifyRestorePublicationPaths({
    stagingStat: null,
    destinationStat: ownedStagingStat,
    expectedStaging,
  }).manualInspectionRequired,
  true,
  'a post-publication error must require manual inspection instead of deleting the destination',
);
assert.equal(
  classifyRestorePublicationPaths({
    stagingStat: competitorStat,
    destinationStat: null,
    expectedStaging,
  }).manualInspectionRequired,
  true,
  'a staging-path replacement must never be recursively cleaned as owned data',
);

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-bi-browser-backup-test-'));
process.env.SHEIN_BI_BACKUP_HOST_ID = 'unit-test-host';
const isLinux = process.platform === 'linux';
const isWindows = process.platform === 'win32';

try {
  const profileRoot = path.join(tempRoot, 'profiles-live');
  const sessionRoot = path.join(tempRoot, 'sessions-live');
  const profile = path.join(profileRoot, 'persistent-dl-profile');
  const profileDefault = path.join(profile, 'Default');
  await fs.mkdir(path.join(profileDefault, 'Network'), {recursive: true});
  await fs.mkdir(path.join(profileDefault, 'Cache'), {recursive: true});
  await fs.mkdir(sessionRoot, {recursive: true});
  await fs.writeFile(path.join(profile, 'Local State'), '{"profile":"DL"}\n');
  await fs.writeFile(path.join(profileDefault, 'Network', 'Cookies'), 'cookie-secret-that-must-be-encrypted');
  await fs.writeFile(path.join(profileDefault, 'Login Data'), 'saved-login-secret');
  await fs.writeFile(path.join(profileDefault, 'empty.db'), '');
  await fs.writeFile(path.join(profileDefault, 'Cache', 'cache.bin'), 'must-not-be-backed-up');
  await fs.writeFile(path.join(profile, 'SingletonLock'), 'runtime-lock');
  await fs.writeFile(path.join(sessionRoot, 'DL.local.json'), '{"cookie":"session-secret"}\n');

  const keyFile = path.join(tempRoot, 'backup.key');
  await fs.writeFile(keyFile, crypto.randomBytes(32), {mode: 0o600});
  if (process.platform !== 'win32') await fs.chmod(keyFile, 0o600);
  const fixtureKeyOwnerUid = (await fs.stat(keyFile)).uid;
  const withFixtureKeyOwner = options => ({
    ...options,
    diagnostics: {...(options.diagnostics || {}), expectedKeyOwnerUid: fixtureKeyOwnerUid},
  });
  const createEncryptedBrowserStateBackup = options =>
    createEncryptedBrowserStateBackupImpl(withFixtureKeyOwner(options));
  const verifyEncryptedBrowserStateBackup = options =>
    verifyEncryptedBrowserStateBackupImpl(withFixtureKeyOwner(options));
  const restoreEncryptedBrowserStateBackup = options =>
    restoreEncryptedBrowserStateBackupImpl(withFixtureKeyOwner(options));
  const archive = path.join(tempRoot, 'browser-state.sheinenc');
  const sources = [
    {logical: 'profiles', absolutePath: profileRoot, optional: false},
    {logical: 'state/shein_webapi_sessions', absolutePath: sessionRoot, optional: false},
    {logical: 'state/not-created', absolutePath: path.join(tempRoot, 'missing'), optional: true},
  ];

  const created = await createEncryptedBrowserStateBackup({keyFile, output: archive, sources});
  assert.equal(created.ok, true);
  assert.equal(created.action, 'create');
  assert.deepEqual(created.includedRoots, ['profiles', 'state/shein_webapi_sessions']);
  assert.deepEqual(created.skippedOptionalRoots, ['state/not-created']);
  assert.ok(created.fileCount >= 5);
  assert.match(created.archiveSha256, /^[0-9a-f]{64}$/);

  const ciphertext = await fs.readFile(archive);
  assert.equal(ciphertext.includes(Buffer.from('cookie-secret-that-must-be-encrypted')), false,
    'credential material must never appear in plaintext inside the archive');
  assert.equal(ciphertext.includes(Buffer.from('saved-login-secret')), false);

  const verified = await verifyEncryptedBrowserStateBackup({archive, keyFile});
  assert.equal(verified.ok, true);
  assert.equal(verified.action, 'verify');
  assert.equal(verified.manifestSha256, created.manifestSha256);
  assert.equal(verified.archiveSha256, created.archiveSha256);

  const assertFailedCreateClean = async output => {
    await assert.rejects(fs.lstat(output), error => error.code === 'ENOENT',
      'a source binding failure must not publish a final archive');
    assert.equal((await fs.readdir(path.dirname(output))).some(name => name.startsWith(`${path.basename(output)}.partial-`)), false,
      'a source binding failure must remove its controlled partial archive');
  };

  // ---- create source binding: inventory dev:ino -> one O_NOFOLLOW fd ->
  //      stable fd stats -> terminal non-symlink path binding.
  const replacedRoot = path.join(tempRoot, 'source-replaced-after-inventory');
  const replacedFile = path.join(replacedRoot, 'target.bin');
  const replacedOld = path.join(replacedRoot, 'target.old');
  await fs.mkdir(replacedRoot);
  await fs.writeFile(replacedFile, 'inventory-bytes');
  const replacedOutput = path.join(tempRoot, 'source-replaced.sheinenc');
  let replacedOnce = false;
  await assert.rejects(createEncryptedBrowserStateBackup({
    keyFile, output: replacedOutput,
    sources: [{logical: 'source-replaced', absolutePath: replacedRoot, optional: false}],
    diagnostics: { beforeSourceFileOpen: async ({entry}) => {
      if (replacedOnce || entry.logical !== 'source-replaced/target.bin') return;
      replacedOnce = true;
      await fs.rename(replacedFile, replacedOld);
      await fs.writeFile(replacedFile, 'different-path-inode-and-size');
    } },
  }), /no longer matches inventory before read/,
  'a pathname replaced after inventory must fail before any replacement bytes are read');
  assert.equal(replacedOnce, true);
  await assertFailedCreateClean(replacedOutput);

  const sameMetadataRoot = path.join(tempRoot, 'source-same-metadata-inode-drift');
  const sameMetadataFile = path.join(sameMetadataRoot, 'target.bin');
  const sameMetadataOld = path.join(sameMetadataRoot, 'target.old');
  const fixedMtime = new Date('2024-01-02T03:04:05.000Z');
  await fs.mkdir(sameMetadataRoot);
  await fs.writeFile(sameMetadataFile, 'AAAA');
  await fs.utimes(sameMetadataFile, fixedMtime, fixedMtime);
  const inventoriedMetadata = await fs.stat(sameMetadataFile);
  const sameMetadataOutput = path.join(tempRoot, 'source-same-metadata.sheinenc');
  await assert.rejects(createEncryptedBrowserStateBackup({
    keyFile, output: sameMetadataOutput,
    sources: [{logical: 'source-same-metadata', absolutePath: sameMetadataRoot, optional: false}],
    diagnostics: { beforeSourceFileOpen: async ({entry}) => {
      if (entry.logical !== 'source-same-metadata/target.bin') return;
      await fs.rename(sameMetadataFile, sameMetadataOld);
      await fs.writeFile(sameMetadataFile, 'BBBB');
      await fs.utimes(sameMetadataFile, fixedMtime, fixedMtime);
      const replacement = await fs.stat(sameMetadataFile);
      assert.equal(replacement.size, inventoriedMetadata.size, 'fixture replacement must retain the inventoried size');
      assert.equal(replacement.mtimeMs, inventoriedMetadata.mtimeMs, 'fixture replacement must retain the inventoried mtime');
    } },
  }), /no longer matches inventory before read/,
  'dev:ino drift must fail even when replacement size and mtime are identical');
  await assertFailedCreateClean(sameMetadataOutput);

  const finalSymlinkRoot = path.join(tempRoot, 'source-final-symlink');
  const finalSymlinkDir = path.join(finalSymlinkRoot, 'nested');
  const finalSymlinkOldDir = path.join(finalSymlinkRoot, 'nested-old');
  const finalSymlinkFile = path.join(finalSymlinkDir, 'target.bin');
  const finalSymlinkOld = path.join(finalSymlinkDir, 'target.old');
  await fs.mkdir(finalSymlinkDir, {recursive: true});
  await fs.writeFile(finalSymlinkFile, 'fd-bound-original');
  const finalSymlinkOutput = path.join(tempRoot, 'source-final-symlink.sheinenc');
  await assert.rejects(createEncryptedBrowserStateBackup({
    keyFile, output: finalSymlinkOutput,
    sources: [{logical: 'source-final-symlink', absolutePath: finalSymlinkRoot, optional: false}],
    diagnostics: { afterSourceFileRead: async ({entry}) => {
      if (entry.logical !== 'source-final-symlink/nested/target.bin') return;
      if (process.platform === 'win32') {
        // File symlinks require elevated Windows privileges.  A directory
        // junction is a real reparse-point symlink and deterministically
        // exercises the final inventory binding without a skip.
        await fs.rename(finalSymlinkDir, finalSymlinkOldDir);
        await fs.symlink(finalSymlinkOldDir, finalSymlinkDir, 'junction');
      } else {
        await fs.rename(finalSymlinkFile, finalSymlinkOld);
        await fs.symlink(finalSymlinkOld, finalSymlinkFile, 'file');
      }
    } },
  }), /Source path changed after read|Symlinks are forbidden/,
  'a final pathname changed to a symlink must fail after the bound fd read');
  await assertFailedCreateClean(finalSymlinkOutput);

  const postPublishFailureOutput = path.join(tempRoot, 'post-publish-failure.sheinenc');
  await assert.rejects(createEncryptedBrowserStateBackup({
    keyFile,
    output: postPublishFailureOutput,
    sources: [{logical: 'profiles', absolutePath: profileRoot, optional: false}],
    afterPublish: async () => { throw new Error('injected failure after publication link'); },
  }), /injected failure after publication link/);
  await assert.rejects(fs.lstat(postPublishFailureOutput), error => error.code === 'ENOENT',
    'a create failure after hard-link publication must remove the output it created');
  assert.equal((await fs.readdir(tempRoot)).some(name => name.startsWith('post-publish-failure.sheinenc.partial-')), false,
    'a create failure after hard-link publication must remove its partial file');

  assert.throws(() => validateRecordIdentity(0xffff_ffff, 'uid'), /uid is invalid/,
    'the POSIX chown no-change sentinel must not be accepted as an authenticated identity');
  const appliedIdentity = {uid: 1000, gid: 1000};
  await restoreRecordIdentity('identity-fixture', 2000, 3000, {
    platform: 'linux',
    lstat: async () => ({...appliedIdentity}),
    chown: async (_target, uid, gid) => { appliedIdentity.uid = uid; appliedIdentity.gid = gid; },
  });
  assert.deepEqual(appliedIdentity, {uid: 2000, gid: 3000});
  await assert.rejects(restoreRecordIdentity('identity-noop-fixture', 2000, 3000, {
    platform: 'linux',
    lstat: async () => ({uid: 1000, gid: 1000}),
    chown: async () => {},
  }), /identity readback mismatch/,
  'restore must not report success when chown returns without applying the authenticated identity');

  await assert.rejects(
    restoreEncryptedBrowserStateBackup({archive, keyFile, destination: path.join(tempRoot, 'restore-no-confirm'), confirmation: ''}),
    /Restore requires --confirm/,
  );

  const destination = path.join(tempRoot, 'restore-staging');
  if (isLinux) {
    const restored = await restoreEncryptedBrowserStateBackup({
      archive,
      keyFile,
      destination,
      confirmation: RESTORE_CONFIRMATION,
      sameHostIdentity: true,
    });
    assert.equal(restored.ok, true);
    assert.equal(restored.action, 'restore');
    assert.equal(restored.publicationMethod, 'renameat2(RENAME_NOREPLACE)',
      'Linux restore must report the real no-replace primitive');
    assert.equal(restored.parentFsync, 'ok',
      'a durable Linux restore must return only on an exact parent directory fsync ok');
    assert.equal(await fs.readFile(path.join(destination, 'profiles', 'persistent-dl-profile', 'Default', 'Network', 'Cookies'), 'utf8'),
      'cookie-secret-that-must-be-encrypted');
    assert.equal(await fs.readFile(path.join(destination, 'state', 'shein_webapi_sessions', 'DL.local.json'), 'utf8'),
      '{"cookie":"session-secret"}\n');
    const sourceCookieStat = await fs.stat(path.join(profileRoot, 'persistent-dl-profile', 'Default', 'Network', 'Cookies'));
    const restoredCookieStat = await fs.stat(path.join(destination, 'profiles', 'persistent-dl-profile', 'Default', 'Network', 'Cookies'));
    assert.equal(restoredCookieStat.uid, sourceCookieStat.uid, 'restore must preserve numeric file uid');
    assert.equal(restoredCookieStat.gid, sourceCookieStat.gid, 'restore must preserve numeric file gid');
    assert.equal(restoredCookieStat.mode & 0o777, sourceCookieStat.mode & 0o777, 'restore must preserve file mode');
    const sourceProfileStat = await fs.stat(profileRoot);
    const restoredProfileStat = await fs.stat(path.join(destination, 'profiles'));
    assert.equal(restoredProfileStat.uid, sourceProfileStat.uid, 'restore must preserve numeric directory uid');
    assert.equal(restoredProfileStat.gid, sourceProfileStat.gid, 'restore must preserve numeric directory gid');
    await assert.rejects(fs.stat(path.join(destination, 'profiles', 'persistent-dl-profile', 'Default', 'Cache')), /ENOENT/);
    await assert.rejects(fs.stat(path.join(destination, 'profiles', 'persistent-dl-profile', 'SingletonLock')), /ENOENT/);
  } else {
    await assert.rejects(restoreEncryptedBrowserStateBackup({
      archive,
      keyFile,
      destination,
      confirmation: RESTORE_CONFIRMATION,
      sameHostIdentity: true,
    }), /supported only on Linux.*no ordinary rename fallback/,
    'non-Linux restore publication must fail closed before staging');
    await assert.rejects(fs.lstat(destination), error => error.code === 'ENOENT',
      'non-Linux fail-closed publication must not create a destination');
    assert.equal((await fs.readdir(tempRoot)).some(name => name.startsWith('restore-staging.partial-')), false,
      'non-Linux fail-closed publication must not create staging');
    await fs.mkdir(destination);
  }

  await assert.rejects(
    restoreEncryptedBrowserStateBackup({archive, keyFile, destination, confirmation: RESTORE_CONFIRMATION, sameHostIdentity: true}),
    /must not already exist/,
  );
  if (!isLinux) await fs.rm(destination, {recursive: true});

  const wrongKeyFile = path.join(tempRoot, 'wrong.key');
  await fs.writeFile(wrongKeyFile, crypto.randomBytes(32), {mode: 0o600});
  if (process.platform !== 'win32') await fs.chmod(wrongKeyFile, 0o600);
  await assert.rejects(verifyEncryptedBrowserStateBackup({archive, keyFile: wrongKeyFile}), /does not match archive key id/);

  const tamperedArchive = path.join(tempRoot, 'browser-state-tampered.sheinenc');
  const tampered = Buffer.from(ciphertext);
  tampered[Math.floor(tampered.length / 2)] ^= 0x01;
  await fs.writeFile(tamperedArchive, tampered, {mode: 0o600});
  await assert.rejects(verifyEncryptedBrowserStateBackup({archive: tamperedArchive, keyFile}));
  const tamperedDestination = path.join(tempRoot, 'restore-tampered');
  await assert.rejects(restoreEncryptedBrowserStateBackup({
    archive: tamperedArchive,
    keyFile,
    destination: tamperedDestination,
    confirmation: RESTORE_CONFIRMATION,
    sameHostIdentity: true,
  }));
  await assert.rejects(fs.stat(tamperedDestination), /ENOENT/,
    'an unauthenticated archive must not create even a restore staging directory');

  if (process.platform !== 'win32') {
    await fs.chmod(keyFile, 0o644);
    await assert.rejects(verifyEncryptedBrowserStateBackup({archive, keyFile}), /deny group\/world access/);
    await fs.chmod(keyFile, 0o600);
  }

 await assert.rejects(createEncryptedBrowserStateBackup({keyFile, output: archive, sources}), /EEXIST|exist/i,
   'create must never overwrite an existing encrypted backup');

  // ---- Chrome process detection: google-chrome/google-chrome-stable launched
  // through the app bind must be recognized as using the canonical host source.
  const procRoot = path.join(tempRoot, 'proc-fixture');
  const canonicalProfiles = path.join(tempRoot, 'data', 'shein-bi', 'profiles');
  const appProfiles = path.join(tempRoot, 'opt', 'shein-bi', 'app', 'profiles');
  const unrelatedChromeRoot = path.join(tempRoot, 'elsewhere', 'udd');
  await fs.mkdir(path.join(canonicalProfiles, 'persistent-dl-profile'), {recursive: true});
  await fs.mkdir(unrelatedChromeRoot, {recursive: true});
  await fs.mkdir(path.dirname(appProfiles), {recursive: true});
  await fs.symlink(canonicalProfiles, appProfiles, process.platform === 'win32' ? 'junction' : 'dir');
  const writeCmdline = async (pid, argv) => {
    await fs.mkdir(path.join(procRoot, String(pid)), {recursive: true});
    await fs.writeFile(path.join(procRoot, String(pid), 'cmdline'), Buffer.from(argv.join('\0')));
  };
  await writeCmdline(1001, ['/usr/bin/google-chrome', '--user-data-dir=' + path.join(appProfiles, 'persistent-dl-profile'), '--no-sandbox']);
  await writeCmdline(1002, ['/usr/bin/google-chrome-stable', '--user-data-dir=' + path.join(appProfiles, 'persistent-dl-profile')]);
  await writeCmdline(1003, ['/usr/bin/google-chrome', '--user-data-dir=' + unrelatedChromeRoot]);
  await writeCmdline(1004, ['/usr/bin/python3', '--user-data-dir=' + canonicalProfiles]);
  await writeCmdline(1005, ['/usr/bin/google-chrome', '--user-data-dir=' + path.join(canonicalProfiles, 'persistent-dl-profile')]);
  await writeCmdline(1006, ['/usr/bin/google-chrome']);
  await writeCmdline(1007, []);
  await writeCmdline(1008, ['/usr/bin/google-chrome', '--user-data-dir=' + tempRoot]);
  const detected = await activeBrowserProcessesFromProc(procRoot, [canonicalProfiles]);
  assert.deepEqual(detected.map(row => row.pid).sort((a, b) => a - b), [1001, 1002, 1005, 1008],
    'google-chrome/google-chrome-stable inside the source tree (app bind or canonical) must be detected; '
    + 'unrelated Chrome and non-Chrome processes must not be treated as conflicts');
  await assert.rejects(activeBrowserProcessesFromProc(path.join(tempRoot, 'no-such-proc'), [canonicalProfiles]),
    /cannot audit/, 'an unreadable /proc must fail closed instead of silently allowing a backup');

  // ---- CLI limits are configurable with parsed suffixes -
  const cliArgs = parseArgs(['verify', '--key-file', 'k', '--archive', 'a', '--limit-entries', '5', '--limit-total-bytes', '1g']);
  assert.equal(cliArgs.limits.maxEntries, 5);
  assert.equal(cliArgs.limits.maxTotalBytes, 1024 ** 3);
  const createCliArgs = parseArgs(['create', '--key-file', 'k', '--output', 'a', '--source', 'profiles=p', '--limit-total-bytes', '8g']);
  assert.equal(createCliArgs.limits.maxTotalBytes, 8 * 1024 ** 3, 'create CLI must parse the explicit production total-byte bound');

  // ---- Resource limits during verify/restore -
  const sourceForLimits = async (name, files, fill) => {
    const root = path.join(tempRoot, 'limit-' + name);
    for (const [rel, bytes] of Object.entries(files)) {
      const full = path.join(root, rel);
      await fs.mkdir(path.dirname(full), {recursive: true});
      await fs.writeFile(full, Buffer.alloc(bytes, fill));
    }
    return root;
  };
  const manyRoot = await sourceForLimits('entries', Object.fromEntries(
    Array.from({length: 8}, (_, index) => ['f' + index + '.bin', 8]),
  ), 0x41);
  const manyOutput = path.join(tempRoot, 'limit-entries.sheinenc');
  const manySummary = await createEncryptedBrowserStateBackup({
    keyFile, output: manyOutput,
    sources: [{logical: 'many', absolutePath: manyRoot, optional: false}],
  });
  assert.ok(manySummary.entryCount >= 9, 'entry limit fixture must exercise a real archive');
  const createEntryLimitOutput = path.join(tempRoot, 'create-limit-entries.sheinenc');
  await assert.rejects(createEncryptedBrowserStateBackup({
    keyFile, output: createEntryLimitOutput,
    sources: [{logical: 'many', absolutePath: manyRoot, optional: false}],
    limits: {maxEntries: 4},
  }), /entry limit/i, 'create must reject an over-limit source before writing an archive');
  await assert.rejects(fs.stat(createEntryLimitOutput), /ENOENT/,
    'create entry-limit rejection must not publish an archive');
  await assert.rejects(verifyEncryptedBrowserStateBackup({archive: manyOutput, keyFile, limits: {maxEntries: 4}}),
    /too many entries|entry limit/i, 'verify must reject an archive with more records than the entry limit');
  const entryRestoreDestination = path.join(tempRoot, 'restore-limit-entries');
  await assert.rejects(restoreEncryptedBrowserStateBackup({
    archive: manyOutput, keyFile, destination: entryRestoreDestination, confirmation: RESTORE_CONFIRMATION,
    sameHostIdentity: true,
    limits: {maxEntries: 4},
  }), /too many entries|entry limit/i, 'restore must reject an over-limit archive during its verify pass');
  await assert.rejects(fs.stat(entryRestoreDestination), /ENOENT/,
    'an entry-limit violation must be caught before any staging directory is created');

  const bigFileRoot = await sourceForLimits('total', {'big.bin': 200000}, 0x41);
  const totalOutput = path.join(tempRoot, 'limit-total.sheinenc');
  const createTotalLimitOutput = path.join(tempRoot, 'create-limit-total.sheinenc');
  await assert.rejects(createEncryptedBrowserStateBackup({
    keyFile, output: createTotalLimitOutput,
    sources: [{logical: 'big', absolutePath: bigFileRoot, optional: false}],
    limits: {maxTotalBytes: 100000},
  }), /total byte limit/i, 'create must enforce the explicit total-byte bound before encryption');
  await assert.rejects(fs.stat(createTotalLimitOutput), /ENOENT/,
    'create total-byte rejection must not publish an archive');
  await createEncryptedBrowserStateBackup({
    keyFile, output: totalOutput,
    sources: [{logical: 'big', absolutePath: bigFileRoot, optional: false}],
  });
  await assert.rejects(verifyEncryptedBrowserStateBackup({archive: totalOutput, keyFile, limits: {maxTotalBytes: 100000}}),
    /total byte/i, 'verify must reject an archive that exceeds the total plaintext limit');
  await assert.rejects(verifyEncryptedBrowserStateBackup({archive: totalOutput, keyFile, limits: {maxFileBytes: 1000}}),
    /file exceeds the size limit/, 'verify must reject a single oversized file');

  const compressibleRoot = await sourceForLimits('ratio', {'leveldb-like.bin': 200000}, 0x41);
  const ratioOutput = path.join(tempRoot, 'limit-ratio.sheinenc');
  const createRatioLimitOutput = path.join(tempRoot, 'create-limit-ratio.sheinenc');
  await assert.rejects(createEncryptedBrowserStateBackup({
    keyFile, output: createRatioLimitOutput,
    sources: [{logical: 'ratio', absolutePath: compressibleRoot, optional: false}],
    limits: {maxCompressionRatio: 2},
  }), /compression ratio limit/i, 'create must reject an unsafe compression ratio before publishing the archive');
  await assert.rejects(fs.stat(createRatioLimitOutput), /ENOENT/,
    'create compression-ratio rejection must not publish an archive');
  await createEncryptedBrowserStateBackup({
    keyFile, output: ratioOutput,
    sources: [{logical: 'ratio', absolutePath: compressibleRoot, optional: false}],
  });
  const ratioVerified = await verifyEncryptedBrowserStateBackup({archive: ratioOutput, keyFile});
  assert.equal(ratioVerified.ok, true, 'default limits must accept a highly compressible but legitimate profile payload');
  await assert.rejects(verifyEncryptedBrowserStateBackup({archive: ratioOutput, keyFile, limits: {maxCompressionRatio: 2}}),
    /compression ratio/i, 'verify must reject an archive whose declared compression ratio exceeds the limit');

  const diskDestination = path.join(tempRoot, 'restore-disk');
  const diskStatfs = await fs.statfs(path.dirname(diskDestination));
  const freeBytes = Number(diskStatfs.bavail) * Number(diskStatfs.bsize);
  await assert.rejects(restoreEncryptedBrowserStateBackup({
    archive, keyFile, destination: diskDestination, confirmation: RESTORE_CONFIRMATION,
    sameHostIdentity: true,
    limits: {freeMarginBytes: freeBytes + 1024},
  }), /Insufficient free space/, 'restore must refuse to write when free space is below declared size plus margin');
  await assert.rejects(fs.stat(diskDestination), /ENOENT/,
    'the disk preflight must run before the staging directory is created');

  // ---- Mandatory session root: a missing mandatory source must fail closed ----
  const missingSessionArchive = path.join(tempRoot, 'missing-session.sheinenc');
  await assert.rejects(createEncryptedBrowserStateBackup({
    keyFile, output: missingSessionArchive,
    sources: [
      {logical: 'profiles', absolutePath: profileRoot, optional: false},
      {logical: 'state/shein_webapi_sessions', absolutePath: path.join(tempRoot, 'no-session-root'), optional: false},
    ],
  }), /ENOENT|real directory|No backup source/, 'a missing mandatory root must fail the whole create');
  await assert.rejects(fs.stat(missingSessionArchive), /ENOENT/,
    'a missing mandatory root must not publish an archive');

  // ---- Key file single-FD hardening ----
  await assert.rejects(readKeyFile(keyFile, {expectedOwnerUid: fixtureKeyOwnerUid + 1}), /must be owned by uid/,
    'a key owned by the wrong injected uid must be rejected on every test platform');
  assert.equal((await readKeyFile(keyFile, {expectedOwnerUid: fixtureKeyOwnerUid})).length, 32,
    'the expected injected owner must pass through the single-FD read');
  if (!isWindows) {
    const hardLinkKey = path.join(tempRoot, 'key.hardlink');
    await fs.link(keyFile, hardLinkKey);
    await assert.rejects(readKeyFile(hardLinkKey), /must not be a hard link/,
      'a hard-linked key must be rejected');
    await fs.unlink(hardLinkKey);
    const looseParent = path.join(tempRoot, 'loose-parent');
    await fs.mkdir(looseParent, {mode: 0o777});
    await fs.chmod(looseParent, 0o777);
    const looseKey = path.join(looseParent, 'k');
    await fs.writeFile(looseKey, crypto.randomBytes(32), {mode: 0o600});
    await assert.rejects(readKeyFile(looseKey), /parent directory must not be group\/world writable/,
      'a key in a group/world-writable parent must be rejected');
    const linkKey = path.join(tempRoot, 'key.symlink');
    await fs.symlink(keyFile, linkKey);
    await assert.rejects(readKeyFile(linkKey), /regular|Following links|opened safely/,
      'a symlinked key must be rejected via O_NOFOLLOW');
  } else {
    console.log('  [skip] dynamic nlink/parent/symlink key checks: require non-Windows semantics (static contracts passed)');
  }
  // Replacement and truncation mid-read (any platform).
  const swapKey = path.join(tempRoot, 'swap.key');
  const swappedAway = path.join(tempRoot, 'swap.away');
  await fs.writeFile(swapKey, crypto.randomBytes(32), {mode: 0o600});
  await assert.rejects(readKeyFile(swapKey, {
    expectedOwnerUid: fixtureKeyOwnerUid,
    beforeRead: async () => {
      await fs.rename(swapKey, swappedAway);
      await fs.writeFile(swapKey, Buffer.from('s'.repeat(32)), {mode: 0o600});
    },
  }), /path was replaced while it was being read/, 'an atomic key-path replacement mid-read must fail');
  const truncKey = path.join(tempRoot, 'trunc.key');
  await fs.writeFile(truncKey, crypto.randomBytes(32), {mode: 0o600});
  await assert.rejects(readKeyFile(truncKey, {
    expectedOwnerUid: fixtureKeyOwnerUid,
    beforeRead: async () => {
      const h = await fs.open(truncKey, 'r+');
      await h.truncate(0);
      await h.close();
    },
  }), /changed while it was being read|valid size/, 'a truncation mid-read must be detected');

  // ---- verify: path atomic replacement during verification must fail ----
  const swapArchive = path.join(tempRoot, 'verify-swap.sheinenc');
  const swapOriginal = path.join(tempRoot, 'verify-swap-original.sheinenc');
  await createEncryptedBrowserStateBackup({keyFile, output: swapArchive, sources: [{logical: 'profiles', absolutePath: profileRoot, optional: false}]});
  await assert.rejects(verifyEncryptedBrowserStateBackup({
    archive: swapArchive, keyFile,
    diagnostics: { afterAuthCheck: async () => {
      await fs.rename(swapArchive, swapOriginal);
      await createEncryptedBrowserStateBackup({keyFile, output: swapArchive, sources: [{logical: 'profiles', absolutePath: profileRoot, optional: false}]});
    } },
  }), /Archive (?:path was replaced during verification|changed while it was being verified)/,
  'an atomic path swap during verification must fail closed');
  await fs.rename(swapOriginal, swapArchive);

  // ---- Restore identity: explicit mapping, same-host proof, unmapped fail-closed ----
  await assert.rejects(restoreEncryptedBrowserStateBackup({
    archive, keyFile, destination: path.join(tempRoot, 'restore-no-identity'), confirmation: RESTORE_CONFIRMATION,
  }), /Restore requires --identity-map or --same-host-identity/,
    'restore must refuse bare archive uid/gid without an explicit identity policy');
  const verifiedPairs = await verifyEncryptedBrowserStateBackup({archive, keyFile});
  const allPairs = verifiedPairs.identityPairs;
  assert.ok(allPairs.length > 0, 'the fixture archive must contain identity pairs');
  const explicitMap = allPairs.map(pair => {
    const [u, g] = pair.split(':').map(Number);
    return {source: pair, target: [u, g]};
  });
  const mappedDest = path.join(tempRoot, 'restore-mapped');
  if (isLinux) {
    await restoreEncryptedBrowserStateBackup({
      archive, keyFile, destination: mappedDest, confirmation: RESTORE_CONFIRMATION, identityMaps: explicitMap,
    });
    assert.equal(await fs.readFile(path.join(mappedDest, 'profiles', 'persistent-dl-profile', 'Default', 'Network', 'Cookies'), 'utf8'),
      'cookie-secret-that-must-be-encrypted', 'an explicit identity map must restore content');
    await fs.rm(mappedDest, {recursive: true, force: true});
  } else {
    await assert.rejects(restoreEncryptedBrowserStateBackup({
      archive, keyFile, destination: mappedDest, confirmation: RESTORE_CONFIRMATION, identityMaps: explicitMap,
    }), /supported only on Linux.*no ordinary rename fallback/,
    'explicit identity mapping must not bypass non-Linux publication fail-closed behavior');
    await assert.rejects(fs.lstat(mappedDest), error => error.code === 'ENOENT');
  }
  // Unmapped pair must fail closed before any staging directory is created.
  // A map that names an identity absent from the archive proves that a
  // source uid/gid without a mapping entry can never be applied blindly.
  const unmappedDest = path.join(tempRoot, 'restore-unmapped');
  await assert.rejects(restoreEncryptedBrowserStateBackup({
    archive, keyFile, destination: unmappedDest, confirmation: RESTORE_CONFIRMATION,
    identityMaps: [{source: '4294967294:4294967294', target: [0, 0]}],
  }), /no --identity-map entry/, 'an unmapped archive identity must fail closed');
  await assert.rejects(fs.stat(unmappedDest), /ENOENT/,
    'an unmapped identity must be rejected before staging is created');
  // Cross-host same-host proof must fail closed.
  const crossDest = path.join(tempRoot, 'restore-cross-host');
  process.env.SHEIN_BI_BACKUP_HOST_ID = 'another-host';
  await assert.rejects(restoreEncryptedBrowserStateBackup({
    archive, keyFile, destination: crossDest, confirmation: RESTORE_CONFIRMATION, sameHostIdentity: true,
  }), /--same-host-identity/, 'a foreign-host archive must not pass same-host identity proof');
  await assert.rejects(fs.stat(crossDest), /ENOENT/, 'cross-host rejection must not create a destination');
  process.env.SHEIN_BI_BACKUP_HOST_ID = 'unit-test-host';
  // UID drift: only a root user can actually chown to a different numeric uid.
  if (isLinux && typeof process.getuid === 'function' && process.getuid() === 0) {
    const driftDest = path.join(tempRoot, 'restore-drift');
    await restoreEncryptedBrowserStateBackup({
      archive, keyFile, destination: driftDest, confirmation: RESTORE_CONFIRMATION,
      identityMaps: allPairs.map(pair => { const [u, g] = pair.split(':').map(Number); return {source: pair, target: [54321, 54321]}; }),
    });
    const driftStat = await fs.stat(path.join(driftDest, 'profiles', 'persistent-dl-profile', 'Default', 'Network', 'Cookies'));
    assert.equal(driftStat.uid, 54321, 'mapped uid drift must be applied, not the bare archive uid');
    assert.equal(driftStat.gid, 54321, 'mapped gid drift must be applied, not the bare archive gid');
    await fs.rm(driftDest, {recursive: true, force: true});
  }

  if (isLinux) {
    // ---- restore failure cleanup: no permanent final dir, staging preserved ----
    const failDest = path.join(tempRoot, 'restore-fail');
    let restorePassCount = 0;
    await assert.rejects(restoreEncryptedBrowserStateBackup({
      archive, keyFile, destination: failDest, confirmation: RESTORE_CONFIRMATION, sameHostIdentity: true,
      diagnostics: { afterAuthCheck: async () => { restorePassCount += 1; if (restorePassCount >= 2) throw new Error('injected restore failure'); } },
    }), /injected restore failure[\s\S]*restore-fail\.partial-[\s\S]*manual inspection required/,
    'a restore-pass failure must fail closed, name the captured staging tree and demand manual inspection');
    await assert.rejects(fs.stat(failDest), /ENOENT/, 'a failed restore must not leave a permanent final directory');
    const failPartialNames = (await fs.readdir(tempRoot)).filter(name => name.startsWith('restore-fail.partial-'));
    assert.equal(failPartialNames.length, 1,
      'a restore-pass failure must preserve exactly one captured staging tree instead of deleting it');
    const failStaging = path.join(tempRoot, failPartialNames[0]);
    assert.equal((await fs.lstat(failStaging)).isDirectory(), true,
      'the preserved staging directory must still exist for manual inspection');
    await fs.rm(failStaging, {recursive: true, force: true});

    // A nonempty target created at the final hook must survive untouched and
    // the rejected restore must preserve its captured staging tree.
    const publishRaceDest = path.join(tempRoot, 'restore-publish-race');
    const attackerMarker = path.join(publishRaceDest, 'attacker-owned.txt');
    let publishGateInjected = 0;
    let publishRaceStaging = '';
    await assert.rejects(restoreEncryptedBrowserStateBackup({
      archive, keyFile, destination: publishRaceDest, confirmation: RESTORE_CONFIRMATION, sameHostIdentity: true,
      diagnostics: { beforeRestorePublish: async ({destination: target, staging}) => {
        publishGateInjected += 1;
        publishRaceStaging = staging;
        assert.equal(target, publishRaceDest);
        assert.equal((await fs.lstat(staging)).isDirectory(), true,
          'fixture must run only after the restored staging tree is complete');
        await fs.mkdir(target);
        await fs.writeFile(attackerMarker, 'must-survive');
      } },
    }), /destination appeared during atomic publication[\s\S]*manual inspection required/,
    'RENAME_NOREPLACE must reject a last-instant nonempty competing destination and demand manual inspection');
    assert.equal(publishGateInjected, 1);
    assert.equal(await fs.readFile(attackerMarker, 'utf8'), 'must-survive',
      'the nonempty destination creator data must not be overwritten or removed');
    await assert.rejects(fs.lstat(path.join(publishRaceDest, 'profiles')), error => error.code === 'ENOENT',
      'no restored tree may be merged into the competing destination');
    assert.equal((await fs.lstat(publishRaceStaging)).isDirectory(), true,
      'the rejected restore must preserve its captured staging tree for manual inspection');
    await fs.rm(publishRaceStaging, {recursive: true, force: true});
    assert.equal((await fs.readdir(tempRoot)).some(name => name.startsWith('restore-publish-race.partial-')), false,
      'the test explicitly cleans the preserved captured staging directory');

    // An empty destination is still competing state and must not be replaced;
    // the rejected restore preserves its captured staging tree.
    const emptyRaceDest = path.join(tempRoot, 'restore-publish-empty-race');
    let emptyRaceIdentity = null;
    let emptyRaceStaging = '';
    await assert.rejects(restoreEncryptedBrowserStateBackup({
      archive, keyFile, destination: emptyRaceDest, confirmation: RESTORE_CONFIRMATION, sameHostIdentity: true,
      diagnostics: { beforeRestorePublish: async ({destination: target, staging}) => {
        emptyRaceStaging = staging;
        await fs.mkdir(target);
        const stat = await fs.lstat(target, {bigint: true});
        emptyRaceIdentity = {dev: stat.dev, ino: stat.ino};
      } },
    }), /destination appeared during atomic publication[\s\S]*manual inspection required/,
    'RENAME_NOREPLACE must reject a last-instant empty competing destination and demand manual inspection');
    assert.deepEqual(await fs.readdir(emptyRaceDest), [],
      'an empty competing destination must survive as the same untouched empty directory');
    const emptyRaceReadback = await fs.lstat(emptyRaceDest, {bigint: true});
    assert.deepEqual({dev: emptyRaceReadback.dev, ino: emptyRaceReadback.ino}, emptyRaceIdentity,
      'the exact empty competing directory inode must survive publication');
    assert.equal((await fs.lstat(emptyRaceStaging)).isDirectory(), true,
      'the empty-destination race must preserve its captured staging tree for manual inspection');
    await fs.rm(emptyRaceStaging, {recursive: true, force: true});
    assert.equal((await fs.readdir(tempRoot)).some(name => name.startsWith('restore-publish-empty-race.partial-')), false,
      'the test explicitly cleans the preserved empty-race captured staging directory');

    // Replacing the destination parent pathname with another safe-looking
    // directory must still fail the bound dev:ino readback.
    const parentRaceRoot = path.join(tempRoot, 'restore-parent-race-root');
    const parentRaceMoved = path.join(tempRoot, 'restore-parent-race-moved');
    const parentRaceDest = path.join(parentRaceRoot, 'destination');
    let parentRaceStagingName = '';
    await fs.mkdir(parentRaceRoot, {mode: 0o700});
    await assert.rejects(restoreEncryptedBrowserStateBackup({
      archive, keyFile, destination: parentRaceDest, confirmation: RESTORE_CONFIRMATION, sameHostIdentity: true,
      diagnostics: { beforeRestorePublish: async ({staging}) => {
        parentRaceStagingName = path.basename(staging);
        await fs.rename(parentRaceRoot, parentRaceMoved);
        await fs.mkdir(parentRaceRoot, {mode: 0o700});
        await fs.mkdir(parentRaceDest);
      } },
    }), /parent dev:ino changed immediately before atomic publication[\s\S]*manual inspection required/,
    'a replacement parent path must not inherit publication authority from matching mode/owner metadata');
    assert.deepEqual(await fs.readdir(parentRaceDest), [],
      'the destination under the replacement parent must survive untouched');
    assert.equal((await fs.lstat(path.join(parentRaceMoved, parentRaceStagingName))).isDirectory(), true,
      'the captured staging inode moved with its bound parent must be left for manual inspection');
    await fs.rm(parentRaceRoot, {recursive: true});
    await fs.rm(parentRaceMoved, {recursive: true});

    // Once renameat2 succeeds, a later readback failure must leave the
    // destination intact and require manual inspection.
    const uncertainDest = path.join(tempRoot, 'restore-published-uncertain');
    await assert.rejects(restoreEncryptedBrowserStateBackup({
      archive, keyFile, destination: uncertainDest, confirmation: RESTORE_CONFIRMATION, sameHostIdentity: true,
      diagnostics: { beforeRestoreTerminalReadback: async () => { throw new Error('injected terminal readback failure'); } },
    }), /injected terminal readback failure[\s\S]*manual inspection required/,
    'a post-publication readback failure must be reported as manual inspection, not rolled back');
    assert.equal(await fs.readFile(path.join(uncertainDest, 'profiles', 'persistent-dl-profile', 'Default', 'Network', 'Cookies'), 'utf8'),
      'cookie-secret-that-must-be-encrypted',
      'a successfully published destination must survive an uncertain terminal readback');
    assert.equal((await fs.readdir(tempRoot)).some(name => name.startsWith('restore-published-uncertain.partial-')), false,
      'successful publication moves the staging inode instead of leaving a second tree');

    const movedAfterPublishDest = path.join(tempRoot, 'restore-published-moved-before-readback');
    const movedAfterPublishReadback = `${movedAfterPublishDest}.manual-inspection`;
    await assert.rejects(restoreEncryptedBrowserStateBackup({
      archive, keyFile, destination: movedAfterPublishDest, confirmation: RESTORE_CONFIRMATION, sameHostIdentity: true,
      diagnostics: { beforeRestoreTerminalReadback: async ({destination: target}) => {
        await fs.rename(target, movedAfterPublishReadback);
      } },
    }), /ENOENT[\s\S]*manual inspection required/,
    'losing the destination pathname after helper success must retain the successful-publication fact');
    assert.equal(await fs.readFile(path.join(movedAfterPublishReadback, 'profiles', 'persistent-dl-profile', 'Default', 'Network', 'Cookies'), 'utf8'),
      'cookie-secret-that-must-be-encrypted',
      'a destination moved after publication must be left untouched for manual inspection');
    await assert.rejects(fs.lstat(movedAfterPublishDest), error => error.code === 'ENOENT');

    // Replacing the staging pathname never grants cleanup authority over the
    // replacement directory, even when it has the same owner and safe mode.
    const replacedStagingDest = path.join(tempRoot, 'restore-staging-replaced');
    let movedOwnedStaging = '';
    let replacementStaging = '';
    await assert.rejects(restoreEncryptedBrowserStateBackup({
      archive, keyFile, destination: replacedStagingDest, confirmation: RESTORE_CONFIRMATION, sameHostIdentity: true,
      diagnostics: { beforeRestorePublish: async ({staging}) => {
        movedOwnedStaging = `${staging}.moved-owned`;
        replacementStaging = staging;
        await fs.rename(staging, movedOwnedStaging);
        await fs.mkdir(staging, {mode: 0o700});
        await fs.writeFile(path.join(staging, 'competitor-marker.txt'), 'must-survive');
      } },
    }), /staging dev:ino changed[\s\S]*replacement staging path left untouched[\s\S]*manual inspection required/,
    'cleanup must reject a staging pathname that no longer names the captured inode');
    assert.equal(await fs.readFile(path.join(replacementStaging, 'competitor-marker.txt'), 'utf8'), 'must-survive',
      'a replacement staging directory must survive untouched');
    assert.equal((await fs.lstat(movedOwnedStaging)).isDirectory(), true,
      'the displaced owned staging directory must be left for explicit manual inspection');
    await fs.rm(replacementStaging, {recursive: true});
    await fs.rm(movedOwnedStaging, {recursive: true});
  }

  // ---- Chrome TOCTOU: every /proc channel fails closed except an explicit
  //      ENOENT/ESRCH process-disappearance race; fd overlap is detected.
  // Injected procFs adapters make these Linux error contracts deterministic
  // on Windows too, so no permission scenario is counted as a skipped pass.
  const nativeProcFs = {
    readdir: (...args) => fs.readdir(...args),
    readFile: (...args) => fs.readFile(...args),
    readlink: (...args) => fs.readlink(...args),
    realpath: (...args) => fs.realpath(...args),
  };
  const procError = code => Object.assign(new Error(`injected ${code}`), {code});

  const hiddenProc = path.join(tempRoot, 'proc-hidepid');
  const hiddenSource = path.join(tempRoot, 'data-hide', 'profiles');
  const hiddenCmdline = path.join(hiddenProc, '777', 'cmdline');
  await fs.mkdir(hiddenSource, {recursive: true});
  await fs.mkdir(path.dirname(hiddenCmdline), {recursive: true});
  await fs.writeFile(hiddenCmdline, Buffer.from(['/usr/bin/google-chrome', '--user-data-dir=' + hiddenSource].join('\0')));
  await assert.rejects(activeBrowserProcessesFromProc(hiddenProc, [hiddenSource], {
    procFs: {
      ...nativeProcFs,
      readFile: async (...args) => {
        if (path.resolve(String(args[0])) === path.resolve(hiddenCmdline)) throw procError('EACCES');
        return nativeProcFs.readFile(...args);
      },
    },
  }), /cannot read cmdline.*EACCES/,
  'a single unreadable cmdline must fail closed instead of being skipped');

  const fdProc = path.join(tempRoot, 'proc-fd');
  const fdSource = path.join(tempRoot, 'data-fd', 'profiles');
  const fdDir = path.join(fdProc, '444', 'fd');
  const fdEntry = path.join(fdDir, '3');
  await fs.mkdir(fdSource, {recursive: true});
  const fdFile = path.join(fdSource, 'open.bin');
  await fs.writeFile(fdFile, 'held-open');
  await fs.mkdir(fdDir, {recursive: true});
  await fs.writeFile(fdEntry, 'fixture-placeholder');
  await fs.writeFile(path.join(fdProc, '444', 'cmdline'), Buffer.from(['/usr/bin/google-chrome'].join('\0')));
  const fdDetected = await activeBrowserProcessesFromProc(fdProc, [fdSource], {
    procFs: {
      ...nativeProcFs,
      readlink: async (...args) => {
        if (path.resolve(String(args[0])) === path.resolve(fdEntry)) return fdFile;
        return nativeProcFs.readlink(...args);
      },
    },
  });
  assert.deepEqual(fdDetected.map(row => row.pid), [444],
    'a Chrome reaching the source through an fd without --user-data-dir must be detected');
  await assert.rejects(activeBrowserProcessesFromProc(fdProc, [fdSource], {
    procFs: {
      ...nativeProcFs,
      readlink: async (...args) => {
        if (path.resolve(String(args[0])) === path.resolve(fdEntry)) throw procError('EIO');
        return nativeProcFs.readlink(...args);
      },
    },
  }), /cannot read fd 3.*EIO/,
  'an individual fd read error must fail closed instead of being treated as a closed descriptor');

  const faultProc = path.join(tempRoot, 'proc-audit-errors');
  const faultSource = path.join(tempRoot, 'data-audit-errors', 'profiles');
  const faultPidDir = path.join(faultProc, '555');
  const faultFdDir = path.join(faultPidDir, 'fd');
  await fs.mkdir(faultFdDir, {recursive: true});
  await fs.mkdir(faultSource, {recursive: true});
  await fs.writeFile(path.join(faultPidDir, 'cmdline'), Buffer.from(['/usr/bin/google-chrome'].join('\0')));
  await fs.writeFile(path.join(faultPidDir, 'maps'), '');

  await assert.rejects(activeBrowserProcessesFromProc(faultProc, [faultSource], {
    procFs: {
      ...nativeProcFs,
      readdir: async (...args) => {
        if (path.resolve(String(args[0])) === path.resolve(faultFdDir)) throw procError('EACCES');
        return nativeProcFs.readdir(...args);
      },
    },
  }), /cannot read fd directory.*EACCES/,
  'an fd-directory permission failure must be a precise fail-closed blocker');

  for (const code of ['EACCES', 'EIO']) {
    await assert.rejects(activeBrowserProcessesFromProc(faultProc, [faultSource], {
      procFs: {
        ...nativeProcFs,
        readFile: async (...args) => {
          if (path.basename(String(args[0])) === 'maps') throw procError(code);
          return nativeProcFs.readFile(...args);
        },
      },
    }), new RegExp(`cannot read maps.*${code}`),
    `a maps ${code} failure must be a precise fail-closed blocker`);
  }

  const vanished = await activeBrowserProcessesFromProc(faultProc, [faultSource], {
    procFs: {
      ...nativeProcFs,
      readdir: async (...args) => {
        if (path.resolve(String(args[0])) === path.resolve(faultFdDir)) throw procError('ENOENT');
        return nativeProcFs.readdir(...args);
      },
    },
  });
  assert.deepEqual(vanished, [],
    'ENOENT after cmdline means the PID disappeared; the pre-publish full re-audit closes that race');
  const vanishedAtMaps = await activeBrowserProcessesFromProc(faultProc, [faultSource], {
    procFs: {
      ...nativeProcFs,
      readFile: async (...args) => {
        if (path.basename(String(args[0])) === 'maps') throw procError('ENOENT');
        return nativeProcFs.readFile(...args);
      },
    },
  });
  assert.deepEqual(vanishedAtMaps, [],
    'maps ENOENT is explicitly a disappeared-PID race, not a permission/read-error success');
  const auditArchive = path.join(tempRoot, 'prepublish-audit.sheinenc');
  await assert.rejects(createEncryptedBrowserStateBackup({
    keyFile, output: auditArchive,
    sources: [{logical: 'profiles', absolutePath: profileRoot, optional: false}],
    diagnostics: { activeBrowserProcesses: async () => [{pid: 424242}] },
  }), /Chrome started using a backup source after capture/,
    'a Chrome started after capture must abort create before the atomic publish');
  await assert.rejects(fs.stat(auditArchive), /ENOENT/, 'a pre-publish audit failure must not publish an output');
  assert.equal((await fs.readdir(tempRoot)).some(name => name.startsWith('prepublish-audit.sheinenc.partial-')), false,
    'a pre-publish audit failure must not leave a partial file');

  // ---- Disk capacity: bytes, blocks and inodes are all budgeted ----
  assert.equal(checkRestoreCapacity({bsize: 4096, bavail: 1000000, favail: 10000000}, 1000, 10, {freeMarginBytes: 1024}).needed, 1000 + 1024);
  assert.throws(() => checkRestoreCapacity({bsize: 4096, bavail: 0, favail: 10000000}, 1000, 10, {freeMarginBytes: 1024}), /Insufficient free/,
    'a bytes/block shortfall must fail');
  assert.throws(() => checkRestoreCapacity({bsize: 4096, bavail: 1000000, favail: 2}, 1000, 100, {freeMarginBytes: 1024}), /Insufficient free inodes/,
    'many zero-byte records hitting the inode budget must fail');

  // ---- Consecutive create failures stay space-bounded ----
  for (let n = 0; n < 3; n += 1) {
    const seqOut = path.join(tempRoot, `seq-fail-${n}.sheinenc`);
    await assert.rejects(createEncryptedBrowserStateBackup({
      keyFile, output: seqOut,
      sources: [{logical: 'profiles', absolutePath: profileRoot, optional: false}],
      afterPublish: async () => { throw new Error('sequence failure'); },
    }), /sequence failure/);
    await assert.rejects(fs.stat(seqOut), /ENOENT/, 'a failed create must never publish');
    assert.equal((await fs.readdir(tempRoot)).some(name => name.startsWith(`seq-fail-${n}.sheinenc.partial-`)), false,
      'a failed create must never leave a partial file across consecutive runs');
  }

  // ---- CLI identity-map parsing ----
  const mapCli = parseArgs(['restore', '--key-file', 'k', '--archive', 'a', '--destination', 'd', '--confirm', 'c',
    '--identity-map', '1000:1000=2000:2000', '--identity-map', '1:2=3:4', '--same-host-identity']);
  assert.deepEqual(mapCli.identityMaps, [
    {source: '1000:1000', target: [2000, 2000]},
    {source: '1:2', target: [3, 4]},
  ]);
  assert.equal(mapCli.sameHostIdentity, true);
  assert.throws(() => parseArgs(['restore', '--identity-map', 'garbage']), /Invalid identity map/);

  console.log('Encrypted browser state backup tests passed');
} finally {
  await fs.rm(tempRoot, {recursive: true, force: true});
}
