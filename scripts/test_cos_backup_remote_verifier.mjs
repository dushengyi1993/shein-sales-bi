#!/usr/bin/env node
// Deterministic contract tests for the independent COS remote verifier and
// the anonymous privacy probe.  No real COS network is ever used: SDK
// behavior is exercised against local loopback HTTP/HTTPS servers and
// deterministic fake streams, while credential/target files are real
// bounded files read through the production loader.
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import {PassThrough, Writable} from 'node:stream';
import {fileURLToPath} from 'node:url';

import COS from 'cos-nodejs-sdk-v5';

import {
  createLockedCos,
  EXIT_CONFIG,
  EXIT_OK,
  EXIT_USAGE,
  EXIT_VERIFY_FAILED,
  buildAuthorizationHeader,
  buildObjectKey,
  loadLockedTargetAndSecret,
  parseRemoteVerifyArgs,
  readBoundedCredentialFile,
  resolveOriginHost,
  runMain,
  sha256Hex,
  validateSafeRelativeKey,
  verifyRemoteObject,
} from './verify_cos_backup_remote.mjs';

import {
  anonymousGetStatus,
  buildProbeUrls,
  probePrivacy,
  runPrivacyProbe,
  targetFingerprint,
} from './check_cos_backup_privacy.mjs';

// Deterministic loader/test behavior; owner/mode enforcement is exercised
// separately on POSIX where it is meaningful.
process.env.SHEIN_BI_COS_VERIFY_TEST_MODE = '1';

const modulePath = fileURLToPath(new URL('./verify_cos_backup_remote.mjs', import.meta.url));

// Git Bash on PATH can drop custom environment variables; the test resolves
// a bash that is proven to propagate env (required for the openssl fixture).
function findBash() {
  const candidates = [
    process.env.SHEIN_BI_TEST_BASH,
    'D:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\bin\\bash.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['-lc', 'printf ok'], {encoding: 'utf8'});
    if (probe.status === 0) return candidate;
  }
  return 'bash';
}
const BASH = findBash();
const scenarios = [];
const skips = [];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fixtureBase(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

function makeTarget(overrides = {}) {
  return {
    bucket: 'shein-bi-test-1250000000',
    region: 'ap-shanghai',
    domain: '',
    prefix: 'db-backups',
    probeObjectKey: '2026-08-17/today.tar',
    maxObjectBytes: 64 * 1024 * 1024,
    requestTimeoutMs: 2000,
    ...overrides,
  };
}

function writeTargetFiles(root, target) {
  const targetFile = path.join(root, 'target.json');
  const shaLockFile = path.join(root, 'target.sha256');
  const secretFile = path.join(root, 'secret.json');
  const targetBytes = Buffer.from(JSON.stringify(target), 'utf8');
  fs.writeFileSync(targetFile, targetBytes, {mode: 0o600});
  fs.writeFileSync(shaLockFile, sha256Hex(targetBytes) + '\n', {mode: 0o600});
  fs.writeFileSync(secretFile, JSON.stringify({
    secretId: 'AKIDtestfixturesecret',
    secretKey: 'testsecretkey0123456789abcdef',
    securityToken: '',
  }), {mode: 0o600});
  return {
    secretFile,
    targetFile,
    targetShaLockFile: shaLockFile,
    SHEIN_BI_COS_VERIFY_SECRET_FILE: secretFile,
    SHEIN_BI_COS_VERIFY_TARGET_FILE: targetFile,
    SHEIN_BI_COS_VERIFY_TARGET_SHA_FILE: shaLockFile,
  };
}

function captureStream() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  return {stream, text: () => Buffer.concat(chunks).toString('utf8')};
}

// Runs a subprocess asynchronously so a live local server in THIS process
// keeps accepting connections while the child runs (spawnSync would block
// this event loop and stall a TLS handshake).
function runCliAsync(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('cli subprocess exceeded its bounded run time'));
    }, 30_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({status: code, signal, stdout, stderr});
    });
  });
}

function expectConfigError(fn, code) {
  return fn().then(
    () => assert.fail('expected rejection with ' + code),
    (error) => assert.equal(error.code, code),
  );
}

// ---------------------------------------------------------------------------
// A) argument parsing
// ---------------------------------------------------------------------------
{
  const parsed = parseRemoteVerifyArgs(['2026-08-17/base.tar', 'a'.repeat(64), '12345']);
  assert.deepEqual(parsed, {rel: '2026-08-17/base.tar', digest: 'a'.repeat(64), size: 12345});
  for (const bad of [
    ['2026-08-17/base.tar', 'a'.repeat(64)],
    ['2026-08-17/base.tar', 'a'.repeat(63), '1'],
    ['2026-08-17/base.tar', 'A'.repeat(64), '1'],
    ['2026-08-17/base.tar', 'g'.repeat(64), '1'],
    ['2026-08-17/base.tar', 'a'.repeat(64), '0'],
    ['2026-08-17/base.tar', 'a'.repeat(64), '-1'],
    ['2026-08-17/base.tar', 'a'.repeat(64), '007'],
    ['2026-08-17/base.tar', 'a'.repeat(64), '9999999999999999999'],
    ['2026-08-17/base.tar', 'a'.repeat(64), '1e3'],
    ['/abs.tar', 'a'.repeat(64), '1'],
  ]) {
    assert.throws(() => parseRemoteVerifyArgs(bad), (error) => /^COS_/.test(error.code));
  }
  scenarios.push('parse-remote-verify-args');
}

// ---------------------------------------------------------------------------
// B) relative key grammar and object key composition
// ---------------------------------------------------------------------------
{
  const good = ['2026-08-17/base.tar', 'today.tar', 'a.b_c-1/2', 'x'];
  for (const value of good) assert.equal(validateSafeRelativeKey(value, 'k'), value);
  const bad = ['', '/abs', 'a/../b', 'a//b', 'a/.', './a', 'a\\b', 'a%2Fb', 'a b', 'a?b', 'a#b', 'C:a', 'c:/x', 'a/\n', 'a\x01b', 'a\tb', '/', '..', '.', 'a/', 'a/./b'];
  for (const value of bad) {
    assert.throws(() => validateSafeRelativeKey(value, 'k'), (error) => error.code === 'COS_REL_KEY_INVALID', value);
  }
  assert.equal(buildObjectKey('db-backups', '2026-08-17/base.tar'), 'db-backups/2026-08-17/base.tar');
  assert.equal(buildObjectKey('', '2026-08-17/base.tar'), '2026-08-17/base.tar');
  // composed length must stay bounded even when each component is bounded
  assert.throws(
    () => buildObjectKey('a'.repeat(600), 'b'.repeat(600)),
    (error) => error.code === 'COS_REL_KEY_INVALID',
  );
  scenarios.push('relative-key-grammar-and-composed-length');
}

