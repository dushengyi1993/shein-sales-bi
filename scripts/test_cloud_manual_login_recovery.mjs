#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {
  assessLinkRecoveryCompletion,
  assessSessionManagerManualRecovery,
  mergeLinkBusinessPartialState,
  planManualLoginLinkRecovery,
  planManualLoginLinkRecoveryFromMorningChunks,
} from '../lib/cloud_manual_login_recovery.mjs';

const plan = planManualLoginLinkRecovery({
  storeKey: 'dx',
  partialState: {
    date: '2026-07-31',
    failedStores: 'DX QY',
    successStores: 'DL FY',
    logFile: '/srv/shein-bi/logs/partial.log',
  },
});
assert.equal(plan.required, true);
assert.equal(plan.storeKey, 'DX');
assert.equal(plan.date, '2026-07-31');

assert.deepEqual(
  planManualLoginLinkRecovery({
    storeKey: 'HL',
    partialState: {date: '2026-07-31', failedStores: ['DX']},
  }),
  {
    required: false,
    reason: 'store_not_in_partial_failure',
    date: '2026-07-31',
    failedStores: ['DX'],
  },
);

const failedReport = {
  ok: false,
  generatedAt: '2026-08-01T02:39:51.000Z',
  summary: {failedStores: ['DX']},
};
const failedUnit = {
  ExecMainExitTimestamp: 'Sat 2026-08-01 10:39:51 CST',
  StateChangeTimestamp: 'Sat 2026-08-01 10:39:51 CST',
};
const recovered = assessSessionManagerManualRecovery({
  sessionReport: failedReport,
  unitStatus: failedUnit,
  manualLoginState: {
    sessions: [{
      storeKey: 'DX',
      status: 'completed',
      completedAt: '2026-08-01T07:48:39.022Z',
      finish: {export: {ok: true}, probe: {ok: true}},
    }],
  },
});
assert.equal(recovered.recovered, true);
assert.deepEqual(recovered.recoveredStores, ['DX']);

assert.equal(assessSessionManagerManualRecovery({
  sessionReport: failedReport,
  unitStatus: failedUnit,
  manualLoginState: {
    sessions: [{
      storeKey: 'DX',
      status: 'completed',
      completedAt: '2026-08-01T07:48:39.022Z',
      finish: {export: {ok: true}, probe: {ok: false}},
    }],
  },
}).recovered, false);

assert.equal(assessSessionManagerManualRecovery({
  sessionReport: failedReport,
  unitStatus: failedUnit,
  manualLoginState: {
    sessions: [{
      storeKey: 'DX',
      status: 'completed',
      completedAt: '2026-08-01T01:48:39.022Z',
      finish: {export: {ok: true}, probe: {ok: true}},
    }],
  },
}).recovered, false);

assert.equal(assessSessionManagerManualRecovery({
  sessionReport: {
    ok: true,
    generatedAt: '2026-08-01T11:12:55.054Z',
    summary: {failedStores: []},
  },
  unitStatus: failedUnit,
  manualLoginState: {sessions: []},
}).recovered, true);

const completion = assessLinkRecoveryCompletion({
  plan: {storeKey: 'DX', date: '2026-07-31'},
  startedAt: '2026-08-01T11:13:00.000Z',
  successState: {
    ok: true,
    date: '2026-07-31',
    generatedAt: '2026-08-01T11:16:28.417Z',
    successfulStores: ['DL', 'DX', 'FY'],
    failedStores: [],
    metricReady: true,
    warehouseLoaded: true,
  },
  partialState: null,
});
assert.equal(completion.complete, true);

assert.equal(assessLinkRecoveryCompletion({
  plan: {storeKey: 'DX', date: '2026-07-31'},
  startedAt: '2026-08-01T11:13:00.000Z',
  successState: {
    ok: true,
    date: '2026-07-31',
    generatedAt: '2026-08-01T11:16:28.417Z',
    successfulStores: ['DX'],
    failedStores: [],
    metricReady: true,
    warehouseLoaded: true,
  },
  partialState: {date: '2026-07-31', failedStores: 'DX'},
}).complete, false);

