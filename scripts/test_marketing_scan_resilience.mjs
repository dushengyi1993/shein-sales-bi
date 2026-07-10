#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const marketingPath = path.join(root, 'scripts', 'marketing', 'scan_current_marketing_prices_for_bi.mjs');
const marketing = fs.readFileSync(marketingPath, 'utf8');
const links = fs.readFileSync(path.join(root, 'scripts', 'fetch_shein_links.mjs'), 'utf8');

assert.match(marketing, /import \{connectCdp\} from '\.\.\/\.\.\/lib\/shein_browser\.mjs'/);
assert.match(marketing, /attempt <= 2/);
assert.match(marketing, /isTransientMarketingScanError/);
assert.match(marketing, /transient scan failure on attempt/);
assert.match(marketing, /T00:00:00/);
assert.doesNotMatch(marketing, /class Cdp/);

const help = spawnSync(process.execPath, [marketingPath, '--help'], {cwd: root, encoding: 'utf8', timeout: 5000});
assert.equal(help.status, 0, help.stderr);
assert.match(help.stdout, /Usage:/);
assert.match(help.stdout, /exit without scanning/);
assert.doesNotMatch(help.stdout, /^scan [A-Z]+/m);

const unknown = spawnSync(process.execPath, [marketingPath, '--definitely-unknown'], {cwd: root, encoding: 'utf8', timeout: 5000});
assert.notEqual(unknown.status, 0);
assert.match(unknown.stderr, /Unknown option: --definitely-unknown/);

const unknownGroup = spawnSync(process.execPath, [marketingPath, '--group', 'NOT_A_GROUP'], {cwd: root, encoding: 'utf8', timeout: 5000});
assert.notEqual(unknownGroup.status, 0);
assert.match(unknownGroup.stderr, /Unknown store group: NOT_A_GROUP/);

assert.match(links, /import \{connectCdp\} from '\.\.\/lib\/shein_browser\.mjs'/);
assert.match(links, /cdp\.close\(\)/);
assert.doesNotMatch(links, /new Promise\(\(resolve, reject\) => pending\.set/);
assert.doesNotMatch(links, /process\.exit\(1\)/);

console.log('marketing_scan_resilience: bounded CDP, safe CLI, and transient retry contracts passed');
