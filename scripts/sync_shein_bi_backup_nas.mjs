#!/usr/bin/env node
// Copy one verified half-managed (shein-bi) database archive to the independent NAS disk.
// Adapted from the full-managed sync proven on 2026-09-05; same protocol and hardening.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const BACKUP_ROOT = '/srv/shein-bi/backups/auto';
const RUNTIME = '/srv/shein-bi/runtime/backup-nas-sync';
const KEY = '/srv/shein-bi/secrets/backup-nas-sync/id_ed25519';
const HOSTS = '/srv/shein-bi/secrets/backup-nas-sync/known_hosts';
const RECEIVER = '/usr/bin/python3 /home/dushengyi/.local/libexec/shein-bi-backup-receiver.py';
const REMOTE = 'dushengyi@192.168.1.59';
const DB_CONTAINER = 'shein-warehouse-db';
const MEMBER = 'shein_bi.dump';
const STAMP = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/;
const MAX_BYTES = 100 * 1024 ** 3;
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

export function parseArgs(argv) {
  const args = { execute: false, source: null, latest: false };
  for (const arg of argv) {
    if (arg === '--execute' && !args.execute) args.execute = true;
    else if (arg === '--latest-completed' && !args.latest) args.latest = true;
    else if (arg.startsWith('--source=') && !args.source) args.source = arg.slice(9);
    else fail('ARGUMENT_INVALID');
  }
  if (Number(Boolean(args.source)) + Number(args.latest) !== 1) fail('SOURCE_REQUIRED');
  return args;
}

export function validateSourceDir(source, root = BACKUP_ROOT) {
  if (typeof source !== 'string' || path.dirname(source) !== root
      || !STAMP.test(path.basename(source))) fail('SOURCE_PATH_INVALID');
  return source;
}

export async function latestCompleted(root = BACKUP_ROOT) {
  const names = (await fs.readdir(root)).filter((n) => STAMP.test(n)).sort();
  if (!names.length) fail('NO_COMPLETED_BACKUP');
  return path.join(root, names.at(-1));
}

function signature(st) {
  return [st.dev, st.ino, st.size, st.mtimeNs, st.ctimeNs].map(String).join(':');
}

