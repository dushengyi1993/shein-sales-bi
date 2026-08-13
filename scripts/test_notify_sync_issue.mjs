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

const serviceText = buildSyncIssueMessage({
  isCloudWatchdog: true,
  message: '服务异常：shein-bi-et-low-inventory-recheck.service state=failed result=exit-code exit=2 code=1',
  now,
});
assert.match(serviceText, /低库存自动复查连续运行失败/);
assert.match(serviceText, /系统已经完成自动重试确认/);
assert.doesNotMatch(serviceText, /shein bi et low inventory recheck运行失败/);

const recoveryText = buildSyncIssueMessage({
  isCloudWatchdogRecovery: true,
  message: '服务异常：shein-bi-cloud-openapi-stock-refresh.service state=failed result=exit-code exit=1 code=1',
  logFile: '/srv/shein-bi/logs/cloud-watchdog/watchdog-recovery.json',
  now,
});
assert.match(recoveryText, /^✅ BI 已自动恢复/m);
assert.match(recoveryText, /商品库存同步已经恢复运行/);
assert.match(recoveryText, /无需人工处理/);
assert.doesNotMatch(recoveryText, /连续运行失败|需要维护/);

const profitText = buildSyncIssueMessage({
  isCloudWatchdog: true,
  message: '日更补采异常：date=2026-08-12 status=warning message=profit mart refresh failed status=3 log=/srv/x.log',
  now,
});
assert.match(profitText, /利润数据更新遇到数据库并发冲突/);
assert.match(profitText, /不会把缺失利润显示成 0/);

const runtimeText = buildSyncIssueMessage({
  isCloudWatchdog: true,
  message: 'BI 实时更新通道未连接：enabled=true connected=false',
  now,
});
assert.match(runtimeText, /实时更新连接已中断/);
assert.match(runtimeText, /现有数据仍可查看/);
assert.doesNotMatch(runtimeText, /enabled=true|connected=false/);

const auditText = buildSyncIssueMessage({
  isCloudWatchdog: true,
  message: '订单闭环 DB 审计失败：psql exit=1',
  now,
});
assert.match(auditText, /订单数据完整性检查没有完成/);
assert.doesNotMatch(auditText, /psql|exit=1/);

console.log('notify_sync_issue: webhook, marketing, sync and watchdog alerts use business-language copy');
