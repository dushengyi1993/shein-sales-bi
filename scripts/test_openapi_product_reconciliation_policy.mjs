#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  assessProductReconciliationPolicy,
  resolveProductReconciliationReportTargets,
} from './run_shein_openapi_products_reconciliation.mjs';

const runnerSource = await fs.readFile(new URL('./run_shein_openapi_products_reconciliation.mjs', import.meta.url), 'utf8');
const cloudWrapperSource = await fs.readFile(new URL('./cloud_openapi_product_reconciliation.sh', import.meta.url), 'utf8');
assert.match(runnerSource, /writeJsonFileAtomic\(reportTargets\.out, output\)/);
assert.match(runnerSource, /writeJsonFileAtomic\(reportTargets\.latestOut, output\)/);
assert.match(cloudWrapperSource, /--latest-out "\$LATEST_REPORT_FILE"/);
assert.doesNotMatch(cloudWrapperSource, /cp -f "\$REPORT_FILE" "\$LATEST_REPORT_FILE"/);

const fullReportTargets = resolveProductReconciliationReportTargets({
  out: '/tmp/full.json',
  latestOut: '/tmp/latest.json',
  requestedStores: ['DL', 'DX'],
  allAuthorizedStores: ['DX', 'DL'],
});
assert.equal(fullReportTargets.complete, true);
assert.equal(fullReportTargets.kind, 'all_authorized_stores');
assert.equal(fullReportTargets.latestOut, '/tmp/latest.json');

const targetedReportTargets = resolveProductReconciliationReportTargets({
  out: '/tmp/scoped.json',
  latestOut: '/tmp/latest.json',
  requestedStores: ['LQ'],
  allAuthorizedStores: ['DL', 'LQ'],
});
assert.equal(targetedReportTargets.complete, false);
assert.equal(targetedReportTargets.kind, 'targeted_stores');
assert.equal(targetedReportTargets.out, '/tmp/scoped.json');
assert.equal(targetedReportTargets.latestOut, '');
assert.equal(targetedReportTargets.latestSuppressedReason, 'targeted_run_cannot_replace_all_store_latest');

const defaultTargetedReportTargets = resolveProductReconciliationReportTargets({
  requestedStores: ['LQ'],
  allAuthorizedStores: ['DL', 'LQ'],
});
assert.equal(defaultTargetedReportTargets.complete, false);
assert.match(defaultTargetedReportTargets.out, /product-reconciliation\.targeted-LQ\.latest\.json$/);
assert.equal(defaultTargetedReportTargets.latestOut, '');

function snapshot(rows) {
  return {
    fetchedAt: '2026-07-26T00:00:00.000Z',
    bySkc: new Map(rows.map(row => [row.skc, row])),
  };
}

const previous = snapshot([
  {skc: 'LIVE', shelfStatusCode: '1', hasDetail: true, hasStock: true},
  {skc: 'OFF', shelfStatusCode: '1', hasDetail: true, hasStock: true},
]);
const current = snapshot([
  {skc: 'LIVE', shelfStatusCode: '1', hasDetail: true, hasStock: true},
  {skc: 'OFF', shelfStatusCode: '4', hasDetail: true, hasStock: true},
  {skc: 'API_ONLY_OFF', shelfStatusCode: '2', hasDetail: true, hasStock: true},
]);

const browserOnlyDiagnostic = {
  api_only_skc_count: 3,
  browser_only_skc_count: 11,
  status_mismatch_count: 7,
  exact_status_mismatch_count: 19,
};

const confirmed = assessProductReconciliationPolicy({
  current,
  previous,
  webhookEvents: [{skc: 'OFF', action: 'off_shelf', status: '0'}],
  browserDiagnostic: browserOnlyDiagnostic,
});
assert.equal(confirmed.status, 'matched', 'API-only/off-shelf rows and browser four-state differences are diagnostic only');
assert.equal(confirmed.counts.statusRollbackWithWebhook, 1);
assert.equal(confirmed.counts.statusRollbackWithoutWebhook, 0);

const unexplained = assessProductReconciliationPolicy({current, previous, browserDiagnostic: browserOnlyDiagnostic});
assert.equal(unexplained.status, 'warning', 'an on-shelf to off-shelf transition without a webhook must remain actionable');
assert.equal(unexplained.counts.statusRollbackWithoutWebhook, 1);
assert.match(unexplained.warnings.join('\n'), /未收到对应 Webhook/);

const missingEvidence = assessProductReconciliationPolicy({
  current: snapshot([{skc: 'MISSING', shelfStatusCode: '1', hasDetail: false, hasStock: false}]),
  previous: null,
});
assert.equal(missingEvidence.status, 'warning');
assert.equal(missingEvidence.counts.detailMissing, 1);
assert.equal(missingEvidence.counts.detailMissingActionable, 1);
assert.equal(missingEvidence.counts.detailPendingEnrichment, 0);
assert.equal(missingEvidence.counts.stockMissing, 1);
assert.equal(missingEvidence.policyVersion, 'openapi-current-webhook-previous/v2');

const stockOnlyPendingDetail = assessProductReconciliationPolicy({
  current: snapshot([{skc: 'NEW_PENDING', shelfStatusCode: '0', hasDetail: false, hasStock: true}]),
  previous: null,
  detailCheckActionable: false,
  detailValidationMode: 'stock_only',
});
assert.equal(stockOnlyPendingDetail.status, 'matched',
  'a new product awaiting the daily detail pass must not make a successful stock refresh look broken');
assert.equal(stockOnlyPendingDetail.counts.detailMissing, 1);
assert.equal(stockOnlyPendingDetail.counts.detailMissingActionable, 0);
assert.equal(stockOnlyPendingDetail.counts.detailPendingEnrichment, 1);
assert.match(stockOnlyPendingDetail.notes.join('\n'), /不作为故障报警/);

const cachedCurrent = snapshot([{
  skc: 'CACHED',
  shelfStatusCode: '4',
  hasDetail: true,
  detailSource: 'prior_cache',
  detailFetchedAt: '2026-07-25T00:00:00.000Z',
  hasStock: true,
}]);
const cachedPolicy = assessProductReconciliationPolicy({
  current: cachedCurrent,
  previous: snapshot([{skc: 'CACHED', shelfStatusCode: '1', hasDetail: true, hasStock: true}]),
});
assert.equal(cachedPolicy.status, 'matched', 'fresh cached detail is evidence fallback, not a false shelf rollback');
assert.equal(cachedPolicy.counts.cachedDetail, 1);
assert.equal(cachedPolicy.counts.statusRollbackWithoutWebhook, 0);

console.log('openapi_product_reconciliation_policy: checks passed');
