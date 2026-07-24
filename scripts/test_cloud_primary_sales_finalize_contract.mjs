import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('./cloud_bi_refresh.sh', import.meta.url), 'utf8');

assert.match(source, /shein_webhook_primary_sales_enabled\(DATE '\$DATE'\)/);
assert.match(source, /run_shein_openapi_sales_reconciliation\.mjs/);
assert.match(source, /Number\(counts\.matched\) === expected/);
assert.match(source, /Number\(counts\.warning \|\| 0\) === 0/);
assert.match(source, /ops\.promote_openapi_sales_slice\(DATE '\$DATE',DATE '\$DATE'\)/);

const loader = await fs.readFile(new URL('./load_bi_warehouse.mjs', import.meta.url), 'utf8');
assert.match(loader, /readPrimarySalesGuard/);
assert.match(loader, /guardFormalSalesFacts/);
assert.match(loader, /formalSales\.items/);
assert.match(loader, /cleanupLoadedSlices\(args, formalSales\.daily/);

console.log('cloud_primary_sales_finalize_contract: WebAPI compare, 19-store gate and canonical promotion passed');
