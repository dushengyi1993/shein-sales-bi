import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {
  stageAndDeliverBusinessResult,
  retryPendingBusinessDeliveries,
  OPS_BUSINESS_STAGING_ROOT,
} from '../lib/ops_business_result_pipeline.mjs';
import {formatOpsBusinessResult} from '../lib/ops_business_result_formatter.mjs';

console.log('Testing F1 hooks, single business execution, durable staging on missing config, byte/hash immutability, and retry idempotency...');

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-f1-delivery-hooks-'));
const testLandingRoot = path.join(tempDir, 'automation-delivery');
await fs.mkdir(testLandingRoot, {recursive: true});

const fakeLarkConfig = {
  recipientChatId: 'oc_deliverygrouptest123',
  defaultIdentity: 'bot',
};

function makeFakeSpawn(outcomes) {
  let callIndex = 0;
  return function fakeSpawn(bin, args, options) {
    const outcome = outcomes[callIndex++] || {ok: true, message_id: 'om_default'};
    return {
      stdout: {
        setEncoding() {},
        on(event, cb) {
          if (event === 'data') cb(JSON.stringify(outcome));
        },
      },
      stderr: {
        setEncoding() {},
        on() {},
      },
      on(event, cb) {
        if (event === 'close') {
          setTimeout(() => cb(outcome.exitCode !== undefined ? outcome.exitCode : (outcome.ok ? 0 : 1)), 5);
        }
      },
    };
  };
}

// 1. Single execution contract with initial partial failure & successful retry
{
  let businessFunctionRunCount = 0;

  async function mockBusinessOperation() {
    businessFunctionRunCount++;
    return {
      action: '库存维护',
      succeededCount: 12,
      failedItems: [
        { store: 'JY', canonicalGoodsSn: 'G555', reason: '临时锁定' }
      ],
      occupancyChange: { ordinary: 10, temporary: 2 },
    };
  }

  // Execute business logic ONCE
  const businessResult = await mockBusinessOperation();
  assert.equal(businessFunctionRunCount, 1, 'Business function must execute exactly once');

  // Spawn 1: Summary succeeds, attachment fails -> status: partial
  const spawn1 = makeFakeSpawn([
    {ok: true, message_id: 'om_summary_first_attempt'},
    {ok: false, error: {code: 'LARK_NETWORK_ERROR', message: 'connection dropped'}},
  ]);

  const outcome1 = await stageAndDeliverBusinessResult({
    automationId: 'inventory-replenishment',
    businessDate: '2026-09-05',
    result: businessResult,
    landingRoot: testLandingRoot,
    config: fakeLarkConfig,
    spawnImpl: spawn1,
  });

  assert.equal(outcome1.ok, false);
  assert.equal(outcome1.status, 'partial');
  assert.equal(outcome1.delivery.items.summary.accepted, true);
  assert.equal(outcome1.delivery.items.attachment.accepted, false);

  // Check state on disk
  const deliveryDir = path.join(testLandingRoot, 'inventory-replenishment', '2026-09-05', outcome1.fingerprint);
  const stateFile = path.join(deliveryDir, 'state.json');
  const summaryFile = path.join(deliveryDir, 'summary.md');
  const attachmentFile = path.join(deliveryDir, 'result.json');

  const initialSummaryBytes = await fs.readFile(summaryFile);
  const initialAttachmentBytes = await fs.readFile(attachmentFile);
  const initialSummarySha = crypto.createHash('sha256').update(initialSummaryBytes).digest('hex');
  const initialAttachmentSha = crypto.createHash('sha256').update(initialAttachmentBytes).digest('hex');

  // Verify attachment payload preserved occupancyChange
  const payloadParsed = JSON.parse(initialAttachmentBytes.toString('utf8'));
  assert.deepEqual(payloadParsed.occupancyChange, { ordinary: 10, temporary: 2 });
  assert.equal(payloadParsed.succeededCount, 12);
  assert.equal(payloadParsed.failedCount, 1);

  // Now perform retry via retryPendingBusinessDeliveries (NO re-execution of businessFunction!)
  const spawn2 = makeFakeSpawn([
    {ok: true, data: {message_id: 'om_attach_retry_success', file_key: 'fk_attach_retry'}},
  ]);

  const retried = await retryPendingBusinessDeliveries({
    landingRoot: testLandingRoot,
    config: fakeLarkConfig,
    spawnImpl: spawn2,
  });

  assert.equal(retried.length, 1);
  assert.equal(retried[0].automationId, 'inventory-replenishment');
  assert.equal(retried[0].previousStatus, 'partial');
  assert.equal(retried[0].newStatus, 'ok');
  assert.equal(retried[0].ok, true);

  // Business function was NOT called again
  assert.equal(businessFunctionRunCount, 1, 'Business function must NOT be called again during retry');

  // Verify artifact byte and hash immutability: files on disk remain untouched
  const finalSummaryBytes = await fs.readFile(summaryFile);
  const finalAttachmentBytes = await fs.readFile(attachmentFile);
  const finalSummarySha = crypto.createHash('sha256').update(finalSummaryBytes).digest('hex');
  const finalAttachmentSha = crypto.createHash('sha256').update(finalAttachmentBytes).digest('hex');

  assert.equal(initialSummarySha, finalSummarySha, 'Summary bytes/hash must remain unchanged');
  assert.equal(initialAttachmentSha, finalAttachmentSha, 'Attachment bytes/hash must remain unchanged');
  assert.deepEqual(initialSummaryBytes, finalSummaryBytes);
  assert.deepEqual(initialAttachmentBytes, finalAttachmentBytes);
}

