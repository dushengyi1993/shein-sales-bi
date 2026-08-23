#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  assessMarketingDailyDeliveryReadiness,
  buildMarketingDailyFinalMarkdown,
  buildMarketingDailyGroupSummary,
  countOutstandingGuardRepairs,
  larkSendAccepted,
} from './send_marketing_daily_group_report.mjs';
import {resolveEffectiveCloudBiSsh} from './build_marketing_daily_guard_report.mjs';

const guardMarkdown = `# report
## 先看结论
- 没有需要立即止损的风险。
## 限时折扣兜底情况
- 巡检：覆盖 19/19 店，读到当前限时折扣 604 行。
## 高点击低转化专属折扣
- 本轮候选：符合 7 条；已保护 7 条。
- 效果跟踪：共 24 条；最新7日已出单 14 条。
## 今日关键状态
- 价格止损阻塞：2 个，不能自动执行
- 订单商品行成交价：低于目标 0 条；高于目标 0 条。
- 未来 3 天普通活动提醒：0 个。
`;
assert.equal(resolveEffectiveCloudBiSsh({
  root: '/opt/shein-bi/app', cloudBiRoot: '/opt/shein-bi/app', cloudBiSsh: 'shein-bi-tencent',
}), 'local', 'a cloud process must never SSH its own repository alias');
assert.equal(resolveEffectiveCloudBiSsh({
  root: '/workspace/local', cloudBiRoot: '/opt/shein-bi/app', cloudBiSsh: 'shein-bi-tencent',
}), 'shein-bi-tencent', 'a workstation may still use the configured cloud SSH alias');
const executionMarkdown = `# execution
## 结论
- 计划可处理 9 个链接；本次实际新建/重建 7 个。
- 平台/库存阻断 2 个；异常失败 0 个。
## 已执行
- DL: 活动 123，2 个 SKC
`;
const executionReport = {
  finishedAt: '2026-07-31T04:00:00.000Z',
  totals: {executedTargetCount: 7},
  results: [{
    storeKey: 'TZ',
    inventoryTopUps: [{
      skc: 'sv1',
      execute: {
        canonical: 'SK-7015绞肉机',
        decision: {ok: false, platformStock: 7, etStock: 4, required: 10},
      },
    }],
  }],
};
const summary = buildMarketingDailyGroupSummary({
  date: '2026-07-31',
  guardMarkdown,
  guardReport: {
    createdAt: '2026-07-31T04:05:00.000Z',
    limitedDiscountTargetPriceDrift: {belowTarget: 2},
    manualSpecialLimitedDiscount: {activeCount: 24, checked: 24},
    mandatoryLimitedDiscountStatus: {
      live: {storeCount: 19, okStoreCount: 19, limitedRows: 604},
      latestAutoRepair: {blockedCount: 2},
    },
    orderPriceAudit: {auditedRows: 65, below: 0, above: 0},
    highClickSpecialEffect: {total: 24, convertedCount: 14},
    t3MarketingCandidates: [{activityId: 49767}, {activityId: 49776}],
  },
  executionMarkdown,
  executionReport,
});
assert.match(summary, /巡检和授权修复已完成/);
assert.match(summary, /最终回读 19\/19 店/);
assert.match(summary, /可安全执行的动作均已处理/);
assert.match(summary, /人工特殊折扣 24\/24 精确覆盖/);
assert.doesNotMatch(summary, /不能自动执行/);
assert.match(summary, /高点击专属折扣跟踪 24 条，已出单 14 条/);
assert.match(summary, /完整明细见唯一附件/);

const finalMarkdown = buildMarketingDailyFinalMarkdown({
  date: '2026-07-31',
  summary,
  guardMarkdown,
  executionMarkdown,
});
assert.match(finalMarkdown, /营销巡检报告/);
assert.match(finalMarkdown, /唯一最终附件/);
assert.match(finalMarkdown, /自动执行结果/);
assert.doesNotMatch(finalMarkdown, /不能自动执行/);

