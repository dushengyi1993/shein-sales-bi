#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {buildPartnerCliRelease} from '../lib/partner_cli_release.mjs';
import {
  PARTNER_CLI_DEPLOYMENT_SCHEMA_VERSION,
  validatePartnerCliDeploymentPayload,
} from '../lib/partner_cli_release_store.mjs';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    args[key.slice(2)] = value;
    index += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
for (const required of ['source-root', 'package-file', 'checksum-file', 'tag', 'source-commit', 'published-at', 'output']) {
  if (!args[required]) throw new Error(`--${required} is required`);
}

const sourceRoot = path.resolve(args['source-root']);
const packageFile = path.resolve(args['package-file']);
const checksumFile = path.resolve(args['checksum-file']);
const outputFile = path.resolve(args.output);
const release = await buildPartnerCliRelease({sourceRoot});
const [packageBytes, checksumText] = await Promise.all([
  fs.readFile(packageFile),
  fs.readFile(checksumFile, 'utf8'),
]);
const packageSha256 = String(checksumText || '').trim().split(/\s+/)[0].toLowerCase();
const payload = {
  schemaVersion: PARTNER_CLI_DEPLOYMENT_SCHEMA_VERSION,
  tagName: args.tag,
  sourceCommit: args['source-commit'],
  publishedAt: args['published-at'],
  manifest: release.manifest,
  bundle: release.bundle,
  package: {
    fileName: path.basename(packageFile),
    size: packageBytes.length,
    sha256: packageSha256,
    dataBase64: packageBytes.toString('base64'),
  },
};
const validated = validatePartnerCliDeploymentPayload(payload);
await fs.mkdir(path.dirname(outputFile), {recursive: true});
const temporary = `${outputFile}.${process.pid}.tmp`;
await fs.writeFile(temporary, `${JSON.stringify(payload)}\n`, {encoding: 'utf8', mode: 0o600});
await fs.rename(temporary, outputFile);
console.log(JSON.stringify({
  ok: true,
  version: validated.version,
  tagName: validated.tagName,
  sourceCommit: validated.sourceCommit,
  bundleSha256: validated.bundleSha256,
  packageSha256: validated.package.sha256,
  packageSize: validated.package.size,
  outputFile,
}));
