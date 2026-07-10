#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {connectCdp} from '../lib/shein_browser.mjs';

const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'application/json'});
  res.end('[]');
});
await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
const address = server.address();
const port = typeof address === 'object' && address ? address.port : 0;

try {
  await assert.rejects(
    connectCdp(port, {targetTimeoutMs: 500, openTimeoutMs: 500, commandTimeoutMs: 500}),
    /No Chrome page target/,
  );
} finally {
  await new Promise(resolve => server.close(resolve));
}

const source = await fs.readFile(new URL('../lib/shein_browser.mjs', import.meta.url), 'utf8');
assert.match(source, /CDP command timed out after/);
assert.match(source, /rejectPending/);
assert.match(source, /addEventListener\('close'/);
assert.match(source, /const on = \(method, listener\)/, 'shared CDP client supports domain event subscriptions');
assert.match(source, /CDP websocket open timed out[\s\S]*ws\.close\(\)/, 'an open timeout closes the websocket');
assert.match(source, /await send\('Runtime\.enable'\)[\s\S]*catch \(error\)[\s\S]*close\(\)/, 'initialization failure closes the websocket');

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
async function walkMjs(dir) {
  const files = [];
  for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walkMjs(file));
    else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(file);
  }
  return files;
}

const consumers = [];
for (const file of await walkMjs(scriptsDir)) {
  const relative = path.relative(scriptsDir, file).replace(/\\/g, '/');
  const scriptSource = await fs.readFile(file, 'utf8');
  if (relative !== 'test_shein_browser_cdp.mjs') {
    assert.doesNotMatch(scriptSource, /async function connectCdp\(/, `${relative} must not keep an unbounded local CDP implementation`);
  }
  if (/\bconnectCdp\(/.test(scriptSource) && relative !== 'test_shein_browser_cdp.mjs') {
    assert.match(scriptSource, /import \{connectCdp\} from '\.\.\/(?:\.\.\/)?lib\/shein_browser\.mjs'/, `${relative} must import the shared CDP client`);
    assert.doesNotMatch(scriptSource, /(?:cdp|conn|ctx)\.ws(?:\?\.)?\.close|\bws\.close\(/, `${relative} must close through the shared lifecycle`);
    consumers.push(relative);
  }
}
assert.ok(consumers.length >= 13, `expected the shared CDP client to cover operational scripts, got ${consumers.length}`);

console.log(`shein_browser_cdp: bounded lifecycle and ${consumers.length} shared consumers passed`);
