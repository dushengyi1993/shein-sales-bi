#!/usr/bin/env node
// Anonymous COS backup-privacy acceptance probe.
//
// After a Bucket is privatized this probe proves the two terminal gates on
// the canonical origin only:
//   1. an unauthenticated ListBucket must be exactly HTTP 403;
//   2. an unauthenticated Range GET of a known non-empty object must be
//      exactly HTTP 403.
//
// The probe never uses the verifier credentials and performs NO authenticated
// requests.  It reads the same root-only locked target (Bucket/Region/prefix/
// probe key) so it always hits the canonical origin the authenticated
// verifier signs against.  Production forces HTTPS; plain HTTP is allowed
// only in explicit test mode against a loopback origin.  Output is strictly
// sanitized: booleans, raw HTTP status codes and a target fingerprint (a
// SHA-256 of the canonical identity).  Bucket names, region, host, object
// keys, URLs and response bodies are never written to stdout or stderr, and
// a response body is never drained.
import http from 'node:http';
import https from 'node:https';

import {
  EXIT_CONFIG,
  EXIT_OK,
  EXIT_USAGE,
  buildObjectKey,
  loadLockedTarget,
  resolveCredentialPaths,
  resolveOriginHost,
  sha256Hex,
} from './verify_cos_backup_remote.mjs';

function probeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function buildProbeUrls(target, protocol) {
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw probeError('COS_PROBE_PROTOCOL_INVALID');
  }
  const scheme = protocol;
  const host = resolveOriginHost(target);
  // The probe object key is a RELATIVE key under the locked prefix.  It is
  // composed with the exact same buildObjectKey the verifier uses, so the
  // anonymous probe can never hit a different object than the one the
  // authenticated verifier would read.
  const objectKey = buildObjectKey(target.prefix, target.probeObjectKey);
  const listUrl = scheme + '//' + host + '/';
  const objectUrl = scheme + '//' + host + '/' + objectKey;
  return Object.freeze({host, listUrl, objectUrl, objectKey});
}

// Performs one anonymous GET with a fully closed lifecycle and NO credential.
// The status code is captured from the response headers and the response is
// destroyed immediately (a hostile provider body is never drained).  The
// ClientRequest's real client socket is captured and held; every outcome
// (headers, request error, shared request deadline) is torn down FIRST and then
// delivered as an ordinary result only after that real socket emitted 'close'
// (a response/request-level close is never treated as a socket close).  If the bounded grace
// expires without a close the result carries an explicit fail-closed
// teardownUnconfirmed marker -- never a fabricated status.  The two probe
// requests share ONE request deadline via deadlineAt; teardown has a separate
// bounded grace and may therefore finish after that deadline.
const PRIVACY_GRACE_MS = 2000;

