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

const formalCommit = 'f'.repeat(40);
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

const formalValidEmergencyValidAudit = resolveWatchdogReleaseAudit({
  deployedReleaseValidation: {ok: true, issues: []},
  deploymentEvidence: {ok: true, commit: formalCommit, issues: []},
  emergencyLocalRelease: {ok: true, exists: true, issues: [], receipt: {commit: emergencyCommit}},
});
assert.equal(formalValidEmergencyValidAudit.releaseAuditReady, true);
assert.deepEqual(formalValidEmergencyValidAudit.releaseAuditIssues, []);
assert.equal(formalValidEmergencyValidAudit.expectedCommit, emergencyCommit);
assert.equal(formalValidEmergencyValidAudit.sourceBinding, 'emergency-local-receipt-v1');

const formalValidNoEmergencyAudit = resolveWatchdogReleaseAudit({
  deployedReleaseValidation: {ok: true, issues: []},
  deploymentEvidence: {ok: true, commit: formalCommit, issues: []},
  emergencyLocalRelease: {ok: false, exists: false, issues: ['receipt_missing']},
});
assert.equal(formalValidNoEmergencyAudit.releaseAuditReady, true);
assert.deepEqual(formalValidNoEmergencyAudit.releaseAuditIssues, []);
assert.equal(formalValidNoEmergencyAudit.expectedCommit, formalCommit);
assert.equal(formalValidNoEmergencyAudit.sourceBinding, 'formal-v3');

const formalValidInvalidEmergencyAudit = resolveWatchdogReleaseAudit({
  deployedReleaseValidation: {ok: true, issues: []},
  deploymentEvidence: {ok: true, commit: formalCommit, issues: []},
  emergencyLocalRelease: {ok: false, exists: true, issues: ['receipt_hash_mismatch']},
});
assert.equal(formalValidInvalidEmergencyAudit.releaseAuditReady, true);
assert.equal(formalValidInvalidEmergencyAudit.expectedCommit, formalCommit);
assert.equal(formalValidInvalidEmergencyAudit.sourceBinding, 'formal-v3');
assert.deepEqual(formalValidInvalidEmergencyAudit.releaseAuditIssues, ['emergency_local_receipt_invalid:receipt_hash_mismatch']);
assert.deepEqual(filterWatchdogReleaseAuditIssues(formalValidInvalidEmergencyAudit.releaseAuditIssues), []);

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
    'formal_valid_emergency_valid_binds_emergency',
    'formal_valid_no_emergency_binds_formal',
    'formal_valid_invalid_emergency_binds_formal_with_advisory',
    'dirty_source_remains_red',
    'release_advisory_not_normal_issue',
    'legacy_release_alert_state_detached',
  ],
}, null, 2));
