#!/usr/bin/env node
import crypto from 'node:crypto';
import {constants as fsConstants} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const DEFAULT_BI_SESSION_SECRET_FILE = '/data/shein-bi/state/bi_portal_session_secret.local';
export const BI_SESSION_SECRET_MIN_LENGTH = 32;
export const BI_SESSION_SECRET_MAX_LENGTH = 256;

const SECRET_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${BI_SESSION_SECRET_MIN_LENGTH},${BI_SESSION_SECRET_MAX_LENGTH}}$`, 'u');
const CREATION_SETTLE_ATTEMPTS = 40;
const CREATION_SETTLE_DELAY_MS = 25;

export class BiSessionSecretError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'BiSessionSecretError';
    this.code = code;
    this.detail = Object.freeze({...detail});
  }
}

function effectiveUid() {
  return typeof process.geteuid === 'function' ? process.geteuid() : null;
}

function sameResolvedPath(left, right, platform = process.platform) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function fileIdentityMatches(left, right) {
  if (!left || !right) return false;
  if (Number.isInteger(left.dev) && Number.isInteger(right.dev)
      && Number.isInteger(left.ino) && Number.isInteger(right.ino)) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return true;
}

function errorForFs(operation, file, error) {
  if (error?.code === 'ENOENT') {
    return new BiSessionSecretError(
      'BI_SESSION_SECRET_MISSING',
      `BI session secret is missing: ${file}; run shein-bi-session-secret.service before starting the runtime`,
      {file, operation},
    );
  }
  return new BiSessionSecretError(
    'BI_SESSION_SECRET_IO_ERROR',
    `Cannot ${operation} BI session secret file: ${file}`,
    {file, operation, fsCode: String(error?.code || '')},
  );
}

export function validateBiSessionSecretText(raw, file = '') {
  if (typeof raw !== 'string') {
    throw new BiSessionSecretError(
      'BI_SESSION_SECRET_INVALID',
      `BI session secret content is not text${file ? `: ${file}` : ''}`,
      {file, reason: 'not-text'},
    );
  }
  const secret = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  if (!SECRET_PATTERN.test(secret) || (raw !== secret && raw !== `${secret}\n`)) {
    throw new BiSessionSecretError(
      'BI_SESSION_SECRET_INVALID',
      `BI session secret content is invalid${file ? `: ${file}` : ''}`,
      {file, reason: 'content', length: secret.length},
    );
  }
  return secret;
}

export function validateBiSessionSecretParentStat(stat, {
  parent = '',
  platform = process.platform,
  euid = effectiveUid(),
} = {}) {
  if (!stat?.isDirectory?.()) {
    throw new BiSessionSecretError(
      'BI_SESSION_SECRET_PARENT_UNSAFE',
      `BI session secret parent is not a real directory${parent ? `: ${parent}` : ''}`,
      {parent, reason: 'not-directory'},
    );
  }
  if (platform !== 'win32') {
    const mode = Number(stat.mode) & 0o777;
    if ((mode & 0o002) !== 0) {
      throw new BiSessionSecretError(
        'BI_SESSION_SECRET_PARENT_UNSAFE',
        `BI session secret parent must not be world-writable${parent ? `: ${parent}` : ''}`,
        {parent, reason: 'world-writable', mode: mode.toString(8).padStart(4, '0')},
      );
    }
    if (Number.isInteger(euid) && Number.isInteger(stat.uid) && stat.uid !== 0 && stat.uid !== euid) {
      throw new BiSessionSecretError(
        'BI_SESSION_SECRET_PARENT_UNSAFE',
        `BI session secret parent has an unexpected owner${parent ? `: ${parent}` : ''}`,
        {parent, reason: 'owner', uid: stat.uid, expectedUid: euid},
      );
    }
  }
  return true;
}

export function validateBiSessionSecretFileStat(stat, {
  file = '',
  platform = process.platform,
  euid = effectiveUid(),
} = {}) {
  if (!stat?.isFile?.()) {
    throw new BiSessionSecretError(
      'BI_SESSION_SECRET_FILE_UNSAFE',
      `BI session secret path is not a regular file${file ? `: ${file}` : ''}`,
      {file, reason: 'not-regular'},
    );
  }
  if (Number.isInteger(stat.nlink) && stat.nlink !== 1) {
    throw new BiSessionSecretError(
      'BI_SESSION_SECRET_FILE_UNSAFE',
      `BI session secret must have exactly one filesystem link${file ? `: ${file}` : ''}`,
      {file, reason: 'link-count', nlink: stat.nlink},
    );
  }
  if (Number.isFinite(stat.size) && (stat.size < BI_SESSION_SECRET_MIN_LENGTH || stat.size > BI_SESSION_SECRET_MAX_LENGTH + 1)) {
    throw new BiSessionSecretError(
      'BI_SESSION_SECRET_INVALID',
      `BI session secret file size is invalid${file ? `: ${file}` : ''}`,
      {file, reason: 'size', size: stat.size},
    );
  }
  if (platform !== 'win32') {
    const mode = Number(stat.mode) & 0o777;
    if (mode !== 0o600) {
      throw new BiSessionSecretError(
        'BI_SESSION_SECRET_PERMISSIONS_INVALID',
        `BI session secret permissions must be exactly 0600${file ? `: ${file}` : ''}`,
        {file, reason: 'mode', mode: mode.toString(8).padStart(4, '0')},
      );
    }
    if (Number.isInteger(euid) && Number.isInteger(stat.uid) && stat.uid !== euid) {
      throw new BiSessionSecretError(
        'BI_SESSION_SECRET_PERMISSIONS_INVALID',
        `BI session secret owner does not match the runtime user${file ? `: ${file}` : ''}`,
        {file, reason: 'owner', uid: stat.uid, expectedUid: euid},
      );
    }
  }
  return true;
}

export async function assertSafeBiSessionSecretParent(file) {
  const resolved = path.resolve(String(file || ''));
  const parent = path.dirname(resolved);
  let stat;
  let real;
  try {
    stat = await fs.lstat(parent);
    real = await fs.realpath(parent);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new BiSessionSecretError(
        'BI_SESSION_SECRET_PARENT_UNSAFE',
        `BI session secret parent does not exist: ${parent}`,
        {parent, reason: 'missing'},
      );
    }
    throw new BiSessionSecretError(
      'BI_SESSION_SECRET_PARENT_UNSAFE',
      `Cannot validate BI session secret parent: ${parent}`,
      {parent, reason: 'io', fsCode: String(error?.code || '')},
    );
  }
  validateBiSessionSecretParentStat(stat, {parent});
  // Windows realpath commonly expands 8.3 path components (for example
  // DUSHEN~1) even when no reparse point is involved. lstat already rejects a
  // symlink/junction parent there; exact realpath equality is enforced on the
  // Linux production host where it also detects symlinked ancestors.
  if (process.platform !== 'win32' && !sameResolvedPath(real, parent)) {
    throw new BiSessionSecretError(
      'BI_SESSION_SECRET_PARENT_UNSAFE',
      `BI session secret parent must not traverse a symlink: ${parent}`,
      {parent, reason: 'symlink'},
    );
  }
  return parent;
}

function readOpenFlags() {
  const noFollow = process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW || 0);
  return fsConstants.O_RDONLY | noFollow;
}

function createOpenFlags() {
  const noFollow = process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW || 0);
  return fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow;
}

export async function loadBiSessionSecret(file) {
  const resolved = path.resolve(String(file || ''));
  await assertSafeBiSessionSecretParent(resolved);
  let before;
  try {
    before = await fs.lstat(resolved);
  } catch (error) {
    throw errorForFs('inspect', resolved, error);
  }
  validateBiSessionSecretFileStat(before, {file: resolved});

  let handle;
  try {
    handle = await fs.open(resolved, readOpenFlags());
    const opened = await handle.stat();
    validateBiSessionSecretFileStat(opened, {file: resolved});
    if (!fileIdentityMatches(before, opened)) {
      throw new BiSessionSecretError(
        'BI_SESSION_SECRET_FILE_UNSAFE',
        `BI session secret changed while opening: ${resolved}`,
        {file: resolved, reason: 'identity-race'},
      );
    }
    return validateBiSessionSecretText(await handle.readFile('utf8'), resolved);
  } catch (error) {
    if (error instanceof BiSessionSecretError) throw error;
    throw errorForFs('read', resolved, error);
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function biSessionSecretFingerprint(secret) {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

async function syncParentDirectory(parent) {
  if (process.platform === 'win32') return;
  const handle = await fs.open(parent, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function cleanupOwnedCreation(file, identity) {
  try {
    const current = await fs.lstat(file);
    if (fileIdentityMatches(identity, current)) await fs.unlink(file);
  } catch {}
}

async function loadSettledCreation(file) {
  let lastError = null;
  for (let attempt = 0; attempt < CREATION_SETTLE_ATTEMPTS; attempt += 1) {
    try {
      return await loadBiSessionSecret(file);
    } catch (error) {
      lastError = error;
      const transient = error?.code === 'BI_SESSION_SECRET_MISSING'
        || (error?.code === 'BI_SESSION_SECRET_INVALID'
          && ['size', 'content'].includes(error?.detail?.reason));
      if (!transient) throw error;
      await new Promise(resolve => setTimeout(resolve, CREATION_SETTLE_DELAY_MS));
    }
  }
  throw lastError;
}

export async function provisionBiSessionSecret(file = DEFAULT_BI_SESSION_SECRET_FILE) {
  const resolved = path.resolve(String(file || DEFAULT_BI_SESSION_SECRET_FILE));
  const parent = await assertSafeBiSessionSecretParent(resolved);
  try {
    const secret = await loadBiSessionSecret(resolved);
    return Object.freeze({file: resolved, created: false, secret, fingerprint: biSessionSecretFingerprint(secret)});
  } catch (error) {
    if (error?.code === 'BI_SESSION_SECRET_INVALID'
        && ['size', 'content'].includes(error?.detail?.reason)) {
      const secret = await loadSettledCreation(resolved);
      return Object.freeze({file: resolved, created: false, secret, fingerprint: biSessionSecretFingerprint(secret)});
    }
    if (error?.code !== 'BI_SESSION_SECRET_MISSING') throw error;
  }

  const generated = crypto.randomBytes(48).toString('base64url');
  let handle;
  let createdIdentity = null;
  try {
    handle = await fs.open(resolved, createOpenFlags(), 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const secret = await loadSettledCreation(resolved);
      return Object.freeze({file: resolved, created: false, secret, fingerprint: biSessionSecretFingerprint(secret)});
    }
    throw errorForFs('create', resolved, error);
  }

  try {
    await handle.chmod(0o600);
    createdIdentity = await handle.stat();
    await handle.writeFile(`${generated}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await syncParentDirectory(parent);
    const secret = await loadBiSessionSecret(resolved);
    if (secret !== generated) {
      throw new BiSessionSecretError(
        'BI_SESSION_SECRET_FILE_UNSAFE',
        `BI session secret readback did not match the created value: ${resolved}`,
        {file: resolved, reason: 'readback-mismatch'},
      );
    }
    return Object.freeze({file: resolved, created: true, secret, fingerprint: biSessionSecretFingerprint(secret)});
  } catch (error) {
    await handle?.close().catch(() => {});
    await cleanupOwnedCreation(resolved, createdIdentity);
    throw error;
  }
}

function parseArgs(argv) {
  const args = {file: process.env.SHEIN_BI_SESSION_SECRET_FILE || DEFAULT_BI_SESSION_SECRET_FILE};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--file') args.file = argv[++index] || '';
    else throw new BiSessionSecretError('BI_SESSION_SECRET_ARGUMENT_INVALID', `Unknown argument: ${argv[index]}`);
  }
  if (!String(args.file || '').trim()) {
    throw new BiSessionSecretError('BI_SESSION_SECRET_ARGUMENT_INVALID', '--file requires a non-empty path');
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await provisionBiSessionSecret(args.file);
  console.log(JSON.stringify({
    ok: true,
    file: result.file,
    created: result.created,
    fingerprint: result.fingerprint,
    length: result.secret.length,
    permissions: '0600',
  }));
}

const IS_DIRECT_RUN = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_DIRECT_RUN) {
  main().catch(error => {
    console.error(JSON.stringify({
      ok: false,
      code: String(error?.code || 'BI_SESSION_SECRET_PROVISION_FAILED'),
      error: String(error?.message || error),
      detail: error?.detail && typeof error.detail === 'object' ? error.detail : undefined,
    }));
    process.exitCode = 1;
  });
}
