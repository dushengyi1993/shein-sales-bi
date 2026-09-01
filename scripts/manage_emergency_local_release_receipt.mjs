#!/usr/bin/env node
import path from 'node:path';

import {
  DEFAULT_EMERGENCY_LOCAL_RELEASE_FILE,
  verifyEmergencyLocalReleaseReceipt,
  writeEmergencyLocalReleaseReceipt,
} from '../lib/emergency_local_release_receipt.mjs';

function usage() {
  return [
    'usage:',
    '  manage_emergency_local_release_receipt.mjs create --bundle <file> --commit <40-hex> --baseline-commit <40-hex> --reason <text> [--cwd <checkout>] [--receipt-file <file>] [--created-at <ISO>] [--max-bundle-bytes <n>]',
    '  manage_emergency_local_release_receipt.mjs verify [--receipt-file <file>] [--bundle <file>] [--cwd <checkout>]',
  ].join('\n');
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function parseArgs(argv) {
  const command = String(argv[0] || '').trim().toLowerCase();
  if (!['create', 'verify'].includes(command)) fail('EMERGENCY_RECEIPT_USAGE', usage());
  const args = {
    command,
    receiptFile: process.env.SHEIN_BI_EMERGENCY_LOCAL_RELEASE_FILE || DEFAULT_EMERGENCY_LOCAL_RELEASE_FILE,
    bundleFile: '',
    commit: '',
    baselineCommit: '',
    reason: '',
    createdAt: undefined,
    cwd: process.cwd(),
    maxBundleBytes: undefined,
  };
  const allowed = new Set(command === 'create'
    ? ['--receipt-file', '--bundle', '--commit', '--baseline-commit', '--reason', '--created-at', '--cwd', '--max-bundle-bytes']
    : ['--receipt-file', '--bundle', '--cwd', '--max-bundle-bytes']);
  const seen = new Set();
  const withValue = new Set([
    '--receipt-file', '--bundle', '--commit', '--baseline-commit', '--reason', '--created-at', '--cwd', '--max-bundle-bytes',
  ]);
  for (let i = 1; i < argv.length; i += 1) {
    const option = argv[i];
    if (!allowed.has(option) || !withValue.has(option)) fail('EMERGENCY_RECEIPT_USAGE', `unknown or invalid option: ${option}\n${usage()}`);
    if (seen.has(option)) fail('EMERGENCY_RECEIPT_USAGE', `duplicate option: ${option}`);
    seen.add(option);
    if (i + 1 >= argv.length) fail('EMERGENCY_RECEIPT_USAGE', `missing value for ${option}`);
    const value = String(argv[++i]);
    if (option === '--receipt-file') args.receiptFile = path.resolve(value);
    else if (option === '--bundle') args.bundleFile = path.resolve(value);
    else if (option === '--commit') args.commit = value;
    else if (option === '--baseline-commit') args.baselineCommit = value;
    else if (option === '--reason') args.reason = value;
    else if (option === '--created-at') args.createdAt = value;
    else if (option === '--cwd') args.cwd = path.resolve(value);
    else if (option === '--max-bundle-bytes') {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed)) fail('EMERGENCY_RECEIPT_USAGE', '--max-bundle-bytes must be a safe integer');
      args.maxBundleBytes = parsed;
    }
  }
  if (command === 'create') {
    if (!args.bundleFile) fail('EMERGENCY_RECEIPT_USAGE', 'create requires --bundle');
    if (!args.commit) fail('EMERGENCY_RECEIPT_USAGE', 'create requires --commit');
    if (!args.baselineCommit) fail('EMERGENCY_RECEIPT_USAGE', 'create requires --baseline-commit');
    if (!args.reason) fail('EMERGENCY_RECEIPT_USAGE', 'create requires --reason');
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.command === 'create') {
    const created = await writeEmergencyLocalReleaseReceipt({
      receiptFile: args.receiptFile,
      bundleFile: args.bundleFile,
      commit: args.commit,
      baselineCommit: args.baselineCommit,
      reason: args.reason,
      createdAt: args.createdAt,
      cwd: args.cwd,
      maxBundleBytes: args.maxBundleBytes,
    });
    console.log(JSON.stringify({
      ok: true,
      mode: 'create',
      receiptFile: created.receiptFile,
      bundle: created.bundle,
      source: created.source,
      receipt: created.receipt,
      readback: {ok: created.readback.ok, bytesSha256: created.readback.bytesSha256},
    }, null, 2));
    return;
  }

  const verified = verifyEmergencyLocalReleaseReceipt({
    receiptFile: args.receiptFile,
    bundleFile: args.bundleFile,
    maxBundleBytes: args.maxBundleBytes,
    cwd: args.cwd,
    verifySource: true,
  });
  console.log(JSON.stringify({
    ok: verified.ok,
    mode: 'verify',
    file: verified.file,
    issues: verified.issues,
    receipt: verified.receipt,
    bundle: verified.bundle,
    bundleVerified: verified.bundleVerified,
    bundleVerification: verified.bundleVerification,
    source: verified.source,
  }, null, 2));
  if (!verified.ok) process.exitCode = 1;
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    errorCode: String(error?.code || 'EMERGENCY_RECEIPT_FAILED'),
    error: String(error?.message || error).slice(0, 500),
  }, null, 2));
  process.exitCode = 1;
}
