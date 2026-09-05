#!/usr/bin/env node
/**
 * Cloud CLI for staging a completed/partial business result and retrying pending deliveries.
 *
 * Usage:
 *   # Retry all pending deliveries in staging
 *   node scripts/cloud_team_report_delivery.mjs retry-pending [--landing-root <dir>]
 *
 *   # Stage and deliver an ops result from file
 *   node scripts/cloud_team_report_delivery.mjs stage-and-deliver \
 *     --automation-id <id> --business-date <YYYY-MM-DD> \
 *     --result-json <file> [--attachment-name <name>] [--attachment-file <file>]
 */
import {contractError} from '../lib/cloud_team_report_common.mjs';
import {
  cloudFailureResult,
  deliverCloudTeamReport,
} from '../lib/cloud_team_report_cloud.mjs';
import {
  stageAndDeliverBusinessResult,
  retryPendingBusinessDeliveries,
  OPS_BUSINESS_STAGING_ROOT,
} from '../lib/ops_business_result_pipeline.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  let command = '';
  let startIndex = 0;
  if (argv[0] && !argv[0].startsWith('--')) {
    command = argv[0];
    startIndex = 1;
  }
  const options = {command};
  for (let i = startIndex; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--automation-id') options.automationId = argv[++i];
    else if (arg === '--business-date') options.businessDate = argv[++i];
    else if (arg === '--result-json' || arg === '--business-result') options.resultJson = argv[++i];
    else if (arg === '--attachment-name') options.attachmentName = argv[++i];
    else if (arg === '--attachment-file') options.attachmentFile = argv[++i];
    else if (arg === '--landing-root') options.landingRoot = argv[++i];
  }
  if (!options.command && options.resultJson) {
    options.command = 'stage-and-deliver';
  }
  return options;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) throw contractError('INVALID_BUNDLE', 'cloud delivery stdin was empty');
  try {
    return JSON.parse(raw);
  } catch {
    throw contractError('INVALID_BUNDLE', 'cloud delivery stdin was not valid JSON');
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length) {
    throw contractError('INVALID_CLOUD_COMMAND', 'command required: deliver-stdin, retry-pending, or stage-and-deliver');
  }

  const opts = parseArgs(argv);
  const sub = opts.command || argv[0];
  if (sub === 'deliver-stdin') {
    const bundle = await readStdin();
    const result = await deliverCloudTeamReport({bundle});
    console.log(JSON.stringify(result, null, 2));
    return result.ok === true ? 0 : 1;
  }

  if (sub === 'retry-pending') {
    const opts = parseArgs(argv);
    const retried = await retryPendingBusinessDeliveries({
      landingRoot: opts.landingRoot || OPS_BUSINESS_STAGING_ROOT,
    });
    console.log(JSON.stringify({ok: true, retriedCount: retried.length, retried}, null, 2));
    return 0;
  }

  if (sub === 'stage-and-deliver') {
    const opts = parseArgs(argv);
    if (!opts.automationId || !opts.businessDate || !opts.resultJson) {
      throw contractError('INVALID_ARGUMENTS', 'stage-and-deliver requires --automation-id, --business-date, --result-json');
    }
    const resultContent = JSON.parse(await fs.readFile(opts.resultJson, 'utf8'));
    let attachmentContent;
    if (opts.attachmentFile) {
      attachmentContent = await fs.readFile(opts.attachmentFile);
    }
    const outcome = await stageAndDeliverBusinessResult({
      automationId: opts.automationId,
      businessDate: opts.businessDate,
      result: resultContent,
      attachmentName: opts.attachmentName || (opts.attachmentFile ? path.basename(opts.attachmentFile) : 'result.json'),
      attachmentContent,
      landingRoot: opts.landingRoot || OPS_BUSINESS_STAGING_ROOT,
    });
    console.log(JSON.stringify(outcome, null, 2));
    return outcome.ok ? 0 : 1;
  }

  throw contractError('INVALID_CLOUD_COMMAND', 'unknown command: ' + sub);
}

main().then(code => { process.exitCode = code; }).catch(error => {
  console.log(JSON.stringify(cloudFailureResult(error), null, 2));
  process.exitCode = 1;
});
