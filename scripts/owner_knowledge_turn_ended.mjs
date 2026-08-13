#!/usr/bin/env node
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {redactOwnerKnowledgeSensitiveText} from '../lib/owner_knowledge_policy.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT), '..');
const PROJECT = path.resolve(process.env.SHEIN_OWNER_KNOWLEDGE_PROJECT_ROOT || ROOT).toLowerCase();
const HOME = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const SPOOL = path.join(HOME, 'owner-knowledge', 'completion-spool');
const SCHEMA = path.join(ROOT, 'scripts', 'owner_knowledge_completion_schema.json');

function safeId(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 160);
}

async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), {encoding: 'utf8', mode: 0o600});
  await fs.rename(temp, file);
}

function parsePayload(raw) {
  const value = JSON.parse(String(raw || '{}'));
  if (value.type !== 'agent-turn-complete') throw new Error('不是任务回合结束通知');
  return value;
}

function forwardNotification(raw) {
  const config = path.join(HOME, 'owner-knowledge', 'notify-forwarder.json');
  try {
    const target = JSON.parse(fsSync.readFileSync(config, 'utf8'));
    if (target?.exe && fsSync.existsSync(target.exe)) {
      spawnSync(target.exe, [...(Array.isArray(target.args) ? target.args : []), raw], {windowsHide: true, stdio: 'ignore'});
    }
  } catch {}
}

async function notify(raw) {
  forwardNotification(raw);
  if (process.env.SHEIN_OWNER_KNOWLEDGE_SUMMARIZER === '1') return;
  const payload = parsePayload(raw);
  const cwd = path.resolve(String(payload.cwd || '')).toLowerCase();
  if (cwd !== PROJECT && !cwd.startsWith(PROJECT + path.sep)) return;
  const threadId = safeId(payload['thread-id']);
  const turnId = safeId(payload['turn-id']);
  const id = `${threadId}__${turnId}`;
  const rawFile = path.join(SPOOL, 'pending', `${id}.json`);
  if (fsSync.existsSync(rawFile) || fsSync.existsSync(path.join(SPOOL, 'ready', `${id}.json`)) || fsSync.existsSync(path.join(SPOOL, 'sent', `${id}.json`))) return;
  await atomicJson(rawFile, {
    version: 1,
    checkId: `codex:${payload['thread-id']}:${payload['turn-id']}`,
    threadId: String(payload['thread-id'] || ''),
    turnId: String(payload['turn-id'] || ''),
    cwd: String(payload.cwd || ''),
    client: String(payload.client || ''),
    sourceAt: new Date().toISOString(),
    inputMessages: (Array.isArray(payload['input-messages']) ? payload['input-messages'] : []).map(value => redactOwnerKnowledgeSensitiveText(value)).slice(-12),
    finalMessage: redactOwnerKnowledgeSensitiveText(payload['last-assistant-message'] || ''),
  });
  if (process.env.SHEIN_OWNER_KNOWLEDGE_DISABLE_AUTO_PROCESS === '1') return;
  const child = spawn(process.execPath, [SCRIPT, 'process', rawFile], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: {...process.env, SHEIN_OWNER_KNOWLEDGE_SUMMARIZER: '1'},
  });
  child.unref();
}

async function processPending(file) {
  const job = JSON.parse(await fs.readFile(file, 'utf8'));
  const output = `${file}.${process.pid}.result.json`;
  const codex = process.env.CODEX_CLI_PATH || 'codex';
  const prompt = [
    '你是负责人任务结束规则检查器。只分析下面给出的本轮用户输入和最终答复，不调用工具，不读取文件。',
    '判断本轮是否明确产生、修正或废止了可跨任务复用的长期规则。一次性命令、临时范围、猜测、模型自行总结都不是规则。',
    '如果存在明确长期规则，status=candidate；不含长期规则则 status=no_rule；材料不足、矛盾或无法可靠判断则 status=review_required。',
    '所有规则只能是候选，禁止声称已生效。规则文字用简洁中文。若本轮明确修正旧说法，候选中写修正后的当前版本，并在 reason 说明旧说法已过时。',
    `任务时间：${job.sourceAt}`,
    `用户输入：${JSON.stringify(job.inputMessages).slice(0, 24000)}`,
    `最终答复：${JSON.stringify(job.finalMessage).slice(0, 16000)}`,
  ].join('\n\n');
  const result = spawnSync(codex, ['exec', '--ephemeral', '--skip-git-repo-check', '-c', 'notify=[]', '--output-schema', SCHEMA, '--output-last-message', output, '-'], {
    cwd: job.cwd || ROOT,
    input: prompt,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10 * 60 * 1000,
    env: {...process.env, SHEIN_OWNER_KNOWLEDGE_SUMMARIZER: '1'},
  });
  let check;
  if (result.status === 0) {
    check = JSON.parse(await fs.readFile(output, 'utf8'));
  } else {
    check = {status: 'review_required', reason: `规则分析失败，需人工检查（退出码 ${result.status ?? 'unknown'}）`, rules: []};
  }
  const ready = {...check, checkId: job.checkId, sourceId: `${job.threadId}:${job.turnId}`, sourceAt: job.sourceAt};
  await atomicJson(path.join(SPOOL, 'ready', path.basename(file)), ready);
  await fs.rm(file, {force: true});
  await fs.rm(output, {force: true});
}

const [command, argument] = process.argv.slice(2);
if (command === 'notify') await notify(argument || process.argv.at(-1));
else if (command === 'process') await processPending(path.resolve(argument));
else throw new Error('用法：owner_knowledge_turn_ended.mjs notify <json> | process <file>');
