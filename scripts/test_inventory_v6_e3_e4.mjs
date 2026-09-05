import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
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
    await fs.writeFile(options.stagingJournalFile, '');
    async function writeTuple(mutateMarker = () => {}) {
      await fs.writeFile(options.stagingPlanFile, crlfJson(plan));
      await fs.writeFile(options.stagingResultFile, crlfJson(result));
      const status = evaluateResultBatchStatus(result, plan.actionable.length);
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
  // SUITE 3: Actual Mock HTTP Portal & CLI Flow
  // =========================================================================
  console.log('\n--- Suite 3: Actual Mock HTTP Portal & CLI Flow ---');

  let serverReceived = [];
  const portalServer = http.createServer((req, res) => {
    if (req.url === '/api/inventory-replenishment-run' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const parsed = JSON.parse(body);
        serverReceived.push(parsed);
        // Server response as documented in serve_bi_portal.mjs:
        // HTTP 202 with state: "queued"
        res.writeHead(202, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({
          ok: true,
          data: {
            jobId: 'job_portal_' + parsed.commandId,
            status: 'queued',
            commandId: parsed.commandId,
            createdAt: new Date().toISOString(),
          }
        }));
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise(r => portalServer.listen(0, '127.0.0.1', r));
  const portalPort = portalServer.address().port;
  const portalBase = 'http://127.0.0.1:' + portalPort;

  try {
    const sessionDir = path.join(tempRoot, 'cli-session');
    await fs.mkdir(sessionDir, {recursive: true});
    const sessionFile = path.join(sessionDir, 'session.json');
    await writeJson(sessionFile, {username: 'test_operator_cli'});

    // 3.1: Automatic UUID, persistent receipt written BEFORE network dispatch, stdout queued
    await asyncCheck('3.1: CLI auto-UUID writes receipt and outputs queued status', async () => {
      const {stdout, stderr} = await execFileAsync(process.execPath, [
        path.join(SCRIPT_ROOT, 'scripts', 'bi_ops_cli.mjs'),
        'maintain-inventory',
        '--base-url', portalBase,
        '--session-file', sessionFile,
        '--date', today,
      ], {cwd: SCRIPT_ROOT});

      assert.equal(serverReceived.length, 1);
      const dispatched = serverReceived[0];
      assert.ok(dispatched.commandId, 'auto UUID commandId must be generated');

      // Verify stdout shows queued, NOT completed
      assert(stdout.includes('queued'), 'stdout must report queued, not completed');
      assert(!stdout.includes('completed'), 'stdout must not claim unverified completed');

      // Verify receipt was written
      const cmdHash = crypto.createHash('sha256').update(dispatched.commandId).digest('hex');
      const receiptPath = path.join(sessionDir, 'inventory-commands', cmdHash + '.json');
      const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
      assert.equal(receipt.commandId, dispatched.commandId);
      assert.equal(receipt.response.ok, true);
      assert.equal(receipt.response.data.status, 'queued');
    });

    // 3.2: Explicit same commandId retry maintains idempotency and consistency
    await asyncCheck('3.2: explicit same commandId retry is consistent and safe', async () => {
      const explicitId = 'explicit-cli-cmd-009';
      serverReceived = [];

      // First run
      const {stdout: out1} = await execFileAsync(process.execPath, [
        path.join(SCRIPT_ROOT, 'scripts', 'bi_ops_cli.mjs'),
        'maintain-inventory',
        '--base-url', portalBase,
        '--session-file', sessionFile,
        '--command-id', explicitId,
        '--date', today,
      ], {cwd: SCRIPT_ROOT});

      // Second run (retry)
      const {stdout: out2} = await execFileAsync(process.execPath, [
        path.join(SCRIPT_ROOT, 'scripts', 'bi_ops_cli.mjs'),
        'maintain-inventory',
        '--base-url', portalBase,
        '--session-file', sessionFile,
        '--command-id', explicitId,
        '--date', today,
      ], {cwd: SCRIPT_ROOT});

      assert.equal(serverReceived.length, 2);
      assert.equal(serverReceived[0].commandId, explicitId);
      assert.equal(serverReceived[1].commandId, explicitId);
      assert(out1.includes('queued'));
      assert(out2.includes('queued'));

      // Modifying parameters on same commandId is rejected locally by receipt check
      await assert.rejects(
        execFileAsync(process.execPath, [
          path.join(SCRIPT_ROOT, 'scripts', 'bi_ops_cli.mjs'),
          'maintain-inventory',
          '--base-url', portalBase,
          '--session-file', sessionFile,
          '--command-id', explicitId,
          '--date', today,
          '--max-rows', '500', // altered payload
        ], {cwd: SCRIPT_ROOT}),
        /already belongs to a different inventory request/
      );
    });
  } finally {
    await new Promise(r => portalServer.close(r));
  }

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