// Morning-chunk fallback planner: authoritative same-run evidence only.
const ENABLED_STORES = ['CX', 'DL', 'DX', 'FY', 'HL', 'JSH', 'JY', 'LQ', 'MZ', 'NM', 'QH', 'QY', 'TS', 'TZZ', 'TZ', 'XL', 'XC', 'YJ', 'ZL'];
const RUN_DATE = '2026-08-16';
const BUSINESS_DATE = '2026-08-15';
const latestFailed = {
  date: RUN_DATE,
  businessDate: BUSINESS_DATE,
  generatedAt: '2026-08-16T03:00:00+08:00',
  stage: 'all',
  status: 'failed',
  message: 'no-progress store retry bound reached',
  logFile: '/srv/shein-bi/logs/cloud-morning-chain/morning-all-2026-08-15-071000.log',
};
const allBut = failed => ENABLED_STORES.filter(store => !failed.includes(store));
const chunk = (name, {
  status = 'warning', success = [], failed = [], date = BUSINESS_DATE,
  generatedAt = '2026-08-16T02:00:00+08:00',
  logFile = '/srv/shein-bi/logs/cloud-morning-chain/chunk.log',
} = {}) => ({
  name,
  payload: {
    ok: status === 'done',
    status,
    date,
    generatedAt,
    successfulStores: success,
    failedStores: failed,
    message: '',
    logFile,
  },
});

const fallbackValid = planManualLoginLinkRecoveryFromMorningChunks({
  storeKey: 'DX',
  runDate: RUN_DATE,
  enabledStores: ENABLED_STORES,
  latestState: latestFailed,
  chunkDocuments: [
    chunk(`${RUN_DATE}-all.json`, {success: allBut(['DX', 'QY']), failed: ['DX', 'QY']}),
  ],
});
assert.equal(fallbackValid.required, true);
assert.equal(fallbackValid.reason, 'morning_chunk_partial_recovery');
assert.equal(fallbackValid.date, BUSINESS_DATE);
assert.deepEqual(fallbackValid.failedStores, ['DX', 'QY']);
assert.deepEqual(fallbackValid.chunkFiles, ['2026-08-16-all.json']);

// A later same-run retry chunk recovering a store wins over the earlier chunk.
const fallbackRecovered = planManualLoginLinkRecoveryFromMorningChunks({
  storeKey: 'DX',
  runDate: RUN_DATE,
  enabledStores: ENABLED_STORES,
  latestState: latestFailed,
  chunkDocuments: [
    chunk(`${RUN_DATE}-all.json`, {success: allBut(['DX', 'QY']), failed: ['DX', 'QY']}),
    chunk(`${RUN_DATE}-retry-1.json`, {
      success: ['DX'], failed: ['QY'], generatedAt: '2026-08-16T02:05:00+08:00',
    }),
  ],
});
assert.equal(fallbackRecovered.required, false);
assert.equal(fallbackRecovered.reason, 'store_not_in_fallback_failure');
assert.deepEqual(fallbackRecovered.failedStores, ['QY']);

const fallbackFailedAgain = planManualLoginLinkRecoveryFromMorningChunks({
  storeKey: 'DX',
  runDate: RUN_DATE,
  enabledStores: ENABLED_STORES,
  latestState: latestFailed,
  chunkDocuments: [
    chunk(`${RUN_DATE}-all.json`, {
      success: allBut(['DX', 'QY']), failed: ['DX', 'QY'], generatedAt: '2026-08-16T01:00:00+08:00',
    }),
    chunk(`${RUN_DATE}-retry-1.json`, {
      success: ['DX'], failed: [], generatedAt: '2026-08-16T02:00:00+08:00',
    }),
    chunk(`${RUN_DATE}-retry-2.json`, {
      success: [], failed: ['DX'], generatedAt: '2026-08-16T03:00:00+08:00',
    }),
  ],
});
assert.equal(fallbackFailedAgain.required, true);
assert.deepEqual(fallbackFailedAgain.failedStores, ['DX', 'QY']);

const fallbackQy = planManualLoginLinkRecoveryFromMorningChunks({
  storeKey: 'QY',
  runDate: RUN_DATE,
  enabledStores: ENABLED_STORES,
  latestState: latestFailed,
  chunkDocuments: [
    chunk(`${RUN_DATE}-all.json`, {success: allBut(['DX', 'QY']), failed: ['DX', 'QY']}),
    chunk(`${RUN_DATE}-retry-1.json`, {
      success: ['DX'], failed: ['QY'], generatedAt: '2026-08-16T02:05:00+08:00',
    }),
  ],
});
assert.equal(fallbackQy.required, true);
assert.deepEqual(fallbackQy.failedStores, ['QY']);

