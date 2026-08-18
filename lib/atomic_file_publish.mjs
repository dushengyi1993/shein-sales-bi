import fs from 'node:fs/promises';
import path from 'node:path';

function tempPathFor(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  return path.join(dir, `.${base}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
}

async function enforceExactMetadata(handle, options) {
  // Apply ownership before the exact requested mode on the already-open
  // handle. chown may clear permission bits on POSIX, while the final chmod
  // prevents the caller's umask from silently narrowing published access.
  // Windows cannot represent real POSIX owners, so chown is attempted only
  // where the platform can honor it.
  const hasUid = options.uid !== undefined;
  const hasGid = options.gid !== undefined;
  if (hasUid !== hasGid) {
    throw new TypeError('atomic publish uid and gid must be supplied together');
  }
  if (hasUid && (!Number.isSafeInteger(options.uid) || options.uid < 0
    || !Number.isSafeInteger(options.gid) || options.gid < 0)) {
    throw new TypeError('atomic publish uid and gid must be non-negative integers');
  }
  if (process.platform !== 'win32' && hasUid) {
    await handle.chown(options.uid, options.gid);
  }
  if (options.mode !== undefined) await handle.chmod(options.mode);
}

async function verifyPublishedMetadata(handle, options) {
  if (process.platform === 'win32') return;
  const stat = await handle.stat();
  if (!stat.isFile() || stat.nlink !== 1) {
    throw new Error(`atomic publish temporary artifact is unsafe: regular=${stat.isFile()} nlink=${stat.nlink}`);
  }
  if (options.mode !== undefined && (stat.mode & 0o777) !== (options.mode & 0o777)) {
    throw new Error(`atomic publish mode readback mismatch: got=${(stat.mode & 0o777).toString(8)} want=${(options.mode & 0o777).toString(8)}`);
  }
  if (options.uid !== undefined && stat.uid !== options.uid) {
    throw new Error(`atomic publish uid readback mismatch: got=${stat.uid} want=${options.uid}`);
  }
  if (options.gid !== undefined && stat.gid !== options.gid) {
    throw new Error(`atomic publish gid readback mismatch: got=${stat.gid} want=${options.gid}`);
  }
}

async function fsyncDirectory(dir) {
  // Directory fsync makes the rename durable on POSIX filesystems. Windows does
  // not allow opening directories this way, where rename itself is the durable
  // boundary available to Node; ignore only that platform-specific limitation.
  if (process.platform === 'win32') return;
  const handle = await fs.open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Publish one complete file with a same-directory temporary file, fsync, and
 * rename. Readers therefore observe either the previous complete artifact or
 * the new complete artifact, never a partially written JSON/HTML payload.
 *
 * `beforeRename` is intentionally narrow and exists for deterministic fault
 * injection tests; production callers do not pass it.
 */
export async function writeFileAtomic(file, data, options = {}) {
  const target = path.resolve(file);
  const dir = path.dirname(target);
  const tmp = tempPathFor(target);
  await fs.mkdir(dir, {recursive: true});
  let handle;
  try {
    handle = await fs.open(tmp, 'wx', options.mode);
    await enforceExactMetadata(handle, options);
    await handle.writeFile(data, options.encoding);
    await handle.sync();
    await verifyPublishedMetadata(handle, options);
    await handle.close();
    handle = null;
    if (typeof options.beforeRename === 'function') await options.beforeRename(tmp, target);
    await fs.rename(tmp, target);
    await fsyncDirectory(dir);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(tmp, {force: true}).catch(() => {});
    throw error;
  }
}

export async function writeJsonFileAtomic(file, value, options = {}) {
  const spacing = options.spacing === undefined ? 2 : options.spacing;
  const suffix = options.trailingNewline === false ? '' : '\n';
  return writeFileAtomic(file, `${JSON.stringify(value, null, spacing)}${suffix}`, {
    ...options,
    encoding: 'utf8',
  });
}
