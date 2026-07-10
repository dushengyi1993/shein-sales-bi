#!/usr/bin/env node
import assert from 'node:assert/strict';

import {parseMarketingDateMs} from '../lib/marketing_plan_selector.mjs';

const shanghaiMidnight = Date.parse('2026-07-10T00:00:00+08:00');
assert.equal(parseMarketingDateMs('2026-07-10'), shanghaiMidnight, 'date-only values use Shanghai midnight');
assert.equal(parseMarketingDateMs('2026/7/10'), shanghaiMidnight, 'slash date-only values are normalized');
assert.equal(parseMarketingDateMs('2026-07-10 08:30:00'), Date.parse('2026-07-10T08:30:00+08:00'));
assert.equal(parseMarketingDateMs('2026-07-10T08:30:00Z'), Date.parse('2026-07-10T08:30:00Z'));
assert.equal(parseMarketingDateMs(''), 0);
assert.equal(parseMarketingDateMs('not-a-date'), 0);

console.log('marketing_plan_selector: 6 deterministic date parsing checks passed');