// Reviewer counterexamples: equal chunk timestamps with conflicting per-store
// conclusions must reject the fallback; numeric retry ordering is only a
// deterministic tie-breaker for non-conflicting evidence.
assert.equal(planManualLoginLinkRecoveryFromMorningChunks({
  storeKey: 'DX',
  runDate: RUN_DATE,
  enabledStores: ENABLED_STORES,
  latestState: latestFailed,
  chunkDocuments: [
    chunk(`${RUN_DATE}-all.json`, {success: allBut(['DX', 'QY']), failed: ['DX', 'QY']}),
    chunk(`${RUN_DATE}-retry-1.json`, {success: ['DX'], failed: []}),
  ],
}).reason, 'fallback_chunk_conflict');
const conflictPlan = planManualLoginLinkRecoveryFromMorningChunks({
  storeKey: 'DX',
  runDate: RUN_DATE,
  enabledStores: ENABLED_STORES,
  latestState: latestFailed,
  chunkDocuments: [
    chunk(`${RUN_DATE}-all.json`, {success: allBut(['DX', 'QY']), failed: ['DX', 'QY']}),
    chunk(`${RUN_DATE}-retry-1.json`, {success: ['DX'], failed: []}),
  ],
});
assert.equal(conflictPlan.required, false);
assert.equal(conflictPlan.storeKey, 'DX');
assert.deepEqual(conflictPlan.chunkFiles, ['2026-08-16-all.json', '2026-08-16-retry-1.json']);

const equalTimestampTieBreak = planManualLoginLinkRecoveryFromMorningChunks({
  storeKey: 'QY',
  runDate: RUN_DATE,
  enabledStores: ENABLED_STORES,
  latestState: latestFailed,
  chunkDocuments: [
    chunk(`${RUN_DATE}-all.json`, {
      success: allBut(['QY']), failed: ['QY'],
      logFile: '/srv/shein-bi/logs/cloud-morning-chain/all.log',
    }),
    chunk(`${RUN_DATE}-retry-1.json`, {
      success: ['DX'], failed: [],
      logFile: '/srv/shein-bi/logs/cloud-morning-chain/retry.log',
    }),
  ],
});
assert.equal(equalTimestampTieBreak.required, true);
assert.deepEqual(equalTimestampTieBreak.failedStores, ['QY']);
assert.equal(equalTimestampTieBreak.logFile, '/srv/shein-bi/logs/cloud-morning-chain/retry.log');

const conflictResolvedLatest = planManualLoginLinkRecoveryFromMorningChunks({
  storeKey: 'QY',
  runDate: RUN_DATE,
  enabledStores: ENABLED_STORES,
  latestState: latestFailed,
  chunkDocuments: [
    chunk(`${RUN_DATE}-all.json`, {
      success: allBut(['DX', 'QY']), failed: ['DX', 'QY'], generatedAt: '2026-08-16T01:00:00+08:00',
    }),
    chunk(`${RUN_DATE}-retry-1.json`, {
      success: ['DX'], failed: ['QY'], generatedAt: '2026-08-16T03:00:00+08:00',
    }),
  ],
});
assert.equal(conflictResolvedLatest.required, true);
assert.deepEqual(conflictResolvedLatest.failedStores, ['QY']);
assert.equal(conflictResolvedLatest.successStores.includes('DX'), true);

assert.equal(planManualLoginLinkRecoveryFromMorningChunks({
  storeKey: 'DX',
  runDate: RUN_DATE,
  enabledStores: ENABLED_STORES,
  latestState: latestFailed,
  chunkDocuments: [chunk(`${RUN_DATE}-all.json`, {success: [...allBut(['DX']), 'DX'], failed: ['DX']})],
}).reason, 'fallback_chunk_store_conflict');
assert.equal(planManualLoginLinkRecoveryFromMorningChunks({
  storeKey: 'DX',
  runDate: RUN_DATE,
  enabledStores: ENABLED_STORES,
  latestState: latestFailed,
  chunkDocuments: [{
    name: `${RUN_DATE}-all.json`,
    payload: {
      status: 'warning', date: BUSINESS_DATE, generatedAt: 'not-a-timestamp',
      successfulStores: allBut(['DX']), failedStores: ['DX'],
    },
  }],
}).reason, 'fallback_chunk_time_invalid');

