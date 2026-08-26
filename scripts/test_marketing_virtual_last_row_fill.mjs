#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runnerPath = path.join(root, 'scripts', 'marketing', 'dsy_marketing_deadline_fill.mjs');
const runner = await fs.readFile(runnerPath, 'utf8');

const limitMatch = runner.match(/const VIRTUAL_TERMINAL_STABLE_SCAN_LIMIT = (\d+);/);
assert.equal(Number(limitMatch?.[1]), 3, 'terminal virtual-list scan limit must stay bounded at three observations');

const fillStart = runner.indexOf('const sweepSteps = [450, 325, 240, 175, 120];');
const fillEnd = runner.indexOf('  // 二次复核', fillStart);
assert(fillStart >= 0 && fillEnd > fillStart, 'fill sweep block must be present');
const fillSweep = runner.slice(fillStart, fillEnd);

const verifyStart = runner.indexOf('const verifySteps = [450, 325, 240, 175, 120];');
const verifyEnd = runner.indexOf('  const mismatches = [];', verifyStart);
assert(verifyStart >= 0 && verifyEnd > verifyStart, 'verify sweep block must be present');
const verifySweep = runner.slice(verifyStart, verifyEnd);

for (const [name, source] of [['fill', fillSweep], ['verify', verifySweep]]) {
  assert.match(source, /const scanTop = Math\.min\(top, max\);/, `${name} sweep must clamp each requested position`);
  assert.match(source, /const atTerminal = scroll\.hasScroller && scanTop >= max;/, `${name} sweep must identify the terminal position`);
  assert.match(source, /await scrollTo\(cdp, sessionId, scanTop\);/, `${name} sweep must scan the clamped terminal position`);
  assert.match(source, /let terminalScanCount = 0;/, `${name} sweep must count terminal observations`);
  assert.match(source, /let terminalProgressToken = null;/, `${name} sweep must retain terminal progress`);
  assert.match(source, /let terminalStableScans = 0;/, `${name} sweep must detect a stable terminal scan`);
  assert.match(source, /terminalScanCount >= VIRTUAL_TERMINAL_STABLE_SCAN_LIMIT/, `${name} sweep must have a terminal bound`);
  assert.match(source, /terminalStableScans >= 1/, `${name} sweep must stop after a stable no-progress observation`);
}
assert.doesNotMatch(fillSweep, /if \(!scroll\.hasScroller \|\| top >= max\) break;/,
  'fill sweep must not stop before its terminal stability check');

const expectedLastSkc = 'sb260728182941078236523';
const expectedRows = Array.from({length: 26}, (_, index) => (
  index === 25 ? expectedLastSkc : `sb260728182941078236${String(index + 1).padStart(3, '0')}`
));
const firstTwentyFiveRows = expectedRows.slice(0, 25);

function simulateFill({terminalRowsForScan, actualTopForRequested = requestedTop => requestedTop}) {
  const max = 2929;
  const step = 450;
  let top = 2240;
  let iterations = 0;
  let terminalScanCount = 0;
  let terminalProgressToken = null;
  let terminalStableScans = 0;
  const scanned = new Set();
  const terminalRowsSeen = [];

  while (iterations < 240) {
    iterations += 1;
    const scanTop = Math.min(top, max);
    const atTerminal = scanTop >= max;
    const actualTop = actualTopForRequested(scanTop);
    const rows = actualTop >= max
      ? terminalRowsForScan(terminalScanCount + 1)
      : firstTwentyFiveRows;
    if (atTerminal) terminalRowsSeen.push([...rows]);
    for (const row of rows) scanned.add(row);
    const covered = scanned.size;

    if (atTerminal) {
      terminalScanCount += 1;
      const rowSignature = [...rows].sort().join('|');
      const progressToken = `${covered}:${rowSignature}`;
      if (progressToken === terminalProgressToken) terminalStableScans += 1;
      else {
        terminalProgressToken = progressToken;
        terminalStableScans = 0;
      }
    }

    if (covered >= expectedRows.length && (!atTerminal || terminalStableScans >= 1)) break;
    if (!atTerminal) {
      top = Math.min(scanTop + step, max);
      continue;
    }
    if (terminalScanCount >= 3 || terminalStableScans >= 1) break;
  }

  const coverage = scanned.size;
  return {
    coverage,
    iterations,
    terminalScanCount,
    terminalRowsSeen,
    lastRowSeen: scanned.has(expectedLastSkc),
    ok: coverage >= expectedRows.length
      && scanned.size === expectedRows.length,
  };
}

const delayedTerminalRow = simulateFill({
  terminalRowsForScan: terminalScan => terminalScan >= 2 ? expectedRows : firstTwentyFiveRows,
});
assert.equal(delayedTerminalRow.coverage, 26, 'a last row rendered at the terminal position must reach full coverage');
assert.equal(delayedTerminalRow.lastRowSeen, true, 'the terminal-only last row must be observed');
assert.equal(delayedTerminalRow.terminalRowsSeen[0].includes(expectedLastSkc), false,
  'the last row must be absent from the first terminal observation');
assert.equal(delayedTerminalRow.terminalRowsSeen[1].includes(expectedLastSkc), true,
  'the last row must be accepted when it appears at the terminal position');
assert.equal(delayedTerminalRow.ok, true, 'full terminal coverage must remain eligible when no blockers exist');
assert.equal(delayedTerminalRow.terminalScanCount, 3,
  'a row that appears on the second terminal observation must receive one stable follow-up scan');

const stalledScroll = simulateFill({
  terminalRowsForScan: () => firstTwentyFiveRows,
  actualTopForRequested: () => 2240,
});
assert.equal(stalledScroll.coverage, 25, 'a stalled scroll must not invent the missing row');
assert.equal(stalledScroll.lastRowSeen, false, 'a stalled scroll must leave the absent row uncovered');
assert.equal(stalledScroll.ok, false, 'missing terminal coverage must fail closed');
assert.ok(stalledScroll.iterations < 240, 'a stalled terminal scan must exit before the per-sweep guard');
assert.equal(stalledScroll.terminalScanCount, 2, 'stable terminal stagnation must stop after two equal observations');

console.log('marketing virtual last-row fill: PASS');
