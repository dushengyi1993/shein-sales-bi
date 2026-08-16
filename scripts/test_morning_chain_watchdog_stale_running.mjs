#!/usr/bin/env node

// The watchdog must surface a morning-chain unit that has already left the
// active set (failed/inactive/dead) while its latest.json is still `running`
// as an explicit blocker.  A stale-running observation must never be treated
// as normal operation, and an unreadable or in-between systemd state must
// never create a false alert.
//
// The watchdog must also surface the converged TERMINAL failure of the day's
// morning chain (latest.json failed/deferred/partial for the current runDate
// while the unit is idle), and business recovery of a failed morning-chain
// unit must ONLY ever come from a real `done` morning-links-ready marker: a
// `warning` marker (even with pipeline ok=true) or a done marker without
// ok=true must NOT mark the failed service as recovered.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  assessBusinessRecovery,
  isMorningChainStaleRunning,
  isMorningChainTerminalFailure,
} from './cloud_ops_watchdog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watchdog = fs.readFileSync(path.join(root, 'scripts', 'cloud_ops_watchdog.mjs'), 'utf8');

const running = {status: 'running', generatedAt: '2026-08-16T02:10:00+08:00'};
const ok = {status: 'ok', generatedAt: '2026-08-16T03:30:00+08:00'};
const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const yesterday = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 10);

// A service that failed or already exited while the latest state is still
// running is the stale-running blocker we must alert on.
assert.equal(isMorningChainStaleRunning(running, {ActiveState: 'failed', Result: 'timeout', ExecMainStatus: '15'}), true);
assert.equal(isMorningChainStaleRunning(running, {ActiveState: 'inactive', Result: 'success'}), true);
assert.equal(isMorningChainStaleRunning(running, {ActiveState: 'dead'}), true);

// A legitimately active run, or an in-between / unreadable state, must not
// create a false stale-running alert.
assert.equal(isMorningChainStaleRunning(running, {ActiveState: 'active'}), false);
assert.equal(isMorningChainStaleRunning(running, {ActiveState: 'activating'}), false);
assert.equal(isMorningChainStaleRunning(running, {ActiveState: 'reloading'}), false);
assert.equal(isMorningChainStaleRunning(running, {ActiveState: 'unknown'}), false);
assert.equal(isMorningChainStaleRunning(running, {}), false);
assert.equal(isMorningChainStaleRunning(running, null), false);

// A converged non-running latest state can never be stale-running.
assert.equal(isMorningChainStaleRunning(ok, {ActiveState: 'failed'}), false);
assert.equal(isMorningChainStaleRunning(ok, {ActiveState: 'inactive'}), false);
assert.equal(isMorningChainStaleRunning({status: 'failed'}, {ActiveState: 'inactive'}), false);

// A missing/corrupt latest state is not the stale-running class either.
assert.equal(isMorningChainStaleRunning(null, {ActiveState: 'failed'}), false);
assert.equal(isMorningChainStaleRunning(undefined, {ActiveState: 'inactive'}), false);
assert.equal(isMorningChainStaleRunning({error: 'unreadable'}, {ActiveState: 'failed'}), false);

// --- terminal-failure detection (converged deadline / morning chain failure) --

const failedToday = {status: 'failed', date: today, message: 'first-start absolute deadline expired', generatedAt: '2026-08-16T03:30:00+08:00'};
const okToday = {status: 'ok', date: today, generatedAt: '2026-08-16T03:30:00+08:00'};

// A terminal failure for the CURRENT runDate while the unit has left the
// active set is exactly what the watchdog must page.
assert.equal(isMorningChainTerminalFailure(failedToday, {ActiveState: 'inactive', Result: 'success'}), true);
assert.equal(isMorningChainTerminalFailure(failedToday, {ActiveState: 'failed', Result: 'exit-code'}), true);
assert.equal(isMorningChainTerminalFailure(failedToday, {ActiveState: 'dead'}), true);
assert.equal(isMorningChainTerminalFailure({status: 'deferred', date: today}, {ActiveState: 'inactive'}), true);
assert.equal(isMorningChainTerminalFailure({status: 'partial', date: today}, {ActiveState: 'inactive'}), true);

// A live run, an in-between state, an unreadable payload or a non-terminal
// latest status must never create a terminal-failure alert.
assert.equal(isMorningChainTerminalFailure(failedToday, {ActiveState: 'active'}), false);
assert.equal(isMorningChainTerminalFailure(failedToday, {ActiveState: 'activating'}), false);
assert.equal(isMorningChainTerminalFailure(failedToday, {ActiveState: 'reloading'}), false);
assert.equal(isMorningChainTerminalFailure(failedToday, {ActiveState: 'unknown'}), false);
assert.equal(isMorningChainTerminalFailure(failedToday, {}), false);
assert.equal(isMorningChainTerminalFailure(failedToday, null), false);
assert.equal(isMorningChainTerminalFailure(okToday, {ActiveState: 'inactive'}), false);
assert.equal(isMorningChainTerminalFailure(running, {ActiveState: 'inactive'}), false);
assert.equal(isMorningChainTerminalFailure({status: 'running', date: today}, {ActiveState: 'inactive'}), false);

