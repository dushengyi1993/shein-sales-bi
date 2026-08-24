#!/usr/bin/env node
/**
 * Cloud-only half of the team-report delivery contract.
 *
 * The local caller supplies only report bytes and their binding. This command
 * reads the server-local Lark config itself, stages the bytes under the fixed
 * runtime root, and invokes lark-cli as the bot for the configured group.
 */
import {contractError} from '../lib/cloud_team_report_common.mjs';
import {
  cloudFailureResult,
  deliverCloudTeamReport,
} from '../lib/cloud_team_report_cloud.mjs';

function parseCommand(argv) {
  if (argv.length !== 1 || argv[0] !== 'deliver-stdin') {
    throw contractError('INVALID_CLOUD_COMMAND', 'cloud delivery requires the deliver-stdin subcommand');
  }
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
  parseCommand(process.argv.slice(2));
  const bundle = await readStdin();
  const result = await deliverCloudTeamReport({bundle});
  console.log(JSON.stringify(result, null, 2));
  return result.ok === true ? 0 : 1;
}

main().then(code => { process.exitCode = code; }).catch(error => {
  console.log(JSON.stringify(cloudFailureResult(error), null, 2));
  process.exitCode = 1;
});
