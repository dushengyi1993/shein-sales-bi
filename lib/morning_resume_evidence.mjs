import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {writeJsonFileAtomic} from './atomic_file_publish.mjs';

const DOMAINS = Object.freeze(['shein_links', 'shein_business_domains']);

function validateDate(value) {
  const date = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new Error('resume evidence date must be YYYY-MM-DD');
  }
  return date;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export async function buildMorningResumeEvidence({root, date, generatedAt = new Date().toISOString()} = {}) {
  const resolvedRoot = path.resolve(root || process.cwd());
  const businessDate = validateDate(date);
  const config = JSON.parse(await fs.readFile(path.join(resolvedRoot, 'config', 'stores.json'), 'utf8'));
  const stores = (Array.isArray(config?.stores) ? config.stores : [])
    .filter(row => row?.enabled !== false)
    .map(row => String(row?.storeKey || '').trim().toUpperCase())
    .filter(Boolean);
  if (!stores.length) throw new Error('resume evidence has no enabled stores');
  const artifacts = [];
  for (const storeKey of stores) {
    for (const domain of DOMAINS) {
      const file = path.join(resolvedRoot, 'outputs', domain, storeKey, `${businessDate}.json`);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`resume evidence is not a regular file: ${file}`);
      const bytes = await fs.readFile(file);
      const payload = JSON.parse(bytes.toString('utf8'));
      const payloadStore = String(payload?.store?.storeKey || '').trim().toUpperCase();
      if (payload?.ok !== true || String(payload?.date || '') !== businessDate || payloadStore !== storeKey) {
        throw new Error(`resume evidence identity mismatch: ${domain}/${storeKey}/${businessDate}`);
      }
      artifacts.push({
        storeKey,
        domain,
        path: path.relative(resolvedRoot, file).split(path.sep).join('/'),
        bytes: stat.size,
        sha256: sha256(bytes),
      });
    }
  }
  return {
    schemaVersion: 'shein-morning-resume-evidence/v1',
    ok: true,
    date: businessDate,
    generatedAt: new Date(generatedAt).toISOString(),
    source: 'existing_exact_date_store_artifacts',
    expectedStoreCount: stores.length,
    artifactCount: artifacts.length,
    stores,
    domains: DOMAINS,
    artifacts,
  };
}

export async function writeMorningResumeEvidence({root, date, outputFile, generatedAt} = {}) {
  const document = await buildMorningResumeEvidence({root, date, generatedAt});
  await writeJsonFileAtomic(path.resolve(outputFile), document, {mode: 0o660});
  return document;
}