// Fail-closed refusals: active/completed run, stale pair, cross-day chunk,
// contradictory done chunk, unknown status, malformed chunk, inexact set,
// no failures, store not in failures, missing evidence.
assert.equal(planManualLoginLinkRecoveryFromMorningChunks({
  storeKey: 'DX',
  runDate: RUN_DATE,
  enabledStores: ENABLED_STORES,
  latestState: {...latestFailed, status: 'running'},
  chunkDocuments: [chunk(`${RUN_DATE}-all.json`, {success: allBut(['DX']), failed: ['DX']})],
}).reason, 'fallback_run_status_not_terminal_failure');
const staleRunningRecovered = planManualLoginLinkRecoveryFromMorningChunks({
  storeKey: 'DX',
  runDate: RUN_DATE,
  enabledStores: ENABLED_STORES,
  latestState: {...latestFailed, status: 'running', generatedAt: '2026-08-16T01:00:00+08:00'},
  morningServiceActive: false,
  chunkDocuments: [chunk(`${RUN_DATE}-all.json`, {
    success: allBut(['DX']), failed: ['DX'], generatedAt: '2026-08-16T02:00:00+08:00',
  })],
});
assert.equal(staleRunningRecovered.required, true);
assert.equal(staleRunningRecovered.reason, 'morning_chunk_partial_recovery');
assert.equal(planManualLoginLinkRecoveryFromMorningChunks({
  storeKey: 'DX',
  runDate: RUN_DATE,
  enabledStores: ENABLED_STORES,
  latestState: {...latestFailed, status: 'running', generatedAt: '2026-08-16T03:00:00+08:00'},
  morningServiceActive: false,
  chunkDocuments: [chunk(`${RUN_DATE}-all.json`, {
    success: allBut(['DX']), failed: ['DX'], generatedAt: '2026-08-16T02:00:00+08:00',
  })],
}).reason, 'fallback_stale_running_not_superseded');
assert.equal(planManualLoginLinkRecoveryFromMorningChunks({
  storeKey: 'DX',
  runDate: RUN_DATE,
  enabledStores: ENABLED_STORES,
  latestState: null,
  chunkDocuments: [chunk(`${RUN_DATE}-all.json`, {success: allBut(['DX']), failed: ['DX']})],
}).reason, 'fallback_run_state_missing');
assert.equal(planManualLoginLinkRecoveryFromMorningChunks({
  storeKey: 'DX',
  runDate: RUN_DATE,
  enabledStores: ENABLED_STORES,
  latestState: {...latestFailed, date: '2026-08-15', businessDate: '2026-08-14'},
  chunkDocuments: [chunk(`${RUN_DATE}-all.json`, {success: allBut(['DX']), failed: ['DX']})],
}).reason, 'fallback_run_pair_mismatch');
assert.equal(planManualLoginLinkRecoveryFromMorningChunks({
  storeKey: 'DX',
  runDate: RUN_DATE,
  enabledStores: ENABLED_STORES,
  latestState: latestFailed,
  chunkDocuments: [chunk(`${RUN_DATE}-all.json`, {date: '2026-08-14', success: allBut(['DX']), failed: ['DX']})],
}).reason, 'fallback_chunk_date_mismatch');
assert.equal(planManualLoginLinkRecoveryFromMorningChunks({
  storeKey: 'DX',
  runDate: RUN_DATE,
  enabledStores: ENABLED_STORES,
  latestState: latestFailed,
  chunkDocuments: [chunk(`${RUN_DATE}-all.json`, {status: 'done', success: allBut(['DX']), failed: ['DX']})],
}).reason, 'fallback_chunk_status_inconsistent');
assert.equal(planManualLoginLinkRecoveryFromMorningChunks({
  storeKey: 'DX',
  runDate: RUN_DATE,
  enabledStores: ENABLED_STORES,
  latestState: latestFailed,
  chunkDocuments: [chunk(`${RUN_DATE}-all.json`, {status: 'bogus', success: allBut(['DX']), failed: ['DX']})],
}).reason, 'fallback_chunk_status_invalid');
assert.equal(planManualLoginLinkRecoveryFromMorningChunks({
  storeKey: 'DX',
  runDate: RUN_DATE,
  enabledStores: ENABLED_STORES,
  latestState: latestFailed,
  chunkDocuments: [{name: `${RUN_DATE}-all.json`, payload: null}],
}).reason, 'fallback_chunk_malformed');
assert.equal(planManualLoginLinkRecoveryFromMorningChunks({
  storeKey: 'DX',
  runDate: RUN_DATE,
  enabledStores: ENABLED_STORES,
  latestState: latestFailed,
  chunkDocuments: [chunk(`${RUN_DATE}-all.json`, {success: allBut(['DX', 'QY']), failed: ['DX']})],
}).reason, 'fallback_store_set_mismatch');
assert.equal(planManualLoginLinkRecoveryFromMorningChunks({
  storeKey: 'DX',
  runDate: RUN_DATE,
  enabledStores: ENABLED_STORES,
  latestState: latestFailed,
  chunkDocuments: [chunk(`${RUN_DATE}-all.json`, {success: [...allBut(['DX']), 'ZZ'], failed: ['DX']})],
}).reason, 'fallback_store_set_mismatch');
assert.equal(planManualLoginLinkRecoveryFromMorningChunks({
  storeKey: 'DX',
  runDate: RUN_DATE,
  enabledStores: ENABLED_STORES,
  latestState: latestFailed,
  chunkDocuments: [chunk(`${RUN_DATE}-all.json`, {status: 'done', success: ENABLED_STORES})],
}).reason, 'fallback_no_failed_stores');
assert.equal(planManualLoginLinkRecoveryFromMorningChunks({
  storeKey: 'DX',
  runDate: RUN_DATE,
  enabledStores: ENABLED_STORES,
  latestState: latestFailed,
  chunkDocuments: [chunk(`${RUN_DATE}-all.json`, {success: allBut(['QY']), failed: ['QY']})],
}).reason, 'store_not_in_fallback_failure');
assert.equal(planManualLoginLinkRecoveryFromMorningChunks({
  storeKey: 'DX',
  runDate: RUN_DATE,
  enabledStores: ENABLED_STORES,
  latestState: latestFailed,
  chunkDocuments: [],
}).reason, 'fallback_no_chunks');
assert.equal(planManualLoginLinkRecoveryFromMorningChunks({
  storeKey: 'DX',
  runDate: RUN_DATE,
  enabledStores: ENABLED_STORES,
  latestState: latestFailed,
  chunkDocuments: [{name: `${RUN_DATE}-all.json`, payload: {schemaVersion: 'shein-morning-resume-evidence/v1', ok: true}}],
}).reason, 'fallback_no_partial_chunks');

