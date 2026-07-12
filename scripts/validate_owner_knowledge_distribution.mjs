#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateOwnerKnowledgeDistribution} from '../lib/owner_knowledge_distribution.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argIndex = process.argv.indexOf('--root');
const distributionRoot = path.resolve(argIndex >= 0 ? process.argv[argIndex + 1] : path.join(ROOT, 'owner-knowledge'));

async function readJson(file) {
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

const manifestFile = path.join(distributionRoot, 'manifest.json');
const manifest = await readJson(manifestFile);
const repositoryRoot = path.resolve(distributionRoot, '..');
const bundleFile = path.resolve(repositoryRoot, String(manifest.bundlePath || ''));
const allowedBundleRoot = `${path.resolve(distributionRoot, 'bundles')}${path.sep}`;
if (!bundleFile.startsWith(allowedBundleRoot)) throw new Error('owner knowledge manifest bundlePath escapes bundles directory');
if (!/^[a-f0-9]{64}\.json$/i.test(path.basename(bundleFile))) throw new Error('owner knowledge bundle filename must be its SHA-256 fingerprint');
const bundle = await readJson(bundleFile);
const result = validateOwnerKnowledgeDistribution({manifest, bundle});
if (process.env.GITHUB_OUTPUT) {
  await fs.appendFile(process.env.GITHUB_OUTPUT, `fingerprint=${result.fingerprint}\nbundle_sha256=${result.bundleSha256}\n`, 'utf8');
}
console.log(JSON.stringify({ok: true, manifestFile, bundleFile, ...result}, null, 2));
