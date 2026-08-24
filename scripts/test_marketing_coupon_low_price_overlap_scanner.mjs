#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scanner = path.join(root, 'scripts', 'marketing', 'scan_coupon_low_price_overlap_risks.mjs');
const outputDir = path.join(root, 'tmp', 'marketing-signup', 'low-price-overlap-risk');
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-coupon-overlap-scanner-'));

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}

const beforeOutputDir = fs.existsSync(outputDir);
const beforeOutputFiles = beforeOutputDir
  ? new Set(fs.readdirSync(outputDir))
  : new Set();
const targetPlan = path.join(fixtureDir, 'selection-plan-partial.json');
const firstOverrides = path.join(fixtureDir, 'price-overrides-offline-a.json');
const secondOverrides = path.join(fixtureDir, 'price-overrides-offline-b.json');

try {
  writeJson(targetPlan, {items: []});
  writeJson(firstOverrides, {planMetadata: {status: 'offline_candidate'}, items: []});
  writeJson(secondOverrides, {planMetadata: {status: 'offline_candidate'}, items: []});

  const result = spawnSync(process.execPath, [
    scanner,
    '--stores', 'JSH',
    '--target-plan', targetPlan,
    '--price-overrides', firstOverrides,
    '--price-overrides', secondOverrides,
    '--no-launch',
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });

  assert.notEqual(result.status, 0, 'multiple price overrides must fail closed');
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  assert.match(output, /Multiple --price-overrides files are not supported/i);
  assert.doesNotMatch(output, /scan coupon\/limited overlap|CANCEL_LIST|RISK_ROWS/i,
    'rejected input must not reach browser scanning or output reporting');

  if (fs.existsSync(outputDir)) {
    const afterOutputFiles = new Set(fs.readdirSync(outputDir));
    assert.deepEqual(afterOutputFiles, beforeOutputFiles,
      'rejected input must not create a cancellation-list or scanner output artifact');
  } else {
    assert.equal(beforeOutputDir, false,
      'output directory unexpectedly disappeared during scanner rejection test');
  }
} finally {
  fs.rmSync(fixtureDir, {recursive: true, force: true});
}

console.log('coupon low-price overlap scanner: rejects multi-file overrides before scan/output');