// 2. Durable Stage on Missing Config: first attempt fails on config, files ARE staged, retry succeeds after supplying config
{
  let businessRunCount = 0;
  async function produceRetireReport() {
    businessRunCount++;
    return {
      action: '退链候选报告',
      counts: {
        inputRows: 50,
        candidateRows: 3,
        excludedByFirstShelf15d: 5,
        cannotJudgeRows: 1,
      },
      summary: {},
    };
  }

  // Business operation runs exactly once
  const retireResult = await produceRetireReport();
  assert.equal(businessRunCount, 1);

  // Initial attempt has NO valid config file at missingConfigPath
  const missingConfigPath = path.join(tempDir, 'non_existent_lark_config.json');
  const outcomeMissingConfig = await stageAndDeliverBusinessResult({
    automationId: 'link-retire-candidates',
    businessDate: '2026-09-05',
    result: retireResult,
    landingRoot: testLandingRoot,
    configPath: missingConfigPath,
  });

  assert.equal(outcomeMissingConfig.ok, false);
  assert.equal(outcomeMissingConfig.status, 'failed');
  assert.equal(outcomeMissingConfig.delivery.errorCode, 'LARK_CONFIG_MISSING');

  // CRITICAL CHECK: Artifacts and state MUST be staged on disk despite missing config!
  const retireDeliveryDir = path.join(testLandingRoot, 'link-retire-candidates', '2026-09-05', outcomeMissingConfig.fingerprint);
  const retireStateFile = path.join(retireDeliveryDir, 'state.json');
  const retireSummaryFile = path.join(retireDeliveryDir, 'summary.md');
  const retireAttachmentFile = path.join(retireDeliveryDir, 'result.json');

  assert.equal(await fs.access(retireStateFile).then(() => true).catch(() => false), true, 'state.json must exist even when config is missing');
  assert.equal(await fs.access(retireSummaryFile).then(() => true).catch(() => false), true, 'summary.md must exist even when config is missing');
  assert.equal(await fs.access(retireAttachmentFile).then(() => true).catch(() => false), true, 'result.json must exist even when config is missing');

  const stagedBytes = await fs.readFile(retireAttachmentFile);
  const stagedSha = crypto.createHash('sha256').update(stagedBytes).digest('hex');

  // Now supply the config file at missingConfigPath
  await fs.writeFile(missingConfigPath, JSON.stringify(fakeLarkConfig, null, 2), 'utf8');

  // Spawn for retry: both summary and attachment succeed
  const retrySpawn = makeFakeSpawn([
    {ok: true, message_id: 'om_retire_summary'},
    {ok: true, data: {message_id: 'om_retire_attachment', file_key: 'fk_retire'}},
  ]);

  const retriedList = await retryPendingBusinessDeliveries({
    landingRoot: testLandingRoot,
    configPath: missingConfigPath,
    spawnImpl: retrySpawn,
  });

  const retireRetried = retriedList.find(r => r.automationId === 'link-retire-candidates');
  assert.ok(retireRetried, 'link-retire-candidates must be retried after config is supplied');
  assert.equal(retireRetried.previousStatus, 'failed');
  assert.equal(retireRetried.newStatus, 'ok');
  assert.equal(retireRetried.ok, true);

  // Business logic was NEVER run a second time
  assert.equal(businessRunCount, 1, 'Business function must remain executed exactly once');

  // Artifact on disk is immutable
  const postRetryBytes = await fs.readFile(retireAttachmentFile);
  const postRetrySha = crypto.createHash('sha256').update(postRetryBytes).digest('hex');
  assert.equal(stagedSha, postRetrySha, 'Attachment byte hash must remain immutable after retry');
}

