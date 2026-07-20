#!/usr/bin/env node
import assert from 'node:assert/strict';
import {buildSyncIssueMessage} from './notify_sync_issue.mjs';

const now = new Date('2026-07-20T10:20:51.000Z');
const webhookText = buildSyncIssueMessage({
  isWebhook: true,
  title: 'QH 店：店铺授权需要处理',
  message: 'SHEIN 店铺授权发生变化，系统已暂停该店的自动操作，避免误写。请重新检查并恢复授权。',
  now,
});

assert.equal(webhookText, [
  '🚨 QH 店：店铺授权需要处理',
  '',
  'SHEIN 店铺授权发生变化，系统已暂停该店的自动操作，避免误写。请重新检查并恢复授权。',
  '',
  '时间：2026-07-20 18:20:51',
].join('\n'));
assert.doesNotMatch(webhookText, /P0|3001503|authorization_exception|原因：|处理原则：|eventCode|actionState/);

const syncText = buildSyncIssueMessage({
  title: 'SHEIN 同步异常提醒：2026-07-20 日更',
  failed: ['QH'],
  message: '订单抓取失败',
  now,
});
assert.match(syncText, /失败店铺：QH/);
assert.match(syncText, /原因：订单抓取失败/);

console.log('notify_sync_issue: webhook alerts use business-language copy while sync alerts retain diagnostics');
