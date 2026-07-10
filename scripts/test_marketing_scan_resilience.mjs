#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const marketing = fs.readFileSync(path.join(root, 'scripts', 'marketing', 'scan_current_marketing_prices_for_bi.mjs'), 'utf8');
const links = fs.readFileSync(path.join(root, 'scripts', 'fetch_shein_links.mjs'), 'utf8');

assert.match(marketing, /import \{connectCdp\} from '\.\.\/\.\.\/lib\/shein_browser\.mjs'/);
assert.match(marketing, /attempt <= 2/);
assert.match(marketing, /isTransientMarketingScanError/);
assert.match(marketing, /transient scan failure on attempt/);
assert.match(marketing, /T00:00:00/);
assert.doesNotMatch(marketing, /class Cdp/);

assert.match(links, /import \{connectCdp\} from '\.\.\/lib\/shein_browser\.mjs'/);
assert.match(links, /cdp\.close\(\)/);
assert.doesNotMatch(links, /new Promise\(\(resolve, reject\) => pending\.set/);
assert.doesNotMatch(links, /process\.exit\(1\)/);

console.log('marketing_scan_resilience: bounded CDP and transient retry contracts passed');