// Canonical partial seeding/merging.
const seeded = mergeLinkBusinessPartialState({
  date: BUSINESS_DATE,
  failedStores: ['DX', 'QY'],
  successStores: allBut(['DX', 'QY']),
  logFile: '/srv/shein-bi/logs/cloud-morning-chain/chunk.log',
  generatedAt: '2026-08-16T03:30:00+08:00',
  recoveryRunId: 'run-1',
});
assert.equal(seeded.date, BUSINESS_DATE);
assert.equal(seeded.failedStores, 'DX QY');
assert.equal(seeded.successStores, allBut(['DX', 'QY']).sort().join(' '));
assert.equal(seeded.logFile, '/srv/shein-bi/logs/cloud-morning-chain/chunk.log');
assert.equal(seeded.recoveryRunId, 'run-1');
const merged = mergeLinkBusinessPartialState({
  existing: seeded,
  date: BUSINESS_DATE,
  successStores: ['DX'],
  logFile: '/srv/shein-bi/logs/cloud-morning-chain/retry.log',
  generatedAt: '2026-08-16T04:00:00+08:00',
});
assert.equal(merged.failedStores, 'QY');
assert.equal(merged.successStores.includes('DX'), true);
assert.equal(merged.logFile, '/srv/shein-bi/logs/cloud-morning-chain/retry.log');
assert.equal(merged.recoveryRunId, 'run-1');
const replaced = mergeLinkBusinessPartialState({
  existing: seeded,
  date: '2026-08-14',
  successStores: ['HL'],
});
assert.equal(replaced.date, '2026-08-14');
assert.equal(replaced.failedStores, '');
assert.equal(replaced.successStores, 'HL');

// A store removed from the partial (moved to success while others remain
// pending) must terminate as completed_pending_others without success evidence.
const pendingOthers = assessLinkRecoveryCompletion({
  plan: {storeKey: 'DX', date: BUSINESS_DATE},
  startedAt: '2026-08-16T04:00:00.000Z',
  successState: null,
  partialState: {date: BUSINESS_DATE, failedStores: 'QY', successStores: allBut(['QY']).join(' ')},
});
assert.equal(pendingOthers.complete, false);
assert.equal(pendingOthers.pendingOthers, true);
assert.equal(pendingOthers.reason, 'store_removed_from_partial_pending_others');

const omittedFromBothSets = assessLinkRecoveryCompletion({
  plan: {storeKey: 'DX', date: BUSINESS_DATE},
  startedAt: '2026-08-16T04:00:00.000Z',
  successState: null,
  partialState: {date: BUSINESS_DATE, failedStores: 'QY', successStores: allBut(['DX', 'QY']).join(' ')},
});
assert.equal(omittedFromBothSets.pendingOthers, false);