const queue = {
  status: 'blocked',
  createdAt: '2026-07-31T03:00:00.000Z',
  updatedAt: '2026-07-31T04:02:00.000Z',
  counts: {totalRows: 9},
};
const guardSha256 = 'a'.repeat(64);
assert.equal(assessMarketingDailyDeliveryReadiness({
  queue,
  guardReport: {createdAt: '2026-07-31T04:01:00.000Z'},
  executionReport,
}).ready, false, 'a pre-terminal guard must never be delivered');
assert.equal(assessMarketingDailyDeliveryReadiness({
  queue,
  guardReport: {createdAt: '2026-07-31T04:05:00.000Z'},
  executionReport,
}).ready, true, 'a post-terminal final guard is deliverable');
const hashBoundQueue = {
  ...queue,
  updatedAt: '2026-07-31T04:06:00.000Z',
  sourceGuardHash: guardSha256,
};
assert.equal(assessMarketingDailyDeliveryReadiness({
  queue: hashBoundQueue,
  guardReport: {createdAt: '2026-07-31T04:05:00.000Z'},
  executionReport,
  guardSha256,
}).ready, true, 'a matching guard hash permits queue updates after guard creation');
assert.equal(assessMarketingDailyDeliveryReadiness({
  queue: {...hashBoundQueue, sourceGuardHash: 'b'.repeat(64)},
  guardReport: {createdAt: '2026-07-31T04:05:00.000Z'},
  executionReport,
  guardSha256,
}).ready, false, 'a mismatched guard hash must fail closed');
assert.equal(assessMarketingDailyDeliveryReadiness({
  queue: hashBoundQueue,
  guardReport: {createdAt: '2026-07-31T04:05:00.000Z'},
  executionReport: {...executionReport, finishedAt: '2026-07-31T04:06:00.000Z'},
  guardSha256,
}).ready, false, 'a matching guard hash cannot bypass a later execution result');

assert.equal(assessMarketingDailyDeliveryReadiness({
  queue: null,
  guardReport: {createdAt: '2026-07-31T04:05:00.000Z'},
}).ready, false, 'a missing queue must never be treated as a no-repair final');

const terminalZeroQueue = {
  status: 'completed',
  createdAt: '2026-07-31T04:00:00.000Z',
  updatedAt: '2026-07-31T04:01:00.000Z',
  counts: {totalRows: 0},
};
assert.equal(assessMarketingDailyDeliveryReadiness({
  queue: terminalZeroQueue,
  guardReport: {
    createdAt: '2026-07-31T04:05:00.000Z',
    highClickLowConversionSpecial: {actionCount: 2},
    manualSpecialLimitedDiscount: {actionCount: 3},
    limitedDiscountTargetPriceDrift: {belowRows: [{}, {}]},
    newSkcCandidates: {
      newListingWithin7DaysLimitedDiscount: {executableActionCount: 4},
    },
  },
}).ready, false, 'a zero-row queue cannot hide outstanding guard repair actions');
assert.deepEqual(countOutstandingGuardRepairs({
  highClickLowConversionSpecial: {actionCount: 2},
  manualSpecialLimitedDiscount: {actionCount: 3},
  limitedDiscountTargetPriceDrift: {belowRows: [{}, {}]},
  newSkcCandidates: {
    newListingWithin7DaysLimitedDiscount: {executableActionCount: 4},
  },
}), {
  highClickSpecial: 2,
  manualSpecialRestore: 3,
  driftRepair: 2,
  fallbackRepair: 4,
  total: 11,
});
assert.equal(assessMarketingDailyDeliveryReadiness({
  queue: terminalZeroQueue,
  guardReport: {createdAt: '2026-07-31T04:05:00.000Z'},
}).ready, true, 'a terminal zero-row queue is deliverable only with a zero-action guard');

