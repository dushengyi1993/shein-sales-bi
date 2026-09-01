#!/usr/bin/env node
/**
 * The only local entry point for automation -> cloud bot -> team-group report
 * delivery. It never loads a local Lark config and never starts a local Lark
 * CLI. The cloud target and bot identity are resolved only on the server.
 */
import {
  localFailureResult,
  runLocalCloudTeamReport,
} from '../lib/cloud_team_report_local.mjs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

function requiredValue(argv, index, name) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

export function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--automation-id') args.automationId = requiredValue(argv, index++, token);
    else if (token === '--business-date') args.businessDate = requiredValue(argv, index++, token);
    else if (token === '--summary-file') args.summaryFile = requiredValue(argv, index++, token);
    else if (token === '--attachment') args.attachment = requiredValue(argv, index++, token);
    else if (token === '--expected-attachment-sha256') args.expectedAttachmentSha256 = requiredValue(argv, index++, token);
    else if (token === '--cloud-ssh') args.cloudSsh = requiredValue(argv, index++, token);
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

export function usage() {
  return `Usage:
  node scripts/send_cloud_team_report.mjs
    --automation-id <safe-id>
    --business-date <YYYY-MM-DD>
    --summary-file <file-under-outputs>
    --attachment <file-under-outputs>
    --expected-attachment-sha256 <sha256>
    --cloud-ssh shein-bi-tencent

The local command validates ordinary files under outputs, then sends one fixed
stdin bundle to the cloud delivery entry. It does not accept a local chat/user
target and does not invoke a local Lark CLI.
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return 0;
  }
  for (const name of ['automationId', 'businessDate', 'summaryFile', 'attachment', 'expectedAttachmentSha256', 'cloudSsh']) {
    if (!args[name]) throw new Error(`--${name.replace(/[A-Z]/gu, character => `-${character.toLowerCase()}`)} is required`);
  }
  const result = await runLocalCloudTeamReport(args);
  console.log(JSON.stringify(result, null, 2));
  return result.ok === true ? 0 : 1;
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    const result = localFailureResult(error);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  });
}