// Only the CURRENT runDate may alert: an old daily failure must not be paged.
assert.equal(isMorningChainTerminalFailure({status: 'failed', date: yesterday}, {ActiveState: 'inactive'}), false);
assert.equal(isMorningChainTerminalFailure({status: 'failed', date: ''}, {ActiveState: 'inactive'}), false);
assert.equal(isMorningChainTerminalFailure({status: 'failed'}, {ActiveState: 'inactive'}), false);
assert.equal(isMorningChainTerminalFailure({error: 'unreadable'}, {ActiveState: 'inactive'}), false);
assert.equal(isMorningChainTerminalFailure(null, {ActiveState: 'inactive'}), false);
assert.equal(isMorningChainTerminalFailure(undefined, {ActiveState: 'inactive'}), false);

// --- business recovery: only a real done morning-links-ready marker counts --

const unitStatus = {ActiveState: 'inactive', Result: 'success', ExecMainExitTimestamp: '2026-08-16 07:12:00'};
const doneMarker = {runDate: today, status: 'done', ok: true, completedAt: '2026-08-16 09:00:00'};
const warningMarker = {runDate: today, status: 'warning', ok: true, completedAt: '2026-08-16 09:00:00'};
const doneButNotOk = {runDate: today, status: 'done', ok: false, completedAt: '2026-08-16 09:00:00'};
const wrongDate = {runDate: '2026-08-01', status: 'done', ok: true, completedAt: '2026-08-16 09:00:00'};
const tooOld = {runDate: today, status: 'done', ok: true, completedAt: '2026-08-16 07:00:00'};

assert.equal(assessBusinessRecovery('shein-bi-cloud-morning-chain.service', unitStatus, {
  morningMarker: doneMarker,
}).recovered, true, 'a real done morning-links-ready marker after unit exit must recover the failed service');
assert.equal(assessBusinessRecovery('shein-bi-cloud-morning-chain.service', unitStatus, {
  morningMarker: warningMarker,
}).recovered, false, 'a warning morning-links-ready marker must NEVER recover the failed service');
assert.equal(assessBusinessRecovery('shein-bi-cloud-morning-chain.service', unitStatus, {
  morningMarker: doneButNotOk,
}).recovered, false, 'a done marker with ok=false must not recover the failed service');
assert.equal(assessBusinessRecovery('shein-bi-cloud-morning-chain.service', unitStatus, {
  morningMarker: wrongDate,
}).recovered, false, 'a marker for another run date must not recover today\'s failed service');
assert.equal(assessBusinessRecovery('shein-bi-cloud-morning-chain.service', unitStatus, {
  morningMarker: tooOld,
}).recovered, false, 'a marker written before the unit exit must not recover the failed service');
assert.equal(assessBusinessRecovery('shein-bi-cloud-morning-chain.service', unitStatus, {
  morningMarker: null,
}).recovered, false, 'a missing marker must not recover the failed service');
assert.equal(assessBusinessRecovery('shein-bi-cloud-order-closure.service', unitStatus, {
  morningMarker: doneMarker,
}).recovered, false, 'a morning marker must not recover non-morning units');

// The production watchdog must read the morning-chain latest state and wire
// the predicate into the per-unit systemd loop with an explicit blocker text
// that is pushed to issues (an alert), never into maintenance notes.
assert.match(watchdog, /cloud_morning_chain', 'latest\.json'/,
  'the watchdog must observe the coordinator latest.json');
assert.match(watchdog, /isMorningChainStaleRunning\(morningChainLatest, status\)/,
  'the stale-running predicate must be wired into the per-unit loop');
assert.match(watchdog, /晨链终态未收敛/,
  'a stale-running morning chain must surface an explicit blocker issue');
assert.match(watchdog, /^      issues\.push\(`晨链终态未收敛/m,
  'the stale-running blocker must be pushed into issues so the alert path pages it');
assert.match(watchdog, /isMorningChainTerminalFailure\(morningChainLatest, status\)/,
  'the terminal-failure predicate must be wired into the per-unit loop');
assert.match(watchdog, /晨链当日失败/,
  'a converged terminal morning-chain failure must surface an explicit blocker issue');
assert.match(watchdog, /^      issues\.push\(`晨链当日失败/m,
  'the terminal-failure blocker must be pushed into issues so the alert path pages it');
assert.match(watchdog, /export function isMorningChainTerminalFailure/, 'the terminal-failure predicate must be importable');
assert.match(watchdog, /export function assessBusinessRecovery/, 'the business-recovery predicate must be importable');
assert.match(watchdog, /String\(morningMarker\?\.status \|\| ''\) === 'done'/,
  'business recovery must require the morning-links-ready status to be done');
assert.doesNotMatch(watchdog, /\['done', 'warning'\]/,
  'a warning morning-links-ready marker must never be part of business recovery');
assert.match(watchdog, /morningChainLatest,/,
  'the observed latest state must be part of the watchdog report for follow-up');
assert.match(watchdog, /const isMain = process\.argv\[1\]/,
  'the watchdog main loop must only run when executed directly so tests can import the predicate');

console.log(JSON.stringify({ok: true, checks: ['stale_running_detection', 'no_false_positive_on_active_or_unknown', 'terminal_failure_detection', 'business_recovery_done_only_no_warning', 'watchdog_wiring']}, null, 2));
