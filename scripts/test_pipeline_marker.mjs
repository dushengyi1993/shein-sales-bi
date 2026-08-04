#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  markerPath,
  readMarker,
  requireMarker,
  writeMarker,
} from './pipeline_marker.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shein-bi-pipeline-marker-'));
try {
  const completedAt = '2026-08-04T08:52:00.000+08:00';
  const written = writeMarker({
    root,
    stage: 'morning-links-ready',
    date: '2026-08-04',
    businessDate: '2026-08-03',
    status: 'done',
    completedAt,
    message: 'all 19 stores merged',
    evidence: ['/tmp/chunk-1.json', '/tmp/chunk-2.json', '/tmp/chunk-1.json'],
  });
  assert.equal(written.ok, true);
  assert.equal(written.status, 'done');
  assert.equal(written.businessDate, '2026-08-03');
  assert.deepEqual(written.evidence, ['/tmp/chunk-1.json', '/tmp/chunk-2.json']);
  assert.equal(written.file, markerPath(root, '2026-08-04', 'morning-links-ready'));
  assert.equal(readMarker({
    root,
    stage: 'morning-links-ready',
    date: '2026-08-04',
  })?.completedAt, completedAt);

  assert.equal(requireMarker({
    root,
    stage: 'morning-links-ready',
    date: '2026-08-04',
    statuses: ['done'],
    notBefore: '2026-08-04T08:45:00+08:00',
  }).ok, true);
  assert.equal(requireMarker({
    root,
    stage: 'morning-links-ready',
    date: '2026-08-04',
    statuses: ['done'],
    notBefore: '2026-08-04T09:00:00+08:00',
  }).reason, 'marker_too_old');
  assert.equal(requireMarker({
    root,
    stage: 'missing',
    date: '2026-08-04',
  }).reason, 'marker_missing');

  writeMarker({
    root,
    stage: 'morning-supplements',
    date: '2026-08-04',
    status: 'warning',
    completedAt,
  });
  assert.equal(requireMarker({
    root,
    stage: 'morning-supplements',
    date: '2026-08-04',
    statuses: ['done'],
  }).reason, 'marker_status_not_ready');
  assert.equal(requireMarker({
    root,
    stage: 'morning-supplements',
    date: '2026-08-04',
    statuses: ['done', 'warning'],
  }).ok, true);

  assert.throws(() => markerPath(root, '2026-08-04', '../escape'), /STAGE_INVALID/);
  console.log(JSON.stringify({ok: true}));
} finally {
  fs.rmSync(root, {recursive: true, force: true});
}