export async function openSnapshot(sourceDir, root = BACKUP_ROOT) {
  validateSourceDir(sourceDir, root);
  if (await fs.realpath(root) !== root) fail('SOURCE_ROOT_SYMLINK');
  const stamp = path.basename(sourceDir);
  const source = path.join(sourceDir, MEMBER);
  const dirStat = await fs.lstat(sourceDir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) fail('SOURCE_DIR_INVALID');
  const handle = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await handle.stat({ bigint: true });
    if (!st.isFile() || st.size <= 0n || st.size > BigInt(MAX_BYTES)) fail('SOURCE_INVALID');
    const head = Buffer.alloc(5);
    await handle.read(head, 0, 5, 0);
    if (head.toString() !== 'PGDMP') fail('ARCHIVE_MAGIC_INVALID');
    const expected = signature(st);
    const assertUnchanged = async () => {
      const [opened, named] = await Promise.all([
        handle.stat({ bigint: true }), fs.lstat(source, { bigint: true }),
      ]);
      if (!named.isFile() || signature(opened) !== expected || signature(named) !== expected) {
        fail('SOURCE_CHANGED');
      }
    };
    const stream = () => {
      let position = 0n;
      const total = st.size;
      const CHUNK_SIZE = 64 * 1024;
      let reading = false;
      return new Readable({
        async read(size) {
          if (reading) return;
          if (position >= total) { this.push(null); return; }
          reading = true;
          try {
            const want = BigInt(size && size > 0 ? size : CHUNK_SIZE);
            const remain = total - position;
            const toRead = remain < want ? Number(remain) : Number(want);
            const buf = Buffer.allocUnsafe(toRead);
            const { bytesRead } = await handle.read(buf, 0, toRead, position);
            if (bytesRead === 0) { this.push(null); return; }
            position += BigInt(bytesRead);
            this.push(buf.subarray(0, bytesRead));
          } catch (err) { this.destroy(err); } finally { reading = false; }
        },
      });
    };
    const hash = async () => {
      const h = createHash('sha256');
      for await (const chunk of stream()) h.update(chunk);
      await assertUnchanged();
      return h.digest('hex');
    };
    return { handle, stream, hash, assertUnchanged, name: 'shein-bi-' + stamp + '.dump', bytes: Number(st.size) };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function transferChild(executable, args, snapshot, header = null, spawnImpl = spawn) {
  const child = spawnImpl(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
  let output = '';
  let overflow = false;
  const timer = setTimeout(() => child.kill('SIGKILL'), 15 * 60 * 1000);
  child.stdout.on('data', (chunk) => {
    if (header && Buffer.byteLength(output) + chunk.length <= 8192) output += chunk.toString('utf8');
    else if (header) { overflow = true; child.kill('SIGKILL'); }
  });
  child.stderr.on('data', () => {});
  const terminal = new Promise((resolve) => {
    child.once('error', () => resolve(-1));
    child.once('close', (code) => resolve(code));
  });
  try {
    if (header) child.stdin.write(JSON.stringify(header) + '\n');
    try { await pipeline(snapshot.stream(), child.stdin); }
    catch (error) {
      if (header === null && ['EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error?.code)
          && await terminal === 0) {
        await snapshot.assertUnchanged();
        return '';
      }
      child.kill('SIGKILL'); await terminal; fail('TRANSFER_FAILED');
    }
    if (await terminal !== 0 || overflow) fail('CHILD_FAILED');
    await snapshot.assertUnchanged();
    return output;
  } finally { clearTimeout(timer); }
}

export function validateReceipt(text, manifest) {
  let result;
  try { result = JSON.parse(text); } catch { fail('RECEIPT_INVALID'); }
  if (result?.ok !== true || !['copied', 'already_present'].includes(result.state)
      || result.name !== manifest.name || result.bytes !== manifest.bytes
      || result.sha256 !== manifest.sha256) fail('RECEIPT_MISMATCH');
  return { ok: true, state: result.state, name: manifest.name, bytes: manifest.bytes, sha256: manifest.sha256 };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceDir = args.latest ? await latestCompleted() : args.source;
  let lock;
  let snapshot;
  try {
    if (args.execute) {
      await fs.mkdir(RUNTIME, { recursive: true, mode: 0o700 });
      const runtimeStat = await fs.lstat(RUNTIME);
      if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()
          || runtimeStat.uid !== 0 || await fs.realpath(RUNTIME) !== RUNTIME) fail('RUNTIME_UNSAFE');
      lock = await fs.open(path.join(RUNTIME, 'sync.lock'), 'wx', 0o600);
    }
    snapshot = await openSnapshot(sourceDir);
    const manifest = { version: 1, name: snapshot.name, bytes: snapshot.bytes, sha256: await snapshot.hash() };
    if (!args.execute) {
      console.log(JSON.stringify({ ok: true, mode: 'DRY_RUN', ...manifest, archiveVerified: false, transferred: false }));
      return;
    }
    for (const file of [KEY, HOSTS]) {
      const st = await fs.lstat(file);
      if (!st.isFile() || st.isSymbolicLink() || (file === KEY && (st.mode & 0o077))) fail('SSH_FILE_INVALID');
    }
    await transferChild('/usr/bin/docker', ['exec', '-i', DB_CONTAINER, 'pg_restore', '--list'], snapshot);
    const reply = await transferChild('/usr/bin/ssh', [
      '-F', '/dev/null', '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
      '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + HOSTS,
      '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-i', KEY,
      REMOTE, RECEIVER,
    ], snapshot, manifest);
    const receipt = validateReceipt(reply, manifest);
    if (await snapshot.hash() !== manifest.sha256) fail('SOURCE_CHANGED_AFTER_TRANSFER');
    const output = { ...receipt, archiveVerified: true, completedAt: new Date().toISOString() };
    const temp = path.join(RUNTIME, 'latest.' + process.pid + '.tmp');
    const fd = await fs.open(temp, 'wx', 0o600);
    try { await fd.writeFile(JSON.stringify(output) + '\n'); await fd.sync(); }
    finally { await fd.close(); }
    await fs.rename(temp, path.join(RUNTIME, 'latest.json'));
    const directory = await fs.open(RUNTIME, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await directory.sync(); } finally { await directory.close(); }
    console.log(JSON.stringify(output));
  } finally {
    await snapshot?.handle.close();
    if (lock) { await lock.close(); await fs.unlink(path.join(RUNTIME, 'sync.lock')); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const allowed = /^(ARGUMENT_INVALID|SOURCE_REQUIRED|SOURCE_PATH_INVALID|SOURCE_ROOT_SYMLINK|SOURCE_DIR_INVALID|SOURCE_INVALID|ARCHIVE_MAGIC_INVALID|SOURCE_CHANGED|TRANSFER_FAILED|CHILD_FAILED|RECEIPT_INVALID|RECEIPT_MISMATCH|NO_COMPLETED_BACKUP|SSH_FILE_INVALID|SOURCE_CHANGED_AFTER_TRANSFER|RUNTIME_UNSAFE)$/;
    console.error(JSON.stringify({ ok: false, errorCode: allowed.test(error?.code) ? error.code : 'BACKUP_NAS_SYNC_FAILED' }));
    process.exitCode = 1;
  });
}