export function anonymousGetStatus(url, {headers = {}, deadlineAt = null, timeoutMs, client, hooks = {}} = {}) {
  return new Promise((resolve) => {
    const fallbackTimeout = Number.isFinite(Number(timeoutMs)) ? Math.max(1000, Number(timeoutMs)) : 30000;
    const remaining = deadlineAt !== null ? Math.max(0, deadlineAt - Date.now()) : fallbackTimeout;
    if (remaining <= 0) {
      resolve({statusCode: 0, requestError: true, timedOut: true});
      return;
    }
    const graceMs = Number(hooks.teardownGraceMs) || PRIVACY_GRACE_MS;
    let settled = false;
    let request = null;
    let response = null;
    let socket = null;
    let sawResponse = false;
    // The first business outcome is immutable.  A later response/error/deadline
    // may only trigger teardown again or provide close evidence; it cannot
    // replace this value.
    let terminal = null;
    let deadlineTimer = null;
    let teardownTimer = null;
    const socketSignal = {closed: false};
    const requestSignal = {closed: false};
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(teardownTimer);
      if (request) {
        request.removeListener('error', onError);
        request.removeListener('response', onResponse);
        request.removeListener('socket', onSocketAssigned);
        request.removeListener('close', onRequestClose);
      }
      if (socket && typeof socket.removeListener === 'function') {
        socket.removeListener('close', onSocketClose);
      }
      resolve(value);
    };
    const teardown = () => {
      try { if (response && typeof response.destroy === 'function') response.destroy(); } catch (ignored) {}
      try { if (request && typeof request.destroy === 'function') request.destroy(); } catch (ignored) {}
      try { if (socket && typeof socket.destroy === 'function') socket.destroy(); } catch (ignored) {}
    };
    const unrefAll = () => {
      try { if (response && typeof response.unref === 'function') response.unref(); } catch (ignored) {}
      try { if (request && typeof request.unref === 'function') request.unref(); } catch (ignored) {}
      try { if (socket && typeof socket.unref === 'function') socket.unref(); } catch (ignored) {}
    };
    const failClosedTeardownValue = () => ({
      statusCode: 0,
      requestError: true,
      timedOut: Boolean(terminal && terminal.value && terminal.value.timedOut),
      teardownUnconfirmed: true,
    });
    const startTeardownGrace = () => {
      if (settled || teardownTimer !== null) return;
      teardownTimer = setTimeout(() => {
        // Grace expiry is not socket-close evidence.  It always zeros the
        // status and reports an explicit fail-closed teardown marker.
        teardown();
        unrefAll();
        done(failClosedTeardownValue());
      }, graceMs);
    };
    const attachSocket = (sock) => {
      if (!sock || settled || socket) return;
      socket = sock;
      if (typeof sock.once === 'function') sock.once('close', onSocketClose);
      if (terminal) {
        try { if (typeof sock.destroy === 'function') sock.destroy(); } catch (ignored) {}
      }
    };
    const refreshSocketFromRequest = () => {
      if (!socket && request && request.socket) attachSocket(request.socket);
    };
    const maybeFinish = () => {
      if (settled || !terminal) return;
      refreshSocketFromRequest();
      if (socket) {
        if (!socketSignal.closed) return;
      } else {
        if (!requestSignal.closed) return;
        // A response proves that a socket existed.  If it was never observable,
        // request close cannot substitute for the missing socket-close proof.
        if (sawResponse) {
          done(failClosedTeardownValue());
          return;
        }
        // ClientRequest close with request.socket still absent is the provable
        // no-socket allocation path allowed to settle on request close.
      }
      done(terminal.value);
    };
    const freezeOutcome = (kind, value) => {
      if (settled || terminal) return false;
      terminal = {kind, value};
      refreshSocketFromRequest();
      teardown();
      startTeardownGrace();
      maybeFinish();
      return true;
    };
    const onRequestClose = () => {
      requestSignal.closed = true;
      if (settled) return;
      refreshSocketFromRequest();
      if (!terminal) {
        freezeOutcome('error', {statusCode: 0, requestError: true, timedOut: false});
        return;
      }
      maybeFinish();
    };
    const onSocketClose = () => {
      socketSignal.closed = true;
      if (settled) return;
      if (!terminal) {
        freezeOutcome('error', {statusCode: 0, requestError: true, timedOut: false});
        return;
      }
      maybeFinish();
    };
    const onSocketAssigned = (sock) => {
      attachSocket(sock);
      maybeFinish();
    };
    const onError = () => {
      if (settled) return;
      if (freezeOutcome('error', {statusCode: 0, requestError: true, timedOut: false})) return;
      teardown();
      maybeFinish();
    };
    const onResponse = (res) => {
      if (settled) return;
      response = res;
      sawResponse = true;
      refreshSocketFromRequest();
      if (terminal) {
        // A response that loses the race to timeout/error is teardown evidence
        // only.  In particular, a late 403 cannot overwrite status 0.
        teardown();
        maybeFinish();
        return;
      }
      const statusCode = Number(res.statusCode) || 0;
      // Response headers freeze the business outcome.  If the shared deadline
      // fires while socket close is delayed, it may reassert teardown but does
      // not overwrite this already-selected status.
      freezeOutcome('response', {statusCode, requestError: statusCode === 0, timedOut: false});
    };
    deadlineTimer = setTimeout(() => {
      if (freezeOutcome('timeout', {statusCode: 0, requestError: true, timedOut: true})) return;
      // The first business outcome owns semantics.  For a prior response this
      // deadline is only an additional teardown guard.
      teardown();
      maybeFinish();
    }, remaining);
    try {
      // Use exactly one response registration source.  Passing a callback to
      // get() and also listening for 'response' would process every real Node
      // response twice.
      request = (client || (url.startsWith('https:') ? https : http)).get(url, {headers, agent: false});
    } catch (error) {
      done({statusCode: 0, requestError: true});
      return;
    }
    if (!request || typeof request.on !== 'function') {
      done({statusCode: 0, requestError: true});
      return;
    }
    request.on('error', onError);
    request.on('response', onResponse);
    request.on('close', onRequestClose);
    request.on('socket', onSocketAssigned);
    if (request.socket) attachSocket(request.socket);
  });
}

