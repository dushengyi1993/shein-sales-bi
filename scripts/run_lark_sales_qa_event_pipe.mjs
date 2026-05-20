#!/usr/bin/env node
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LARK_CLI_BIN = process.env.LARK_CLI_BIN || 'lark-cli';
const NODE_BIN = process.env.SHEIN_QA_NODE_BIN || process.execPath;
const EVENT_KEY = process.env.SHEIN_QA_EVENT_KEY || 'im.message.receive_v1';

function log(line) {
  process.stderr.write(`${new Date().toISOString()} ${line}\n`);
}

function spawnChild(name, command, args, options = {}) {
  log(`[${name}] start ${command} ${args.join(' ')}`);
  const child = spawn(command, args, {
    cwd: ROOT,
    env: {...process.env, ...(options.env || {})},
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.on('error', err => log(`[${name}] error ${err?.stack || err}`));
  child.on('exit', (code, signal) => log(`[${name}] exit code=${code} signal=${signal || ''}`));
  return child;
}

const lark = spawnChild('lark-event', LARK_CLI_BIN, ['event', 'consume', EVENT_KEY, '--as', 'bot']);
const bot = spawnChild('qa-bot', NODE_BIN, ['scripts/lark_sales_qa_bot.mjs', '--consume']);

// Keep lark-cli stdin open. Do not call lark.stdin.end().
lark.stdout.pipe(bot.stdin);
lark.stderr.on('data', chunk => process.stderr.write(chunk));
bot.stdout.on('data', chunk => process.stdout.write(chunk));
bot.stderr.on('data', chunk => process.stderr.write(chunk));

let shuttingDown = false;
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`[supervisor] shutdown reason=${reason}`);
  for (const child of [lark, bot]) {
    try {
      child.kill('SIGTERM');
    } catch {}
  }
  setTimeout(() => {
    for (const child of [lark, bot]) {
      if (!child.killed) {
        try { child.kill('SIGKILL'); } catch {}
      }
    }
  }, 5000).unref?.();
}

lark.on('exit', () => shutdown('lark-exit'));
bot.on('exit', () => shutdown('bot-exit'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
