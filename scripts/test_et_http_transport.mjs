#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {EtHttpClient} from './fetch_et_forwarder.mjs';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-et-http-test-'));
const sessionPath = path.join(tempDir, 'session.local.json');
let loginCalls = 0;
let detailCalls = 0;
let notFoundCalls = 0;
let always500Calls = 0;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const cookie = String(req.headers.cookie || '');
  if (url.pathname === '/Goods/StockSearch/GetStoreStockGridJson') {
    res.setHeader('Content-Type', 'application/json');
    if (!cookie.includes('sid=ready')) {
      res.statusCode = 401;
      res.end(JSON.stringify({code: 401, message: 'login required'}));
      return;
    }
    res.end(JSON.stringify({data: [{sku: 'probe'}]}));
    return;
  }
  if (url.pathname === '/Login/GetAuthCode') {
    res.setHeader('Set-Cookie', 'captcha=issued; Path=/; HttpOnly');
    res.setHeader('Content-Type', 'image/png');
    res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    return;
  }
  if (url.pathname === '/Login/CheckCustomerLogin') {
    loginCalls += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    assert.equal(form.get('username'), 'user');
    assert.equal(form.get('password'), 'secret');
    assert.equal(form.get('vercode'), 'ABCD');
    assert.match(cookie, /captcha=issued/);
    res.setHeader('Set-Cookie', 'sid=ready; Path=/; HttpOnly');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({state: 'success'}));
    return;
  }
  if (url.pathname === '/Delivery/Outbound/DetailForm') {
    detailCalls += 1;
    if (detailCalls < 3) {
      res.statusCode = 500;
      res.end('temporary server error');
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<html><head><script>window.x = 1;</script><style>body{}</style></head><body><div>Hello&nbsp;World &amp; more</div></body></html>');
    return;
  }
  if (url.pathname === '/Test/NotFound') {
    notFoundCalls += 1;
    res.statusCode = 404;
    res.end('missing page');
    return;
  }
  if (url.pathname === '/Test/Always500') {
    always500Calls += 1;
    res.statusCode = 500;
    res.end('permanent server error');
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const {port} = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

try {
  const client = await EtHttpClient.load({baseUrl, sessionPath});
  assert.equal((await client.probe()).ok, false);
  const login = await client.login({
    credentials: {username: 'user', password: 'secret'},
    recognizeCaptcha: async () => 'ABCD',
    maxAttempts: 2,
  });
  assert.equal(login.ok, true);
  assert.equal(loginCalls, 1);
  await client.save();

  const saved = JSON.parse(await fs.readFile(sessionPath, 'utf8'));
  assert.equal(Object.hasOwn(saved, 'password'), false, 'the HTTP session file must never persist credentials');
  assert.ok(saved.cookies.some(row => row.name === 'sid' && row.value === 'ready'));

  const reused = await EtHttpClient.load({baseUrl, sessionPath});
  assert.equal((await reused.probe()).ok, true, 'a later ET run must reuse the cookie jar without Chrome/login');
  assert.equal(loginCalls, 1);

  const previousAttempts = process.env.SHEIN_ET_HTTP_READ_ATTEMPTS;
  try {
    process.env.SHEIN_ET_HTTP_READ_ATTEMPTS = 'not-a-number';
    const detail = await reused.fetchText('/Delivery/Outbound/DetailForm?id=100');
    assert.equal(detailCalls, 3, 'an invalid attempts value must fall back to the default bounded attempts');
    assert.equal(detail, 'Hello World & more', 'HTML must be normalized to plain text');
  } finally {
    if (previousAttempts === undefined) delete process.env.SHEIN_ET_HTTP_READ_ATTEMPTS;
    else process.env.SHEIN_ET_HTTP_READ_ATTEMPTS = previousAttempts;
  }

  try {
    process.env.SHEIN_ET_HTTP_READ_ATTEMPTS = '2';
    await assert.rejects(
      reused.fetchText('/Test/Always500'),
      (error) => {
        assert.match(String(error?.message || error), /status=500/);
        assert.equal(error?.httpStatus, 500);
        return true;
      },
      'a constant 500 must fail with the original ET HTTP text fetch error'
    );
  } finally {
    if (previousAttempts === undefined) delete process.env.SHEIN_ET_HTTP_READ_ATTEMPTS;
    else process.env.SHEIN_ET_HTTP_READ_ATTEMPTS = previousAttempts;
  }
  assert.equal(always500Calls, 2, 'a constant 500 must be attempted exactly maxAttempts times');

  await assert.rejects(
    reused.fetchText('/Test/NotFound'),
    (error) => {
      assert.match(String(error?.message || error), /status=404/);
      assert.equal(error?.httpStatus, 404);
      return true;
    },
    'a permanent 4xx must fail with the original ET HTTP text fetch error'
  );
  assert.equal(notFoundCalls, 1, 'a non-retryable 4xx must not be retried');

  console.log(JSON.stringify({ok: true, transport: 'http', loginCalls}, null, 2));
} finally {
  await new Promise(resolve => server.close(resolve));
  await fs.rm(tempDir, {recursive: true, force: true});
}
