#!/usr/bin/env node
// Independent remote-object verifier for SHEIN BI backups. Production may
// use signed credentials or the explicit anonymous-public mode for objects
// intentionally readable without a signing secret.
//
// Contract (see cloud_db_backup.sh verify_independent_remote):
//   verify_cos_backup_remote.mjs "<YYYY-MM-DD/base.tar>" <sha256> <size>
// Success: exit 0, stdout exactly "remote-ok <sha256> <size>" on one line.
// Failure: exit non-zero, stdout empty.  Diagnostics go to stderr only and
// never include credentials, signed URLs, object keys, provider bodies or
// raw SDK errors.
//
// The verifier is deliberately independent of the COS FUSE write path.  The
// officially locked cos-nodejs-sdk-v5 is used ONLY as the signer in signed
// mode (getAuth is a pure synchronous primitive); the actual request is one non-Range HTTP 200
// GetObject issued with Node's http/https modules and streamed into a bounded
// SHA-256 sink (never buffering the whole object, never touching disk).  The
// transport owns the ClientRequest, the response and the underlying client
// socket: Connection: close, no redirect and no retry.  Success and ordinary
// failures settle only after the real client socket observed 'close'; a
// bounded no-close path instead returns TEARDOWN_UNCONFIRMED and never success.
// A response/request-level close is never treated as a socket close.  There is
// no default credential chain: signed requests use only root-owned systemd
// credentials; anonymous-public sends no Authorization or token header while
// retaining the same hash-locked target and exact byte/hash gates.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromise from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

import COS from 'cos-nodejs-sdk-v5';

export const EXIT_OK = 0;
export const EXIT_VERIFY_FAILED = 1;
export const EXIT_USAGE = 64;
export const EXIT_CONFIG = 78;

export const TARGET_MAX_BYTES = 64 * 1024;
export const TARGET_SHA_LOCK_MAX_BYTES = 1024;
export const SECRET_MAX_BYTES = 16 * 1024;
export const REL_KEY_MAX_BYTES = 1024;

const TARGET_KEYS = ['bucket', 'domain', 'maxObjectBytes', 'prefix', 'probeObjectKey', 'region', 'requestTimeoutMs'].sort();
const SECRET_KEYS = ['secretId', 'secretKey', 'securityToken'].sort();
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const TEST_PORT_DOMAIN = /^127\.0\.0\.1:(?:[0-9]{1,4}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/;

const O_NOFOLLOW = Number(fs.constants?.O_NOFOLLOW) || 0;

function verifyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function statIdentity(stat) {
  return Object.freeze({
    dev: Number(stat?.dev || 0),
    ino: Number(stat?.ino || 0),
    size: Number(stat?.size || 0),
    mtimeMs: Number(stat?.mtimeMs || 0),
    ctimeMs: Number(stat?.ctimeMs || 0),
  });
}

// Path identity: same directory entry.  Used for the pathAfter lstat check so
// a path swap (including symlink swaps on platforms without O_NOFOLLOW)
// fails closed.
function sameIdentity(left, right) {
  return Boolean(left && right) && left.dev === right.dev && left.ino === right.ino;
}

// Full descriptor state: identical directory entry AND identical size and
// timestamps.  Used between the two fstat calls around the exact-size read so
// a same-inode in-place mutation (size/mtime/ctime drift) fails closed too.
function sameFileState(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw verifyError('COS_CONFIG_SHAPE_INVALID', label + ' must be a JSON object');
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw verifyError('COS_CONFIG_SHAPE_INVALID', label + ' keys are not the locked schema');
  }
}

function isTestMode(env) {
  return String(env?.SHEIN_BI_COS_VERIFY_TEST_MODE || '') === '1';
}

function enforceOwnerAndMode(env) {
  // Owner/group permission enforcement is POSIX production semantics.  In
  // explicit test mode the caller may run as an unprivileged user, and the
  // mode bits reported by Node on Windows are not a security boundary.
  return process.platform !== 'win32' && !isTestMode(env);
}

