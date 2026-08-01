#!/usr/bin/env node
import assert from 'node:assert/strict';
import {collapseWatchdogRootCauseIssues} from '../lib/cloud_watchdog_issue_collapse.mjs';

const input = [
  '商品 OpenAPI 对账需处理：TZZ 店商品对账需处理：详情缺失',
  '服务异常：shein-bi-cloud-session-manager.service state=failed result=exit-code exit=1 code=1',
  '链接/业务域日更部分店铺失败：date=2026-07-31 failed=DX log=/tmp/link.log',
  '日更补采异常：date=2026-07-31 status=warning message=link-business partial log=/tmp/daily.log',
];
const result = collapseWatchdogRootCauseIssues({
  issues: input,
  sessionReport: {
    summary: {failedStores: ['DX']},
    results: [{storeKey: 'DX', steps: [{textPreview: '手机号码验证 请输入短信验证码 验证码已发送'}]}],
  },
});
assert.equal(result.collapsed, true);
assert.equal(result.otpRequired, true);
assert.equal(result.issues.length, 2);
assert.match(result.issues[0], /DX 登录已进入短信验证码页面/);
assert.equal(result.issues[1], input[0], 'unrelated product reconciliation issue must remain');

const mismatch = collapseWatchdogRootCauseIssues({
  issues: input,
  sessionReport: {summary: {failedStores: ['FY']}},
});
assert.equal(mismatch.collapsed, false);
assert.deepEqual(mismatch.issues, input);

console.log('cloud watchdog issue collapse: one login root cause replaces three derivative alerts');
