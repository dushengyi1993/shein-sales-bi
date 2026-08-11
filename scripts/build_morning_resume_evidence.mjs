#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {writeMorningResumeEvidence} from '../lib/morning_resume_evidence.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {root: ROOT, date: '', outputFile: ''};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') args.root = path.resolve(String(argv[++i] || ''));
    else if (argv[i] === '--date') args.date = String(argv[++i] || '').trim();
    else if (argv[i] === '--out') args.outputFile = path.resolve(String(argv[++i] || ''));
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.date || !args.outputFile) throw new Error('Usage: build_morning_resume_evidence.mjs --date YYYY-MM-DD --out <result.json>');
  return args;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const document = await writeMorningResumeEvidence(args);
  console.log(JSON.stringify({ok: true, date: document.date, storeCount: document.expectedStoreCount, artifactCount: document.artifactCount, savedTo: args.outputFile}, null, 2));
} catch (error) {
  console.error(JSON.stringify({ok: false, error: String(error?.message || error)}, null, 2));
  process.exitCode = 1;
}
