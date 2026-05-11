#!/usr/bin/env node
/**
 * Read-only browser smoke check for the local SHEIN BI portal.
 *
 * Uses agent-browser headless by default. It does not modify backend data or
 * click irreversible operations; it only opens the portal, checks core text and
 * navigation, and writes a compact JSON report.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function pad(n) { return String(n).padStart(2, '0'); }
function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function parseArgs(argv) {
  const args = {
    url: 'http://127.0.0.1:8787/',
    session: `shein-bi-ui-check-${Date.now()}`,
    outputDir: path.join(ROOT, 'outputs', 'bi_ui_check'),
    headed: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--url') args.url = String(argv[++i] || args.url);
    else if (a === '--session') args.session = String(argv[++i] || args.session);
    else if (a === '--output-dir') args.outputDir = path.resolve(ROOT, String(argv[++i] || args.outputDir));
    else if (a === '--headed') args.headed = true;
    else if (a === '--json') args.json = true;
  }
  return args;
}

async function runAgent(args, options = {}) {
  const exe = process.platform === 'win32' ? 'cmd.exe' : 'agent-browser';
  const finalArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'agent-browser', ...args] : args;
  const timeoutMs = Number(options.timeoutMs || 60000);
  return await new Promise((resolve, reject) => {
    const child = spawn(exe, finalArgs, {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let done = false;
    let timer = null;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      if (err) reject(err);
      else resolve(value);
    };
    const tryResolveJson = () => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
      if (!stdout) return;
      try {
        const parsed = JSON.parse(stdout);
        if (parsed?.success === false) {
          finish(new Error(parsed?.error || stdout));
        } else {
          finish(null, parsed);
        }
      } catch {
        // Wait for the rest of stdout.
      }
    };
    timer = setTimeout(() => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      finish(new Error(stderr || stdout || `agent-browser ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      tryResolveJson();
    });
    child.stderr.on('data', chunk => stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.on('error', err => finish(err));
    child.on('close', code => {
      if (done) return;
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      let parsed = null;
      if (stdout) {
        try { parsed = JSON.parse(stdout); } catch {}
      }
      if (code !== 0 || parsed?.success === false) {
        finish(new Error(stderr || parsed?.error || stdout || `agent-browser ${args.join(' ')} failed with code ${code}`));
      } else {
        finish(null, parsed || {success: true, data: stdout});
      }
    });
  });
}

async function snapshot(session) {
  const res = await runAgent(['snapshot', '-i', '--session', session, '--json'], {timeoutMs: 90000});
  return res.data || {};
}

function textOf(snap) {
  return String(snap?.snapshot || '');
}

function findRefByName(snap, name) {
  const refs = snap?.refs || {};
  for (const [ref, meta] of Object.entries(refs)) {
    if (String(meta?.name || '') === name) return `@${ref}`;
  }
  return null;
}

function expectContains(checks, label, snap, expectedTexts) {
  const text = textOf(snap);
  const missing = expectedTexts.filter(x => !text.includes(x));
  const ok = missing.length === 0;
  checks.push({label, ok, missing});
  return ok;
}

async function maybeScreenshot(session, outputDir, name) {
  try {
    const file = path.join(outputDir, `${name}.png`);
    await runAgent(['screenshot', file, '--session', session, '--json'], {timeoutMs: 90000});
    return file;
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await fs.mkdir(args.outputDir, {recursive: true});
  const report = {
    ok: false,
    checkedAt: new Date().toISOString(),
    url: args.url,
    session: args.session,
    checks: [],
    screenshots: [],
    error: null,
  };

  try {
    await runAgent(['open', args.url, '--session', args.session, '--json', ...(args.headed ? ['--headed'] : [])], {timeoutMs: 90000});
    let snap = await snapshot(args.session);

    expectContains(report.checks, 'overview-core', snap, [
      'SHEIN BI',
      '总控驾驶舱',
      '经营总览仪表盘',
      '当前时段真实利润',
      '日趋势',
      '月趋势',
      '排行榜',
    ]);

    const navChecks = [
      {name: '订单 / 售后', expected: ['订单', '售后']},
      {name: '成本 / 利润', expected: ['成本', '利润']},
      {name: '实际库存 / 去化', expected: ['实际库存', '去化']},
      {name: '今日动作池', expected: ['动作']},
      {name: '系统状态', expected: ['系统状态']},
    ];

    for (const item of navChecks) {
      const ref = findRefByName(snap, item.name);
      if (!ref) {
        report.checks.push({label: `nav-ref:${item.name}`, ok: false, missing: [item.name]});
        continue;
      }
      await runAgent(['click', ref, '--session', args.session, '--json'], {timeoutMs: 60000});
      await runAgent(['wait', '700', '--session', args.session, '--json'], {timeoutMs: 10000}).catch(() => null);
      snap = await snapshot(args.session);
      expectContains(report.checks, `nav-page:${item.name}`, snap, item.expected);
    }

    report.ok = report.checks.every(x => x.ok);
    if (!report.ok) {
      const screenshot = await maybeScreenshot(args.session, args.outputDir, `failed-${stamp()}`);
      if (screenshot) report.screenshots.push(path.relative(ROOT, screenshot));
    }
  } catch (err) {
    report.error = String(err?.stack || err);
    const screenshot = await maybeScreenshot(args.session, args.outputDir, `error-${stamp()}`);
    if (screenshot) report.screenshots.push(path.relative(ROOT, screenshot));
  } finally {
    await runAgent(['close', '--session', args.session, '--json'], {timeoutMs: 30000}).catch(() => null);
  }

  const datedFile = path.join(args.outputDir, `bi-ui-check-${stamp()}.json`);
  const latestFile = path.join(args.outputDir, 'latest.json');
  await fs.writeFile(datedFile, JSON.stringify(report, null, 2), 'utf8');
  await fs.writeFile(latestFile, JSON.stringify(report, null, 2), 'utf8');
  const output = JSON.stringify({...report, file: path.relative(ROOT, datedFile)}, null, 2);
  if (args.json) process.stdout.write(output);
  else console.log(output);
  if (!report.ok) process.exitCode = 1;
}

main().catch(err => {
  console.error(String(err?.stack || err));
  process.exit(1);
});
