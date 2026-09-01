#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function parse(argv) {
  const args = {command: String(argv[0] || '').trim()};
  for (let i = 1; i < argv.length; i += 1) {
    const key = argv[i];
    const value = () => String(argv[++i] || '').trim();
    if (key === '--queue') args.queue = path.resolve(value());
    else if (key === '--result') args.result = path.resolve(value());
    else if (key === '--date') args.date = value();
    else if (key === '--expires-at') args.expiresAt = value();
    else if (key === '--reason') args.reason = value();
    else if (key === '--receipt') args.receipt = path.resolve(value());
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!['create', 'consume'].includes(args.command)) throw new Error('Usage: create|consume ...');
  if (!args.queue || !args.receipt) throw new Error('--queue and --receipt are required');
  if (args.command === 'create' && (!args.result || !args.date || !args.expiresAt || !args.reason)) throw new Error('create requires --result --date --expires-at --reason');
  return args;
}

async function regularBytes(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected regular non-symlink file: ${file}`);
  return fs.readFile(file);
}

function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function canonicalHash(payload) { return sha(Buffer.from(JSON.stringify(payload))); }
function assertSha(value, name) { if (!/^[a-f0-9]{64}$/.test(String(value || ''))) throw new Error(`${name} must be SHA-256`); }

async function atomicWrite(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {encoding: 'utf8', mode: 0o600});
  await fs.rename(temp, file);
}

const args = parse(process.argv.slice(2));
if (args.command === 'create') {
  const [queueBytes, resultBytes] = await Promise.all([regularBytes(args.queue), regularBytes(args.result)]);
  const queue = JSON.parse(queueBytes.toString('utf8').replace(/^\uFEFF/, ''));
  assertSha(queue?.queueFingerprint, 'queueFingerprint');
  assertSha(queue?.sourceGuardHash, 'sourceGuardHash');
  if (queue?.date !== args.date) throw new Error(`Queue date mismatch expected=${args.date} actual=${queue?.date || 'missing'}`);
  const createdAt = new Date();
  const expiresAt = new Date(args.expiresAt);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= createdAt || expiresAt.getTime() - createdAt.getTime() > 2 * 60 * 60_000) throw new Error('Receipt expiry must be in the future and no more than two hours');
  const payload = {
    schemaVersion: 1,
    date: args.date,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    reason: args.reason,
    queuePath: args.queue,
    queueStateSha256: sha(queueBytes),
    queueFingerprint: queue.queueFingerprint,
    sourceGuardHash: queue.sourceGuardHash,
    resultPath: args.result,
    resultSha256: sha(resultBytes),
  };
  const receipt = {...payload, canonicalHash: canonicalHash(payload)};
  await atomicWrite(args.receipt, receipt);
  console.log(JSON.stringify({ok: true, receipt: args.receipt, canonicalHash: receipt.canonicalHash, ...payload}, null, 2));
} else {
  const receiptBytes = await regularBytes(args.receipt);
  const receipt = JSON.parse(receiptBytes.toString('utf8').replace(/^\uFEFF/, ''));
  const {canonicalHash: storedHash, ...payload} = receipt;
  assertSha(storedHash, 'canonicalHash');
  if (canonicalHash(payload) !== storedHash) throw new Error('Resume receipt canonical hash mismatch');
  if (path.resolve(payload.queuePath || '') !== args.queue) throw new Error('Resume receipt queue path mismatch');
  const now = Date.now();
  const createdAt = Date.parse(payload.createdAt);
  const expiresAt = Date.parse(payload.expiresAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || createdAt > now + 60_000 || expiresAt <= now || expiresAt - createdAt > 2 * 60 * 60_000) throw new Error('Resume receipt is expired or has an invalid validity window');
  const [queueBytes, resultBytes] = await Promise.all([regularBytes(args.queue), regularBytes(path.resolve(payload.resultPath || ''))]);
  const queue = JSON.parse(queueBytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (sha(queueBytes) !== payload.queueStateSha256 || queue?.queueFingerprint !== payload.queueFingerprint || queue?.sourceGuardHash !== payload.sourceGuardHash || queue?.date !== payload.date) throw new Error('Resume receipt queue binding drift');
  if (sha(resultBytes) !== payload.resultSha256) throw new Error('Resume receipt result binding drift');
  const consumed = `${args.receipt}.consumed-${Date.now()}.json`;
  await fs.rename(args.receipt, consumed);
  console.log(JSON.stringify({ok: true, consumed, canonicalHash: storedHash, date: payload.date, queueStateSha256: payload.queueStateSha256, queueFingerprint: payload.queueFingerprint, sourceGuardHash: payload.sourceGuardHash, resultSha256: payload.resultSha256}, null, 2));
}
