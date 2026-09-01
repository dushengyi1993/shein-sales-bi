#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./cloud_link_business_sync.sh', import.meta.url), 'utf8');

const publishBlock = source.match(
  /if \[\[ "\$METRIC_REFETCH_SKIP_PUBLISH"[\s\S]*?^fi\n\nif \[\[ "\$METRIC_REFETCH_SOURCE_STATUS"/m,
)?.[0];
assert.ok(publishBlock, 'the core link publish block must remain present');

for (const step of ['dashboard', 'warehouse', 'business-domain-load']) {
  const escapedStep = step.replaceAll('-', '\\-');
  assert.match(
    publishBlock,
    new RegExp(`if ! run_link_publish_step "${escapedStep}"[\\s\\S]*?then\\n\\s+handle_link_publish_failure`),
    `${step} must fail closed before Portal generation`,
  );
}

const marketingBlock = publishBlock.match(
  /  if ! run_link_publish_step "marketing-export"[\s\S]*?^  fi\n/m,
)?.[0];
assert.ok(marketingBlock, 'the marketing export phase must remain present');
assert.match(marketingBlock,
  /if \[\[ "\$METRIC_REFETCH_SOURCE_STATUS" == "source_committed" \]\]; then\n\s+handle_link_publish_failure\n\s+fi/,
  'marketing export must only fail closed for source_committed refetch runs',
);
assert.match(marketingBlock, /WARN marketing export failed status=\$PUBLISH_FAILURE_STATUS/,
  'ordinary marketing export failures must remain explicit warnings',
);

const auditBlock = source.match(
  /if node scripts\/audit_bi_warehouse\.mjs; then[\s\S]*?^fi\n\nnode scripts\/generate_bi_portal\.mjs/m,
)?.[0];
assert.ok(auditBlock, 'audit must be guarded immediately before Portal generation');
assert.match(auditBlock, /AUDIT_STATUS=\$\?/);
assert.match(auditBlock, /WARN warehouse audit failed status=\$AUDIT_STATUS/);
assert.match(auditBlock, /continuing Portal generation and enqueue/);
assert.match(auditBlock, /node scripts\/generate_bi_portal\.mjs/);

const auditStart = source.indexOf('if node scripts/audit_bi_warehouse.mjs; then');
const portalStart = source.indexOf('node scripts/generate_bi_portal.mjs', auditStart);
const queueStart = source.indexOf('bash scripts/enqueue_bi_portal_sections.sh', portalStart);
assert.ok(auditStart >= 0 && portalStart > auditStart && queueStart > portalStart,
  'audit must precede Portal generation and enqueue');

console.log(JSON.stringify({ok: true, policy: 'link-business-audit-nonblocking'}));