// Reads one bounded regular file through an already-open descriptor without
// following symlinks: lstat reject -> O_NOFOLLOW open -> fstat identity/size
// bound -> exact-size read -> full fstat-state check -> final path lstat must
// match the descriptor.  This is the same contract the deployment marker uses
// (lib/source_release_attestation.mjs), with the added same-inode mutation
// check and the root-owner / no group-other permission checks.
export async function readBoundedCredentialFile(file, maxBytes, label, {env = process.env, hooks = {}} = {}) {
  // Injected stat resolvers let tests substitute a synthetic stat object
  // (for example uid=0) without ever running as root.  Production always
  // uses the real lstat/fstat so the same-inode path checks stay intact.
  const resolveLstat = typeof hooks.lstat === 'function' ? hooks.lstat : (target) => fsPromise.lstat(target);
  const resolveFdStat = typeof hooks.fdStat === 'function' ? hooks.fdStat : (handle) => handle.stat();
  let lstatBefore;
  try {
    lstatBefore = await resolveLstat(file);
  } catch (error) {
    throw verifyError('COS_CREDENTIAL_FILE_STAT_FAILED', label + ' cannot be statted safely');
  }
  if (!lstatBefore.isFile()) throw verifyError('COS_CREDENTIAL_FILE_TYPE_INVALID', label + ' is not a regular file');
  if (lstatBefore.size > maxBytes) throw verifyError('COS_CREDENTIAL_FILE_SIZE_INVALID', label + ' exceeds the bounded size limit');
  if (enforceOwnerAndMode(env)) {
    if (lstatBefore.uid !== 0) throw verifyError('COS_CREDENTIAL_FILE_OWNER_INVALID', label + ' must be owned by root');
    if ((lstatBefore.mode & 0o77) !== 0) throw verifyError('COS_CREDENTIAL_FILE_MODE_INVALID', label + ' must not be readable by group or other');
  }
  if (hooks.onBeforeOpen) {
    try {
      await hooks.onBeforeOpen();
    } catch (error) {
      throw verifyError('COS_CREDENTIAL_FILE_HOOK_FAILED', label + ' pre-open hook failed');
    }
  }
  let handle;
  try {
    handle = await fsPromise.open(file, fs.constants.O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    throw verifyError('COS_CREDENTIAL_FILE_OPEN_FAILED', label + ' cannot be opened safely');
  }
  let bodyFailure = null;
  let result = null;
  try {
    let fdStat;
    try {
      fdStat = await resolveFdStat(handle);
    } catch (error) {
      throw verifyError('COS_CREDENTIAL_FILE_STAT_FAILED', label + ' descriptor cannot be statted safely');
    }
    if (!fdStat.isFile()) throw verifyError('COS_CREDENTIAL_FILE_TYPE_INVALID', label + ' is not a regular file');
    if (fdStat.size > maxBytes) throw verifyError('COS_CREDENTIAL_FILE_SIZE_INVALID', label + ' exceeds the bounded size limit');
    if (enforceOwnerAndMode(env)) {
      if (fdStat.uid !== 0) throw verifyError('COS_CREDENTIAL_FILE_OWNER_INVALID', label + ' descriptor is not owned by root');
      if ((fdStat.mode & 0o77) !== 0) throw verifyError('COS_CREDENTIAL_FILE_MODE_INVALID', label + ' descriptor must not be readable by group or other');
    }
    // Full-state compare across the lstat -> open window: an in-place rewrite
    // of the same inode before open must not become the new baseline.
    if (!sameFileState(lstatBefore, fdStat)) {
      throw verifyError('COS_CREDENTIAL_FILE_RACE', label + ' changed between lstat and open');
    }
    if (hooks.onAfterOpen) {
      try {
        await hooks.onAfterOpen();
      } catch (error) {
        throw verifyError('COS_CREDENTIAL_FILE_HOOK_FAILED', label + ' post-open hook failed');
      }
    }
    const bytes = Buffer.allocUnsafe(fdStat.size);
    let offset = 0;
    while (offset < bytes.length) {
      let readOut;
      try {
        readOut = await handle.read(bytes, offset, bytes.length - offset, offset);
      } catch (error) {
        throw verifyError('COS_CREDENTIAL_FILE_READ_FAILED', label + ' could not be read safely');
      }
      if (readOut.bytesRead <= 0 || offset + readOut.bytesRead > bytes.length) {
        throw verifyError('COS_CREDENTIAL_FILE_RACE', label + ' was truncated while reading');
      }
      offset += readOut.bytesRead;
    }
    let afterStat;
    try {
      afterStat = await resolveFdStat(handle);
    } catch (error) {
      throw verifyError('COS_CREDENTIAL_FILE_STAT_FAILED', label + ' descriptor cannot be re-statted safely');
    }
    if (!sameFileState(fdStat, afterStat)) throw verifyError('COS_CREDENTIAL_FILE_RACE', label + ' changed while reading');
    if (hooks.onAfterSecondFstat) {
      try {
        await hooks.onAfterSecondFstat();
      } catch (error) {
        throw verifyError('COS_CREDENTIAL_FILE_HOOK_FAILED', label + ' final-window hook failed');
      }
    }
    let pathAfter;
    try {
      pathAfter = await resolveLstat(file);
    } catch (error) {
      throw verifyError('COS_CREDENTIAL_FILE_STAT_FAILED', label + ' cannot be statted safely after reading');
    }
    // The final path lstat must match the descriptor's FULL state: a
    // different inode is a path swap; the same inode with a changed
    // size/mtime/ctime is an in-place mutation in the final window.
    if (!sameFileState(fdStat, pathAfter)) {
      throw verifyError(
        sameIdentity(fdStat, pathAfter) ? 'COS_CREDENTIAL_FILE_RACE' : 'COS_CREDENTIAL_FILE_PATH_SWAPPED',
        label + ' changed after the verified read window',
      );
    }
    result = Object.freeze({bytes, stat: statIdentity(afterStat)});
  } catch (error) {
    bodyFailure = error;
  } finally {
    try {
      await handle.close();
    } catch (error) {
      if (!bodyFailure) bodyFailure = verifyError('COS_CREDENTIAL_FILE_CLOSE_FAILED', label + ' could not be closed safely');
    }
  }
  if (bodyFailure) throw bodyFailure;
  return result;
}function parseSecret(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw verifyError('COS_SECRET_INVALID_JSON', 'cos overrides secret is not valid JSON');
  }
  exactKeys(parsed, SECRET_KEYS, 'cos overrides secret');
  if (!/^[A-Za-z0-9+/=_-]{1,256}$/.test(String(parsed.secretId || ''))) {
    throw verifyError('COS_SECRET_ID_INVALID', 'secretId does not match the locked charset');
  }
  if (!/^[A-Za-z0-9+/=_-]{1,512}$/.test(String(parsed.secretKey || ''))) {
    throw verifyError('COS_SECRET_KEY_INVALID', 'secretKey does not match the locked charset');
  }
  const token = String(parsed.securityToken || '');
  if (token !== '' && !/^[A-Za-z0-9+/=_.-]{1,2048}$/.test(token)) {
    throw verifyError('COS_SECURITY_TOKEN_INVALID', 'securityToken does not match the locked charset');
  }
  return Object.freeze({
    secretId: String(parsed.secretId),
    secretKey: String(parsed.secretKey),
    securityToken: token,
  });
}