export function targetFingerprint(target) {
  return sha256Hex(JSON.stringify({
    bucket: target.bucket,
    region: target.region,
    domain: target.domain,
    prefix: target.prefix,
    probeObjectKey: target.probeObjectKey,
  }));
}

export async function probePrivacy({target, protocol, client, timeoutMs, testMode = false, hooks = {}}) {
  if (protocol === 'http:' && !testMode) {
    throw probeError('COS_PROBE_HTTPS_REQUIRED');
  }
  const urls = buildProbeUrls(target, protocol);
  // Both anonymous requests share ONE request deadline.  A selected outcome
  // may extend beyond it only while the independent teardown grace waits for
  // real socket-close evidence.
  const deadlineAt = Date.now() + Math.max(0, Number(timeoutMs) || 30000);
  const listStatus = await anonymousGetStatus(urls.listUrl, {
    headers: {Accept: 'application/xml', Connection: 'close'},
    deadlineAt,
    client,
    hooks,
  });
  const objectStatus = await anonymousGetStatus(urls.objectUrl, {
    headers: {Accept: '*/*', Range: 'bytes=0-0', Connection: 'close'},
    deadlineAt,
    client,
    hooks,
  });
  const closed = (state) => state.statusCode === 403
    && !state.requestError && !state.timedOut && !state.teardownUnconfirmed;
  return Object.freeze({
    ok: closed(listStatus) && closed(objectStatus),
    checks: [
      closed(listStatus) ? 'anonymous-list-403' : 'anonymous-list-not-closed',
      closed(objectStatus) ? 'anonymous-range-get-403' : 'anonymous-range-get-not-closed',
    ],
    anonymousListBucketStatus: listStatus.statusCode,
    anonymousObjectRangeGetStatus: objectStatus.statusCode,
    targetFingerprint: targetFingerprint(target),
  });
}

const EXIT_VERIFY_FAILED = 1;

export async function runPrivacyProbe({env = process.env, out = process.stdout, err = process.stderr, client, hooks = {}} = {}) {
  let protocol = String(env.SHEIN_BI_COS_VERIFY_PROBE_PROTOCOL || 'https:');
  if (protocol === 'http:') {
    // Plain HTTP is a test-only transport.  Production must always use TLS
    // so an unauthenticated probe cannot be answered by an on-path MITM.
    if (String(env.SHEIN_BI_COS_VERIFY_TEST_MODE || '') !== '1') {
      err.write('cos-probe-error code=COS_PROBE_HTTPS_REQUIRED\n');
      return {code: EXIT_CONFIG, ok: false, errorCode: 'COS_PROBE_HTTPS_REQUIRED'};
    }
  } else if (protocol !== 'https:') {
    err.write('cos-probe-error code=COS_PROBE_PROTOCOL_INVALID\n');
    return {code: EXIT_CONFIG, ok: false, errorCode: 'COS_PROBE_PROTOCOL_INVALID'};
  }
  const targetFile = env.SHEIN_BI_COS_VERIFY_TARGET_FILE;
  const targetShaLockFile = env.SHEIN_BI_COS_VERIFY_TARGET_SHA_FILE;
  if (!targetFile || !targetShaLockFile) {
    err.write('cos-probe-error code=COS_CREDENTIAL_PATH_MISSING\n');
    return {code: EXIT_CONFIG, ok: false, errorCode: 'COS_CREDENTIAL_PATH_MISSING'};
  }
  let loaded;
  try {
    loaded = await loadLockedTarget({targetFile, targetShaLockFile, env});
  } catch (error) {
    const code = error?.code || 'COS_CONFIG_CHECK_FAILED';
    err.write('cos-probe-error code=' + code + '\n');
    return {code: EXIT_CONFIG, ok: false, errorCode: code};
  }
  const timeoutMs = Math.min(60_000, loaded.target.requestTimeoutMs);
  const testMode = String(env.SHEIN_BI_COS_VERIFY_TEST_MODE || '') === '1';
  const result = await probePrivacy({target: loaded.target, protocol, client, timeoutMs, testMode, hooks});
  out.write(JSON.stringify(result, null, 2) + '\n');
  return {code: result.ok ? EXIT_OK : EXIT_VERIFY_FAILED, ok: result.ok};
}

// resolveCredentialPaths is imported so its contract stays in one place; the
// probe deliberately does NOT require the secret file.
void resolveCredentialPaths;

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1].replace(/\\/g, '/')).href) {
  const result = await runPrivacyProbe();
  process.exitCode = result.code;
}
