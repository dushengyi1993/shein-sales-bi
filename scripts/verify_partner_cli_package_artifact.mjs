#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

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

async function collectFiles(root, current = root, output = []) {
  for (const entry of await fs.readdir(current, {withFileTypes: true})) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Package contains a symbolic link: ${path.relative(root, absolute)}`);
    if (entry.isDirectory()) await collectFiles(root, absolute, output);
    else if (entry.isFile()) output.push(path.relative(root, absolute).replace(/\\/g, '/'));
    else throw new Error(`Package contains an unsupported entry: ${path.relative(root, absolute)}`);
  }
  return output;
}

async function assertSameFile(left, right, label) {
  const [leftBytes, rightBytes] = await Promise.all([fs.readFile(left), fs.readFile(right)]);
  if (!leftBytes.equals(rightBytes)) throw new Error(`Package content differs from release source: ${label}`);
}

const args = parseArgs(process.argv.slice(2));
for (const required of ['source-root', 'extracted-root']) {
  if (!args[required]) throw new Error(`--${required} is required`);
}
const sourceRoot = path.resolve(args['source-root']);
const extractedRoot = path.resolve(args['extracted-root']);
const manifestFile = path.join(sourceRoot, 'config', 'partner_cli_package.json');
const manifest = JSON.parse((await fs.readFile(manifestFile, 'utf8')).replace(/^\uFEFF/, ''));
const packageRoot = path.join(extractedRoot, `shein-bi-ops-cli-${manifest.version}`);
const topLevel = await fs.readdir(extractedRoot, {withFileTypes: true});
if (topLevel.length !== 1 || !topLevel[0].isDirectory() || path.resolve(extractedRoot, topLevel[0].name) !== packageRoot) {
  throw new Error('Partner CLI ZIP must contain exactly one versioned package directory');
}

const expected = new Map();
for (const relativeValue of manifest.files || []) {
  const relative = String(relativeValue || '').replace(/\\/g, '/');
  expected.set(relative, path.join(sourceRoot, relative));
}
expected.set('config/partner_cli_package.json', manifestFile);
expected.set('install.ps1', path.join(sourceRoot, 'scripts', 'install_partner_bi_ops_cli.ps1'));

const actualFiles = (await collectFiles(packageRoot)).sort();
const expectedFiles = [...expected.keys()].sort();
if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
  const missing = expectedFiles.filter(file => !actualFiles.includes(file));
  const unexpected = actualFiles.filter(file => !expectedFiles.includes(file));
  throw new Error(`Partner CLI ZIP file set mismatch; missing=${missing.join(',') || '-'} unexpected=${unexpected.join(',') || '-'}`);
}
for (const [relative, sourceFile] of expected) {
  await assertSameFile(sourceFile, path.join(packageRoot, relative), relative);
}

console.log(JSON.stringify({ok: true, version: manifest.version, fileCount: actualFiles.length}));