// Relative keys are validated by strict segment grammar and never decoded:
// absolute paths, empty/. /.. segments, backslashes, control characters,
// percent-style encodings, repeated separators, whitespace and non-ASCII are
// rejected.  The verifier only ever prepends the locked prefix.
export function validateSafeRelativeKey(value, label, {allowEmpty = false} = {}) {
  if (allowEmpty && value === '') return '';
  if (typeof value !== 'string' || value.length === 0 || value.length > REL_KEY_MAX_BYTES) {
    throw verifyError('COS_REL_KEY_INVALID', label + ' must be a bounded non-empty path');
  }
  if (value.includes('\\') || value.includes('%') || value.includes('?') || value.includes('#')) {
    throw verifyError('COS_REL_KEY_INVALID', label + ' contains an unsafe character');
  }
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    throw verifyError('COS_REL_KEY_INVALID', label + ' must be relative');
  }
  const segments = value.split('/');
  for (const segment of segments) {
    if (!SAFE_SEGMENT.test(segment)) {
      throw verifyError('COS_REL_KEY_INVALID', label + ' contains an unsafe segment');
    }
  }
  return value;
}

export function buildObjectKey(prefix, rel) {
  const normalizedPrefix = validateSafeRelativeKey(prefix, 'target prefix', {allowEmpty: true});
  const normalizedRel = validateSafeRelativeKey(rel, 'archive relative key');
  const composed = normalizedPrefix === '' ? normalizedRel : normalizedPrefix + '/' + normalizedRel;
  // The composed COS key itself must stay within the bounded length: two
  // small components must not smuggle an oversized final key.
  if (composed.length > REL_KEY_MAX_BYTES) {
    throw verifyError('COS_REL_KEY_INVALID', 'composed object key exceeds the bounded length');
  }
  return composed;
}

export function parseRemoteVerifyArgs(argv) {
  const args = Array.from(argv || []);
  if (args.length !== 3) throw verifyError('COS_USAGE', 'expected <relative-key> <sha256> <size>');
  const [rel, digest, sizeText] = args;
  validateSafeRelativeKey(rel, 'archive relative key');
  if (!/^[0-9a-f]{64}$/.test(digest)) throw verifyError('COS_DIGEST_INVALID', 'sha256 digest must be 64 lowercase hex characters');
  if (!/^(0|[1-9][0-9]{0,14})$/.test(sizeText) || !Number.isSafeInteger(Number(sizeText)) || !(Number(sizeText) > 0)) {
    throw verifyError('COS_SIZE_INVALID', 'size must be a canonical positive decimal');
  }
  return Object.freeze({rel, digest, size: Number(sizeText)});
}

// Resolves the pinned canonical origin the SDK signs against.  In production
// domain is always empty: the only allowed host is the bucket's canonical
// virtual-host endpoint, so credentials can never be sent to another host.
export function resolveOriginHost(target) {
  if (target.domain !== '') return target.domain;
  return target.bucket + '.cos.' + target.region + '.myqcloud.com';
}

