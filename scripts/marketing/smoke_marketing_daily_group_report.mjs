#!/usr/bin/env node
import assert from 'node:assert/strict';
import {buildMarketingDailyGroupSummary} from './send_marketing_daily_group_report.mjs';

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
  executionMarkdown,
  executionReport,
});
assert.match(summary, /完整结论/);
assert.match(summary, /覆盖 19\/19 店/);
assert.match(summary, /实际新建\/重建 7 个/);
assert.match(summary, /TZ · SK-7015绞肉机：平台可用 7，ET 可用 4，活动需要 10/);
assert.match(summary, /最新7日已出单 14 条/);
assert.match(summary, /完整人话版巡检报告和自动执行结果见附件/);
console.log('marketing daily group report: complete summary and attachments are required');