// completed_pending_others must be proven by the current attempt: command ok,
// partial.generatedAt >= attemptStartedAt, bound attempt/run id match, and the
// target store's exact-date evidence files verified.
const attemptBase = {
  commandOk: true,
  startedAt: '2026-08-16T04:00:00.000Z',
  recoveryRunId: 'sid-a1',
  evidenceVerified: true,
};
const partialForAttempt = {
  date: BUSINESS_DATE,
  generatedAt: '2026-08-16T04:30:00.000Z',
  failedStores: 'QY',
  successStores: allBut(['QY']).join(' '),
  recoveryRunId: 'sid-a1',
};
const pendingWithAttempt = assessLinkRecoveryCompletion({
  plan: {storeKey: 'DX', date: BUSINESS_DATE},
  startedAt: attemptBase.startedAt,
  successState: null,
  partialState: partialForAttempt,
  attempt: attemptBase,
});
assert.equal(pendingWithAttempt.pendingOthers, true);
assert.equal(pendingWithAttempt.reason, 'store_removed_from_partial_pending_others');
assert.equal(assessLinkRecoveryCompletion({
  plan: {storeKey: 'DX', date: BUSINESS_DATE},
  startedAt: attemptBase.startedAt,
  successState: null,
  partialState: partialForAttempt,
  attempt: {...attemptBase, commandOk: false},
}).pendingOthers, false);
assert.equal(assessLinkRecoveryCompletion({
  plan: {storeKey: 'DX', date: BUSINESS_DATE},
  startedAt: attemptBase.startedAt,
  successState: null,
  partialState: partialForAttempt,
  attempt: {...attemptBase, commandOk: false},
}).reason, 'pending_others_command_failed');
assert.equal(assessLinkRecoveryCompletion({
  plan: {storeKey: 'DX', date: BUSINESS_DATE},
  startedAt: attemptBase.startedAt,
  successState: null,
  partialState: {...partialForAttempt, generatedAt: '2026-08-16T03:30:00.000Z'},
  attempt: attemptBase,
}).reason, 'pending_others_partial_stale');
assert.equal(assessLinkRecoveryCompletion({
  plan: {storeKey: 'DX', date: BUSINESS_DATE},
  startedAt: attemptBase.startedAt,
  successState: null,
  partialState: {...partialForAttempt, recoveryRunId: 'sid-a2'},
  attempt: attemptBase,
}).reason, 'pending_others_run_id_mismatch');
assert.equal(assessLinkRecoveryCompletion({
  plan: {storeKey: 'DX', date: BUSINESS_DATE},
  startedAt: attemptBase.startedAt,
  successState: null,
  partialState: partialForAttempt,
  attempt: {...attemptBase, evidenceVerified: false},
}).reason, 'pending_others_evidence_missing');
assert.equal(assessLinkRecoveryCompletion({
  plan: {storeKey: 'DX', date: BUSINESS_DATE},
  startedAt: attemptBase.startedAt,
  successState: null,
  partialState: partialForAttempt,
  attempt: {...attemptBase, evidenceVerified: false},
}).pendingOthers, false);

const stillBlocks = assessLinkRecoveryCompletion({
  plan: {storeKey: 'DX', date: BUSINESS_DATE},
  startedAt: '2026-08-16T04:00:00.000Z',
  successState: null,
  partialState: {date: BUSINESS_DATE, failedStores: 'DX QY', successStores: allBut(['DX', 'QY']).join(' ')},
});
assert.equal(stillBlocks.pendingOthers, false);

const finalStoreComplete = assessLinkRecoveryCompletion({
  plan: {storeKey: 'QY', date: BUSINESS_DATE},
  startedAt: '2026-08-16T04:00:00.000Z',
  successState: {
    ok: true,
    date: BUSINESS_DATE,
    generatedAt: '2026-08-16T05:00:00.000Z',
    successfulStores: ENABLED_STORES,
    failedStores: [],
    metricReady: true,
    warehouseLoaded: true,
  },
  partialState: {date: BUSINESS_DATE, failedStores: '', successStores: ENABLED_STORES.join(' ')},
});
assert.equal(finalStoreComplete.complete, true);
assert.equal(finalStoreComplete.pendingOthers, false);