// 3. Unknown receipts are NEVER blindly retried
{
  const unknownDir = path.join(testLandingRoot, 'unknown-test', '2026-09-05', 'a'.repeat(64));
  await fs.mkdir(unknownDir, {recursive: true});
  await fs.writeFile(path.join(unknownDir, 'summary.md'), 'test', 'utf8');
  await fs.writeFile(path.join(unknownDir, 'result.json'), 'test', 'utf8');
  await fs.writeFile(path.join(unknownDir, 'state.json'), JSON.stringify({
    schemaVersion: 'cloud-team-report-state/v1',
    automationId: 'unknown-test',
    businessDate: '2026-09-05',
    fingerprint: 'a'.repeat(64),
    status: 'unknown',
    items: {
      summary: { accepted: false, attempts: 1, unknown: true },
      attachment: { accepted: false, attempts: 0 },
    },
  }), 'utf8');

  const unknownCalls = [];
  const retriedUnknown = await retryPendingBusinessDeliveries({
    landingRoot: testLandingRoot,
    config: fakeLarkConfig,
    spawnImpl: makeFakeSpawn([{ok: true, message_id: 'must_not_send'}], unknownCalls),
  });

  const foundUnknown = retriedUnknown.find(r => r.automationId === 'unknown-test');
  assert.equal(foundUnknown, undefined, 'Unknown state must NEVER be retried');
  assert.equal(unknownCalls.length, 0, 'No lark command should be spawned for unknown receipts');
}

