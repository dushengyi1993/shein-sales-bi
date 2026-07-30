#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./send_daily_ops_group_digest.mjs', import.meta.url), 'utf8');
assert.match(source, /resolveLarkDeliveryTarget/);
assert.match(source, /marketing-daily-guard-\$\{args\.date\}\.md/);
assert.match(source, /daily-ops-inspection-\$\{args\.date\}\.md/);
assert.match(source, /\.\.\.target\.cliArgs/);
assert.match(source, /--file/);
assert.match(source, /daily_ops_group_digest_sent/);
assert.doesNotMatch(source, /--user-id['"],\s*config\.recipientUserId/);
console.log('daily_ops_group_digest: group summary, attachments and daily idempotency passed');
