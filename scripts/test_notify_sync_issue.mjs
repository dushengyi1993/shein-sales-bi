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
assert.match(syncText, /订单抓取失败/);
assert.doesNotMatch(syncText, /处理原则：/);

const marketingText = buildSyncIssueMessage({
  isMarketing: true,
  title: '营销兜底未完成：2 条链接库存不足',
  message: '系统没有虚增库存，也没有提交活动。',
  now,
});
assert.match(marketingText, /^⚠️ 营销兜底未完成/m);
assert.match(marketingText, /系统没有虚增库存/);
assert.doesNotMatch(marketingText, /SHEIN 同步异常|处理原则：已成功店铺|原因：/);

const sourceMismatchText = buildSyncIssueMessage({
  isCloudWatchdog: true,
  title: 'SHEIN 同步异常提醒：2026-07-30 watchdog',
  message: '云端源码不一致：commitMatch=true dirty=3 hidden=0 missing=0',
  logFile: '/srv/shein-bi/logs/cloud-watchdog/watchdog-20260730085001.json',
  now,
});
assert.match(sourceMismatchText, /^⚠️ BI 服务器上有未发布的程序改动/m);
assert.match(sourceMismatchText, /数据抓取没有失败，BI 当前仍可使用/);
assert.match(sourceMismatchText, /3 项未提交改动/);
assert.match(sourceMismatchText, /下次发布或重启时被覆盖/);
assert.match(sourceMismatchText, /维护日志：/);
assert.doesNotMatch(sourceMismatchText, /commitMatch=true|dirty=3|处理原则：已成功店铺|原因：云端源码/);

const coverageText = buildSyncIssueMessage({
  isCloudWatchdog: true,
  message: 'BI 覆盖不足：SHEIN 销售日报 覆盖不足：1 天、2 个店铺日缺口；2026-07-24 缺 LQ,QY',
  now,
});
assert.match(coverageText, /部分店铺的数据还没有收齐/);
assert.match(coverageText, /2026-07-24 缺 LQ,QY/);
assert.doesNotMatch(coverageText, /处理原则：|commitMatch|dirty=/);

console.log('notify_sync_issue: webhook, marketing, sync and watchdog alerts use business-language copy');