const manualScript = fs.readFileSync(new URL('./cloud_manual_login_session.mjs', import.meta.url), 'utf8');
assert.match(manualScript, /finishResult\?\.export\?\.ok === true && finishResult\?\.probe\?\.ok === true/);
assert.match(manualScript, /scheduleLinkRecovery\(session, args\)/);
assert.match(manualScript, /shein-manual-login-recovery-queue\/v1/);
assert.match(manualScript, /SHEIN_BI_MORNING_CHAIN_STATE_DIR/);
assert.match(manualScript, /planManualLoginLinkRecoveryFromMorningChunks/);
assert.match(manualScript, /seedLinkBusinessPartialFromFallback/);
assert.match(manualScript, /seed_link_business_partial_state\.mjs/);
assert.match(manualScript, /DEFAULT_LINK_PARTIAL_LOCK_FILE/);
assert.match(manualScript, /prepare_shared_lock_file/);
assert.match(manualScript, /flock -w/);
assert.match(manualScript, /'show', '--no-pager', '--property=LoadState', '--property=ActiveState'/);
assert.doesNotMatch(manualScript, /systemctl is-active/);
const seedHelperScript = fs.readFileSync(new URL('./seed_link_business_partial_state.mjs', import.meta.url), 'utf8');
assert.match(seedHelperScript, /mergeLinkBusinessPartialState/);
assert.match(seedHelperScript, /fs\.rename\(temporary, partialFile\)/);
assert.match(seedHelperScript, /reason: 'canonical_exists'/);
{
  const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-login-partial-seed-'));
  try {
    const partialFile = path.join(seedDir, 'partial.json');
    const firstPlan = JSON.stringify({
      date: BUSINESS_DATE,
      failedStores: ['DX', 'QY'],
      successStores: allBut(['DX', 'QY']),
      logFile: 'first',
      recoveryRunId: '',
    });
    const first = spawnSync(process.execPath, [path.join(process.cwd(), 'scripts', 'seed_link_business_partial_state.mjs')], {
      cwd: process.cwd(), encoding: 'utf8',
      env: {...process.env, SEED_PARTIAL_FILE: partialFile, SEED_PARTIAL_PLAN: firstPlan},
    });
    assert.equal(first.status, 0, first.stderr);
    const firstBytes = fs.readFileSync(partialFile, 'utf8');
    const stalePlan = JSON.stringify({
      date: BUSINESS_DATE,
      failedStores: ENABLED_STORES,
      successStores: [],
      logFile: 'stale',
      recoveryRunId: '',
    });
    const second = spawnSync(process.execPath, [path.join(process.cwd(), 'scripts', 'seed_link_business_partial_state.mjs')], {
      cwd: process.cwd(), encoding: 'utf8',
      env: {...process.env, SEED_PARTIAL_FILE: partialFile, SEED_PARTIAL_PLAN: stalePlan},
    });
    assert.equal(second.status, 17, second.stderr);
    assert.equal(fs.readFileSync(partialFile, 'utf8'), firstBytes);
  } finally {
    fs.rmSync(seedDir, {recursive: true, force: true});
  }
}

const recoveryWorkerScript = fs.readFileSync(new URL('./cloud_manual_login_recovery.mjs', import.meta.url), 'utf8');
assert.match(recoveryWorkerScript, /completed_pending_others/);
assert.match(recoveryWorkerScript, /targeted_store_removed_from_partial_pending_others/);
assert.match(recoveryWorkerScript, /SHEIN_LINK_BUSINESS_RUN_ID: attemptRunId/);
assert.match(recoveryWorkerScript, /targetStoreEvidenceComplete/);
assert.match(recoveryWorkerScript, /commandOk: result\.ok/);

const recoveryQueueScript = fs.readFileSync(new URL('./cloud_manual_login_recovery_queue.mjs', import.meta.url), 'utf8');
assert.match(recoveryQueueScript, /\[['"]completed['"], ['"]not_required['"], ['"]completed_pending_others['"]\]/);