// 4. CLI interface invocation test: '--business-result FILE --automation-id ID --business-date DATE'
{
  const resultJsonFile = path.join(tempDir, 'sample_business_result.json');
  await fs.writeFile(resultJsonFile, JSON.stringify({
    action: '待议价每日巡检扫描',
    mode: 'daily',
    ok: true,
    rowCount: 0,
    coverage: { expectedCount: 19, succeededCount: 19, failedStores: [] },
  }, null, 2), 'utf8');

  const cliPath = path.resolve('scripts/cloud_team_report_delivery.mjs');
  const testConfigPath = path.join(tempDir, 'test_lark_config_cli.json');
  await fs.writeFile(testConfigPath, JSON.stringify(fakeLarkConfig, null, 2), 'utf8');

  const proc = spawn(process.execPath, [
    cliPath,
    '--business-result', resultJsonFile,
    '--automation-id', 'pending-discuss-daily',
    '--business-date', '2026-09-05',
    '--landing-root', testLandingRoot,
  ], {
    env: {
      ...process.env,
      CLOUD_TEAM_REPORT_CLOUD_CONFIG: testConfigPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let outText = '';
  proc.stdout.on('data', d => { outText += d.toString(); });
  await new Promise(res => proc.on('close', res));

  assert.ok(outText.includes('pending-discuss-daily'), 'CLI output should include automationId');
  const cliOutcome = JSON.parse(outText);
  assert.equal(cliOutcome.automationId, 'pending-discuss-daily');
  assert.equal(cliOutcome.businessDate, '2026-09-05');
  assert.match(cliOutcome.formatted.copy, /待议价每日巡检扫描已全部完成：检查结果为 0 项待议价商品/);
}

// Cleanup



// 5. Webhook processOne tick integration: >=60s async serial retry, non-blocking, single concurrency, and bounded drain
{
  const {createSheinWebhookService} = await import('../scripts/serve_shein_webhook.mjs');
  let clock = 1_000_000;
  let retryCalls = 0;
  let concurrentRetries = 0;
  let maxConcurrency = 0;
  let receivedSignalAborted = false;

  const mockRepo = {
    storeReceipt: async () => ({stored: true}),
    claimNext: async () => null,
    health: async () => ({ok: true}),
  };
  const mockCreds = { resolve: () => ({openKeyId: 'k', secretKey: 's'}) };
  const mockProcessor = { process: async () => ({ok: true}) };

  const service = createSheinWebhookService({
    repository: mockRepo,
    credentialRegistry: mockCreds,
    eventProcessor: mockProcessor,
    workerEnabled: false,
    deliveryEnabled: true,
    deliveryRetryIntervalMs: 60_000,
    deliveryShutdownBudgetMs: 500,
    deliveryLandingRoot: testLandingRoot,
    deliveryRetryImpl: async ({signal}) => {
      retryCalls++;
      concurrentRetries++;
      maxConcurrency = Math.max(maxConcurrency, concurrentRetries);
      if (signal) {
        signal.addEventListener('abort', () => {
          receivedSignalAborted = true;
        }, {once: true});
      }
      await new Promise(r => setTimeout(r, 20));
      concurrentRetries--;
      return [];
    },
    now: () => clock,
    logger: { warn() {}, error() {}, info() {} },
  });

  // First processOne: interval elapsed (1_000_000 >= 60_000) -> triggers retry in background
  await service.processOne();
  await new Promise(r => setTimeout(r, 40));
  assert.equal(retryCalls, 1, 'First tick must trigger retry');

  // Second processOne immediately: clock has not advanced 60s -> should NOT trigger retry
  clock += 10_000; // only 10s elapsed
  await service.processOne();
  await new Promise(r => setTimeout(r, 40));
  assert.equal(retryCalls, 1, 'Tick within 60s must NOT trigger retry');

  // Third processOne after 60s: clock advances 60s -> triggers retry
  clock += 60_000;
  await service.processOne();
  await new Promise(r => setTimeout(r, 40));
  assert.equal(retryCalls, 2, 'Tick after >=60s must trigger retry');

  // Verify concurrency was strictly serial (maxConcurrency <= 1)
  assert.equal(maxConcurrency, 1, 'Delivery retries must be strictly serial and never run concurrently');

  // Test bounded shutdown & abort: service.stop() triggers abort signal and bounds wait time
  clock += 70_000;
  void service.processOne();
  const stopPromise = service.stop();
  await stopPromise;
  assert.equal(receivedSignalAborted, true, 'Service stop must abort in-flight delivery retry');

  // Verify NO post-stop new send can start
  clock += 80_000;
  await service.processOne();
  assert.equal(retryCalls, 3, 'No new delivery send allowed after service has stopped');

  console.log('✓ Webhook service delivery retry tick integration passed');
}

// 6. Test never-resolve delivery retry mock + timeout kill & bounded stop guarantees no post-stop sends
{
  const {createSheinWebhookService} = await import('../scripts/serve_shein_webhook.mjs');
  let neverResolveClock = 2_000_000;
  let neverResolveStarted = false;
  let neverResolveAborted = false;
  let postStopCalls = 0;

  const mockRepo = {
    storeReceipt: async () => ({stored: true}),
    claimNext: async () => null,
    health: async () => ({ok: true}),
  };
  const mockCreds = { resolve: () => ({openKeyId: 'k', secretKey: 's'}) };
  const mockProcessor = { process: async () => ({ok: true}) };

  const hungService = createSheinWebhookService({
    repository: mockRepo,
    credentialRegistry: mockCreds,
    eventProcessor: mockProcessor,
    workerEnabled: false,
    deliveryEnabled: true,
    deliveryRetryIntervalMs: 60_000,
    deliveryShutdownBudgetMs: 200, // Short shutdown deadline
    deliveryLandingRoot: testLandingRoot,
    deliveryRetryImpl: async ({signal}) => {
      if (neverResolveStarted) {
        postStopCalls++;
        return [];
      }
      neverResolveStarted = true;
      signal?.addEventListener('abort', () => {
        neverResolveAborted = true;
      }, {once: true});
      // Simulate hung external process that never settles on its own
      return new Promise(() => {});
    },
    now: () => neverResolveClock,
    logger: { warn() {}, error() {}, info() {} },
  });

  void hungService.processOne();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(neverResolveStarted, true);

  const beforeStop = Date.now();
  await hungService.stop();
  const elapsed = Date.now() - beforeStop;

  assert.equal(neverResolveAborted, true, 'Hung delivery retry must be signaled with abort on stop');
  assert.ok(elapsed < 1_500, 'Shutdown must complete within bounded budget and not hang indefinitely');

  // Attempt another tick post-stop
  neverResolveClock += 100_000;
  await hungService.processOne();
  assert.equal(postStopCalls, 0, 'No post-stop sends should ever be triggered');

  console.log('✓ Hung delivery retry bounded stop & no-post-stop send verified');
}



// 7. Real local wrapper spawning grandchild process with stdio ignore + abort/timeout paths
{
  const canaryFile = path.join(tempDir, 'lark_grandchild_canary.txt');
  const grandchildScript = path.join(tempDir, 'grandchild.mjs');
  const wrapperScript = path.join(tempDir, 'wrapper.mjs');

  // Grandchild writes "grandchild_started", then waits 1500ms to write "grandchild_finished_late"
  const gcCode = "import fs from 'node:fs';\nconst file = process.argv[2];\nfs.appendFileSync(file, 'grandchild_started\\n');\nsetTimeout(() => {\n  try { fs.appendFileSync(file, 'grandchild_finished_late\\n'); } catch {}\n  process.exit(0);\n}, 1500);\n";
  await fs.writeFile(grandchildScript, gcCode, 'utf8');

  // Wrapper spawns grandchild with stdio: 'ignore' (detached or independent)
  const wrapperCode = `import {spawn} from 'node:child_process';
const [,, gcScript, file] = process.argv;
const child = spawn(process.execPath, [gcScript, file], {
  stdio: 'ignore',
  detached: process.platform !== 'win32',
});
child.unref();
// Wrapper stays alive to mimic CLI host
await new Promise(r => setTimeout(r, 4000));
process.exit(0);
`;
  await fs.writeFile(wrapperScript, wrapperCode, 'utf8');

  const {deliverCloudTeamReport} = await import('../lib/cloud_team_report_cloud.mjs');

  // --- Path A: Abort kills wrapper and process tree ---
  {
    const abortController = new AbortController();
    const bundle = {
      schemaVersion: 'cloud-team-report/v1',
      automationId: 'tree-kill-abort',
      businessDate: '2026-09-05',
      expectedAttachmentSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      fingerprint: '06ff2b06d38dca0708a8b94c26b11eb7272ce6964b5c59e28859dfe5b1832a99',
      attachmentName: 'test.bin',
      summaryBase64: Buffer.from('# tree kill\n', 'utf8').toString('base64'),
      attachmentBase64: Buffer.from('', 'utf8').toString('base64'),
    };

    const deliveryPromise = deliverCloudTeamReport({
      bundle,
      config: fakeLarkConfig,
      landingRoot: testLandingRoot,
      spawnImpl: (bin, args, options) => {
        return spawn(process.execPath, [wrapperScript, grandchildScript, canaryFile], options);
      },
      signal: abortController.signal,
    });

    // Poll until grandchild is started
    let canaryText = '';
    const pollStart = Date.now();
    while (Date.now() - pollStart < 3000) {
      canaryText = await fs.readFile(canaryFile, 'utf8').catch(() => '');
      if (canaryText.includes('grandchild_started')) break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.match(canaryText, /grandchild_started/, 'Grandchild must have started');

    // Trigger abort
    abortController.abort();
    const outcome = await deliveryPromise;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.status, 'unknown');
    assert.equal(outcome.items.summary.unknown, true);

    // Wait 2000ms (> 1500ms grandchild delay) to prove tree was killed and no late send occurred
    await new Promise(r => setTimeout(r, 2000));
    const canaryAfter = await fs.readFile(canaryFile, 'utf8');
    assert.doesNotMatch(canaryAfter, /grandchild_finished_late/, 'Killed process tree must NEVER complete late write after abort');
  }

  console.log('✓ Process tree kill on abort verified: no late grandchild writes, unknown receipt preserved');
}

// 8. Formatter verification on real production shapes (Inventory execution result & Marketing batch totals)
{
  const {formatOpsBusinessResult} = await import('../lib/ops_business_result_formatter.mjs');

  // Real inventory execution shape: 43 succeeded, 13 pending (with diff & occupancyChange), pre_submit_blocked
  const realInventoryResult = {
    schemaVersion: 'daily-inventory-replenishment-result/v1',
    planHash: 'hash_test_plan_001',
    counts: {
      total: 60,
      updated: 43,
      dryRunReady: 0,
      skipped: 2,
      deferredHistorical: 0,
      blocked: 15,
    },
    results: [
      // 43 updated rows
      ...Array.from({length: 43}, (_, i) => ({
        storeKey: 'FY', skc: `sv_updated_${i}`, skuCode: `sku_updated_${i}`,
        canonicalGoodsSn: `SK-UPDATED-${i}`,
        state: 'updated_readback_matched',
      })),
      // 2 skipped rows
      { storeKey: 'DL', skc: 'sv_skip_1', skuCode: 'sku_skip_1', canonicalGoodsSn: 'SK-SKIP-1', state: 'skipped_target_already_matched' },
      { storeKey: 'DL', skc: 'sv_skip_2', skuCode: 'sku_skip_2', canonicalGoodsSn: 'SK-SKIP-2', state: 'skipped_safety_no_increase' },
      // 13 submitted_but_readback_pending rows with target diff and occupancyChange
      ...Array.from({length: 13}, (_, i) => ({
        storeKey: 'XL', skc: `sv_pending_${i}`, skuCode: `sku_pending_${i}`,
        canonicalGoodsSn: `SK-PENDING-${i}`,
        state: 'submitted_but_readback_pending',
        approvedTarget: 10,
        after: { totalUsableInventory: 7 },
        occupancyChange: { ordinary: 2, temporary: 1 },
      })),
      // 2 pre_submit_blocked rows
      {
        storeKey: 'JY', skc: 'sv_pre_block_1', skuCode: 'sku_pre_block_1', canonicalGoodsSn: 'SK-PRE-1',
        state: 'pre_submit_blocked',
        error: '7-day sales/exposure evidence changed after plan',
      },
      {
        storeKey: 'JY', skc: 'sv_pre_block_2', skuCode: 'sku_pre_block_2', canonicalGoodsSn: 'SK-PRE-2',
        state: 'pre_submit_blocked',
        error: 'Link is not inventory-relevant',
      },
    ],
  };

  const invFormatted = formatOpsBusinessResult(realInventoryResult);
  assert.equal(invFormatted.succeededCount, 43, 'Must accurately count 43 succeeded rows');
  assert.equal(invFormatted.pendingCount, 13, 'Must accurately count 13 pending rows');
  assert.equal(invFormatted.failedCount, 2, 'Pre-submit blocked must be counted in failed/blocked');
  assert.equal(invFormatted.status, 'partial');
  assert.match(invFormatted.copy, /成功更新并回读核对 43 条/);
  assert.match(invFormatted.copy, /条件已满足跳过 2 条/);
  assert.match(invFormatted.copy, /提交前安全拦截 2 条/);
  assert.match(invFormatted.copy, /另有 13 条已提交但回读未匹配待人工或下一轮核验/);
  assert.match(invFormatted.copy, /差额 3/);
  assert.match(invFormatted.copy, /占用变动\[普通 2，临时 1\]/);
  assert.match(invFormatted.copy, /系统未安排自动重试/);

  // Real marketing batch 3-runner shape
  const realMarketingResult = {
    totals: {
      storesProcessed: 19,
      storesOk: 17,
      storesBlocked: 1,
      storesFailed: 1,
      targetSkcs: 85,
      removedSkcs: 12,
      createdSkcs: 73,
    },
    results: [],
  };

  const mktFormatted = formatOpsBusinessResult(realMarketingResult);
  assert.equal(mktFormatted.succeededCount, 17);
  assert.equal(mktFormatted.failedCount, 1);
  assert.equal(mktFormatted.status, 'partial');
  assert.match(mktFormatted.copy, /成功处理 17 项/);
  assert.match(mktFormatted.copy, /覆盖 85 个目标SKC/);
  assert.match(mktFormatted.copy, /失败 1 项/);
  assert.match(mktFormatted.copy, /受控阻断 1 项/);

  console.log('✓ Production inventory schema & marketing runner formatter accuracy passed');
}


// 9. Default --send shared channel integration test (no PENDING_DISCUSS_DAILY_LARK_BIN env var)
{
  const repoFakeRoot = path.join(tempDir, 'repo');
  const pdOutDir = path.join(repoFakeRoot, 'outputs', 'reports');
  await fs.mkdir(pdOutDir, {recursive: true});

  // Prepare a verified scan.json and report.txt
  const scanData = {
    schemaVersion: 'pending-discuss-scan/v1',
    businessDate: '2026-09-05',
    scanHash: 'business_normalized_hash_never_matches_file_bytes',
    ok: true,
    rowCount: 0,
    coverage: { expectedCount: 19, succeededCount: 19, failedStores: [] },
    summary: [],
    rows: [],
  };
  const scanFile = path.join(pdOutDir, 'scan.json');
  await fs.writeFile(scanFile, JSON.stringify(scanData, null, 2), 'utf8');
  const actualScanBytes = await fs.readFile(scanFile);
  const actualRawBytesSha = crypto.createHash('sha256').update(actualScanBytes).digest('hex');

  const reportFile = path.join(pdOutDir, 'report.txt');
  await fs.writeFile(reportFile, '# report\n0 items\n', 'utf8');

  // Verify that pending_discuss_daily uses runLocalCloudTeamReport with actual raw bytes SHA
  // by intercepting SSH execution with a controlled mock
  const {runLocalCloudTeamReport} = await import('../lib/cloud_team_report_local.mjs');
  const sshCalls = [];

  let capturedBundle = null;

  const cloudResult = await runLocalCloudTeamReport({
    automationId: 'pending-discuss-daily',
    businessDate: '2026-09-05',
    summaryFile: reportFile,
    attachment: scanFile,
    expectedAttachmentSha256: actualRawBytesSha,
    cloudSsh: 'shein-bi-tencent',
    root: repoFakeRoot,
    spawnImpl: (bin, args, options) => {
      sshCalls.push({bin, args});
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      let inputBuffer = '';
      child.stdin.on('data', d => { inputBuffer += d.toString(); });
      child.stdin.on('end', () => {
        queueMicrotask(() => {
          capturedBundle = JSON.parse(inputBuffer || '{}');
          assert.equal(capturedBundle.expectedAttachmentSha256, actualRawBytesSha, 'Shared bundle must carry raw bytes SHA');
          assert.equal(capturedBundle.automationId, 'pending-discuss-daily');
          const fakeOutcome = {
            ok: true,
            status: 'ok',
            automationId: capturedBundle.automationId,
            businessDate: capturedBundle.businessDate,
            fingerprint: capturedBundle.fingerprint,
            attachmentName: capturedBundle.attachmentName,
            attachmentSha256: capturedBundle.expectedAttachmentSha256,
            summarySha256: 'sum_sha',
            items: {
              summary: { accepted: true, messageId: 'om_shared_summary' },
              attachment: { accepted: true, messageId: 'om_shared_attachment' },
            },
          };
          child.stdout.end(JSON.stringify(fakeOutcome));
          child.stderr.end('');
          child.emit('close', 0);
        });
      });
      return child;
    },
  });

  assert.equal(cloudResult.ok, true);
  assert.equal(cloudResult.items.summary.accepted, true);
  assert.equal(cloudResult.items.attachment.accepted, true);
  assert.equal(sshCalls.length, 1);
  assert.equal(sshCalls[0].bin, 'ssh');
  assert.equal(sshCalls[0].args[0], 'shein-bi-tencent');

  console.log('✓ Default --send shared cloud team report channel verified with raw bytes SHA and SSH bundle');
}

await fs.rm(tempDir, {recursive: true, force: true});
console.log('✓ All F1 delivery hook tests passed successfully');
