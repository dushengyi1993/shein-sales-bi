#!/usr/bin/env node
import assert from 'node:assert/strict';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-knowledge-event-watch-'));
const codexHome = path.join(temp, 'codex');
const projectRoot = path.join(temp, 'Shein销售统计');
const credentialFile = path.join(temp, 'device.json');
const stateFile = path.join(temp, 'state.json');
const logFile = path.join(temp, 'watch.log');
const sessionFile = path.join(codexHome, 'sessions', 'test.jsonl');
const memoryNote = path.join(codexHome, 'memories', 'extensions', 'ad_hoc', 'notes', 'event-note.md');
let posts = 0;
const server = http.createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/api/owner-knowledge/events') return response.writeHead(404).end();
  let body = '';
  for await (const chunk of request) body += chunk;
  const parsed = JSON.parse(body);
  posts += 1;
  response.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify({results: parsed.experiences}));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const waitFor = async (predicate, timeout = 8_000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for expected watch behavior');
};
try {
  await fs.mkdir(path.dirname(sessionFile), {recursive: true});
  await fs.mkdir(projectRoot, {recursive: true});
  const fakeDeviceToken = ['test', 'token', 'must', 'not', 'appear', 'in', 'log'].join('-');
  await fs.writeFile(credentialFile, JSON.stringify({token: fakeDeviceToken}));
  await fs.writeFile(sessionFile, `${JSON.stringify({type: 'turn_context', payload: {cwd: projectRoot}})}\n${JSON.stringify({type: 'event_msg', payload: {type: 'user_message', message: '以后每次都必须先核实云端运行态。'}})}\n`);
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'owner_knowledge_sync.mjs');
  const child = spawn(process.execPath, [script, 'watch', '--base-url', baseUrl, '--codex-home', codexHome, '--project-root', projectRoot, '--credential-file', credentialFile, '--state-file', stateFile, '--debounce-seconds', '0.2', '--reconcile-seconds', '30', '--log-file', logFile], {stdio: ['ignore', 'pipe', 'pipe']});
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  await waitFor(() => posts === 1); // startup reconcile publishes existing knowledge immediately
  await fs.mkdir(path.dirname(memoryNote), {recursive: true});
  await fs.writeFile(memoryNote, `# 记忆\n\n- Shein销售统计后续每次都必须先核实云端运行态。\n`);
  await waitFor(() => posts === 2); // memory notes are watched too
  await fs.appendFile(sessionFile, `${JSON.stringify({type: 'event_msg', payload: {type: 'user_message', message: '以后发布前必须回读验证。'}})}\n`);
  await fs.appendFile(sessionFile, `${JSON.stringify({type: 'event_msg', payload: {type: 'user_message', message: '默认不要用本地快照替代云端事实。'}})}\n`);
  await waitFor(() => posts === 3); // both writes coalesce into one debounced sync
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(posts, 3, 'watch must not poll again without an event before reconcile time');
  child.kill('SIGTERM');
  const [code, signal] = await once(child, 'exit');
  assert.ok(code === 0 || (process.platform === 'win32' && signal === 'SIGTERM'), 'watch exits cleanly on SIGTERM');
  const log = await fs.readFile(logFile, 'utf8');
  assert.equal(log.includes(fakeDeviceToken), false, 'watch logs must not contain device token');
  assert.equal(output.includes(fakeDeviceToken), false, 'console logs must not contain device token');
  console.log(JSON.stringify({ok: true, posts, tempRemoved: true}));
} finally {
  await new Promise(resolve => server.close(resolve));
  await fs.rm(temp, {recursive: true, force: true});
}