const localHandoffQueue = {
  status: 'deferred_to_local',
  createdAt: '2026-07-31T04:00:00.000Z',
  updatedAt: '2026-07-31T04:01:00.000Z',
  counts: {totalRows: 9},
};
assert.equal(assessMarketingDailyDeliveryReadiness({
  queue: localHandoffQueue,
  guardReport: {createdAt: '2026-07-31T04:00:00.000Z'},
}).ready, true, 'a non-empty exact queue handed to local execution is reportable as an inspection result');
const localSummary = buildMarketingDailyGroupSummary({
  date: '2026-07-31',
  queue: localHandoffQueue,
  guardMarkdown,
  guardReport: {
    mandatoryLimitedDiscountStatus: {live: {storeCount: 19, okStoreCount: 19, limitedRows: 604}},
    manualSpecialLimitedDiscount: {},
    limitedDiscountTargetPriceDrift: {},
    orderPriceAudit: {},
    highClickSpecialEffect: {},
  },
  executionMarkdown,
  executionReport,
});
assert.match(localSummary, /巡检已完成，9 条已形成精确队列/);
assert.doesNotMatch(localSummary, /授权修复已完成|可安全执行的动作均已处理/);
const localMarkdown = buildMarketingDailyFinalMarkdown({
  date: '2026-07-31', summary: localSummary, queue: localHandoffQueue, guardMarkdown,
});
assert.match(localMarkdown, /不能视为写后终态/);

const senderSource = await fs.readFile(
  new URL('./send_marketing_daily_group_report.mjs', import.meta.url),
  'utf8',
);
assert.equal(
  (senderSource.match(/'--file'/g) || []).length,
  1,
  'daily delivery must have exactly one file-send path',
);

// lark-cli send acceptance: process success is not enough; the response must
// carry ok=true AND a message_id (tolerating bounded nesting).
assert.deepEqual(larkSendAccepted(JSON.stringify({ok: true, message_id: 'om_top'})), {ok: true});
assert.deepEqual(larkSendAccepted(JSON.stringify({ok: true, data: {message_id: 'om_nested'}})), {ok: true});
assert.deepEqual(larkSendAccepted(JSON.stringify({ok: true, result: {message: {message_id: 'om_deep'}}})), {ok: true});
assert.deepEqual(larkSendAccepted(JSON.stringify({ok: false, message_id: 'om_x'})), {ok: false, reason: 'response_ok_not_true'});
assert.deepEqual(larkSendAccepted(JSON.stringify({ok: true})), {ok: false, reason: 'message_id_missing'});
assert.deepEqual(larkSendAccepted(JSON.stringify({ok: true, data: {}})), {ok: false, reason: 'message_id_missing'});
assert.deepEqual(larkSendAccepted(JSON.stringify({ok: 'true', message_id: 'om_x'})), {ok: false, reason: 'response_ok_not_true'});
assert.deepEqual(larkSendAccepted('not json at all'), {ok: false, reason: 'non_json_response'});
assert.deepEqual(larkSendAccepted(''), {ok: false, reason: 'non_json_response'});
assert.equal(Object.keys(larkSendAccepted(JSON.stringify({ok: true, message_id: 'om_top'}))).includes('message_id'), false, 'acceptance result must never carry message_id');

// State and console must not record/output message_id or recipient IDs.
assert.doesNotMatch(senderSource, /message_id\s*:/, 'state and log JSON must never persist message_id as a key');
for (const line of senderSource.split(/\r?\n/)) {
  if (!line.includes('console.log')) continue;
  assert.doesNotMatch(line, /message_id|cliArgs/, `console output must not expose message_id or recipient ids`);
}

const workerSource = await fs.readFile(
  new URL('../cloud_marketing_repair_worker.sh', import.meta.url),
  'utf8',
);
assert.match(
  workerSource,
  /if \[\[ "\$QUEUE_STATUS" == "blocked" \]\]; then[\s\S]*?run_final_readback[\s\S]*?send_daily_group_report/,
  'terminal blockers must refresh final evidence before delivery',
);
assert.match(workerSource, /DEFER TO LOCAL before browser lease or SHEIN mutation/);

console.log('marketing daily group report: final gate and one attachment policy are enforced');
