#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  buildMarketingRepairBlockerNotice,
  buildMarketingRepairNotificationKey,
} from '../../lib/marketing_repair_blocker_notice.mjs';

const notice = buildMarketingRepairBlockerNotice({
  results: [
    {
      storeKey: 'DL',
      inventoryTopUps: [{
        skc: 'sv1',
        dryRun: {
          canonical: 'SK-6863半自动意式咖啡机',
          target: {activityStock: 10},
          decision: {ok: false, reason: 'et_stock_below_activity_stock', platformStock: 9, etStock: 3, required: 10},
        },
      }],
    },
    {
      storeKey: 'YJ',
      inventoryTopUps: [{
        skc: 'sb1',
        dryRun: {
          canonical: 'HS-025直发夹板',
          target: {activityStock: 10},
          decision: {ok: false, reason: 'et_stock_below_activity_stock', platformStock: 1, etStock: 1, required: 10},
        },
      }],
    },
  ],
});

assert.equal(notice.rows.length, 2);
assert.equal(notice.title, '营销兜底未完成：2 条链接库存不足');
assert.match(notice.message, /DL · SK-6863半自动意式咖啡机：平台可用 9，ET 可用 3，计划活动库存 10/);
assert.match(notice.message, /系统没有虚增库存，也没有提交这些活动/);
const notificationKey = buildMarketingRepairNotificationKey(
  '2026-07-31',
  'c91aaa4d1deadc5958ac',
);
assert.equal(notificationKey, 'mkt-repair-20260731-c91aaa4d1deadc5958ac');
assert.ok(notificationKey.length <= 50);

console.log('marketing_repair_blocker_notice: terminal inventory blockers are rendered in business language');