// ---------------------------------------------------------------------------
// C) bounded credential file loader
// ---------------------------------------------------------------------------
{
  const root = fixtureBase('cos-verify-loader-');
  try {
    const target = makeTarget();
    const {secretFile, targetFile, targetShaLockFile: shaLockFile} = writeTargetFiles(root, target);
    const read = await readBoundedCredentialFile(targetFile, 64 * 1024, 'cos target');
    assert.deepEqual(read.bytes, Buffer.from(JSON.stringify(target)));
    assert.equal(read.stat.size, Buffer.byteLength(JSON.stringify(target)));

    await expectConfigError(
      () => readBoundedCredentialFile(path.join(root, 'missing.json'), 1024, 'missing'),
      'COS_CREDENTIAL_FILE_STAT_FAILED',
    );

    await expectConfigError(
      () => readBoundedCredentialFile(root, 1024, 'directory'),
      'COS_CREDENTIAL_FILE_TYPE_INVALID',
    );

    const big = path.join(root, 'big.json');
    fs.writeFileSync(big, Buffer.alloc(1024 * 1024, 0x41));
    await expectConfigError(
      () => readBoundedCredentialFile(big, 1024, 'big'),
      'COS_CREDENTIAL_FILE_SIZE_INVALID',
    );

    // Same-inode in-place mutation during the exact-size read: dev/ino stay
    // identical but size/mtime/ctime drift, which must fail closed.
    await expectConfigError(
      () => readBoundedCredentialFile(targetFile, 64 * 1024, 'mutated', {
        hooks: {onAfterOpen: async () => { fs.writeFileSync(targetFile, 'mutated-in-place'); }},
      }),
      'COS_CREDENTIAL_FILE_RACE',
    );
    // Restore the locked content for the remaining loader checks.
    fs.writeFileSync(targetFile, JSON.stringify(target), {mode: 0o600});
    fs.writeFileSync(shaLockFile, sha256Hex(Buffer.from(JSON.stringify(target))) + '\n', {mode: 0o600});

    // Same-inode mutation BETWEEN lstat and open: the mutated bytes must not
    // become the new baseline.
    await expectConfigError(
      () => readBoundedCredentialFile(targetFile, 64 * 1024, 'preopen', {
        hooks: {onBeforeOpen: async () => { fs.writeFileSync(targetFile, 'mutated-before-open'); }},
      }),
      'COS_CREDENTIAL_FILE_RACE',
    );
    fs.writeFileSync(targetFile, JSON.stringify(target), {mode: 0o600});

    // Same-inode mutation in the FINAL window (after the second fstat, before
    // the final lstat) must fail closed too.
    await expectConfigError(
      () => readBoundedCredentialFile(targetFile, 64 * 1024, 'postread', {
        hooks: {onAfterSecondFstat: async () => { fs.writeFileSync(targetFile, 'mutated-after-second-fstat'); }},
      }),
      'COS_CREDENTIAL_FILE_RACE',
    );
    fs.writeFileSync(targetFile, JSON.stringify(target), {mode: 0o600});

    // Path swap (rename a different file over the path) after the second
    // descriptor stat and before the final path lstat. POSIX permits renaming
    // over an open descriptor; Windows denies it (EPERM), so the rename-based
    // swap is exercised on POSIX where it is meaningful. Injecting immediately
    // after open would first change the unlinked descriptor's ctime and
    // correctly produce the broader COS_CREDENTIAL_FILE_RACE guard.
    if (process.platform !== 'win32') {
      const swapped = path.join(root, 'swapped.json');
      fs.writeFileSync(swapped, 'other bytes');
      await expectConfigError(
        () => readBoundedCredentialFile(targetFile, 64 * 1024, 'swapped', {
          hooks: {onAfterSecondFstat: async () => { fs.renameSync(swapped, targetFile); }},
        }),
        'COS_CREDENTIAL_FILE_PATH_SWAPPED',
      );
      fs.writeFileSync(targetFile, JSON.stringify(target), {mode: 0o600});
    }

    // Symlink rejection (POSIX only; Windows lacks the capability).
    try {
      const link = path.join(root, 'link.json');
      fs.symlinkSync(targetFile, link);
      const linkError = await readBoundedCredentialFile(link, 64 * 1024, 'link').then(
        () => null,
        (error) => error,
      );
      assert.ok(linkError && String(linkError.code).startsWith('COS_CREDENTIAL_FILE_'), 'symlink must fail closed');
    } catch (error) {
      assert.ok(error.code === 'EPERM' || error.code === 'EACCES', 'symlink capability failure: ' + error.code);
    }

    // Owner/mode enforcement on POSIX.  CI usually runs as a non-root user,
    // so the checks use (a) a real file owned by the current user for the
    // OWNER_INVALID integration gate and (b) a SYNTHETIC uid=0 stat fixture
    // (via the loader's injectable stat resolvers) to prove a group/other-
    // readable 0644 fails MODE_INVALID while 0600 is accepted -- without ever
    // needing root.  Production keeps the root-owned 0600 requirement.
    if (process.platform !== 'win32') {
      const modeEnv = {...process.env, SHEIN_BI_COS_VERIFY_TEST_MODE: '0'};
      const realUid = typeof process.getuid === 'function' ? process.getuid() : -1;
      // 1. Non-root POSIX integration: a real regular file owned by the
      // current (non-root) user must fail closed with OWNER_INVALID before
      // the mode bits are even consulted.
      if (realUid !== 0) {
        const nonRoot = path.join(root, 'nonroot.json');
        fs.writeFileSync(nonRoot, JSON.stringify(target), {mode: 0o600});
        await expectConfigError(
          () => readBoundedCredentialFile(nonRoot, 64 * 1024, 'nonroot', {env: modeEnv}),
          'COS_CREDENTIAL_FILE_OWNER_INVALID',
        );
      }
      // 2. Synthetic uid=0 stat fixture: impersonate root ownership so the
      // mode gate is exercised deterministically on any POSIX host.
      const fixtureBytes = Buffer.from(JSON.stringify(target));
      const fixturePath = path.join(root, 'fixture.json');
      fs.writeFileSync(fixturePath, fixtureBytes, {mode: 0o600});
      const synthetic = (mode) => ({
        isFile: () => true,
        dev: 1,
        ino: 1,
        size: fixtureBytes.length,
        mtimeMs: 123,
        ctimeMs: 456,
        uid: 0,
        mode,
      });
      // 0644 group/other-readable under uid=0 -> MODE_INVALID
      await expectConfigError(
        () => readBoundedCredentialFile(fixturePath, 64 * 1024, 'fixture', {
          env: modeEnv,
          hooks: {lstat: async () => synthetic(0o644), fdStat: async () => synthetic(0o644)},
        }),
        'COS_CREDENTIAL_FILE_MODE_INVALID',
      );
      // 0600 under uid=0 -> accepted, real bytes are read back.
      const accepted = await readBoundedCredentialFile(fixturePath, 64 * 1024, 'fixture', {
        env: modeEnv,
        hooks: {lstat: async () => synthetic(0o600), fdStat: async () => synthetic(0o600)},
      });
      assert.deepEqual(accepted.bytes, fixtureBytes, '0600 root-owned fixture must load the real bytes');
      scenarios.push('posix-owner-invalid-and-synthetic-uid0-mode-gate');
    }

    await loadLockedTargetAndSecret({secretFile, targetFile, targetShaLockFile: shaLockFile});
    scenarios.push('bounded-credential-loader-symlink-mode-race-drift');
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
}// ---------------------------------------------------------------------------
// D) locked target parsing and SHA lock
// ---------------------------------------------------------------------------
{
  const root = fixtureBase('cos-verify-target-');
  try {
    const base = makeTarget();
    const write = (target) => writeTargetFiles(root, target);

    const {secretFile, targetFile, targetShaLockFile: shaLockFile} = write(base);
    const loaded = await loadLockedTargetAndSecret({secretFile, targetFile, targetShaLockFile: shaLockFile});
    assert.equal(loaded.target.bucket, base.bucket);
    assert.equal(loaded.target.prefix, 'db-backups');

    // SHA drift
    const driftRoot = fixtureBase('cos-verify-drift-');
    const drift = writeTargetFiles(driftRoot, makeTarget());
    fs.writeFileSync(drift.targetShaLockFile, 'f'.repeat(64) + '\n');
    await expectConfigError(
      () => loadLockedTargetAndSecret({secretFile: drift.secretFile, targetFile: drift.targetFile, targetShaLockFile: drift.targetShaLockFile}),
      'COS_TARGET_SHA_DRIFT',
    );
    fs.rmSync(driftRoot, {recursive: true, force: true});

    // Lock file not hex
    const lockRoot = fixtureBase('cos-verify-lockhex-');
    const lockHex = writeTargetFiles(lockRoot, makeTarget());
    fs.writeFileSync(lockHex.targetShaLockFile, 'zz\n');
    await expectConfigError(
      () => loadLockedTargetAndSecret({secretFile: lockHex.secretFile, targetFile: lockHex.targetFile, targetShaLockFile: lockHex.targetShaLockFile}),
      'COS_TARGET_SHA_LOCK_INVALID',
    );
    fs.rmSync(lockRoot, {recursive: true, force: true});

    // Schema / field validation failures
    const invalidTargets = [
      [{...base, bucket: 'no-appid'}, 'COS_TARGET_BUCKET_INVALID'],
      [{...base, region: 'bad region!'}, 'COS_TARGET_REGION_INVALID'],
      [{...base, domain: 'evil.example.com'}, 'COS_TARGET_DOMAIN_INVALID'],
      [{...base, domain: '127.0.0.1:70000'}, 'COS_TARGET_DOMAIN_INVALID'],
      [{...base, prefix: '../escape'}, 'COS_REL_KEY_INVALID'],
      [{...base, probeObjectKey: ''}, 'COS_REL_KEY_INVALID'],
      [{...base, maxObjectBytes: 0}, 'COS_TARGET_SIZE_BOUND_INVALID'],
      [{...base, requestTimeoutMs: 0}, 'COS_TARGET_TIMEOUT_INVALID'],
      [{...base, prefix: 'p'.repeat(600), probeObjectKey: 'q'.repeat(600)}, 'COS_REL_KEY_INVALID'],
    ];
    for (const [target, code] of invalidTargets) {
      const {targetFile: t, targetShaLockFile: l, secretFile: sec} = write(target);
      await expectConfigError(
        () => loadLockedTargetAndSecret({secretFile: sec, targetFile: t, targetShaLockFile: l}),
        code,
      );
    }
    // Extra key is a shape violation
    const {targetFile: t2, targetShaLockFile: l2, secretFile: s2} = write({...base, extra: 1});
    await expectConfigError(
      () => loadLockedTargetAndSecret({secretFile: s2, targetFile: t2, targetShaLockFile: l2}),
      'COS_CONFIG_SHAPE_INVALID',
    );
    // Empty prefix is explicitly supported end-to-end.
    const emptyPrefix = write(makeTarget({prefix: ''}));
    const emptyLoaded = await loadLockedTargetAndSecret(emptyPrefix);
    assert.equal(emptyLoaded.target.prefix, '');
    assert.equal(buildObjectKey(emptyLoaded.target.prefix, '2026-08-17/base.tar'), '2026-08-17/base.tar');

    // The SDK has legacy implicit host rules for a handful of old region
    // aliases.  The verifier must override them so authenticated readback and
    // the anonymous privacy probe always hit the same canonical HTTPS origin.
    const pinned = createLockedCos(makeTarget({region: 'sg'}), {
      secretId: 'test-id',
      secretKey: 'test-key',
      securityToken: '',
    });
    assert.equal(pinned.options.Protocol, 'https:');
    assert.equal(pinned.options.Domain, '{Bucket}.cos.{Region}.myqcloud.com');
    assert.equal(resolveOriginHost(makeTarget({region: 'sg'})), 'shein-bi-test-1250000000.cos.sg.myqcloud.com');
    scenarios.push('locked-target-schema-sha-lock-empty-prefix-domain-pin');
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
}

// ---------------------------------------------------------------------------
// E) verifyRemoteObject lifecycle: official getAuth signing + direct http(s)
// ---------------------------------------------------------------------------
{
  const target = makeTarget({domain: '127.0.0.1:1', requestTimeoutMs: 3000});
  const body = 'fixture object body';
  const digest = sha256(body);
  const size = body.length;
  const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Deterministic signer: the real COS getAuth is exercised end-to-end in G/H;
  // here it is faked so the transport lifecycle is controlled without network.
  const fakeSigner = (opts = {}) => ({
    options: {Protocol: opts.protocol || 'http:', SecurityToken: opts.token || ''},
    getAuth(params) {
      if (opts.throwWith) throw opts.throwWith;
      return 'q-sign-algorithm=sha1&q-ak=test&q-header-list=host&q-url-param-list=&q-signature=deadbeef';
    },
  });

  // Fake real client socket.  promptDestroy models a normal Node socket whose
  // destroy() surfaces 'close' on the next tick; otherwise destroy() is inert
  // and the test drives the real 'close' manually (a delayed close).
  function fakeSocket(promptDestroy = false) {
    const sock = new EventEmitter();
    sock.destroyed = false;
    sock.destroy = () => {
      sock.destroyed = true;
      if (promptDestroy) process.nextTick(() => sock.emit('close'));
    };
    return sock;
  }

  // 1. signer throws with a secret sentinel -> COS_VERIFY_SDK_ERROR, no leak
  {
    const sentinel = 'top-secret-credential-marker';
    const cos = fakeSigner({throwWith: Object.assign(new Error('https://' + sentinel + '/auth?x=' + sentinel), {code: 'SIGN'})});
    const err = await verifyRemoteObject(cos, target, {rel: '2026-08-17/base.tar', digest, size}).then(() => null, (e) => e);
    assert.equal(err.code, 'COS_VERIFY_SDK_ERROR');
    assert.doesNotMatch(err.message, /top-secret/, 'signing errors must be sanitized');
  }
  // 2. transport.get throws synchronously -> COS_VERIFY_SDK_ERROR
  {
    const cos = fakeSigner();
    const client = {get() { throw new Error('init failed'); }};
    await expectConfigError(
      () => verifyRemoteObject(cos, target, {rel: '2026-08-17/base.tar', digest, size}, {client}),
      'COS_VERIFY_SDK_ERROR',
    );
  }
  // 3. transport returns no usable request -> COS_VERIFY_SDK_ERROR
  {
    const cos = fakeSigner();
    const client = {get() { return null; }};
    await expectConfigError(
      () => verifyRemoteObject(cos, target, {rel: '2026-08-17/base.tar', digest, size}, {client}),
      'COS_VERIFY_SDK_ERROR',
    );
  }
  // 4. response/end/response-close fire FIRST, the real socket close is
  //    DELAYED: success must stay pending until the socket really closes --
  //    a response-level close is never treated as a socket close.
  {
    const cos = fakeSigner();
    const sock = fakeSocket(false);
    const fakeRes = new PassThrough();
    fakeRes.statusCode = 200;
    fakeRes.headers = {'content-length': String(size)};
    const client = {
      get() {
        const req = new EventEmitter();
        req.destroy = () => {};
        process.nextTick(() => {
          req.emit('socket', sock);
          req.emit('response', fakeRes);
          process.nextTick(() => fakeRes.end(Buffer.from(body)));
        });
        return req;
      },
    };
    let settled = false;
    const p = verifyRemoteObject(cos, target, {rel: '2026-08-17/base.tar', digest, size}, {client, hooks: {teardownGraceMs: 800}});
    p.then(() => { settled = true; }, () => { settled = true; });
    await tick(20); // body ended, response closed, socket close still pending
    assert.equal(settled, false, 'success must NOT settle on response close alone; the socket close is delayed');
    sock.emit('close'); // the delayed real socket close arrives
    const out = await p;
    assert.equal(settled, true, 'success settles only after the real socket close');
    assert.equal(out.ok, true);
  }

  // 4a. A complete, valid body is only a candidate success.  If its socket
  // never closes, the still-armed request/body deadline upgrades it to timeout;
  // the independent teardown grace then completes with fail-closed
  // TEARDOWN_UNCONFIRMED.  This await is bounded by those implementation timers
  // themselves -- no outer kill/watchdog participates.
  {
    const cos = fakeSigner();
    const sock = fakeSocket(false);
    const fakeRes = new PassThrough();
    fakeRes.statusCode = 200;
    fakeRes.headers = {'content-length': String(size)};
    let bodyEnded = false;
    fakeRes.once('end', () => { bodyEnded = true; });
    const client = {
      get() {
        const req = new EventEmitter();
        req.destroy = () => {};
        process.nextTick(() => {
          req.emit('socket', sock);
          req.emit('response', fakeRes);
          process.nextTick(() => fakeRes.end(Buffer.from(body)));
        });
        return req;
      },
    };
    const boundedTarget = makeTarget({domain: '127.0.0.1:1', requestTimeoutMs: 90});
    const started = Date.now();
    const error = await verifyRemoteObject(
      cos,
      boundedTarget,
      {rel: '2026-08-17/base.tar', digest, size},
      {client, hooks: {teardownGraceMs: 120}},
    ).then(() => null, (caught) => caught);
    const elapsed = Date.now() - started;
    assert.equal(bodyEnded, true, 'the valid response body must have ended before the lifecycle failure');
    assert.equal(error && error.code, 'COS_VERIFY_TEARDOWN_UNCONFIRMED', 'a never-closing success socket must fail closed, never hang or succeed');
    assert.equal(sock.destroyed, true, 'deadline teardown must destroy the never-closing socket');
    assert.ok(elapsed >= 170 && elapsed < 1500, 'request deadline plus teardown grace must bound completion, elapsed=' + elapsed);
    scenarios.push('verify-success-body-end-never-close-bounded-fail-closed');
  }

  // 4b. Body end does not disarm the deadline.  After the deadline destroys
  // the socket, a deliberately delayed real socket close is required before
  // the promise returns the frozen TIMEOUT outcome.
  {
    const cos = fakeSigner();
    const sock = fakeSocket(false);
    let socketClosed = false;
    sock.once('close', () => { socketClosed = true; });
    const fakeRes = new PassThrough();
    fakeRes.statusCode = 200;
    fakeRes.headers = {'content-length': String(size)};
    let bodyEnded = false;
    fakeRes.once('end', () => { bodyEnded = true; });
    const client = {
      get() {
        const req = new EventEmitter();
        req.destroy = () => {};
        process.nextTick(() => {
          req.emit('socket', sock);
          req.emit('response', fakeRes);
          process.nextTick(() => fakeRes.end(Buffer.from(body)));
        });
        return req;
      },
    };
    let settled = false;
    let socketClosedAtSettle = null;
    const observed = verifyRemoteObject(
      cos,
      makeTarget({domain: '127.0.0.1:1', requestTimeoutMs: 100}),
      {rel: '2026-08-17/base.tar', digest, size},
      {client, hooks: {teardownGraceMs: 800}},
    ).then(
      (value) => ({value}),
      (error) => ({error}),
    ).then((result) => {
      settled = true;
      socketClosedAtSettle = socketClosed;
      return result;
    });
    await tick(35);
    assert.equal(bodyEnded, true, 'body end must precede the deadline upgrade');
    assert.equal(settled, false, 'candidate success must still await socket close');
    await tick(100);
    assert.equal(sock.destroyed, true, 'deadline must destroy the held socket after body end');
    assert.equal(settled, false, 'timeout outcome must still wait for delayed socket close');
    sock.emit('close');
    const result = await observed;
    assert.equal(result.error && result.error.code, 'COS_VERIFY_TIMEOUT');
    assert.equal(socketClosedAtSettle, true, 'TIMEOUT must settle only after the real socket close event');
    scenarios.push('verify-success-candidate-upgraded-timeout-waits-socket-close');
  }

  // 5. request errors FIRST, the real socket close is DELAYED: the verifier
  //    tears down on error but the promise stays pending until the socket
  //    really closes, then maps the failure to the sanitized stream-error code.
  {
    const cos = fakeSigner();
    const sock = fakeSocket(false);
    const emitted = {error: 0};
    const client = {
      get() {
        const req = new EventEmitter();
        req.destroy = () => {};
        process.nextTick(() => {
          req.emit('socket', sock);
          setTimeout(() => {
            emitted.error += 1;
            req.emit('error', Object.assign(new Error('stream reset'), {code: 'ECONNRESET'}));
          }, 10);
        });
        return req;
      },
    };
    let settled = false;
    const p = verifyRemoteObject(cos, target, {rel: '2026-08-17/base.tar', digest, size}, {client, hooks: {teardownGraceMs: 800}});
    p.then(() => { settled = true; }, () => { settled = true; });
    await tick(25); // error delivered + teardown done, socket close still pending
    assert.equal(emitted.error, 1, 'the fake request must have errored');
    assert.equal(settled, false, 'must STILL be pending while the socket close is delayed (error first)');
    assert.equal(sock.destroyed, true, 'error path must destroy the held socket');
    sock.emit('close');
    await expectConfigError(() => p, 'COS_VERIFY_STREAM_ERROR');
    assert.equal(settled, true, 'failure settles only after the real socket close');
  }

  // 5a. Error/request-close may race ahead of the ClientRequest 'socket'
  // event.  If request.socket is already assigned, the verifier must capture
  // it and refuse to settle on request close.
  {
    const cos = fakeSigner();
    const sock = fakeSocket(false);
    const client = {
      get() {
        const req = new EventEmitter();
        req.destroy = () => {};
        process.nextTick(() => {
          req.socket = sock;
          req.emit('error', new Error('early request error'));
          req.emit('close');
          // Intentionally never emit the usual 'socket' event.  Production
          // must recover the assigned socket through request.socket.
        });
        return req;
      },
    };
    let settled = false;
    const observed = verifyRemoteObject(
      cos,
      target,
      {rel: '2026-08-17/base.tar', digest, size},
      {client, hooks: {teardownGraceMs: 800}},
    ).then(
      (value) => ({value}),
      (error) => ({error}),
    ).then((result) => { settled = true; return result; });
    await tick(30);
    assert.equal(sock.destroyed, true, 'the late-observed request.socket must be destroyed');
    assert.equal(settled, false, 'request close cannot substitute for an assigned socket close');
    sock.emit('close');
    const result = await observed;
    assert.equal(result.error && result.error.code, 'COS_VERIFY_STREAM_ERROR');
    scenarios.push('verify-request-close-cannot-substitute-assigned-socket-close');
  }

  // 5b. Receiving a response proves that a client socket existed.  If the
  // transport never exposes that socket, a later request close cannot certify
  // teardown even when the response itself is already an ordinary HTTP
  // failure.  The verifier must replace that business error with the distinct
  // fail-closed lifecycle error.
  {
    const cos = fakeSigner();
    const fakeRes = new PassThrough();
    fakeRes.statusCode = 500;
    fakeRes.headers = {'content-length': '0'};
    const client = {
      get() {
        const req = new EventEmitter();
        req.destroy = () => {};
        process.nextTick(() => {
          req.emit('response', fakeRes);
          req.emit('close');
        });
        return req;
      },
    };
    await expectConfigError(
      () => verifyRemoteObject(
        cos,
        target,
        {rel: '2026-08-17/base.tar', digest, size},
        {client, hooks: {teardownGraceMs: 120}},
      ),
      'COS_VERIFY_TEARDOWN_UNCONFIRMED',
    );
    scenarios.push('verify-response-without-observable-socket-fails-closed');
  }

  // 6. never responds -> the request/body deadline tears everything down; the
  //    destroyed socket really closes and settle happens promptly with TIMEOUT.
  {
    const cos = fakeSigner();
    const sock = fakeSocket(true);
    const client = {
      get() {
        const req = new EventEmitter();
        req.destroy = () => {};
        process.nextTick(() => req.emit('socket', sock));
        return req; // never responds, never closes by itself
      },
    };
    const started = Date.now();
    await expectConfigError(
      () => verifyRemoteObject(cos, makeTarget({domain: '127.0.0.1:1', requestTimeoutMs: 400}), {rel: '2026-08-17/base.tar', digest, size}, {client, hooks: {teardownGraceMs: 800}}),
      'COS_VERIFY_TIMEOUT',
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 340 && elapsed < 3000, 'never-respond must be bounded by the request/body deadline plus close handling');
    assert.equal(sock.destroyed, true, 'deadline teardown must destroy the held socket');
  }
  // 7. teardown grace expires with NO real close -> distinct fail-closed
  //    COS_VERIFY_TEARDOWN_UNCONFIRMED error, never success, socket destroyed.
  {
    const cos = fakeSigner();
    const sock = fakeSocket(false); // never emits 'close' at all
    const client = {
      get() {
        const req = new EventEmitter();
        req.destroy = () => {};
        process.nextTick(() => {
          req.emit('socket', sock);
          req.emit('error', Object.assign(new Error('reset'), {code: 'ECONNRESET'}));
        });
        return req;
      },
    };
    const started = Date.now();
    await expectConfigError(
      () => verifyRemoteObject(cos, target, {rel: '2026-08-17/base.tar', digest, size}, {client, hooks: {teardownGraceMs: 120}}),
      'COS_VERIFY_TEARDOWN_UNCONFIRMED',
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 100, 'fail-closed teardown is bounded by the grace period');
    assert.equal(sock.destroyed, true, 'fail-closed teardown must destroy the held socket');
  }
  // 8. a response that physically sends MORE bytes than the locked bound must
  //    overflow the bounded stream promptly, destroy the response and socket
  //    and only settle after the REAL socket close.
  {
    const cos = fakeSigner();
    const sock = fakeSocket(true);
    const fakeRes = new PassThrough();
    fakeRes.statusCode = 200;
    fakeRes.headers = {'content-length': String(size)};
    let resClosed = 0;
    fakeRes.once('close', () => { resClosed += 1; });
    const client = {
      get() {
        const req = new EventEmitter();
        req.destroy = () => {};
        process.nextTick(() => {
          req.emit('socket', sock);
          req.emit('response', fakeRes);
          process.nextTick(() => {
            fakeRes.write(Buffer.alloc(2000, 0x51));
            fakeRes.write(Buffer.alloc(2000, 0x52));
            // never end: the verifier must overflow and tear down before end
          });
        });
        return req;
      },
    };
    const started = Date.now();
    await expectConfigError(
      () => verifyRemoteObject(cos, target, {rel: '2026-08-17/base.tar', digest, size}, {client, hooks: {teardownGraceMs: 800}}),
      'COS_VERIFY_SIZE_OVERFLOW',
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, 'overflow must interrupt the bounded stream promptly, elapsed=' + elapsed);
    assert.equal(fakeRes.destroyed, true, 'overflow must destroy the response stream');
    assert.ok(resClosed >= 1, 'overflow must destroy the response');
  }
  scenarios.push('verifyRemoteObject-getAuth-direct-transport-lifecycle-fake-socket');
}// ---------------------------------------------------------------------------
// F) runMain CLI contract (in-process)
// ---------------------------------------------------------------------------
{
  const root = fixtureBase('cos-verify-main-');
  try {
    const target = makeTarget({requestTimeoutMs: 2000});
    const files = writeTargetFiles(root, target);

    // usage
    const usageOut = captureStream();
    const usageErr = captureStream();
    let result = await runMain({argv: ['only-two'], env: process.env, out: usageOut.stream, err: usageErr.stream});
    assert.equal(result.code, EXIT_USAGE);
    assert.equal(usageOut.text(), '', 'usage failures must keep stdout empty');
    assert.match(usageErr.text(), /cos-verify-error code=COS_USAGE/);

    // missing credential paths
    const noPathsOut = captureStream();
    const noPathsErr = captureStream();
    result = await runMain({argv: ['2026-08-17/base.tar', 'a'.repeat(64), '5'], env: {...process.env, SHEIN_BI_COS_VERIFY_SECRET_FILE: '', SHEIN_BI_COS_VERIFY_TARGET_FILE: '', SHEIN_BI_COS_VERIFY_TARGET_SHA_FILE: ''}, out: noPathsOut.stream, err: noPathsErr.stream});
    assert.equal(result.code, EXIT_CONFIG);
    assert.equal(noPathsOut.text(), '');
    assert.match(noPathsErr.text(), /code=COS_CREDENTIAL_PATH_MISSING/);

    // Anonymous-public mode needs only the hash-locked target and must send
    // no Authorization header. It remains HTTPS-only in production; the
    // explicit test mode permits this loopback HTTP fixture.
    const anonymousRequests = [];
    const anonymousServer = http.createServer((req2, res) => {
      anonymousRequests.push({authorization: req2.headers.authorization, token: req2.headers['x-cos-security-token']});
      const body = Buffer.from('anonymous public object');
      res.writeHead(200, {'content-length': String(body.length)});
      res.end(body);
    });
    await new Promise((resolve) => anonymousServer.listen(0, '127.0.0.1', resolve));
    const anonymousPort = anonymousServer.address().port;
    const anonymousTarget = makeTarget({domain: '127.0.0.1:' + anonymousPort, requestTimeoutMs: 2000});
    writeTargetFiles(root, anonymousTarget);
    const anonymousBody = Buffer.from('anonymous public object');
    const anonymousOut = captureStream();
    const anonymousErr = captureStream();
    result = await runMain({
      argv: ['2026-08-17/public.tar', sha256(anonymousBody), String(anonymousBody.length)],
      env: {
        ...process.env,
        ...files,
        SHEIN_BI_COS_VERIFY_AUTH_MODE: 'anonymous-public',
        SHEIN_BI_COS_VERIFY_SECRET_FILE: '',
      },
      out: anonymousOut.stream,
      err: anonymousErr.stream,
    });
    assert.equal(result.code, EXIT_OK, anonymousErr.text());
    assert.equal(anonymousRequests.length, 1);
    assert.equal(anonymousRequests[0].authorization, undefined);
    assert.equal(anonymousRequests[0].token, undefined);
    anonymousServer.closeAllConnections();
    anonymousServer.close();
    writeTargetFiles(root, target);

    // check-config success and failure
    const checkOut = captureStream();
    const checkErr = captureStream();
    result = await runMain({argv: ['--check-config'], env: {...process.env, ...files}, out: checkOut.stream, err: checkErr.stream});
    assert.equal(result.code, EXIT_OK);
    assert.equal(checkOut.text(), 'check-config ok\n');
    assert.equal(checkErr.text(), '');
    fs.writeFileSync(files.targetShaLockFile, '0'.repeat(64) + '\n');
    const driftOut = captureStream();
    const driftErr = captureStream();
    result = await runMain({argv: ['--check-config'], env: {...process.env, ...files}, out: driftOut.stream, err: driftErr.stream});
    assert.equal(result.code, EXIT_CONFIG);
    assert.equal(driftOut.text(), '');
    assert.match(driftErr.text(), /code=COS_TARGET_SHA_DRIFT/);
    fs.writeFileSync(files.targetShaLockFile, sha256Hex(Buffer.from(JSON.stringify(target))) + '\n');

    // verify success/failure against a REAL COS signer + local loopback
    // server: the request goes over the direct http transport.
    const server = http.createServer((req2, res) => {
      if (req2.url === '/db-backups/2026-08-17/base.tar') {
        const b = Buffer.from('cli success body');
        res.writeHead(200, {'content-length': String(b.length)});
        res.end(b);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const loopbackTarget = makeTarget({domain: '127.0.0.1:' + port, requestTimeoutMs: 2000});
    writeTargetFiles(root, loopbackTarget); // repoint the same credential files
    const cliFactory = () => new COS({
      SecretId: 'test',
      SecretKey: 'test',
      FollowRedirect: false,
      AutoSwitchHost: false,
      Timeout: loopbackTarget.requestTimeoutMs,
      Domain: loopbackTarget.domain,
      Protocol: 'http:',
    });

    const body = 'cli success body';
    const digest = sha256(body);
    const successOut = captureStream();
    const successErr = captureStream();
    result = await runMain({
      argv: ['2026-08-17/base.tar', digest, String(body.length)],
      env: {...process.env, ...files},
      out: successOut.stream,
      err: successErr.stream,
      cosFactory: cliFactory,
    });
    assert.equal(result.code, EXIT_OK);
    assert.equal(successOut.text(), 'remote-ok ' + digest + ' ' + body.length + '\n');
    assert.equal(successErr.text(), '');

    // verify failure: stdout EMPTY, err carries only the sanitized code
    const failOut = captureStream();
    const failErr = captureStream();
    result = await runMain({
      argv: ['2026-08-17/base.tar', 'b'.repeat(64), String(body.length)],
      env: {...process.env, ...files},
      out: failOut.stream,
      err: failErr.stream,
      cosFactory: cliFactory,
    });
    assert.equal(result.code, EXIT_VERIFY_FAILED);
    assert.equal(failOut.text(), '', 'failure must leave stdout empty');
    assert.match(failErr.text(), /cos-verify-error code=COS_VERIFY_HASH_MISMATCH/);
    assert.doesNotMatch(failErr.text(), /db-backups|127\.0\.0\.1|AKID/, 'sanitized errors must not leak identity or credentials');

    // SDK error carrying a secret sentinel must never leak into out/err
    const sentinel = 'SHEIN_SECRET_SENTINEL_xyz';
    const leakOut = captureStream();
    const leakErr = captureStream();
    result = await runMain({
      argv: ['2026-08-17/base.tar', digest, String(body.length)],
      env: {...process.env, ...files},
      out: leakOut.stream,
      err: leakErr.stream,
      cosFactory: () => ({
        options: {Protocol: 'http:'},
        getAuth() { throw new Error('https://' + sentinel + '.example.com/auth?x=' + sentinel); },
      }),
    });
    assert.equal(result.code, EXIT_VERIFY_FAILED);
    assert.doesNotMatch(leakOut.text() + leakErr.text(), /SHEIN_SECRET_SENTINEL/, 'secret sentinels must never leak');
    assert.match(leakErr.text(), /cos-verify-error code=COS_VERIFY_SDK_ERROR/);
    server.closeAllConnections();
    server.close();
    scenarios.push('runMain-cli-contract-exact-stdout-sanitized-errors');
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
}

// ---------------------------------------------------------------------------
// G) real SDK against a local HTTP server (streaming end to end)
// ---------------------------------------------------------------------------
{
  const serverHashbad = Buffer.from('different body than the provided digest');
  const serverLengthbad = Buffer.from('x'.repeat(100));
  const temporaryToken = 'temporary-token-fixture-value';
  const tokenRequests = [];
  const server = http.createServer((req, res) => {
    const last = req.url.split('/').pop();
    if (last === 'token') {
      const authorization = String(req.headers.authorization || '');
      const encodedHeaderList = authorization.split('&').find((part) => part.startsWith('q-header-list='));
      tokenRequests.push({
        method: req.method,
        host: req.headers.host,
        tokenMatches: req.headers['x-cos-security-token'] === temporaryToken,
        range: req.headers.range,
        qHeaderList: encodedHeaderList ? decodeURIComponent(encodedHeaderList.slice('q-header-list='.length)) : '',
      });
      const body = Buffer.from('real sdk temporary token body');
      res.writeHead(200, {'content-length': String(body.length)});
      res.end(body);
    } else if (last === 'ok') {
      const body = Buffer.from('real sdk object body');
      res.writeHead(200, {'content-length': String(body.length)});
      res.end(body);
    } else if (last === '206') {
      const body = Buffer.from('real sdk object body');
      res.writeHead(206, {'content-length': String(body.length), 'Content-Range': 'bytes 0-' + (body.length - 1) + '/' + (body.length * 10)});
      res.end(body);
    } else if (last === 'gzip') {
      const body = Buffer.from('gzipped content marker');
      res.writeHead(200, {'content-length': String(body.length), 'Content-Encoding': 'gzip'});
      res.end(body);
    } else if (last === 'nolen') {
      res.writeHead(200);
      res.end('chunked body without content-length');
    } else if (last === 'hashbad') {
      res.writeHead(200, {'content-length': String(serverHashbad.length)});
      res.end(serverHashbad);
    } else if (last === 'lengthbad') {
      res.writeHead(200, {'content-length': String(serverLengthbad.length)});
      res.end(serverLengthbad);
    } else if (last === '404') {
      // Empty error body: with an error status the SDK reports the response
      // status itself, and no provider body is ever streamed into the sink.
      res.writeHead(404);
      res.end();
    } else if (last === 'redirect') {
      res.writeHead(301, {location: 'https://evil.example.com/steal'});
      res.end();
    } else if (last === 'truncated') {
      res.writeHead(200, {'content-length': '200'});
      res.write('only twenty bytes...');
      res.destroy();
    } else if (last === 'flood') {
      res.writeHead(200, {'content-length': '100000'});
      res.write(Buffer.alloc(2000, 0x55));
    } else if (last === 'hang') {
      res.writeHead(200, {'content-length': '100'});
      // headers only: socket stays open
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const root = fixtureBase('cos-verify-sdk-');
  try {
    const target = makeTarget({domain: '127.0.0.1:' + port, requestTimeoutMs: 1500});
    const files = writeTargetFiles(root, target);
    const testCosFactory = () => new COS({
      SecretId: 'test', SecretKey: 'test', FollowRedirect: false, AutoSwitchHost: false,
      Timeout: target.requestTimeoutMs, Domain: target.domain, Protocol: 'http:',
    });
    const run = async (rel, digest, size) => {
      const out = captureStream();
      const err = captureStream();
      const result = await runMain({argv: [rel, digest, String(size)], env: {...process.env, ...files}, out: out.stream, err: err.stream, cosFactory: testCosFactory});
      return {result, out: out.text(), err: err.text()};
    };
    const okBody = Buffer.from('real sdk object body');
    const okDigest = sha256(okBody);
    const gzipBody = Buffer.from('gzipped content marker');
    const hashbadBody = Buffer.from('different body than the provided digest');

    const success = await run('2026-08-17/ok', okDigest, okBody.length);
    assert.equal(success.result.code, EXIT_OK, success.err);
    assert.equal(success.out, 'remote-ok ' + okDigest + ' ' + okBody.length + '\n');
    assert.equal(success.err, '');

    // Locked real-SDK temporary-token contract: public getAuth signs the Host
    // and the explicitly supplied x-cos-security-token.  The direct transport
    // must send those exact signed headers, no Range, and exactly one GET.
    const tokenCos = new COS({
      SecretId: 'test',
      SecretKey: 'test',
      SecurityToken: temporaryToken,
      FollowRedirect: false,
      AutoSwitchHost: false,
      Timeout: target.requestTimeoutMs,
      Domain: target.domain,
      Protocol: 'http:',
    });
    const tokenRel = '2026-08-17/token';
    const tokenKey = buildObjectKey(target.prefix, tokenRel);
    const signedAuthorization = buildAuthorizationHeader(tokenCos, target, tokenKey, resolveOriginHost(target));
    const signedHeaderListPart = signedAuthorization.split('&').find((part) => part.startsWith('q-header-list='));
    assert.equal(
      signedHeaderListPart && decodeURIComponent(signedHeaderListPart.slice('q-header-list='.length)),
      'host;x-cos-security-token',
      'real SDK getAuth must sign Host and the temporary token in SDK order',
    );
    const tokenBody = Buffer.from('real sdk temporary token body');
    const tokenResult = await verifyRemoteObject(
      tokenCos,
      target,
      {rel: tokenRel, digest: sha256(tokenBody), size: tokenBody.length},
    );
    assert.equal(tokenResult.ok, true);
    assert.equal(tokenRequests.length, 1, 'temporary-token verification must issue exactly one GET');
    assert.deepEqual(tokenRequests[0], {
      method: 'GET',
      host: target.domain,
      tokenMatches: true,
      range: undefined,
      qHeaderList: 'host;x-cos-security-token',
    });
    scenarios.push('real-sdk-temporary-token-signed-headers-single-get');

    const matrix = [
      ['2026-08-17/206', okDigest, okBody.length, ['COS_VERIFY_PARTIAL_CONTENT']],
      ['2026-08-17/gzip', sha256(gzipBody), gzipBody.length, ['COS_VERIFY_CONTENT_ENCODING']],
      ['2026-08-17/nolen', sha256('chunked body without content-length'), 'chunked body without content-length'.length, ['COS_VERIFY_CONTENT_LENGTH_MISSING']],
      ['2026-08-17/404', okDigest, okBody.length, ['COS_VERIFY_HTTP_STATUS', '404']],
      ['2026-08-17/redirect', okDigest, okBody.length, ['COS_VERIFY_HTTP_STATUS', '301']],
      ['2026-08-17/hashbad', okDigest, hashbadBody.length, ['COS_VERIFY_HASH_MISMATCH']],
      ['2026-08-17/lengthbad', sha256(Buffer.from('x'.repeat(100))), 101, ['COS_VERIFY_CONTENT_LENGTH_MISMATCH']],
      // A flood whose declared Content-Length trumps the expected size is a
      // header fast-fail: the non-matching Content-Length is rejected before
      // any body is drained (bounded streaming is proven in section E).
      ['2026-08-17/flood', sha256(Buffer.alloc(100, 0x55)), 100, ['COS_VERIFY_CONTENT_LENGTH_MISMATCH']],
    ];
    for (const [rel, digest, size, acceptedCodes] of matrix) {
      const outcome = await run(rel, digest, size);
      assert.equal(outcome.result.code, EXIT_VERIFY_FAILED, rel + ' must fail: ' + outcome.err);
      assert.equal(outcome.out, '', rel + ' must leave stdout empty');
      assert.match(outcome.err, new RegExp('code=(' + acceptedCodes.join('|') + ')'), rel + ' expected code');
    }
    // truncated body: must fail fast with a bounded code set and empty stdout
    const truncOutcome = await run('2026-08-17/truncated', okDigest, 200);
    assert.equal(truncOutcome.result.code, EXIT_VERIFY_FAILED);
    assert.equal(truncOutcome.out, '');
    assert.match(truncOutcome.err, /code=(COS_VERIFY_STREAM_ERROR|COS_VERIFY_STREAM_CLOSED|COS_VERIFY_TIMEOUT|COS_VERIFY_HTTP_STATUS|ECONNRESET|ETIMEDOUT)/);
    // hang: bounded by the deadline, stdout empty
    const hangOutcome = await run('2026-08-17/hang', okDigest, 100);
    assert.equal(hangOutcome.result.code, EXIT_VERIFY_FAILED);
    assert.equal(hangOutcome.out, '');
    assert.match(hangOutcome.err, /code=(COS_VERIFY_TIMEOUT|COS_VERIFY_STREAM_ERROR|COS_VERIFY_STREAM_CLOSED|ETIMEDOUT)/);
    scenarios.push('real-sdk-local-http-streaming-matrix');
  } finally {
    server.closeAllConnections();
    server.close();
    fs.rmSync(root, {recursive: true, force: true});
  }
}// ---------------------------------------------------------------------------
// H) real SDK CLI subprocess over HTTPS with a self-signed CA
// ---------------------------------------------------------------------------
{
  const openssl = spawnSync(BASH, ['-lc', 'command -v openssl'], {encoding: 'utf8'});
  if (openssl.status === 0) {
    const root = fixtureBase('cos-verify-tls-');
    try {
      const keyPath = path.join(root, 'server-key.pem');
      const certPath = path.join(root, 'server-cert.pem');
      const opensslConf = [
        '[req]',
        'distinguished_name = dn',
        'prompt = no',
        'x509_extensions = v3_ca',
        '[dn]',
        'CN = 127.0.0.1',
        '[v3_ca]',
        'subjectAltName = IP:127.0.0.1',
        'basicConstraints = critical,CA:TRUE',
      ].join('\n');
      const opensslConfPath = path.join(root, 'openssl.cnf');
      fs.writeFileSync(opensslConfPath, opensslConf, 'utf8');
      const gen = spawnSync(BASH, ['-lc',
        'openssl req -x509 -newkey rsa:2048 -keyout "$COS_KEY" -out "$COS_CERT" -days 1 -nodes -config "$COS_CONF"',
        '_',
      ], {
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          ...process.env,
          COS_KEY: keyPath.replace(/\\/g, '/'),
          COS_CERT: certPath.replace(/\\/g, '/'),
          COS_CONF: opensslConfPath.replace(/\\/g, '/'),
        },
      });
      assert.equal(gen.status, 0, gen.stderr);
      const server = https.createServer({key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath)}, (req, res) => {
        const body = Buffer.from('tls verified object');
        res.writeHead(200, {'content-length': String(body.length)});
        res.end(body);
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;
      const target = makeTarget({domain: '127.0.0.1:' + port, requestTimeoutMs: 5000});
      const files = writeTargetFiles(root, target);
      const env = {
        ...process.env,
        ...files,
        NODE_EXTRA_CA_CERTS: certPath,
        SHEIN_BI_COS_VERIFY_TEST_MODE: '1',
      };
      const body = Buffer.from('tls verified object');
      const digest = sha256(body);
      const success = await runCliAsync([modulePath, '2026-08-17/base.tar', digest, String(body.length)], env);
      assert.equal(success.status, 0, success.stderr);
      assert.equal(success.stdout, 'remote-ok ' + digest + ' ' + body.length + '\n', 'CLI success stdout must be exactly one line');
      const failure = await runCliAsync([modulePath, '2026-08-17/base.tar', 'c'.repeat(64), String(body.length)], env);
      assert.equal(failure.status, EXIT_VERIFY_FAILED);
      assert.equal(failure.stdout, '', 'CLI failure stdout must be empty');
      assert.match(failure.stderr, /cos-verify-error code=COS_VERIFY_HASH_MISMATCH/);
      assert.doesNotMatch(failure.stderr, /127\.0\.0\.1|tls verified object/, 'CLI stderr must stay sanitized');
      server.closeAllConnections();
      server.close();
      scenarios.push('real-sdk-cli-https-selfsigned-subprocess');
    } finally {
      fs.rmSync(root, {recursive: true, force: true});
    }
  } else {
    skips.push({scenario: 'real-sdk-cli-https-selfsigned-subprocess', reason: 'openssl-not-installed'});
  }
}

// ---------------------------------------------------------------------------
// I) privacy probe
// ---------------------------------------------------------------------------
{
  // URL composition must bind prefix + probe relative key
  {
    const target = makeTarget({prefix: 'db-backups', probeObjectKey: '2026-08-17/today.tar'});
    const urls = buildProbeUrls(target, 'https:');
    assert.equal(urls.listUrl, 'https://shein-bi-test-1250000000.cos.ap-shanghai.myqcloud.com/');
    assert.equal(urls.objectUrl, 'https://shein-bi-test-1250000000.cos.ap-shanghai.myqcloud.com/db-backups/2026-08-17/today.tar');
    assert.throws(() => buildProbeUrls(target, 'ftp:'), (error) => error.code === 'COS_PROBE_PROTOCOL_INVALID');
    // fingerprint binds the probe object key
    const changed = targetFingerprint(makeTarget({probeObjectKey: '2026-08-17/other.tar'}));
    assert.notEqual(changed, targetFingerprint(target));
    scenarios.push('probe-url-composition-and-fingerprint-binding');
  }

  // production HTTPS enforcement: http: requires explicit test mode
  {
    const out = captureStream();
    const err = captureStream();
    const result = await runPrivacyProbe({
      env: {...process.env, SHEIN_BI_COS_VERIFY_PROBE_PROTOCOL: 'http:', SHEIN_BI_COS_VERIFY_TEST_MODE: '0'},
      out: out.stream,
      err: err.stream,
    });
    assert.equal(result.code, EXIT_CONFIG);
    assert.equal(out.text(), '');
    assert.match(err.text(), /code=COS_PROBE_HTTPS_REQUIRED/);
    const badOut = captureStream();
    const badErr = captureStream();
    const bad = await runPrivacyProbe({
      env: {...process.env, SHEIN_BI_COS_VERIFY_PROBE_PROTOCOL: 'ftp:', SHEIN_BI_COS_VERIFY_TEST_MODE: '1'},
      out: badOut.stream,
      err: badErr.stream,
    });
    assert.equal(bad.code, EXIT_CONFIG);
    assert.match(badErr.text(), /code=COS_PROBE_PROTOCOL_INVALID/);
    scenarios.push('probe-https-enforcement-and-protocol-rejection');
  }

  // test-mode HTTP probe against a local server
  {
    const server = http.createServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(403, {'content-type': 'application/xml'});
        res.end('<Error><Code>AccessDenied</Code></Error>');
        return;
      }
      if (req.url === '/db-backups/2026-08-17/today.tar') {
        res.writeHead(403);
        res.end();
        return;
      }
      res.writeHead(200);
      res.end('open');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const root = fixtureBase('cos-verify-probe-');
    try {
      const target = makeTarget({domain: '127.0.0.1:' + port, requestTimeoutMs: 3000});
      const files = writeTargetFiles(root, target);
      const out = captureStream();
      const err = captureStream();
      const result = await runPrivacyProbe({
        env: {...process.env, ...files, SHEIN_BI_COS_VERIFY_PROBE_PROTOCOL: 'http:', SHEIN_BI_COS_VERIFY_TEST_MODE: '1'},
        out: out.stream,
        err: err.stream,
      });
      assert.equal(result.code, EXIT_OK, err.text());
      const report = JSON.parse(out.text());
      assert.equal(report.ok, true);
      assert.equal(report.anonymousListBucketStatus, 403);
      assert.equal(report.anonymousObjectRangeGetStatus, 403);
      assert.deepEqual(report.checks, ['anonymous-list-403', 'anonymous-range-get-403']);
      assert.match(report.targetFingerprint, /^[0-9a-f]{64}$/);
      assert.doesNotMatch(out.text(), /127\.0\.0\.1|today\.tar|db-backups|shein-bi-test/, 'probe output must stay sanitized');
      assert.equal(err.text(), '');
      scenarios.push('probe-test-mode-http-403-403-sanitized');
    } finally {
      server.closeAllConnections();
      server.close();
      fs.rmSync(root, {recursive: true, force: true});
    }
  }

  // open-list / open-object failures and immediate response teardown
  {
    const server = http.createServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, {'content-length': '999999999'});
        res.write(Buffer.alloc(4096, 0x61));
        return; // never ends: the probe must not drain it
      }
      if (req.url === '/db-backups/2026-08-17/today.tar') {
        res.writeHead(200, {'content-length': '999999999'});
        res.write(Buffer.alloc(4096, 0x62));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const root = fixtureBase('cos-verify-probe-open-');
    try {
      const target = makeTarget({domain: '127.0.0.1:' + port, requestTimeoutMs: 5000});
      const files = writeTargetFiles(root, target);
      const started = Date.now();
      const out = captureStream();
      const err = captureStream();
      const result = await runPrivacyProbe({
        env: {...process.env, ...files, SHEIN_BI_COS_VERIFY_PROBE_PROTOCOL: 'http:', SHEIN_BI_COS_VERIFY_TEST_MODE: '1'},
        out: out.stream,
        err: err.stream,
      });
      const elapsed = Date.now() - started;
      assert.equal(result.code, EXIT_VERIFY_FAILED);
      assert.equal(JSON.parse(out.text()).ok, false);
      assert.equal(JSON.parse(out.text()).anonymousListBucketStatus, 200);
      assert.ok(elapsed < 3000, 'probe must not drain endless bodies, elapsed=' + elapsed);
      scenarios.push('probe-open-endpoints-rejected-no-body-drain');
    } finally {
      server.closeAllConnections();
      server.close();
      fs.rmSync(root, {recursive: true, force: true});
    }
  }

  // no-headers / hang: the server never writes a response.  Each probe must
  // settle deterministically within its bounded window with status 0 and no
  // drained body.
  {
    const server = http.createServer(() => {
      // intenionally no response
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const root = fixtureBase('cos-verify-probe-hang-');
    try {
      const target = makeTarget({domain: '127.0.0.1:' + port, requestTimeoutMs: 1200});
      const files = writeTargetFiles(root, target);
      const started = Date.now();
      const out = captureStream();
      const err = captureStream();
      const result = await runPrivacyProbe({
        env: {...process.env, ...files, SHEIN_BI_COS_VERIFY_PROBE_PROTOCOL: 'http:', SHEIN_BI_COS_VERIFY_TEST_MODE: '1'},
        out: out.stream,
        err: err.stream,
      });
      const elapsed = Date.now() - started;
      assert.equal(result.code, EXIT_VERIFY_FAILED);
      assert.equal(JSON.parse(out.text()).ok, false);
      assert.equal(JSON.parse(out.text()).anonymousListBucketStatus, 0);
      assert.ok(elapsed >= 1000 && elapsed < 6000, 'no-header probe must settle within the bounded window, elapsed=' + elapsed);
      scenarios.push('probe-no-headers-hang-bounded-settle');
    } finally {
      server.closeAllConnections();
      server.close();
      fs.rmSync(root, {recursive: true, force: true});
    }
  }
}

// ---------------------------------------------------------------------------
// J) privacy probe: real client socket captured; a delayed socket close keeps
//    the probe pending and the fail-closed teardown marker is explicit.
// ---------------------------------------------------------------------------
{
  const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // J1: direct anonymousGetStatus -- request error FIRST, socket close
  // DELAYED: the promise stays pending until the real socket close.
  {
    const sock = new EventEmitter();
    sock.destroyed = false;
    sock.destroy = () => { sock.destroyed = true; };
    const client = {
      get() {
        const req = new EventEmitter();
        req.destroy = () => {};
        process.nextTick(() => {
          req.emit('socket', sock);
          setTimeout(() => req.emit('error', new Error('ECONNRESET')), 10);
        });
        return req;
      },
    };
    let settled = false;
    const p = anonymousGetStatus('http://127.0.0.1:1/', {deadlineAt: Date.now() + 3000, client, hooks: {teardownGraceMs: 800}});
    p.then((v) => { settled = true; return v; });
    await tick(25);
    assert.equal(settled, false, 'probe request must stay pending while the socket close is delayed');
    assert.equal(sock.destroyed, true, 'error path must destroy the held socket');
    sock.emit('close'); // the delayed real socket close arrives
    const value = await p;
    assert.equal(settled, true, 'probe request settles only after the real socket close');
    assert.equal(value.statusCode, 0);
    assert.equal(value.requestError, true);
    scenarios.push('probe-anonymous-get-socket-delayed-close-stays-pending');
  }

  // J2: the two probe requests share ONE request deadline and their fake
  // sockets really close only after a delay (error first); the whole probe
  // must wait for the socket closes, not settle on request/response close.
  {
    const emitted = {closeCount: 0, errorCount: 0};
    const client = {
      get() {
        const sock = new EventEmitter();
        sock.destroyed = false;
        sock.destroy = () => { sock.destroyed = true; };
        const req = new EventEmitter();
        req.destroy = () => {};
        process.nextTick(() => req.emit('socket', sock));
        setTimeout(() => { emitted.errorCount += 1; req.emit('error', new Error('ECONNRESET')); }, 10);
        setTimeout(() => { emitted.closeCount += 1; sock.emit('close'); }, 60);
        return req;
      },
    };
    const root = fixtureBase('cos-verify-probe-fake-');
    try {
      const target = makeTarget({domain: '127.0.0.1:1', requestTimeoutMs: 3000});
      const files = writeTargetFiles(root, target);
      const out = captureStream();
      const err = captureStream();
      const started = Date.now();
      const result = await runPrivacyProbe({
        env: {...process.env, ...files, SHEIN_BI_COS_VERIFY_PROBE_PROTOCOL: 'http:', SHEIN_BI_COS_VERIFY_TEST_MODE: '1'},
        out: out.stream,
        err: err.stream,
        client,
        hooks: {teardownGraceMs: 800},
      });
      const elapsed = Date.now() - started;
      assert.equal(result.code, EXIT_VERIFY_FAILED);
      assert.equal(JSON.parse(out.text()).ok, false);
      assert.ok(emitted.errorCount >= 1, 'the fake requests must have errored');
      assert.ok(emitted.closeCount >= 1, 'probe must NOT settle before ANY real socket close');
      assert.ok(elapsed >= 90, 'probe must WAIT for the delayed socket closes, elapsed=' + elapsed);
      assert.ok(elapsed < 3000, 'probe must stay below the probe budget, elapsed=' + elapsed);
      scenarios.push('probe-error-first-delayed-socket-close-not-before-close');
    } finally {
      fs.rmSync(root, {recursive: true, force: true});
    }
  }

  // J3: socket NEVER closes -> explicit fail-closed teardownUnconfirmed
  // marker (never a fabricated status), socket destroyed.
  {
    const sock = new EventEmitter();
    sock.destroyed = false;
    sock.destroy = () => { sock.destroyed = true; };
    const client = {
      get() {
        const req = new EventEmitter();
        req.destroy = () => {};
        process.nextTick(() => { req.emit('socket', sock); });
        setTimeout(() => req.emit('error', new Error('ECONNRESET')), 5);
        return req;
      },
    };
    const value = await anonymousGetStatus('http://127.0.0.1:1/', {
      deadlineAt: Date.now() + 5000,
      client,
      hooks: {teardownGraceMs: 120},
    });
    assert.equal(value.statusCode, 0);
    assert.equal(value.requestError, true);
    assert.equal(value.teardownUnconfirmed, true, 'grace expiry must be an explicit fail-closed marker, never a fabricated status');
    assert.equal(sock.destroyed, true, 'fail-closed teardown must destroy the held socket');
    scenarios.push('probe-fail-closed-teardown-unconfirmed');
  }

  // J4: Node's response is registered through request.on('response') exactly
  // once.  Request/response close events happen first but cannot settle while
  // the captured socket close is delayed.
  {
    const sock = new EventEmitter();
    sock.destroyed = false;
    sock.destroy = () => { sock.destroyed = true; };
    const res = new EventEmitter();
    let statusReads = 0;
    let responseDestroyCalls = 0;
    Object.defineProperty(res, 'statusCode', {
      get() { statusReads += 1; return 403; },
    });
    res.destroy = () => { responseDestroyCalls += 1; };
    let callbackRegistrations = 0;
    let responseEvents = 0;
    const client = {
      get(url, options, callback) {
        if (typeof callback === 'function') callbackRegistrations += 1;
        const req = new EventEmitter();
        req.destroy = () => {};
        process.nextTick(() => {
          req.emit('socket', sock);
          responseEvents += 1;
          if (typeof callback === 'function') callback(res);
          req.emit('response', res);
          res.emit('close');
          req.emit('close');
        });
        return req;
      },
    };
    let settled = false;
    const p = anonymousGetStatus('http://127.0.0.1:1/', {
      deadlineAt: Date.now() + 3000,
      client,
      hooks: {teardownGraceMs: 800},
    });
    p.then(() => { settled = true; });
    await tick(30);
    assert.equal(callbackRegistrations, 0, 'transport.get must not receive a second response callback registration');
    assert.equal(responseEvents, 1, 'the fake transport emits exactly one response event');
    assert.equal(statusReads, 1, 'the response status must be processed exactly once');
    assert.equal(responseDestroyCalls, 1, 'single response processing must tear down the response exactly once');
    assert.equal(settled, false, 'request/response close cannot substitute for the held socket close');
    sock.emit('close');
    const value = await p;
    assert.equal(value.statusCode, 403);
    assert.equal(value.requestError, false);
    assert.equal(value.timedOut, false);
    scenarios.push('probe-single-response-registration-and-delayed-socket-close');
  }

  // J5: the shared deadline wins first.  A later 403 is teardown evidence only
  // and cannot overwrite the immutable timeout outcome; socket close remains
  // mandatory before settlement.
  {
    const sock = new EventEmitter();
    sock.destroyed = false;
    sock.destroy = () => { sock.destroyed = true; };
    const res = new EventEmitter();
    res.statusCode = 403;
    res.destroy = () => {};
    let req;
    const client = {
      get() {
        req = new EventEmitter();
        req.destroy = () => {};
        process.nextTick(() => req.emit('socket', sock));
        return req;
      },
    };
    let settled = false;
    const p = anonymousGetStatus('http://127.0.0.1:1/', {
      deadlineAt: Date.now() + 70,
      client,
      hooks: {teardownGraceMs: 600},
    });
    p.then(() => { settled = true; });
    await tick(105);
    assert.equal(sock.destroyed, true, 'deadline-first outcome must tear down the held socket');
    assert.equal(settled, false, 'deadline cannot settle before socket close');
    req.emit('response', res);
    res.emit('close');
    req.emit('close');
    await tick(20);
    assert.equal(settled, false, 'late 403 plus response/request close still cannot settle before socket close');
    sock.emit('close');
    const value = await p;
    assert.deepEqual(value, {statusCode: 0, requestError: true, timedOut: true});

    let probeCalls = 0;
    const probeClient = {
      get() {
        probeCalls += 1;
        const probeSock = new EventEmitter();
        probeSock.destroy = () => {};
        const probeReq = new EventEmitter();
        probeReq.destroy = () => {};
        const probeRes = new EventEmitter();
        probeRes.statusCode = 403;
        probeRes.destroy = () => {};
        process.nextTick(() => probeReq.emit('socket', probeSock));
        setTimeout(() => {
          probeReq.emit('response', probeRes);
          probeRes.emit('close');
          probeReq.emit('close');
        }, 80);
        setTimeout(() => probeSock.emit('close'), 120);
        return probeReq;
      },
    };
    const report = await probePrivacy({
      target: makeTarget({domain: '127.0.0.1:1'}),
      protocol: 'http:',
      client: probeClient,
      timeoutMs: 45,
      testMode: true,
      hooks: {teardownGraceMs: 500},
    });
    assert.equal(report.ok, false, 'a late 403 after deadline must never close the privacy gate');
    assert.equal(report.anonymousListBucketStatus, 0);
    assert.equal(report.anonymousObjectRangeGetStatus, 0);
    assert.equal(probeCalls, 1, 'the second shared-deadline request must not start after the first exhausts the budget');
    scenarios.push('probe-deadline-first-late-403-cannot-overwrite-timeout');
  }

  // J6: response headers win the business race.  A later request deadline may
  // reassert teardown but does not overwrite 403; the promise still waits for
  // the delayed socket close.
  {
    const sock = new EventEmitter();
    sock.destroyed = false;
    sock.destroy = () => { sock.destroyed = true; };
    const res = new EventEmitter();
    res.statusCode = 403;
    res.destroy = () => {};
    let req;
    const client = {
      get() {
        req = new EventEmitter();
        req.destroy = () => {};
        process.nextTick(() => {
          req.emit('socket', sock);
          req.emit('response', res);
        });
        return req;
      },
    };
    let settled = false;
    const p = anonymousGetStatus('http://127.0.0.1:1/', {
      deadlineAt: Date.now() + 75,
      client,
      hooks: {teardownGraceMs: 600},
    });
    p.then(() => { settled = true; });
    await tick(110);
    assert.equal(sock.destroyed, true, 'response handling and later deadline both enforce teardown');
    assert.equal(settled, false, 'response-first outcome must still wait beyond deadline for socket close');
    res.emit('close');
    req.emit('close');
    await tick(15);
    assert.equal(settled, false, 'response/request close remain insufficient');
    sock.emit('close');
    const value = await p;
    assert.deepEqual(value, {statusCode: 403, requestError: false, timedOut: false});
    scenarios.push('probe-response-first-deadline-does-not-overwrite-status');
  }

  // J7: if the socket event is missing but request.socket is already assigned,
  // request close cannot prove teardown.  The genuine no-socket request-close
  // path remains bounded and returns an error without fabricating a socket.
  {
    const sock = new EventEmitter();
    sock.destroyed = false;
    sock.destroy = () => { sock.destroyed = true; };
    const assignedClient = {
      get() {
        const req = new EventEmitter();
        req.destroy = () => {};
        process.nextTick(() => {
          req.socket = sock;
          req.emit('error', new Error('early error'));
          req.emit('close');
        });
        return req;
      },
    };
    let settled = false;
    const assigned = anonymousGetStatus('http://127.0.0.1:1/', {
      deadlineAt: Date.now() + 3000,
      client: assignedClient,
      hooks: {teardownGraceMs: 800},
    });
    assigned.then(() => { settled = true; });
    await tick(30);
    assert.equal(sock.destroyed, true);
    assert.equal(settled, false, 'request close cannot settle after request.socket has been captured');
    sock.emit('close');
    const assignedValue = await assigned;
    assert.equal(assignedValue.requestError, true);

    const noSocketClient = {
      get() {
        const req = new EventEmitter();
        req.destroy = () => {};
        process.nextTick(() => req.emit('close'));
        return req;
      },
    };
    const noSocketValue = await anonymousGetStatus('http://127.0.0.1:1/', {
      deadlineAt: Date.now() + 3000,
      client: noSocketClient,
      hooks: {teardownGraceMs: 800},
    });
    assert.deepEqual(noSocketValue, {statusCode: 0, requestError: true, timedOut: false});
    scenarios.push('probe-request-close-socket-assignment-race-and-proven-no-socket');
  }
}

// ---------------------------------------------------------------------------
// K) live loopback TLS: the verifier captures the CLIENT socket and settles
//    only after it is really closed (checked at the settle-instant, not after
//    a later poll); the CLI subprocess additionally proves a natural exit (no
//    outer watchdog kill) for a slow stall and an oversize body.
// ---------------------------------------------------------------------------
{
  const openssl = spawnSync(BASH, ['-lc', 'command -v openssl'], {encoding: 'utf8'});
  if (openssl.status !== 0) {
    skips.push({scenario: 'live-tls-in-process-socket-close-and-cli-natural-exit', reason: 'openssl-not-installed'});
  } else {
    const root = fixtureBase('cos-verify-lifecycle-');
    let server = null;
    try {
      const keyPath = path.join(root, 'server-key.pem');
      const certPath = path.join(root, 'server-cert.pem');
      const opensslConf = [
        '[req]',
        'distinguished_name = dn',
        'prompt = no',
        'x509_extensions = v3_ca',
        '[dn]',
        'CN = 127.0.0.1',
        '[v3_ca]',
        'subjectAltName = IP:127.0.0.1',
        'basicConstraints = critical,CA:TRUE',
      ].join('\n');
      const opensslConfPath = path.join(root, 'openssl.cnf');
      fs.writeFileSync(opensslConfPath, opensslConf, 'utf8');
      const gen = spawnSync(BASH, ['-lc',
        'openssl req -x509 -newkey rsa:2048 -keyout "$COS_KEY" -out "$COS_CERT" -days 1 -nodes -config "$COS_CONF"',
        '_',
      ], {
        encoding: 'utf8',
        timeout: 60_000,
        env: {...process.env, COS_KEY: keyPath.replace(/\\/g, '/'), COS_CERT: certPath.replace(/\\/g, '/'), COS_CONF: opensslConfPath.replace(/\\/g, '/')},
      });
      assert.equal(gen.status, 0, gen.stderr);

      const body = Buffer.from('in-process tls body');
      server = https.createServer({key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath)}, (req, res) => {
        const last = req.url.split('/').pop();
        if (last === 'inprocb') {
          res.writeHead(200, {'content-length': String(body.length)});
          res.end(body);
          return;
        }
        if (last === 'slow') {
          res.writeHead(200, {'content-length': '20'});
          res.write('slow-prefz'); // partial body, then stall forever
          return;
        }
        if (last === 'oversize') {
          res.writeHead(200, {'content-length': '100000'});
          res.write(Buffer.alloc(2000, 0x61));
          return; // declared length trumps expected: header fast-fail
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;

      const target = makeTarget({domain: '127.0.0.1:' + port, requestTimeoutMs: 1200});
      const files = writeTargetFiles(root, target);
      const env = {...process.env, ...files, NODE_EXTRA_CA_CERTS: certPath, SHEIN_BI_COS_VERIFY_TEST_MODE: '1'};
      const runCli = (rel, dig, sz) => runCliAsync([modulePath, rel, dig, String(sz)], env);

      // In-process live TLS: wrap the real https client to capture the CLIENT
      // socket and prove it really closed at the instant verifyRemoteObject
      // settles (no later poll).
      const capture = {count: 0, closed: false};
      const httpsClient = {
        get(url, opts) {
          // Pin the loopback CA so the in-process client really verifies the
          // self-signed server cert (test-only plumbing through the injected
          // client; production uses the real platform trust store).
          const req = https.get(url, {...opts, ca: fs.readFileSync(certPath)});
          req.on('socket', (sock) => {
            capture.count += 1;
            sock.once('close', () => { capture.closed = true; });
          });
          return req;
        },
      };
      const cos = new COS({
        SecretId: 'test',
        SecretKey: 'test',
        Protocol: 'https:',
        Timeout: 2000,
        FollowRedirect: false,
        AutoSwitchHost: false,
      });
      const digest = sha256(body);
      let closedAtResolve = null;
      const out = await verifyRemoteObject(cos, target, {rel: '2026-08-17/inprocb', digest, size: body.length}, {client: httpsClient});
      closedAtResolve = capture.closed;
      assert.equal(out.ok, true);
      assert.ok(capture.count >= 1, 'a real client socket must have been allocated');
      assert.equal(closedAtResolve, true, 'at the instant verifyRemoteObject settled the client socket was already REALLY closed');

      // CLI black-box: the subprocess exits naturally (no outer watchdog kill)
      // and stays sanitized for a slow stall and an oversize body.
      const slow = await runCli('2026-08-17/slow', digest, 20);
      assert.notEqual(slow.status, null, 'slow: CLI must exit by itself, not be killed by the outer watchdog');
      assert.equal(slow.signal, null, 'slow: must exit without an outer signal');
      assert.equal(slow.stdout, '');
      assert.match(slow.stderr, /code=COS_VERIFY_TIMEOUT/);

      const over = await runCli('2026-08-17/oversize', digest, 20);
      assert.notEqual(over.status, null, 'oversize: CLI must exit by itself');
      assert.equal(over.stdout, '');
      assert.match(over.stderr, /code=COS_VERIFY_CONTENT_LENGTH_MISMATCH/);

      scenarios.push('live-tls-in-process-socket-close-and-cli-natural-exit');
    } finally {
      if (server) {
        server.closeAllConnections();
        server.close();
      }
      fs.rmSync(root, {recursive: true, force: true});
    }
  }
}

// Reporting is part of the test contract: executed/passed scenarios and
// environmental skips are disjoint.  A skip marker hidden in scenarios must
// fail the suite instead of being reported as a pass.
assert.equal(
  scenarios.some((name) => /(^|:)skip(?:-|$)/i.test(name)),
  false,
  'skip markers must never be mixed into executed scenarios',
);
assert.equal(new Set(scenarios).size, scenarios.length, 'executed scenario names must be unique');
for (const entry of skips) {
  assert.deepEqual(Object.keys(entry).sort(), ['reason', 'scenario']);
  assert.equal(typeof entry.scenario, 'string');
  assert.equal(typeof entry.reason, 'string');
  assert.equal(scenarios.includes(entry.scenario), false, 'a scenario cannot be both executed and skipped');
}
for (const gatedScenario of [
  'real-sdk-cli-https-selfsigned-subprocess',
  'live-tls-in-process-socket-close-and-cli-natural-exit',
]) {
  const dispositions = Number(scenarios.includes(gatedScenario))
    + Number(skips.some((entry) => entry.scenario === gatedScenario));
  assert.equal(dispositions, 1, gatedScenario + ' must be reported exactly once as passed or skipped');
}

console.log(JSON.stringify({
  ok: true,
  tests: scenarios.length,
  scenarios,
  skips,
}, null, 2));
