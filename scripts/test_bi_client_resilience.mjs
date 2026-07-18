#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'scripts', 'bi_app', 'client.js'), 'utf8');

assert.match(source, /window\.addEventListener\('hashchange',syncTabFromLocation\)/, 'hash navigation stays synchronized');
assert.match(source, /window\.addEventListener\('popstate',syncTabFromLocation\)/, 'browser back and forward are handled');
assert.match(source, /document\.addEventListener\('visibilitychange'/, 'long-open tabs refresh after becoming visible');
assert.match(source, /await core\(\{silent:true,ensureAfter:false\}\)/, 'section version mismatches revalidate core first');
assert.match(source, /versionWarning=.*数据版本与 core 暂未同步/, 'persistent mismatches degrade to an explicit stale warning');
assert.doesNotMatch(source, /throw Error\(n\+' generatedAt 不匹配/, 'version mismatches must not hard-fail a usable cached page');
assert.match(source, /history\.pushState\(null,'',hash\)/, 'normal navigation creates browser history');
assert.match(source, /function inventoryMatchStatus\(r\)/, 'client keeps a backward-compatible inventory match-state reader');
assert.match(source, /match==='not_matched'/, 'client must not treat an unmatched ET record as zero stock');
assert.match(source, /match==='stale'/, 'client must surface stale ET snapshots distinctly');
assert.match(source, /仅在 ET 快照最新且已匹配、当前可售为 0、没有有效在途时成立/, 'client out-of-stock copy keeps the fresh-match invariant');

console.log('bi_client_resilience: refresh, version fallback, and history contracts passed');
