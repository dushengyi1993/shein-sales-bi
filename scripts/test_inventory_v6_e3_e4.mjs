import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

import {
  inventoryMaintenanceRequest,
  enqueueInventoryMaintenance,
  runInventoryMaintenanceJob,
} from '../lib/cloud_inventory_replenishment_job.mjs';

import {
  ensureLegacyExecutionArtifactsPreserved,
  evaluateResultBatchStatus,
  publishDailyInventoryResultVersion,
  readDailyInventoryVersionIndex,
  resolveResultEvidenceArtifact,
  resolveInventoryVersionIndexPath,
  resolveInventoryLegacyResultPath,
  resolveInventoryLegacyPlanPath,
  fileSha256AndBytes,
} from './inventory/daily_inventory_version_publisher.mjs';

import {createLinkOpsJsonRepository} from '../lib/link_ops_json_repository.mjs';
import {createLinkOpsStoreGateway} from '../lib/link_ops_store_gateway.mjs';
import {createLinkOpsJobWorker} from '../lib/link_ops_job_worker.mjs';
import {appendDurableJournalRecord} from '../lib/durable_inventory_write.mjs';
import {buildDailyInventoryPlanHashPayload, stableInventoryHash} from '../lib/inventory_replenishment_policy.mjs';
import {verifyInventoryDryRun} from '../lib/inventory_dry_run_integrity.mjs';

const execFileAsync = promisify(execFile);
const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'inventory-v6-e3-e4-run-'));
const today = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());
const businessDate = new Date(Date.parse(today + 'T12:00:00Z') - 86_400_000).toISOString().slice(0, 10);
const canonicalPolicy = JSON.parse(await fs.readFile(path.join(SCRIPT_ROOT, 'config', 'inventory_replenishment_policy.json'), 'utf8'));

console.log('=== V6 Inventory E3/E4 Real Regression Suite ===');
console.log('Isolated temp root:', tempRoot);

let totalChecks = 0;
const check = (desc, fn) => {
  try {
    fn();
    totalChecks++;
    console.log(`  [PASS] ${desc}`);
  } catch (err) {
    console.error(`  [FAIL] ${desc}`, err);
    throw err;
  }
};
const asyncCheck = async (desc, fn) => {
  try {
    await fn();
    totalChecks++;
    console.log(`  [PASS] ${desc}`);
  } catch (err) {
    console.error(`  [FAIL] ${desc}`, err);
    throw err;
  }
};

const writeJson = async (file, value) => {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
};