function parseLockedTarget(bytes, {env = process.env} = {}) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw verifyError('COS_TARGET_INVALID_JSON', 'cos target is not valid JSON');
  }
  exactKeys(parsed, TARGET_KEYS, 'cos target');
  const bucket = String(parsed.bucket || '');
  const region = String(parsed.region || '');
  const domain = String(parsed.domain || '');
  const prefix = String(parsed.prefix || '');
  const probeObjectKey = String(parsed.probeObjectKey || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,62}-\d+$/.test(bucket)) {
    throw verifyError('COS_TARGET_BUCKET_INVALID', 'target bucket does not match the locked schema');
  }
  if (!/^[a-zA-Z0-9-]{1,32}$/.test(region)) {
    throw verifyError('COS_TARGET_REGION_INVALID', 'target region does not match the locked schema');
  }
  if (domain !== '') {
    // Production pins the SDK to the canonical `{Bucket}.cos.{Region}.myqcloud.com`
    // origin.  A custom domain would send signed requests to an uncontrolled
    // host, so only explicit test mode may use a loopback origin.
    if (!isTestMode(env)) throw verifyError('COS_TARGET_DOMAIN_INVALID', 'target domain must be empty in production to pin the canonical COS origin');
    if (!TEST_PORT_DOMAIN.test(domain)) throw verifyError('COS_TARGET_DOMAIN_INVALID', 'test target domain must be a loopback origin');
  }
  validateSafeRelativeKey(prefix, 'target prefix', {allowEmpty: true});
  validateSafeRelativeKey(probeObjectKey, 'target probe object key');
  // Lock the composed probe/backup object key and its total length at
  // configuration load: a late buildObjectKey throw must never surface as a
  // raw runtime failure or a wrong error class.
  buildObjectKey(prefix, probeObjectKey);
  const maxObjectBytes = Number(parsed.maxObjectBytes);
  if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes <= 0) {
    throw verifyError('COS_TARGET_SIZE_BOUND_INVALID', 'target maxObjectBytes is not a positive integer');
  }
  const requestTimeoutMs = Number(parsed.requestTimeoutMs);
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > 3_600_000) {
    throw verifyError('COS_TARGET_TIMEOUT_INVALID', 'target requestTimeoutMs is outside the locked range');
  }
  return Object.freeze({bucket, region, domain, prefix, probeObjectKey, maxObjectBytes, requestTimeoutMs});
}

