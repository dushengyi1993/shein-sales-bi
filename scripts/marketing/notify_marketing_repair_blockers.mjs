#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildMarketingRepairBlockerNotice} from '../../lib/marketing_repair_blocker_notice.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const args = {date: '', result: '', logFile: '', dryRun: false};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--date') args.date = argv[++i] || '';
    else if (arg === '--result') args.result = argv[++i] || '';
    else if (arg === '--log-file') args.logFile = argv[++i] || '';
    else if (arg === '--dry-run') args.dryRun = true;
  }
  if (!args.result) throw new Error('Missing --result');
  return args;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd: ROOT, stdio: 'inherit'});
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`notification exited ${code}`)));
  });
}

const args = parseArgs(process.argv.slice(2));
const resultPath = path.resolve(ROOT, args.result);
const report = JSON.parse(await fs.readFile(resultPath, 'utf8'));
const notice = buildMarketingRepairBlockerNotice(report);
if (!notice.rows.length) {
  console.log(JSON.stringify({ok: true, skipped: true, reason: 'no terminal blockers'}));
  process.exit(0);
}
const fingerprint = crypto.createHash('sha256')
  .update(JSON.stringify(notice.rows))
  .digest('hex')
  .slice(0, 20);
const notifyArgs = [
  'scripts/notify_sync_issue.mjs',
  '--kind', 'marketing',
  '--mode', 'limited-discount-fallback',
  '--date', args.date || String(report.date || ''),
  '--title', notice.title,
  '--message', notice.message,
  '--log-file', args.logFile,
  '--idempotency-key', `marketing-repair-blocked-${args.date || report.date || 'unknown'}-${fingerprint}`,
  '--force',
];
if (args.dryRun) notifyArgs.push('--dry-run');
await run(process.execPath, notifyArgs);
