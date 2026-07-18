import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const policy = JSON.parse(await fs.readFile(new URL('../../config/marketing_pricing_policy.json', import.meta.url), 'utf8'));
const builder = await fs.readFile(new URL('./build_new_listing_limited_discount_plan.mjs', import.meta.url), 'utf8');
const executor = await fs.readFile(new URL('./apply_hl_limited_discount_rescue.mjs', import.meta.url), 'utf8');

assert.equal(policy.limitedDiscount.defaultActivityStock, 10);
assert.equal(policy.limitedDiscount.defaultDurationDays, 7);
assert.match(builder, /activityStock\s*=\s*positiveInt\(policy\?\.limitedDiscount\?\.defaultActivityStock,\s*10\)/);
assert.match(builder, /policy\?\.limitedDiscount\?\.defaultDurationDays/);
assert.match(builder, /activityStock,/);
assert.match(executor, /const\s+effectiveActivityStock\s*=\s*Number\(manualActivityStocks\[0\]\s*\?\?\s*rescue\.activityStock\s*\?\?\s*args\.activityStock\)/);
assert.match(executor, /manualActivityStocks\s*=\s*\[\.\.\.new Set\(manualRows\.map\(row\s*=>\s*Number\(row\.activityStock\)\)/);
assert.match(executor, /const\s+\{[\s\S]*?activityStock,[\s\S]*?\}\s*=\s*__arg/);
assert.match(executor, /const\s+attendNum\s*=\s*Number\.isInteger\(Number\(target\.activityStock\)\)[\s\S]*?:\s*activityStock;/);
assert.match(executor, /activityStock:\s*effectiveActivityStock/);

console.log(JSON.stringify({ok: true, test: 'limited_discount_default_activity_stock_10_duration_7d'}));
