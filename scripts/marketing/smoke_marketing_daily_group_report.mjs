#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  assessMarketingDailyDeliveryReadiness,
  buildMarketingDailyFinalMarkdown,
  buildMarketingDailyGroupSummary,
} from './send_marketing_daily_group_report.mjs';

const guardMarkdown = `# report
## 先看结论
- 没有需要立即止损的风险。
## 限时折扣兜底情况
- 巡检：覆盖 19/19 店，读到当前限时折扣 604 行。
## 高点击低转化专属折扣
- 本轮候选：符合 7 条；已保护 7 条。
- 效果跟踪：共 24 条；最新7日已出单 14 条。
## 今日关键状态
- 订单商品行成交价：低于目标 0 条；高于目标 0 条。
- 未来 3 天普通活动提醒：0 个。
`;
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
assert.match(finalMarkdown, /营销巡检最终报告/);
assert.match(finalMarkdown, /唯一最终附件/);
assert.match(finalMarkdown, /自动执行结果/);

const queue = {
  status: 'blocked',
  createdAt: '2026-07-31T03:00:00.000Z',
  updatedAt: '2026-07-31T04:02:00.000Z',
  counts: {totalRows: 9},
};
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

const senderSource = await fs.readFile(
  new URL('./send_marketing_daily_group_report.mjs', import.meta.url),
  'utf8',
);
assert.equal(
  (senderSource.match(/'--file'/g) || []).length,
  1,
  'daily delivery must have exactly one file-send path',
);
const workerSource = await fs.readFile(
  new URL('../cloud_marketing_repair_worker.sh', import.meta.url),
  'utf8',
);
assert.match(
  workerSource,
  /if \[\[ "\$QUEUE_STATUS" == "blocked" \]\]; then[\s\S]*?run_terminal_final_snapshot[\s\S]*?send_daily_group_report/,
  'terminal blockers must refresh final evidence before delivery',
);

console.log('marketing daily group report: final gate and one attachment policy are enforced');