const linkScript = fs.readFileSync(new URL('./cloud_link_business_sync.sh', import.meta.url), 'utf8');
assert.match(linkScript, /selection_args=\(--stores "\$SHEIN_LINK_BUSINESS_STORES"\)/);
assert.match(linkScript, /const success = new Set\(sameDate/);
assert.match(linkScript, /const failed = new Set\(sameDate/);
assert.match(linkScript, /prepare_shared_lock_file/);
assert.match(linkScript, /LINK_PARTIAL_LOCK_FILE/);
assert.match(linkScript, /LINK_RUN_LOCK_FILE/);
assert.match(linkScript, /full-run\/publish lifecycle lock/);
assert.ok((linkScript.match(/flock -w/g) || []).length >= 4);
assert.equal((linkScript.match(/recoveryRunId: process\.env\.SHEIN_LINK_BUSINESS_RUN_ID \|\| ''/g) || []).length, 3);
assert.match(linkScript, /TARGETED_RECOVERY_OUTCOME=/);
assert.match(linkScript, /const success = new Set\(split\(prior\.successStores\)\);/);
assert.match(linkScript, /hold\|failed_stores_remain/);
assert.match(linkScript, /hold\|store_set_not_exact/);
assert.match(linkScript, /nomatch\|no_same_date_partial/);
assert.match(linkScript, /publish \$\{expected\.join\(' '\)\}/);
assert.match(linkScript, /evidence-ok/);
assert.match(linkScript, /evidence-missing/);
assert.match(linkScript, /systemctl show --no-pager --property=LoadState --value/);
assert.doesNotMatch(linkScript, /systemctl is-active/);
// Partial subsets must never reach warehouse/portal: the targeted hold/nomatch
// exits appear before any dashboard/warehouse/portal publication step.
assert.ok(linkScript.indexOf('TARGETED_RECOVERY_OUTCOME=') < linkScript.indexOf('generate_link_ops_web_dashboard.mjs'));
assert.ok(linkScript.indexOf('hold|failed_stores_remain') < linkScript.indexOf('generate_link_ops_web_dashboard.mjs'));
assert.ok(linkScript.indexOf('nomatch|no_same_date_partial') < linkScript.indexOf('generate_link_ops_web_dashboard.mjs'));
// The evidence gate also precedes any dashboard/warehouse/portal publication.
assert.ok(linkScript.indexOf('evidence-missing') < linkScript.indexOf('generate_link_ops_web_dashboard.mjs'));

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-login-recovery-queue-'));
try {
  const runtimeDir = path.join(temp, 'runtime');
  const logDir = path.join(temp, 'logs');
  const empty = spawnSync(process.execPath, [
    path.join(process.cwd(), 'scripts', 'cloud_manual_login_recovery_queue.mjs'),
    '--runtime-dir', runtimeDir,
    '--log-dir', logDir,
  ], {cwd: process.cwd(), encoding: 'utf8'});
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(JSON.parse(empty.stdout).processed, 0);

  const queueDir = path.join(runtimeDir, 'queue');
  fs.writeFileSync(path.join(queueDir, 'bad.json'), JSON.stringify({schemaVersion: 'wrong'}), 'utf8');
  const invalid = spawnSync(process.execPath, [
    path.join(process.cwd(), 'scripts', 'cloud_manual_login_recovery_queue.mjs'),
    '--runtime-dir', runtimeDir,
    '--log-dir', logDir,
  ], {cwd: process.cwd(), encoding: 'utf8'});
  assert.equal(invalid.status, 2);
  assert.equal(fs.existsSync(path.join(runtimeDir, 'failed', 'bad.json')), true);
} finally {
  fs.rmSync(temp, {recursive: true, force: true});
}

const serviceUnit = fs.readFileSync(new URL('../infra/systemd/shein-bi-cloud-manual-login-recovery.service', import.meta.url), 'utf8');
const pathUnit = fs.readFileSync(new URL('../infra/systemd/shein-bi-cloud-manual-login-recovery.path', import.meta.url), 'utf8');
const timerUnit = fs.readFileSync(new URL('../infra/systemd/shein-bi-cloud-manual-login-recovery.timer', import.meta.url), 'utf8');
assert.match(serviceUnit, /User=sheinops/);
assert.match(serviceUnit, /MemoryMax=3400M/);
assert.match(serviceUnit, /cloud_manual_login_recovery_queue\.mjs/);
assert.match(serviceUnit, /ExecCondition=.*shein-bi-cloud-daily-refresh\.service/);
assert.match(pathUnit, /DirectoryNotEmpty=\/srv\/shein-bi\/runtime\/cloud_manual_login_recovery\/queue/);
assert.match(timerUnit, /OnCalendar=\*-\*-\* \*:47:00/);
assert.match(timerUnit, /Persistent=false/);
assert.doesNotMatch(timerUnit, /OnUnitInactiveSec=/);

const testCount = (fs.readFileSync(new URL(import.meta.url), 'utf8').match(/\bassert\./g) || []).length;
console.log(JSON.stringify({ok: true, tests: testCount}, null, 2));