export async function loadLockedTarget({targetFile, targetShaLockFile, env = process.env, hooks = {}}) {
  const targetRead = await readBoundedCredentialFile(targetFile, TARGET_MAX_BYTES, 'cos target', {env, hooks: hooks.target || {}});
  const lockRead = await readBoundedCredentialFile(targetShaLockFile, TARGET_SHA_LOCK_MAX_BYTES, 'cos target sha lock', {env, hooks: hooks.lock || {}});
  const lockText = lockRead.bytes.toString('utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(lockText)) throw verifyError('COS_TARGET_SHA_LOCK_INVALID', 'target sha lock is not a 64-character lowercase hex digest');
  if (sha256Hex(targetRead.bytes) !== lockText) throw verifyError('COS_TARGET_SHA_DRIFT', 'target sha lock does not match the target file bytes');
  const target = parseLockedTarget(targetRead.bytes, {env});
  return Object.freeze({target});
}

export async function loadLockedTargetAndSecret({secretFile, targetFile, targetShaLockFile, env = process.env, hooks = {}}) {
  const secretRead = await readBoundedCredentialFile(secretFile, SECRET_MAX_BYTES, 'cos overrides secret', {env, hooks: hooks.secret || {}});
  const {target} = await loadLockedTarget({targetFile, targetShaLockFile, env, hooks});
  const secret = parseSecret(secretRead.bytes);
  return Object.freeze({target, secret});
}

export function createLockedCos(target, secret) {
  return new COS({
    SecretId: secret.secretId,
    SecretKey: secret.secretKey,
    SecurityToken: secret.securityToken === '' ? undefined : secret.securityToken,
    FollowRedirect: false,
    AutoSwitchHost: false,
    StrictSsl: true,
    // Pin both transport and host template explicitly.  The SDK's implicit
    // host resolver uses a legacy no-`cos` hostname for a small set of old
    // region aliases (for example `sg`), while the independent privacy probe
    // intentionally uses the canonical `{Bucket}.cos.{Region}` origin.
    // Leaving Domain empty could therefore make the authenticated verifier
    // and anonymous privacy gate inspect different origins.  A loopback
    // domain is still accepted only by parseLockedTarget in explicit test
    // mode; production always lands on this canonical HTTPS template.
    Protocol: 'https:',
    Timeout: target.requestTimeoutMs,
    Domain: target.domain || '{Bucket}.cos.{Region}.myqcloud.com',
    UseAccelerate: false,
  });
}

// ---------------------------------------------------------------------------
// Authenticated GET via the official COS signing primitive + Node http/https.
// The official cos-nodejs-sdk-v5 is used ONLY as the signer: getAuth is a
// pure synchronous operation that returns the Authorization header.  The
// actual request is issued with Node's http/https modules so this verifier
// holds the ClientRequest/response/socket directly and can enforce: one
// request/body deadline, Connection: close, no redirect, no retry, and that
// every failure path destroys all handles and awaits the REAL socket close
// before the promise settles.  A separate bounded teardown grace starts only
// after a failure; it is deliberately not described as part of that deadline.
// ---------------------------------------------------------------------------

const TEARDOWN_GRACE_MS = 2000;

// Signs exactly one GET against the target object.  The signed headers must
// match what is sent on the wire (Host, and x-cos-security-token for
// temporary credentials) or the COS server rejects the signature.
export function buildAuthorizationHeader(cos, target, key, host) {
  if (!cos || typeof cos.getAuth !== 'function') {
    throw verifyError('COS_VERIFY_SDK_ERROR', 'remote object signer is not usable');
  }
  const headers = {host};
  const securityToken = String(cos && cos.options && cos.options.SecurityToken || '');
  if (securityToken !== '') headers['x-cos-security-token'] = securityToken;
  let authorization;
  try {
    authorization = cos.getAuth({
      Bucket: target.bucket,
      Region: target.region,
      Method: 'GET',
      Key: key,
      Headers: headers,
    });
  } catch (error) {
    throw verifyError('COS_VERIFY_SDK_ERROR', 'remote object request could not be signed');
  }
  if (typeof authorization !== 'string' || authorization.length === 0) {
    throw verifyError('COS_VERIFY_SDK_ERROR', 'remote object request could not be signed');
  }
  return authorization;
}

// The transport must be HTTPS against the canonical origin in production.  A
// loopback test origin may use plain HTTP only in explicit test mode.
export function resolveRequestProtocol(cos, target) {
  const protocol = String(cos && cos.options && cos.options.Protocol || 'https:');
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw verifyError('COS_VERIFY_SDK_ERROR', 'remote object transport is not a supported protocol');
  }
  if (protocol === 'http:' && target.domain === '') {
    throw verifyError('COS_VERIFY_SDK_ERROR', 'remote object transport cannot downgrade to plain HTTP in production');
  }
  return protocol;
}

