import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('./cloud_bi_refresh.sh', import.meta.url), 'utf8');
const reconcile = await fs.readFile(new URL('./cloud_today_sales_reconcile.sh', import.meta.url), 'utf8');

assert.match(source, /shein_webhook_primary_sales_enabled\(DATE '\$DATE'\)/);
assert.match(source, /run_shein_openapi_sales_reconciliation\.mjs/);
assert.match(source, /row\?\.fetch\?\.ok === true/);
assert.match(source, /row\?\.load\?\.ok === true/);
assert.match(source, /Number\(row\?\.load\?\.rowCounts\?\.daily \|\| 0\) === 1/);
assert.doesNotMatch(source, /Number\(counts\.matched\) === expected/);
assert.match(source, /ops\.promote_openapi_sales_slice\(DATE '\$DATE',DATE '\$DATE'\)/);
assert.match(reconcile, /ops\.promote_openapi_sales_slice_v2\(DATE '\$DATE',DATE '\$DATE'\)/);
assert.match(reconcile, /changed,headers_added,headers_modified,headers_deleted/);
assert.match(reconcile, /if \(changed && \(differences === 0 \|\| daily === 0\)\)/);
assert.doesNotMatch(reconcile, /if \(changed && \(differences === 0 \|\| written === 0 \|\| daily === 0\)\)/,
  'delete-only semantic changes may legitimately write zero replacement rows');
assert.match(reconcile, /if \[\[ \"\$PROMOTION_CHANGED_FLAG\" == 1 \]\]; then/);

// Execute the exact bounded promotion-result parser embedded in the shell.
// This keeps the deletion-only contract from becoming a comment-only guard.
const parserStart = reconcile.indexOf('PROMOTION_RESULT="$PROMOTION_RESULT" node - <<\'NODE\'');
assert.ok(parserStart >= 0, 'reconcile must keep its strict promotion parser');
const parserBodyStart = reconcile.indexOf('\n', parserStart) + 1;
const parserBodyEnd = reconcile.indexOf('\nNODE', parserBodyStart);
assert.ok(parserBodyStart > 0 && parserBodyEnd > parserBodyStart, 'promotion parser heredoc must be extractable');
const promotionParser = reconcile.slice(parserBodyStart, parserBodyEnd);
const runParser = value => {
  const result = spawnSync(process.execPath, ['-'], {
    input: promotionParser,
    encoding: 'utf8',
    env: {...process.env, PROMOTION_RESULT: value},
  });
  return result;
};
const zeros = Array(13).fill('0');
const noChange = runParser(['f', ...zeros].join('|'));
assert.equal(noChange.status, 0, noChange.stderr);
assert.match(noChange.stdout, /^0\t/);
const deletionOnly = runParser(['t', '0', '0', '1', '0', '0', '0', '0', '0', '0', '0', '0', '0', '19'].join('|'));
assert.equal(deletionOnly.status, 0,
  `delete-only promotion must be accepted when daily refresh is real: ${deletionOnly.stderr}`);
assert.match(deletionOnly.stdout, /^1\t0\t0\t1\t/);
const invalidChanged = runParser(['t', ...Array(12).fill('0'), '0'].join('|'));
assert.notEqual(invalidChanged.status, 0, 'changed=true with no semantic diff/daily refresh must fail closed');

const loader = await fs.readFile(new URL('./load_bi_warehouse.mjs', import.meta.url), 'utf8');
assert.match(loader, /readPrimarySalesGuard/);
assert.match(loader, /guardFormalSalesFacts/);
assert.match(loader, /formalSales\.items/);
assert.match(loader, /cleanupLoadedSlices\(args, formalSales\.daily/);

console.log('cloud_primary_sales_finalize_contract: 19-store OpenAPI completeness gate and canonical promotion passed');
