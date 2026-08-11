#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import {
  markerPath,
  readMarker,
  requireMarker,
  writeMarker,
} from './pipeline_marker.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shein-bi-pipeline-marker-'));
const moduleFile = fileURLToPath(new URL('./pipeline_marker.mjs', import.meta.url));

function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function writeEvidenceFile(relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function runCli(args) {
  return spawnSync(process.execPath, [moduleFile, ...args], {encoding: 'utf8'});
}

async function main() {
  try {
    const completedAt = '2026-08-04T08:52:00.000+08:00';

    // write basics + evidence dedup / bytes / sha256
    const chunkA = writeEvidenceFile('chunk-1.json', '{"a":1}\n');
    const chunkB = writeEvidenceFile('chunk-2.json', '{"b":2}\n');
    const written = await writeMarker({
      root,
      stage: 'morning-links-ready',
      date: '2026-08-04',
      businessDate: '2026-08-03',
      status: 'done',
      completedAt,
      message: 'all 19 stores merged',
      evidence: [chunkA, chunkB, chunkA],
    });
    assert.equal(written.ok, true);
    assert.equal(written.status, 'done');
    assert.equal(written.businessDate, '2026-08-03');
    assert.deepEqual(written.evidence, [
      {path: chunkA, bytes: Buffer.byteLength('{"a":1}\n', 'utf8'), sha256: sha256Text('{"a":1}\n')},
      {path: chunkB, bytes: Buffer.byteLength('{"b":2}\n', 'utf8'), sha256: sha256Text('{"b":2}\n')},
    ]);
    assert.equal(written.file, markerPath(root, '2026-08-04', 'morning-links-ready'));
    assert.equal(readMarker({
      root,
      stage: 'morning-links-ready',
      date: '2026-08-04',
    })?.completedAt, completedAt);
    const latest = JSON.parse(fs.readFileSync(path.join(root, 'morning-links-ready.latest.json'), 'utf8'));
    assert.deepEqual(latest.evidence, written.evidence);

    // write fails closed on missing / non-file evidence and writes no marker
    const missingPath = path.join(root, 'no-such-evidence.json');
    await assert.rejects(
      writeMarker({root, stage: 'bad-missing', date: '2026-08-04', evidence: [missingPath]}),
      /PIPELINE_MARKER_EVIDENCE_MISSING/,
    );
    assert.equal(readMarker({root, stage: 'bad-missing', date: '2026-08-04'}), null);
    const dirPath = path.join(root, 'evidence-dir');
    fs.mkdirSync(dirPath, {recursive: true});
    await assert.rejects(
      writeMarker({root, stage: 'bad-dir', date: '2026-08-04', evidence: [dirPath]}),
      /PIPELINE_MARKER_EVIDENCE_NOT_FILE/,
    );

    // require with evidence: success, notBefore and marker semantics unchanged
    assert.equal((await requireMarker({
      root,
      stage: 'morning-links-ready',
      date: '2026-08-04',
      statuses: ['done'],
      notBefore: '2026-08-04T08:45:00+08:00',
      requireEvidence: true,
    })).ok, true);
    assert.equal((await requireMarker({
      root,
      stage: 'morning-links-ready',
      date: '2026-08-04',
      statuses: ['done'],
      notBefore: '2026-08-04T09:00:00+08:00',
    })).reason, 'marker_too_old');
    assert.equal((await requireMarker({
      root,
      stage: 'missing',
      date: '2026-08-04',
    })).reason, 'marker_missing');

    // tamper: same-size content change -> hash mismatch, then size change -> size mismatch
    fs.writeFileSync(chunkA, '{"a":9}\n', 'utf8');
    assert.equal((await requireMarker({
      root, stage: 'morning-links-ready', date: '2026-08-04', requireEvidence: true,
    })).reason, 'evidence_hash_mismatch');
    fs.writeFileSync(chunkA, '{"a":1}\n{"tamper":true}\n', 'utf8');
    assert.equal((await requireMarker({
      root, stage: 'morning-links-ready', date: '2026-08-04', requireEvidence: true,
    })).reason, 'evidence_size_mismatch');
    fs.writeFileSync(chunkA, '{"a":1}\n', 'utf8');
    assert.equal((await requireMarker({
      root, stage: 'morning-links-ready', date: '2026-08-04', requireEvidence: true,
    })).ok, true);

    // missing evidence file -> evidence_missing; non-regular file -> evidence_not_file
    fs.rmSync(chunkB);
    assert.equal((await requireMarker({
      root, stage: 'morning-links-ready', date: '2026-08-04', requireEvidence: true,
    })).reason, 'evidence_missing');
    fs.mkdirSync(chunkB);
    assert.equal((await requireMarker({
      root, stage: 'morning-links-ready', date: '2026-08-04', requireEvidence: true,
    })).reason, 'evidence_not_file');
    fs.rmdirSync(chunkB);
    fs.writeFileSync(chunkB, '{"b":2}\n', 'utf8');
    assert.equal((await requireMarker({
      root, stage: 'morning-links-ready', date: '2026-08-04', requireEvidence: true,
    })).ok, true);

    // flag-off compatibility: stale evidence is ignored when the switch is off
    fs.rmSync(chunkA);
    assert.equal((await requireMarker({
      root, stage: 'morning-links-ready', date: '2026-08-04',
    })).ok, true);

    // legacy marker without an evidence field: compatible off, fail-closed on
    const legacy = {
      ok: true,
      stage: 'legacy-no-evidence',
      status: 'done',
      runDate: '2026-08-04',
      businessDate: '2026-08-04',
      completedAt,
      message: '',
    };
    fs.writeFileSync(markerPath(root, '2026-08-04', 'legacy-no-evidence'), `${JSON.stringify(legacy, null, 2)}\n`);
    assert.equal((await requireMarker({
      root, stage: 'legacy-no-evidence', date: '2026-08-04',
    })).ok, true);
    assert.equal((await requireMarker({
      root, stage: 'legacy-no-evidence', date: '2026-08-04', requireEvidence: true,
    })).reason, 'evidence_missing');

    // new marker written without --evidence keeps working; with the switch it fails closed
    await writeMarker({
      root,
      stage: 'morning-supplements',
      date: '2026-08-04',
      status: 'warning',
      completedAt,
    });
    assert.equal((await requireMarker({
      root, stage: 'morning-supplements', date: '2026-08-04', statuses: ['done'],
    })).reason, 'marker_status_not_ready');
    assert.equal((await requireMarker({
      root, stage: 'morning-supplements', date: '2026-08-04', statuses: ['done', 'warning'],
    })).ok, true);
    assert.equal((await requireMarker({
      root, stage: 'morning-supplements', date: '2026-08-04', statuses: ['done', 'warning'], requireEvidence: true,
    })).reason, 'evidence_missing');

    // malformed evidence entry fails closed
    const malformed = {...legacy, stage: 'malformed-evidence', evidence: [{path: '/nope.json'}]};
    fs.writeFileSync(markerPath(root, '2026-08-04', 'malformed-evidence'), `${JSON.stringify(malformed, null, 2)}\n`);
    assert.equal((await requireMarker({
      root, stage: 'malformed-evidence', date: '2026-08-04', requireEvidence: true,
    })).reason, 'evidence_missing');

    assert.throws(() => markerPath(root, '2026-08-04', '../escape'), /STAGE_INVALID/);

    // CLI: exit codes 0 / 64 / 75 and --require-evidence behavior
    const cliRoot = path.join(root, 'cli');
    fs.mkdirSync(cliRoot, {recursive: true});
    const cliEvidence = writeEvidenceFile('cli-evidence.json', '{"ok":true}\n');
    let run = runCli(['write', '--stage', 'cli-stage', '--date', '2026-08-04', '--root', cliRoot, '--evidence', cliEvidence]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).evidence[0].sha256, sha256Text('{"ok":true}\n'));
    run = runCli(['require', '--stage', 'cli-stage', '--date', '2026-08-04', '--root', cliRoot, '--require-evidence']);
    assert.equal(run.status, 0, run.stderr);
    fs.writeFileSync(cliEvidence, '{"ok":tru1}\n', 'utf8');
    run = runCli(['require', '--stage', 'cli-stage', '--date', '2026-08-04', '--root', cliRoot, '--require-evidence']);
    assert.equal(run.status, 75, run.stdout);
    assert.equal(JSON.parse(run.stdout).reason, 'evidence_hash_mismatch');
    run = runCli(['require', '--stage', 'cli-stage', '--date', '2026-08-04', '--root', cliRoot]);
    assert.equal(run.status, 0, run.stderr);
    run = runCli(['require', '--stage', 'cli-stage', '--date', '2026-08-04', '--root', cliRoot, '--bogus']);
    assert.equal(run.status, 64, run.stdout);
    run = runCli(['write', '--stage', 'cli-write-missing', '--date', '2026-08-04', '--root', cliRoot, '--require-evidence']);
    assert.equal(run.status, 64, run.stdout);
    run = runCli(['write', '--stage', 'cli-write-missing', '--date', '2026-08-04', '--root', cliRoot, '--evidence', path.join(cliRoot, 'gone.json')]);
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stderr, /PIPELINE_MARKER_EVIDENCE_MISSING/);

    console.log(JSON.stringify({ok: true}));
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
}

main().catch(error => {
  console.error(String(error?.stack || error));
  process.exitCode = 1;
});
