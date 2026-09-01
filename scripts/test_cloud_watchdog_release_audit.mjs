#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  applyWatchdogAlertState,
} from '../lib/cloud_watchdog_alert_state.mjs';
import {
  detachWatchdogReleaseAuditState,
  filterWatchdogReleaseAuditIssues,
  isWatchdogReleaseAuditIssue,
  resolveWatchdogReleaseAudit,
  sourceIntegrityIssueFor,
  watchdogIssueMaintenanceClass,
} from './cloud_ops_watchdog.mjs';

const emergencyCommit = 'e'.repeat(40);
const cleanSource = {
  ok: true,
  commitMatches: true,
  dirtyEntries: [],
  hiddenIndexEntries: [],
  missingTrackedFiles: [],
};

const audit = resolveWatchdogReleaseAudit({
  deployedReleaseValidation: {ok: false, issues: ['schema_version_invalid']},
  deploymentEvidence: {ok: false, issues: ['deployment_evidence_verification_failed']},
  emergencyLocalRelease: {
    ok: true,
    exists: true,
    issues: [],
    receipt: {commit: emergencyCommit},
  },
});
assert.equal(audit.releaseAuditReady, false, 'formal v3 audit must stay red');
assert.ok(audit.releaseAuditIssues.length >= 2);
assert.equal(audit.expectedCommit, emergencyCommit, 'valid emergency receipt must bind the exact source commit');
assert.equal(audit.sourceBinding, 'emergency-local-receipt-v1');
assert.deepEqual(
  filterWatchdogReleaseAuditIssues(audit.releaseAuditIssues),
  [],
  'release-only advisories must never become normal notification issues',
);
assert.equal(sourceIntegrityIssueFor(cleanSource), null, 'clean source remains business/infrastructure green');

const dirtySourceIssue = sourceIntegrityIssueFor({
  ...cleanSource,
  dirtyEntries: [' M tracked.js'],
});
assert.match(dirtySourceIssue, /dirty=1/);
assert.ok(dirtySourceIssue, 'dirty tracked source must stay actionable despite a valid emergency receipt');

const releaseAdvisory = '生产部署证明无效（source release v3）：schema_version_invalid';
assert.equal(isWatchdogReleaseAuditIssue(releaseAdvisory), true);
assert.equal(watchdogIssueMaintenanceClass(releaseAdvisory), 'release-audit');

const legacyState = {
  schemaVersion: 'cloud-watchdog-alert-state/v1',
  runCount: 8,
  episodes: {
    'issue:release': {
      family: 'issue:release',
      status: 'alerted',
      alertSentCount: 1,
      lastRaw: releaseAdvisory,
    },
    'source-integrity': {
      family: 'source-integrity',
      status: 'pending',
      alertSentCount: 0,
      lastRaw: '云端源码不一致：commitMatch=false dirty=1 hidden=0 missing=0',
    },
  },
  outbox: {
    release: {
      family: 'issue:release',
      kind: 'alert',
      raw: releaseAdvisory,
      status: 'pending',
    },
  },
  dispatches: {
    releaseDispatch: {intentIds: ['release'], status: 'pending'},
  },
};
const detached = detachWatchdogReleaseAuditState(legacyState);
assert.equal(Object.hasOwn(detached.episodes, 'issue:release'), false);
assert.equal(Object.hasOwn(detached.outbox, 'release'), false);
assert.equal(Object.hasOwn(detached.dispatches, 'releaseDispatch'), false);
const afterDetach = applyWatchdogAlertState({previousState: detached, issues: []});
assert.equal(afterDetach.toRecover.length, 0, 'legacy release advisories must not emit recovery notifications');

console.log(JSON.stringify({
  ok: true,
  checks: [
    'formal_invalid_emergency_valid_business_green_release_audit_red',
    'emergency_exact_commit_binding',
    'dirty_source_remains_red',
    'release_advisory_not_normal_issue',
    'legacy_release_alert_state_detached',
  ],
}, null, 2));
