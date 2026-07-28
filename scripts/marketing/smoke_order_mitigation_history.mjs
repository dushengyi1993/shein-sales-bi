#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  driftFixResultDate,
  isDriftFixResultEligibleForReport,
} from '../../lib/marketing_order_mitigation_history.mjs';

assert.equal(
  driftFixResultDate('batch-drift-fix-result-2026-07-26.json'),
  '2026-07-26',
);
assert.equal(
  driftFixResultDate('batch-drift-fix-result-2026-07-26-resume-2.json'),
  '2026-07-26',
);
assert.equal(
  isDriftFixResultEligibleForReport('batch-drift-fix-result-2026-07-26.json', '2026-07-27'),
  true,
  'a previous-day repair must mitigate an older order on the next daily report',
);
assert.equal(
  isDriftFixResultEligibleForReport('batch-drift-fix-result-2026-07-27.json', '2026-07-27'),
  true,
);
assert.equal(
  isDriftFixResultEligibleForReport('batch-drift-fix-result-2026-07-28.json', '2026-07-27'),
  false,
  'future repair evidence must not suppress a current report',
);
assert.equal(
  isDriftFixResultEligibleForReport('batch-drift-fix-result-2026-02-30.json', '2026-07-27'),
  false,
);
assert.equal(
  isDriftFixResultEligibleForReport('unrelated.json', '2026-07-27'),
  false,
);

console.log(JSON.stringify({
  ok: true,
  test: 'order_mitigation_evidence_survives_daily_report_boundary',
}));