// Performs ONE signed or explicitly anonymous non-Range GET and streams the response body into
// a bounded SHA-256 sink.  The ClientRequest's underlying client socket is
// captured and held for the whole call; success is delivered only after that
// real socket has emitted 'close' (a response/request-level close is never
// treated as a socket close).  Every failure path destroys the
// response/request/socket FIRST and then waits for the real socket close; if
// the bounded grace expires without a close it returns the distinct
// fail-closed COS_VERIFY_TEARDOWN_UNCONFIRMED error (never success), with all
// handles destroyed and unref'd.  The request/body deadline remains armed while
// a completed body is waiting for socket close: a candidate success can still
// become COS_VERIFY_TIMEOUT.  Teardown then has its own bounded grace, so the
// maximum failure latency is request/body deadline plus teardown grace.
function performAuthenticatedGet({
  cos, target, key, size, maxBytes, deadlineMs, client,
  teardownGraceMs = TEARDOWN_GRACE_MS, signed = true,
}) {
  const host = resolveOriginHost(target);
  const protocol = resolveRequestProtocol(cos, target);
  const authorization = signed ? buildAuthorizationHeader(cos, target, key, host) : '';
  const securityToken = signed ? String(cos && cos.options && cos.options.SecurityToken || '') : '';
  const transport = client || (protocol === 'https:' ? https : http);
  const url = protocol + '//' + host + '/' + key;
  const headers = {
    Host: host,
    Connection: 'close',
    Accept: 'application/octet-stream',
    'Accept-Encoding': 'identity',
  };
  if (signed) headers.Authorization = authorization;
  if (securityToken !== '') headers['x-cos-security-token'] = securityToken;

  return new Promise((resolve, reject) => {
    let request = null;
    let response = null;
    let socket = null;
    let metaStatusCode = 0;
    let metaHeaders = null;
    let sawResponse = false;
    // terminal is a single arbiter.  ok is only a candidate until the socket
    // closes; the first failure (including the request/body deadline) may
    // upgrade that candidate and is then immutable.
    let terminal = null;
    let settled = false;
    let deadlineTimer = null;
    let teardownTimer = null;
    const socketSignal = {closed: false};
    const requestSignal = {closed: false};
    const hash = crypto.createHash('sha256');
    let bytes = 0;

    const onRequestClose = () => {
      requestSignal.closed = true;
      refreshSocketFromRequest();
      if (!terminal) {
        beginFailure(verifyError('COS_VERIFY_STREAM_CLOSED', 'remote object request closed before completion'));
        return;
      }
      maybeSettleAfterTransportClose();
    };
    const onSocketClose = () => {
      socketSignal.closed = true;
      if (!terminal) {
        beginFailure(verifyError('COS_VERIFY_STREAM_CLOSED', 'remote object stream closed before completion'));
        return;
      }
      maybeSettleAfterTransportClose();
    };
    const attachSocket = (sock) => {
      if (!sock || settled || socket) return;
      socket = sock;
      if (typeof sock.once === 'function') {
        sock.once('close', onSocketClose);
      }
      // A socket can be assigned after an error/deadline event.  Once captured,
      // request close is no longer sufficient evidence: destroy and wait for
      // this socket's own close.
      if (terminal && terminal.kind === 'error') {
        try { if (typeof sock.destroy === 'function') sock.destroy(); } catch (ignored) {}
      }
    };
    const refreshSocketFromRequest = () => {
      if (!socket && request && request.socket) attachSocket(request.socket);
    };

    const detach = () => {
      if (request) {
        request.removeListener('error', onRequestError);
        request.removeListener('response', onResponse);
        request.removeListener('socket', attachSocket);
        request.removeListener('close', onRequestClose);
      }
      if (response) {
        response.removeListener('readable', onReadable);
        response.removeListener('end', onEnd);
        response.removeListener('error', onStreamError);
        response.removeListener('close', onResponseClose);
      }
      if (socket && typeof socket.removeListener === 'function') {
        socket.removeListener('close', onSocketClose);
      }
    };

    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(teardownTimer);
      detach();
      if (error) reject(error);
      else resolve(value);
    };

    const destroyAll = () => {
      try { if (response && typeof response.destroy === 'function') response.destroy(); } catch (ignored) {}
      try { if (request && typeof request.destroy === 'function') request.destroy(); } catch (ignored) {}
      try { if (socket && typeof socket.destroy === 'function') socket.destroy(); } catch (ignored) {}
    };

    const unrefAll = () => {
      try { if (response && typeof response.unref === 'function') response.unref(); } catch (ignored) {}
      try { if (request && typeof request.unref === 'function') request.unref(); } catch (ignored) {}
      try { if (socket && typeof socket.unref === 'function') socket.unref(); } catch (ignored) {}
    };

    const startTeardownGrace = () => {
      if (settled || teardownTimer !== null) return;
      teardownTimer = setTimeout(() => {
        // Grace expiry is not close evidence.  Destroy/unref every known handle
        // and return the distinct fail-closed teardown error, never success and
        // never the earlier business error.
        destroyAll();
        unrefAll();
        settle(verifyError('COS_VERIFY_TEARDOWN_UNCONFIRMED', 'remote object teardown could not confirm the real socket close'), null);
      }, teardownGraceMs);
    };

    const maybeSettleAfterTransportClose = () => {
      if (settled || !terminal) return;
      refreshSocketFromRequest();
      if (socket) {
        if (!socketSignal.closed) return;
      } else {
        // ClientRequest 'close' with request.socket still absent is the only
        // provable no-socket path.  Any response proves that a socket existed;
        // if it was never observable, request close cannot certify teardown.
        if (!requestSignal.closed) return;
        if (sawResponse) {
          destroyAll();
          unrefAll();
          settle(verifyError('COS_VERIFY_TEARDOWN_UNCONFIRMED', 'remote object response had no observable client socket close'), null);
          return;
        }
      }
      if (terminal.kind === 'ok') {
        settle(null, {statusCode: metaStatusCode, headers: metaHeaders, bytes: terminal.bytes, hex: terminal.hex});
      } else {
        settle(terminal.error, null);
      }
    };

    const beginFailure = (error) => {
      if (settled) return;
      if (!terminal || terminal.kind === 'ok') {
        // Failure upgrades a candidate success.  Once a failure is selected,
        // later error/timeout/response events cannot replace it.
        terminal = {kind: 'error', error};
      } else {
        return;
      }
      refreshSocketFromRequest();
      destroyAll();
      startTeardownGrace();
      maybeSettleAfterTransportClose();
    };

    const onRequestError = () => {
      beginFailure(verifyError('COS_VERIFY_STREAM_ERROR', 'remote object request failed'));
    };

    const onStreamError = () => {
      beginFailure(verifyError('COS_VERIFY_STREAM_ERROR', 'remote object stream failed'));
    };

    const onReadable = () => {
      if (settled || (terminal && terminal.kind === 'error')) return;
      let chunk;
      while ((chunk = response.read()) !== null) {
        bytes += chunk.length;
        if (bytes > size || bytes > maxBytes) {
          beginFailure(verifyError('COS_VERIFY_SIZE_OVERFLOW', 'remote object exceeded the expected or locked size'));
          return;
        }
        hash.update(chunk);
      }
    };

    const onEnd = () => {
      if (terminal || settled) return;
      terminal = {kind: 'ok', bytes, hex: hash.digest('hex')};
      // Success is delivered only when the real socket 'close' fires via
      // maybeSettleAfterTransportClose.  The request/body deadline deliberately
      // remains armed while this candidate waits.
      maybeSettleAfterTransportClose();
    };

    const onResponseClose = () => {
      if (settled) return;
      if (terminal) return; // never settle on response close alone
      beginFailure(verifyError('COS_VERIFY_STREAM_CLOSED', 'remote object stream closed before completion'));
    };

    const onResponse = (res) => {
      if (settled) {
        try { if (res && typeof res.destroy === 'function') res.destroy(); } catch (ignored) {}
        return;
      }
      sawResponse = true;
      refreshSocketFromRequest();
      if (terminal && terminal.kind === 'error') {
        response = res;
        destroyAll();
        return;
      }
      if (terminal) return;
      response = res;
      metaStatusCode = Number(res.statusCode) || 0;
      metaHeaders = res.headers || {};
      if (typeof response.on === 'function') {
        response.on('readable', onReadable);
        response.once('end', onEnd);
        response.on('error', onStreamError);
        response.once('close', onResponseClose);
      }
      try {
        assertObjectMeta({statusCode: metaStatusCode, headers: metaHeaders}, size);
      } catch (error) {
        beginFailure(error);
      }
    };

    deadlineTimer = setTimeout(() => {
      beginFailure(verifyError('COS_VERIFY_TIMEOUT', 'remote object verification exceeded the request/body deadline'));
    }, deadlineMs);

    try {
      request = transport.get(url, {headers, agent: false});
    } catch (error) {
      settle(verifyError('COS_VERIFY_SDK_ERROR', 'remote object request could not be initiated'), null);
      return;
    }
    if (!request || typeof request.on !== 'function') {
      settle(verifyError('COS_VERIFY_SDK_ERROR', 'remote object transport did not return a usable request'), null);
      return;
    }
    request.on('error', onRequestError);
    request.on('response', onResponse);
    request.on('socket', attachSocket);
    request.on('close', onRequestClose);
    if (request.socket) {
      attachSocket(request.socket);
    }
  });
}

