import fs from 'node:fs/promises';
import path from 'node:path';

function tempPathFor(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  return path.join(dir, `.${base}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
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
    handle = await fs.open(tmp, 'w', options.mode);
    await handle.writeFile(data, options.encoding);
    await handle.sync();
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