try {
  // =========================================================================
  // SUITE 1: Publisher 4-piece suite with raw CRLF & Chinese characters
  // =========================================================================
  console.log('\n--- Suite 1: daily_inventory_version_publisher Contract ---');

  const invRuntime = path.join(tempRoot, 'inventory-runtime');
  const versionsDir = path.join(invRuntime, 'versions');
  await fs.mkdir(invRuntime, {recursive: true});

  // Source evidence fixture with Chinese characters
  const sourceEvidenceFile = path.join(tempRoot, 'source_evidence.json');
  const sourceBytes = Buffer.from('{\r\n  "store": "JSH-广州仓库",\r\n  "note": "中文测试事实源证据"\r\n}\r\n', 'utf8');
  await fs.writeFile(sourceEvidenceFile, sourceBytes);
  const sourceSha = crypto.createHash('sha256').update(sourceBytes).digest('hex');

  // Plan 1 fixture with CRLF & Chinese text
  const rawPlanV1 = Buffer.from(
    `{\r\n  "date": "${today}",\r\n  "payloadHash": "` + '1'.repeat(64) + `",\r\n  "actionable": [\r\n    {"storeKey": "JSH", "skc": "SKC中文01", "skuCode": "SKU中文01", "targetUsableInventory": 100}\r\n  ],\r\n  "sourceEvidence": [\r\n    {"file": "${sourceEvidenceFile.replace(/\\/g, '/')}", "sha256": "${sourceSha}"}\r\n  ]\r\n}\r\n`,
    'utf8'
  );
  const planV1Sha = crypto.createHash('sha256').update(rawPlanV1).digest('hex');

  // Result 1 fixture
  const rawResultV1 = Buffer.from(
    `{\r\n  "planHash": "` + '1'.repeat(64) + `",\r\n  "execute": true,\r\n  "executionMode": "automatic",\r\n  "generatedAt": "${new Date().toISOString()}",\r\n  "results": [\r\n    {\r\n      "storeKey": "JSH",\r\n      "skc": "SKC中文01",\r\n      "skuCode": "SKU中文01",\r\n      "state": "updated_readback_matched",\r\n      "targetUsableInventory": 100,\r\n      "after": {"totalUsableInventory": 100},\r\n      "writes": [{"attempt": 1}]\r\n    }\r\n  ]\r\n}\r\n`,
    'utf8'
  );
  const resultV1Sha = crypto.createHash('sha256').update(rawResultV1).digest('hex');

  // Marker 1 fixture
  const rawMarkerV1 = Buffer.from(
    JSON.stringify({
      stage: 'daily-inventory-guard',
      runDate: today,
      businessDate,
      ok: true,
      status: 'done',
      evidence: [
        {path: path.join(tempRoot, 'staging-v1', 'plan.json'), sha256: planV1Sha, bytes: rawPlanV1.length},
        {path: path.join(tempRoot, 'staging-v1', 'result.json'), sha256: resultV1Sha, bytes: rawResultV1.length},
      ],
    }) + '\r\n',
    'utf8'
  );

  // Journal 1 fixture
  const rawJournalV1 = Buffer.from(`{"kind":"intent","intentId":"int-v1-中文"}\r\n`, 'utf8');

  const stagingDir = path.join(tempRoot, 'staging-v1');
  await fs.mkdir(stagingDir, {recursive: true});
  const planV1Path = path.join(stagingDir, 'plan.json');
  const resultV1Path = path.join(stagingDir, 'result.json');
  const journalV1Path = path.join(stagingDir, 'result.json.journal.ndjson');
  const markerV1Path = path.join(stagingDir, 'marker.json');

  await fs.writeFile(planV1Path, rawPlanV1);
  await fs.writeFile(resultV1Path, rawResultV1);
  await fs.writeFile(journalV1Path, rawJournalV1);
  await fs.writeFile(markerV1Path, rawMarkerV1);

  // 1.1: Publish V1
  let entryV1;
  await asyncCheck('1.1: publish v1 creates atomic index and version directory', async () => {
    entryV1 = await publishDailyInventoryResultVersion({
      inventoryRuntimeRoot: invRuntime,
      date: today,
      batchId: 'batch-v1',
      commandId: 'cmd-v1',
      stagingPlanFile: planV1Path,
      stagingResultFile: resultV1Path,
      stagingJournalFile: journalV1Path,
      stagingMarkerFile: markerV1Path,
      root: tempRoot,
    });
    assert.equal(entryV1.version, 1);
    assert.equal(entryV1.batchId, 'batch-v1');
    assert.equal(entryV1.status, 'done');

    const index = await readDailyInventoryVersionIndex({inventoryRuntimeRoot: invRuntime, date: today});
    assert.equal(index.latestVersion, 1);
    assert.equal(index.activeVersion, 1);
    assert.equal(index.latestBatchId, 'batch-v1');
    assert.equal(index.batches.length, 1);

    const sealFile = journalV1Path + '.sealed.json';
    const sealExists = await fs.access(sealFile).then(() => true).catch(() => false);
    assert.equal(sealExists, true, 'journal seal file must exist after publish');
    await assert.rejects(
      appendDurableJournalRecord(journalV1Path, {kind: 'intent', intentId: 'post-seal-attempt'}),
      /INVENTORY_JOURNAL_SEALED/,
      'appending to sealed journal must be rejected'
    );
  });

  // 1.2: Publish V2 and verify old bytes remain 100% unchanged
  await asyncCheck('1.2: publish v2 advances active version while old v1 snapshot bytes remain identical', async () => {
    // Read original snapshot bytes for v1
    const v1SnapshotFile = path.resolve(invRuntime, entryV1.artifacts.result.snapshot);
    const v1SavedBytes = await fs.readFile(v1SnapshotFile);
    assert.deepEqual(v1SavedBytes, rawResultV1, 'v1 snapshot must match raw CRLF result bytes exactly');

    // Create V2
    const rawPlanV2 = Buffer.from(
      `{\r\n  "date": "${today}",\r\n  "payloadHash": "` + '2'.repeat(64) + `",\r\n  "actionable": [\r\n    {"storeKey": "JSH", "skc": "SKC中文01", "skuCode": "SKU中文01", "targetUsableInventory": 100}\r\n  ],\r\n  "sourceEvidence": [\r\n    {"file": "${sourceEvidenceFile.replace(/\\/g, '/')}", "sha256": "${sourceSha}"}\r\n  ]\r\n}\r\n`,
      'utf8'
    );
    const planV2Sha = crypto.createHash('sha256').update(rawPlanV2).digest('hex');
    const rawResultV2 = Buffer.from(
      `{\r\n  "planHash": "` + '2'.repeat(64) + `",\r\n  "execute": true,\r\n  "executionMode": "automatic",\r\n  "generatedAt": "${new Date().toISOString()}",\r\n  "results": [\r\n    {\r\n      "storeKey": "JSH",\r\n      "skc": "SKC中文01",\r\n      "skuCode": "SKU中文01",\r\n      "state": "skipped_target_already_matched",\r\n      "targetUsableInventory": 100,\r\n      "before": {"totalUsableInventory": 100}\r\n    }\r\n  ]\r\n}\r\n`,
      'utf8'
    );
    const resultV2Sha = crypto.createHash('sha256').update(rawResultV2).digest('hex');
    const rawMarkerV2 = Buffer.from(
      JSON.stringify({
        stage: 'daily-inventory-guard',
        runDate: today,
      businessDate,
      ok: true,
        status: 'done',
        evidence: [
          {path: path.join(tempRoot, 'staging-v2', 'plan.json'), sha256: planV2Sha, bytes: rawPlanV2.length},
          {path: path.join(tempRoot, 'staging-v2', 'result.json'), sha256: resultV2Sha, bytes: rawResultV2.length},
        ],
      }) + '\r\n',
      'utf8'
    );
    const rawJournalV2 = Buffer.from(`{"kind":"intent","intentId":"int-v2-中文"}\r\n`, 'utf8');

    const stagingV2Dir = path.join(tempRoot, 'staging-v2');
    await fs.mkdir(stagingV2Dir, {recursive: true});
    const planV2Path = path.join(stagingV2Dir, 'plan.json');
    const resultV2Path = path.join(stagingV2Dir, 'result.json');
    const journalV2Path = path.join(stagingV2Dir, 'result.json.journal.ndjson');
    const markerV2Path = path.join(stagingV2Dir, 'marker.json');

    await fs.writeFile(planV2Path, rawPlanV2);
    await fs.writeFile(resultV2Path, rawResultV2);
    await fs.writeFile(journalV2Path, rawJournalV2);
    await fs.writeFile(markerV2Path, rawMarkerV2);

    const entryV2 = await publishDailyInventoryResultVersion({
      inventoryRuntimeRoot: invRuntime,
      date: today,
      batchId: 'batch-v2',
      commandId: 'cmd-v2',
      stagingPlanFile: planV2Path,
      stagingResultFile: resultV2Path,
      stagingJournalFile: journalV2Path,
      stagingMarkerFile: markerV2Path,
      root: tempRoot,
    });
    assert.equal(entryV2.version, 2);
    assert.equal(entryV2.batchId, 'batch-v2');

    const indexAfterV2 = await readDailyInventoryVersionIndex({inventoryRuntimeRoot: invRuntime, date: today});
    assert.equal(indexAfterV2.latestVersion, 2);
    assert.equal(indexAfterV2.activeVersion, 2);
    assert.equal(indexAfterV2.batches.length, 2);

    // Assert v1 bytes unchanged
    const v1BytesAfter = await fs.readFile(v1SnapshotFile);
    assert.deepEqual(v1BytesAfter, v1SavedBytes, 'old v1 snapshot bytes must be completely unchanged');
  });

  // 1.3: Atomic index failure preserves previous active version
  await asyncCheck('1.3: one-index atomic failure preserves old active state', async () => {
    const rawPlanV3 = Buffer.from(
      `{\r\n  "date": "${today}",\r\n  "payloadHash": "` + '3'.repeat(64) + `",\r\n  "actionable": [\r\n    {"storeKey": "JSH", "skc": "SKC03", "skuCode": "SKU03", "targetUsableInventory": 100}\r\n  ],\r\n  "sourceEvidence": [\r\n    {"file": "${sourceEvidenceFile.replace(/\\/g, '/')}", "sha256": "${sourceSha}"}\r\n  ]\r\n}\r\n`,
      'utf8'
    );
    const planV3Sha = crypto.createHash('sha256').update(rawPlanV3).digest('hex');
    const rawResultV3 = Buffer.from(
      `{\r\n  "planHash": "` + '3'.repeat(64) + `",\r\n  "execute": true,\r\n  "executionMode": "automatic",\r\n  "generatedAt": "${new Date().toISOString()}",\r\n  "results": [\r\n    {\r\n      "storeKey": "JSH",\r\n      "skc": "SKC03",\r\n      "skuCode": "SKU03",\r\n      "state": "skipped_target_already_matched",\r\n      "targetUsableInventory": 100,\r\n      "before": {"totalUsableInventory": 100}\r\n    }\r\n  ]\r\n}\r\n`,
      'utf8'
    );
    const resultV3Sha = crypto.createHash('sha256').update(rawResultV3).digest('hex');
    const rawMarkerV3 = Buffer.from(
      JSON.stringify({
        stage: 'daily-inventory-guard',
        runDate: today,
      businessDate,
      ok: true,
        status: 'done',
        evidence: [
          {path: path.join(tempRoot, 'staging-v3', 'plan.json'), sha256: planV3Sha, bytes: rawPlanV3.length},
          {path: path.join(tempRoot, 'staging-v3', 'result.json'), sha256: resultV3Sha, bytes: rawResultV3.length},
        ],
      }) + '\r\n',
      'utf8'
    );
    const stagingV3Dir = path.join(tempRoot, 'staging-v3');
    await fs.mkdir(stagingV3Dir, {recursive: true});
    const planV3Path = path.join(stagingV3Dir, 'plan.json');
    const resultV3Path = path.join(stagingV3Dir, 'result.json');
    const journalV3Path = path.join(stagingV3Dir, 'result.json.journal.ndjson');
    const markerV3Path = path.join(stagingV3Dir, 'marker.json');

    await fs.writeFile(planV3Path, rawPlanV3);
    await fs.writeFile(resultV3Path, rawResultV3);
    await fs.writeFile(journalV3Path, '{"kind":"intent"}\n');
    await fs.writeFile(markerV3Path, rawMarkerV3);

    // Simulate atomic write rename failure via beforeIndexRename hook
    await assert.rejects(
      publishDailyInventoryResultVersion({
        inventoryRuntimeRoot: invRuntime,
        date: today,
        batchId: 'batch-v3-crash',
        commandId: 'cmd-v3-crash',
        stagingPlanFile: planV3Path,
        stagingResultFile: resultV3Path,
        stagingJournalFile: journalV3Path,
        stagingMarkerFile: markerV3Path,
        root: tempRoot,
        beforeIndexRename: async () => {
          throw new Error('SIMULATED_DISK_IO_FAILURE_ON_INDEX_RENAME');
        },
      }),
      /SIMULATED_DISK_IO_FAILURE_ON_INDEX_RENAME/
    );

    // Verify index is still cleanly at v2
    const indexRollback = await readDailyInventoryVersionIndex({inventoryRuntimeRoot: invRuntime, date: today});
    assert.equal(indexRollback.latestVersion, 2);
    assert.equal(indexRollback.activeVersion, 2);
    assert.equal(indexRollback.latestBatchId, 'batch-v2');
  });

  // 1.4: Idempotent replay of same commandId & batchId
  await asyncCheck('1.4: same commandId/batchId replay returns existing immutable entry', async () => {
    const replay = await publishDailyInventoryResultVersion({
      inventoryRuntimeRoot: invRuntime,
      date: today,
      batchId: 'batch-v2',
      commandId: 'cmd-v2',
      stagingPlanFile: path.join(tempRoot, 'staging-v2', 'plan.json'),
      stagingResultFile: path.join(tempRoot, 'staging-v2', 'result.json'),
      stagingJournalFile: path.join(tempRoot, 'staging-v2', 'result.json.journal.ndjson'),
      stagingMarkerFile: path.join(tempRoot, 'staging-v2', 'marker.json'),
      root: tempRoot,
    });
    assert.equal(replay.version, 2);
    assert.equal(replay.batchId, 'batch-v2');
  });

  // 1.5: Rejections: mismatched hash, missing journal, missing marker, strict batch/hash no fallback
  await asyncCheck('1.5: mismatched hash, missing journal, missing marker reject fail-closed', async () => {
    const badDir = path.join(tempRoot, 'staging-bad');
    await fs.mkdir(badDir, {recursive: true});

    // 1.5.1: Missing journal
    await assert.rejects(
      publishDailyInventoryResultVersion({
        inventoryRuntimeRoot: invRuntime,
        date: today,
        batchId: 'batch-bad-1',
        commandId: 'cmd-bad-1',
        stagingPlanFile: path.join(tempRoot, 'staging-v2', 'plan.json'),
        stagingResultFile: path.join(tempRoot, 'staging-v2', 'result.json'),
        stagingJournalFile: path.join(badDir, 'nonexistent.journal.ndjson'),
        stagingMarkerFile: path.join(tempRoot, 'staging-v2', 'marker.json'),
      }),
      /Missing required inventory artifact: journal|ENOENT/
    );

    // 1.5.2: Corrupt marker evidence hash
    const corruptMarker = JSON.stringify({
      stage: 'daily-inventory-guard',
      runDate: today,
      businessDate,
      ok: true,
      status: 'done',
      evidence: [
        {path: path.join(tempRoot, 'staging-v2', 'plan.json'), sha256: 'deadbeef'.repeat(8), bytes: 123},
        {path: path.join(tempRoot, 'staging-v2', 'result.json'), sha256: 'feedface'.repeat(8), bytes: 456},
      ],
    });
    const badMarkerPath = path.join(badDir, 'bad_marker.json');
    await fs.writeFile(badMarkerPath, corruptMarker);
    await assert.rejects(
      publishDailyInventoryResultVersion({
        inventoryRuntimeRoot: invRuntime,
        date: today,
        batchId: 'batch-bad-2',
        commandId: 'cmd-bad-2',
        stagingPlanFile: path.join(tempRoot, 'staging-v2', 'plan.json'),
        stagingResultFile: path.join(tempRoot, 'staging-v2', 'result.json'),
        stagingJournalFile: path.join(tempRoot, 'staging-v2', 'result.json.journal.ndjson'),
        stagingMarkerFile: badMarkerPath,
        root: tempRoot,
      }),
      /Inventory marker lacks exact plan evidence/
    );

    // 1.5.3: Strict batch / hash no fallback: resolving non-existent hash returns null
    const nonExistent = await resolveResultEvidenceArtifact({
      inventoryRuntimeRoot: invRuntime,
      date: today,
      batchId: 'nonexistent-batch',
    });
    assert.equal(nonExistent, null, 'strict identity must return null without fallback');
  });

  // Each negative case starts from a publishable tuple, changes one contract,
  // and repairs that same tuple after the rejection. All hashes are recomputed
  // so identity failures cannot pass merely because an older hash is stale.
  const contractRuntime = path.join(tempRoot, 'marker-contract-runtime');
  const crlfJson = value => Buffer.from(JSON.stringify(value, null, 2).replaceAll('\n', '\r\n') + '\r\n');
  const contractPlan = JSON.parse(rawPlanV1);
  const contractResult = JSON.parse(rawResultV1);
  contractResult.results[0] = {
    ...contractResult.results[0], state: 'skipped_target_already_matched',
    before: {totalUsableInventory: 100}, writes: [],
  };
  const secondIdentity = {storeKey: 'DL', skc: '第二款SKC', skuCode: '第二款SKU', targetUsableInventory: 20};
  contractPlan.actionable.push(secondIdentity);
  contractResult.results.push({...secondIdentity, state: 'skipped_target_already_matched', before: {totalUsableInventory: 20}});
  async function contractFixture(name, {state = 'skipped_target_already_matched', execute = true} = {}) {
    const directory = path.join(tempRoot, 'marker-contract', name);
    await fs.mkdir(directory, {recursive: true});
    const options = {
      inventoryRuntimeRoot: contractRuntime, root: tempRoot, date: today,
      batchId: 'contract-' + name, commandId: 'contract-' + name,
      stagingPlanFile: path.join(directory, 'plan.json'),
      stagingResultFile: path.join(directory, 'result.json'),
      stagingJournalFile: path.join(directory, 'result.json.journal.ndjson'),
      stagingMarkerFile: path.join(directory, 'marker.json'),
    };
    const plan = structuredClone(contractPlan);
    const result = structuredClone(contractResult);
    result.execute = execute;
    result.results.forEach(row => { row.state = state; });
    if (!execute) {
      Object.assign(plan, {commandId: options.commandId, executable: true, blockers: []});
      plan.payloadHash = stableInventoryHash(buildDailyInventoryPlanHashPayload(plan));
      Object.assign(result, {commandId: options.commandId, executionMode: 'dry_run', planHash: plan.payloadHash, unresolvedIntents: []});
      result.results.forEach(row => { delete row.before; delete row.after; delete row.writes; });
    }
    await fs.writeFile(options.stagingJournalFile, '');
    async function writeTuple(mutateMarker = () => {}) {
      await fs.writeFile(options.stagingPlanFile, crlfJson(plan));
      await fs.writeFile(options.stagingResultFile, crlfJson(result));
      if (!execute) await fs.writeFile(options.stagingJournalFile, result.results.map(row => JSON.stringify({
        kind: 'result', planHash: plan.payloadHash, row,
      })).join('\r\n') + '\r\n');
      const dryRunSummary = !execute ? await verifyInventoryDryRun({plan, result, commandId: options.commandId,
        journalFile: options.stagingJournalFile}) : null;
      const status = evaluateResultBatchStatus(result, plan.actionable.length, dryRunSummary);
      const marker = {
        stage: 'daily-inventory-guard', runDate: plan.date,
        businessDate: new Date(Date.parse(plan.date + 'T12:00:00Z') - 86_400_000).toISOString().slice(0, 10),
        status: status === 'dry_run_ready' ? 'done' : status,
        ok: ['done', 'warning', 'dry_run_ready'].includes(status),
        evidence: await Promise.all([options.stagingPlanFile, options.stagingResultFile].map(async file => ({
          path: path.resolve(file), ...await fileSha256AndBytes(file),
        }))),
      };
      mutateMarker(marker);
      await fs.writeFile(options.stagingMarkerFile, crlfJson(marker));
    }
    await writeTuple();
    return {options, plan, result, writeTuple};
  }
  for (const [name, state, execute, expected] of [
    ['done', 'skipped_target_already_matched', true, 'done'],
    ['warning', 'submitted_but_readback_pending', true, 'warning'],
    ['failed', 'blocked', true, 'failed'],
    ['dry-run', 'dry_run_ready', false, 'dry_run_ready'],
  ]) {
    await asyncCheck('1.6: exact marker tuple publishes ' + name, async () => {
      const fixture = await contractFixture(name, {state, execute});
      fixture.result.results.reverse(); // Coverage is a multiset, not row order.
      await fixture.writeTuple();
      const entry = await publishDailyInventoryResultVersion(fixture.options);
      assert.equal(entry.status, expected);
    });
  }
  const negativeCases = [
    ...['plan', 'result'].map((kind, index) => ({
      name: kind + '-same-hash-wrong-path', error: new RegExp('Inventory marker lacks exact ' + kind + ' evidence'),
      mutate: async fixture => {
        const original = fixture.options[kind === 'plan' ? 'stagingPlanFile' : 'stagingResultFile'];
        const copy = original + '.same-bytes.json';
        await fs.copyFile(original, copy);
        assert.deepEqual(await fileSha256AndBytes(copy), await fileSha256AndBytes(original));
        await fixture.writeTuple(marker => { marker.evidence[index].path = copy; });
      },
    })),
    ...[
      ['done', 'skipped_target_already_matched'], ['warning', 'submitted_but_readback_pending'], ['failed', 'blocked'],
    ].map(([name, state]) => ({
      name: name + '-ok-conflict', state, error: /Inventory marker ok\/status conflict/,
      mutate: fixture => fixture.writeTuple(marker => { marker.ok = !marker.ok; }),
    })),
    {name: 'business-date', error: /Inventory marker business date conflict/,
      mutate: fixture => fixture.writeTuple(marker => { marker.businessDate = today; })},
    {name: 'run-date', error: /Inventory marker does not belong to this plan/,
      mutate: fixture => fixture.writeTuple(marker => { marker.runDate = businessDate; })},
    {name: 'publication-date', error: /Inventory publication date\/plan conflict/,
      mutate: async fixture => { fixture.options.date = businessDate; }},
    {name: 'evidence-bytes', error: /Inventory marker lacks exact result evidence/,
      mutate: fixture => fixture.writeTuple(marker => { marker.evidence[1].bytes += 1; })},
    ...['storeKey', 'skc', 'skuCode', 'targetUsableInventory'].map(field => ({
      name: 'same-count-wrong-' + field, error: /Inventory result object\/target coverage conflict/,
      mutate: async fixture => {
        fixture.result.results[0][field] = field === 'targetUsableInventory' ? 99 : '错误对象';
        if (field === 'targetUsableInventory') fixture.result.results[0].before.totalUsableInventory = 99;
        await fixture.writeTuple();
      },
    })),
    {name: 'duplicate-result-identity', error: /Inventory result object\/target coverage conflict/,
      mutate: async fixture => { fixture.result.results[1] = structuredClone(fixture.result.results[0]); await fixture.writeTuple(); }},
    {name: 'duplicate-plan-and-result-identity', error: /Inventory result object\/target coverage conflict/,
      mutate: async fixture => {
        fixture.plan.actionable[1] = structuredClone(fixture.plan.actionable[0]);
        fixture.result.results[1] = structuredClone(fixture.result.results[0]);
        await fixture.writeTuple();
      }},
  ];
  for (const candidate of negativeCases) {
    await asyncCheck('1.7: rejects ' + candidate.name + ' without changing active bytes', async () => {
      const fixture = await contractFixture(candidate.name, {state: candidate.state});
      const validPlan = structuredClone(fixture.plan);
      const validResult = structuredClone(fixture.result);
      const indexPath = resolveInventoryVersionIndexPath(contractRuntime, today);
      const oldIndexBytes = await fs.readFile(indexPath);
      await candidate.mutate(fixture);
      await assert.rejects(publishDailyInventoryResultVersion(fixture.options), candidate.error);
      assert.deepEqual(await fs.readFile(indexPath), oldIndexBytes);
      await assert.rejects(fs.access(fixture.options.stagingJournalFile + '.sealed.json'), {code: 'ENOENT'});
      if (fixture.options.date !== today) {
        assert.equal(await readDailyInventoryVersionIndex({inventoryRuntimeRoot: contractRuntime, date: fixture.options.date}), null);
      }
      Object.assign(fixture.plan, validPlan);
      Object.assign(fixture.result, validResult);
      fixture.options.date = today;
      await fixture.writeTuple();
      const repaired = await publishDailyInventoryResultVersion(fixture.options);
      assert.equal(repaired.commandId, fixture.options.commandId);
    });
  }

  // =========================================================================
  // SUITE 2: PG Contract Simulation with createLinkOpsJsonRepository +
  //          storegateway + createLinkOpsJobWorker
  // =========================================================================
  console.log('\n--- Suite 2: Job Store Gateway & Worker Contract Simulation ---');

  const repoRoot = path.join(tempRoot, 'link-ops-repo');
  const repo = createLinkOpsJsonRepository({rootDir: repoRoot});
  const gateway = createLinkOpsStoreGateway({repository: repo});

  const owner = 'partner_operator_1';

  // 2.1: Concurrent enqueue same owner + commandId yields only 1 job
  await asyncCheck('2.1: concurrent enqueue same owner + commandId deduplicates to exactly 1 job', async () => {
    const cmdId = 'dedupe-cmd-001';
    const [job1, job2] = await Promise.all([
      enqueueInventoryMaintenance({
        store: gateway,
        actor: owner,
        body: {commandId: cmdId, date: today, maxRows: 50},
      }),
      enqueueInventoryMaintenance({
        store: gateway,
        actor: owner,
        body: {commandId: cmdId, date: today, maxRows: 50},
      }),
    ]);
    assert.equal(job1.id, job2.id, 'job IDs must be identical');
    assert.equal(job1.ownerUser, owner);
  });

  // 2.2: Same ID with different payload causes conflict; new command creates new job
  await asyncCheck('2.2: same ID with changed payload conflicts; new command creates new job', async () => {
    const cmdId = 'conflict-cmd-002';
    const first = await enqueueInventoryMaintenance({
      store: gateway,
      actor: owner,
      body: {commandId: cmdId, date: today, maxRows: 100},
    });
    assert.ok(first);

    // Changed payload with same commandId
    await assert.rejects(
      enqueueInventoryMaintenance({
        store: gateway,
        actor: owner,
        body: {commandId: cmdId, date: today, maxRows: 200}, // altered
      }),
      /idempotency/i
    );

    // New command creates distinct new job
    const freshJob = await enqueueInventoryMaintenance({
      store: gateway,
      actor: owner,
      body: {commandId: 'distinct-cmd-003', date: today, maxRows: 200},
    });
    assert.notEqual(freshJob.id, first.id);
  });

  // 2.3: Handler must advance durable boundary before running guard
  await asyncCheck('2.3: handler advances durable boundary strictly prior to runGuard', async () => {
    const testJob = {
      id: 'job_test_boundary_01',
      jobId: 'job_test_boundary_01',
      kind: 'inventory_maintenance',
      ownerUser: owner,
      payload: {
        commandId: 'boundary-check-cmd',
        date: today,
        dryRun: false,
        maxRows: 100,
      },
    };

    let boundaryAdvancedAt = null;
    let guardDispatchedAt = null;

    const mockContext = {
      signal: new AbortController().signal,
      async checkLeaseAsync() {},
      async advanceWriteBoundary(boundary) {
        boundaryAdvancedAt = Date.now();
        assert.equal(boundary, 'inventory_guard_dispatched');
      },
    };

    const mockRunGuard = async () => {
      guardDispatchedAt = Date.now();
      assert.ok(boundaryAdvancedAt !== null, 'write boundary must be advanced BEFORE runGuard');
      assert.ok(guardDispatchedAt >= boundaryAdvancedAt);
      return {status: 0};
    };

    // Test rejection if policy missing authorization
    await assert.rejects(
      runInventoryMaintenanceJob(testJob, mockContext, {
        platform: 'linux',
        inventoryRuntimeRoot: invRuntime,
        runGuard: mockRunGuard,
        loadPolicy: async () => ({execution: {automaticExecution: {enabled: false}}}),
      }),
      /Current inventory policy does not authorize the managed automatic guard/
    );

    // Now test with valid canonical policy
    let capturedEnv = null;
    const mockRunGuardWithEnv = async ({env}) => {
      capturedEnv = env;
      return mockRunGuard();
    };

    await assert.rejects(
      runInventoryMaintenanceJob(testJob, mockContext, {
        platform: 'linux',
        inventoryRuntimeRoot: invRuntime,
        runGuard: mockRunGuardWithEnv,
        loadPolicy: async () => canonicalPolicy,
        resolveEvidence: async () => null, // force guard execution then fail-closed on evidence
      }),
      /Inventory guard has no complete verified artifact set/
    );
    assert.ok(boundaryAdvancedAt !== null, 'boundary was indeed advanced prior to dispatch');
    assert.equal(capturedEnv.SHEIN_BI_INVENTORY_AUTOMATION_CONTEXT, 'cloud_daily_inventory_replenishment_guard');
    assert.equal(capturedEnv.SHEIN_BI_INVENTORY_AUTOMATION_AUTHORIZATION, 'owner-automatic-inventory-20260803-v1');
    assert.equal(capturedEnv.SHEIN_BI_INVENTORY_COMMAND_ID, 'boundary-check-cmd');
  });

  // 2.4: Windows refuses real execution
  await asyncCheck('2.4: platform=win32 refuses real execution directly', async () => {
    const testJob = {
      id: 'job_win32_refusal',
      payload: {commandId: 'win-cmd', date: today, maxRows: 100},
    };
    const mockContext = {
      signal: new AbortController().signal,
      async checkLeaseAsync() {},
      async advanceWriteBoundary() {},
    };
    await assert.rejects(
      runInventoryMaintenanceJob(testJob, mockContext, {platform: 'win32'}),
      /Inventory execution requires the managed Linux cloud runner/
    );
  });

  // 2.5: Missing index / wrong batch does not produce false success
  await asyncCheck('2.5: missing index / wrong batch does not produce false success', async () => {
    const testJob = {
      id: 'job_wrong_batch',
      payload: {commandId: 'wrong-batch-cmd', date: today, maxRows: 100},
    };
    const mockContext = {
      signal: new AbortController().signal,
      async checkLeaseAsync() {},
      async advanceWriteBoundary() {},
    };
    await assert.rejects(
      runInventoryMaintenanceJob(testJob, mockContext, {
        platform: 'linux',
        inventoryRuntimeRoot: invRuntime,
        runGuard: async () => ({status: 0}),
        loadPolicy: async () => canonicalPolicy,
        resolveEvidence: async () => null, // no valid index/evidence
      }),
      /Inventory guard has no complete verified artifact set/
    );
  });

  // 2.6: Uncertain error does not rerun automatically
  await asyncCheck('2.6: uncertain error sets uncertainWrite=true and forbids auto-retry', async () => {
    const testJob = {
      id: 'job_uncertain_test',
      payload: {commandId: 'uncertain-cmd', date: today, maxRows: 100, dryRun: false},
    };
    const mockContext = {
      signal: new AbortController().signal,
      async checkLeaseAsync() {},
      async advanceWriteBoundary() {},
    };
    try {
      await runInventoryMaintenanceJob(testJob, mockContext, {
        platform: 'linux',
        inventoryRuntimeRoot: invRuntime,
        runGuard: async () => { throw new Error('GUARD_NETWORK_TIMEOUT'); },
        loadPolicy: async () => canonicalPolicy,
        resolveEvidence: async () => null,
      });
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.code, 'INVENTORY_GUARD_UNCERTAIN');
      assert.equal(err.uncertainWrite, true, 'non-dry-run failed execution must mark uncertainWrite');
    }
  });

  // =========================================================================
  // SUITE 3: Direct CLI with in-process mock transport (no sockets or APIs).
  // =========================================================================
  console.log('\n--- Suite 3: Direct CLI Offline Transport Contract ---');
  const sessionDir = path.join(tempRoot, 'cli-session');
  const sessionFile = path.join(sessionDir, 'session.json');
  const callsFile = path.join(tempRoot, 'cli-calls.jsonl');
  const transportFile = path.join(tempRoot, 'cli-transport.mjs');
  await writeJson(sessionFile, {username: 'test_operator_cli'});
  await fs.writeFile(callsFile, '');
  await fs.writeFile(transportFile, `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import crypto from 'node:crypto';
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), 'https://inventory-cli.invalid/api/inventory-replenishment-run');
      assert.equal(options.method, 'POST');
      const payload = JSON.parse(options.body);
      const receiptFile = path.join(process.env.CLI_FIXTURE_SESSION_DIR, 'inventory-commands',
        crypto.createHash('sha256').update(payload.commandId).digest('hex') + '.json');
      const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
      assert.deepEqual(receipt.request, payload, 'exact receipt must exist before dispatch');
      assert.ok(receipt.status === 'dispatch_pending' || receipt.response);
      await fs.appendFile(process.env.CLI_FIXTURE_CALLS, JSON.stringify(payload) + '\\n');
      return new Response(JSON.stringify({ok: true, data: {
        jobId: 'fixture_' + payload.commandId, commandId: payload.commandId, status: 'queued',
      }}), {status: 202, headers: {'content-type': 'application/json'}});
    };
  `);
  const cli = (command, flags = []) => execFileAsync(process.execPath, [
    '--import', pathToFileURL(transportFile).href, path.join(SCRIPT_ROOT, 'scripts', 'bi_ops_cli.mjs'),
    command, '--base-url', 'https://inventory-cli.invalid', '--session-file', sessionFile,
    ...flags,
  ], {cwd: SCRIPT_ROOT, windowsHide: true, env: {
    ...process.env, CLI_FIXTURE_SESSION_DIR: sessionDir, CLI_FIXTURE_CALLS: callsFile,
  }});
  const calls = async () => (await fs.readFile(callsFile, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const receiptPath = id => path.join(sessionDir, 'inventory-commands', crypto.createHash('sha256').update(id).digest('hex') + '.json');

  await asyncCheck('3.1: all aliases default to execution; explicit preview wins; queued is not completed', async () => {
    for (const command of ['maintain-inventory', 'maintain_inventory', 'replenish-inventory', 'replenish_inventory']) {
      for (const [flags, dryRun] of [
        [[], false], [['--dry-run'], true], [['--mode', 'dry-run'], true],
        [['--mode', 'execute'], false], [['--mode', 'execute', '--dry-run'], true],
        [['--dry-run', '--mode', 'execute'], true],
        [['--mode'], true],
      ]) {
        const before = (await calls()).length;
        const {stdout, stderr} = await cli(command, flags);
        const sent = await calls();
        assert.equal(sent.length, before + 1);
        const payload = sent.at(-1);
        assert.equal(payload.dryRun, dryRun, command + ' ' + flags.join(' '));
        assert.match(payload.commandId, /^[0-9a-f-]{36}$/);
        assert.match(stdout, /queued/);
        assert.doesNotMatch(stdout, /completed/);
        assert.ok(stderr.includes(payload.commandId));
        const receipt = JSON.parse(await fs.readFile(receiptPath(payload.commandId), 'utf8'));
        assert.deepEqual(receipt.request, payload);
        assert.equal(receipt.response.data.status, 'queued');
      }
    }
  });

  await asyncCheck('3.1b: invalid inventory modes reject before receipt or dispatch, even with --dry-run', async () => {
    for (const command of ['maintain-inventory', 'maintain_inventory', 'replenish-inventory', 'replenish_inventory']) {
      for (const mode of ['unsupported', 'dry_run']) {
        for (const flags of [['--mode', mode], ['--mode', mode, '--dry-run'], ['--dry-run', '--mode', mode]]) {
          const commandId = crypto.randomUUID();
          const before = (await calls()).length;
          const receiptsBefore = await fs.readdir(path.join(sessionDir, 'inventory-commands'));
          await assert.rejects(cli(command, ['--command-id', commandId, ...flags]), /Inventory maintenance --mode must be execute or dry-run/);
          assert.equal((await calls()).length, before, 'invalid mode must not dispatch');
          await assert.rejects(fs.readFile(receiptPath(commandId)), {code: 'ENOENT'});
          assert.deepEqual(await fs.readdir(path.join(sessionDir, 'inventory-commands')), receiptsBefore);
        }
      }
    }
  });

  await asyncCheck('3.2: same ID preserves date and parameters; drift never dispatches', async () => {
    const flags = ['--command-id', 'same-execution', '--date', businessDate];
    await cli('maintain-inventory', flags);
    const original = (await calls()).at(-1);
    await cli('maintain-inventory', ['--command-id', 'same-execution']);
    assert.deepEqual((await calls()).at(-1), original);
    for (const drift of [['--max-rows', '500'], ['--dry-run'], ['--date', today]]) {
      const before = (await calls()).length;
      await assert.rejects(cli('maintain-inventory', [...flags, ...drift]), /already belongs to a different inventory request/);
      assert.equal((await calls()).length, before);
    }
  });

  await asyncCheck('3.3: old dry-run receipts cannot become execution; new ID requests a fresh plan', async () => {
    for (const status of ['dispatch_pending', 'responded']) {
      const commandId = 'old-preview-' + status;
      const request = {date: businessDate, commandId, dryRun: true, maxRows: 1000};
      await writeJson(receiptPath(commandId), {commandId, request, ...(status === 'dispatch_pending'
        ? {status} : {response: {ok: true, data: {status: 'queued'}}})});
      const original = await fs.readFile(receiptPath(commandId), 'utf8');
      for (const command of ['maintain-inventory', 'maintain_inventory', 'replenish-inventory', 'replenish_inventory']) {
        for (const mode of [[], ['--mode', 'execute']]) {
          const before = (await calls()).length;
          await assert.rejects(cli(command, ['--command-id', commandId, ...mode]), /new command ID and a fresh cloud plan/);
          assert.equal((await calls()).length, before, 'old preview must not resubmit');
          assert.equal(await fs.readFile(receiptPath(commandId), 'utf8'), original);
        }
      }
      for (const preview of [['--dry-run'], ['--mode', 'dry-run']]) {
        await cli('maintain-inventory', ['--command-id', commandId, ...preview]);
        assert.deepEqual((await calls()).at(-1), request);
      }
      await cli('maintain-inventory', ['--command-id', 'fresh-execution-' + status]);
      const fresh = (await calls()).at(-1);
      assert.notEqual(fresh.commandId, commandId);
      assert.equal(fresh.dryRun, false);
      assert.equal(fresh.date, today);
      assert.deepEqual(Object.keys(fresh), ['date', 'commandId', 'dryRun', 'maxRows'], 'no old plan is replayed');
    }
  });

  await asyncCheck('3.4: unrelated commands retain global dry-run default and explicit mode behavior', async () => {
    const source = await fs.readFile(path.join(SCRIPT_ROOT, 'scripts', 'bi_ops_cli.mjs'), 'utf8');
    const parser = source.slice(source.indexOf('function parseArgs('), source.indexOf('function normalizeOperationName('));
    const parse = vm.runInNewContext(parser + '; parseArgs', {
      DEFAULT_BASE_URL: 'https://inventory-cli.invalid', DEFAULT_SESSION_FILE: sessionFile,
      DEFAULT_PARTNER_KNOWLEDGE_CACHE_DIR: tempRoot,
      process: {env: {}},
    });
    for (const command of ['upload-pic', 'transform-pic', 'audit-status', 'search-product', 'publish-standard', 'shelf-quota', 'query']) {
      assert.equal(parse([command]).mode, 'dry-run');
      assert.equal(parse([command]).modeProvided, false);
      for (const mode of ['dry-run', 'execute', 'unsupported']) {
        assert.equal(parse([command, '--mode', mode]).mode, mode);
        assert.equal(parse([command, '--mode', mode]).modeProvided, true);
      }
    }
  });

  // =========================================================================
  // Clean up temporary files
  // =========================================================================
  await fs.rm(tempRoot, {recursive: true, force: true});
  console.log('\n[CLEANUP] Successfully removed temporary directory:', tempRoot);

  console.log(`\n======================================================`);
  console.log(`All ${totalChecks} test checks passed cleanly with 0 failures!`);
  console.log(`======================================================\n`);
} catch (error) {
  await fs.rm(tempRoot, {recursive: true, force: true}).catch(() => {});
  console.error('Test suite execution failed:', error);
  process.exit(1);
}