function headerValue(headers, name) {
  const lower = name.toLowerCase();
  const keys = Object.keys(headers || {});
  for (const key of keys) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

function assertObjectMeta(objectMeta, expectedSize) {
  const headers = objectMeta?.headers || {};
  const statusCode = Number(objectMeta?.statusCode || 0);
  // Specific header checks run first so a 206/partial, an unexpected content
  // encoding or a broken Content-Length is reported deterministically with
  // its own code; the plain non-200 status check is the fallback.
  if (headerValue(headers, 'content-range') !== undefined) {
    throw verifyError('COS_VERIFY_PARTIAL_CONTENT', 'remote object returned a ranged/partial response');
  }
  const encoding = String(headerValue(headers, 'content-encoding') || 'identity').trim().toLowerCase();
  if (encoding !== '' && encoding !== 'identity') {
    throw verifyError('COS_VERIFY_CONTENT_ENCODING', 'remote object was returned with a non-identity content encoding');
  }
  // A non-200 response is the strongest signal and must be reported before
  // any header-shape noise (for example a missing Content-Length on a 404).
  if (statusCode !== 200) {
    throw verifyError('COS_VERIFY_HTTP_STATUS', 'remote object HTTP status is not exactly 200');
  }
  const contentLength = headerValue(headers, 'content-length');
  if (contentLength === undefined || contentLength === null || String(contentLength).trim() === '') {
    throw verifyError('COS_VERIFY_CONTENT_LENGTH_MISSING', 'remote object response omitted Content-Length');
  }
  if (String(contentLength).trim() !== String(expectedSize)) {
    throw verifyError('COS_VERIFY_CONTENT_LENGTH_MISMATCH', 'remote object Content-Length does not match the expected size');
  }
}

export async function verifyRemoteObject(cos, target, {rel, digest, size}, {
  env = process.env, hooks = {}, client, authMode = 'signed',
} = {}) {
  const key = buildObjectKey(target.prefix, rel);
  const maxBytes = target.maxObjectBytes;
  if (size > maxBytes) {
    throw verifyError('COS_VERIFY_SIZE_ABOVE_BOUND', 'expected size exceeds the locked object bound');
  }
  // One authenticated request, signed by the official COS getAuth primitive
  // and transported by Node http/https: holds the ClientRequest, response and
  // socket directly.  Ordinary outcomes require real socket-close evidence;
  // an exhausted teardown grace returns only the fail-closed unconfirmed code.
  const result = await performAuthenticatedGet({
    cos,
    target,
    key,
    size,
    maxBytes,
    deadlineMs: target.requestTimeoutMs,
    client,
    teardownGraceMs: Number(hooks && hooks.teardownGraceMs) || TEARDOWN_GRACE_MS,
    signed: authMode !== 'anonymous-public',
  });
  if (result.bytes !== size) {
    throw verifyError('COS_VERIFY_SIZE_MISMATCH', 'remote object byte count does not match the expected size');
  }
  if (result.hex !== digest) {
    throw verifyError('COS_VERIFY_HASH_MISMATCH', 'remote object SHA-256 does not match the expected digest');
  }
  return Object.freeze({ok: true});
}

export function resolveAuthMode(env = process.env) {
  const value = String(env.SHEIN_BI_COS_VERIFY_AUTH_MODE || 'signed').trim();
  if (!['signed', 'anonymous-public'].includes(value)) {
    throw verifyError('COS_CONFIG_AUTH_MODE_INVALID', 'remote verifier auth mode is invalid');
  }
  return value;
}

export function resolveCredentialPaths(env = process.env) {
  const authMode = resolveAuthMode(env);
  const secretFile = env.SHEIN_BI_COS_VERIFY_SECRET_FILE;
  const targetFile = env.SHEIN_BI_COS_VERIFY_TARGET_FILE;
  const targetShaLockFile = env.SHEIN_BI_COS_VERIFY_TARGET_SHA_FILE;
  if ((authMode === 'signed' && !secretFile) || !targetFile || !targetShaLockFile) {
    throw verifyError('COS_CREDENTIAL_PATH_MISSING', 'credential file paths are not configured');
  }
  return {authMode, secretFile, targetFile, targetShaLockFile};
}

const CONFIG_CODE_PREFIXES = ['COS_CREDENTIAL', 'COS_SECRET_', 'COS_TARGET_', 'COS_CONFIG_', 'COS_REL_KEY_', 'COS_DIGEST_', 'COS_SIZE_', 'COS_USAGE'];

function isConfigCode(code) {
  return CONFIG_CODE_PREFIXES.some((prefix) => code.startsWith(prefix));
}

export async function runMain({
  argv = [],
  env = process.env,
  out = process.stdout,
  err = process.stderr,
  cosFactory = createLockedCos,
  hooks = {},
  client,
} = {}) {
  const args = Array.from(argv || []);
  if (args.length === 1 && args[0] === '--check-config') {
    try {
      const paths = resolveCredentialPaths(env);
      if (paths.authMode === 'anonymous-public') {
        await loadLockedTarget({...paths, env, hooks});
      } else {
        await loadLockedTargetAndSecret({...paths, env, hooks});
      }
      out.write('check-config ok\n');
      return {code: EXIT_OK, ok: true, mode: 'check-config'};
    } catch (error) {
      const code = error?.code || 'COS_CONFIG_CHECK_FAILED';
      err.write('cos-verify-error code=' + code + '\n');
      return {code: EXIT_CONFIG, ok: false, mode: 'check-config', errorCode: code};
    }
  }
  let request;
  try {
    request = parseRemoteVerifyArgs(args);
  } catch (error) {
    const code = error?.code || 'COS_USAGE';
    err.write('cos-verify-error code=' + code + '\n');
    return {code: EXIT_USAGE, ok: false, errorCode: code};
  }
  try {
    const paths = resolveCredentialPaths(env);
    const loaded = paths.authMode === 'anonymous-public'
      ? await loadLockedTarget({...paths, env, hooks})
      : await loadLockedTargetAndSecret({...paths, env, hooks});
    const cos = paths.authMode === 'anonymous-public'
      ? {options: {Protocol: isTestMode(env) && loaded.target.domain ? 'http:' : 'https:'}}
      : (cosFactory || createLockedCos)(loaded.target, loaded.secret);
    await verifyRemoteObject(cos, loaded.target, {rel: request.rel, digest: request.digest, size: request.size}, {
      env, hooks, client, authMode: paths.authMode,
    });
    out.write('remote-ok ' + request.digest + ' ' + request.size + '\n');
    return {code: EXIT_OK, ok: true, mode: 'verify'};
  } catch (error) {
    const code = error?.code || 'COS_VERIFY_UNKNOWN';
    err.write('cos-verify-error code=' + code + '\n');
    if (isConfigCode(code)) return {code: EXIT_CONFIG, ok: false, errorCode: code};
    return {code: EXIT_VERIFY_FAILED, ok: false, errorCode: code};
  }
}

export function isMainUrl(moduleUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(path.resolve(entry)).href === moduleUrl;
  } catch (error) {
    return false;
  }
}

if (isMainUrl(import.meta.url)) {
  const result = await runMain({argv: process.argv.slice(2)});
  process.exitCode = result.code;
}
