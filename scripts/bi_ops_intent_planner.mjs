#!/usr/bin/env node
import fs from 'node:fs/promises';
import {
  BI_OPS_CODEX_CLI_VERSION,
  BI_OPS_DEFAULT_STORES,
  BI_OPS_INTENT_LIMITS,
  BiOpsIntentPlannerError,
  runBiOpsIntentPlanner,
} from '../lib/bi_ops_intent_planner.mjs';

const MAX_CONTEXT_FILE_BYTES = 256 * 1024;

function splitList(value) {
  return String(value || '').split(/[,，、\s]+/).map(item => item.trim()).filter(Boolean);
}

function parseArgs(argv) {
  const args = {
    text: '',
    contextJson: '',
    contextFile: '',
    allowedStores: [],
    codexBin: String(process.env.SHEIN_BI_INTENT_PLANNER_CODEX_BIN || 'codex').trim() || 'codex',
    model: String(process.env.SHEIN_BI_INTENT_PLANNER_MODEL || '').trim(),
    reasoning: String(process.env.SHEIN_BI_INTENT_PLANNER_REASONING || 'low').trim(),
    timeoutMs: Number(process.env.SHEIN_BI_INTENT_PLANNER_TIMEOUT_MS || 90_000),
    pretty: false,
    help: false,
    positional: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--text' || arg === '--message') args.text = String(argv[++i] || '');
    else if (arg === '--context-json') args.contextJson = String(argv[++i] || '');
    else if (arg === '--context-file') args.contextFile = String(argv[++i] || '');
    else if (arg === '--allowed-stores') args.allowedStores.push(...splitList(argv[++i]));
    else if (arg === '--codex-bin') args.codexBin = String(argv[++i] || '').trim();
    else if (arg === '--model') args.model = String(argv[++i] || '').trim();
    else if (arg === '--reasoning') args.reasoning = String(argv[++i] || '').trim();
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i]);
    else if (arg === '--pretty') args.pretty = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg.startsWith('-')) throw new BiOpsIntentPlannerError(`Unknown argument: ${arg}`, {code: 'INVALID_ARGUMENT', status: 400});
    else args.positional.push(arg);
  }
  if (!args.text && args.positional.length) args.text = args.positional.join(' ');
  if (args.contextJson && args.contextFile) {
    throw new BiOpsIntentPlannerError('Use only one of --context-json or --context-file', {
      code: 'INVALID_ARGUMENT',
      status: 400,
    });
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 15_000 || args.timeoutMs > 600_000) {
    throw new BiOpsIntentPlannerError('--timeout-ms must be between 15000 and 600000', {
      code: 'INVALID_ARGUMENT',
      status: 400,
    });
  }
  return args;
}

function printHelp() {
  process.stdout.write(`SHEIN BI natural-language intent planner (Codex CLI ${BI_OPS_CODEX_CLI_VERSION})

Usage:
  node scripts/bi_ops_intent_planner.mjs --text "查一下 HL 近7天销售额"
  echo "把 QY 的 505 复制到 HL" | node scripts/bi_ops_intent_planner.mjs --pretty

Options:
  --text, --message <text>   User message. If omitted, read stdin.
  --context-json <json>      Existing task/session context as inline JSON.
  --context-file <path>      Existing task/session context JSON file (max 256 KiB).
  --allowed-stores <list>    Server-side store allowlist; defaults to the current 19 stores.
  --codex-bin <path>         Codex executable; defaults to SHEIN_BI_INTENT_PLANNER_CODEX_BIN or codex.
  --model <name>             Optional model override.
  --reasoning <level>        minimal|low|medium|high|xhigh; default low.
  --timeout-ms <number>      15000..600000; default 90000.
  --pretty                   Pretty-print the final strict JSON object.

The model runs in an isolated read-only, ephemeral Codex exec with shell, web,
Apps, code mode and subagents disabled. The process validates every returned
field against server-side intent/store/parameter allowlists before printing it.
`);
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > BI_OPS_INTENT_LIMITS.messageChars * 4) {
      throw new BiOpsIntentPlannerError('stdin exceeds the input safety limit', {
        code: 'MESSAGE_TOO_LONG',
        status: 413,
      });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

function parseContextJson(raw, sourceLabel) {
  if (!String(raw || '').trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new BiOpsIntentPlannerError(`${sourceLabel} is not valid JSON`, {
      code: 'INVALID_CONTEXT_JSON',
      status: 400,
      details: {cause: String(error?.message || error).slice(0, 160)},
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BiOpsIntentPlannerError(`${sourceLabel} must contain a JSON object`, {
      code: 'INVALID_CONTEXT_JSON',
      status: 400,
    });
  }
  return parsed;
}

async function readContext(args) {
  if (args.contextJson) return parseContextJson(args.contextJson, '--context-json');
  if (!args.contextFile) return {};
  const stat = await fs.stat(args.contextFile);
  if (!stat.isFile() || stat.size > MAX_CONTEXT_FILE_BYTES) {
    throw new BiOpsIntentPlannerError(`--context-file must be a file no larger than ${MAX_CONTEXT_FILE_BYTES} bytes`, {
      code: 'INVALID_CONTEXT_FILE',
      status: 400,
    });
  }
  return parseContextJson(await fs.readFile(args.contextFile, 'utf8'), '--context-file');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const text = args.text || await readStdin();
  const context = await readContext(args);
  const plan = await runBiOpsIntentPlanner({message: text, context}, {
    allowedStores: args.allowedStores.length ? args.allowedStores : BI_OPS_DEFAULT_STORES,
    codexBin: args.codexBin,
    model: args.model,
    reasoning: args.reasoning,
    timeoutMs: args.timeoutMs,
  });
  process.stdout.write(`${JSON.stringify(plan, null, args.pretty ? 2 : 0)}\n`);
}

main().catch(error => {
  const code = error instanceof BiOpsIntentPlannerError ? error.code : 'UNEXPECTED_ERROR';
  const message = String(error?.message || error).replace(/[\r\n]+/g, ' ').slice(0, 500);
  process.stderr.write(`[${code}] ${message}\n`);
  process.exitCode = 1;
});
