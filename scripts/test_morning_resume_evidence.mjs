#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {buildMorningResumeEvidence, writeMorningResumeEvidence} from '../lib/morning_resume_evidence.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-morning-resume-'));
const date = '2026-08-11';
try {
  await fs.mkdir(path.join(root, 'config'), {recursive: true});
  await fs.writeFile(path.join(root, 'config', 'stores.json'), JSON.stringify({
    stores: [{storeKey: 'A'}, {storeKey: 'B'}, {storeKey: 'DISABLED', enabled: false}],
  }), 'utf8');
  for (const storeKey of ['A', 'B']) {
    for (const domain of ['shein_links', 'shein_business_domains']) {
      const dir = path.join(root, 'outputs', domain, storeKey);
      await fs.mkdir(dir, {recursive: true});
      await fs.writeFile(path.join(dir, `${date}.json`), JSON.stringify({ok: true, date, store: {storeKey}}), 'utf8');
    }
  }
  const document = await buildMorningResumeEvidence({root, date, generatedAt: '2026-08-11T12:00:00Z'});
  assert.equal(document.expectedStoreCount, 2);
  assert.equal(document.artifactCount, 4);
  assert.ok(document.artifacts.every(row => /^[a-f0-9]{64}$/.test(row.sha256) && row.bytes > 0));

  const outputFile = path.join(root, 'state', '2026-08-11-all.json');
  const written = await writeMorningResumeEvidence({root, date, outputFile, generatedAt: '2026-08-11T12:00:00Z'});
  assert.equal(written.ok, true);
  assert.equal(JSON.parse(await fs.readFile(outputFile, 'utf8')).artifactCount, 4);

  await fs.rm(path.join(root, 'outputs', 'shein_links', 'B', `${date}.json`));
  await assert.rejects(() => buildMorningResumeEvidence({root, date}), error => error.code === 'ENOENT');
} finally {
  await fs.rm(root, {recursive: true, force: true});
}

console.log(JSON.stringify({ok: true, checks: ['complete_resume_manifest', 'atomic_write', 'missing_store_evidence_blocked']}, null, 2));
