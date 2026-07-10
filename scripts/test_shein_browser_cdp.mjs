#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';

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

const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../lib/shein_browser.mjs', import.meta.url), 'utf8'));
assert.match(source, /CDP command timed out after/);
assert.match(source, /rejectPending/);
assert.match(source, /addEventListener\('close'/);

console.log('shein_browser_cdp: missing target and bounded command lifecycle checks passed');
