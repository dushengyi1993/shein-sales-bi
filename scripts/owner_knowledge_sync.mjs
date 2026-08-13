#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function parseArgs(argv) {
  const args = {
    command: argv[0] && !argv[0].startsWith('--') ? argv.shift() : 'upload',
    baseUrl: process.env.SHEIN_OWNER_KNOWLEDGE_BASE_URL || 'https://sa.dushengyi.cc',
    credentialFile: process.env.SHEIN_OWNER_KNOWLEDGE_CREDENTIAL_FILE || path.join(os.homedir(), '.codex', 'owner-knowledge', 'device.json'),
    spoolDir: process.env.SHEIN_OWNER_KNOWLEDGE_SPOOL_DIR || path.join(os.homedir(), '.codex', 'owner-knowledge', 'completion-spool'),
    intervalSeconds: 30,
    once: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base-url') args.baseUrl = argv[++i];
    else if (argv[i] === '--credential-file') args.credentialFile = path.resolve(argv[++i]);
    else if (argv[i] === '--spool-dir') args.spoolDir = path.resolve(argv[++i]);
    else if (argv[i] === '--interval-seconds') args.intervalSeconds = Math.max(5, Number(argv[++i]) || 30);
    else if (argv[i] === '--once') args.once = true;
    else throw new Error(`未知参数：${argv[i]}`);
  }
  args.baseUrl = String(args.baseUrl).replace(/\/+$/, '');
  return args;
}

async function readJson(file, fallback = null) {
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); } catch { return fallback; }
}

async function credential(args) {
  const raw = await readJson(args.credentialFile);
  const value = raw?.data?.token ? raw.data : raw;
  if (!value?.token) throw new Error(`负责人设备尚未登记：${args.credentialFile}`);
  return value;
}

async function api(args, pathname, options = {}) {
  const auth = await credential(args);
  const response = await fetch(args.baseUrl + pathname, {
    method: options.method || 'GET',
    headers: {Authorization: `Bearer ${auth.token}`, ...(options.body ? {'Content-Type': 'application/json'} : {}), 'User-Agent': 'shein-owner-completion-uploader/2'},
    ...(options.body ? {body: JSON.stringify(options.body)} : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!response.ok) throw new Error(`负责人规则接口 ${response.status}：${json?.error || text.slice(0, 500)}`);
  return json;
}

async function uploadOnce(args) {
  const ready = path.join(args.spoolDir, 'ready');
  await fs.mkdir(ready, {recursive: true});
  const files = (await fs.readdir(ready)).filter(name => name.endsWith('.json')).sort();
  let sent = 0;
  for (const name of files) {
    const file = path.join(ready, name);
    const body = await readJson(file);
    if (!body) continue;
    await api(args, '/api/owner-knowledge/completions', {method: 'POST', body});
    const target = path.join(args.spoolDir, 'sent', name);
    await fs.mkdir(path.dirname(target), {recursive: true});
    await fs.rename(file, target).catch(async () => { await fs.copyFile(file, target); await fs.rm(file, {force: true}); });
    sent += 1;
  }
  return {found: files.length, sent};
}

async function upload(args) {
  do {
    try {
      const summary = await uploadOnce(args);
      console.log(JSON.stringify({ok: true, command: 'upload', at: new Date().toISOString(), summary}));
    } catch (error) {
      console.error(JSON.stringify({ok: false, command: 'upload', at: new Date().toISOString(), error: String(error?.message || error)}));
      if (args.once) throw error;
    }
    if (args.once) return;
    await new Promise(resolve => setTimeout(resolve, args.intervalSeconds * 1000));
  } while (true);
}

const args = parseArgs(process.argv.slice(2));
if (['scan', 'sync', 'watch'].includes(args.command)) throw new Error('旧会话扫描采集器已废弃；请使用任务结束检查与候选审核流程');
if (args.command === 'status') console.log(JSON.stringify({ok: true, command: 'status', data: (await api(args, '/api/owner-knowledge/status')).data}, null, 2));
else if (args.command === 'upload') await upload(args);
else throw new Error(`未知命令：${args.command}`);
